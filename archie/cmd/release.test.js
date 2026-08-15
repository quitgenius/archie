'use strict';

// Tests for `archie release set|show|history` and `archie generation taint`.
//
// WHAT THESE TESTS ARE FOR. `release set` is the only command in the CLI that moves live traffic, and
// its value is almost entirely in what it REFUSES. So the refusals come first here, and each one is
// asserted twice: that the exit code is 5, and that NOTHING was written — an exit code alone would
// still pass if the pointer had already moved. The healthcheck and taint refusals are additionally
// asserted under `--hotfix`, under a rollback (pointing back at an older generation), and with every
// plausible bypass flag set at once, because "in every mode without exception" (§5.1, §5.2) is the
// property, not "in the normal path".
//
// WHAT THEY CANNOT DO. They cannot prove a DynamoDB expression is valid: a fake client "happily
// asserted the broken expression string", which is how an unaliased `agent` — a reserved word — broke
// every turn for every agent on 2026-08-13 (`registry-e2e.js:5-15`). The one thing checkable offline
// is that no attribute name is ever written bare, and `fakeDoc` asserts it on every expression it is
// handed. An e2e against a real table is the actual gate.
//
// No credentials and no network: the DynamoDB and STS clients are injected.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const rel = require('./release');
const { EXIT } = require('../lib/exit');
const { resourcesFor } = require('../lib/context');
const { COMMANDS, load } = require('../lib/registry');

const NAME = 'agent-gn0p84';
const TABLE = resourcesFor(NAME).configTable;
const IMAGE = '203366135563.dkr.ecr.us-east-1.amazonaws.com/agent-gn0p84core:pi-obs-40';
const GEN = 'rel-2026-08-14-01';
const OLD = 'rel-2026-08-13-01';
const NOW = Date.parse('2026-08-15T10:00:00.000Z');
const NOW_ISO = '2026-08-15T10:00:00.000Z';

// ── doubles ──────────────────────────────────────────────────────────────────────────────────────

const DDB_WORDS = new Set(['begins_with', 'attribute_not_exists', 'attribute_exists', 'attribute_type',
  'contains', 'size', 'if_not_exists', 'list_append', 'SET', 'REMOVE', 'ADD', 'DELETE', 'AND', 'OR',
  'NOT', 'BETWEEN', 'IN']);

/** Every identifier in an expression must arrive as `#alias` or `:value` — nothing bare, ever. */
function assertAllNamesAliased(expr, where) {
  const text = String(expr);
  for (const m of text.matchAll(/(.?)\b([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const [, prev, token] = m;
    if (prev === '#' || prev === ':') continue;
    assert.ok(DDB_WORDS.has(token),
      `${where}: bare attribute name "${token}" in "${text}" — alias everything (runtime-registry.js:134-138)`);
  }
}

const keyOf = (pk, sk) => `${pk} ${sk}`;

/**
 * @param opts.failPut     throw this on the Nth PutCommand whose Item.pk matches (see `failPutPk`)
 * @param opts.raceTo      after the pointer Put, make the next consistent read return this generation
 * @param opts.dropPointer after the pointer Put, make the next consistent read return nothing
 */
function fakeDoc(items = [], opts = {}) {
  const store = new Map(items.map((i) => [keyOf(i.pk, i.sk), { ...i }]));
  const seen = [];
  let pointerWritten = false;
  return {
    store,
    seen,
    puts() { return seen.filter((s) => s.name === 'PutCommand'); },
    updates() { return seen.filter((s) => s.name === 'UpdateCommand'); },
    writes() { return seen.filter((s) => s.name === 'PutCommand' || s.name === 'UpdateCommand' || s.name === 'DeleteCommand'); },
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      seen.push({ name, input });
      for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression']) {
        if (input[k]) assertAllNamesAliased(input[k], `${name}.${k}`);
      }
      if (name === 'GetCommand') {
        const key = keyOf(input.Key.pk, input.Key.sk);
        if (pointerWritten && input.Key.sk === 'ACTIVE') {
          if (opts.dropPointer) return {};
          if (opts.raceTo) {
            return {
              Item: {
                pk: input.Key.pk,
                sk: 'ACTIVE',
                data: JSON.stringify({ generationId: opts.raceTo, publishedAt: '2026-08-15T09:59:59.000Z', publishedBy: 'agent-848o7l' }),
              },
            };
          }
        }
        return { Item: store.get(key) };
      }
      if (name === 'ScanCommand') {
        const prefix = input.ExpressionAttributeValues && input.ExpressionAttributeValues[':p'];
        return { Items: [...store.values()].filter((i) => !prefix || String(i.pk).startsWith(prefix)) };
      }
      if (name === 'QueryCommand') {
        const pk = input.ExpressionAttributeValues[':pk'];
        let rows = [...store.values()].filter((i) => i.pk === pk);
        rows.sort((a, b) => (a.sk < b.sk ? -1 : 1));
        if (input.ScanIndexForward === false) rows.reverse();
        if (input.Limit) rows = rows.slice(0, input.Limit);
        return { Items: rows };
      }
      if (name === 'PutCommand') {
        const key = keyOf(input.Item.pk, input.Item.sk);
        if (opts.failPut && input.Item.pk === (opts.failPutPk || 'CONFIG#release-history')) throw opts.failPut;
        if (input.ConditionExpression === 'attribute_not_exists(#pk)' && store.has(key)) {
          const e = new Error('The conditional request failed');
          e.name = 'ConditionalCheckFailedException';
          throw e;
        }
        store.set(key, { ...input.Item });
        if (input.Item.sk === 'ACTIVE') pointerWritten = true;
        return {};
      }
      if (name === 'UpdateCommand') {
        // The narrowest reader that can express `#a = :v` and `#a = if_not_exists(#a, :v)`. Aliases
        // are matched as whole tokens deliberately (`cmd/stage.test.js:96-98`).
        const key = keyOf(input.Key.pk, input.Key.sk);
        const item = store.get(key) || { ...input.Key };
        const names = input.ExpressionAttributeNames || {};
        const values = input.ExpressionAttributeValues || {};
        for (const m of input.UpdateExpression.matchAll(/#([A-Za-z0-9_]+)\s*=\s*(if_not_exists\(#[A-Za-z0-9_]+,\s*)?(:[A-Za-z0-9_]+)\)?/g)) {
          const attr = names[`#${m[1]}`];
          if (m[2] && item[attr] !== undefined) continue;
          item[attr] = values[m[3]];
        }
        store.set(key, item);
        return {};
      }
      if (name === 'DeleteCommand') {
        store.delete(keyOf(input.Key.pk, input.Key.sk));
        return {};
      }
      throw new Error(`fakeDoc: unexpected ${name}`);
    },
  };
}

/**
 * ECR double for `release publish-image`. `describeImage` (cmd/generation.js) issues DescribeImages
 * then BatchGetImage; a missing tag is `ImageNotFoundException` from the first, and the architecture
 * comes from the manifest list returned by the second.
 */
function fakeEcr({ missing = false, arches = ['arm64'], digest = 'sha256:deadbeef' } = {}) {
  const seen = [];
  return {
    seen,
    async send(cmd) {
      const name = cmd.constructor.name;
      seen.push(name);
      if (name === 'DescribeImagesCommand') {
        if (missing) {
          const e = new Error('image not found');
          e.name = 'ImageNotFoundException';
          throw e;
        }
        return {
          imageDetails: [{ imageDigest: digest, imagePushedAt: new Date(NOW), imageSizeInBytes: 104857600 }],
        };
      }
      if (name === 'BatchGetImageCommand') {
        return {
          images: [{ imageManifest: JSON.stringify({ manifests: arches.map((a) => ({ platform: { architecture: a } })) }) }],
        };
      }
      throw new Error(`fakeEcr: unexpected ${name}`);
    },
  };
}

const fakeSts = (Account = '203366135563') => ({ async send() { return { Account }; } });

function fakeOut() {
  const o = {
    answers: [], progressLines: [], warnings: [], verboseLines: [], failures: [],
  };
  return Object.assign(o, {
    answer: (v) => o.answers.push(v),
    progress: (l) => o.progressLines.push(l),
    verbose: (l) => o.verboseLines.push(l),
    warn: (l) => o.warnings.push(l),
    failure: (f) => o.failures.push(f),
    failureCount: () => o.failures.length,
    error: () => {},
  });
}

const ctxFor = (over = {}) => ({
  name: NAME,
  region: 'us-east-1',
  profile: null,
  account: null,
  dryRun: false,
  assumeYes: false,
  json: true,
  verbosity: 0,
  timeoutSeconds: null,
  resources: resourcesFor(NAME),
  ...over,
});

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────

const SPEC = {
  image: IMAGE,
  efsRootPrefix: '/openclaw-data',
  efsMountPath: '/mnt/efs',
  securityGroupId: 'sg-123',
  idleRuntimeSessionTimeout: 900,
  maxLifetime: 28800,
  serverProtocol: 'HTTP',
  runtimeEnv: { REGION: 'us-east-1', EFS_DIR: '/mnt/efs' },
};

const generationItem = (sk = GEN, over = {}) => ({
  pk: 'CONFIG#generation',
  sk,
  data: JSON.stringify({
    generationId: sk, spec: SPEC, specDigest: 'abc123', image: IMAGE, imageTag: 'pi-obs-40', createdAt: '2026-08-14T00:00:00.000Z', createdBy: 'sandbox',
  }),
  ...over,
});

const binding = (agent, generationId = GEN, over = {}) => ({
  pk: `RUNTIME#${agent}`,
  sk: `GEN#${generationId}`,
  agent,
  generationId,
  runtimeName: `${agent}_${generationId}`,
  arn: `arn:aws:bedrock-agentcore:us-east-1:203366135563:runtime/${agent}-abc`,
  healthcheck: 'ok',
  stagedAt: '2026-08-14T01:00:00.000Z',
  ...over,
});

const pointerItem = (generationId, over = {}) => {
  const body = {
    generationId, mode: 'staged', publishedAt: '2026-08-14T02:00:00.000Z', publishedBy: 'sandbox', ...over,
  };
  return {
    pk: 'CONFIG#release', sk: 'ACTIVE', data: JSON.stringify(body), ...body,
  };
};

const historyItem = (generationId, publishedAt, over = {}) => {
  const body = {
    generationId, mode: 'staged', publishedAt, publishedBy: 'sandbox', ...over,
  };
  return {
    pk: 'CONFIG#release-history', sk: `${publishedAt}#${generationId}`, data: JSON.stringify(body), ...body,
  };
};

/** A generation staged onto `count` agents, all healthy and live. */
const healthyFleet = (count = 3, generationId = GEN, over = {}) => Array.from({ length: count },
  (_, i) => binding(`agent_${i}`, generationId, over));

async function runCmd(fn, {
  items = [], values = {}, positionals = [], ctx: over = {}, deps = {}, docOpts = {},
} = {}) {
  const doc = fakeDoc(items, docOpts);
  const out = fakeOut();
  const ctx = ctxFor(over);
  let error = null;
  try {
    await fn(ctx, { positionals, values }, out, {
      doc, sts: fakeSts(), user: 'sandbox', now: () => NOW, ...deps,
    });
  } catch (e) {
    error = e;
  }
  return {
    doc, out, error, code: error ? error.exitCode : EXIT.OK, result: out.answers[0],
  };
}

const setCmd = rel['release set'];
const showCmd = rel['release show'];
const historyCmd = rel['release history'];
const taintCmd = rel['generation taint'];

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE REFUSALS — every one of them exit 5 with nothing mutated.
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test('release set refuses a generation that does not exist — exit 5, nothing written', async () => {
  const r = await runCmd(setCmd, { items: [], positionals: ['nope'] });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /does not exist/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a TAINTED generation — exit 5, nothing written', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN, { taintedAt: '2026-08-14T05:00:00.000Z', taintReason: 'crash loop', taintedBy: 'sandbox' }), ...healthyFleet()],
    positionals: [GEN],
  });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /TAINTED/);
  assert.match(r.error.detail, /crash loop/);
  assert.match(r.error.detail, /no untaint and no force flag/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a tainted generation WITH --hotfix — the flag is attribution, not a bypass', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN, { taintedAt: '2026-08-14T05:00:00.000Z', taintReason: 'crash loop' }), ...healthyFleet()],
    positionals: [GEN],
    values: { hotfix: true },
  });
  assert.equal(r.code, EXIT.REFUSED);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a tainted ROLLBACK target — "it worked before" is not a healthcheck', async () => {
  // GEN is live; OLD is the previous generation, fully staged and healthy, but tainted since.
  const r = await runCmd(setCmd, {
    items: [
      generationItem(GEN), ...healthyFleet(3, GEN),
      generationItem(OLD, { taintedAt: '2026-08-14T06:00:00.000Z', taintReason: 'condemned after the fact' }),
      ...healthyFleet(3, OLD),
      pointerItem(GEN),
    ],
    positionals: [OLD],
  });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /TAINTED/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a REAPED generation and says to re-stage — it would invoke a corpse', async () => {
  const reaped = healthyFleet(3, OLD).map((b) => ({ ...b, arn: undefined, reapedAt: '2026-08-14T07:00:00.000Z' }));
  const r = await runCmd(setCmd, {
    items: [generationItem(OLD), ...reaped, generationItem(GEN), ...healthyFleet(3, GEN), pointerItem(GEN)],
    positionals: [OLD],
  });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /reaped/);
  assert.match(r.error.detail, /invoke a corpse/);
  assert.match(r.error.detail, /generation stage --generation/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a generation that was never staged', async () => {
  const r = await runCmd(setCmd, { items: [generationItem(GEN)], positionals: [GEN] });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /never been staged/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a FAILED healthcheck, and says the taint write was lost', async () => {
  const rows = healthyFleet(3);
  rows[1].healthcheck = 'failed';
  const r = await runCmd(setCmd, { items: [generationItem(GEN), ...rows], positionals: [GEN] });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /FAILED healthcheck/);
  assert.match(r.error.detail, /generation taint/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a PENDING healthcheck — a binding that was never invoked proves nothing', async () => {
  const rows = healthyFleet(3);
  rows[2].healthcheck = 'pending';
  const r = await runCmd(setCmd, { items: [generationItem(GEN), ...rows], positionals: [GEN] });
  assert.equal(r.code, EXIT.REFUSED);
  assert.match(r.error.message, /healthcheck has not run/);
  assert.equal(r.doc.writes().length, 0);
});

test('release set refuses a hotfix whose single canary is not healthy', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), binding('canary', GEN, { healthcheck: 'pending' })],
    positionals: [GEN],
    values: { hotfix: true },
  });
  assert.equal(r.code, EXIT.REFUSED);
  assert.equal(r.doc.writes().length, 0);
});

test('no flag, and no environment variable, bypasses the taint refusal', async () => {
  // Every plausible bypass at once: the documented flag, invented ones, --yes, and an env var. §5.1
  // and §5.2 say "no force flag, no --i-know-what-im-doing, no environment variable" — this is that
  // sentence as a test, and it fails the moment any of them is wired up.
  process.env.ARCHIE_FORCE = '1';
  process.env.ARCHIE_RELEASE_FORCE = '1';
  try {
    const r = await runCmd(setCmd, {
      items: [generationItem(GEN, { taintedAt: '2026-08-14T05:00:00.000Z' }), ...healthyFleet()],
      positionals: [GEN],
      values: {
        hotfix: true, force: true, 'i-know-what-im-doing': true, yes: true,
      },
      ctx: { assumeYes: true },
    });
    assert.equal(r.code, EXIT.REFUSED);
    assert.equal(r.doc.writes().length, 0);
  } finally {
    delete process.env.ARCHIE_FORCE;
    delete process.env.ARCHIE_RELEASE_FORCE;
  }
});

test('the gate is pure and takes no flags — there is nowhere to add a force option', async () => {
  // `releaseRefusal` decides from the item, its rows and the pointer. It is handed no option values
  // at all, so a bypass cannot be threaded into it without changing its signature in review.
  const args = String(rel.releaseRefusal);
  assert.ok(!/values|hotfix|force/.test(args.slice(0, args.indexOf('{'))),
    'releaseRefusal must not accept flags');
  const err = rel.releaseRefusal({
    generationId: GEN,
    item: { pk: 'CONFIG#generation', sk: GEN, taintedAt: '2026-08-14T05:00:00.000Z' },
    rows: [],
    release: null,
    table: TABLE,
  });
  assert.equal(err.exitCode, EXIT.REFUSED);
});

test('the gate agrees with `generation list` STATE: a rollback target is releasable', async () => {
  // One opinion, not two. `stateOf` decides the STATE column an operator reads before rolling back
  // (`cmd/generation.js:634`); if it says "rollback target", this command must not refuse.
  const { stateOf, bindingStats } = require('./generation');
  const item = generationItem(OLD);
  const rows = healthyFleet(3, OLD);
  const state = stateOf({ item, stats: bindingStats(rows), release: { generationId: GEN } });
  assert.equal(state.isRollbackTarget, true);
  assert.equal(rel.releaseRefusal({
    generationId: OLD, item, rows, release: { generationId: GEN }, table: TABLE,
  }), null);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// THE WRITE
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test('release set writes ONE pointer item, with the body AND the four mirrored attributes', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet(3), generationItem(OLD), ...healthyFleet(3, OLD), pointerItem(OLD)],
    positionals: [GEN],
  });
  assert.equal(r.code, EXIT.OK);

  const pointerPuts = r.doc.puts().filter((p) => p.input.Item.sk === 'ACTIVE');
  assert.equal(pointerPuts.length, 1, 'exactly one pointer write — it is one item');
  const item = pointerPuts[0].input.Item;
  assert.equal(item.pk, 'CONFIG#release');
  assert.equal(item.sk, 'ACTIVE');
  assert.equal(pointerPuts[0].input.TableName, TABLE);

  // The body is an opaque JSON string under `data` — order-stable, and what `readBody` prefers.
  const body = JSON.parse(item.data);
  assert.equal(body.generationId, GEN);
  assert.equal(body.mode, 'staged');
  assert.equal(body.publishedAt, NOW_ISO);
  assert.equal(body.publishedBy, 'sandbox');
  assert.equal(body.previousGenerationId, OLD);
  assert.equal(body.image, IMAGE);
  assert.equal(body.imageTag, 'pi-obs-40');
  assert.equal(body.specDigest, 'abc123');
  assert.deepEqual(body.coverage, {
    agents: 3, bound: 3, live: 3, ok: 3, failed: 0, pending: 0,
  });

  // The mirrors cmd/status.js:702-705 reads straight off the item. Body-only would make `archie
  // status` report a total outage on a healthy fleet.
  for (const k of ['generationId', 'mode', 'publishedAt', 'publishedBy']) {
    assert.equal(item[k], body[k], `top-level ${k} must mirror the body`);
  }
});

test('release set reads back CONSISTENTLY after the write', async () => {
  const r = await runCmd(setCmd, { items: [generationItem(GEN), ...healthyFleet()], positionals: [GEN] });
  assert.equal(r.code, EXIT.OK);
  const gets = r.doc.seen.filter((s) => s.name === 'GetCommand' && s.input.Key.sk === 'ACTIVE');
  assert.ok(gets.length >= 2, 'the pointer is read before and after the write');
  for (const g of gets) assert.equal(g.input.ConsistentRead, true);
  assert.equal(r.result.readback, 'consistent');
  assert.equal(r.result.effectiveWithinSeconds, 5);
});

test('release set reports the ~5s effectiveness window in human output', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet()], positionals: [GEN], ctx: { json: false },
  });
  assert.equal(r.code, EXIT.OK);
  const text = r.out.answers[0];
  assert.match(text, /^target {4}rel-2026-08-14-01/m);
  assert.match(text, /^previous {2}none$/m);
  assert.match(text, /^written {3}CONFIG#release \/ ACTIVE {2}mode=staged {2}by sandbox$/m);
  assert.match(text, /^readback {2}CONSISTENT {2}ok$/m);
  assert.match(text, /effective within ~5s/);
});

test('--hotfix records mode: hotfix and changes nothing that is checked', async () => {
  // One healthy canary and no other binding: the coverage a staged release needs is skipped at the
  // STAGING step, and verification here is untouched (§2.13).
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), binding('canary', GEN)],
    positionals: [GEN],
    values: { hotfix: true },
  });
  assert.equal(r.code, EXIT.OK);
  const item = r.doc.puts().find((p) => p.input.Item.sk === 'ACTIVE').input.Item;
  assert.equal(item.mode, 'hotfix');
  assert.equal(JSON.parse(item.data).mode, 'hotfix');
});

test('release set appends a history row and never rewrites one', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet(), historyItem(OLD, '2026-08-14T02:00:00.000Z')],
    positionals: [GEN],
  });
  assert.equal(r.code, EXIT.OK);
  const hist = r.doc.puts().filter((p) => p.input.Item.pk === rel.HISTORY_PK);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].input.Item.sk, `${NOW_ISO}#${GEN}`);
  assert.equal(hist[0].input.ConditionExpression, 'attribute_not_exists(#pk)');
  // The prior row is still there, untouched.
  assert.ok(r.doc.store.get(`${rel.HISTORY_PK} 2026-08-14T02:00:00.000Z#${OLD}`));
  assert.equal(r.result.historySk, `${NOW_ISO}#${GEN}`);
});

test('the pointer moves even if the history append fails — traffic is not held hostage to an audit row', async () => {
  const boom = new Error('AccessDeniedException on the history partition');
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet()],
    positionals: [GEN],
    docOpts: { failPut: boom, failPutPk: rel.HISTORY_PK },
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.written, true);
  assert.equal(r.result.historySk, null);
  assert.equal(r.out.failures.length, 0, 'a missing audit row must not exit 6 and send an operator back to re-run');
  assert.match(r.out.warnings.join('\n'), /history row could not be appended/);
});

test('a duplicate history row is a benign no-op, not an overwrite', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet(), historyItem(GEN, NOW_ISO)],
    positionals: [GEN],
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.written, true);
  assert.match(r.out.verboseLines.join('\n'), /already exists — not overwritten/);
});

test('release set --dry-run writes nothing and exits 0', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet()], positionals: [GEN], ctx: { dryRun: true },
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.doc.writes().length, 0);
  assert.equal(r.result.dryRun, true);
  assert.equal(r.result.written, false);
});

test('release set --dry-run still refuses a tainted generation', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN, { taintedAt: '2026-08-14T05:00:00.000Z' }), ...healthyFleet()],
    positionals: [GEN],
    ctx: { dryRun: true },
  });
  assert.equal(r.code, EXIT.REFUSED);
});

test('re-publishing the generation that is already live writes nothing', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet(), pointerItem(GEN)],
    positionals: [GEN],
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.unchanged, true);
  assert.equal(r.doc.writes().length, 0, 'no pointer write and no duplicate history row');
});

test('an already-live generation that has since been TAINTED still refuses', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN, { taintedAt: '2026-08-15T09:00:00.000Z' }), ...healthyFleet(), pointerItem(GEN)],
    positionals: [GEN],
  });
  assert.equal(r.code, EXIT.REFUSED);
});

test('a partially reaped generation is allowed but warned about', async () => {
  const rows = healthyFleet(3);
  rows[0] = { ...rows[0], arn: undefined, reapedAt: '2026-08-15T08:00:00.000Z' };
  const r = await runCmd(setCmd, { items: [generationItem(GEN), ...rows], positionals: [GEN] });
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out.warnings.join('\n'), /have been reaped/);
});

test('a read-back that names another generation is exit 1, not a silent success', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet()],
    positionals: [GEN],
    docOpts: { raceTo: 'rel-agent-848o7l' },
  });
  assert.equal(r.code, EXIT.FAILED);
  assert.match(r.error.message, /another publish raced this one/);
});

test('a read-back that finds no pointer at all is exit 1', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet()],
    positionals: [GEN],
    docOpts: { dropPointer: true },
  });
  assert.equal(r.code, EXIT.FAILED);
  assert.match(r.error.message, /reads absent/);
});

test('release set requires a generation id', async () => {
  const r = await runCmd(setCmd, { items: [], positionals: [] });
  assert.equal(r.code, EXIT.USAGE);
});

test('release set asserts --account before anything else', async () => {
  const r = await runCmd(setCmd, {
    items: [generationItem(GEN), ...healthyFleet()],
    positionals: [GEN],
    ctx: { account: '111111111111' },
    deps: { sts: fakeSts('203366135563') },
  });
  assert.equal(r.code, EXIT.PREFLIGHT);
  assert.equal(r.doc.writes().length, 0);
});

test('release set never calls ListAgentRuntimes — coverage comes from the registry', async () => {
  const r = await runCmd(setCmd, { items: [generationItem(GEN), ...healthyFleet()], positionals: [GEN] });
  assert.equal(r.code, EXIT.OK);
  assert.ok(!r.doc.seen.some((s) => /ListAgentRuntimes/.test(s.name)));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// release show / history
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test('release show with no pointer is exit 1 and does not report "none"', async () => {
  const r = await runCmd(showCmd, { items: [] });
  assert.equal(r.code, EXIT.FAILED);
  assert.match(r.error.message, /no release pointer/);
  assert.match(r.error.detail, /ImagePointerMissing/);
  assert.equal(r.out.answers.length, 0);
});

test('release show reports the active generation and how it was published', async () => {
  const r = await runCmd(showCmd, { items: [pointerItem(GEN, { publishedBy: 'sandbox', mode: 'hotfix' }), generationItem(GEN)] });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.generationId, GEN);
  assert.equal(r.result.mode, 'hotfix');
  assert.equal(r.result.publishedBy, 'sandbox');
  assert.equal(r.result.generationExists, true);
  assert.equal(r.result.imageTag, 'pi-obs-40');
  // No table scan: show is two GetItems.
  assert.ok(!r.doc.seen.some((s) => s.name === 'ScanCommand'));
});

test('release show warns when the LIVE generation has been tainted since', async () => {
  const r = await runCmd(showCmd, {
    items: [pointerItem(GEN), generationItem(GEN, { taintedAt: '2026-08-15T09:00:00.000Z', taintReason: 'bad build' })],
  });
  assert.equal(r.code, EXIT.OK);
  assert.match(r.out.warnings.join('\n'), /LIVE generation .* is TAINTED/);
  assert.equal(r.result.taintReason, 'bad build');
});

test('release show warns when the pointer names a generation that is not there', async () => {
  const r = await runCmd(showCmd, { items: [pointerItem(GEN)] });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.generationExists, false);
  assert.match(r.out.warnings.join('\n'), /no CONFIG#generation item/);
});

test('release history with no pointer is exit 1 even when history rows exist', async () => {
  const r = await runCmd(historyCmd, { items: [historyItem(OLD, '2026-08-14T02:00:00.000Z')] });
  assert.equal(r.code, EXIT.FAILED);
  assert.match(r.error.message, /no release pointer/);
});

test('release history lists previous pointer values newest first and marks the active one', async () => {
  const r = await runCmd(historyCmd, {
    items: [
      pointerItem(GEN, { publishedAt: '2026-08-15T02:00:00.000Z' }),
      historyItem(OLD, '2026-08-13T02:00:00.000Z'),
      historyItem('rel-mid', '2026-08-14T02:00:00.000Z'),
      historyItem(GEN, '2026-08-15T02:00:00.000Z'),
    ],
  });
  assert.equal(r.code, EXIT.OK);
  assert.deepEqual(r.result.history.map((h) => h.generationId), [GEN, 'rel-mid', OLD]);
  assert.equal(r.result.history[0].active, true);
  assert.equal(r.result.history[1].active, false);
});

test('release history synthesises the active pointer when it has no history row', async () => {
  const r = await runCmd(historyCmd, {
    items: [pointerItem(GEN, { publishedAt: '2026-08-15T02:00:00.000Z' }), historyItem(OLD, '2026-08-13T02:00:00.000Z')],
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.history[0].generationId, GEN);
  assert.equal(r.result.history[0].fromPointer, true);
  assert.equal(r.result.history[0].active, true);
});

test('release history --limit bounds the query itself', async () => {
  const r = await runCmd(historyCmd, {
    items: [
      pointerItem(GEN, { publishedAt: '2026-08-15T02:00:00.000Z' }),
      historyItem(GEN, '2026-08-15T02:00:00.000Z'),
      historyItem('rel-mid', '2026-08-14T02:00:00.000Z'),
      historyItem(OLD, '2026-08-13T02:00:00.000Z'),
    ],
    values: { limit: '2' },
  });
  assert.equal(r.code, EXIT.OK);
  const q = r.doc.seen.find((s) => s.name === 'QueryCommand');
  assert.equal(q.input.Limit, 2);
  assert.equal(q.input.ScanIndexForward, false);
  assert.equal(r.result.history.length, 2);
});

test('release history rejects a nonsense --limit', async () => {
  const r = await runCmd(historyCmd, { items: [pointerItem(GEN)], values: { limit: 'lots' } });
  assert.equal(r.code, EXIT.USAGE);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// generation taint
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test('generation taint writes the three attributes TOP-LEVEL and never touches the body', async () => {
  const r = await runCmd(taintCmd, {
    items: [generationItem(GEN)], positionals: [GEN], values: { reason: 'agents crash-loop on boot' },
  });
  assert.equal(r.code, EXIT.OK);
  const updates = r.doc.updates();
  assert.equal(updates.length, 1);
  const u = updates[0].input;
  assert.deepEqual(u.Key, { pk: 'CONFIG#generation', sk: GEN });
  assert.deepEqual(Object.values(u.ExpressionAttributeNames).sort(), ['taintReason', 'taintedAt', 'taintedBy']);
  assert.ok(!/#data|:data/.test(u.UpdateExpression), 'the body is written once and never rewritten');

  const stored = r.doc.store.get(`CONFIG#generation ${GEN}`);
  assert.equal(stored.taintedAt, NOW_ISO);
  assert.equal(stored.taintReason, 'agents crash-loop on boot');
  assert.equal(stored.taintedBy, 'sandbox');
  // The body still hashes to what it did: `data` is byte-identical.
  assert.equal(stored.data, generationItem(GEN).data);
});

test('a tainted generation is immediately unreleasable — the two commands agree', async () => {
  const items = [generationItem(GEN), ...healthyFleet()];
  const t = await runCmd(taintCmd, { items, positionals: [GEN], values: { reason: 'condemned' } });
  assert.equal(t.code, EXIT.OK);
  // Carry the mutated item into a release attempt, exactly as a second shell would read it.
  const after = [...t.doc.store.values()];
  const s = await runCmd(setCmd, { items: after, positionals: [GEN] });
  assert.equal(s.code, EXIT.REFUSED);
  assert.match(s.error.detail, /condemned/);
});

test('generation taint is idempotent and keeps the FIRST reason', async () => {
  const r = await runCmd(taintCmd, {
    items: [generationItem(GEN, { taintedAt: '2026-08-14T05:00:00.000Z', taintReason: 'first', taintedBy: 'ci' })],
    positionals: [GEN],
    values: { reason: 'second' },
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.result.written, false);
  assert.equal(r.result.taintReason, 'first');
  assert.equal(r.doc.writes().length, 0);
});

test('generation taint requires an id and a reason', async () => {
  assert.equal((await runCmd(taintCmd, { items: [generationItem(GEN)], values: { reason: 'x' } })).code, EXIT.USAGE);
  assert.equal((await runCmd(taintCmd, { items: [generationItem(GEN)], positionals: [GEN] })).code, EXIT.USAGE);
  assert.equal((await runCmd(taintCmd, { items: [generationItem(GEN)], positionals: [GEN], values: { reason: '   ' } })).code, EXIT.USAGE);
});

test('generation taint on an unknown id is exit 1 and mints no phantom generation', async () => {
  // An UpdateItem on an absent key CREATES the item, so this refusal has to happen before the write
  // or a typo would leave a body-less generation in the catalogue forever.
  const r = await runCmd(taintCmd, { items: [], positionals: ['typo'], values: { reason: 'x' } });
  assert.equal(r.code, EXIT.FAILED);
  assert.equal(r.doc.writes().length, 0);
  assert.equal(r.doc.store.size, 0);
});

test('generation taint --dry-run writes nothing', async () => {
  const r = await runCmd(taintCmd, {
    items: [generationItem(GEN)], positionals: [GEN], values: { reason: 'x' }, ctx: { dryRun: true },
  });
  assert.equal(r.code, EXIT.OK);
  assert.equal(r.doc.writes().length, 0);
  assert.equal(r.result.dryRun, true);
});

test('there is no untaint, no --clear and no --force anywhere in this module', async () => {
  for (const name of Object.keys(rel)) {
    assert.ok(!/untaint|clearTaint/i.test(name), `${name} must not exist — taint is permanent (§5.2)`);
  }
  assert.deepEqual(Object.keys(COMMANDS['generation taint'].options), ['reason']);
  assert.deepEqual(Object.keys(COMMANDS['release set'].options), ['hotfix']);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════════
// wiring
// ═════════════════════════════════════════════════════════════════════════════════════════════════

test('every declared command resolves to this module, and no bare verb is exported', async () => {
  for (const key of ['release set', 'release show', 'release history', 'generation taint']) {
    assert.equal(typeof load(key, COMMANDS[key]), 'function', `${key} must load`);
  }
  // `show` is also `generation show`'s verb and `set`/`history`/`taint` are plausible verbs elsewhere;
  // a bare export would answer for another noun's command (`lib/registry.js:156-166`).
  for (const verb of ['set', 'show', 'history', 'taint']) {
    assert.equal(rel[verb], undefined, `must not export a bare "${verb}"`);
  }
});

test('the pointer item carries a literal `data` attribute but no expression ever names it', async () => {
  // `data` is a DynamoDB reserved word. It is safe in a PutItem's item map and lethal in an
  // expression, so the shape is asserted rather than assumed (`runtime-registry.js:134-138`).
  const item = rel.pointerItemFor('ACTIVE', {
    generationId: GEN, mode: 'staged', publishedAt: NOW_ISO, publishedBy: 'sandbox',
  });
  assert.equal(typeof item.data, 'string');
  const r = await runCmd(setCmd, { items: [generationItem(GEN), ...healthyFleet()], positionals: [GEN] });
  for (const s of r.doc.seen) {
    for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression']) {
      if (s.input[k]) assert.ok(!/\bdata\b/.test(String(s.input[k])), `${s.name}.${k} names "data"`);
    }
  }
});

test('history lives in its own partition, apart from the pointer and its reserved scope siblings', async () => {
  // Plan §3 reserves `CONFIG#release` for scope overrides (`sk: AGENT#<id>` / `CHANNEL#<id>`), which
  // are read by Querying that partition — an unbounded audit log must not be in it.
  assert.equal(rel.HISTORY_PK, 'CONFIG#release-history');
  const body = {
    generationId: GEN, mode: 'staged', publishedAt: NOW_ISO, publishedBy: 'sandbox',
  };
  assert.equal(rel.historyItemFor(body).pk, 'CONFIG#release-history');
  assert.equal(rel.historyItemFor(body).sk, `${NOW_ISO}#${GEN}`);
});

// ── release publish-image ────────────────────────────────────────────────────────────────────────
//
// WHY THIS COMMAND MATTERS MORE THAN ITS SIZE SUGGESTS. `CONFIG#image` is what `image-source.js:63`
// actually reads on the turn path — `CONFIG#release/ACTIVE` is not read by anything yet — so until
// the dispatcher switches over, THIS write is the one that decides what the fleet provisions. It was
// reachable only from `slack-dispatcher/publish-image.mjs`, outside the CLI, while `preflight` check
// 4 and `status` both reported its absence. The tests below hold the two rails that make writing it
// safe: the ECR gate, and the refusal to clear the fleet pointer.

const publish = (over = {}) => ({ positionals: ['pi-obs-41'], values: {}, ...over });

test('publish-image writes CONFIG#image/FLEET after the ECR gate passes', async () => {
  const doc = fakeDoc();
  const ecr = fakeEcr();
  const out = fakeOut();
  const r = await rel['release publish-image'](ctxFor(), publish(), out, {
    doc, ecr, sts: fakeSts(), user: 'sandbox', now: () => NOW,
  });

  const put = doc.puts()[0];
  assert.equal(put.input.Item.pk, 'CONFIG#image');
  assert.equal(put.input.Item.sk, 'FLEET');
  assert.equal(put.input.Item.tag, 'pi-obs-41');
  // The digest is provenance; `tag` is what image-source.js resolves against the repo. Both are
  // written because publish-image.mjs writes both, and the two writers must agree while both exist.
  assert.equal(put.input.Item.imageDigest, 'sha256:deadbeef');
  assert.equal(put.input.Item.publishedBy, 'sandbox');
  assert.equal(r.written, true);
  assert.match(r.imageUri, /agent-gn0p84core:pi-obs-41$/);
});

test('publish-image REFUSES a tag that is not in ECR, and writes nothing', async () => {
  const doc = fakeDoc();
  const out = fakeOut();
  // The failure this prevents is silent: a bad pointer provisions runtimes that cannot pull, so
  // every agent breaks on its NEXT message and nothing points back at the publish.
  const e = await rel['release publish-image'](ctxFor(), publish(), out, {
    doc, ecr: fakeEcr({ missing: true }), sts: fakeSts(),
  }).then(() => null, (err) => err);
  assert.equal(e.exitCode, EXIT.REFUSED);
  assert.match(e.message, /does not exist in ECR/);
  assert.equal(doc.writes().length, 0);
});

test('publish-image REFUSES an amd64 image — microVMs are arm64', async () => {
  const doc = fakeDoc();
  const out = fakeOut();
  // "almost always the amd64 dispatcher image published by mistake" — same tree, minutes apart.
  const e = await rel['release publish-image'](ctxFor(), publish(), out, {
    doc, ecr: fakeEcr({ arches: ['amd64'] }), sts: fakeSts(),
  }).then(() => null, (err) => err);
  assert.equal(e.exitCode, EXIT.REFUSED);
  assert.match(e.message, /amd64/);
  assert.equal(doc.writes().length, 0);
});

test('publish-image --agent writes the per-agent override, not the fleet key', async () => {
  const doc = fakeDoc();
  const out = fakeOut();
  await rel['release publish-image'](ctxFor(), publish({ values: { agent: 'dm-u0x' } }), out, {
    doc, ecr: fakeEcr(), sts: fakeSts(), user: 'sandbox',
  });
  assert.equal(doc.puts()[0].input.Item.sk, 'AGENT#dm-u0x');
  // The fleet pointer must be untouched — a canary that moved the fleet is the opposite of a canary.
  assert.equal(doc.puts().filter((p) => p.input.Item.sk === 'FLEET').length, 0);
});

test('publish-image --clear unpins EVERY agent and never touches the fleet pointer', async () => {
  const doc = fakeDoc([
    { pk: 'CONFIG#image', sk: 'FLEET', tag: 'pi-obs-40' },
    { pk: 'CONFIG#image', sk: 'AGENT#dm-u0x', tag: 'pi-obs-41' },
    { pk: 'CONFIG#image', sk: 'AGENT#ch-c01', tag: 'pi-obs-42' },
  ]);
  const out = fakeOut();
  const r = await rel['release publish-image'](ctxFor(), { positionals: [], values: { clear: true } }, out, {
    doc, ecr: fakeEcr(), sts: fakeSts(),
  });

  assert.equal(r.count, 2);
  assert.deepEqual(r.cleared.map((c) => c.agent), ['ch-c01', 'dm-u0x']);
  assert.equal(doc.store.has('CONFIG#image AGENT#dm-u0x'), false);
  assert.equal(doc.store.has('CONFIG#image AGENT#ch-c01'), false);
  // THE INVARIANT. There is no spelling of this command that removes FLEET: with no baked fallback
  // (image-source.js:11-15) an absent fleet pointer is ImagePointerMissing on every provision — an
  // outage, not a rollback. Unpinning converges agents ONTO the fleet image; it cannot remove it.
  assert.ok(doc.store.has('CONFIG#image FLEET'), 'the FLEET pointer must never be cleared');
  // The previous tag is reported, because it is the only record of what each agent was pinned to.
  assert.deepEqual(r.cleared.map((c) => c.tag).sort(), ['pi-obs-41', 'pi-obs-42']);
});

test('publish-image --clear --agent unpins only that agent', async () => {
  const doc = fakeDoc([
    { pk: 'CONFIG#image', sk: 'FLEET', tag: 'pi-obs-40' },
    { pk: 'CONFIG#image', sk: 'AGENT#dm-u0x', tag: 'pi-obs-41' },
    { pk: 'CONFIG#image', sk: 'AGENT#ch-c01', tag: 'pi-obs-42' },
  ]);
  const r = await rel['release publish-image'](ctxFor(), { positionals: [], values: { clear: true, agent: 'dm-u0x' } }, fakeOut(), {
    doc, ecr: fakeEcr(), sts: fakeSts(),
  });
  assert.equal(r.count, 1);
  assert.equal(doc.store.has('CONFIG#image AGENT#dm-u0x'), false);
  assert.ok(doc.store.has('CONFIG#image AGENT#ch-c01'), 'the other agent must be untouched');
  assert.ok(doc.store.has('CONFIG#image FLEET'));
});

test('publish-image --clear with nothing pinned is a no-op, not an error', async () => {
  const doc = fakeDoc([{ pk: 'CONFIG#image', sk: 'FLEET', tag: 'pi-obs-40' }]);
  const out = fakeOut();
  const r = await rel['release publish-image'](ctxFor(), { positionals: [], values: { clear: true } }, out, {
    doc, ecr: fakeEcr(), sts: fakeSts(),
  });
  assert.equal(r.count, 0);
  assert.equal(doc.writes().length, 0);
  assert.match(out.progressLines.join('\n'), /already follows the fleet pointer/);
});

test('publish-image --clear --dry-run names each agent it would unpin, and writes nothing', async () => {
  const doc = fakeDoc([
    { pk: 'CONFIG#image', sk: 'FLEET', tag: 'pi-obs-40' },
    { pk: 'CONFIG#image', sk: 'AGENT#dm-u0x', tag: 'pi-obs-41' },
  ]);
  const out = fakeOut();
  const r = await rel['release publish-image'](ctxFor({ dryRun: true }), { positionals: [], values: { clear: true } }, out, {
    doc, ecr: fakeEcr(), sts: fakeSts(),
  });
  assert.equal(r.dryRun, true);
  assert.equal(r.count, 1);
  assert.equal(doc.writes().length, 0);
  assert.match(out.progressLines.join('\n'), /would unpin dm-u0x \(currently pi-obs-41\)/);
});

test('publish-image --clear with a tag is a usage error, not a silent ignore', async () => {
  const doc = fakeDoc();
  const e = await rel['release publish-image'](ctxFor(), publish({ values: { clear: true } }), fakeOut(), {
    doc, ecr: fakeEcr(), sts: fakeSts(),
  }).then(() => null, (err) => err);
  assert.equal(e.exitCode, EXIT.USAGE);
  assert.equal(doc.writes().length, 0);
});

test('publish-image with no tag is a usage error', async () => {
  const e = await rel['release publish-image'](ctxFor(), { positionals: [], values: {} }, fakeOut(), {
    doc: fakeDoc(), ecr: fakeEcr(), sts: fakeSts(),
  }).then(() => null, (err) => err);
  assert.equal(e.exitCode, EXIT.USAGE);
});

test('publish-image --dry-run writes nothing but still runs the ECR gate', async () => {
  const doc = fakeDoc();
  const ecr = fakeEcr();
  const r = await rel['release publish-image'](ctxFor({ dryRun: true }), publish(), fakeOut(), {
    doc, ecr, sts: fakeSts(), user: 'sandbox',
  });
  assert.equal(r.written, false);
  assert.equal(r.dryRun, true);
  assert.equal(doc.writes().length, 0);
  // The gate must run in dry-run too, or "would publish" tells you nothing about whether it could.
  assert.ok(ecr.seen.includes('DescribeImagesCommand'));
});

test('the registry routes release publish-image and declares only agent/clear', () => {
  const meta = COMMANDS['release publish-image'];
  assert.ok(meta, 'release publish-image is not registered');
  assert.deepEqual(Object.keys(meta.options).sort(), ['agent', 'clear']);
  assert.equal(meta.positional, 'tag');
  // Key-first resolution: `publish-image` must not be answerable by some other noun's verb.
  assert.equal(load('release publish-image', meta, {}), rel['release publish-image']);
});

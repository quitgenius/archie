'use strict';

// Tests for `archie fleet deploy` and `archie fleet drift`.
//
// WHAT THESE TESTS ARE FOR. This file composes; almost nothing in it computes. So the tests are
// about ORDER and STOPPING, not about arithmetic:
//
//   · the pointer is never moved on an incomplete stage (exit 6 stops before `release set`);
//   · the pointer is never moved on a taint (exit 4 stops before `release set`);
//   · the flip is gated by `releaseRefusal` — the REAL one, run against real binding rows in a fake
//     table, so a second gate written here would have to disagree with it to pass;
//   · `--hotfix` narrows coverage to one agent and narrows NOTHING else;
//   · a post-release `runtime gc` failure never reports itself as "the pointer was not moved";
//   · an `efsRoot` change BLOCKS, in every mode including `--fix`, unless the agent's own
//     `AGENT#<id>/META.efsRoot` proves it is a §8.10 legacy adopt.
//
// No credentials, no network, no Docker and no subprocess: every composed step and the
// spec-baseline.mjs runner are injected.
//
// NOTE ON RESERVED WORDS. `agent` and `data` are DynamoDB reserved words and a fake client will
// happily accept a broken expression string (`registry-e2e.js:5-15`), so the check below is on every
// expression this file's code path produces. It produces exactly one DynamoDB call of its own — the
// `AGENT#<id>/META` GetItem, which is key-only and has no expression at all — and the rest come from
// cmd/generation.js and cmd/release.js, which assert their own.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const fleet = require('./fleet');
const { EXIT } = require('../lib/exit');
const { resourcesFor } = require('../lib/context');
const { COMMANDS, load } = require('../lib/registry');

const NAME = 'agent-gn0p84';
const TABLE = resourcesFor(NAME).configTable;
const GEN = 'gen-abc123';
const TAG = 'content-0123456789abcdef';
const IMAGE = `203366135563.dkr.ecr.us-east-1.amazonaws.com/${NAME}-agentcore:${TAG}`;

// ── doubles ──────────────────────────────────────────────────────────────────────────────────────

const DDB_WORDS = new Set(['begins_with', 'attribute_not_exists', 'attribute_exists', 'contains',
  'size', 'if_not_exists', 'SET', 'REMOVE', 'AND', 'OR', 'NOT']);

function assertAllNamesAliased(expr, where) {
  for (const m of String(expr).matchAll(/(.?)\b([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const [, prev, token] = m;
    if (prev === '#' || prev === ':') continue;
    assert.ok(DDB_WORDS.has(token), `${where}: bare attribute name "${token}" in "${expr}"`);
  }
}

const keyOf = (pk, sk) => `${pk} ${sk}`;

function fakeDoc(items = []) {
  const store = new Map(items.map((i) => [keyOf(i.pk, i.sk), { ...i }]));
  const seen = [];
  return {
    store,
    seen,
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      seen.push({ name, input });
      const foreign = name === 'QueryCommand' && input.IndexName === 'routing';
      for (const k of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression']) {
        if (input[k] && !foreign) assertAllNamesAliased(input[k], `${name}.${k}`);
      }
      if (name === 'GetCommand') return { Item: store.get(keyOf(input.Key.pk, input.Key.sk)) };
      if (name === 'ScanCommand') {
        const prefix = input.ExpressionAttributeValues && input.ExpressionAttributeValues[':p'];
        return { Items: [...store.values()].filter((i) => !prefix || String(i.pk).startsWith(prefix)) };
      }
      if (name === 'QueryCommand') {
        if (input.IndexName === 'routing') return { Items: [...store.values()].filter((i) => i.gsi1pk === 'ROUTING') };
        const pk = input.ExpressionAttributeValues[':pk'];
        return { Items: [...store.values()].filter((i) => i.pk === pk) };
      }
      throw new Error(`fakeDoc: unexpected ${name}`);
    },
  };
}

function fakeOut() {
  const o = {
    answers: [], progressLines: [], warnings: [], verboseLines: [], failures: [],
  };
  return Object.assign(o, {
    startedAt: 0,
    answer: (v) => o.answers.push(v),
    progress: (l) => o.progressLines.push(l),
    verbose: (l) => o.verboseLines.push(l),
    warn: (l) => o.warnings.push(l),
    failure: ({ agent = null, step = null, error = null } = {}) => o.failures.push({
      agent, step, error: error ? String(error.message || error) : null,
    }),
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

/** The composed steps, recording every call in order. */
function fakeSteps(over = {}) {
  const calls = [];
  const wrap = (name, impl) => async (ctx, args, out, deps) => {
    calls.push({ name, values: { ...args.values }, positionals: args.positionals, json: ctx.json, dryRun: ctx.dryRun });
    return impl(ctx, args, out, deps);
  };
  const steps = {
    build: wrap('build', over.build || (async () => ({ tag: TAG, image: IMAGE, skipped: true, built: false, pushed: false }))),
    stage: wrap('stage', over.stage || (async () => ({
      tag: TAG, image: IMAGE, agents: 2, coverage: 2, staged: 2, healthOk: 2, healthFailed: 0, healthPending: 0, stragglers: 0,
    }))),
    publish: wrap('publish', over.publish || (async () => ({ tag: TAG, written: true }))),
    gc: wrap('gc', over.gc || (async () => ({ reaped: [], kept: [], planned: [] }))),
  };
  return { calls, names: () => calls.map((c) => c.name), steps };
}

/** A taint record for TAG — the only DDB item that can stop a deploy at the gate. */
const taintItem = (over = {}) => ({
  pk: 'CONFIG#image',
  sk: `TAINT#${TAG}`,
  reason: 'healthcheck failed',
  taintedBy: 'sandbox',
  taintedAt: '2026-08-14T12:00:00Z',
  ...over,
});

const bindingItem = (agent, over = {}) => ({
  pk: `RUNTIME#${agent}`,
  sk: `GEN#oc_${agent}_fp000001`,
  agent,
  image: IMAGE,
  runtimeName: `oc_${agent}_fp000001`,
  arn: `arn:aws:bedrock-agentcore:us-east-1:203366135563:runtime/${agent}`,
  healthcheck: 'ok',
  ...over,
});

const routingItem = (agent) => ({ pk: `AGENT#${agent}`, sk: 'META#routing', gsi1pk: 'ROUTING', gsi1sk: agent, data: '{}' });

const fakeSts = () => ({ async send() { return { Account: '203366135563' }; } });

/** ECR double. `found: false` is "the tag is not in ECR", which the gate refuses on. */
const fakeEcr = (found = true) => ({
  async send(cmd) {
    const n = cmd.constructor.name;
    if (n === 'DescribeImagesCommand') {
      if (!found) { const e = new Error('nope'); e.name = 'ImageNotFoundException'; throw e; }
      return { imageDetails: [{ imageDigest: 'sha256:abc', imagePushedAt: new Date(0), imageSizeInBytes: 1 }] };
    }
    if (n === 'BatchGetImageCommand') {
      return { images: [{ imageManifest: JSON.stringify({ manifests: [{ platform: { architecture: 'arm64' } }] }) }] };
    }
    throw new Error(`fakeEcr: unexpected ${n}`);
  },
});

/** A table where the gate PASSES: both bindings are live, healthy and on TAG. */
const healthyTable = () => [bindingItem('a1'), bindingItem('a2'), routingItem('a1'), routingItem('a2')];

// ── fleet deploy: the happy path ─────────────────────────────────────────────────────────────────

test('gc runs FIRST, then build -> stage -> gate -> publish', async () => {
  const s = fakeSteps();
  const out = fakeOut();
  const result = await fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, out,
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });

  // GC MOVED TO THE FRONT (2026-08-15). Reaping after a release destroys rollback targets in the
  // window they are most likely to be wanted, and recovering one is not a re-run: AgentCore holds a
  // deleted runtime's name for 3.5-10+ minutes, so a re-stage of a reaped generation is measured in
  // hours across the fleet. Reaping first does it from a known-good state instead.
  assert.deepEqual(s.names(), ['gc', 'build', 'stage', 'publish'],
    'gc -> build -> create -> stage -> gate -> release set');
  assert.equal(result.imageTag, TAG);
  assert.equal(result.mode, 'staged');
  assert.equal(result.imageTag, TAG);
});

test('the image tag comes from the build, and the build always pushes', async () => {
  const s = fakeSteps();
  await fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, fakeOut(),
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  const build = s.calls.find((c) => c.name === 'build');
  assert.equal(build.values.push, true, 'an unpushed image is one no agent can pull');
  const stage = s.calls.find((c) => c.name === 'stage');
  assert.equal(stage.values.tag, TAG, 'staging uses the tag the build produced, not a re-derived one');
});

test('sub-steps are run in --json mode so their structured answer can be read', async () => {
  const s = fakeSteps();
  await fleet['fleet deploy'](ctxFor({ json: false }), { positionals: [], values: {} }, fakeOut(),
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  assert.ok(s.calls.every((c) => c.json === true),
    'the generation id is read out of `generation create`\'s answer — a paragraph has none');
});

test('only ONE answer reaches stdout — the composed one', async () => {
  const s = fakeSteps();
  const out = fakeOut();
  await fleet['fleet deploy'](ctxFor({ json: false }), { positionals: [], values: {} }, out,
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  assert.equal(out.answers.length, 1, 'stdout carries the answer and only the answer (§1.4)');
  assert.match(out.answers[0], /downtime {4}none/);
});

test('concurrency is passed through to stage unparsed — the EFS clamp lives there', async () => {
  const s = fakeSteps();
  await fleet['fleet deploy'](ctxFor(), { positionals: [], values: { concurrency: '9' } }, fakeOut(),
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  assert.equal(s.calls.find((c) => c.name === 'stage').values.concurrency, '9',
    'the bound is EFS CreateAccessPoint and cmd/stage.js owns the clamp and the warning (§5.3)');
});

test('--keep is passed through to runtime gc', async () => {
  const s = fakeSteps();
  await fleet['fleet deploy'](ctxFor(), { positionals: [], values: { keep: '2' } }, fakeOut(),
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  assert.equal(s.calls.find((c) => c.name === 'gc').values.keep, '2');
});

// ── the two exits that must never move the pointer ───────────────────────────────────────────────

test('EXIT 4: a healthcheck failure taints and the pointer is NEVER moved', async () => {
  const tainted = Object.assign(new Error('2 healthcheck(s) failed'), { exitCode: EXIT.TAINTED });
  const s = fakeSteps({ stage: async () => { throw tainted; } });
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, fakeOut(),
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.TAINTED,
  );
  assert.ok(!s.names().includes('publish'), 'exit 4 means tainted, pointer not moved (§2.19)');
  // gc DID run — it leads every deploy now. Harmless here: it reaped from a known-good state before
  // anything was attempted, so a failed deploy leaves a cleaner quota rather than a dirtier one.
  assert.deepEqual(s.names(), ['gc', 'build', 'stage'], 'it stopped at stage; nothing after it ran');
});

test('EXIT 6: stragglers stop the run BEFORE release set', async () => {
  const s = fakeSteps({
    stage: async (ctx, args, out) => {
      out.failure({ agent: 'a2', step: 'provision', error: new Error('Rate exceeded') });
      return { tag: TAG, agents: 2, coverage: 1, healthOk: 1, healthFailed: 0 };
    },
  });
  const out = fakeOut();
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, out,
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.PARTIAL && /pointer was NOT moved/.test(e.message),
  );
  assert.ok(!s.names().includes('publish'));
  assert.equal(out.failures.length, 1, 'the per-agent failure still names WHICH agent failed');
});

test('EXIT 6: incomplete coverage stops the run even with no per-agent failure', async () => {
  // The shape this catches: an agent that was never attempted at all, so nothing called out.failure()
  // and staging still reported success for what it did do.
  const s = fakeSteps({ stage: async () => ({ tag: TAG, agents: 208, coverage: 207, healthOk: 207, healthFailed: 0 }) });
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, fakeOut(),
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.PARTIAL && /207 of 208/.test(e.message),
  );
  assert.ok(!s.names().includes('publish'));
});

// ── the gate is `releaseRefusal`, not a local opinion ────────────────────────────────────────────

test('EXIT 5: the gate refuses a tag whose healthcheck never ran', async () => {
  // Staging claims success; the BINDINGS say `pending`. The gate reads the table, not the claim.
  const s = fakeSteps();
  const table = [bindingItem('a1', { healthcheck: 'pending' }), bindingItem('a2')];
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, fakeOut(),
      { doc: fakeDoc(table), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.REFUSED && /healthcheck has not run/.test(e.message),
  );
  assert.ok(!s.names().includes('publish'), 'the flip is refused before it is attempted');
});

test('EXIT 5: the gate refuses a TAINTED tag in every mode, including --hotfix', async () => {
  const s = fakeSteps();
  const table = [taintItem(), bindingItem('a1'), routingItem('a1')];
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: { hotfix: true, canary: 'a1' } }, fakeOut(),
      { doc: fakeDoc(table), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.REFUSED && /TAINTED/.test(e.message),
  );
  assert.ok(!s.names().includes('publish'));
});

test('EXIT 5: the gate refuses a tag with a FAILED healthcheck row', async () => {
  const s = fakeSteps();
  const table = [bindingItem('a1', { healthcheck: 'failed' }), bindingItem('a2')];
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, fakeOut(),
      { doc: fakeDoc(table), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.REFUSED && /FAILED healthcheck/.test(e.message),
  );
});

test('there is no force flag: an unknown value cannot turn the refusal off', async () => {
  const s = fakeSteps();
  const table = [bindingItem('a1', { healthcheck: 'failed' })];
  for (const values of [{ force: true }, { yes: true }, { hotfix: true, canary: 'a1' }]) {
    await assert.rejects(
      () => fleet['fleet deploy'](ctxFor(), { positionals: [], values }, fakeOut(),
        { doc: fakeDoc([...table, routingItem('a1')]), sts: fakeSts(), ecr: fakeEcr(), steps: fakeSteps().steps }),
      (e) => e.exitCode === EXIT.REFUSED,
    );
  }
  assert.ok(!s.names().includes('publish'));
});

// ── hotfix ───────────────────────────────────────────────────────────────────────────────────────

test('--hotfix stages ONE canary and flips with mode=hotfix', async () => {
  const s = fakeSteps({ stage: async () => ({ tag: TAG, agents: 1, coverage: 1, healthOk: 1, healthFailed: 0 }) });
  const result = await fleet['fleet deploy'](ctxFor(), { positionals: [], values: { hotfix: true } }, fakeOut(),
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });

  const stage = s.calls.find((c) => c.name === 'stage');
  assert.equal(stage.values.agents, 'a1', 'one canary, deterministic (first in sorted order)');
  assert.equal(s.calls.find((c) => c.name === 'publish').values.hotfix, true);
  assert.equal(result.canary, 'a1');
});

test('--hotfix narrows COVERAGE, never VERIFICATION — the canary is healthchecked and can taint', async () => {
  const tainted = Object.assign(new Error('healthcheck failed'), { exitCode: EXIT.TAINTED });
  const s = fakeSteps({ stage: async () => { throw tainted; } });
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: { hotfix: true, canary: 'a2' } }, fakeOut(),
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.TAINTED,
  );
  assert.ok(!s.names().includes('publish'), '§3.2: the hotfix does not ship, the old generation still serves');
});

test('--canary must name a real agent', async () => {
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: { hotfix: true, canary: 'nope' } }, fakeOut(),
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: fakeSteps().steps }),
    (e) => e.exitCode === EXIT.USAGE && /no routing entry/.test(e.message),
  );
});

test('--canary without --hotfix is a usage error, not a silently ignored flag', async () => {
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: { canary: 'a1' } }, fakeOut(),
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: fakeSteps().steps }),
    (e) => e.exitCode === EXIT.USAGE,
  );
});

// ── build skipping and resuming ──────────────────────────────────────────────────────────────────

test('--skip-build skips the build and uses the tag it is given', async () => {
  const s = fakeSteps();
  await fleet['fleet deploy'](ctxFor(), { positionals: [], values: { 'skip-build': true, tag: TAG } }, fakeOut(),
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  assert.ok(!s.names().includes('build'));
  assert.equal(s.calls.find((c) => c.name === 'stage').values.tag, TAG);
});

test('--skip-build with no --tag derives the same content tag the build would have', async () => {
  const s = fakeSteps();
  await fleet['fleet deploy'](ctxFor(), { positionals: [], values: { 'skip-build': true } }, fakeOut(),
    {
      // The gate reads bindings for the DERIVED tag, so the table has to hold them under that tag —
      // otherwise this asserts "unstaged tags are refused", which is a different test.
      doc: fakeDoc([bindingItem('a1', { image: `203366135563.dkr.ecr.us-east-1.amazonaws.com/${NAME}-agentcore:content-abcdef0123456789` }), routingItem('a1')]),
      sts: fakeSts(),
      ecr: fakeEcr(),
      steps: s.steps,
      digestFor: () => ({ digest: 'abcdef0123456789ff', tag: 'content-abcdef0123456789' }),
    });
  assert.equal(s.calls.find((c) => c.name === 'stage').values.tag, 'content-abcdef0123456789');
});

test('re-running with an unchanged tree is the resume: the build skips, staging is additive', () => {
  // `--generation <id>` used to mean "carry on with THAT generation". There is nothing to carry on
  // with, and nothing was lost: the tag is a content digest of the build's own inputs, so an
  // unchanged tree derives the SAME tag, finds it in ECR, skips the build and stages over what is
  // already staged. Resuming is what running it again does.
  //
  // Asserted as a property of the digest rather than through the composed command, because that is
  // where it actually holds: two derivations of the same inputs, one string.
  const { digestFor, tagFor } = require('../lib/digest');
  const a = digestFor('agent');
  const b = digestFor('agent');
  assert.equal(tagFor(a.digest), tagFor(b.digest));
});

test('a refusal still publishes the report — a thrown handler returns nothing', async () => {
  const s = fakeSteps();
  const out = fakeOut();
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, out,
      { doc: fakeDoc([bindingItem('a1', { healthcheck: 'pending' })]), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.REFUSED,
  );
  assert.equal(out.answers.length, 1);
  assert.equal(out.answers[0].imageTag, TAG, 'the --json envelope still says what was attempted');
});

// ── dry run ──────────────────────────────────────────────────────────────────────────────────────

test('a dry run stops after staging and never evaluates the gate or the flip', async () => {
  const s = fakeSteps({ stage: async () => ({ tag: TAG, wouldStage: [{ agent: 'a1' }], skipped: 0, dryRun: true }) });
  const out = fakeOut();
  const result = await fleet['fleet deploy'](ctxFor({ dryRun: true }), { positionals: [], values: {} }, out,
    { doc: fakeDoc([]), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });
  assert.deepEqual(s.names(), ['build', 'stage'], 'a dry run reaps nothing');
  assert.equal(result.dryRun, true);
  assert.match(out.progressLines.join('\n'), /gate {8}not evaluated/);
});

// ── retention, BEFORE anything is created ────────────────────────────────────────────────────────

test('a per-unit gc failure warns and the deploy still proceeds', async () => {
  const s = fakeSteps({
    gc: async (ctx, args, out) => {
      out.failure({ agent: 'a1', step: 'runtime delete', error: new Error('ThrottlingException') });
      return { reaped: [], kept: [] };
    },
  });
  const out = fakeOut();
  const result = await fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, out,
    { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps });

  // A runtime that would not reap costs quota, not availability — and nothing has been created at
  // this point, so it cannot make the deploy wrong. A forwarded failure would exit 6, which out of
  // this command means "pointer not moved" (§2.19).
  assert.equal(out.failures.length, 0);
  assert.equal(result.gcFailures.length, 1, 'it is still reported, per agent, in the result');
  assert.ok(s.names().includes('publish'), 'the deploy completed despite the failed reap');
});

test('a THROWN gc stops the deploy BEFORE anything is created', async () => {
  const s = fakeSteps({
    gc: async () => { throw Object.assign(new Error('hit a service quota'), { exitCode: EXIT.HEADROOM }); },
  });
  await assert.rejects(
    () => fleet['fleet deploy'](ctxFor(), { positionals: [], values: {} }, fakeOut(),
      { doc: fakeDoc(healthyTable()), sts: fakeSts(), ecr: fakeEcr(), steps: s.steps }),
    (e) => e.exitCode === EXIT.HEADROOM,
  );
  // Deliberately NOT swallowed. 8 means the quota cannot fit what is about to be created, so
  // continuing would march into a doomed 208-runtime staging pass and fail later and messier.
  // Nothing was created, so the fleet is exactly as it was — a clean stop, re-runnable.
  assert.deepEqual(s.names(), ['gc'], 'it stopped at gc: no build, no create, no stage, no release');
});

// ── fleet drift ──────────────────────────────────────────────────────────────────────────────────

const AGENTS = {
  a1: { name: 'a1-gen1', image: IMAGE, efsRoot: '/openclaw-data/a1', spec: {}, liveAtAws: true },
  a2: { name: 'a2-gen1', image: IMAGE, efsRoot: '/openclaw-data/a2', spec: {}, liveAtAws: true },
};

const baselineReport = (agents = AGENTS, over = {}) => JSON.stringify({
  tdArn: 'arn:aws:ecs:us-east-1:203366135563:task-definition/agent-gn0p84-dispatcher:70',
  fleetImage: IMAGE,
  generatedFor: Object.keys(agents).length,
  agents,
  ...over,
});

const driftDeps = (stdout, { code = 0, doc = fakeDoc([]), file = null, steps } = {}) => ({
  doc,
  runNode: async () => ({ code, stdout, stderr: '# task definition: 70\n' }),
  readFile: () => file,
  ...(steps ? { steps } : {}),
});

const runDrift = (values, deps) => fleet['fleet drift'](ctxFor(), { positionals: [], values }, fakeOut(), deps);

test('no drift: every derived name is live at AWS', async () => {
  const r = await runDrift({}, driftDeps(baselineReport()));
  assert.equal(r.agents, 2);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.dataLoss, []);
});

test('EXIT 7: a derived name that is not live at AWS is drift', async () => {
  const agents = { ...AGENTS, a2: { ...AGENTS.a2, liveAtAws: false } };
  await assert.rejects(
    () => runDrift({}, driftDeps(baselineReport(agents))),
    (e) => e.exitCode === EXIT.DRIFT && /1 agent\(s\) drift/.test(e.message),
  );
});

test('EXIT 7: a changed runtime NAME is a roll and is accepted as fixable drift', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2' } };
  await assert.rejects(
    () => runDrift({ compare: 'baseline.json' }, driftDeps(baselineReport(now), { file: baselineReport() })),
    (e) => e.exitCode === EXIT.DRIFT,
  );
});

test('EXIT 5: a changed efsRoot is DATA LOSS and blocks', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2', efsRoot: '/openclaw-data/dm-u01' } };
  await assert.rejects(
    () => runDrift({ compare: 'baseline.json' }, driftDeps(baselineReport(now), { code: 1, file: baselineReport() })),
    (e) => e.exitCode === EXIT.REFUSED && /data loss, not a roll/.test(e.message),
  );
});

test('--fix NEVER applies an efsRoot change: it refuses before staging anything', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2', efsRoot: '/openclaw-data/dm-u01' } };
  const s = fakeSteps();
  await assert.rejects(
    () => runDrift({ compare: 'baseline.json', fix: true },
      driftDeps(baselineReport(now), { code: 1, file: baselineReport(), steps: s.steps })),
    (e) => e.exitCode === EXIT.REFUSED,
  );
  assert.deepEqual(s.names(), [], '§2.21: refuses to apply an efsRoot change, ever, in any mode');
});

// THE BLIND SPOT. `derivedSpecFor` always derives efsRootDir(agent, prefix), so a §8.10-rekeyed agent
// that legitimately adopted its old directory looks like data loss to a naive comparison.
test('a §8.10 legacy adopt is NOT data loss — META.efsRoot proves it, and the script\'s exit 1 is explained', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2', efsRoot: '/openclaw-data/dm-u01ab' } };
  const doc = fakeDoc([{ pk: 'AGENT#a1', sk: 'META', data: JSON.stringify({ efsRoot: 'dm-u01ab' }) }]);
  await assert.rejects(
    () => runDrift({ compare: 'baseline.json' }, driftDeps(baselineReport(now), { code: 1, file: baselineReport(), doc })),
    (e) => e.exitCode === EXIT.DRIFT,          // a roll, not a refusal
  );
});

test('an unreadable META leaves an efsRoot difference blocking — an unproven difference is data loss', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2', efsRoot: '/openclaw-data/dm-u01ab' } };
  const doc = { doc: () => ({ async send() { throw new Error('AccessDenied'); } }) };
  await assert.rejects(
    () => fleet['fleet drift'](ctxFor(), { positionals: [], values: { compare: 'b.json' } }, fakeOut(), {
      aws: doc,
      runNode: async () => ({ code: 1, stdout: baselineReport(now), stderr: '' }),
      readFile: () => baselineReport(),
    }),
    (e) => e.exitCode === EXIT.REFUSED,
  );
});

test('--fix stages the drifted agents onto the ACTIVE generation', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2' } };
  const s = fakeSteps({ stage: async () => ({ tag: TAG, agents: 1, coverage: 1, healthOk: 1 }) });
  const doc = fakeDoc([{ pk: 'CONFIG#image', sk: 'FLEET', tag: TAG }]);
  const r = await runDrift({ compare: 'b.json', fix: true },
    driftDeps(baselineReport(now), { file: baselineReport(), doc, steps: s.steps }));
  const stage = s.calls.find((c) => c.name === 'stage');
  assert.equal(stage.values.tag, TAG);
  assert.equal(stage.values.agents, 'a1');
  assert.equal(r.fixed.agents.length, 1);
});

test('--fix with nothing published fails rather than guessing a tag', async () => {
  const now = { ...AGENTS, a1: { ...AGENTS.a1, name: 'a1-gen2' } };
  await assert.rejects(
    () => runDrift({ compare: 'b.json', fix: true }, driftDeps(baselineReport(now), { file: baselineReport() })),
    (e) => e.exitCode === EXIT.FAILED && /active image pointer/.test(e.message),
  );
});

test('a script that produced no report is exit 1, with its stderr preserved', async () => {
  await assert.rejects(
    () => fleet['fleet drift'](ctxFor(), { positionals: [], values: {} }, fakeOut(), {
      doc: fakeDoc([]),
      runNode: async () => ({ code: 1, stdout: '', stderr: 'FAILED: CredentialsProviderError\n' }),
    }),
    (e) => e.exitCode === EXIT.FAILED && /CredentialsProviderError/.test(e.detail),
  );
});

// ── the refusal to read the local shell ──────────────────────────────────────────────────────────

test('the baseline script never inherits the shell\'s dispatcher configuration', async () => {
  const env = fleet.baselineEnv(ctxFor({ profile: 'sandbox' }), {
    PATH: '/bin',
    HOME: '/home/x',
    AWS_PROFILE: 'agent-848o7l',
    AWS_SESSION_TOKEN: 'tok',
    AGENT_CONFIG_TABLE: 'another-stacks-table',
    EFS_ROOT_PREFIX: '/somewhere-else',
    ARCHIE_STACK: 'openclaw',
  });
  assert.equal(env.AGENT_CONFIG_TABLE, undefined,
    'spec-baseline.mjs only applies task-definition env where the shell left a hole (:49-51)');
  assert.equal(env.EFS_ROOT_PREFIX, undefined);
  assert.equal(env.ARCHIE_STACK, undefined);
  assert.equal(env.AWS_SESSION_TOKEN, 'tok', 'credentials are not configuration');
  assert.equal(env.AWS_PROFILE, 'sandbox', '--profile wins over the shell');
  assert.equal(env.ARCHIE_CLUSTER, resourcesFor(NAME).cluster);
  assert.equal(env.ARCHIE_SERVICE, resourcesFor(NAME).dispatcherService);
  assert.equal(env.AWS_REGION, 'us-east-1');
});

// ── pure classification ──────────────────────────────────────────────────────────────────────────

test('classifyCompare: same name is same, changed name is a roll, changed efsRoot is neither', () => {
  const before = { a: { name: 'n1', efsRoot: '/r/a' }, b: { name: 'n1', efsRoot: '/r/b' }, c: { name: 'n1', efsRoot: '/r/c' } };
  const now = { a: { name: 'n1', efsRoot: '/r/a' }, b: { name: 'n2', efsRoot: '/r/b' }, c: { name: 'n2', efsRoot: '/r/CHANGED' } };
  const r = fleet.classifyCompare(now, before);
  assert.deepEqual(r.same, ['a']);
  assert.deepEqual(r.rolled.map((x) => x.agent), ['b']);
  assert.deepEqual(r.efsChanged.map((x) => x.agent), ['c']);
});

test('classifyCompare ignores agents the baseline never knew about', () => {
  const r = fleet.classifyCompare({ new: { name: 'n', efsRoot: '/r/new' } }, {});
  assert.deepEqual(r, { same: [], rolled: [], efsChanged: [] });
});

test('isLegacyAdopt matches only a trailing path segment', () => {
  assert.equal(fleet.isLegacyAdopt('/openclaw-data/dm-u01', 'dm-u01'), true);
  assert.equal(fleet.isLegacyAdopt('/openclaw-data/dm-u01x', 'dm-u01'), false);
  assert.equal(fleet.isLegacyAdopt('/openclaw-data/dm-u01', null), false);
});

// ── registry wiring ──────────────────────────────────────────────────────────────────────────────

test('both commands resolve through the registry under their full keys', () => {
  for (const key of ['fleet deploy', 'fleet drift']) {
    assert.equal(typeof load(key, COMMANDS[key]), 'function', `registry cannot load \`archie ${key}\``);
  }
});

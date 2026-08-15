'use strict';

// Nothing here touches AWS, the network, Docker or `make`: every client and the subprocess runner is
// injected. What that CANNOT test is the one thing most likely to break in production — a DynamoDB
// expression with an unaliased reserved word, since a fake client "happily asserted the broken
// expression string" (registry-e2e.js:5-15). So the fake below asserts a structural property of every
// expression it is handed instead: no bare attribute identifiers, anywhere, ever. That is as close as
// a unit test gets; an e2e against a real table is what actually proves it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const gen = require('./generation');
const { EXIT } = require('../lib/exit');
const { createOutput } = require('../lib/output');
const { resourcesFor } = require('../lib/context');

// ── harness ──────────────────────────────────────────────────────────────────────────────────────

function makeCtx(over = {}) {
  const name = over.name || 'agent-gn0p84';
  return {
    name,
    region: 'us-east-1',
    profile: null,
    account: null,
    dryRun: false,
    assumeYes: false,
    json: false,
    verbosity: 0,
    timeoutSeconds: null,
    resources: resourcesFor(name),
    ...over,
  };
}

function makeOut(over = {}) {
  const stdout = [];
  const stderr = [];
  const out = createOutput({
    streams: { stdout: { write: (s) => stdout.push(s) }, stderr: { write: (s) => stderr.push(s) } },
    ...over,
  });
  out.stdout = stdout;
  out.stderr = stderr;
  return out;
}

// DynamoDB expressions name attributes ONLY through `#alias` placeholders. Anything that looks like a
// bare identifier and is not a DynamoDB function or keyword is the 2026-08-13 outage in miniature.
const DDB_WORDS = new Set(['begins_with', 'attribute_not_exists', 'attribute_exists', 'attribute_type',
  'contains', 'size', 'if_not_exists', 'list_append', 'SET', 'REMOVE', 'ADD', 'DELETE', 'AND', 'OR', 'NOT', 'BETWEEN', 'IN']);

function assertAllNamesAliased(expr, where) {
  for (const token of String(expr).match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
    // Only flag tokens NOT preceded by # or : — the regex above strips the sigil, so re-check.
    const at = String(expr).indexOf(token);
    const prev = at > 0 ? String(expr)[at - 1] : '';
    if (prev === '#' || prev === ':') continue;
    assert.ok(DDB_WORDS.has(token), `${where}: bare attribute name "${token}" in "${expr}" — alias everything (runtime-registry.js:134-138)`);
  }
}

/**
 * A fake DynamoDBDocumentClient. Items live in a Map keyed `pk\u0000sk`; the commands are the real
 * ones, so `cmd.constructor.name` and `cmd.input` are exactly what the SDK would carry.
 */
function fakeDoc(items = []) {
  const store = new Map(items.map((i) => [`${i.pk}\u0000${i.sk}`, i]));
  const seen = [];
  return {
    store,
    seen,
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      seen.push({ name, input });
      for (const key of ['KeyConditionExpression', 'FilterExpression', 'ConditionExpression', 'UpdateExpression', 'ProjectionExpression']) {
        if (input[key]) assertAllNamesAliased(input[key], `${name}.${key}`);
      }
      if (name === 'GetCommand') {
        return { Item: store.get(`${input.Key.pk}\u0000${input.Key.sk}`) || undefined };
      }
      if (name === 'QueryCommand') {
        const pk = input.ExpressionAttributeValues[':pk'];
        return { Items: [...store.values()].filter((i) => i.pk === pk) };
      }
      if (name === 'ScanCommand') {
        const prefix = input.ExpressionAttributeValues[':p'];
        return { Items: [...store.values()].filter((i) => String(i.pk).startsWith(prefix)) };
      }
      if (name === 'PutCommand') {
        const key = `${input.Item.pk}\u0000${input.Item.sk}`;
        if (input.ConditionExpression && store.has(key)) {
          const e = new Error('The conditional request failed');
          e.name = 'ConditionalCheckFailedException';
          throw e;
        }
        store.set(key, input.Item);
        return {};
      }
      throw new Error(`fakeDoc: unexpected ${name}`);
    },
  };
}

const fakeSts = (Account = '203366135563') => ({ async send() { return { Account }; } });

function fakeEcr({ present = {}, manifest = null } = {}) {
  return {
    calls: [],
    async send(cmd) {
      const name = cmd.constructor.name;
      this.calls.push(name);
      const tag = cmd.input.imageIds && cmd.input.imageIds[0] && cmd.input.imageIds[0].imageTag;
      if (name === 'DescribeImagesCommand') {
        if (!present[tag]) {
          const e = new Error('not found');
          e.name = 'ImageNotFoundException';
          throw e;
        }
        return { imageDetails: [{ imageDigest: present[tag], imageSizeInBytes: 1048576, imagePushedAt: new Date(0) }] };
      }
      if (name === 'BatchGetImageCommand') {
        return { images: [{ imageManifest: JSON.stringify(manifest || { manifests: [{ platform: { architecture: 'arm64', os: 'linux' } }] }) }] };
      }
      if (name === 'GetAuthorizationTokenCommand') {
        return { authorizationData: [{ authorizationToken: Buffer.from('AWS:pw:with:colons').toString('base64') }] };
      }
      throw new Error(`fakeEcr: unexpected ${name}`);
    },
  };
}

// The dispatcher's spec computation, standing in for createAgentCoreClient. Deliberately shaped
// EXACTLY like the real runtimeSpecFor return (agentcore-client.js:904-915) — the real one is
// exercised for real in the reuse test at the bottom of this file.
function fakeAgentCore(overrides = {}) {
  const config = {
    region: 'us-east-1',
    efsRootPrefix: '/openclaw-data',
    efsMountPath: '/mnt/efs',
    securityGroupId: 'sg-123',
    agentConfigTable: 'agent-gn0p84-config',
    extraEnv: {},
    ...overrides,
  };
  return {
    config,
    runtimeSpecFor(agent, image) {
      return {
        image,
        efsRoot: `${config.efsRootPrefix}/agents/${agent}`,
        efsMountPath: config.efsMountPath,
        envs: {
          AGENT_NAME: agent,
          REGION: config.region,
          EFS_DIR: config.efsMountPath,
          AGENT_CONFIG_TABLE: config.agentConfigTable,
          ...config.extraEnv,
        },
        securityGroupId: config.securityGroupId,
        idleRuntimeSessionTimeout: 900,
        maxLifetime: 28800,
        serverProtocol: 'HTTP',
      };
    },
  };
}

const baseDeps = (over = {}) => ({
  doc: fakeDoc(over.items || []),
  sts: fakeSts(),
  ecr: over.ecr || fakeEcr({ present: { 'archie-0.2.6': 'sha256:abc' } }),
  agentcore: (o) => fakeAgentCore({ ...o, ...(o.extraEnv ? { extraEnv: o.extraEnv } : {}) }),
  efsRootDir: (agent, prefix) => `${prefix}/agents/${agent}`,
  canonicalize: require('../../slack-dispatcher/agentcore-client').canonicalize,
  now: () => Date.parse('2026-08-14T20:03:11.000Z'),
  user: 'sandbox',
  ...over,
});

const args = (values = {}, positionals = []) => ({ values, positionals });

async function rejects(fn, code, match) {
  await assert.rejects(fn, (e) => {
    assert.equal(e.exitCode, code, `expected exit ${code}, got ${e.exitCode}: ${e.message}`);
    if (match) assert.match(`${e.message} ${e.detail || ''}`, match);
    return true;
  });
}

// A generation item exactly as create() writes one, for the read-side tests.
function generationItem(id, spec, extra = {}) {
  const { canonical, specDigest } = gen.canonicalGeneration(spec, { canonicalize: require('../../slack-dispatcher/agentcore-client').canonicalize });
  return {
    pk: gen.GENERATION_PK,
    sk: id,
    data: JSON.stringify({
      generationId: id,
      spec: canonical,
      specDigest,
      image: spec.image,
      imageTag: spec.image.split(':').pop(),
      imageDigest: 'sha256:abc',
      createdAt: extra.createdAt || '2026-08-14T20:03:11.000Z',
      createdBy: 'sandbox',
    }),
    ...extra,
  };
}

const SPEC = {
  image: '203366135563.dkr.ecr.us-east-1.amazonaws.com/agent-gn0p84core:archie-0.2.6',
  efsRootPrefix: '/openclaw-data',
  efsMountPath: '/mnt/efs',
  securityGroupId: 'sg-123',
  idleRuntimeSessionTimeout: 900,
  maxLifetime: 28800,
  serverProtocol: 'HTTP',
  runtimeEnv: { REGION: 'us-east-1', EFS_DIR: '/mnt/efs' },
};

const binding = (agent, generationId, over = {}) => ({
  pk: `RUNTIME#${agent}`,
  sk: `GEN#${generationId}`,
  agent,
  generationId,
  runtimeName: `oc_${agent}_${generationId}`,
  arn: `arn:aws:bedrock-agentcore:us-east-1:203366135563:runtime/oc_${agent}-XYZ`,
  runtimeId: `oc_${agent}-XYZ`,
  healthcheck: 'ok',
  ...over,
});

// ── canonical form and the digest ────────────────────────────────────────────────────────────────

test('canonical form sorts keys, so two specs built in different orders hash identically', () => {
  const a = gen.canonicalGeneration({ image: 'i', runtimeEnv: { B: '2', A: '1' }, serverProtocol: 'HTTP' });
  const b = gen.canonicalGeneration({ serverProtocol: 'HTTP', runtimeEnv: { A: '1', B: '2' }, image: 'i' });
  assert.equal(a.specDigest, b.specDigest);
  assert.equal(a.json, b.json);
  assert.match(a.specDigest, /^[0-9a-f]{16}$/);
});

test('canonical form sorts arrays of primitives — an AWS-order-dependent hash mints runtimes for nothing', () => {
  const a = gen.canonicalGeneration({ subnets: ['b', 'a', 'c'] });
  const b = gen.canonicalGeneration({ subnets: ['c', 'b', 'a'] });
  assert.equal(a.specDigest, b.specDigest);
  assert.equal(a.json, '{"subnets":["a","b","c"]}');
});

test('a changed value changes the digest', () => {
  assert.notEqual(
    gen.canonicalGeneration({ ...SPEC }).specDigest,
    gen.canonicalGeneration({ ...SPEC, maxLifetime: 3600 }).specDigest,
  );
});

test('the stored body round-trips byte-exact, so specDigest can be recomputed from the item', () => {
  const item = generationItem('rel-1', SPEC);
  const body = JSON.parse(item.data);
  assert.equal(JSON.stringify(body.spec), gen.canonicalGeneration(body.spec).json);
  assert.equal(gen.canonicalGeneration(body.spec).specDigest, body.specDigest);
});

// ── --set ────────────────────────────────────────────────────────────────────────────────────────

test('--set splits on the FIRST = so a value may contain more', () => {
  const { fields, env } = gen.parseSets(['efsRootPrefix=/agentcore-test', 'runtimeEnv.DISPATCHER_BASE_URL=https://x/y?a=b']);
  assert.equal(fields.efsRootPrefix, '/agentcore-test');
  assert.equal(env.DISPATCHER_BASE_URL, 'https://x/y?a=b');
});

test('--set maxLifetime is REFUSED before its value is even coerced', () => {
  // It used to coerce to a number here, because a string would change the digest and break
  // CreateAgentRuntime. That coercion is now unreachable through --set: the saga hard-codes
  // maxLifetime, so the field is refused outright (see UNAPPLIABLE). The refusal must come FIRST —
  // "cannot be honoured" is more useful than "not a number", and it holds for a valid value too.
  assert.throws(() => gen.parseSets(['maxLifetime=3600']), (e) => e.exitCode === EXIT.REFUSED);
  assert.throws(() => gen.parseSets(['maxLifetime=soon']), (e) => e.exitCode === EXIT.REFUSED);
});

test('--set rejects an unknown field rather than silently dropping it', () => {
  assert.throws(() => gen.parseSets(['efsRootPrefixx=/x']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => gen.parseSets(['novalue']), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => gen.parseSets(['runtimeEnv.not-a-var=1']), (e) => e.exitCode === EXIT.USAGE);
});

// ── the fleet/per-agent split ────────────────────────────────────────────────────────────────────

test('the fleet template drops the per-agent terms and keeps the prefix', () => {
  const spec = gen.fleetSpecFrom(fakeAgentCore(), 'repo:tag', { fields: {}, env: {} });
  assert.equal(spec.efsRootPrefix, '/openclaw-data');
  assert.equal(spec.efsRoot, undefined);
  assert.equal(spec.runtimeEnv.AGENT_NAME, undefined);
  assert.equal(spec.runtimeEnv.EFS_DIR, '/mnt/efs');
});

test('a per-agent value leaking into the fleet template is a hard failure, not a silent bake-in', () => {
  const leaky = fakeAgentCore();
  const inner = leaky.runtimeSpecFor.bind(leaky);
  // Both shapes the dispatcher could grow one in: a new top-level field, and a new env entry.
  leaky.runtimeSpecFor = (agent, image) => ({ ...inner(agent, image), sessionRoot: `/x/${agent}` });
  assert.throws(() => gen.fleetSpecFrom(leaky, 'repo:tag', { fields: {}, env: {} }),
    (e) => e.exitCode === EXIT.FAILED && /per-agent field/.test(e.message));

  leaky.runtimeSpecFor = (agent, image) => {
    const s = inner(agent, image);
    return { ...s, envs: { ...s.envs, AGENT_HOME: `/home/${agent}` } };
  };
  assert.throws(() => gen.fleetSpecFrom(leaky, 'repo:tag', { fields: {}, env: {} }),
    (e) => e.exitCode === EXIT.FAILED && /per-agent field/.test(e.message));
});

test('a new FLEET-level field in the dispatcher spec is carried into the generation with no change here', () => {
  const grown = fakeAgentCore();
  const inner = grown.runtimeSpecFor.bind(grown);
  grown.runtimeSpecFor = (agent, image) => ({ ...inner(agent, image), requestHeaderConfiguration: { allow: ['x'] } });
  const spec = gen.fleetSpecFrom(grown, 'repo:tag', { fields: {}, env: {} });
  assert.deepEqual(spec.requestHeaderConfiguration, { allow: ['x'] });
  assert.deepEqual(gen.derivedSpecFor(spec, 'a1', { efsRootDir: (a, p) => `${p}/agents/${a}` }).requestHeaderConfiguration,
    { allow: ['x'] });
});

test('derivedSpecFor expands the template back into the shape specFromGet returns', () => {
  const derived = gen.derivedSpecFor(SPEC, 'ch_platform', { efsRootDir: (a, p) => `${p}/agents/${a}` });
  assert.deepEqual(Object.keys(derived).sort(), [
    'efsMountPath', 'efsRoot', 'envs', 'idleRuntimeSessionTimeout', 'image', 'maxLifetime', 'securityGroupId', 'serverProtocol',
  ]);
  assert.equal(derived.efsRoot, '/openclaw-data/agents/ch_platform');
  assert.equal(derived.envs.AGENT_NAME, 'ch_platform');
  // The stored template is untouched — deriving for one agent must not mutate it for the next.
  assert.equal(SPEC.runtimeEnv.AGENT_NAME, undefined);
});

// ── generation create ────────────────────────────────────────────────────────────────────────────

test('create writes ONE item, body as an opaque JSON string, outside AGENT#', async () => {
  const deps = baseDeps();
  const out = makeOut();
  await gen.create(makeCtx(), args({ image: 'archie-0.2.6', id: 'rel-2026-08-14-01' }), out, deps);

  const put = deps.doc.seen.find((c) => c.name === 'PutCommand');
  assert.ok(put, 'a PutCommand was sent');
  assert.equal(put.input.Item.pk, 'CONFIG#generation');
  assert.ok(!put.input.Item.pk.startsWith('AGENT#'), 'never under the AGENT# prefix (derive-exec-role.mjs:104-110)');
  assert.equal(put.input.Item.sk, 'rel-2026-08-14-01');
  assert.equal(typeof put.input.Item.data, 'string', 'the body is a string, never a DDB Map (schema.mjs:104-108)');
  assert.deepEqual(Object.keys(put.input.Item).sort(), ['data', 'pk', 'sk']);

  const body = JSON.parse(put.input.Item.data);
  assert.equal(body.generationId, 'rel-2026-08-14-01');
  assert.equal(body.image, '203366135563.dkr.ecr.us-east-1.amazonaws.com/agent-gn0p84core:archie-0.2.6');
  assert.equal(body.imageTag, 'archie-0.2.6');
  assert.equal(body.imageDigest, 'sha256:abc');
  assert.equal(body.createdAt, '2026-08-14T20:03:11.000Z');
  assert.equal(body.createdBy, 'sandbox');
  assert.match(body.specDigest, /^[0-9a-f]{16}$/);
  assert.equal(body.spec.efsRootPrefix, '/openclaw-data');
  assert.equal(out.stdout.join('').includes('nothing is live'), true);
});

test('create guards the write with attribute_not_exists — the read-then-write race is the rewrite it must never do', async () => {
  const deps = baseDeps();
  await gen.create(makeCtx(), args({ image: 'archie-0.2.6', id: 'rel-1' }), makeOut(), deps);
  const put = deps.doc.seen.find((c) => c.name === 'PutCommand');
  assert.equal(put.input.ConditionExpression, 'attribute_not_exists(#pk)');
  assert.deepEqual(put.input.ExpressionAttributeNames, { '#pk': 'pk' });
});

test('create refuses to overwrite an existing id with a different spec', async () => {
  const deps = baseDeps({ items: [generationItem('rel-1', { ...SPEC, maxLifetime: 3600 })] });
  await rejects(() => gen.create(makeCtx(), args({ image: 'archie-0.2.6', id: 'rel-1' }), makeOut(), deps),
    EXIT.REFUSED, /never rewritten/);
  assert.equal(deps.doc.seen.some((c) => c.name === 'PutCommand'), false, 'nothing was written');
});

test('create is a no-op — not an error, not a write — when the id exists with an IDENTICAL spec', async () => {
  const deps = baseDeps();
  const ctx = makeCtx();
  await gen.create(ctx, args({ image: 'archie-0.2.6', id: 'rel-1' }), makeOut(), deps);
  const writes = () => deps.doc.seen.filter((c) => c.name === 'PutCommand').length;
  assert.equal(writes(), 1);
  const out = makeOut();
  await gen.create(ctx, args({ image: 'archie-0.2.6', id: 'rel-1' }), out, deps);
  assert.equal(writes(), 1, 're-running the same create writes nothing');
  assert.match(out.stdout.join(''), /unchanged/);
});

test('create refuses a lost race even though the pre-read said the id was free', async () => {
  const deps = baseDeps();
  const original = deps.doc.send.bind(deps.doc);
  deps.doc.send = async (cmd) => {
    if (cmd.constructor.name === 'PutCommand') {
      const e = new Error('The conditional request failed');
      e.name = 'ConditionalCheckFailedException';
      throw e;
    }
    return original(cmd);
  };
  await rejects(() => gen.create(makeCtx(), args({ image: 'archie-0.2.6', id: 'rel-1' }), makeOut(), deps),
    EXIT.REFUSED, /created by someone else/);
});

test('create refuses an image that is not in ECR', async () => {
  const deps = baseDeps({ ecr: fakeEcr({ present: {} }) });
  await rejects(() => gen.create(makeCtx(), args({ image: 'archie-0.2.9' }), makeOut(), deps),
    EXIT.PREFLIGHT, /does not exist in ECR/);
});

test('create refuses an amd64 image — the single easiest mistake to make here', async () => {
  const deps = baseDeps({
    ecr: fakeEcr({
      present: { 'archie-0.2.6': 'sha256:abc' },
      manifest: { manifests: [{ platform: { architecture: 'amd64', os: 'linux' } }] },
    }),
  });
  await rejects(() => gen.create(makeCtx(), args({ image: 'archie-0.2.6' }), makeOut(), deps),
    EXIT.REFUSED, /arm64/);
});

test('create defaults the id to the content address of the spec', async () => {
  const deps = baseDeps();
  await gen.create(makeCtx(), args({ image: 'archie-0.2.6' }), makeOut(), deps);
  const put = deps.doc.seen.find((c) => c.name === 'PutCommand');
  const body = JSON.parse(put.input.Item.data);
  assert.equal(put.input.Item.sk, `gen-${body.specDigest}`);
});

test('create rejects an id that could not survive a sort key and a runtime name', async () => {
  await rejects(() => gen.create(makeCtx(), args({ image: 'archie-0.2.6', id: 'rel/2026 01' }), makeOut(), baseDeps()),
    EXIT.USAGE, /not a valid generation id/);
});

test('--set reaches the spec AND everything derived from it (EFS_DIR follows efsMountPath)', async () => {
  const deps = baseDeps();
  await gen.create(makeCtx(), args({
    image: 'archie-0.2.6',
    id: 'rel-1',
    set: ['efsMountPath=/mnt/other', 'runtimeEnv.AGENTCORE_OTEL_MODE=full'],
  }), makeOut(), deps);
  const body = JSON.parse(deps.doc.seen.find((c) => c.name === 'PutCommand').input.Item.data);
  assert.equal(body.spec.efsMountPath, '/mnt/other');
  assert.equal(body.spec.runtimeEnv.EFS_DIR, '/mnt/other', 'the env follows the config, not a post-hoc patch');
  assert.equal(body.spec.maxLifetime, 28800, 'the saga hard-codes this; --set on it is refused');
  assert.equal(body.spec.runtimeEnv.AGENTCORE_OTEL_MODE, 'full');
});

test('--from seeds every field from an existing generation, then applies --image and --set only', async () => {
  const seed = { ...SPEC, securityGroupId: 'sg-from-terraform', runtimeEnv: { ...SPEC.runtimeEnv, ONLY_ON_SEED: 'yes' } };
  const deps = baseDeps({ items: [generationItem('rel-1', seed)] });
  deps.ecr = fakeEcr({ present: { 'archie-0.2.7': 'sha256:def' } });
  await gen.create(makeCtx(), args({ from: 'rel-1', image: 'archie-0.2.7', id: 'rel-2', set: ['runtimeEnv.NEW=1'] }), makeOut(), deps);
  const body = JSON.parse(deps.doc.seen.find((c) => c.name === 'PutCommand' && c.input.Item.sk === 'rel-2').input.Item.data);
  assert.equal(body.spec.securityGroupId, 'sg-from-terraform', 'seeded, not re-derived from the environment');
  assert.equal(body.spec.runtimeEnv.ONLY_ON_SEED, 'yes');
  assert.equal(body.spec.runtimeEnv.NEW, '1');
  assert.equal(body.imageTag, 'archie-0.2.7');
});

test('--from a generation that does not exist is a clean failure, not a partial write', async () => {
  const deps = baseDeps();
  await rejects(() => gen.create(makeCtx(), args({ from: 'nope', id: 'rel-2' }), makeOut(), deps), EXIT.FAILED, /no generation nope/);
  assert.equal(deps.doc.seen.some((c) => c.name === 'PutCommand'), false);
});

test('create --dry-run validates the image but writes nothing', async () => {
  const deps = baseDeps();
  const out = makeOut({ dryRun: true });
  await gen.create(makeCtx({ dryRun: true }), args({ image: 'archie-0.2.6', id: 'rel-1' }), out, deps);
  assert.equal(deps.doc.seen.some((c) => c.name === 'PutCommand'), false);
  assert.equal(deps.ecr.calls.includes('DescribeImagesCommand'), true, 'the check that matters still runs');
  assert.match(out.stdout.join(''), /specDigest/);
});

test('create asserts the caller is in --account before naming an image after it', async () => {
  const deps = baseDeps({ sts: fakeSts('999999999999') });
  await rejects(() => gen.create(makeCtx({ account: '203366135563' }), args({ image: 'archie-0.2.6' }), makeOut(), deps),
    EXIT.PREFLIGHT, /the caller is in 999999999999/);
});

test('create uses the derived repo name, never a literal', async () => {
  const deps = baseDeps();
  const ctx = makeCtx({ name: 'archie-alt' });
  deps.ecr = fakeEcr({ present: { 'archie-0.2.6': 'sha256:abc' } });
  await gen.create(ctx, args({ image: 'archie-0.2.6', id: 'rel-1' }), makeOut(), deps);
  const body = JSON.parse(deps.doc.seen.find((c) => c.name === 'PutCommand').input.Item.data);
  assert.match(body.image, /\/archie-alt-agentcore:archie-0\.2\.6$/);
});

// ── generation list / show ───────────────────────────────────────────────────────────────────────

const RELEASE_ITEM = { pk: 'CONFIG#release', sk: 'ACTIVE', data: JSON.stringify({ generationId: 'rel-3', mode: 'staged' }) };

function fleetItems() {
  return [
    RELEASE_ITEM,
    generationItem('rel-3', SPEC, { createdAt: '2026-08-14T00:00:00.000Z' }),
    generationItem('rel-2', { ...SPEC, maxLifetime: 3600 }, {
      createdAt: '2026-08-13T00:00:00.000Z', taintedAt: '2026-08-13T18:22:00.000Z', taintReason: 'healthcheck: 3 agents',
    }),
    generationItem('rel-1', { ...SPEC, maxLifetime: 7200 }, { createdAt: '2026-08-12T00:00:00.000Z' }),
    generationItem('rel-0', { ...SPEC, maxLifetime: 1800 }, { createdAt: '2026-08-11T00:00:00.000Z' }),
    binding('a1', 'rel-3'), binding('a2', 'rel-3'),
    binding('a1', 'rel-2', { healthcheck: 'failed' }),
    binding('a1', 'rel-1'),
    // Reaped: the row survives as history, the arn is gone (runtime-registry.js:30-37).
    binding('a1', 'rel-0', { arn: undefined, runtimeId: undefined, reapedAt: '2026-08-13T00:00:00.000Z' }),
  ];
}

test('list never shows a reaped generation as a rollback target', async () => {
  const deps = baseDeps({ items: fleetItems() });
  const out = makeOut({ json: true });
  await gen.list(makeCtx({ json: true }), args({}), out, deps);
  out.finish({ command: 'generation list' });
  const { result } = JSON.parse(out.stdout.join(''));
  const byId = Object.fromEntries(result.generations.map((g) => [g.generationId, g]));

  assert.equal(byId['rel-0'].isRollbackTarget, false);
  assert.equal(byId['rel-0'].isReaped, true);
  assert.equal(byId['rel-0'].live, 0, 'the COUNT survives alongside the flag — they are different fields');
  assert.match(byId['rel-0'].state, /NOT a rollback target/);
  assert.equal(byId['rel-1'].isRollbackTarget, true);
  assert.equal(byId['rel-3'].isLive, true);
  assert.match(byId['rel-3'].state, /LIVE \(staged\)/);
  assert.equal(byId['rel-2'].isTainted, true);
  assert.equal(byId['rel-2'].isRollbackTarget, false, 'a tainted generation is not a rollback target either');
  assert.match(byId['rel-2'].state, /TAINTED — healthcheck: 3 agents/);
  // Newest first.
  assert.deepEqual(result.generations.map((g) => g.generationId), ['rel-3', 'rel-2', 'rel-1', 'rel-0']);
});

test('list never calls ListAgentRuntimes — coverage comes from the registry rows', async () => {
  const deps = baseDeps({ items: fleetItems() });
  await gen.list(makeCtx(), args({}), makeOut(), deps);
  assert.deepEqual([...new Set(deps.doc.seen.map((c) => c.name))].sort(), ['GetCommand', 'QueryCommand', 'ScanCommand']);
  // No AgentCore control client is even constructed: nothing but the doc client was used.
});

test('list counts bindings and healthchecks per generation', async () => {
  const deps = baseDeps({ items: fleetItems() });
  const out = makeOut({ json: true });
  await gen.list(makeCtx({ json: true }), args({}), out, deps);
  out.finish({ command: 'generation list' });
  const { result } = JSON.parse(out.stdout.join(''));
  const rel3 = result.generations.find((g) => g.generationId === 'rel-3');
  assert.equal(rel3.bound, 2);
  assert.equal(rel3.live, 2, 'live is a COUNT of bindings with an arn');
  assert.equal(rel3.isLive, true, 'isLive is whether the release pointer names it');
  assert.equal(rel3.ok, 2);
  const rel2 = result.generations.find((g) => g.generationId === 'rel-2');
  assert.equal(rel2.failed, 1);
});

test('list --limit trims the table but reports the true total', async () => {
  const deps = baseDeps({ items: fleetItems() });
  const out = makeOut({ json: true });
  await gen.list(makeCtx({ json: true }), args({ limit: '2' }), out, deps);
  out.finish({ command: 'generation list' });
  const { result } = JSON.parse(out.stdout.join(''));
  assert.equal(result.generations.length, 2);
  assert.equal(result.total, 4);
});

test('list on an empty table says so rather than printing an empty table', async () => {
  const out = makeOut();
  await gen.list(makeCtx(), args({}), out, baseDeps());
  assert.match(out.stdout.join(''), /no generations/);
});

test('show prints the declared spec and the per-agent bindings', async () => {
  const out = makeOut();
  await gen.show(makeCtx(), args({}, ['rel-3']), out, baseDeps({ items: fleetItems() }));
  const printed = out.stdout.join('');
  assert.match(printed, /generation rel-3/);
  assert.match(printed, /specDigest/);
  assert.match(printed, /AGENT\s+RUNTIME/);
  assert.match(printed, /a1/);
  assert.match(printed, /a2/);
});

test('show warns when the stored body no longer hashes to its own specDigest', async () => {
  const item = generationItem('rel-9', SPEC);
  const body = JSON.parse(item.data);
  body.spec.maxLifetime = 1;                       // edited after the fact; digest left alone
  item.data = JSON.stringify(body);
  const out = makeOut();
  await gen.show(makeCtx(), args({}, ['rel-9']), out, baseDeps({ items: [item] }));
  assert.match(out.stderr.join(''), /edited after it was written/);
});

test('show on an unknown generation fails cleanly', async () => {
  await rejects(() => gen.show(makeCtx(), args({}, ['nope']), makeOut(), baseDeps()), EXIT.FAILED, /no generation nope/);
});

// ── generation verify ────────────────────────────────────────────────────────────────────────────

function observedFor(agent, over = {}) {
  const declared = gen.derivedSpecFor(SPEC, agent, { efsRootDir: (a, p) => `${p}/agents/${a}` });
  return {
    image: declared.image,
    efsRoot: declared.efsRoot,
    efsAccessPoint: 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-123',
    efsMountPath: declared.efsMountPath,
    envs: { ...declared.envs },
    securityGroupId: declared.securityGroupId,
    idleRuntimeSessionTimeout: declared.idleRuntimeSessionTimeout,
    maxLifetime: declared.maxLifetime,
    serverProtocol: declared.serverProtocol,
    ...over,
  };
}

// The fake read-back is keyed by runtime id, exactly as GetAgentRuntime is: handing every agent the
// same observation would make a1's EFS root look like drift on a2 and quietly pass the wrong test.
const agentOfRuntimeId = (id) => String(id).replace(/^oc_/, '').replace(/-XYZ$/, '');

const verifyDeps = (observedBy) => baseDeps({
  items: [RELEASE_ITEM, generationItem('rel-3', SPEC), binding('a1', 'rel-3'), binding('a2', 'rel-3')],
  agentcore: () => ({ config: {}, async observedSpecOf(id) { return observedBy(agentOfRuntimeId(id)); } }),
});

test('verify passes when the observed runtime matches, and the access point is not a phantom change', async () => {
  const out = makeOut();
  await gen.verify(makeCtx(), args({ generation: 'rel-3' }), out, verifyDeps((a) => observedFor(a)));
  assert.match(out.stdout.join(''), /2\/2 runtimes match/);
});

test('verify catches the dropped image — a roll that looks successful and changed nothing', async () => {
  const deps = verifyDeps((a) => observedFor(a, { image: 'repo:archie-0.2.5' }));
  await rejects(() => gen.verify(makeCtx(), args({ generation: 'rel-3' }), makeOut(), deps), EXIT.DRIFT, /image/);
});

test('verify reports env drift per key, not as one opaque "envs changed"', async () => {
  const deps = verifyDeps((a) => {
    const o = observedFor(a);
    o.envs.AGENTCORE_OTEL_MODE = 'off';
    return o;
  });
  await rejects(() => gen.verify(makeCtx(), args({ generation: 'rel-3' }), makeOut(), deps),
    EXIT.DRIFT, /env\.AGENTCORE_OTEL_MODE/);
});

test('verify drops efsRoot from BOTH sides when the access point could not be read', async () => {
  // observedSpecOf leaves efsRoot undefined when DescribeAccessPoints fails. Absent is unknown, not
  // "changed to undefined" (spec-diff.js:17-24) — so this must PASS, not report drift.
  const deps = verifyDeps((a) => {
    const o = observedFor(a);
    delete o.efsRoot;
    return o;
  });
  const out = makeOut();
  await gen.verify(makeCtx(), args({ generation: 'rel-3' }), out, deps);
  assert.match(out.stdout.join(''), /2\/2 runtimes match/);
});

test('verify skips a reaped binding instead of calling it drift', async () => {
  const deps = baseDeps({
    items: [RELEASE_ITEM, generationItem('rel-3', SPEC),
      binding('a1', 'rel-3'), binding('a2', 'rel-3', { arn: undefined, runtimeId: undefined, reapedAt: 'x' })],
    agentcore: () => ({ config: {}, async observedSpecOf(id) { return observedFor(agentOfRuntimeId(id)); } }),
  });
  const out = makeOut({ json: true });
  await gen.verify(makeCtx({ json: true }), args({ generation: 'rel-3' }), out, deps);
  out.finish({ command: 'generation verify' });
  const { result } = JSON.parse(out.stdout.join(''));
  assert.equal(result.checked, 1);
  assert.equal(result.results.find((r) => r.agent === 'a2').skipped, 'reaped');
});

test('verify defaults to the live generation from the release pointer', async () => {
  const out = makeOut();
  await gen.verify(makeCtx(), args({}), out, verifyDeps((a) => observedFor(a)));
  assert.match(out.stdout.join(''), /generation rel-3/);
});

test('verify with no pointer and no --generation is a usage error, not a guess', async () => {
  await rejects(() => gen.verify(makeCtx(), args({}), makeOut(), baseDeps()), EXIT.USAGE, /--generation/);
});

test('verify --agent narrows to one binding', async () => {
  const seen = [];
  const deps = verifyDeps((a) => { seen.push(a); return observedFor(a); });
  await gen.verify(makeCtx(), args({ generation: 'rel-3', agent: 'a2' }), makeOut(), deps);
  assert.equal(seen.length, 1);
});

test('verify exits 1, not 7, when a runtime cannot be read at all', async () => {
  const deps = verifyDeps(() => { throw new Error('ResourceNotFoundException'); });
  await rejects(() => gen.verify(makeCtx(), args({ generation: 'rel-3' }), makeOut(), deps), EXIT.FAILED, /could not read/);
});

test('verify never records per-unit failures — a wrong image is drift (7), not a straggler (6)', async () => {
  const out = makeOut();
  const deps = verifyDeps((a) => observedFor(a, { image: 'repo:wrong' }));
  await assert.rejects(() => gen.verify(makeCtx(), args({ generation: 'rel-3' }), out, deps));
  assert.equal(out.failureCount(), 0);
});

// ── generation build ─────────────────────────────────────────────────────────────────────────────

// The real target, so the constraint check is exercised against what actually ships.
const REAL_MAKEFILE = fs.readFileSync(path.join(__dirname, '..', '..', 'Makefile'), 'utf8');

test('the shipped Makefile still applies all three constraints', () => {
  const { localImage } = gen.assertMakeConstraints(REAL_MAKEFILE);
  assert.equal(localImage, 'agentcore-pi');
});

test('a build target that lost a constraint is refused, loudly, per constraint', () => {
  const cases = [
    ['--platform=linux/arm64', /arm64/],
    ['--build-context lintroot=.', /lintroot/],
    ['$(AGENTCORE_PI_TAG)', /AGENTCORE_PI_TAG/],
  ];
  for (const [needle, match] of cases) {
    // replaceAll, not replace: `--build-context lintroot=.` appears first in the COMMENT above the
    // target explaining why it is required, so removing only the first occurrence would leave the
    // recipe intact and the test would pass while proving nothing.
    const broken = REAL_MAKEFILE.split(needle).join('');
    assert.throws(() => gen.assertMakeConstraints(broken), (e) => {
      assert.equal(e.exitCode, EXIT.REFUSED);
      assert.match(`${e.message} ${e.detail}`, match);
      return true;
    }, `removing ${needle} must be refused`);
  }
});

test('makeRecipe joins line continuations and stops at the next target', () => {
  const recipe = gen.makeRecipe('a:\n\tone \\\n\t  two\nb:\n\tthree\n', 'a');
  assert.equal(recipe, 'one two');
});

// A tree with just enough in it for digestFor('agent') to run, so build can derive a tag without a
// real checkout. The Makefile is the real one — the constraint check must see what ships.
function fakeTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archie-gen-')));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  write('Makefile', REAL_MAKEFILE);
  write('package.json', '{}');
  write('package-lock.json', '{}');
  write('eslint.config.mjs', 'export default [];\n');
  write('clawdbot/agentcore-pi/Dockerfile', 'FROM x\n');
  write('clawdbot/config-resolver/schema.mjs', 'export const x = 1;\n');
  write('clawdbot/plugin-sdk/index.js', '1\n');
  write('clawdbot/connector-session-plugin/index.js', '1\n');
  write('clawdbot/demo-cache-plugin/index.js', '1\n');
  write('clawdbot/openclaw-mcp-auth-plugin/index.js', '1\n');
  write('clawdbot/agentcore-observability/insight-queries.js', '1\n');
  write('clawdbot/config-seed/new-agent-skeleton/SEED.md', 'seed\n');
  return root;
}

function buildDeps(over = {}) {
  const ran = [];
  return {
    ...baseDeps(over),
    root: over.root,
    run: (cmd, argv, opts) => { ran.push({ cmd, argv, opts }); return ''; },
    ran,
    ...(over.ecr ? { ecr: over.ecr } : {}),
  };
}

test('build derives its tag from the image inputs and shells out to the Makefile target', async () => {
  const root = fakeTree();
  const deps = buildDeps({ root, ecr: fakeEcr({ present: {} }) });
  const out = makeOut();
  await gen.build(makeCtx(), args({}), out, deps);

  const make = deps.ran.find((r) => r.cmd === 'make');
  assert.ok(make, 'the build goes through make, not a hand-rolled docker command');
  assert.deepEqual(make.argv.slice(0, 3), ['-C', root, 'build-agentcore-pi']);
  assert.match(make.argv[3], /^AGENTCORE_PI_TAG=content-[0-9a-f]{16}$/);
  assert.equal(deps.ran.some((r) => r.cmd === 'docker'), false, 'no --push, no docker');
});

test('build refuses a non-arm64 --platform and a `latest` tag', async () => {
  const root = fakeTree();
  await rejects(() => gen.build(makeCtx(), args({ platform: 'linux/amd64' }), makeOut(), buildDeps({ root })),
    EXIT.REFUSED, /arm64/);
  await rejects(() => gen.build(makeCtx(), args({ tag: 'latest' }), makeOut(), buildDeps({ root })),
    EXIT.REFUSED, /latest/);
});

test('build skips entirely when the derived tag is already in ECR — same content, same tag', async () => {
  const root = fakeTree();
  const probe = buildDeps({ root, ecr: fakeEcr({ present: {} }) });
  await gen.build(makeCtx(), args({}), makeOut(), probe);
  const tag = probe.ran.find((r) => r.cmd === 'make').argv[3].split('=')[1];

  const deps = buildDeps({ root, ecr: fakeEcr({ present: { [tag]: 'sha256:abc' } }) });
  const out = makeOut();
  await gen.build(makeCtx(), args({ push: true }), out, deps);
  assert.equal(deps.ran.length, 0, 'no build and no push');
  assert.match(out.stdout.join(''), /already in ECR/);
});

test('build refuses to push over a PINNED tag that exists — the repo is immutable so rollback stays honest', async () => {
  const root = fakeTree();
  const deps = buildDeps({ root, ecr: fakeEcr({ present: { 'archie-0.2.6': 'sha256:abc' } }) });
  await rejects(() => gen.build(makeCtx(), args({ tag: 'archie-0.2.6', push: true }), makeOut(), deps),
    EXIT.REFUSED, /immutable/);
  assert.equal(deps.ran.length, 0);
});

test('build --push logs in with an ECR token, tags and pushes the DERIVED repo uri', async () => {
  const root = fakeTree();
  const deps = buildDeps({ root, ecr: fakeEcr({ present: {} }) });
  await gen.build(makeCtx({ name: 'archie-alt' }), args({ push: true }), makeOut(), deps);
  const docker = deps.ran.filter((r) => r.cmd === 'docker');
  assert.deepEqual(docker.map((d) => d.argv[0]), ['login', 'tag', 'push']);
  assert.equal(docker[0].opts.input, 'pw:with:colons', 'the password may contain colons');
  assert.match(docker[2].argv[1], /^203366135563\.dkr\.ecr\.us-east-1\.amazonaws\.com\/archie-alt-agentcore:content-[0-9a-f]{16}$/);
});

test('build --dry-run prints the command and runs nothing', async () => {
  const root = fakeTree();
  const deps = buildDeps({ root, ecr: fakeEcr({ present: {} }) });
  const out = makeOut({ dryRun: true });
  await gen.build(makeCtx({ dryRun: true }), args({ push: true }), out, deps);
  assert.equal(deps.ran.length, 0);
  assert.match(out.stderr.join(''), /\[dry-run\] would run: make/);
});

// ── the reuse itself ─────────────────────────────────────────────────────────────────────────────
//
// The tests above inject a stand-in for the dispatcher's spec computation. This one uses the REAL
// createAgentCoreClient with fake AWS clients underneath it, because the property that matters is not
// that our code works against our fake — it is that the DECLARED spec this file derives and the
// OBSERVED spec the dispatcher reads back are the same shape, and diff to nothing when they agree.
// If either side of that ever drifts, this is the test that fails.

test('a generation built by the real runtimeSpecFor verifies clean against the real specFromGet', async () => {
  const { createAgentCoreClient } = require('../../slack-dispatcher/agentcore-client');
  const client = createAgentCoreClient({
    region: 'us-east-1', account: '203366135563', agentConfigTable: 'agent-gn0p84-config',
  });

  const imageUri = '203366135563.dkr.ecr.us-east-1.amazonaws.com/agent-gn0p84core:archie-0.2.6';
  const fleet = gen.fleetSpecFrom(client, imageUri, { fields: {}, env: {} });
  const declared = gen.derivedSpecFor(fleet, 'ch_platform');

  // What CreateAgentRuntime was given, played back as GetAgentRuntime would return it.
  const getResponse = {
    agentRuntimeArtifact: { containerConfiguration: { containerUri: declared.image } },
    environmentVariables: { ...declared.envs },
    filesystemConfigurations: [{
      efsAccessPoint: {
        accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-1',
        mountPath: declared.efsMountPath,
      },
    }],
    networkConfiguration: { networkModeConfig: { securityGroups: [declared.securityGroupId] } },
    lifecycleConfiguration: { idleRuntimeSessionTimeout: declared.idleRuntimeSessionTimeout, maxLifetime: declared.maxLifetime },
    protocolConfiguration: { serverProtocol: declared.serverProtocol },
  };
  client.setClientsForTest({
    control: { async send() { return getResponse; } },
    efs: { async send() { return { AccessPoints: [{ RootDirectory: { Path: declared.efsRoot } }] }; } },
  });

  const observed = await client.observedSpecOf('oc_ch_platform-XYZ');
  // A clean match is `['fingerprint-algorithm']`, NOT `[]` — specDiff's usual caller only diffs when
  // the runtime name already changed, so "no field differs" is reported as "the hash algorithm moved"
  // (spec-diff.js:52-56). verify() filters that sentinel; reading it as a difference would make every
  // healthy runtime look like drift, and reading `[]` as the pass condition would make every one of
  // them pass regardless of what changed.
  assert.deepEqual(diffKeys(observed, declared), ['fingerprint-algorithm'], 'declared and observed must agree on every field');

  // And the same pair with the image swapped is the bug this command exists to catch.
  assert.deepEqual(diffKeys({ ...observed, image: 'other:tag' }, declared), ['image']);
});

function diffKeys(observed, declared) {
  return require('../../slack-dispatcher/spec-diff').diffObserved(observed, declared);
}

test('--image accepts this deployment\'s own URI and refuses anyone else\'s', async () => {
  const deps = baseDeps();
  await gen.create(makeCtx(), args({
    image: '203366135563.dkr.ecr.us-east-1.amazonaws.com/agent-gn0p84core:archie-0.2.6', id: 'rel-uri',
  }), makeOut(), deps);
  assert.ok(deps.doc.seen.some((c) => c.name === 'PutCommand'));

  await rejects(() => gen.create(makeCtx(), args({
    image: '999999999999.dkr.ecr.us-east-1.amazonaws.com/agent-848o7ls-repo:archie-0.2.6', id: 'rel-bad',
  }), makeOut(), baseDeps()), EXIT.USAGE, /not this deployment's agent repository/);
});

test('--from + --set efsMountPath is refused unless EFS_DIR moves with it', async () => {
  const items = [generationItem('rel-1', SPEC)];
  await rejects(() => gen.create(makeCtx(), args({
    from: 'rel-1', id: 'rel-2', set: ['efsMountPath=/mnt/other'],
  }), makeOut(), baseDeps({ items })), EXIT.REFUSED, /EFS_DIR/);

  const deps = baseDeps({ items: [generationItem('rel-1', SPEC)] });
  await gen.create(makeCtx(), args({
    from: 'rel-1', id: 'rel-2', set: ['efsMountPath=/mnt/other', 'runtimeEnv.EFS_DIR=/mnt/other'],
  }), makeOut(), deps);
  const body = JSON.parse(deps.doc.seen.find((c) => c.name === 'PutCommand' && c.input.Item.sk === 'rel-2').input.Item.data);
  assert.equal(body.spec.efsMountPath, '/mnt/other');
  assert.equal(body.spec.runtimeEnv.EFS_DIR, '/mnt/other');
});

// ── §8.10: a rekeyed agent's ADOPTED efsRoot is not drift ────────────────────────────────────────
//
// derivedSpecFor always derives efsRootDir(agent, prefix), but a rekeyed agent ADOPTS its old
// directory rather than moving its data — so its observed root can never equal the derived one.
// Without this check, verify exits 7 for the WHOLE FLEET and `archie status` reports drift that is
// not there. cmd/stage.js and cmd/fleet.js already had this rule; verify was the one missing it.

test('verify: an efsRoot-only difference the BINDING explains is not drift', async () => {
  const legacy = 'oc-legacy-a1';
  const deps = baseDeps({
    items: [
      RELEASE_ITEM,
      generationItem('rel-3', SPEC),
      { ...binding('a1', 'rel-3'), legacyEfsRoot: legacy },
      binding('a2', 'rel-3'),
    ],
    agentcore: () => ({
      config: {},
      async observedSpecOf(id) {
        const a = agentOfRuntimeId(id);
        // a1 sits on its adopted directory; a2 is untouched.
        return a === 'a1' ? observedFor(a, { efsRoot: `/openclaw-data/${legacy}` }) : observedFor(a);
      },
    }),
  });
  const out = makeOut();
  await gen.verify(makeCtx(), args({ generation: 'rel-3' }), out, deps);
  assert.match(out.stdout.join(''), /2\/2 runtimes match/, 'the adopt is not counted as a mismatch');
});

test('verify: efsRoot PLUS anything else is still drift — an adopt excuses only itself', async () => {
  const legacy = 'oc-legacy-a1';
  const deps = baseDeps({
    items: [
      RELEASE_ITEM,
      generationItem('rel-3', SPEC),
      { ...binding('a1', 'rel-3'), legacyEfsRoot: legacy },
      binding('a2', 'rel-3'),
    ],
    agentcore: () => ({
      config: {},
      async observedSpecOf(id) {
        const a = agentOfRuntimeId(id);
        return a === 'a1'
          ? observedFor(a, { efsRoot: `/openclaw-data/${legacy}`, image: 'repo:archie-0.2.5' })
          : observedFor(a);
      },
    }),
  });
  await rejects(() => gen.verify(makeCtx(), args({ generation: 'rel-3' }), makeOut(), deps), EXIT.DRIFT, /image/);
});

// ── the three --set fields the saga can never honour ─────────────────────────────────────────────
test('create: --set on a saga-hardcoded field is refused, once, before anything is written', async () => {
  // agentcore-provisioning.js:521 fixes these at 900 / 28800 / HTTP. A generation setting one can be
  // written but never satisfied — `stage` would report a read-back mismatch once PER AGENT (208
  // times) and a re-run would never converge. One error here replaces all of that.
  for (const field of ['idleRuntimeSessionTimeout', 'maxLifetime', 'serverProtocol']) {
    assert.throws(
      () => gen.parseSets([`${field}=1234`]),
      (e) => e.exitCode === EXIT.REFUSED && /hard-codes it/.test(e.message),
      field,
    );
  }
});

test('create: the fleet-level fields that DO reach the spec are still settable', () => {
  const sets = gen.parseSets(['efsRootPrefix=/other-data', 'runtimeEnv.AGENTCORE_OTEL_MODE=off']);
  assert.equal(sets.fields.efsRootPrefix, '/other-data');
  assert.equal(sets.env.AGENTCORE_OTEL_MODE, 'off');
});

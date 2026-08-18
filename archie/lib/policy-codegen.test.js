'use strict';

// The generated baseline module, and the check that makes committing a generated file safe.
//
// The failure this exists to prevent: someone edits `capGroups.baseline` in semantics.json, does not
// regenerate, and the release publishes a policy whose baseline set disagrees with the one the runtime is
// actually enforcing. Nothing else would notice — the policy validates, the checks pass, the images build.
//
// So the load-bearing test here is `assertGenerated` FAILING on a stale file. A staleness check that cannot
// fail is worse than none, because the committed file reads as verified.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { render, write, assertGenerated, baselineFrom, GENERATED_ABS } = require('./policy-codegen');
const { loadPolicySources } = require('./policy-sources');

const SANDBOX = loadPolicySources({ env: 'sandbox' });

test('the committed file matches the policy', () => {
  // The gate itself, run against the real tree — this is what `npm run check` relies on.
  assert.doesNotThrow(() => assertGenerated({ env: 'sandbox' }));
  assert.doesNotThrow(() => assertGenerated({ env: 'prod' }), 'the baseline set is env-independent');
});

test('it reproduces exactly the set the hand-written map had', () => {
  // The port must be behaviour-preserving: these are the 7 that were in CAPABILITY_DEFAULTS before codegen.
  const { members, immutable } = baselineFrom(SANDBOX);
  assert.deepEqual(members, ['fs.read', 'memory', 'cron', 'otel', 'connector', 'health', 'hindsight.read']);
  assert.deepEqual(immutable, ['otel', 'hindsight.read']);
});

test('the rendered module is valid ESM with the three exports the runtime imports', async () => {
  const text = render(SANDBOX);
  assert.match(text, /^\/\/ @generated from docker\/policy\/semantics\.json — DO NOT EDIT BY HAND\./);
  for (const sym of ['BASELINE', 'IMMUTABLE', 'POLICY_DIGEST']) {
    assert.match(text, new RegExp(`export const ${sym}`), sym);
  }
  // Actually loadable, and actually what the runtime sees — rendering valid-looking text that does not
  // import is the obvious way for this to be wrong.
  const mod = await import(`file://${GENERATED_ABS}`);
  assert.deepEqual(Object.keys(mod.BASELINE).sort(), baselineFrom(SANDBOX).members.slice().sort());
  assert.ok(Object.isFrozen(mod.BASELINE), 'frozen — nothing may mutate the baseline set at runtime');
  assert.deepEqual([...mod.IMMUTABLE], ['otel', 'hindsight.read']);
});

test('`*` is NOT in the generated set — it is the fallthrough, not a capability', () => {
  // Putting it in capGroups.baseline would demand a Capability entity named `*` and make check 2
  // permanently red; capabilities.mjs adds it when building CAPABILITY_DEFAULTS.
  assert.ok(!('*' in baselineFrom(SANDBOX).members));
  assert.doesNotMatch(render(SANDBOX), /'\*'/);
});

test('the runtime map is the generated set plus the fallthrough, and nothing else', async () => {
  const caps = await import(`file://${require.resolve('../../archie-runner/agentcore-pi/permissions/capabilities.mjs')}`);
  const { members } = baselineFrom(SANDBOX);
  assert.deepEqual(Object.keys(caps.CAPABILITY_DEFAULTS), [...members, '*'], 'order preserved, one extra key');
  for (const c of members) assert.equal(caps.CAPABILITY_DEFAULTS[c], 'allow', c);
  assert.equal(caps.CAPABILITY_DEFAULTS['*'], 'deny');
  assert.deepEqual([...caps.IMMUTABLE_CAPABILITIES], ['otel', 'hindsight.read']);
});

// ── the staleness check must bite ──────────────────────────────────────────────────────────────────

test('assertGenerated FAILS when the policy gains a baseline capability', () => {
  // The realistic edit: someone makes a capability generally available in the policy and forgets to
  // regenerate. The runtime would keep denying it while the policy says otherwise.
  const s = { ...SANDBOX, data: JSON.parse(JSON.stringify(SANDBOX.data)) };
  s.data.capGroups.baseline.members.push('datadog');
  const tmp = `${GENERATED_ABS}.stale-test`;
  try {
    fs.writeFileSync(tmp, render(s));   // a file rendered from a DIFFERENT policy than the one on disk
    assert.throws(() => assertGenerated({ env: 'sandbox', file: tmp }), /is STALE/);
  } finally { fs.rmSync(tmp, { force: true }); }
});

test('assertGenerated FAILS when the file is missing, rather than passing vacuously', () => {
  assert.throws(() => assertGenerated({ env: 'sandbox', file: `${GENERATED_ABS}.does-not-exist` }), /is missing/);
});

test('assertGenerated ignores the DIGEST line, which is env-dependent', () => {
  // The baseline set lives in the shared semantics, but `digest` covers the pins too — so the digest line
  // differs between envs while the set does not. Comparing it would make the check fail whenever it ran
  // against a different env than the last generation, which would train people to regenerate to silence it.
  const prod = render(loadPolicySources({ env: 'prod' }));
  const sandbox = render(SANDBOX);
  assert.notEqual(prod, sandbox, 'the digest line really does differ');
  const strip = (t) => t.split('\n').filter((l) => !/Policy digest at generation|POLICY_DIGEST/.test(l)).join('\n');
  assert.equal(strip(prod), strip(sandbox), 'and everything else is identical');
});

test('write() is idempotent — regenerating an up-to-date file changes nothing', () => {
  // So `archie policy codegen` is safe to run at any time and does not produce a spurious diff.
  assert.equal(write(SANDBOX).changed, false);
});

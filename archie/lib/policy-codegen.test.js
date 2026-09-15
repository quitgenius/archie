'use strict';

// The generated baseline module.
//
// The file is GITIGNORED, so the risk is not a stale committed copy — it is ABSENCE. A fresh clone has no
// baseline.generated.mjs, and permissions/capabilities.mjs imports it, so every suite that touches the
// permission model fails with ERR_MODULE_NOT_FOUND. `ensure()` is what closes that, and it is called from
// the offline gate, both image builds, and `deploy` (which reads a digest before either build runs).
//
// The staleness check still matters for one case: a run that generated the file earlier and then had the
// policy change under it, or a stale file left by a previous run against different sources.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { render, write, ensure, assertGenerated, baselineFrom, GENERATED_ABS } = require('./policy-codegen');
const { loadPolicySources } = require('./policy-sources');

const SANDBOX = loadPolicySources({ env: 'sandbox' });

test('the file on disk matches the policy', () => {
  // The gate itself, run against the real tree. `npm run check` regenerates before any suite runs, so by
  // the time this executes the file is current — this asserts the generator and the checker agree.
  assert.doesNotThrow(() => assertGenerated({ env: 'sandbox' }));
  assert.doesNotThrow(() => assertGenerated({ env: 'prod' }), 'the baseline set is env-independent');
});

test('it reproduces the ported set, plus only deliberate additions', () => {
  // PORTED is the 7 that were in CAPABILITY_DEFAULTS before codegen; the port had to be behaviour-
  // preserving, so every one must STILL be baseline. Anything added since is named separately and on
  // purpose — an accidental widening of the generally-available set still fails here.
  const PORTED = ['fs.read', 'memory', 'cron', 'otel', 'connector', 'health', 'hindsight.read'];
  const ADDED_SINCE = [
    'slack.send',     // 2026-09-03: archie's own Slack send (slack-reply-plugin)
    'files.publish',  // 2026-09-14: save_artifact (file-publish-plugin) — ambient under OpenClaw; the
                      // prefix on the agent's derived role is the isolation, not this flag
  ];
  const { members, immutable } = baselineFrom(SANDBOX);
  assert.deepEqual(members, [...PORTED, ...ADDED_SINCE]);
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
  // So the hooks in the gate, both builds and deploy cost nothing on a warm tree, and can therefore run
  // unconditionally rather than behind a staleness guard whose failure mode is the thing being avoided.
  assert.equal(write(SANDBOX).changed, false);
});

test('ensure() RECREATES the file when it is absent — the fresh-clone case', () => {
  // The whole reason the file can be gitignored. Verified for real by deleting it: without generation a
  // suite importing capabilities.mjs dies with ERR_MODULE_NOT_FOUND, naming baseline.generated.mjs.
  const tmp = `${GENERATED_ABS}.ensure-test`;
  fs.rmSync(tmp, { force: true });
  const first = ensure({ env: 'sandbox', file: tmp });
  try {
    assert.equal(first.changed, true, 'created');
    assert.ok(fs.existsSync(tmp));
    assert.equal(ensure({ env: 'sandbox', file: tmp }).changed, false, 'and is then idempotent');
    assert.equal(fs.readFileSync(tmp, 'utf8'), render(SANDBOX), 'byte-identical to render()');
  } finally { fs.rmSync(tmp, { force: true }); }
});

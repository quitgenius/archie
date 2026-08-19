'use strict';

// The policy document as an INPUT — that both environments load, that the annotation convention is
// read the way the files are written, and that the digest moves when and only when a source changes.
//
// These run against the REAL files in docker/policy/, not fixtures, deliberately: the
// shipped policy is the artifact, and a fixture would let the real one rot (policy/README.md:174-176
// says exactly that — "there is no permanent runner for these files yet, so they will rot until that
// exists"). This is the start of that runner.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  POLICY_DIR, availableEnvs, realKeys, digestOf, loadPolicySources, pinsFileFor,
} = require('./policy-sources');
const { EXIT } = require('./exit');

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.exitCode;
  }
  return null;
};

test('both environments load from the real policy directory', () => {
  assert.deepEqual(availableEnvs(), ['sandbox', 'prod']);

  const sandbox = loadPolicySources({ env: 'sandbox' });
  const prod = loadPolicySources({ env: 'prod' });

  // The accounts each file declares it may be applied to. The deploy compares these against the
  // caller (plan §3 check 5) — the mechanism that turns "seeded a sandbox file with production
  // scopes", which really happened, into a refusal rather than a silent cross-environment apply.
  assert.equal(sandbox.pins.account, '203366135563');
  assert.equal(prod.pins.account, '361364274007');

  // The shared half is byte-identical across environments because it is the SAME FILE — not a copy
  // kept in step. That is the property semantics.cedar:8-13 exists to have.
  assert.equal(sandbox.semantics, prod.semantics);
  assert.equal(sandbox.schema, prod.schema);
  assert.deepEqual(sandbox.data, prod.data);
});

test('$-prefixed keys are annotation, and the filter is on the PREFIX not the type', () => {
  const prod = loadPolicySources({ env: 'prod' });
  const sandbox = loadPolicySources({ env: 'sandbox' });

  // 17 groups in each: 12 capability pins + 5 skill groups (comms-approval removed 2026-08-19).
  assert.equal(realKeys(prod.pins.groups).length, 17);
  assert.equal(realKeys(sandbox.pins.groups).length, 17);
  assert.ok(!realKeys(prod.pins.groups).some((k) => k.startsWith('$')));

  // PROD CARRIES NO ANNOTATIONS AT ALL since 2026-08-18 — its 154 lines of prose moved to
  // policy/README.md (internal decision). Asserted, because a data file
  // that is meant to be data only should fail if prose creeps back into it.
  assert.deepEqual(Object.keys(prod.pins).filter((k) => k.startsWith('$')), [], 'prod is data only');
  assert.deepEqual(Object.keys(prod.pins.groups).filter((k) => k.startsWith('$')), []);

  // THE CASE A TYPE-BASED FILTER GETS WRONG, still demonstrated on REAL data: sandbox's
  // `$pin.aws-readonly` is an ARRAY OF STRINGS, structurally indistinguishable from a group. Only the `$`
  // separates a nine-line review note from nine extra scope memberships.
  assert.ok(Array.isArray(sandbox.pins.groups['$pin.aws-readonly']));
  assert.ok(!realKeys(sandbox.pins.groups).includes('$pin.aws-readonly'));
  // The bare-STRING half used to be prod's own `$pin.aws-readonly` and went with the prose, so it is
  // constructed here rather than dropped: both value shapes must be filtered, and a reader that special-cased
  // one would pass on half the real data.
  assert.deepEqual(realKeys({ 'pin.real': ['dm-x'], $note: 'a bare string', $lines: ['an', 'array'] }), ['pin.real']);

  // Same convention in the shared data file, where `$immutable` sits beside `members`.
  assert.deepEqual(realKeys(prod.data.capGroups), ['baseline', 'connector.comms']);
  assert.ok(Array.isArray(prod.data.capGroups.baseline.$immutable));
});

test('the digest covers all four sources and nothing else', () => {
  const prod = loadPolicySources({ env: 'prod' });
  assert.match(prod.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(prod.digest, digestOf(prod.raw), 'digest must be re-derivable from raw');

  // A fleet-wide digest, so the two environments differ only through their bindings file.
  assert.notEqual(prod.digest, loadPolicySources({ env: 'sandbox' }).digest);

  // Each source moves it independently — the property plan §2's step-4 uniformity gate rests on.
  for (const key of ['schema', 'semantics', 'data', 'pins']) {
    const changed = digestOf({ ...prod.raw, [key]: `${prod.raw[key]}\n` });
    assert.notEqual(changed, prod.digest, `editing ${key} must move the digest`);
  }

  // Length-framing: moving a byte across a boundary must not collide. Without the framed lengths in
  // digestOf, `schema='a'+semantics='bc'` and `schema='ab'+semantics='c'` hash the same.
  const a = digestOf({ schema: 'a', semantics: 'bc', data: '{}', pins: '{}' });
  const b = digestOf({ schema: 'ab', semantics: 'c', data: '{}', pins: '{}' });
  assert.notEqual(a, b);
});

test('a shape error in the one hand-edited file is a preflight refusal, not a silent deny', () => {
  // Every case below fails CLOSED in Cedar — which is safe but SILENT (spike README §4), and a silent
  // deny for the intended holder is the failure mode this whole layer exists to remove.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archie-policy-'));
  for (const f of ['archie.cedarschema', 'semantics.cedar', 'semantics.json']) {
    fs.copyFileSync(path.join(POLICY_DIR, f), path.join(dir, f));
  }
  const writePins = (pins) => fs.writeFileSync(path.join(dir, pinsFileFor('t')), JSON.stringify(pins));
  const good = JSON.parse(fs.readFileSync(path.join(POLICY_DIR, pinsFileFor('prod')), 'utf8'));

  writePins(good);
  assert.equal(loadPolicySources({ env: 't', dir }).pins.account, '361364274007');

  // A group whose value is prose — a dropped `$` on one of the review-aid siblings.
  writePins({ ...good, groups: { ...good.groups, 'pin.datadog': 'agent-k4wmx6, agent-pkyue4' } });
  assert.equal(codeOf(() => loadPolicySources({ env: 't', dir })), EXIT.PREFLIGHT);

  writePins({ ...good, account: '05065271846' });
  assert.equal(codeOf(() => loadPolicySources({ env: 't', dir })), EXIT.PREFLIGHT);

  writePins({ ...good, groups: undefined });
  assert.equal(codeOf(() => loadPolicySources({ env: 't', dir })), EXIT.PREFLIGHT);

  fs.writeFileSync(path.join(dir, pinsFileFor('t')), '{ not json');
  assert.equal(codeOf(() => loadPolicySources({ env: 't', dir })), EXIT.PREFLIGHT);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a missing source or an unknown env refuses rather than loading a partial policy', () => {
  assert.equal(codeOf(() => loadPolicySources({ env: 'nope' })), EXIT.PREFLIGHT);
  assert.equal(codeOf(() => loadPolicySources({})), EXIT.USAGE);
  assert.equal(codeOf(() => loadPolicySources({ env: 'prod', dir: '/nonexistent' })), EXIT.PREFLIGHT);
  assert.deepEqual(availableEnvs('/nonexistent'), []);
});

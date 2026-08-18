'use strict';

// The two-path design's safety net. `archie deploy` computes verdicts with Cedar; the dispatcher, which
// has no engine and must answer for scopes minted at turn time, derives them from pin memberships alone.
// assertDerivationMatchesCedar is the only thing making that second path trustworthy, so the tests that
// matter most here are the ones proving it FAILS when the two disagree — a check that cannot fail is
// worse than no check, because it reads as proof.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicySources } = require('./policy-sources');
const { artifactFor, assertDerivationMatchesCedar, plan } = require('./policy-publish');
const { rowFromMemberships, rowIsStale } = require('../../archie-gateway/policy-derive');

const SOURCES = loadPolicySources({ env: 'sandbox' });
const PINNED = 'ch-cr89fluhion';      // holds every zero-holder sandbox pin, incl. hindsight.write
const OTHER = 'ch-c66pp782t9k';
const UNSEEN = 'dm-u-never-minted';   // no deploy has ever seen this one

test('the artifact carries memberships, a digest and the account — not verdicts', () => {
  const a = artifactFor(SOURCES);
  assert.equal(a.policyDigest, SOURCES.digest);
  assert.equal(a.account, SOURCES.pins.account);
  // 18 groups now: 12 `pin.<capability>` + 6 `skill.<id>` (seeded D3, 2026-08-18). Split by class rather
  // than asserting one total, because the two are read by different consumers — the verdicts come from the
  // pins, the row's `skills` list from the skill groups — and a change in either count should be legible.
  const byClass = (p) => Object.keys(a.groups).filter((g) => g.startsWith(p));
  assert.equal(byClass('pin.').length, 12, '12 pinned capabilities');
  assert.equal(byClass('skill.').length, 6, '6 pinned skills');
  assert.ok(!('verdicts' in a), 'verdicts cannot be precomputed for scopes that do not exist yet');
  for (const g of Object.keys(a.groups)) assert.match(g, /^(pin|skill)\./, 'every group is pin.<capability> or skill.<id>');
  // Annotation keys are documentation and must not reach the fleet.
  assert.ok(!Object.keys(a.groups).some((k) => k.startsWith('$')), 'no $-annotations in the artifact');
});

test('the artifact is byte-stable for the same sources', () => {
  // Otherwise the item churns every deploy and a real diff becomes invisible.
  assert.equal(JSON.stringify(artifactFor(SOURCES)), JSON.stringify(artifactFor(SOURCES)));
});

test('Cedar and the membership derivation agree — including for a scope never seen', () => {
  const { checked } = assertDerivationMatchesCedar([PINNED, OTHER, UNSEEN], SOURCES);
  assert.equal(checked, 3);
});

test('the derived row is COMPLETE over the pinned set, never sparse', () => {
  // An absent entry falls through to grants.has() in the consumer, so a missing `deny` is a hole, not a
  // saving: a DynamoDB grant row would confer a pinned capability.
  const row = rowFromMemberships(UNSEEN, artifactFor(SOURCES));
  assert.equal(Object.keys(row.verdicts).length, 12);
  for (const v of Object.values(row.verdicts)) assert.equal(v, 'deny', 'a non-member is denied explicitly');
  assert.equal(row.scope, UNSEEN);
});

test('membership IS the verdict: the pinned scope gets allow with no grant row anywhere', () => {
  const row = rowFromMemberships(PINNED, artifactFor(SOURCES));
  assert.equal(row.verdicts['hindsight.write'], 'allow');
  assert.equal(rowFromMemberships(OTHER, artifactFor(SOURCES)).verdicts['hindsight.write'], 'deny');
});

// ── the negative cases: the assertion must actually bite ───────────────────────────────────────────

test('a membership the artifact is MISSING is caught', () => {
  // The shape a stale or hand-edited artifact takes: Cedar says allow (the pin is in the sources), the
  // dispatcher would say deny. Silent loss of a pinned capability for every minted scope.
  const a = artifactFor(SOURCES);
  a.groups['pin.hindsight.write'] = a.groups['pin.hindsight.write'].filter((s) => s !== PINNED);
  assert.throws(() => assertDerivationMatchesCedar([PINNED], SOURCES, a), (e) => {
    assert.match(e.message, /DISAGREES with Cedar for ch-cr89fluhion \/ hindsight\.write/);
    assert.match(e.message, /cedar=allow membership=deny/);
    return true;
  });
});

test('a membership the artifact INVENTS is caught', () => {
  // The dangerous direction: the dispatcher would grant a capability Cedar denies.
  const a = artifactFor(SOURCES);
  a.groups['pin.aws-readonly'] = [...a.groups['pin.aws-readonly'], OTHER];
  assert.throws(() => assertDerivationMatchesCedar([OTHER], SOURCES, a), /cedar=deny membership=allow/);
});

test('a capability the artifact drops entirely is caught', () => {
  // Not "one fewer entry" — an absent entry means "not overridden", i.e. grantable. Must not pass.
  const a = artifactFor(SOURCES);
  delete a.groups['pin.hindsight.write'];
  assert.throws(() => assertDerivationMatchesCedar([PINNED], SOURCES, a), /hindsight\.write/);
});

test('a digest or account mismatch is caught separately from the verdicts', () => {
  const a = artifactFor(SOURCES);
  a.policyDigest = 'sha256:deadbeef';
  assert.throws(() => assertDerivationMatchesCedar([PINNED], SOURCES, a), /policy digest mismatch/);
  const b = artifactFor(SOURCES);
  b.account = '000000000000';
  assert.throws(() => assertDerivationMatchesCedar([PINNED], SOURCES, b), /policy account mismatch/);
});

test('a malformed group name is refused rather than skipped', () => {
  // Skipping would drop a capability from the row, which the consumer reads as "grantable".
  const a = artifactFor(SOURCES);
  a.groups.hindsight_write = [PINNED];
  assert.throws(() => rowFromMemberships(PINNED, a), /unexpected group name hindsight_write/);
});

test('plan() verifies every scope it returns a row for', () => {
  // `checked` equalling the scope count is the observable proof the assertion ran over all of them —
  // the entry point performs it so a caller cannot forget, since the assertion is the whole safety
  // argument for the dispatcher's engine-free path.
  //
  // NOT asserted here: that plan() throws on a Cedar/membership divergence. plan() derives BOTH sides
  // from the same sources, so it can only diverge if the POLICY outgrows membership (a `when`/`unless`
  // clause), which cannot be simulated without a fake policy set. The four negative cases above cover
  // the assertion itself with a hand-corrupted artifact; this covers only that plan() invokes it.
  const p = plan([PINNED, OTHER, UNSEEN], SOURCES);
  assert.equal(p.checked, 3, 'every planned scope was verified against Cedar');
  assert.equal(p.rows.length, 3);
  assert.ok(p.rows.every((r) => Object.keys(r.verdicts).length === 12));
  assert.equal(p.artifact.policyDigest, SOURCES.digest);
});

// ── the staleness backstop ─────────────────────────────────────────────────────────────────────────

test('rowIsStale: a missing, versionless or digest-drifted row is stale', () => {
  const a = artifactFor(SOURCES);
  const fresh = rowFromMemberships(PINNED, a);
  assert.equal(rowIsStale(fresh, a), false);
  assert.equal(rowIsStale(null, a), true, 'absent flows through the same write');
  assert.equal(rowIsStale({ ...fresh, policyDigest: 'sha256:old' }, a), true, 'a policy edit is detected');
  assert.equal(rowIsStale({ ...fresh, v: 999 }, a), true, 'a contract bump is detected');
  assert.equal(rowIsStale({ ...fresh, policyDigest: undefined }, a), true, 'no digest means unknown, not current');
});

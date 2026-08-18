// The compiled-verdict layer. Two things under test and they fail in opposite directions on purpose:
// loadPolicyTable's validation (invalid → deny everything; absent → behave as before), and the
// resolution rule shared by the decider and the tool filter.
//
// The assertions that matter most are the ones about a GRANT ROW BEING INERT. "Policy-pinned" means
// membership is the whole story, so if a `deny` verdict ever loses to a grant row the pin layer is
// decorative — and that is not a loud failure, it is a silent widening. Several tests below exist only
// to make that specific regression impossible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicyTable, policyTableRequired, CONTRACT_VERSION } from './policy-table.mjs';
import { makeDecider, makeAllowCheck, policyRef } from './capabilities.mjs';

const SCOPE = 'ch-cr89fluhion';
const rowOf = (verdicts, over = {}) => ({
  v: CONTRACT_VERSION, account: '203366135563', policyDigest: 'sha256:abc', scope: SCOPE, verdicts, ...over,
});
const load = (row, opts = {}) => loadPolicyTable(row, { scope: SCOPE, ...opts });

test('a valid row resolves its verdicts and exposes the digest', () => {
  const t = load(rowOf({ 'hindsight.write': 'allow', 'aws-readonly': 'deny', datadog: 'grant' }));
  assert.equal(t.denyAll, false);
  assert.equal(t.verdictFor('hindsight.write'), 'allow');
  assert.equal(t.verdictFor('aws-readonly'), 'deny');
  assert.equal(t.verdictFor('datadog'), 'grant');
  assert.equal(t.verdictFor('never-mentioned'), undefined);
  assert.equal(t.digest, 'sha256:abc');
});

test('ABSENT is null, NOT deny-all — the layer must be additive before it is materialised', () => {
  // Distinct from every invalid case below. Every scope is in this state until the first policy deploy
  // reaches it, so conflating the two would deny-all the entire fleet on rollout.
  const problems = [];
  assert.equal(load(null, { onProblem: (w) => problems.push(w) }), null);
  assert.equal(load(undefined), null);
  assert.deepEqual(problems, ['absent'], 'absence is still reported — it is permissive, so it must be visible');
});

test('every malformed row fails CLOSED, denying capabilities it never mentioned', () => {
  const cases = {
    'not-an-object': 'a string',
    'not-an-object-array': [],
    'unknown-version': rowOf({}, { v: 99 }),
    'scope-mismatch': rowOf({}, { scope: 'dm-agent-848o7l' }),
    'verdicts-not-an-object': rowOf('nope'),
    'verdicts-null': rowOf(null),
    'bad-verdict': rowOf({ datadog: 'maybe' }),
  };
  for (const [label, row] of Object.entries(cases)) {
    const t = load(row);
    assert.equal(t.denyAll, true, `${label} must deny-all`);
    // Baseline capabilities included: a deny-all table means deny-all, not "deny the extras".
    assert.equal(t.verdictFor('fs.read'), 'deny', `${label} denies even baseline`);
    assert.equal(t.verdictFor('anything'), 'deny', `${label} denies the unmentioned`);
  }
});

test('one bad verdict poisons the whole row rather than being skipped', () => {
  // Skipping it would leave the entry ABSENT, which falls through to the grant path — turning a typo in
  // the policy into a widening. The good entries in this row must not survive.
  const t = load(rowOf({ 'hindsight.write': 'allow', datadog: 'GRANT' }));   // wrong case is invalid
  assert.equal(t.denyAll, true);
  assert.equal(t.verdictFor('hindsight.write'), 'deny');
});

test('account is asserted when supplied, skipped-and-recorded when not', () => {
  assert.equal(load(rowOf({}), { expectedAccount: '999999999999' }).denyAll, true);
  assert.equal(load(rowOf({}), { expectedAccount: '203366135563' }).accountAsserted, true);
  // Unset today (adding the env var would re-fingerprint every runtime), so this must read as
  // "not checked" rather than as a pass.
  assert.equal(load(rowOf({})).accountAsserted, false);
});

test('POLICY_TABLE_REQUIRED is off unless explicitly 1', () => {
  assert.equal(policyTableRequired({}), false);
  assert.equal(policyTableRequired({ POLICY_TABLE_REQUIRED: '0' }), false);
  assert.equal(policyTableRequired({ POLICY_TABLE_REQUIRED: 'true' }), false, 'only the exact flag counts');
  assert.equal(policyTableRequired({ POLICY_TABLE_REQUIRED: '1' }), true);
});

// ---------------------------------------------------------------------------------------------------
// The resolution rule.

const decideWith = (verdicts, granted = []) => {
  const signals = [];
  const policy = policyRef(verdicts === null ? null : load(rowOf(verdicts)));
  const decide = makeDecider({ grants: new Set(granted), policy, onSignal: (s) => signals.push(s) });
  return { decide, signals, policy };
};

test('a `deny` verdict beats a grant row — the pin is not advisory', () => {
  // THE test. If this ever passes-as-allowed, every policy pin in the fleet is decorative.
  const { decide, signals } = decideWith({ 'hindsight.write': 'deny' }, ['hindsight.write']);
  assert.equal(decide('hindsight.write'), false);
  assert.equal(signals[0].reason, 'policy-denied', 'and it is distinguishable from a missing grant');
});

test('an `allow` verdict needs no grant row — membership IS access', () => {
  const { decide, signals } = decideWith({ 'hindsight.write': 'allow' }, []);
  assert.equal(decide('hindsight.write'), true);
  assert.equal(signals[0].reason, 'pinned');
});

test('a `deny` verdict beats the BASELINE too', () => {
  // Cedar's forbid beats every permit, including A1 (the baseline permit). A row saying deny for a
  // baseline capability is therefore meaningful, not a contradiction to be resolved in baseline's favour.
  const { decide } = decideWith({ 'fs.read': 'deny' });
  assert.equal(decide('fs.read'), false);
});

test('`grant` defers to the grant row, in both directions', () => {
  assert.equal(decideWith({ datadog: 'grant' }, ['datadog']).decide('datadog'), true);
  assert.equal(decideWith({ datadog: 'grant' }, []).decide('datadog'), false);
});

test('reason distinguishes every outcome', () => {
  const reason = (verdicts, granted, cap) => {
    const { decide, signals } = decideWith(verdicts, granted);
    decide(cap);
    return signals[0].reason;
  };
  assert.equal(reason({ 'hindsight.write': 'allow' }, [], 'hindsight.write'), 'pinned');
  assert.equal(reason({ 'aws-readonly': 'deny' }, ['aws-readonly'], 'aws-readonly'), 'policy-denied');
  assert.equal(reason({ datadog: 'grant' }, ['datadog'], 'datadog'), 'granted');
  assert.equal(reason({ datadog: 'grant' }, [], 'datadog'), 'ungranted');
  assert.equal(reason({}, [], 'fs.read'), 'ambient');
  assert.equal(reason({}, [], 'aws-readonly'), 'ungranted');
});

test('an unusable table reports policy-unusable, not a bare deny', () => {
  // Otherwise a row that was written but failed validation — the scope is denying EVERYTHING — looks
  // exactly like an agent nobody has granted anything to.
  const signals = [];
  const decide = makeDecider({
    grants: new Set(['datadog']), policy: policyRef(load('garbage')), onSignal: (s) => signals.push(s),
  });
  assert.equal(decide('datadog'), false);
  assert.equal(signals[0].reason, 'policy-unusable');
});

test('with NO table the decider is byte-equivalent to the pre-policy rule', () => {
  // The additive property Phase 0's baseline depends on.
  const { decide } = decideWith(null, ['datadog']);
  assert.equal(decide('fs.read'), true, 'baseline still ambient');
  assert.equal(decide('datadog'), true, 'grant still works');
  assert.equal(decide('aws-readonly'), false, 'default-deny still denies');
});

test('the tool FILTER applies the same rule, so a pinned-away tool is never offered', () => {
  // If the filter and the decider disagreed, the model would be shown a tool and refused mid-turn —
  // which reads to it as a broken tool and makes it improvise around the gate.
  const t = load(rowOf({ 'hindsight.write': 'deny', 'hindsight.read': 'allow' }));
  const allows = makeAllowCheck({ grants: new Set(['hindsight.write']), policy: policyRef(t) });
  assert.equal(allows('hindsight.write'), false);
  assert.equal(allows('hindsight.read'), true);
});

test('the policy holder is LIVE — a pin revoked between turns takes effect on the next one', () => {
  // Both the decider and the filter close over the holder, not the table, so applyFilter can swap it.
  const policy = policyRef(load(rowOf({ 'hindsight.write': 'allow' })));
  const decide = makeDecider({ grants: new Set(), policy });
  const allows = makeAllowCheck({ grants: new Set(), policy });
  assert.equal(decide('hindsight.write'), true);
  assert.equal(allows('hindsight.write'), true);
  policy.table = load(rowOf({ 'hindsight.write': 'deny' }));       // next turn's read
  assert.equal(decide('hindsight.write'), false, 'no session rebuild required');
  assert.equal(allows('hindsight.write'), false);
});

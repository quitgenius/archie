'use strict';

// B2 — the materialiser, against the real engine and the real policy document.
//
// WHAT THESE TESTS ARE FOR, since they mostly assert numbers. The materialiser's job is to reproduce
// Cedar's decisions exactly, and the one class of bug it can have is a plausible-looking row that is
// wrong in the permissive direction — the omitted `deny` §1.1 calls "the hole". Every count below is a
// fact about the shipped `pins.<env>.json`, so a bindings edit that changes who holds what fails here
// and has to be acknowledged, which is the same service plan §3's check 7 provides at deploy time.
//
// THE 213-SCOPE PROD LIST IS NOT AVAILABLE OFFLINE, and these tests do not pretend otherwise.
// Plan §2.1 derives it from `items/routing/*.json`, of which this tree holds three (all sandbox);
// `_full-config.json` carries many bindings, which §2.1 explicitly rules out as a scope source. So the
// fleet-wide claim is asserted through its two components instead, which together are equivalent:
// every scope carries 12 entries whatever its membership, and the `allow` entries are exactly the 21
// memberships, all of which are in the many scopes named by the file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicySources } = require('./policy-sources');
const { capabilityDomain, membershipIndex, sharedEntities, scopeEntity } = require('./policy-entities');
const {
  ROW_VERSION, VERDICT, policySetFor, decisionFor, verdictFor, ambientVerdict,
  verdictsFor, rowFor, rowsFor, contextFor,
} = require('./policy-row');
const { EXIT } = require('./exit');

const PROD = loadPolicySources({ env: 'prod' });
const SANDBOX = loadPolicySources({ env: 'sandbox' });

/** The 12 policy-pinned capabilities — the only ones any statement overrides (semantics.cedar B + C). */
const PINNED = [
  'airflow', 'aws-person79b333-secrets', 'aws-readonly', 'cloudwatch-logs', 'datadog', 'demo_diagram_app',
  'hindsight.write', 'demo_notes_app', 'otel.fleet', 'demo_cache', 'sandbox-probe', 'demo_mail_app',
];

const PEER_TWO = 'dm-udbugah9aty';       // pin.aws-readonly, and nothing else
const PEER = 'dm-umrsp7355u7';        // six of the seven seeded groups
const UNSEEN = 'ch-never-seen';       // a scope no bindings file has named
const SANDBOX_CHANNEL = 'ch-cr89fluhion';   // sandbox's five zero-holder pins

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.exitCode;
  }
  return null;
};

test('three verdicts, and each one comes from a distinguishable place in the policy', () => {
  const all = verdictsFor(PEER_TWO, PROD);

  // `allow` — A1, the baseline CapGroup. No grant consulted.
  assert.equal(all['fs.read'], VERDICT.ALLOW);
  // `allow` — a PINNED capability this scope is a member of. Membership IS access, so it is `allow`
  // and never `grant`: that is the whole difference between the shipped permit/forbid pairs and the
  // forbid-only design superseded on 2026-08-18 (semantics.cedar:100-105).
  assert.equal(all['aws-readonly'], VERDICT.ALLOW);
  // `grant` — A2 only. Unpinned, non-baseline: the four capabilities that stay grant-managed, plus the
  // 8 comms slugs, which behave as ordinary ungated capabilities because `connector.comms` is declared
  // as data with no statement referencing it.
  for (const cap of ['fs.write', 'runtime', 'demo_query_app', 'demo_warehouse', 'SLACK_SEND_MESSAGE']) {
    assert.equal(all[cap], VERDICT.GRANT, cap);
  }
  // `deny` — a pin whose group this scope is not in. Nothing can allow it.
  assert.equal(all['demo_cache'], VERDICT.DENY);

  assert.equal(Object.keys(all).length, 31, 'the full map covers the whole domain');
});

test('a pinned capability is never `grant`, in either environment', () => {
  // If any pinned capability ever materialised as `grant` the pin would have silently become a
  // permission to be granted — the exact property the permit half of each pair exists to prevent.
  for (const sources of [PROD, SANDBOX]) {
    const scopes = [...membershipIndex(sources).keys(), UNSEEN];
    for (const scope of scopes) {
      const all = verdictsFor(scope, sources);
      for (const cap of PINNED) {
        assert.notEqual(all[cap], VERDICT.GRANT, `${sources.env} ${scope} ${cap}`);
      }
    }
  }
});

test('THE LOAD-BEARING DENY: a non-member with a live DynamoDB grant is denied', () => {
  const policies = policySetFor(PROD);
  const entities = [...sharedEntities(PROD), scopeEntity(UNSEEN, PROD)];
  for (const cap of PINNED) {
    // The row must SAY deny, not omit the entry: §1.1's consumer falls through an absent entry to
    // `grants.has(capability)`, and none of these twelve is baseline — so an omitted entry means a
    // DynamoDB row would confer it, which is precisely what the pin exists to make impossible.
    assert.equal(decisionFor({ scope: UNSEEN, capability: cap, grants: [cap], policies, entities }), 'deny', cap);
    assert.equal(rowFor(UNSEEN, PROD).verdicts[cap], VERDICT.DENY, cap);
  }
});

test('rowFor is TOTAL — a scope never seen before gets twelve denies, not an error', () => {
  // Plan §2 property 3: every pin is conditioned only on group membership, so a channel minted between
  // deploys is computable at mint time. There is no unknown-scope case to handle, and this is what
  // makes one delivery point serve both writers.
  for (const scope of [UNSEEN, 'dm-u000000000', 'ch-zzzzzzzzzzz']) {
    const row = rowFor(scope, PROD);
    assert.equal(row.scope, scope);
    assert.deepEqual(Object.keys(row.verdicts).sort(), PINNED);
    assert.deepEqual(Object.values(row.verdicts), PINNED.map(() => VERDICT.DENY));
  }
});

test('every scope carries exactly 12 entries, and the allows are exactly the memberships', () => {
  // The fleet-wide measurement of plan §1.1, asserted through its components (see the header note).
  for (const sources of [PROD, SANDBOX]) {
    const index = membershipIndex(sources);
    const scopes = [...index.keys(), UNSEEN, 'dm-u000000000'];
    let allows = 0;
    for (const [scope, row] of rowsFor(scopes, sources)) {
      assert.deepEqual(Object.keys(row.verdicts).sort(), PINNED, `${sources.env} ${scope}`);
      const scopeAllows = Object.values(row.verdicts).filter((v) => v === VERDICT.ALLOW).length;
      // One `allow` per PIN group the scope is in, and nothing else — membership ⟺ access, exactly. The
      // `skill.<id>` groups it may also belong to produce no verdict at all: they land in `row.skills`,
      // because a skill is prose the model is given rather than a tool the PEP gates (D3, 2026-08-18).
      const pinGroups = (index.get(scope) || []).filter((g) => g.startsWith('pin.'));
      assert.equal(scopeAllows, pinGroups.length, `${sources.env} ${scope}`);
      const skillGroups = (index.get(scope) || []).filter((g) => g.startsWith('skill.')).map((g) => g.slice(6));
      assert.deepEqual(row.skills, skillGroups.sort(), `${sources.env} ${scope} skills`);
      allows += scopeAllows;
    }
    assert.equal(allows, sources.env === 'prod' ? 21 : 9);
  }

  // Which gives the fleet figure: 213 prod scopes × 12 = 2,556 entries, 21 `allow`, 2,535 `deny`.
  // Plan §1.1 still quotes 220 / 2,640 / 22 — stale on both counts (prod is many scopes, and
  // pins.prod.json was corrected on 2026-08-18 from 22 memberships to 21).
  assert.equal(213 * PINNED.length, 2556);
  assert.equal(2556 - 21, 2535);
});

test('the two environments differ only in membership, and sharply', () => {
  // The five zero-holder pins are aimed at one sandbox channel and are `[]` in prod. That divergence is
  // the entire point of a per-environment bindings file (pins.sandbox.json:52-53).
  const sandbox = rowFor(SANDBOX_CHANNEL, SANDBOX).verdicts;
  for (const cap of ['hindsight.write', 'aws-person79b333-secrets', 'airflow', 'otel.fleet', 'sandbox-probe']) {
    assert.equal(sandbox[cap], VERDICT.ALLOW, cap);
    assert.equal(rowFor(SANDBOX_CHANNEL, PROD).verdicts[cap], VERDICT.DENY, cap);
  }
  // And prod's own holders are denied in the sandbox, because they are not sandbox scopes at all.
  assert.equal(rowFor(PEER, PROD).verdicts['demo_cache'], VERDICT.ALLOW);
  assert.equal(rowFor(PEER, SANDBOX).verdicts['demo_cache'], VERDICT.DENY);
});

test('pruning keeps exactly what the policy overrides — no baseline, no plain grant', () => {
  const all = verdictsFor(PEER, PROD);
  const row = rowFor(PEER, PROD);
  for (const cap of capabilityDomain(PROD)) {
    const kept = cap in row.verdicts;
    assert.equal(kept, all[cap] !== ambientVerdict(cap, PROD), `${cap} pruning must follow the ambient rule`);
    if (kept) assert.equal(row.verdicts[cap], all[cap]);
  }
  // The ambient rule the §1.1 consumer falls through to, derived from CapGroup::"baseline" and not
  // hard-coded, so `demo_diagram_app` joining baseline needs no code change here.
  assert.equal(ambientVerdict('fs.read', PROD), VERDICT.ALLOW);
  assert.equal(ambientVerdict('fs.write', PROD), VERDICT.GRANT);
  assert.equal(ambientVerdict('demo_diagram_app', PROD), VERDICT.GRANT);
});

test('the row envelope is the §1.1 contract, and refuses to be built without its assertions', () => {
  const row = rowFor(PEER, PROD);
  // `skills` is part of the envelope since D3: the runtime's skill filter needs the pinned skills this
  // scope may hold, and it cannot evaluate policy to work them out.
  assert.deepEqual(Object.keys(row), ['v', 'account', 'policyDigest', 'scope', 'verdicts', 'skills']);
  assert.equal(row.v, ROW_VERSION);
  assert.equal(row.account, '361364274007');
  assert.equal(row.policyDigest, PROD.digest);
  assert.equal(row.scope, PEER);

  // Deterministic serialisation: the same inputs must give byte-identical JSON, or check 7's diff and
  // the DynamoDB write both see phantom changes.
  assert.equal(JSON.stringify(rowFor(PEER, PROD)), JSON.stringify(row));
  assert.deepEqual(Object.keys(row.verdicts), [...Object.keys(row.verdicts)].sort());

  // The three inputs a row cannot be honest without. A row that cannot prove which policy and which
  // account it belongs to installs a deny-all table at boot (plan §5), so producing one without them
  // is a refusal, not a default.
  assert.equal(codeOf(() => rowFor(PEER, { ...PROD, digest: 'nope' })), EXIT.USAGE);
  assert.equal(codeOf(() => rowFor(PEER, { ...PROD, pins: { ...PROD.pins, account: '1' } })), EXIT.USAGE);
  assert.equal(codeOf(() => rowFor(PEER, { ...PROD, semantics: '' })), EXIT.USAGE);
  assert.equal(codeOf(() => rowFor('', PROD)), EXIT.USAGE);
});

test('BOTH of Cedar\'s error channels are refusals, never denies', () => {
  // `deny` is the expected value for 2,535 of prod's 2,556 entries, so a swallowed engine error would
  // produce a fleet-wide deny-all row set that looks completely ordinary.

  // Channel 1 — the policy text does not parse. Loud.
  assert.equal(codeOf(() => verdictsFor(PEER, { ...PROD, semantics: 'permit (principal action resource);' })),
    EXIT.PREFLIGHT);

  // Channel 2 — THE TRAP, and it is why decisionFor reads diagnostics.errors. This is a SUCCESSFUL
  // call: `{ decision: 'deny', reason: [], errors: ['record does not have the attribute `nope`'] }`.
  // Reading only `response.decision` materialises it as a genuine deny with nothing to notice.
  const errored = { ...PROD, semantics: 'permit (principal, action, resource) when { context.nope };' };
  assert.equal(codeOf(() => verdictsFor(PEER, errored)), EXIT.PREFLIGHT);

  // The same channel is what the missing-`resource.name` trap arrives through — A2 against a resource
  // with no Capability entity. This is the bug policy/README.md:129-146 records the document finding in
  // itself, and it is the reason capabilityEntities() asserts the attribute rather than hoping.
  const entities = [];   // no Capability entity at all
  assert.equal(codeOf(() => decisionFor({
    scope: PEER, capability: 'aws-readonly', grants: ['aws-readonly'],
    policies: policySetFor(PROD), entities,
  })), EXIT.PREFLIGHT);
});

test('VERIFIED: the two-probe enumeration is faithful — no cross-capability grant dependence', () => {
  // The materialiser's only real assumption (policy-row.js verdictFor): a capability's decision depends
  // on the grant set ONLY through whether THAT capability is in it. Every v1 statement satisfies it —
  // A2 tests `context.grants.contains(resource.name)` and the 24 pin statements read no context at all
  // — but it is not structural, and the comms gate the plan sketches would break it. So it is measured:
  // two extra probes per cell (everything granted, everything-but-this granted) must tell us nothing
  // the two-probe verdict did not already say.
  for (const sources of [PROD, SANDBOX]) {
    const ctx = contextFor(sources);
    const domain = capabilityDomain(sources);
    for (const scope of [...membershipIndex(sources).keys(), UNSEEN]) {
      const entities = [...ctx.shared, scopeEntity(scope, sources, ctx.index)];
      const ask = (capability, grants) =>
        decisionFor({ scope, capability, grants, policies: ctx.policies, entities });
      for (const capability of domain) {
        const verdict = verdictFor({ scope, capability, policies: ctx.policies, entities });
        const others = domain.filter((c) => c !== capability);
        assert.equal(ask(capability, others), ask(capability, []),
          `${sources.env} ${scope} ${capability}: other grants changed the answer with it ABSENT`);
        assert.equal(ask(capability, domain), ask(capability, [capability]),
          `${sources.env} ${scope} ${capability}: other grants changed the answer with it PRESENT`);
        // And the verdict is the one the two probes name.
        const expected = ask(capability, []) === 'allow'
          ? VERDICT.ALLOW
          : (ask(capability, [capability]) === 'allow' ? VERDICT.GRANT : VERDICT.DENY);
        assert.equal(verdict, expected);
      }
    }
  }
});

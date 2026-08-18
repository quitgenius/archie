'use strict';

// B1 — the entity set, and the two claims in policy-entities.js's header note that were MEASURED
// rather than reasoned about. Both are engine-backed here, because the whole point of the note is that
// the intuitive reading of "ScopeGroup entity data fails closed" attributes membership to the wrong
// entity, and only the engine can settle that.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPolicySources } = require('./policy-sources');
const {
  TYPE, uid,
  capabilityDomain, capGroupNames, scopeGroupNames, capGroupParents,
  capabilityEntities, scopeGroupEntities, sharedEntities,
  membershipIndex, groupsFor, scopeEntity, entitiesFor,
} = require('./policy-entities');
const { policySetFor, decisionFor } = require('./policy-row');
const { EXIT } = require('./exit');

const PROD = loadPolicySources({ env: 'prod' });
const SANDBOX = loadPolicySources({ env: 'sandbox' });

/** A prod scope in exactly one group — agent-kehypz's DM, pins.prod.json:86-87. */
const MEMBER = 'dm-udbugah9aty';
/** agent-k4wmx6's DM, in six of the seven seeded groups — pins.prod.json records this as correct. */
const PEER = 'dm-umrsp7355u7';
/** A scope no bindings file has ever named. */
const UNSEEN = 'ch-never-seen';

const codeOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.exitCode;
  }
  return null;
};

const ask = (sources, entities, scope, capability, grants = []) =>
  decisionFor({ scope, capability, grants, policies: policySetFor(sources), entities });

test('the domain is capabilities ∪ slugs, and the slugs are really there', () => {
  const domain = capabilityDomain(PROD);
  // 23 capabilities + 8 Connector comms slugs. Two blocks for review, one entity set (semantics.json:123).
  assert.equal(domain.length, 31);
  assert.deepEqual(domain, [...domain].sort(), 'sorted, so the row key order cannot depend on JSON key order');

  // THE BUG THE POLICY DOCUMENT FOUND IN ITSELF (policy/README.md:129-146). The 8 slugs were listed as
  // capGroup members with no entity built for them, so a GRANTED SLACK_SEND_MESSAGE evaluated to DENY —
  // A2 reads `resource.name` and there was nothing to read it from. It denied for a reason having
  // nothing to do with policy, which is the worst kind of wrong.
  for (const slug of PROD.data.capGroups['connector.comms'].members) assert.ok(domain.includes(slug), slug);
});

test('every Capability entity carries attrs.name, because A2 reads it', () => {
  const entities = capabilityEntities(PROD);
  const caps = entities.filter((e) => e.uid.type === TYPE.capability);
  assert.equal(caps.length, 31);
  for (const e of caps) {
    // archie.cedarschema:29-33 and spike README §5: omit this and the condition ERRORS, the permit
    // never applies, and you would "confirm" a pin that is doing nothing.
    assert.equal(e.attrs.name, e.uid.id, `${e.uid.id} must carry name === id`);
  }
  assert.deepEqual(
    entities.filter((e) => e.uid.type === TYPE.capGroup).map((e) => e.uid.id),
    ['baseline', 'connector.comms'],
  );
});

test('CapGroup membership becomes the capability entity\'s parents, one hop only', () => {
  const parents = capGroupParents(PROD);
  assert.deepEqual(parents.get('fs.read'), ['baseline']);
  assert.deepEqual(parents.get('SLACK_SEND_MESSAGE'), ['connector.comms']);
  assert.equal(parents.get('aws-readonly'), undefined, 'a pinned capability is in no capGroup');

  // The 7 baseline members are exactly CAPABILITY_DEFAULTS' 7 allow entries
  // (permissions/capabilities.mjs:12-21). Plan §8.2 makes that map DERIVED from this group; until it
  // does, `rowFor`'s pruning depends on the two agreeing (see policy-row.js ambientVerdict).
  assert.deepEqual(PROD.data.capGroups.baseline.members.slice().sort(),
    ['connector', 'cron', 'fs.read', 'health', 'hindsight.read', 'memory', 'otel']);

  // CapGroups cannot nest: archie.cedarschema:36 declares `entity CapGroup;` with no `in [...]`.
  for (const e of capabilityEntities(PROD).filter((x) => x.uid.type === TYPE.capGroup)) {
    assert.deepEqual(e.parents, []);
  }
});

test('a capGroup member with no capability entity refuses loudly', () => {
  // The same omission fails CLOSED one way (a silent deny through A2) and OPEN the other (a forbid on
  // it would never fire, since a nonexistent entity cannot be `in` a CapGroup). Neither is visible
  // without this refusal.
  const broken = { ...PROD, data: { ...PROD.data, capGroups: { ...PROD.data.capGroups,
    baseline: { members: [...PROD.data.capGroups.baseline.members, 'fs.raed'] } } } };
  assert.equal(codeOf(() => capGroupParents(broken)), EXIT.PREFLIGHT);
});

test('the ScopeGroup vocabulary is the 12 pins, in both environments', () => {
  const expected = [
    'pin.airflow', 'pin.aws-person79b333-secrets', 'pin.aws-readonly', 'pin.cloudwatch-logs',
    'pin.datadog', 'pin.demo_diagram_app', 'pin.hindsight.write', 'pin.demo_notes_app', 'pin.otel.fleet',
    'pin.demo_cache', 'pin.sandbox-probe', 'pin.demo_mail_app',
  ];
  assert.deepEqual(scopeGroupNames(PROD), expected);
  assert.deepEqual(scopeGroupNames(SANDBOX), expected);
  assert.deepEqual(scopeGroupEntities(PROD).map((e) => e.uid.id), expected);
  assert.equal(capGroupNames(PROD).length, 2);
});

test('membership is the Scope entity\'s parents, and an unnamed scope simply has none', () => {
  const index = membershipIndex(PROD);
  // 21 memberships over 14 distinct scopes. agent-k4wmx6 legitimately appears in six groups.
  assert.equal([...index.values()].reduce((n, g) => n + g.length, 0), 21);
  assert.equal(index.size, 14);
  assert.deepEqual(groupsFor(MEMBER, PROD), ['pin.aws-readonly']);
  assert.equal(groupsFor(PEER, PROD).length, 6);

  assert.deepEqual(scopeEntity(MEMBER, PROD).parents, [uid(TYPE.scopeGroup, 'pin.aws-readonly')]);
  // NOT an error and NOT a missing entry — the ordinary case for 199 of prod's many scopes.
  assert.deepEqual(scopeEntity(UNSEEN, PROD), { uid: uid(TYPE.scope, UNSEEN), attrs: {}, parents: [] });

  // The sandbox differs sharply and legitimately: 9 memberships over 3 scopes, five of them the
  // zero-holder pins aimed at one channel (pins.sandbox.json:55-59) that prod deliberately keeps empty.
  const sandboxIndex = membershipIndex(SANDBOX);
  assert.equal([...sandboxIndex.values()].reduce((n, g) => n + g.length, 0), 9);
  assert.equal(sandboxIndex.size, 3);
  assert.equal(groupsFor('ch-cr89fluhion', SANDBOX).length, 5);

  assert.equal(codeOf(() => groupsFor('', PROD)), EXIT.USAGE);
});

test('entitiesFor is the shared set plus exactly one principal', () => {
  const shared = sharedEntities(PROD);
  assert.equal(shared.length, 31 + 2 + 12);
  const all = entitiesFor(MEMBER, PROD);
  assert.equal(all.length, shared.length + 1);
  assert.equal(all[all.length - 1].uid.id, MEMBER);
  // Passing the shared half in must give the identical set — that is what makes the fleet pass cheap.
  assert.deepEqual(entitiesFor(MEMBER, PROD, shared), all);
});

test('MEASURED: the ScopeGroup entity is documentation; the Scope\'s parents are what decide', () => {
  // This is the claim policy-entities.js's header note makes and the reason it is worth making: the
  // spike's "group entity absent entirely → deny" row is easy to read as "the ScopeGroup entity
  // carries membership". It does not. Cedar's membership edge points FROM the child.
  const caps = capabilityEntities(PROD);
  const scope = { uid: uid(TYPE.scope, MEMBER), attrs: {}, parents: [uid(TYPE.scopeGroup, 'pin.aws-readonly')] };

  // No ScopeGroup entity supplied at all, yet the pin's permit still lands.
  assert.equal(ask(PROD, [...caps, scope], MEMBER, 'aws-readonly'), 'allow');
  // The full set, as this module builds it: same answer.
  assert.equal(ask(PROD, entitiesFor(MEMBER, PROD), MEMBER, 'aws-readonly'), 'allow');

  // And the fail-closed rows, which is where the property actually lives: drop the edge and it denies
  // even with the ScopeGroup entity present and a DynamoDB grant saying yes.
  const groups = scopeGroupEntities(PROD);
  const noEdge = { uid: uid(TYPE.scope, MEMBER), attrs: {}, parents: [] };
  assert.equal(ask(PROD, [...caps, ...groups, noEdge], MEMBER, 'aws-readonly', ['aws-readonly']), 'deny');
  // A principal absent from the entity set entirely — which is what makes rowFor TOTAL (plan §2,
  // property 3): a scope minted between deploys is authorizable and denied, not an error.
  assert.equal(ask(PROD, [...caps, ...groups], UNSEEN, 'aws-readonly', ['aws-readonly']), 'deny');
});

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

/**
 * agent-kehypz's DM. In `pin.aws-readonly` and, since the skill lists were seeded (D3, 2026-08-18), also in
 * `skill.demo-crm` — so it is now the useful case for BOTH group classes landing on one Scope
 * entity's parents rather than "a scope in exactly one group", which it used to be.
 */
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

test('the ScopeGroup vocabulary is the 12 pins PLUS the 6 skill groups, in both environments', () => {
  // Two classes now (D3, 2026-08-18): `pin.<capability>` groups, which Cedar statements reference, and
  // `skill.<id>` groups, which no statement references — they are compiled into the row's `skills` list and
  // consumed by the runtime's skill filter. Both are ScopeGroups because both are per-environment scope
  // membership; the difference is who reads them, and check 3 exempts the skill prefix for that reason.
  const pins = [
    'pin.airflow', 'pin.aws-person79b333-secrets', 'pin.aws-readonly', 'pin.cloudwatch-logs',
    'pin.datadog', 'pin.demo_diagram_app', 'pin.hindsight.write', 'pin.demo_notes_app', 'pin.otel.fleet',
    'pin.demo_cache', 'pin.sandbox-probe', 'pin.demo_mail_app',
  ];
  const skills = [
    'skill.comms-approval', 'skill.demo-crm', 'skill.sales-reengagement-briefing',
    'skill.skill-builder', 'skill.support-member-update', 'skill.demo-sensitive-skill',
  ];
  const expected = [...pins, ...skills].sort();
  assert.deepEqual(scopeGroupNames(PROD), expected);
  assert.deepEqual(scopeGroupNames(SANDBOX), expected);
  assert.deepEqual(scopeGroupEntities(PROD).map((e) => e.uid.id), expected);
  assert.equal(capGroupNames(PROD).length, 2);
});

test('membership is the Scope entity\'s parents, and an unnamed scope simply has none', () => {
  const index = membershipIndex(PROD);
  // 29 capability pins + 147 skill memberships.
  //
  // THIS COUNT WAS 21 + 145 AND BOTH WERE UNDER-COUNTS, which is the more useful thing for this test to
  // record than the number itself. The derivation read `config/marketplace-installs.json` only, and sandra
  // declares a pinned authority on THREE surfaces — that file, each agent's `skills: [...]` in
  // openclaw.config.js, and the resolved per-agent plugin config. `person79b333`, `archie-data-engineer` and
  // `agent-zxgm7w` are absent from the installs file entirely, so:
  //
  //   pin.aws-readonly        2 → 7   five prod scopes would have LOST aws-readonly on publish
  //   pin.cloudwatch-logs     3 → 4   sona-support, via its datadog-logs skill
  //   pin.aws-person79b333-secrets  0 → 1   person79b333
  //   pin.hindsight.write     0 → 1   agent-zxgm7w (`enableKnowledgeTools`, plugin config)
  //   skill.support-member-update / skill.demo-sensitive-skill  0 → 1 each  (agent-ykdenu)
  //
  // An under-counted pin group is SILENT — membership ⟺ access, so the only symptom is less access than
  // intended — which is why the assertion below is paired with the per-group trace above rather than left as
  // a bare total. The previous message on this line read "the capability pins are unchanged by the skill
  // seeding": true of the code at the time, and the reason nobody looked.
  const pinOnly = (g) => g.startsWith('pin.');
  const pinMemberships = [...index.values()].reduce((n, g) => n + g.filter(pinOnly).length, 0);
  assert.equal(pinMemberships, 29, 'capability pins are derived from all three surfaces, additively');
  assert.equal([...index.values()].reduce((n, g) => n + g.length, 0), 29 + 147);
  assert.deepEqual(groupsFor(MEMBER, PROD).filter(pinOnly), ['pin.aws-readonly']);
  // Peer holds SEVEN of the capability pins, not six: aws-readonly arrived with the code-declared skills
  // surface (`skills: [… 'aws-readonly']` in his agent block), which nothing read before.
  assert.deepEqual(groupsFor(PEER, PROD).filter(pinOnly), [
    'pin.aws-readonly', 'pin.cloudwatch-logs', 'pin.datadog',
    'pin.demo_diagram_app', 'pin.demo_notes_app', 'pin.demo_cache', 'pin.demo_mail_app',
  ]);

  // BOTH classes, on one entity, in the order groupsFor returns them. Cedar does not distinguish them —
  // membership is membership — which is exactly why the SKILL axis had to stay out of the verdicts rather
  // than out of the entity set.
  assert.deepEqual(scopeEntity(MEMBER, PROD).parents,
    [uid(TYPE.scopeGroup, 'pin.aws-readonly'), uid(TYPE.scopeGroup, 'skill.demo-crm')]);
  // NOT an error and NOT a missing entry — the ordinary case for a scope in no group at all. Note that is
  // now a much smaller share of prod than it was: the seeded skill lists put many scopes in
  // skill.demo-crm alone, so the membership index covers 142 of many scopes rather than 14.
  assert.deepEqual(scopeEntity(UNSEEN, PROD), { uid: uid(TYPE.scope, UNSEEN), attrs: {}, parents: [] });

  // The sandbox differs sharply and legitimately: 9 memberships over 3 scopes, five of them the
  // zero-holder pins aimed at one channel (pins.sandbox.json:55-59) that prod deliberately keeps empty.
  const sandboxIndex = membershipIndex(SANDBOX);
  const sandboxPins = [...sandboxIndex.values()].reduce((n, g) => n + g.filter(pinOnly).length, 0);
  assert.equal(sandboxPins, 9);
  // +2 skill memberships: ch-c66pp782t9k AND dm-ux0mz5ckp2r both hold skill-builder in the sandbox config.
  // The second was MISSED by hand-seeding and found by seed-policy-pins.mjs, because agent-xx9aff
  // exists in both environments and the hand script assigned it to whichever routing matched first (prod).
  // Deriving per-environment against that environment's own routing gets it right by construction.
  assert.equal([...sandboxIndex.values()].reduce((n, g) => n + g.length, 0), 11);
  assert.equal(sandboxIndex.size, 3);
  // 142, from 137: the five scopes the code-declared-skills surface added to pin.aws-readonly, plus
  // person79b333/agent-zxgm7w/sona-support/agent-ykdenu, less the overlap with scopes already
  // named by a skill group. Every one of them is a scope that was in the file's fleet but in NO group.
  assert.equal(membershipIndex(PROD).size, 142, 'prod: pin-only scopes + the seeded skill holders');
  assert.equal(groupsFor('ch-cr89fluhion', SANDBOX).filter(pinOnly).length, 5);
  for (const scope of ['ch-c66pp782t9k', 'dm-ux0mz5ckp2r']) {
    assert.deepEqual(groupsFor(scope, SANDBOX).filter((g) => !pinOnly(g)), ['skill.skill-builder'], scope);
  }

  assert.equal(codeOf(() => groupsFor('', PROD)), EXIT.USAGE);
});

test('entitiesFor is the shared set plus exactly one principal', () => {
  const shared = sharedEntities(PROD);
  // 31 capabilities + 2 CapGroups + 18 ScopeGroups (12 pin + 6 skill, seeded 2026-08-18). The skill groups
  // get entities like any other ScopeGroup even though no Cedar statement references them: the entity set is
  // vocabulary, and omitting them would make a Scope's `parents` name a group that does not exist — which
  // spike README §5 records as a dangling parent that still ALLOWS, i.e. fails OPEN.
  assert.equal(shared.length, 31 + 2 + 18);
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

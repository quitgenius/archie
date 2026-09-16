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
  // 28 capabilities + 8 Connector comms slugs. Two blocks for review, one entity set (semantics.json:123).
  // 24 → 25 on 2026-09-14: files.publish joined the baseline with save_artifact.
  // 25 → 27 on 2026-09-15: `ec2` and `bedrock-mantle`, the first capabilities to arrive from OpenClaw's
  // per-agent IAM map rather than from a tool or a skill.
  // 27 → 28 on 2026-09-16: `demo_sensitive_action`, once demo_sensitive_tool was ported and the capability had
  // a tool to govern. It is the LAST of the prod.tfvars statements, so NOT_PORTED is now empty.
  assert.equal(domain.length, 36);
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
  assert.equal(caps.length, 36);
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

  // The baseline members are exactly CAPABILITY_DEFAULTS' allow entries — which ARE now derived from
  // this group (baseline.generated.mjs), so the two cannot drift; `rowFor`'s pruning depends on that
  // agreement (see policy-row.js ambientVerdict).
  assert.deepEqual(PROD.data.capGroups.baseline.members.slice().sort(),
    ['connector', 'cron', 'files.publish', 'fs.read', 'health', 'hindsight.read', 'memory', 'otel', 'slack.send']);

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

test('the ScopeGroup vocabulary is the 15 pins PLUS the 5 skill groups, in both environments', () => {
  // FIVE skill groups since 2026-08-19: comms-approval was removed as a zero-holder pin. It was also the
  // group the deployed gateway rejected, which made every POLICY row write fail non-fatally — so a group
  // nobody held was disabling the policy layer for whichever scope tried to use it.
  //
  // Two classes (D3, 2026-08-18): `pin.<capability>` groups, which Cedar statements reference, and
  // `skill.<id>` groups, which no statement references — they are compiled into the row's `skills` list and
  // consumed by the runtime's skill filter. Both are ScopeGroups because both are per-environment scope
  // membership; the difference is who reads them, and check 3 exempts the skill prefix for that reason.
  // FIFTEEN pins since 2026-09-16 — pin.ec2 and pin.bedrock-mantle (B6/B7, pin-only, ported from
  // clawdbot_agent_iam_statements, so the group IS the authority), and pin.demo_sensitive_action (B8), which
  // unlike those two DOES have a tool: demo_sensitive_tool, whose own approval gate is the second
  // control alongside the pin.
  const pins = [
    'pin.airflow', 'pin.aws-person79b333-secrets', 'pin.aws-readonly', 'pin.bedrock-mantle',
    'pin.cloudwatch-logs', 'pin.demo_sensitive_action', 'pin.datadog', 'pin.ec2', 'pin.demo_diagram_app',
    'pin.hindsight.write', 'pin.demo_notes_app', 'pin.otel.fleet', 'pin.demo_cache', 'pin.sandbox-probe',
    'pin.demo_mail_app',
  ];
  const skills = [
    'skill.demo-crm', 'skill.sales-reengagement-briefing',
    'skill.skill-builder', 'skill.support-member-update', 'skill.demo-sensitive-skill',
  ];
  const expected = [...pins, ...skills].sort();
  assert.deepEqual(scopeGroupNames(PROD), expected);
  assert.deepEqual(scopeGroupNames(SANDBOX), expected);
  assert.deepEqual(scopeGroupEntities(PROD).map((e) => e.uid.id), expected);
  assert.equal(capGroupNames(PROD).length, 2);
});


test('entitiesFor is the shared set plus exactly one principal', () => {
  const shared = sharedEntities(PROD);
  // 36 capabilities + 2 CapGroups + 20 ScopeGroups (15 pin + 5 skill; comms-approval removed 2026-08-19,
  // a zero-holder pin that was also breaking POLICY row writes on the deployed gateway). The skill groups
  // get entities like any other ScopeGroup even though no Cedar statement references them: the entity set is
  // vocabulary, and omitting them would make a Scope's `parents` name a group that does not exist — which
  // spike README §5 records as a dangling parent that still ALLOWS, i.e. fails OPEN.
  assert.equal(shared.length, 36 + 2 + 20);
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

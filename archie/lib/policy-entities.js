'use strict';

// B1 — the Cedar entity set `semantics.cedar` expects, built from the policy document.
//
// Cedar splits a policy into three inputs: the POLICY TEXT (what is true), the SCHEMA (what the words
// mean), and the ENTITY DATA (who is in which group). This module is the third. The whole design turns
// on that split, because it is what lets one shared `semantics.cedar` mean the same thing in every
// account while membership varies per environment — see archie-cedar-spike/README.md §1-4 for the
// three ways the obvious alternative (a policy TEMPLATE) was measured to fail, one of them by meaning
// the exact opposite of what was intended.
//
// FOUR ENTITY TYPES, and every one of them is required by a statement:
//
//   Archie::Capability   the RESOURCE. Must carry attrs.name — see the note on capabilityEntities().
//   Archie::CapGroup     `resource in Archie::CapGroup::"baseline"` (A1, semantics.cedar:53-57).
//   Archie::ScopeGroup   `principal in Archie::ScopeGroup::"pin.X"` — every one of the 12 pins.
//   Archie::Scope        the PRINCIPAL, and its `parents` array IS its group membership.
//
// `Archie::Action::"use"` is declared in the schema, not here — actions are schema data in Cedar, and
// supplying one as an entity is neither needed nor possible in this shape. `Archie::Trigger` is an
// ENUMERATED entity type (archie.cedarschema:59), whose values are literals and need no entity data
// either; no v1 statement reads `context.trigger` at all.
//
// ── WHERE MEMBERSHIP ACTUALLY LIVES, because it is not where the README's phrasing suggests ────────
//
// The spike records that "ScopeGroup entity data fails closed" and measures three rows: group =
// [holder] allows the holder, group = [] denies everyone, and "group entity absent entirely" denies
// everyone. That is all true, but it is easy to read it as "the ScopeGroup entity is what carries
// membership", and it is not. In Cedar, membership is an edge FROM the child: it is the
// `Archie::Scope` entity's `parents` array that says which groups it is in. Measured against
// cedar-wasm 4.12.0 while writing this module:
//
//   · a Scope whose `parents` names `pin.aws-readonly`, with NO ScopeGroup entity supplied at all →
//     still ALLOW, and `checkParseEntities` accepts it against the schema. A dangling parent is not
//     an error and does not break the membership test.
//   · a Scope with an empty `parents`, or a scope not present in the entity set at all → DENY.
//
// So the fail-closed property is really this: **membership is only ever asserted by the Scope entity
// this module emits from `pins.<env>.json`, and every other way of arriving at the question denies.**
// The ScopeGroup entities are still emitted (scopeGroupEntities), for two honest but lesser reasons:
// the entity set then names the complete group vocabulary, which is what a human reads when a pin
// misfires; and it is the shape the entity data would need if a group ever gained an attribute or a
// parent of its own. It is documentation, not enforcement — stated plainly here so nobody later
// "optimises" the Scope's parents away believing the groups carry the edges.
//
// The second half of that measurement is what makes plan §2's property 3 true — `rowFor` is a TOTAL
// function, and a scope minted between deploys correctly gets 12 denies rather than an error, because
// Cedar is content to authorize a principal it has never been told about (the spike's `pinAsk(HOLDER,
// [])` rows, 04-plan-snippets.mjs:110-111). There is no unknown-scope case to handle.

const { usage, preflight } = require('./exit');
const { realKeys } = require('./policy-sources');

// The one namespace, from archie.cedarschema:9. Written out per type rather than composed from a
// prefix constant so a grep for `Archie::Capability` finds this file.
const TYPE = {
  scope: 'Archie::Scope',
  scopeGroup: 'Archie::ScopeGroup',
  capability: 'Archie::Capability',
  capGroup: 'Archie::CapGroup',
  action: 'Archie::Action',
};

const ACTION_USE = { type: TYPE.action, id: 'use' };

/** Cedar's `EntityUidJson` in its bare `{ type, id }` form — the shape the spike's harness used. */
const uid = (type, id) => ({ type, id });

/**
 * Every capability that can be the RESOURCE of a decision, sorted.
 *
 * The union of semantics.json's `capabilities` and `slugs`. They are two blocks for review reasons
 * only — one is our capability model, the other is Connector's catalogue — and semantics.json:123 is
 * explicit that "the build step unions both into one entity set". The `slugs` block exists BECAUSE its
 * absence was a live bug: the 8 comms slugs were listed as capGroup members with no entity built for
 * them, so a granted SLACK_SEND_MESSAGE evaluated to DENY, since A2 reads `resource.name` and there
 * was nothing to read it from (policy/README.md:129-146).
 *
 * This set is also the domain the materialiser enumerates, which is why it is sorted: the row's key
 * order must not depend on JSON key order surviving a re-edit.
 */
function capabilityDomain(sources) {
  const data = requireData(sources);
  const names = [...realKeys(data.capabilities), ...realKeys(data.slugs)];
  const seen = new Set();
  for (const name of names) {
    // A name in both blocks would silently collapse to one entity with one `parents` list, and the
    // review split ("grouped by origin, not by authority") is what would have hidden it.
    if (seen.has(name)) throw preflight(`semantics.json declares "${name}" in both capabilities and slugs`);
    seen.add(name);
  }
  return names.sort();
}

/** CapGroup names — `baseline` and `connector.comms` today. */
const capGroupNames = (sources) => realKeys(requireData(sources).capGroups);

/**
 * ScopeGroup names, from the bindings.
 *
 * This is the bindings' side of plan §3's check 3 (bidirectional: every group named by a statement
 * must appear here, and every group here must be named by a statement). That check belongs to the
 * deploy step; this is the enumeration it will read.
 */
const scopeGroupNames = (sources) => realKeys(requirePins(sources).groups);

/**
 * capability → the CapGroups it belongs to.
 *
 * Refuses a capGroup member with no capability entity, which is the exact bug policy/README.md:129
 * records this document finding in itself — and it fails in both directions, so it must be loud: a
 * missing entity is a silent DENY through A2, and a `forbid` naming it would never fire, because a
 * nonexistent entity cannot be `in` a CapGroup. This is NOT plan §3's check 2, which asks a bigger
 * question (does the entity set equal CAPABILITY_DEFAULTS ∪ ALSO_ALLOW_CAP ∪ the declared slugs, i.e.
 * does the policy know about every capability the CODE has). This only asserts semantics.json is
 * internally consistent with itself, which is the part a builder of entities can see.
 *
 * Cedar cannot nest CapGroups here even if we wanted to: archie.cedarschema:36 declares
 * `entity CapGroup;` with no `in [...]`, so a group has no parents and membership is exactly one hop.
 */
function capGroupParents(sources) {
  const data = requireData(sources);
  const domain = new Set(capabilityDomain(sources));
  const parents = new Map();
  for (const group of capGroupNames(sources)) {
    for (const member of data.capGroups[group].members) {
      if (!domain.has(member)) {
        throw preflight(`semantics.json: capGroups["${group}"] names "${member}", which has no capability entity`,
          { detail: 'add it to `capabilities` or `slugs` — a member with no entity denies silently, and a '
            + 'forbid on it would never fire (policy/README.md:129-146)' });
      }
      if (!parents.has(member)) parents.set(member, []);
      parents.get(member).push(group);
    }
  }
  return parents;
}

/**
 * The Capability and CapGroup entities. Scope-independent, so a fleet-wide pass builds them once.
 *
 * `attrs.name` IS NOT DECORATION. A2 — the grant-row permit — reads `context.grants.contains
 * (resource.name)` (semantics.cedar:73). Omit the attribute and the condition ERRORS, the permit never
 * applies, and the request denies for a reason that has nothing to do with policy: you would "confirm"
 * a pin that was doing nothing. Both archie.cedarschema:29-33 and the spike README §5 call this out as
 * the trap that costs real time, so it is asserted rather than assumed (`name === id`, always).
 */
function capabilityEntities(sources) {
  const parents = capGroupParents(sources);
  return [
    ...capGroupNames(sources).map((g) => ({ uid: uid(TYPE.capGroup, g), attrs: {}, parents: [] })),
    ...capabilityDomain(sources).map((cap) => ({
      uid: uid(TYPE.capability, cap),
      attrs: { name: cap },
      parents: (parents.get(cap) || []).map((g) => uid(TYPE.capGroup, g)),
    })),
  ];
}

/** The ScopeGroup entities — the group vocabulary, for the reasons in the header note. */
function scopeGroupEntities(sources) {
  return scopeGroupNames(sources).map((g) => ({ uid: uid(TYPE.scopeGroup, g), attrs: {}, parents: [] }));
}

/**
 * scope id → the ScopeGroups it is in.
 *
 * Built once and shared, because the fleet pass asks it 213 times and the answer is the inversion of
 * the same 12 arrays. A scope absent from the map is in no group — that is the ordinary case (14 of
 * prod's many scopes appear in any group at all) and not a missing entry.
 */
function membershipIndex(sources) {
  const pins = requirePins(sources);
  const index = new Map();
  for (const group of scopeGroupNames(sources)) {
    for (const scope of pins.groups[group]) {
      if (!index.has(scope)) index.set(scope, []);
      const groups = index.get(scope);
      // A scope listed twice in one group is harmless to Cedar but is a copy-paste slip worth not
      // reproducing in the entity set, where it would appear as a duplicated parent edge.
      if (!groups.includes(group)) groups.push(group);
    }
  }
  return index;
}

/** Which ScopeGroups this scope is in, sorted. Empty for a scope the bindings have never named. */
function groupsFor(scope, sources, index = null) {
  assertScope(scope);
  const groups = (index || membershipIndex(sources)).get(scope) || [];
  return [...groups].sort();
}

/**
 * The one Scope entity — the principal, carrying its membership as `parents`.
 *
 * This is the entire per-scope half of the entity set, and per the header note it is the only place
 * membership is asserted.
 */
function scopeEntity(scope, sources, index = null) {
  return {
    uid: uid(TYPE.scope, scope),
    attrs: {},
    parents: groupsFor(scope, sources, index).map((g) => uid(TYPE.scopeGroup, g)),
  };
}

/**
 * Everything except the principal — capabilities, capGroups, scopeGroups.
 *
 * Exported separately so a fleet-wide materialisation builds it once and concatenates one Scope entity
 * per scope, rather than rebuilding the same 45 entities (31 capabilities + 2 CapGroups + 12
 * ScopeGroups) 213 times.
 */
function sharedEntities(sources) {
  return [...capabilityEntities(sources), ...scopeGroupEntities(sources)];
}

/** The complete entity set for one authorization request about `scope`. */
function entitiesFor(scope, sources, shared = null) {
  return [...(shared || sharedEntities(sources)), scopeEntity(scope, sources)];
}

function assertScope(scope) {
  // Deliberately a SHAPE-FREE check. Validating that a scope id looks like `dm-…`/`ch-…` is plan §3's
  // check 4, and §2.1 records that check 4 had to be UPGRADED from shape to membership in the
  // environment's scope list precisely because shape cannot catch the bug that was live in
  // pins.prod.json until 2026-08-18: two well-formed SANDBOX ids in pin.cloudwatch-logs that do not
  // exist on prod. A shape check here would read as that guard while providing none of it.
  if (typeof scope !== 'string' || scope === '') throw usage('a scope id (a non-empty string) is required');
}

function requireData(sources) {
  if (!sources?.data?.capGroups) throw usage('sources.data must be the parsed semantics.json');
  return sources.data;
}

function requirePins(sources) {
  if (!sources?.pins?.groups) throw usage('sources.pins must be the parsed pins.<env>.json');
  return sources.pins;
}

module.exports = {
  TYPE, ACTION_USE, uid,
  capabilityDomain, capGroupNames, scopeGroupNames, capGroupParents,
  capabilityEntities, scopeGroupEntities, sharedEntities,
  membershipIndex, groupsFor, scopeEntity, entitiesFor,
};

'use strict';

// B2 — the materialiser. Cedar in, one per-scope verdict row out (plan §1, §1.1).
//
// This is the whole reason Cedar is a BUILD-TIME authority. An agent maps 1:1 to a scope, so it never
// needs the (scope × capability) cross-product — it needs its OWN ROW, one verdict per capability
// (plan §1). The row is what ships; the engine is not. `decide()` at runtime stays a set lookup.
//
// ENUMERATION *USING* CEDAR, NOT A REIMPLEMENTATION OF IT. That distinction is what makes this sound
// (plan §3, check 6). Nothing here reads `semantics.cedar` looking for pins, counts `forbid`s, or
// knows the names of the 12 pinned capabilities. It asks the real engine a bounded set of questions and
// records the answers. Consequences worth stating, because they are the point:
//
//   · `rowFor` is a TOTAL pure function of (scope id, policy sources). A scope the materialiser has
//     never seen — a channel minted between deploys — gets 12 denies, not an error. Every pin is
//     conditioned only on `principal in ScopeGroup::"…"`, so an unknown principal is simply in no
//     group (measured; see the header note in policy-entities.js). There is no unknown-scope case.
//   · A policy change nobody understood still materialises correctly. If a 13th pin lands, or the
//     baseline set changes, this file does not change.
//
// ── THREE VERDICTS, AND THE THIRD IS THE ONE THAT MATTERS (plan §1) ────────────────────────────────
//
//   allow  unconditional — the grant row is not consulted
//   grant  allowed iff the live GRANT#<scope> row has it, THIS TURN
//   deny   nothing can allow it
//
// A two-valued table would collapse "pinned member" into `allow` and silently convert every policy pin
// into a grant. Note what does NOT occur: for a PINNED capability the verdict is only ever `allow`
// (member) or `deny` (non-member), never `grant` — because under the permit/forbid pairs that ship,
// membership IS access (semantics.cedar:90-98). `grant` is what a non-pinned, non-baseline capability
// gets: `fs.write`, `runtime`, `demo_query_app`, `demo_warehouse`, and the 8 comms slugs.
//
// ── THE `deny` IS LOAD-BEARING, NOT AN OPTIMISATION TO BE REMOVED ──────────────────────────────────
//
// §1.1's consumer falls through an ABSENT entry to `isBaseline(cap) || grants.has(cap)`. `aws-readonly`
// is not baseline, so an omitted `deny` for a non-member means a DynamoDB row would confer it — which
// is precisely what the pin exists to make impossible. An earlier draft of §1.1 said a scope holding
// nothing pinned has `verdicts: {}`; that was true only of the forbid-only design superseded on
// 2026-08-18, and §1.1 now records it as "the hole". So every scope carries an entry for every pinned
// capability, member or not: 12 entries, always.

const { usage, preflight } = require('./exit');
const {
  ACTION_USE, TYPE, uid,
  capabilityDomain, capGroupNames, sharedEntities, scopeEntity, membershipIndex,
} = require('./policy-entities');

/** The row contract version. The runtime REFUSES a version it does not know (plan §1.1). */
const ROW_VERSION = 1;

const VERDICT = { ALLOW: 'allow', GRANT: 'grant', DENY: 'deny' };

/** The CapGroup that A1 permits unconditionally (semantics.cedar:53-57). */
const BASELINE_GROUP = 'baseline';

/**
 * The engine, loaded once and lazily.
 *
 * LAZY, because `@cedar-policy/cedar-wasm` is a 4.1 MB wasm binary and `archie` has ~20 subcommands
 * that have no business paying for it. Measured at 6 ms here, which is cheap — but a top-level require
 * would put it on the path of every one of them for no reason, and this module is required by exactly
 * one step of one command.
 *
 * THE `/nodejs` SUBPATH, not the package root, and that is deliberate: the root `exports` map offers
 * only an `import` condition (an ESM build), while `./nodejs` offers `require` and is marked
 * `"type": "commonjs"`. Since `archie/` is CommonJS, going through the root would force
 * `await import()` and make every function in this file async for no gain. It is the same wasm — the
 * spike loaded `package/nodejs/cedar_wasm.js` directly and every measurement in
 * archie-docs/archie-cedar-spike/README.md came from it.
 *
 * lib/policy-engine.test.js is what keeps this dependency in the CLI and out of both images, and pins
 * the major: the semantics below were verified against 4.12.0.
 */
let cachedEngine = null;
function engine() {
  if (!cachedEngine) cachedEngine = require('@cedar-policy/cedar-wasm/nodejs');
  return cachedEngine;
}

/**
 * `semantics.cedar` as one whole-text policy set.
 *
 * MEASURED, because the spike warns about the opposite: README §5 records that "`staticPolicies` values
 * are ONE policy each", so a `permit` and its paired `forbid` in a single MAP ENTRY fails to parse on
 * `unexpected token 'forbid'`. That trap is specific to the map form. cedar-wasm's `StaticPolicySet` is
 * `string | Policy[] | Record<PolicyId, Policy>`, and against 4.12.0 the whole 26-statement file passes
 * `checkParsePolicySet`, `validate` (0 errors, 0 warnings) and `isAuthorized` as a single string — so
 * there is nothing to split, and no id-numbering scheme that would shift when a statement is added.
 *
 * What the string form gives up is NAMED policy ids in `response.diagnostics.reason`. The materialiser
 * does not read them: it records decisions, not which statement produced them. A check that wants to
 * report the deciding statement should split with `policySetTextToParts` (which reports 26 for this
 * file) and key the map itself.
 */
const policySetFor = (sources) => ({ staticPolicies: requireSemantics(sources) });

/**
 * One authorization question, with BOTH of the engine's error channels treated as failures.
 *
 * THIS IS THE ONE PLACE A SWALLOWED ERROR WOULD BE CATASTROPHIC, because `deny` is the expected value
 * for 2,535 of prod's 2,556 entries — so anything that quietly becomes a deny produces a row set that
 * looks completely ordinary and revokes capabilities fleet-wide.
 *
 * THERE ARE TWO CHANNELS, AND THE SECOND ONE IS THE TRAP. Measured against 4.12.0:
 *
 *   · `{ type: 'failure' }` — the policy text or the request did not parse. Loud, unmissable.
 *   · `{ type: 'success', response: { decision: 'deny', diagnostics: { errors: [...] } } }` — a
 *     condition ERRORED at evaluation time. A missing `resource.name` gives exactly this: decision
 *     `deny`, `reason: []`, and `entity "Archie::Capability::\"c\"" does not exist` buried in
 *     `diagnostics.errors`. This is the failure archie.cedarschema:29-33 and spike README §5 both warn
 *     about — "the permit never applies and the request denies for a reason that has nothing to do
 *     with policy" — and it is a SUCCESSFUL call with an ordinary-looking answer. Reading only
 *     `response.decision` would materialise it as a real deny and there would be nothing to notice.
 *
 * So a non-empty `diagnostics.errors` refuses too. It is not a permissible state for this policy: every
 * capability in the domain has an entity carrying `name` (policy-entities.js), so any error here means
 * the entity set and the policy have come apart.
 */
function decisionFor({ scope, capability, grants, policies, entities }) {
  const answer = engine().isAuthorized({
    principal: uid(TYPE.scope, scope),
    action: ACTION_USE,
    resource: uid(TYPE.capability, capability),
    context: { grants },
    policies,
    entities,
  });
  if (answer.type !== 'success') {
    throw preflight(`Cedar refused the request for ${scope} / ${capability}`,
      { detail: JSON.stringify(answer.errors) });
  }
  const errors = answer.response.diagnostics?.errors || [];
  if (errors.length > 0) {
    throw preflight(`Cedar evaluated ${scope} / ${capability} with errors — the decision is not trustworthy`,
      { detail: errors.map((e) => `${e.policyId}: ${e.error?.message}`).join('; ') });
  }
  return answer.response.decision;   // 'allow' | 'deny'
}

/**
 * The verdict for one (scope, capability), from TWO probes of the real engine:
 *
 *   grants = []        allow → the capability is unconditional            → `allow`
 *   grants = [cap]     allow → the grant row is what admits it            → `grant`
 *                      deny  → nothing admits it                         → `deny`
 *
 * WHAT THE TWO PROBES ASSUME, stated because it is the materialiser's only real assumption: that a
 * capability's decision depends on the grant set ONLY through whether THAT capability is in it. Every
 * v1 statement satisfies this — A2 tests `context.grants.contains(resource.name)` and the 24 pin
 * statements do not read `context` at all — but the property is not structural. A statement of the
 * shape the plan sketches for the comms gate, `forbid (… resource in CapGroup::"connector.comms")
 * unless { context.grants.contains("connector.comms") }`, would break it: SLACK_SEND_MESSAGE's verdict
 * would then depend on a DIFFERENT capability's grant, which is not expressible in a row keyed by
 * capability. It would need the row contract to change, not just this function.
 *
 * That is VERIFIED, not assumed: policy-row.test.js runs a four-probe cross-check ({}, {cap},
 * everything, everything-but-cap) over both bindings files and every capability, and asserts the extra
 * two probes tell us nothing new. If a future statement breaks the assumption, that test fails and this
 * comment is what says why.
 */
function verdictFor({ scope, capability, policies, entities }) {
  if (decisionFor({ scope, capability, grants: [], policies, entities }) === 'allow') return VERDICT.ALLOW;
  const granted = decisionFor({ scope, capability, grants: [capability], policies, entities });
  return granted === 'allow' ? VERDICT.GRANT : VERDICT.DENY;
}

/**
 * The verdict the §1.1 consumer reaches when the row has NO entry for a capability:
 * `isBaseline(cap) || grants.has(cap)` — i.e. `allow` for a baseline capability, `grant` otherwise.
 *
 * DERIVED FROM `CapGroup::"baseline"`, never hard-coded, so the pruning below follows the policy: the
 * day `demo_diagram_app` joins baseline (semantics.cedar:49-51 says it will, in the change that lands
 * decision 12's successor) nothing here needs editing.
 *
 * THE COUPLING TO NAME, because it is the one thing that could make pruning wrong. `isBaseline` on the
 * consumer side reads `CAPABILITY_DEFAULTS` (permissions/capabilities.mjs:12-21). Pruning is only safe
 * while that map and this CapGroup agree. They do today — verified by reading both: 7 entries,
 * `fs.read`, `memory`, `cron`, `otel`, `connector`, `health`, `hindsight.read`, in both. Plan §8.2
 * removes the risk properly by GENERATING `CAPABILITY_DEFAULTS` from this group; until then a divergence
 * would silently change what an omitted entry means, and the guard for it is the equivalence fixture of
 * plan §4, not this file.
 */
function ambientVerdict(capability, sources) {
  return baselineSet(sources).has(capability) ? VERDICT.ALLOW : VERDICT.GRANT;
}

function baselineSet(sources) {
  const groups = requireData(sources).capGroups;
  if (!capGroupNames(sources).includes(BASELINE_GROUP)) {
    // A1 permits `resource in CapGroup::"baseline"` unconditionally. With no such group nothing is
    // ambient, every baseline capability materialises as `grant`, and the fleet loses seven
    // capabilities on the next deploy. Loud, because Cedar itself would not complain.
    throw preflight(`semantics.json declares no "${BASELINE_GROUP}" capGroup, but A1 permits membership of it`);
  }
  return new Set(groups[BASELINE_GROUP].members);
}

/**
 * The COMPLETE verdict map for one scope — every capability in the domain, sorted.
 *
 * This is what plan §3's check 7 wants: a decision-level view, so "does this policy edit change any
 * decision for any scope?" is answerable. A textual diff cannot answer it — reordering statements,
 * renaming a group, or adding a `forbid` whose group happens to contain everyone are all textual
 * changes with zero decision changes, while a one-character edit to a group id can revoke a capability
 * from 8 scopes.
 *
 * `rowFor` prunes this down to what the row must carry; nothing else about the two differs.
 */
function verdictsFor(scope, sources, ctx = null) {
  const { policies, shared, index, domain } = ctx || contextFor(sources);
  const entities = [...shared, scopeEntity(scope, sources, index)];
  const verdicts = {};
  for (const capability of domain) verdicts[capability] = verdictFor({ scope, capability, policies, entities });
  return verdicts;
}

/**
 * The §1.1 row for one scope. THE deliverable of this module.
 *
 * ```jsonc
 * {
 *   "v": 1,
 *   "account": "361364274007",     // asserted against sts:GetCallerIdentity at boot; mismatch → deny-all
 *   "policyDigest": "sha256:…",    // over the four sources
 *   "scope": "dm-umrsp7355u7",     // must equal AGENT_NAME or the runtime denies all
 *   "verdicts": { "aws-readonly": "deny", … }
 * }
 * ```
 *
 * `verdicts` CARRIES ONLY WHAT DIFFERS FROM THE AMBIENT RULE — and that is not the same as sparse. The
 * entries that survive pruning are exactly the capabilities a statement overrides, which under the v1
 * policy is the 12 pinned ones, for EVERY scope: `allow` where the scope is a member, `deny` where it
 * is not. Both directions are load-bearing (see the header note on the `deny`).
 *
 * Measured over `pins.prod.json`: every scope carries 12 entries; 21 entries are `allow` fleet-wide —
 * one per membership, across 14 distinct scopes — and every other entry is `deny`. (Plan §1.1 quotes
 * many scopes / 2,640 entries / 22 allow; both numbers are stale. Prod is many scopes and
 * `pins.prod.json` was corrected on 2026-08-18 to 21 memberships.)
 *
 * A capability the policy does not override is ABSENT, deliberately: the row then means "no opinion,
 * behave as today", which is what makes plan §4's Phase 0 baseline byte-equivalent to the current
 * decider for an unpinned fleet.
 */
function rowFor(scope, sources, ctx = null) {
  // Asserted BEFORE the up-to-62 engine calls this costs (31 capabilities, two probes each): a row that
  // cannot name its policy and its account is unshippable whatever its verdicts, so there is nothing to
  // compute.
  const account = requireAccount(sources);
  const policyDigest = requireDigest(sources);
  const context = ctx || contextFor(sources);
  const all = verdictsFor(scope, sources, context);
  const verdicts = {};
  for (const capability of context.domain) {
    if (all[capability] !== ambientVerdict(capability, sources)) verdicts[capability] = all[capability];
  }
  return { v: ROW_VERSION, account, policyDigest, scope, verdicts, skills: skillsFor(scope, sources), skillsGoverned: governedSkills(sources) };
}

/**
 * The PINNED skills this scope may hold — membership of `skill.<id>` in pins.<env>.json.
 *
 * NOT A CEDAR EVALUATION, and that is deliberate: Cedar here governs capabilities, and a skill is a
 * different axis (prose the model is given, not a tool it may call). So this is the same membership
 * derivation the verdicts use, expressed directly. It ships in the row because the runtime's skill filter
 * needs it and cannot evaluate policy.
 *
 * ONLY PINNED SKILLS APPEAR. An unpinned skill is not governed at all, so listing every skill an agent has
 * would make the row grow with the marketplace and imply a gate that does not exist. The filter treats
 * "absent from this list" as "allowed" for unpinned skills — see skill-pins.isPinned.
 */
/** EVERY pinned skill in this environment — the filter's `governed` set, so the policy is its only source. */
function governedSkills(sources) {
  return Object.keys((sources.pins || {}).groups || {})
    .filter((g) => g.startsWith('skill.')).map((g) => g.slice('skill.'.length)).sort();
}

function skillsFor(scope, sources) {
  const groups = (sources.pins && sources.pins.groups) || {};
  const out = [];
  for (const g of Object.keys(groups)) {
    if (!g.startsWith('skill.')) continue;
    if ((groups[g] || []).includes(scope)) out.push(g.slice('skill.'.length));
  }
  return out.sort();
}

/**
 * One row per scope, sharing the parsed policy set and the scope-independent entities.
 *
 * WORTH HAVING RATHER THAN A LOOP AT THE CALL SITE, for one measured reason: `isAuthorized` re-parses
 * the 26-statement policy set on every call, and a fleet pass is ~2 calls × 31 capabilities × 213
 * scopes. Measured against 4.12.0 on this hardware: **~8 s for many scopes**, which is acceptable for a
 * deploy step that runs before anything is built.
 *
 * The obvious speedup was measured and REJECTED: `preparsePolicySet` + `statefulIsAuthorized` does the
 * same work in ~4.3 s, but it keeps the parsed policy set in engine-global state keyed by a string id.
 * Halving a one-off 8 s is not worth a global that two concurrent materialisations could collide on.
 */
function rowsFor(scopes, sources) {
  const ctx = contextFor(sources);
  return new Map(scopes.map((scope) => [scope, rowFor(scope, sources, ctx)]));
}

/** The per-sources work every scope shares. Built once; passed through as `ctx`. */
function contextFor(sources) {
  return {
    policies: policySetFor(sources),
    shared: sharedEntities(sources),
    index: membershipIndex(sources),
    domain: capabilityDomain(sources),
  };
}

function requireSemantics(sources) {
  if (typeof sources?.semantics !== 'string' || sources.semantics.trim() === '') {
    throw usage('sources.semantics must be the text of semantics.cedar');
  }
  return sources.semantics;
}

function requireAccount(sources) {
  const account = String(sources?.pins?.account ?? '');
  // Re-checked here, not only in the loader: this value is what the agent compares against
  // sts:GetCallerIdentity at boot, and a row carrying a wrong-shaped account can only ever deny-all.
  if (!/^[0-9]{12}$/.test(account)) throw usage('sources.pins.account must be a 12-digit AWS account id');
  return account;
}

function requireDigest(sources) {
  const digest = sources?.digest;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw usage('sources.digest must be the `sha256:<hex>` policy digest (see policy-sources.digestOf)',
      { detail: 'a row whose digest the runtime cannot match installs a deny-all table (plan §5)' });
  }
  return digest;
}

function requireData(sources) {
  if (!sources?.data?.capGroups) throw usage('sources.data must be the parsed semantics.json');
  return sources.data;
}

module.exports = {
  ROW_VERSION, VERDICT, BASELINE_GROUP,
  policySetFor, decisionFor, verdictFor, ambientVerdict,
  verdictsFor, rowFor, rowsFor, contextFor,
};

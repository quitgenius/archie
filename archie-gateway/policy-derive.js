'use strict';

// Derive a scope's compiled verdict row from the fleet pin MEMBERSHIPS — by set membership, with no
// policy engine (archie-policy-implementation-plan.md §2, §1.1 for the row contract).
//
// WHY THIS EXISTS AS A SECOND PATH AT ALL. `archie deploy` computes rows with the real Cedar engine
// (archie/lib/policy-row.js rowFor). The dispatcher cannot: cedar-wasm must never enter an image
// (archie/lib/policy-engine.test.js asserts it) and `archie/` is not COPYed into the gateway. But the
// dispatcher MINTS scopes at turn time that no deploy has ever seen, and a minted scope with no POLICY
// row falls back to grant-only behaviour — which makes every pin on it silently inert. That is not
// hypothetical: it is exactly what ch-cr89fluhion did with all five sandbox pins attached to it.
//
// SO THIS IS DELIBERATELY NOT A REIMPLEMENTATION OF CEDAR. It implements one narrow claim — that for a
// PINNED capability, membership of its group IS the verdict — which holds because every pin in
// semantics.cedar is a permit/forbid pair conditioned solely on `principal in ScopeGroup::"pin.X"`.
// The claim is what makes `rowFor` a total function, and it is the only reason a scope the materialiser
// has never seen can be answered correctly.
//
// AND IT IS NOT TRUSTED ON ITS OWN. `archie deploy` runs this function against Cedar's answer for every
// scope it computes and refuses to publish on any disagreement. So if a pin ever gains a `when` clause —
// the comms approval gate in part 2 does exactly that — the deploy fails loudly instead of this quietly
// returning the wrong verdicts for the whole fleet. THAT assertion, not this comment, is what keeps the
// two paths honest; do not delete it to make a deploy pass.
//
// This module is REQUIRED BY BOTH SIDES on purpose. One implementation, verified in one place.

const ALLOW = 'allow';
const DENY = 'deny';

/**
 * The row for `scope`, given the fleet artifact.
 *
 * @param {string} scope        the scope id (dm-<user> / ch-<channel>) — must equal the runtime's AGENT_NAME
 * @param {object} artifact     { v, account, policyDigest, groups: { 'pin.<cap>': [scopeId, …] } }
 * @returns {{v: number, account: string, policyDigest: string, scope: string, verdicts: object}}
 *
 * COMPLETE OVER THE PINNED SET, never sparse. A non-member gets an explicit `deny`, because the
 * consumer treats an ABSENT entry as "not overridden" and falls through to `grants.has(capability)`
 * (permissions/capabilities.mjs resolve) — so omitting the deny would let a DynamoDB grant row confer a
 * pinned capability, which is the one thing the pin exists to prevent. Measured: 12 entries per scope,
 * ~260 bytes, against a 400KB item limit. There is nothing to optimise and a real hole to avoid.
 */
function rowFromMemberships(scope, artifact) {
  if (!scope) throw new Error('rowFromMemberships: scope required');
  const groups = artifact?.groups;
  if (!groups || typeof groups !== 'object') throw new Error('rowFromMemberships: artifact.groups required');
  const verdicts = {};
  for (const [group, members] of Object.entries(groups)) {
    // `pin.<capability>` is the group naming contract (pins.<env>.json). A group not in that shape is a
    // data error, not something to skip: skipping would drop a capability from the row and turn a typo
    // into "not overridden", i.e. grantable.
    if (!group.startsWith('pin.')) throw new Error(`rowFromMemberships: unexpected group name ${group}`);
    const capability = group.slice('pin.'.length);
    verdicts[capability] = (Array.isArray(members) ? members : []).includes(scope) ? ALLOW : DENY;
  }
  return {
    v: artifact.v,
    account: artifact.account,
    policyDigest: artifact.policyDigest,
    scope,
    verdicts,
  };
}

/**
 * Is this scope's stored row current with respect to the fleet artifact?
 *
 * The staleness backstop. The deploy writes rows for the scopes it can enumerate; a MINTED scope is not
 * one of them, so nothing would ever update its row after a policy edit — correct at mint and silently
 * frozen thereafter, the same failure shape as the stale image. Comparing digests here lets the
 * dispatcher self-heal any scope on its next turn, minted or not, with no enumeration to get wrong.
 *
 * Treats a missing row or a missing digest as stale, so the absent case flows through the same write.
 */
function rowIsStale(row, artifact) {
  if (!row || typeof row !== 'object') return true;
  if (row.v !== artifact?.v) return true;
  if (!row.policyDigest || row.policyDigest !== artifact?.policyDigest) return true;
  return false;
}

/**
 * The capabilities the POLICY owns — i.e. the ones a grant row cannot affect either way.
 *
 * WHY EVERY GRANT WRITER NEEDS THIS (R1). For a pinned capability the policy is the whole authority:
 * membership allows, non-membership denies, and the `forbid` beats the grant-row permit. So a grant row
 * for one confers NOTHING. Left unchecked, the Slack Tools tab still offers the capability, Approve still
 * succeeds, the row is still written, the derived-role hook still adds real sts:AssumeRole IAM — and the
 * PEP still denies. Silent, and the worst failure in the set: the UI asserts access the agent does not
 * have, while IAM exposure is real.
 *
 * So the writers refuse instead. Derived from the artifact's group names (`pin.<capability>`) rather than
 * from a second list, because a hand-maintained list of pinned capabilities is exactly the kind of mirror
 * that drifts — and drifting OPEN here means a capability silently becomes grantable again.
 *
 * A null/absent artifact returns an EMPTY set: before the first policy publish nothing is policy-managed,
 * so every writer behaves as it did before. Fail-open is correct in that direction — the policy is not in
 * force yet, so refusing a grant would block work for no reason.
 */
function pinnedCapabilities(artifact) {
  const groups = artifact?.groups;
  if (!groups || typeof groups !== 'object') return new Set();
  const out = new Set();
  for (const g of Object.keys(groups)) if (g.startsWith('pin.')) out.add(g.slice('pin.'.length));
  return out;
}

module.exports = { rowFromMemberships, rowIsStale, pinnedCapabilities };

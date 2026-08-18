'use strict';

// The deploy side of the policy layer: build the fleet artifact, PROVE the dispatcher's cheap
// derivation agrees with Cedar, and produce the per-scope rows to write
// (archie-policy-implementation-plan.md §2, §1.1).
//
// Cedar runs HERE and only here. The artifact this builds is what lets the dispatcher answer for a scope
// no deploy has ever seen — see archie-gateway/policy-derive.js for why that second path has to exist.

const { rowFor, ROW_VERSION } = require('./policy-row');
const { realKeys } = require('./policy-sources');
// The SAME module the dispatcher ships. Required, not reimplemented: an equivalence check against a
// second copy of the logic would prove nothing about the copy that actually runs.
const { rowFromMemberships } = require('../../archie-gateway/policy-derive');

/**
 * The fleet artifact: pin memberships plus the digest of the sources they came from.
 *
 * MEMBERSHIPS, not verdicts — the dispatcher needs to answer for scope ids that do not exist yet, and
 * only membership generalises. `$`-prefixed annotation keys are dropped (they are documentation, and
 * `realKeys` is the one place that rule lives).
 */
function artifactFor(sources) {
  const groups = {};
  for (const g of realKeys(sources.pins.groups)) {
    const members = sources.pins.groups[g];
    if (!Array.isArray(members)) throw new Error(`policy artifact: group ${g} is not an array`);
    // Sorted so the artifact is byte-stable for a given pins file: an unstable serialisation would make
    // the item churn on every deploy and make a real diff impossible to see.
    groups[g] = [...members].sort();
  }
  return {
    v: ROW_VERSION,
    account: sources.pins.account,
    policyDigest: sources.digest,
    groups,
  };
}

/**
 * Assert the dispatcher's membership-only derivation reproduces Cedar's verdicts, for every scope given.
 *
 * THIS IS THE LOAD-BEARING CHECK OF THE WHOLE TWO-PATH DESIGN, and the reason it is safe to let the
 * dispatcher compute verdicts without a policy engine. It holds today because every pin is a
 * permit/forbid pair conditioned only on group membership — but that is a property of the current
 * policy, not a law. The comms approval gate in part 2 adds `unless { context.grants.contains(…) }`,
 * which makes membership insufficient; when that lands this must fail, loudly, on the deploy that
 * introduces it — rather than the dispatcher silently handing every minted scope the wrong answer.
 *
 * So: if this ever fails, the fix is NOT to relax it. It means the policy has outgrown what the
 * dispatcher can derive, and the delivery design needs revisiting (§2).
 *
 * @returns {{checked: number}} on success
 * @throws with the first disagreement spelled out — scope, capability, both answers
 */
function assertDerivationMatchesCedar(scopes, sources, artifact = artifactFor(sources)) {
  let checked = 0;
  for (const scope of scopes) {
    const truth = rowFor(scope, sources);
    const cheap = rowFromMemberships(scope, artifact);
    // Compare the VERDICT MAPS, not the whole row: the envelope fields (account, digest) come from the
    // artifact on one side and the sources on the other, and are asserted separately below.
    const caps = new Set([...Object.keys(truth.verdicts), ...Object.keys(cheap.verdicts)]);
    for (const cap of caps) {
      if (truth.verdicts[cap] !== cheap.verdicts[cap]) {
        throw new Error(
          `policy derivation DISAGREES with Cedar for ${scope} / ${cap}: `
          + `cedar=${truth.verdicts[cap] ?? '(absent)'} membership=${cheap.verdicts[cap] ?? '(absent)'}. `
          + 'The dispatcher derives minted scopes\' verdicts by membership alone, so this must not ship: '
          + 'a pin now depends on something membership cannot express (a `when`/`unless` clause?). '
          + 'See archie-gateway/policy-derive.js and plan §2 — do not weaken this check to pass.',
        );
      }
    }
    if (cheap.policyDigest !== truth.policyDigest) {
      throw new Error(`policy digest mismatch for ${scope}: artifact=${cheap.policyDigest} sources=${truth.policyDigest}`);
    }
    if (cheap.account !== truth.account) {
      throw new Error(`policy account mismatch for ${scope}: artifact=${cheap.account} sources=${truth.account}`);
    }
    checked++;
  }
  return { checked };
}

/**
 * Everything the deploy needs to write, for a known set of scopes.
 *
 * The rows come from CEDAR (rowFor), not from the derivation — the deploy has the engine, so it should
 * use it; the derivation is the dispatcher's fallback, and `assertDerivationMatchesCedar` is what ties
 * the two together. Callers must run that assertion; `plan` does it so they cannot forget.
 */
function plan(scopes, sources) {
  const artifact = artifactFor(sources);
  const { checked } = assertDerivationMatchesCedar(scopes, sources, artifact);
  return {
    artifact,
    rows: scopes.map((scope) => rowFor(scope, sources)),
    checked,
  };
}

module.exports = { artifactFor, assertDerivationMatchesCedar, plan };

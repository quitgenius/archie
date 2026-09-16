// Deriving policy pin membership — OPEN-SOURCE BUILD.
//
// THE IDEA, which is worth keeping even though the implementation is not shipped.
//
// A policy pin says a capability's authority comes from ScopeGroup membership alone. That leaves one
// question: who should be IN each group? Hand-maintaining that list is how authorization drifts — a
// skill gets installed, the holder is never added, and the policy quietly denies something that
// worked yesterday. So membership is DERIVED from what the fleet actually has, and the derivation is
// re-runnable and diffable against what is deployed.
//
// WHY THIS FILE SHIPS AS A STUB, and it is the more useful half of the lesson.
//
// The real implementation reads a configuration repository that is not part of this build, and it
// writes `pins.<env>.json` files that are also not part of this build — so here it would have no
// input and no output. But it was also removed on purpose. Its comments were a forensic account of
// getting this exact derivation WRONG in a live fleet: which of several authority surfaces were read,
// which were missed, and precisely which scopes would have lost access had the result been published.
// That is a map of where an authorization model was weak, and it is not ours to hand out.
//
// The transferable part is short enough to state plainly:
//
//   1. AUTHORITY USUALLY HAS MORE THAN ONE SURFACE. A capability may be conferred by an install
//      record, by a declaration in code, by resolved plugin configuration, or by an IAM statement in
//      another repository entirely. Read one of them and you will produce a confident, wrong answer.
//   2. "NO HOLDERS FOUND" IS THE DANGEROUS RESULT. An empty group reads as "nobody needs this", and
//      publishing it revokes access from everybody who did. Treat an empty derivation as a question,
//      never as a finding.
//   3. A SURFACE YOU CANNOT READ MUST SAY SO. Report coverage alongside the result, so a partial
//      read is visibly partial instead of contributing silently.
//   4. DIFF BEFORE YOU PUBLISH, against the live fleet rather than against the last derivation.
//
// To implement: replace this module, keeping the export surface below — `archie policy seed` calls
// into it and nothing else does. `archie policy publish` is unaffected and deploys the artifact as
// normal.

const NOT_AVAILABLE = 'not-available-in-open-source-build';

/** Every entry point refuses the same way, with the reason and what to do about it. */
function unavailable(fn) {
  const e = new Error(
    `${fn}: ${NOT_AVAILABLE}. Pin membership is derived from a deployment's own configuration, `
    + 'which is not shipped here. Implement archie/lib/policy-seed.js against your own sources — '
    + 'see the note at the top of this file for the four rules worth keeping.',
  );
  e.code = NOT_AVAILABLE;
  throw e;
}

/** `$`-prefixed keys are ANNOTATION, never data — every consumer filters on the PREFIX, not the type. */
const realKeys = (obj) => Object.keys(obj || {}).filter((k) => !k.startsWith('$')).sort();

/** Capability signals conferred by resolved plugin CONFIG rather than by a skill or a token. */
const PLUGIN_CAP_SIGNALS = {};

const scopeMap = () => unavailable('scopeMap');
const deriveSkillGroups = () => unavailable('deriveSkillGroups');
const deriveIamGroups = () => unavailable('deriveIamGroups');
const capsFromSkillIds = () => unavailable('capsFromSkillIds');
const skillsByAgent = () => unavailable('skillsByAgent');
const applySkillGroups = () => unavailable('applySkillGroups');

/** Pure set operations over group maps — no deployment knowledge, so they are real. */
const mergeGroups = (a = {}, b = {}) => {
  const out = {};
  for (const k of new Set([...realKeys(a), ...realKeys(b)])) {
    out[k] = [...new Set([...(a[k] || []), ...(b[k] || [])])].sort();
  }
  return out;
};

const mergeGroupsForAgent = (base = {}, add = {}, agentScopeId) => {
  if (!agentScopeId) return mergeGroups(base, add);
  const out = { ...base };
  for (const k of realKeys(add)) {
    if ((add[k] || []).includes(agentScopeId)) {
      out[k] = [...new Set([...(out[k] || []), agentScopeId])].sort();
    }
  }
  return out;
};

/** Added/removed per group. The thing to read BEFORE publishing, never after. */
const diffGroups = (from = {}, to = {}) => {
  const diff = {};
  for (const k of new Set([...realKeys(from), ...realKeys(to)])) {
    const a = new Set(from[k] || []);
    const b = new Set(to[k] || []);
    const added = [...b].filter((x) => !a.has(x)).sort();
    const removed = [...a].filter((x) => !b.has(x)).sort();
    if (added.length || removed.length) diff[k] = { added, removed };
  }
  return diff;
};

module.exports = {
  scopeMap, deriveSkillGroups, deriveIamGroups, diffGroups, mergeGroups, mergeGroupsForAgent,
  applySkillGroups, realKeys, capsFromSkillIds, skillsByAgent, PLUGIN_CAP_SIGNALS,
};

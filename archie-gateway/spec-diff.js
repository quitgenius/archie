'use strict';

// Attribution for a runtime generation roll: WHICH spec field changed.
//
// A runtime's name encodes a hash of its whole immutable CreateAgentRuntime spec, so a change to any
// of those fields mints a new generation and costs that agent a ~30s provision — and one dispatcher
// env change rolls the WHOLE fleet on their next turns. The name hash is one-way, so without a diff a
// fleet-wide latency event has nothing in the logs explaining itself.
//
// Extracted from index.js so it can be tested directly: index.js starts a server on require.

/**
 * Diff a spec READ BACK FROM AWS against one we built. The two sides describe the same runtime in
 * different vocabularies, so the comparison has to be made pairwise rather than by cleaning each side
 * in isolation:
 *
 *  - AWS reports an access point ARN; our spec never carries one. Dropped — it would be a phantom
 *    change on every single roll.
 *  - AWS does not report the EFS ROOT directly, so `observedSpecOf` resolves it from the access point's
 *    RootDirectory.Path. When that resolution WORKS the paths compare directly, which is the point:
 *    pointing the fleet at a different EFS root is how the side-by-side migration cuts over, and it
 *    used to be reported as `unknown`. When it FAILS (the AP was already deleted) the root is dropped
 *    from BOTH sides — absent is unknown, not "changed to undefined", and only a pairwise view can
 *    tell those apart.
 */
function diffObserved(observedSpec, builtSpec) {
  if (!observedSpec) return ['initial'];
  const { efsAccessPoint, ...before } = observedSpec;
  const after = { ...(builtSpec || {}) };
  if (before.efsRoot === undefined) { delete before.efsRoot; delete after.efsRoot; }
  return specDiff(before, after);
}

/**
 * Which spec fields differ — the human-readable reason a generation rolled. Nested `envs` are reported
 * per key (`env.DISPATCHER_BASE_URL`) rather than as one opaque "envs changed", because the whole point
 * is to name the thing someone edited.
 */
function specDiff(before, after) {
  if (!before) return ['initial'];
  const changed = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after || {})])) {
    if (k === 'envs') {
      const a = before.envs || {}; const b = (after || {}).envs || {};
      for (const ek of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (a[ek] !== b[ek]) changed.push(`env.${ek}`);
      }
    } else if (JSON.stringify(before[k]) !== JSON.stringify((after || {})[k])) {
      changed.push(k);
    }
  }
  // Callers only diff when the NAME already changed. So identical specs mean the name moved for a
  // reason no field can show — the fingerprint ALGORITHM itself changed (as it did when the hash
  // widened from image-only to spec-wide). Naming that beats 'unknown', which reads like a failure to
  // look and sent me hunting a data bug that did not exist.
  return changed.length ? changed.sort() : ['fingerprint-algorithm'];
}

module.exports = { diffObserved, specDiff };

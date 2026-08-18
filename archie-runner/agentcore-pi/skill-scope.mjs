// Per-agent skill scoping + fingerprint (sandra-repo-removal-plan Phase 3).
//
// Skills are now scoped to the agent's marketplace INSTALLS (not fleet-wide): the runtime
// materializes only AGENT#<id>/MARKETPLACE.installs, so installing/uninstalling a skill takes
// effect. The fingerprint is Option A restricted to skills — it changes iff an install is
// added/removed OR an installed skill's content (its manifest version) changes. The adapter
// reads it per turn to decide reuse-vs-refresh; unchanged → warm-session fast path.
//
// Pure functions (no DDB/fs) so they unit-test in isolation; the adapter injects the reads.

import { createHash } from 'node:crypto';

// 16-hex content hash — same scheme the hydrator uses for skill versions (extract.mjs hash16).
export const hash16 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);

// Skills every agent loads REGARDLESS of its marketplace installs — fleet-wide + default (user
// decision 2026-08-01). Kept alongside the install logic so the fingerprint + scoping treat them
// identically to installs (materialized to /tmp, pruned like the rest if removed from the list).
// Overridable via env AGENTCORE_ALWAYS_ON_SKILLS (csv; empty string = none). A listed skill still
// has to exist in the fleet manifest to load — a missing DEF is simply skipped, never an error.
export function alwaysOnSkills() {
  const raw = process.env.AGENTCORE_ALWAYS_ON_SKILLS;
  if (raw === '') return [];
  return (raw || 'otel-debug').split(',').map((s) => s.trim()).filter(Boolean);
}

// Union the always-on skills (that exist in the manifest) into an installs map, as pseudo-installs.
// Feeding the result to skillFingerprint/scopeManifest makes every agent materialize them without
// any per-agent MARKETPLACE write — and new agents get them automatically.
export function withAlwaysOn(installs, manifest) {
  const skills = (manifest && manifest.skills) || {};
  const out = { ...(installs || {}) };
  for (const n of alwaysOnSkills()) if (skills[n] != null && out[n] == null) out[n] = { alwaysOn: true };
  return out;
}

// Fingerprint the agent's EFFECTIVE skill set: installed names (sorted, order-independent) each
// tagged with its manifest content-version. Two agents with the same installs+versions share a
// fingerprint; any install add/remove or content bump flips it.
export function skillFingerprint(installs, manifest) {
  const names = Object.keys(installs || {}).sort();
  const skills = (manifest && manifest.skills) || {};
  return { fp: hash16(JSON.stringify(names.map((n) => skills[n] ?? null))), names };
}

// Scope a fleet manifest down to just the installed skills. Feeding this to skill-sync makes it
// materialize exactly the installed set and PRUNE anything else — so an uninstall drops the skill
// off /tmp on the next refresh. `catalogVersion` is carried through (unused by the scoped diff).
export function scopeManifest(manifest, names) {
  const skills = (manifest && manifest.skills) || {};
  const out = { skills: {}, catalogVersion: manifest && manifest.catalogVersion };
  for (const n of names) if (skills[n] != null) out.skills[n] = skills[n];
  return out;
}

/**
 * Remove PINNED skills this scope may not hold (plan §7.2 / D3, the LLM-facing skill filter).
 *
 * WHY THIS EXISTS AT ALL. Tools have `applyToolFilter`; skills had no equivalent, so a denied skill's PROSE
 * stayed in the prompt and the model kept being instructed to do something it could not do. The fix is to
 * remove it from what the model is given, not to let it try and fail.
 *
 * @param installs      the agent's installs, already unioned with the always-on set
 * @param allowedSkills the pinned skills this scope may hold — the POLICY row's `skills`. NULL means "no
 *                      policy row", which must be a NO-OP: every scope is in that state until the first
 *                      policy deploy reaches it, and filtering on absent data would strip 146 holders on
 *                      their next turn, which is precisely the unrecoverable strip D3 orders against.
 * @param governed      EVERY pinned skill id, from the row. Taken from the policy rather than imported
 *                      from skill-pins.mjs for two reasons: the in-image layout flattens agentcore-pi/ to
 *                      /app/ while config-resolver/ stays nested, so `../config-resolver/…` does not
 *                      resolve there (caught by image-layout-test.mjs) — and more importantly the POLICY
 *                      should be the single source of what it governs, not a second module the row could
 *                      disagree with.
 * @param manifest      the fleet skill manifest, for the always-on set
 * @param onDeny        called once per removed skill — the OTEL leg. A silent strip is indistinguishable
 *                      from an agent that never had the skill, which makes "why did it stop doing X"
 *                      unanswerable.
 */
export function filterPinnedSkills(installs, allowedSkills, governed, manifest, onDeny = () => {}) {
  if (!Array.isArray(allowedSkills) || !Array.isArray(governed)) return installs;
  const allowed = new Set(allowedSkills);
  const isGoverned = new Set(governed);
  // ALWAYS-ON SKILLS ARE UNFILTERABLE, and this is a hard condition rather than a nicety: otel-debug is how
  // an operator sees the fleet at all, so one bad allow-list must not be able to blind it. They are also not
  // per-agent installs — they are fleet-wide pseudo-installs — so an allow-list has no business deciding
  // them.
  const alwaysOn = new Set(alwaysOnSkills());
  const out = {};
  for (const [id, v] of Object.entries(installs || {})) {
    if (alwaysOn.has(id) || !isGoverned.has(id) || allowed.has(id)) { out[id] = v; continue; }
    // UNPINNED SKILLS PASS UNTOUCHED. This filter governs pinned skills only; becoming a second install
    // gate for the whole marketplace would deny every skill the policy simply says nothing about.
    try { onDeny(id); } catch { /* telemetry never drops a skill decision */ }
  }
  return out;
}

'use strict';

// Render the baseline capability set from the Cedar policy into the module the runtime imports.
//
// WHAT THIS REPLACES. `CAPABILITY_DEFAULTS` used to be a hand-written map that mirrored
// `capGroups.baseline` in semantics.json, with check 8 refusing any deploy where the two disagreed. That
// made drift impossible but left the fact written twice, and semantics.json had said from the start what
// the intent was: "Cedar is intended to become the single declaration of this set, with the JS map derived
// from it." This is that derivation.
//
// NOT COMMITTED — it is gitignored (repo .gitignore). It is derived, so a copy in git is review noise and
// a merge conflict waiting to happen. It IS still hashed into both image digests, because it ships and the
// tag must reflect what is in the image; being gitignored keeps it out of `git status --porcelain -uall`,
// so `--pure` and the dirty-tree warning are unaffected.
//
// THE COST OF NOT COMMITTING IT, stated because it is the part that bites: a fresh clone does not have the
// file, and `permissions/capabilities.mjs` imports it — so tests and builds fail with ERR_MODULE_NOT_FOUND
// until something generates it. `ensure()` below exists for exactly that, and is called from the offline
// gate and from both image builds. Anything that imports the runtime's permission model without going
// through one of those needs to call it too.
//
// AND WHY THIS IS ONLY SAFE AFTER R8. Generating from a source that is not a declared image input means an
// edit to the source changes no tag — the build is skipped as "already in ECR" and the stale generated file
// ships under a tag claiming to contain the new policy. `docker/policy/` is now declared for both images
// (digest.js POLICY_INPUTS), so a policy edit moves the tag and the regenerated file goes with it.

const fs = require('node:fs');
const path = require('node:path');
const { loadPolicySources, realKeys } = require('./policy-sources');

// docker/ — the same root digest.js uses, so the path vocabulary matches everything else.
const DOCKER = path.resolve(__dirname, '..', '..');
const GENERATED = path.join('archie-runner', 'agentcore-pi', 'permissions', 'baseline.generated.mjs');
const GENERATED_ABS = path.join(DOCKER, GENERATED);

/**
 * The baseline set and the immutable subset, read from the policy.
 *
 * ORDER IS THE POLICY'S ORDER, not sorted. The generated file is reviewed by humans as a diff, and
 * re-sorting would make an insertion in the middle of the policy's list look like a wholesale rewrite.
 */
function baselineFrom(sources) {
  const group = (sources.data.capGroups || {}).baseline;
  if (!group || !Array.isArray(group.members)) {
    throw new Error('policy codegen: semantics.json capGroups.baseline.members is missing or not an array');
  }
  // A capability is IMMUTABLE iff the $immutable prose names it AND it is a member — the same rule
  // policy-checks.immutableCaps applies, so the generated file and check 8 cannot disagree about which
  // ones they are.
  const prose = (group.$immutable || []).join(' ');
  return { members: [...group.members], immutable: group.members.filter((c) => prose.includes(c)) };
}

/** The exact text of the generated module. Pure, so the check can compare without touching disk. */
function render(sources) {
  const { members, immutable } = baselineFrom(sources);
  const digest = sources.digest;
  const line = (c) => `  ${/^[a-z][a-z0-9]*$/i.test(c) ? c : `'${c}'`}: 'allow',${immutable.includes(c) ? ' // UNREMOVABLE' : ''}`;
  return `// @generated from docker/policy/semantics.json — DO NOT EDIT BY HAND.
//
// GITIGNORED — regenerated, never committed. \`npm run check\` and both image builds regenerate it, so it is
// always current; run \`archie policy codegen\` if you need it by hand. Both image digests include
// docker/policy/ AND this file, so a policy edit rolls the images that carry it.
//
// THE CEDAR POLICY IS THE SINGLE DECLARATION of what is "generally available": capGroups.baseline in
// semantics.json. This file exists because the runtime cannot evaluate Cedar — cedar-wasm never enters an
// image (archie/lib/policy-engine.test.js) — and because the set must be available even for a scope with
// no compiled POLICY row, which is every scope before its first policy deploy. Sourcing it from the row
// instead would make an absent row mean "deny everything", including fs.read, turning a normal rollout
// state into a dead agent.
//
// ${immutable.length} of these are UNREMOVABLE, not merely baseline (2026-08-18). That property cannot be a Cedar statement, because \`forbid\` beats
// every \`permit\`: a forbid naming one would override even an unconditional permit while leaving the policy
// valid. Deploy check 8 is what enforces it — it rejects any forbid that reaches them, by name or through a
// CapGroup they belong to.
//
// Policy digest at generation: ${digest}

/** The "generally available" capabilities, verbatim from capGroups.baseline. */
export const BASELINE = Object.freeze({
${members.map(line).join('\n')}
});

/** The subset that no policy may take away. Enforced at deploy, not expressible in Cedar. */
export const IMMUTABLE = Object.freeze([${immutable.map((c) => `'${c}'`).join(', ')}]);

/** The digest of the policy these were generated from, for the staleness check and for logs. */
export const POLICY_DIGEST = '${digest}';
`;
}

/** Write the generated module. Returns {path, changed}. */
function write(sources, { file = GENERATED_ABS } = {}) {
  const next = render(sources);
  const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (prev === next) return { path: file, changed: false };
  fs.writeFileSync(file, next);
  return { path: file, changed: true };
}

/**
 * Make the generated file exist and match the policy. Idempotent; returns {path, changed}.
 *
 * THE ENTRY POINT EVERYTHING ELSE USES. Since the file is not committed, "is it stale?" and "is it there?"
 * are the same question with the same answer — regenerate. Callers do not need to distinguish, and one that
 * tried would be choosing between two ways of being broken.
 */
function ensure({ env = 'sandbox', dir, file = GENERATED_ABS } = {}) {
  return write(loadPolicySources({ env, ...(dir ? { dir } : {}) }), { file });
}

/**
 * Throw unless the file on disk matches what the policy implies.
 *
 * STILL WORTH HAVING even though the file is generated rather than committed, for one case: a build or a
 * deploy that generated it EARLIER in the same run, then had the policy change under it — or a stale file
 * left by a previous run against different sources. It is the assertion the deploy makes after codegen, so
 * "the baseline the fleet enforces" and "the policy this release publishes" cannot differ.
 */
function assertGenerated({ env = 'sandbox', dir, file = GENERATED_ABS } = {}) {
  // The BASELINE half of the policy is in the shared semantics, not the per-environment pins, so any env
  // renders the same members — but `digest` covers pins too, so the digest LINE differs per env. Compare
  // everything except that line, and assert the members separately, or this would fail whenever the check
  // ran against a different env than the last generation.
  const sources = loadPolicySources({ env, ...(dir ? { dir } : {}) });
  const expected = render(sources);
  const actual = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (actual === null) {
    throw new Error(`${GENERATED} is missing — it is generated (and gitignored), so run `
      + '`archie policy codegen`. `npm run check` and both image builds do this for you.');
  }
  const strip = (t) => t.split('\n').filter((l) => !l.startsWith('// Policy digest at generation:') && !l.startsWith('export const POLICY_DIGEST')).join('\n');
  if (strip(actual) !== strip(expected)) {
    throw new Error(`${GENERATED} is STALE — it does not match docker/policy/semantics.json. `
      + 'Run `archie policy codegen` and commit the result. Until then the runtime\'s baseline set '
      + 'disagrees with the policy this release would publish.');
  }
  return { path: file, env };
}

module.exports = {
  render, write, ensure, assertGenerated, baselineFrom, GENERATED, GENERATED_ABS, realKeys,
};

'use strict';

// Render the baseline capability set from the Cedar policy into the module the runtime imports.
//
// WHAT THIS REPLACES. `CAPABILITY_DEFAULTS` used to be a hand-written map that mirrored
// `capGroups.baseline` in semantics.json, with check 8 refusing any deploy where the two disagreed. That
// made drift impossible but left the fact written twice, and semantics.json had said from the start what
// the intent was: "Cedar is intended to become the single declaration of this set, with the JS map derived
// from it." This is that derivation.
//
// WHY A COMMITTED GENERATED FILE, rather than generating during the docker build. The generated module
// ships inside BOTH images (permissions/ is COPYed to each), and generating at build time would mean the
// content of an image depended on a step no test could observe. Committed, it is an ordinary declared input:
// it is linted, it is hashed into both tags, and `assertGenerated` below fails the offline gate the moment
// it stops matching the policy. So the file in git is always the file in the image.
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
// Regenerate with \`archie policy codegen\`. \`npm run check\` fails if this file stops matching the policy,
// and both image digests include docker/policy/, so a policy edit rolls the images that carry this.
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
 * Throw unless the committed file matches what the policy implies.
 *
 * THIS IS THE WHOLE SAFETY ARGUMENT for committing a generated file, so it runs in the offline gate rather
 * than only at deploy: the failure it prevents is someone editing semantics.json, not regenerating, and
 * shipping a baseline set that disagrees with the policy the same release publishes.
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
    throw new Error(`${GENERATED} is missing — run \`archie policy codegen\``);
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
  render, write, assertGenerated, baselineFrom, GENERATED, GENERATED_ABS, realKeys,
};

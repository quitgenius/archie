// @generated from docker/policy/semantics.json — DO NOT EDIT BY HAND.
//
// Regenerate with `archie policy codegen`. `npm run check` fails if this file stops matching the policy,
// and both image digests include docker/policy/, so a policy edit rolls the images that carry this.
//
// THE CEDAR POLICY IS THE SINGLE DECLARATION of what is "generally available": capGroups.baseline in
// semantics.json. This file exists because the runtime cannot evaluate Cedar — cedar-wasm never enters an
// image (archie/lib/policy-engine.test.js) — and because the set must be available even for a scope with
// no compiled POLICY row, which is every scope before its first policy deploy. Sourcing it from the row
// instead would make an absent row mean "deny everything", including fs.read, turning a normal rollout
// state into a dead agent.
//
// 2 of these are UNREMOVABLE, not merely baseline (2026-08-18). That property cannot be a Cedar statement, because `forbid` beats
// every `permit`: a forbid naming one would override even an unconditional permit while leaving the policy
// valid. Deploy check 8 is what enforces it — it rejects any forbid that reaches them, by name or through a
// CapGroup they belong to.
//
// Policy digest at generation: sha256:24bb87f92839088052b622bbdcb321635fbe5888277806a644dfa92ad0ea626f

/** The "generally available" capabilities, verbatim from capGroups.baseline. */
export const BASELINE = Object.freeze({
  'fs.read': 'allow',
  memory: 'allow',
  cron: 'allow',
  otel: 'allow', // UNREMOVABLE
  connector: 'allow',
  health: 'allow',
  'hindsight.read': 'allow', // UNREMOVABLE
});

/** The subset that no policy may take away. Enforced at deploy, not expressible in Cedar. */
export const IMMUTABLE = Object.freeze(['otel', 'hindsight.read']);

/** The digest of the policy these were generated from, for the staleness check and for logs. */
export const POLICY_DIGEST = 'sha256:24bb87f92839088052b622bbdcb321635fbe5888277806a644dfa92ad0ea626f';

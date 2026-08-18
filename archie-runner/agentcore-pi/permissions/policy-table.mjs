// The COMPILED Cedar verdict row, as the runtime sees it (archie-policy-implementation-plan.md §1.1).
//
// Cedar is a BUILD-TIME authority. `archie deploy` evaluates the policy sources and writes one row per
// scope to AGENT#<scope>/POLICY (schema.mjs agentPolicyKey); this module validates that row and turns it
// into a lookup. Nothing here evaluates policy — `decide()` stays a couple of map reads, which is the
// whole point of materialising (a wasm PDP in the hot path would cost a load on every cold boot).
//
// THE THREE VALUES, and the third is the one that matters:
//   allow  — ambient for this scope. No grant consulted. This is what a POLICY PIN means.
//   grant  — allowed iff the live grant row carries it THIS TURN. Today's behaviour.
//   deny   — nothing can allow it. A grant row is inert.
// A two-valued form would collapse "pinned member" into `allow`-if-granted, silently converting every
// pin back into a grant — which is the one thing the pin layer exists to prevent.
//
// WHY `deny` IS CARRIED EXPLICITLY, rather than left absent as a space saving: an absent entry falls
// through to `grants.has()` (see makeDecider), so omitting the deny for a NON-member of a pinned group
// would let a DynamoDB grant row confer the capability. That is precisely the hole the pin closes. So
// the row is COMPLETE over the pinned set, not a sparse diff — 12 entries for every scope in the fleet,
// of which the overwhelming majority are `deny`. Measured over prod's many scopes: 2,556 entries, 21
// `allow`. It costs ~260 bytes a row against a 5,000-char ceiling, so there is nothing to optimise.

/** The contract version this runtime understands. A row stamped anything else is refused. */
export const CONTRACT_VERSION = 1;

const VALID_VERDICTS = new Set(['allow', 'grant', 'deny']);

/**
 * A table that denies EVERYTHING, installed whenever a row is present but unusable.
 *
 * Fail closed, never fall through. The tempting alternative — drop back to CAPABILITY_DEFAULTS on a
 * malformed row — means a corrupted or truncated policy silently reverts the scope to a MORE PERMISSIVE
 * state, which is the single behaviour this layer exists to make impossible. A deny-all agent is
 * obviously broken and gets fixed in minutes; a quietly re-widened one is not noticed at all.
 */
const denyAllTable = (why) => ({
  verdictFor: () => 'deny',
  digest: null,
  denyAll: true,
  why,
});

/**
 * Validate a raw POLICY item into a verdict table.
 *
 * @param {object|null|undefined} row      the parsed item body (schema.readData of the POLICY item)
 * @param {object} opts
 * @param {string} opts.scope              this runtime's own scope id (AGENT_NAME) — the row must match
 * @param {string|null} [opts.expectedAccount]  asserted against row.account when supplied; see below
 * @param {(msg: string, detail: object) => void} [opts.onProblem]  called for every refusal, once
 * @returns {{verdictFor: (cap: string) => ('allow'|'grant'|'deny'|undefined), digest: string|null,
 *            denyAll: boolean, why?: string}}
 *          ALWAYS a table — never null. An unusable or missing row yields a deny-all table.
 *
 * ABSENT NOW MEANS DENY-ALL, exactly like invalid (2026-08-18). It used to return `null` for
 * "behave exactly as before this layer existed", which made the rollout additive and made an absent row
 * PERMISSIVE — so a scope the materialiser never covered kept grant-based behaviour and any pin on it was
 * silently inert. That was not hypothetical: ch-cr89fluhion, the scope holding every sandbox pin, sat in
 * exactly that state, and its five pins did nothing while looking configured. A permissive default for the
 * component whose whole job is withholding capability is the wrong default, and "we will flip the flag once
 * the fleet is materialised" is a promise no one is paged about.
 *
 * WHAT MAKES THIS SAFE is not optimism, it is that the row is written on EVERY TURN before the invoke:
 * `ensureCurrentRuntime` awaits `ensurePolicyRow` (archie-gateway/index.js:161), which is both the
 * mint-time write for a scope no deploy can enumerate and the staleness backstop for a policy edit the
 * deploy never saw. So a scope cannot serve a turn without a current row.
 *
 * WHAT IT COSTS, stated plainly because it is a real operational edge: if the FLEET ARTIFACT does not
 * exist, `ensurePolicyRow` is a documented no-op ('no-artifact'), no rows are written anywhere, and every
 * agent is denied everything — including baseline. Two consequences follow, and both are deliberate:
 *   1. `archie policy publish` must precede the image roll. `archie deploy` already orders it that way
 *      (step 1.5 publishes before the agent half), so a normal release satisfies this by construction.
 *   2. An account with NO pins file can no longer run agents at all. `archie deploy` treats that as a
 *      warning ('no-pins') on the grounds that the layer is additive — which is no longer true. That
 *      branch should become a refusal; until it does, standing up a new environment means adding its
 *      pins file first.
 */
export function loadPolicyTable(row, { scope, expectedAccount = null, onProblem = () => {} } = {}) {
  const refuse = (why, detail = {}) => {
    try { onProblem(why, detail); } catch { /* never fail a boot on telemetry */ }
    return denyAllTable(why);
  };

  if (row === null || row === undefined) {
    try { onProblem('absent', { scope }); } catch { /* ignore */ }
    return denyAllTable('absent');
  }
  if (typeof row !== 'object' || Array.isArray(row)) return refuse('not-an-object');

  // Version FIRST: an unknown contract means every field below may mean something else, so no other
  // check on this row is meaningful. Refusing forward is deliberate — a newer writer paired with an
  // older runtime is a deploy-ordering mistake, and it should be loud rather than half-honoured.
  if (row.v !== CONTRACT_VERSION) return refuse('unknown-version', { v: row.v, expected: CONTRACT_VERSION });

  // The row is addressed to a scope. A mismatch means the wrong row reached this runtime — a staging
  // bug, or an env/item mix-up — and applying another scope's verdicts would be exactly the
  // cross-scope privilege transfer the whole model is built to prevent.
  if (row.scope !== scope) return refuse('scope-mismatch', { rowScope: row.scope, scope });

  // Account is checked only when the caller can supply one. It guards against a sandbox row reaching a
  // prod runtime (or the reverse) — the class of mistake that put two sandbox scope ids into
  // pins.prod.json. When the caller passes null the assertion is SKIPPED, not passed: recorded so the
  // gap is visible rather than mistaken for a check that ran.
  if (expectedAccount && row.account && row.account !== expectedAccount) {
    return refuse('account-mismatch', { rowAccount: row.account, expectedAccount });
  }

  const verdicts = row.verdicts;
  if (verdicts === null || typeof verdicts !== 'object' || Array.isArray(verdicts)) {
    return refuse('verdicts-not-an-object');
  }
  // A single unrecognised verdict poisons the WHOLE row rather than being skipped. Skipping it would
  // turn an unreadable value into an absent entry, which falls through to the grant path — a typo
  // becoming a widening. There is no safe way to partially honour this row.
  for (const [cap, v] of Object.entries(verdicts)) {
    if (!VALID_VERDICTS.has(v)) return refuse('bad-verdict', { capability: cap, verdict: v });
  }

  return {
    verdictFor: (cap) => verdicts[cap],
    // The capabilities this row governs. Exposed so a caller can REPORT what the policy decided without
    // needing a separate list of capability names to iterate — the row is the authority, and any external
    // list would be a mirror that drifts. Added after the first live check found that a healthy load logged
    // nothing at all, leaving "policy in force at digest X" indistinguishable from "this image has no
    // policy code" (see pi-adapter loadPolicy).
    capabilities: Object.keys(verdicts).sort(),
    // The PINNED skills this scope may hold, straight from the row. Consumed by readSkillState's filter,
    // which intersects the agent's installs with it. Only pinned skills appear, so an ABSENT entry means
    // "not governed" (allowed) rather than "denied" — see skill-pins.isPinned.
    skills: Array.isArray(row.skills) ? [...row.skills].sort() : [],
    skillsGoverned: Array.isArray(row.skillsGoverned) ? [...row.skillsGoverned].sort() : [],
    allowed: Object.keys(verdicts).filter((c) => verdicts[c] === 'allow').sort(),
    digest: typeof row.policyDigest === 'string' ? row.policyDigest : null,
    denyAll: false,
    accountAsserted: Boolean(expectedAccount && row.account),
  };
}

// POLICY_TABLE_REQUIRED IS GONE (2026-08-18). It was the env flag that turned an absent row from
// permissive into deny-all, off by default so the rollout could be additive. Deny-all is now the
// UNCONDITIONAL default, so there is nothing left to switch: see loadPolicyTable's absent branch.
//
// What made the flag safe to delete rather than merely unnecessary: the dispatcher writes this row on
// EVERY turn, before the invoke, and awaits it — `ensureCurrentRuntime` → `ensurePolicyRow`
// (archie-gateway/index.js:161). That is both the mint-time write for a scope no deploy can enumerate and
// the staleness backstop for a policy edit the deploy never saw. So a scope cannot take a turn without a
// current row, and "absent" no longer means "not reached yet" — it means the write failed or the fleet has
// no policy at all. Neither is a state to serve a turn in.

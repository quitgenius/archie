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
 *            denyAll: boolean, why?: string} | null}
 *          `null` means NO ROW AT ALL — the caller keeps today's grant-only behaviour. Any other
 *          return is a table to consult.
 *
 * ABSENT IS NOT THE SAME AS INVALID, and conflating them would break the rollout in one direction or
 * the other. Every scope has no row until the first policy deploy reaches it, so absent must mean
 * "behave exactly as before" — that additive property is what makes the Phase 0 baseline meaningful and
 * what lets this ship before the fleet is fully materialised. Invalid, by contrast, means a row was
 * written and cannot be trusted, and that fails closed.
 *
 * The danger in that split is real and worth naming: an absent row is PERMISSIVE, so a scope the
 * materialiser never covered keeps grant-based behaviour and any pin on it is silently inert. That is
 * not hypothetical — ch-cr89fluhion, the scope holding every sandbox pin, is absent from the deploy
 * roster for exactly this reason (§2.1). So absence is logged loudly here, and once the fleet is fully
 * materialised POLICY_TABLE_REQUIRED flips it to deny-all, which is the switch that closes the hole.
 */
export function loadPolicyTable(row, { scope, expectedAccount = null, onProblem = () => {} } = {}) {
  const refuse = (why, detail = {}) => {
    try { onProblem(why, detail); } catch { /* never fail a boot on telemetry */ }
    return denyAllTable(why);
  };

  if (row === null || row === undefined) {
    try { onProblem('absent', { scope }); } catch { /* ignore */ }
    return null;
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
    digest: typeof row.policyDigest === 'string' ? row.policyDigest : null,
    denyAll: false,
    accountAsserted: Boolean(expectedAccount && row.account),
  };
}

/**
 * Should an ABSENT row be treated as deny-all?
 *
 * Off by default so the layer is additive during rollout (see loadPolicyTable). Flipping this on is the
 * final step of materialising the fleet: after it, a scope with no POLICY row cannot act, so a pin can
 * never be silently inert. It is an env flag rather than a constant precisely because the safe value
 * changes over the rollout, and the change must be revertible without an image build.
 */
export const policyTableRequired = (env = process.env) => env.POLICY_TABLE_REQUIRED === '1';

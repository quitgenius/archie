'use strict';

// Scope id → the Slack name a human recognises. `dm-ux0mz5ckp2r` → `personc73cc2 · dm-ux0mz5ckp2r`.
//
// STATELESS, AND THAT IS THE WHOLE POINT. Every call talks to Slack. There is no name map held
// between calls, no TTL, no rename-event invalidation and no reload signal — and none may be added.
//
// This replaced the label cache inside agent-directory.js, which loaded every name once at boot and
// then relied on `channel_rename` / `group_rename` / `user_change` to stay correct. That was wrong in
// two directions at once: it silently indexed only the first 100 of every agent in the fleet, and its one repair
// path (`POST /reload`) is unreachable from outside the VPC — the gateway admits port 9090 only from
// the runtime and hydrator security groups.
//
// ── PER-SCOPE `info`, NOT A WORKSPACE `list`. THIS BROKE PROD ONCE. ──────────────────────────────
//
// The first version bulk-loaded names with `users.list` + `conversations.list`, on the reasoning that
// two calls cover any number of scopes. That is true in a small workspace and false in a real one:
// `conversations.list` is Tier 2 (~20 req/min) AND PAGINATED, so in the Pelago workspace one render
// costs many Tier-2 requests rather than one. `labelFor` is awaited by `homeViewOptions`, i.e. by
// EVERY App Home render, so the budget was gone in minutes and Bolt's WebClient then backed off 30s
// per attempt — which is not a degraded label, it is a Home tab that never publishes. Observed in
// prod 2026-09-08: continuous `A rate limit was exceeded (url: .../conversations.list,
// retry-after: 30)`.
//
// So labels are resolved ONE SCOPE AT A TIME with `users.info` / `conversations.info` (Tier 4 and
// Tier 3, ~100 and ~50 per minute, single request each). The common case — one scope for the current
// render target — is now exactly one cheap call instead of paginating thousands of channels.
//
// ── NEVER RETRY, NEVER BLOCK ────────────────────────────────────────────────────────────────────
//
// A label is cosmetic; a render is not. The caller injects a NO-RETRY client, so a 429 fails
// immediately and degrades to the raw scope id rather than sleeping. Concurrency is bounded so a
// viewer who owns many scopes cannot fire 60 requests at once, and every per-scope failure is
// absorbed independently — a rate-limited lookup costs that one entry its name, nothing more.
//
// EVERY FAILURE DEGRADES TO THE RAW SCOPE ID, never to an empty label and never to a throw. The raw
// id is the honest answer — it is also what an operator needs in order to cross-check DynamoDB.

const { slackRefFromScopeId } = require('./agent-scope');
const { composeLabel } = require('./agent-directory');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };

// How many per-scope lookups run at once. Small on purpose: these are Tier 3/4 methods and the
// point of the bound is that one viewer's interaction cannot exhaust the workspace's budget.
const CONCURRENCY = 5;

/**
 * @param deps.slack  { users: {list}, conversations: {list} } — injected, so tests need no WebClient
 * @param deps.log    pino-shaped logger
 */
function createAgentLabels({ slack, log = NOOP_LOG }) {
  /**
   * One scope's Slack name, or null. Never throws, never retries, never sleeps.
   *
   * `missing_scope` is the case that matters most (a reinstall with narrowed scopes) and
   * `ratelimited` the one that broke prod; both land here and both yield null, which the caller
   * renders as the raw scope id.
   */
  async function nameFor(ref) {
    if (!ref) return null;
    try {
      if (ref.kind === 'user') {
        const r = await slack.users.info({ user: ref.id });
        const u = (r && r.user) || {};
        const p = u.profile || {};
        return p.display_name || u.real_name || p.real_name || u.name || null;
      }
      const r = await slack.conversations.info({ channel: ref.id });
      const c = (r && r.channel) || {};
      return c.name ? `#${c.name}` : null;
    } catch (err) {
      log.warn(
        { kind: ref.kind, id: ref.id, err: err.message, code: err.data && err.data.error },
        'agent-labels: name lookup failed — this entry degrades to its raw scope id',
      );
      return null;
    }
  }

  /**
   * Label a set of scope ids. Returns entries in the SAME ORDER they were given — the caller has
   * already decided the order (own scope first) and this must not resort it.
   *
   * `kind` rides along because the selector groups by it (People / Channels / Other) and the scope id
   * is the only input to that decision.
   */
  async function resolve(scopeIds) {
    const ids = (scopeIds || []).filter((s) => typeof s === 'string' && s);
    const refs = ids.map((scopeId) => ({ scopeId, ref: slackRefFromScopeId(scopeId) }));

    // Bounded concurrency. A viewer owning many scopes must not fire 60 requests at once — that is how
    // a Tier-3 budget is spent in one interaction. Sequential batches of CONCURRENCY.
    const names = new Array(refs.length).fill(null);
    for (let i = 0; i < refs.length; i += CONCURRENCY) {
      const slice = refs.slice(i, i + CONCURRENCY);
      const got = await Promise.all(slice.map((r) => nameFor(r.ref)));
      for (let k = 0; k < got.length; k += 1) names[i + k] = got[k];
    }

    return refs.map(({ scopeId, ref }, i) => ({
      scopeId,
      kind: ref ? ref.kind : 'other',
      name: names[i] || null,
      label: composeLabel(names[i], scopeId),
    }));
  }

  /**
   * One scope's label, for the selector's `initial_option` and anything else rendering a single
   * target. Exactly ONE Slack request — this is the App-Home-render path, so its cost is the cost of
   * opening the Home tab.
   */
  async function labelFor(scopeId) {
    if (!scopeId) return '';
    const [entry] = await resolve([scopeId]);
    return entry ? entry.label : composeLabel(null, String(scopeId));
  }

  return { resolve, labelFor };
}

module.exports = { createAgentLabels };

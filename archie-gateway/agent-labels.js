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
// the runtime and hydrator security groups — so an operator who noticed a stale label could not fix
// it without rolling the service.
//
// WHAT MAKES FRESH AFFORDABLE. Under owner-gating the caller resolves only the scopes ONE viewer
// owns, not the fleet, and it resolves them when a human opens a tab or types in the selector. Two
// paginated Tier-2 calls cover any number of scopes, and a kind that is not present costs nothing:
// a viewer who owns only DM scopes never calls conversations.list.
//
// EVERY FAILURE DEGRADES TO THE RAW SCOPE ID, never to an empty label and never to a throw. The raw
// id is the honest answer — it is also what an operator needs in order to cross-check DynamoDB — so
// a lost `channels:read` scope makes the selector ugly rather than empty. `missing_scope` is the case
// that matters: it is what a reinstall with narrowed scopes looks like.

const { slackRefFromScopeId } = require('./agent-scope');
const { composeLabel } = require('./agent-directory');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };

// conversations.list is Tier 2 and the docs advise <=200 per page; users.list takes 500 happily.
const CHANNEL_PAGE = 200;
const USER_PAGE = 500;

// Cursor loops are bounded so a malformed or looping cursor cannot spin forever on a render path.
const MAX_PAGES = 50;

/**
 * @param deps.slack  { users: {list}, conversations: {list} } — injected, so tests need no WebClient
 * @param deps.log    pino-shaped logger
 */
function createAgentLabels({ slack, log = NOOP_LOG }) {
  async function paginate(what, call, absorb) {
    let cursor;
    let pages = 0;
    do {
      let r;
      try {
        r = await call(cursor);
      } catch (err) {
        log.warn({ what, err: err.message, code: err.data && err.data.error }, 'agent-labels: name load failed — labels degrade to raw scope ids');
        return;
      }
      if (!r || r.ok === false) {
        log.warn({ what, error: r && r.error }, 'agent-labels: name load returned not-ok — labels degrade to raw scope ids');
        return;
      }
      absorb(r);
      cursor = (r.response_metadata && r.response_metadata.next_cursor) || '';
    } while (cursor && ++pages < MAX_PAGES);
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

    const needUsers = refs.some((r) => r.ref && r.ref.kind === 'user');
    const needChannels = refs.some((r) => r.ref && r.ref.kind === 'channel');

    const userNames = new Map();
    const channelNames = new Map();

    // Both kinds at once — they are independent calls to independent methods, so serialising them
    // would double the latency of a render for no benefit. A kind nobody asked for is not called.
    await Promise.all([
      needUsers ? paginate('users', (cursor) => slack.users.list({ limit: USER_PAGE, cursor }), (r) => {
        for (const u of r.members || []) {
          if (!u || !u.id) continue;
          const p = u.profile || {};
          const name = p.display_name || u.real_name || p.real_name || u.name;
          if (name) userNames.set(u.id, name);
        }
      }) : Promise.resolve(),
      // `types` MUST name private_channel explicitly or the call returns public channels only.
      needChannels ? paginate('channels', (cursor) => slack.conversations.list({
        types: 'public_channel,private_channel',
        limit: CHANNEL_PAGE,
        exclude_archived: false,
        cursor,
      }), (r) => {
        for (const c of r.channels || []) {
          if (c && c.id && c.name) channelNames.set(c.id, c.name);
        }
      }) : Promise.resolve(),
    ]);

    return refs.map(({ scopeId, ref }) => {
      const raw = ref ? (ref.kind === 'user' ? userNames.get(ref.id) : channelNames.get(ref.id)) : null;
      const shown = raw ? (ref.kind === 'channel' ? `#${raw}` : raw) : null;
      return {
        scopeId,
        kind: ref ? ref.kind : 'other',
        name: shown || null,
        label: composeLabel(shown, scopeId),
      };
    });
  }

  /**
   * One scope's label, for the selector's `initial_option` and anything else rendering a single
   * target. Costs the same Slack call as resolving a set, so a caller that needs both a list and the
   * current target's label should call `resolve` once with both rather than calling this as well.
   */
  async function labelFor(scopeId) {
    if (!scopeId) return '';
    const [entry] = await resolve([scopeId]);
    return entry ? entry.label : composeLabel(null, String(scopeId));
  }

  return { resolve, labelFor };
}

module.exports = { createAgentLabels };

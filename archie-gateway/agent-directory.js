'use strict';

// The agent directory: ONE local, searchable list of every agent, labelled by its real Slack name.
//
// It backs App Home's agent selector (`external_select`), and it is deliberately one structure doing
// three jobs — roster, search index, and label cache — because they have the same lifetime. An
// earlier draft had a roster read from DynamoDB and a separately-cached name map; the select's
// options-load fires on every keystroke, so that shape put a table Scan on the typing path. The Scan
// happens once, at boot.
//
// AGENT# IS THE SOURCE OF TRUTH for what an agent is. Distinct `AGENT#<scope>` partition keys, and
// nothing else is consulted:
//
//   - NOT the routing GSI. It is the pre-§8.10 override table, and a minted agent has no META, so it
//     is absent from that index BY CONSTRUCTION — measured in the sandbox, the GSI held 0 ROUTING
//     items while three real agents existed. Anything using it as a census under-reports silently.
//   - NO liveness filter of any kind. There is no runtime state that changes whether an agent is a
//     valid target, because every App Home action is a config write (skills/connectors/model →
//     AGENT#<scope>/MARKETPLACE, grants → GRANT#<scope>, cron → the cron store, conversation
//     pin/order → EFS). An agent that has never booted is perfectly configurable; the config lands on
//     its next turn. (And runtime-registry.js:12-14 disclaims liveness anyway — "the invoke is what
//     proves it still exists" — so a binding row could not have answered the question.)
//
// FRESHNESS IS PUSH-ONLY. There is no TTL, no setInterval, and no expiry check anywhere in this file,
// and that is a hard constraint rather than an oversight: a refresh interval is a window in which the
// cache is knowingly wrong, and nothing surfaces that. Two push signals keep the list current:
//
//   1. `noteMinted` — the gateway IS the minter (resolveAgent → mintAgentName runs in-process on the
//      message path), so a new agent is known at the instant it comes into existence. No polling, no
//      staleness window.
//   2. `applyChannelRename` / `applyUserChange` — Slack's own channel_rename / group_rename /
//      user_change events correct a label in place.
//
// KNOWN BOUND, stated rather than hidden: an agent created OUTSIDE this process — `archie` CLI
// hydration, say — emits no signal this module can observe, so it appears after the next restart.
// desired_count = 1, so there is no second task holding a divergent list. The fix, if it ever bites,
// is a real push signal (a DynamoDB stream, or the CLI calling the existing POST /reload), not a
// refresh loop.

const { slackRefFromScopeId } = require('./agent-scope');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };

const AGENT_PK_PREFIX = 'AGENT#';

// Slack caps an option's `text` at 75 chars. The scope id is never the part that gets dropped: it is
// what disambiguates two people with the same display name, and it is the value an operator needs to
// cross-check against DynamoDB.
const OPTION_TEXT_MAX = 75;

// A single options-load response may carry at most 100 options.
const SEARCH_LIMIT = 100;

// conversations.list is Tier 2 and the docs advise <=200 per page; users.list takes 500 happily.
const CHANNEL_PAGE = 200;
const USER_PAGE = 500;

// Cursor loops are bounded so a malformed/looping cursor cannot spin forever at boot.
const MAX_PAGES = 50;

/** `personc73cc2 · dm-ux0mz5ckp2r`, with the NAME truncated if the pair will not fit. */
function composeLabel(name, scopeId) {
  if (!name) return scopeId.slice(0, OPTION_TEXT_MAX);
  const suffix = ` · ${scopeId}`;
  const room = OPTION_TEXT_MAX - suffix.length;
  if (room <= 1) return scopeId.slice(0, OPTION_TEXT_MAX);
  const shown = name.length > room ? `${name.slice(0, room - 1)}…` : name;
  return `${shown}${suffix}`;
}

/**
 * @param deps.tableName the single config table (AGENT_CONFIG_TABLE).
 * @param deps.doc       () => DynamoDBDocumentClient — a GETTER, so the client stays lazy and tests
 *                       can inject a fake without constructing an SDK client.
 * @param deps.slack     a @slack/web-api-shaped client (users.list/info, conversations.list/info).
 * @param deps.logger    pino-shaped.
 */
function createAgentDirectory({ tableName, doc, slack, logger } = {}) {
  const log = logger || NOOP_LOG;

  // scopeId -> { scopeId, kind, slackId, name, label }
  //   kind: 'user' | 'channel' | 'other'   ('other' = a real scope not minted from Slack, e.g. a
  //   BDD fixture; it has no name to resolve and renders as its raw id, which is the honest answer)
  const entries = new Map();

  // Slack id -> name, from the boot bulk-load. Kept so a rename event, or a scope discovered later,
  // can be answered without another API call.
  const userNames = new Map();
  const channelNames = new Map();

  function cmds() {
    return require('@aws-sdk/lib-dynamodb');
  }

  function nameFor(ref) {
    if (!ref) return null;
    return ref.kind === 'user' ? userNames.get(ref.id) || null : channelNames.get(ref.id) || null;
  }

  function displayName(ref, name) {
    if (!name) return null;
    return ref.kind === 'channel' ? `#${name}` : name;
  }

  /** Build (or rebuild) one entry from whatever names are currently known. */
  function upsert(scopeId) {
    const ref = slackRefFromScopeId(scopeId);
    const raw = nameFor(ref);
    const shown = ref ? displayName(ref, raw) : null;
    const entry = {
      scopeId,
      kind: ref ? ref.kind : 'other',
      slackId: ref ? ref.id : null,
      name: shown,
      label: composeLabel(shown, scopeId),
    };
    entries.set(scopeId, entry);
    return entry;
  }

  // ---------- boot ----------

  /**
   * Every distinct `AGENT#<scope>` partition key. One Scan, projected to the keys.
   *
   * ProjectionExpression does not reduce the read cost (DynamoDB bills the whole item either way) —
   * it reduces the payload, which is the part that matters when SEED rows carry a whole workspace
   * skeleton. The table is small: 57 items in the sandbox, order-of-1500 in prod, one or two pages.
   */
  async function scanScopeIds() {
    const { ScanCommand } = cmds();
    const found = new Set();
    let ExclusiveStartKey;
    let pages = 0;
    do {
      const r = await doc().send(new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'pk',
        ExclusiveStartKey,
      }));
      for (const it of r.Items || []) {
        const pk = it && it.pk;
        if (typeof pk === 'string' && pk.startsWith(AGENT_PK_PREFIX)) {
          const scope = pk.slice(AGENT_PK_PREFIX.length);
          if (scope) found.add(scope);
        }
      }
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey && ++pages < MAX_PAGES);
    return [...found];
  }

  /**
   * Bulk-label in two paginated calls rather than one lookup per scope.
   *
   * many scopes resolved per-scope would be ~208 Tier-3/4 calls on a cold Home open, which blows the
   * budget and puts that latency on the first render. users.list + conversations.list cover the whole
   * workspace in two Tier-2 calls. (archie-metrics/server.js:34 is the precedent for the bulk shape —
   * but NOT for its hourly refresh, which is deliberately not copied here.)
   *
   * `types` must name private_channel explicitly or the call returns public only. Verified live
   * 2026-08-24 that with groups:read granted, a private channel the bot belongs to DOES come back.
   *
   * A failure here is logged and swallowed: the roster still exists, entries just fall back to their
   * raw scope ids. A missing scope is invisible; a raw-id label is merely ugly.
   */
  async function loadSlackNames() {
    await paginate('users', (cursor) => slack.users.list({ limit: USER_PAGE, cursor }), (r) => {
      for (const u of r.members || []) {
        if (!u || !u.id) continue;
        const p = u.profile || {};
        const name = p.display_name || u.real_name || p.real_name || u.name;
        if (name) userNames.set(u.id, name);
      }
    });

    await paginate('channels', (cursor) => slack.conversations.list({
      types: 'public_channel,private_channel',
      limit: CHANNEL_PAGE,
      exclude_archived: false,
      cursor,
    }), (r) => {
      for (const c of r.channels || []) {
        if (c && c.id && c.name) channelNames.set(c.id, c.name);
      }
    });
  }

  async function paginate(what, call, absorb) {
    let cursor;
    let pages = 0;
    do {
      let r;
      try {
        r = await call(cursor);
      } catch (err) {
        // missing_scope is the interesting one: it means the app lost channels:read/groups:read, and
        // the right response is degraded labels, not a dead Home tab.
        log.warn({ what, err: err.message, code: err.data && err.data.error }, 'agent-directory: bulk name load failed — labels degrade to raw scope ids');
        return;
      }
      if (!r || r.ok === false) {
        log.warn({ what, error: r && r.error }, 'agent-directory: bulk name load returned not-ok — labels degrade to raw scope ids');
        return;
      }
      absorb(r);
      cursor = (r.response_metadata && r.response_metadata.next_cursor) || '';
    } while (cursor && ++pages < MAX_PAGES);
  }

  /** Boot: scan the roster, bulk-label it, build the list. Never throws — a broken selector must not stop the gateway. */
  async function load() {
    if (!tableName) {
      log.warn('agent-directory: no AGENT_CONFIG_TABLE — the agent selector will be empty');
      return { agents: 0, users: 0, channels: 0 };
    }
    try {
      const [scopes] = await Promise.all([scanScopeIds(), loadSlackNames()]);
      entries.clear();
      for (const s of scopes.sort()) upsert(s);
      log.info({ agents: entries.size, users: userNames.size, channels: channelNames.size }, 'agent-directory loaded');
    } catch (err) {
      log.error({ err: err.message }, 'agent-directory: load failed — the agent selector will be empty until the next restart');
    }
    return { agents: entries.size, users: userNames.size, channels: channelNames.size };
  }

  // ---------- push updates ----------

  /**
   * A scope seen on the message path. Appends it if new, and resolves its ONE name with a single
   * lookup (the bulk maps will not have a channel created since boot).
   *
   * Called from the turn path, so it must never throw and never block: callers fire-and-forget.
   * Returns true if the list changed.
   */
  async function noteMinted(scopeId) {
    if (!scopeId || entries.has(scopeId)) return false;
    const ref = slackRefFromScopeId(scopeId);
    if (ref && !nameFor(ref)) {
      try {
        if (ref.kind === 'user') {
          const r = await slack.users.info({ user: ref.id });
          const p = (r.user && r.user.profile) || {};
          const name = p.display_name || (r.user && r.user.real_name) || p.real_name;
          if (name) userNames.set(ref.id, name);
        } else {
          const r = await slack.conversations.info({ channel: ref.id });
          if (r.channel && r.channel.name) channelNames.set(ref.id, r.channel.name);
        }
      } catch (err) {
        log.warn({ scope: scopeId, err: err.message }, 'agent-directory: could not name a newly minted scope — it lists as its raw id');
      }
    }
    upsert(scopeId);
    log.info({ scope: scopeId, agents: entries.size }, 'agent-directory: appended a newly minted agent');
    return true;
  }

  /** channel_rename / group_rename — `{ channel: { id, name } }`. Relabels in place. */
  function applyChannelRename(channel) {
    if (!channel || !channel.id || !channel.name) return false;
    channelNames.set(channel.id, channel.name);
    return relabelBySlackId('channel', channel.id);
  }

  /** user_change — the full user object. Relabels in place if the display/real name moved. */
  function applyUserChange(user) {
    if (!user || !user.id) return false;
    const p = user.profile || {};
    const name = p.display_name || user.real_name || p.real_name || user.name;
    if (!name || userNames.get(user.id) === name) return false;
    userNames.set(user.id, name);
    return relabelBySlackId('user', user.id);
  }

  function relabelBySlackId(kind, slackId) {
    let changed = false;
    for (const e of entries.values()) {
      if (e.kind === kind && e.slackId === slackId) {
        upsert(e.scopeId);
        changed = true;
      }
    }
    return changed;
  }

  // ---------- read ----------

  /**
   * Filter the local list. Pure in-memory — this runs on the options-load path, which fires on every
   * keystroke, so it must do no I/O.
   *
   * Matches the label, the resolved name and the scope id, so both "sandbox" and "dm-u0bd" find the same
   * agent. Entries are pre-sorted by scope id; named agents sort ahead of raw-id ones so the useful
   * results are not pushed off the 100-option cap by BDD fixtures.
   */
  function search(query, { limit = SEARCH_LIMIT } = {}) {
    const q = String(query || '').trim().toLowerCase();
    const out = [];
    for (const e of entries.values()) {
      if (!q || e.scopeId.toLowerCase().includes(q) || (e.name || '').toLowerCase().includes(q)) out.push(e);
    }
    out.sort((a, b) => {
      if (!!a.name !== !!b.name) return a.name ? -1 : 1;
      return (a.name || a.scopeId).localeCompare(b.name || b.scopeId);
    });
    return out.slice(0, limit);
  }

  /** Is this a real agent? The membership check the select handler runs on untrusted input. */
  const has = (scopeId) => entries.has(scopeId);

  /** The label for one scope, falling back to the raw id for anything not in the list. */
  const labelFor = (scopeId) => {
    const e = entries.get(scopeId);
    return e ? e.label : composeLabel(null, String(scopeId || ''));
  };

  const get = (scopeId) => entries.get(scopeId) || null;
  const size = () => entries.size;
  const all = () => [...entries.values()];

  return {
    load, noteMinted, applyChannelRename, applyUserChange,
    search, has, labelFor, get, size, all,
  };
}

module.exports = { createAgentDirectory, composeLabel, OPTION_TEXT_MAX, SEARCH_LIMIT };

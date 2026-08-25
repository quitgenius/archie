'use strict';

// §8.10 identity=scope — THE scope-id rule, in one place.
//
// A source with no explicit route gets its own on-demand agent named after the SOURCE, not after a
// person: `dm-<userId>` or `ch-<channelId>`. Same source → same name every time, so routing needs no
// stored state: the name IS the route, recomputed on every message.
//
// WHY THIS FILE EXISTS. The rule was written out twice — `mintAgentName` in index.js (what an
// unrouted event mints) and `scopeIdFor` in config-resolver/rekey-to-scope.mjs (what the rekey
// migration writes), the latter carrying the comment "EXACT mirror of mintAgentName (keep in
// lockstep — the scope id MUST equal what an unrouted event would mint, or continuity/routing
// splits)". A rule kept in lockstep by a comment is a rule that will drift, and the failure is
// invisible: a rekeyed agent and a live event would resolve to different ids, so the same human
// would silently become two agents with two sessions and two sets of grants.
//
// Cron hydration needs the same rule a third time (it must post an agent's jobs under the identity
// the dispatcher will actually route to), which is what forced the extraction rather than a third
// copy.
//
// THE NORMALISATION IS PART OF THE CONTRACT, not tidying. Slack ids are already
// `[A-Z0-9]`, but the lowercase + slug + 48-char truncation is what the runtime name derivation and
// the EFS/IAM path derivations assume downstream. Changing any of it re-keys every minted agent.

/** `dm-U123` / `ch-C456` → the stored, routed, runtime-safe form. */
/**
 * THE ONE PLACE A ScopeId IS MINTED. Both producers below funnel through here, so the brand's
 * boundary is this single cast — see types/identity.d.ts for why the two identity spaces are
 * distinct types rather than both being `string`.
 * @param {string} raw
 * @returns {import('../types/identity').ScopeId}
 */
function normaliseScopeId(raw) {
  return /** @type {import('../types/identity').ScopeId} */ (String(raw)
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 48));
}

/**
 * What an UNROUTED Slack event mints. This is the definition; everything else agrees with it.
 * `channel_type === 'im'` is what distinguishes a DM from a channel post by the same user.
 */
/**
 * @param {{channel_type?: string, user?: string, channel?: string}} event
 * @returns {import('../types/identity').ScopeId}
 */
function mintAgentName(event) {
  const isDM = event.channel_type === 'im';
  const raw = isDM ? `dm-${event.user}` : `ch-${event.channel}`;
  return normaliseScopeId(raw);
}

/**
 * The scope id for a NAMED agent's routing config — the id it becomes under §8.10.
 *
 * DM WINS OVER CHANNEL when an agent has both. Exactly one agent in the fleet does
 * (`agent-83l3pa`, verified across many configs on 2026-08-16), so this tie-break decides one case;
 * it is stated rather than left to array order because "whichever came first" is not a rule anyone
 * can rely on. Its channel routing is NOT lost — rekey copies the routing META verbatim and points
 * the routing GSI at the scope id, so channel traffic still resolves there.
 *
 * Returns null when an agent has neither — a config that cannot be scope-keyed, which callers must
 * refuse rather than guess at.
 */
/**
 * @param {{dm_users?: string[], channels?: string[]} | null | undefined} meta
 * @returns {import('../types/identity').ScopeId | null}
 */
function scopeIdForRouting(meta) {
  const dm = ((meta && meta.dm_users) || [])[0];
  const ch = ((meta && meta.channels) || [])[0];
  if (dm) return normaliseScopeId(`dm-${dm}`);
  if (ch) return normaliseScopeId(`ch-${ch}`);
  return null;
}

// Slack ids are an uppercase-only alphabet, which is the whole reason the inverse below is possible.
// {8,} not {6,}: real ids are 9-11 chars, and {6,} false-ACCEPTED ordinary words — 'current'
// uppercases to CURRENT = C + URRENT, which matched. See the same note on
// cron-inventory-metrics.js's SLACK_CHANNEL_ID, where that false accept was observed live.
const SLACK_USER_ID = /^U[A-Z0-9]{6,}$/;
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/;

/**
 * THE INVERSE of the rule above: a scope id → the Slack thing it was minted from.
 *
 * `dm-ux0mz5ckp2r` → `{ kind: 'user', id: 'UX0MZ5CKP2R' }`
 * `ch-cr89fluhion` → `{ kind: 'channel', id: 'CR89FLUHION' }`
 * `bdd-tests`      → `null`  (a real scope, but not one minted from Slack)
 *
 * WHY IT LIVES HERE. This file's header exists because the FORWARD rule was written out three times
 * and kept in step by a comment. The inverse is the same hazard: `cron-inventory-metrics.js:114
 * userFromScopeId` already spells out the `dm-` half for cron delivery, and a second free-hand copy
 * elsewhere is how the two drift. Put it next to the rule it inverts. (That cron copy is deliberately
 * NOT collapsed into this one here — it sits on the cron delivery path and refactoring it belongs in
 * a change that can verify that path, not in an App Home feature.)
 *
 * CASE RECOVERY IS LOSSLESS, and that is a property of the forward rule, not luck: `normaliseScopeId`
 * lowercases, and there is nothing in the uppercase-only Slack alphabet for it to have destroyed. The
 * uppercasing is not cosmetic — `conversations.info` rejects a lowercased id with `channel_not_found`
 * (observed live 2026-08-09, see cron-delivery.js), so a caller that skips it gets a silent miss.
 *
 * Returns null rather than guessing for anything that does not validate, so a caller renders the raw
 * scope id instead of inventing a Slack object that does not exist.
 *
 * @param {string} scopeId
 * @returns {{kind: 'user'|'channel', id: string} | null}
 */
function slackRefFromScopeId(scopeId) {
  if (typeof scopeId !== 'string') return null;
  const m = scopeId.match(/^(dm|ch)-([a-z0-9]+)$/i);
  if (!m) return null;
  const id = m[2].toUpperCase();
  if (m[1].toLowerCase() === 'dm') return SLACK_USER_ID.test(id) ? { kind: 'user', id } : null;
  return SLACK_CHANNEL_ID.test(id) ? { kind: 'channel', id } : null;
}

module.exports = { normaliseScopeId, mintAgentName, scopeIdForRouting, slackRefFromScopeId };

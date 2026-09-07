'use strict';

// Per-agent OWNERS — who may point App Home at a scope and administer it there.
//
// An owner of a scope can select it in the Home tab's agent selector and drive every control on it;
// a non-owner cannot see it in the selector and cannot address it. That is the whole of what
// ownership means. It also gates the outbound-comms approval toggle (opt-toggle), which was the
// first consumer and is now one of several.
//
// ── WHERE THE DATA LIVES ─────────────────────────────────────────────────────────────────────────
//
//   AGENT#<scope> / OWNERS      owners: { "UMRSP7355U7": { by, at }, ... }
//
// Its own sort key, not a field on CONFIG, because CONFIG is replaced wholesale by every
// `archie config hydrate` and this list has a second writer (an owner adding another owner) whose
// additions must survive that. Written by hydration from `sandra/agents/<name>/slack.json` →
// `owners: []` (config-resolver/migrate-to-ddb.mjs, `by: 'hydrate'`), by App Home's Owners tab
// (`by: <slackUserId>`), and by the mint path when an @mention brings a new scope into being
// (`by: 'mention'`).
//
// `owners` is a NATIVE DynamoDB Map, the one body in this table that is not an opaque JSON string in
// `data`. That is load-bearing: `ownedScopes` filters membership SERVER-SIDE with
// `attribute_exists(owners.<uid>)` over the `facet` GSI, and a FilterExpression cannot read inside a
// string. See modules/archie/agent_config.tf.
//
// ── THE DM SCOPE IS DERIVED, NEVER STORED ────────────────────────────────────────────────────────
//
// A `dm-<userId>` scope is owned by that user by construction — the owner is encoded in the id. So
// it is asserted in code (`ownsOwnScope`) and deliberately absent from the table: a stored row would
// be 150+ items of data that can only ever agree with the derivation, and could disagree with it if
// something wrote one wrong. Hydration writes no OWNERS row for DM agents for the same reason.
//
// ── NO CACHE. NOT ANYWHERE IN THIS FILE ──────────────────────────────────────────────────────────
//
// Every function here reads DynamoDB on every call. There is no boot-time scan, no in-memory map, no
// TTL and no `POST /reload` dependency, and none may be added. The previous version of this module
// kept a boot-time owner map for rendering and took a fresh read only for authorization; under a
// selector that GATES on ownership those are the same decision, and the cached half was wrong for
// the whole window between a hydrate and a dispatcher restart — a window an operator could not
// close, because the gateway admits port 9090 only from the runtime and hydrator security groups, so
// nothing on a laptop can reach /reload.
//
// The reads are cheap enough that this is not a trade. `ownedScopes` is one Query of the OWNERS
// partition of the `facet` GSI (~1 per agent-with-owners, not the 2,163-item table); `isOwner` and
// `ownersOf` are single GetItems on a known key.

const { mintAgentName } = require('./agent-scope');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };
const AGENT_PK_PREFIX = 'AGENT#';
const OWNERS_SK = 'OWNERS';
const FACET_INDEX = 'facet';
const MAX_PAGES = 50;

// Slack ids are an uppercase-only alphabet; {8,} because {6,} false-accepts ordinary words
// uppercased (see the same note on agent-scope.js SLACK_USER_ID / cron-inventory-metrics.js).
const SLACK_USER_ID = /^U[A-Z0-9]{6,}$/;

/** The canonical stored form of a Slack user id. Both writers normalise; readers must agree. */
const normaliseUserId = (userId) => String(userId || '').toUpperCase();

/** The scope a user owns by construction. Never read from or written to the table. */
const ownScopeFor = (userId) => mintAgentName({ channel_type: 'im', user: normaliseUserId(userId) });

/**
 * Does this user own this scope BY DERIVATION?
 *
 * Exported because the answer must be identical everywhere it is asked, and it is asked on paths
 * that have no table access.
 */
function ownsOwnScope(userId, scopeId) {
  if (!userId || !scopeId) return false;
  return scopeId === ownScopeFor(userId);
}

/** The owners map from an OWNERS item, tolerating anything malformed. `null` = unreadable. */
function ownersOfItem(item) {
  if (!item) return {};
  const { owners } = item;
  if (owners === undefined || owners === null) return {};
  if (typeof owners !== 'object' || Array.isArray(owners)) return null;
  return owners;
}

/**
 * @param deps.doc        () => DynamoDBDocumentClient
 * @param deps.tableName  the agent-config table
 * @param deps.metrics    dispatcher-metrics (optional; only the add path emits)
 * @param deps.isBotUser  async (slackUserId) => boolean. Required by addOwner; see BOTS below.
 * @param deps.log        pino-shaped logger
 */
function createOwners({ doc, tableName, metrics = null, isBotUser = null, log = NOOP_LOG }) {
  /**
   * THE AUTHORIZATION DECISION. Fresh read, every time.
   *
   * Fails CLOSED on any error: refusing a legitimate owner is a visible annoyance they can retry,
   * whereas admitting a non-owner hands them another person's agent.
   */
  async function isOwner(userId, scopeId) {
    if (!userId || !scopeId) return false;
    if (ownsOwnScope(userId, scopeId)) return true;
    if (!tableName) return false;
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    try {
      const r = await doc().send(new GetCommand({
        TableName: tableName,
        Key: { pk: `${AGENT_PK_PREFIX}${scopeId}`, sk: OWNERS_SK },
        // Never a bare attribute name in an expression — the house rule; an unaliased `agent` broke
        // every turn for every agent on 2026-08-13.
        ProjectionExpression: '#owners',
        ExpressionAttributeNames: { '#owners': 'owners' },
      }));
      const owners = ownersOfItem(r.Item);
      if (owners === null) {
        log.warn({ scopeId }, 'owners: OWNERS row is not a map — refusing (fails closed)');
        return false;
      }
      return Object.prototype.hasOwnProperty.call(owners, normaliseUserId(userId));
    } catch (err) {
      log.warn({ userId, scopeId, err: err.message }, 'owners: isOwner read failed — refusing (fails closed)');
      return false;
    }
  }

  /**
   * Every scope this user may address, freshly resolved. This IS the agent selector's roster.
   *
   * One Query of the `facet` GSI's OWNERS partition with a server-side membership filter, so the
   * table is never scanned and nothing off-limits is ever read back and discarded client-side. The
   * derived own-DM scope is prepended, and is present even when the Query returns nothing — a user
   * with no stored ownership anywhere still gets their own agent.
   *
   * Fails OPEN TO SELF, not closed and not wide: a read failure yields exactly the caller's own
   * scope. An empty list would publish a Home tab with no selectable agent at all, which reads as a
   * permissions change rather than a read error.
   */
  async function ownedScopes(userId) {
    const uid = normaliseUserId(userId);
    // VALIDATE BEFORE DERIVING. The own-scope derivation is a string template, so it happily turns
    // junk into a plausible-looking scope id (`not-a-slack-id` → `dm-not-a-slack-id`) that no agent
    // will ever answer to. Returning that is worse than returning nothing: it puts a dead entry in
    // the selector and, if selected, points every Home write at a scope that does not exist.
    //
    // The Query side is not injectable either way — ExpressionAttributeNames is a data field, not
    // string-concatenated into the expression — but a malformed map key silently matches nothing,
    // which reads as "you own no agents" rather than "that was not a Slack user id".
    if (!SLACK_USER_ID.test(uid)) {
      if (uid) log.warn({ userId }, 'owners: ownedScopes called with a non-Slack user id — refusing');
      return [];
    }
    const own = [ownScopeFor(uid)];
    if (!tableName) return own;
    const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
    const found = new Set(own);
    let ExclusiveStartKey;
    let pages = 0;
    try {
      do {
        const r = await doc().send(new QueryCommand({
          TableName: tableName,
          IndexName: FACET_INDEX,
          KeyConditionExpression: '#sk = :owners',
          FilterExpression: 'attribute_exists(#owners.#uid)',
          ProjectionExpression: '#pk',
          ExpressionAttributeNames: { '#sk': 'sk', '#pk': 'pk', '#owners': 'owners', '#uid': uid },
          ExpressionAttributeValues: { ':owners': OWNERS_SK },
          ExclusiveStartKey,
        }));
        for (const it of r.Items || []) {
          const pk = it && it.pk;
          if (typeof pk !== 'string' || !pk.startsWith(AGENT_PK_PREFIX)) continue;
          const scopeId = pk.slice(AGENT_PK_PREFIX.length);
          if (scopeId) found.add(scopeId);
        }
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey && ++pages < MAX_PAGES);
    } catch (err) {
      log.error({ userId, err: err.message }, 'owners: ownedScopes query failed — own scope only');
      return own;
    }
    // Own scope first, the rest sorted. The selector shows this order, and "your own agent" belongs
    // at the top rather than wherever it sorts.
    const rest = [...found].filter((s) => !own.includes(s)).sort();
    return [...own, ...rest];
  }

  /**
   * The stored owners of one scope, for the Owners tab. Does NOT include the derived owner of a
   * `dm-` scope — that is added by the caller, which knows it is rendering rather than deciding.
   */
  async function ownersOf(scopeId) {
    if (!scopeId || !tableName) return {};
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    try {
      const r = await doc().send(new GetCommand({
        TableName: tableName,
        Key: { pk: `${AGENT_PK_PREFIX}${scopeId}`, sk: OWNERS_SK },
        ProjectionExpression: '#owners',
        ExpressionAttributeNames: { '#owners': 'owners' },
      }));
      return ownersOfItem(r.Item) || {};
    } catch (err) {
      log.warn({ scopeId, err: err.message }, 'owners: ownersOf read failed');
      return {};
    }
  }

  /**
   * Add an owner. ADD ONLY — there is no removal path, by design.
   *
   * TWO UpdateItems, and the first is not optional. `SET owners.<uid> = :meta` on a scope with no
   * OWNERS row fails with `ValidationException: The document path provided in the update expression
   * is invalid for update` (confirmed against the live table, 2026-09-07) — and "no OWNERS row yet"
   * is every auto-provisioned agent and every DM agent, i.e. the common case. So the map is created
   * first with `if_not_exists`, which is a no-op when it already exists.
   *
   * Both statements are idempotent and neither is a read-modify-write, so two people adding
   * different owners concurrently cannot lose one another's write — each SETs its own map key.
   *
   * `by` is the acting Slack user id, or the literal 'hydrate' / 'mention' for the two automatic
   * writers. NOT validated as a Slack id for that reason.
   *
   * Authorization is the CALLER's job and is deliberately not attempted here: this is the store, and
   * the decision needs the clicker's identity re-derived from the interaction payload rather than
   * whatever an argument says.
   */
  async function addOwner({ scopeId, ownerUserId, by }) {
    const uid = normaliseUserId(ownerUserId);
    if (!scopeId) throw new Error('addOwner: scopeId required');
    if (!SLACK_USER_ID.test(uid)) throw new Error(`addOwner: '${ownerUserId}' is not a Slack user id`);
    if (!tableName) throw new Error('addOwner: no agent-config table configured');

    // ── NO BOTS ──────────────────────────────────────────────────────────────────────────────────
    //
    // Ownership is the right to point App Home at a scope. A bot has no App Home, never opens a
    // dropdown and never presses a button, so a bot owner is inert data in an authorization list —
    // it cannot act on the permission it holds. archie itself is addable by shape (its bot user id is
    // an ordinary `U…`), which is how this was found.
    //
    // Shape cannot decide it: a bot USER id is `U…` exactly like a person's (`B…` is the separate
    // bot-id namespace, which never appears here). So it takes a users.info lookup — one Tier-4 call
    // on a human button press, no cache.
    //
    // FAILS CLOSED, including when the lookup itself fails. Refusing a legitimate add is visible and
    // retryable; the refusal is surfaced to the clicker rather than logged and dropped.
    if (!isBotUser) throw new Error('addOwner: isBotUser resolver required (cannot verify the id is a person)');
    let bot;
    try {
      bot = await isBotUser(uid);
    } catch (err) {
      log.warn({ scopeId, ownerUserId: uid, err: err.message }, 'owners: could not verify whether the id is a bot — refusing');
      throw Object.assign(new Error(`addOwner: could not verify <@${uid}> is a person`), { name: 'OwnerUnverified' });
    }
    if (bot) {
      log.info({ scopeId, ownerUserId: uid, by }, 'owners: refused a bot as owner');
      throw Object.assign(new Error(`addOwner: <@${uid}> is a bot — bots have no App Home and cannot own a scope`), { name: 'OwnerIsBot' });
    }

    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const Key = { pk: `${AGENT_PK_PREFIX}${scopeId}`, sk: OWNERS_SK };
    const at = new Date().toISOString();
    try {
      await doc().send(new UpdateCommand({
        TableName: tableName,
        Key,
        UpdateExpression: 'SET #owners = if_not_exists(#owners, :empty)',
        ExpressionAttributeNames: { '#owners': 'owners' },
        ExpressionAttributeValues: { ':empty': {} },
      }));
      await doc().send(new UpdateCommand({
        TableName: tableName,
        Key,
        UpdateExpression: 'SET #owners.#uid = :meta',
        ExpressionAttributeNames: { '#owners': 'owners', '#uid': uid },
        ExpressionAttributeValues: { ':meta': { by, at } },
      }));
    } catch (err) {
      // Loud, metered, and rethrown. A silent failure here means the person who was told they are an
      // owner is not one, and finds out by not seeing the agent in their selector.
      log.error({ scopeId, ownerUserId: uid, by, err: err.message }, 'owners: addOwner FAILED');
      if (metrics) metrics.emitOwnerAdded(scopeId, { ownerUserId: uid, by, ok: false, errName: err.name });
      throw err;
    }
    log.info({ scopeId, ownerUserId: uid, by, at }, 'owners: owner added');
    if (metrics) metrics.emitOwnerAdded(scopeId, { ownerUserId: uid, by, ok: true });
    return { ownerUserId: uid, by, at };
  }

  /**
   * FIRST CONTACT establishes ownership: whoever @mentions archie in a channel it has never served
   * becomes that scope's owner, so the agent it brings into being is administrable by the person who
   * asked for it rather than by nobody.
   *
   * ONE conditional UpdateItem, and the condition is the whole design:
   *
   *   ConditionExpression: attribute_not_exists(#owners)
   *
   * It makes this safe to call on EVERY turn with no preceding read. On a scope that already has
   * owners the condition fails and nothing happens — which is not merely an optimisation, it is the
   * security property: without it, anyone who @mentioned archie in an already-owned channel would
   * make themselves an owner of it. Sandra's hydrated owners therefore always win, and a
   * bootstrapped one can only ever be the first.
   *
   * It is also SELF-HEALING. A failed write leaves the condition still true, so the next message to
   * that scope retries it. That is why this does not need to be fatal to the turn.
   *
   * `dm-` scopes are not passed here by the caller and must not be: their owner is derived from the
   * scope id, so a row would be data that can only agree with the derivation or be wrong.
   *
   * @returns {'created'|'already-owned'|'failed'}
   */
  async function bootstrapOwner({ scopeId, ownerUserId }) {
    const uid = normaliseUserId(ownerUserId);
    if (!scopeId || !SLACK_USER_ID.test(uid) || !tableName) return 'failed';
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const at = new Date().toISOString();
    try {
      await doc().send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: `${AGENT_PK_PREFIX}${scopeId}`, sk: OWNERS_SK },
        UpdateExpression: 'SET #owners = :first',
        // ABSENT ONLY. Not `OR size(#owners) = 0`, and that was tried and reverted on 2026-09-07:
        // it changes the invariant from "a scope can be claimed once, ever" to "a scope is claimable
        // whenever its owner list is empty", and an empty map is reachable by accident.
        //
        // The path that matters is a TORN WRITE in addOwner: step 1 creates the map, step 2 sets the
        // key, and a failure between them leaves `owners: {}`. That is harmless while adding an owner
        // requires already being a STORED owner — a channel scope's row is then never empty — but the
        // moment a root admin can add the FIRST owner to a channel scope, a torn write there would
        // make that agent claimable by the next person to speak in the channel, and ownership reaches
        // the Tools tab.
        //
        // An operator who removes the last owner has vacated the scope deliberately; re-opening it to
        // whoever speaks next undoes that. Re-seeding is an operator action, not an automatic one.
        ConditionExpression: 'attribute_not_exists(#owners)',
        ExpressionAttributeNames: { '#owners': 'owners' },
        ExpressionAttributeValues: { ':first': { [uid]: { by: 'mention', at } } },
      }));
    } catch (err) {
      // The EXPECTED outcome for every established scope, and by far the common case — every turn to
      // every already-owned agent lands here. Not an error, and not metered as one.
      if (err.name === 'ConditionalCheckFailedException') return 'already-owned';
      log.error({ scopeId, ownerUserId: uid, err: err.message }, 'owners: bootstrapOwner FAILED — retried on this scope\'s next turn');
      if (metrics) metrics.emitOwnerAdded(scopeId, { ownerUserId: uid, by: 'mention', ok: false, errName: err.name });
      return 'failed';
    }
    log.info({ scopeId, ownerUserId: uid, at }, 'owners: first owner set from an @mention');
    if (metrics) metrics.emitOwnerAdded(scopeId, { ownerUserId: uid, by: 'mention', ok: true });
    return 'created';
  }

  return { isOwner, ownedScopes, ownersOf, addOwner, bootstrapOwner };
}

module.exports = { createOwners, ownsOwnScope, ownScopeFor, normaliseUserId, SLACK_USER_ID };

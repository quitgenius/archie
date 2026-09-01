'use strict';

// Per-agent OWNERS — who may manage an agent that is not their own DM agent.
//
// Today that means exactly one thing: who may turn the outbound-comms approval gate off for
// an agent (`canToggleAgent`, opt-toggle-auth.js). It is deliberately NOT wired to anything
// else — archie's Phase-1 posture is that App Home has no general authorization gate
// (index.js, the `handleAgentSelect` comment), and widening this from "who may disable an
// approval flow" to "who may configure an agent" is a separate decision with its own plan.
//
// WHERE THE DATA COMES FROM. `sandra/agents/<name>/slack.json` → `owners: []`, carried into
// `AGENT#<scope>/CONFIG.owners` by the hydrator (config-resolver/migrate-to-ddb.mjs). CONFIG
// rather than META because META is `efsRoot` and nothing else by design, and require_mention
// — the other non-routing slack.json field — set that precedent.
//
// NO NAME TRANSLATION HAPPENS HERE. OpenClaw's equivalent maps owners to config-repo
// directory names; the hydrator already rekeys to the §8.10 scope id inline, so the pk is
// the identifier and `buildOwnerMaps` (verbatim from slack-dispatcher) yields scope-keyed
// maps directly.
//
// TWO READERS, TWO FRESHNESS CONTRACTS, ON PURPOSE:
//
//   ownedAgentsFor(userId)  — a LIST, for rendering. Served from the boot-time scan.
//   isOwner(userId, scope)  — the AUTHORIZATION DECISION. Always a fresh GetItem.
//
// The split follows this codebase's own rule, stated at index.js where requiresMention is
// read: "agentDirectory.has() is the right shape and the wrong source". A cache is fine for
// deciding what to draw; it is not fine for deciding what someone may do. One GetItem per
// human button press is not a budget anyone will notice, and it means a revoked owner loses
// access at the next click rather than at the next restart.
//
// FRESHNESS OF THE LIST IS PUSH-ONLY — no TTL, no setInterval — matching agent-directory.js,
// and for the same reason: a refresh interval is a window in which the cache is knowingly
// wrong and nothing surfaces that. The push signal is `POST /reload`, which is also what the
// OpenClaw dispatcher uses after a config-repo change. KNOWN BOUND, stated rather than
// hidden: owners hydrated by the `archie` CLI while this process is running appear in the
// LIST only after a reload — but they take effect for AUTHORIZATION immediately, because
// isOwner never consults the list. That asymmetry is the point of splitting them.

const { buildOwnerMaps } = require('./routes-owners');

const NOOP_LOG = { info() {}, warn() {}, error() {}, debug() {} };
const AGENT_PK_PREFIX = 'AGENT#';
const MAX_PAGES = 50;

/**
 * @param deps.doc        () => DynamoDBDocumentClient
 * @param deps.tableName  the agent-config table
 * @param deps.log        pino-shaped logger
 */
function createOwnersDirectory({ doc, tableName, log = NOOP_LOG }) {
  let ownedAgents = {};   // OWNER_ID (uppercase) -> [scopeId, …] sorted
  let agentOwners = {};   // scopeId -> [OWNER_ID, …]
  let loaded = false;

  /** Parse an agent CONFIG row's owners, tolerating anything malformed. */
  function ownersOf(item) {
    if (!item || typeof item.data !== 'string') return [];
    let cfg;
    try {
      cfg = JSON.parse(item.data);
    } catch {
      // A single corrupt row must not blank the whole directory. Logged by the caller, which
      // knows which scope it was.
      return null;
    }
    return Array.isArray(cfg && cfg.owners) ? cfg.owners : [];
  }

  /**
   * Boot-time scan. Reads the CONFIG row of every AGENT# scope and rebuilds both maps.
   *
   * Filters on sk server-side so the whole SKILL#* / GRANT#* / CONFIG#* half of the table is
   * never paged back — the table holds far more non-agent rows than agent ones.
   */
  async function load() {
    const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
    const configs = [];
    let ExclusiveStartKey;
    let pages = 0;
    try {
      do {
        const r = await doc().send(new ScanCommand({
          TableName: tableName,
          FilterExpression: '#sk = :cfg',
          // Never a bare attribute name in an expression — the house rule; an unaliased
          // `agent` broke every turn for every agent on 2026-08-13.
          ProjectionExpression: '#pk, #data',
          ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk', '#data': 'data' },
          ExpressionAttributeValues: { ':cfg': 'CONFIG' },
          ExclusiveStartKey,
        }));
        for (const it of r.Items || []) {
          const pk = it && it.pk;
          if (typeof pk !== 'string' || !pk.startsWith(AGENT_PK_PREFIX)) continue;
          const scopeId = pk.slice(AGENT_PK_PREFIX.length);
          if (!scopeId) continue;
          const owners = ownersOf(it);
          if (owners === null) {
            log.warn({ scopeId }, 'owners: unparseable CONFIG row — skipped');
            continue;
          }
          if (owners.length > 0) configs.push({ agentName: scopeId, owners });
        }
        ExclusiveStartKey = r.LastEvaluatedKey;
      } while (ExclusiveStartKey && ++pages < MAX_PAGES);
    } catch (err) {
      // Keep whatever we had. An empty directory would silently hide every owned agent from
      // its owner's selector, which looks like a permissions change rather than a read failure.
      log.error({ err: err.message }, 'owners: scan failed — keeping the previous directory');
      return { agents: Object.keys(agentOwners).length, stale: true };
    }

    ({ agentOwners, ownedAgents } = buildOwnerMaps(configs));
    loaded = true;
    return { agents: Object.keys(agentOwners).length, owners: Object.keys(ownedAgents).length };
  }

  /** Agents this user owns, from the boot-time list. Rendering only — never authorization. */
  function ownedAgentsFor(userId) {
    if (!userId) return [];
    return ownedAgents[String(userId).toUpperCase()] || [];
  }

  /**
   * THE AUTHORIZATION DECISION. Fresh read, every time, no cache.
   *
   * Fails CLOSED on any error: refusing a legitimate owner is a visible annoyance they can
   * retry, whereas allowing a non-owner to disable an approval gate is the thing this
   * function exists to prevent.
   */
  async function isOwner(userId, scopeId) {
    if (!userId || !scopeId) return false;
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    try {
      const r = await doc().send(new GetCommand({
        TableName: tableName,
        Key: { pk: `${AGENT_PK_PREFIX}${scopeId}`, sk: 'CONFIG' },
        ProjectionExpression: '#data',
        ExpressionAttributeNames: { '#data': 'data' },
      }));
      const owners = ownersOf(r.Item);
      if (!owners || owners.length === 0) return false;
      const want = String(userId).toUpperCase();
      // Uppercase BOTH sides. The hydrator normalises on write (normaliseOwners), but a row
      // written before that, or edited by hand, would otherwise be a silent refusal.
      return owners.some((o) => typeof o === 'string' && o.toUpperCase() === want);
    } catch (err) {
      log.warn({ userId, scopeId, err: err.message }, 'owners: isOwner read failed — refusing (fails closed)');
      return false;
    }
  }

  return {
    load,
    ownedAgentsFor,
    isOwner,
    isLoaded: () => loaded,
    _maps: () => ({ agentOwners, ownedAgents }),
  };
}

module.exports = { createOwnersDirectory };

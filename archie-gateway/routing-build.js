'use strict';

// Dispatcher routing aggregation (config-db-migration-plan.md §3b): the per-agent slack
// configs come from the DynamoDB routing GSI (collectFromDdb) and buildRoutes() turns them
// into the routes table. Every agent is served by AgentCore, so all routes are deliverable.

const NOOP_LOG = { info() {}, warn() {}, error() {} };

/**
 * Pure aggregation: [{ agent, cfg }] + env-derived inputs → the routes table
 * (conflict handling, streaming). requireMention/streamingAgents are Sets.
 *
 * THERE IS NO `default` KEY, deliberately — see the §8.10 note below. It is absent rather than
 * null so that a consumer writing `routes.default` is a bug you can grep for, not a value that
 * quietly reads as "no default today" and invites someone to populate it.
 *
 * @returns { dmUsers, channels, requireMention:Set, streamingAgents:Set }
 */
function buildRoutes(agentConfigs, opts = {}) {
  const extraStreamingAgents = opts.extraStreamingAgents || [];
  const log = opts.log || NOOP_LOG;

  const dmUsers = {};
  const channels = {};
  const requireMention = new Set();
  const streamingAgents = new Set();

  for (const { agent: agentName, cfg } of agentConfigs) {
    for (const u of cfg.dm_users || []) {
      if (dmUsers[u] && dmUsers[u] !== agentName) {
        log.warn({ user: u, keeping: dmUsers[u], rejecting: agentName }, 'dm_user conflict');
        continue;
      }
      dmUsers[u] = agentName;
    }
    for (const c of cfg.channels || []) {
      if (channels[c] && channels[c] !== agentName) {
        log.warn({ channel: c, keeping: channels[c], rejecting: agentName }, 'channel conflict');
        continue;
      }
      channels[c] = agentName;
      if (cfg.require_mention) requireMention.add(c);
    }
    if (cfg.streaming !== false) streamingAgents.add(agentName);
    // §8.10 identity=scope: a shared `default` agent is fail-closed OUT, and the concept is now
    // GONE rather than merely unset. Every real event resolves to an explicit route or a minted
    // `dm-`/`ch-` scope agent, so a default could only ever serve an unrouted user into a SHARED
    // persona's session/memory — a cross-user leak.
    //
    // The warning stays even though the field does not: `is_default` is still a legal key in the
    // OpenClaw config repo these agents are migrated from, so silence here would turn a stale
    // config into an invisible no-op. Warn, ignore, never route.
    if (cfg.is_default) log.warn({ agent: agentName }, 'is_default is not supported under identity=scope — ignored (there is no default route)');
  }

  // NO STATIC OVERRIDE LAYER. There was one — a SLACK_ROUTES env map merged on top of these tables
  // for "one-off overrides without a config-repo commit". It is gone, and the reason is that under
  // §8.10 identity=scope it had no remaining job: an unrouted event MINTS its own `dm-`/`ch-` scope
  // agent (see resolveAgent), so there is nothing to rescue with a manual pin. Its only interesting
  // key, `default`, was already rejected here for cross-user leak reasons, and no environment ever
  // set the variable — archie shipped `{}` everywhere.
  //
  // Pinning a channel to a specific agent is expressible in the config repo (that agent's
  // slack.json), which is reviewable; an env map on the gateway was not.

  for (const name of extraStreamingAgents) streamingAgents.add(name);

  return { dmUsers, channels, requireMention, streamingAgents };
}

/**
 * DDB source (config-DB migration, Phase 2.3): read routing from the agent-config routing
 * GSI → [{ agent, cfg }]. `doc` is a DynamoDBDocumentClient, injected so this module stays
 * aws-sdk-free + unit-testable. GSI/attr names mirror config-resolver/schema.mjs; the body is
 * an opaque JSON string under `data`. Sorted by agent id for deterministic first-writer-wins.
 */
async function collectFromDdb(doc, tableName, deps = {}) {
  const log = deps.log || NOOP_LOG;
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: tableName,
      IndexName: 'routing',
      KeyConditionExpression: 'gsi1pk = :r',
      ExpressionAttributeValues: { ':r': 'ROUTING' },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) {
      let cfg;
      try { cfg = JSON.parse(it.data); } catch (err) {
        log.error({ agent: it.gsi1sk, err: err.message }, 'skipping malformed routing META');
        continue;
      }
      out.push({ agent: it.gsi1sk, cfg });
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  out.sort((a, b) => (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0));
  return out;
}

module.exports = { buildRoutes, collectFromDdb };

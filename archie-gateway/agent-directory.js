'use strict';

// THE AGENT LIST: the distinct `AGENT#<scope>` partition keys, and the label format the selector
// renders them in. Nothing else. No state, no Slack, no cache.
//
// It used to also BE a directory — a boot-time roster plus a name cache plus a search index, kept
// current by Slack rename events and `POST /reload`. All of that is gone: the App Home selector now
// resolves the viewer's owned scopes fresh from DynamoDB on every render (owners.js) and labels them
// fresh from Slack (agent-labels.js). The cache could only ever be right between a hydrate and a
// restart, and its repair path was unreachable from outside the VPC.
//
// `scanAgentScopes` stays here and stays exported: it is the fleet enumerator the `archie` CLI reads
// (lib/agents.js, cmd/wrappers.js) and `agent-migrate.js` with it. AGENT# IS the agent list — not the
// routing GSI, which was deleted for being unable to see a minted agent, and not RUNTIME#.

const AGENT_PK_PREFIX = 'AGENT#';

// Slack caps an option's `text` at 75 chars. The scope id is never the part that gets dropped: it is
// what disambiguates two people with the same display name, and it is the value an operator needs to
// cross-check against DynamoDB.
const OPTION_TEXT_MAX = 75;

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
 * EVERY AGENT: the distinct `AGENT#<scope>` partition keys. THE agent list, for this module and for
 * the `archie` CLI, which imports it from here.
 *
 * It lives in the gateway rather than the CLI on purpose: the CLI already requires gateway modules
 * (that is the established direction — `runtime-registry`, `spec-diff`, `agentcore-client`), and the
 * gateway's lint stage only copies `archie-gateway/`, so a require pointing the other way fails the
 * build. It also replaced `routing-build.collectFromDdb`, which lived here for exactly these reasons.
 *
 * ProjectionExpression does not reduce the read cost — DynamoDB bills the whole item either way — it
 * reduces the payload, which matters because SEED rows carry a whole workspace skeleton.
 *
 * Sorted, so callers that report or iterate are deterministic.
 */
async function scanAgentScopes(doc, tableName) {
  const { ScanCommand, GetCommand } = require('@aws-sdk/lib-dynamodb');
  const rows = new Map(); // scope -> Set(sk)
  let ExclusiveStartKey;
  let pages = 0;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: tableName,
      // NEVER a bare attribute name in an expression. `pk` is not itself reserved, but the rule is
      // uniform because knowing the reserved-word list by heart is not a control: an unaliased
      // `agent` broke every turn for every agent on 2026-08-13.
      ProjectionExpression: '#pk, #sk',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) {
      const pk = it && it.pk;
      if (typeof pk === 'string' && pk.startsWith(AGENT_PK_PREFIX)) {
        const scope = pk.slice(AGENT_PK_PREFIX.length);
        if (!scope) continue;
        if (!rows.has(scope)) rows.set(scope, new Set());
        if (typeof it.sk === 'string') rows.get(scope).add(it.sk);
      }
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey && ++pages < MAX_PAGES);

  // ONE `AGENT#…` partition is not an agent: the cron LEGACY-NAME ALIAS, keyed by an agent's
  // config-repo directory name rather than its scope id, holding `{ alias: "<scopeId>" }` so the
  // OpenClaw cron gate can bridge the two identities (cron-runner-flag.js setAlias). Counting it
  // as an agent hands every enumerator a scope that does not exist — `deploy` stages a runtime for
  // it, `teardown` DELETES THE POINTER OpenClaw's gate reads, and the App Home selector offers it.
  //
  // The test is the body, not the name: a legacy name is not distinguishable from a scope id by
  // shape (`bdd-tests` and `test-agent` are both real agents). An alias row carries `alias` and no
  // `runner`; the runner row carries `runner`. Only CRON-ONLY partitions can be ambiguous — any
  // partition with a second sk is an agent whose CRON row is its runner flag — so this costs one
  // GetItem for each of a handful of keys, never a second scan.
  const candidates = [...rows].filter(([, sks]) => sks.size === 1 && sks.has('CRON')).map(([s]) => s);
  const aliases = new Set();
  for (const scope of candidates) {
    let body = null;
    try {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: { pk: `${AGENT_PK_PREFIX}${scope}`, sk: 'CRON' } }));
      body = r && r.Item && r.Item.data ? JSON.parse(r.Item.data) : null;
    } catch {
      // Unreadable/unparseable: KEEP it. Over-listing shows an operator a scope to ask about;
      // dropping one hides an agent, and hidden agents are what this whole scan exists to end.
      continue;
    }
    if (body && body.alias && !body.runner) aliases.add(scope);
  }
  return [...rows.keys()].filter((s) => !aliases.has(s)).sort();
}

/**
 * @param deps.tableName the single config table (AGENT_CONFIG_TABLE).
 * @param deps.doc       () => DynamoDBDocumentClient — a GETTER, so the client stays lazy and tests
 *                       can inject a fake without constructing an SDK client.
 * @param deps.slack     a @slack/web-api-shaped client (users.list/info, conversations.list/info).
 * @param deps.logger    pino-shaped.
 */
module.exports = { scanAgentScopes, composeLabel, OPTION_TEXT_MAX };

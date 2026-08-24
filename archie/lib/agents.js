'use strict';

// THE AGENT LIST. One implementation, for every command that needs to know which agents exist.
//
// `AGENT#<scope>` partition keys ARE the set of agents. Minting writes POLICY/SEED/MARKETPLACE/
// CONNECTOR under them, so nothing is ever missing. That is the whole rule.
//
// WHAT THIS REPLACED, AND WHY IT MATTERED. Six commands used to ask the `routing` GSI for this list:
// stage, policy, image, status, agent, and the gateway's agent-migrate. That index only contains an
// agent if it has an `AGENT#<scope>/META` row, and META is written ONLY by config-repo hydration — so
// every MINTED agent (the normal path: a Slack event with no explicit route, `mintAgentName` derives
// the scope, it provisions on demand) is invisible to it permanently.
//
// Measured 2026-08-24 in the sandbox sandbox: the index returned 0 agents while 3 were serving traffic.
// `archie deploy` therefore staged "0 of 3", published an unverified tag, and refused at its own
// "never been staged" gate — the agent half of the deploy did nothing at all, and had not for weeks.
//
// DO NOT reintroduce a union with `RUNTIME#`. `cmd/policy.js` merged the two and its comment reads
// "routing held 2 and runtimes held 4"; that is evidence BOTH lists are wrong, not that both are
// needed. `RUNTIME#` is image-binding state — which runtime name holds which image tag — and says
// nothing about which agents exist.

const AGENT_PK_PREFIX = 'AGENT#';

// A malformed or looping cursor cannot spin forever. The table is small (order-of-1500 items in prod),
// so this is a backstop, not a limit anyone should reach.
const MAX_PAGES = 50;

/**
 * Every agent, as `[{ agent }]`.
 *
 * The shape matches what `routing-build.collectFromDdb` returned (`{ agent, cfg }` minus `cfg`) so
 * callers keep working with `.map((r) => r.agent)` and the `deps.collectAgents` injection points in
 * `stage.js` / `image.js` stay valid without touching their tests.
 *
 * `ProjectionExpression: 'pk'` does not reduce the read cost — DynamoDB bills the whole item either
 * way — it reduces the payload, which matters because SEED rows carry a whole workspace skeleton.
 *
 * Sorted, so callers that report or iterate are deterministic (the GSI query this replaces sorted for
 * the same reason: first-writer-wins in `buildRoutes` had to be stable).
 *
 * @param doc        a DynamoDBDocumentClient
 * @param tableName  the agent-config table
 */
async function listAgents(doc, tableName) {
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const found = new Set();
  let ExclusiveStartKey;
  let pages = 0;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: tableName,
      // NEVER a bare attribute name in an expression. `pk` is not itself reserved, but the rule is
      // uniform because knowing the reserved-word list by heart is not a control: an unaliased
      // `agent` broke every turn for every agent on 2026-08-13, and cmd/stage.test.js's fake asserts
      // aliasing on every expression it is handed precisely so that cannot recur.
      ProjectionExpression: '#pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
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
  return [...found].sort().map((agent) => ({ agent }));
}

module.exports = { listAgents, AGENT_PK_PREFIX };

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

const { scanAgentScopes } = require('../../archie-gateway/agent-directory');

/**
 * Every agent, as `[{ agent }]`.
 *
 * A thin adapter over the gateway's `scanAgentScopes` — REUSE, not a second implementation, which is
 * the rule this CLI follows and the reason `collectFromDdb` used to be imported from there too. The
 * `{ agent }` shape matches what that returned minus `cfg`, so callers keep working with
 * `.map((r) => r.agent)` and the `deps.collectAgents` injection points in stage.js / image.js stay
 * valid without touching their tests.
 */
async function listAgents(doc, tableName) {
  return (await scanAgentScopes(doc, tableName)).map((agent) => ({ agent }));
}

module.exports = { listAgents };

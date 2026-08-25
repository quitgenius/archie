// The per-turn CONFIG fingerprint: "has anything that changes how this agent resolves moved since
// the warm session was built?" Its sibling is `skillFingerprint` (skill-scope.mjs), which answers
// the same question for the /tmp skill materialisation.
//
// PURE AND IMPORTABLE, deliberately — the same shape as skill-scope.mjs. It used to live in
// pi-adapter.mjs, which cannot be imported by a test: `boot()` runs at module load, so importing it
// starts the agent and the process never exits. A fingerprint whose only guard was "read the code
// carefully" is exactly the thing that already shipped one silent bug (see below), so it lives
// where it can be tested.
//
// THE TWO INPUTS:
//
//   agent        AGENT#<id>/CONFIG — the per-agent openclaw override.
//   marketplace  AGENT#<id>/MARKETPLACE — THE WHOLE ITEM, not a slice of it.
//
// HASHING THE WHOLE ITEM IS THE POINT, and it is the fix for a bug that has now happened twice.
//
// This used to take `model` — just the `.models` slice — and before 2026-08-15 it took nothing from
// the marketplace item at all. Each time, the failure was identical and invisible: a field on that
// item feeds config resolution, nothing hashes it, so a change flips NEITHER fingerprint, the warm
// session takes the fast path, and the agent keeps serving the old resolution until its microVM is
// replaced for some unrelated reason. The Slack UI papered over it with "your agent will briefly
// restart" — copy inherited from the ECS era, where the dispatcher really did StopTask the task to
// force a re-read. Under AgentCore nothing does.
//
//   2026-08-15  `.models` — picking a model in Slack kept answering on the old model.
//   2026-08-24  `.connectors` — installing a connector (Notion) left the agent without its toolkit.
//               plugin-slice.mjs:100: "Connectors the agent has authorised through the marketplace
//               — the slug IS the toolkit." So the install landed in DynamoDB and the running agent
//               told its owner the toolkit was restricted.
//
// The pattern is a hand-maintained mirror of a dependency set: every future field that resolution
// consumes has to be remembered HERE too, and the failure for forgetting is silent. So it stops
// being a list. `readAgentMarketplace()` already returns the whole item and readSkillState already
// holds it in memory — the reads were never the cost, the cherry-picking was. Hashing all of it
// costs one sortedJson over an object we have, and covers every field by construction.
//
// The one accepted consequence: `installs` is now hashed here as well as by `skillFingerprint`, so a
// skill install re-resolves the config in addition to re-hydrating /tmp. That is CORRECT, not waste
// — plugin-slice.mjs:92-97 derives connector toolkits from skills' `requires.connectorToolkits`, so a
// skill install can change the toolkit list, which only a config re-resolve picks up. Under the old
// split that was a third instance of the same bug, waiting.
//
// The FLEET BASE is deliberately NOT an input. It was, until it became the constant
// `schema.mjs BASE_MAIN`; a constant cannot change between turns, so hashing it bought nothing and
// cost a DynamoDB read on every message.

import { createHash } from 'node:crypto';

/**
 * Order-insensitive JSON. Both items are decoded fresh from DynamoDB each turn, so attribute order
 * is not stable — hashing `JSON.stringify` directly would re-resolve on essentially every message.
 */
export function sortedJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(sortedJson).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${sortedJson(v[k])}`).join(',')}}`;
}

/**
 * @param agent        AGENT#<id>/CONFIG body, or null
 * @param marketplace  AGENT#<id>/MARKETPLACE body IN FULL (installs, connectors, models, customMcp,
 *                     and anything added later), or null when the agent has no marketplace item
 */
export function configFingerprint(agent, marketplace) {
  return createHash('sha1')
    .update(sortedJson({ agent: agent ?? null, marketplace: marketplace ?? null }))
    .digest('hex')
    .slice(0, 16);
}

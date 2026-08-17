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
// THE TWO INPUTS, and why the second one is not obvious:
//
//   agent  AGENT#<id>/CONFIG — the per-agent openclaw override.
//   model  AGENT#<id>/MARKETPLACE `.models` — what the App Home "Models" tab writes.
//
// The model half was missing until 2026-08-15, and its absence was invisible in the worst way. The
// generator resolves the marketplace pick AHEAD of the agent's own config:
//
//     marketplaceModel?.modelId ? `amazon-bedrock/${modelId}` : models[agent.model] || agent.model
//
// so it decides which model the turn runs on. But it lives on the MARKETPLACE item, and
// `skillFingerprint` hashes only that item's `installs` slice. So picking a model in Slack flipped
// neither fingerprint: the warm session took the fast path and kept answering on the old model
// until the microVM happened to be replaced for an unrelated reason. The Slack UI papered over it
// with "your agent will briefly restart" — copy inherited from the ECS era, where the dispatcher
// really did StopTask the agent's task to make it re-read git. Under AgentCore nothing does.
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
 * @param agent  AGENT#<id>/CONFIG body, or null
 * @param model  AGENT#<id>/MARKETPLACE `.models` body, or null when nothing is picked
 */
export function configFingerprint(agent, model) {
  return createHash('sha1')
    .update(sortedJson({ agent: agent ?? null, model: model ?? null }))
    .digest('hex')
    .slice(0, 16);
}

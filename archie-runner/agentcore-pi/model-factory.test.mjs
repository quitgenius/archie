// getModel's resolution ladder: catalog -> nearest catalogued sibling -> Bedrock Claude factory.
//
// WHY THIS MATTERS MORE THAN IT USED TO. pi-adapter's loadConfig is now FATAL, so a model the
// catalog cannot resolve is a crash-looping agent, not a degraded one. pi-ai 0.61.1 carries no
// `claude-*-5` at all and no opus above 4-6 — and neither does 0.70.2, the version OpenClaw itself
// bundles, so a version bump does not fix it. Meanwhile the account can invoke sonnet-5, opus-5 and
// opus-4-8 today. Without the factory, pointing the fleet default at Sonnet 5 would crash every
// minted agent.
//
// The order is load-bearing and each rung is asserted below: the catalog is preferred because its
// metadata is real; the sibling is preferred over the factory because it is a measured relative;
// the factory is last because its context/token figures are a table.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModel } from './pi-runtime.mjs';

const src = (m) => m._synthesisedBy || (m._synthesisedFrom ? 'sibling' : 'catalog');

test('the catalog wins when it has the model', () => {
  const m = getModel('global.anthropic.claude-sonnet-4-6');
  assert.equal(src(m), 'catalog');
  assert.equal(m.cost.input, 3);      // real catalog metadata, not ours
});

test('a catalogued sibling beats the factory', () => {
  // opus-4-8 matches <family>-<major>-<minor>, so it clones opus-4-6-v1 rather than being built.
  const m = getModel('global.anthropic.claude-opus-4-8');
  assert.equal(src(m), 'sibling');
  assert.equal(m.id, 'global.anthropic.claude-opus-4-8'); // the REQUESTED id is what Converse uses
});

test('the factory resolves ids no sibling can match', () => {
  // `-5` has no minor for the sibling pattern; `fable` has no family in the catalog at all.
  for (const id of ['global.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-5', 'us.anthropic.claude-fable-5']) {
    const m = getModel(id);
    assert.equal(m.id, id);
    assert.equal(m.api, 'bedrock-converse-stream');
    assert.equal(m.provider, 'amazon-bedrock');
    assert.ok(m.contextWindow > 0 && m.maxTokens > 0);
  }
});

// AWS's published figures, us-east-1, offer AmazonBedrockFoundationModels (2026-08-14). Pinned as
// literals so a table edit has to be deliberate: pi-ai computes each turn's USD from `model.cost`,
// so these numbers ARE the fleet's cost telemetry.
test('factory prices match AWS, and the regional premium is applied', () => {
  const g = getModel('global.anthropic.claude-sonnet-5');
  assert.deepEqual(g.cost, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 });
  const r = getModel('us.anthropic.claude-sonnet-5');
  assert.deepEqual(r.cost, { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 });
});

// The rule this protects: "a made-up cost that looks real is worse than a missing datapoint"
// (pi-adapter resolveTurnCostUsd). An unknown family must carry NO cost, so pi-ai reports none and
// TurnCostUsd is simply not emitted — rather than a plausible, wrong number reaching a spend board.
test('an unpriced family resolves but carries NO cost', () => {
  const m = getModel('global.anthropic.claude-mythos-9');
  assert.equal(src(m), 'factory:unpriced');
  assert.equal(m.cost, undefined);
  // Conservative context: under-stating makes Pi compact early; over-stating builds requests
  // Bedrock rejects. A degraded turn beats a failed one.
  assert.ok(m.contextWindow <= 200000);
  assert.ok(m.maxTokens <= 8192);
});

test('a non-Claude or malformed id still throws — the factory is not a catch-all', () => {
  for (const id of ['not-a-model', 'amazon.titan-text-express-v1', '']) {
    assert.throws(() => getModel(id), /not in Pi catalog/, `${id} should not resolve`);
  }
});

// The whole point of the exercise: the value about to become the fleet default must resolve.
test('the fleet default model resolves', async () => {
  const { BASE_MAIN } = await import('../config-resolver/schema.mjs');
  const spec = BASE_MAIN().model;                       // "amazon-bedrock/<id>"
  const id = spec.slice(spec.indexOf('/') + 1);
  const m = getModel(id);
  assert.equal(m.id, id);
  assert.ok(m.cost, 'the fleet default must be PRICED — every agent in the fleet run on it and TurnCostUsd would '
    + 'silently stop being emitted for all of them');
});

// ── thinking API compatibility (found live, 2026-08-15) ─────────────────────────────────────────

test('every synthesised Claude declares reasoning — including Claude 5', () => {
  // Claude 5 turns failed in ~1s under the unpatched pi-ai, which sends the legacy
  // `thinking.type: "enabled"` block that those models reject. The fix is NOT to turn thinking off:
  // agentcore-pi/patch-pi-ai-adaptive-thinking.mjs widens pi-ai's `supportsAdaptiveThinking` at image
  // build time so Claude 5 takes the adaptive branch. This asserts the half that lives here — that
  // the model still asks for thinking — and the patch script self-verifies the half that lives there.
  for (const id of ['us.anthropic.claude-sonnet-5', 'global.anthropic.claude-opus-5',
    'global.anthropic.claude-fable-5', 'anthropic.claude-opus-4-8', 'us.anthropic.claude-opus-4-7']) {
    assert.equal(getModel(id).reasoning, true, `${id} must request thinking`);
  }
});

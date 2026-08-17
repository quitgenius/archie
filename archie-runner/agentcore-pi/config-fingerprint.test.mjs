// The per-turn config fingerprint — what decides whether a warm session keeps serving, or
// re-resolves openclaw.json and rebuilds.
//
// WHY THIS FILE EXISTS. The App Home "Models" tab writes the picked model to
// AGENT#<id>/MARKETPLACE `.models` (marketplace.js setModel), and the generator resolves it AHEAD
// of the agent's own config: `marketplaceModel?.modelId ? 'amazon-bedrock/'+id : models[agent.model]`.
// So it decides which model the turn runs on.
//
// It used to be invisible to both fingerprints. `skillFingerprint` hashes only the `installs`
// slice of that item, and the config fingerprint read only AGENT#<id>/CONFIG — so picking a model
// in Slack flipped NEITHER, the warm session took the fast path, and the old model kept answering
// until the microVM was replaced for some unrelated reason. That is what the old UI copy ("your
// agent will briefly restart") was really describing, and under ECS it was true: the dispatcher
// called StopTask. Under AgentCore nothing does.
//
// These tests are the guard on that: a model change MUST flip the config fingerprint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configFingerprint } from './config-fingerprint.mjs';

const AGENT_CFG = { model: 'default', tools: { alsoAllow: ['read', 'write'] } };
const PICKED = { modelId: 'global.anthropic.claude-opus-4-8', modelName: 'Claude Opus 4.8', selectedAt: '2026-08-15T10:00:00Z', selectedBy: 'U1' };

test('picking a model flips the fingerprint — the next turn re-resolves', () => {
  const before = configFingerprint(AGENT_CFG, null);
  const after = configFingerprint(AGENT_CFG, PICKED);
  assert.notEqual(before, after, 'a model selection did not flip the config fingerprint — the warm '
    + 'session would keep serving the old model, which is the bug this covers');
});

test('switching between two models flips it, and resetting returns to the original', () => {
  const a = configFingerprint(AGENT_CFG, PICKED);
  const b = configFingerprint(AGENT_CFG, { ...PICKED, modelId: 'global.anthropic.claude-sonnet-4-6' });
  assert.notEqual(a, b, 'switching models must re-resolve');
  // Reset (setModel deletes `.models`) has to land back on the unpicked fingerprint, or the agent
  // would re-resolve every turn forever after a reset.
  assert.equal(configFingerprint(AGENT_CFG, null), configFingerprint(AGENT_CFG, undefined));
});

test('unchanged inputs are stable — the fast path stays fast', () => {
  assert.equal(configFingerprint(AGENT_CFG, PICKED), configFingerprint(AGENT_CFG, PICKED));
  // Key order must not matter: the item is JSON-decoded fresh each turn, so an attribute-order
  // difference would otherwise re-resolve on every message.
  const reordered = { selectedBy: 'U1', selectedAt: PICKED.selectedAt, modelName: PICKED.modelName, modelId: PICKED.modelId };
  assert.equal(configFingerprint(AGENT_CFG, PICKED), configFingerprint(AGENT_CFG, reordered));
});

test('the agent config half still counts — a tool-allow change re-resolves', () => {
  const changed = { ...AGENT_CFG, tools: { alsoAllow: ['read'] } };
  assert.notEqual(configFingerprint(AGENT_CFG, PICKED), configFingerprint(changed, PICKED));
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getModel as catalogModel } from '@mariozechner/pi-ai';
import { getModel } from './pi-runtime.mjs';
import { CHAT_MODEL_IDS, UNAVAILABLE_MODELS, isSelectableModel } from './bedrock-model-registry.mjs';
import { refreshSessionConfig } from './session-config-refresh.mjs';

test('every retained chat profile resolves with its exact Bedrock invocation ID', () => {
  for (const base of CHAT_MODEL_IDS) {
    for (const prefix of ['us.', 'global.']) {
      const id = prefix + base;
      const model = getModel(id);
      assert.equal(model.id, id);
      assert.equal(model.provider, 'amazon-bedrock');
      assert.equal(model.api, 'bedrock-converse-stream');
      assert.ok(model.contextWindow > model.maxTokens);
    }
  }
});

test('regional Nova definition preserves catalog capabilities without mutating it', () => {
  const original = catalogModel('amazon-bedrock', 'amazon.nova-micro-v1:0');
  const before = structuredClone(original);
  const model = getModel('us.amazon.nova-micro-v1:0');
  assert.equal(model.contextWindow, original.contextWindow);
  assert.deepEqual(model.input, ['text']);
  assert.deepEqual(original, before);
  assert.notEqual(model, original);
});

test('picker only allows retained US chat models that passed runtime compatibility checks', () => {
  for (const id of ['us.openai.gpt-5.6-sol', 'us.openai.gpt-6-astra', 'us.amazon.nova-micro-v1:0', 'us.xai.grok-4.6']) assert.ok(isSelectableModel(id));
  for (const id of ['global.openai.gpt-5.6-sol', 'us.cohere.embed-v4:0', 'us.stability.stable-image-inpaint-v1:0', 'us.meta.llama3-1-8b-instruct-v1:0', 'us.deepseek.r1-v1:0', 'us.writer.palmyra-x4-v1:0', 'us.mistral.pixtral-large-2502-v1:0', 'us.openai.typo', null]) assert.equal(isSelectableModel(id), false);
  for (const id of Object.keys(UNAVAILABLE_MODELS)) assert.equal(isSelectableModel(`us.${id}`), false);
});

test('new OpenAI cost is explicitly unknown, never a fabricated free invocation', () => {
  assert.ok(Number.isNaN(getModel('us.openai.gpt-5.6-sol').cost.input));
});

test('first turn after prewarm reloads rather than stamping a fingerprint on an old model', async () => {
  let model = 'claude';
  const refreshed = await refreshSessionConfig({ fp: null }, 'openai-selection', async () => {
    model = 'openai';
    return { model };
  });
  assert.equal(model, 'openai');
  assert.equal(refreshed.state.fp, 'openai-selection');
  assert.equal(refreshed.info.model, 'openai');
});

test('unchanged config avoids reload; failed reload cannot acknowledge the new selection', async () => {
  const previous = { fp: 'old' };
  const same = await refreshSessionConfig(previous, 'old', () => { throw new Error('must not reload'); });
  assert.equal(same.state, previous);
  await assert.rejects(refreshSessionConfig(previous, 'new', async () => { throw new Error('unsupported model'); }), /unsupported model/);
  assert.deepEqual(previous, { fp: 'old' });
});

test('US Fable 5 and 5.1 are selectable; global Fable remains blocked', () => {
  assert.equal(isSelectableModel('us.anthropic.claude-fable-5'), true);
  assert.equal(isSelectableModel('global.anthropic.claude-fable-5'), false);
  assert.equal(isSelectableModel('us.anthropic.claude-fable-5-1'), true);
});

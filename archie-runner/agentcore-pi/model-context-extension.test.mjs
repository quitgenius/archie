import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelContextExtension } from './model-context-extension.mjs';

test('identity follows the live model across selection and temporary overrides', () => {
  let handler;
  createModelContextExtension()({ on: (event, fn) => {
    assert.equal(event, 'before_agent_start');
    handler = fn;
  } });
  const event = { systemPrompt: 'Keep the existing assistant instructions.' };
  const ctx = { model: undefined };
  assert.equal(handler(event, ctx), undefined);
  for (const id of ['us.xai.grok-4.6', 'us.openai.gpt-5.6-sol', 'us.amazon.nova-micro-v1:0', 'us.xai.grok-4.6']) {
    ctx.model = { id, provider: 'amazon-bedrock' };
    const { systemPrompt } = handler(event, ctx);
    assert.ok(systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
    const metadata = JSON.parse(systemPrompt.match(/<active_model>\n(.*?)\n<\/active_model>/s)[1]);
    assert.deepEqual(metadata, { modelId: id, runtimeProvider: 'amazon-bedrock' });
    assert.equal(systemPrompt.match(/<active_model>/g).length, 1);
  }
  assert.equal(event.systemPrompt, 'Keep the existing assistant instructions.');
});

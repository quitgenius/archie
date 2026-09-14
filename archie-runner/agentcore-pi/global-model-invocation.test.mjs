import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, withModel } from './pi-runtime.mjs';

test('saved Global models are rejected before Pi can send a request', async () => {
  for (const id of ['global.anthropic.claude-sonnet-4-6', 'global.openai.gpt-5.6-sol', 'global.xai.grok-4.6']) {
    let invoked = false;
    const session = { model: { id }, prompt: async () => { invoked = true; } };
    await assert.rejects(runTurn(session, 'hello'), /Global Bedrock profiles are disabled/);
    assert.equal(invoked, false);
  }
});

test('Global cron overrides cannot invoke and restore the previous model', async () => {
  const previous = { id: 'us.openai.gpt-5.6-sol' };
  let invoked = false;
  const session = {
    model: previous,
    setModel: async (model) => { session.model = model; },
    prompt: async () => { invoked = true; },
  };
  await assert.rejects(withModel(session, 'global.openai.gpt-5.6-sol', () => runTurn(session, 'hello')), /Global Bedrock profiles are disabled/);
  assert.equal(invoked, false);
  assert.equal(session.model, previous);
});

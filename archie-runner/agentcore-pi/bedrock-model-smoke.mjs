// Explicit live smoke test: AWS_PROFILE=austin AWS_REGION=us-east-1 node bedrock-model-smoke.mjs --all
// Synthetic text and a locally fulfilled echo tool only; never reads agent data or posts to Slack.
import assert from 'node:assert/strict';
import { streamSimple, Type } from '@mariozechner/pi-ai';
import { getModel } from './pi-runtime.mjs';
import { CHAT_MODEL_IDS } from './bedrock-model-registry.mjs';
const args = process.argv.slice(2);
const ids = args.includes('--all') ? [...CHAT_MODEL_IDS].map(id => `us.${id}`) : args;
if (!ids.length) throw new Error('Pass model IDs or --all to authorize live Bedrock smoke calls.');
const results = [];
async function probe(id) {
  const model = getModel(id);
  const tools = [{ name: 'echo', description: 'Return the supplied text.', parameters: Type.Object({ text: Type.String() }) }];
  const messages = [{ role: 'user', content: 'Call the echo tool with text MODEL_SMOKE_OK. After receiving its result, reply with that exact text.', timestamp: Date.now() }];
  const options = { maxTokens: 1024, signal: AbortSignal.timeout(45000) };
  const first = await streamSimple(model, { systemPrompt: 'Follow the user request using the provided tool.', messages, tools }, options).result();
  assert.equal(first.model, id);
  assert.notEqual(first.stopReason, 'error', first.errorMessage);
  const call = first.content.find(c => c.type === 'toolCall');
  assert.ok(call, `No tool call: ${JSON.stringify(first.content)}`);
  assert.equal(call.name, 'echo');
  const result = await streamSimple(model, { tools, messages: [...messages, first, {
    role: 'toolResult', toolCallId: call.id, toolName: call.name,
    content: [{ type: 'text', text: 'MODEL_SMOKE_OK' }], isError: false, timestamp: Date.now(),
  }] }, { ...options, signal: AbortSignal.timeout(45000) }).result();
  assert.equal(result.model, id);
  assert.notEqual(result.stopReason, 'error', result.errorMessage);
  assert.ok(result.content.some(c => c.type === 'text' && c.text.includes('MODEL_SMOKE_OK')));
  return { id, status: 'passed', model: result.model, stopReason: result.stopReason };
}
let cursor = 0;
await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
  while (cursor < ids.length) {
    const id = ids[cursor++];
    let result;
    try { result = await probe(id); } catch (err) { result = { id, status: 'failed', error: err.message }; }
    results.push(result);
    console.log(JSON.stringify(result));
  }
}));
if (results.some(r => r.status === 'failed')) process.exitCode = 1;

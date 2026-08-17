// Unit test for runTurn's streaming forwarding + buffered back-compat (Phase 1, no AWS).
// Drives runTurn with a FAKE AgentSession that emits a scripted event sequence, and asserts:
//   (A) with onEvent: ordered delta (ACCUMULATED text) + tool events, and NO final from runTurn;
//   (B) without onEvent: the returned aggregate is byte-identical (buffered path unaffected);
//   (C) a tool error maps to status 'error'.
// Self-contained: points PI_VENDOR_DIR at the sibling vendored Pi dist so pi-runtime's eager
// imports resolve, then dynamic-imports runTurn.  Run:  node pi-runtime-stream-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
process.env.PI_VENDOR_DIR ||= join(here, '..', 'connector-session-plugin', 'node_modules', '@mariozechner');
const { runTurn } = await import('./pi-runtime.mjs');

// Fake AgentSession: subscribe stores the listener; prompt() replays a scripted sequence to it.
function fakeSession(script) {
  let listener = null;
  return {
    subscribe(fn) { listener = fn; return () => { listener = null; }; },
    async prompt() { for (const ev of script) if (listener) listener(ev); },
  };
}

// Real AgentSession event shapes: streaming deltas arrive as `message_update` carrying the
// accumulated partial message (NOT raw text_delta — see pi-agent-core agent-loop.js).
const SCRIPT = [
  { type: 'message_start', message: { role: 'assistant', content: [] } },
  { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hel' }] } },
  { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello' }] } },
  { type: 'tool_execution_start', toolCallId: 'tc1', toolName: 'read', args: {} },
  { type: 'tool_execution_end', toolCallId: 'tc1', toolName: 'read', result: {}, isError: false },
  { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] } },
  { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }], stopReason: 'end_turn', usage: { input: 3, output: 5 }, model: 'claude-sonnet-4-6' } },
];
const EXPECTED = { text: 'Hello world', stopReason: 'end_turn', usage: { input: 3, output: 5 }, model: 'claude-sonnet-4-6' };

// Aggregate check: the scalar fields must match EXPECTED byte-for-byte; toolCalls/modelCalls
// (added by P1 / the Bedrock-call spans) carry wall-clock timestamps, so assert their SHAPE.
function assertAggregate(out, label) {
  const { text, stopReason, usage, model, errorMessage, toolCalls, modelCalls } = out;
  assert.deepEqual({ text, stopReason, usage, model }, EXPECTED, `${label}: scalar aggregate`);
  assert.equal(errorMessage, null, `${label}: no errorMessage`);
  assert.equal(toolCalls.length, 1, `${label}: one tool call captured`);
  assert.deepEqual(
    { id: toolCalls[0].id, name: toolCalls[0].name, isError: toolCalls[0].isError },
    { id: 'tc1', name: 'read', isError: false }, `${label}: tool call shape`);
  assert.ok(toolCalls[0].endMs >= toolCalls[0].startMs, `${label}: tool timing sane`);
  // One assistant message_end = one model request (one Bedrock call span).
  assert.equal(modelCalls.length, 1, `${label}: one model call captured`);
  const mc = modelCalls[0];
  assert.deepEqual(
    { model: mc.model, stopReason: mc.stopReason, usage: mc.usage, isError: mc.isError },
    { model: 'claude-sonnet-4-6', stopReason: 'end_turn', usage: { input: 3, output: 5 }, isError: false },
    `${label}: model call carries per-request model/stopReason/usage`);
  assert.ok(mc.endMs >= mc.startMs, `${label}: model-call timing sane`);
  assert.ok(mc.firstTokenMs === null || (mc.firstTokenMs >= mc.startMs && mc.firstTokenMs <= mc.endMs),
    `${label}: firstTokenMs within the request window when set`);
}

// (A) streaming
{
  const events = [];
  const out = await runTurn(fakeSession(SCRIPT), 'hi', (ev) => events.push(ev));
  assert.deepEqual(events.filter((e) => e.type === 'delta').map((e) => e.text),
    ['Hel', 'Hello', 'Hello world'], 'delta events must carry ACCUMULATED text');
  assert.deepEqual(events.filter((e) => e.type === 'tool'), [
    { type: 'tool', itemId: 'tc1', title: 'read', status: 'running' },
    { type: 'tool', itemId: 'tc1', title: 'read', status: 'done' },
  ], 'tool start/end → running/done');
  assert.equal(events.some((e) => e.type === 'final'), false, 'runTurn must NOT emit final (adapter owns it)');
  assertAggregate(out, 'streaming');
  assert.ok(out.modelCalls[0].firstTokenMs !== null, 'streaming: message_update sets firstTokenMs (TTFT)');
}

// (B) buffered back-compat — identical aggregate, no onEvent
{
  const out = await runTurn(fakeSession(SCRIPT), 'hi');
  assertAggregate(out, 'buffered');
}

// (B2) multi-request (tool-loop) turn: two assistant messages = two model calls, per-request usage
{
  const out = await runTurn(fakeSession([
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'step one ' }], stopReason: 'toolUse', usage: { input: 10, output: 2 }, model: 'claude-sonnet-4-6' } },
    { type: 'tool_execution_start', toolCallId: 'tc9', toolName: 'read', args: {} },
    { type: 'tool_execution_end', toolCallId: 'tc9', toolName: 'read', result: {}, isError: false },
    { type: 'message_start', message: { role: 'assistant', content: [] } },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage: { input: 15, output: 4 }, model: 'claude-sonnet-4-6' } },
  ]), 'x');
  assert.equal(out.modelCalls.length, 2, 'tool-loop: one model call per assistant message');
  assert.deepEqual(out.modelCalls.map((m) => m.usage), [{ input: 10, output: 2 }, { input: 15, output: 4 }],
    'tool-loop: per-request usage preserved (not the turn aggregate)');
  assert.deepEqual(out.modelCalls.map((m) => m.stopReason), ['toolUse', 'end_turn'], 'tool-loop: per-request stopReason');
  assert.equal(out.text, 'step one done', 'tool-loop: turn text still aggregates');
}

// (C) tool error → status 'error'
{
  const events = [];
  await runTurn(fakeSession([
    { type: 'tool_execution_start', toolCallId: 'tc2', toolName: 'exec', args: {} },
    { type: 'tool_execution_end', toolCallId: 'tc2', toolName: 'exec', result: {}, isError: true },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn' } },
  ]), 'x', (ev) => events.push(ev));
  const t = events.find((e) => e.type === 'tool' && e.status === 'error');
  assert.ok(t && t.itemId === 'tc2', 'tool isError:true → status error');
}

console.log('pi-runtime stream test: ALL PASS');

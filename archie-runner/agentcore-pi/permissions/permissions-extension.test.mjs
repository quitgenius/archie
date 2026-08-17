import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionsExtension, makeCan } from './permissions-extension.mjs';
import { makeCapabilityResolver, makeDecider } from './capabilities.mjs';
import { toolCapabilities } from '../tool-registry.mjs';
const TC = toolCapabilities();

// Minimal fake Pi: capture the tool_call handler registered via pi.on.
function fakePi() {
  const handlers = {};
  return { pi: { on: (evt, fn) => (handlers[evt] = fn) }, handlers };
}

function wire({ grants = new Set(), mcpPrefixes = [] } = {}) {
  const turnCtx = { channel: 'C0TEST', agent: 'a', trigger: 'user' };
  const signals = [];
  const capabilityOf = makeCapabilityResolver({ mcpPrefixes, toolCaps: TC });
  const decide = makeDecider({ grants, onSignal: (s) => signals.push(s) });
  const { pi, handlers } = fakePi();
  createPermissionsExtension({ capabilityOf, decide, turnCtx })(pi);
  return { onToolCall: handlers.tool_call, decide, turnCtx, signals };
}

test('allows a baseline tool (returns undefined = proceed)', () => {
  const { onToolCall } = wire();
  assert.equal(onToolCall({ toolName: 'memory_search' }), undefined);
  assert.equal(onToolCall({ toolName: 'read' }), undefined);
});

test('blocks an ungranted non-baseline tool with a legible reason', () => {
  const { onToolCall } = wire({ mcpPrefixes: ['demo_query_app'] });
  const r = onToolCall({ toolName: 'demo_query_app__run_query' });
  assert.equal(r.block, true);
  assert.match(r.reason, /capability "demo_query_app" is not granted/);
});

test('allows a granted non-baseline tool', () => {
  const { onToolCall } = wire({ grants: new Set(['demo_query_app']), mcpPrefixes: ['demo_query_app'] });
  assert.equal(onToolCall({ toolName: 'demo_query_app__run_query' }), undefined);
});

test('unknown tool fails closed (blocked)', () => {
  const { onToolCall } = wire();
  assert.equal(onToolCall({ toolName: 'mystery_tool' }).block, true);
});

test('emits an OTEL signal per tool_call (allow + deny)', () => {
  const { onToolCall, signals } = wire({ mcpPrefixes: ['demo_query_app'] });
  onToolCall({ toolName: 'read' });
  onToolCall({ toolName: 'demo_query_app__q' });
  assert.equal(signals.length, 2);
  assert.equal(signals[0].decision, 'allow');
  assert.equal(signals[1].decision, 'deny');
  assert.equal(signals[1].tool, 'demo_query_app__q');
  assert.equal(signals[1].channel, 'C0TEST');
});

test('makeCan gates hindsight read/write off the same decider', () => {
  const decide = makeDecider({ grants: new Set() });          // hindsight.write not granted
  const can = makeCan(decide, { channel: 'C0TEST', agent: 'a' });
  assert.equal(can('hindsight.read'), true);                  // baseline
  assert.equal(can('hindsight.write'), false);                // default deny
});

// Live regression, 2026-08-12. A cron job holds ONE session across fires, so the agent reads its
// own past runs. `hiccup-ping` (every 2m) concluded "this is firing repeatedly — there's a runaway
// cron job", called cron.remove, and deleted itself mid-turn: the removal is logged three seconds
// before the turn that issued it completed. A cron turn is unattended, so nothing caught it.
test('a CRON-triggered turn cannot remove a cron job', () => {
  const { onToolCall, turnCtx } = wire({ grants: new Set(['cron']) });
  turnCtx.trigger = 'cron';
  const r = onToolCall({ toolName: 'cron', input: { action: 'remove', jobId: 'j1' } });
  assert.equal(r.block, true);
  assert.match(r.reason, /scheduled run cannot remove/);
  assert.match(r.reason, /not a\s+runaway/);   // tells the model WHY, so it stops trying
});

test('a CRON-triggered turn cannot disable a cron job either (same loss, other name)', () => {
  const { onToolCall, turnCtx } = wire({ grants: new Set(['cron']) });
  turnCtx.trigger = 'cron';
  const r = onToolCall({ toolName: 'cron', input: { action: 'update', jobId: 'j1', patch: { enabled: false } } });
  assert.equal(r.block, true);
  assert.match(r.reason, /scheduled run cannot disable/);
});

test('a CRON-triggered turn may still add, list, run and reschedule', () => {
  const { onToolCall, turnCtx } = wire({ grants: new Set(['cron']) });
  turnCtx.trigger = 'cron';
  for (const input of [
    { action: 'list' },
    { action: 'add', job: { schedule: { kind: 'every', everyMs: 60000 } } },
    { action: 'run', jobId: 'j1' },
    { action: 'update', jobId: 'j1', patch: { schedule: { kind: 'every', everyMs: 300000 } } },
  ]) assert.equal(onToolCall({ toolName: 'cron', input }), undefined, JSON.stringify(input));
});

test('an INTERACTIVE turn may still remove a cron job (a human is watching)', () => {
  const { onToolCall, turnCtx } = wire({ grants: new Set(['cron']) });
  turnCtx.trigger = 'user';
  assert.equal(onToolCall({ toolName: 'cron', input: { action: 'remove', jobId: 'j1' } }), undefined);
});

test('the guard does not disturb non-cron tools on a cron turn', () => {
  const { onToolCall, turnCtx } = wire();
  turnCtx.trigger = 'cron';
  assert.equal(onToolCall({ toolName: 'read' }), undefined);
});

// The guard runs BEFORE the capability check, so make sure it did not shadow it: an ungranted
// non-baseline tool must still be refused on a cron turn, with the capability reason.
test('the capability check still applies on a cron turn', () => {
  const { onToolCall, turnCtx } = wire({ mcpPrefixes: ['demo_query_app'] });   // no grants
  turnCtx.trigger = 'cron';
  const r = onToolCall({ toolName: 'demo_query_app__run_query' });
  assert.equal(r.block, true);
  assert.match(r.reason, /capability "demo_query_app" is not granted/);
});

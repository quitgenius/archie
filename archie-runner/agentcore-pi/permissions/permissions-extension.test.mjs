import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPermissionsExtension, makeCan } from './permissions-extension.mjs';
import { makeCapabilityResolver, makeDecider } from './capabilities.mjs';
import { CUSTOM_TOOLS } from '../tool-declarations.mjs';
const TC = CUSTOM_TOOLS;

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

// ── The connector slug reaches telemetry ─────────────────────────────────────────
// Connector's six generic tools carry the real action as an argument, so `tool` alone cannot tell a
// calendar read from an email send. The slug rides the decision signal to the EMF line; the
// arguments beside it never do (permissions/third-party-slug.mjs).
test('a connector multi-execute reports the slug it will run', () => {
  const { onToolCall, signals } = wire();
  const r = onToolCall({
    toolName: 'mcp_connector__CONNECTOR_MULTI_EXECUTE_TOOL',
    input: { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'jane@example.com', subject: 'private' } }] },
  });
  assert.equal(r, undefined);                       // connector is baseline — allowed
  assert.equal(signals.at(-1).capability, 'connector');
  assert.equal(signals.at(-1).slugs, 'GMAIL_SEND_EMAIL');
  // ...and nothing from the arguments came with it.
  const s = JSON.stringify(signals.at(-1));
  assert.equal(s.includes('jane@example.com'), false);
  assert.equal(s.includes('private'), false);
});

test('a non-connector tool call carries no slugs field at all', () => {
  const { onToolCall, signals } = wire({ grants: new Set(['runtime']) });
  onToolCall({ toolName: 'bash', input: { command: 'echo hi' } });
  assert.equal('slugs' in signals.at(-1), false);
});

// A DENIED call is the one you most want to identify: connector.exec is default-deny, and "something
// was blocked" is far less useful than "a remote bash was blocked".
test('a denied connector call still reports its slug', () => {
  const { onToolCall, signals } = wire();
  const r = onToolCall({ toolName: 'mcp_connector__CONNECTOR_REMOTE_BASH_TOOL', input: { tool_slug: 'CONNECTOR_REMOTE_BASH_TOOL' } });
  assert.equal(r.block, true);
  assert.equal(signals.at(-1).decision, 'deny');
  assert.equal(signals.at(-1).capability, 'connector.exec');
  assert.equal(signals.at(-1).slugs, 'CONNECTOR_REMOTE_BASH_TOOL');
});

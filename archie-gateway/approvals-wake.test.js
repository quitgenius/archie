'use strict';
// approvals-wake.test.js — NEW for the archie port. No upstream counterpart: OpenClaw
// wakes the agent through gatewayPool.send, which does not exist under AgentCore.

const { createApprovalWake, parseSlackThreadKey } = require('./approvals-wake');

const RECORD = {
  id: 'ap-1',
  agentId: 'dm-ux0mz5ckp2r',
  sessionKey: 'slack:thread:DL1HA3II6V6:1788000000.000:dm:ux0mz5ckp2r',
  destination: 'ULRXOHM8VOT',
};

const silentLog = { info() {}, warn() {}, error() {}, child() { return silentLog; } };

function harness(overrides = {}) {
  const calls = { invokes: [], ensured: [], exclusive: [], drained: 0, stopped: 0 };
  const session = { stream: { stopped: false } };
  const agentCore = {
    runExclusiveForSession: (sessionId, fn, opts) => { calls.exclusive.push({ sessionId, opts }); return fn(); },
    makeStreamBridge: () => () => {},
    invokeStreaming: async (arn, sessionId, body, onChunk, opts) => {
      calls.invokes.push({ arn, sessionId, body, opts });
      return { ok: true };
    },
    ensureRuntime: async () => 'arn:RAW-CLIENT-MUST-NOT-BE-USED',
  };
  const streaming = {
    registerSession: () => 'trace-1',
    findSession: () => ({ session }),
    startStream: () => {},
    stopStream: () => { calls.stopped += 1; },
    drain: async () => { calls.drained += 1; },
  };
  const wake = createApprovalWake({
    agentCore,
    ensureRuntime: async (agent, o) => { calls.ensured.push(agent); return 'arn:IMAGE-AWARE'; },
    streaming,
    sessionIdFor: (k) => `ac-${k}`,
    log: silentLog,
    ...overrides,
  });
  return { wake, calls, agentCore, streaming };
}

describe('parseSlackThreadKey', () => {
  test('recovers channel and thread from a slack thread key', () => {
    expect(parseSlackThreadKey('slack:thread:C123:1788.0')).toEqual({ channel: 'C123', threadTs: '1788.0' });
  });
  test('tolerates the :dm: suffix', () => {
    expect(parseSlackThreadKey('slack:thread:D1:1788.0:dm:u1')).toEqual({ channel: 'D1', threadTs: '1788.0' });
  });
  test('returns null for a cron-shaped or foreign key', () => {
    expect(parseSlackThreadKey('agent:x:cron:job-1:run:abc')).toBeNull();
    expect(parseSlackThreadKey(undefined)).toBeNull();
  });
});

test('sends the wake string as the ENTIRE bare prompt', async () => {
  // The contract: approvals-hook told the model, at block time, to "Retry the identical
  // send now". Wrapping that in chat framing — which is what forwardToAgentCore's
  // buildAgentPayload would do — turns a control signal into conversation.
  const { wake, calls } = harness();
  const text = '[approval] Approval ap-1 granted for sending to ULRXOHM8VOT. Retry the identical send now.';
  await wake(RECORD, { text, userId: 'UX0MZ5CKP2R' });
  expect(calls.invokes).toHaveLength(1);
  expect(calls.invokes[0].body.input.prompt).toBe(text);
});

test('runId carries the approver so per-user Connector identity survives the retry', async () => {
  // pi-adapter parses "u:<userId>:" back out of runId. Without it the retried send runs
  // under no entity and fails auth — which looks like the approval did not work.
  const { wake, calls } = harness();
  await wake(RECORD, { text: 'x', userId: 'UX0MZ5CKP2R' });
  expect(calls.invokes[0].body.input.runId).toMatch(/^u:UX0MZ5CKP2R:/);
  expect(calls.invokes[0].body.input.sender).toBe('UX0MZ5CKP2R');
  expect(calls.invokes[0].body.input.trigger).toBe('approval');
});

test('reuses the ORIGINATING session id so the agent sees the approval in context', async () => {
  const { wake, calls } = harness();
  await wake(RECORD, { text: 'x', userId: 'U1' });
  expect(calls.invokes[0].sessionId).toBe(`ac-${RECORD.sessionKey}`);
  expect(calls.exclusive[0].sessionId).toBe(`ac-${RECORD.sessionKey}`);
});

test('uses the IMAGE-AWARE runtime resolver, never the raw client', async () => {
  // cron-fire.js:196-201 records the failure: the raw client resolves the runtime name from
  // the dispatcher's BAKED image, silently pinning the agent to the build image.
  const { wake, calls } = harness();
  await wake(RECORD, { text: 'x', userId: 'U1' });
  expect(calls.ensured).toEqual([RECORD.agentId]);
  expect(calls.invokes[0].arn).toBe('arn:IMAGE-AWARE');
});

test('holds the session lock — the requester may be mid-turn in that thread', async () => {
  const { wake, calls } = harness();
  await wake(RECORD, { text: 'x', userId: 'U1' });
  expect(calls.exclusive).toHaveLength(1);
});

test('an unroutable session key logs and invokes nothing', async () => {
  const { wake, calls } = harness();
  const r = await wake({ ...RECORD, sessionKey: 'agent:x:cron:j1:run:abc' }, { text: 'x', userId: 'U1' });
  expect(r).toEqual({ ok: false, reason: 'unroutable_session_key' });
  expect(calls.invokes).toHaveLength(0);
});

test('drains the stream on the FAILURE path too, not just on success', async () => {
  // A turn that dies without draining leaves the Slack placeholder hanging forever.
  const { wake, calls } = harness({});
  const boom = createApprovalWake({
    agentCore: {
      runExclusiveForSession: (id, fn) => fn(),
      makeStreamBridge: () => () => {},
      invokeStreaming: async () => { throw new Error('invoke exploded'); },
    },
    ensureRuntime: async () => 'arn:IMAGE-AWARE',
    streaming: {
      registerSession: () => 't', findSession: () => ({ session: { stream: {} } }),
      startStream: () => {}, stopStream: () => { calls.stopped += 1; },
      drain: async () => { calls.drained += 1; },
    },
    sessionIdFor: (k) => `ac-${k}`,
    log: silentLog,
  });
  const r = await boom(RECORD, { text: 'x', userId: 'U1' });
  expect(r).toEqual({ ok: false, reason: 'invoke_failed' });
  expect(calls.drained).toBe(1);
});

test('a runtime-resolution failure does not invoke and still drains', async () => {
  const calls = { drained: 0 };
  const w = createApprovalWake({
    agentCore: {
      runExclusiveForSession: (id, fn) => fn(),
      makeStreamBridge: () => () => {},
      invokeStreaming: async () => { throw new Error('should not be reached'); },
    },
    ensureRuntime: async () => { throw new Error('no runtime'); },
    streaming: {
      registerSession: () => 't', findSession: () => ({ session: { stream: {} } }),
      startStream: () => {}, stopStream: () => {}, drain: async () => { calls.drained += 1; },
    },
    sessionIdFor: (k) => `ac-${k}`,
    log: silentLog,
  });
  const r = await w(RECORD, { text: 'x', userId: 'U1' });
  expect(r).toEqual({ ok: false, reason: 'ensure_runtime_failed' });
  expect(calls.drained).toBe(1);
});

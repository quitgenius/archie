'use strict';

// The outbound Slack proxy. Restored 2026-09-03 for `slack_send`; these pin the three things that
// decide whether an agent's message reaches Slack at all, and the one that keeps /simulate honest.

const assert = require('node:assert/strict');
const {
  ALLOWED_METHODS,
  slackThreadTargetFromSessionKey,
  anchorDmPostMessage,
  makeSlackProxyHandler,
} = require('./slack-proxy-routes');

const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const reqFor = (method, body = {}, headers = {}) => ({
  params: { method },
  body,
  headers,
  get(name) { return headers[name.toLowerCase()]; },
});

test('extracts the immutable Slack reply target from Pi and migrated session keys', () => {
  expect(slackThreadTargetFromSessionKey('slack:thread:DEBRG0LOAX7:1789039774.094039'))
    .toEqual({ channel: 'DEBRG0LOAX7', threadTs: '1789039774.094039' });
  expect(slackThreadTargetFromSessionKey('agent:a:slack:thread:dm:D0ABC:1712.5:dm:U1'))
    .toEqual({ channel: 'D0ABC', threadTs: '1712.5' });
  expect(slackThreadTargetFromSessionKey('slack:thread:D0ABC:cron-job-1')).toBeNull();
});

test('anchors an unthreaded post back to the originating DM message', () => {
  const original = { channel: 'DEBRG0LOAX7', text: 'step 1' };
  expect(anchorDmPostMessage(
    'chat.postMessage',
    original,
    'slack:thread:DEBRG0LOAX7:1789039774.094039',
  )).toEqual({ ...original, thread_ts: '1789039774.094039' });
  expect(original).toEqual({ channel: 'DEBRG0LOAX7', text: 'step 1' });
});

test('does not override explicit, cross-channel, channel, or cron delivery targets', () => {
  const key = 'slack:thread:D0ORIGIN:1789039774.094039';
  expect(anchorDmPostMessage('chat.postMessage', {
    channel: 'D0ORIGIN', text: 'explicit', thread_ts: '999.1',
  }, key).thread_ts).toBe('999.1');
  expect(anchorDmPostMessage('chat.postMessage', { channel: 'D0OTHER', text: 'cross-post' }, key))
    .toEqual({ channel: 'D0OTHER', text: 'cross-post' });
  expect(anchorDmPostMessage('chat.postMessage', { channel: 'C0CHANNEL', text: 'channel' }, key))
    .toEqual({ channel: 'C0CHANNEL', text: 'channel' });
  expect(anchorDmPostMessage('chat.postMessage', { channel: 'D0ORIGIN', text: 'cron' },
    'slack:thread:D0ORIGIN:cron-job-1'))
    .toEqual({ channel: 'D0ORIGIN', text: 'cron' });
});

test('proxy applies the Pi session thread before chat.postMessage reaches Slack', async () => {
  const calls = [];
  const slack = { apiCall: async (m, b) => { calls.push([m, b]); return { ok: true, ts: '1.3' }; } };
  const res = mockRes();
  await makeSlackProxyHandler({ slack, log: silent })(reqFor(
    'chat.postMessage',
    { channel: 'DEBRG0LOAX7', text: 'step 1' },
    { 'x-archie-session-key': 'slack:thread:DEBRG0LOAX7:1789039774.094039' },
  ), res);
  assert.deepEqual(calls, [[
    'chat.postMessage',
    { channel: 'DEBRG0LOAX7', text: 'step 1', thread_ts: '1789039774.094039' },
  ]]);
});

test('interleaved sessions retain their own thread on repeated sends', async () => {
  const calls = [];
  const slack = { apiCall: async (_method, body) => { calls.push(body); return { ok: true }; } };
  const handler = makeSlackProxyHandler({ slack, log: silent });
  const send = (root) => handler(reqFor(
    'chat.postMessage',
    { channel: 'D0ABC', text: 'reply' },
    { 'x-archie-session-key': `slack:thread:D0ABC:${root}` },
  ), mockRes());

  await send('100.1');
  await send('200.2');
  await send('100.1');

  expect(calls.map((body) => body.thread_ts)).toEqual(['100.1', '200.2', '100.1']);
});

test('chat.postMessage is proxied through, body verbatim, and the Slack result returned', async () => {
  const calls = [];
  const slack = { apiCall: async (m, b) => { calls.push([m, b]); return { ok: true, ts: '1.2', channel: 'D1' }; } };
  const res = mockRes();
  await makeSlackProxyHandler({ slack, log: silent })(reqFor('chat.postMessage', { channel: 'D1', text: 'hi' }), res);
  assert.deepEqual(calls, [['chat.postMessage', { channel: 'D1', text: 'hi' }]]);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, ts: '1.2', channel: 'D1' });
});

test('a method outside the whitelist is refused BEFORE any Slack call', async () => {
  // The whitelist is the blast radius of a compromised agent, so the refusal must not depend on
  // Slack rejecting it — assert nothing reached the client at all.
  let called = false;
  const slack = { apiCall: async () => { called = true; return { ok: true }; } };
  const res = mockRes();
  await makeSlackProxyHandler({ slack, log: silent })(reqFor('chat.delete', { channel: 'C1' }), res);
  assert.equal(called, false, 'the Slack client must never be reached');
  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { ok: false, error: 'method not allowed' });
});

test('the whitelist is exactly the seven OpenClaw allows — widening it is a deliberate act', () => {
  assert.deepEqual([...ALLOWED_METHODS].sort(), [
    'chat.postEphemeral', 'chat.postMessage', 'chat.update',
    'conversations.replies', 'files.uploadV2', 'reactions.add', 'users.info',
  ]);
});

test('a simulate channel is intercepted, never sent to Slack', async () => {
  // `slack.apiCall` bypasses the simulate-aware Proxy (it wraps namespaced access only), so without
  // the handler's own guard a C_SIMULATE* channel reaches real Slack and fails invalid_channel.
  let called = false;
  const slack = { apiCall: async () => { called = true; return { ok: true }; } };
  const res = mockRes();
  await makeSlackProxyHandler({
    slack, log: silent, isSimulateChannel: (c) => typeof c === 'string' && c.startsWith('C_SIMULATE'),
  })(reqFor('chat.postMessage', { channel: 'C_SIMULATE_1', text: 'hi' }), res);
  assert.equal(called, false, 'simulate must not reach Slack');
  assert.equal(res.body.ok, true);
  assert.match(res.body.ts, /^sim-proxy-/);
});

test('a Slack transport failure is 502, not a throw that kills the request', async () => {
  const slack = { apiCall: async () => { throw new Error('socket hang up'); } };
  const res = mockRes();
  await makeSlackProxyHandler({ slack, log: silent })(reqFor('chat.postMessage', { channel: 'D1' }), res);
  assert.equal(res.statusCode, 502);
  assert.deepEqual(res.body, { ok: false, error: 'socket hang up' });
});

test('a Slack-level rejection is passed through as-is, so the caller can see ok:false', async () => {
  // slack_send throws on ok:false. That only works if the body reaches it unmodified — the exact
  // signal Connector's wrapper loses by reporting `successful: true` over a failed Slack call.
  const slack = { apiCall: async () => ({ ok: false, error: 'channel_not_found' }) };
  const res = mockRes();
  await makeSlackProxyHandler({ slack, log: silent })(reqFor('chat.postMessage', { channel: 'D0' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: false, error: 'channel_not_found' });
});

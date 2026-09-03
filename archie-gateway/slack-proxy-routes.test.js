'use strict';

// The outbound Slack proxy. Restored 2026-09-03 for `slack_send`; these pin the three things that
// decide whether an agent's message reaches Slack at all, and the one that keeps /simulate honest.

const assert = require('node:assert/strict');
const { ALLOWED_METHODS, makeSlackProxyHandler } = require('./slack-proxy-routes');

const silent = { info() {}, warn() {}, error() {}, child() { return silent; } };

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
const reqFor = (method, body = {}) => ({ params: { method }, body });

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

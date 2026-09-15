'use strict';

const http = require('node:http');
const { WebClient, LogLevel } = require('@slack/web-api');
const { StreamingManager } = require('./streaming');

// Exercise each package's installed Slack SDK against a local HTTP fixture. No
// Slack account, token, or production messaging is used by these regressions.
describe('stream recovery with the real Slack SDK', () => {
  let server, manager, agent;
  afterEach(async () => {
    manager?.destroy();
    agent?.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
  });

  it.each(['chat.appendStream', 'chat.stopStream'])('handles the SDK error from %s and keeps the original message', async (failureMethod) => {
    const calls = [];
    server = http.createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      const args = Object.fromEntries(new URLSearchParams(body));
      const method = req.url.slice(1);
      calls.push({ method, args });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(method === failureMethod
        ? { ok: false, error: 'message_not_in_streaming_state' }
        : { ok: true, ts: '123.456' }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    agent = new http.Agent({ keepAlive: false });
    const slack = new WebClient('local-test-token', {
      slackApiUrl: `http://127.0.0.1:${server.address().port}/`,
      agent, retryConfig: { retries: 0 }, logLevel: LogLevel.ERROR,
    });
    manager = new StreamingManager({ slack, log: { info: () => {}, warn: () => {}, error: () => {} } });
    manager.registerSession('s', { channel: 'D1', threadTs: '123.000', userId: 'U1', isDM: true });
    const session = manager.findSession('s').session;
    const run = manager.getOrCreateRun(session, 'run');
    manager.handleDelta(run, session, 'Acknowledged prefix');
    await session.stream.chain;
    manager.handleDelta(run, session, 'Acknowledged prefix and tail');
    await session.stream.chain;
    await manager.stopStream(session, 'Acknowledged prefix and tail — complete');
    const updates = calls.filter((call) => call.method === 'chat.update');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((call) => call.args.ts === '123.456')).toBe(true);
    expect(updates.at(-1).args.text).toBe('Acknowledged prefix and tail — complete');
    expect(JSON.parse(updates.at(-1).args.blocks)).toEqual([]);
    expect(calls.filter((call) => call.method === failureMethod)).toHaveLength(1);
    expect(calls.some((call) => call.method === 'chat.postMessage')).toBe(false);
  });
});

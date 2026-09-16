// Hermetic unit test for dispatcher-client.mjs (no AWS, no network — mock fetch).
//   node dispatcher-client-test.mjs
// PASS/FAIL + exit code, matching the agentcore-pi *-test.mjs convention.

import assert from 'node:assert';
import { createDispatcherClient } from './dispatcher-client.mjs';

// Mock fetch: records the last call, returns a canned response.
function mockFetch(response) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: response.status ? response.status < 400 : true,
      status: response.status || 200,
      text: async () => (response.body !== undefined ? JSON.stringify(response.body) : ''),
    };
  };
  fn.calls = calls;
  return fn;
}

const cfg = { baseUrl: 'https://dispatcher.example.com/', secret: 's3cr3t', timeoutMs: 500 };
let pass = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('add: POST /cron with secret header + JSON body', async () => {
  const f = mockFetch({ body: { ok: true, job: { id: 'a::j' } } });
  const c = createDispatcherClient({ ...cfg, fetchImpl: f });
  const r = await c.add({ agentId: 'a', jobId: 'j', schedule: { kind: 'every', everyMs: 10000 } });
  const { url, opts } = f.calls[0];
  assert.equal(url, 'https://dispatcher.example.com/cron'); // trailing slash trimmed
  assert.equal(opts.method, 'POST');
  assert.equal(opts.headers['x-dispatcher-secret'], 's3cr3t');
  assert.equal(opts.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(opts.body).jobId, 'j');
  assert.equal(r.job.id, 'a::j');
});

check('list: GET /cron/:agentId (url-encoded), no body', async () => {
  const f = mockFetch({ body: { ok: true, jobs: [] } });
  const c = createDispatcherClient({ ...cfg, fetchImpl: f });
  await c.list('agent one');
  const { url, opts } = f.calls[0];
  assert.equal(url, 'https://dispatcher.example.com/cron/agent%20one');
  assert.equal(opts.method, 'GET');
  assert.equal(opts.body, undefined);
});

check('update: PUT /cron/:agentId/:jobId with patch body', async () => {
  const f = mockFetch({ body: { ok: true } });
  const c = createDispatcherClient({ ...cfg, fetchImpl: f });
  await c.update('a', 'j', { enabled: false });
  const { url, opts } = f.calls[0];
  assert.equal(url, 'https://dispatcher.example.com/cron/a/j');
  assert.equal(opts.method, 'PUT');
  assert.deepEqual(JSON.parse(opts.body), { enabled: false });
});

check('remove: DELETE /cron/:agentId/:jobId', async () => {
  const f = mockFetch({ body: { ok: true } });
  const c = createDispatcherClient({ ...cfg, fetchImpl: f });
  await c.remove('a', 'j');
  const { url, opts } = f.calls[0];
  assert.equal(url, 'https://dispatcher.example.com/cron/a/j');
  assert.equal(opts.method, 'DELETE');
});

check('run: POST /cron/:agentId/:jobId/run', async () => {
  const f = mockFetch({ body: { ok: true, final: { text: 'ran' } } });
  const c = createDispatcherClient({ ...cfg, fetchImpl: f });
  const r = await c.run('a', 'j');
  assert.equal(f.calls[0].url, 'https://dispatcher.example.com/cron/a/j/run');
  assert.equal(r.final.text, 'ran');
});

check('non-2xx throws with status + parsed body', async () => {
  const f = mockFetch({ status: 400, body: { ok: false, error: 'cron: invalid expr' } });
  const c = createDispatcherClient({ ...cfg, fetchImpl: f });
  await assert.rejects(() => c.add({ agentId: 'a', jobId: 'j' }), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /invalid expr/);
    return true;
  });
});

check('unconfigured (no base) throws before fetching', async () => {
  const f = mockFetch({ body: {} });
  const c = createDispatcherClient({ baseUrl: '', secret: 's', fetchImpl: f });
  assert.equal(c.isConfigured(), false);
  await assert.rejects(() => c.list('a'), /DISPATCHER_BASE_URL not set/);
  assert.equal(f.calls.length, 0);
});

check('unconfigured (no secret) throws before fetching', async () => {
  const f = mockFetch({ body: {} });
  const c = createDispatcherClient({ baseUrl: 'https://x', secret: '', fetchImpl: f });
  await assert.rejects(() => c.list('a'), /DISPATCHER_SHARED_SECRET not set/);
  assert.equal(f.calls.length, 0);
});

check('reads config from env when opts omitted', async () => {
  process.env.DISPATCHER_BASE_URL = 'https://env-dispatcher';
  process.env.DISPATCHER_SHARED_SECRET = 'env-secret';
  const f = mockFetch({ body: { ok: true, jobs: [] } });
  const c = createDispatcherClient({ fetchImpl: f });
  await c.list('a');
  assert.equal(f.calls[0].url, 'https://env-dispatcher/cron/a');
  assert.equal(f.calls[0].opts.headers['x-dispatcher-secret'], 'env-secret');
  delete process.env.DISPATCHER_BASE_URL;
  delete process.env.DISPATCHER_SHARED_SECRET;
});

// PHASE 3 of the per-turn credential: the client is built once per SESSION and a session serves many
// turns, so a captured secret would pin turn 1's token for the life of the session — and the
// dispatcher deletes that token when turn 1 ends.
check('reads the secret PER CALL, so a per-turn token is never stale', async () => {
  const f = mockFetch({ body: { ok: true, jobs: [] } });
  const prev = process.env.DISPATCHER_SHARED_SECRET;
  process.env.DISPATCHER_SHARED_SECRET = 'turn-1-token';
  const c = createDispatcherClient({ baseUrl: 'https://d.example.com', fetchImpl: f, timeoutMs: 500 });
  await c.list('a');
  process.env.DISPATCHER_SHARED_SECRET = 'turn-2-token';   // a new turn rewrites the env var
  await c.list('a');
  if (prev === undefined) delete process.env.DISPATCHER_SHARED_SECRET; else process.env.DISPATCHER_SHARED_SECRET = prev;
  assert.deepEqual(
    f.calls.map((c2) => c2.opts.headers['x-dispatcher-secret']),
    ['turn-1-token', 'turn-2-token'],
  );
});

for (const { name, fn } of checks) {
  try { await fn(); console.log(`  ✅ ${name}`); pass += 1; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); }
}
const ok = pass === checks.length;




console.log(`[dispatcher-client] ${pass}/${checks.length} ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);

'use strict';

// vitest globals enabled via vitest.config.js
// Real express app on an ephemeral port, driven with fetch — a genuine API test of
// the router (routing, status codes, sole-writer delegation to the service).
const express = require('express');
const { createCronApi } = require('./cron-api');
const { keyOf } = require('./cron-store');

function fakeService(over = {}) {
  const jobs = [];
  return {
    add: vi.fn((job) => {
      if (job.schedule && job.schedule.kind === 'bad') throw new Error('cron: invalid expr');
      const saved = { id: keyOf(job.agentId, job.jobId), ...job };
      jobs.push(saved);
      return saved;
    }),
    update: vi.fn((job) => ({ id: keyOf(job.agentId, job.jobId), ...job })),
    remove: vi.fn(),
    purgeAgent: vi.fn((agentId) => ({ agentId, removed: 2, fileDeleted: true })),
    list: vi.fn(() => jobs),
    runNow: vi.fn(async () => ({ text: 'ran' })),
    getRunner: vi.fn(async (agentId) => ({ agentId, runner: 'openclaw', source: 'default', setAtMs: null, setBy: null })),
    setRunner: vi.fn(async (agentId, runner, opts) => ({ agentId, runner, wrote: true, setBy: opts && opts.by })),
    setDefaultRunner: vi.fn(async (agentId, opts) => ({ agentId, runner: (opts && opts.runner) || 'openclaw', wrote: true })),
    setRunnerAlias: vi.fn(async (legacyName, scopeId) => ({ legacyName, scopeId, wrote: true })),
    ...over,
  };
}

let server;
let base;
let service;

beforeEach(async () => {
  service = fakeService();
  const app = express();
  app.use(express.json());
  // BOTH MOUNTS, exactly as index.js wires them (phase 4): `/cron` is the agent surface with the
  // invalid-delivery bypass OFF, `/admin/cron` is the hydrator's with it ON. Mounting only one would
  // let the bypass's confinement regress without a test noticing.
  app.use('/cron', createCronApi({ service }));
  app.use('/admin/cron', createCronApi({ service, allowDeliveryBypass: true }));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterEach(() => new Promise((resolve) => server.close(resolve)));

const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const put = (path, body) => fetch(`${base}${path}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
const del = (path) => fetch(`${base}${path}`, { method: 'DELETE' });

describe('POST /cron (add)', () => {
  it('adds a valid job and returns it', async () => {
    const res = await post('/cron', { agentId: 'a', jobId: 'j', schedule: { kind: 'every', everyMs: 10000 } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.job.id).toBe(keyOf('a', 'j'));
    expect(service.add).toHaveBeenCalledOnce();
  });

  it('400s when agentId/jobId are missing (no service call)', async () => {
    const res = await post('/cron', { schedule: { kind: 'every', everyMs: 10000 } });
    expect(res.status).toBe(400);
    expect(service.add).not.toHaveBeenCalled();
  });

  it('400s on a validation error from the service', async () => {
    const res = await post('/cron', { agentId: 'a', jobId: 'j', schedule: { kind: 'bad' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid expr/);
  });
});

describe('GET /cron/:agentId (list)', () => {
  it('returns only that agent\'s jobs', async () => {
    await post('/cron', { agentId: 'a', jobId: 'j1', schedule: { kind: 'every', everyMs: 10000 } });
    await post('/cron', { agentId: 'b', jobId: 'j2', schedule: { kind: 'every', everyMs: 10000 } });
    const res = await fetch(`${base}/cron/a`);
    const body = await res.json();
    expect(body.jobs.map((j) => j.jobId)).toEqual(['j1']);
  });
});

describe('PUT /cron/:agentId/:jobId (update)', () => {
  it('merges path ids into the body and updates', async () => {
    const res = await put('/cron/a/j', { schedule: { kind: 'every', everyMs: 60000 } });
    expect(res.status).toBe(200);
    const arg = service.update.mock.calls[0][0];
    expect(arg).toMatchObject({ agentId: 'a', jobId: 'j', schedule: { kind: 'every', everyMs: 60000 } });
  });
});

describe('DELETE /cron/:agentId/:jobId (remove)', () => {
  it('removes by composite id', async () => {
    const res = await del('/cron/a/j');
    expect(res.status).toBe(200);
    expect(service.remove).toHaveBeenCalledWith(keyOf('a', 'j'));
  });
});


describe('POST /cron/:agentId/:jobId/run (run now)', () => {
  it('fires once and returns the final', async () => {
    const res = await post('/cron/a/j/run');
    expect(res.status).toBe(200);
    expect(service.runNow).toHaveBeenCalledWith(keyOf('a', 'j'));
    expect((await res.json()).final).toEqual({ text: 'ran' });
  });

  it('500s (not 400) when runNow throws a non-validation error', async () => {
    service.runNow = vi.fn(async () => { throw new Error('runtime exploded'); });
    const res = await post('/cron/a/j/run');
    expect(res.status).toBe(500);
  });
});

// ── Add-time delivery validation ───────────────────────────────────────────
// The live bug this exists to stop: an agent created {mode:'announce', to:'<userId>'} with no
// channel, got a cheerful {ok:true}, and the job then failed invalid_arguments on EVERY fire —
// hours later, in a log line nobody reads. Rejecting here puts the error in the agent's own turn,
// while it still has the context to fix it.
describe('delivery validation at add/update time', () => {
  const jobFixture = { agentId: 'a1', jobId: 'j1', schedule: { kind: 'every', everyMs: 180000 }, payload: { message: 'x' } };

  it('rejects announce with no resolvable channel, and explains the `to` overload', async () => {
    const res = await post('/cron', { ...jobFixture, delivery: { mode: 'announce' } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/announce-missing-channel/);
    expect(service.add).not.toHaveBeenCalled();
  });

  it('accepts announce when the channel is explicit', async () => {
    const res = await post('/cron', { ...jobFixture, delivery: { mode: 'announce', channel: 'C0ABC123XYZ' } });
    expect(res.status).toBe(200);
    expect(service.add).toHaveBeenCalledOnce();
  });

  it('accepts announce when the channel is derivable from sessionKey', async () => {
    const res = await post('/cron', { ...jobFixture, sessionKey: 'slack:thread:C0ABC123XYZ:1.2', delivery: { mode: 'announce' } });
    expect(res.status).toBe(200);
  });

  it('rejects webhook with no url, and an unknown mode', async () => {
    expect((await post('/cron', { ...jobFixture, delivery: { mode: 'webhook' } })).status).toBe(400);
    expect((await post('/cron', { ...jobFixture, delivery: { mode: 'telepathy' } })).status).toBe(400);
    expect(service.add).not.toHaveBeenCalled();
  });

  it('does NOT reject a job with no delivery block (legitimate side-effect job)', async () => {
    const res = await post('/cron', jobFixture);
    expect(res.status).toBe(200);
    expect(service.add).toHaveBeenCalledOnce();
  });

  it('ACCEPTS announce with `to` = a user id (a DM, valid upstream and now here)', async () => {
    const res = await post('/cron', { ...jobFixture, delivery: { mode: 'announce', to: 'UX0MZ5CKP2R' } });
    expect(res.status).toBe(200);
  });

  it('validates PUT too — an update must not be a back door to an invalid delivery', async () => {
    const res = await put('/cron/a1/j1', { schedule: jobFixture.schedule, delivery: { mode: 'announce' } });
    expect(res.status).toBe(400);
    expect(service.update).not.toHaveBeenCalled();
  });

  const bypassPost = (path) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-cron-allow-invalid-delivery': '1' },
    body: JSON.stringify({ ...jobFixture, delivery: { mode: 'announce' } }),
  });

  it('HYDRATOR BYPASS: the header forces an already-broken legacy job through on /admin/cron', async () => {
    // Hydration replays OpenClaw-era jobs. Rejecting one that is ALREADY broken would fail the
    // seed, leaving the agent un-hydrated and retrying forever — a cutover blocker.
    const res = await bypassPost('/admin/cron');
    expect(res.status).toBe(200);
    expect(service.add).toHaveBeenCalledOnce();
  });

  // PHASE 4: "agents never set it" used to be a convention. It is enforced now — the header is only
  // read on the admin mount, so an agent cannot author past the validation by setting it.
  it('the same header is IGNORED on the agent mount', async () => {
    const res = await bypassPost('/cron');
    expect(res.status).toBe(400);
    expect(service.add).not.toHaveBeenCalled();
  });
});

// ── payload.timeoutSeconds is INERT (2026-09-16) ──────────────────────────────
// There was a G7 gate here refusing a negative `timeoutSeconds`, because upstream clamped it to 0
// and 0 meant NO TIMEOUT — so a typo'd `-1` silently meant "run forever". The field is no longer
// read at all: every agentTurn gets one ceiling (cron-inventory-metrics AGENT_TURN_CEILING_MS), so
// a negative value is inert rather than dangerous and there is nothing left to refuse.
//
// These tests are the replacement, not a deletion: the promise changed from "reject a bad value" to
// "accept ANY value and ignore it", and that promise needs holding. Hydrated OpenClaw jobs carry the
// field, so rejecting it would break the seed for something we ignore.
describe('cron api — payload.timeoutSeconds is accepted and ignored', () => {
  const base_ = () => ({
    agentId: 'a', jobId: 'j',
    schedule: { kind: 'cron', expr: '0 9 * * *' },
    delivery: { mode: 'announce', to: 'CZ3E1122Y3K' },
  });
  const withPayload = (payload) => ({ ...base_(), payload });

  it.each([
    ['a negative (the old 400)', -1],
    ['zero (the old "unbounded" opt-out)', 0],
    ['a positive budget', 300],
    ['a string', '300'],
    ['null', null],
  ])('accepts %s', async (_label, timeoutSeconds) => {
    const res = await post('/cron/', withPayload({ kind: 'agentTurn', message: 'x', timeoutSeconds }));
    expect(res.status).toBe(200);
    expect(service.add).toHaveBeenCalled();
  });

  it('accepts an absent field', async () => {
    expect((await post('/cron/', withPayload({ kind: 'agentTurn', message: 'x' }))).status).toBe(200);
  });

  // The case that used to need the hydrator's bypass header. It no longer does, which is the point:
  // a legacy job replayed from OpenClaw adds on the normal path.
  it('a legacy negative from hydration needs no bypass header', async () => {
    const res = await post('/cron/', withPayload({ kind: 'agentTurn', message: 'x', timeoutSeconds: -1 }));
    expect(res.status).toBe(200);
  });

  // An unknown model must NOT be rejected: the runtime falls back to the agent default, and a model
  // id that merely postdates the pinned pi-ai catalog (agent-k4wmx6's opus-4-8) must stay authorable.
  it('does NOT reject an unknown model id', async () => {
    expect((await post('/cron/', withPayload({ kind: 'agentTurn', message: 'x', model: 'global.anthropic.claude-opus-4-8' }))).status).toBe(200);
  });

  it('the same is true on UPDATE (the two routes must not drift)', async () => {
    const res = await put('/cron/a/j', { payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: -5 } });
    expect(res.status).toBe(200);
  });
});

describe('purge (DELETE /cron/:agentId) — §E1', () => {
  it('wipes one agent and reports what it removed', async () => {
    const res = await fetch(`${base}/cron/agent-75lieo`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, agentId: 'agent-75lieo', removed: 2, fileDeleted: true });
    expect(service.purgeAgent).toHaveBeenCalledWith('agent-75lieo');
  });

  it('is a DISTINCT route from deleting one job — a fat-fingered jobId cannot reach it', async () => {
    // DELETE /cron/<agent>/<jobId> removes one job; DELETE /cron/<agent> removes everything. They
    // must not be reachable from each other by a typo, which is why the purge is not expressed as a
    // wildcard jobId.
    await fetch(`${base}/cron/agent-75lieo/digest`, { method: 'DELETE' });
    expect(service.purgeAgent).not.toHaveBeenCalled();
    expect(service.remove).toHaveBeenCalledWith(keyOf('agent-75lieo', 'digest'));
  });

  it('surfaces a purge failure rather than reporting a clean wipe', async () => {
    // A purge that half-succeeded and answered ok:true would be the worst outcome: hydration would
    // seed on top of jobs it believes are gone.
    service.purgeAgent = vi.fn(() => { throw new Error('EIO: unlink failed'); });
    const res = await fetch(`${base}/cron/agent-75lieo`, { method: 'DELETE' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).ok).toBe(false);
  });
});

// §3a' — the CRON_RUNNER routes. These decide which stack fires a scope's jobs, so the interesting
// tests are about the two ways they could silently do the wrong thing.
describe('GET/PUT /cron/:agentId/runner', () => {
  it('reports the resolved runner AND where it came from', async () => {
    const res = await fetch(`${base}/cron/dm-u1/runner`);
    expect(res.status).toBe(200);
    // 'source' is not decoration: "nobody has flipped this scope yet" and "this scope is pinned to
    // openclaw" are operationally different and look identical in the value alone.
    expect(await res.json()).toMatchObject({ ok: true, runner: 'openclaw', source: 'default' });
  });

  it('sets the runner, recording who asked', async () => {
    const res = await put('/cron/dm-u1/runner', { runner: 'agentcore', by: 'U123' });
    expect(res.status).toBe(200);
    expect(service.setRunner).toHaveBeenCalledWith('dm-u1', 'agentcore', { by: 'U123' });
  });

  it('ifAbsent takes the seed-the-default path, which never overwrites a decision', async () => {
    await put('/cron/dm-u1/runner', { runner: 'openclaw', by: 'hydrate:x', ifAbsent: true });
    expect(service.setDefaultRunner).toHaveBeenCalledWith('dm-u1', { runner: 'openclaw', by: 'hydrate:x' });
    expect(service.setRunner).not.toHaveBeenCalled();
  });

  it("writes the legacy-name alias through the same route — it is the same ROW", async () => {
    const res = await put('/cron/agent-xx9aff/runner', { alias: 'dm-u1', by: 'hydrate:agent-xx9aff' });
    expect(res.status).toBe(200);
    expect(service.setRunnerAlias).toHaveBeenCalledWith('agent-xx9aff', 'dm-u1', { by: 'hydrate:agent-xx9aff' });
    // …and it must NOT be mistaken for a runner write
    expect(service.setRunner).not.toHaveBeenCalled();
    expect(service.setDefaultRunner).not.toHaveBeenCalled();
  });

  it('an unknown runner is a 400, not a 500', async () => {
    service.setRunner.mockRejectedValueOnce(new Error('cron: runner must be one of openclaw | agentcore (got "ecs")'));
    const res = await put('/cron/dm-u1/runner', { runner: 'ecs' });
    expect(res.status).toBe(400);
  });

  it('refuses a job whose jobId would collide with this route', async () => {
    const res = await post('/cron', { agentId: 'dm-u1', jobId: 'runner', schedule: { kind: 'every', everyMs: 10000 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/reserved jobId/);
  });

  // THE ROUTE-ORDERING TRAP. Express matches in declaration order, so with the runner routes below
  // `/:agentId/:jobId` this would bind jobId='runner' and quietly UPDATE A JOB by that name instead
  // — a flip that returns 200 and changes nothing about which stack fires.
  it('is not shadowed by the per-job update route', async () => {
    await put('/cron/dm-u1/runner', { runner: 'agentcore', by: 'U123' });
    expect(service.update).not.toHaveBeenCalled();
    expect(service.setRunner).toHaveBeenCalled();
  });
});

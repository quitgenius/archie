'use strict';

// Integration test: the REAL runner + store (on a temp dir) + fire composed by
// cron-service. Only the leaf I/O collaborators are mocked (AgentCore invoke, delivery).
// Proves the Phase-1 modules actually wire together end to end, and that a fire persists
// run-state to EFS and survives a "restart".
//
// vitest globals enabled via vitest.config.js

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronService } = require('./cron-service');
const { FakeClock } = require('./fake-clock');

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-svc-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function svc(over = {}) {
  const clock = new FakeClock(over.startMs || 0);
  const invoked = [];
  const delivered = [];
  const agentCore = {
    ensureRuntime: vi.fn(async () => 'arn:runtime'),
    invokeStreaming: vi.fn(async (arn, sid, body) => { invoked.push(body.input); return { text: `did:${body.input.prompt}` }; }),
  };
  const deliver = vi.fn(async (job, final) => { delivered.push({ jobId: job.jobId, final }); });
  const service = createCronService({
    dir,
    clock,
    agentCore,
    sessionIdFor: (job) => `sess-${job.agentId}`.padEnd(33, '0'),
    deliver,
    now: () => clock.now(),
  });
  return { clock, service, agentCore, deliver, invoked, delivered };
}

const job = (over = {}) => ({
  agentId: 'agentA',
  jobId: 'digest',
  name: 'digest',
  enabled: true,
  createdAtMs: 0,
  sessionTarget: 'main',
  payload: { kind: 'agentTurn', message: 'daily digest' },
  ...over,
});

describe('cron-service end-to-end (real runner+store+fire)', () => {
  it('a recurring job fires through to invoke + deliver and persists run-state to EFS', async () => {
    const s = svc();
    s.service.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await s.clock.advance(25_000);

    // fired twice (10s, 20s) -> invoked twice, delivered twice
    expect(s.invoked.length).toBe(2);
    expect(s.invoked[0].trigger).toBe('cron');
    expect(s.invoked[0].prompt.startsWith('daily digest')).toBe(true); // + §12c delivery instruction
    // the fake echoes the prompt, which now carries the §12c delivery instruction — assert the lead
    expect(s.delivered.map((d) => d.final.text.split('\n')[0])).toEqual(['did:daily digest', 'did:daily digest']);

    expect(s.agentCore.ensureRuntime).toHaveBeenCalled();
    // run-state landed on EFS
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agentA.json'), 'utf8'));
    expect(raw.jobs.digest.state.lastRunStatus).toBe('ok');
    expect(raw.jobs.digest.state.consecutiveErrors).toBe(0);
  });

  it('a one-shot fires once, delivers, and self-deletes from EFS', async () => {
    const s = svc();
    s.service.add(job({ jobId: 'once', schedule: { kind: 'at', at: 5000 } }));
    await s.clock.advance(10_000);
    expect(s.invoked.length).toBe(1);
    expect(s.delivered.length).toBe(1);
    expect(fs.existsSync(path.join(dir, 'agentA.json'))).toBe(false); // gone
  });

  it('boot-recovery: a fresh service over the same EFS dir re-arms and resumes (no double-fire)', async () => {
    const s1 = svc();
    s1.service.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await s1.clock.advance(25_000); // fires 10, 20
    s1.service.stop();
    const firesBefore = s1.invoked.length;
    expect(firesBefore).toBe(2);

    // restart: new service, same dir, clock jumped forward across "downtime"
    const s2 = svc({ startMs: 63_000 });
    const loaded = await s2.service.start();
    expect(loaded).toBe(1); // the recurring job was recovered from EFS
    await s2.clock.advance(10_000); // 63s -> next aligned tick 70s
    expect(s2.invoked.map((i) => i.trigger)).toEqual(['cron']); // exactly one, no backfill of missed 30/40/50/60
  });
});

// ── Emit-on-change (M4.5 follow-up) ────────────────────────────────────────
// The periodic sweep answers "what is configured" only as of the last tick, which left the most
// common question — "I just created a cron job, did it register correctly?" — unanswerable for up
// to a full interval. That gap was found live: a newly created job was flagged misconfigured only
// via the 60s aggregate, with no per-job record for up to 15 minutes.
describe('cron-service emit-on-change', () => {
  function capture(over = {}) {
    const lines = [];
    const clock = new FakeClock(0);
    const service = createCronService({
      dir, clock, now: () => clock.now(),
      agentCore: { ensureRuntime: vi.fn(async () => 'arn'), invokeStreaming: vi.fn(async () => ({ text: 'x' })) },
      sessionIdFor: (j) => `sess-${j.agentId}`.padEnd(33, '0'),
      deliver: vi.fn(async () => {}),
      inventoryEmit: (l) => lines.push(l),
      inventoryIntervalMs: 0,   // no periodic sweep — prove the EMISSION came from the mutation
      jobRecordIntervalMs: 0,
      ...over,
    });
    return { service, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
  }

  it('add emits that job\'s record immediately, with no periodic timer running', () => {
    const { service, parsed } = capture();
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce', channel: 'C0ABC123XYZ' } }));
    const rec = parsed().find((e) => e.CronJobRecord != null);
    expect(rec).toBeTruthy();
    expect(rec.JobId).toBe('digest');
    expect(rec.status).toBe('ok');
  });

  it('a NEW misconfigured job is visible immediately (the live gap this closes)', () => {
    const { service, parsed } = capture();
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce' } }));
    const rec = parsed().find((e) => e.CronJobRecord != null);
    expect(rec.status).toBe('announce-missing-channel');
    // aggregates refresh too, so the misconfiguration gauge does not wait for the 60s tick
    const mis = parsed().find((e) => e.CronJobsMisconfigured != null);
    expect(mis.Reason).toBe('announce-missing-channel');
  });

  it('update re-emits the changed job', () => {
    const { service, parsed, lines } = capture();
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce', channel: 'C0ABC123XYZ' } }));
    lines.length = 0;
    service.update(job({ schedule: { kind: 'every', everyMs: 900000 }, delivery: { mode: 'announce', channel: 'C0DEF456XYZ' } }));
    const rec = parsed().find((e) => e.CronJobRecord != null);
    expect(rec.channel).toBe('C0DEF456XYZ');
  });

  it('remove refreshes the aggregates and emits no record for the deleted job', () => {
    const { service, parsed, lines } = capture();
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce' } }));
    lines.length = 0;
    service.remove('agentA::digest');
    expect(parsed().some((e) => e.CronJobRecord != null)).toBe(false);
    expect(parsed().some((e) => e.CronJobsMisconfigured != null)).toBe(false); // gauge cleared
  });

  it('a metrics failure never fails the mutation', () => {
    const { service } = capture({ inventoryEmit: () => { throw new Error('emf sink down'); } });
    expect(() => service.add(job({ schedule: { kind: 'every', everyMs: 600000 } }))).not.toThrow();
  });
});

// ── PUT is a PATCH, not a replace ──────────────────────────────────────────
// Live data loss: the agent-side tool sends a `patch`, the EFS mirror patches, but the
// dispatcher replaced — so {enabled, schedule} wiped name/payload/delivery/sessionTarget on the
// authoritative copy. A payload-less job then invokes with prompt=undefined (runtime 400) and a
// delivery-less job goes silent.
describe('cron-service update = merge (not replace)', () => {
  const full = () => job({
    schedule: { kind: 'every', everyMs: 600000 },
    delivery: { mode: 'announce', channel: 'C0ABC123XYZ' },
    payload: { kind: 'agentTurn', message: 'the real work' },
    sessionTarget: 'isolated',
    name: 'nightly',
  });

  it('a partial patch preserves every field it does not mention', () => {
    const { service } = svc();
    service.add(full());
    service.update({ agentId: 'agentA', jobId: 'digest', schedule: { kind: 'every', everyMs: 900000 } });
    const saved = service.list().find((j) => j.jobId === 'digest');
    expect(saved.schedule.everyMs).toBe(900000);        // the patch applied
    expect(saved.payload).toEqual({ kind: 'agentTurn', message: 'the real work' }); // and nothing else died
    expect(saved.delivery).toEqual({ mode: 'announce', channel: 'C0ABC123XYZ' });
    expect(saved.sessionTarget).toBe('isolated');
    expect(saved.name).toBe('nightly');
  });

  it('a patch with NO schedule no longer 400s on validateSchedule(undefined)', () => {
    const { service } = svc();
    service.add(full());
    expect(() => service.update({ agentId: 'agentA', jobId: 'digest', name: 'renamed' })).not.toThrow();
    const saved = service.list().find((j) => j.jobId === 'digest');
    expect(saved.name).toBe('renamed');
    expect(saved.schedule.everyMs).toBe(600000); // inherited from the existing record
  });

  it('the patch still WINS on the fields it does mention', () => {
    const { service } = svc();
    service.add(full());
    service.update({ agentId: 'agentA', jobId: 'digest', delivery: { mode: 'none' }, schedule: full().schedule });
    expect(service.list().find((j) => j.jobId === 'digest').delivery).toEqual({ mode: 'none' });
  });
});

// ── the store must stop reporting success for an undelivered turn ──────────
describe('cron-service records the DELIVERY outcome in job state', () => {
  const withDeliver = (deliverImpl) => {
    const clock = new FakeClock(0);
    return createCronService({
      dir, clock, now: () => clock.now(),
      agentCore: { ensureRuntime: vi.fn(async () => 'arn'), invokeStreaming: vi.fn(async () => ({ text: 'done' })) },
      sessionIdFor: (j) => `sess-${j.agentId}`.padEnd(33, '0'),
      deliver: deliverImpl,
      inventoryIntervalMs: 0, jobRecordIntervalMs: 0,
    });
  };

  it('a swallowed delivery failure is recorded — and lastRunStatus still says the TURN was ok', async () => {
    const service = withDeliver(async () => ({ delivered: false, error: 'An API error occurred: invalid_arguments' }));
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce' } }));
    await service.runNow('agentA::digest');
    const st = service.list().find((j) => j.jobId === 'digest').state;
    expect(st.lastDeliveryStatus).toBe('failed');
    expect(st.lastDeliveryError).toMatch(/invalid_arguments/);
    // UNCHANGED on purpose: consecutiveErrors drives failureAlert, and a failed announce must not
    // trip it — that is the whole reason delivery errors are swallowed.
    expect(st.lastRunStatus).toBe('ok');
    expect(st.consecutiveErrors).toBe(0);
  });

  it('a successful delivery records ok', async () => {
    const service = withDeliver(async () => ({ delivered: true, mode: 'announce' }));
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce', channel: 'C0ABC123XYZ' } }));
    await service.runNow('agentA::digest');
    expect(service.list().find((j) => j.jobId === 'digest').state.lastDeliveryStatus).toBe('ok');
  });

  it('a skip (mode none / NO_REPLY) is recorded as skipped, not failed', async () => {
    const service = withDeliver(async () => ({ delivered: false, reason: 'no-reply' }));
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 } }));
    await service.runNow('agentA::digest');
    const st = service.list().find((j) => j.jobId === 'digest').state;
    expect(st.lastDeliveryStatus).toBe('skipped');
    expect(st.lastDeliveryReason).toBe('no-reply');
  });
});


describe('cron-service removal telemetry', () => {
  it('reports the job as it was BEFORE deletion, and never fails the removal', () => {
    const removed = [];
    const clock = new FakeClock(0);
    const service = createCronService({
      dir, clock, now: () => clock.now(),
      agentCore: { ensureRuntime: vi.fn(async () => 'arn'), invokeStreaming: vi.fn(async () => ({ text: 'x' })) },
      sessionIdFor: (j) => `sess-${j.agentId}`.padEnd(33, '0'),
      deliver: vi.fn(async () => {}),
      inventoryIntervalMs: 0, jobRecordIntervalMs: 0,
      onJobRemoved: (job, info) => removed.push({ jobId: job.jobId, name: job.name, mode: job.delivery && job.delivery.mode, reason: info.reason }),
    });
    service.add(job({ name: 'whale', schedule: { kind: 'every', everyMs: 600000 }, delivery: { mode: 'announce', channel: 'CZ3E1122Y3K' } }));
    service.remove('agentA::digest');
    expect(removed).toEqual([{ jobId: 'digest', name: 'whale', mode: 'announce', reason: 'requested' }]);
    expect(service.list()).toHaveLength(0);
  });

  it('a throwing telemetry hook does not fail the removal', () => {
    const clock = new FakeClock(0);
    const service = createCronService({
      dir, clock, now: () => clock.now(),
      agentCore: { ensureRuntime: vi.fn(async () => 'arn'), invokeStreaming: vi.fn(async () => ({ text: 'x' })) },
      sessionIdFor: (j) => `sess-${j.agentId}`.padEnd(33, '0'),
      deliver: vi.fn(async () => {}),
      inventoryIntervalMs: 0, jobRecordIntervalMs: 0,
      onJobRemoved: () => { throw new Error('emf down'); },
    });
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 } }));
    expect(() => service.remove('agentA::digest')).not.toThrow();
    expect(service.list()).toHaveLength(0);
  });
});

describe('cron-service mutation telemetry (add / update)', () => {
  // The gap these close: `emitChange` re-emits a CronJobRecord on every mutation, so the new STATE
  // is visible — but the record is identical whether it came from an edit or the periodic sweep, and
  // it carries no previous value. The `Focus Time Slack Status` disable on dm-urbnxvak3l5
  // (2026-09-03) was therefore only findable by diffing ~500 sweeps five days after the fact.
  const wire = (hooks) => {
    const clock = new FakeClock(0);
    return createCronService({
      dir, clock, now: () => clock.now(),
      agentCore: { ensureRuntime: vi.fn(async () => 'arn'), invokeStreaming: vi.fn(async () => ({ text: 'x' })) },
      sessionIdFor: (j) => `sess-${j.agentId}`.padEnd(33, '0'),
      deliver: vi.fn(async () => {}),
      inventoryIntervalMs: 0, jobRecordIntervalMs: 0,
      ...hooks,
    });
  };

  it('reports an add with the stored record', () => {
    const added = [];
    const service = wire({ onJobAdded: (job, info) => added.push({ jobId: job.jobId, name: job.name, source: info.source }) });
    service.add(job({ name: 'whale', schedule: { kind: 'every', everyMs: 600000 } }));
    expect(added).toEqual([{ jobId: 'digest', name: 'whale', source: 'requested' }]);
  });

  it('passes the PREVIOUS record to the update hook, read before the merge', () => {
    const seen = [];
    const service = wire({ onJobUpdated: (before, after) => seen.push({ from: before && before.enabled, to: after.enabled }) });
    service.add(job({ schedule: { kind: 'every', everyMs: 600000 }, enabled: true }));
    service.update({ agentId: 'agentA', jobId: 'digest', enabled: false });
    expect(seen).toEqual([{ from: true, to: false }]);
  });

  it('the previous record is a CLONE — a runner mutating in place cannot corrupt the event', () => {
    let captured = null;
    const service = wire({ onJobUpdated: (before) => { captured = before; } });
    service.add(job({ name: 'original', schedule: { kind: 'every', everyMs: 600000 } }));
    service.update({ agentId: 'agentA', jobId: 'digest', name: 'renamed' });
    expect(captured.name).toBe('original');
    expect(service.list()[0].name).toBe('renamed');
  });

  it('a throwing telemetry hook fails neither the add nor the update', () => {
    const service = wire({
      onJobAdded: () => { throw new Error('emf down'); },
      onJobUpdated: () => { throw new Error('emf down'); },
    });
    expect(() => service.add(job({ schedule: { kind: 'every', everyMs: 600000 } }))).not.toThrow();
    expect(() => service.update({ agentId: 'agentA', jobId: 'digest', enabled: false })).not.toThrow();
    expect(service.list()[0].enabled).toBe(false);
  });

  it('an update with no previous record reports before=null rather than throwing', () => {
    const seen = [];
    const service = wire({ onJobUpdated: (before, after) => seen.push({ before, jobId: after.jobId }) });
    service.update(job({ schedule: { kind: 'every', everyMs: 600000 } }));
    expect(seen).toHaveLength(1);
    expect(seen[0].before).toBeNull();
  });
});

describe('cron-service purgeAgent (§E1 — hydration wipes the slate)', () => {
  it('DISARMS as well as deletes — a purged job must never fire again', async () => {
    // THE POINT OF THE WHOLE TEST FILE ENTRY. `store.delete()` drops the cache entry and re-persists
    // but does NOT cancel the timer; only `runner.remove()` disarms. A purge that took the store
    // route would leave live timers invoking turns for jobs that exist nowhere — invisible in the
    // store, visible only as unexplained Slack messages. Advancing the clock past several periods is
    // the only way to prove the timer is genuinely gone rather than merely unreferenced.
    const s = svc();
    s.service.add(job({ jobId: 'a', schedule: { kind: 'every', everyMs: 10_000 } }));
    s.service.add(job({ jobId: 'b', schedule: { kind: 'every', everyMs: 10_000 } }));
    await s.clock.advance(25_000);
    expect(s.invoked.length).toBeGreaterThan(0);
    const firedBeforePurge = s.invoked.length;

    s.service.purgeAgent('agentA');
    await s.clock.advance(120_000);   // twelve more periods

    expect(s.invoked.length).toBe(firedBeforePurge);
    expect(s.service.list()).toHaveLength(0);
  });

  it('removes the agent file, so a restart does not read the jobs straight back in', async () => {
    // A purge that left the file behind would be undone by the next `load()`. persistAgent already
    // unlinks when the last job goes; this asserts the observable end state rather than the mechanism.
    const s = svc();
    s.service.add(job({ jobId: 'a', schedule: { kind: 'every', everyMs: 10_000 } }));
    expect(fs.existsSync(path.join(dir, 'agentA.json'))).toBe(true);

    s.service.purgeAgent('agentA');
    expect(fs.existsSync(path.join(dir, 'agentA.json'))).toBe(false);
  });

  it('touches ONLY the named agent', async () => {
    // Hydration runs per agent. A purge that reached wider would silently unschedule a fleet.
    const s = svc();
    s.service.add(job({ agentId: 'agentA', jobId: 'a', schedule: { kind: 'every', everyMs: 10_000 } }));
    s.service.add(job({ agentId: 'agentB', jobId: 'b', schedule: { kind: 'every', everyMs: 10_000 } }));

    const result = s.service.purgeAgent('agentA');
    expect(result).toMatchObject({ agentId: 'agentA', removed: 1 });
    expect(s.service.list().map((j) => j.agentId)).toEqual(['agentB']);
    expect(fs.existsSync(path.join(dir, 'agentB.json'))).toBe(true);
  });

  it('purging an agent with nothing to purge is a clean no-op', async () => {
    const s = svc();
    expect(s.service.purgeAgent('nobody')).toMatchObject({ removed: 0, fileDeleted: false });
  });
});

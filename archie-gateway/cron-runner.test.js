'use strict';

// Deterministic Phase-0 gate for the dispatcher cron runner (pi-cron-migration-plan.md §10).
//
// These are the REAL timing/recovery gate: a virtual clock (FakeClock) makes
// "fires on the correct schedule", boot-recovery, and overlap fully deterministic —
// no wall-clock sleeps, no live runtimes. The agent-driven E2E leg (does the wiring
// actually fire end-to-end) is Phase 3, in agentcore-tests.
//
// Tag ↔ test mapping uses the @cron-* names from the plan's gate table.

// vitest globals (describe/it/expect/vi) are enabled via vitest.config.js
const {
  createCronRunner,
  computeNextRun,
  validateSchedule,
  MIN_EVERY_MS,
} = require('./cron-runner');
const { FakeClock } = require('./fake-clock');

// ── Test doubles ────────────────────────────────────────────────────────────

function memStore(initial = []) {
  const jobs = new Map(initial.map((j) => [j.id, { state: {}, ...j }]));
  return {
    list: () => [...jobs.values()],
    get: (id) => jobs.get(id),
    put: (job) => { jobs.set(job.id, { state: {}, ...jobs.get(job.id), ...job }); },
    delete: (id) => { jobs.delete(id); },
    patchState: (id, patch) => {
      const j = jobs.get(id);
      if (j) j.state = { ...j.state, ...patch };
    },
    _jobs: jobs,
  };
}

// Builds a runner whose fire records (jobId, firedAt) and returns a hook to make
// fire slow or throwing. Default fire is instant + succeeds.
function harness(jobs = [], opts = {}) {
  const clock = new FakeClock(opts.startMs || 0);
  const store = memStore(jobs);
  const fired = [];
  const fireImpl = opts.fire || (async () => {});
  const fire = vi.fn(async (job) => {
    fired.push({ id: job.id, at: clock.now() });
    return fireImpl(job, clock);
  });
  const onAlert = vi.fn();
  const runner = createCronRunner({ clock, store, fire, onAlert, maxConcurrent: opts.maxConcurrent || 8, enabled: opts.enabled, longRunMs: opts.longRunMs, onLongRun: opts.onLongRun, onOverlapSkip: opts.onOverlapSkip });
  return { clock, store, fire, fired, onAlert, runner };
}

const job = (over = {}) => ({
  id: 'j1',
  name: 'test',
  enabled: true,
  createdAtMs: 0,
  payload: { kind: 'agentTurn', message: 'do the thing' },
  sessionTarget: 'main',
  ...over,
});

// ── Pure helpers ──────────────────────────────────────────────────────────────

// Live regression, 2026-08-12 (@cron-double-arm). Re-running the hydrator seeds every job through
// add() — api.add → POST /cron/ → runner.add. add() did not disarm first, and arm() only does
// `handles.set(id, handle)`, so the previous timer was orphaned, not cancelled: the job fired twice
// per period and every re-add leaked another timer. It presented as "cron protect: skipping
// overlapping tick" twice, 19ms apart, for one jobId — a duplicate disguised as a slow turn.
describe('re-adding an existing job must not leave a second timer armed', () => {
  it('fires ONCE per period after a re-add (the hydrator re-seed path)', async () => {
    const h = harness([]);
    const j = job({ schedule: { kind: 'every', everyMs: 60_000 } });
    h.runner.add(j);
    h.runner.add(j);            // re-hydration seeds the same job again
    h.runner.add(j);            // and again — each used to leak another live timer

    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(1);
    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(2);   // still one per period, not 3 then 6
  });

  it('a re-add with a CHANGED schedule honours the new one only', async () => {
    const h = harness([]);
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 300_000 } }));

    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(0);   // the old 60s timer must be gone, not merely forgotten
    await h.clock.advance(240_000);
    expect(h.fired.length).toBe(1);
  });

  it('re-adding as disabled disarms the live timer', async () => {
    const h = harness([]);
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 }, enabled: false }));

    await h.clock.advance(180_000);
    expect(h.fired.length).toBe(0);
  });
});

// A cron turn is unattended and overruns are DROPPED, not queued, so both signals below were
// invisible: a long run was only a duration nobody measured, and a skipped tick was log.info only.
// `run: timeout` is already the largest prod failure class (30 of 79), and a frequent job that
// overruns silently runs at a fraction of its configured frequency.
describe('overrun observability', () => {
  it('reports a run that exceeds the long-run threshold, with its duration', async () => {
    const seen = [];
    const h = harness([], {
      longRunMs: 5000,
      onLongRun: (job, info) => seen.push({ id: job.id, ...info }),
      fire: async (_job, clock) => { await clock.advance(9000); },
    });
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    await h.clock.advance(60_000);   // fires; the run itself advances virtual time from inside
    await h.clock.advance(15_000);   // let that run finish — advance does not await callbacks
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe('j1');
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(9000);
    expect(seen[0].status).toBe('ok');   // slow is not failed
  });

  it('does NOT report a run inside the threshold', async () => {
    const seen = [];
    const h = harness([], {
      longRunMs: 60_000,
      onLongRun: () => seen.push(1),
      fire: async (_job, clock) => { await clock.advance(1000); },
    });
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 120_000 } }));
    await h.clock.advance(120_000);
    expect(seen).toEqual([]);
  });

  it('reports every tick DROPPED by the overlap guard (there is no queue)', async () => {
    const skipped = [];
    const h = harness([], {
      onOverlapSkip: (job) => skipped.push(job.id),
      fire: async (_job, clock) => { await clock.advance(300_000); },  // 5m run, 1m period
    });
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    await h.clock.advance(300_000);
    // one fire started; the ticks landing while it ran are lost, and each is now countable
    expect(h.fired.length).toBe(1);
    expect(skipped.length).toBeGreaterThanOrEqual(3);
    expect(new Set(skipped)).toEqual(new Set(['j1']));
  });

  it('records the duration on run state', async () => {
    const h = harness([], { fire: async (_job, clock) => { await clock.advance(4000); } });
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    await h.clock.advance(60_000);
    await h.clock.advance(10_000);   // as above: let the in-flight run complete
    expect(h.store.get('j1').state.lastDurationMs).toBeGreaterThanOrEqual(4000);
  });
});

describe('computeNextRun (pure)', () => {
  it('at: returns the instant if future, null if elapsed', () => {
    expect(computeNextRun({ kind: 'at', at: 5000 }, 0)).toBe(5000);
    expect(computeNextRun({ kind: 'at', at: 5000 }, 5000)).toBeNull(); // strictly after
    expect(computeNextRun({ kind: 'at', at: 5000 }, 6000)).toBeNull();
  });
  it('every: next strictly after now, anchored', () => {
    expect(computeNextRun({ kind: 'every', everyMs: 10_000 }, 0, 0)).toBe(10_000);
    expect(computeNextRun({ kind: 'every', everyMs: 10_000 }, 10_000, 0)).toBe(20_000);
    expect(computeNextRun({ kind: 'every', everyMs: 10_000 }, 15_000, 0)).toBe(20_000);
  });
  it('every: honours anchorMs phase', () => {
    // anchor at 3s, every 10s -> fires at 3,13,23...
    expect(computeNextRun({ kind: 'every', everyMs: 10_000, anchorMs: 3000 }, 0)).toBe(3000);
    expect(computeNextRun({ kind: 'every', everyMs: 10_000, anchorMs: 3000 }, 3000)).toBe(13_000);
    expect(computeNextRun({ kind: 'every', everyMs: 10_000, anchorMs: 3000 }, 9000)).toBe(13_000);
  });
  it('cron: uses croner as a pure calculator', () => {
    const base = Date.parse('2026-01-01T00:00:00Z');
    // every 5s
    expect(computeNextRun({ kind: 'cron', expr: '*/5 * * * * *' }, base)).toBe(base + 5000);
  });
});

describe('validateSchedule (@cron-error-badexpr surface)', () => {
  it('rejects an invalid cron expr', () => {
    expect(() => validateSchedule({ kind: 'cron', expr: 'not a cron' })).toThrow(/invalid expr/);
  });
  it('rejects sub-1s every but ALLOWS sub-minute (fidelity we keep)', () => {
    expect(() => validateSchedule({ kind: 'every', everyMs: 500 })).toThrow();
    expect(() => validateSchedule({ kind: 'every', everyMs: MIN_EVERY_MS })).not.toThrow();
    expect(() => validateSchedule({ kind: 'every', everyMs: 5000 })).not.toThrow(); // 5s ok
  });
  it('rejects unknown kind and non-finite at', () => {
    expect(() => validateSchedule({ kind: 'weekly' })).toThrow(/unknown/);
    expect(() => validateSchedule({ kind: 'at', at: 'soon' })).toThrow();
  });
});

// ── The gate ──────────────────────────────────────────────────────────────────

describe('@cron-oneshot: at now+5s fires once, self-deletes, no second fire', () => {
  it('fires exactly once and removes the job', async () => {
    const h = harness();
    h.runner.add(job({ schedule: { kind: 'at', at: 5000 } }));
    await h.clock.advance(5000);
    expect(h.fired).toEqual([{ id: 'j1', at: 5000 }]);
    expect(h.store.get('j1')).toBeUndefined(); // self-deleted
    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(1); // no second fire
  });
});

describe('@cron-recurring: every 10s fires repeatedly on schedule', () => {
  it('fires at 10s, 20s, 30s', async () => {
    const h = harness();
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await h.clock.advance(35_000);
    expect(h.fired.map((f) => f.at)).toEqual([10_000, 20_000, 30_000]);
  });
});

describe('@cron-accuracy: fires at the scheduled instant, never early', () => {
  it('does not fire before T+8s and fires exactly at T+8s', async () => {
    const h = harness([], { startMs: 1000 });
    h.runner.add(job({ schedule: { kind: 'at', at: 1000 + 8000 } }));
    await h.clock.advance(7999);
    expect(h.fired.length).toBe(0); // never early
    await h.clock.advance(1);
    expect(h.fired).toEqual([{ id: 'j1', at: 9000 }]); // exact
  });
});

describe('@cron-subminute: seconds-granularity every 5s (fidelity EventBridge could not give)', () => {
  it('fires every 5s', async () => {
    const h = harness();
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 5000 } }));
    await h.clock.advance(17_000);
    expect(h.fired.map((f) => f.at)).toEqual([5000, 10_000, 15_000]);
  });
});

describe('@cron-overlap: protect skips overlapping ticks, no pile-up', () => {
  it('a 25s-long fire on every-10s fires at 10 and 40, skipping 20 & 30', async () => {
    // fire resolves 25s of virtual time after it starts
    const slow = (j, clock) => new Promise((resolve) => { clock.setTimeout(resolve, 25_000); });
    const h = harness([], { fire: slow });
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await h.clock.advance(45_000);
    expect(h.fired.map((f) => f.at)).toEqual([10_000, 40_000]);
  });
});

describe('@cron-error-badexpr: invalid schedule stores/arms nothing', () => {
  it('add throws and leaves the store empty', () => {
    const h = harness();
    expect(() => h.runner.add(job({ schedule: { kind: 'cron', expr: 'garbage' } }))).toThrow();
    expect(h.store.list().length).toBe(0);
    expect(h.runner._handles.size).toBe(0);
  });
});

describe('@cron-turn-error: a throwing turn keeps the schedule alive + alerts after N', () => {
  it('increments consecutiveErrors, keeps firing, alerts once at threshold', async () => {
    const h = harness([], { fire: async () => { throw new Error('turn boom'); } });
    h.runner.add(job({
      schedule: { kind: 'every', everyMs: 10_000 },
      failureAlert: { afterConsecutiveErrors: 3 },
    }));
    await h.clock.advance(35_000);
    expect(h.fired.length).toBe(3); // next fire still happens each time
    expect(h.store.get('j1').state.consecutiveErrors).toBe(3);
    expect(h.store.get('j1').state.lastRunStatus).toBe('error');
    expect(h.onAlert).toHaveBeenCalledTimes(1); // fires exactly at the threshold
  });
});

describe('@cron-restart-recovery: recurring resumes across a restart, no double-fire', () => {
  it('a fresh runner over the same store re-arms without replaying missed ticks', async () => {
    const clock = new FakeClock(0);
    const store = memStore();
    const firedA = [];
    const r1 = createCronRunner({ clock, store, fire: async (j) => firedA.push(clock.now()) });
    r1.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await clock.advance(25_000); // fires 10, 20
    r1.stop(); // "dispatcher goes down"

    // downtime: time passes with no scheduler (advance while stopped fires nothing new)
    clock.nowMs = 63_000;

    const firedB = [];
    const r2 = createCronRunner({ clock, store, fire: async () => firedB.push(clock.now()) });
    await r2.start(); // boot-recovery
    await clock.advance(10_000); // now 63s -> next tick 70s
    expect(firedA).toEqual([10_000, 20_000]);
    // skip-to-next: NOT backfilled to 30/40/50/60; resumes at the next aligned tick
    expect(firedB).toEqual([70_000]);
  });
});

describe('@cron-downtime-oneshot: an at that elapsed during downtime fires once on boot', () => {
  it('boot catch-up fires the overdue one-shot exactly once, then deletes it', async () => {
    const clock = new FakeClock(0);
    const store = memStore([job({ schedule: { kind: 'at', at: 5000 } })]);
    const fired = [];
    // "boot" at t=60s, well past the 5s scheduled fire
    clock.nowMs = 60_000;
    const runner = createCronRunner({ clock, store, fire: async () => fired.push(clock.now()) });
    await runner.start();
    expect(fired).toEqual([60_000]); // catch-up once, at boot time
    expect(store.get('j1')).toBeUndefined();
    await clock.advance(60_000);
    expect(fired.length).toBe(1); // never again
  });
});

// ── Pinned wrapper behaviours (documented, not characterised against live ECS) ──

describe('pinned: past-`at` at add time fires once immediately then deletes', () => {
  it('fires now and removes the job', async () => {
    const h = harness([], { startMs: 10_000 });
    h.runner.add(job({ schedule: { kind: 'at', at: 5000 } })); // already in the past
    await h.clock.advance(0); // let the immediate microtask run
    expect(h.fired).toEqual([{ id: 'j1', at: 10_000 }]);
    expect(h.store.get('j1')).toBeUndefined();
  });
});

describe('long delay: a far-future job does not fire early (setTimeout 24.8-day ceiling)', () => {
  it('re-arms past the cap and fires at the scheduled instant, never early', async () => {
    const h = harness();
    const AT = 2_592_000_000; // 30 days — beyond MAX_TIMER_MS (~24.8d), where raw setTimeout would clamp+fire-now
    h.runner.add(job({ schedule: { kind: 'at', at: AT } }));
    await h.clock.advance(2_000_000_000); // past setTimeout's 2^31 ceiling but before AT
    expect(h.fired.length).toBe(0); // MUST NOT fire early
    await h.clock.advance(AT - 2_000_000_000); // reach the scheduled time
    expect(h.fired).toEqual([{ id: 'j1', at: AT }]);
  });
});

describe('lifecycle: remove disarms; disabled never fires', () => {
  it('remove stops future fires', async () => {
    const h = harness();
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await h.clock.advance(10_000);
    h.runner.remove('j1');
    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(1);
    expect(h.store.get('j1')).toBeUndefined();
  });
  it('a disabled job is never armed', async () => {
    const h = harness();
    h.runner.add(job({ enabled: false, schedule: { kind: 'every', everyMs: 10_000 } }));
    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(0);
  });
});

// Live 2026-08-16 (dm-ux0mz5ckp2r): three 15-minute jobs resumed at 18:13:24 all fired at
// 18:16:15-18:16:42 — a phase inherited from 19:01 the previous day, nothing to do with the resume.
// Uniformly distributed in (0, everyMs], so the same press could have fired them in seconds.
describe('resume re-anchors an `every` schedule (pause stops the clock)', () => {
  const paused = (over = {}) => job({
    enabled: false, schedule: { kind: 'every', everyMs: 10_000, anchorMs: 0 }, ...over,
  });

  it('the first run after resume is a FULL period away, not the inherited phase', async () => {
    const h = harness([paused()], { startMs: 0 });
    await h.clock.advance(9_000);                        // inherited phase would fire in 1s
    h.runner.update({ ...h.store.get('j1'), enabled: true });
    await h.clock.advance(9_999);
    expect(h.fired.length).toBe(0);                      // ...and does not
    await h.clock.advance(1);
    expect(h.fired.map((f) => f.at)).toEqual([19_000]);  // resumed at 9s + one full 10s period
  });

  it('records the new anchor, so the stored job and the App Home "Next run" agree', async () => {
    const h = harness([paused()], { startMs: 0 });
    await h.clock.advance(9_000);
    h.runner.update({ ...h.store.get('j1'), enabled: true });
    expect(h.store.get('j1').schedule.anchorMs).toBe(9_000);
    expect(h.store.get('j1').state.nextRunAtMs).toBe(19_000);
  });

  it('an already-enabled job keeps its phase — an unrelated edit must not move the schedule', async () => {
    const h = harness([job({ schedule: { kind: 'every', everyMs: 10_000, anchorMs: 0 } })]);
    await h.clock.advance(9_000);
    h.runner.update({ ...h.store.get('j1'), name: 'renamed' });
    expect(h.store.get('j1').schedule.anchorMs).toBe(0);
    await h.clock.advance(1_000);
    expect(h.fired.length).toBe(1);                      // still on the original phase
  });

  it('`cron` is wall-clock — resuming "every day at 07:00" still means 07:00', async () => {
    const start = Date.UTC(2026, 0, 1, 6, 0, 0);
    const h = harness([job({ enabled: false, schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' } })], { startMs: start });
    await h.clock.advance(30 * 60_000);                  // 06:30
    h.runner.update({ ...h.store.get('j1'), enabled: true });
    expect(h.store.get('j1').state.nextRunAtMs).toBe(Date.UTC(2026, 0, 1, 7, 0, 0));
  });

  it('pausing does not re-anchor (only the disabled→enabled edge does)', async () => {
    const h = harness([job({ schedule: { kind: 'every', everyMs: 10_000, anchorMs: 0 } })]);
    await h.clock.advance(9_000);
    h.runner.update({ ...h.store.get('j1'), enabled: false });
    expect(h.store.get('j1').schedule.anchorMs).toBe(0);
  });

  it('a restart still preserves phase — boot recovery is not a resume', async () => {
    // start() re-arms from the stored schedule; nothing on that path calls update(), so a
    // dispatcher roll must not silently push every recurring job out by a full period.
    const h = harness([job({ schedule: { kind: 'every', everyMs: 10_000, anchorMs: 0 } })], { startMs: 9_000 });
    await h.runner.start();
    expect(h.store.get('j1').schedule.anchorMs).toBe(0);
    expect(h.store.get('j1').state.nextRunAtMs).toBe(10_000);
  });
});

describe('semaphore: global maxConcurrent caps simultaneous fires', () => {
  it('never exceeds the cap when many jobs are due at once', async () => {
    const clock = new FakeClock(0);
    const store = memStore();
    let inFlight = 0;
    let peak = 0;
    const slow = () => new Promise((resolve) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      clock.setTimeout(() => { inFlight -= 1; resolve(); }, 5000);
    });
    const runner = createCronRunner({ clock, store, fire: slow, maxConcurrent: 2 });
    for (let i = 0; i < 6; i += 1) {
      runner.add(job({ id: `j${i}`, schedule: { kind: 'at', at: 1000 } }));
    }
    await clock.advance(20_000);
    expect(peak).toBeLessThanOrEqual(2);
  });
});


// ── Regression: the firing gate must close EVERY path ───────────────────────
//
// A real incident (2026-08-12): the gate was placed on the boot path only, so
// `cronService.start()` was skipped but a job POSTed afterwards by an agent still armed
// through add() — and fired 4.9s later, delivering a scheduled Slack message from a stack
// that was supposed to be dormant. The gate belongs at arm(), which every route funnels
// through.
describe('firing gate (enabled: false)', () => {
  it('does not fire a job armed at boot', async () => {
    const h = harness([job({ schedule: { kind: 'every', everyMs: 10_000 } })], { enabled: false });
    await h.runner.start();
    await h.clock.advance(60_000);
    expect(h.fired).toEqual([]);
  });

  it('does not fire a job ADDED after boot — the path that actually leaked', async () => {
    const h = harness([], { enabled: false });
    await h.runner.start();
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await h.clock.advance(60_000);
    expect(h.fired).toEqual([]);
    // stored and listable — seeding must still work, only firing is off
    expect(h.runner.list().map((j) => j.id)).toEqual(['j1']);
  });

  it('does not fire a one-shot added after boot', async () => {
    const h = harness([], { enabled: false });
    h.runner.add(job({ schedule: { kind: 'at', at: 5_000 } }));
    await h.clock.advance(30_000);
    expect(h.fired).toEqual([]);
  });

  it('refuses runNow, which bypasses arm() entirely', async () => {
    const h = harness([job({ schedule: { kind: 'every', everyMs: 10_000 } })], { enabled: false });
    await expect(h.runner.runNow('j1')).rejects.toThrow(/disabled/i);
    expect(h.fired).toEqual([]);
  });

  it('still fires when enabled (gate is not simply always-off)', async () => {
    const h = harness([], { enabled: true });
    await h.runner.start();
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 10_000 } }));
    await h.clock.advance(25_000);
    expect(h.fired.map((f) => f.at)).toEqual([10_000, 20_000]);
  });
});

// §3a' — a fire DECLINED by the CRON_RUNNER gate (cron-fire.js) did not run: no turn, no cost, no
// output. The runner has to treat that as "nothing happened", not as a successful run.
describe('a gated tick leaves the run-state alone', () => {
  const gatedFire = { fire: async () => ({ gated: true, runner: 'openclaw' }) };

  it('records no lastRunAtMs / lastRunStatus for a tick this stack declined', async () => {
    const h = harness([], gatedFire);
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    await h.clock.advance(60_000);
    expect(h.fired.length).toBe(1);              // the tick happened…
    const state = h.store.get('j1').state;
    expect(state.lastRunAtMs).toBeUndefined();   // …and nothing about it was recorded
    expect(state.lastRunStatus).toBeUndefined();
    // Otherwise every tick of every un-migrated job would write `ok` + a fresh timestamp, and the
    // store — and the App Home line that reads it — would report a healthy run history for jobs
    // that have never once executed here.
  });

  it('still writes nextRunAtMs, because the job IS still armed here', async () => {
    const h = harness([], gatedFire);
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    await h.clock.advance(60_000);
    expect(h.store.get('j1').state.nextRunAtMs).toBe(120_000);
  });

  it('cannot trip failureAlert — a scope awaiting cutover is not failing', async () => {
    const h = harness([], gatedFire);
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 }, failureAlert: { afterConsecutiveErrors: 1 } }));
    await h.clock.advance(180_000);
    expect(h.onAlert).not.toHaveBeenCalled();
    expect(h.store.get('j1').state.consecutiveErrors).toBeUndefined();
  });
});

// The gate lets an explicit human run through (cron-fire runnerGate) — that is how you prove a
// hydrated job works on archie BEFORE handing the schedule over. The runner is what marks the run
// as human-initiated, so the flag has to survive the trip.
describe('runNow tells the fire path it is a manual run', () => {
  it('passes { manual: true }; a scheduled tick does not', async () => {
    const h = harness([]);
    h.runner.add(job({ schedule: { kind: 'every', everyMs: 60_000 } }));
    await h.clock.advance(60_000);
    expect(h.fire.mock.calls[0][1]).toBeUndefined();

    await h.runner.runNow('j1');
    expect(h.fire.mock.calls[1][1]).toEqual({ manual: true });
  });
});

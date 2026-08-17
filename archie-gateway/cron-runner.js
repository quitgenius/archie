'use strict';

// Dispatcher-owned cron runner (Option B — see pi-cron-migration-plan.md).
//
// The scheduler lives in the always-on dispatcher (desired_count=1), not in the
// scale-to-zero agent runtime. A due job runs a full agent turn via the injected
// `fire(job)` (which is the runtime-gate + forwardToAgentCore path in prod).
//
// TESTABILITY: croner is used ONLY as a PURE schedule-expression calculator
// (`Cron(expr).nextRun(from)` — no internal timer). Actual firing is driven by an
// injected `clock` ({ now, setTimeout, clearTimeout }). In prod that wraps the real
// Date/timers; in tests a FakeClock advances virtual time deterministically. This
// avoids the fragile fake-timers-vs-croner-internal-timer interplay entirely.
//
// SINGLETON: this runner and its EFS store both assume ONE dispatcher instance.
// Two instances = two schedulers (double-fire) AND two writers of the same EFS
// files (corruption). Do NOT scale the dispatcher out without a lease/lock.

const { Cron } = require('croner');

// Smallest permitted `every` interval. OpenClaw allows seconds and we deliberately
// KEEP sub-minute fidelity (the whole reason we run croner in-process rather than
// EventBridge, whose floor is 1 minute); 1s guards against a pathological busy-loop.
const MIN_EVERY_MS = 1000;

const DEFAULT_ALERT_AFTER = 3; // consecutive errors before failureAlert fires

// setTimeout's max delay (2^31-1 ms ≈ 24.8 days); larger values clamp to fire-immediately.
const MAX_TIMER_MS = 2_147_483_647;

// ── Pure helpers ──────────────────────────────────────────────────────────────

/**
 * Validate a schedule. Throws on invalid so `add`/`update` reject up-front and
 * nothing partial is ever stored or armed (@cron-error-badexpr).
 */
function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('cron: schedule required');
  switch (schedule.kind) {
    case 'at':
      if (!Number.isFinite(schedule.at)) throw new Error('cron: at must be a finite epoch-ms');
      return;
    case 'every':
      if (!Number.isFinite(schedule.everyMs) || schedule.everyMs < MIN_EVERY_MS) {
        throw new Error(`cron: everyMs must be a finite >= ${MIN_EVERY_MS}ms`);
      }
      if (schedule.anchorMs !== undefined && !Number.isFinite(schedule.anchorMs)) {
        throw new Error('cron: anchorMs must be a finite epoch-ms when provided');
      }
      return;
    case 'cron':
      if (typeof schedule.expr !== 'string' || !schedule.expr.trim()) {
        throw new Error('cron: expr required');
      }
      try {
        const c = new Cron(schedule.expr, schedule.tz ? { timezone: schedule.tz } : {});
        c.stop();
      } catch (e) {
        throw new Error(`cron: invalid expr "${schedule.expr}": ${e.message}`);
      }
      return;
    default:
      throw new Error(`cron: unknown schedule kind "${schedule && schedule.kind}"`);
  }
}

/**
 * Next fire time strictly AFTER `fromMs`, or null if there is none (an elapsed
 * one-shot `at`). Pure. `base` anchors an unanchored `every` (created-at fallback).
 */
function computeNextRun(schedule, fromMs, base = 0) {
  switch (schedule.kind) {
    case 'at':
      return schedule.at > fromMs ? schedule.at : null;
    case 'every': {
      const anchor = schedule.anchorMs ?? base;
      if (anchor > fromMs) return anchor;
      const k = Math.floor((fromMs - anchor) / schedule.everyMs) + 1;
      return anchor + k * schedule.everyMs;
    }
    case 'cron': {
      const c = new Cron(schedule.expr, schedule.tz ? { timezone: schedule.tz } : {});
      const d = c.nextRun(new Date(fromMs));
      c.stop();
      return d ? d.getTime() : null;
    }
    default:
      throw new Error(`cron: unknown schedule kind "${schedule.kind}"`);
  }
}

function isOneShot(job) {
  return job.schedule.kind === 'at' || job.deleteAfterRun === true;
}

function alertThreshold(job) {
  const n = job.failureAlert && job.failureAlert.afterConsecutiveErrors;
  return Number.isFinite(n) ? n : DEFAULT_ALERT_AFTER;
}

// ── Real clock (prod) ───────────────────────────────────────────────────────

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};

// ── Runner ────────────────────────────────────────────────────────────────────

/**
 * @param deps.clock   { now, setTimeout, clearTimeout }
 * @param deps.fire    async (job) => void  — runs the agent turn; throws on failure
 * @param deps.store   { list, get, put, delete, patchState }
 * @param deps.log     optional { info, warn, error }
 * @param deps.onAlert optional (job) => void — failureAlert reached
 * @param deps.maxConcurrent optional cap on simultaneous fires (default 8)
 */
function createCronRunner(deps) {
  const { clock, fire, store } = deps;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  // Master switch for FIRING. Default on; `enabled: false` makes the runner record and
  // list jobs without ever scheduling one.
  //
  // It lives here, not at the boot path, because arm() is the single choke point every
  // route funnels through — start() (boot recovery), add() (a job created via the manager
  // API), update(), and arm()'s own long-delay re-arm. An earlier version gated only
  // start(); a job POSTed afterwards by an agent still armed through add() and fired.
  const firingEnabled = deps.enabled !== false;
  let disabledNoticeLogged = false;
  const onAlert = deps.onAlert || (() => {});
  // A run that outlives this is reported, not killed — the timeout still owns termination. 10
  // minutes is the point at which a cron turn is no longer "slow", and for anything firing more
  // often than that it also means ticks are being DROPPED (see the overlap guard in onDue).
  const longRunMs = deps.longRunMs || 10 * 60_000;
  const onLongRun = deps.onLongRun || (() => {});
  // Fired when a tick is skipped because the previous run is still going. There is no queue and no
  // catch-up: the tick is discarded. It was log.info only, so a job silently running at a fraction
  // of its configured frequency looked perfectly healthy on every metric.
  const onOverlapSkip = deps.onOverlapSkip || (() => {});
  const maxConcurrent = deps.maxConcurrent || 8;

  const handles = new Map(); // jobId -> clock timer handle (the NEXT armed tick)
  const running = new Set(); // jobId currently firing (per-job overlap protect)
  let active = 0; // global in-flight count (semaphore)
  const waiters = []; // resolvers queued on the semaphore

  function acquire() {
    if (active < maxConcurrent) { active += 1; return Promise.resolve(); }
    return new Promise((resolve) => waiters.push(resolve));
  }
  function release() {
    active -= 1;
    const next = waiters.shift();
    if (next) { active += 1; next(); }
  }

  function disarm(id) {
    const h = handles.get(id);
    if (h !== undefined) { clock.clearTimeout(h); handles.delete(id); }
  }

  function arm(job) {
    if (!firingEnabled) {
      if (!disabledNoticeLogged) {
        disabledNoticeLogged = true;
        log.warn({ jobId: job && job.id }, 'cron firing DISABLED — jobs are stored and listed but never armed');
      }
      return false;
    }
    const nowMs = clock.now();
    const nextMs = computeNextRun(job.schedule, nowMs, job.createdAtMs || 0);
    if (nextMs === null) return false; // elapsed one-shot — nothing to arm
    store.patchState(job.id, { nextRunAtMs: nextMs });
    const delay = Math.max(0, nextMs - nowMs);
    // setTimeout's delay is a 32-bit int (~24.8 days); a larger value is clamped and
    // fires IMMEDIATELY. For a far-future `at`/`every`/yearly-`cron`, wake at the cap
    // and re-arm (recompute the remaining delay) rather than firing early.
    if (delay > MAX_TIMER_MS) {
      const handle = clock.setTimeout(() => {
        handles.delete(job.id);
        const fresh = store.get(job.id);
        if (fresh && fresh.enabled !== false) arm(fresh);
      }, MAX_TIMER_MS);
      handles.set(job.id, handle);
      return true;
    }
    const handle = clock.setTimeout(() => onDue(job.id), delay);
    handles.set(job.id, handle);
    return true;
  }

  async function fireGuarded(job, opts) {
    await acquire();
    try {
      return await fire(job, opts);
    } finally {
      release();
    }
  }

  /**
   * @param opts.manual  this run was asked for by a human (cron.run / App Home "Run now"), not by
   *                     the schedule. Passed through to `fire`, which uses it to bypass the
   *                     per-scope CRON_RUNNER gate — see cron-fire.js.
   */
  async function runOnce(job, opts) {
    // Records run-state, updates consecutive-error counter + alert. Never throws.
    let status = 'ok';
    let err;
    let result;
    const startedMs = clock.now();
    try {
      result = await fireGuarded(job, opts);
    } catch (e) {
      status = 'error';
      err = e;
    }
    // A fire DECLINED by the CRON_RUNNER gate did not run: no turn, no cost, no output. Recording
    // it would write `lastRunStatus:'ok'` and a fresh `lastRunAtMs` on every tick of every job whose
    // scope still belongs to OpenClaw — so the store, and the App Home line that reads it, would
    // report a healthy run history for jobs that have never once executed here. Leaving the state
    // untouched keeps it honest: what it holds is what the hydrator imported, until we really run.
    if (result && result.gated) return;
    const durationMs = clock.now() - startedMs;
    if (durationMs >= longRunMs) {
      log.warn({ jobId: job.id, durationMs, status }, 'cron run exceeded the long-run threshold');
      try { onLongRun(job, { durationMs, status }); } catch { /* never break the scheduler */ }
    }
    const prev = (store.get(job.id) || {}).state || {};
    const consecutiveErrors = status === 'error' ? (prev.consecutiveErrors || 0) + 1 : 0;
    store.patchState(job.id, {
      lastRunAtMs: clock.now(),
      lastDurationMs: durationMs,
      lastRunStatus: status,
      lastError: err ? String(err.message || err) : undefined,
      consecutiveErrors,
    });
    if (status === 'error') {
      log.warn({ jobId: job.id, err: String(err && err.message), consecutiveErrors }, 'cron fire failed');
      if (consecutiveErrors === alertThreshold(job)) onAlert(store.get(job.id) || job);
    }
  }

  async function onDue(id) {
    const job = store.get(id);
    if (!job) return; // removed while armed
    handles.delete(id); // this tick's timer has fired

    const oneShot = isOneShot(job);
    // Re-arm the NEXT occurrence at its SCHEDULED time BEFORE firing, so schedule
    // alignment is preserved and overlap is caught by `protect` (below) rather than
    // by drifting. One-shots are never re-armed.
    if (!oneShot && job.enabled !== false) arm(job);

    if (job.enabled === false) return;

    if (running.has(id)) {
      // protect: previous fire of THIS job is still running — skip this tick, no pile-up.
      // The tick is DISCARDED, never queued, so this is a lost execution and must be countable.
      log.info({ jobId: id }, 'cron protect: skipping overlapping tick');
      try { onOverlapSkip(job); } catch { /* metrics must never break the scheduler */ }
      return;
    }

    running.add(id);
    try {
      await runOnce(job);
    } finally {
      running.delete(id);
      if (oneShot) { store.delete(id); disarm(id); }
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Boot-recovery. For each stored job:
   *  - elapsed one-shot `at` (fired-time passed during downtime) → catch-up: fire ONCE now.
   *  - recurring with missed ticks → skip-to-next (NO backfill of missed ticks).
   */
  async function start() {
    let armed = 0;
    let caughtUp = 0;
    let disabled = 0;
    for (const job of store.list()) {
      if (job.enabled === false) { disabled += 1; continue; }
      if (isOneShot(job)) {
        const at = job.schedule.kind === 'at' ? job.schedule.at : null;
        if (at !== null && at <= clock.now()) {
          log.info({ jobId: job.id }, 'cron boot catch-up: firing overdue one-shot');
          caughtUp += 1;
          running.add(job.id);
          try { await runOnce(job); } finally { running.delete(job.id); store.delete(job.id); }
        } else if (arm(job)) {
          armed += 1;
        }
      } else if (arm(job)) { // skip-to-next: computeNextRun(now) ignores missed ticks
        armed += 1;
      }
    }
    log.info({ armed, caughtUp, disabled }, 'cron boot-recovery complete');
  }

  function add(job) {
    validateSchedule(job.schedule);
    // The store owns identity: it may enrich the job (e.g. derive a globally-unique
    // composite `id` from agentId+jobId). Arm/track the STORED record so the runner's
    // key matches the store's. (Falls back to the input for stores that return void.)
    const rec = store.put(job) || job;
    // DISARM FIRST — add() on an id that is already armed is an UPDATE, because `store.put`
    // overwrites by id. Without this the previous timer is orphaned rather than cancelled:
    // arm() does `handles.set(id, handle)`, so the map forgets the old handle while it stays
    // live, and the job fires TWICE per period. Every re-add leaks another one.
    //
    // Live, 2026-08-12: re-running the hydrator (it seeds through this path — api.add → POST
    // /cron/ → add) left one job with two timers, visible as two ticks 19ms apart for the same
    // jobId. The overlap guard masked it as "skipping overlapping tick", so a duplicate looked
    // like a slow turn; with fast turns it is two real turns and two Slack messages.
    //
    // update() has always done this. add() is the path the hydrator and the agent's cron tool use.
    disarm(rec.id);
    if (rec.enabled === false) return rec;
    // past-`at` at add time → fire once immediately (same policy as boot catch-up).
    if (rec.schedule.kind === 'at' && rec.schedule.at <= clock.now()) {
      running.add(rec.id);
      Promise.resolve()
        .then(() => runOnce(rec))
        .finally(() => { running.delete(rec.id); store.delete(rec.id); });
      return rec;
    }
    arm(rec);
    return rec;
  }

  /**
   * RESUMING RE-ANCHORS AN `every` SCHEDULE. Pausing stops the clock; resuming restarts it.
   *
   * An `every` job's phase comes from `anchorMs`, set once when the job was created. Resume did not
   * touch it, so the first run after resume landed at whatever point in the period the ORIGINAL
   * creation time dictated — uniformly anywhere in `(0, everyMs]`, with no relation to when the
   * button was pressed. Live 2026-08-16: three 15-minute jobs resumed at 18:13:24 all fired at
   * 18:16:15-18:16:42, on a phase inherited from 19:01 the previous day. It reads as "resuming ran
   * them", and at a different phase it would have been seconds rather than minutes.
   *
   * Re-anchoring to now means resume schedules the first run one FULL period out, which is also
   * what the App Home "Next run" line then honestly shows. Running it now is a separate, explicit
   * action — the Run now button — and it should stay the only way to get one.
   *
   * ONLY on the disabled→enabled edge, and ONLY for `every`:
   *   - an already-enabled job being patched keeps its phase (an unrelated edit must not silently
   *     move the schedule);
   *   - `cron` is wall-clock by definition — "every day at 07:00" means 07:00 whenever you resume;
   *   - `at` is a fixed instant with no phase to re-anchor.
   */
  function reanchorOnResume(job) {
    if (job.enabled === false || job.schedule.kind !== 'every') return job;
    const before = store.get(job.id);
    if (!before || before.enabled !== false) return job;
    return { ...job, schedule: { ...job.schedule, anchorMs: clock.now() } };
  }

  function update(job) {
    validateSchedule(job.schedule);
    const next = reanchorOnResume(job);
    const rec = store.put(next) || next;
    disarm(rec.id);
    if (rec.enabled !== false && !(rec.schedule.kind === 'at' && rec.schedule.at <= clock.now())) {
      arm(rec);
    }
    return rec;
  }

  function remove(id) {
    disarm(id);
    store.delete(id);
  }

  function list() {
    return store.list();
  }

  // Out-of-band manual fire (cron.run) — does not disturb the schedule.
  async function runNow(id) {
    // Manual run bypasses arm() entirely, so it needs its own check.
    if (!firingEnabled) throw new Error('cron firing is disabled for this runner (deps.enabled === false)');
    const job = store.get(id);
    if (!job) throw new Error(`cron: no job ${id}`);
    running.add(id);
    // `manual` — an explicit human run, which the CRON_RUNNER gate lets through even when this
    // scope's schedule still belongs to OpenClaw (cron-fire.js runnerGate).
    try { await runOnce(job, { manual: true }); } finally { running.delete(id); }
  }

  function stop() {
    for (const id of handles.keys()) clock.clearTimeout(handles.get(id));
    handles.clear();
  }

  return { start, add, update, remove, list, runNow, stop, _handles: handles };
}

module.exports = {
  createCronRunner,
  computeNextRun,
  validateSchedule,
  isOneShot,
  realClock,
  MIN_EVERY_MS,
  DEFAULT_ALERT_AFTER,
};

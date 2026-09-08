'use strict';

// Composition root for the dispatcher cron subsystem (pi-cron-migration-plan.md §3).
// Wires the Phase-1 modules into the single object index.js instantiates and boots.
// index.js supplies the live collaborators (agentCore client, a session-id deriver, and
// the delivery fn); everything else is internal. The dispatcher is the sole scheduler.
//
//   const cron = createCronService({ dir:'/efs/cron', agentCore, sessionIdFor, deliver });
//   await cron.start();                     // load store + arm all jobs (boot-recovery)
//   cron.add(job) / update / remove / list  // manager API delegates here

const { createCronRunner, realClock } = require('./cron-runner');
const { createCronStore, keyOf } = require('./cron-store');
const { createCronFire } = require('./cron-fire');
const { createCronInventoryEmitter } = require('./cron-inventory-metrics');

function createCronService(opts) {
  const log = opts.log || { info() {}, warn() {}, error() {}, child() { return this; } };

  const store = createCronStore({ dir: opts.dir, fs: opts.fs, log });

  // Inventory gauge: periodically snapshot the CONFIGURED job set (per agent / per channel)
  // to EMF, so "which crons are set up per channel" is a queryable CloudWatch metric — the
  // config-inventory counterpart to the per-fire trace. setInterval/clearInterval are
  // injectable for tests; the default interval is 60s. inventoryIntervalMs <= 0 disables it.
  const inventory = createCronInventoryEmitter({ emit: opts.inventoryEmit, now: opts.now, log });
  const inventoryIntervalMs = opts.inventoryIntervalMs == null ? 60_000 : opts.inventoryIntervalMs;
  const setIntervalFn = opts.setInterval || setInterval;
  const clearIntervalFn = opts.clearInterval || clearInterval;
  let inventoryTimer = null;

  // M4.5: per-job records ride their OWN, slower timer. The aggregate gauges are cheap (one line
  // per agent/channel/reason) and stay at 60s; per-job is O(routes x jobs) per tick, which is fine
  // at 15 min and wasteful at 60s once the prod fleet (~208 routes) is on it. 0 disables.
  const jobRecordIntervalMs = opts.jobRecordIntervalMs == null ? 900_000 : opts.jobRecordIntervalMs;
  let jobRecordTimer = null;

  function snapshotInventory() {
    return inventory.snapshot(store.list());
  }

  function snapshotJobRecords() {
    return inventory.jobRecords(store.list());
  }

  /**
   * Emit-on-change. The periodic sweep alone answers "what is configured" only as of the last
   * tick, which makes the most common question — "I just created a cron job, did it register
   * correctly?" — unanswerable for up to a full interval. Mutations are rare and bounded (one
   * agent action each), so emitting the affected job immediately costs nothing in steady state
   * and makes a new or edited job visible within seconds. The periodic sweep stays as the
   * drift/backstop pass (a record that stops being refreshed is one that no longer exists).
   *
   * Also re-snapshots the aggregates so CronJobsMisconfigured reflects the change immediately
   * rather than at the next 60s tick. Never throws — metrics must not fail a cron mutation.
   */
  function emitChange(job) {
    try {
      if (job) inventory.jobRecords([job]);
      inventory.snapshot(store.list());
    } catch (err) {
      log.warn({ err: String(err && err.message) }, 'cron: emit-on-change failed');
    }
  }

  function add(job) {
    const rec = runner.add(job);
    // Telemetry AFTER the mutation and never able to fail it — same contract as remove()'s.
    try {
      if (opts.onJobAdded) opts.onJobAdded(rec || job, { source: 'requested' });
    } catch (err) {
      log.warn({ err: String(err && err.message) }, 'cron: add telemetry failed');
    }
    emitChange(rec || job);
    return rec;
  }

  /**
   * PATCH, not replace — fixed here in the service so EVERY caller gets it, not just HTTP.
   *
   * The bug this fixes (found live): the agent-side cron tool names its parameter `patch` and
   * forwards it verbatim, and the agent-local EFS mirror really does patch (mirror.patchJob) —
   * but the dispatcher did `{...req.body, agentId, jobId}` -> store.put(), which preserves only
   * `state`. So a partial update through the tool silently destroyed payload / delivery / name /
   * sessionTarget on the AUTHORITATIVE copy while the mirror kept them. Proven live: after a
   * {enabled, schedule} update the stored job read
   *   name=null payload=null delivery=null sessionTarget=null
   * A payload-less job then invokes with prompt=undefined and the runtime 400s, and a
   * delivery-less job goes silent — which is very plausibly how a job loses its delivery block
   * in the first place, since "change my job's schedule" is the commonest update there is.
   *
   * Shallow merge is the right depth: nested objects (schedule/delivery/payload) are replaced
   * wholesale when present in the patch, which matches field-level patch semantics and the
   * mirror. Merging the existing record first also fixes the second failure mode — a patch with
   * no `schedule` used to hit validateSchedule(undefined) and 400 outright.
   *
   * NB with merge you can no longer clear a field by omitting it; use delivery.mode 'none'.
   */
  function update(job) {
    const existing = store.get(job.id || keyOf(job.agentId, job.jobId));
    const merged = existing ? { ...existing, ...job } : job;
    const rec = runner.update(merged);
    // `existing` is read BEFORE the merge, so the event can carry the previous value — the thing a
    // CronJobRecord can never carry, and the reason an `enabled` flip was only findable by diffing
    // ~500 sweeps. Cloned because `merged` spreads `existing` and the runner may mutate in place.
    try {
      if (opts.onJobUpdated) opts.onJobUpdated(existing ? { ...existing } : null, rec || merged, { source: 'requested' });
    } catch (err) {
      log.warn({ err: String(err && err.message) }, 'cron: update telemetry failed');
    }
    emitChange(rec || merged);
    return rec;
  }

  function remove(id) {
    // Read the job BEFORE it goes, so the removal event can describe what was deleted. Without
    // this the only trace was a CronJobRecord ceasing to appear on the next sweep.
    const before = store.get(id) || null;
    const rec = runner.remove(id);
    try {
      if (opts.onJobRemoved) opts.onJobRemoved(before || { id }, { reason: 'requested' });
    } catch (err) {
      log.warn({ id, err: String(err && err.message) }, 'cron: removal telemetry failed');
    }
    emitChange(null); // no record for a deleted job — just refresh the aggregates
    return rec;
  }
  /**
   * Record the DELIVERY outcome in the job's own state.
   *
   * Before this, a job that ran and delivered nothing stored `lastRunStatus:"ok"` with
   * `consecutiveErrors:0` — observed live on a job that had never once reached Slack. That is
   * the first thing an agent or a human inspects, so the store was the last place still
   * reporting success.
   *
   * The fix is ADDITIVE, not a redefinition: `lastRunStatus` keeps meaning "did the TURN run",
   * because `consecutiveErrors` (and therefore failureAlert) is derived from it — flipping it on
   * a delivery failure would make the swallow fatal, which is exactly what the swallow exists to
   * prevent. The delivery outcome gets its own adjacent fields, so "run ok, delivery failed" is
   * precisely representable instead of being flattened to "ok".
   */
  function deliverAndRecord(job, final) {
    const deliverFn = opts.deliver || (async () => ({ delivered: false, reason: 'none' }));
    return Promise.resolve(deliverFn(job, final)).then((result) => {
      try {
        const id = job.id || keyOf(job.agentId, job.jobId);
        const delivered = !!(result && result.delivered);
        store.patchState(id, {
          lastDeliveryAtMs: (opts.now || Date.now)(),
          lastDeliveryStatus: delivered ? 'ok' : (result && result.error ? 'failed' : 'skipped'),
          lastDeliveryReason: result && result.reason ? String(result.reason) : undefined,
          lastDeliveryError: result && result.error ? String(result.error) : undefined,
        });
      } catch (err) {
        log.warn({ jobId: job.jobId, err: String(err && err.message) }, 'cron: delivery-state record failed');
      }
      return result;
    });
  }

  // The per-scope CRON_RUNNER gate. Optional: without it every job fires here, which is the
  // pre-flag behaviour and what the older unit tests construct.
  const runnerFlags = opts.runnerFlags || null;

  const fireHandler = createCronFire({
    agentCore: opts.agentCore,
    ensureRuntime: opts.ensureRuntime,   // image-pointer-aware; see cron-fire

    sessionIdFor: opts.sessionIdFor,
    deliver: deliverAndRecord,
    now: opts.now,
    runnerFlags,
    onRunnerGated: opts.onRunnerGated,
    log,
  });
  const runner = createCronRunner({
    clock: opts.clock || realClock,
    store,
    fire: fireHandler.fire,
    onAlert: opts.onAlert,
    onLongRun: opts.onLongRun,
    onOverlapSkip: opts.onOverlapSkip,
    longRunMs: opts.longRunMs,
    maxConcurrent: opts.maxConcurrent,
    enabled: opts.enabled,
    log,
  });

  // Load persisted jobs from EFS, then arm them (skip-to-next recurring, catch-up
  // overdue one-shots) — the boot-recovery half of owning the timer.
  async function start() {
    store.load();
    await runner.start();
    // Emit an immediate inventory gauge at boot, then on an interval. unref() so this timer
    // never keeps the process alive on shutdown.
    snapshotInventory();
    if (inventoryIntervalMs > 0 && !inventoryTimer) {
      inventoryTimer = setIntervalFn(snapshotInventory, inventoryIntervalMs);
      if (inventoryTimer && typeof inventoryTimer.unref === 'function') inventoryTimer.unref();
    }
    snapshotJobRecords();
    if (jobRecordIntervalMs > 0 && !jobRecordTimer) {
      jobRecordTimer = setIntervalFn(snapshotJobRecords, jobRecordIntervalMs);
      if (jobRecordTimer && typeof jobRecordTimer.unref === 'function') jobRecordTimer.unref();
    }
    return store.list().length;
  }

  function stop() {
    if (inventoryTimer) { clearIntervalFn(inventoryTimer); inventoryTimer = null; }
    if (jobRecordTimer) { clearIntervalFn(jobRecordTimer); jobRecordTimer = null; }
    return runner.stop ? runner.stop() : undefined;
  }

  /**
   * Delete EVERY job for one agent, and the file behind them.
   *
   * WHY IT GOES THROUGH `remove` PER JOB rather than clearing the store. `store.delete()` only drops
   * the cache entry and re-persists — it does NOT disarm. Only `runner.remove()` does
   * `disarm(id); store.delete(id)`. A purge that bypassed it would leave live timers firing turns for
   * jobs that no longer exist anywhere, which is worse than not purging at all: invisible in the
   * store, visible only as unexplained Slack messages.
   *
   * Going through `remove` also means each deletion emits its removal telemetry, so a purge is
   * legible after the fact rather than a silent gap in the record.
   *
   * The file is unlinked as a side effect — `persistAgent` removes an agent's file when its last job
   * goes, rather than leaving an empty shell. The explicit `purgeFile` below is for the case that
   * side effect cannot reach: a file on disk with no jobs in the cache. That should not happen, but
   * "should not happen" is exactly what a wipe has to cope with, and the whole point of this call is
   * that the slate is CLEAN afterwards.
   */
  function purgeAgent(agentId) {
    const ids = store.list().filter((j) => j.agentId === agentId).map((j) => j.id);
    for (const id of ids) remove(id);
    const fileDeleted = store.purgeFile(agentId);
    log.info({ agentId, removed: ids.length, fileDeleted }, 'cron: agent store purged');
    return { agentId, removed: ids.length, fileDeleted };
  }

  /**
   * The per-scope CRON_RUNNER, read/written through the ONE object every caller already holds —
   * the manager API, the App Home Jobs tab and the hydrator all reach the flag through here rather
   * than each constructing their own DynamoDB client. Without the flag wired in, `getRunner`
   * reports the default and the setters refuse, which is the honest answer for a dispatcher that
   * has no config table.
   */
  function getRunner(agentId) {
    if (!runnerFlags) {
      const { DEFAULT_CRON_RUNNER } = require('./cron-runner-flag');
      return Promise.resolve({ agentId, runner: DEFAULT_CRON_RUNNER, source: 'default', setAtMs: null, setBy: null });
    }
    return runnerFlags.get(agentId);
  }

  function setRunner(agentId, runner, options = {}) {
    if (!runnerFlags) return Promise.reject(new Error('CRON_RUNNER store is not configured on this dispatcher'));
    return runnerFlags.set(agentId, runner, options);
  }

  function setDefaultRunner(agentId, options = {}) {
    if (!runnerFlags) return Promise.reject(new Error('CRON_RUNNER store is not configured on this dispatcher'));
    return runnerFlags.setDefault(agentId, options);
  }

  /**
   * The legacy-name → ScopeId pointer the OpenClaw gate resolves through (cron-runner-flag.setAlias).
   * Written by hydration only; nothing in archie reads it, because archie is keyed by scope
   * everywhere already.
   */
  function setRunnerAlias(legacyName, scopeId, options = {}) {
    if (!runnerFlags) return Promise.reject(new Error('CRON_RUNNER store is not configured on this dispatcher'));
    return runnerFlags.setAlias(legacyName, scopeId, options);
  }

  return {
    start,
    stop,
    add,
    update,
    remove,
    purgeAgent,
    getRunner,
    setRunner,
    setDefaultRunner,
    setRunnerAlias,
    list: runner.list,
    runNow: runner.runNow,
    snapshotInventory,
    snapshotJobRecords,
    store,
    runner,
  };
}

module.exports = { createCronService };

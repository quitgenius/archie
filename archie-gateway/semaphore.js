'use strict';

// Bounded concurrency with FIFO fairness (provisioning-queue-plan.md, Phase 1).
//
// WHY THIS EXISTS. Before this, ONE number — TURN_QUEUE_POLLERS — capped three unrelated things at
// once: how many durable messages we hold, how many AgentCore provisions run concurrently, and how
// many invokes run concurrently. They want completely different values (~100 / ~5 / ~25), and sharing
// one meant a 30-45s control-plane provision occupied a slot that could have been serving a turn.
// The pathological case, measured: `_inflight` collapses N turns for one agent onto ONE provision
// promise, but each of those N turns still parked its own poller waiting for it — ten threads on one
// cold agent burned ten of twenty-five slots on a single CreateAgentRuntime.
//
// FIFO IS NOT DECORATION. Waiters are served in arrival order because the thing being bounded is on
// the user-visible latency path: a LIFO or random wake order would let a late turn overtake an early
// one and produce unbounded worst-case waits for whoever was unlucky, which is exactly the starvation
// this is meant to remove.

/**
 * @param limit  max concurrent holders. **<= 0 or non-finite means UNBOUNDED**, deliberately: these
 *               are configured from environment variables, and a typo'd or empty `MAX_...=0` that
 *               meant "no limit" would otherwise wedge every turn forever with no error anywhere.
 *               Failing open is the safe direction for a concurrency bound — the worst case is the
 *               behaviour we already had before this module existed.
 * @param name   for logs/metrics only.
 */
function createSemaphore(limit, { name = 'semaphore' } = {}) {
  const bounded = Number.isFinite(limit) && limit > 0;
  const max = bounded ? Math.floor(limit) : Infinity;
  const waiters = [];
  let held = 0;
  let peakHeld = 0;
  let peakWaiting = 0;
  let totalWaitMs = 0;
  let waitedCount = 0;

  function stats() {
    return {
      name,
      held,
      waiting: waiters.length,
      limit: bounded ? max : 0, // 0 reads as "unbounded" in metrics, matching the config convention
      peakHeld,
      peakWaiting,
      // Mean wait among those that ACTUALLY waited. Averaging over all acquires would bury the signal:
      // in a healthy pool almost every acquire is instant, so the mean would sit near zero even while
      // a minority waited tens of seconds — and that minority is the SLO breach we are hunting.
      avgWaitMs: waitedCount ? Math.round(totalWaitMs / waitedCount) : 0,
      waitedCount,
    };
  }

  /** Resolves to the number of ms spent waiting (0 = a free permit was available). */
  function acquire() {
    if (!bounded || held < max) {
      held += 1;
      if (held > peakHeld) peakHeld = held;
      return Promise.resolve(0);
    }
    const startedAt = Date.now();
    return new Promise((resolve) => {
      waiters.push(() => {
        held += 1;
        if (held > peakHeld) peakHeld = held;
        const waited = Date.now() - startedAt;
        totalWaitMs += waited;
        waitedCount += 1;
        resolve(waited);
      });
      if (waiters.length > peakWaiting) peakWaiting = waiters.length;
    });
  }

  function release() {
    // A double release would mint a permit out of nothing and silently raise the ceiling — the bound
    // would then be wrong in the one direction nobody checks for. Clamp instead of trusting callers;
    // `run()` below is the path that cannot get this wrong.
    if (held === 0) return;
    held -= 1;
    const next = waiters.shift();
    // Hand the permit straight to the next waiter rather than letting it race with a fresh acquire():
    // without this, a hot caller can repeatedly win the free permit and a queued waiter never runs.
    if (next) next();
  }

  /**
   * The only form callers should use. `fn` receives the ms spent waiting, so a caller can attribute
   * its own latency to "queued behind the bound" versus "slow work" without a second timer.
   */
  async function run(fn) {
    const waitedMs = await acquire();
    try {
      return await fn(waitedMs);
    } finally {
      release();
    }
  }

  return { acquire, release, run, stats, get held() { return held; }, get waiting() { return waiters.length; } };
}

module.exports = { createSemaphore };

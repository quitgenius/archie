'use strict';

// Was this turn's AgentCore session NEW or REUSED? — as telemetry, on the turn's own span.
//
// WHY IT IS WORTH A MODULE. Session reuse is the single biggest swing in a warm turn's latency:
// measured 2026-08-13 over 24h, the AgentCore platform leg (our InvokeAgentRuntime send -> the runtime
// beginning work) is ~2,500ms on a new session and ~118ms on a reused one, which roughly halves median
// TTFM (5.6s -> 1.9s on Slack turns, 4.5s -> 2.4s on cron). Until now that split could only be recovered
// by INFERRING it from the platform leg's bimodal shape in an ad-hoc query — fine for one analysis, not
// something to build decisions on.
//
// WHAT THIS CAN AND CANNOT KNOW. AgentCore decides whether a session is served by a warm microVM; we
// never see that decision. What the dispatcher knows for certain is whether IT has invoked this
// runtimeSessionId before, and how long ago. So the attributes are named for what they are —
// `session.first_use`, `session.last_use_age_ms`, `session.idle_expired` — and NOT `session.reused`,
// which would claim knowledge we do not have.
//
// The useful one is `idle_expired`: we invoked this session before, but longer ago than the runtime's
// idleRuntimeSessionTimeout, so AgentCore has almost certainly dropped it and we are paying full
// new-session cost on a session that could have been warm. That is the only member of this set that
// names something ACTIONABLE (raise the idle timeout, or drive the thread sooner). Measured baseline:
// exactly 2 Slack turns in 24h — which is why the idle timeout was left at 900s rather than raised.
//
// RESTART BIAS, stated rather than hidden. This is per-process state, so after a restart a genuinely
// warm session reads as `first_use`. That is deliberate: the alternative is a DynamoDB read on the hot
// path to answer a telemetry question. The bias is bounded — sessions die after maxLifetime (8h), so a
// process that has been up that long has complete knowledge — and `session.tracker_uptime_ms` is
// stamped alongside so a reader can discount early samples instead of guessing.

const DEFAULT_IDLE_TIMEOUT_MS = 900_000;      // AgentCore idleRuntimeSessionTimeout (900s)
const DEFAULT_MAX_LIFETIME_MS = 28_800_000;   // AgentCore maxLifetime (28800s) — the useful-memory horizon

/**
 * @param deps.idleTimeoutMs   mirror of the runtime spec's idleRuntimeSessionTimeout.
 * @param deps.maxLifetimeMs   mirror of maxLifetime; entries older than this are pruned, because a
 *                             session cannot outlive it and the entry can never again be a "reuse".
 * @param deps.now             () => epoch ms, injectable for tests.
 */
function createSessionTracker({
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  maxLifetimeMs = DEFAULT_MAX_LIFETIME_MS,
  now = () => Date.now(),
} = {}) {
  const lastUse = new Map();       // runtimeSessionId -> epoch ms of our previous invoke
  const startedAt = now();
  let lastPrune = startedAt;
  let firstUseCount = 0;
  let repeatCount = 0;
  let idleExpiredCount = 0;

  // Pruned on the way through rather than on a timer: the map is only read on the turn path, so a timer
  // would be an extra moving part for no benefit. WITHOUT pruning this grows by one entry per Slack
  // thread forever — the unbounded-Map failure mode that the in-process runtime cache already taught us.
  function prune(t) {
    if (t - lastPrune < maxLifetimeMs) return 0;
    lastPrune = t;
    let dropped = 0;
    for (const [id, at] of lastUse) {
      if (t - at > maxLifetimeMs) { lastUse.delete(id); dropped += 1; }
    }
    return dropped;
  }

  /**
   * Record that we are about to invoke `sessionId`, and report what we knew about it.
   * Returns attributes shaped for a span, plus `firstUse`/`idleExpired` for metric emission.
   */
  function touch(sessionId) {
    const t = now();
    prune(t);
    const previous = sessionId ? lastUse.get(sessionId) : undefined;
    if (sessionId) lastUse.set(sessionId, t);

    if (previous === undefined) {
      firstUseCount += 1;
      return { firstUse: true, ageMs: null, idleExpired: false, trackerUptimeMs: t - startedAt };
    }
    const ageMs = t - previous;
    // >= not >: at exactly the timeout the session is gone, and a boundary sample that reads "reusable"
    // would understate the very thing this measures.
    const idleExpired = ageMs >= idleTimeoutMs;
    repeatCount += 1;
    if (idleExpired) idleExpiredCount += 1;
    return { firstUse: false, ageMs, idleExpired, trackerUptimeMs: t - startedAt };
  }

  /**
   * Span attributes for a `touch()` result. Omits age on first use — there is no age to report.
   *
   * FLAGS ARE 1/0 NUMBERS, NOT BOOLEANS. Verified live 2026-08-13: a boolean span attribute is
   * INVISIBLE to CloudWatch Logs Insights — on the same span, `ispresent(attributes.session.first_use)`
   * matched 0 rows while `ispresent(attributes.session.tracker_uptime_ms)` (a number) matched, and
   * `attributes.session.first_use = 1` also matched nothing. The attribute is present in the raw span
   * JSON either way, so nothing errors: the query just returns EMPTY, which on a dashboard reads as
   * "every session is new" — a plausible-looking lie rather than a visible break. Numbers are queryable,
   * so flags are numbers.
   */
  function attributesFor(info) {
    if (!info) return {};
    return {
      'session.first_use': info.firstUse ? 1 : 0,
      'session.idle_expired': info.idleExpired ? 1 : 0,
      'session.tracker_uptime_ms': info.trackerUptimeMs,
      ...(info.ageMs == null ? {} : { 'session.last_use_age_ms': info.ageMs }),
    };
  }

  function stats() {
    return {
      tracked: lastUse.size,
      firstUse: firstUseCount,
      repeat: repeatCount,
      idleExpired: idleExpiredCount,
      uptimeMs: now() - startedAt,
    };
  }

  return { touch, attributesFor, stats, _size: () => lastUse.size };
}

module.exports = { createSessionTracker, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_LIFETIME_MS };

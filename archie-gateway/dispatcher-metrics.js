'use strict';

// Dispatcher-side operational metrics (dispatcher-observability-plan M1 / D6).
//
// M1 scope: EMF-via-stdout metrics ONLY. No OpenTelemetry, no traces, no traceparent — those
// are M2/M3. This module is the interim mechanism: plain `Date.now()` phase timers in the
// provisioning saga + invoke sites, surfaced as CloudWatch metrics without any SDK or IAM.
//
// EMF (CloudWatch Embedded Metric Format): we write a structured JSON line to stdout and
// CloudWatch Logs auto-extracts the metric — NO PutMetricData call, so no extra IAM and no
// new SDK dependency. The awslogs log driver already ships the dispatcher's stdout to a
// CloudWatch log group (/ecs/agent-4ggvzl-dispatcher). This CLONES the mechanism in
// cron-metrics.js (createCronAlertEmitter); the only differences are the namespace and the
// broader set of metrics.
//
// Namespace: ClawdbotDispatcher — a NEW namespace, distinct from the runtime-side AgentCore/Pi
// (that is emitted by the Pi adapter, not the dispatcher) and from ClawdbotCron.
//
// Dimensions: Agent only (bounded cardinality) PLUS a zero-dimension fleet-wide aggregate, so
// each metric can be viewed per-agent AND fleet-wide. Any other context (runtimeId, phase,
// error name) rides as EMF context PROPERTIES (searchable in Logs Insights), never as a
// dimension — a per-runtime/per-error dimension would explode cardinality.

// Namespace is per STACK, not per build. While the OpenClaw and archie gateways run side by side they
// share this image, and both emit a dimensionless fleet-wide aggregate — so a shared namespace sums two
// fleets into one series and every alarm on it is wrong in a way that looks plausible. The default is
// the historical value, so the OpenClaw stack is unaffected by this becoming configurable.
const NAMESPACE = process.env.DISPATCHER_METRIC_NAMESPACE || 'ClawdbotDispatcher';

// Provisioning-saga phase durations + counts (D6 §2).
const M_MOUNT_TARGETS_MS = 'ProvisionMountTargetsReadyMs';
const M_ACCESS_POINT_MS = 'ProvisionAccessPointReadyMs';
const M_RUNTIME_READY_MS = 'ProvisionRuntimeCreateReadyMs';
const M_TOTAL_MS = 'ProvisionRuntimeReadyMs';
const M_RUNTIME_CREATED = 'RuntimeCreatedCount';
const M_ACCESS_POINT_CREATED = 'AccessPointCreatedCount';
const M_PROVISION_ERROR = 'ProvisionErrorCount';

// Connector inline provisioning (phase 3). Separate metric NAMES rather than one metric with an
// `outcome` dimension, because the three interesting outcomes want three different responses and a
// per-name alarm is trivial where a dimension filter is not:
//   PROVISIONED  a new agent got its own project     — informational, and the migration counter
//                                                      that should rise as ConnectorSharedKey falls
//   BLOCKED      the project exists and CANNOT be keyed by API — a HUMAN must mint one in the
//                console. This is the expected outcome for most existing agents, so it is a
//                worklist signal, not a fault.
//   FAILED       the API or Secrets Manager broke — provisioning is genuinely unhealthy.
// LATENCY exists to CHECK the parallelism claim rather than assume it: this leg is only free if it
// finishes inside the mount-target/access-point window it runs alongside.
const M_CONNECTOR_PROVISIONED = 'ConnectorProvisionedCount';
const M_CONNECTOR_BLOCKED = 'ConnectorProvisionBlockedCount';
const M_CONNECTOR_FAILED = 'ConnectorProvisionFailedCount';
const M_CONNECTOR_MS = 'ConnectorProvisionMs';

// Invoke-site latency / cold-retry / error (D6 §3).
const M_INVOKE_LATENCY_MS = 'InvokeLatencyMs';
const M_INVOKE_COLD_RETRIES = 'InvokeColdRetries';
const M_INVOKE_ERROR = 'InvokeErrorCount';

// Per-session queue (per-message isolation). Turns for one Slack thread run strictly one at a time,
// so a burst QUEUES rather than overlapping — which means a user's perceived latency is
// SessionQueueWaitMs + InvokeLatencyMs, and InvokeLatencyMs alone stops telling the whole story the
// moment anyone bursts. These three make the queue visible instead of inferred from log archaeology:
//   Depth    — turns outstanding for the thread at enqueue (1 = went straight through, no wait).
//   WaitMs   — enqueue → this turn actually starting. The part of the wait isolation is responsible for.
//   Rejected — backpressure: over MAX_SESSION_QUEUE, the message is refused rather than accepted and
//              answered minutes later. Should be ~0; a non-zero rate means the bound is too low for
//              real use (it was 8, which a hand-typed 11-message burst exceeded).
//   Backlog  — depth crossed the alert threshold (200): the thread is ~30min behind at ~10s/turn.
//              This is the alarm signal; Rejected only fires at the 10,000 memory backstop, which a
//              human cannot reach, so alarming on Rejected alone would never fire in practice.
const M_SESSION_QUEUE_DEPTH = 'SessionQueueDepth';
const M_SESSION_QUEUE_WAIT_MS = 'SessionQueueWaitMs';
const M_SESSION_QUEUE_REJECTED = 'SessionQueueRejectedCount';
const M_SESSION_QUEUE_BACKLOG = 'SessionQueueBacklogCount';

// POLLER SATURATION — the signal that was missing when TURN_QUEUE_POLLERS was 5.
// A poller is held for the WHOLE turn, provisioning included (~30-45s on a cold turn), so a
// handful of cold turns could park the entire pool and every other agent's turns then waited in
// SQS for a free poller. That wait is invisible in the per-turn spans (it happens before the turn
// exists) and it lands in the TTFM `dispatch` phase, which is how it was eventually found — from
// the other end, days later. These are the two numbers that would have said it directly.
// Busy is a GAUGE sampled on an interval, so alarm on Maximum (a Sum would multiply by sample
// count) and read PollersTotal alongside it — 40 busy means nothing without knowing the cap.
const M_POLLERS_BUSY = 'TurnPollersBusy';
const M_POLLERS_TOTAL = 'TurnPollersTotal';
// PollersWaiting: receive loops blocked because every in-flight slot is taken. Since the hand-off
// (provisioning-queue-plan.md Phase 1) Busy/Total measure turns-in-flight against MAX_INFLIGHT_TURNS,
// not against the poller count — so this is the number that says "the ceiling is what is limiting us"
// rather than "the queue is empty". Busy at its cap with Waiting zero is a coincidence; Busy at its cap
// with Waiting non-zero is a bottleneck.
const M_POLLERS_WAITING = 'TurnPollersWaiting';

// The two bounds Phase 1 split out of the poller count. Each is a gauge of held permits plus its cap.
// Provisions sitting at its cap is the cold-start bottleneck; Invokes sitting at its cap means turns
// are queueing behind the model/stream bound rather than behind provisioning — different fixes, and
// before this they were indistinguishable because one number covered both.
const M_PROVISIONS_BUSY = 'ProvisionsBusy';
const M_PROVISIONS_TOTAL = 'ProvisionsTotal';
const M_PROVISIONS_WAITING = 'ProvisionsWaiting';
const M_INVOKES_BUSY = 'InvokesBusy';
const M_INVOKES_TOTAL = 'InvokesTotal';
const M_INVOKES_WAITING = 'InvokesWaiting';

// SESSION FIRST-USE vs REUSE. The biggest swing in a warm turn: the AgentCore platform leg is ~2,500ms
// on a new session and ~118ms on a reused one (measured over 24h), which roughly halves median TTFM.
//
// Three NAMES rather than one metric with a `reused` dimension, because each answers a different
// question and each wants a different response:
//   FirstUse    — a session we have never invoked. On the Slack path this is ~87% of turns and is
//                 STRUCTURAL: 89% of threads get exactly one message, so there is no session to reuse.
//                 Watch the RATIO, not the count; it is a property of the workload, not a fault.
//   Reused      — served within the idle window. The good case. Cron gets ~66% of these for free
//                 because its session keys are per-job and stable.
//   IdleExpired — the only ACTIONABLE one: we had this session, but longer ago than
//                 idleRuntimeSessionTimeout, so we pay full new-session cost on something that could
//                 have been warm. Baseline is ~2 Slack turns/day, which is precisely why the idle
//                 timeout was left at 900s. A sustained rise is the signal that raising it would pay.
const M_SESSION_FIRST_USE = 'SessionFirstUseCount';
const M_SESSION_REUSED = 'SessionReusedCount';
const M_SESSION_IDLE_EXPIRED = 'SessionIdleExpiredCount';
// Gap since the previous invoke of this session, for the turns where there WAS one. Distribution
// matters more than any single statistic: it says how much headroom a longer idle timeout would buy.
const M_SESSION_GAP_MS = 'SessionReuseGapMs';

// RUNTIME CACHE — THE PRE-WARM SCOREBOARD (provisioning-queue-plan.md Phase 2, step 0).
//
// Phase 2's whole success criterion is "miss rate → 0", and until now that was unobservable: the only
// way to tell a warm turn from a provisioning one was to infer it from the absence of a
// dispatcher.provision span in an ad-hoc trace join. This makes it a first-class series, and it exists
// BEFORE the queue deliberately, so pre-warm is judged against a measured baseline rather than a hope.
//
// Emitted once per TURN with the outcome that turn experienced, so hit+miss+coalesced+late_hit = turns.
// Counting provisions instead would undercount the cost: when N turns collapse onto one provision, one
// provision happened but N turns waited.
//
// Four names, not one metric with an `outcome` dimension, because each says to do something different:
//   Hit       — the registry served it. Zero control-plane calls. The number that should approach 100%.
//   Miss      — this turn paid for a provision. The one pre-warm must eliminate.
//   Coalesced — joined another turn's in-flight provision. The herd collapsing AS DESIGNED (one
//               provision, N waiters); a rising share during a roll is the mechanism working, not a
//               fault, which is precisely why it must not be summed into Miss.
//   LateHit   — queued for a provision permit, then found the work already done. Means the provision
//               BOUND is delaying turns rather than the provision itself → raise MAX_CONCURRENT_PROVISIONS.
// WaitMs rides alongside as the "how much TTFM does the fallback path cost" number the plan also wanted.
const M_RUNTIME_CACHE_HIT = 'RuntimeCacheHitCount';
const M_RUNTIME_CACHE_MISS = 'RuntimeCacheMissCount';
const M_RUNTIME_CACHE_COALESCED = 'RuntimeCacheCoalescedCount';
const M_RUNTIME_CACHE_LATE_HIT = 'RuntimeCacheLateHitCount';
const M_RUNTIME_CACHE_WAIT_MS = 'RuntimeCacheResolveMs';

// The fleet has no published container image (DynamoDB CONFIG#image / FLEET missing or unreadable
// with nothing cached). Provisioning fails closed rather than guessing a build — there is no baked
// fallback by design — so this is a HARD outage signal: agents cannot start until a pointer exists.
// Expected exactly once, briefly, in a brand-new environment before the first publish.
const M_IMAGE_POINTER_MISSING = 'ImagePointerMissingCount';

// Durable turn queue (sqs-durable-queue-plan.md). Enqueued is the volume entering the queue;
// EnqueueFailed is a message Slack already acked that we then failed to persist — i.e. a turn the
// user asked for that nothing will ever run. It should be flat zero and is worth alarming on.
const M_TURN_ENQUEUED = 'TurnEnqueuedCount';
const M_TURN_ENQUEUE_FAILED = 'TurnEnqueueFailedCount';
// Started = committed (deleted from the queue because the runtime is demonstrably executing).
// Released = handed back for retry because the turn failed BEFORE the runtime started; a steady
// non-zero rate means turns are failing to launch, which ends at the DLQ.
const M_TURN_STARTED = 'TurnStartedCount';
const M_TURN_RELEASED = 'TurnReleasedCount';

// A runtime generation rolled — the agent's immutable spec changed (image, EFS root, an env var…) so a
// new runtime was provisioned. Fleet-wide this is the signal that answers "what is rolling right now",
// which a per-trace span event cannot: one env change rolls EVERY agent on its next turn, and without
// this the only symptom is that everything felt slow for a while with nothing explaining it.
const M_RUNTIME_GENERATION_ROLL = 'RuntimeGenerationRollCount';

// Message volume. The DDB `message-metrics` table has counted user×agent×day since July, but its only
// reader is the ALB-fronted `archie` chart service — so under AgentCore (no ALB, and that service
// scaled to 0) message volume had NO visible surface at all. This is the dashboard-visible half:
// per-agent and fleet-wide, which is what the volume question is usually asked at.
//
// NOT a replacement for the table: `Agent` is a bounded dimension (~208), a `user` dimension would be
// thousands × 208 custom metrics at $0.30 each per month. Per-USER breakdown stays in DynamoDB. The
// userId rides here as an EMF property, so Logs Insights can still answer "who" without paying for a
// dimension.
const M_MESSAGE_RECEIVED = 'MessagesReceivedCount';

// Owner adds. Two counters rather than one with an `ok` property, matching the Connector pattern:
// a failure is the thing anyone would alarm on, and an alarm cannot filter on an EMF property.
const M_OWNER_ADDED = 'OwnerAddedCount';
const M_OWNER_ADD_FAILED = 'OwnerAddFailedCount';

/**
 * Create a dispatcher metrics emitter (EMF-via-stdout).
 *
 * @param deps.emit       optional (line:string) => void sink (default: process.stdout).
 * @param deps.namespace  optional metric namespace (default ClawdbotDispatcher).
 * @param deps.now        optional () => epoch ms (injectable for tests).
 * @param deps.log        optional pino-shaped logger (only used if an emit throws).
 * @returns emitter with per-metric helpers + a generic `emit`.
 */
function createDispatcherMetrics(deps = {}) {
  const write = deps.emit || ((line) => process.stdout.write(`${line}\n`));
  const namespace = deps.namespace || NAMESPACE;
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  // Emit one EMF line: a single metric with an `Agent` dimension AND a fleet-wide aggregate.
  // `props` become searchable EMF context properties (not dimensions).
  function emitMetric(metricName, value, unit, agent, props = {}) {
    const emf = {
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{
          Namespace: namespace,
          Dimensions: [['Agent'], []], // per-agent AND a fleet-wide aggregate
          Metrics: [{ Name: metricName, Unit: unit }],
        }],
      },
      Agent: agent || 'unknown',
      ...props,
      [metricName]: value,
    };
    try {
      write(JSON.stringify(emf));
    } catch (err) {
      log.warn({ err: String(err && err.message), metric: metricName, agent }, 'dispatcher metric emit failed');
    }
  }

  // ── Provisioning-saga metrics ──────────────────────────────────────────────
  //
  // A single provision run reports each phase duration, a total, and the counts. `phases` are
  // supplied by the saga's Date.now() timers. `created` flags gate the "created vs reused"
  // counts (a reused runtime/AP is not a create). `props` carries runtimeId etc. for context.
  function emitProvision(agent, {
    mountTargetsMs, accessPointMs, runtimeReadyMs, totalMs,
    runtimeCreated, accessPointCreated, props = {},
  } = {}) {
    if (Number.isFinite(mountTargetsMs)) emitMetric(M_MOUNT_TARGETS_MS, mountTargetsMs, 'Milliseconds', agent, props);
    if (Number.isFinite(accessPointMs)) emitMetric(M_ACCESS_POINT_MS, accessPointMs, 'Milliseconds', agent, props);
    if (Number.isFinite(runtimeReadyMs)) emitMetric(M_RUNTIME_READY_MS, runtimeReadyMs, 'Milliseconds', agent, props);
    if (Number.isFinite(totalMs)) emitMetric(M_TOTAL_MS, totalMs, 'Milliseconds', agent, props);
    // Counts: emit 1 only when a NEW resource was minted (reuse/adopt is not a create), so the
    // metric answers "how many fresh provisions/APs" cleanly.
    if (runtimeCreated) emitMetric(M_RUNTIME_CREATED, 1, 'Count', agent, props);
    if (accessPointCreated) emitMetric(M_ACCESS_POINT_CREATED, 1, 'Count', agent, props);
  }

  // One call per cold provision, driven by the outcome ensureConnectorCredential reports. `already-pointed` and
  // `skipped` emit nothing: they are the steady state (every provision after the first, and every
  // deployment with provisioning switched off), and counting them would bury the three that matter.
  function emitConnectorProvision(agent, { outcome, ms, reason, projectId } = {}) {
    const props = {};
    if (reason) props.reason = reason;
    if (projectId) props.projectId = projectId;
    if (Number.isFinite(ms) && outcome !== 'already-pointed' && outcome !== 'skipped') {
      emitMetric(M_CONNECTOR_MS, ms, 'Milliseconds', agent, props);
    }
    if (outcome === 'created') emitMetric(M_CONNECTOR_PROVISIONED, 1, 'Count', agent, props);
    else if (outcome === 'blocked') emitMetric(M_CONNECTOR_BLOCKED, 1, 'Count', agent, props);
    else if (outcome === 'failed') emitMetric(M_CONNECTOR_FAILED, 1, 'Count', agent, props);
  }

  function emitProvisionError(agent, props = {}) {
    emitMetric(M_PROVISION_ERROR, 1, 'Count', agent, props);
  }

  // ── Invoke-site metrics ────────────────────────────────────────────────────
  //
  // `latencyMs` is wall-time of the invoke leg (ensureRuntime + invokeStreaming, i.e. what the
  // caller experiences). `coldRetries` is the count of provision-then-retry / cold-boot retries
  // that happened before the turn completed (0 on a warm hit). Emitted once per invoke.
  function emitInvoke(agent, { latencyMs, coldRetries, trigger } = {}) {
    const props = trigger ? { trigger } : {};
    if (Number.isFinite(latencyMs)) emitMetric(M_INVOKE_LATENCY_MS, latencyMs, 'Milliseconds', agent, props);
    if (Number.isFinite(coldRetries)) emitMetric(M_INVOKE_COLD_RETRIES, coldRetries, 'Count', agent, props);
  }

  function emitInvokeError(agent, { trigger, errName } = {}) {
    const props = {};
    if (trigger) props.trigger = trigger;
    if (errName) props.errName = errName;
    emitMetric(M_INVOKE_ERROR, 1, 'Count', agent, props);
  }

  // ── Per-session queue metrics ──────────────────────────────────────────────
  //
  // One call site per event, each emitting only the fields it knows:
  //   enqueue  -> { depth }              (depth INCLUDES this turn, so 1 means no waiting)
  //   start    -> { waitMs, depth }      (how long isolation made this message wait)
  //   rejected -> { rejected: true, depth, max }
  // `sessionId` is deliberately a PROPERTY, never a dimension — it is per-thread and would explode
  // cardinality; Agent stays the only dimension, as everywhere else in this module.
  function emitSessionQueue(agent, { depth, waitMs, rejected, backlog, max, alertAt, sessionId } = {}) {
    const props = {};
    if (sessionId) props.sessionId = sessionId;
    if (Number.isFinite(max)) props.maxQueue = max;
    if (Number.isFinite(alertAt)) props.alertAt = alertAt;
    if (backlog) {
      emitMetric(M_SESSION_QUEUE_BACKLOG, 1, 'Count', agent, { ...props, ...(Number.isFinite(depth) ? { depth } : {}) });
      return;
    }
    if (rejected) {
      emitMetric(M_SESSION_QUEUE_REJECTED, 1, 'Count', agent, { ...props, ...(Number.isFinite(depth) ? { depth } : {}) });
      return;
    }
    // Exactly ONE metric per call. Depth is sampled once, at enqueue; the slot-entry call carries
    // waitMs and repeats depth only as a PROPERTY ("why was this one slow"). Emitting a depth sample
    // at both ends would count every turn twice and skew the percentiles used to size the bound.
    if (Number.isFinite(waitMs)) {
      emitMetric(M_SESSION_QUEUE_WAIT_MS, waitMs, 'Milliseconds', agent,
        { ...props, ...(Number.isFinite(depth) ? { depth } : {}) });
      return;
    }
    if (Number.isFinite(depth)) emitMetric(M_SESSION_QUEUE_DEPTH, depth, 'Count', agent, props);
  }

  // No fleet image pointer — see M_IMAGE_POINTER_MISSING. `agent` is the one that could not start.
  function emitImagePointerMissing({ agent, table } = {}) {
    emitMetric(M_IMAGE_POINTER_MISSING, 1, 'Count', agent, table ? { table } : {});
  }

  // Turn queued for durable execution. `sessionId` rides as a property (per-thread = unbounded
  // cardinality), consistent with the rest of this module.
  function emitTurnEnqueued(agent, { sessionId } = {}) {
    emitMetric(M_TURN_ENQUEUED, 1, 'Count', agent, sessionId ? { sessionId } : {});
  }

  // Failed to persist a turn Slack already acked — nothing else will retry it.
  function emitTurnEnqueueFailed(agent, { sessionId, errName } = {}) {
    const props = {};
    if (sessionId) props.sessionId = sessionId;
    if (errName) props.errName = errName;
    emitMetric(M_TURN_ENQUEUE_FAILED, 1, 'Count', agent, props);
  }

  // Pool occupancy sample. Fleet-level, not per-agent: the pool is shared, so the `Agent` dimension
  // is meaningless here and only the zero-dimension series should be alarmed on (emitMetric publishes
  // both). Called on a timer by the consumer, and once more on every transition into saturation so a
  // short spike between samples still shows up.
  function emitPollerSaturation({ busy, total, waiting } = {}) {
    if (Number.isFinite(busy)) emitMetric(M_POLLERS_BUSY, busy, 'Count', 'fleet', Number.isFinite(total) ? { total } : {});
    if (Number.isFinite(total)) emitMetric(M_POLLERS_TOTAL, total, 'Count', 'fleet', {});
    if (Number.isFinite(waiting)) emitMetric(M_POLLERS_WAITING, waiting, 'Count', 'fleet', {});
  }

  /**
   * One turn's runtime-resolution outcome. `outcome` is one of hit | miss | coalesced | late_hit.
   *
   * Per-AGENT (plus the fleet aggregate) because pre-warm coverage is per agent: a fleet-only hit rate
   * hides the case that matters most, which is a handful of agents that pre-warm never reaches while
   * everyone else is warm.
   */
  function emitRuntimeCache(agent, { outcome, waitMs, runtime } = {}) {
    const name = {
      hit: M_RUNTIME_CACHE_HIT,
      miss: M_RUNTIME_CACHE_MISS,
      coalesced: M_RUNTIME_CACHE_COALESCED,
      late_hit: M_RUNTIME_CACHE_LATE_HIT,
    }[outcome];
    // An unknown outcome is dropped rather than guessed at: inventing a series would be worse than the
    // gap, because a wrong hit rate is acted on while a missing one is noticed.
    if (!name) return;
    const props = { outcome };
    if (runtime) props.runtime = runtime;
    emitMetric(name, 1, 'Count', agent, props);
    // Resolution time on EVERY outcome, not just misses: a hit should be single-digit milliseconds
    // (measured: the registry GetItem is 8-10ms), so this is also how a degrading fast path surfaces.
    if (Number.isFinite(waitMs)) emitMetric(M_RUNTIME_CACHE_WAIT_MS, waitMs, 'Milliseconds', agent, { outcome });
  }

  /**
   * One turn's session provenance, from session-tracker.touch(). Per-AGENT dimension (plus the
   * fleet aggregate) because reuse rate is a property of how an agent is USED — a cron-driven agent
   * and a Slack-driven one sit at opposite ends, and a fleet-only number averages that away.
   */
  function emitSessionUse(agent, info) {
    if (!info) return;
    if (info.firstUse) {
      emitMetric(M_SESSION_FIRST_USE, 1, 'Count', agent, {});
      return;
    }
    emitMetric(M_SESSION_REUSED, 1, 'Count', agent, {});
    if (Number.isFinite(info.ageMs)) emitMetric(M_SESSION_GAP_MS, info.ageMs, 'Milliseconds', agent, {});
    // Counted IN ADDITION to Reused, not instead of it: the session was ours to reuse and the timeout
    // took it. Emitting it as a third mutually-exclusive state would hide it from the reuse ratio.
    if (info.idleExpired) emitMetric(M_SESSION_IDLE_EXPIRED, 1, 'Count', agent, {});
  }

  /**
   * Occupancy of the provision and invoke bounds — the shape returned by
   * agentCore.concurrencyStats(). Same gauge conventions as above: alarm on Maximum, read the cap
   * alongside. Emitted from the same sampler as poller saturation so all three move on one timeline.
   */
  function emitConcurrencyBounds({ provision, invoke } = {}) {
    if (provision) {
      if (Number.isFinite(provision.held)) emitMetric(M_PROVISIONS_BUSY, provision.held, 'Count', 'fleet', { limit: provision.limit, avgWaitMs: provision.avgWaitMs });
      if (Number.isFinite(provision.limit)) emitMetric(M_PROVISIONS_TOTAL, provision.limit, 'Count', 'fleet', {});
      if (Number.isFinite(provision.waiting)) emitMetric(M_PROVISIONS_WAITING, provision.waiting, 'Count', 'fleet', {});
    }
    if (invoke) {
      if (Number.isFinite(invoke.held)) emitMetric(M_INVOKES_BUSY, invoke.held, 'Count', 'fleet', { limit: invoke.limit, avgWaitMs: invoke.avgWaitMs });
      if (Number.isFinite(invoke.limit)) emitMetric(M_INVOKES_TOTAL, invoke.limit, 'Count', 'fleet', {});
      if (Number.isFinite(invoke.waiting)) emitMetric(M_INVOKES_WAITING, invoke.waiting, 'Count', 'fleet', {});
    }
  }

  function emitTurnStarted(agent, { sessionId, receiveCount } = {}) {
    const props = {};
    if (sessionId) props.sessionId = sessionId;
    if (Number.isFinite(receiveCount)) props.receiveCount = receiveCount;
    emitMetric(M_TURN_STARTED, 1, 'Count', agent, props);
  }

  function emitTurnReleased(agent, { sessionId, receiveCount } = {}) {
    const props = {};
    if (sessionId) props.sessionId = sessionId;
    if (Number.isFinite(receiveCount)) props.receiveCount = receiveCount;
    emitMetric(M_TURN_RELEASED, 1, 'Count', agent, props);
  }

  // `reason` is the list of spec fields that changed (e.g. ['image','env.DISPATCHER_BASE_URL']). It
  // rides as a PROPERTY, not a dimension — field combinations are unbounded.
  function emitRuntimeGenerationRoll(agent, { from, to, reason } = {}) {
    const props = {};
    if (from) props.fromGeneration = from;
    if (to) props.toGeneration = to;
    if (reason?.length) props.reason = reason.join(',');
    emitMetric(M_RUNTIME_GENERATION_ROLL, 1, 'Count', agent, props);
  }

  // One routed inbound Slack message. Counted where the DDB counter is counted — AFTER routing
  // resolves an agent, BEFORE the turn is forwarded — so the two cannot disagree. That means it counts
  // messages RECEIVED, not replies delivered: a turn that later fails still counts. Deliberate, and
  // stated here because "message volume" invites the other reading.
  // An owner was added to a scope. `agent` is the scope the ownership is OVER; `by` is who granted
  // it ('hydrate'/'mention' for the automatic writers), `ownerUserId` who received it. Timestamp is
  // inherent to the EMF record.
  function emitOwnerAdded(agent, { ownerUserId, by, ok = true, errName } = {}) {
    const props = {};
    if (ownerUserId) props.ownerUserId = ownerUserId;
    if (by) props.grantedBy = by;
    if (errName) props.errName = errName;
    emitMetric(ok ? M_OWNER_ADDED : M_OWNER_ADD_FAILED, 1, 'Count', agent, props);
  }

  function emitMessageReceived(agent, { userId, channel, eventType } = {}) {
    const props = {};
    if (userId) props.userId = userId;
    if (channel) props.channel = channel;
    if (eventType) props.eventType = eventType;
    emitMetric(M_MESSAGE_RECEIVED, 1, 'Count', agent, props);
  }

  return {
    emit: emitMetric,
    emitProvision,
    emitProvisionError,
    emitConnectorProvision,
    emitInvoke,
    emitInvokeError,
    emitSessionQueue,
    emitImagePointerMissing,
    emitTurnEnqueued,
    emitTurnEnqueueFailed,
    emitTurnStarted,
    emitTurnReleased,
    emitPollerSaturation,
    emitConcurrencyBounds,
    emitSessionUse,
    emitRuntimeCache,
    emitRuntimeGenerationRoll,
    emitMessageReceived,
    emitOwnerAdded,
    _namespace: namespace,
  };
}

// A shared no-op emitter for DI defaults (so the provisioning saga's unit tests, which inject
// nothing, produce zero stdout side effects).
const NOOP_METRICS = {
  emit() {},
  emitProvision() {},
  emitProvisionError() {},
  emitConnectorProvision() {},
  emitInvoke() {},
  emitInvokeError() {},
  emitSessionQueue() {},
  emitImagePointerMissing() {},
  emitTurnEnqueued() {},
  emitTurnEnqueueFailed() {},
  emitTurnStarted() {},
  emitTurnReleased() {},
  emitRuntimeGenerationRoll() {},
  emitMessageReceived() {},
  emitOwnerAdded() {},
  _namespace: NAMESPACE,
};

module.exports = {
  createDispatcherMetrics,
  NOOP_METRICS,
  DISPATCHER_METRIC_NAMESPACE: NAMESPACE,
  METRIC_NAMES: {
    M_MOUNT_TARGETS_MS,
    M_ACCESS_POINT_MS,
    M_RUNTIME_READY_MS,
    M_TOTAL_MS,
    M_RUNTIME_CREATED,
    M_ACCESS_POINT_CREATED,
    M_PROVISION_ERROR,
    M_CONNECTOR_PROVISIONED,
    M_CONNECTOR_BLOCKED,
    M_CONNECTOR_FAILED,
    M_CONNECTOR_MS,
    M_INVOKE_LATENCY_MS,
    M_INVOKE_COLD_RETRIES,
    M_INVOKE_ERROR,
    M_SESSION_QUEUE_DEPTH,
    M_SESSION_QUEUE_WAIT_MS,
    M_SESSION_QUEUE_REJECTED,
    M_SESSION_QUEUE_BACKLOG,
    M_IMAGE_POINTER_MISSING,
    M_TURN_ENQUEUED,
    M_TURN_ENQUEUE_FAILED,
    M_TURN_STARTED,
    M_TURN_RELEASED,
    M_MESSAGE_RECEIVED,
    M_RUNTIME_GENERATION_ROLL,
    M_POLLERS_BUSY,
    M_POLLERS_TOTAL,
    M_POLLERS_WAITING,
    M_PROVISIONS_BUSY,
    M_PROVISIONS_TOTAL,
    M_PROVISIONS_WAITING,
    M_INVOKES_BUSY,
    M_INVOKES_TOTAL,
    M_INVOKES_WAITING,
    M_SESSION_FIRST_USE,
    M_SESSION_REUSED,
    M_SESSION_IDLE_EXPIRED,
    M_SESSION_GAP_MS,
    M_RUNTIME_CACHE_HIT,
    M_RUNTIME_CACHE_MISS,
    M_RUNTIME_CACHE_COALESCED,
    M_RUNTIME_CACHE_LATE_HIT,
    M_RUNTIME_CACHE_WAIT_MS,
  },
};

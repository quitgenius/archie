'use strict';

// vitest globals enabled via vitest.config.js
const { createDispatcherMetrics, DISPATCHER_METRIC_NAMESPACE, METRIC_NAMES, NOOP_METRICS } = require('./dispatcher-metrics');

function capture() {
  const lines = [];
  const m = createDispatcherMetrics({ emit: (l) => lines.push(l), now: () => 1_800_000_000_000 });
  return { m, lines, at: (i) => JSON.parse(lines[i]) };
}

describe('createDispatcherMetrics.emitProvision', () => {
  it('emits phase durations + total in the ClawdbotDispatcher namespace with the right units', () => {
    const { m, lines, at } = capture();
    m.emitProvision('alpha', {
      mountTargetsMs: 1200, accessPointMs: 3400, runtimeReadyMs: 25000, totalMs: 30100,
      runtimeCreated: true, accessPointCreated: true, props: { runtimeId: 'rt-1' },
    });
    // 4 durations + 2 counts = 6 lines
    expect(lines).toHaveLength(6);
    const byName = Object.fromEntries(lines.map((l) => {
      const e = JSON.parse(l);
      return [e._aws.CloudWatchMetrics[0].Metrics[0].Name, e];
    }));
    const total = byName[METRIC_NAMES.M_TOTAL_MS];
    expect(total._aws.CloudWatchMetrics[0].Namespace).toBe(DISPATCHER_METRIC_NAMESPACE);
    expect(total._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: 'ProvisionRuntimeReadyMs', Unit: 'Milliseconds' });
    expect(total.ProvisionRuntimeReadyMs).toBe(30100);
    expect(total.Agent).toBe('alpha');
    expect(total.runtimeId).toBe('rt-1'); // context property, not a dimension
    expect(total._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
    // counts are Count-unit, value 1
    expect(byName[METRIC_NAMES.M_RUNTIME_CREATED].RuntimeCreatedCount).toBe(1);
    expect(byName[METRIC_NAMES.M_ACCESS_POINT_CREATED].Metrics === undefined); // sanity
  });

  it('does NOT emit created-counts when the resource was reused/adopted', () => {
    const { m, lines } = capture();
    m.emitProvision('alpha', { totalMs: 50, runtimeCreated: false, accessPointCreated: false });
    const names = lines.map((l) => JSON.parse(l)._aws.CloudWatchMetrics[0].Metrics[0].Name);
    expect(names).toContain('ProvisionRuntimeReadyMs');
    expect(names).not.toContain('RuntimeCreatedCount');
    expect(names).not.toContain('AccessPointCreatedCount');
  });

  it('skips a phase whose duration is not finite', () => {
    const { m, lines } = capture();
    m.emitProvision('alpha', { mountTargetsMs: undefined, totalMs: 100 });
    const names = lines.map((l) => JSON.parse(l)._aws.CloudWatchMetrics[0].Metrics[0].Name);
    expect(names).toEqual(['ProvisionRuntimeReadyMs']);
  });
});

describe('createDispatcherMetrics invoke + error metrics', () => {
  it('emits InvokeLatencyMs + InvokeColdRetries with trigger context', () => {
    const { m, lines } = capture();
    m.emitInvoke('alpha', { latencyMs: 812, coldRetries: 2, trigger: 'user' });
    expect(lines).toHaveLength(2);
    const lat = JSON.parse(lines[0]);
    expect(lat._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: 'InvokeLatencyMs', Unit: 'Milliseconds' });
    expect(lat.InvokeLatencyMs).toBe(812);
    expect(lat.trigger).toBe('user');
    const retries = JSON.parse(lines[1]);
    expect(retries.InvokeColdRetries).toBe(2);
  });

  it('emits a provision error count', () => {
    const { m, at } = capture();
    m.emitProvisionError('alpha', { errName: 'ValidationException' });
    expect(at(0).ProvisionErrorCount).toBe(1);
    expect(at(0).errName).toBe('ValidationException');
  });

  it('emits an invoke error count with error name context', () => {
    const { m, at } = capture();
    m.emitInvokeError('alpha', { trigger: 'cron', errName: 'RuntimeClientError' });
    expect(at(0).InvokeErrorCount).toBe(1);
    expect(at(0).trigger).toBe('cron');
    expect(at(0).errName).toBe('RuntimeClientError');
  });

  it('defaults Agent to "unknown" when absent and never throws', () => {
    const { m, at } = capture();
    expect(() => m.emitInvoke(undefined, { latencyMs: 1 })).not.toThrow();
    expect(at(0).Agent).toBe('unknown');
  });
});

describe('createDispatcherMetrics.emitMessageReceived', () => {
  it('emits MessagesReceivedCount=1 with Agent dim + fleet aggregate', () => {
    const { m, lines, at } = capture();
    m.emitMessageReceived('sandbox-person79b333-test', { userId: 'UX0MZ5CKP2R', channel: 'C66PP782T9K', eventType: 'message' });
    expect(lines).toHaveLength(1);
    const e = at(0);
    expect(e._aws.CloudWatchMetrics[0].Namespace).toBe(DISPATCHER_METRIC_NAMESPACE);
    expect(e._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: METRIC_NAMES.M_MESSAGE_RECEIVED, Unit: 'Count' });
    expect(e._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
    expect(e[METRIC_NAMES.M_MESSAGE_RECEIVED]).toBe(1);
    expect(e.Agent).toBe('sandbox-person79b333-test');
  });

  // THE COST CONTROL, and the reason this metric does not simply replace the DynamoDB table: `Agent`
  // is bounded (~208), a per-user DIMENSION would be thousands × 208 custom metrics at $0.30/month
  // each. userId/channel must stay properties — searchable in Logs Insights, free.
  it('keeps userId and channel as PROPERTIES, never as dimensions', () => {
    const { m, at } = capture();
    m.emitMessageReceived('a', { userId: 'U123', channel: 'C456', eventType: 'app_mention' });
    const e = at(0);
    expect(e._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
    expect(e.userId).toBe('U123');
    expect(e.channel).toBe('C456');
    expect(e.eventType).toBe('app_mention');
  });

  it('omits optional props and never throws on a bare call', () => {
    const { m, at } = capture();
    expect(() => m.emitMessageReceived('a')).not.toThrow();
    expect(at(0).userId).toBeUndefined();
    expect(at(0).channel).toBeUndefined();
  });
});

describe('NOOP_METRICS', () => {
  it('is a safe DI default that produces no output', () => {
    expect(() => {
      NOOP_METRICS.emitProvision('a', { totalMs: 1 });
      NOOP_METRICS.emitInvoke('a', { latencyMs: 1 });
      NOOP_METRICS.emitProvisionError('a');
      NOOP_METRICS.emitInvokeError('a');
      NOOP_METRICS.emitMessageReceived('a', { userId: 'U1' });
    }).not.toThrow();
  });
});

// ── Per-session queue metrics ────────────────────────────────────────────────
//
// Per-message isolation means a burst QUEUES instead of overlapping, so a user's perceived latency is
// SessionQueueWaitMs + InvokeLatencyMs. Without these, the queue was only visible by reading logs —
// which is exactly how the "bound of 8 is too low" defect stayed hidden until a user hit it.
describe('emitSessionQueue', () => {
  const collect = () => {
    const lines = [];
    const m = createDispatcherMetrics({ emit: (l) => lines.push(l), now: () => 1234 });
    return { m, parsed: () => lines.map((l) => JSON.parse(l)) };
  };

  it('enqueue emits depth only', () => {
    const { m, parsed } = collect();
    m.emitSessionQueue('agent-a', { depth: 3, sessionId: 'ac-thread-x' });
    const [e] = parsed();
    expect(e.SessionQueueDepth).toBe(3);
    expect(e.SessionQueueWaitMs).toBeUndefined();
    expect(e.Agent).toBe('agent-a');
    expect(e.sessionId).toBe('ac-thread-x');   // property, never a dimension
    expect(e._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
  });

  it('slot entry emits wait with the depth it waited behind', () => {
    const { m, parsed } = collect();
    m.emitSessionQueue('agent-a', { waitMs: 8200, depth: 5 });
    const [e] = parsed();
    expect(e.SessionQueueWaitMs).toBe(8200);
    expect(e.depth).toBe(5);                   // context for "why was this slow"
    expect(e._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
  });

  it('a rejection emits ONLY the rejected count — never a depth/wait sample', () => {
    // A refused message never waited and never ran; counting it as a depth sample would bias the
    // very percentiles used to decide whether the bound is right.
    const { m, parsed } = collect();
    m.emitSessionQueue('agent-a', { rejected: true, depth: 50, max: 50 });
    const events = parsed();
    expect(events).toHaveLength(1);
    expect(events[0].SessionQueueRejectedCount).toBe(1);
    expect(events[0].SessionQueueDepth).toBeUndefined();
    expect(events[0].SessionQueueWaitMs).toBeUndefined();
    expect(events[0].maxQueue).toBe(50);
  });

  it('a zero wait is still emitted (0 is a real measurement, not a missing one)', () => {
    const { m, parsed } = collect();
    m.emitSessionQueue('agent-a', { waitMs: 0, depth: 1 });
    expect(parsed()[0].SessionQueueWaitMs).toBe(0);
  });

  it('emits nothing when there is nothing to say', () => {
    const { m, parsed } = collect();
    m.emitSessionQueue('agent-a', {});
    m.emitSessionQueue('agent-a');
    expect(parsed()).toHaveLength(0);
  });

  it('the no-op sink accepts it (DI default must stay side-effect free)', () => {
    expect(() => NOOP_METRICS.emitSessionQueue('a', { depth: 1 })).not.toThrow();
  });
});

describe('emitSessionQueue — backlog alert', () => {
  const collect = () => {
    const lines = [];
    const m = createDispatcherMetrics({ emit: (l) => lines.push(l), now: () => 1 });
    return { m, parsed: () => lines.map((l) => JSON.parse(l)) };
  };

  it('backlog emits its own count, carrying depth and the threshold', () => {
    const { m, parsed } = collect();
    m.emitSessionQueue('a', { backlog: true, depth: 240, alertAt: 200, sessionId: 'ac-x' });
    const [e] = parsed();
    expect(e.SessionQueueBacklogCount).toBe(1);
    expect(e.depth).toBe(240);
    expect(e.alertAt).toBe(200);
    expect(e.SessionQueueDepth).toBeUndefined();   // not also a depth sample
  });

  it('backlog is DISTINCT from rejected — they alarm on different things', () => {
    // Rejected only fires at the 10,000 memory backstop, which a human cannot reach; alarming on it
    // would never fire. Backlog is the signal that a thread is minutes behind.
    const { m, parsed } = collect();
    m.emitSessionQueue('a', { backlog: true, depth: 200 });
    m.emitSessionQueue('a', { rejected: true, depth: 10000, max: 10000 });
    const [b, r] = parsed();
    expect(b.SessionQueueBacklogCount).toBe(1);
    expect(b.SessionQueueRejectedCount).toBeUndefined();
    expect(r.SessionQueueRejectedCount).toBe(1);
    expect(r.SessionQueueBacklogCount).toBeUndefined();
  });
});

// ── Phase 1 concurrency gauges (provisioning-queue-plan.md) ─────────────────────────────────────

describe('createDispatcherMetrics: concurrency bounds', () => {
  it('emits busy/total/waiting for both bounds, fleet-wide, as Count gauges', () => {
    const { m, lines } = capture();
    m.emitConcurrencyBounds({
      provision: { held: 5, limit: 5, waiting: 3, avgWaitMs: 1200 },
      invoke: { held: 12, limit: 25, waiting: 0, avgWaitMs: 0 },
    });
    const byName = Object.fromEntries(lines.map((l) => {
      const e = JSON.parse(l);
      return [e._aws.CloudWatchMetrics[0].Metrics[0].Name, e];
    }));
    expect(byName[METRIC_NAMES.M_PROVISIONS_BUSY].ProvisionsBusy).toBe(5);
    expect(byName[METRIC_NAMES.M_PROVISIONS_TOTAL].ProvisionsTotal).toBe(5);
    expect(byName[METRIC_NAMES.M_PROVISIONS_WAITING].ProvisionsWaiting).toBe(3);
    expect(byName[METRIC_NAMES.M_INVOKES_BUSY].InvokesBusy).toBe(12);
    expect(byName[METRIC_NAMES.M_INVOKES_TOTAL].InvokesTotal).toBe(25);
    // The cap rides as a PROPERTY on the busy series too, so a single log line answers
    // "5 busy — out of how many?" without joining two metrics.
    expect(byName[METRIC_NAMES.M_PROVISIONS_BUSY].limit).toBe(5);
    expect(byName[METRIC_NAMES.M_PROVISIONS_BUSY].avgWaitMs).toBe(1200);
    // Fleet-wide: these bounds are process-global, so a per-Agent series would be meaningless.
    expect(byName[METRIC_NAMES.M_INVOKES_BUSY].Agent).toBe('fleet');
    expect(byName[METRIC_NAMES.M_INVOKES_BUSY]._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Count');
  });

  it('emits ZERO for an idle bound rather than nothing — an absent gauge reads as "no data"', () => {
    const { m, lines } = capture();
    m.emitConcurrencyBounds({ provision: { held: 0, limit: 5, waiting: 0, avgWaitMs: 0 }, invoke: null });
    const names = lines.map((l) => JSON.parse(l)._aws.CloudWatchMetrics[0].Metrics[0].Name);
    expect(names).toContain(METRIC_NAMES.M_PROVISIONS_BUSY);
    expect(names).not.toContain(METRIC_NAMES.M_INVOKES_BUSY); // absent input → no series invented
  });

  it('survives a partial/garbage stats object without throwing on the sampler path', () => {
    const { m, lines } = capture();
    expect(() => m.emitConcurrencyBounds({})).not.toThrow();
    expect(() => m.emitConcurrencyBounds()).not.toThrow();
    expect(() => m.emitConcurrencyBounds({ provision: { held: undefined, limit: 'x' } })).not.toThrow();
    expect(lines).toHaveLength(0);
  });

  it('adds waiting to poller saturation without disturbing busy/total', () => {
    const { m, lines } = capture();
    m.emitPollerSaturation({ busy: 40, total: 100, waiting: 7 });
    const byName = Object.fromEntries(lines.map((l) => {
      const e = JSON.parse(l);
      return [e._aws.CloudWatchMetrics[0].Metrics[0].Name, e];
    }));
    expect(byName[METRIC_NAMES.M_POLLERS_BUSY].TurnPollersBusy).toBe(40);
    expect(byName[METRIC_NAMES.M_POLLERS_TOTAL].TurnPollersTotal).toBe(100);
    expect(byName[METRIC_NAMES.M_POLLERS_WAITING].TurnPollersWaiting).toBe(7);
  });
});

// ── Session first-use vs reuse ───────────────────────────────────────────────────────────────────
//
// Reuse is the biggest swing in a warm turn (platform leg ~2,500ms new vs ~118ms reused). These
// metrics exist so that split is a first-class series rather than something inferred from the
// bimodal shape of a latency histogram in an ad-hoc query.

describe('createDispatcherMetrics.emitSessionUse', () => {
  const names = (lines) => lines.map((l) => JSON.parse(l)._aws.CloudWatchMetrics[0].Metrics[0].Name);

  it('emits FirstUse alone for a session never seen before', () => {
    const { m, lines } = capture();
    m.emitSessionUse('alpha', { firstUse: true, ageMs: null, idleExpired: false });
    expect(names(lines)).toEqual([METRIC_NAMES.M_SESSION_FIRST_USE]);
    // No gap metric: there is no previous invoke to measure from, and emitting 0 would pollute the
    // distribution that says how much a longer idle timeout would buy.
    expect(names(lines)).not.toContain(METRIC_NAMES.M_SESSION_GAP_MS);
  });

  it('emits Reused plus the gap for a session served inside the idle window', () => {
    const { m, lines } = capture();
    m.emitSessionUse('alpha', { firstUse: false, ageMs: 101_000, idleExpired: false });
    expect(names(lines)).toEqual([METRIC_NAMES.M_SESSION_REUSED, METRIC_NAMES.M_SESSION_GAP_MS]);
    const gap = JSON.parse(lines[1]);
    expect(gap.SessionReuseGapMs).toBe(101_000);
    expect(gap._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
  });

  it('counts IdleExpired IN ADDITION to Reused, never instead of it', () => {
    // Counting it as a third mutually-exclusive state would remove it from the reuse ratio, hiding the
    // one actionable case (we had the session and the timeout took it) inside the structural one.
    const { m, lines } = capture();
    m.emitSessionUse('alpha', { firstUse: false, ageMs: 901_000, idleExpired: true });
    expect(names(lines)).toContain(METRIC_NAMES.M_SESSION_REUSED);
    expect(names(lines)).toContain(METRIC_NAMES.M_SESSION_IDLE_EXPIRED);
  });

  it('keeps the per-Agent dimension — reuse rate is a property of how an agent is USED', () => {
    // A cron-driven agent reuses ~66% and a Slack-driven one ~13%; a fleet-only series averages that
    // away and the number stops meaning anything.
    const { m, lines } = capture();
    m.emitSessionUse('cron-agent', { firstUse: true, ageMs: null, idleExpired: false });
    const e = JSON.parse(lines[0]);
    expect(e.Agent).toBe('cron-agent');
    expect(e._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
  });

  it('is a no-op on a missing info object rather than emitting a phantom sample', () => {
    const { m, lines } = capture();
    m.emitSessionUse('alpha', null);
    m.emitSessionUse('alpha', undefined);
    expect(lines).toHaveLength(0);
  });
});

// ── Runtime cache: the pre-warm scoreboard ───────────────────────────────────────────────────────
//
// Phase 2's success criterion is "miss rate → 0", so this series has to be trustworthy BEFORE the
// queue exists — it is the baseline pre-warm gets judged against.

describe('createDispatcherMetrics.emitRuntimeCache', () => {
  const names = (lines) => lines.map((l) => JSON.parse(l)._aws.CloudWatchMetrics[0].Metrics[0].Name);

  it('emits a distinct COUNT per outcome, so each can be alarmed independently', () => {
    const cases = {
      hit: METRIC_NAMES.M_RUNTIME_CACHE_HIT,
      miss: METRIC_NAMES.M_RUNTIME_CACHE_MISS,
      coalesced: METRIC_NAMES.M_RUNTIME_CACHE_COALESCED,
      late_hit: METRIC_NAMES.M_RUNTIME_CACHE_LATE_HIT,
    };
    for (const [outcome, metric] of Object.entries(cases)) {
      const { m, lines } = capture();
      m.emitRuntimeCache('alpha', { outcome, waitMs: 9 });
      expect(names(lines)).toContain(metric);
    }
  });

  it('does NOT fold coalesced into miss — they demand opposite responses', () => {
    // Coalesced is the herd collapsing as designed (one provision, N waiters). Summing it into Miss
    // would make a WORKING roll look like a pre-warm failure and invite exactly the wrong fix.
    const { m, lines } = capture();
    m.emitRuntimeCache('alpha', { outcome: 'coalesced', waitMs: 40 });
    expect(names(lines)).toContain(METRIC_NAMES.M_RUNTIME_CACHE_COALESCED);
    expect(names(lines)).not.toContain(METRIC_NAMES.M_RUNTIME_CACHE_MISS);
  });

  it('reports resolve time on EVERY outcome, not just misses', () => {
    // A hit is 8-10ms (the registry GetItem). Timing hits is how a degrading fast path shows up at all.
    const { m, lines } = capture();
    m.emitRuntimeCache('alpha', { outcome: 'hit', waitMs: 9 });
    const ms = lines.map((l) => JSON.parse(l)).find((e) => e[METRIC_NAMES.M_RUNTIME_CACHE_WAIT_MS] !== undefined);
    expect(ms[METRIC_NAMES.M_RUNTIME_CACHE_WAIT_MS]).toBe(9);
    expect(ms.outcome).toBe('hit');           // so the histogram can be split by outcome
    expect(ms._aws.CloudWatchMetrics[0].Metrics[0].Unit).toBe('Milliseconds');
  });

  it('carries the runtime name as a PROPERTY, never a dimension', () => {
    // Per-generation dimensions would be unbounded cardinality; searchable in Insights is enough.
    const { m, lines } = capture();
    m.emitRuntimeCache('alpha', { outcome: 'miss', waitMs: 30000, runtime: 'oc_alpha_abc123' });
    const e = JSON.parse(lines[0]);
    expect(e.runtime).toBe('oc_alpha_abc123');
    expect(e._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
  });

  it('DROPS an unknown outcome rather than inventing a series', () => {
    // A wrong hit rate gets acted on; a missing one gets noticed. Dropping is the safer failure.
    const { m, lines } = capture();
    m.emitRuntimeCache('alpha', { outcome: 'sideways', waitMs: 1 });
    m.emitRuntimeCache('alpha', {});
    m.emitRuntimeCache('alpha');
    expect(lines).toHaveLength(0);
  });

  it('emits the count even when waitMs is missing', () => {
    const { m, lines } = capture();
    m.emitRuntimeCache('alpha', { outcome: 'hit' });
    expect(names(lines)).toEqual([METRIC_NAMES.M_RUNTIME_CACHE_HIT]);
  });
});

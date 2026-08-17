'use strict';

// vitest globals enabled via vitest.config.js
const {
  createCronAlertEmitter,
  CRON_METRIC_NAMESPACE,
  CRON_METRIC_NAME,
  CRON_DELIVERY_METRIC_NAME,
  CRON_REMOVED_METRIC_NAME,
} = require('./cron-metrics');

function capture() {
  const lines = [];
  const emitter = createCronAlertEmitter({ emit: (l) => lines.push(l), now: () => 1_800_000_000_000 });
  return { emitter, lines, first: () => JSON.parse(lines[0]) };
}

const job = (over = {}) => ({
  agentId: 'agent-k4wmx6',
  jobId: 'daily',
  id: 'agent-k4wmx6::daily',
  name: 'daily report',
  state: { consecutiveErrors: 3, lastError: 'boom' },
  ...over,
});

describe('createCronAlertEmitter.onAlert', () => {
  it('emits one EMF line with the right namespace, metric and value', () => {
    const { emitter, lines, first } = capture();
    emitter.onAlert(job());
    expect(lines).toHaveLength(1);
    const emf = first();
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(CRON_METRIC_NAMESPACE);
    expect(emf._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: CRON_METRIC_NAME, Unit: 'Count' });
    expect(emf[CRON_METRIC_NAME]).toBe(1);
    expect(emf._aws.Timestamp).toBe(1_800_000_000_000);
  });

  it('carries Agent as a dimension plus a fleet-wide aggregate ([] dimension set)', () => {
    const { emitter, first } = capture();
    emitter.onAlert(job());
    const emf = first();
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
    expect(emf.Agent).toBe('agent-k4wmx6');
  });

  it('rides JobId / name / consecutiveErrors / lastError as context properties (not dimensions)', () => {
    const { emitter, first } = capture();
    emitter.onAlert(job());
    const emf = first();
    expect(emf.JobId).toBe('daily');
    expect(emf.name).toBe('daily report');
    expect(emf.consecutiveErrors).toBe(3);
    expect(emf.lastError).toBe('boom');
  });

  it('is defensive about a sparse job (no agentId/state)', () => {
    const { emitter, first } = capture();
    expect(() => emitter.onAlert({})).not.toThrow();
    const emf = first();
    expect(emf.Agent).toBe('unknown');
    expect(emf[CRON_METRIC_NAME]).toBe(1);
    expect(emf.consecutiveErrors).toBe(0);
  });

  it('falls back to the composite id when jobId is absent', () => {
    const { emitter, first } = capture();
    emitter.onAlert({ agentId: 'a', id: 'a::x', state: {} });
    expect(first().JobId).toBe('a::x');
  });
});

// §9r — the swallowed-delivery-failure counterpart. A cron announce that fails leaves the
// turn "successful" everywhere else (by design), so this metric is the only alarmable signal.
describe('createCronAlertEmitter.onDeliveryFailure', () => {
  const dJob = (over = {}) => ({
    agentId: 'agent-k4wmx6',
    jobId: 'digest',
    name: 'daily digest',
    delivery: { mode: 'announce', channel: 'C123' },
    ...over,
  });

  it('emits one EMF line for CronDeliveryFailure in the cron namespace', () => {
    const { emitter, lines, first } = capture();
    emitter.onDeliveryFailure(dJob(), { mode: 'announce', error: 'channel_not_found' });
    expect(lines).toHaveLength(1);
    const emf = first();
    expect(emf._aws.CloudWatchMetrics[0].Namespace).toBe(CRON_METRIC_NAMESPACE);
    expect(emf._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: CRON_DELIVERY_METRIC_NAME, Unit: 'Count' });
    expect(emf[CRON_DELIVERY_METRIC_NAME]).toBe(1);
    expect(emf._aws.Timestamp).toBe(1_800_000_000_000);
  });

  it('is a DISTINCT metric from CronFailureAlert (a failing announce is not a failing turn)', () => {
    const { emitter, first } = capture();
    emitter.onDeliveryFailure(dJob(), { error: 'boom' });
    expect(first()[CRON_METRIC_NAME]).toBeUndefined();
  });

  it('carries Agent as a dimension plus the fleet-wide aggregate', () => {
    const { emitter, first } = capture();
    emitter.onDeliveryFailure(dJob(), { error: 'boom' });
    const emf = first();
    expect(emf._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
    expect(emf.Agent).toBe('agent-k4wmx6');
  });

  it('rides JobId / name / mode / channel / deliveryError as context properties', () => {
    const { emitter, first } = capture();
    emitter.onDeliveryFailure(dJob(), { mode: 'announce', error: 'channel_not_found' });
    const emf = first();
    expect(emf.JobId).toBe('digest');
    expect(emf.name).toBe('daily digest');
    expect(emf.mode).toBe('announce');
    expect(emf.channel).toBe('C123');
    expect(emf.deliveryError).toBe('channel_not_found');
    // channel/JobId must never become dimensions — unbounded cardinality.
    expect(emf._aws.CloudWatchMetrics[0].Dimensions.flat()).toEqual(['Agent']);
  });

  it('falls back to the job delivery mode when info omits it', () => {
    const { emitter, first } = capture();
    emitter.onDeliveryFailure(dJob({ delivery: { mode: 'webhook', to: 'https://hook' } }), { error: 'HTTP 500' });
    const emf = first();
    expect(emf.mode).toBe('webhook');
    expect(emf.channel).toBeUndefined();
  });

  it('is defensive about a sparse job and a missing info arg', () => {
    const { emitter, first } = capture();
    expect(() => emitter.onDeliveryFailure({})).not.toThrow();
    const emf = first();
    expect(emf.Agent).toBe('unknown');
    expect(emf.JobId).toBe('unknown');
    expect(emf.mode).toBe('unknown');
    expect(emf[CRON_DELIVERY_METRIC_NAME]).toBe(1);
  });
});


// Deletion telemetry. Before this, a removal left NO trace: cron-api's DELETE logs nothing and the
// only signal was a CronJobRecord ceasing to appear, so "which job did I just delete?" could only
// be answered by diffing snapshots.
describe('createCronAlertEmitter.onJobRemoved', () => {
  const gone = {
    agentId: 'sandbox-person79b333-test', jobId: '3732c948', name: 'whale-every-2min', enabled: true,
    schedule: { kind: 'every', everyMs: 120000 },
    delivery: { mode: 'announce', channel: 'C66PP782T9K' },
  };

  it('emits CronJobRemoved and DESCRIBES what went (the record is already gone by then)', () => {
    const { emitter, lines, first } = capture();
    emitter.onJobRemoved(gone);
    expect(lines).toHaveLength(1);
    const e = first();
    expect(e._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: CRON_REMOVED_METRIC_NAME, Unit: 'Count' });
    expect(e[CRON_REMOVED_METRIC_NAME]).toBe(1);
    expect(e.Agent).toBe('sandbox-person79b333-test');
    expect(e.JobId).toBe('3732c948');
    expect(e.name).toBe('whale-every-2min');
    expect(e.mode).toBe('announce');
    expect(e.channel).toBe('C66PP782T9K');
    expect(e.scheduleKind).toBe('every');
    expect(e.scheduleExpr).toBe('every 120000ms');
    expect(e.reason).toBe('requested');
  });

  it("defaults reason to 'requested' — it is NEVER a one-shot self-delete", () => {
    // one-shots self-remove via store.delete() inside the runner, bypassing service.remove(), so
    // this metric can only ever mean "somebody asked for this job to go".
    const { emitter, first } = capture();
    emitter.onJobRemoved(gone);
    expect(first().reason).toBe('requested');
  });

  it('renders a cron expression and a one-shot `at` too', () => {
    const { emitter, lines } = capture();
    emitter.onJobRemoved({ ...gone, schedule: { kind: 'cron', expr: '0 9 * * *' } });
    emitter.onJobRemoved({ ...gone, schedule: { kind: 'at', at: 1786311294770 } });
    expect(JSON.parse(lines[0]).scheduleExpr).toBe('0 9 * * *');
    expect(JSON.parse(lines[1]).scheduleExpr).toBe('at 1786311294770');
  });

  it('is defensive about a job that is already unknown', () => {
    const { emitter, first } = capture();
    expect(() => emitter.onJobRemoved({ id: 'a::b' })).not.toThrow();
    expect(first().Agent).toBe('unknown');
  });
});

// A cron turn is unattended and overruns are DROPPED (no queue, no catch-up), so neither signal
// was measurable before: a long run was a duration nobody recorded, a skipped tick was log.info.
describe('overrun metrics', () => {
  it('CronLongRun carries the duration as a property, not a dimension', () => {
    const lines = [];
    const e = createCronAlertEmitter({ emit: (l) => lines.push(l), now: () => 0 });
    e.onLongRun({ agentId: 'agentA', jobId: 'j1', name: 'nightly' }, { durationMs: 900000, status: 'ok' });
    const emf = JSON.parse(lines[0]);
    const m = emf._aws.CloudWatchMetrics[0];
    expect(m.Metrics.map((x) => x.Name)).toContain('CronLongRun');
    expect(m.Dimensions.flat()).not.toContain('durationMs');  // unbounded cardinality
    expect(emf.durationMs).toBe(900000);
    expect(emf.status).toBe('ok');
    expect(emf.CronLongRun).toBe(1);
  });

  it('CronOverlapSkip counts a LOST execution', () => {
    const lines = [];
    const e = createCronAlertEmitter({ emit: (l) => lines.push(l), now: () => 0 });
    e.onOverlapSkip({ agentId: 'agentA', jobId: 'j1', name: 'every-2m', schedule: { kind: 'every', everyMs: 120000 } });
    const emf = JSON.parse(lines[0]);
    expect(emf._aws.CloudWatchMetrics[0].Metrics.map((x) => x.Name)).toContain('CronOverlapSkip');
    expect(emf.CronOverlapSkip).toBe(1);
    expect(emf.schedule).toBe('every');
  });

  it('neither throws on a malformed job (metrics must never break the scheduler)', () => {
    const e = createCronAlertEmitter({ emit: () => {}, now: () => 0 });
    expect(() => e.onLongRun(null, null)).not.toThrow();
    expect(() => e.onOverlapSkip(undefined)).not.toThrow();
  });
});

// §3a' — a tick declined by the CRON_RUNNER gate writes NOTHING to the store (that is deliberate:
// see cron-runner runOnce), so this metric is the only place the whole class is countable.
describe('CronFireGated', () => {
  it('counts a declined tick and says WHY it was declined', () => {
    const lines = [];
    const e = createCronAlertEmitter({ emit: (l) => lines.push(l), now: () => 0 });
    e.onRunnerGated({ agentId: 'dm-u1', jobId: 'j1', name: 'daily' }, { runner: 'openclaw', source: 'default' });
    const emf = JSON.parse(lines[0]);
    expect(emf._aws.CloudWatchMetrics[0].Metrics.map((x) => x.Name)).toContain('CronFireGated');
    expect(emf.CronFireGated).toBe(1);
    expect(emf.Agent).toBe('dm-u1');
    // 'default' (nobody has flipped this scope) vs 'store' (pinned on purpose) vs 'unreadable'
    // (the table read failed) are three very different reasons for the same silence.
    expect(emf.runnerSource).toBe('default');
    expect(emf.runner).toBe('openclaw');
  });

  it('does not throw on a malformed job', () => {
    const e = createCronAlertEmitter({ emit: () => {}, now: () => 0 });
    expect(() => e.onRunnerGated(null)).not.toThrow();
  });
});

'use strict';

// Cron failure-alert metric (pi-cron-migration-plan.md §6 / Phase 4 §9d).
//
// The runner tracks `consecutiveErrors` per job and calls `onAlert(job)` once it reaches
// the job's `failureAlert.afterConsecutiveErrors` threshold (default 3) — but index.js
// wired NO onAlert, so that alert logic fired into a no-op. This emits a CloudWatch
// metric datapoint on each alert so an alarm (§9e, Terraform) can page, preserving the
// agent-visible failureAlert semantics the ECS gateway had.
//
// EMF (CloudWatch Embedded Metric Format): we write a structured JSON line to stdout and
// CloudWatch Logs auto-extracts the metric — NO PutMetricData call, so no extra IAM and
// no new SDK dependency (matches the "small, high-operability" intent). The awslogs log
// driver already ships the dispatcher's stdout to a CloudWatch log group.
//
// Dimension is Agent only (bounded cardinality); JobId/name ride as context properties
// (a per-job dimension would explode cardinality). The alarm keys on Namespace+Agent.

// Per-stack, same reasoning as dispatcher-metrics.js: two gateways share this image and both emit a
// fleet-wide aggregate. Default is the historical value so the OpenClaw stack does not move.
const NAMESPACE = process.env.CRON_METRIC_NAMESPACE || 'ClawdbotCron';
const METRIC = 'CronFailureAlert';

// Delivery-failure metric (§9r). CronFailureAlert covers a failing TURN; it does NOT cover a
// failing ANNOUNCE. cron-delivery.js deliberately swallows delivery errors — "the turn already
// ran", so a bad channel must not bump consecutiveErrors and trip failureAlert — which left the
// path silent: a cron job whose Slack post fails succeeds as far as every metric and alarm is
// concerned, visible only in the 'cron delivery failed' log line. This is the counterpart metric,
// emitted from that same catch, so the silent path alarms.
const METRIC_DELIVERY = 'CronDeliveryFailure';
// Deletion telemetry. A removal used to leave NO trace anywhere: cron-api's DELETE route logs
// nothing, the tool call is not logged with its action, and the only signal was a CronJobRecord
// silently ceasing to appear — so "which job did I just delete?" could only be INFERRED by diffing
// snapshots. This makes it an explicit event.
//
// Deliberately emitted from the service's remove() and NOT from the store: a one-shot job
// self-deletes via store.delete() inside the runner (cron-runner.js:225/248/271), which bypasses
// remove(). So this metric means "somebody asked for this job to go", never "it finished".
const METRIC_REMOVED = 'CronJobRemoved';
// A run that took longer than the long-run threshold (default 10 min). NOT a failure — the turn
// may well succeed — but for any job firing more often than the threshold it also means ticks are
// being dropped, and it is the leading indicator for the largest prod failure class (`run: timeout`
// is 30 of 79 failing prod jobs). Duration rides as a property; the metric is a count so the alarm
// is "any long run in the period".
const METRIC_LONG_RUN = 'CronLongRun';
// A tick discarded because the previous run of the same job was still going. There is no queue and
// no catch-up (cron-runner.onDue), so this is a LOST execution: the job silently runs at a fraction
// of its configured frequency. Previously log.info only — invisible to every metric and alarm.
const METRIC_OVERLAP_SKIP = 'CronOverlapSkip';
// A tick this dispatcher DECLINED because the scope's CRON_RUNNER is not `agentcore` (§3a'). Not a
// failure — it is the migration working, and the OpenClaw gateway is firing that job instead — but
// it is the only quantity that answers the two questions the cutover actually turns on: "is archie
// still holding back on the scopes we have not moved" and, once a scope is flipped, "did this stop".
// A gated tick writes NOTHING to the store by design (cron-runner runOnce), so without this metric
// the whole class is log-only.
const METRIC_RUNNER_GATED = 'CronFireGated';

/**
 * @param deps.emit       optional (line:string) => void sink (default: process.stdout).
 * @param deps.namespace  optional metric namespace (default ClawdbotCron).
 * @param deps.now        optional () => epoch ms (injectable for tests).
 * @param deps.log        optional pino-shaped logger.
 * @returns { onAlert(job), onDeliveryFailure(job, info) }
 */
function createCronAlertEmitter(deps = {}) {
  const emit = deps.emit || ((line) => process.stdout.write(`${line}\n`));
  const namespace = deps.namespace || NAMESPACE;
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  // One EMF line: a single Count metric with an `Agent` dimension AND the fleet-wide `[]`
  // aggregate. `props` ride as EMF context properties (searchable in Logs Insights), never
  // as dimensions — JobId/channel per-dimension would explode cardinality. Never throws:
  // a metrics failure must not propagate into the scheduler or the delivery path.
  function emitMetric(metricName, agent, jobId, props) {
    const emf = {
      _aws: {
        Timestamp: now(),
        CloudWatchMetrics: [{
          Namespace: namespace,
          Dimensions: [['Agent'], []], // per-agent AND a fleet-wide aggregate
          Metrics: [{ Name: metricName, Unit: 'Count' }],
        }],
      },
      Agent: agent,
      JobId: jobId,
      ...props,
      [metricName]: 1,
    };
    try {
      emit(JSON.stringify(emf));
    } catch (err) {
      log.warn({ err: String(err && err.message), agent, jobId, metric: metricName }, 'cron alert metric emit failed');
    }
  }

  const agentOf = (job) => (job && job.agentId) || 'unknown';
  const jobIdOf = (job) => (job && job.jobId) || (job && job.id) || 'unknown';

  function onAlert(job) {
    const agent = agentOf(job);
    const jobId = jobIdOf(job);
    const consecutiveErrors = (job && job.state && job.state.consecutiveErrors) || 0;
    emitMetric(METRIC, agent, jobId, {
      name: (job && job.name) || jobId,
      lastError: job && job.state && job.state.lastError,
      consecutiveErrors,
    });
    log.warn({ agent, jobId, consecutiveErrors }, 'cron failureAlert threshold reached — emitted CronFailureAlert metric');
  }

  /**
   * A cron announce failed after a successful turn. Wired as cron-delivery's `onFailure`.
   * @param job   the cron job whose delivery failed.
   * @param info  { mode, error } from the delivery catch.
   *
   * No log line here — cron-delivery.js already logs 'cron delivery failed' at error level with
   * the same fields, and double-logging one event makes the log-based triage ambiguous.
   */
  function onDeliveryFailure(job, info = {}) {
    const jobId = jobIdOf(job);
    const delivery = (job && job.delivery) || {};
    emitMetric(METRIC_DELIVERY, agentOf(job), jobId, {
      name: (job && job.name) || jobId,
      mode: info.mode || delivery.mode || 'unknown',
      // Slack channel id — bounded, non-PHI, and the first thing triage needs.
      channel: delivery.channel,
      deliveryError: info.error === undefined || info.error === null ? undefined : String(info.error),
    });
  }

  /**
   * A job was removed by request (API/tool), not by completing. `job` is the record as it was
   * BEFORE deletion, so the event is self-describing — the whole point is to answer "what did I
   * just delete" without needing the store that no longer has it.
   */
  // durationMs rides as a property, not a dimension: it is unbounded cardinality, and the alarm
  // only needs "did any run exceed the threshold".
  function onLongRun(job, info) {
    emitMetric(METRIC_LONG_RUN, job && job.agentId, job && job.jobId, {
      name: (job && job.name) || null,
      durationMs: (info && info.durationMs) || 0,
      status: (info && info.status) || null,
    });
  }

  function onOverlapSkip(job) {
    emitMetric(METRIC_OVERLAP_SKIP, job && job.agentId, job && job.jobId, {
      name: (job && job.name) || null,
      // The frequency makes the impact legible: a 2-minute job skipping is losing a lot more than
      // a daily one.
      schedule: (job && job.schedule && job.schedule.kind) || null,
    });
  }

  /**
   * A fire declined by the CRON_RUNNER gate. `info` is the resolved flag record, so `source`
   * distinguishes "pinned to openclaw by a decision" from "nobody has flipped this scope yet" and
   * from "the table read failed" — three very different reasons for the same silence.
   */
  function onRunnerGated(job, info = {}) {
    emitMetric(METRIC_RUNNER_GATED, agentOf(job), jobIdOf(job), {
      name: (job && job.name) || null,
      runner: info.runner || null,
      runnerSource: info.source || null,
    });
  }

  function onJobRemoved(job, info = {}) {
    const jobId = jobIdOf(job);
    const delivery = (job && job.delivery) || {};
    const sched = (job && job.schedule) || {};
    emitMetric(METRIC_REMOVED, agentOf(job), jobId, {
      name: (job && job.name) || jobId,
      mode: delivery.mode || 'none',
      channel: delivery.channel,
      scheduleKind: sched.kind,
      scheduleExpr: sched.expr || (sched.everyMs != null ? `every ${sched.everyMs}ms` : (sched.at != null ? `at ${sched.at}` : undefined)),
      enabled: job ? job.enabled !== false : undefined,
      reason: info.reason || 'requested',
    });
    log.info({ agent: agentOf(job), jobId, name: (job && job.name) || jobId, reason: info.reason || 'requested' }, 'cron job removed');
  }

  return { onAlert, onDeliveryFailure, onJobRemoved, onLongRun, onOverlapSkip, onRunnerGated, _namespace: namespace, _metric: METRIC, _metricDelivery: METRIC_DELIVERY };
}

module.exports = {
  createCronAlertEmitter,
  CRON_LONG_RUN_METRIC: METRIC_LONG_RUN,
  CRON_OVERLAP_SKIP_METRIC: METRIC_OVERLAP_SKIP,
  CRON_RUNNER_GATED_METRIC: METRIC_RUNNER_GATED,
  CRON_METRIC_NAMESPACE: NAMESPACE,
  CRON_METRIC_NAME: METRIC,
  CRON_DELIVERY_METRIC_NAME: METRIC_DELIVERY,
  CRON_REMOVED_METRIC_NAME: METRIC_REMOVED,
};

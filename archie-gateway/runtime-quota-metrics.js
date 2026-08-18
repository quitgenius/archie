'use strict';

// ── Agent-runtime quota gauge ───────────────────────────────────────────────────────────────────
//
// THE CEILING THIS WATCHES: `Total Agents per Account` (Service Quotas L-F4575653, bedrock-agentcore),
// 1,000 in us-east-1 and ADJUSTABLE. "Agents" there means AGENT RUNTIMES, not agents in our sense —
// we mint one runtime per (agent, image tag), so the fleet consumes `agents x live tags`:
//
//   every agent in the fleet, gc --keep 1 -> 2 tags = 416 runtimes, staging peak 3 tags = 624
//                gc --keep 2 -> 3 tags = 624,          staging peak 4 tags = 832
//                gc --keep 3 -> 4 tags = 832,          staging peak 5 tags = 1,040  <- OVER
//
// So the gc keep policy, not the agent count, is what walks the fleet into the limit, and it does so
// during a ROLL — the worst possible moment, because the failure is CreateAgentRuntime refusing and
// every agent whose runtime has not been staged yet stops serving turns.
//
// WHY THIS FILE EXISTS AT ALL — the quota is invisible to CloudWatch. Service Quotas can only alarm on
// a quota that publishes a `UsageMetric` into AWS/Usage, and (verified against
// `list-service-quotas --service-code bedrock-agentcore`, 2026-08-18) only the per-second RATE quotas
// carry one. Every RESOURCE-COUNT quota in that service — this one, workload identities, memories —
// has no usage metric, so there is no AWS-published series to threshold and no Service Quotas alarm to
// create. The count has to be measured by us or not at all.
//
// WHY ListAgentRuntimes AND NOT THE REGISTRY. The DynamoDB runtime registry knows what the dispatcher
// wrote; the quota is applied to what EXISTS. Those differ exactly where it hurts: a runtime created by
// a provision that then failed, a delete that errored, anything minted by the CLI or by hand. Those
// orphans consume quota while being invisible to every registry-side count, which makes the registry
// the one source that would under-report right up to the moment provisioning starts failing.
// `runtime.js --reconcile-aws` exists for the same reason.
//
// COST OF ASKING. ListAgentRuntimes is 25/s ACCOUNT-WIDE and non-adjustable (which is why nothing on
// the turn path may call it). One paginated pass every 5 minutes is ~7 calls at 100/page for a
// full-size fleet — roughly 0.02/s, i.e. a rounding error against the shared budget. The dispatcher
// task role already holds the (unscopable) `ListAgentRuntimes` grant for gc, so this adds no IAM.
//
// DELETING runtimes are COUNTED. A delete takes ~5 minutes to complete and the name is held for all of
// it; treating those as already-gone would under-report precisely during a roll, when the number is
// moving fastest. The per-status breakdown below is what separates "we own 900 runtimes" from "we own
// 700 and are waiting on 200 deletes".

const NAMESPACE = process.env.DISPATCHER_METRIC_NAMESPACE || 'ClawdbotDispatcher';

// The gauge to alarm on: total runtimes in the account/region. GAUGE, so alarm on Maximum — a Sum
// would multiply by the sample count over the window.
const METRIC_COUNT = 'AgentRuntimeCount';
// The cap, emitted alongside on every sample for the same reason TurnPollersTotal rides with
// TurnPollersBusy: 900 runtimes means nothing without the number it is 900 OF, and this quota is
// adjustable — the day someone raises it to 2,000 the alarm threshold is stale and this series is the
// only thing that says so.
const METRIC_QUOTA = 'AgentRuntimeQuota';

// L-F4575653 in us-east-1. Overridable via env so a quota increase does not need an image build.
const DEFAULT_QUOTA = 1000;

// 5 minutes. The count only moves at provisioning speed, so a finer sample buys nothing and spends
// account-wide List budget that the gc pass also draws on.
const DEFAULT_INTERVAL_MS = 300_000;

const PAGE_SIZE = 100;
// Backstop against a pagination bug spinning forever against a rate-limited API. 60 pages is 6,000
// runtimes — 6x the quota this file exists to watch, so hitting it means the loop is broken, not that
// the fleet grew.
const MAX_PAGES = 60;

/** Default page fetcher: the real control-plane client, built lazily on first use. */
function defaultListPage(deps) {
  let client = deps.client || null;
  let Command = null;
  return async (nextToken) => {
    const sdk = require('@aws-sdk/client-bedrock-agentcore-control');
    if (!client) {
      client = new sdk.BedrockAgentCoreControlClient({
        region: deps.region || process.env.AWS_REGION || 'us-east-1',
      });
    }
    if (!Command) Command = sdk.ListAgentRuntimesCommand;
    return client.send(new Command({ maxResults: PAGE_SIZE, ...(nextToken ? { nextToken } : {}) }));
  };
}

/**
 * Create the runtime-quota sampler.
 *
 * @param deps.listPage    optional (nextToken) => Promise<{agentRuntimes, nextToken}> (injectable for tests).
 * @param deps.client      optional pre-built control client (used by the default listPage).
 * @param deps.emit        optional (line:string) => void EMF sink (default: stdout).
 * @param deps.namespace   optional metric namespace (default: the per-stack env value).
 * @param deps.quota       optional cap (default: AGENT_RUNTIME_QUOTA env, else 1000).
 * @param deps.intervalMs  optional sample interval; <= 0 disables the timer entirely.
 */
function createRuntimeQuotaSampler(deps = {}) {
  const write = deps.emit || ((line) => process.stdout.write(`${line}\n`));
  const namespace = deps.namespace || NAMESPACE;
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const quota = Number(deps.quota ?? process.env.AGENT_RUNTIME_QUOTA ?? DEFAULT_QUOTA) || DEFAULT_QUOTA;
  const intervalMs = Number(
    deps.intervalMs ?? process.env.RUNTIME_QUOTA_SAMPLE_MS ?? DEFAULT_INTERVAL_MS,
  );
  const setIntervalFn = deps.setInterval || setInterval;
  const clearIntervalFn = deps.clearInterval || clearInterval;
  const listPage = deps.listPage || defaultListPage(deps);

  let timer = null;
  let disabled = false;

  /** Paginate the account's runtimes. @returns {{total:number, byStatus:Map, pages:number, truncated:boolean}} */
  async function count() {
    const byStatus = new Map();
    let total = 0;
    let token;
    let pages = 0;
    let truncated = false;
    do {
      const page = await listPage(token);
      pages += 1;
      for (const r of (page && page.agentRuntimes) || []) {
        total += 1;
        const s = (r && r.status) || 'UNKNOWN';
        byStatus.set(s, (byStatus.get(s) || 0) + 1);
      }
      token = page && page.nextToken;
      if (token && pages >= MAX_PAGES) {
        truncated = true;
        break;
      }
    } while (token);
    return { total, byStatus, pages, truncated };
  }

  /**
   * Emit the fleet total (dimensionless — the series alarms are built on) plus one line per status.
   *
   * The status lines carry ONLY the `Status` dimension and are deliberately not folded into the
   * dimensionless aggregate: they partition the same population, so publishing them into `[]` would
   * put N datapoints per tick on the alarmed series and double the number it reports.
   */
  function emitSnapshot({ total, byStatus, pages, truncated }) {
    const ts = now();
    const pct = quota > 0 ? Math.round((total / quota) * 1000) / 10 : null;
    try {
      write(JSON.stringify({
        _aws: {
          Timestamp: ts,
          CloudWatchMetrics: [{
            Namespace: namespace,
            Dimensions: [[]],
            Metrics: [{ Name: METRIC_COUNT, Unit: 'Count' }, { Name: METRIC_QUOTA, Unit: 'Count' }],
          }],
        },
        // Properties, not dimensions: readable in Logs Insights, free of per-series cost.
        headroom: quota - total,
        utilizationPct: pct,
        pages,
        ...(truncated ? { truncated: true } : {}),
        [METRIC_COUNT]: total,
        [METRIC_QUOTA]: quota,
      }));
      for (const [status, n] of byStatus) {
        write(JSON.stringify({
          _aws: {
            Timestamp: ts,
            CloudWatchMetrics: [{
              Namespace: namespace,
              Dimensions: [['Status']],
              Metrics: [{ Name: METRIC_COUNT, Unit: 'Count' }],
            }],
          },
          Status: status,
          [METRIC_COUNT]: n,
        }));
      }
    } catch (err) {
      log.warn({ err: String(err && err.message) }, 'runtime quota metric emit failed');
    }
  }

  /**
   * One sample. NEVER throws — a metrics failure must not touch the turn path.
   *
   * AccessDenied disables the sampler permanently instead of retrying: the grant is static, so a denial
   * is a deployment fact rather than a transient, and re-asking every 5 minutes forever would produce a
   * log line an hour with no path to recovery. (It is a real case: the OpenClaw baseline dispatcher runs
   * from the same image family without this stack's ListAgentRuntimes grant.)
   */
  async function sample() {
    if (disabled) return null;
    try {
      const snap = await count();
      emitSnapshot(snap);
      if (snap.total >= quota * 0.9) {
        log.warn({ runtimes: snap.total, quota }, 'agent runtime count is within 10% of the account quota');
      }
      return snap;
    } catch (err) {
      const name = err && (err.name || err.code);
      if (name === 'AccessDeniedException' || name === 'AccessDenied') {
        disabled = true;
        stop();
        log.warn({ err: String(err && err.message) }, 'runtime quota sampler disabled — no ListAgentRuntimes permission');
        return null;
      }
      log.warn({ err: String(err && err.message) }, 'runtime quota sample failed');
      return null;
    }
  }

  function start() {
    if (timer || disabled) return timer;
    if (!(intervalMs > 0)) {
      log.info('runtime quota sampler disabled by interval <= 0');
      return null;
    }
    // Sample once at boot so a stack that is already near the ceiling says so immediately rather than
    // one interval later — a fleet roll can consume hundreds of runtimes inside five minutes.
    //
    // The .catch handlers are unreachable by construction (sample() handles its own failures) and exist
    // only so a future edit that makes it throw cannot take the process down with an unhandled
    // rejection. They LOG rather than swallow, because "unreachable" is an assumption worth testing.
    sample().catch((err) => log.warn({ err: String(err && err.message) }, 'runtime quota boot sample threw'));
    timer = setIntervalFn(() => {
      sample().catch((err) => log.warn({ err: String(err && err.message) }, 'runtime quota sample threw'));
    }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  function stop() {
    if (!timer) return;
    clearIntervalFn(timer);
    timer = null;
  }

  return { start, stop, sample, count, intervalMs, quota };
}

module.exports = {
  createRuntimeQuotaSampler,
  RUNTIME_QUOTA_NAMESPACE: NAMESPACE,
  RUNTIME_QUOTA_METRIC_COUNT: METRIC_COUNT,
  RUNTIME_QUOTA_METRIC_QUOTA: METRIC_QUOTA,
  RUNTIME_QUOTA_DEFAULT: DEFAULT_QUOTA,
  RUNTIME_QUOTA_MAX_PAGES: MAX_PAGES,
};

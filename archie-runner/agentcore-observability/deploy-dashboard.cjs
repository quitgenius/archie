'use strict';

// Builds + deploys the AgentCore observability CloudWatch dashboard from the
// shared query/metric library (insight-queries.js). Idempotent (PutDashboard).
//   AWS_PROFILE=sandbox node deploy-dashboard.cjs [dashboardName]

const { CloudWatchClient, PutDashboardCommand } = require('@aws-sdk/client-cloudwatch');
const Q = require('./insight-queries');

// Fleet-wide dashboard (SEARCH across all agents + dispatcher fleet logs), not per-agent.
const NAME = process.argv[2] || process.env.AGENTCORE_DASHBOARD_NAME || 'agentcore-fleet';

function metricWidget(x, y, w, h, title, specs, view = 'timeSeries') {
  return {
    type: 'metric', x, y, width: w, height: h,
    properties: {
      region: Q.REGION, title, view, stacked: false, period: 300,
      metrics: specs.map((s, i) => [{ expression: s.expr, id: `e${i}`, label: s.label }]),
    },
  };
}

function logWidget(x, y, w, h, title, insight, view = 'table') {
  const source = insight.logGroups.map((g) => `'${g}'`).join(' ');
  return {
    type: 'log', x, y, width: w, height: h,
    properties: { region: Q.REGION, title, view, query: `SOURCE ${source} | ${insight.query}` },
  };
}

function textWidget(x, y, w, h, markdown) {
  return { type: 'text', x, y, width: w, height: h, properties: { markdown } };
}

const M = Q.METRICS;
const body = {
  widgets: [
    // Row 1 — runtime health (AWS/Bedrock-AgentCore)
    metricWidget(0, 0, 6, 6, 'Invocations', [M.invocations]),
    metricWidget(6, 0, 6, 6, 'Latency p95 / Duration avg (ms)', [M.latency, M.duration]),
    metricWidget(12, 0, 6, 6, 'Errors / Throttles', [M.errors, M.userErrors, M.systemErrors, M.throttles]),
    metricWidget(18, 0, 6, 6, 'Active sessions', [M.activeSessions]),
    // Row 2 — token usage (ApplicationSignals, from adapter agent_i32pz9 spans)
    metricWidget(0, 6, 24, 6, 'Token usage (input / output)', [M.inputTokens, M.outputTokens]),
    // Row 3 — per-turn LLM detail (adapter agent_i32pz9 spans in aws/spans; populates when
    // AGENTCORE_OTEL_MODE=xray is set on the runtimes — see runtimeEnv).
    logWidget(0, 12, 24, 6, 'Recent agent turns (session / model / tokens / duration / finish) — needs tracing on', Q.INSIGHTS.genai_turns),
    // Row 4 — cold start (AgentCore/Pi ColdBootMs EMF, per-Agent): avg + worst-case band
    // beside the boot-concurrency (boots/min = how many microVMs spawned at once).
    metricWidget(0, 18, 12, 6, 'Cold start — avg / max per agent (ms, ~1s band)', [M.coldBoot, M.coldBootMax]),
    metricWidget(12, 18, 12, 6, 'Boot concurrency — cold boots / min (each new thread = 1)', [M.bootConcurrency]),
    // Row 5 — on-demand spawns + fleet invoke outcomes (dispatcher log)
    logWidget(0, 24, 12, 6, 'On-demand agents spawned (per unmapped channel/DM)', Q.INSIGHTS.agent_spawns),
    logWidget(12, 24, 12, 6, 'Invoke outcomes — complete vs failed (5-min bins)', Q.INSIGHTS.invoke_outcomes, 'timeSeries'),
    // Row 6 — fleet errors (dispatcher log, level>=50)
    logWidget(0, 30, 24, 6, 'Fleet errors (dispatcher, level≥error)', Q.INSIGHTS.fleet_errors),
    // Row 7 — per-turn EMF metrics (P2): latency/TTFT, tokens, real error count (AgentCore/Pi,
    // per-Agent). 1-line metric queries replacing span scans; TurnErrorCount is P4-disambiguated.
    metricWidget(0, 36, 8, 6, 'Turn latency p90 / avg + TTFT p90 (ms, per agent)', [M.turnLatencyP90, M.turnLatencyAvg, M.turnTtftP90]),
    metricWidget(8, 36, 8, 6, 'Tokens per turn (input / output, per agent)', [M.turnTokensInput, M.turnTokensOutput]),
    metricWidget(16, 36, 8, 6, 'Turn errors — real failures only (P4-disambiguated)', [M.turnErrors]),
    // Row 7b — prompt-cache observability: cache read/write token volumes (the true prompt size that
    // usage.input hides) + cache-hit rate (fraction of turns reusing a cached prefix). Big cost lever.
    metricWidget(0, 42, 8, 6, 'Cache tokens per turn (read / write, per agent)', [M.turnCacheReadTokens, M.turnCacheWriteTokens]),
    metricWidget(8, 42, 8, 6, 'True prompt size — input+cache tokens / turn (per agent)', [M.turnTokensContext]),
    metricWidget(16, 42, 8, 6, 'Cache-hit rate — fraction of turns hitting cache (0..1, per agent)', [M.turnCacheHitRate]),
    // Row 8 — turn-outcome breakdown (P4): benign empties read outcome=empty/finish=stop; only
    // genuine failures carry status.code=ERROR. The trust check that the `error` bucket is real.
    logWidget(0, 48, 24, 6, 'Turn outcomes — reply / empty / error × finish × status (P4)', Q.INSIGHTS.turn_outcomes),
    // Row 9 — per-tool spans (P1): call count / latency / errors per tool (execute_tool child
    // spans). Tool calls were previously invisible in the trace; this is the completeness win.
    logWidget(0, 54, 24, 6, 'Per-tool spans — calls / avg+max ms / errors by tool (P1)', Q.INSIGHTS.tool_spans),
    // Row 10 — cost (P3) + live context size (P6). Cost is pi-ai's computed USD per turn.
    metricWidget(0, 60, 12, 6, 'Cost — USD / turn (Sum, per agent)', [M.turnCost]),
    metricWidget(12, 60, 12, 6, 'Context length — tokens in context (avg, per agent)', [M.contextLengthTokens]),
    // Row 11 — session shape (P6): length + human/AI balance + compaction frequency per agent.
    metricWidget(0, 66, 12, 6, 'Session shape — length / AI / human responses (avg, per agent)', [M.sessionLengthTurns, M.aiResponses, M.humanResponses]),
    metricWidget(12, 66, 12, 6, 'Compactions per session (max, per agent)', [M.compactionEvents]),
    // Row 12 — P5 signpost: where the agent_i32pz9 detail actually lives (not the raw X-Ray console).
    // Row 13 — dispatcher observability (M2/M3): the cross-boundary trace-stitch health
    // (context_source=payload-traceparent ⇒ dispatcher→runtime joined on one traceId) and the
    // dispatcher phase-span tree (provision/name_release_wait/warmup/invoke durations) — the two
    // signals the M3 delivery was debugged with (dashboard-living-artifact rule).
    logWidget(0, 72, 12, 6, 'Trace stitch — runtime turns by trace.context_source (payload-traceparent = joined)', Q.INSIGHTS.trace_stitch),
    logWidget(12, 72, 12, 6, 'Dispatcher phase spans — request / provision / name_release_wait / warmup / invoke (ms)', Q.INSIGHTS.dispatcher_spans),
    textWidget(0, 78, 24, 3, [
      '### Where the agent_i32pz9 detail lives',
      'Token/model/tool/outcome detail is in the **`aws/spans`** log group (CloudWatch Transaction Search), queried via Logs Insights — **not** the raw X-Ray console (which only shows the trace skeleton).',
      'See the `genai_turns` / `turn_outcomes` / `tool_spans` log widgets above. Everything is **us-east-1**; requires Transaction Search enabled + runtimes on `AGENTCORE_OTEL_MODE=xray`. Details: `agentcore-observability/README.md`.',
    ].join('\n\n')),
    // Row 13 — dispatcher operational metrics (dispatcher-observability M1 / D6, namespace
    // ClawdbotDispatcher). These are emitted by the DISPATCHER (EMF-via-stdout), not the runtime:
    // cold-provision phase timing + invoke-leg latency/retries. ProvisionRuntimeReadyMs ≈ 30s
    // (bench-cold-provision.mjs's deterministic figure) is the health signal for on-demand spawn.
    metricWidget(0, 75, 8, 6, 'Provision → READY (ms) — p90 / max (dispatcher, ~30s cold)', [M.provisionTotalP90, M.provisionTotalMax]),
    metricWidget(8, 75, 8, 6, 'Provision phases (ms) — mount-targets / access-point / runtime (avg)', [M.provisionMountTargetsMs, M.provisionAccessPointMs, M.provisionRuntimeReadyMs]),
    metricWidget(16, 75, 8, 6, 'Provision counts — runtimes / access points / errors (fleet)', [M.runtimeCreatedCount, M.accessPointCreatedCount, M.provisionErrorCount]),
    // Row 14 — dispatcher invoke-leg metrics: latency p90 + cold-retry / error volumes.
    metricWidget(0, 81, 12, 6, 'Invoke latency p90 (ms, dispatcher, per agent)', [M.invokeLatencyP90]),
    metricWidget(12, 81, 12, 6, 'Invoke cold-retries / errors (fleet)', [M.invokeColdRetries, M.invokeErrorCount]),
    // Row 14b — PER-SESSION QUEUE (per-message isolation). Invoke latency above measures the WORK;
    // these measure the WAIT, which is what a user in a burst actually feels. Live 2026-08-11, a
    // 15-message burst ran dispatcher.request p50 35s against dispatcher.agent_i073q7 p50 8s — ~77%
    // of perceived latency was queueing, invisible in every widget on this dashboard until now.
    // Rejected should stay flat at ZERO; anything else means the bound is too low for real use.
    metricWidget(0, 87, 8, 6, 'Queue wait (ms) — p50 / p90 / max (per agent)', [M.sessionQueueWaitP50, M.sessionQueueWaitP90, M.sessionQueueWaitMax]),
    metricWidget(8, 87, 8, 6, 'Queue depth — max / avg (1 = straight through)', [M.sessionQueueDepthMax, M.sessionQueueDepthAvg]),
    metricWidget(16, 87, 8, 6, 'Queue BACKLOG (>=200) / REJECTED / NO IMAGE — all alarmed, want 0', [M.sessionQueueBacklog, M.sessionQueueRejected, M.imagePointerMissing]),
    // A spec change (image, EFS root, an env var) rolls agents LAZILY at ~30s of provisioning each, so
    // one dispatcher env edit rolls the whole fleet across their next turns. Spikes here are what turn
    // "everything felt slow for a while" into an answer; the EMF `reason` property says which field.
    metricWidget(0, 125, 12, 6, 'Runtime generation rolls (fleet) — an immutable spec field changed', [M.runtimeGenerationRolls]),
    // Row 15 — CRON (M4, namespace ClawdbotCron). Answers the questions the 2026-08-09 cron
    // investigation had to answer by exec'ing into the dispatcher and grepping logs: what is
    // configured across channels/DMs, which jobs are INVALID at rest, and when do they next run.
    // MISCONFIGURED is first because it is the only at-rest signal — a job with no delivery block
    // fires forever and posts nothing, and never appears in CronDeliveryFailure (it never tries).
    metricWidget(0, 93, 8, 6, 'Cron jobs MISCONFIGURED (by reason) — should be 0', [M.cronJobsMisconfigured]),
    metricWidget(8, 93, 8, 6, 'Cron jobs by channel + mode (none+announce = broken)', [M.cronJobsByChannelMode]),
    metricWidget(16, 93, 8, 6, 'Cron failures — delivery / failureAlert (fleet)', [M.cronDeliveryFailure, M.cronFailureAlert]),
    logWidget(0, 99, 24, 7, 'Cron MISCONFIGURED — agent / job / channel / mode / status / schedule (fix these)', Q.INSIGHTS.cron_misconfigured),
    logWidget(0, 106, 24, 7, 'Cron inventory — every configured job: channel/DM, mode, status, schedule, next run', Q.INSIGHTS.cron_inventory),
    logWidget(0, 113, 12, 6, 'Cron delivery failures — agent / job / mode / channel / error', Q.INSIGHTS.cron_delivery_failures),
    logWidget(12, 113, 12, 6, 'Cron fires vs delivery failures (1h bins)', Q.INSIGHTS.cron_fires_vs_failures, 'timeSeries'),
    // Row 16 — cron lifecycle: requested removals (a deletion previously left no trace at all).
    logWidget(0, 119, 16, 6, 'Cron REMOVALS — what was deleted, when (agent / job / schedule / target)', Q.INSIGHTS.cron_removals),
    metricWidget(16, 119, 8, 6, 'Cron job removals (fleet)', [M.cronJobRemoved]),
    // Row 18 — MESSAGE VOLUME. Counted in DynamoDB since July, but its only reader is the
    // ALB-fronted `archie` service, which is scaled to 0 — so volume was invisible while the table
    // kept filling. Reads messages RECEIVED and routed, not replies delivered: pair it with the turn
    // errors widget above. The per-user cut lives in the log widget, because a user DIMENSION would
    // be thousands of custom metrics (the DynamoDB table keeps the durable user×agent×day history).
    metricWidget(0, 131, 12, 6, 'Messages received — per agent (Sum, 5m)', [M.messagesReceived]),
    metricWidget(12, 131, 12, 6, 'Messages received — fleet total (Sum, 5m)', [M.messagesReceivedFleet]),
    logWidget(0, 137, 24, 6, 'WHO is talking to which agent — messages by user × agent (userId is an EMF property, not a dimension)', Q.INSIGHTS.messages_by_user),
    // Row 19 — CONNECTOR POSTURE. The left widget is a migration progress bar, not a fault board: an
    // agent on the shared key WORKS (prod's shared project holds real connected accounts), it simply
    // shares that project — and every connection in it — with every other agent on the same key.
    // Each agent that disappears from this series has been given a project of its own; the remaining
    // series IS the worklist. The right widget is the genuinely-broken case (no key resolved at all)
    // and is the one with an alarm behind it.
    metricWidget(0, 143, 12, 6, 'Connector — boots on the SHARED key (per agent): migration worklist, want 0', [M.connectorSharedKey]),
    metricWidget(12, 143, 12, 6, 'Connector — boots with NO key at all (per agent): ALARMED, always 0', [M.connectorUnprovisioned]),
    // Row 19b — the DISPATCHER side of the same story (phase 3). PROVISIONED rising while
    // ConnectorSharedKey above falls IS the migration burn-down, read across the two widgets.
    // BLOCKED is a worklist and does not alarm: the project exists and cannot be keyed by API, so a
    // human must mint one in the console. Latency is here to CHECK the "it's free because it runs in
    // parallel" claim against the provision-phase widget rather than take it on trust.
    metricWidget(0, 149, 8, 6, 'Connector provisioned vs BLOCKED (blocked = needs a console key)', [M.connectorProvisioned, M.connectorBlocked]),
    metricWidget(8, 149, 8, 6, 'Connector provision FAILED (alarmed — API/secrets broken, not merely refusing)', [M.connectorProvisionFailed]),
    metricWidget(16, 149, 8, 6, 'Connector provision max (ms) — free only while under the parallel phase', [M.connectorProvisionMs]),
    // Row 22 — CRON CUTOVER (§3a'). The one board question the cron rows above cannot answer:
    // those describe jobs archie HOLDS, and during the migration most of them are fired by OpenClaw,
    // not here. A gated tick writes nothing to the store, so without these two widgets "archie is
    // correctly holding back" and "archie has silently stopped scheduling" look identical.
    metricWidget(0, 155, 8, 6, 'Cron fires DECLINED per agent — scope still on OpenClaw (§3a\')', [M.cronFireGated]),
    logWidget(8, 155, 16, 6, 'Cron cutover — which scopes archie is declining to fire, and why', Q.INSIGHTS.cron_gated),
    // Row 23 — ACCOUNT QUOTA. The fleet consumes `agents x live image tags` AgentCore runtimes
    // against a 1,000 account cap, and a roll stages the next tag before collecting the last — so the
    // ceiling is hit DURING a release, where the symptom is CreateAgentRuntime refusing partway
    // through and the unstaged agents serving nothing. Nothing in AWS publishes this: resource-count
    // quotas in bedrock-agentcore have no AWS/Usage metric, so the dispatcher counts it itself.
    metricWidget(0, 161, 12, 6, 'AgentCore runtimes vs account quota (alarmed at 900 of 1,000)', [M.agentRuntimeCount, M.agentRuntimeQuota]),
    metricWidget(12, 161, 12, 6, 'Runtimes by status — DELETING holds its quota slot for ~5 min', [M.agentRuntimeByStatus]),
    // Row 24 — PROMPT CACHE, cut BY MODEL (the metric widgets in row 7b are cut by agent, which is
    // the wrong axis for the failure this catches). pi-ai gates Bedrock cache points on a hard-coded
    // model list, so moving the fleet to a model it does not know silently stops caching while every
    // turn keeps succeeding — exactly what the Sonnet 5 default did on 2026-08-15 (92% hit rate the
    // day before, 0% after, discovered three weeks later). Appended rather than slotted next to row
    // 7b because inserting a row here renumbers every widget below it.
    logWidget(0, 167, 24, 6, 'Prompt cache by MODEL × hit/miss — cached vs written vs uncached tokens, cached share, cost (no cache tokens at all = the gate is shut; writes with no reads = unstable prefix)', Q.INSIGHTS.prompt_cache_effect),
  ],
};

// A check that cannot RUN is not a check that passed, so every failure is collected here and
// printed with the rest — a missing cloudwatch:ListMetrics / logs:DescribeLogGroups / ecs:Describe*
// must not read as a clean bill of health.
const checkErrors = [];

/**
 * Post-deploy checks: is this dashboard pointed at the stack it claims to be?
 *
 * Three checks, in increasing order of how much they actually prove — all WARNINGS, never
 * failures, because every one of them has a legitimate quiet case (a brand-new environment, a
 * genuinely silent log group, no ECS read permission).
 *
 * 1. EMPTINESS (namespaces, log groups). A SEARCH() over an empty namespace and a log widget over
 *    a non-existent group both render an EMPTY GRAPH, indistinguishable from a quiet fleet.
 * 2. EXISTENCE (log groups). A misspelled group is silently blank forever; a real one at least
 *    shows up here.
 * 3. AGREEMENT WITH THE DEPLOYED DISPATCHER — the only check with teeth. Emptiness would NOT have
 *    caught the bugs this file has actually had: `ClawdbotDispatcher`, `ClawdbotCron` and
 *    `/ecs/agent-4ggvzl-dispatcher` are all REAL and POPULATED (the OpenClaw baseline
 *    stack still runs in this account), so pointing the archie board at them rendered ANOTHER
 *    STACK'S FLEET as if it were archie's — plausible, non-empty and wrong. The ground truth is
 *    the running dispatcher's task definition, which Terraform sets from `${var.name}`, so that is
 *    what the resolved values are compared against.
 *
 * Whatever happens, the resolved targets are PRINTED. Half of the value here is that a human sees
 * which stack the board was built for without having to read the source.
 */
async function checkNamespaces(cw) {
  const { ListMetricsCommand } = require('@aws-sdk/client-cloudwatch');
  const namespaces = [...new Set(
    JSON.stringify(body).match(/(?:Namespace=")([^"]+)|SEARCH\('\{([^,}]+)/g)
      ?.map((m) => m.replace(/^SEARCH\('\{/, '').replace(/^Namespace="/, '').replace(/[",]$/, ''))
      .filter((n) => n && !n.startsWith('AWS/')) || [],
  )];
  const empty = [];
  for (const ns of namespaces) {
    try {
      const r = await cw.send(new ListMetricsCommand({ Namespace: ns }));
      if (!r.Metrics || r.Metrics.length === 0) empty.push(ns);
    } catch (e) {
      // Not fatal — a listing failure is not worth failing a deploy over — but not silent either.
      checkErrors.push(`ListMetrics ${ns}: ${e.name || e.message}`);
    }
  }
  return { namespaces, empty };
}

// Log groups are named inside each log widget's `SOURCE 'a' 'b' | ...` query, so they are read back
// out of the built body rather than from the library — this checks what was actually DEPLOYED.
async function checkLogGroups() {
  const { CloudWatchLogsClient, DescribeLogGroupsCommand } = require('@aws-sdk/client-cloudwatch-logs');
  const logs = new CloudWatchLogsClient({ region: Q.REGION });
  const groups = [...new Set(
    body.widgets
      .filter((w) => w.type === 'log' && typeof w.properties?.query === 'string')
      .flatMap((w) => (w.properties.query.match(/^SOURCE ((?:'[^']+' ?)+)/)?.[1] || '').match(/'([^']+)'/g) || [])
      .map((g) => g.replace(/'/g, '')),
  )];
  const missing = []; const emptyGroups = [];
  for (const g of groups) {
    try {
      const r = await logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: g }));
      const hit = (r.logGroups || []).find((lg) => lg.logGroupName === g);
      if (!hit) missing.push(g);
      else if (!hit.storedBytes) emptyGroups.push(g);
    } catch (e) {
      checkErrors.push(`DescribeLogGroups ${g}: ${e.name || e.message}`);
    }
  }
  return { groups, missing, emptyGroups };
}

// The running dispatcher's task definition is the ground truth for all three stack-shaped values;
// Terraform sets them from `${var.name}`. Cluster and service are `${STACK}` / `${STACK}-dispatcher`,
// so the whole check follows the same knob as the values it is checking.
async function checkAgainstDispatcher() {
  const { ECSClient, DescribeServicesCommand, DescribeTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
  const ecs = new ECSClient({ region: Q.REGION });
  const service = `${Q.STACK}-dispatcher`;
  try {
    const svc = await ecs.send(new DescribeServicesCommand({ cluster: Q.STACK, services: [service] }));
    const taskDefinition = svc.services?.[0]?.taskDefinition;
    if (!taskDefinition) return { checked: false, reason: `no ECS service ${Q.STACK}/${service}` };
    const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition }));
    const env = Object.fromEntries(
      (td.taskDefinition?.containerDefinitions || []).flatMap((c) => c.environment || []).map((e) => [e.name, e.value]),
    );
    const expect = {
      DISPATCHER_LOG_GROUP: Q.DISPATCHER_LG,
      DISPATCHER_METRIC_NAMESPACE: Q.DISPATCHER_NS,
      CRON_METRIC_NAMESPACE: Q.CRON_NS,
    };
    const mismatches = Object.entries(expect)
      .filter(([k, v]) => env[k] && env[k] !== v)
      .map(([k, v]) => ({ key: k, dashboard: v, deployed: env[k] }));
    return { checked: true, taskDefinition, mismatches };
  } catch (e) {
    return { checked: false, reason: e.name || String(e) };
  }
}

(async () => {
  const cw = new CloudWatchClient({ region: Q.REGION });
  const out = await cw.send(new PutDashboardCommand({
    DashboardName: NAME, DashboardBody: JSON.stringify(body),
  }));
  const warnings = out.DashboardValidationMessages || [];
  const ns = await checkNamespaces(cw);
  const lg = await checkLogGroups();
  const td = await checkAgainstDispatcher();
  console.log(JSON.stringify({
    dashboard: NAME, region: Q.REGION, widgets: body.widgets.length, warnings,
    // Which stack this board was built for — printed every time, not only on failure.
    resolved: {
      stack: Q.STACK, dispatcherLogGroup: Q.DISPATCHER_LG, dispatcherNamespace: Q.DISPATCHER_NS, cronNamespace: Q.CRON_NS,
    },
    namespaces: ns.namespaces,
    // The line that would have caught the archie blank-dashboard bug on the day it was introduced.
    emptyNamespaces: ns.empty,
    logGroups: lg.groups,
    missingLogGroups: lg.missing,
    emptyLogGroups: lg.emptyGroups,
    // ...and the line that would have caught the WRONG-BUT-POPULATED variant of it.
    dispatcherTaskDefinition: td.checked ? td.taskDefinition : `not checked (${td.reason})`,
    stackMismatches: td.mismatches || [],
    // Checks that could not run at all (permissions, throttles) — not the same as checks that passed.
    checkErrors,
  }, null, 2));
  if (ns.empty.length) {
    console.error(`\nWARNING: ${ns.empty.length} namespace(s) contain NO metrics, so their widgets will render blank:`);
    for (const n of ns.empty) console.error(`  - ${n}`);
    console.error('If this is not a new environment, the namespace is probably wrong — set');
    console.error('DISPATCHER_METRIC_NAMESPACE / CRON_METRIC_NAMESPACE to match `${var.name}Dispatcher` / `${var.name}Cron`.');
  }
  if (lg.missing.length) {
    console.error(`\nWARNING: ${lg.missing.length} log group(s) DO NOT EXIST, so their widgets will render blank:`);
    for (const g of lg.missing) console.error(`  - ${g}`);
    console.error('Set DISPATCHER_LOG_GROUP (or ARCHIE_STACK) to match `/ecs/${var.name}-dispatcher`.');
  }
  if (lg.emptyGroups.length) {
    console.error(`\nNOTE: ${lg.emptyGroups.length} log group(s) exist but have never been written to: ${lg.emptyGroups.join(', ')}`);
  }
  if (td.mismatches?.length) {
    console.error('\nWARNING: this dashboard disagrees with the DEPLOYED dispatcher — it is pointed at another stack.');
    console.error('The other stack\'s log group and namespaces are real and populated, so the board will look');
    console.error('plausible and be wrong. Unset the overrides, or set ARCHIE_STACK to the stack you meant:');
    for (const m of td.mismatches) console.error(`  - ${m.key}: dashboard=${m.dashboard} deployed=${m.deployed}`);
  }
})().catch((e) => { console.error('deploy-dashboard failed:', e.message); process.exit(1); });

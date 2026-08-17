// OTEL self-observability tools — the agent querying its OWN telemetry (the same signals the
// agentcore-fleet dashboard is built from). The query/metric corpus is NOT redefined here: it's
// loaded from the single source of truth, agentcore-observability/insight-queries.js (also consumed
// by the dashboard builder + BDD suite), so the tools, the dashboard, and the tests can never drift.
//
// Transport is native Pi tools over the AWS SDK (not an MCP server): there is no MCP client in the
// Pi image, and the awslabs cloudwatch-mcp-server this replaces is itself only a wrapper over these
// same Logs Insights + GetMetricData APIs. Credentials come from the default chain = the runtime's
// container role (needs the read grant in observability-iam.cjs).
//
// ── TWO TIERS (2026-08-11) ────────────────────────────────────────────────────────────────────
// This module used to be three fleet-wide tools on the baseline `otel` capability, i.e. every agent
// could read every other agent's telemetry, and `otel_query` accepted a free-form query + arbitrary
// logGroups — so any agent could run any Logs Insights query over any log group the runtime role
// could reach. IAM cannot narrow that: `aws/spans` is ONE account-wide Transaction Search store and
// the dispatcher log is ONE fleet log (Logs Insights authorizes StartQuery per LOG GROUP, with no
// row-level condition key), and cloudwatch:GetMetricData supports no resource-level permissions at
// all. The boundary therefore has to be drawn here, in the tool:
//
//   otel_my_*      capability `otel`        BASELINE (every agent). Scope-pinned: every query
//                                          filters on this agent's own identity before stats, and
//                                          the metric SEARCHes are pinned to its own Agent
//                                          dimension. No parameter can widen them.
//   otel_fleet_*   capability `otel.fleet`  GRANTED (default-deny via '*'). The unscoped corpus
//                                          plus the ad-hoc query/logGroups escape hatch.
//
// Fail-closed on identity: if AGENT_NAME is missing or is not a safe query literal, the scoped tools
// return an error rather than running an unscoped query.
//
// Read-only throughout; disable the whole surface with OTEL_TOOLS_DISABLED=1.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { piAi } from './pi-runtime.mjs';
import {
  CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand,
  DescribeLogGroupsCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient, GetMetricDataCommand } from '@aws-sdk/client-cloudwatch';

const T = piAi.Type;
const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load the shared corpus. In the image it's COPYed next to this file as .cjs (the source is
// CommonJS but /app is "type":"module", so a .js would be parsed as ESM and throw); in the repo
// it lives one dir over in agentcore-observability/ as .js (that dir is not type:module). Env wins.
function loadCorpus() {
  const candidates = [
    process.env.OTEL_QUERIES_PATH,
    path.join(HERE, 'insight-queries.cjs'),
    path.join(HERE, '..', 'agentcore-observability', 'insight-queries.js'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return require(p);
  }
  throw new Error(`insight-queries.js not found (tried: ${candidates.join(', ')})`);
}

const {
  REGION, SPANS_LG, INSIGHTS, METRICS, SELF_HEALTH_METRICS, DISPATCHER_SERVICE, SLACK_TRIGGERS,
  assertSafeScopeLiteral, runtimeLogGroupPrefix, runtimeLogGroupMatcher,
  runtimeNameFromArn, parseRuntimeName,
  scopedTurnsQuery, scopedMessagesQuery, scopedToolsQuery, scopedDenialsQuery, scopedRuntimeErrorsQuery,
  scopedTraceQuery, scopedCronInventoryQuery, scopedCronFailuresQuery, scopedDispatcherQuery,
  scopedGenerationsQuery, scopedMetricExpr,
} = loadCorpus();

// Lazy singletons — constructing an AWS client is cheap but pointless if the tool is never used.
let _logs = null;
let _cw = null;
const logs = () => (_logs ||= new CloudWatchLogsClient({ region: REGION }));
const cw = () => (_cw ||= new CloudWatchClient({ region: REGION }));

const INSIGHTS_NAMES = Object.keys(INSIGHTS);
const METRIC_NAMES = Object.keys(METRICS);

// THIS agent's identity — the scope every otel_my_* query is pinned to. Read at call time (not
// module load) so a test can set it, and validated every time: an AGENT_NAME that isn't a safe
// query literal must stop the query being built, never silently widen it.
function ownAgentId() {
  const raw = process.env.AGENT_NAME || '';
  if (!raw) throw new Error('AGENT_NAME is not set — cannot scope a query to this agent');
  return assertSafeScopeLiteral(raw, 'AGENT_NAME');
}

// "15m" / "3h" / "2d" / "90s" → milliseconds. Default unit = hours for a bare number.
export function sinceToMs(since, fallbackMs) {
  if (since == null || since === '') return fallbackMs;
  const m = String(since).trim().match(/^(\d+(?:\.\d+)?)\s*([smhd]?)$/i);
  if (!m) return fallbackMs;
  const n = Number(m[1]);
  const unit = (m[2] || 'h').toLowerCase();
  const mult = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[unit];
  return Math.round(n * mult);
}

const asText = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], details: payload });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const timeWindow = (since, fallbackMs) => {
  const endMs = Date.now();
  return { startMs: endMs - sinceToMs(since, fallbackMs), endMs };
};

// Run a Logs Insights query to completion (bounded poll) and return rows as plain objects.
async function runInsights({ logGroups, query, startMs, endMs, limit }) {
  const start = await logs().send(new StartQueryCommand({
    logGroupNames: logGroups,
    startTime: Math.floor(startMs / 1000),
    endTime: Math.floor(endMs / 1000),
    queryString: query,
    limit: limit || undefined,
  }));
  const queryId = start.queryId;
  const deadline = Date.now() + 55_000; // Insights is async; cap the wait well under a turn budget.
  try {
    for (;;) {
      const res = await logs().send(new GetQueryResultsCommand({ queryId }));
      const status = res.status;
      if (status === 'Complete') {
        const rows = (res.results || []).map((row) => {
          const o = {};
          for (const { field, value } of row) if (field !== '@ptr') o[field] = value;
          return o;
        });
        return { status, rows, statistics: res.statistics };
      }
      if (status === 'Failed' || status === 'Cancelled' || status === 'Timeout') {
        return { status, rows: [], error: `query ${status}` };
      }
      if (Date.now() > deadline) {
        try { await logs().send(new StopQueryCommand({ queryId })); } catch { /* best effort */ }
        return { status: 'Timeout', rows: [], error: 'poll deadline exceeded (55s)' };
      }
      await sleep(1200);
    }
  } catch (err) {
    return { status: 'Error', rows: [], error: String(err?.message || err) };
  }
}

// Same, but tolerant: a scoped tool runs several queries and one failing source (e.g. no runtime log
// group yet on a first boot) must degrade to a note rather than fail the whole answer.
async function tryInsights(spec) {
  try {
    return await runInsights(spec);
  } catch (err) {
    return { status: 'Error', rows: [], error: String(err?.message || err) };
  }
}

// ── own-runtime log groups ─────────────────────────────────────────────────────────────────────
// This agent's runtime log group(s) — /aws/bedrock-agentcore/runtimes/oc_<agent>_<fp>-<id>-DEFAULT,
// one per runtime GENERATION (a new image/spec mints a new runtime, hence a new group). Inherently
// per-agent, and the only place this runtime's own stdout lives: the PEP's permission_decision
// records, cold-boot/turn EMF, and its own errors. Resolved by prefix (StartQuery takes NAMES, not
// prefixes) and then confirmed against the separator-anchored matcher, because a bare prefix would
// also match a longer agent id starting with this one. Newest generations first, capped at the
// StartQuery limit of 50. Cached briefly: the set only changes on a generation roll.
let _lgCache = { at: 0, agent: null, groups: [] };
async function ownRuntimeLogGroups(agentId) {
  if (_lgCache.agent === agentId && Date.now() - _lgCache.at < 5 * 60_000) return _lgCache.groups;
  const matches = runtimeLogGroupMatcher(agentId);
  const found = [];
  let nextToken;
  do {
    // eslint-disable-next-line no-await-in-loop
    const res = await logs().send(new DescribeLogGroupsCommand({
      logGroupNamePrefix: runtimeLogGroupPrefix(agentId), nextToken, limit: 50,
    }));
    for (const g of res.logGroups || []) {
      if (g.logGroupName && matches.test(g.logGroupName)) found.push({ name: g.logGroupName, createdAt: g.creationTime || 0 });
    }
    nextToken = res.nextToken;
  } while (nextToken && found.length < 200);
  const groups = found.sort((a, b) => b.createdAt - a.createdAt).slice(0, 50).map((g) => g.name);
  _lgCache = { at: Date.now(), agent: agentId, groups };
  return groups;
}

// ── metrics ────────────────────────────────────────────────────────────────────────────────────
export function summarizeSeries(r) {
  const values = r.Values || [];
  const n = values.length;
  if (!n) return { label: r.Label, id: r.Id, statusCode: r.StatusCode, points: 0 };
  const sum = values.reduce((s, v) => s + v, 0);
  return {
    label: r.Label,
    id: r.Id,
    statusCode: r.StatusCode,
    points: n,
    latest: values[0], // GetMetricData returns TimestampDescending → [0] is newest
    min: Math.min(...values),
    max: Math.max(...values),
    avg: sum / n,
    sum,
  };
}

// One GetMetricData call for many named metrics. `specs` = [{ id, name, expr, label }]. Results are
// keyed back by Id, not Label: a SEARCH resolves its own per-series labels, and the SUM(SEARCH(…))
// metrics come back labelled with the raw query id — so Id is the only reliable join. Label is still
// passed for human readability of the series.
async function runMetrics(specs, startMs, endMs) {
  const res = await cw().send(new GetMetricDataCommand({
    MetricDataQueries: specs.map((s) => ({ Id: s.id, Expression: s.expr, Label: s.label, ReturnData: true })),
    StartTime: new Date(startMs),
    EndTime: new Date(endMs),
    ScanBy: 'TimestampDescending',
  }));
  const byId = {};
  for (const r of res.MetricDataResults || []) (byId[r.Id] ||= []).push(summarizeSeries(r));
  const out = {};
  for (const s of specs) out[s.name] = (byId[s.id] || []).filter((x) => x.points > 0);
  return { metrics: out, messages: (res.Messages || []).map((m) => m.Value) };
}

// Numeric helpers for the JS-side rollups the scoped tools add (the corpus stays declarative).
const nums = (rows, field) => rows.map((r) => Number(r[field])).filter((n) => Number.isFinite(n));
const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null);
function rollup(rows, field) {
  const v = nums(rows, field).sort((a, b) => a - b);
  if (!v.length) return null;
  return { n: v.length, min: v[0], p50: pct(v, 50), p90: pct(v, 90), max: v[v.length - 1], sum: v.reduce((s, x) => s + x, 0) };
}

// Split turns by what triggered them. Load-bearing for the inbound-vs-ran comparison below: only the
// SLACK_TRIGGERS turns have a matching MessagesReceivedCount record, so lumping cron fires in with
// them would mask real drops (a busy cron makes the shortfall vanish) — or invent them.
// An ABSENT trigger counts as unknown, not as a message: pre-2026-08-11 spans have no trigger
// attribute at all, and defaulting those to `message` would fabricate a shortfall on any window that
// straddles the roll.
export function classifyTurns(rows) {
  const byTrigger = {};
  for (const r of rows) {
    const t = r.trigger || 'unknown';
    byTrigger[t] = (byTrigger[t] || 0) + 1;
  }
  const slackTurns = SLACK_TRIGGERS.reduce((n, t) => n + (byTrigger[t] || 0), 0);
  const cronTurns = byTrigger.cron || 0;
  return { byTrigger, slackTurns, cronTurns, otherTurns: rows.length - slackTurns - cronTurns };
}

// A scoped tool's uniform failure envelope — an identity problem must read as a refusal to widen,
// not as an empty result set (which would look like "you had no turns").
const scopedError = (tool, err) => asText({ tool, scope: null, error: String(err?.message || err), note: 'scoped tools require a valid AGENT_NAME; they never fall back to a fleet-wide read' });

// ══ TIER 1 — scope-pinned, baseline `otel` ═════════════════════════════════════════════════════

function createMyTurns() {
  return {
    name: 'otel_my_turns',
    label: 'otel_my_turns',
    capability: 'otel',
    description:
      'YOUR OWN recent turns (read-only). One row per model turn — session, model, input/output '
      + 'tokens, finish reason, outcome (reply/empty/error), what triggered it, duration, and the '
      + 'traceId to pass to otel_my_trace — plus a latency/token rollup AND how many inbound Slack '
      + 'messages you were sent over the same window, so a turn you never ran is visible. Use for '
      + '"am I slow / expensive / erroring", "which turn was the worst", and "did I miss a message". '
      + 'byUser=true adds who messaged you and through which surface (message vs @mention). '
      + 'withDispatcher=true adds the dispatcher\'s own log lines for you (which show turns that '
      + 'never reached the runtime). since = lookback like "1h","30m","24h" (default 3h). '
      + 'Other agents are not visible.',
    parameters: T.Object({
      since: T.Optional(T.String()),
      withDispatcher: T.Optional(T.Boolean()),
      byUser: T.Optional(T.Boolean()),
    }),
    async execute(_id, params = {}) {
      let agent;
      try { agent = ownAgentId(); } catch (e) { return scopedError('otel_my_turns', e); }
      const { startMs, endMs } = timeWindow(params.since, 3 * 36e5);
      const [turns, dispatcher, senders] = await Promise.all([
        tryInsights({ ...scopedTurnsQuery(agent), startMs, endMs }),
        params.withDispatcher ? tryInsights({ ...scopedDispatcherQuery(agent), startMs, endMs }) : null,
        params.byUser ? tryInsights({ ...scopedMessagesQuery(agent), startMs, endMs }) : null,
      ]);
      const errors = turns.rows.filter((r) => r.status === 'ERROR').length;
      const { byTrigger, slackTurns, cronTurns, otherTurns } = classifyTurns(turns.rows);

      // INBOUND vs RAN. MessagesReceivedCount fires once per routed inbound message, BEFORE the turn
      // is enqueued; the spans above only exist for turns that actually ran. The difference is
      // therefore the messages that reached the dispatcher and produced no turn — queue rejection,
      // enqueue failure, or an invoke that died before the runtime span. Nothing else surfaces that
      // today: the user says "you ignored me" and the agent has no signal at all.
      // NO SERIES ≠ ZERO MESSAGES. runMetrics drops empty series, so an unresolved metric and a
      // genuinely idle agent both arrive as []. Treating that as 0 is not a rounding error, it
      // INVERTS the signal: it reports every turn you ran as a message you never received (live:
      // messagesWithoutTurn -5 while the counter held 2). A brand-new metric name also takes ~15
      // minutes to appear in SEARCH() even though GetMetricStatistics already returns it, so the
      // unresolved case is guaranteed to happen on rollout. Report unknown and say so.
      let messagesReceived = null;
      let messagesNote = null;
      try {
        const expr = scopedMetricExpr('messagesReceived', agent);
        if (!expr) {
          messagesNote = 'messagesReceived is not Agent-dimensioned in this corpus — inbound comparison unavailable';
        } else {
          const { metrics } = await runMetrics([{ id: 'm0', name: 'messagesReceived', expr, label: 'Messages received (this agent)' }], startMs, endMs);
          const series = metrics.messagesReceived || [];
          if (series.length) messagesReceived = series.reduce((n, s) => n + (s.sum || 0), 0);
          else messagesNote = 'no MessagesReceivedCount series resolved for this window — either genuinely no inbound messages, or the metric has not yet been indexed for search (new metric names take ~15 min). NOT interpreted as zero.';
        }
      } catch (e) {
        messagesNote = `inbound-message metric read failed: ${String(e?.message || e)}`;
      }

      return asText({
        tool: 'otel_my_turns',
        scope: agent,
        since: params.since || '3h',
        region: REGION,
        status: turns.status,
        turnCount: turns.rows.length,
        turnsByTrigger: byTrigger,
        errorTurns: errors,
        messageTriggeredTurns: slackTurns,
        ...(messagesNote ? { messagesReceived: null, messagesNote } : {}),
        // The two directions of (inbound − ran) are NOT one signed quantity: they have different
        // causes and only one is a fault, so they are reported as different fields. Collapsing them
        // invites reading a benign negative as "phantom messages" (live: -4, purely because the
        // window predated the counter's deployment).
        ...(messagesReceived != null ? {
          messagesReceived,
          ...(messagesReceived > slackTurns ? {
            messagesWithoutTurn: messagesReceived - slackTurns,
            messagesWithoutTurnNote: 'inbound messages that produced NO turn — the real fault signal. 1-2 is window-edge noise (the stores have separate clocks); more, or sustained, means turns were dropped: check sessionQueueRejected, enqueue failures and dispatcher errors (otel_my_turns withDispatcher=true).',
          } : {}),
          ...(slackTurns > messagesReceived ? {
            turnsWithoutCountedMessage: slackTurns - messagesReceived,
            turnsWithoutCountedMessageNote: 'message-triggered turns with no counted inbound message. Normally BENIGN: the window predates the MessagesReceivedCount counter (deployed 2026-08-11), or a turn landed inside the window while its message fell just outside. Not a dropped-turn signal.',
          } : {}),
        } : {}),
        cronTurns,
        ...(otherTurns ? { otherTurns } : {}),
        latencyMs: rollup(turns.rows, 'duration_ms'),
        inputTokens: rollup(turns.rows, 'in_tokens'),
        outputTokens: rollup(turns.rows, 'out_tokens'),
        turns: turns.rows,
        ...(senders ? { senders: senders.rows, sendersStatus: senders.status } : {}),
        ...(dispatcher ? { dispatcherLog: dispatcher.rows, dispatcherStatus: dispatcher.status } : {}),
        ...(turns.error ? { error: turns.error } : {}),
      });
    },
  };
}

function createMyTools() {
  return {
    name: 'otel_my_tools',
    label: 'otel_my_tools',
    capability: 'otel',
    description:
      'YOUR OWN tool calls (read-only): per-tool call count, avg/max duration and span status from '
      + 'your execute_tool spans, PLUS your permission DENIALS (which tool, and the capability that '
      + 'would need granting) from your own runtime log. Use for "which tool is slow or failing for '
      + 'me" and "why was that tool refused". since = lookback (default 3h).',
    parameters: T.Object({ since: T.Optional(T.String()) }),
    async execute(_id, params = {}) {
      let agent;
      try { agent = ownAgentId(); } catch (e) { return scopedError('otel_my_tools', e); }
      const { startMs, endMs } = timeWindow(params.since, 3 * 36e5);
      const spans = await tryInsights({ ...scopedToolsQuery(agent), startMs, endMs });
      let denials = { status: 'Skipped', rows: [], error: undefined };
      try {
        const groups = await ownRuntimeLogGroups(agent);
        denials = groups.length
          ? await tryInsights({ ...scopedDenialsQuery(), logGroups: groups, startMs, endMs })
          : { status: 'NoLogGroups', rows: [], error: 'no runtime log group found for this agent yet' };
      } catch (e) {
        denials = { status: 'Error', rows: [], error: String(e?.message || e) };
      }
      return asText({
        tool: 'otel_my_tools',
        scope: agent,
        since: params.since || '3h',
        region: REGION,
        status: spans.status,
        tools: spans.rows,
        denials: denials.rows,
        denialsStatus: denials.status,
        ...(denials.error ? { denialsNote: denials.error } : {}),
        ...(spans.error ? { error: spans.error } : {}),
      });
    },
  };
}

// Ownership gate for a trace. Returns { owned, mine, foreign } over the fetched spans: a span is
// THIS agent's if its service.name is the agent (runtime spans) or its dispatcher.agent is the
// agent (dispatcher request/invoke spans); dispatcher spans with NO agent attribution are the
// provisioning internals of whatever request they belong to, so they ride along with an owned trace
// (dropping them would hide exactly the provisioning legs that explain a slow turn). A span naming a
// DIFFERENT agent is dropped — a fan-out trace must not leak the other participant.
export function partitionTraceSpans(rows, agent, dispatcherService = DISPATCHER_SERVICE) {
  const mine = [];
  let foreign = 0;
  let owned = false;
  for (const r of rows) {
    const svc = r.svc || '';
    const dAgent = r.dispatcher_agent || '';
    if (svc === agent || dAgent === agent) { owned = true; mine.push(r); continue; }
    if (!dAgent && svc === dispatcherService) { mine.push(r); continue; }
    foreign += 1;
  }
  return { owned, mine: owned ? mine : [], foreign };
}

function createMyTrace() {
  return {
    name: 'otel_my_trace',
    label: 'otel_my_trace',
    capability: 'otel',
    description:
      'Reconstruct ONE OF YOUR OWN turns end-to-end by traceId (read-only): every span from the '
      + 'dispatcher request → queue → provisioning → invoke → your runtime turn → its model/tool '
      + 'children, with duration, model, tokens, tool and status. Answers "where did that turn\'s '
      + 'time and tokens go". Get traceIds from otel_my_turns. A traceId that is not yours returns '
      + 'not_found. since = lookback (default 6h).',
    parameters: T.Object({ traceId: T.String(), since: T.Optional(T.String()) }),
    async execute(_id, params = {}) {
      let agent;
      try { agent = ownAgentId(); } catch (e) { return scopedError('otel_my_trace', e); }
      let spec;
      try { spec = scopedTraceQuery(String(params.traceId || '').trim()); } catch (e) {
        return asText({ tool: 'otel_my_trace', error: String(e?.message || e), got: params.traceId });
      }
      const { startMs, endMs } = timeWindow(params.since, 6 * 36e5);
      const out = await tryInsights({ ...spec, startMs, endMs });
      const { owned, mine, foreign } = partitionTraceSpans(out.rows, agent);
      if (!owned) {
        return asText({
          tool: 'otel_my_trace', scope: agent, traceId: params.traceId, status: out.status,
          result: 'not_found', note: 'no span in this trace belongs to you (it is another agent\'s trace, outside the window, or the id is wrong)',
        });
      }
      return asText({
        tool: 'otel_my_trace',
        scope: agent,
        traceId: params.traceId,
        since: params.since || '6h',
        region: REGION,
        status: out.status,
        spanCount: mine.length,
        ...(foreign ? { foreignSpansDropped: foreign } : {}),
        spans: mine,
        ...(out.error ? { error: out.error } : {}),
      });
    },
  };
}

function createMyCrons() {
  return {
    name: 'otel_my_crons',
    label: 'otel_my_crons',
    capability: 'otel',
    description:
      'YOUR OWN scheduled jobs (read-only): what is configured right now — schedule, timezone, next '
      + 'and last run, delivery target/channel/mode, and whether each job is VALID (delivery_status '
      + '!= ok is a misconfiguration, e.g. an announce job with no channel) — plus your recent '
      + 'delivery failures and removals. Use for "what am I scheduled to do", "why did my cron not '
      + 'post", "which of my jobs is broken". A live job\'s record_at is under 16 minutes old; older '
      + 'means the job is gone. Optional channel narrows to one destination. since = lookback '
      + '(default 24h; records are re-emitted every 15 min, so do not go below 1h).',
    parameters: T.Object({ since: T.Optional(T.String()), channel: T.Optional(T.String()) }),
    async execute(_id, params = {}) {
      let agent;
      try { agent = ownAgentId(); } catch (e) { return scopedError('otel_my_crons', e); }
      let inventorySpec;
      try { inventorySpec = scopedCronInventoryQuery(agent, params.channel ? String(params.channel).trim() : null); } catch (e) {
        return asText({ tool: 'otel_my_crons', scope: agent, error: String(e?.message || e) });
      }
      const { startMs, endMs } = timeWindow(params.since, 24 * 36e5);
      const [inventory, failures] = await Promise.all([
        tryInsights({ ...inventorySpec, startMs, endMs }),
        tryInsights({ ...scopedCronFailuresQuery(agent), startMs, endMs }),
      ]);
      const misconfigured = inventory.rows.filter((r) => r.delivery_status && r.delivery_status !== 'ok');
      return asText({
        tool: 'otel_my_crons',
        scope: agent,
        ...(params.channel ? { channel: params.channel } : {}),
        since: params.since || '24h',
        region: REGION,
        status: inventory.status,
        jobCount: inventory.rows.length,
        misconfiguredCount: misconfigured.length,
        jobs: inventory.rows,
        failuresAndRemovals: failures.rows,
        ...(inventory.error ? { error: inventory.error } : {}),
      });
    },
  };
}

function createMyRuntime() {
  return {
    name: 'otel_my_runtime',
    label: 'otel_my_runtime',
    capability: 'otel',
    description:
      'YOUR OWN runtime health (read-only): cold-boot times, turn latency/TTFT p90, real turn '
      + 'errors, the dispatcher\'s provisioning saga for you (provision→READY, invoke latency, cold '
      + 'retries), per-session QUEUE WAIT and depth (usually the biggest share of felt latency), and '
      + 'runtime generation rolls — plus recent errors/warnings from your own runtime log. Use for '
      + '"why does this feel slow", "am I cold-booting a lot", "did my runtime just get rolled". '
      + 'since = lookback (default 3h).',
    parameters: T.Object({ since: T.Optional(T.String()) }),
    async execute(_id, params = {}) {
      let agent;
      try { agent = ownAgentId(); } catch (e) { return scopedError('otel_my_runtime', e); }
      const { startMs, endMs } = timeWindow(params.since, 3 * 36e5);
      const specs = SELF_HEALTH_METRICS
        // The corpus labels are written for the FLEET dashboard, so several read "(fleet)" — but
        // these expressions are pinned to this agent's Agent dimension, so a SUM over them is this
        // agent's total. Relabel, or the tool hands the model a number that says fleet and isn't.
        .map((name, i) => ({
          id: `q${i}`,
          name,
          expr: scopedMetricExpr(name, agent),
          label: (METRICS[name]?.label || name).replace(/\(fleet\)/g, '(this agent)'),
        }))
        .filter((s) => s.expr);
      let metrics = {};
      let messages = [];
      let metricsError;
      try { ({ metrics, messages } = await runMetrics(specs, startMs, endMs)); } catch (e) { metricsError = String(e?.message || e); }
      let runtimeLog = { status: 'Skipped', rows: [] };
      let groups = [];
      try {
        groups = await ownRuntimeLogGroups(agent);
        if (groups.length) runtimeLog = await tryInsights({ ...scopedRuntimeErrorsQuery(), logGroups: groups, startMs, endMs });
      } catch (e) {
        runtimeLog = { status: 'Error', rows: [], error: String(e?.message || e) };
      }
      // Which runtime INSTANCES actually served turns in the window, newest first. The
      // RuntimeGenerationRollCount metric above says a roll HAPPENED; this says which generations ran
      // and how much traffic each took, which is what makes "did my runtime just get rolled" (in the
      // description) answerable rather than merely countable. Best-effort: a failure here must not
      // cost the caller the metrics, which are the primary payload.
      let generations = [];
      let generationsNote;
      try {
        const gens = await tryInsights({ ...scopedGenerationsQuery(agent), startMs, endMs });
        generations = (gens.rows || []).map((r) => {
          const name = runtimeNameFromArn(r.runtime_arn);
          const parts = name ? parseRuntimeName(name) : null;
          return {
            runtime: name,
            // fp8 = the immutable-spec fingerprint. Same fp8 + different awsSuffix = the SAME spec
            // recreated (a fleet roll's delete→recreate); a different fp8 = a real spec change.
            generation: parts?.fp8 || null,
            instance: parts?.awsSuffix || null,
            ...(parts && !parts.generational ? { naming: 'pre-generation' } : {}),
            turns: Number(r.turns) || 0,
            firstTurn: r.first_turn,
            lastTurn: r.last_turn,
            avgDurationMs: r.avg_duration_ms == null ? null : Math.round(Number(r.avg_duration_ms)),
          };
        });
      } catch (e) {
        generationsNote = String(e?.message || e);
      }
      return asText({
        tool: 'otel_my_runtime',
        scope: agent,
        since: params.since || '3h',
        region: REGION,
        metrics,
        // Two DIFFERENT counts, deliberately both present: log groups exist for every runtime the
        // platform ever booted for you (including pool containers that served nothing), whereas
        // `generations` only lists instances that actually served a turn in the window.
        runtimeLogGroups: groups.length,
        generations,
        ...(generationsNote ? { generationsNote } : {}),
        recentErrors: runtimeLog.rows,
        ...(messages.length ? { metricMessages: messages } : {}),
        ...(metricsError ? { metricsError } : {}),
        ...(runtimeLog.error ? { runtimeLogNote: runtimeLog.error } : {}),
      });
    },
  };
}

// ══ TIER 2 — fleet-wide + ad-hoc, granted `otel.fleet` ═════════════════════════════════════════
// Unchanged in behaviour from the pre-2026-08-11 otel_query/otel_metric/otel_trace — only the names
// and the capability moved. Renamed rather than left in place so the tier is legible at the call
// site: an agent that holds the grant is reading OTHER agents' telemetry, and (via query/logGroups)
// any log group its role can reach. NB that ad-hoc reach is bounded by IAM's log-group resource
// scoping, not by this tool — see observability-iam.cjs.
function createFleetQuery() {
  return {
    name: 'otel_fleet_query',
    label: 'otel_fleet_query',
    capability: 'otel.fleet',
    description:
      'FLEET-WIDE Logs Insights over the agent fleet\'s OTEL telemetry (read-only; covers ALL agents '
      + '— for your own use otel_my_turns/otel_my_tools). '
      + `Pass a named query — one of: ${INSIGHTS_NAMES.join(', ')}. `
      + 'genai_turns/genai_tokens_over_time = token usage per turn; tool_spans = per-tool call count/latency/errors; '
      + 'turn_outcomes = reply/empty/error breakdown; trace_stitch = dispatcher→runtime join health; '
      + 'dispatcher_spans = provisioning/invoke phase durations; fleet_errors/invoke_outcomes/agent_spawns = fleet log; '
      + 'cron_inventory/cron_misconfigured/cron_delivery_failures/cron_removals = fleet cron state. '
      + 'since = lookback window like "1h","30m","24h","7d" (default 1h). Omit name to list available queries. '
      + 'For an ad-hoc query pass query + logGroups (advanced).',
    parameters: T.Object({
      name: T.Optional(T.String()),
      since: T.Optional(T.String()),
      limit: T.Optional(T.Number()),
      query: T.Optional(T.String()),
      logGroups: T.Optional(T.Array(T.String())),
    }),
    async execute(_id, params = {}) {
      const { startMs, endMs } = timeWindow(params.since, 36e5);
      let spec;
      if (params.query) {
        spec = { logGroups: params.logGroups && params.logGroups.length ? params.logGroups : [SPANS_LG], query: params.query };
      } else if (params.name && INSIGHTS[params.name]) {
        spec = INSIGHTS[params.name];
      } else {
        return asText({ error: params.name ? `unknown query "${params.name}"` : 'no query name given', available: INSIGHTS_NAMES });
      }
      const out = await runInsights({ ...spec, startMs, endMs, limit: params.limit });
      const capped = out.rows.slice(0, 100);
      return asText({
        query: params.query ? '(ad-hoc)' : params.name,
        logGroups: spec.logGroups,
        since: params.since || '1h',
        region: REGION,
        status: out.status,
        rowCount: out.rows.length,
        rows: capped,
        ...(out.rows.length > capped.length ? { truncated: `showing first ${capped.length} of ${out.rows.length}` } : {}),
        ...(out.error ? { error: out.error } : {}),
      });
    },
  };
}

function createFleetMetric() {
  return {
    name: 'otel_fleet_metric',
    label: 'otel_fleet_metric',
    capability: 'otel.fleet',
    description:
      'FLEET-WIDE named CloudWatch metric time-series (read-only GetMetricData over the observability '
      + 'SEARCH corpus; covers ALL agents — for your own use otel_my_runtime). '
      + `Named metrics: ${METRIC_NAMES.join(', ')}. `
      + 'e.g. turnLatencyP90/turnTtftP90 = latency; turnTokensInput/turnTokensContext/turnCacheHitRate = tokens+cache; '
      + 'turnCost = spend; coldBoot/bootConcurrency = cold starts; provisionTotalP90/invokeLatencyP90 = dispatcher saga; '
      + 'errors/throttles/turnErrors = failures. Returns per-series latest/min/max/avg/sum. '
      + 'since = lookback like "3h","1d" (default 3h). Omit name to list available metrics.',
    parameters: T.Object({
      name: T.Optional(T.String()),
      since: T.Optional(T.String()),
    }),
    async execute(_id, params = {}) {
      if (!params.name || !METRICS[params.name]) {
        return asText({ error: params.name ? `unknown metric "${params.name}"` : 'no metric name given', available: METRIC_NAMES });
      }
      const spec = METRICS[params.name];
      const { startMs, endMs } = timeWindow(params.since, 3 * 36e5);
      try {
        const res = await cw().send(new GetMetricDataCommand({
          MetricDataQueries: [{ Id: 'q0', Expression: spec.expr, Label: spec.label, ReturnData: true }],
          StartTime: new Date(startMs),
          EndTime: new Date(endMs),
          ScanBy: 'TimestampDescending',
        }));
        const series = (res.MetricDataResults || []).map(summarizeSeries);
        const messages = (res.Messages || []).map((m) => m.Value);
        return asText({
          metric: params.name,
          label: spec.label,
          expr: spec.expr,
          since: params.since || '3h',
          region: REGION,
          seriesCount: series.length,
          series,
          ...(messages.length ? { messages } : {}),
        });
      } catch (err) {
        return asText({ metric: params.name, error: String(err?.message || err) });
      }
    },
  };
}

function createFleetTrace() {
  return {
    name: 'otel_fleet_trace',
    label: 'otel_fleet_trace',
    capability: 'otel.fleet',
    description:
      'Reconstruct ANY agent\'s full end-to-end trace by traceId from the aws/spans store (read-only; '
      + 'for your own traces use otel_my_trace) — every span (dispatcher.request → '
      + 'dispatcher.provision.* → dispatcher.agent_i073q7 → runtime agent_i073q7 → execute_tool/chat '
      + 'children) with name, duration, operation, model, tokens, tool, and status. '
      + 'traceId = the 32-hex trace id (from genai_turns/dispatcher_spans rows). since = lookback (default 6h).',
    parameters: T.Object({ traceId: T.String(), since: T.Optional(T.String()) }),
    async execute(_id, params = {}) {
      let spec;
      try { spec = scopedTraceQuery(String(params.traceId || '').trim()); } catch (e) {
        return asText({ error: String(e?.message || e), got: params.traceId });
      }
      const { startMs, endMs } = timeWindow(params.since, 6 * 36e5);
      const out = await runInsights({ ...spec, startMs, endMs });
      return asText({
        traceId: params.traceId,
        since: params.since || '6h',
        region: REGION,
        status: out.status,
        spanCount: out.rows.length,
        spans: out.rows,
        ...(out.error ? { error: out.error } : {}),
      });
    },
  };
}

// The scoped tier is fleet-wide + always-on (user decision 2026-08-01: every agent gets
// self-observability) — NOT gated on the per-agent allow-set, unlike buildMemoryTools/
// buildCronTools: self-debugging is a base capability regardless of tools.profile. The fleet tier
// is declared here too but carries capability `otel.fleet`, so the tool FILTER (and the tool_call
// PEP as backstop) hides it from any agent without that grant. Kill switch for everything:
// OTEL_TOOLS_DISABLED=1.
export function buildOtelTools() {
  if (process.env.OTEL_TOOLS_DISABLED === '1') return [];
  return [
    createMyTurns(), createMyTools(), createMyTrace(), createMyCrons(), createMyRuntime(),
    createFleetQuery(), createFleetMetric(), createFleetTrace(),
  ];
}

'use strict';

// Builds + deploys the AgentCore TURN-LATENCY dashboard from the shared query library
// (insight-queries.js). Idempotent (PutDashboard).
//   AWS_PROFILE=sandbox AWS_REGION=us-east-1 node deploy-latency-dashboard.cjs [dashboardName]
//
// Why a SECOND dashboard instead of more widgets on `agentcore-fleet`: this one answers a single
// question — "is TTFM p99 inside the 10s budget, and if not, which leg blew it?" — and it is the
// SLO surface, so it stays readable without competing with the 31-widget fleet-health board (whose
// widget count is a BDD-asserted single-owner contention point). The widget helpers below are
// deliberately duplicated from deploy-dashboard.cjs rather than shared: keeping this file's
// blast radius at zero is worth ~15 lines.
//
// SLO: p99 of TTFM (dispatcher.request start → first Bedrock `chat` span) < 10s, fleet-wide.
//
// Status 2026-08-13, after Phase 1 + the runtime registry: warm turns are p50 5.5s (slack) / 2.4s
// (cron), and the DISPATCHER'S OWN work is 5-44ms — the earlier "dispatcher leg owns 103s" reading was
// provisioning inside the turn, which no longer happens. What remains is (a) cold turns at ~32s p50,
// which Phase 2 pre-warm removes, and (b) AgentCore session allocation under burst: 12-16s per new
// session at ~15-way concurrency versus ~2.5s solo, which is not ours to fix.
// Beware p99 on this board when traffic is thin: at n=12 a p99 is the single worst turn.

// The DISPATCHER_LOG_GROUP override this file used to set before the require is gone: as of
// 2026-08-14 insight-queries.js derives the log group (and both EMF namespaces) from the same
// ARCHIE_STACK knob itself, so the fix lives in one place and covers every consumer — this board,
// the fleet board, the BDD suite and the in-image otel_* tools — instead of only whoever remembered
// to poke the env. Setting DISPATCHER_LOG_GROUP / ARCHIE_STACK still overrides.

const { CloudWatchClient, PutDashboardCommand } = require('@aws-sdk/client-cloudwatch');
const Q = require('./insight-queries');

const NAME = process.argv[2] || process.env.AGENTCORE_LATENCY_DASHBOARD_NAME || 'agentcore-turn-latency';
const SLO_MS = 10000;

// No metricWidget helper here any more: every widget on this board is span-derived (log) so that
// phases are exact and additive. CloudWatch METRICS can't express the per-trace join TTFM needs.
function logWidget(x, y, w, h, title, insight, view = 'table', extra = {}) {
  const source = insight.logGroups.map((g) => `'${g}'`).join(' ');
  return {
    type: 'log', x, y, width: w, height: h,
    properties: { region: Q.REGION, title, view, query: `SOURCE ${source} | ${insight.query}`, ...extra },
  };
}

function textWidget(x, y, w, h, markdown) {
  return { type: 'text', x, y, width: w, height: h, properties: { markdown } };
}

// The SLO line, drawn on both TTFM trend widgets so a breach is visible without reading numbers.
const sloAnnotation = { horizontal: [{ label: 'SLO p99 < 10s', value: SLO_MS, color: '#d13212' }] };
const msAxis = { left: { label: 'ms', min: 0, showUnits: false } };

const secAxis = { left: { label: 'seconds of TTFM', min: 0, showUnits: false } };

// NO PER-AGENT / PER-RUNTIME WIDGETS ON THIS BOARD, deliberately. This dashboard answers "where is
// the time going", not "who is slow" — every widget is a fleet-wide aggregate or a phase breakdown.
// The per-agent and per-runtime cuts still exist as `agent_ldzgpn` / `agent_ldzgpn_runtime` in
// insight-queries.js (reachable from otel_query for triage), and the per-agent provisioning METRIC
// widgets live on `agentcore-fleet`. They were removed from here, not deleted.
const body = {
  widgets: [
    textWidget(0, 0, 24, 5, [
      '## Turn latency — TTFM (time to first model call) · **SLO: p99 < 10s**',
      'Measures **`dispatcher.request` start → first `chat <model>` start**, joined per-trace on `traceId`.'
        + ' Fleet-wide aggregates only — no per-agent breakdowns; this board is about **where the time goes**.',
      '**The four phases sum exactly to TTFM** (residual verified 0): `dispatch` = request received → provisioning'
        + ' starts *(for a warm turn this is the whole pre-runtime wait, including queueing behind a runtime another turn'
        + ' is provisioning)*; `provision` = provisioning → runtime reports READY; `claim` = READY → the runtime actually'
        + ' starts the turn; `prep` = turn starts → first model call.',
      '**Caveats.** Phases are milestone *instants*, never span durations — `dispatcher.provision`\'s duration outlives'
        + ' the turn it provisions (seen: 69.6s span on a turn whose runtime started at +26.5s). `cold` means the turn drove'
        + ' its OWN provision; a turn that merely waited on someone else\'s reads `warm` and its wait shows up in `dispatch`.'
        + ' TTFM ends at the first Bedrock *response* byte, so it includes network + model TTFT. Queries: `ttfm_*`.',
    ].join('\n\n')),
    // Row 1 — the SLO itself.
    logWidget(0, 5, 24, 7, 'TTFM p99 / p95 / p50 (ms, 15-min bins) — the SLO trend',
      Q.INSIGHTS.ttfm_trend, 'timeSeries', { annotations: sloAnnotation, yAxis: msAxis }),
    // Row 2 — cold vs warm: share of turns, p99 each, and seconds burned by each path.
    logWidget(0, 12, 24, 6, 'Cold vs warm — turns, p50/p95/p99, and total seconds burned by each path (cold=1)',
      Q.INSIGHTS.ttfm_cold_vs_warm),
    // Row 3 — the cumulative-time answer, at two scopes. Same query, different window: the widget
    // `start` overrides the dashboard time range so "today" and "right now" sit side by side.
    logWidget(0, 18, 12, 7, 'Where the time went — LAST 24h (cumulative seconds + % per phase, by cold/warm)',
      Q.INSIGHTS.ttfm_phase_share, 'table', { start: '-P1D' }),
    logWidget(12, 18, 12, 7, 'Where the time went — LAST 1 HOUR (cumulative seconds + % per phase, by cold/warm)',
      Q.INSIGHTS.ttfm_phase_share, 'table', { start: '-PT1H' }),
    // Row 4 — the same cumulative view as a stacked trend: band height = the hour's time sink.
    logWidget(0, 25, 24, 7, 'Cumulative TTFM seconds by phase, per hour (stacked — tallest band is the sink)',
      Q.INSIGHTS.ttfm_phase_trend, 'timeSeries', { stacked: true, yAxis: secAxis }),
    // Row 5 — slow spots inside provisioning, ranked by cumulative time (parents contain children).
    logWidget(0, 32, 24, 7, 'Slow spots — provisioning steps + AWS control-plane calls by CUMULATIVE time',
      Q.INSIGHTS.ttfm_slow_spots),
    // Row 6 — INSIDE the dispatcher leg. Provisioning is off the warm path now, so `request ->
    // agent_i073q7` is the dominant TTFM term (measured: dispatcher p99 21.7s vs runtime p99 3.6s) and
    // it used to be one opaque block. These two widgets are the partition: ranked by cumulative time,
    // and per-phase p99 over time so a regression lands on a deploy.
    logWidget(0, 39, 12, 7, 'Dispatcher leg — phases by CUMULATIVE time (request -> agent_i073q7)',
      Q.INSIGHTS.ttfm_dispatcher_phases),
    logWidget(12, 39, 12, 7, 'Dispatcher leg — p99 per phase over time (session_slot = queued behind the same thread)',
      Q.INSIGHTS.ttfm_dispatcher_phase_trend, 'timeSeries', { yAxis: msAxis }),
    // Row 7 — session provenance. Reuse is the biggest single swing in a warm turn (platform leg
    // ~2,505ms new vs ~118ms reused), and it is workload-determined rather than a fault: Slack is ~87%
    // first-use because 89% of threads get one message. Split by trigger so that structural fact is not
    // averaged together with cron's ~66% reuse.
    logWidget(0, 46, 12, 7, 'Session first-use vs reuse, by trigger (first_use=1 means no session to reuse)',
      Q.INSIGHTS.ttfm_session_reuse),
    logWidget(12, 46, 12, 7, 'Idle-expired sessions — the ACTIONABLE case (we had it, the 900s timeout took it)',
      Q.INSIGHTS.ttfm_session_idle_expired),
    // Row 8 — THE PRE-WARM SCOREBOARD (Phase 2 step 0). Deliberately built before the queue exists, so
    // pre-warm is judged against a measured baseline. `coalesced` is kept separate from `miss` because
    // it is the herd collapsing as designed; summing them would make a working roll look like a failure.
    logWidget(0, 53, 12, 7, 'Runtime cache outcomes — miss should trend to ZERO once pre-warm lands',
      Q.INSIGHTS.runtime_cache_outcomes),
    logWidget(12, 53, 12, 7, 'Runtime cache hit % by agent, WORST first (a fleet average hides the gaps)',
      Q.INSIGHTS.agent_kwuho5),
    // Row 9 — the work queue: every turn over budget, with its leg split and traceId.
    logWidget(0, 60, 24, 7, `SLO breaches — turns over ${SLO_MS / 1000}s, worst first (total / dispatcher / runtime ms + traceId)`,
      Q.INSIGHTS.ttfm_breaches),
  ],
};

(async () => {
  const cw = new CloudWatchClient({ region: Q.REGION });
  const out = await cw.send(new PutDashboardCommand({
    DashboardName: NAME, DashboardBody: JSON.stringify(body),
  }));
  const warnings = out.DashboardValidationMessages || [];
  console.log(JSON.stringify({ dashboard: NAME, region: Q.REGION, widgets: body.widgets.length, warnings }, null, 2));
})().catch((e) => { console.error('deploy-latency-dashboard failed:', e.message); process.exit(1); });

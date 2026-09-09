'use strict';

// Single source of truth for AgentCore observability queries + metrics.
// Dependency-free so it's requireable by both the dashboard builder
// (dashboard deploy) and the BDD suite (queries-as-contract).
//
// Sources (all us-east-1):
//   - Adapter agent_i32pz9.* spans           -> aws/spans (Logs Insights; needs AGENTCORE_OTEL_MODE=xray)
//   - Dispatcher fleet log             -> /ecs/<stack>-dispatcher (spawns/outcomes/errors)
//   - Runtime metrics                  -> AWS/Bedrock-AgentCore (CloudWatch Metrics)
//   - Cold-boot EMF (per microVM boot) -> AgentCore/Pi ColdBootMs, dimension Agent (CloudWatch Metrics)
//   - Token metrics (from agent_i32pz9 spans)-> ApplicationSignals (CloudWatch Metrics)
// Removed (OpenClaw-era, no Pi equivalent under per-agent on-demand runtimes): the
// openclaw-otel + per-runtime gateway log queries + the gateway_ready cold-boot logs query.

const REGION = process.env.AGENTCORE_REGION || 'us-east-1';
const AGENT = process.env.AGENT_NAME || 'agent-xx9aff';

const SPANS_LG = 'aws/spans';

// ── ONE STACK KNOB ──────────────────────────────────────────────────────────────────────────
// Every stack-shaped name below (dispatcher log group, EMF namespaces) derives from ARCHIE_STACK,
// matching how the BDD support code derives the config table and base policy
// (`${process.env.ARCHIE_STACK || 'agent-gn0p84'}-...`). Terraform passes the real values explicitly
// (DISPATCHER_LOG_GROUP / DISPATCHER_METRIC_NAMESPACE / CRON_METRIC_NAMESPACE from
// modules/archie), so the deployed path never relies on these defaults — they exist for hand-run
// tooling, the BDD suite, and the otel_* tools baked into the runtime image.
//
// The defaults now name ARCHIE, not OpenClaw. Three things forced that (2026-08-14):
//   1. A MIXED default is worse than either. Deriving the namespaces (2026-08-13) while leaving
//      the log group on `/ecs/agent-4ggvzl-dispatcher` produced a board whose METRIC
//      widgets read archie and whose LOG widgets read the OpenClaw stack. One knob, or the two
//      halves drift apart again on the next rename.
//   2. Every consumer of these defaults is archie. The dashboards, the BDD suite and the
//      in-image otel_* tools all target AgentCore, which is Pi/archie-only; the OpenClaw
//      dispatcher is simply another live process in the same account.
//   3. The wrong log group does not fail loudly, it lies. `/ecs/agent-4ggvzl-dispatcher`
//      STILL EXISTS and is still being written to by the OpenClaw dispatcher, in the same pino
//      shape — so the widgets and the BDD assertions rendered another stack's fleet as if it were
//      archie's. That is a worse failure mode than the empty namespaces this pairs with, which at
//      least looked quiet. In the runtime it fails outright: the agentcore-base role grants
//      `logs:StartQuery` on `/ecs/agent-gn0p84-dispatcher*` ONLY, so an archie agent running
//      otel_query against the OpenClaw default gets AccessDenied.
//
// To point this at the OpenClaw stack, set ARCHIE_STACK=agent-4ggvzl for the log group AND
// both namespace vars — OpenClaw's namespaces are the historical literals `ClawdbotDispatcher` /
// `ClawdbotCron`, which are NOT derived from its stack name and so cannot follow the knob.
const STACK = process.env.ARCHIE_STACK || 'archie';

// The dispatcher owns the fleet-wide signals (routing, on-demand agent spawns, invoke
// outcomes, errors) — one stable log group, unlike the ephemeral per-agent runtime groups
// (which are per-runtime-id and don't map to a single source under on-demand spawning).
const DISPATCHER_LG = process.env.DISPATCHER_LOG_GROUP || `/ecs/${STACK}-dispatcher`;

// EMF metric namespaces, DERIVED not hardcoded — the same mistake alarms.tf closed on 2026-08-13.
// The dispatcher publishes to `${var.name}Dispatcher` and cron to `${var.name}Cron`, so archie's
// metrics land in `agent-gn0p84Dispatcher` / `agent-gn0p84Cron` while OpenClaw's land in the historical
// `ClawdbotDispatcher` / `ClawdbotCron`. Every widget below hardcoded the OpenClaw names, so the
// whole dispatcher half of this dashboard rendered EMPTY against archie — silently, because a
// SEARCH() over a namespace with no metrics is indistinguishable from a quiet fleet.
const DISPATCHER_NS = process.env.DISPATCHER_METRIC_NAMESPACE || `${STACK}Dispatcher`;
const CRON_NS = process.env.CRON_METRIC_NAMESPACE || `${STACK}Cron`;

// --- TTFM join fragments (time to first model call) ---------------------------------------
// There is no single span for "message arrived → model called": the clock starts on the
// dispatcher's LOCAL_ROOT span (`dispatcher.request`, on ECS) and stops on the runtime's first
// `chat <model>` span (in the microVM). Both carry the same traceId thanks to the M3
// payload-traceparent stitch, so every TTFM query joins them per-trace with a TWO-STAGE stats:
//   stage 1 (TTFM_STAGE1)   collapse each trace to its request-start / first-chat-start
//   stage 2 (in each query) percentiles over the per-trace gaps
// Notes / gotchas, all load-bearing:
//   - startTimeUnixNano (NOT durationNano): we need span START times, not durations.
//   - /1000000 FIRST: nanosecond epochs (~1.79e18) exceed float64's exact-integer range
//     (2^53 ≈ 9e15); milliseconds (~1.79e12) are exact, so the subtraction is safe.
//   - NO_SPAN sentinel: min() needs a large NEUTRAL value for non-matching rows — `0` would make
//     min() return 0 for every trace. TTFM_KEEP then drops traces that never called a model (cron
//     nudges / empty turns) rather than scoring them.
//   - RETRIES: a cold turn the dispatcher retries produces SEVERAL `agent_i073q7` spans under one
//     traceId (~5% of traces, always 2). Both rt_start and chat_start therefore use min() —
//     pinning the FIRST attempt — so the two legs are always measured from the same attempt.
//     (Using max() for rt_start pairs a later attempt's turn start with an earlier attempt's chat
//     span and yields a NEGATIVE runtime leg; that bug was live before this comment existed.)
//     min/min also makes runtime_ms >= 0 structurally, since the earliest turn span cannot start
//     after the earliest model call inside it.
//   - earliest(attributes.dispatcher.agent): only the request span carries the agent, and it is
//     always the first span in the trace, so earliest() reliably picks it up.
//   - BOUNDARY CAVEAT: Pi emits `message_start` (which backdates the chat span) on the FIRST
//     EVENT OF THE BEDROCK RESPONSE STREAM, not before the SDK call (pi-agent-core
//     agent-loop.js: the emit sits inside `for await (const event of response)`). So TTFM ends at
//     first response byte and INCLUDES the request dispatch + network + model TTFT. It is an
//     upper bound on "our" pre-model overhead — do not read it as purely our own latency.
//   - Cross-boundary clock skew (ECS vs microVM) was believed real and large (~3.6s worst case),
//     which would have made sub-second precision on the joined total meaningless. MEASURED
//     2026-08-14 and it is not: over 282 turns, `dispatcher.agent_i073q7` END minus the runtime
//     `agent_i073q7` END — the same two clocks, at the other end of the same call — was 1–79ms,
//     median 4ms, INCLUDING every turn whose start-to-start gap was 12–18s. Two clocks that agree
//     to 4ms at one boundary cannot be 15s apart at the other, so that gap is real waiting, not
//     skew, and the joined totals here are trustworthy to well under a second.
const NO_SPAN = 99999999999999;
const TTFM_FILTER = "filter name = 'dispatcher.request' or attributes.agent_i32pz9.operation.name = 'chat'";
const TTFM_STAGE1 = [
  '| fields startTimeUnixNano/1000000 as st_ms',
  "| stats max(if(name = 'dispatcher.request', st_ms, 0)) as req_start,",
  `    min(if(attributes.agent_i32pz9.operation.name = 'chat', st_ms, ${NO_SPAN})) as chat_start,`,
  '    min(@timestamp) as ts',
].join('\n');
// Leg-split variant: also pins the runtime turn's own start (`agent_i073q7`, the parent of the
// chat spans) so the gap can be cut into dispatcher-side and runtime-side halves. min() on
// rt_start is deliberate — see the RETRIES note above.
const TTFM_STAGE1_LEGS = [
  '| fields startTimeUnixNano/1000000 as st_ms',
  "| stats max(if(name = 'dispatcher.request', st_ms, 0)) as req_start,",
  `    min(if(name = 'agent_i073q7', st_ms, ${NO_SPAN})) as rt_start,`,
  `    min(if(attributes.agent_i32pz9.operation.name = 'chat', st_ms, ${NO_SPAN})) as chat_start,`,
  '    min(@timestamp) as ts',
].join('\n');
const TTFM_KEEP = `by traceId\n| filter req_start > 0 and chat_start < ${NO_SPAN}`;
const TTFM_KEEP_LEGS = `${TTFM_KEEP} and rt_start < ${NO_SPAN}`;
// Same value as SPAN_RUNTIME_ARN_FIELD (declared further down, after INSIGHTS, so not in scope
// here) — the runtime-instance ARN. Duplicated as a const rather than inlined so a rename greps.
// TRAP, verified 2026-08-12: aggregating this field only works on the RAW dotted path.
// `| fields resource.attributes.cloud.resource_id as rid | stats earliest(rid) ...` returns an
// EMPTY column — no error, just silently nothing — whereas `stats earliest(resource.attributes.
// cloud.resource_id)` returns the ARN. (Grouping BY an alias is fine; that's what
// scopedGenerationsQuery does. It's aggregating an alias that breaks.) It is a RESOURCE attribute,
// so it is absent on dispatcher spans; earliest() skips those nulls, which is why it survives the
// mixed-span TTFM join at all.
const TTFM_RUNTIME_ARN = 'resource.attributes.cloud.resource_id';

// --- TTFM PHASE decomposition (where the time actually goes) -------------------------------
// Splits TTFM into four phases that SUM EXACTLY to it (residual verified 0 over 577 turns), so
// "% of total" and "cumulative seconds" are both honest:
//   dispatch_ms   req received      → provisioning starts (warm: → runtime turn starts, so for a
//                                     warm turn this phase IS the whole pre-runtime wait: SQS
//                                     hand-off, AgentCore ingress, AND waiting on a runtime that
//                                     another turn is currently provisioning)
//   provision_ms  provisioning      → the runtime reports READY   (0 when warm)
//   claim_ms      READY             → the runtime actually starts the turn (0 when warm) — the
//                                     post-READY wait for a container that will really serve
//   prep_ms       turn starts       → first model call (session load, prompt build, dispatch, TTFT)
//
// WHY MILESTONES AND NOT SPAN DURATIONS — the trap that made the first version of this wrong:
// `dispatcher.provision`'s DURATION is NOT a subset of TTFM. Live example (trace
// 099d99eb09ec9e81b58d536bc2e254fd): ONE provision span lasting 69.6s on a turn whose runtime
// started at +26.5s — the provision span stays open long after the turn it provisioned is already
// running. Subtracting its duration produced NEGATIVE phases on 34/579 turns. So every boundary
// here is an INSTANT (a span start, or runtime_ready's end), and the two cold boundaries are
// CLAMPED to rt_start via if(), which is what makes all four phases non-negative by construction
// and keeps the sum exact for warm turns (where both clamps collapse to rt_start).
const TTFM_PHASE_FILTER = "filter name = 'dispatcher.request' or name = 'dispatcher.provision' or name = 'dispatcher.provision.runtime_ready' or name = 'agent_i073q7' or attributes.agent_i32pz9.operation.name = 'chat'";
const TTFM_PHASE_STAGE1 = [
  '| fields startTimeUnixNano/1000000 as st_ms, (startTimeUnixNano + durationNano)/1000000 as end_ms',
  "| stats max(if(name = 'dispatcher.request', st_ms, 0)) as req_start,",
  `    min(if(name = 'dispatcher.provision', st_ms, ${NO_SPAN})) as prov_start,`,
  "    max(if(name = 'dispatcher.provision.runtime_ready', end_ms, 0)) as ready_end,",
  `    min(if(name = 'agent_i073q7', st_ms, ${NO_SPAN})) as rt_start,`,
  `    min(if(attributes.agent_i32pz9.operation.name = 'chat', st_ms, ${NO_SPAN})) as chat_start,`,
  '    min(@timestamp) as ts',
  '  by traceId',
  `| filter req_start > 0 and chat_start < ${NO_SPAN} and rt_start < ${NO_SPAN}`,
  '| fields if(prov_start < rt_start, prov_start, rt_start) as p0,',
  '    if(ready_end > 0 and ready_end < rt_start, ready_end, rt_start) as p1',
  '| fields p0 - req_start as dispatch_ms, p1 - p0 as provision_ms, rt_start - p1 as claim_ms,',
  '    chat_start - rt_start as prep_ms, chat_start - req_start as total_ms',
].join('\n');
// Cold = this turn drove a provision of its own. NB a turn that merely WAITED on another turn's
// provision reads `warm` here (it has no provision span) and its wait lands in dispatch_ms — which
// is exactly why the phase view is more truthful than the cold/warm label alone.
const TTFM_COLD_KEY = `prov_start < ${NO_SPAN} as cold`;

// --- Logs Insights queries (name -> { logGroups, query }) ---
// Field paths use CloudWatch's flattened dotted keys (verified against aws/spans).
const INSIGHTS = {
  // `in_tokens` IS NOT THE PROMPT SIZE. Under prompt caching it is the uncached remainder only —
  // TURN-LATENCY-REPORT.md §3 measured a p50 of ONE token. Every column below that matters for
  // "how big / how expensive was this turn" comes from the cache-aware attributes instead:
  // prompt_tokens (the true prompt size), cached (read tokens), cache_ratio, cost_usd, calls.
  genai_turns: {
    logGroups: [SPANS_LG],
    query: [
      'fields @timestamp, attributes.session.id as session, attributes.agent_i32pz9.request.model as model,',
      '  attributes.agent_i32pz9.usage.input_tokens as uncached_in, attributes.agent_i32pz9.usage.output_tokens as out_tokens,',
      '  attributes.agent_i32pz9.usage.total_prompt_tokens as prompt_tokens,',
      '  attributes.agent_i32pz9.usage.cache_read_tokens as cached, attributes.agent_i32pz9.usage.cache_write_tokens as cache_write,',
      '  attributes.agentcore.cache.read_ratio as cache_ratio, attributes.agent_i32pz9.usage.cost_usd as cost_usd,',
      '  attributes.agent_i32pz9.usage.model_calls as calls,',
      '  attributes.agent_i32pz9.response.finish_reasons as finish, durationNano/1000000 as duration_ms',
      "| filter attributes.agent_i32pz9.operation.name = 'agent_i073q7'",
      '| sort @timestamp desc | limit 50',
    ].join('\n'),
  },
  genai_tokens_over_time: {
    logGroups: [SPANS_LG],
    query: [
      'fields attributes.agent_i32pz9.usage.input_tokens as uncached_in, attributes.agent_i32pz9.usage.output_tokens as out_tokens,',
      '  attributes.agent_i32pz9.usage.cache_read_tokens as cached, attributes.agent_i32pz9.usage.cache_write_tokens as cache_write,',
      '  attributes.agent_i32pz9.usage.cost_usd as cost_usd',
      "| filter attributes.agent_i32pz9.operation.name = 'agent_i073q7'",
      // uncached_in + cached + cache_write is the whole billed prompt; splitting it three ways is
      // the point — the same total costs ~10x less when it arrives as `cached`.
      '| stats sum(uncached_in) as uncached_prompt_tokens, sum(cached) as cached_prompt_tokens,',
      '    sum(cache_write) as cache_write_tokens, sum(out_tokens) as output_tokens,',
      // `as cost_total_usd`, not `as cost_usd`: an aggregate may not reuse the name of the ephemeral
      // field it reads from (MalformedQueryException). Verified against aws/spans.
      '    sum(cost_usd) as cost_total_usd by bin(5m)',
    ].join('\n'),
  },
  // THE CACHE-EFFECT VIEW, per model. This is the query that would have caught the Sonnet 5
  // regression on the day it shipped (2026-08-15): pi-ai gates cache points on a hard-coded model
  // list, so moving the fleet to a model it did not know silently dropped hit_rate to 0 while every
  // turn kept succeeding. Cut by model because that is the axis the gate keys on.
  //
  // Read it as: hit_rate ≈ 1 and cached_share ≈ 1 is healthy. hit_rate 0 across a busy window means
  // no cache points are being written at all (model gate, or caching switched off). hit_rate high
  // with a LOW cached_share means the prefix keeps shifting — tool-set churn or a per-turn edit
  // landing ahead of the breakpoint — so entries get written and never meaningfully read.
  prompt_cache_effect: {
    logGroups: [SPANS_LG],
    query: [
      'fields attributes.agent_i32pz9.request.model as model,',
      '  attributes.agentcore.cache.read_ratio as ratio,',
      '  attributes.agent_i32pz9.usage.cache_read_tokens as cached, attributes.agent_i32pz9.usage.cache_write_tokens as cache_write,',
      '  attributes.agent_i32pz9.usage.input_tokens as uncached_in, attributes.agent_i32pz9.usage.cost_usd as cost_usd',
      "| filter attributes.agent_i32pz9.operation.name = 'agent_i073q7'",
      // A no-op turn never reached the model, so it has no prompt and would drag hit_rate down for
      // a reason that has nothing to do with caching.
      '| filter ispresent(cached) and (cached > 0 or cache_write > 0 or uncached_in > 0)',
      // hit_turns counts `cached > 0` rather than averaging the `agentcore.cache.hit` boolean
      // attribute: sum() over a numeric comparison is the idiom Insights is known to evaluate here
      // (same as `sum(receives > 1)` in sqs_queue_wait), whereas a JSON boolean's aggregate typing
      // is not worth betting a dashboard on. The rate itself is computed AFTER stats, the pattern
      // ttfm_phase_share already uses.
      '| stats count(*) as turns, sum(cached > 0) as hit_turns, avg(ratio) as avg_cached_share,',
      '    sum(cached) as cached_tokens, sum(cache_write) as written_tokens, sum(uncached_in) as uncached_tokens,',
      // NOT `sum(cost_usd) as cost_usd` — reusing the name of an already-defined ephemeral field is
      // a MalformedQueryException ("Ephemeral field is already defined"), caught by running this
      // against aws/spans before shipping it. Same reason for every other aggregate alias here.
      '    sum(cost_usd) as cost_total_usd by model',
      // ONLY the derived column here. Re-listing the stats columns to reorder them is also
      // "Ephemeral field is already defined" — same lesson, one line further down.
      '| fields hit_turns * 100 / turns as hit_rate_pct',
      '| sort turns desc',
    ].join('\n'),
  },
  // Turn outcome breakdown (P4): after error-disambiguation a benign empty/no-op turn reads
  // outcome=empty + finish=stop (NOT finish=error), and only genuine failures carry
  // status.code=ERROR. This query is the trust check — the `error` bucket should now ≈ real
  // failures, not cron-nudge empties (was 9 false-positive `error` spans in the sample).
  turn_outcomes: {
    logGroups: [SPANS_LG],
    query: [
      "filter attributes.agent_i32pz9.operation.name = 'agent_i073q7'",
      '| stats count(*) as turns by attributes.agentcore.turn.outcome as outcome, attributes.agent_i32pz9.response.finish_reasons as finish, status.code as status',
      '| sort turns desc',
    ].join('\n'),
  },
  // Per-tool spans (P1): child spans (agent_i32pz9.operation.name=execute_tool) nested under the turn.
  // Per-tool call count + latency + error rate — the trace-completeness win (tool calls used to be
  // invisible: only the parent agent_i073q7 span existed). durationNano/1e6 = span duration in ms.
  tool_spans: {
    logGroups: [SPANS_LG],
    query: [
      "filter attributes.agent_i32pz9.operation.name = 'execute_tool'",
      '| stats count(*) as calls, avg(durationNano/1000000) as avg_ms, max(durationNano/1000000) as max_ms by attributes.agent_i32pz9.tool.name as tool, status.code as status',
      '| sort calls desc | limit 50',
    ].join('\n'),
  },
  // Fleet errors (dispatcher log): pino level>=50 = errors (invoke failures, ensureRuntime
  // failures, etc.) across all agents — the one stable fleet error surface (replaces the
  // OpenClaw-era per-runtime gateway_errors / openclaw-otel errors_by_subsystem).
  fleet_errors: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, agent, msg, err.message as error',
      '| filter level >= 50',
      '| sort @timestamp desc | limit 50',
    ].join('\n'),
  },
  // On-demand agent spawns: the dispatcher mints a dedicated agent per unmapped
  // channel/DM (dm-<userId> / ch-<channelId>). Counts creations per agent so you can see
  // how many new channels/people got their own agent.
  agent_spawns: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields agent, channel',
      "| filter msg = 'agentcore runtime created'",
      '| stats count(*) as spawns, earliest(@timestamp) as first_seen by agent',
      '| sort first_seen desc | limit 100',
    ].join('\n'),
  },
  // Invoke outcomes (fleet): completed vs failed turns over time — the success signal.
  invoke_outcomes: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, msg',
      "| filter msg = 'agentcore invoke complete' or msg = 'agentcore invoke failed'",
      '| stats count(*) as turns by msg, bin(5m)',
    ].join('\n'),
  },
  // M3 stitch health: every runtime agent_i073q7 span carries trace.context_source —
  // 'payload-traceparent' means it parented under the dispatcher's invoke span (one
  // cross-boundary trace). Any other bucket = unstitched turns (fresh runtime trace):
  // x-amzn-trace-id-header would mean AgentCore's own ingress Root shadowed the stitch
  // (the S1 bug shape), absent means a pre-M3 image or a non-dispatcher caller.
  trace_stitch: {
    logGroups: [SPANS_LG],
    query: [
      "filter attributes.agent_i32pz9.operation.name = 'agent_i073q7'",
      // `sort` takes FIELD NAMES, not function calls: `sort bin(1h)` is a MalformedQueryException
      // ("unexpected symbol found ("). This widget had therefore NEVER rendered — it shipped
      // broken and stayed dark, which is why the stitch health it exists to show went unseen.
      // Alias the bin and sort the alias.
      '| stats count(*) as turns by attributes.trace.context_source as source, bin(1h) as ts',
      '| sort ts desc | limit 50',
    ].join('\n'),
  },
  // WHO is talking to which agent — the per-user cut the EMF metric deliberately omits (a user
  // dimension would be thousands of custom metrics). Free here: userId rides as an EMF property on
  // every MessagesReceivedCount record, so this is the dashboard-native replacement for the DynamoDB
  // table's user×agent view.
  messages_by_user: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, Agent, userId, channel, eventType',
      '| filter ispresent(MessagesReceivedCount)',
      '| stats count(*) as messages by userId, Agent',
      '| sort messages desc | limit 50',
    ].join('\n'),
  },

  // M2 dispatcher phase spans: the provisioning saga + invoke legs as spans (request →
  // provision{mount_targets,access_point,runtime_ready,name_release_wait} → agent_i073q7).
  // name_release_wait is the P3-B DELETING-window wait (~3.5-5 min when a teardown races a
  // recreate). There is no warmup span since 2026-08-11 — provisioning spends no model turn, so
  // the invoke under a cold provision IS the user's own turn. The live debugging view for
  // "where did that turn's time go".
  dispatcher_spans: {
    logGroups: [SPANS_LG],
    query: [
      'fields @timestamp, name, durationNano/1000000 as duration_ms, traceId',
      '| filter name like /^dispatcher\\./',
      '| sort @timestamp desc | limit 50',
    ].join('\n'),
  },

  // ── M4.6: cron inventory + validity ────────────────────────────────────────
  // Answers "what crons exist, in which channel/DM, when do they next run, and are they valid"
  // WITHOUT exec'ing into the dispatcher to hit /cron/:agentId — which is how the 2026-08-09
  // investigation had to be run. Sourced from the per-job EMF record (CronJobRecord).
  cron_inventory: {
    logGroups: [DISPATCHER_LG],
    query: [
      'filter ispresent(CronJobRecord)',
      // LATEST record per (agent, job NAME) — not per jobId. CronJobRecord is re-emitted on every
      // 15-min sweep AND on change, and a job deleted+recreated under the same name gets a NEW
      // jobId, so `dedup agent, job` returned one row per historical jobId: live, `whale-every-2min`
      // showed 4 rows all reading enabled=1 when only one was still emitting. Each dead row is a
      // truthful snapshot of a job that WAS enabled — the stream has no tombstone, so recency is
      // the only honest liveness signal. `record_at` surfaces it: a live job's record is <16 min old.
      //
      // TRADE-OFF: job identity in the store is agentId+jobId (cron-store keyOf) and names are not
      // unique, so two genuinely-live jobs sharing a name on one agent collapse to one row. Accepted
      // because name-collision-over-time is precisely the defect being fixed, and this widget answers
      // "what is configured now" rather than "enumerate every record".
      '| stats latest(@timestamp) as record_at_ms, latest(JobId) as job, latest(target) as destination,',
      '  latest(Mode) as delivery_mode, latest(status) as delivery_status, latest(enabled) as is_enabled,',
      '  latest(schedule.kind) as sched_kind,',
      // scheduleOf() only set `expr` for kind:'cron', so a bare schedule.expr was BLANK for every
      // `every`/`at` job. The emitter now carries expr for all kinds, but this synthesis stays as the
      // back-compat path for records already in the log (and for a rollback).
      // `if()` is required, not coalesce: concat() coerces a missing field to '', so the everyMs
      // branch returns the non-null "every ms" and wins the coalesce for `at` jobs.
      "  latest(if(schedule.kind = 'every', concat('every ', schedule.everyMs, 'ms'), if(schedule.kind = 'at', concat('at ', schedule.at), schedule.expr))) as sched_expr,",
      '  latest(schedule.tz) as tz, latest(nextRunAtMs) as next_run_ms, latest(lastRunAtMs) as last_run_ms,',
      '  latest(lastRunStatus) as last_run_status, latest(sessionTarget) as session',
      // An alias must NOT reuse its source field name (`latest(status) as status`) — that is a
      // "Cycle found in operation dependency graph" compile error. Hence the renamed columns.
      '  by Agent as agent, coalesce(name, JobId) as job_name',
      // fromMillis MUST come AFTER the stats: inside latest() the timestamp type is lost and the raw
      // epoch number comes back. Renders "2026-08-11 08:00:00.000" (UTC) — CWL QL has no strftime,
      // so this is as close to RFC3339 as a query can get without pre-formatting in the emitter.
      '| fields fromMillis(record_at_ms) as record_at, fromMillis(next_run_ms) as next_run, fromMillis(last_run_ms) as last_run',
      '| sort record_at_ms desc',
      '| display agent, job_name, job, destination, delivery_mode, delivery_status, is_enabled, sched_kind, sched_expr, tz, next_run, last_run, last_run_status, session, record_at',
      '| limit 200',
    ].join('\n'),
  },
  // The misconfigured set, most-actionable first. `announce-missing-channel` fails on EVERY fire
  // (chat.postMessage with channel:undefined -> invalid_arguments). `no-delivery` is quieter and
  // arguably worse: it fires forever and posts nothing, and is invisible to CronDeliveryFailure
  // by construction because it never attempts a delivery.
  cron_misconfigured: {
    logGroups: [DISPATCHER_LG],
    query: [
      // Same latest-per-name collapse + schedule synthesis as cron_inventory (it had the identical
      // duplicate-row and blank-sched_expr defects).
      'filter ispresent(CronJobRecord)',
      '| stats latest(@timestamp) as record_at_ms, latest(JobId) as job, latest(target) as destination,',
      '  latest(Mode) as delivery_mode, latest(status) as delivery_status, latest(enabled) as is_enabled,',
      '  latest(schedule.kind) as sched_kind,',
      "  latest(if(schedule.kind = 'every', concat('every ', schedule.everyMs, 'ms'), if(schedule.kind = 'at', concat('at ', schedule.at), schedule.expr))) as sched_expr,",
      '  latest(nextRunAtMs) as next_run_ms',
      '  by Agent as agent, coalesce(name, JobId) as job_name',
      // SINGLE quotes: CWL string literals are single-quoted and DOUBLE quotes denote a FIELD name,
      // so the previous `status != "ok"` compared status to a field called `ok` — i.e. this widget
      // was not actually filtering to the misconfigured set at all.
      "| filter delivery_status != 'ok'",
      '| fields fromMillis(record_at_ms) as record_at, fromMillis(next_run_ms) as next_run',
      '| sort record_at_ms desc',
      '| display agent, job_name, job, destination, delivery_mode, delivery_status, is_enabled, sched_kind, sched_expr, next_run, record_at',
      '| limit 100',
    ].join('\n'),
  },
  // Delivery failures with the context needed to fix them (agent, job, mode, channel, error).
  cron_delivery_failures: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, Agent as agent, JobId as job, name, mode, channel, deliveryError as error',
      '| filter ispresent(CronDeliveryFailure)',
      '| sort @timestamp desc | limit 100',
    ].join('\n'),
  },
  // Deletion audit: who removed what, and when. Before CronJobRemoved a removal left no trace at
  // all — the only signal was a CronJobRecord ceasing to appear, so "which job did I just delete?"
  // could only be answered by diffing snapshots. NB this is REQUESTED removal only; a one-shot
  // self-deletes inside the runner and never reaches this path.
  cron_removals: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, Agent as agent, JobId as job, name, mode, channel,',
      '  scheduleKind as sched, scheduleExpr as expr, enabled, reason',
      '| filter ispresent(CronJobRemoved)',
      '| sort @timestamp desc | limit 100',
    ].join('\n'),
  },
  // §3a' CUTOVER PROGRESS. Which scopes archie is DECLINING to fire, because their CRON_RUNNER is
  // still `openclaw`. A gated tick writes nothing to the store by design, so this log line and the
  // CronFireGated metric are the whole of the record — and this is the query that answers the two
  // questions the cutover turns on: "is archie still holding back on everything we have not moved"
  // and, immediately after a flip, "did this scope stop appearing".
  cron_gated: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, Agent as agent, JobId as job, name, runner, runnerSource as source',
      '| filter ispresent(CronFireGated)',
      '| stats count() as declinedTicks, latest(@timestamp) as lastTick by agent, runner, source',
      '| sort declinedTicks desc | limit 100',
    ].join('\n'),
  },
  // Fires vs delivery failures over time — the gap is the silent-failure surface.
  cron_fires_vs_failures: {
    logGroups: [DISPATCHER_LG],
    query: [
      'fields @timestamp, agent, jobId, msg',
      '| filter msg in ["cron fire completed", "cron delivery failed"]',
      '| stats count(*) as n by msg, bin(1h)',
    ].join('\n'),
  },
  // --- TTFM: time to first model call (the turn-latency SLO, target p99 < 10s) ---------
  // See the TTFM join fragments above for why these are two-stage joins and what the
  // measurement boundary actually is. Rendered by deploy-latency-dashboard.cjs.
  // Headline trend: is the fleet inside the 10s p99 budget, and is it moving? 15-min bins.
  ttfm_trend: {
    logGroups: [SPANS_LG],
    query: [
      TTFM_FILTER,
      TTFM_STAGE1,
      TTFM_KEEP,
      '| fields chat_start - req_start as gap_ms',
      '| stats pct(gap_ms, 99) as p99_ms, pct(gap_ms, 95) as p95_ms, pct(gap_ms, 50) as p50_ms by bin(ts, 15m)',
    ].join('\n'),
  },
  // Which half of the budget is being spent: the dispatcher leg (request → runtime turn
  // starts: queue + provision + warmup + InvokeAgentRuntime) vs the runtime leg (turn start
  // → first model call: session load, prompt build, SDK dispatch, model TTFT). As of
  // 2026-08-12 the runtime leg is flat (~2.4s p50 / 4.9s p99) and the dispatcher leg owns the
  // entire tail (p99 ~103s), so this widget is the one that says whether a fix landed.
  ttfm_legs: {
    logGroups: [SPANS_LG],
    query: [
      `${TTFM_FILTER} or name = 'agent_i073q7'`,
      TTFM_STAGE1_LEGS,
      TTFM_KEEP_LEGS,
      '| fields rt_start - req_start as dispatch_ms, chat_start - rt_start as runtime_ms',
      '| stats pct(dispatch_ms, 99) as dispatch_p99_ms, pct(runtime_ms, 99) as runtime_p99_ms by bin(ts, 15m)',
    ].join('\n'),
  },
  // Per-agent TTFM, worst p99 first — fleet-wide (every agent the dispatcher routed to),
  // so a single pathological agent can't hide inside the fleet percentile.
  agent_ldzgpn: {
    logGroups: [SPANS_LG],
    query: [
      TTFM_FILTER,
      `${TTFM_STAGE1}, earliest(attributes.dispatcher.agent) as agent`,
      TTFM_KEEP,
      '| fields chat_start - req_start as gap_ms',
      '| stats count(*) as turns, pct(gap_ms,50) as p50_ms, pct(gap_ms,90) as p90_ms, pct(gap_ms,99) as p99_ms, max(gap_ms) as max_ms by agent',
      '| sort p99_ms desc | limit 30',
    ].join('\n'),
  },
  // TTFM per RUNTIME INSTANCE (not per agent) — the cut that separates two failure modes a
  // per-agent view actively hides. Verified over 7d, 2026-08-12:
  //   • turns=1 with p50 == p99 ≈ 28-45s, many such rows — the FIRST turn on a freshly created
  //     instance. This is the real cold signal, and it is TRACE-INDEPENDENT: the provision-span
  //     test ("does this trace contain dispatcher.provision?") misses burst turns that waited on
  //     ANOTHER trace's provision, so it undercounts cold. Instance identity does not.
  //   • a healthy instance reads p50 2-7s over many turns with one big max (its own first turn).
  //   • oc_sandbox_person79b333_test-TNGKEu9t2E: 58 turns at p50 54.5s — an instance that was slow for
  //     EVERY turn, which is NOT a cold start and is invisible per-agent (that agent's per-agent
  //     p50 is 4.6s). Chronically-bad instances need finding and rolling, not waiting out.
  // The fp8 in the name also makes "did the roll fix it?" a group-by instead of a log-group join
  // (see SPAN_RUNTIME_ARN_FIELD); same fp8 + different suffix = delete→recreate of one spec.
  agent_ldzgpn_runtime: {
    logGroups: [SPANS_LG],
    query: [
      TTFM_FILTER,
      `${TTFM_STAGE1}, earliest(${TTFM_RUNTIME_ARN}) as runtime_arn`,
      TTFM_KEEP,
      '| parse runtime_arn /:runtime\\/(?<runtime>[^\\/]+)/',
      '| fields chat_start - req_start as gap_ms',
      '| stats count(*) as turns, pct(gap_ms,50) as p50_ms, pct(gap_ms,99) as p99_ms, max(gap_ms) as max_ms, min(ts) as first_turn, max(ts) as last_turn by runtime',
      '| sort p99_ms desc | limit 30',
    ].join('\n'),
  },
  // Cold vs warm: what share of turns take each path, what each path's p99 is, and — the number
  // that actually directs effort — how many SECONDS of the fleet's total TTFM each path burns.
  // Verified 7d to 2026-08-12: cold = 44 turns (7.6%) / p50 29.1s / p99 259.9s / 1,643s total;
  // warm = 535 (92.4%) / p50 3.2s / p99 97.8s / 5,198s total. So the 92% warm path owns 76% of
  // all TTFM seconds despite a 3.2s median — the tail, not the median, is where the budget goes.
  ttfm_cold_vs_warm: {
    logGroups: [SPANS_LG],
    query: [
      TTFM_PHASE_FILTER,
      TTFM_PHASE_STAGE1,
      '| stats count(*) as turns, pct(total_ms,50) as p50_ms, pct(total_ms,95) as p95_ms,',
      '    pct(total_ms,99) as p99_ms, max(total_ms) as max_ms, sum(total_ms)/1000 as total_s',
      `  by ${TTFM_COLD_KEY}`,
    ].join('\n'),
  },
  // CUMULATIVE time by phase, split cold/warm, with each phase as a % of that path's total. This
  // is "what parts take up the highest cumulative total of the sum of TTFM" — the sum view, not
  // the percentile view, so a cheap-but-constant phase can outrank a rare expensive one.
  // Verified 7d: cold → provision 57% / claim 36% / prep 6% / dispatch 0.5%;
  //              warm → dispatch 73% / prep 27%. Fleet-wide dispatch is the single biggest bucket
  // (~55% of ALL TTFM seconds), which is turns queued behind a runtime that is not ready yet —
  // NOT provisioning itself (~14%). The lever is not making provisioning faster, it is not making
  // other turns wait on it.
  ttfm_phase_share: {
    logGroups: [SPANS_LG],
    query: [
      TTFM_PHASE_FILTER,
      TTFM_PHASE_STAGE1,
      '| stats count(*) as turns, sum(total_ms)/1000 as total_s, sum(dispatch_ms)/1000 as dispatch_s,',
      '    sum(provision_ms)/1000 as provision_s, sum(claim_ms)/1000 as claim_s, sum(prep_ms)/1000 as prep_s',
      `  by ${TTFM_COLD_KEY}`,
      // Only the DERIVED columns go in this `fields` — re-listing a column that already exists
      // (cold/turns/total_s/…) fails with "Ephemeral field is already defined". The stats columns
      // are carried through automatically, so the table shows seconds and % side by side.
      '| fields dispatch_s/total_s*100 as dispatch_pct, provision_s/total_s*100 as provision_pct,',
      '    claim_s/total_s*100 as claim_pct, prep_s/total_s*100 as prep_pct',
    ].join('\n'),
  },
  // The same cumulative view over TIME (stacked): total seconds of TTFM contributed per phase per
  // hour. Band height = where the day's time went; a fix should visibly shrink one band.
  ttfm_phase_trend: {
    logGroups: [SPANS_LG],
    query: [
      TTFM_PHASE_FILTER,
      TTFM_PHASE_STAGE1,
      '| stats sum(dispatch_ms)/1000 as dispatch_s, sum(provision_ms)/1000 as provision_s,',
      '    sum(claim_ms)/1000 as claim_s, sum(prep_ms)/1000 as prep_s by bin(ts, 1h)',
    ].join('\n'),
  },
  // Slow spots inside the provisioning saga + the AWS control-plane calls it makes, ranked by
  // CUMULATIVE time rather than worst case. NB nesting: dispatcher.provision.runtime_ready
  // CONTAINS its CreateAgentRuntime/GetAgentRuntime children, so parent and child rows overlap —
  // read it as "which step, then which call inside it", not as a partition. The `claim_ms` phase
  // has NO spans of its own (nothing instruments post-READY container claim), so it cannot appear
  // here; that is a real instrumentation gap, not an absence of cost.
  ttfm_slow_spots: {
    logGroups: [SPANS_LG],
    query: [
      "filter name like /^dispatcher\\.provision/ or name like /^BedrockAgentCoreControl\\./ or name like /^EFS\\./ or name like /^IAM\\./",
      '| fields durationNano/1000000 as dur_ms',
      '| stats count(*) as calls, pct(dur_ms,50) as p50_ms, pct(dur_ms,99) as p99_ms,',
      '    max(dur_ms) as max_ms, sum(dur_ms)/1000 as total_s by name',
      '| sort total_s desc | limit 25',
    ].join('\n'),
  },
  // WHERE THE DISPATCHER LEG GOES. With provisioning off the warm path, `request -> agent_i073q7`
  // became the dominant TTFM term: measured 2026-08-13 over 38 warm turns, the dispatcher leg was
  // p50 3,564ms / p99 21,665ms while the runtime leg held at p50 2,674ms / p99 3,587ms. It was one
  // opaque block, so the p99 breach could only be described by what it was NOT (not the concurrency
  // bounds — all reported zero waiting; not per-session serialisation — depth 1, wait <=1ms; not Slack
  // rate limiting — no 429s). These child spans partition it.
  //
  // session_slot is the odd one out and the most diagnostic: it measures time QUEUED behind other turns
  // on the same thread, i.e. the only part of the leg that is not this turn's own work.
  ttfm_dispatcher_phases: {
    logGroups: [SPANS_LG],
    query: [
      "filter name in ['dispatcher.user_profile', 'dispatcher.prior_context', 'dispatcher.session_slot', 'dispatcher.stream_start', 'dispatcher.ensure_runtime']",
      '| fields durationNano/1000000 as dur_ms',
      '| stats count(*) as spans, pct(dur_ms,50) as p50_ms, pct(dur_ms,99) as p99_ms,',
      '    max(dur_ms) as max_ms, sum(dur_ms)/1000 as total_s by name',
      '| sort total_s desc',
    ].join('\n'),
  },
  // The same phases over time, so a regression is attributable to a deploy rather than to "it feels
  // slow". Per-phase p99 rather than avg: the tail is the SLO, and an average hides it.
  ttfm_dispatcher_phase_trend: {
    logGroups: [SPANS_LG],
    query: [
      "filter name in ['dispatcher.user_profile', 'dispatcher.prior_context', 'dispatcher.session_slot', 'dispatcher.stream_start', 'dispatcher.ensure_runtime']",
      '| fields durationNano/1000000 as dur_ms',
      '| stats pct(dur_ms,99) as p99_ms by bin(15m), name',
    ].join('\n'),
  },
  // SESSION FIRST-USE vs REUSE, straight off the span attributes rather than inferred.
  //
  // This split was originally recovered by classifying the platform leg's bimodal latency (~118ms reused
  // vs ~2,505ms new) — fine for one analysis, wrong to build on. `session.first_use` is now stamped on
  // dispatcher.request, so the split is a fact and joins directly against TTFM.
  //
  // Grouped by TRIGGER because the two populations behave oppositely and averaging them says nothing:
  // Slack is ~87% first-use (89% of threads get exactly one message — structural, not a fault), cron is
  // ~66% reused (per-job session keys, stable across fires).
  ttfm_session_reuse: {
    logGroups: [SPANS_LG],
    query: [
      // `= 1 or = 0` rather than ispresent(): the flags are emitted as 1/0 NUMBERS because a BOOLEAN
      // span attribute is invisible to Insights (verified — ispresent() on a boolean matched zero rows
      // on a span that demonstrably carried it, while a numeric attribute on the same span matched).
      "filter name = 'dispatcher.request' and (attributes.session.first_use = 1 or attributes.session.first_use = 0)",
      '| fields attributes.dispatcher.trigger as trigger, attributes.session.first_use as first_use,',
      '    attributes.session.idle_expired as idle_expired',
      '| stats count(*) as turns, sum(idle_expired = 1) as idle_expired_turns by trigger, first_use',
      '| sort trigger asc, first_use desc',
    ].join('\n'),
  },
  // The ACTIONABLE one on its own: turns where we HAD the session and lost it to the idle timeout, so we
  // paid full new-session cost on something that could have been warm. Baseline ~2 Slack turns/day, which
  // is why idleRuntimeSessionTimeout stayed at 900s — a sustained rise is what would justify raising it.
  // The gap distribution says how much a higher timeout would actually recover.
  ttfm_session_idle_expired: {
    logGroups: [SPANS_LG],
    query: [
      "filter name = 'dispatcher.request' and attributes.session.idle_expired = 1",
      '| fields attributes.dispatcher.agent as agent, attributes.session.last_use_age_ms/1000 as gap_s',
      '| stats count(*) as expired_turns, pct(gap_s,50) as gap_p50_s, max(gap_s) as gap_max_s by agent',
      '| sort expired_turns desc | limit 25',
    ].join('\n'),
  },
  // THE PRE-WARM SCOREBOARD. Phase 2's success criterion is "miss rate -> 0", and this is how it is read.
  //
  // From the EMF metric log rather than spans, because the outcome is emitted per turn by the dispatcher
  // and carries the agent + the runtime generation as properties — the spans have no equivalent.
  //
  // The four outcomes must NOT be summed into two: `coalesced` is the herd collapsing as designed (one
  // provision, N waiters), so folding it into `miss` makes a WORKING roll look like a pre-warm failure.
  // `late_hit` means the provision BOUND delayed the turn, not the provision — a different fix
  // (raise MAX_CONCURRENT_PROVISIONS) from a genuine miss (pre-warm did not reach this agent).
  runtime_cache_outcomes: {
    logGroups: [DISPATCHER_LG],
    query: [
      // Scoped to the RESOLVE-MS lines, NOT to `ispresent(outcome)`. `outcome` is a generic property name
      // that other emitters use too — connector provisioning writes outcome='skipped' — so filtering on it
      // silently mixed two unrelated metrics into one scoreboard (caught live: a phantom 'skipped' row).
      // One line per turn carries RuntimeCacheResolveMs, so this is also the correct turn count.
      'fields Agent as agent, outcome, RuntimeCacheResolveMs as resolve_ms',
      '| filter ispresent(RuntimeCacheResolveMs)',
      '| stats count(*) as turns, pct(resolve_ms,50) as p50_ms, pct(resolve_ms,99) as p99_ms by outcome',
      '| sort turns desc',
    ].join('\n'),
  },
  // Per-agent, because pre-warm coverage is per agent: a fleet hit rate of 95% hides the handful of
  // agents pre-warm never reaches, and those agents are exactly the complaint that arrives.
  agent_kwuho5: {
    logGroups: [DISPATCHER_LG],
    query: [
      // Grouped by (agent, outcome) rather than pivoted with sum(outcome = '...'): comparing a STRING
      // inside sum() does not compile in Insights (numeric comparisons do), and it fails at
      // start-query time — invisible on a dashboard, which just renders empty.
      // Excludes the dimensionless 'fleet' aggregate, which would double every row.
      'fields Agent as agent, outcome',
      "| filter ispresent(RuntimeCacheResolveMs) and agent != 'fleet'",
      '| stats count(*) as turns by agent, outcome',
      '| sort agent asc, turns desc',
    ].join('\n'),
  },
  // The SLO breach list: individual turns over the 10s budget, with the leg split and the
  // traceId to click through to the trace. This is the work queue for getting p99 under 10s.
  ttfm_breaches: {
    logGroups: [SPANS_LG],
    query: [
      `${TTFM_FILTER} or name = 'agent_i073q7'`,
      `${TTFM_STAGE1_LEGS}, earliest(attributes.dispatcher.agent) as agent`,
      TTFM_KEEP_LEGS,
      '| fields chat_start - req_start as total_ms, rt_start - req_start as dispatch_ms, chat_start - rt_start as runtime_ms',
      '| filter total_ms > 10000',
      '| sort total_ms desc | limit 50',
    ].join('\n'),
  },
  // TIME BEFORE THE CLOCK STARTED. Every TTFM query above measures from `dispatcher.request`, which
  // opens when a poller picks the message UP — so the wait between a Slack event being enqueued and
  // a poller reaching it was not merely unattributed, it was outside the measurement. This is that
  // wait, and it belongs on top of every TTFM number.
  ttfm_queue_wait: {
    logGroups: [SPANS_LG],
    query: [
      "filter name = 'dispatcher.request' and ispresent(attributes.dispatcher.queue_wait_ms)",
      '| fields attributes.dispatcher.queue_wait_ms as wait_ms, attributes.dispatcher.trigger as trigger,',
      '    attributes.dispatcher.queue_receive_count as receives',
      '| stats count(*) as turns, pct(wait_ms,50) as p50_ms, pct(wait_ms,95) as p95_ms,',
      '    pct(wait_ms,99) as p99_ms, max(wait_ms) as max_ms, sum(receives > 1) as redelivered',
      '  by trigger',
      '| sort turns desc',
    ].join('\n'),
  },
  // WHOSE PREPARE TIME. `prepare_turn` is the biggest slice of a fully warm turn, and it is two
  // costs welded together: our context assembly and Bedrock's time to first byte. Split, the answer
  // has been decisive every time it has been measured — context build is tens of milliseconds and
  // TTFB is seconds — so this query is what stops anyone optimising the wrong half.
  prepare_split: {
    logGroups: [SPANS_LG],
    query: [
      "filter attributes.agentcore.phase = 'prepare_turn' and ispresent(attributes.agentcore.prepare.context_build_ms)",
      '| fields attributes.agentcore.prepare.context_build_ms as build_ms,',
      '    attributes.agentcore.prepare.model_ttfb_ms as ttfb_ms',
      '| stats count(*) as turns, pct(build_ms,50) as build_p50, pct(build_ms,99) as build_p99,',
      '    pct(ttfb_ms,50) as ttfb_p50, pct(ttfb_ms,99) as ttfb_p99,',
      '    sum(build_ms)/1000 as build_s, sum(ttfb_ms)/1000 as ttfb_s',
      '  by bin(1h)',
      '| sort bin desc | limit 24',
    ].join('\n'),
  },
  // WAS THE 15 SECONDS OURS. A turn arriving at a container that has been up for seconds waited on
  // AgentCore scheduling; one arriving at a container whose uptime ~= the wait booted FOR it, and
  // that cost is ours (image size, adapter boot). Bucketed by uptime because the population is
  // trimodal, and an average over three modes is a number that describes no turn that ever ran.
  container_warmth: {
    logGroups: [SPANS_LG],
    query: [
      "filter name = 'agent_i073q7' and ispresent(attributes.agentcore.container.uptime_ms)",
      '| fields attributes.agentcore.container.uptime_ms as uptime_ms,',
      '    attributes.agentcore.container.turn_index as turn_index,',
      '    resource.attributes.service.name as agent',
      '| stats count(*) as turns, pct(uptime_ms,50) as uptime_p50, max(uptime_ms) as uptime_max',
      '  by turn_index > 1 as reused_container',
      '| sort reused_container desc',
    ].join('\n'),
  },
};

// --- Metric search specs (name -> CloudWatch SEARCH expression + stat) ---
// SEARCH() auto-discovers dimensions, robust to dimension shape changes.
// Use the schema-agnostic SEARCH form `Namespace="..." MetricName="..."` — the
// `{Namespace}` form matches only zero-dimension metrics (AgentCore metrics carry
// dimensions, so it returns nothing).
const METRICS = {
  invocations: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="Invocations"', 'Sum', 300)`, stat: 'Sum', label: 'Invocations' },
  latency: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="Latency"', 'p95', 300)`, stat: 'p95', label: 'Latency p95' },
  duration: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="Duration"', 'Average', 300)`, stat: 'Average', label: 'Duration avg' },
  errors: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="Errors"', 'Sum', 300)`, stat: 'Sum', label: 'Errors' },
  userErrors: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="UserErrors"', 'Sum', 300)`, stat: 'Sum', label: 'UserErrors' },
  systemErrors: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="SystemErrors"', 'Sum', 300)`, stat: 'Sum', label: 'SystemErrors' },
  throttles: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="Throttles"', 'Sum', 300)`, stat: 'Sum', label: 'Throttles' },
  activeSessions: { expr: `SEARCH('Namespace="AWS/Bedrock-AgentCore" MetricName="ActiveSessionCount"', 'Maximum', 300)`, stat: 'Maximum', label: 'ActiveSessions' },
  inputTokens: { expr: `SEARCH('Namespace="ApplicationSignals" MetricName="InputTokens"', 'Sum', 300)`, stat: 'Sum', label: 'Input tokens' },
  outputTokens: { expr: `SEARCH('Namespace="ApplicationSignals" MetricName="OutputTokens"', 'Sum', 300)`, stat: 'Sum', label: 'Output tokens' },
  // Cold-boot duration — the Pi adapter emits this as an EMF metric (namespace AgentCore/Pi,
  // dimension Agent) once per microVM cold boot. Plot RAW per-agent SEARCH series (avg + max
  // per minute); all sit in the ~1s band. NB do NOT wrap in AVG()/metric-math — AVG divides by
  // the count of ALL agent series (mostly null in any minute), which understates ~10x.
  coldBoot: { expr: `SEARCH('Namespace="AgentCore/Pi" MetricName="ColdBootMs"', 'Average', 60)`, stat: 'Average', label: 'Cold boot avg (ms, per agent)' },
  coldBootMax: { expr: `SEARCH('Namespace="AgentCore/Pi" MetricName="ColdBootMs"', 'Maximum', 60)`, stat: 'Maximum', label: 'Cold boot max (ms, per agent)' },
  // Boot concurrency: total microVM cold boots per minute across the fleet — SUM over the
  // SampleCount series is correct (a count total, unlike AVG). Each new thread/session = a boot.
  bootConcurrency: { expr: `SUM(SEARCH('Namespace="AgentCore/Pi" MetricName="ColdBootMs"', 'SampleCount', 60))`, label: 'Cold boots / min (fleet)' },
  // Connector posture, per agent. Emitted once per boot by pi-entrypoint when an agent falls back to
  // the SHARED Connector key. This is deliberately NOT alarmed: the shared key works (prod's shared
  // project holds real connected accounts), it just means every agent using it can reach every
  // connection in that one project. So the series is a MIGRATION PROGRESS BAR — each agent that
  // drops off it has been given a project of its own — and the per-agent breakout is the remaining
  // worklist. `ConnectorUnprovisioned` is the sibling metric for the genuinely-broken case (no key at
  // all) and that one does alarm. See connector-provisioning-plan.md "Migration pathway".
  connectorSharedKey: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="ConnectorSharedKey"', 'Sum', 300)`, stat: 'Sum', label: 'Boots on the SHARED Connector key (per agent)' },
  connectorUnprovisioned: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="ConnectorUnprovisioned"', 'Sum', 300)`, stat: 'Sum', label: 'Boots with NO Connector key (per agent)' },
  // Connector inline provisioning (phase 3, namespace ClawdbotDispatcher/agent-gn0p84Dispatcher).
  // PROVISIONED should rise as ConnectorSharedKey falls — together they are the migration burn-down.
  // BLOCKED is a WORKLIST, not a fault: the agent's project exists and cannot be keyed by API, so a
  // human must mint one in the console. FAILED is the only one with an alarm behind it.
  // LATENCY exists to CHECK the parallelism claim rather than assume it — this leg runs alongside
  // the mount-target/access-point waits, so it is free only while it finishes inside them. Compare
  // it against the provision-phase widget directly above.
  connectorProvisioned: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ConnectorProvisionedCount"', 'Sum', 300)`, stat: 'Sum', label: 'Connector projects provisioned' },
  connectorBlocked: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ConnectorProvisionBlockedCount"', 'Sum', 300)`, stat: 'Sum', label: 'Connector BLOCKED — needs a console key (worklist)' },
  connectorProvisionFailed: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ConnectorProvisionFailedCount"', 'Sum', 300)`, stat: 'Sum', label: 'Connector provision FAILED (alarmed)' },
  connectorProvisionMs: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ConnectorProvisionMs"', 'Maximum', 300)`, stat: 'Maximum', label: 'Connector provision max (ms) — must stay under the parallel phase' },
  // Turn metrics (P2) — the Pi adapter emits these EMF metrics per turn (namespace AgentCore/Pi,
  // dims Agent and Agent+Model). Use the schema-pinned SEARCH form `{Namespace,Agent}` so we match
  // the per-Agent series ONLY (not the Agent+Model schema too) — avoids double-counting Sum metrics.
  // These turn dashboards + alarms into 1-line metric queries instead of span scans.
  turnLatencyP90: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnLatencyMs"', 'p90', 300)`, stat: 'p90', label: 'Turn latency p90 (ms, per agent)' },
  turnLatencyAvg: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnLatencyMs"', 'Average', 300)`, stat: 'Average', label: 'Turn latency avg (ms, per agent)' },
  turnTtftP90: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TtftMs"', 'p90', 300)`, stat: 'p90', label: 'TTFT p90 (ms, per agent)' },
  turnTokensInput: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnTokensInput"', 'Sum', 300)`, stat: 'Sum', label: 'Input tokens / turn (per agent)' },
  turnTokensOutput: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnTokensOutput"', 'Sum', 300)`, stat: 'Sum', label: 'Output tokens / turn (per agent)' },
  // Prompt-cache token volumes — cache read/write is a big chunk of real context + cost that
  // usage.input alone hides. TurnTokensContext = input+cacheRead+cacheWrite = the TRUE prompt size.
  turnCacheReadTokens: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnCacheReadTokens"', 'Sum', 300)`, stat: 'Sum', label: 'Cache-read tokens / turn (per agent)' },
  turnCacheWriteTokens: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnCacheWriteTokens"', 'Sum', 300)`, stat: 'Sum', label: 'Cache-write tokens / turn (per agent)' },
  turnTokensContext: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnTokensContext"', 'Sum', 300)`, stat: 'Sum', label: 'True prompt tokens (input+cache) / turn (per agent)' },
  // Cache-hit RATE — TurnCacheHit is 1 when the turn reused a cached prefix, else 0; Average over
  // invocations = fraction of turns that hit cache (0..1). Per-Agent schema-pinned like the rest.
  turnCacheHitRate: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnCacheHit"', 'Average', 300)`, stat: 'Average', label: 'Cache-hit rate (0..1, per agent)' },
  turnErrors: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnErrorCount"', 'Sum', 300)`, stat: 'Sum', label: 'Turn errors (real, per agent)' },
  // Cost (P3) — TurnCostUsd EMF (USD per turn, from pi-ai's computed cost). Sum = spend per agent;
  // SUM-over-agents = fleet spend. Emitted only when pi-ai reports a cost (no fabricated values).
  turnCost: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="TurnCostUsd"', 'Sum', 300)`, stat: 'Sum', label: 'Cost USD / turn (per agent)' },
  // Session-shape (P6) — snapshot per turn of the conversation's shape. Session length / human-AI
  // balance / compaction frequency / live context size. Bounded to the Agent dim.
  sessionLengthTurns: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="SessionLengthTurns"', 'Average', 300)`, stat: 'Average', label: 'Session length (turns, avg per agent)' },
  aiResponses: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="AiResponses"', 'Average', 300)`, stat: 'Average', label: 'AI responses / session (avg)' },
  humanResponses: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="HumanResponses"', 'Average', 300)`, stat: 'Average', label: 'Human responses / session (avg)' },
  compactionEvents: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="CompactionEvents"', 'Maximum', 300)`, stat: 'Maximum', label: 'Compactions / session (max)' },
  contextLengthTokens: { expr: `SEARCH('{AgentCore/Pi,Agent} MetricName="ContextLengthTokens"', 'Average', 300)`, stat: 'Average', label: 'Context length (tokens, avg per agent)' },
  // Dispatcher operational metrics (dispatcher-observability M1 / D6) — namespace ClawdbotDispatcher,
  // emitted by the dispatcher itself (EMF-via-stdout), NOT the runtime. Provisioning-saga phase
  // durations + the total (ProvisionRuntimeReadyMs lands ~30s cold per bench-cold-provision.mjs) and
  // the invoke-leg latency / cold-retries. Schema-pinned to the Agent dim (SEARCH '{Namespace,Agent}')
  // to match the per-agent series; a period of 60 keeps the sparse provision metric visible.
  provisionTotalP90: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ProvisionRuntimeReadyMs"', 'p90', 60)`, stat: 'p90', label: 'Provision→READY p90 (ms, ~30s) (per agent)' },
  provisionTotalMax: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ProvisionRuntimeReadyMs"', 'Maximum', 60)`, stat: 'Maximum', label: 'Provision→READY max (ms) (per agent)' },
  provisionRuntimeReadyMs: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ProvisionRuntimeCreateReadyMs"', 'Average', 60)`, stat: 'Average', label: 'CreateRuntime→READY avg (ms) (per agent)' },
  provisionAccessPointMs: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ProvisionAccessPointReadyMs"', 'Average', 60)`, stat: 'Average', label: 'Access-point ready avg (ms) (per agent)' },
  provisionMountTargetsMs: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="ProvisionMountTargetsReadyMs"', 'Average', 60)`, stat: 'Average', label: 'Mount-targets ready avg (ms) (per agent)' },
  runtimeCreatedCount: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="RuntimeCreatedCount"', 'Sum', 300))`, label: 'Runtimes created (fleet)' },
  accessPointCreatedCount: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="AccessPointCreatedCount"', 'Sum', 300))`, label: 'Access points created (fleet)' },
  provisionErrorCount: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="ProvisionErrorCount"', 'Sum', 300))`, label: 'Provision errors (fleet)' },
  invokeLatencyP90: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="InvokeLatencyMs"', 'p90', 300)`, stat: 'p90', label: 'Invoke latency p90 (ms) (per agent)' },
  invokeColdRetries: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="InvokeColdRetries"', 'Sum', 300))`, label: 'Invoke cold retries (fleet)' },
  invokeErrorCount: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="InvokeErrorCount"', 'Sum', 300))`, label: 'Invoke errors (fleet)' },

  // Per-session queue (per-message isolation). Turns for one Slack thread run strictly one at a
  // time, so a burst QUEUES rather than overlapping — and the wait, not the work, becomes what a
  // user feels. Measured live 2026-08-11 during a 15-message burst: dispatcher.request p50 35s vs
  // dispatcher.agent_i073q7 p50 8s, i.e. ~77% of perceived latency at p50 (and ~88% at p90) was
  // QUEUE WAIT. That was only derivable by subtracting two span durations; these make it first-class.
  // Rejected should sit flat at zero — a non-zero rate means MAX_SESSION_QUEUE is too low for real
  // use (it was 8, which a hand-typed 11-message burst blew straight through).
  sessionQueueWaitP50: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueWaitMs"', 'p50', 300)`, stat: 'p50', label: 'Queue wait p50 (ms) (per agent)' },
  sessionQueueWaitP90: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueWaitMs"', 'p90', 300)`, stat: 'p90', label: 'Queue wait p90 (ms) (per agent)' },
  sessionQueueWaitMax: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueWaitMs"', 'Maximum', 300)`, stat: 'Maximum', label: 'Queue wait max (ms) (per agent)' },
  sessionQueueDepthMax: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueDepth"', 'Maximum', 300)`, stat: 'Maximum', label: 'Queue depth max (turns outstanding) (per agent)' },
  sessionQueueDepthAvg: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueDepth"', 'Average', 300)`, stat: 'Average', label: 'Queue depth avg (1 = no waiting)' },
  sessionQueueRejected: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueRejectedCount"', 'Sum', 300))`, label: 'Queue REJECTED — backpressure (fleet, want 0)' },
  sessionQueueBacklog: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="SessionQueueBacklogCount"', 'Sum', 300))`, label: 'Queue BACKLOG >=200 — alarmed (fleet, want 0)' },
  // No fleet image published — a hard outage signal, since there is no baked fallback image by
  // design (a fallback would silently run whatever build the dispatcher shipped with).
  // A runtime generation rolled — the agent's immutable spec changed (image, EFS root, an env var…).
  // ONE dispatcher env change rolls every agent on its next turn at ~30s of provisioning each, so
  // this is the widget that turns "everything felt slow for a while" into an answer. The reason rides
  // as an EMF property (searchable in Logs Insights), not a dimension.
  runtimeGenerationRolls: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="RuntimeGenerationRollCount"', 'Sum', 300))`, label: 'Runtime generation rolls (fleet)' },
  imagePointerMissing: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="ImagePointerMissingCount"', 'Sum', 300))`, label: 'NO fleet image published — alarmed (want 0)' },

  // ── AgentCore account quota (`Total Agents per Account`, L-F4575653) ──────
  // The only ceiling on this board with NO AWS-published series behind it: resource-COUNT quotas in
  // bedrock-agentcore emit no AWS/Usage metric (only the per-second rate quotas do), so Service
  // Quotas cannot alarm on it and this number exists solely because the dispatcher counts it
  // (runtime-quota-metrics.js). The schema is `{Namespace}` with NO dimension — that dimensionless
  // series is the one the alarm is built on; the Status cut below is a separate schema and must not
  // be summed into it (the two partition the same population).
  //
  // Read the two lines TOGETHER: the fleet holds `agents x live image tags` runtimes, and a roll
  // stages the next tag before collecting the last, so the count that matters is the peak DURING a
  // roll, not the resting one.
  agentRuntimeCount: { expr: `SEARCH('{${DISPATCHER_NS}} MetricName="AgentRuntimeCount"', 'Maximum', 300)`, stat: 'Maximum', label: 'Agent runtimes in the account' },
  agentRuntimeQuota: { expr: `SEARCH('{${DISPATCHER_NS}} MetricName="AgentRuntimeQuota"', 'Maximum', 300)`, stat: 'Maximum', label: 'Quota (adjustable)' },
  // DELETING is counted in the total above — the name and the quota slot are held for the ~5 minutes
  // a delete takes. This cut is what separates "we own 900 runtimes" from "we own 700 and are waiting
  // on 200 deletes", which is the difference between requesting an increase and waiting.
  agentRuntimeByStatus: { expr: `SEARCH('{${DISPATCHER_NS},Status} MetricName="AgentRuntimeCount"', 'Maximum', 300)`, stat: 'Maximum', label: 'Runtimes by status' },

  // ── Message volume (namespace ClawdbotDispatcher) ─────────────────────────
  // Inbound Slack messages, per agent and fleet-wide. This existed ONLY in the DynamoDB
  // `message-metrics` table until 2026-08-11, whose sole reader is the ALB-fronted `archie` chart
  // service — so with that service scaled to 0 (and no ALB under AgentCore) message volume had no
  // visible surface at all, while the table kept counting.
  //
  // Counts messages RECEIVED and routed, NOT replies delivered: the counter fires after routing
  // resolves an agent and before the turn is forwarded, so a turn that later fails still counts.
  // Pair it with turnErrors to read it correctly.
  //
  // Per-USER breakdown stays in DynamoDB deliberately: `Agent` is bounded (~208) but a user
  // dimension would be thousands × 208 custom metrics. The userId rides as an EMF property, so
  // messages_by_user below answers "who" out of Logs Insights for free.
  messagesReceived: { expr: `SEARCH('{${DISPATCHER_NS},Agent} MetricName="MessagesReceivedCount"', 'Sum', 300)`, label: 'Messages received (per agent)' },
  messagesReceivedFleet: { expr: `SUM(SEARCH('{${DISPATCHER_NS},Agent} MetricName="MessagesReceivedCount"', 'Sum', 300))`, label: 'Messages received (fleet)' },

  // ── M4: cron inventory + validity (namespace ClawdbotCron) ────────────────
  // Configured/enabled are GAUGES snapshotted every 60s, so Maximum (not Sum) is the correct
  // statistic — Sum would multiply by the number of ticks in the period.
  cronJobsConfigured: { expr: `SEARCH('{${CRON_NS},Agent} MetricName="CronJobsConfigured"', 'Maximum', 300)`, stat: 'Maximum', label: 'Cron jobs configured (per agent)' },
  cronJobsEnabled: { expr: `SEARCH('{${CRON_NS},Agent} MetricName="CronJobsEnabled"', 'Maximum', 300)`, stat: 'Maximum', label: 'Cron jobs enabled (per agent)' },
  // Per (Channel, Mode) — `Channel=none` paired with `Mode=announce` is the misconfiguration
  // fingerprint. Channel alone conflates a broken announce with a legitimate webhook/side-effect job.
  cronJobsByChannelMode: { expr: `SEARCH('{${CRON_NS},Channel,Mode} MetricName="CronJobsConfigured"', 'Maximum', 300)`, stat: 'Maximum', label: 'Cron jobs by channel + mode' },
  // At-rest validity, per reason. Only non-ok jobs emit, so a flat zero/empty series == clean fleet.
  cronJobsMisconfigured: { expr: `SEARCH('{${CRON_NS},Reason} MetricName="CronJobsMisconfigured"', 'Maximum', 300)`, stat: 'Maximum', label: 'Cron jobs MISCONFIGURED (by reason)' },
  // Failure counters (events, not gauges) — Sum is correct here.
  cronDeliveryFailure: { expr: `SUM(SEARCH('{${CRON_NS},Agent} MetricName="CronDeliveryFailure"', 'Sum', 300))`, label: 'Cron delivery failures (fleet)' },
  cronFailureAlert: { expr: `SUM(SEARCH('{${CRON_NS},Agent} MetricName="CronFailureAlert"', 'Sum', 300))`, label: 'Cron failureAlert threshold hits (fleet)' },
  // Churn: requested removals. An EVENT, so Sum (not Maximum like the gauges).
  cronJobRemoved: { expr: `SUM(SEARCH('{${CRON_NS},Agent} MetricName="CronJobRemoved"', 'Sum', 300))`, label: 'Cron jobs removed (fleet)' },
  // §3a': ticks archie DECLINED because the scope's CRON_RUNNER is still `openclaw`. Per-agent, not
  // summed to the fleet, because the useful reading is which scopes are still held back — and a
  // series that goes flat after a flip is the confirmation the flip took effect.
  cronFireGated: { expr: `SEARCH('{${CRON_NS},Agent} MetricName="CronFireGated"', 'Sum', 300)`, label: 'Cron fires DECLINED — scope still on OpenClaw' },
};

// =====================================================================================
// SCOPE-PINNED corpus — the same signals, restricted to ONE agent (its own scope).
// =====================================================================================
// Everything above is FLEET-shaped: `aws/spans` is one account-wide Transaction Search store and
// the dispatcher log is one fleet log, so an agent reading them sees every other agent's telemetry.
// IAM cannot fix that — Logs Insights authorizes StartQuery against LOG GROUP ARNs and has no
// row/field-level condition key, and cloudwatch:GetMetricData supports no resource-level
// permissions at all. So own-scope is enforced HERE, at the query, and the tools that use these
// builders are the baseline (`otel`) tier; the unscoped corpus above — and the ad-hoc
// query/logGroups escape hatch — moved behind the granted `otel.fleet` capability. See
// agentcore-pi/otel-tool.mjs.
//
// The scope keys were verified live against the sandbox stores (2026-08-11), NOT assumed:
//   • agent_i32pz9 spans     → `resource.attributes.service.name` == the agent id (createExporter passes
//                        serviceName: AGENT_NAME). Exact and generation-independent, which is what
//                        makes it the right SCOPE key.
//                        CORRECTION (2026-08-12): an earlier note here said cloud.resource_id "came
//                        back EMPTY on every span". It is not empty — it is a RESOURCE attribute, so
//                        it lives at `resource.attributes.cloud.resource_id` and a query against
//                        `attributes.cloud.resource_id` returns nothing. AgentCore sets it in the
//                        container's OTEL_RESOURCE_ATTRIBUTES (confirmed by reading /proc/1/environ
//                        in a live runtime) and our exporter MERGES rather than replaces, so both
//                        keys are present on every span. It is the RUNTIME INSTANCE ARN — see
//                        SPAN_RUNTIME_ARN_FIELD below for what that buys that service.name cannot.
//   • dispatcher spans → `attributes.dispatcher.agent` (service.name is 'slack-dispatcher'). NB the
//                        dispatcher.provision.* CHILD spans carry no agent attribute — only the
//                        request/agent_i073q7 spans do (which is why trace scoping is ownership-
//                        gated rather than per-span filtered; see scopedTraceQuery).
//   • dispatcher log   → pino `agent` on the fleet lines, EMF `Agent` on the cron records.
//   • own runtime log  → inherently per-agent: /aws/bedrock-agentcore/runtimes/<runtimeName>-*,
//                        where runtimeName is derived from the agent id (runtimeLogGroupBase).
const DISPATCHER_SERVICE = process.env.DISPATCHER_SERVICE_NAME || 'slack-dispatcher';
const SPAN_AGENT_FIELD = 'resource.attributes.service.name';
const SPAN_DISPATCHER_AGENT_FIELD = 'attributes.dispatcher.agent';
const RUNTIME_LG_PREFIX = '/aws/bedrock-agentcore/runtimes/';

// The full runtime-instance ARN, platform-set on every span:
//   arn:aws:bedrock-agentcore:<region>:<acct>:runtime/oc_<agent>_<fp8>-<awsSuffix>/runtime-endpoint/DEFAULT:DEFAULT
// NOT a substitute for SPAN_AGENT_FIELD as a scope key — it changes on every roll, so pinning scope
// to it would silently drop a turn's history at each generation. It answers a DIFFERENT question:
// WHICH RUNTIME INSTANCE served this turn. service.name cannot express that at all, because it is
// the agent id and therefore identical across every generation the agent has ever run.
//
// Three things fall out of the name embedded in it (verified live over a 48h window, 2026-08-12):
//   • fp8      — the spec fingerprint, so a turn can be attributed to a GENERATION. Roll
//                verification ("did this turn run on the new image?") stops needing a log-group
//                join and becomes a group-by.
//   • suffix   — AWS's per-instance id. The SAME fp8 with a DIFFERENT suffix is a delete→recreate
//                of an unchanged spec (the fleet-roll path), which is a materially different event
//                from a spec change and was previously indistinguishable in telemetry.
//   • absence  — a name with no `_fp8` segment at all is PRE-generation naming, i.e. a runtime that
//                predates generational rolls and has never been rolled since.
// It also maps 1:1 onto the runtime's log group, so span→logs is exact rather than the prefix match
// runtimeLogGroupMatcher has to do (with the collision caveat documented there).
const SPAN_RUNTIME_ARN_FIELD = 'resource.attributes.cloud.resource_id';

// Runtime name out of that ARN: `.../runtime/<name>/runtime-endpoint/...`, tolerating the bare
// `.../runtime/<name>` form. Returns null rather than a partial parse — a caller grouping by this
// must be able to tell "no attribution" from "attributed to something".
function runtimeNameFromArn(arn) {
  const m = /:runtime\/([^/]+)/.exec(String(arn ?? ''));
  return m ? m[1] : null;
}

// Split that name into its parts. `fp8` is null for pre-generation names, which is a real state and
// not a parse failure — hence `generational` as an explicit flag rather than making callers infer it
// from a null. The fp8 is exactly 8 hex chars (agentcore-client.js generationRuntimeName), so it is
// distinguishable from an agent id that merely contains underscores.
function parseRuntimeName(name) {
  const s = String(name ?? '');
  const m = /^(.*?)_([0-9a-f]{8})-([^-]+)$/.exec(s);
  if (m) return { agentPart: m[1], fp8: m[2], awsSuffix: m[3], generational: true };
  const bare = /^(.*)-([^-]+)$/.exec(s);
  if (bare) return { agentPart: bare[1], fp8: null, awsSuffix: bare[2], generational: false };
  return { agentPart: s || null, fp8: null, awsSuffix: null, generational: false };
}

// Turn TRIGGERS that correspond to an inbound Slack message, i.e. the ones that should have a
// matching MessagesReceivedCount record. VERIFIED against the live span store (2026-08-11): the
// runtime span's `attributes.agentcore.turn.trigger` carries the SLACK EVENT TYPE, because the
// dispatcher passes `trigger: event.type || 'user'` (index.js) — observed values are `message`,
// `app_mention`, `cron`, and `warmup` (synthetic; the warm-up path was deleted 2026-08-11, so those
// only appear in historical windows). NOT `user|cron`, which is what the emit-site comment claims.
//
// This list is the JOIN KEY between the two stores: `MessagesReceivedCount`'s `eventType` property is
// emitted from the same two Slack handlers with the same two values, so inbound-messages and
// message-triggered-turns are directly comparable — that difference is the dropped-turn signal.
const SLACK_TRIGGERS = ['message', 'app_mention'];

// Every scope literal is interpolated into a CloudWatch query string, so it is validated rather
// than escaped: agent ids are `[a-z0-9._-]` by construction (dm-<userId> / ch-<channelId> / a
// named agent), and anything else is a misconfigured AGENT_NAME or an injection attempt — either
// way the query must not be built. CWL has no bind parameters, so this guard IS the sanitizer.
function assertSafeScopeLiteral(value, what = 'scope') {
  const s = String(value ?? '');
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s)) {
    throw new Error(`${what} "${s}" is not a safe query literal (expected [A-Za-z0-9._-]{1,128})`);
  }
  return s;
}

// The runtime log-group NAME PREFIX for one agent, mirroring the dispatcher's runtime naming
// (agentcore-client.js sanitizeRuntimeName / generationRuntimeName): `oc_<sanitized agent>`, then
// either `_<fp8>-<suffix>-DEFAULT` (generation naming) or `-<suffix>-DEFAULT` (pre-generation).
// Deliberately stops BEFORE that separator so both shapes match; callers must still confirm the
// separator (see runtimeLogGroupMatcher) because a bare prefix would also match a longer agent id
// that happens to start with this one — the same collision isGenerationOf() guards against.
function runtimeLogGroupBase(agentId) {
  const s = assertSafeScopeLiteral(agentId, 'agentId').replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return `oc_${s || 'agent'}`.slice(0, 39);
}
const runtimeLogGroupPrefix = (agentId) => `${RUNTIME_LG_PREFIX}${runtimeLogGroupBase(agentId)}`;
const runtimeLogGroupMatcher = (agentId) => {
  const base = runtimeLogGroupBase(agentId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${RUNTIME_LG_PREFIX}${base}[-_]`);
};

// --- Scoped Logs Insights builders (agentId -> { logGroups, query }) ------------------
// Each mirrors a fleet query above but pins the scope in the FIRST filter, so the restriction is
// applied by CloudWatch before any stats/sort — not trimmed from the rows afterwards.

// My turns: one row per model turn, newest first, with the traceId to hand to otel_my_trace.
const scopedTurnsQuery = (agentId) => ({
  logGroups: [SPANS_LG],
  query: [
    `filter attributes.agent_i32pz9.operation.name = 'agent_i073q7' and ${SPAN_AGENT_FIELD} = '${assertSafeScopeLiteral(agentId)}'`,
    '| fields @timestamp, attributes.session.id as session, attributes.agent_i32pz9.request.model as model,',
    '  attributes.agent_i32pz9.usage.input_tokens as in_tokens, attributes.agent_i32pz9.usage.output_tokens as out_tokens,',
    '  attributes.agent_i32pz9.response.finish_reasons as finish, attributes.agentcore.turn.outcome as outcome,',
    '  attributes.agentcore.turn.trigger as trigger,',
    '  status.code as status, durationNano/1000000 as duration_ms,',
    '  attributes.trace.context_source as trace_source, traceId,',
    // Which runtime instance served this turn. Cheap to carry (already on the span) and it is the
    // field that turns "everything was slow around 14:00" into "those turns ran on a new generation".
    `  ${SPAN_RUNTIME_ARN_FIELD} as runtime_arn`,
    '| sort @timestamp desc | limit 50',
  ].join('\n'),
});

// My runtime generations: one row per RUNTIME INSTANCE that served a turn, with the window it served
// and how much. This is the roll history — see SPAN_RUNTIME_ARN_FIELD for why service.name cannot
// produce it.
//
// stats-by on the raw ARN rather than a parsed name because CWL has no regex-extract in a group key;
// callers parse the rows with runtimeNameFromArn/parseRuntimeName. Sorted by `last_turn` so the
// CURRENT runtime is row 0 — the usual question is "what am I on now, and when did that change?".
//
// The alias is bound in `fields` and grouped by the ALIAS, not by the dotted path: CWL rejects
// `stats … by <dotted.path> as alias`. Aliasing early also keeps the group key off a name that
// collides with its own source (which produces "Cycle found in operation dependency graph" —
// the same trap that forced `job_channel` in scopedCronInventoryQuery).
const scopedGenerationsQuery = (agentId) => ({
  logGroups: [SPANS_LG],
  query: [
    `filter attributes.agent_i32pz9.operation.name = 'agent_i073q7' and ${SPAN_AGENT_FIELD} = '${assertSafeScopeLiteral(agentId)}'`,
    `| fields ${SPAN_RUNTIME_ARN_FIELD} as runtime_arn, durationNano/1000000 as duration_ms`,
    '| stats count(*) as turns,',
    '    earliest(@timestamp) as first_turn,',
    '    latest(@timestamp) as last_turn,',
    '    avg(duration_ms) as avg_duration_ms',
    '  by runtime_arn',
    '| sort last_turn desc | limit 50',
  ].join('\n'),
});

// Who sent ME messages, and through which Slack surface. Sourced from the MessagesReceivedCount EMF
// record, which is emitted once per ROUTED inbound message (after routing resolves this agent, before
// the turn is forwarded) and carries userId/channel/eventType as PROPERTIES — a userId DIMENSION
// would be thousands of custom metrics, so the per-user cut is only expressible as a log query.
// Deduplicated at the source: both Slack handlers share isDuplicateEvent(client_msg_id), and Slack
// fires BOTH a `message` and an `app_mention` event for one @mention, so this is one row per real
// message rather than two.
const scopedMessagesQuery = (agentId) => ({
  logGroups: [DISPATCHER_LG],
  query: [
    `filter ispresent(MessagesReceivedCount) and Agent = '${assertSafeScopeLiteral(agentId)}'`,
    '| stats count(*) as messages, earliest(@timestamp) as first_at, latest(@timestamp) as last_at by userId, eventType',
    '| sort messages desc | limit 50',
  ].join('\n'),
});

// My tool calls: the execute_tool child spans, aggregated per tool.
const scopedToolsQuery = (agentId) => ({
  logGroups: [SPANS_LG],
  query: [
    `filter attributes.agent_i32pz9.operation.name = 'execute_tool' and ${SPAN_AGENT_FIELD} = '${assertSafeScopeLiteral(agentId)}'`,
    '| fields attributes.agent_i32pz9.tool.name as tool, status.code as span_status, durationNano/1000000 as ms',
    '| stats count(*) as calls, avg(ms) as avg_ms, max(ms) as max_ms by tool, span_status',
    '| sort calls desc | limit 50',
  ].join('\n'),
});

// My permission denials, from THIS agent's own runtime log (the PEP's per-decision EMF record —
// pi-adapter onPermissionSignal). Answers "why can't I call X": a denial names the capability that
// needs granting. logGroups are resolved per call (own runtime generations) — see otel-tool.
const scopedDenialsQuery = () => ({
  query: [
    "filter msg = 'permission_decision' and decision = 'deny'",
    '| stats count(*) as denials, latest(@timestamp) as last_at_ms by tool, capability',
    '| sort denials desc | limit 50',
  ].join('\n'),
});

// My runtime's own errors/warnings (own runtime log group, all generations).
const scopedRuntimeErrorsQuery = () => ({
  query: [
    "filter level = 'error' or level = 'warn' or msg like /fail/",
    '| fields @timestamp, component, msg, err, error',
    '| sort @timestamp desc | limit 50',
  ].join('\n'),
});

// One trace, whole tree. NOT scope-filtered per span, deliberately: dispatcher.provision.* children
// carry no agent attribute, so a per-span filter would hide exactly the provisioning legs that
// explain a slow turn. Ownership is instead gated in the tool — it proves ≥1 span in the trace is
// this agent's, then drops any span attributed to a DIFFERENT agent (a fan-out trace) and keeps the
// unattributed dispatcher internals. A traceId is 128-bit and the agent only learns its own from
// otel_my_turns, so this is a proof-of-possession check, not an enumeration surface.
const scopedTraceQuery = (traceId) => ({
  logGroups: [SPANS_LG],
  query: [
    `filter traceId = '${assertSafeScopeLiteral(traceId, 'traceId')}'`,
    `| fields @timestamp, name, ${SPAN_AGENT_FIELD} as svc, ${SPAN_DISPATCHER_AGENT_FIELD} as dispatcher_agent,`,
    '  attributes.agent_i32pz9.operation.name as op, durationNano/1000000 as duration_ms,',
    '  attributes.agent_i32pz9.request.model as model, attributes.agent_i32pz9.tool.name as tool,',
    '  attributes.agent_i32pz9.usage.input_tokens as in_tokens, attributes.agent_i32pz9.usage.output_tokens as out_tokens,',
    '  status.code as status, attributes.trace.context_source as ctx, parentSpanId, spanId',
    '| sort @timestamp asc | limit 300',
  ].join('\n'),
});

// My crons: the latest CronJobRecord per job name for THIS agent (same latest-per-name collapse and
// schedule synthesis as cron_inventory — see the trade-offs documented there), plus this agent's
// delivery failures and removals. `channel` is a convenience narrowing, not a boundary: every job
// in the result already belongs to this agent's own scope.
const scopedCronInventoryQuery = (agentId, channel) => ({
  logGroups: [DISPATCHER_LG],
  query: [
    `filter ispresent(CronJobRecord) and Agent = '${assertSafeScopeLiteral(agentId)}'`
      + (channel ? ` and channel = '${assertSafeScopeLiteral(channel, 'channel')}'` : ''),
    '| stats latest(@timestamp) as record_at_ms, latest(JobId) as job, latest(target) as destination,',
    // `latest(channel) as channel` would be a "Cycle found in operation dependency graph" compile
    // error — an alias may not reuse its own source field name (same trap as cron_inventory's
    // renamed columns). Hence job_channel.
    '  latest(channel) as job_channel, latest(Mode) as delivery_mode, latest(status) as delivery_status,',
    '  latest(enabled) as is_enabled, latest(schedule.kind) as sched_kind,',
    "  latest(if(schedule.kind = 'every', concat('every ', schedule.everyMs, 'ms'), if(schedule.kind = 'at', concat('at ', schedule.at), schedule.expr))) as sched_expr,",
    '  latest(schedule.tz) as tz, latest(nextRunAtMs) as next_run_ms, latest(lastRunAtMs) as last_run_ms,',
    '  latest(lastRunStatus) as last_run_status, latest(sessionTarget) as session',
    '  by coalesce(name, JobId) as job_name',
    '| fields fromMillis(record_at_ms) as record_at, fromMillis(next_run_ms) as next_run, fromMillis(last_run_ms) as last_run',
    '| sort record_at_ms desc',
    '| display job_name, job, destination, job_channel, delivery_mode, delivery_status, is_enabled, sched_kind, sched_expr, tz, next_run, last_run, last_run_status, session, record_at',
    '| limit 100',
  ].join('\n'),
});

const scopedCronFailuresQuery = (agentId) => ({
  logGroups: [DISPATCHER_LG],
  query: [
    `filter (ispresent(CronDeliveryFailure) or ispresent(CronJobRemoved)) and Agent = '${assertSafeScopeLiteral(agentId)}'`,
    '| fields @timestamp, JobId as job, name, mode, channel, deliveryError as error, reason,',
    "  if(ispresent(CronJobRemoved), 'removed', 'delivery_failed') as kind",
    '| sort @timestamp desc | limit 50',
  ].join('\n'),
});

// My dispatcher legs: routing/provisioning/invoke as the dispatcher saw them (its pino log), scoped
// to this agent. The counterpart to scopedTurnsQuery — a turn that never reached the runtime has no
// span here but does have a dispatcher line.
const scopedDispatcherQuery = (agentId) => ({
  logGroups: [DISPATCHER_LG],
  query: [
    `filter agent = '${assertSafeScopeLiteral(agentId)}'`,
    '| fields @timestamp, level, msg, channel, err.message as error',
    '| sort @timestamp desc | limit 50',
  ].join('\n'),
});

// --- Scoped metrics ------------------------------------------------------------------
// Most METRICS above are already schema-pinned to the Agent dimension (`SEARCH('{NS,Agent} …')`),
// so scoping one is a matter of adding an `Agent="<id>"` token to the SEARCH — which restricts the
// series SEARCH resolves, the only per-agent narrowing available anywhere in the metrics path (IAM
// offers none). Namespaces WITHOUT an Agent dimension (AWS/Bedrock-AgentCore, ApplicationSignals)
// are therefore NOT scopeable and are excluded from the scoped tier — fail closed, no silent
// fleet-wide read. Returns null when a metric can't be pinned.
function scopedMetricExpr(name, agentId) {
  const spec = METRICS[name];
  if (!spec) return null;
  const agent = assertSafeScopeLiteral(agentId);
  // Schema-pinned per-Agent form: SEARCH('{Namespace,Agent} MetricName="X"', …)
  if (/\{[^}]*,Agent\}/.test(spec.expr)) return spec.expr.replace(/MetricName="([^"]+)"/, `MetricName="$1" Agent="${agent}"`);
  // Namespace-form AgentCore/Pi metrics (coldBoot…) also carry the Agent dimension.
  if (spec.expr.includes(`Namespace="AgentCore/Pi"`)) return spec.expr.replace(/MetricName="([^"]+)"/, `MetricName="$1" Agent="${agent}"`);
  return null;
}
const isScopeableMetric = (name) => scopedMetricExpr(name, 'probe') !== null;

// The curated self-health set for otel_my_runtime — one GetMetricData call answering "how is MY
// runtime doing": cold boots, turn latency/TTFT, the dispatcher's provisioning saga, per-session
// queue wait (the biggest felt-latency contributor per the 2026-08-11 burst measurement), errors,
// denials, generation rolls. All Agent-dimensioned, hence all scopeable.
// `messagesReceived` is DEMAND, not health — included because latency is only interpretable against
// load: "slow" during a 15-message burst and "slow" on a single message are different faults, and
// queue wait alone doesn't distinguish them.
const SELF_HEALTH_METRICS = [
  'messagesReceived',
  'coldBoot', 'coldBootMax', 'turnLatencyP90', 'turnTtftP90', 'turnErrors',
  'provisionTotalP90', 'invokeLatencyP90', 'invokeColdRetries',
  'sessionQueueWaitP90', 'sessionQueueDepthMax', 'runtimeGenerationRolls',
];

module.exports = {
  REGION,
  AGENT,
  STACK,
  SPANS_LG,
  DISPATCHER_LG,
  // Exported so a caller (the dashboard deploy) can report/verify what it resolved to.
  DISPATCHER_NS,
  CRON_NS,
  INSIGHTS,
  METRICS,
  // scope-pinned surface
  DISPATCHER_SERVICE,
  SPAN_AGENT_FIELD,
  SPAN_DISPATCHER_AGENT_FIELD,
  SPAN_RUNTIME_ARN_FIELD,
  RUNTIME_LG_PREFIX,
  SLACK_TRIGGERS,
  SELF_HEALTH_METRICS,
  assertSafeScopeLiteral,
  runtimeNameFromArn,
  parseRuntimeName,
  runtimeLogGroupBase,
  runtimeLogGroupPrefix,
  runtimeLogGroupMatcher,
  scopedGenerationsQuery,
  scopedTurnsQuery,
  scopedMessagesQuery,
  scopedToolsQuery,
  scopedDenialsQuery,
  scopedRuntimeErrorsQuery,
  scopedTraceQuery,
  scopedCronInventoryQuery,
  scopedCronFailuresQuery,
  scopedDispatcherQuery,
  scopedMetricExpr,
  isScopeableMetric,
};

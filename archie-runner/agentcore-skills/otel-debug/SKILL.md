---
name: otel-debug
description: Debug your own OTEL telemetry — token usage, tool calls, latency/cold starts, queue wait, errors, cost, scheduled jobs, and end-to-end traces — using the otel_my_turns, otel_my_tools, otel_my_trace, otel_my_crons and otel_my_runtime tools (plus the fleet-wide otel_fleet_* tools if you hold the otel.fleet grant). Use when asked to investigate performance, token/cost blowups, tool behaviour, failures, resource contention, cron/schedule problems, or "where did that turn's time go" on the AgentCore (Pi) runtimes and the Slack dispatcher.
---

# Debugging your OTEL telemetry

Your observability signals are queryable inline, read-only, in two tiers.

## Tier 1 — your own telemetry (always available)

These five tools are **scope-pinned**: every query filters on your own agent identity before
aggregating, and every metric is pinned to your own `Agent` dimension. You cannot widen them, and
they never return another agent's data. Region is `us-east-1`; every tool takes `since`
(`"30m"`, `"3h"`, `"24h"`, `"7d"`).

- **`otel_my_turns`** — your recent turns: model, in/out tokens, finish reason, outcome
  (reply/empty/error), what triggered it, duration, `traceId`, plus a latency/token rollup **and how
  many inbound Slack messages you were sent over the same window**, so a message you never answered
  is visible. `byUser=true` adds who messaged you and via which surface (message vs @mention);
  `withDispatcher=true` adds the dispatcher's own log lines for you (which show turns that never
  reached the runtime).
- **`otel_my_tools`** — your tool calls: per-tool count, avg/max ms, span status — **and your
  permission denials**, each naming the capability that would need granting.
- **`otel_my_trace`** — one of your turns end-to-end by `traceId`: dispatcher request → queue →
  provisioning → invoke → your turn → its model/tool children. A traceId that isn't yours returns
  `not_found`.
- **`otel_my_crons`** — your scheduled jobs: schedule, timezone, next/last run, delivery
  target/channel/mode, whether each is valid, plus recent delivery failures and removals.
  Optional `channel` narrows to one destination.
- **`otel_my_runtime`** — your runtime health: cold boots, turn latency/TTFT p90, real turn errors,
  the dispatcher's provisioning saga for you, per-session queue wait/depth, generation rolls, and
  recent errors from your own runtime log.

## Tier 2 — the whole fleet (needs the `otel.fleet` grant)

`otel_fleet_query`, `otel_fleet_metric` and `otel_fleet_trace` read **every** agent's telemetry, and
`otel_fleet_query` additionally accepts an ad-hoc `query` + `logGroups` (any log group the runtime
role can reach). They are default-denied: if you don't hold `otel.fleet` you won't see them, and
that's expected — reach for the `otel_my_*` tools instead. Their named corpus is the exact set the
`agentcore-fleet` CloudWatch dashboard is built from; call either with **no name** to list it.

## Pick the tool by symptom

| The question / symptom | Reach for |
|---|---|
| "How many tokens did that use?" / token blowup | `otel_my_turns` (per-turn in/out + model + duration) |
| Prompt-cache effectiveness, TRUE prompt size, spend | `otel_my_runtime` for latency/errors; fleet tier for `turnTokensContext`/`turnCacheHitRate`/`turnCost` |
| "Which of my tools is slow or failing?" | `otel_my_tools` (count / avg_ms / max_ms / status) |
| "Why was that tool refused?" | `otel_my_tools` → the `denials` list names the capability to grant |
| My turns succeeding vs empty vs erroring | `otel_my_turns` → `outcome` + `errorTurns` |
| "You ignored my message" / did I drop a turn? | `otel_my_turns` → `messagesWithoutTurn` (then `withDispatcher=true` for the cause) |
| "Who actually uses me?" / engagement | `otel_my_turns byUser=true` → messages per user × surface |
| "Why does this feel slow?" | `otel_my_runtime` — check **queue wait** first, then cold boot, then provisioning |
| Am I cold-booting a lot / did my runtime get rolled? | `otel_my_runtime` → `coldBoot`, `runtimeGenerationRolls` |
| "Where did THIS turn's time/tokens go?" | grab a `traceId` from `otel_my_turns`, then `otel_my_trace traceId=<id>` |
| "What am I scheduled to do?" / a cron didn't post | `otel_my_crons` — check `delivery_status != ok` and `record_at` freshness |
| Fleet-wide errors, other agents, spawns, ad-hoc queries | the `otel_fleet_*` tools (needs `otel.fleet`) |

## How to read the signals (gotchas worth knowing)

- **Queue wait is usually the answer to "it felt slow".** Turns for one thread run strictly one at a
  time, so a burst queues. Measured live: ~77% of perceived p50 latency during a 15-message burst was
  queue wait, not work. `otel_my_runtime` surfaces it directly (`sessionQueueWaitP90`,
  `sessionQueueDepthMax`); depth 1 means nothing was waiting.
- **A benign empty turn is not an error.** A cron nudge with nothing to say reads
  `outcome=empty, finish=stop` and `status=OK`. Only genuine failures carry `status=ERROR` — that's
  what `errorTurns` counts.
- **`otel_my_trace` includes the dispatcher's legs**, including the `dispatcher.provision.*`
  children, because that's where a slow cold turn spends its time. `ctx=payload-traceparent` on your
  `agent_i073q7` span confirms the cross-boundary trace stitched; anything else means the turn was
  recorded as a fresh trace. Durations are `durationNano/1e6` ms.
- **A live cron's `record_at` is under 16 minutes old.** Records are re-emitted every 15 minutes and
  the log has no tombstone, so an older row is a job that *was* configured, not one that still is.
  Two live jobs sharing a name collapse into one row.
- **Cold boot is per-agent** and sits in the ~1s band; `otel_my_runtime` gives yours directly rather
  than a fleet average (averaging across agents understates it ~10×, since most series are null in
  any given minute).
- **`otel_my_tools` reads denials from your own runtime log**, which exists per runtime *generation*.
  A just-rolled runtime has a fresh log, so widen `since` if denials look suspiciously absent.
- **Inbound messages and turns come from two different stores**, so read the direction carefully.
  `messagesWithoutTurn` (inbound > ran) is the fault signal — messages that reached the dispatcher and
  produced no turn. `turnsWithoutCountedMessage` (ran > inbound) is normally benign: the window
  predates the counter (deployed 2026-08-11) or a message fell just outside it. A `null`
  `messagesReceived` means *unknown*, never zero — a brand-new metric takes ~15 min to become
  searchable, so don't read an absent series as "no one messaged me".

## Method

1. Start with `otel_my_turns` or `otel_my_runtime` over a sensible window (`24h` for "recently",
   `1h` for "right now").
2. If one turn looks off, take its `traceId` and run `otel_my_trace` for the full breakdown.
3. Report concrete numbers (tokens, ms, counts) and name the model/tool involved — don't hand back
   raw JSON dumps.
4. Zero rows? Widen `since` before concluding nothing happened — the span store only populates when
   the runtime runs with `AGENTCORE_OTEL_MODE=xray`.
5. If you need another agent's data or an ad-hoc query and the `otel_fleet_*` tools aren't available,
   say so plainly and ask for the `otel.fleet` grant — don't try to work around the scope.

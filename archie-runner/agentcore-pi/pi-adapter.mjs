// Pi-only AgentCore adapter — the Bedrock AgentCore custom-container HTTP contract
// (GET /ping, POST /invocations) driving Pi's AgentSession directly. No OpenClaw
// gateway, no gateway-pool. Keeps the same contract as agentcore/agentcore-adapter.js
// but the turn internals are Pi. See pi-core-migration-plan.md §0.5.

import http from 'node:http';
import { mkdirSync, readFileSync, existsSync, statfsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { registerBedrock, getModel, runTurn, withModel, pca } from './pi-runtime.mjs';
import { refreshSessionConfig } from './session-config-refresh.mjs';
import { resolveSessionPath, writeIndexEntry } from './session-store.mjs';
import { outcomeAttributes } from './tool-outcome.mjs';
import { resolveModelSpec, resolveAllowedTools, buildBuiltinTools, buildCustomTools, readBootstrapContext, makeResourceLoader, resolvePluginManifest, findUnavailablePlugins, resolveMcpPrefixes } from './config-map.mjs';
import { loadAgentConfig } from './agent-config.mjs';
import { buildCompatPlugins, prewarmCompatPlugins } from './openclaw-compat/plugin-host.mjs';
import { createHindsightExtension } from './hindsight-extension.mjs';
import { createClockExtension } from './clock-extension.mjs';
import { createModelContextExtension } from './model-context-extension.mjs';
import { makeCapabilityResolver, makeDecider, makeAllowCheck, policyRef } from './permissions/capabilities.mjs';
import { loadPolicyTable } from './permissions/policy-table.mjs';
import { createPermissionsExtension, makeCan } from './permissions/permissions-extension.mjs';
import { applyToolFilter } from './permissions/tool-filter.mjs';
import { buildProviderRegistry, checkClosure } from './permissions/provider-registry.mjs';
import { buildClientRecall } from './hindsight-client-recall.mjs';
import { wantsStream, encodeSse, finalEvent, errorEvent, SSE_HEADERS } from './sse-contract.mjs';
import * as bedrockMark from './bedrock-dispatch-mark.mjs';
import { planReplyMetrics } from './reply-usage.mjs';
import {
  usageIn, usageOut, cacheCostAttrs, turnUsageAttrs,
} from './usage-attrs.mjs';
import { classifyTurn } from './turn-outcome.mjs';
import { seedWorkspace } from './workspace-seed.mjs';
import { syncSkills } from './skill-sync.mjs';
import { skillFingerprint, scopeManifest, withAlwaysOn, filterPinnedSkills } from './skill-scope.mjs';
// Pure + importable (pi-adapter self-boots on import, so anything needing a unit test lives outside
// it — same reason skillFingerprint lives in skill-scope.mjs).
import { configFingerprint } from './config-fingerprint.mjs';
import { extractTraceContext } from './trace-context.mjs';
import { applyDispatcherToken } from './dispatcher-token.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';

// CJS require for the esbuild-bundled compat plugins (connector etc.) baked at /app/plugins.
const requireCjs = createRequire(import.meta.url);
// config-resolver ships in the image (COPY + npm install, brings its own aws-sdk); the DDB seed
// path lazy-loads its client + schema from here so the adapter needs no extra dependency.
const CONFIG_RESOLVER_DIR = process.env.CONFIG_RESOLVER_DIR
  || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'config-resolver');
// Baked config-seed (just the new-agent-skeleton now — skills/catalog live in DDB), COPYd in.
const CONFIG_SEED_DIR = process.env.CONFIG_SEED_DIR
  || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'config-seed');
const PLUGINS_DIR = process.env.PI_PLUGINS_DIR || '/app/plugins';

// OTEL agent_i32pz9.* span exporter (#15). One span per /invocations turn -> X-Ray OTLP
// (SigV4, collector-less), landing in aws/spans (Transaction Search) queryable by
// session id — the structured observability layer atop the (now-trusted) logs. Same
// module + agent_i32pz9.* attribute contract as the OpenClaw adapter, so the existing
// observability queries/dashboard apply. AGENTCORE_OTEL_MODE: xray|stdout|off.
const { createExporter } = requireCjs('./otel-export.cjs');
let otel = null; // set in boot()
// Token/cache/cost span attributes live in usage-attrs.mjs (importing this file runs boot(), so
// they were untestable here, and the turn/per-call sites must not drift apart).

// Resolve THIS runtime's own resource id for per-runtime span attribution (P0). The runtime ARN
// carries a random suffix minted at CreateAgentRuntime, so the dispatcher can't inject it into
// runtimeEnv() pre-create — but AgentCore injects OTEL_RESOURCE_ATTRIBUTES (carrying
// cloud.resource_id=<runtime endpoint ARN>) into every container BY DEFAULT (you opt out via
// DISABLE_ADOT_OBSERVABILITY), so the adapter self-reads it here. Feeding cloud.resource_id onto
// the agent_i32pz9 spans makes them attributable to a specific runtime in the GenAI Observability
// console (today they only carry the coarse service.name). AGENTCORE_RESOURCE_ID is an explicit
// override (takes precedence). Values are comma-separated key=value; ARNs contain ':' but no ','.
function resolveResourceId() {
  if (process.env.AGENTCORE_RESOURCE_ID) return process.env.AGENTCORE_RESOURCE_ID;
  const ra = process.env.OTEL_RESOURCE_ATTRIBUTES;
  if (!ra) return undefined;
  for (const pair of ra.split(',')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === 'cloud.resource_id') return pair.slice(eq + 1).trim() || undefined;
  }
  return undefined;
}

// AgentCore delivers execution-role creds via MMDS (IMDS-like) — NOT via
// AWS_PROFILE / AWS_ACCESS_KEY_ID env, which is what Pi's provider gate
// (@mariozechner/pi-ai env-api-keys.js) checks for amazon-bedrock. The SDK's
// default chain DOES reach MMDS, so resolve the creds and export them to env:
// this satisfies Pi's gate AND feeds the Bedrock client. Refresh before the
// assumed-role creds (~1h) expire. (Upstream: Pi's gate should also accept IMDS.)
async function refreshAwsEnvCreds() {
  // Lazy import so the adapter still boots where the package isn't installed
  // (e.g. local runs using AWS_PROFILE, which already satisfies Pi's gate).
  const { fromNodeProviderChain } = await import('@aws-sdk/credential-providers');
  // Save env creds before clearing: in AgentCore, creds come from MMDS (not env), so we clear
  // env + re-resolve from the chain to get FRESH assumed-role creds (env would be stale). But in
  // a LOCAL container the env creds are the ONLY source (no MMDS) — clearing them and re-resolving
  // fails ("Could not load credentials from any providers"), so restore them as the fallback.
  const saved = { id: process.env.AWS_ACCESS_KEY_ID, secret: process.env.AWS_SECRET_ACCESS_KEY, token: process.env.AWS_SESSION_TOKEN };
  delete process.env.AWS_ACCESS_KEY_ID;
  delete process.env.AWS_SECRET_ACCESS_KEY;
  delete process.env.AWS_SESSION_TOKEN;
  let c;
  try {
    c = await fromNodeProviderChain()();
  } catch (e) {
    if (saved.id) { // local/no-MMDS: keep the env creds we were given
      process.env.AWS_ACCESS_KEY_ID = saved.id;
      process.env.AWS_SECRET_ACCESS_KEY = saved.secret;
      if (saved.token) process.env.AWS_SESSION_TOKEN = saved.token;
      return undefined;
    }
    throw e;
  }
  process.env.AWS_ACCESS_KEY_ID = c.accessKeyId;
  process.env.AWS_SECRET_ACCESS_KEY = c.secretAccessKey;
  if (c.sessionToken) process.env.AWS_SESSION_TOKEN = c.sessionToken;
  return c.expiration;
}

const PORT = Number(process.env.AGENTCORE_ADAPTER_PORT || process.env.PORT || 8080);
const AGENT_NAME = process.env.AGENT_NAME || 'pi-agent';
// The account a POLICY row must claim to have been compiled for (§1.1), guarding a sandbox-compiled row
// reaching a prod runtime or the reverse.
//
// Set by runtimeEnv from the gateway's own `config.account` — the same value behind the derived role and
// the DynamoDB scope statement, so it is by construction the account this row is read from. §1.1
// specifies asserting against sts:GetCallerIdentity instead; the env var says the same thing without
// putting an STS call on the boot path, and it is the writer's claim being checked here, not the
// reader's identity.
//
// NULL ON A RUNTIME PROVISIONED BEFORE THIS KEY EXISTED, and that is the honest state rather than a
// fallback: `envs` is fingerprinted into the runtime name, so the key only appears on runtimes created
// after it was added, i.e. from the next roll onward. loadPolicyTable RECORDS a null as a skipped
// assertion rather than a pass, so the gap is visible in the log instead of looking like a check that
// ran. Do not default it to a literal account — a wrong guess would assert against the wrong value,
// which is worse than not asserting.
const EXPECTED_ACCOUNT = process.env.AGENTCORE_ACCOUNT || null;
// (Removed 2026-09-16.) Pi used to write `sessions.json` entries carrying an ABSOLUTE OpenClaw-style
// path so a rollback to the ECS gateway could open them. That symmetry is no longer wanted — sandbox:
// "it's fine if archie v1 can't read archie v2's session data" — and it was the reason archie shared
// a read-modify-write index with a live OpenClaw gateway, which is what destroyed every entry it
// ever wrote. Pointers are per-key files now and store a basename; see session-store.mjs.
const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
const DEFAULT_SESSION_ID = 'local-pi-default-session-0000000000000';
// EFS_DIR set only in VPC/EFS mode; else ephemeral /tmp (PUBLIC-mode boot POC).
const EFS_DIR = process.env.EFS_DIR;
const SESSIONS_DIR = process.env.PI_SESSIONS_DIR || (EFS_DIR ? join(EFS_DIR, 'sessions') : join(tmpdir(), 'pi-sessions'));
// Workspace == EFS mount root (flat, OpenClaw-compatible) so Pi reads the agent's
// existing MEMORY.md/memory/ in place — no cutover migration. Kept in sync with the
// entrypoint (which sets PI_WORKSPACE=EFS_DIR).
const CWD = process.env.PI_WORKSPACE || (EFS_DIR ? EFS_DIR : join(tmpdir(), 'pi-ws'));
// Skills are ephemeral + per-agent now (sandra-repo-removal Phase 3): materialized from DDB to
// LOCAL DISK (NOT EFS), scoped to the agent's marketplace installs, refreshed per turn on change.
// Local disk → no EFS round trips for skill reads; nothing to persist (DDB is the source).
//
// `~/skills`, NOT `<tmp>/pi-skills`, since 2026-09-15 — the path OpenClaw uses. Every word of the
// rationale above still holds (same container filesystem, same ephemerality, same DDB source); what
// changes is that the fleet's PROSE becomes true. Skill and workspace files across the config repo
// and the agents' own memories say `~/skills/<skill>/scripts/<x>.sh` — person79b333's MEMORY.md names that
// path as her "primary lookup method" for secrets — and under `<tmp>/pi-skills` every one of those
// was a confident instruction to a path that does not exist. Pi does inject each skill's absolute
// <location> into the prompt, so the model could recover; but a wrong hint competing with a right
// one is a bad trade when the alternative is one line.
//
// It also reaches what hydration CANNOT. `workspace-seed.mjs:51` is no-clobber ("never overwrite
// live EFS state"), so an agent's own MEMORY.md is permanently out of reach of any config change we
// could ship; moving the directory fixes those files without touching them.
//
// Overridable by PI_SKILLS_DIR, which nothing sets today — so this default IS the deployed path.
const SKILLS_DIR = process.env.PI_SKILLS_DIR || join(homedir(), 'skills');

// Cold-boot markers, shared epoch with any entrypoint (falls back to process start).
const BOOT_EPOCH_MS = Number(process.env.BOOT_EPOCH_MS) || Date.now();
const bootPhase = (name, extra) => console.log(`BOOT_PHASE name=${name} elapsed_ms=${Date.now() - BOOT_EPOCH_MS}${extra ? ` ${extra}` : ''}`);
// Permission decisions (OTEL): EMF ToolCall (every check) + ToolDenied (on deny) by Agent, with
// capability/decision/tool/channel as searchable properties; denials are greppable via
// msg=permission_decision. Called synchronously from the decider (tool_call hook + hindsight
// gates). ToolDenied is the day-one-enforcement catch-net (migration miss OR a real block) + the
// grant-request seed. Never throws.
function onPermissionSignal(sig) {
  try {
    const denied = sig.decision === 'deny';
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent'], []],
        Metrics: denied ? [{ Name: 'ToolCall', Unit: 'Count' }, { Name: 'ToolDenied', Unit: 'Count' }] : [{ Name: 'ToolCall', Unit: 'Count' }] }] },
      Agent: AGENT_NAME, capability: sig.capability, decision: sig.decision,
      // WHY, not just what. 'ambient' | 'granted' | 'ungranted' | 'pinned' | 'policy-denied' |
      // 'policy-unusable'. Without it a policy pin and a missing grant are the same log line with
      // opposite fixes, and 'policy-unusable' — a row that was written but failed validation, so the
      // scope is denying everything — is otherwise indistinguishable from an agent nobody granted
      // anything to. That one should page.
      ...(sig.reason ? { reason: sig.reason } : {}),
      ...(sig.tool ? { tool: sig.tool } : {}), ...(sig.channel ? { channel: sig.channel } : {}), ...(sig.surface ? { surface: sig.surface } : {}),
      // The connector action the call executes (GMAIL_SEND_EMAIL, SLACK_SEND_MESSAGE, …). A PROPERTY,
      // never a Dimension: dimensions multiply the metric's cardinality by every slug in every
      // toolkit, and `stats count() by slugs` in Logs Insights answers the same questions for free.
      // Slug only — permissions/third-party-slug.mjs never reads the arguments beside it (PII).
      ...(sig.slugs ? { slugs: sig.slugs } : {}),
      ToolCall: 1, ...(denied ? { ToolDenied: 1 } : {}),
      component: 'pi-adapter', msg: 'permission_decision',
    }));
  } catch { /* telemetry must never fail a turn */ }
}

function emitColdBootMetric(ms) {
  try {
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent']], Metrics: [{ Name: 'ColdBootMs', Unit: 'Milliseconds' }] }] },
      Agent: AGENT_NAME, ColdBootMs: ms, component: 'pi-adapter', msg: 'cold_boot_metric',
    }));
  } catch { /* metrics must never break boot */ }
}

// The agent FAILED TO BOOT and is about to exit 1. Emitted from the single top-level handler, not
// from each throw site: boot() resolves creds, registers Bedrock, installs the dispatch mark, loads
// config, prewarms plugins, starts OTEL and listens — any of which is fatal, and all of which
// deserve the same alarm. Per-site metrics would cover whichever causes someone remembered.
//
// Why a metric at all when the process exits loudly: a crash-looping AgentCore runtime produces no
// turns, and no turns is indistinguishable from a quiet agent — this fleet has many genuinely idle
// ones. Without this, a failed boot surfaces only when someone reports their agent went silent.
// `err` carries the cause, so the alarm names it rather than just counting.
function emitBootFailed(err) {
  try {
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent'], []], Metrics: [{ Name: 'BootFailedCount', Unit: 'Count' }] }] },
      Agent: AGENT_NAME, BootFailedCount: 1, component: 'pi-adapter', msg: 'boot_failed',
      err: err && err.message,
    }));
    // Silence IS correct here: the process is already exiting with the real cause logged beside
    // this. A rethrow would REPLACE a precise "config load failed" with "EMF write failed"; a log
    // could only add noise ahead of the error that matters.
    // eslint-disable-next-line local/no-statementless-catch -- see above
  } catch { /* metrics must never mask the throw below */ }
}

// Per-turn EMF metrics (P2) — same mechanism as emitColdBootMetric, so turn latency / tokens /
// error-rate become 1-line CloudWatch metric queries + alarmable instead of span scans. Namespace
// AgentCore/Pi, dims Agent and Agent+Model (bounded cardinality — rich cuts stay in spans/logs).
// TtftMs only carries on stream turns. TurnErrorCount counts only REAL errors (P4 classification),
// so alarms don't fire on benign empty/no-op turns.
function emitTurnMetrics({
  latencyMs, ttftMs, tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, contextTokens: contextTokensIn,
  model, isError, costUsd,
}) {
  try {
    // Prompt-cache token volumes + a cache-hit signal. cacheRead>0 means this turn reused a cached
    // prompt prefix; TurnCacheHit=1/0 makes cache-hit RATE a 1-line Average(TurnCacheHit) query.
    // TurnTokensContext = the TRUE prompt size (usage.input under-reports under prompt caching).
    // All guarded `|| 0` — never NaN. TurnTokensInput/Output semantics unchanged.
    const cacheRead = Math.max(0, Math.round(cacheReadTokens || 0));
    const cacheWrite = Math.max(0, Math.round(cacheWriteTokens || 0));
    // PREFER the caller's contextTokens. planReplyMetrics computes it from the LAST model call
    // (reply-usage.mjs: prompt size is not summable — each call re-sends the whole conversation), and
    // this function used to ignore it and re-derive from the SUMMED billed tokens, which counts the
    // same prompt once per call. A 4-call tool loop over a 30k prompt read as ~120k of "context",
    // i.e. the metric that exists to answer "is this session getting too big" said yes for any turn
    // that used tools. The sum stays as the fallback for callers with no per-call record.
    const contextTokens = Number.isFinite(contextTokensIn)
      ? Math.max(0, Math.round(contextTokensIn))
      : (tokensIn || 0) + cacheRead + cacheWrite;
    const metricDefs = [
      // TurnLatencyMs is emitted ONLY when a latency was supplied. Per-reply metrics attribute the
      // per-invoke latency to the first reply alone (see planReplyMetrics), so later replies omit it;
      // emitting 0 there would silently drag p50/p90 down.
      ...(latencyMs != null ? [{ Name: 'TurnLatencyMs', Unit: 'Milliseconds' }] : []),
      { Name: 'TurnTokensInput', Unit: 'Count' },
      { Name: 'TurnTokensOutput', Unit: 'Count' },
      { Name: 'TurnCacheReadTokens', Unit: 'Count' },
      { Name: 'TurnCacheWriteTokens', Unit: 'Count' },
      { Name: 'TurnCacheHit', Unit: 'Count' },
      { Name: 'TurnTokensContext', Unit: 'Count' },
      { Name: 'TurnErrorCount', Unit: 'Count' },
    ];
    if (ttftMs != null) metricDefs.push({ Name: 'TtftMs', Unit: 'Milliseconds' });
    // P3: only emit TurnCostUsd when pi-ai actually reported a cost — never a fabricated value.
    if (Number.isFinite(costUsd)) metricDefs.push({ Name: 'TurnCostUsd', Unit: 'None' });
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent'], ['Agent', 'Model']], Metrics: metricDefs }] },
      Agent: AGENT_NAME, Model: model || MODEL.id,
      ...(latencyMs != null ? { TurnLatencyMs: Math.max(0, Math.round(latencyMs)) } : {}),
      ...(ttftMs != null ? { TtftMs: Math.max(0, Math.round(ttftMs)) } : {}),
      TurnTokensInput: tokensIn || 0,
      TurnTokensOutput: tokensOut || 0,
      TurnCacheReadTokens: cacheRead,
      TurnCacheWriteTokens: cacheWrite,
      TurnCacheHit: cacheRead > 0 ? 1 : 0,
      TurnTokensContext: contextTokens,
      TurnErrorCount: isError ? 1 : 0,
      ...(Number.isFinite(costUsd) ? { TurnCostUsd: costUsd } : {}),
      component: 'pi-adapter', msg: 'turn_metric',
    }));
  } catch { /* metrics must never break a turn */ }
}

// P3 — per-turn USD cost. @mariozechner/pi-ai ALREADY computes this at runtime (cache-aware, keyed
// on the exact model that ran), so we pass its value through VERBATIM — no price table, no mapping.
// When pi-ai reports no cost (usage.cost absent), we emit NOTHING rather than fabricate an estimate:
// a made-up cost that looks real is worse than a missing datapoint. Returns the number or undefined.
function resolveTurnCostUsd(out) {
  const c = out?.usage?.cost?.total;
  return Number.isFinite(c) ? c : undefined;
}

// PER-REPLY turn metrics. planReplyMetrics (reply-usage.mjs) decides the payloads: usage SUMMED across
// the reply's model calls, because `out.usage` is only the LAST call's — a 4-call tool loop used to
// report a quarter of its output tokens and a quarter of its cost. With per-message isolation a run
// answers ONE user message, so this normally emits one payload; the per-reply shape is retained
// because it is what makes the summation correct across a multi-CALL tool loop.
function emitReplyMetrics({ out, latencyMs, ttftMs, cls }) {
  const plans = planReplyMetrics({ out, latencyMs, ttftMs, isError: !!cls?.isError });
  for (const p of plans) emitTurnMetrics(p);
  return plans.length;
}

// P6 — session-shape metrics off the live SessionManager entries (in-memory; zero I/O — robust to
// Pi's file rewrites/branches, and always in sync with what the turn just wrote). Namespace
// AgentCore/Pi, dim Agent (bounded cardinality; rich per-session cuts come from the JSONL/spans).
// SessionLengthTurns mirrors Pi's messageCount (all message roles). ContextLengthTokens = the last
// assistant usage input+cacheRead+cacheWrite (the true cached context; usage.input alone under-reports
// under prompt caching), else the latest compaction.tokensBefore, else omitted (brand-new session).
// Never throws.
function emitSessionShapeMetrics(sm, model) {
  try {
    if (!sm || typeof sm.getEntries !== 'function') return;
    const entries = sm.getEntries() || [];
    let turns = 0; let ai = 0; let human = 0; let compactions = 0;
    let ctxTokens = null; let lastCompactionBefore = null;
    for (const e of entries) {
      if (e?.type === 'compaction') { compactions += 1; if (Number.isFinite(e.tokensBefore)) lastCompactionBefore = e.tokensBefore; continue; }
      if (e?.type !== 'message') continue;
      turns += 1;
      const role = e.message?.role;
      if (role === 'assistant') ai += 1;
      else if (role === 'user') human += 1; // tool results carry role 'toolResult', so this excludes them
    }
    for (let i = entries.length - 1; i >= 0 && ctxTokens === null; i -= 1) {
      const e = entries[i];
      if (e?.type === 'message' && e.message?.role === 'assistant') {
        const u = e.message.usage || {};
        const t = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
        if (t > 0) ctxTokens = t;
      }
    }
    if (ctxTokens === null && Number.isFinite(lastCompactionBefore)) ctxTokens = lastCompactionBefore;

    const metricDefs = [
      { Name: 'SessionLengthTurns', Unit: 'Count' },
      { Name: 'AiResponses', Unit: 'Count' },
      { Name: 'HumanResponses', Unit: 'Count' },
      { Name: 'CompactionEvents', Unit: 'Count' },
    ];
    if (ctxTokens !== null) metricDefs.push({ Name: 'ContextLengthTokens', Unit: 'Count' });
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent']], Metrics: metricDefs }] },
      Agent: AGENT_NAME, Model: model || MODEL.id,
      SessionLengthTurns: turns, AiResponses: ai, HumanResponses: human, CompactionEvents: compactions,
      ...(ctxTokens !== null ? { ContextLengthTokens: ctxTokens } : {}),
      component: 'pi-adapter', msg: 'session_shape_metric',
    }));
  } catch { /* metrics must never break a turn */ }
}

// Classify a completed (non-thrown) turn (P4): a turn that surfaced an in-band error is a genuine
// failure; a turn that produced NO assistant output is a benign empty/no-op (cron nudge, NO_REPLY)
// — NOT an error, even though Pi may report stopReason='error' with 0 tokens (verified: the 9
// false-positive spans were all zero-output). Otherwise it's a normal reply. Reserving 'error' for
// real failures (+ status.code=ERROR) makes span-level error queries + TurnErrorCount trustworthy.

// P1: emit a child span per tool call, nested under the parent agent_i073q7 span (shared traceId +
// parentSpanId), so per-tool latency/failures are visible in the trace — previously a tool call was
// invisible (only the parent span existed → 2 spans/turn). agent_i32pz9 execute_tool semantics; real
// start/end times recorded in runTurn. No-op if tracing is off or the parent span is absent.
async function emitToolSpans(parent, toolCalls, sessionId) {
  if (!otel || otel.mode === 'off' || !parent || !toolCalls || !toolCalls.length) return;
  for (const tc of toolCalls) {
    try {
      const ts = otel.startSpan(`execute_tool ${tc.name || 'tool'}`, {
        traceId: parent.traceId, parentSpanId: parent.spanId, kind: 1, startTimeMs: tc.startMs,
      });
      // WHICH connector action(s), and whether the call actually worked. Both were missing, and the
      // pair is what makes a tool span answer a question rather than raise one:
      //
      //   slugs   `agent_i32pz9.tool.name` for every connector call is one of six generic wrappers, so a
      //           batched CONNECTOR_MULTI_EXECUTE_TOOL recorded as one anonymous span. Same field the
      //           PEP already emits (permissions-extension.mjs:59), comma-joined for Insights.
      //   result  outcome only, never the payload — see tool-outcome.mjs.
      //
      // THE SPAN GOES RED ON A DECLARED FAILURE, not only on a thrown one. A connector call that fails
      // returns HTTP 200 with `{successful:false}`, so before this a failed Gmail lookup and a working
      // one were both green: measured 2026-08-21 on gmail-count-every-10min, one 755ms tool span with
      // no error flag and a 43-character answer. `ok === false` is the assertion; `ok == null` (no
      // envelope) deliberately does NOT fail the span.
      const failed = tc.outcome && tc.outcome.ok === false;
      await otel.end(ts, {
        attributes: {
          'agent_i32pz9.operation.name': 'execute_tool',
          'agent_i32pz9.tool.name': tc.name,
          'agent_i32pz9.tool.call.id': tc.id,
          'agent_i32pz9.conversation.id': sessionId,
          'session.id': sessionId,
          ...(tc.slugs ? { 'agent_i32pz9.tool.connector.slugs': tc.slugs } : {}),
          ...outcomeAttributes(tc.outcome),
        },
        error: tc.isError
          ? 'tool execution error'
          : (failed ? `tool reported failure${tc.outcome.code ? ` (${tc.outcome.code})` : ''}` : undefined),
        endTimeMs: tc.endMs,
      });
    } catch { /* telemetry must never break a turn */ }
  }
}

// Close the two remaining blind spots in a turn's trace. Before this, a turn showed a hole between
// the runtime's agent_i073q7 span opening and its first `chat` child — real work with no span:
// the EFS mount wait, workspace seed, skill hydration, session construction and tool-surface
// filtering, then Pi's context/prompt assembly. Measured on the pi-obs-41 switchover turn
// (trace 83f7226a…): 0.89s hydrate + 1.70s prepare = 2.6s, 8% of a 32s cold turn, invisible. "Where
// did the turn's time go" bottomed out at "somewhere before the model call".
//
// Emitted AFTER the fact from recorded marks, the same pattern as emitToolSpans/emitModelCallSpans:
// the first model request's real start time comes back as out.modelCalls[0].startMs, so no Pi hook
// is needed — which matters, because Pi's before_provider_request/onPayload hook is DEAD (agent-loop
// never calls it), so there is no in-band callback at "about to call the model".
//
// Deliberately NOT tagged `agent_i32pz9.operation.name`: these are not agent_i32pz9 operations, and tagging them
// would pull them into the genai_turns / tool_spans / turn_outcomes queries, all of which filter on
// that attribute. They carry `agentcore.phase` instead.
async function emitPrepareSpans(parent, {
  tStart, tSessionReady, firstModelStartMs, sessionWasWarm, firstDispatchMs,
}, sessionId) {
  if (!otel || otel.mode === 'off' || !parent || tSessionReady == null) return;
  const common = { 'agent_i32pz9.conversation.id': sessionId, 'session.id': sessionId };
  try {
    // getSession: EFS mount wait → workspace seed → skill hydrate → session construct → tool filter.
    const hs = otel.startSpan('session_hydrate', {
      traceId: parent.traceId, parentSpanId: parent.spanId, kind: 1, startTimeMs: tStart,
    });
    await otel.end(hs, {
      attributes: { ...common, 'agentcore.phase': 'session_hydrate', 'agentcore.session.warm': !!sessionWasWarm },
      endTimeMs: tSessionReady,
    });
  } catch { /* telemetry must never break a turn */ }
  // Only meaningful when a model call actually happened: a no-op turn (NO_REPLY / empty cron nudge)
  // never reaches the provider, so there is no "until the model call" interval to measure.
  if (firstModelStartMs == null) return;
  // The dispatch mark, when we have one, cuts prepare_turn at the boundary between our work and
  // Bedrock's. Only trusted when it falls INSIDE the interval: a mark outside it belongs to some
  // other request (a background call, a previous turn's tool loop) and a span with a negative or
  // overhanging duration is worse than no split at all. Without a usable mark this emits exactly
  // the one span it always did, so the query surface never has a hole in it.
  const splitUsable = firstDispatchMs != null
    && firstDispatchMs >= tSessionReady && firstDispatchMs <= firstModelStartMs;
  try {
    const ps = otel.startSpan('prepare_turn', {
      traceId: parent.traceId, parentSpanId: parent.spanId, kind: 1, startTimeMs: tSessionReady,
    });
    await otel.end(ps, {
      attributes: {
        ...common,
        'agentcore.phase': 'prepare_turn',
        ...(splitUsable ? {
          'agentcore.prepare.context_build_ms': firstDispatchMs - tSessionReady,
          'agentcore.prepare.model_ttfb_ms': firstModelStartMs - firstDispatchMs,
        } : {}),
      },
      endTimeMs: firstModelStartMs,
    });
  } catch { /* telemetry must never break a turn */ }
  if (!splitUsable) return;
  // Emitted as spans as well as attributes: the attributes answer "how was THIS turn split", the
  // spans put the split on the flame graph, where the gap was noticed in the first place.
  for (const [name, phase, startMs, endMs] of [
    ['context_build', 'context_build', tSessionReady, firstDispatchMs],
    ['model_ttfb', 'model_ttfb', firstDispatchMs, firstModelStartMs],
  ]) {
    try {
      const s = otel.startSpan(name, {
        traceId: parent.traceId, parentSpanId: parent.spanId, kind: 1, startTimeMs: startMs,
      });
      await otel.end(s, { attributes: { ...common, 'agentcore.phase': phase }, endTimeMs: endMs });
    } catch { /* telemetry must never break a turn */ }
  }
}

// Per-model-request child spans (`chat <model>`): each Bedrock ConverseStream call inside the
// turn as its own span nested under agent_i073q7 — closing the last seam in the trace (the
// runtime has no aws-sdk auto-instrumentation, so before this the model calls were invisible;
// only the turn-level envelope existed). One span per assistant message (a tool-loop turn =
// several), with per-REQUEST usage; real start/end recorded in runTurn.
//
// The span is BACKDATED TO THE DISPATCH when we have one, not to the first response byte. Pi's
// `message_start` — the only in-band mark available — fires on the first event of the Bedrock
// RESPONSE stream, so a `chat` span started from it began after the request had already been
// waiting. On a tool-loop turn that put the second request's whole dispatch+TTFB in a hole between
// the tool ending and the next span opening: 1.85s of a 4.4s turn, covered by nothing (caught by
// the @latency attribution gate, 2026-08-14). Backdating closes the hole and makes the span mean
// "the model request", which is what its name implies.
//
// It also replaces `agentcore.model.ttft_ms`, which was DEAD: it was computed as
// (first message_update − message_start), and Pi emits both on consecutive events of the same
// response stream, so it measured 0ms or 1ms on all 673 model calls in the 7-day window. TTFB
// against the dispatch is the number it was always meant to be.
async function emitModelCallSpans(parent, modelCalls, sessionId, turnStartMs) {
  if (!otel || otel.mode === 'off' || !parent || !modelCalls || !modelCalls.length) return;
  for (const mc of modelCalls) {
    try {
      const u = mc.usage || {};
      // Floored at the turn's own start. The marks are process-wide, so if this microVM ever serves
      // two turns at once a mark from the other one could sit just before this response and pull the
      // span's start back outside its parent — a span longer than the turn containing it. Rejecting
      // those leaves the span backdated to `message_start` exactly as before.
      const paired = mc.startMs != null ? bedrockMark.dispatchFor(mc.startMs) : null;
      const dispatchMs = (paired != null && turnStartMs != null && paired < turnStartMs) ? null : paired;
      const ms = otel.startSpan(`chat ${mc.model || 'model'}`, {
        traceId: parent.traceId,
        parentSpanId: parent.spanId,
        kind: 3,
        startTimeMs: dispatchMs != null ? dispatchMs : mc.startMs,
      });
      await otel.end(ms, {
        attributes: {
          'agent_i32pz9.operation.name': 'chat',
          'agent_i32pz9.system': 'aws.bedrock',
          'agent_i32pz9.request.model': mc.model,
          'agent_i32pz9.response.finish_reasons': mc.stopReason,
          'agent_i32pz9.usage.input_tokens': usageIn(u),
          'agent_i32pz9.usage.output_tokens': usageOut(u),
          // Per-CALL cache + cost. Each Bedrock call is billed separately (a prefix re-read on call
          // 3 costs money on call 3), so these are the honest per-request figures — and the place
          // to look when a tool loop's later calls stop hitting cache while the first one did.
          ...cacheCostAttrs(u),
          ...(dispatchMs != null && mc.startMs != null
            ? { 'agentcore.model.ttfb_ms': mc.startMs - dispatchMs } : {}),
          'agent_i32pz9.conversation.id': sessionId,
          'session.id': sessionId,
        },
        error: mc.isError ? 'model request error' : undefined,
        endTimeMs: mc.endMs,
      });
    } catch { /* telemetry must never break a turn */ }
  }
}

let MODEL;
let ALLOW = new Set(); // resolved tool allow-set (config-driven); empty = bare (no tools)
let PLUGIN_MANIFEST = { hindsight: null, compat: [], skipped: [] }; // config-driven plugin routing
let SKILL_PATHS = []; // Pi skill roots — set by hydrateSkills to [SKILLS_DIR] (/tmp, per-agent installs)
// The recall client is config-static and built once at boot; the EXTENSION around it is built per
// session, because its capability gate must close over that session's live grants and verdict table
// (R11 — see initHindsight). Null until initHindsight succeeds, and hindsight stays off if it does not.
let HINDSIGHT_RECALL = null;
let HINDSIGHT_EXT_OPTS = null;
let MCP_PREFIXES = []; // this agent's connector.extraMcpServers[].toolPrefix (e.g. ['demo_query_app','demo_warehouse'])
let PROVIDER_REGISTRY = null; // §8 provider manifest, memoized (tool set is agent-invariant)
// §8.6: the capability resolver is built PER SESSION from the registered tools' declared caps
// (see the session build below) + MCP_PREFIXES — no module-level hand-written switch.
let ready = false;
let busy = 0;
let turnIndex = 0; // requests this microVM has served — 1 means it booted for this turn
const sessions = new Map(); // sessionKey -> { session, turnCtx, skillFp } (per-runtime warm cache)

// `model` rides here so a FAILED skill read does not silently drop the picked model out of the
// config fingerprint — dropping it would flip the fp, force a re-resolve, then flip it back on the
// next successful read: two needless re-resolves from one transient DynamoDB error.
let skillState = { fp: null, marketplace: null }; // last skill-fingerprint materialized onto SKILLS_DIR (this microVM)
let configState = { fp: null }; // last config-fingerprint bound into this microVM's live config

// Bind the resolved config for AGENT_NAME -> model + tool allow-set + plugin routing.
//
// TAKES THE RESOLVED OBJECT, not a path. It used to read `openclaw.json` off disk, which the
// entrypoint had rendered by spawning the resolver as a child process — the file existed only to
// carry these two values across that process boundary. Both are gone; `resolved` is what
// config-resolver/resolve-config.mjs returned (see agent-config.mjs).
//
// FATAL if the config has no entry for this agent. There is no fallback: see the note at the bottom
// of this function for why the old PI_MODEL_ID + no-tools path was worse than crashing.
function loadConfig(resolved) {
  const { agent, cfg } = resolved || {};
  try {
    if (agent) {
      const { id } = resolveModelSpec(agent, cfg);
      MODEL = getModel(id);
      ALLOW = resolveAllowedTools(agent);
      PLUGIN_MANIFEST = resolvePluginManifest(cfg);
      // LOUD, on its own line, one per plugin: the agent is allowed a plugin Pi will not load,
      // so a tool it has been told it has does not exist. Left implicit, this surfaces as an
      // agent improvising with bash for minutes — see findUnavailablePlugins.
      const unavailable = findUnavailablePlugins(ALLOW, PLUGIN_MANIFEST);
      for (const u of unavailable) {
        console.error(JSON.stringify({
          level: 'warn', component: 'pi-adapter', msg: 'ALLOWED PLUGIN NOT AVAILABLE UNDER PI — tools it registers do not exist',
          agent: agent.id, ...u,
        }));
      }
      // MCP server prefixes for capability resolution — from the mcp-auth plugin slice, which is
      // the same input the plugin names its tools from (see resolveMcpPrefixes for why reading
      // agent.connector here meant this was always []).
      MCP_PREFIXES = resolveMcpPrefixes(agent, cfg);
      // LOUD when an agent has mcp-auth servers but no prefixes resolved: every tool that plugin
      // registers would resolve 'unknown' and be hidden by the grant filter, which reads to the
      // member as "the agent can't see my data" with nothing in the logs naming the cause.
      const mcpAuthServers = cfg?.plugins?.entries?.['openclaw-mcp-auth-plugin']?.config?.agents?.[agent.id]?.mcpServers ?? [];
      if (mcpAuthServers.length && !MCP_PREFIXES.length) {
        console.error(JSON.stringify({
          level: 'warn', component: 'pi-adapter', agent: agent.id,
          msg: 'mcp-auth servers configured but NO tool prefixes resolved — every mcp_auth__* tool will resolve capability=unknown and be hidden',
          servers: mcpAuthServers.length,
        }));
      }
      // SKILL_PATHS are set per turn by hydrateSkills (the agent's INSTALLED skills materialize
      // from DDB onto /tmp, scoped by fingerprint) — not from the config's extraDirs here.
      return {
        source: 'ddb', agent: agent.id, model: id, allow: [...ALLOW],
        plugins: {
          hindsight: !!PLUGIN_MANIFEST.hindsight,
          compat: PLUGIN_MANIFEST.compat.map((c) => c.id),
          skipped: PLUGIN_MANIFEST.skipped,
          // Carried in the summary too, so the one config line tells the whole story.
          unavailable,
        },
      };
    }
  } catch (e) {
    fail(`config bind failed for agent ${AGENT_NAME}`, e);
  }
  // NO CONFIG for this agent. Fatal.
  //
  // This used to fall back to PI_MODEL_ID with an EMPTY tool allow-set, described as "the bare boot
  // POC". It is not reachable in production and never was: the resolver either returns an agent entry
  // or throws, and boot() awaits it, so by the time this runs a config is guaranteed. Reaching here
  // means the resolver returned an empty object — a fault.
  //
  // The fallback's failure mode was the reason to remove it rather than merely narrow it: the agent
  // booted, connected, answered, and had NO TOOLS — no read, no write, no memory, no cron — behind a
  // single `warn` line. "Talks but cannot act" is far harder to diagnose than a crash loop, and a
  // crash loop is visible in ECS/AgentCore and now alarms (BootFailedCount, from the one top-level
  // boot handler at the tail of this file).
  return fail(`resolver returned no config entry for agent ${AGENT_NAME}`);
}

/**
 * Throw. Never returns.
 *
 * Deliberately does NOT emit the alarm metric: that belongs to the ONE top-level boot handler
 * (see the tail of this file), which catches every fatal boot cause rather than the subset each
 * throw site remembered to instrument.
 */
function fail(what, cause) {
  throw new Error(`pi-adapter: ${what} — refusing to boot tool-less${cause ? `: ${cause.message}` : ''}`, cause ? { cause } : undefined);
}

// Build the compat-plugin tools + extension factory for this session (connector etc.),
// loading each esbuild bundle from /app/plugins. turnCtx is the per-turn mutable ctx the
// compat hooks read (runId/sender), updated by the request handler.
function loadCompatEntries() {
  const entries = [];
  for (const c of PLUGIN_MANIFEST.compat) {
    const bundle = join(PLUGINS_DIR, `${c.id}.cjs`);
    if (!existsSync(bundle)) {
      console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'compat bundle missing', id: c.id, bundle }));
      continue;
    }
    try {
      entries.push({ entry: requireCjs(bundle).default, pluginConfig: c.pluginConfig });
    } catch (e) {
      console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'compat bundle load failed', id: c.id, err: e.message }));
    }
  }
  return entries;
}

// Boot-time pre-warm. Every AgentCore session is a fresh microVM, so without this EVERY session
// build races connector's async discovery and loses — see prewarmCompatPlugins. Boot already spends
// ~1.3s plus the EFS wait, so this costs little and buys the difference between an agent that has
// Connector tools and one that only thinks it does.
async function prewarmCompat() {
  if (!PLUGIN_MANIFEST.compat.length) return;
  const entries = loadCompatEntries();
  if (!entries.length) return;
  const t0 = Date.now();
  const r = await prewarmCompatPlugins(entries, {
    sessionCtx: { agentId: AGENT_NAME, agentDir: CWD, workspaceDir: CWD },
    logSink: console,
  });
  console.log(JSON.stringify({
    level: r.timedOut ? 'warn' : 'info', component: 'pi-adapter', msg: 'compat prewarm complete',
    agent: AGENT_NAME, registered: r.registered, awaited: r.awaited, timedOut: r.timedOut, ms: Date.now() - t0,
  }));
}

function buildCompatForSession(key, turnCtx) {
  if (!PLUGIN_MANIFEST.compat.length) return { customTools: [], extensionFactory: null };
  const entries = loadCompatEntries();
  if (!entries.length) return { customTools: [], extensionFactory: null };
  const { customTools, extensionFactory, plugins } = buildCompatPlugins(entries, {
    sessionCtx: { agentId: AGENT_NAME, sessionKey: key, agentDir: CWD, workspaceDir: CWD },
    turnCtx, logSink: console,
  });
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'compat plugins loaded', plugins }));
  return { customTools, extensionFactory };
}

// Build the Pi-native Hindsight recall extension once at boot (config-static). Org-bank
// recall only (matches the @hindsight leg; agent-bank recall/retain is a later enhancement).
// Reuses the real @vectorize-io/hindsight-client. No-op unless configured (apiUrl+orgBankId).
// The org-bank config the agent_knowledge_* tools need, resolved once by initHindsight and read per
// session by buildCustomTools. Empty until then, and empty forever on an unconfigured agent — which is
// what makes buildKnowledgeTools return no tools rather than four that throw.
let HINDSIGHT_TOOL_CFG = {};

async function initHindsight() {
  const hs = PLUGIN_MANIFEST.hindsight;
  if (!hs) return;
  const c = hs.config || {};
  const apiUrl = c.hindsightApiUrl || process.env.HINDSIGHT_API_URL;
  const orgBankId = c.orgBankId;
  if (!apiUrl || !orgBankId) {
    console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'hindsight not configured (need apiUrl + orgBankId)', apiUrl: !!apiUrl, orgBankId }));
    return;
  }
  try {
    const recall = await buildClientRecall({
      apiUrl, apiToken: c.hindsightApiToken || process.env.HINDSIGHT_API_TOKEN,
      orgApiUrl: c.orgHindsightApiUrl, orgApiToken: c.orgHindsightApiToken,
      orgBankId, // org-only: no agentBankId
      maxTokens: c.orgRecallMaxTokens ?? c.recallMaxTokens, budget: c.orgRecallBudget ?? c.recallBudget,
      types: c.orgRecallTypes ?? c.recallTypes, timeoutMs: c.recallTimeoutMs, logger: console,
    });
    // Gate hindsight by capability: read (context injection) = hindsight.read, baseline-allow; write
    // (agent_end retain) = hindsight.write, default-deny and policy-pinned.
    //
    // R11 — THE `can` IS BUILT PER SESSION, NOT HERE, and this used to be the opposite. The old code
    // built one decider at boot over `new Set()`, i.e. over grants that were empty by construction and
    // never refreshed. Its comment called that "correct today", which held only while retain was a
    // disabled stub: the moment hindsight.write becomes reachable, a boot-level decider can observe
    // NEITHER a grant row NOR a policy verdict, so the gate would deny for every scope, forever, and
    // look like a missing grant. This init runs once per runtime and has no channel, so there is no
    // live permission state it could legitimately read — the deps are stashed and the extension is
    // built in getSession, where `decide` closes over the live grants Set and policy holder.
    HINDSIGHT_RECALL = recall;
    HINDSIGHT_EXT_OPTS = {
      orgBankId, orgOnly: true, preamble: c.recallPromptPreamble, logger: console,
      // Query-shaping knobs, ported with the plugin's own defaults (hindsight-extension.mjs applies
      // them when absent). Read from config so a deployment can widen the budget without an image
      // roll; sandra sets neither today, which is exactly why the defaults have to match the plugin.
      recallContextTurns: c.recallContextTurns,
      recallRoles: c.recallRoles,
      recallMaxQueryChars: c.recallMaxQueryChars,
    };
    // The knowledge TOOLS are org-bank-scoped, mirroring the plugin's factory (index.ts:2887-2898):
    // under orgOnly the bank is orgBankId and the url/token switch to the org ones when set. Unlike the
    // recall HOOK, which merges org + agent results, a tool reads exactly one bank.
    HINDSIGHT_TOOL_CFG = {
      apiUrl: c.orgHindsightApiUrl || apiUrl,
      apiToken: c.orgHindsightApiToken || c.hindsightApiToken || process.env.HINDSIGHT_API_TOKEN,
      bankId: orgBankId,
    };
    console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'hindsight recall enabled (Pi-native)', apiUrl, orgBankId }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'hindsight init failed', err: e?.message || String(e) }));
  }
}

// The BYO-EFS mount attaches ASYNCHRONOUSLY around container start and can take ~90s.
// We must NOT block the adapter's listen on it (a slow mount would fail AgentCore's
// health check → restart loop). So this runs LAZILY: the adapter listens immediately
// (healthy), kicks this off in the background, and getSession awaits it before the first
// turn. Waits until EFS_DIR is real NFS (0x6969), then seeds the workspace from the
// config clone (no-clobber). Memoized — runs once. PI_SKIP_MOUNT_WAIT=1 skips the wait
// for local bind-mount volumes (durable but not NFS).
const NFS_SUPER_MAGIC = 0x6969;
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
let efsReadyPromise = null;
async function waitForEfsMount(dir, timeoutMs = 60_000) {
  // Log BEFORE the guard so we can see this is even reached + which path it takes
  // (the guard early-returns silently otherwise). Cheap, boot-window, always surfaces.
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'waitForEfsMount enter', dir, skip: process.env.PI_SKIP_MOUNT_WAIT === '1' }));
  if (!dir || process.env.PI_SKIP_MOUNT_WAIT === '1') return;
  const started = Date.now();
  const monoStarted = performance.now();
  const deadline = started + timeoutMs;
  const fs = (type) => (type != null ? `0x${Number(type).toString(16)}` : null);
  // Mount-table snapshot for the mount dir — reveals WHETHER an NFS entry exists at all
  // (never-attached) vs a broken/stale one, so a failed mount is diagnosable, not a guess.
  const mountInfo = () => {
    try {
      return readFileSync('/proc/self/mountinfo', 'utf8').split('\n')
        .filter((l) => l.includes(` ${dir} `) || l.includes(' nfs') || l.includes(' nfs4')).slice(0, 8);
    } catch { return ['<mountinfo unreadable>']; }
  };
  for (let n = 0; ; n += 1) {
    let type = null;
    try { type = statfsSync(dir).type; } catch { /* not present yet */ }
    if (n === 0) console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'efs mount probe', dir, fstype: fs(type) }));
    if (Number(type) === NFS_SUPER_MAGIC) { console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'efs mount ready (nfs)', dir, waitedMs: Date.now() - started, polls: n })); return; }
    // Never SILENTLY proceed on the ephemeral overlay (0x794c7630): writes there are lost
    // (sessions unpersisted, seed files missing) with no error — a silent data-loss bug.
    // Throw so ensureEfsReady exits the process and AgentCore recycles this microVM onto a
    // healthy mount, instead of serving turns on throwaway storage. wallMs vs monoMs
    // distinguishes "polled 180s" from "microVM was frozen and unfroze past the deadline".
    if (Date.now() >= deadline) {
      const ft = fs(type);
      const wallMs = Date.now() - started;
      const monoMs = Math.round(performance.now() - monoStarted);
      console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'efs mount did not attach as NFS before deadline — refusing to serve on ephemeral overlay', dir, fstype: ft, wallMs, monoMs, polls: n, mountInfo: mountInfo() }));
      throw new Error(`EFS mount not NFS (fstype ${ft}) after wall=${wallMs}ms mono=${monoMs}ms at ${dir}`);
    }
    // Heartbeat every ~5s so a slow/stuck mount is VISIBLE in logs (the poll was silent
    // between probe and ready, making a hung mount-wait undiagnosable — the whole reason
    // connector's failure was opaque).
    if (n > 0 && n % 10 === 0) console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'efs mount waiting', dir, fstype: fs(type), elapsedMs: Date.now() - started }));
    await sleepMs(500);
  }
}
// The EXPENSIVE mount verification (plan §9) — runs ONCE, only on the fresh-seed path. The
// cheap NFS floor (waitForEfsMount) already ran; this is the belt-and-braces that we're about
// to WRITE the authored baseline onto the right filesystem: re-assert NFS + a mounts-table
// cross-check that an nfs entry maps to EFS_DIR. FATAL (throw) if not.
function verifyEfsMountStrict() {
  let type = null;
  try { type = statfsSync(EFS_DIR).type; } catch { /* absent */ }
  if (Number(type) !== NFS_SUPER_MAGIC) throw new Error(`verifyMount FATAL: ${EFS_DIR} not NFS (fstype 0x${Number(type).toString(16)})`);
  let mi = [];
  try { mi = readFileSync('/proc/self/mountinfo', 'utf8').split('\n').filter((l) => l.includes(` ${EFS_DIR} `) && (l.includes(' nfs') || l.includes(' nfs4'))); } catch { /* unreadable */ }
  if (!mi.length) throw new Error(`verifyMount FATAL: no nfs mount for ${EFS_DIR} in mountinfo`);
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'efs mount verified (nfs + mountinfo)', dir: EFS_DIR }));
}

// Lazy DDB I/O for the workspace seed + skill library — reuses the config-resolver's client +
// schema (its own aws-sdk) so the adapter needs no extra dependency.
async function ddbIO() {
  const schema = await import(pathToFileURL(join(CONFIG_RESOLVER_DIR, 'schema.mjs')).href);
  const ddb = await import(pathToFileURL(join(CONFIG_RESOLVER_DIR, 'ddb-local.mjs')).href);
  const { doc } = ddb.makeClients();
  // READ-ONLY BY CONSTRUCTION. No write command is imported, so there is no code path that could
  // write this table even if the IAM policy were widened by mistake. The brand-new-agent workspace
  // SEED is pre-written by the DISPATCHER at provision time (agentcore-client seedNewWorkspace), so
  // the runtime never writes at all. Rationale: MMDS hands the execution role to ANY code in the microVM (AWS calls this out
  // specifically for LLM-generated code), and DynamoDB IAM has no sort-key condition key, so a write
  // grant narrow enough to permit only AGENT#<id>/SEED cannot be expressed. The nearest expressible
  // grant (LeadingKeys AGENT#*) also permitted the agent's own CONFIG (tools.alsoAllow → the tool
  // surface) and META (routing). Removing the write removes the whole class.
  const { GetCommand } = ddb._require('@aws-sdk/lib-dynamodb');
  const table = process.env.AGENT_CONFIG_TABLE || schema.TABLE;
  const get = async (Key) => (await doc.send(new GetCommand({ TableName: table, Key }))).Item;
  return {
    readSeedManifest: async (id) => {
      const files = schema.readData(await get(schema.agentSeedKey(id)));
      return files ? { files } : null;
    },
    // NO persistSeed. The dispatcher PRE-WRITES AGENT#<id>/SEED at provision time (when it creates
    // the agent's EFS access point), so by the time this runtime boots the manifest is already there
    // and seedWorkspace takes its seeded-from-ddb path. seedWorkspace treats persistSeed as optional
    // (`if (persistSeed)`), so omitting it is the whole change on this side.
    //
    // If the manifest is somehow absent, the runtime still seeds EFS from its own baked skeleton and
    // simply does not record it — degraded, not broken, and the next provision backfills.
    // Skill library: the manifest (name → version) is the cheap warm-boot read; readSkill pulls
    // one skill body only when its version changed (skill-sync decides).
    readSkillManifest: async () => schema.readData(await get(schema.skillManifestKey())) || null,
    readSkill: async (name) => schema.readData(await get(schema.skillKey(name))) || null,
    // Per-agent marketplace slice (installs/connectors/models) — drives per-agent skill scoping.
    readAgentMarketplace: async () => schema.readData(await get(schema.marketplaceKey(AGENT_NAME))) || null,
    // Tool-permission grants: GRANT#* (agent-wide, migration-seeded) ∪ GRANT#<channel> (per-channel
    // CRUD override). Returns a Set of granted capability strings; baseline caps are applied in decide.
    readGrants: async (channel) => {
      const caps = new Set();
      const add = (dbItem) => { for (const c of schema.grantedCaps(schema.readData(dbItem))) caps.add(c); };
      add(await get(schema.agentGrantKey(AGENT_NAME, '*')));
      if (channel) add(await get(schema.agentGrantKey(AGENT_NAME, channel)));
      return caps;
    },
    // The compiled Cedar verdict row for this scope (§1.1). Returns the raw body — validation is
    // policy-table.mjs's job, deliberately kept out of the IO layer so it is unit-testable without a
    // DynamoDB client. `null` here means the item does not exist, which is NOT the same as invalid.
    readPolicy: async () => schema.readData(await get(schema.agentPolicyKey(AGENT_NAME))) || null,
    // The item the resolver builds this agent's config from. Read per turn purely to FINGERPRINT it
    // (see readConfigState) — the resolution itself stays in config-resolver/resolve-config.mjs.
    //
    // The fleet BASE half is gone: it is now a constant (schema.mjs BASE_MAIN), so it cannot change
    // without an image roll, and fingerprinting a constant only costs a DynamoDB read per turn.
    readConfigItems: async () => ({
      agent: schema.readData(await get(schema.agentConfigKey(AGENT_NAME))) || null,
    }),
  };
}

// Parse the Slack channel / DM id from the LOGICAL session key (slack:thread:[dm:]<ch>:<ts>).
// Returns null for non-slack keys (cron/default) → only the agent-wide GRANT#<id>/SCOPE#* applies.
//
// MUST be given the logical key, NOT AgentCore's runtimeSessionId. This is the §12c trap that already
// bit the cron tool: agentcoreSessionId() sanitises colons to dashes for AgentCore's charset, so the
// id the handler holds is `ac-slack-thread-<ch>-<ts>` — which this regex cannot match, silently
// yielding null. The dispatcher therefore sends the colon form in the payload (body.input.sessionKey)
// and getSession threads it through as seed.sessionKey.
//
// Latent when found (2026-08-11), not active: with channel === null the per-scope read
// GRANT#<id>/SCOPE#<channel> was never issued, so a channel-scoped grant would have had no effect.
// Confirmed live — every permission_decision record in the fleet was missing its `channel` field —
// and confirmed harmless so far: all 392 grant items in the table are SCOPE#* (agent-wide), so
// nothing was being ignored yet. Grants only ever ADD capabilities, so the failure direction was
// closed (no escalation); the feature simply would not have worked the first time someone used it.
function channelOf(key) {
  const m = String(key).toLowerCase().match(/slack:thread:(?:dm:)?([^:]+):/);
  return m ? m[1] : null;
}

// Load the effective non-baseline grants for {this agent, channel}. On any DDB failure return an
// EMPTY set → non-baseline tools fail closed (a grant-store outage denies sensitive tools, never
// silently allows them).
async function loadGrants(channel) {
  try {
    return await (await ddbIO()).readGrants(channel);
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'grant load failed — baseline-only (fail-closed)', channel, err: e.message }));
    return new Set();
  }
}

// Load and validate this scope's compiled verdict table (§1.1). Read on the SAME cadence as grants,
// because a pin edit must take effect as fast as a grant does.
//
// FAILURE DIRECTIONS, which are not symmetric and must not be made so:
//   * read THREW (DDB outage) → deny-all. Same posture as loadGrants returning an empty Set: an outage
//     in the store that holds the permissions must never widen what an agent may do. Stricter than
//     grants, though, because a table is authoritative — an empty grant set still leaves baseline, a
//     deny-all table leaves nothing, so an outage here is a hard stop and should be alarmed.
//   * row ABSENT → DENY-ALL, same as invalid (changed 2026-08-18; POLICY_TABLE_REQUIRED is gone). It used
//     to be permissive — "behave exactly as before this layer existed" — which left any pin on an
//     uncovered scope silently inert. The dispatcher writes this row on every turn before the invoke
//     (ensureCurrentRuntime → ensurePolicyRow), so absent no longer means "not reached yet": it means the
//     write failed or the fleet has no policy at all, and neither is a state to serve a turn in.
async function loadPolicy() {
  const onProblem = (why, detail) => console.error(JSON.stringify({
    level: why === 'absent' ? 'info' : 'error', component: 'pi-adapter',
    msg: 'policy_table', why, agent: AGENT_NAME, ...detail,
  }));
  let row;
  try {
    row = await (await ddbIO()).readPolicy();
  } catch (e) {
    onProblem('read-failed', { err: e.message });
    // EMITTED HERE TOO, not only on the path below. This early return is the DynamoDB-outage case —
    // the deny-all most worth paging on — and it bypasses the tail of this function, so an alarm wired
    // only there would stay in OK through exactly the incident it exists for.
    const failed = { verdictFor: () => 'deny', digest: null, denyAll: true, why: 'read-failed' };
    emitPolicyDenyAll(failed);
    return failed;
  }
  // No null case any more: loadPolicyTable always returns a table, and an absent row is a deny-all one.
  const table = loadPolicyTable(row, { scope: AGENT_NAME, expectedAccount: EXPECTED_ACCOUNT, onProblem });

  // SUCCESS IS LOGGED TOO, and the first live check is why. Only the failure paths above logged, so a
  // healthy scope emitted NOTHING — which made "policy is in force at digest X" indistinguishable from
  // "this image does not have the policy code". Verified 2026-08-18 on oc_ch_c66pp782t9k_9162733d: the
  // layer was working, and the only way to tell was noticing that a permission_decision carried
  // reason=policy-denied rather than reason=ungranted. That is an inference, not an observation, and it is
  // not available at all until the agent happens to touch a pinned capability.
  //
  // Carries the DIGEST and the allow-list, because "which policy version is this scope on" is the question
  // asked when a pin appears not to have taken effect — and the answer distinguishes a stale row from a
  // wrong pin. Only the allows are named: the denies are the other ~11 and listing them buries the signal.
  if (table && !table.denyAll) {
    console.log(JSON.stringify({
      level: 'info', component: 'pi-adapter', msg: 'policy_table', why: 'loaded', agent: AGENT_NAME,
      policyDigest: table.digest, accountAsserted: table.accountAsserted,
      governs: table.capabilities.length, allowed: table.allowed,
    }));
  }
  emitPolicyDenyAll(table);
  return table;
}

/**
 * `PolicyDenyAll` — 1 when this scope fell back to deny-all, 0 when the policy loaded.
 *
 * WHY A METRIC WHEN THE FALLBACK ALREADY LOGS. Since 2026-08-18 an absent row denies EVERYTHING
 * including baseline, so this fallback is now a HARD STOP for the agent rather than a quiet downgrade —
 * and the shape it presents is the one this fleet is worst at noticing: the agent answers nothing, and a
 * silent agent is indistinguishable from an idle one (the same argument BootFailedCount was added for).
 * The log line is per-runtime — AgentCore gives each runtime its OWN log group
 * (/aws/bedrock-agentcore/runtimes/<name>-<id>-DEFAULT) — so a log-based alarm would need one metric
 * filter per runtime, recreated on every roll, which Terraform cannot own because the dispatcher creates
 * the runtimes. An EMF metric sidesteps that entirely: one series, fleet-wide.
 *
 * EMITTED ON BOTH PATHS, 1 and 0. A metric that only appears on failure gives the alarm nothing to sit
 * on between incidents, so it depends on `treat_missing_data` to distinguish "healthy" from "this image
 * does not emit the metric at all" — which it cannot. A continuous series makes healthy explicit and
 * makes the alarm's own absence visible.
 *
 * `why` is a dimension-free field rather than a dimension: absent / read-failed / the validation
 * refusals are all the same alarm, and splitting them would let one cause fire while another stayed in
 * OK on a per-reason series with no data. It is on the line so the alarm's log context names the cause.
 */
function emitPolicyDenyAll(table) {
  try {
    const denied = Boolean(table && table.denyAll);
    console.log(JSON.stringify({
      _aws: { Timestamp: Date.now(), CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent'], []], Metrics: [{ Name: 'PolicyDenyAll', Unit: 'Count' }] }] },
      Agent: AGENT_NAME, PolicyDenyAll: denied ? 1 : 0,
      component: 'pi-adapter', msg: 'policy_deny_all',
      why: denied ? (table.why || 'unknown') : null,
      policyDigest: table && table.digest ? table.digest : null,
    }));
    // Same reasoning as emitBootFailed: a failed metric write must never replace the real state with
    // "EMF write failed". The policy decision itself is already logged beside this.
    // eslint-disable-next-line local/no-statementless-catch -- see above
  } catch { /* telemetry never changes the verdict */ }
}

function ensureEfsReady() {
  if (efsReadyPromise) return efsReadyPromise;
  efsReadyPromise = (async () => {
    await waitForEfsMount(EFS_DIR); // cheap NFS floor, ALWAYS (disambiguates empty vs overlay)
    mkdirSync(CWD, { recursive: true });
    // Seed: the authored baseline lives in DDB (existing agent) or the baked skeleton
    // (brand-new). Guarded — see workspace-seed.mjs / plan §9.
    const io = await ddbIO();
    const skeletonDir = process.env.NEW_AGENT_SKELETON_DIR || join(CONFIG_SEED_DIR, 'new-agent-skeleton');
    const r = await seedWorkspace({
      efsDir: CWD, agentName: AGENT_NAME, skeletonDir,
      readSeedManifest: io.readSeedManifest, // no persistSeed: the dispatcher pre-writes it (§9.9a)
      // Strict EFS-mount verification only in VPC/EFS mode. PUBLIC/local mode (no EFS_DIR) writes
      // to ephemeral /tmp — there's no NFS mount to verify, so a no-op (otherwise a fresh-agent
      // seed 500s: verifyEfsMountStrict on an undefined EFS_DIR). Deployed VPC+EFS is unchanged.
      verifyMount: EFS_DIR ? (async () => verifyEfsMountStrict()) : (async () => {}),
      log: (o) => console.log(JSON.stringify(o)),
    });
    console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'workspace seed', agent: AGENT_NAME, workspace: CWD, ...r }));
    // Skills are NOT materialized here anymore — they live on ephemeral /tmp scoped to the
    // agent's installs, (re)hydrated per turn by hydrateSkills(). EFS carries only the workspace
    // (identity/memory) + sessions now.
  })().catch((e) => {
    // Fail THIS invocation loudly (never serve on ephemeral overlay) but do NOT exit the
    // process — exiting during the init/overlay window crash-loops the microVM ("error when
    // starting the runtime"). Reset the memo so a subsequent invoke retries cleanly; rethrow
    // so getSession() rejects and the handler returns an error for this turn (mirrors
    // AgentCore's own HTTP 424 on mount failure).
    efsReadyPromise = null;
    console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'efs not ready — failing this turn (refusing to serve on ephemeral overlay)', err: e.message }));
    throw e;
  });
  return efsReadyPromise;
}

// Per-turn skill state read: the agent's installed set + the fleet manifest → a fingerprint.
// Two cheap DDB GetItems (marketplace + manifest), in parallel. Cheap in-region (Spike 3); this
// is what lets a marketplace install take effect on the very next turn.
// ── Per-turn config (closes the Phase-3 follow-up noted in getSession) ────────────────────────
// Model / tool allow-set / plugin manifest / MCP prefixes used to bind ONCE, at microVM boot, so a
// config edit only took effect when the session's microVM happened to recycle (900s idle / 8h max) —
// invisible, unpredictable, and indistinguishable from "the edit didn't work".
//
// Now the two source items are FINGERPRINTED every turn and the config is re-resolved only when
// they change — the exact shape the skill path already uses, for the same reason: the steady-state
// cost must be a couple of DynamoDB GetItems, not a re-resolve.
//
// Re-resolution CALLS the resolver (loadAgentConfig, force) rather than spawning it. It used to spawn
// `node resolve-boot.mjs` because that script had no exports, and config resolution is precisely the
// logic that must not exist twice: a second in-process implementation would drift from what boot
// produces, and the symptom would be an agent behaving differently after a config change than after a
// restart. The resolver is now an importable function shared by both paths, which keeps that one
// source of truth without the process — so boot and re-resolve run identical code by construction
// instead of by discipline.
/**
 * `model` is the App Home picker's selection (AGENT#<id>/MARKETPLACE `.models`), passed in from
 * readSkillState rather than re-read — same item, one GetItem.
 *
 * It MUST be here. The generator resolves it ahead of the agent's own config
 * (`marketplaceModel?.modelId ? ... : models[agent.model]`), so it decides which model the turn
 * runs on — but it lives on the marketplace item, which `skillFingerprint` hashes only the
 * `installs` slice of. Before this, choosing a model in Slack flipped NEITHER fingerprint: the warm
 * session took the fast path and kept serving the old model until the microVM happened to be
 * replaced for some other reason. That is why the old UI copy promised a restart.
 */
export { configFingerprint };

async function readConfigState(io, marketplace) {
  const { agent } = await io.readConfigItems();
  return { fp: configFingerprint(agent, marketplace) };
}

// Re-read the config items and re-bind. `force` bypasses agent-config's memo (the whole point of the
// call) and replaces it, so every later reader — including a subsequent cold path in this microVM —
// sees the new config rather than the boot-time one.
//
// Still fully async, as the spawn it replaced had to be: this runs on a live turn, and blocking the
// event loop for the resolve (~290ms measured at boot, now less without an interpreter start) would
// stall any concurrent invoke in this microVM.
//
// The 20s timeout the spawn carried is gone with the process. The DynamoDB calls underneath keep the
// SDK's own timeouts and retries, which is the bound that was actually doing the work — and a hang
// here is caught by the caller, which keeps serving the previous config.
async function reloadConfigFromDdb() {
  return loadConfig(await loadAgentConfig({ agentName: AGENT_NAME, force: true }));
}

async function readSkillState(io, allowedSkills = null, governedSkills = null) {
  const [mkt, manifest] = await Promise.all([io.readAgentMarketplace(), io.readSkillManifest()]);
  const man = manifest || { skills: {} };
  // Union the fleet-wide always-on skills (e.g. otel-debug) into the agent's installs so every
  // agent — and every newly-spawned agent — materializes them, no per-agent MARKETPLACE write.
  const installs = withAlwaysOn((mkt && mkt.installs) || {}, man);
  // THE SKILL FILTER (plan §7.2 / D3). Tools have applyToolFilter; skills had no equivalent, so a denied
  // skill's PROSE stayed in the prompt and the model kept being instructed to do something it could not.
  // This removes it from what the model is given at all.
  //
  // ABOVE skillFingerprint, and that placement is the whole reason it works: the fingerprint keys the /tmp
  // materialisation, so filtering below it would leave a denied skill's files on disk and re-prune nothing
  // when a policy change removed a holder.
  const filtered = filterPinnedSkills(installs, allowedSkills, governedSkills, man, (skillId) => {
    // LEGIBLE IN OTEL, which the plan makes a condition on this filter. A silent strip is
    // indistinguishable from an agent that never had the skill, so "why did it stop doing X" would be
    // unanswerable. Same msg/shape as a tool denial so one query covers both surfaces.
    onPermissionSignal({ capability: `skill:${skillId}`, surface: 'skill', tool: skillId, reason: 'policy-denied', decision: 'deny' });
  });
  const { fp, names } = skillFingerprint(filtered, man);
  // THE WHOLE MARKETPLACE ITEM rides back, not a slice of it. It lives on the same item this read
  // already fetched, so carrying all of it costs nothing, and every field on it that config
  // resolution consumes — `.models` (the picker), `.connectors` (connector toolkits, plugin-slice.mjs:100),
  // `.customMcp` — reaches the CONFIG fingerprint by construction rather than by someone remembering
  // to add it. Two silent outages came from that list being hand-maintained; see config-fingerprint.mjs.
  //
  // It is still NOT folded into the SKILL fingerprint: that one keys the /tmp skill materialisation,
  // and a model or connector change must not force a needless re-hydrate. The split stays; only the
  // config half's input selection changed.
  return { fp, names, manifest: man, marketplace: mkt || null };
}

// (Re)materialize the agent's installed skills onto /tmp (scoped: installs written, others pruned),
// only when the fingerprint changed since this microVM last hydrated. skill-sync's version-diff
// makes an unchanged set a no-op. Non-fatal — a hydrate failure degrades to whatever's on /tmp.
async function hydrateSkills(io, skill) {
  if (skillState.fp === skill.fp && existsSync(SKILLS_DIR)) {
    SKILL_PATHS = skill.names.length ? [SKILLS_DIR] : [];
    return;
  }
  try {
    const scoped = scopeManifest(skill.manifest, skill.names);
    const sync = await syncSkills({
      skillsDir: SKILLS_DIR, readManifest: async () => scoped, readSkill: io.readSkill,
      log: (o) => console.log(JSON.stringify(o)),
    });
    SKILL_PATHS = skill.names.length ? [SKILLS_DIR] : [];
    skillState.fp = skill.fp;
    console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'skills hydrated (tmp, per-agent installs)', agent: AGENT_NAME, dir: SKILLS_DIR, installed: skill.names.length, paths: SKILL_PATHS.length, fp: skill.fp, ...sync }));
  } catch (e) {
    SKILL_PATHS = (existsSync(SKILLS_DIR) && skill.names.length) ? [SKILLS_DIR] : [];
    console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'skill hydrate failed — serving with on-/tmp skills only', agent: AGENT_NAME, paths: SKILL_PATHS.length, err: e.message }));
  }
}

async function getSession(key, seed = {}) {
  // Per-turn refresh gate (sandra-repo-removal Phase 3): read the agent's skill AND config
  // fingerprints; a warm session with both unchanged is the fast path. When the installed skill
  // set/content changes (marketplace install/uninstall or a hydrator content bump), or when this
  // agent's config changes (model / tool allow-set / plugins / MCP prefixes — AGENT#<id>/CONFIG),
  // the fingerprint flips → re-hydrate /tmp and/or re-resolve the config, then
  // REBUILD the session (SessionManager.open on the same JSONL preserves the conversation — Spike 1).
  const io = await ddbIO();
  // THE POLICY ROW IS READ BEFORE THE SKILLS, because readSkillState's filter needs its `skills` list and
  // the fingerprint is computed there — a policy change must move the fingerprint so /tmp is re-pruned.
  // The same table is reused for the decider below rather than read twice.
  const policyTable = await loadPolicy();
  let skill;
  try {
    skill = await readSkillState(io, policyTable ? policyTable.skills : null, policyTable ? policyTable.skillsGoverned : null);
  } catch (e) {
    // A fingerprint-read failure must not drop the turn: reuse the warm session if any, else
    // build against whatever skills are already on /tmp.
    console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'skill fingerprint read failed — using cached session / current skills', key, err: e.message }));
    const cachedOnErr = sessions.get(key);
    if (cachedOnErr) return cachedOnErr;
    skill = { fp: skillState.fp, names: [], manifest: { skills: {} }, marketplace: skillState.marketplace };
  }
  // Remember the picked model on EVERY successful read, not inside hydrateSkills — that early-returns
  // whenever the skill fingerprint is unchanged, which is exactly the case where only the model moved.
  if (skill.marketplace !== undefined) skillState.marketplace = skill.marketplace;
  // Same discipline as the skill read: a config-fingerprint failure keeps whatever is already
  // resolved rather than dropping the turn or re-resolving blindly.
  let cfg = { fp: configState.fp };
  try {
    cfg = await readConfigState(io, skill.marketplace);
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'config fingerprint read failed — keeping current config', key, err: e.message }));
  }

  const cached = sessions.get(key);
  // warm + skills unchanged + config unchanged → fast path
  if (cached && cached.skillFp === skill.fp && cached.configFp === cfg.fp) return cached;

  // Never acknowledge a new fingerprint while retaining the old model, including the first
  // turn on a prewarmed microVM. A failed re-bind aborts the turn and retries on the next request.
  if (cfg.fp && cfg.fp !== configState.fp) {
    try {
      const refreshed = await refreshSessionConfig(configState, cfg.fp, reloadConfigFromDdb);
      configState = refreshed.state;
      const info = refreshed.info;
      console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'config re-resolved (per-turn)', key, fp: cfg.fp, ...info }));
    } catch (e) {
      console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'config re-resolve FAILED — refusing to use previous model', key, fp: cfg.fp, err: e.message }));
      throw e;
    }
  }

  const gsT0 = Date.now();
  const reason = cached ? (cached.configFp !== cfg.fp ? 'config-change' : 'skill-change') : 'cold';
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'turn: getSession, (re)building session', key, reason }));
  await ensureEfsReady(); // block the first turn (not health) until EFS is mounted + seeded (workspace)
  await hydrateSkills(io, skill); // scoped installed skills -> /tmp (diff; no-op if this microVM is current)
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'turn: ready, building session', key, efsWaitMs: Date.now() - gsT0, skills: skill.names.length }));

  if (cached) { try { cached.session?.dispose?.(); } catch { /* best-effort */ } sessions.delete(key); }
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(CWD, { recursive: true });
  // Cross-boot restore: resolve the logical key -> existing session file via the OpenClaw-compatible
  // sessions.json index; open it, else create + index it. On a skill-change rebuild the file already
  // exists, so open() restores the conversation.
  const resolved = resolveSessionPath({ sessionsDir: SESSIONS_DIR, key });
  let sm;
  let isNew = false;
  if (resolved.found) {
    sm = pca.SessionManager.open(resolved.path);
  } else {
    sm = pca.SessionManager.create(CWD, SESSIONS_DIR);
    isNew = true;
  }
  // Config-driven: inject the bootstrap context files (MEMORY.md/SOUL/…) from the
  // workspace (direct off EFS) and provide only the allow-listed built-in tools.
  const bootstrap = readBootstrapContext(CWD);
  const tools = buildBuiltinTools(ALLOW, CWD);
  // §12c: pass the session key so the cron tool can stamp it onto jobs (the job's channel
  // is derived from it downstream; the agent never has to know its own channel).
  // §12c: the LOGICAL key from the payload, NOT `key` (= AgentCore's sanitised runtimeSessionId).
  // Falls back to null rather than to `key`: a sanitised id would look like a session key while
  // being unparseable, which is worse than absent — the ladder can fall through cleanly on null.
  const memoryTools = buildCustomTools(ALLOW, CWD, { sessionKey: seed.sessionKey ?? null, hindsight: HINDSIGHT_TOOL_CFG });

  // Per-turn mutable ctx (runId/sender), updated by the /invocations handler; read by the
  // compat hooks (connector externalUserId injection). SEEDED here (not just null) because the
  // compat tool factory resolves tools at session-build and mcp-auth binds the sender then
  // (one Pi session == one sender). The handler still refreshes it per turn.
  // Tool-permission enforcement: resolve this conversation's channel, load its grants, and build
  // the decider. effective = baseline ∪ GRANT#* ∪ GRANT#<channel>; every tool_call is gated below.
  // `grants` is a LIVE, MUTABLE Set: both the PEP decider and the tool-filter close over this exact
  // reference, and applyFilter() re-reads + mutates it in place before each turn (see below). So a
  // grant add/revoke takes effect on the NEXT turn with NO session rebuild or runtime restart —
  // even on a warm (cached) session, which reuses this same closure.
  // seed.sessionKey is the LOGICAL Slack key (colon form) the dispatcher sends precisely so this
  // derivation works; `key` is AgentCore's sanitised runtimeSessionId and cannot be parsed (see
  // channelOf). Fall back to `key` for callers that pass the logical key directly (cron/tests).
  const channel = channelOf(seed.sessionKey || key);
  const grants = await loadGrants(channel);
  // The compiled Cedar verdicts, in a mutable holder for exactly the reason `grants` is a mutable Set:
  // the decider and the filter close over this one reference and applyFilter refreshes it per turn, so a
  // pin edit lands on the next turn even on a warm session.
  const policy = policyRef(policyTable);
  const decide = makeDecider({ grants, policy, onSignal: onPermissionSignal });
  // turnStartedAtMs: the clock the model is shown for THIS turn (clock-extension). Stamped
  // per turn by the handler; seeded here so a turn that somehow skips the refresh still gets
  // a real time rather than none.
  const turnCtx = { runId: seed.runId ?? null, sender: seed.sender ?? null, trigger: seed.trigger ?? 'user', channel, agent: AGENT_NAME, turnStartedAtMs: Date.now() };
  const allows = makeAllowCheck({ grants, policy });
  // LOGICAL key, not the sanitised runtime session id. `key` has been through agentcoreSessionId,
  // which replaces every non-[A-Za-z0-9_-] char with '-', so `slack:thread:D0…:172…` arrives as
  // `ac-slack-thread-D0…-172…`. connector-session-plugin's resolveEntityId keys entirely off the
  // colon-delimited shapes, so it returned undefined for EVERY Pi session — no Connector identity on
  // any path, cron or DM. buildCustomTools two lines above already passes seed.sessionKey for
  // exactly this reason; this call was simply missed.
  const { customTools: compatTools, extensionFactory: compatExt } = buildCompatForSession(seed.sessionKey || key, turnCtx);
  const customTools = [...memoryTools, ...compatTools];
  // §8.6: build the capability resolver FROM this session's registered tools' declared `capability`
  // (the single source), plus this agent's MCP prefixes. Compat/connector tools carry no declaration
  // → they fall through to the resolver's dynamic residual (connector/demo_cache/prefix rules).
  const toolCaps = Object.fromEntries(customTools.filter((t) => t && t.name && t.capability).map((t) => [t.name, t.capability]));
  const capabilityOf = makeCapabilityResolver({ mcpPrefixes: MCP_PREFIXES, toolCaps });
  // §8.0 CLOSURE INVARIANT: every tool the model can see must resolve to a provider. A hole (cap
  // 'unknown') can't grant-escape — the PEP already fails it closed — but it's a provenance gap, so
  // log it LOUDLY at boot rather than throw (a hard throw would crash-loop a live agent over an
  // audit gap; the throwing form assertClosure() is the BDD/test gate). Registry is memoized.
  try {
    const surfaced = [...tools, ...customTools].map((t) => t && t.name).filter(Boolean);
    const { ok, holes, byProvider } = checkClosure(surfaced, { capabilityOf, registry: (PROVIDER_REGISTRY ||= buildProviderRegistry()) });
    if (!ok) console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'closure invariant hole(s) — tool(s) with no provider', key, holes }));
    else console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'closure ok', key, providers: Object.keys(byProvider) }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'closure check failed', key, err: e?.message || String(e) }));
  }
  const extensionFactories = [];
  // PEP first: gate every tool_call by capability before the compat/hindsight extensions run.
  extensionFactories.push(createPermissionsExtension({ capabilityOf, decide, turnCtx }));
  if (compatExt) extensionFactories.push(compatExt);
  // R11: build the hindsight extension HERE so its gate uses this session's decider — the same `decide`
  // the tool_call hook uses, closing over the live grants Set and the mutable policy holder. So a
  // hindsight.write pin (or a grant) takes effect on the next turn, and a recall denial appears in
  // permission_decision with the same `reason` vocabulary as every other capability check.
  if (HINDSIGHT_RECALL) {
    extensionFactories.push(createHindsightExtension(HINDSIGHT_RECALL, {
      ...HINDSIGHT_EXT_OPTS, can: makeCan(decide, { agent: AGENT_NAME, channel, surface: 'hindsight' }),
      // Recall runs on Pi's `context` hook, which fires once per PROVIDER REQUEST — so a tool loop
      // re-recalled (and re-timestamped) its injection before every model call, rewriting the
      // cached prefix mid-turn. Both callbacks read the same turn-stable clock the clock extension
      // uses, which makes the injected block byte-identical across the turn's requests.
      getTurnKey: () => turnCtx.turnStartedAtMs,
      getNow: () => turnCtx.turnStartedAtMs || Date.now(),
    }));
  }
  // Clock LAST: hindsight extracts its recall query from the last user message, so it must
  // read the human's text before we append the <current_time> block to it. Reads the
  // turn-stable timestamp off turnCtx (prompt-cache stability across tool-loop steps).
  extensionFactories.push(createModelContextExtension());
  extensionFactories.push(createClockExtension({ getNow: () => turnCtx.turnStartedAtMs || Date.now() }));
  const resourceLoader = makeResourceLoader({ cwd: CWD, bootstrap, extensionFactories, skillPaths: SKILL_PATHS });
  if (typeof resourceLoader.reload === 'function') await resourceLoader.reload();
  const { session } = await pca.createAgentSession({ model: MODEL, tools, customTools, cwd: CWD, sessionManager: sm, resourceLoader });
  if (extensionFactories.length && typeof session.bindExtensions === 'function') await session.bindExtensions({});

  // applyFilter: called by the handler right before each runTurn/prompt(). It (1) RE-READS this
  // channel's grants live and mutates the shared `grants` Set in place — so a grant change lands on
  // the next turn with no restart (the PEP decider sees it too, sharing the Set) — then (2) shrinks
  // the model's active tool set to the granted subset (defense-in-depth over the tool_call PEP).
  // On a transient store error we KEEP the last-known grants rather than wiping a live session
  // mid-conversation; a real revoke still propagates on the next successful read.
  const applyFilter = async () => {
    try {
      const fresh = await (await ddbIO()).readGrants(channel);
      grants.clear();
      for (const c of fresh) grants.add(c);
    } catch (e) {
      console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'per-turn grant refresh failed — keeping last-known', channel, err: e?.message || String(e) }));
    }
    // …and the verdict table on the same cadence, so a policy edit propagates as fast as a grant.
    //
    // NOT the keep-last-known treatment the grants get above, and the asymmetry is deliberate: on a
    // transient error loadPolicy returns a deny-all table, so a store outage stops the agent rather than
    // leaving it running on verdicts that may since have been revoked. Grants can afford to be sticky
    // because they only ever ADD capability over baseline; the table is authoritative in both
    // directions, so stale-but-permissive is the one state it must not hold.
    policy.table = await loadPolicy();
    applyToolFilter(session, { capabilityOf, allows, turnCtx });
  };
  const entry = { session, turnCtx, skillFp: skill.fp, configFp: cfg.fp, sm, applyFilter }; // sm kept for P6 session-shape metrics (in-memory entries)
  sessions.set(key, entry);
  if (isNew) {
    const sessionId = sm.sessionId ?? sm.getSessionId?.();
    const file = sm.sessionFile ?? sm.getSessionFile?.();
    try {
      // ONE POINTER FILE PER KEY (session-store.mjs). No shared index, so parallel threads and
      // spawned suagent-zh8hwws cannot clobber each other's sessions — which the old single
      // `sessions.json` did on every concurrent write, and why restore had never once succeeded.
      writeIndexEntry({ sessionsDir: SESSIONS_DIR, key, sessionId, sessionFile: file });
    } catch (e) {
      // ERROR, not warn: a lost pointer means this conversation silently starts over on the next
      // microVM, which is exactly the failure that went unnoticed for months.
      console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'session index write FAILED — this conversation will not survive a restart', key, err: e.message }));
    }
  }
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'session', key, mode: resolved.found ? 'restored' : 'created', reason, skills: skill.names.length, extensions: extensionFactories.length, customTools: customTools.map((t) => t.name) }));
  return entry;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 5 * 1024 * 1024) throw Object.assign(new Error('payload too large'), { statusCode: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function handler(req, res) {
  try {
    const path = (req.url || '').split('?')[0];
    if (req.method === 'GET' && path === '/ping') {
      return sendJson(res, ready ? 200 : 503, { status: ready ? (busy > 0 ? 'HealthyBusy' : 'Healthy') : 'Unhealthy' });
    }
    if (req.method === 'POST' && path === '/invocations') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJson(res, e.statusCode || 400, { error: 'invalid JSON body' }); }
      const prompt = body?.input?.prompt ?? body?.prompt;
      if (typeof prompt !== 'string' || prompt.trim() === '') return sendJson(res, 400, { error: 'input.prompt is required and must be a non-empty string' });
      const sessionId = String(req.headers[SESSION_HEADER] || body?.sessionId || DEFAULT_SESSION_ID);
      const stream = wantsStream(req, body);
      // M3 cross-boundary stitch (plan §4.3): adopt the dispatcher's inbound trace context so
      // this turn's agent_i073q7 span parents into the dispatcher.request tree (one traceId in
      // aws/spans). Precedence: traceparent header → x-amzn-trace-id header → body.input.traceparent
      // (the designed portable primary the dispatcher injects). Malformed/absent → fresh trace,
      // exactly as before. The log line is the S1 evidence: presence booleans + winning source
      // only (no header values, no message content) — one live invoke answers whether AgentCore
      // forwards trace headers to /invocations.
      const traceCtx = extractTraceContext(req.headers, body?.input);
      console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'trace-context', hasTraceparentHeader: traceCtx.hasTraceparentHeader, hasAmznTraceHeader: traceCtx.hasAmznTraceHeader, hasPayloadTraceparent: traceCtx.hasPayloadTraceparent, source: traceCtx.source, traceId: traceCtx.traceId }));
      busy += 1;
      const tStart = Date.now();
      const span = otel && otel.mode !== 'off'
        ? otel.startSpan('agent_i073q7', traceCtx.traceId ? { traceId: traceCtx.traceId, parentSpanId: traceCtx.parentSpanId } : {})
        : null;
      // Queryable in aws/spans: which trace-context source stitched this span (or 'none').
      if (span) span.attributes['trace.context_source'] = traceCtx.source || 'none';
      // WHOSE 15 SECONDS. Measured over 282 turns (2026-08-13): the gap between the dispatcher
      // issuing InvokeAgentRuntime and THIS handler running is trimodal — <200ms, ~2s, or 12–18s —
      // and 24% of turns land in the 12–18s mode. Nothing in the trace could say why, because the
      // gap spans a boundary neither side instruments: AgentCore's scheduling plus, possibly, this
      // container booting. These two integers settle it from the runtime side. `uptime_ms` at
      // request receipt roughly equal to the gap means the microVM booted FOR this request (the
      // cost is ours, and ColdBootMs bounds it); much larger means the container was already up and
      // idle, so the wait was AgentCore claiming/routing it (the cost is not ours to optimise, only
      // to pre-warm around). `turn_index` separates the first request a microVM ever serves from
      // later ones.
      turnIndex += 1;
      if (span) {
        span.attributes['agentcore.container.uptime_ms'] = Math.round(process.uptime() * 1000);
        span.attributes['agentcore.container.turn_index'] = turnIndex;
      }
      let ttftMs = null;   // stream: ms from request start to the first delta (time-to-first-token)
      let deltaCount = 0;  // stream: number of delta events emitted
      // Turn trigger: hoisted above okAttrs so BOTH the stream and buffered spans self-tag it. Lets a
      // runtime agent_i073q7 span be filtered by origin directly, without walking up to the
      // dispatcher.request parent (obs cron-tracing gap).
      //
      // VALUES ARE THE SLACK EVENT TYPE, not 'user': the dispatcher passes `trigger: event.type ||
      // 'user'` (index.js), so the live set is `message` | `app_mention` | `cron` (+ `warmup` in
      // windows before the warm-up path was deleted, 2026-08-11). The `'user'` default only fires for
      // a caller that sends no trigger at all. insight-queries.js SLACK_TRIGGERS depends on this,
      // because `message`/`app_mention` are exactly the turns that have a matching
      // MessagesReceivedCount record — changing these strings breaks that join.
      const trigger = body?.trigger ?? body?.input?.trigger ?? 'user';
      const okAttrs = (out, cls, extra = {}) => ({
        'agent_i32pz9.operation.name': 'agent_i073q7',
        'agent_i32pz9.conversation.id': sessionId,
        'session.id': sessionId,
        'agent_i32pz9.request.model': out.model || MODEL.id,
        // Tokens/cache/cost for the WHOLE turn, not just its last model call — see turnUsageAttrs.
        ...turnUsageAttrs(out),
        'agent_i32pz9.response.finish_reasons': cls.finishReasons,      // P4: 'stop' for empty no-ops
        'agentcore.turn.outcome': cls.outcome,                    // P4: reply|empty|error
        'agentcore.turn.trigger': trigger,                        // user|cron — cron-fire filterable on the runtime span
        ...extra,
      });
      try {
        // Resolve sender/run id BEFORE getSession so the compat tool factory (mcp-auth
        // senderUserMap) binds the correct sender when it resolves tools at session-build.
        // The dispatcher encodes the sender in "u:<userId>:<uuid>"; fall back to the session id.
        const runId = body?.runId ?? body?.input?.runId ?? body?.sender ?? sessionId;
        const sender = body?.sender ?? body?.input?.sender ?? null;
        // §12c: the LOGICAL Slack session key (`slack:thread:<ch>:<ts>`), distinct from `sessionId`
        // — that is AgentCore's runtimeSessionId, already sanitised (colons/dots → dashes) and so
        // unparseable for channel derivation. The dispatcher sends the logical key in the payload;
        // the cron tool stamps it onto jobs. Live-caught by a §12c gate: without this the tool
        // stamped 'ac-slack-thread-…-1786307500-991' and the channel ladder never resolved.
        const logicalSessionKey = body?.input?.sessionKey ?? body?.sessionKey ?? null;
        // G7: per-turn model override (cron payload.model, normalised to a bare Bedrock id by the
        // dispatcher). Applied for the duration of THIS turn only and then restored; unresolvable
        // ids fall back to the agent's configured model rather than failing the turn.
        const modelOverride = body?.input?.model ?? body?.model ?? null;
        // PHASE 3 of the per-turn credential: point DISPATCHER_SHARED_SECRET at THIS turn's token,
        // in-process. See dispatcher-token.mjs for why the env var is the interface and why it is
        // set-or-deleted rather than left alone.
        const hasDispatcherToken = applyDispatcherToken(body?.input ?? body, process.env);
        // Queryable in aws/spans: with no boot-resolved fallback, a turn that arrives without a
        // token is a turn whose every dispatcher call will fail — and this is the only thing that
        // distinguishes "the dispatcher did not send one" from "the call was refused".
        if (span) span.attributes['dispatcher.token'] = hasDispatcherToken ? 'present' : 'absent';
        // Warm/cold BEFORE getSession creates the entry — the span attribute is otherwise always true.
        const sessionWasWarm = sessions.has(sessionId);
        const { session, turnCtx, sm, applyFilter } = await getSession(sessionId, { runId, sender, trigger, sessionKey: logicalSessionKey });
        // Refresh per-turn ctx (connector externalUserId injection reads this at call time).
        turnCtx.runId = runId;
        turnCtx.sender = sender;
        turnCtx.trigger = trigger;
        turnCtx.turnStartedAtMs = tStart; // the wall clock this turn is shown (clock-extension)

        if (stream) {
          // Streamed response (text/event-stream): forward delta/tool events as they occur,
          // then a terminal 'final' built from the aggregate. Headers go out immediately so
          // the SDK's response stream delivers chunks incrementally (verified — Phase 0).
          res.writeHead(200, { ...SSE_HEADERS });
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          await applyFilter?.(); // re-read grants + shrink the tool surface before the turn snapshots context.tools
          const tSessionReady = Date.now(); // session hydrated + tool surface resolved; prompt build starts here
          bedrockMark.begin();
          const out = await withModel(session, modelOverride, () => runTurn(session, prompt, (ev) => {
            if (ev.type === 'delta') { deltaCount += 1; if (ttftMs === null) ttftMs = Date.now() - tStart; }
            try { res.write(encodeSse(ev)); } catch { /* client gone */ }
          }));
          const firstDispatchMs = bedrockMark.firstDispatch();
          bedrockMark.end();
          const cls = classifyTurn(out);
          try { res.write(encodeSse(finalEvent({ text: out.text, usage: out.usage, model: out.model, stopReason: out.stopReason }))); } catch { /* client gone */ }
          res.end();
          if (span) await otel.end(span, { attributes: okAttrs(out, cls, {
            'agentcore.response.mode': 'stream',
            'agentcore.stream.ttft_ms': ttftMs ?? undefined,       // key streaming latency metric
            'agentcore.stream.delta_count': deltaCount,
            'agentcore.stream.response_chars': out.text ? out.text.length : 0,
          }), error: cls.isError ? (out.errorMessage || 'turn error') : undefined });
          await emitPrepareSpans(span, {
            tStart, tSessionReady, firstModelStartMs: out.modelCalls?.[0]?.startMs, sessionWasWarm, firstDispatchMs,
          }, sessionId);
          await emitToolSpans(span, out.toolCalls, sessionId);
          await emitModelCallSpans(span, out.modelCalls, sessionId, tStart);
          emitReplyMetrics({ out, latencyMs: Date.now() - tStart, ttftMs, cls });
          emitSessionShapeMetrics(sm, out.model);
          return;
        }

        await applyFilter?.(); // re-read grants + shrink the tool surface before the turn snapshots context.tools
        const tSessionReadyBuffered = Date.now(); // see the stream branch — same mark, buffered path
        bedrockMark.begin();
        const out = await withModel(session, modelOverride, () => runTurn(session, prompt));
        const firstDispatchBufferedMs = bedrockMark.firstDispatch();
        bedrockMark.end();
        const cls = classifyTurn(out);
        if (span) await otel.end(span, { attributes: okAttrs(out, cls, { 'agentcore.response.mode': 'buffered' }), error: cls.isError ? (out.errorMessage || 'turn error') : undefined });
        await emitPrepareSpans(span, {
          tStart,
          tSessionReady: tSessionReadyBuffered,
          firstModelStartMs: out.modelCalls?.[0]?.startMs,
          sessionWasWarm,
          firstDispatchMs: firstDispatchBufferedMs,
        }, sessionId);
        await emitToolSpans(span, out.toolCalls, sessionId);
        await emitModelCallSpans(span, out.modelCalls, sessionId, tStart);
        emitReplyMetrics({ out, latencyMs: Date.now() - tStart, cls });
        emitSessionShapeMetrics(sm, out.model);
        return sendJson(res, 200, { output: { response: out.text, sessionId }, usage: out.usage, model: out.model, stopReason: out.stopReason });
      } catch (turnErr) {
        // LOG IT. The streaming branch below returns before the outer catch's "request failed"
        // line, so a thrown turn on the stream path produced NO log entry at all — only a span and
        // a TurnErrorCount datapoint. Live cost (2026-08-12): turns failing in 200ms with zero
        // tokens, and CloudWatch Logs showing nothing but the metric. The stack matters here
        // because the error is otherwise only visible as a message on a span.
        console.error(JSON.stringify({
          level: 'error', component: 'pi-adapter', msg: 'turn failed',
          agent: AGENT_NAME, sessionId, stream, latencyMs: Date.now() - tStart,
          err: turnErr && turnErr.message, name: turnErr && turnErr.name,
          stack: turnErr && turnErr.stack ? String(turnErr.stack).split('\n').slice(0, 5).join(' | ') : undefined,
        }));
        if (span) await otel.end(span, { attributes: {
          'agent_i32pz9.operation.name': 'agent_i073q7',
          'agent_i32pz9.conversation.id': sessionId,
          'session.id': sessionId,
          'agentcore.response.mode': stream ? 'stream' : 'buffered',
          'agentcore.turn.outcome': 'error',                       // P4: a thrown turn is a genuine error
          // Whether any partial output already reached the client before the failure — separates
          // "failed before first token" from "failed mid-stream", which drives user-facing recovery.
          'agentcore.stream.partial': stream ? (res.headersSent && deltaCount > 0) : undefined,
          'agentcore.stream.ttft_ms': ttftMs ?? undefined,
          'agentcore.stream.delta_count': stream ? deltaCount : undefined,
        }, error: turnErr.message });
        emitTurnMetrics({ latencyMs: Date.now() - tStart, ttftMs: stream ? ttftMs : undefined, tokensIn: 0, tokensOut: 0, model: MODEL.id, isError: true });
        // If the stream already started, headers are sent — we can't send a JSON error status.
        // Surface the failure in-band (error + terminal final) so the consumer closes the run.
        if (stream && res.headersSent) {
          try { res.write(encodeSse(errorEvent(turnErr.message))); res.write(encodeSse(finalEvent({ text: '' }))); } catch { /* client gone */ }
          try { res.end(); } catch { /* already ended */ }
          return;
        }
        throw turnErr; // pre-stream (or buffered path) → outer catch returns a JSON error status
      } finally { busy = Math.max(0, busy - 1); }
    }
    return sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.statusCode || 500;
    console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'request failed', err: err.message, status }));
    return sendJson(res, status, { error: err.message || 'internal error' });
  }
}

async function boot() {
  bootPhase('adapter_start');
  process.env.AWS_REGION = process.env.AWS_REGION || process.env.REGION || 'us-east-1';
  try {
    const exp = await refreshAwsEnvCreds();
    console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'aws creds resolved for bedrock gate', expiration: exp }));
  } catch (e) {
    console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'aws creds resolve failed', err: e.message }));
  }
  setInterval(() => { refreshAwsEnvCreds().catch((e) => console.error(JSON.stringify({ level: 'warn', component: 'pi-adapter', msg: 'cred refresh failed', err: e.message }))); }, 20 * 60 * 1000).unref();
  await registerBedrock();
  // Before the first Bedrock client exists, so the http2 wrapper is in place for every session it
  // opens. Reports its own success: a silently-failed install would show up later as a prepare_turn
  // that simply stopped splitting, which is indistinguishable from "the split isn't deployed yet".
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'bedrock dispatch mark', installed: bedrockMark.install() }));
  // Memoized: the entrypoint already resolved this, so on the normal boot path this is a cache hit,
  // not a second DynamoDB read. It still resolves if the adapter is imported without the entrypoint.
  const cfgInfo = loadConfig(await loadAgentConfig({ agentName: AGENT_NAME }));
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'config', ...cfgInfo }));
  // Before anything can build a session. Non-fatal by construction (prewarmCompatPlugins isolates
  // per-plugin failures and bounds the wait), so a Connector outage delays boot briefly rather than
  // preventing the agent from serving.
  await prewarmCompat();
  // OTEL exporter: agent_i32pz9.* spans -> X-Ray. resourceAttributes match the OpenClaw adapter
  // so the CloudWatch GenAI Observability views + existing queries pick these up. cloud.resource_id
  // (P0) makes each span attributable to THIS runtime — self-read from AgentCore's injected
  // OTEL_RESOURCE_ATTRIBUTES. Log the raw injected value + resolved id once at boot so we can
  // empirically confirm what AgentCore provides to our (non-ADOT-instrumented) container.
  const resourceId = resolveResourceId();
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'otel resource attribution', otelResourceAttributes: process.env.OTEL_RESOURCE_ATTRIBUTES || null, resourceId: resourceId || null }));
  otel = createExporter({
    mode: process.env.AGENTCORE_OTEL_MODE || 'off',
    region: process.env.AWS_REGION || 'us-east-1',
    serviceName: AGENT_NAME,
    resourceAttributes: {
      'aws.service.type': 'agent_i32pz9',
      ...(resourceId ? { 'cloud.resource_id': resourceId } : {}),
    },
  });
  console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'otel exporter', mode: otel.mode }));
  await initHindsight();
  const server = http.createServer(handler);
  server.listen(PORT, '0.0.0.0', () => {
    ready = true;
    bootPhase('adapter_listening');
    const ms = Date.now() - BOOT_EPOCH_MS;
    bootPhase('ready');
    emitColdBootMetric(ms);
    console.log(JSON.stringify({ level: 'info', component: 'pi-adapter', msg: 'listening', port: PORT, model: MODEL.id, agent: AGENT_NAME, sessionsDir: SESSIONS_DIR, cwd: CWD, coldBootMs: ms }));
    // Do NOT touch EFS here. Per the AgentCore docs the BYO-EFS mount is available "only at
    // the time of agent invocation, not during initialization" — probing/seeding at listen
    // races the mount and (previously) seeded the ephemeral overlay. ensureEfsReady() is
    // triggered lazily on the first getSession (invocation), where the mount is guaranteed.
  });
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      try { for (const s of sessions.values()) s.session?.dispose?.(); } catch { /* best-effort flush */ }
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
  }
}

// THE one place a fatal boot is reported. Metric first, then the log (which carries the stack), then
// exit 1 — so the alarm fires even if stderr is lost, and the log always outlives the metric's detail.
boot().catch((e) => {
  emitBootFailed(e);
  console.error(JSON.stringify({ level: 'error', component: 'pi-adapter', msg: 'boot failed', err: e?.stack || e?.message || String(e) }));
  process.exit(1);
});

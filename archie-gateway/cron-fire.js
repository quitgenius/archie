'use strict';

// The cron fire handler (pi-cron-migration-plan.md §3/§7): the function the runner
// calls when a job is due. It IS the runner's `fire` dependency. A cron fire is just
// "an inbound turn whose source is a timer" — so it reuses the AgentCore invoke path.
// The one difference from the Slack request path: there is no Slack thread to stream
// into, so it collects the FINAL turn output and hands it to `deliver` (announce/none).
// The dispatcher is the sole scheduler for every agent.
//
// If anything in the fire path throws, it propagates so the runner records the error
// and increments consecutiveErrors (→ failureAlert). Delivery only runs on success.

// M2: @opentelemetry/api only — a no-op tracer until index.js's `require('./tracing')`
// registers the provider. This module must never require ./tracing itself (DI/testability).
const { trace: otelTrace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');
const tracer = otelTrace.getTracer('slack-dispatcher');

const {
  classifyDelivery, scheduleOf, resolveCronTimeoutMs, resolveCronModel, CRON_TIMEOUT_ERROR,
} = require('./cron-inventory-metrics');
const { CRON_RUNNER } = require('./cron-runner-flag');
// The claim decode only — never the minter. Where the signing secret lives stays index.js's business
// (deps.mintTurnToken), but reading back the jti of a token this module was handed is pure.
const { claimsOf } = require('./turn-token');

const NOOP_CHUNK = () => {};

// Slack for the token beyond the turn's own budget. The turn is aborted at the budget, but the
// abort and the last in-flight dispatcher call are not simultaneous — a tool call already on the
// wire when the timer fires must not fail on an expired credential and report a confusing auth
// error instead of the timeout that actually happened.
const TOKEN_MARGIN_MS = 5 * 60_000;

/**
 * Tell the agent how its output reaches anyone — the cron counterpart of the Slack path's
 * replyInstruction (index.js: "Incoming Slack message — just reply with text. Your response is
 * streamed to Slack automatically.").
 *
 * A cron fire used to send the bare `payload.message` with NO such context, so the agent had no
 * way to know its text IS the delivery. Observed live: agents refusing with "I don't have a Slack
 * messaging tool available in this session — I can't send the message." They were not wrong about
 * their tools (Pi drops slack-reply, connector's slack isn't loaded); they were uninformed about
 * the mechanism, and only on this path.
 *
 * The `none` branch carries the most weight: 207 of 263 enabled prod jobs (79%) have no delivery,
 * and for those the agent should ACT with its tools rather than compose a reply nobody reads.
 */
function deliveryInstruction(job) {
  let mode = 'none';
  let status = 'no-delivery';
  try { ({ mode, status } = classifyDelivery(job)); } catch { /* fall through to the safe default */ }

  if (mode === 'announce' && status === 'ok') {
    return '\n\n[Scheduled turn. Your reply text is delivered to Slack automatically when this turn '
      + 'ends — just write it. There is no messaging tool to call and you do not need one.]';
  }
  if (mode === 'announce') {
    return '\n\n[Scheduled turn. This job has a delivery target configured but it does not resolve, '
      + 'so your reply will NOT reach anyone. Do the work; keep any reply short.]';
  }
  return '\n\n[Scheduled BACKGROUND turn. Your output is NOT delivered anywhere and nobody will read '
    + 'it. Do the work using your tools — do not compose a reply for a user, and do not report that '
    + 'you cannot send a message.]';
}

/**
 * The prompt for this fire. `agentTurn` carries `message`; `systemEvent` carries `text` — reading
 * only `message` meant every systemEvent job invoked with prompt=undefined and the runtime 400'd.
 * 19 enabled prod jobs are systemEvent.
 */
/**
 * Tell the agent it is INSIDE a scheduled run, and that the repetition it can see is the schedule.
 *
 * A cron job holds ONE session across fires (buildCronSessionKey — deliberate, it reproduces
 * upstream `isolated`), so by the tenth fire the agent is looking at ten copies of its own output.
 * Live 2026-08-12: `hiccup-ping` (every 2m) read its own history, concluded "this is firing
 * repeatedly — there's a runaway cron job", called cron.remove, and DELETED ITSELF mid-turn. The
 * removal is logged three seconds before the turn that issued it completed.
 *
 * Nothing was faulty: stable sessions are right, cron.remove is a real tool, and the agent's
 * reasoning was sound given what it could see. The gap was that nothing told it the repetition was
 * its own schedule. This closes that. The hard guard is separate — the runtime denies cron.remove
 * on a cron-triggered turn — because being persuasive is not the same as being safe.
 */
function scheduleContext(job) {
  const sched = job && job.schedule;
  let when = '';
  try {
    if (sched && sched.kind === 'every' && Number.isFinite(sched.everyMs)) {
      when = ` every ${Math.round(sched.everyMs / 1000)}s`;
    } else if (sched && sched.kind === 'cron' && sched.expr) {
      when = ` on "${sched.expr}"`;
    }
  } catch { /* context is best-effort — never fail a fire to describe it */ }
  return `\n\n[This is a SCHEDULED run of cron job "${(job && job.name) || (job && job.jobId)}"`
    + `${when}. You are reading this job's own past runs in this session — repeated identical output `
    + 'is the schedule working, NOT a runaway. Do not delete or disable this job on that basis.]';
}

function promptFor(job) {
  const p = (job && job.payload) || {};
  const base = typeof p.message === 'string' ? p.message : (typeof p.text === 'string' ? p.text : '');
  return `${base}${scheduleContext(job)}${deliveryInstruction(job)}`;
}

/**
 * M4.4: config attributes for the fire span, from the SAME classifier the inventory gauge and
 * (next) the add-time validation use — one rule, no drift. Defensive: a job shape we can't
 * classify must not stop the fire, so any throw degrades to no attributes.
 */
function cronSpanAttrs(job) {
  try {
    const { mode, channel, status } = classifyDelivery(job);
    const sched = scheduleOf(job);
    return {
      'cron.delivery.mode': mode,
      'cron.delivery.status': status,
      'cron.delivery.channel': channel || 'none',
      'cron.schedule.kind': sched.kind,
      ...(job && job.state && job.state.nextRunAtMs ? { 'cron.next_run_at_ms': job.state.nextRunAtMs } : {}),
      ...(job && job.sessionTarget ? { 'cron.session_target': job.sessionTarget } : {}),
      // G7: the two ported payload fields, on the span — so "did this job get the budget/model it
      // asked for" is answerable from the trace instead of by reading the store.
      'cron.timeout_ms': resolveCronTimeoutMs(job) ?? 0, // 0 = unbounded (span attrs can't be null)
      ...(resolveCronModel(job) ? { 'cron.model': resolveCronModel(job) } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * §12c.7 (G7) — run `fn` under the job's wall-clock budget.
 *
 * `timeoutMs === null` means UNBOUNDED (upstream's `timeoutSeconds: 0`), in which case this is a
 * pure passthrough — no timer, no AbortController, so the unbounded path costs nothing and cannot
 * be broken by this code.
 *
 * On expiry we ABORT the invoke and throw upstream's verbatim error text, so the failure is
 * indistinguishable from an OpenClaw timeout to everything downstream: the runner's
 * consecutiveErrors → failureAlert path, and cron-hydrator's `classifyUpstreamFailure`. Aborting
 * (rather than just stopping the wait) is the point — otherwise the turn keeps running on the
 * runtime, billed and with its side effects intact, and we have merely looked away.
 *
 * The timer is always cleared, including on the success path, so a long-lived dispatcher does not
 * accumulate one pending timer per fire.
 */
async function withTimeout(timeoutMs, fn, { span, log, job, onTimeoutKill } = {}) {
  if (timeoutMs == null) return fn(undefined);
  const controller = new AbortController();
  let timer = null;
  let timedOut = false;
  try {
    const budget = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new Error(CRON_TIMEOUT_ERROR));
      }, timeoutMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    });
    return await Promise.race([fn(controller.signal), budget]);
  } catch (err) {
    if (timedOut) {
      // Distinguishable in the trace from an invoke failure: same error text as upstream, but the
      // span carries the budget that was exceeded so "which jobs need a bigger budget" is queryable.
      try {
        span?.setAttribute('cron.timed_out', true);
        span?.setAttribute('cron.timeout_ms', timeoutMs);
        span?.addEvent('cron.timed_out', { 'cron.timeout_ms': timeoutMs });
      } catch { /* enrichment must never mask the timeout */ }
      if (log?.warn) log.warn({ jobId: job && job.jobId, timeoutMs }, 'cron fire timed out — invoke aborted');
      // Alarmable counterpart to the span attribute above. A span is queryable after the fact; an
      // alarm is what tells someone it happened. Wrapped because telemetry must never convert a
      // timeout into a different failure.
      try { onTimeoutKill?.(job, { timeoutMs }); } catch { /* never mask the timeout */ }
      // NORMALISE, don't rely on which side of the race settled first.
      //
      // Caught by its own test: `controller.abort()` rejects the in-flight invoke SYNCHRONOUSLY, so
      // the SDK's AbortError beat our timeout rejection and propagated instead. The error TEXT is
      // load-bearing — cron-hydrator's classifyUpstreamFailure buckets on it, so a real timeout
      // would have been filed as `failing-upstream` rather than `run-timeout`, and would no longer
      // have matched a rolled-back OpenClaw timeout. Reordering abort/reject would only narrow the
      // window; converting here closes it, including for an `fn` that ignores the signal entirely.
      if (err && err.message === CRON_TIMEOUT_ERROR) throw err;
      const timeoutErr = new Error(CRON_TIMEOUT_ERROR);
      timeoutErr.cause = err; // keep the underlying abort for debugging
      throw timeoutErr;
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * @param deps.agentCore         agentcore-client ({ ensureRuntime, invokeStreaming })
 * @param deps.ensureRuntime     optional (agent, {logger}) => arn — the image-pointer-aware
 *                               resolver. Supply it, or cron ignores published images.
 * @param deps.sessionIdFor      (job) => runtimeSessionId (main=stable per-agent, isolated=fresh)
 * @param deps.deliver           async (job, final) => void  (Phase 2; default no-op)
 * @param deps.now               () => epoch-ms (injectable for test determinism)
 * @param deps.runnerFlags       optional { isAgentCore(agentId), get(agentId) } — the per-scope
 *                               CRON_RUNNER gate (cron-runner-flag.js). Absent = ungated, which is
 *                               what the unit tests and any pre-flag caller get.
 * @param deps.mintTurnToken      optional ({scope,sessionId,runId,expMs}) => string — the per-turn
 *                               dispatcher credential (archie-docs/archie-dispatcher-token-plan.md).
 *                               Injected rather than imported so this module keeps no opinion about
 *                               where the signing secret lives, and so a test can assert the claims
 *                               without a real one. Absent → no token on the payload, which is a
 *                               valid state: the runtime ignores the field either way.
 * @param deps.turnTokens        optional { open(claims), close(claims) } — the revocation store
 *                               (turn-token-store.js). Injected for the same reason as the minter.
 *                               Absent → no revocation row, which is what every unit test gets.
 * @param deps.onTimeoutKill      optional (job, {timeoutMs}) => void — telemetry for a run killed
 *                               at the ceiling. The ONLY way we kill a cron run since the per-job
 *                               budget was removed, so it is alarmable at >= 1.
 * @param deps.onRunnerGated     optional (job, {runner, source}) => void — telemetry for a declined
 *                               fire. Without it a gated scope is invisible to every metric.
 * @param deps.log               optional pino-shaped logger
 */
function createCronFire(deps) {
  const { agentCore, sessionIdFor } = deps;
  // The image-aware runtime resolver. Cron fires are turns like any other, so they must honour the
  // published image pointer — a path that calls agentCore.ensureRuntime directly resolves the name
  // from the dispatcher's BAKED image and silently pins cron-driven agents to the build image while
  // the Slack path rolls. Caught live on the first roll. Defaults to the raw client so callers that
  // predate the pointer (and the unit tests) behave exactly as before.
  const ensureRuntimeFor = deps.ensureRuntime
    || ((agent, o) => agentCore.ensureRuntime(agent, o));
  const deliver = deps.deliver || (async () => {});
  const now = deps.now || Date.now;
  const runnerFlags = deps.runnerFlags || null;
  const onTimeoutKill = deps.onTimeoutKill || (() => {});
  const mintTurnToken = deps.mintTurnToken || null;
  const turnTokens = deps.turnTokens || { async open() {}, async close() {} };
  const onRunnerGated = deps.onRunnerGated || (() => {});
  const log = deps.log || { info() {}, warn() {}, error() {} };

  /**
   * The CRON_RUNNER gate (§3a'). A scope whose runner is not `agentcore` still HYDRATES, still
   * ARMS and still ticks here — it just does not fire, because its OpenClaw gateway is still firing
   * the same jobs from the same definitions. See cron-runner-flag.js for why the flag is per scope
   * and why absent means openclaw.
   *
   * The check is per FIRE, not per arm, so flipping a scope in App Home takes effect on the next
   * tick with no restart and no re-arm — the same "hot flip" property the capability grants have.
   *
   * A gated fire is a SUCCESS, not an error: returning normally leaves consecutiveErrors at zero,
   * so a scope waiting on its cutover cannot trip failureAlert simply for not being ours yet.
   *
   * `manual: true` (App Home "Run now", POST /:agentId/:jobId/run) BYPASSES it deliberately. That
   * is a human pressing a button in archie's own UI, once — it is how you prove a hydrated job
   * works here BEFORE handing the schedule over, and a single explicit run cannot produce the
   * sustained double-fire the gate exists to prevent.
   */
  async function runnerGate(job, opts, span) {
    if (!runnerFlags) return null;
    const rec = await runnerFlags.get(job.agentId);
    if (rec.runner === CRON_RUNNER.AGENTCORE) return null;
    try {
      span.setAttribute('cron.runner', rec.runner);
      span.setAttribute('cron.runner.source', rec.source);
    } catch { /* enrichment must never decide whether we fire */ }
    if (opts && opts.manual) {
      log.warn({ agent: job.agentId, jobId: job.jobId, runner: rec.runner },
        'cron manual run BYPASSES the CRON_RUNNER gate — this scope\'s schedule still belongs to openclaw');
      return null;
    }
    log.info({ agent: job.agentId, jobId: job.jobId, runner: rec.runner, source: rec.source },
      'cron fire skipped — CRON_RUNNER is not agentcore for this scope');
    try { onRunnerGated(job, rec); } catch { /* telemetry must never break the scheduler */ }
    // Deliberately NOT shaped like a `final` (no `text`): no turn ran, and a caller that reads
    // `.text` off this should get `undefined` rather than an empty string that reads as "the turn
    // had nothing to say".
    return { gated: true, runner: rec.runner };
  }

  async function fire(job, opts = {}) {
    // M2: dispatcher.request is the SERVER root span for a cron-triggered turn (the timer is
    // the "caller"). Same span name as the Slack path so one query covers both triggers.
    return tracer.startActiveSpan('dispatcher.request', {
      kind: SpanKind.SERVER,
      attributes: {
        'dispatcher.trigger': 'cron',
        'dispatcher.agent': job.agentId,
        'dispatcher.cron.job_id': job.jobId,
        ...(job.sessionKey ? { 'dispatcher.session_key': job.sessionKey } : {}),
        // M4.4: config context on the span itself, so a trace answers "what was this job supposed
        // to do and was it even valid" without a side trip to the cron store.
        ...cronSpanAttrs(job),
      },
    }, async (span) => {
      // Hoisted so the `finally` can revoke it however this fire ends — INCLUDING the timeout kill,
      // which is the one exit where revocation matters most: the runtime has been aborted and is not
      // coming back, so anything still holding the token is not it.
      let tokenClaims = null;
      try {
        const child = (log.child ? log.child({ jobId: job.jobId, agent: job.agentId }) : log);

        // FIRST, before anything with a cost or a side effect: ensureRuntime CREATES the agent's
        // runtime and starts the billing clock, so a gate placed after it would still boot every
        // un-migrated agent in the fleet on its own schedule.
        const gated = await runnerGate(job, opts, span);
        if (gated) {
          span.setAttribute('cron.gated', true);
          return gated;
        }

        const runtimeArn = await ensureRuntimeFor(job.agentId, { logger: child });
        const sessionId = sessionIdFor(job);
        // G7: the per-job model override, normalised to a bare Bedrock id. The runtime falls back to
        // the agent's configured model when it cannot resolve this — deliberately not a hard failure
        // (agent-k4wmx6's 4 jobs name `global.anthropic.claude-opus-4-8`, which postdates the pinned
        // pi-ai catalog, so a strict runtime would break 4 working jobs to honour a preference).
        const model = resolveCronModel(job);
        const runId = `cron:${job.agentId}:${job.jobId}:${now()}`;
        // PHASE 1 of the per-turn credential: the token's life is THIS job's budget plus a margin.
        // A cron turn can legitimately run for hours (7h50m ceiling), so a fixed TTL would either
        // expire mid-run on the long jobs or be uselessly loose on the short ones. The budget is
        // already computed on the next line to drive the abort signal; reusing it means the token
        // and the turn die together by construction.
        const tokenTtlMs = resolveCronTimeoutMs(job) + TOKEN_MARGIN_MS;
        const dispatcherToken = mintTurnToken
          ? mintTurnToken({ scope: job.agentId, sessionId, runId, expMs: now() + tokenTtlMs })
          : null;
        // Presence of the row is the token's liveness, so it opens before the invoke. A failed write
        // is logged by the store and does not abort the fire.
        tokenClaims = dispatcherToken ? claimsOf(dispatcherToken) : null;
        if (tokenClaims) await turnTokens.open(tokenClaims);
        const body = {
          input: {
            prompt: promptFor(job),
            runId,
            sender: job.connectorEntity || null, // per-job Connector identity (§7); null = system
            trigger: 'cron',
            sessionKey: job.sessionKey || null,
            ...(dispatcherToken ? { dispatcherToken } : {}),
            ...(model ? { model } : {}),
          },
        };

        // retryIncomplete: a cold microVM can be reaped mid-turn, closing the stream with no
        // final event. Retry within the cold window; if it still can't complete, invokeStreaming
        // throws → recorded as a fire failure (never a silent no-op).
        // M1 D6: agent + trigger drive the ClawdbotDispatcher invoke metrics (latency / cold-retries /
        // errors) emitted inside invokeStreaming — same single helper as the Slack path.
        const final = await withTimeout(
          resolveCronTimeoutMs(job),
          (signal) => agentCore.invokeStreaming(runtimeArn, sessionId, body, NOOP_CHUNK, {
            logger: child, retryIncomplete: true, agent: job.agentId, trigger: 'cron', abortSignal: signal,
          }),
          { span, log: child, job, onTimeoutKill },
        );
        // A turn that THREW inside the runtime arrives as an empty final carrying `error` (see
        // invokeStreaming). Treat it as a fire failure: without this the run is recorded 'ok',
        // consecutiveErrors RESETS, and failureAlert can never trip on a job that fails every
        // single time — verified live, a job erroring on every fire looked perfectly healthy.
        if (final && final.error) {
          const turnErr = new Error(final.error);
          turnErr.turnError = true;
          throw turnErr;
        }

        // Success-path visibility (§9f): before this, only failures logged — the Phase 3
        // E2E had to be verified by hand-inspecting EFS. Log the completed fire (no PHI:
        // just lengths + delivery mode, not the turn text).
        const deliveryMode = (job.delivery && job.delivery.mode) || 'none';
        child.info(
          { sessionId, textLen: (final && final.text && final.text.length) || 0, deliveryMode },
          'cron fire completed',
        );
        const result = await deliver(job, final);
        // M4.4: record the DELIVERY outcome on the span. Without this the span is green for a
        // failed announce — verified live: the span for a job that failed invalid_arguments was
        // status UNSET with zero delivery attributes, so Transaction Search reported a clean 4.8s
        // success. `deliver` swallows by design (a failed announce must not bump consecutiveErrors
        // and trip failureAlert) and that stays true — we make the outcome VISIBLE, not fatal.
        // Guarded: enrichment must never be the thing that breaks a fire.
        try {
          const delivered = !!(result && result.delivered);
          span.setAttribute('cron.delivery.delivered', delivered);
          if (result && result.reason) span.setAttribute('cron.delivery.skip_reason', String(result.reason));
          if (result && result.error) {
            span.setAttribute('cron.delivery.error', String(result.error));
            span.addEvent('cron.delivery.failed', { 'cron.delivery.mode': deliveryMode, 'cron.delivery.error': String(result.error) });
            // The FIRE succeeded but the turn never reached anyone — that is an error for anyone
            // reading the trace, even though it is deliberately not an error for the scheduler.
            span.setStatus({ code: SpanStatusCode.ERROR, message: `delivery: ${result.error}` });
          }
        } catch (attrErr) {
          child.warn({ err: String(attrErr && attrErr.message) }, 'cron span delivery enrichment failed');
        }
        return final;
      } catch (err) {
        // propagate — the runner records the failure; the span just marks it.
        span.recordException(err);
        span.setStatus({ code: SpanStatusCode.ERROR, message: err && err.message });
        throw err;
      } finally {
        // §8.8: revoke on FINAL completion, not per attempt. invokeStreaming retries internally and
        // those retries share the token, so this sits outside the whole awaited call — and a timeout
        // is a completion. Never throws.
        if (tokenClaims) await turnTokens.close(tokenClaims);
        span.end();
      }
    });
  }

  return { fire };
}

module.exports = { createCronFire, withTimeout, deliveryInstruction, promptFor };

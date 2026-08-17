'use strict';

// `archie fleet healthcheck` — W2-A, and the plan's one required-and-unbuilt item (§7).
//
// This is the gate. `image publish` refuses to move the pointer to a tag whose healthcheck has
// not passed, in every mode including --hotfix and rollback, and there is no force flag. So this
// file decides whether anything ships. Everything below exists because a weaker version of it would
// pass a broken image.
//
// WHY IT HAD TO BE REBUILT. A synthetic warm-up invoke existed until 2026-08-11 and was correctly
// deleted: it cost p50 ~16.5s of a p50 30.1s provision and sat INLINE in the user's turn, so it
// amortised nothing (`agentcore-client.js:412-419`). Off the turn path that objection disappears,
// and nothing else can do this job — publish-time checks prove only that the image is in ECR with
// the right architecture, and `archie-0.2.2` shipped with a missing Dockerfile COPY that passed
// both and crash-looped.
//
// FOUR THINGS LEARNED BY RUNNING THIS, NOT BY READING:
//
//   1. CONTROL-PLANE READY IS NOT SERVING-READY. Measured 2026-08-14: a probe ~1s after
//      GetAgentRuntime returned READY got HTTP 500, and succeeded on retry ~15s later. THE FIRST
//      FAILURE MEANS NOTHING. Treating it as a broken image would reject healthy builds every time,
//      which is why the budget is 2 minutes and why it is a floor rather than a ceiling — a cold
//      boot can reach ~90s when the BYO-EFS mount attach dominates
//      (`agentcore-tests/features/support/agentcore-fixture.js:513-517`).
//
//   2. `/ping` IS NOT REACHABLE through InvokeAgentRuntime. The container exposes only `/ping` and
//      `/invocations` (`agentcore-pi/pi-adapter.mjs:1065,1068`), and the data plane reaches the
//      latter. So the check MUST be a real prompt — which is the stronger check anyway: it proves
//      the model path works, not merely that a process is listening.
//
//   3. SESSION IDS MUST BE >= 33 CHARACTERS or AgentCore rejects with ParamValidation. A 31-char id
//      once meant "the nudge silently never ran and @connector's discovery never fired"
//      (`agentcore-fixture.js:649-651`). Same padding rule as the dispatcher's own
//      `agentcoreSessionId` (`archie-gateway/index.js:532-535`).
//
//   4. AN EMPTY-TEXT TURN AFTER AN `error` EVENT IS A FAILURE, NOT A PASS. The runtime reports a
//      thrown turn in-band as `error` then `final {text:''}`; a caller reading only `final` sees an
//      empty-but-successful turn. Live consequence 2026-08-12: a cron job whose turns failed every
//      time was recorded status:'ok' and RESET consecutiveErrors, so its alarm could never trip
//      (`agentcore-client.js:1309-1314`). `invokeStreaming` surfaces it as `.error` on the result;
//      this file treats that as failure, loudly.

const path = require('node:path');
const { EXIT, CliError, usage, tainted } = require('../lib/exit');

const DEFAULT_BUDGET_SECONDS = 120;
const MIN_BUDGET_SECONDS = 120;          // see §6.2: raise, never lower. Taint is permanent.
const DEFAULT_PROMPT = 'Reply with the single word: ok';
const RETRY_GAP_MS = 8000;

/**
 * The isolated session key from plan §7.
 *
 * A dedicated key gets the synthetic turn its own microVM session and its own EFS session file, so
 * it cannot pollute the agent's real conversation. Hindsight under Pi is recall-only
 * (`agentcore-pi/hindsight-extension.mjs:1-14`), so there is no retain leg to write a memory either.
 *
 * The >= 33 rule is AgentCore's, and violating it fails as ParamValidation rather than as anything
 * that mentions length.
 */
function prewarmSessionId(agent, tag) {
  const base = `prewarm-${agent}-${tag}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return base.length >= 33 ? base.slice(0, 100) : base + '0'.repeat(33 - base.length);
}

/**
 * Is this failure worth retrying inside the budget?
 *
 * Almost everything is, and that is deliberate. The whole premise is that a runtime which is not
 * serving YET looks identical to one that never will — a 500, a stream abort, a connection reset.
 * The budget, not the error class, is what distinguishes them. The exceptions are failures that
 * cannot become true by waiting.
 */
function isTerminal(err) {
  const name = String((err && (err.name || err.Code || err.code)) || '');
  // The runtime, the binding or the caller's permission to invoke it are not going to appear.
  return /ResourceNotFound|AccessDenied|UnrecognizedClient|ValidationException|ParamValidation/i.test(name);
}

/**
 * Run ONE real turn against ONE agent's runtime, retried until the budget is exhausted.
 *
 * Resolves `{ ok: true, attempts, ms }` on a pass. THROWS on failure — `cmd/stage.js` treats any
 * throw without `notImplemented` as a failure that taints the tag, which is the contract
 * that makes this a gate rather than a report.
 */
async function runHealthcheck({
  agent, tag, runtimeArn, sessionId, budgetSeconds, ctx, out, deps = {},
} = {}) {
  if (!runtimeArn) throw new CliError(`healthcheck: no runtime ARN for ${agent}`, { code: EXIT.FAILED });

  const budget = Number(budgetSeconds) > 0 ? Number(budgetSeconds) : DEFAULT_BUDGET_SECONDS;
  const session = sessionId || prewarmSessionId(agent, tag);
  const prompt = deps.prompt || DEFAULT_PROMPT;
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || Date.now;
  const invoke = deps.invoke || defaultInvoke(ctx, deps);

  const started = now();
  const deadline = started + budget * 1000;
  let attempts = 0;
  let lastErr = null;

  for (;;) {
    attempts += 1;
    try {
      // `retryIncomplete: false` — this file owns the retry budget. Letting the client also retry
      // internally would multiply two budgets together and make the observed wait unexplainable.
      const final = await invoke({ runtimeArn, sessionId: session, prompt, agent });

      // See note 4. An `error` event surfaces here as `.error` even when `final` looks complete.
      if (final && final.error) {
        throw new Error(`the turn reported an error event: ${final.error}`);
      }
      if (!final) {
        throw new Error('the stream closed without a final event (incomplete turn)');
      }
      const text = typeof final.text === 'string' ? final.text : '';
      if (!text.trim()) {
        // No error event, but nothing said. A turn that produces no text has not demonstrated the
        // model path, which is the only thing this check is for.
        throw new Error('the turn completed but produced no text');
      }

      const ms = now() - started;
      out?.verbose?.(`healthcheck ${agent}: served in ${ms}ms after ${attempts} attempt(s), ${text.trim().length} chars`);
      return { ok: true, attempts, ms, sessionId: session };
    } catch (e) {
      lastErr = e;
      const terminal = isTerminal(e);
      const remaining = deadline - now();
      out?.verbose?.(`healthcheck ${agent}: attempt ${attempts} failed (${e.name || 'Error'}: `
        + `${String(e.message).slice(0, 120)}), ${terminal ? 'terminal' : `${Math.max(0, Math.round(remaining / 1000))}s left`}`);

      if (terminal) break;
      if (remaining <= RETRY_GAP_MS) break;
      await sleep(RETRY_GAP_MS);
    }
  }

  const ms = now() - started;
  throw new CliError(
    `healthcheck FAILED for ${agent} on ${tag} after ${attempts} attempt(s) over ${Math.round(ms / 1000)}s`,
    {
      code: EXIT.TAINTED,
      cause: lastErr,
      detail: 'Control-plane READY is not serving-ready, so the first failure means nothing and this '
        + `waited ${Math.round(ms / 1000)}s. Exhausting the budget means the image does not serve.`,
    },
  );
}

/**
 * The real invoker. Built from the dispatcher's own client so the healthcheck exercises the same
 * data-plane path a turn does — a check that used a different invoke could pass while turns fail.
 */
function defaultInvoke(ctx, deps = {}) {
  const { createAgentCoreClient } = deps.agentcoreClientModule
    || require(path.join(__dirname, '..', '..', 'archie-gateway', 'agentcore-client.js'));
  // NOOP_METRICS, because the CLI is not the dispatcher and must not publish its metrics.
  //
  // Observed live 2026-08-15: without this, a single healthcheck emitted SessionQueueDepth and
  // SessionQueueWaitMs into **ClawdbotDispatcher** — another stack's namespace — because the client
  // resolves its namespace from its own environment at require time, and this process is not that
  // one. Omitting `opts.agent` silenced the invoke metrics but left these two, relabelled
  // `Agent: "unknown"`, which is worse: 208 of them per release, attributed to nothing.
  //
  // Release-scoped signals belong to `archie emit-release-metrics`, under its own dimension, with
  // agent and tag as EMF properties (plan §7).
  const { NOOP_METRICS } = deps.metricsModule
    || require(path.join(__dirname, '..', '..', 'archie-gateway', 'dispatcher-metrics.js'));
  const client = createAgentCoreClient({
    region: ctx.region,
    metrics: NOOP_METRICS,
    ...(ctx.resources ? { agentConfigTable: ctx.resources.configTable } : {}),
  });
  return async ({ runtimeArn, sessionId, prompt, agent }) => client.invokeStreaming(
    runtimeArn,
    sessionId,
    // The payload shape pi-adapter accepts: `input.prompt` must be a NON-EMPTY string
    // (`agentcore-pi/pi-adapter.mjs:1071-1073`), which is also why `/ping` cannot serve here.
    { input: { prompt, trigger: 'healthcheck', sender: null } },
    () => {},
    // `agent` is DELIBERATELY OMITTED, and it is not an oversight.
    //
    // The client gates invoke metrics on `opts.agent != null` (`agentcore-client.js:1232`), so
    // passing it emits InvokeLatencyMs / InvokeColdRetries on the normal `Agent` dimension.
    // Observed live 2026-08-15: a healthcheck against one runtime published into
    // **ClawdbotDispatcher** — another stack's namespace entirely, because the dispatcher client
    // resolves its namespace from its own env at require time and the CLI is not that process.
    //
    // Plan §7 is explicit that these synthetic turns must not land on the normal dimension: ~208 of
    // them per release would skew the very turn-latency panels used to judge the release, and each
    // one is a deliberate cold first-invoke, so it would drag exactly the metric that matters. The
    // release-scoped metrics belong to `archie emit-release-metrics`, with agent and tag as
    // EMF *properties* rather than dimensions.
    //
    // `trigger` is kept: it costs nothing and it is what distinguishes these turns in the logs.
    { trigger: 'healthcheck', retryIncomplete: false },
  );
}

// ── the command ──────────────────────────────────────────────────────────────────────────────────

function parseBudget(value, out) {
  if (value === undefined) return DEFAULT_BUDGET_SECONDS;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw usage(`--budget must be a positive number of seconds, got "${value}"`);
  if (n < MIN_BUDGET_SECONDS) {
    // Refused, not warned. Taint is permanent, and a budget below the observed serving-ready delay
    // converts platform variance into false taints — the one failure this command must not produce.
    throw new CliError(`--budget ${n}s is below the ${MIN_BUDGET_SECONDS}s floor`, {
      code: EXIT.REFUSED,
      detail: 'Control-plane READY is not serving-ready (measured: 500 at +1s, served at +15s) and a '
        + 'cold boot can reach ~90s. The budget may be raised, never lowered — taint is permanent.',
    });
  }
  if (out && n > DEFAULT_BUDGET_SECONDS) out.verbose(`healthcheck budget raised to ${n}s`);
  return n;
}

async function healthcheck(ctx, args, out, deps = {}) {
  const { scanBindings, tagOf } = require('../lib/bindings');
  const stage = require('./stage');

  // `--tag` is still read for the two-word alias (`archie fleet healthcheck`), where the
  // value an old runbook passes is a tag now.
  const tag = args.values.tag || args.values.generation || args.positionals[0];
  const agent = args.values.agent;
  if (!tag) throw usage('--tag <tag> is required');
  if (!agent) throw usage('--agent <id> is required');

  const budgetSeconds = parseBudget(args.values.budget, out);
  // Default ON. Off only for investigating an already-tainted tag — see the refusal below.
  const taintOnFailure = args.values['no-taint-on-failure'] ? false : true;

  // The `{ doc() }` accessor shape the shared readers take — reused from cmd/stage.js rather than
  // re-spelled, so there is one place where --profile is threaded to the clients the dispatcher's
  // client builds for itself.
  const aws = deps.aws || stage.clientsFor(ctx, deps);

  // NO EXISTENCE CHECK ON THE TAG ITSELF. There is no item to read any more, and the binding IS the
  // stronger check: a live binding for this tag means a runtime was provisioned on this image and is
  // there to invoke. A tag with no binding cannot be healthchecked whether or not it exists in ECR.
  const rows = await scanBindings(aws, ctx);
  const binding = rows.find((r) => r.agent === agent && tagOf(r) === tag);
  if (!binding || !binding.arn) {
    throw new CliError(`${agent} has no live binding for ${tag}`, {
      code: EXIT.REFUSED,
      detail: 'Run `archie fleet stage` first — there is nothing to invoke.',
    });
  }

  out.progress(`healthcheck  ${agent} on ${tag}  budget ${budgetSeconds}s`);
  if (ctx.dryRun) {
    out.progress('[dry-run] would invoke the runtime once on an isolated prewarm session');
    return { agent, tag, dryRun: true, sessionId: prewarmSessionId(agent, tag) };
  }

  try {
    const res = await runHealthcheck({
      agent, tag: tag, runtimeArn: binding.arn, budgetSeconds, ctx, out, deps,
    });
    out.progress(`ok           ${agent} served in ${res.ms}ms after ${res.attempts} attempt(s)`);
    return { agent, tag, ...res };
  } catch (e) {
    if (taintOnFailure) {
      await stage.taintGeneration(aws, ctx, tag, {
        reason: `healthcheck failed for ${agent}: ${String(e.message).slice(0, 200)}`,
        by: process.env.USER || 'archie',
        at: new Date().toISOString(),
      });
      out.warn(`${tag} is now TAINTED and can never be published. `
        + 'Fix the image and build again — the fixed image is a new tag, and there is no untaint.');
    } else {
      out.warn('--no-taint-on-failure: the tag was NOT tainted. Use this only when '
        + 'investigating a tag that is already tainted.');
    }
    throw e instanceof CliError ? e : tainted(String(e.message), { cause: e });
  }
}

module.exports = {
  'fleet healthcheck': healthcheck,
  healthcheck,
  runHealthcheck,
  prewarmSessionId,
  parseBudget,
  isTerminal,
  defaultInvoke,
  DEFAULT_BUDGET_SECONDS,
  MIN_BUDGET_SECONDS,
  DEFAULT_PROMPT,
};

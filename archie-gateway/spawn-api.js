'use strict';

// `POST /spawn` — run a turn as YOURSELF, in a fresh child session
// (archie-docs/archie-sessions-spawn-plan.md).
//
// THE ONE REQUIREMENT THAT DECIDES THE WHOLE DESIGN: there must be no way to spawn under a different
// scope. That is why this route reads NO identity from the body. The scope comes from the per-turn
// token the caller already presents on `x-dispatcher-secret` (dispatcher-auth.js), which is signed,
// expiring and scope-bound — so "spawn as another agent" is unrepresentable rather than forbidden.
// The plan predicted exactly this: build the credential first and the spawn route becomes one more
// consumer of it instead of the reason for it.
//
// SAME SCOPE ⇒ SAME EVERYTHING. The child runs on the same runtime ARN, hence the same derived role,
// the same grants and the same EFS workspace. Spawning is not an escalation path, which is why it
// needs no capability beyond the one that let the agent reach the dispatcher at all.
//
// NOT STREAMING, deliberately (plan §4): a Pi tool returns once, so a stream could only surface
// progress somewhere else — and Slack's streaming cards die ~5 minutes after startStream, so a long
// child would produce a doomed append chain rather than useful progress.

const express = require('express');
const crypto = require('node:crypto');

// Depth 1 = a turn may spawn; a spawned turn may not. This is NOT a taste call — it is what keeps the
// two-semaphore scheme deadlock-free. The spawn pool is safe only while its occupants cannot
// themselves be waiting on it, and a grandchild is exactly that. Raising this without adding a third
// pool reintroduces the fleet-wide invoke deadlock the separate pool exists to prevent.
const MAX_SPAWN_DEPTH = 1;

// Leave the parent enough of its own budget to receive the child's answer and do something with it.
// The child's ceiling is derived from the parent's token expiry, never from a constant.
const PARENT_BUDGET_MARGIN_MS = 30_000;

// A floor on what is worth starting. Below this the child cannot finish a single model call, so it
// would burn a permit to return a timeout.
const MIN_CHILD_MS = 15_000;

const DEFAULT_CHILD_MS = 5 * 60_000;

/**
 * The child's session id.
 *
 * MUST DIFFER FROM THE PARENT'S, and this is load-bearing rather than cosmetic: `invokeStreaming`
 * enforces one invoke in flight per runtimeSessionId (`runExclusiveForSession`). A child reusing the
 * parent's id would wait for a lock the parent holds while the parent waits for the child —
 * immediate deadlock, broken only by a timeout. Any later change that "reuses the session for
 * continuity" reintroduces it.
 */
function childSessionId(parentSessionId, nonce) {
  const base = `ac-spawn-${String(parentSessionId || 'none')}-${nonce}`.replace(/[^A-Za-z0-9_-]/g, '-');
  // AgentCore requires >= 33 chars; pad rather than truncate so the parent stays readable in the id.
  return base.length >= 33 ? base.slice(0, 100) : base + '0'.repeat(33 - base.length);
}

/**
 * How long the child may run.
 *
 * FROM THE PARENT'S TOKEN, not a request field. `exp` already carries this turn's deadline — 30
 * minutes for a Slack turn, budget + margin for a cron run — so the child is bounded by the turn
 * that is blocked waiting for it, with no new plumbing and no way for a child to outlive its parent.
 * A caller may ask for LESS, never more.
 */
function childBudgetMs(claims, requestedSeconds, now) {
  const parentRemainingMs = Number.isFinite(claims && claims.exp)
    ? (claims.exp * 1000) - now - PARENT_BUDGET_MARGIN_MS
    : DEFAULT_CHILD_MS;
  const requested = Number.isFinite(requestedSeconds) && requestedSeconds > 0
    ? requestedSeconds * 1000
    : DEFAULT_CHILD_MS;
  return Math.min(requested, parentRemainingMs);
}

/**
 * @param deps.agentCore     the AgentCore client (ensureRuntime + invokeStreaming)
 * @param deps.ensureRuntime image-pointer-aware resolver, as the cron path uses
 * @param deps.mintTurnToken (claims) => token — mints the CHILD's credential at depth+1
 * @param deps.turnTokens    the revocation store
 * @param deps.now           () => epoch ms
 * @param deps.log           pino-shaped logger
 */
function createSpawnApi(deps) {
  const { agentCore } = deps;
  const ensureRuntime = deps.ensureRuntime || ((agent, o) => agentCore.ensureRuntime(agent, o));
  const mintTurnToken = deps.mintTurnToken || null;
  const turnTokens = deps.turnTokens || { async open() {}, async close() {} };
  const now = deps.now || Date.now;
  const newNonce = deps.newNonce || (() => crypto.randomBytes(6).toString('hex'));
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const router = express.Router();

  // EVERY failure is `{ ok: false, error }` with HTTP 200 unless the CALLER is wrong.
  //
  // The consumer is a Pi tool, and a tool result the model can read beats an exception it retries.
  // A refused depth, a timeout and a child that errored are all outcomes of a working system; the
  // model should see them as text and decide, not treat them as a broken tool.
  const fail = (res, error, extra = {}) => res.json({ ok: false, error, ...extra });

  router.post('/', async (req, res) => {
    const auth = req.dispatcherAuth;
    // Belt and braces: the mount is behind requireToken, so this cannot normally be reached without
    // a token. It is asserted anyway because a future re-mount outside that gate would otherwise
    // turn "spawn as yourself" into "spawn as whoever you name", silently.
    if (!auth || auth.kind !== 'token' || !auth.scope) {
      return res.status(401).json({ ok: false, error: 'spawn requires a per-turn dispatcher token' });
    }
    const scope = auth.scope;
    const claims = auth.claims || {};
    const child = log.child ? log.child({ agent: scope, route: 'spawn' }) : log;

    const prompt = req.body && typeof req.body.prompt === 'string' ? req.body.prompt.trim() : '';
    if (!prompt) return res.status(400).json({ ok: false, error: 'prompt is required' });

    const depth = Number.isFinite(claims.depth) ? claims.depth : 0;
    if (depth >= MAX_SPAWN_DEPTH) {
      // A tool result, not an error: the model asked for something reasonable and the answer is no.
      child.info({ depth }, 'spawn refused — depth cap');
      return fail(res, `spawned sessions cannot spawn again (depth ${depth}/${MAX_SPAWN_DEPTH}). `
        + 'Do this work in the current session, or return to the parent and let it spawn.');
    }

    const budgetMs = childBudgetMs(claims, Number(req.body && req.body.timeoutSeconds), now());
    if (budgetMs < MIN_CHILD_MS) {
      // The parent is nearly out of time. Starting a child now would burn a permit to return a
      // timeout, and the parent could not use the answer even if it arrived.
      child.info({ budgetMs }, 'spawn refused — not enough of the parent turn left');
      return fail(res, 'not enough time left in this turn to spawn a child session');
    }

    const sessionId = childSessionId(claims.sessionId, newNonce());
    const runId = `spawn:${scope}:${now()}`;
    let childClaims = null;

    try {
      const runtimeArn = await ensureRuntime(scope, { logger: child });

      // The child's OWN credential, at depth+1 — which is what stops it spawning again. Its life is
      // the child's budget, so it dies with the child rather than with the parent.
      const token = mintTurnToken
        ? mintTurnToken({ scope, sessionId, runId, depth: depth + 1, expMs: now() + budgetMs + 60_000 })
        : null;
      if (token) {
        const { claimsOf } = require('./turn-token');
        childClaims = claimsOf(token);
        if (childClaims) await turnTokens.open(childClaims);
      }

      const body = {
        input: {
          prompt,
          runId,
          sender: null,
          trigger: 'spawn',
          sessionKey: null,
          ...(token ? { dispatcherToken: token } : {}),
        },
      };

      const started = now();
      // `spawned: true` selects the SEPARATE concurrency pool. Without it this call queues behind
      // permits held by turns that are waiting on it — see agentcore-client.js MAX_CONCURRENT_SPAWNS.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), budgetMs);
      let final;
      try {
        final = await agentCore.invokeStreaming(runtimeArn, sessionId, body, () => {}, {
          logger: child, agent: scope, trigger: 'spawn', spawned: true, abortSignal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (final && final.error) {
        child.warn({ err: final.error }, 'spawned turn returned an error');
        return fail(res, `the spawned session errored: ${final.error}`, { sessionId });
      }
      const ms = now() - started;
      child.info({ sessionId, ms, textLen: (final && final.text && final.text.length) || 0 }, 'spawn complete');
      return res.json({
        ok: true,
        text: (final && final.text) || '',
        usage: (final && final.usage) || null,
        stopReason: (final && final.stopReason) || null,
        sessionId,
        ms,
      });
    } catch (err) {
      const aborted = /abort/i.test(String(err && err.message));
      child.error({ err: String(err && err.message), aborted }, 'spawn failed');
      return fail(res, aborted
        ? `the spawned session ran past its ${Math.round(budgetMs / 1000)}s budget and was stopped`
        : `the spawned session could not be run: ${String(err && err.message)}`, { sessionId });
    } finally {
      // Same rule as every other turn: revoke on FINAL completion, timeout included.
      if (childClaims) await turnTokens.close(childClaims);
    }
  });

  return router;
}

module.exports = { createSpawnApi, childSessionId, childBudgetMs, MAX_SPAWN_DEPTH, MIN_CHILD_MS, PARENT_BUDGET_MARGIN_MS };

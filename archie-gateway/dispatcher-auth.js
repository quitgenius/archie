'use strict';

// PHASE 2 of the per-turn credential (archie-docs/archie-dispatcher-token-plan.md): the dispatcher
// starts ACCEPTING the token it began minting in phase 1, alongside the shared secret.
//
// ONE HEADER, TWO CREDENTIALS. `x-dispatcher-secret` carries either the fleet-wide secret (today) or
// a per-turn token (phase 3), told apart by shape. That is D3's compatibility argument made concrete:
// ~230 EFS workspaces contain scripts that read `$DISPATCHER_SHARED_SECRET` and send it under this
// header (`create-agent/SKILL.md` does exactly that), and they cannot be audited. Same name, same
// header, new lifetime — so when the runtime's env var starts holding a token in phase 3, every one
// of those scripts keeps working and becomes scope-bound for free.
//
// WHAT THE TOKEN BUYS, stated precisely: the secret authenticates *"a member of this fleet"*, and
// every agent-reachable route then takes its subject from the request itself — so an agent can CRUD
// another agent's cron jobs, redeem another agent's approvals, or read another agent's opt-out. With
// a token the subject comes from the SIGNATURE, and `enforceScope` below makes naming another scope
// unrepresentable rather than merely forbidden.
//
// DUAL-ACCEPT IS A MIGRATION STATE, NOT THE DESIGN. While it lasts, presenting the shared secret is
// still full cross-scope authority, so this phase NARROWS nothing on its own — it makes the token
// work so phase 3 can flip the runtime and phase 4 can retire the secret. The hole closes in phase 4.

const crypto = require('node:crypto');
const { verifyTurnToken, VERSION } = require('./turn-token');

// A token is recognisable by its version prefix, and nothing else is. The static secret is random
// bytes from Secrets Manager and cannot collide with `v1.` unless someone chooses it to — and the
// consequence if it did is a 401 on a misconfigured dispatcher, not a bypass.
//
// EXACTLY THE VERSION WE MINT. This briefly matched any `v<n>.` so that a token from a newer task
// during a rolling deploy would reach the verifier and report `unknown_version` rather than
// `invalid`. That was speculative: there is no v2, this API is not versioned (file-ref.js, the
// module this is modelled on, carries no version at all), and both paths 401 regardless — only the
// reason string differs. Whoever introduces a v2 can widen this deliberately.
const looksLikeToken = (v) => typeof v === 'string' && v.startsWith(`${VERSION}.`);

// The metric's vocabulary (§8.8), which is deliberately COARSER than the verifier's. `malformed`,
// `unknown_version` and `invalid` all mean the same operationally — this did not come from us — and
// splitting them across dimensions would split one alarm into three. The precise reason still goes
// in the log line.
const METRIC_REASON = {
  missing: 'missing',
  expired: 'expired',
  revoked: 'revoked',
  // The revocation store could not be read. Its own dimension so it is triageable, but NOT alarmed:
  // the config table being unreachable already breaks every turn at the runtime (pi-adapter reads
  // grants, policy and config from it per turn, unguarded), so it will have alarmed long before this
  // metric says anything. An alarm here would only restate that.
  unavailable: 'unavailable',
  // PHASE 4. The fleet-wide secret on a route that now requires a token — the alarm this whole plan
  // was built to make possible. It has no benign explanation once the hydrator is on /admin/cron.
  shared_secret: 'shared_secret',
  // A bad or missing key on the ADMIN surface. Its own reason because the admin key is a different
  // credential with a different holder: a failure here is an infrastructure caller, never an agent.
  admin_denied: 'admin_denied',
  malformed: 'unknown',
  unknown_version: 'unknown',
  invalid: 'unknown',
};

// WHERE THE SUBJECT LIVES, enumerated — because express populates `req.params` per ROUTER and this
// runs at the app level, before any router has matched. Reading the path directly is what lets one
// middleware cover every route instead of threading a guard through two route modules and a dozen
// handlers, and it means the 403 happens BEFORE a handler can act.
//
// `segment` is the 0-based index of the agent id in the path AFTER the prefix. Both entries hold
// because every route under `/cron/` takes the agent id first (`/:agentId`, `/:agentId/runner`,
// `/:agentId/:jobId`, `/:agentId/:jobId/run`) — verified against cron-api.js's router.
//
// THE FAILURE MODE IF THAT STOPS BEING TRUE is a new `/cron/<something-else>` route read as an agent
// id, which 403s a token caller. That is loud and fails closed, which is the right direction for a
// table that can drift — but it is a table that can drift, so it is tested against the live route
// list rather than trusted.
const PATH_SUBJECT = [
  { prefix: '/cron/', segment: 0 },
  { prefix: '/approvals/optout/', segment: 0 },
];

const BODY_SUBJECT_PATHS = ['/cron', '/approvals', '/approvals/redeem'];

function pathSubject(path) {
  if (typeof path !== 'string') return null;
  for (const { prefix, segment } of PATH_SUBJECT) {
    if (!path.startsWith(prefix)) continue;
    const seg = path.slice(prefix.length).split('/')[segment];
    if (seg) return decodeURIComponent(seg);
  }
  return null;
}

// The routes an AGENT reaches. After phase 4 these are TOKEN-ONLY: presenting the fleet-wide shared
// secret to one of them is refused and alarmed, which is only unambiguous because the hydrator — the
// one legitimate secret-bearing caller of /cron — moved to /admin/cron with its own key.
//
// Everything NOT in this list (/reload, /simulate, /routes, /debug/streaming, /files/download) is
// operator surface and keeps accepting the shared secret: those callers are people and CI, they have
// no turn, and there is no token for them to hold.
const AGENT_ROUTE_PREFIXES = ['/cron', '/approvals', '/api'];

/**
 * @param deps.secret      the fleet-wide shared secret (still accepted this phase)
 * @param deps.turnTokens  the revocation store (turn-token-store.js) — `isLive(claims)`
 * @param deps.metrics     dispatcher metrics (emitTokenRejected)
 * @param deps.log         pino-shaped logger
 */
function createDispatcherAuth(deps = {}) {
  const { secret, turnTokens } = deps;
  const metrics = deps.metrics || { emitTokenRejected() {} };
  const log = deps.log || { info() {}, warn() {}, error() {} };
  if (!secret) throw new Error('createDispatcherAuth: secret required');

  function timingSafeEquals(presented, expected) {
    const a = Buffer.from(presented || '');
    const b = Buffer.from(expected || '');
    // timingSafeEqual throws on a length mismatch, and a length mismatch is the common case here.
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  const secretMatches = (header) => timingSafeEquals(header, secret);

  function reject(req, res, reason, detail) {
    const claimed = detail && detail.scope;
    metrics.emitTokenRejected(METRIC_REASON[reason] || 'unknown', { agent: claimed });
    log.warn({ reason, scope: claimed || null, path: req.path, method: req.method }, 'dispatcher auth rejected');
    // D6: fail closed, and report the reason VERBATIM. The tool surfaces it to the model, and the
    // four reasons answer different questions — "my turn ended" is not "someone forged this".
    return res.status(401).json({ ok: false, error: 'unauthorized', reason });
  }

  /**
   * Authenticate. Sets `req.dispatcherAuth = { kind: 'token'|'secret', scope, claims }`.
   *
   * `scope` is null for a secret-authenticated caller — there is nothing to derive it from, which is
   * the whole problem this replaces.
   */
  async function authenticate(req, res, next) {
    // Express 4 does not propagate a rejected promise from async middleware — it neither 500s nor
    // calls the error handler, it simply never responds, and the request hangs until the client
    // gives up. An auth gate that can hang is worse than one that can 401, so everything below is
    // wrapped and an unexpected throw fails CLOSED.
    try {
      return await authenticateInner(req, res, next);
    } catch (err) {
      log.error({ err: String(err && err.message), path: req.path }, 'dispatcher auth threw — failing closed');
      return reject(req, res, 'invalid');
    }
  }

  async function authenticateInner(req, res, next) {
    const presented = req.headers['x-dispatcher-secret'];
    if (!presented) return reject(req, res, 'missing');

    if (!looksLikeToken(presented)) {
      if (!secretMatches(presented)) return reject(req, res, 'invalid');
      req.dispatcherAuth = { kind: 'secret', scope: null, claims: null };
      return next();
    }

    const r = verifyTurnToken(presented, secret);
    if (!r.valid) return reject(req, res, r.reason);

    // Signature and expiry are settled; only revocation is left, and that is a store read.
    //
    // ANYTHING BUT `live` IS A REFUSAL — one rule, no degraded mode.
    //
    // An earlier version accepted on an unreadable store, reasoning that refusing would take the
    // whole fleet's dispatcher calls down on one DynamoDB blip. That was wrong about the blast
    // radius: the runtime reads its grants, policy and config from THIS SAME TABLE on every turn
    // (pi-adapter.mjs readGrants/readPolicy/readConfigItems, unguarded), so a table that cannot be
    // read is a table where turns are already failing. The window fail-open actually bought was an
    // in-flight turn during a brief blip — bought with a second security mode that silently accepts
    // revoked credentials, and with the operator having to know which mode was in force.
    const liveness = await turnTokens.isLive(r.claims);
    if (liveness !== 'live') return reject(req, res, liveness, { scope: r.claims.scope });
    req.dispatcherAuth = { kind: 'token', scope: r.claims.scope, claims: r.claims };
    return next();
  }

  /**
   * D5: the subject comes from the TOKEN, and a request that names a different one is refused.
   *
   * Applies only to token-authenticated callers. A secret-authenticated caller (the hydrator, the
   * operator tooling, and every agent until phase 3) passes through untouched — it has no scope to
   * check against, which is the state phase 4 ends.
   *
   * TWO ACTIONS, and the second is what makes cross-scope action UNREPRESENTABLE rather than merely
   * forbidden:
   *   MISMATCH → 403. Silently substituting the token's scope would "work" and hide both of the
   *     things a mismatch can be: a bug in a tool, or an attempt. Neither should be invisible.
   *   ABSENT   → inject. The route then reads its own `agentId` exactly as it always has, and there
   *     is no route left where a caller can decline to name a scope and have one inferred from
   *     something it controls.
   */
  function enforceScope(req, res, next) {
    const auth = req.dispatcherAuth;
    if (!auth || auth.kind !== 'token') return next();
    const scope = auth.scope;

    const fromPath = pathSubject(req.path);
    if (fromPath && fromPath !== scope) return mismatch(req, res, scope, fromPath, 'path');

    const body = req.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (typeof body.agentId === 'string' && body.agentId && body.agentId !== scope) {
        return mismatch(req, res, scope, body.agentId, 'body');
      }
      if (!body.agentId && BODY_SUBJECT_PATHS.some((p) => req.path === p)) body.agentId = scope;
    }
    return next();
  }

  function mismatch(req, res, scope, claimed, where) {
    metrics.emitTokenRejected('scope_mismatch', { agent: scope });
    log.warn({ scope, claimed, where, path: req.path, method: req.method }, 'dispatcher auth: SCOPE MISMATCH — refusing');
    return res.status(403).json({ ok: false, error: 'scope_mismatch', scope });
  }

  /**
   * PHASE 4: an agent route requires a TOKEN. The fleet-wide secret is refused here.
   *
   * This is the line that actually closes the hole. Everything before it made the token WORK; this
   * makes the secret STOP working where it conferred cross-scope authority — `/cron` (CRUD another
   * agent's jobs), `/approvals` (request or redeem as another agent), `/api` (post as Archie
   * anywhere the bot is).
   *
   * IT IS ONLY UNAMBIGUOUS BECAUSE THE HYDRATOR MOVED. While the hydrator legitimately POSTed to
   * `/cron` with the shared secret, "an agent presented the secret" could not be treated as a signal
   * — the hydrator did it on every cutover. With it on `/admin/cron` behind its own key, a secret on
   * an agent route has no benign explanation left, which is what makes the alarm meaningful.
   */
  function requireToken(req, res, next) {
    const auth = req.dispatcherAuth;
    if (auth && auth.kind === 'token') return next();
    metrics.emitTokenRejected('shared_secret', {});
    log.warn({ path: req.path, method: req.method, kind: auth && auth.kind },
      'dispatcher auth: SHARED SECRET presented to an agent route — refusing');
    return res.status(401).json({
      ok: false,
      error: 'unauthorized',
      reason: 'shared_secret',
      detail: 'This route requires a per-turn dispatcher token. Infrastructure callers use /admin/cron.',
    });
  }

  /**
   * The admin surface's gate: the shared secret, and ONLY the shared secret.
   *
   * WHY THIS IS NOT A SECOND SECRET, having first been built as one. D4 proposed a dedicated key on
   * the grounds that leaving the hydrator on the fleet secret means "the secret still confers
   * cross-scope cron CRUD, so the hole is narrowed rather than closed". That reasoning assumed the
   * secret stays REACHABLE by agents. Phase 4 removes both routes to it — the `agentcore-base` grant
   * that let every derived role read it from Secrets Manager, and `DISPATCHER_SHARED_SECRET_ID` from
   * the runtime spec — so an agent cannot obtain it, and `requireToken` means it could not spend it
   * on an agent route if it did. A second secret would have added a Secrets Manager resource, a
   * terraform apply, a discovered fact and a task-definition field to protect a credential that is
   * already out of agents' reach. (2026-09-16)
   *
   * So the fleet secret is no longer SHARED in the sense that mattered. It is the INFRASTRUCTURE
   * credential: the hydrator, `archie cron *` and the E2E runner hold it, none of them has a turn,
   * and every one of them is a caller a human ran.
   *
   * A TOKEN IS REFUSED HERE, and that is the half that does need enforcing: an agent holding a
   * perfectly valid per-turn token must not reach a surface that writes other scopes' jobs.
   */
  function requireAdminSecret(req, res, next) {
    const presented = req.headers['x-dispatcher-secret'];
    if (!presented || looksLikeToken(presented) || !timingSafeEquals(presented, secret)) {
      metrics.emitTokenRejected('admin_denied', {});
      log.warn({ path: req.path, method: req.method, wasToken: looksLikeToken(presented) },
        'admin surface: refused — this surface takes the infrastructure credential only');
      return res.status(401).json({ ok: false, error: 'unauthorized', reason: 'admin_denied' });
    }
    // Marked so the routers behind it can tell WHICH surface they are serving — cron-api honours the
    // invalid-delivery bypass on this one only.
    req.dispatcherAuth = { kind: 'admin', scope: null, claims: null };
    return next();
  }

  return { authenticate, enforceScope, requireToken, requireAdminSecret, secretMatches, looksLikeToken, AGENT_ROUTE_PREFIXES };
}

module.exports = { createDispatcherAuth, looksLikeToken, pathSubject, PATH_SUBJECT, BODY_SUBJECT_PATHS, METRIC_REASON };

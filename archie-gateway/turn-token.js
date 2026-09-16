'use strict';

// The per-turn dispatcher credential (archie-docs/archie-dispatcher-token-plan.md).
//
// WHAT IT REPLACES. `DISPATCHER_SHARED_SECRET` is ONE fleet-wide secret, so the `x-dispatcher-secret`
// gate authenticates "a member of this fleet", not "this scope" — and every agent-reachable route
// then takes its subject from the request body or path. An agent can therefore author a cron job for
// another agent, redeem another agent's approval, or post as Archie anywhere the bot is. It is not
// theoretical: pi-entrypoint puts the secret in `process.env`, and Pi's shell tool spreads
// `process.env` into every command, so any agent holding `runtime` can read it and curl the
// dispatcher as anyone.
//
// A token minted per turn and bound to the scope makes cross-scope action UNREPRESENTABLE rather than
// forbidden: no field in the request names a scope, so there is no check to forget and no "trusted
// caller" assumption to get wrong.
//
// WHY THIS IS SAFE TO SHIP ALONE. Minting and sending it changes nothing: the runtime reads named
// payload fields and ignores the rest (pi-adapter.mjs:1391), exactly as `input.traceparent` already
// works. An old runtime never looks at it.
//
// SHAPE BORROWED FROM file-ref.js, deliberately — HMAC-SHA256, base64url, timingSafeEqual, typed
// failure reasons. That module already signs the file-download capability refs in production, so this
// is an established pattern here rather than a new one. The differences are the claim set and, below,
// the revocation step file-refs do not need.

const crypto = require('node:crypto');

// v1. Version-prefixed so a claim change is a rejection rather than a misparse: a token minted by a
// future dispatcher hits `unknown_version` on an older one instead of decoding into the wrong shape.
const VERSION = 'v1';

// The order claims are signed in. NOT the object's key order — a JSON.stringify over an object whose
// key order differs between mint and verify produces a valid-looking signature mismatch that reads as
// an attack. An explicit list cannot drift.
const CLAIM_ORDER = ['jti', 'scope', 'sessionId', 'runId', 'depth', 'exp'];

const canonical = (claims) => CLAIM_ORDER.map((k) => String(claims[k] ?? '')).join('');

/**
 * Mint a token for one turn.
 *
 * `exp` is derived from the turn's own budget by the caller, not from a constant here: a 30-second
 * Slack turn and an 8-hour cron run have wildly different legitimate lifetimes, and the dispatcher
 * already computes each one to set the invoke abort signal. See the plan's §8.8.
 *
 * `depth` is carried but always 0 today. `sessions_spawn` needs it to bound recursion, and adding a
 * claim later would mean reissuing every token that omits it — the cost now is one field.
 */
function mintTurnToken({ scope, sessionId, runId, expMs, depth = 0, jti }, secret) {
  if (!scope) throw new Error('mintTurnToken: scope required');
  if (!secret) throw new Error('mintTurnToken: secret required');
  if (!Number.isFinite(expMs)) throw new Error('mintTurnToken: expMs must be a finite epoch-ms');
  // Seconds, like file-ref.js — the token travels in a JSON payload and a shorter string is one less
  // thing to truncate in a log.
  const claims = {
    // The revocation row's key (D2). Minted here rather than derived from the other claims, because
    // a derived id is only as unique as the caller's `runId` discipline — two turns that happened to
    // agree on every claim would share a row, and closing one would revoke the other. It is random,
    // so a TOKEN# row cannot be located from anything an agent can see either.
    jti: jti || crypto.randomBytes(12).toString('base64url'),
    scope,
    sessionId: sessionId || '',
    runId: runId || '',
    depth,
    exp: Math.floor(expMs / 1000),
  };
  const payload = canonical(claims);
  const hmac = crypto.createHmac('sha256', secret).update(`${VERSION}${payload}`).digest('hex');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${VERSION}.${body}.${hmac}`;
}

/**
 * Verify a token and return its claims.
 *
 * FOUR DISTINCT FAILURE REASONS, and they are not interchangeable — the alarm keys on two of them
 * (plan §8.8):
 *
 *   missing    no token presented at all      — routine during dual-accept, a misconfiguration after
 *   malformed  not parseable as a token       — a bug, or someone poking
 *   invalid    signature does not verify      — forged or corrupted; NEVER routine
 *   expired    past its exp                   — explicable: an overrun, or a late background process
 *
 * `revoked` is NOT decided here: revocation is a store lookup the caller performs, because this
 * module is pure and synchronous by design (it is on the hot path of every agent→dispatcher call).
 */
function verifyTurnToken(token, secret) {
  if (!token || typeof token !== 'string') return { valid: false, reason: 'missing' };
  if (!secret) throw new Error('verifyTurnToken: secret required');
  const parts = token.split('.');
  if (parts.length !== 3) return { valid: false, reason: 'malformed' };
  const [version, body, hmac] = parts;
  if (version !== VERSION) return { valid: false, reason: 'unknown_version' };

  let claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { valid: false, reason: 'malformed' };
  }
  if (!claims || typeof claims !== 'object' || !claims.scope) return { valid: false, reason: 'malformed' };

  const expected = crypto.createHmac('sha256', secret)
    .update(`${VERSION}${canonical(claims)}`).digest('hex');
  // timingSafeEqual throws on a length mismatch, which a hand-crafted token trivially produces —
  // so the length check comes first and is itself constant across every malformed input.
  const a = Buffer.from(hmac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'invalid' };

  if (!Number.isFinite(claims.exp) || Math.floor(Date.now() / 1000) > claims.exp) {
    // Expiry is checked AFTER the signature on purpose: reporting "expired" for an unsigned token
    // would tell a prober that the rest of the format was right.
    return { valid: false, reason: 'expired' };
  }
  return { valid: true, claims };
}

/**
 * The claims of a token the dispatcher ITSELF just minted — an UNVERIFIED decode.
 *
 * Verification would be circular here: the mint sites hold their own freshly-minted token and need
 * its claims to open and close the revocation row. Anything arriving from OUTSIDE goes through
 * `verifyTurnToken`, which returns the same object having actually checked the signature. Never call
 * this on an inbound token — it will happily decode a forgery.
 */
function claimsOf(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && typeof claims.jti === 'string' ? claims : null;
  } catch {
    return null;
  }
}

module.exports = { mintTurnToken, verifyTurnToken, claimsOf, VERSION, CLAIM_ORDER };

'use strict';

// The revocation half of the per-turn credential (plan D1/D2).
//
// WHY A ROW AT ALL, when the token is already signed and already expires. Expiry alone bounds a
// leaked token to its turn's BUDGET, and a cron turn's budget is eight hours — so a token lifted out
// of a workspace (Pi's shell tool spreads `process.env` into every command) would stay usable long
// after the turn that owned it finished. The row makes the credential die when its TURN does, which
// is the lifetime the design is actually claiming.
//
// PRESENCE MEANS LIVE, ABSENCE MEANS REVOKED — the inversion is deliberate and it FAILS CLOSED. The
// row is written at invoke and deleted when the invoke finally returns, so a token presented after
// its turn finds nothing and is refused. A tombstone written at revocation instead (absent = live)
// would be one write cheaper and would fail OPEN: any delete that did not land leaves the token good
// until expiry, which is the exact window this exists to close.
//
// The cost of failing closed, stated rather than discovered: if the row write fails at mint, every
// dispatcher call the turn makes is refused. That is why `open` reports its failure to the caller
// instead of swallowing it, and why phase 2's verify must distinguish a table it could not READ
// (`unavailable`) from a row that is genuinely gone (`revoked`) — the alarm keys on the second.
//
// WHY `TOKEN#` IS ITS OWN PARTITION. `derive-exec-role.mjs` scopes a runtime's read to
// `AGENT#<id>` / `GRANT#<id>` / `OAUTH#<id>` / `SKILL#*` via `dynamodb:LeadingKeys`. IAM has no
// sort-key condition, so a row under `AGENT#<scope>` would be readable by that scope's own agent —
// which, for the store that decides whether that agent's credential is still valid, is the one
// prefix it must not be under. This is the same reasoning that put the OAuth drop-box in its own
// partition.

const TOKEN_PK_PREFIX = 'TOKEN#';

// TTL is GARBAGE COLLECTION, NOT ENFORCEMENT. DynamoDB deletes expired items on a best-effort basis,
// typically within 48h, so a row can outlive its `ttl` by a long way — expiry is checked at read
// time from the signed `exp` claim and nothing here depends on the sweep being timely. The margin
// exists only so GC cannot possibly reap a row while its turn is still running.
const TTL_MARGIN_SECONDS = 60 * 60;

const tokenKey = (jti) => ({ pk: `${TOKEN_PK_PREFIX}${jti}`, sk: 'TURN' });

/**
 * @param deps.doc    DynamoDBDocumentClient (injected — keeps this module aws-sdk-free, same as
 *                    cron-runner-flag.js)
 * @param deps.table  agent-config table name
 * @param deps.now    () => epoch ms
 * @param deps.log    pino-shaped logger
 */
function createTurnTokenStore(deps = {}) {
  const { doc, table } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  // An unconfigured dispatcher is a real state, not a test artifact (cron-runner-flag.js makes the
  // same allowance): no table means no revocation, and every call says so rather than pretending to
  // have written something.
  const configured = !!(doc && table);
  if (!configured) {
    log.warn({}, 'turn tokens: no agent-config table — tokens are valid until expiry, with no revocation');
  }

  /**
   * Open a turn: record the token as live.
   *
   * Returns {ok, reason} rather than throwing — the caller is a turn that is about to start, and
   * whether a failed row write should abort it is the INVOKE path's judgement, not this module's.
   */
  async function open(claims) {
    if (!claims || !claims.jti) return { ok: false, reason: 'no_jti' };
    if (!configured) return { ok: false, reason: 'unconfigured' };
    try {
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      // UpdateItem, not PutItem, for the reason every other write in this stack gives: the
      // dispatcher's policy grants UpdateItem only, and PutItem would permit wholesale replacement
      // of an item. An UpdateItem on an absent key creates it.
      await doc.send(new UpdateCommand({
        TableName: table,
        Key: tokenKey(claims.jti),
        UpdateExpression: 'SET #d = :d, #t = :t',
        ExpressionAttributeNames: { '#d': 'data', '#t': 'ttl' },
        ExpressionAttributeValues: {
          // The body is an opaque JSON string under `data` — the table-wide convention (schema.mjs).
          // It carries the claims for audit: "which scope held a live credential at 03:14" is not
          // otherwise answerable, and this row is the only place the question is cheap.
          ':d': JSON.stringify({
            scope: claims.scope,
            sessionId: claims.sessionId || null,
            runId: claims.runId || null,
            depth: claims.depth || 0,
            exp: claims.exp,
            openedAtMs: now(),
          }),
          ':t': (claims.exp || Math.floor(now() / 1000)) + TTL_MARGIN_SECONDS,
        },
      }));
      return { ok: true };
    } catch (err) {
      log.error({ scope: claims.scope, err: String(err && err.message) }, 'turn tokens: OPEN failed — this turn\'s dispatcher calls will be refused');
      return { ok: false, reason: 'write_failed' };
    }
  }

  /**
   * Close a turn: the token is dead from here.
   *
   * ON FINAL COMPLETION, NOT PER ATTEMPT (§8.8). The invoke client retries internally, and those
   * retries share the token — so this belongs after the whole invoke settles, in a `finally`, and a
   * TIMEOUT IS A COMPLETION. A turn killed at its budget is exactly the turn whose credential most
   * needs revoking: the runtime is gone and anything still holding the token is not it.
   *
   * NEVER THROWS. It runs on the way out of a turn that has already done its work; a delete that
   * fails must not turn a completed turn into a failed one. The consequence is bounded and stated:
   * the token then lives until `exp` instead of until now.
   */
  async function close(claims) {
    if (!claims || !claims.jti || !configured) return { ok: false };
    try {
      const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
      await doc.send(new DeleteCommand({ TableName: table, Key: tokenKey(claims.jti) }));
      return { ok: true };
    } catch (err) {
      log.error({ scope: claims.scope, err: String(err && err.message) }, 'turn tokens: CLOSE failed — token stays valid until its exp');
      return { ok: false };
    }
  }

  /**
   * Is this token still live? The phase-2 verify calls this AFTER the signature checks out.
   *
   * Three answers, and they are not interchangeable — `revoked` is an alarm, `unavailable` is not:
   *   live        the row is there
   *   revoked     the row is gone: the turn finished, or somebody revoked it
   *   unavailable the table could not be read, or there is no table configured
   */
  async function isLive(claims) {
    if (!claims || !claims.jti) return 'revoked';
    if (!configured) return 'unavailable';
    try {
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      const r = await doc.send(new GetCommand({ TableName: table, Key: tokenKey(claims.jti) }));
      return r && r.Item ? 'live' : 'revoked';
    } catch (err) {
      log.error({ scope: claims.scope, err: String(err && err.message) }, 'turn tokens: liveness read failed');
      return 'unavailable';
    }
  }

  return { open, close, isLive, configured };
}

module.exports = { createTurnTokenStore, tokenKey, TOKEN_PK_PREFIX, TTL_MARGIN_SECONDS };

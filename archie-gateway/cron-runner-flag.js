'use strict';

// CRON_RUNNER — which SCHEDULER may fire a scope's cron jobs (pi-cron-migration-plan.md §3a').
//
// During the migration both schedulers exist at once: every OpenClaw agent still runs its own
// in-process croner over `<agent>/cron/jobs.json` on EFS, and archie's dispatcher runs its own
// croner over the store the hydrator seeded from those same files. Two schedulers, one job
// definition — so the invariant the plan has always stated ("exactly one scheduler fires a given
// job at a time", §3a) needs something to enforce it now that the two live in SEPARATE STACKS with
// no shared process and no ECS scale-down between them.
//
// This is that something: one value per SCOPE, not per job. Per-job would mean maintaining a list
// that changes every time an agent adds a cron — a moving target right up to full cutover — while
// the decision being made is never per-job anyway. It is "has this person's agent moved to archie
// yet", which is exactly a scope.
//
// PHASE 1 (this): archie's fire path reads it and EXITS EARLY unless the value is `agentcore`.
//   Jobs still hydrate, still arm, still appear in App Home; they simply do not fire here. OpenClaw
//   keeps firing them, unchanged and unaware.
// PHASE 2: the OpenClaw runner gets the mirror-image check (exit unless `openclaw`), at which point
//   flipping this one value moves a scope's schedule from one stack to the other, atomically.
//
// ABSENT MEANS `openclaw`, and that default is load-bearing in two directions:
//   * it is the FLEET-WIDE fallback, so nothing has to be back-filled for the many scopes that have
//     never been hydrated or flipped — an unrecognised row reads exactly like an un-migrated one;
//   * it is the SAFE direction. archie declining to fire is a schedule that keeps running on
//     OpenClaw; archie firing anyway is a duplicate turn, a duplicate Slack message and a duplicate
//     side effect. A missed tick is the recoverable error (the same judgement the hydrator's
//     one-shot guard makes).
// A read FAILURE resolves the same way, for the same reason.
//
// NAMING, because `cron-runner.js` is next to this file and means something else: THAT is archie's
// scheduler (timers, arming, run-state). This is the flag that says whether a scope's jobs belong
// to it. The value's own vocabulary is the two STACKS — `openclaw` / `agentcore` — which is what the
// person flipping it in Slack is actually choosing between.

// The key shape comes from the schema module, never from a literal — same dual-layout dynamic
// import marketplace.js uses (the file sits under ./config-resolver in the image and under
// ../clawdbot/config-resolver in the repo).
let _schema = null;
async function loadSchema() {
  if (_schema) return _schema;
  try {
    _schema = await import('./config-resolver/schema.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    _schema = await import('../archie-runner/config-resolver/schema.mjs');
  }
  return _schema;
}

const CRON_RUNNER = Object.freeze({
  OPENCLAW: 'openclaw',
  AGENTCORE: 'agentcore',
});

/** Absent, unreadable, or unrecognised → the OpenClaw scheduler owns it. See the header. */
const DEFAULT_CRON_RUNNER = CRON_RUNNER.OPENCLAW;

const RUNNERS = Object.freeze(Object.values(CRON_RUNNER));

function isValidRunner(value) {
  return typeof value === 'string' && RUNNERS.includes(value);
}

/**
 * Normalise a stored/submitted value. Unrecognised input is NOT coerced to the default here —
 * callers need to tell "someone wrote nonsense" from "nobody has decided yet", and the write path
 * must refuse the nonsense rather than silently store the default in its place.
 */
function parseRunner(value) {
  return isValidRunner(value) ? value : null;
}

/**
 * NO CACHING, DELIBERATELY (2026-08-17). Every call reads DynamoDB.
 *
 * This module briefly carried a 30s TTL cache, added to spare the table reads nobody had complained
 * about. It was removed because it traded away the only property the flag has: with a cache, a fire
 * can be decided from a row that has since changed, so a scope flipped in Slack keeps firing here
 * until the entry expires — firing on BOTH stacks, which is the outcome this whole mechanism exists
 * to prevent. What a read costs is not the point; when it happens is.
 *
 * @param deps.doc      DynamoDBDocumentClient (injected — keeps this module aws-sdk-free)
 * @param deps.table    agent-config table name
 * @param deps.now      () => epoch ms (injectable for tests)
 * @param deps.log      pino-shaped logger
 */
function createCronRunnerFlags(deps = {}) {
  const { doc, table } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  // No table configured is a REAL state, not a test artifact: a dispatcher can boot without
  // AGENT_CONFIG_TABLE. It resolves to the default (= archie does not fire), which is the same safe
  // answer an unreadable table gives, and every write refuses loudly instead of pretending.
  const configured = !!(doc && table);
  if (!configured) {
    log.warn({}, 'cron runner flag: no agent-config table — every scope resolves to the default (openclaw)');
  }

  function defaultRecord(agentId, source) {
    return { agentId, runner: DEFAULT_CRON_RUNNER, source, setAtMs: null, setBy: null };
  }

  async function readItem(agentId) {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const { agentCronKey } = await loadSchema();
    const r = await doc.send(new GetCommand({ TableName: table, Key: agentCronKey(agentId) }));
    if (!r || !r.Item) return null;
    // Item bodies are an opaque JSON STRING under `data` — the table-wide convention (schema.mjs).
    try {
      return r.Item.data ? JSON.parse(r.Item.data) : {};
    } catch (err) {
      log.error({ agent: agentId, err: String(err && err.message) }, 'cron runner flag: unparseable item — treating as unset');
      return {};
    }
  }

  /**
   * Resolve a scope's runner.
   * @returns {Promise<{agentId, runner, source: 'store'|'default'|'invalid'|'unreadable', setAtMs, setBy}>}
   *   `source` is what makes this honest: 'store' is a decision somebody made, everything else is
   *   this module falling back, and the App Home banner says which.
   */
  async function get(agentId) {
    if (!agentId) return defaultRecord(agentId, 'default');
    if (!configured) return defaultRecord(agentId, 'default');
    let body;
    try {
      body = await readItem(agentId);
    } catch (err) {
      // The next fire asks again — there is nothing holding this answer.
      log.error({ agent: agentId, err: String(err && err.message) }, 'cron runner flag: read failed — falling back to openclaw');
      return defaultRecord(agentId, 'unreadable');
    }
    if (!body) return defaultRecord(agentId, 'default');
    const runner = parseRunner(body.runner);
    if (!runner) {
      log.warn({ agent: agentId, stored: body.runner }, 'cron runner flag: unrecognised runner — falling back to openclaw');
      return defaultRecord(agentId, 'invalid');
    }
    return {
      agentId,
      runner,
      source: 'store',
      setAtMs: Number.isFinite(body.setAtMs) ? body.setAtMs : null,
      setBy: body.setBy || null,
    };
  }

  /** The one question the fire gate asks. */
  async function isAgentCore(agentId) {
    const rec = await get(agentId);
    return rec.runner === CRON_RUNNER.AGENTCORE;
  }

  async function write(agentId, body, { ifAbsent } = {}) {
    const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const { agentCronKey } = await loadSchema();
    // UpdateItem, never PutItem: the dispatcher's IAM policy grants UpdateItem on AGENT#* only
    // (iam.tf "WriteAgentMarketplaceOnly"), deliberately — PutItem would allow wholesale item
    // replacement. `attribute_not_exists(pk)` on an UpdateItem is the write-if-absent the hydration
    // default needs, and it is atomic, so two hydrations racing cannot both think they were first.
    await doc.send(new UpdateCommand({
      TableName: table,
      Key: agentCronKey(agentId),
      UpdateExpression: 'SET #d = :d',
      ExpressionAttributeNames: { '#d': 'data' },
      ExpressionAttributeValues: { ':d': JSON.stringify(body) },
      ...(ifAbsent ? { ConditionExpression: 'attribute_not_exists(pk)' } : {}),
    }));
  }

  /**
   * Set a scope's runner. This is the cutover action — it moves the schedule between stacks — so it
   * is logged at info with WHO did it. The very next fire on either stack reads the row and honours
   * it: no restart, no invalidation, nothing to wait for.
   */
  async function set(agentId, runner, opts = {}) {
    if (!agentId) throw new Error('cron: agentId required');
    const value = parseRunner(runner);
    if (!value) {
      throw new Error(`cron: runner must be one of ${RUNNERS.join(' | ')} (got ${JSON.stringify(runner)})`);
    }
    if (!configured) throw new Error('CRON_RUNNER store is not configured on this dispatcher (no agent-config table)');
    const body = { runner: value, setAtMs: now(), setBy: opts.by || 'unknown' };
    await write(agentId, body);
    log.info({ agent: agentId, runner: value, setBy: body.setBy }, 'cron runner flag: SET — this scope\'s cron jobs now belong to this scheduler');
    return { agentId, runner: value, source: 'store', setAtMs: body.setAtMs, setBy: body.setBy, wrote: true };
  }

  /**
   * Seed the default for a scope, WITHOUT overwriting a decision somebody has already made.
   *
   * Called by cron hydration. Re-running hydration is a supported, routine correction (it purges and
   * re-seeds from EFS), and it must not quietly drag a scope that has already been cut over back
   * onto OpenClaw — a scope's runner is an operational decision, not a property of its job list. So
   * this is a conditional write, and it REPORTS whether it landed.
   */
  async function setDefault(agentId, opts = {}) {
    if (!agentId) throw new Error('cron: agentId required');
    const value = parseRunner(opts.runner) || DEFAULT_CRON_RUNNER;
    if (!configured) throw new Error('CRON_RUNNER store is not configured on this dispatcher (no agent-config table)');
    const body = { runner: value, setAtMs: now(), setBy: opts.by || 'hydrate' };
    try {
      await write(agentId, body, { ifAbsent: true });
      log.info({ agent: agentId, runner: value }, 'cron runner flag: seeded the default');
      return { agentId, runner: value, wrote: true, existing: null };
    } catch (err) {
      if (!err || err.name !== 'ConditionalCheckFailedException') throw err;
      const existing = await get(agentId);
      log.info({ agent: agentId, runner: existing.runner, setBy: existing.setBy },
        'cron runner flag: already decided — default not applied');
      return { agentId, runner: existing.runner, wrote: false, existing: existing.runner };
    }
  }

  return { get, isAgentCore, set, setDefault, _configured: configured };
}

module.exports = {
  createCronRunnerFlags,
  CRON_RUNNER,
  DEFAULT_CRON_RUNNER,
  RUNNERS,
  isValidRunner,
  parseRunner,
};

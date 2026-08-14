'use strict';

// `archie generation stage` — RUNTIME-CLI-REFERENCE.md §2.8, plan §6 step 3 and §7.
//
// WHAT THIS COMMAND IS. The only thing that creates runtimes. Per agent: derive the per-agent spec
// from the STORED generation, run the provisioning saga (role → mount targets ∥ access point ∥
// Connector → CreateAgentRuntime → poll READY), run a real warm-up invoke, read `GetAgentRuntime`
// back and assert the observed runtime IS what the generation declared, and only then write the
// `RUNTIME#<agent> / GEN#<generationId>` binding. Nothing here moves traffic: the release pointer is
// `release set`'s alone (W2-B), and this file never writes `CONFIG#release` in any mode.
//
// REUSE, NOT REIMPLEMENTATION — the same rule cmd/generation.js follows, for a sharper reason here.
// A provisioning CLI existed in this repo once (`provision.ts`) and was DELETED, because having one
// was how test and production behaviour drifted apart (plan §5, "where the primitives live"). The
// saga is `agentcore-provisioning.js:567` and the injection contract that lets an external caller
// drive it is demonstrated at `agentcore-tests/features/support/provision.js:194-219`. This file is
// a command-line shell over that, never a second implementation: no CreateAgentRuntime, no
// CreateAccessPoint, no READY poll of its own.
//
// THE FOUR THINGS THAT MUST NOT BE GOT WRONG, each a real incident:
//
//  1. CONCURRENCY IS CAPPED AT 5, AND THE BOUND IS EFS. Measured 2026-08-13: `CreateAccessPoint` is
//     clean at 40 concurrent, `26 ok / 34 Rate exceeded` at 60, total failure once the token bucket
//     drains. "AgentCore's own documented limits are far higher (control-plane mutations 50/s, Gets
//     150/s), so EFS is the binding constraint" (`agentcore-client.js:1072-1079`); the harness
//     independently settled on 4 (`agentcore-fixture.js:715`). Over-running does NOT fail fast —
//     `ensureAccessPoint` retries throttles — so the cost is ~30-60s of backoff added to every
//     provision, degrading exactly the metric the bound defends.
//
//  2. THE BINDING IS WRITTEN ONLY AFTER THE READ-BACK. The image was once dropped on the way to
//     `CreateAgentRuntime`, so a runtime named for `pi-obs-39` ran `pi-obs-40` — "a roll that looks
//     completely successful in list-agent-runtimes and changes nothing. Only get-agent-runtime's
//     containerUri showed it" (`agentcore-client.js:421-425`). CLI-assigned names give up the
//     fingerprint guarantee, and this read-back is what replaces it (plan §11).
//
//  3. NOTHING IS EVER RECORDED HEALTHY WITHOUT A HEALTHCHECK HAVING RUN. The healthcheck is W2-A and
//     does not exist yet, so `healthcheckFor()` below resolves a seam that DEFAULTS TO THROWING. Its
//     absence is loud in the output, lands as `healthcheck: 'pending'` on the binding, and records a
//     per-unit failure so the run exits 6 (re-run) rather than 0. A binding written `ok` without a
//     healthcheck is a false gate — precisely what the plan's hard control limit exists to prevent
//     (§5.1), since `release set` trusts this field.
//
//  4. `agent` AND `data` ARE DYNAMODB RESERVED WORDS. Unaliased, `agent` broke every turn for every
//     agent live on 2026-08-13 (`runtime-registry.js:134-138`), and unit tests cannot catch it: they
//     assert command shape against a fake client and accept a broken expression string happily
//     (`registry-e2e.js:5-15`). Every attribute name in every expression below is aliased, without
//     exception; the test file asserts that structurally, and an e2e is the real gate.

const {
  readGeneration, readBody, scanBindings, derivedSpecFor, canonicalGeneration, GENERATION_PK,
} = require('./generation');
const { diffObserved } = require('../../slack-dispatcher/spec-diff');
const { collectFromDdb } = require('../../slack-dispatcher/routing-build');
const { pkFor: bindingPkFor, skFor: bindingSkFor } = require('../../slack-dispatcher/runtime-registry');
const {
  CliError, EXIT, usage, preflight, refused, tainted, headroom,
} = require('../lib/exit');
const { makeClient } = require('../lib/aws');

// ── constants, each with the measurement behind it ───────────────────────────────────────────────

// §5.3. 4 by default (the harness's independently-arrived-at bound, `agentcore-fixture.js:715`),
// hard-clamped at 5 (`MAX_CONCURRENT_PROVISIONS`, `agentcore-client.js:1080`).
const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 5;

// §6.2. A FLOOR, not a ceiling: control-plane READY is not serving-ready — a root shell ~1s after
// READY got HTTP 500 and succeeded ~15s later (measured 2026-08-14), and cold boot to first serve
// can reach ~90s when the BYO-EFS mount attach dominates. `--healthcheck-budget` exists to RAISE it.
// Lowering it converts platform variance into false taints, and taint is permanent (§5.2).
const DEFAULT_HEALTHCHECK_BUDGET_SECONDS = 120;

// How many throttle-classified per-agent failures make a run "sustained EFS throttling" (exit 8)
// rather than a handful of stragglers to re-run (exit 6). Three is deliberately low: the token
// bucket does not refill inside one staging pass, so a third throttle means the rest of the run is
// paying 30-60s of backoff per provision and re-running immediately will do the same.
const SUSTAINED_THROTTLE_FAILURES = 3;

// Structural classification, by exception NAME — never by message text. Kept separate from
// `agentcore-provisioning.classifyError`, which answers a different question (may I retry this?);
// this one answers "is this run out of headroom?", which is the difference between exit 6 and 8.
const THROTTLE_NAMES = new Set([
  'ThrottlingException', 'Throttling', 'ThrottledException', 'TooManyRequestsException',
  'RequestLimitExceeded', 'ProvisionedThroughputExceededException', 'RequestThrottled',
]);
const QUOTA_NAMES = new Set([
  'ServiceQuotaExceededException', 'LimitExceededException', 'QuotaExceededException',
  'ResourceLimitExceededException',
]);

/** throttle | quota | null. `Rate exceeded` is EFS's message for the measured AP rate limit. */
function classifyHeadroom(err) {
  const name = (err && (err.name || err.Code || err.code)) || '';
  if (QUOTA_NAMES.has(name)) return 'quota';
  if (THROTTLE_NAMES.has(name)) return 'throttle';
  const message = String((err && err.message) || '');
  if (/\bRate exceeded\b/i.test(message)) return 'throttle';
  // The runtime cap is the other way to run out of headroom (§5.4: 1,000 runtimes, and `--keep 3`
  // at every agent in the fleet is already over it during a staging pass).
  if (/quota|limit exceeded|maximum number of/i.test(message)) return 'quota';
  return null;
}

// ── clients ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Lazily-constructed AWS clients, every one injectable, so `node --test` touches neither credentials
 * nor the network. Shaped as `{ doc() }` because cmd/generation.js's exported readers take exactly
 * this object (`readGeneration(aws, ctx, id)`, `scanBindings(aws, ctx)`).
 */
function clientsFor(ctx, deps = {}) {
  // `--profile` also has to reach the clients the DISPATCHER'S client constructs for itself
  // (`agentcore-client.js:346-364` builds its own control/EFS/IAM clients from the default
  // credential chain — there is no credentials seam to inject). AWS_PROFILE is the only channel that
  // reaches those. Same reasoning, same line, as cmd/generation.js's clientsFor.
  if (ctx.profile && process.env.AWS_PROFILE !== ctx.profile) process.env.AWS_PROFILE = ctx.profile;

  let doc = deps.doc || null;
  let sts = deps.sts || null;
  return {
    doc() {
      if (!doc) {
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        doc = DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient'));
      }
      return doc;
    },
    sts() {
      if (!sts) sts = makeClient(ctx, '@aws-sdk/client-sts', 'STSClient');
      return sts;
    },
  };
}

/**
 * The account the CLI is operating on. `--account` is an ASSERTION (§1.2), so it is checked against
 * the caller rather than trusted.
 *
 * NOTE: identical to cmd/generation.js's private `resolveAccount`. Duplicated rather than exported,
 * because W1-C owns that file and this one owns only itself; when W2-B lands, both belong in a
 * shared `lib/`.
 */
async function resolveAccount(ctx, aws) {
  const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const id = await aws.sts().send(new GetCallerIdentityCommand({}));
  const actual = id && id.Account;
  if (ctx.account && actual && ctx.account !== actual) {
    throw preflight(`--account ${ctx.account} but the caller is in ${actual}`,
      { detail: 'wrong profile, or the right profile against the wrong deployment' });
  }
  if (!actual) throw preflight('GetCallerIdentity returned no account');
  return actual;
}

/**
 * The dispatcher's AgentCore client, configured FROM THE STORED GENERATION — not from `process.env`.
 *
 * That is the whole point of a generation: `runtimeSpecFor` runs off the dispatcher's environment
 * (`agentcore-client.js:904-915`), so a client built from today's environment would provision
 * whatever the currently-deployed task definition happens to say and then "verify" it against the
 * generation. Every fleet field the generation declares is pushed in as an override, and the
 * per-agent environment is passed per call (`envs`) rather than letting `runtimeEnv()` recompute it.
 */
function dispatcherClientFor(ctx, account, spec, deps = {}) {
  const overrides = {
    region: ctx.region,
    account,
    agentConfigTable: ctx.resources.configTable,
    efsRootPrefix: spec.efsRootPrefix,
    efsMountPath: spec.efsMountPath,
    securityGroupId: spec.securityGroupId,
  };
  if (deps.agentcore) return deps.agentcore(overrides);
  let mod;
  try {
    mod = require('../../slack-dispatcher/agentcore-client');
  } catch (e) {
    throw preflight('cannot load the dispatcher\'s provisioning saga (slack-dispatcher/agentcore-client)', {
      cause: e,
      detail: 'run `npm ci` in docker/slack-dispatcher — the CLI drives that saga rather than reimplementing it',
    });
  }
  return mod.createAgentCoreClient(overrides);
}

/** The pure name helper, lazily — requiring agentcore-client pulls the OTEL API and the AWS SDK. */
function runtimeNameFn(deps = {}) {
  if (deps.runtimeNameFor) return deps.runtimeNameFor;
  return require('../../slack-dispatcher/agentcore-client').generationRuntimeName;
}

// ── the healthcheck seam (W2-A) ──────────────────────────────────────────────────────────────────

/**
 * THE SEAM, and why it defaults to throwing.
 *
 * The warm-up invoke is `archie generation healthcheck` — task W2-A, `cmd/healthcheck.js`, not yet
 * written. Staging cannot wait for it (the provisioning half is what unblocks everything else), and
 * it equally cannot pretend: a binding written `healthcheck: 'ok'` without an invoke having happened
 * is a FALSE GATE, and `release set` reads exactly that field to enforce the plan's hard control
 * limit (§5.1). So the default implementation throws, the caller records `healthcheck: 'pending'`,
 * and the run cannot exit 0.
 *
 * THE CONTRACT W2-A MUST MEET — `cmd/healthcheck.js` exports:
 *
 *   async runHealthcheck({ agent, generationId, runtimeArn, runtimeId, sessionId,
 *                          budgetSeconds, ctx, out }) -> { ok: true, attempts, ms }
 *
 * Resolving is a PASS. Throwing (or resolving `{ ok: false }`) is a FAILURE and taints the
 * generation — including the shape that must not be mistaken for a pass: a turn emitting an `error`
 * event and then `final {text:''}` is a failure, which is what silently reset `consecutiveErrors`
 * for a cron job on 2026-08-12 (`agentcore-client.js:1309-1314`). `sessionId` is the isolated
 * session key from plan §7 (`prewarm:<agent>:<generationId>`), so the synthetic turn gets its own
 * microVM session and its own EFS session file.
 *
 * Only an error carrying `notImplemented === true` means "pending"; every other error is a failure.
 * That flag is set HERE and nowhere else, so W2-A cannot accidentally produce a pending.
 */
const HEALTHCHECK_NOT_IMPLEMENTED = 'the warm-up healthcheck is not implemented yet (W2-A, cmd/healthcheck.js)';

async function healthcheckNotImplemented() {
  const err = new Error(HEALTHCHECK_NOT_IMPLEMENTED);
  err.notImplemented = true;
  throw err;
}

function healthcheckFor(deps = {}) {
  if (typeof deps.healthcheck === 'function') return deps.healthcheck;
  let mod = null;
  try {
    // cmd/healthcheck.js is W2-A and does not exist YET. That is the whole point of this seam: the
    // require is expected to fail today and to start succeeding the moment the file lands, with no
    // change here. The directive below is what W2-A removes.
    // eslint-disable-next-line n/no-missing-require
    mod = require('./healthcheck');
  } catch (e) {
    // Only "the file does not exist yet" falls through to the stub. A healthcheck module that exists
    // and fails to LOAD (a syntax error, a missing dependency) must not silently degrade into
    // "pending" — that would turn a broken gate into a routine straggler report.
    if (!e || e.code !== 'MODULE_NOT_FOUND' || !String(e.message).includes('healthcheck')) throw e;
  }
  if (mod && typeof mod.runHealthcheck === 'function') return mod.runHealthcheck;
  return healthcheckNotImplemented;
}

// ── argument parsing ─────────────────────────────────────────────────────────────────────────────

function parseConcurrency(value, out) {
  if (value === undefined) return DEFAULT_CONCURRENCY;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw usage(`--concurrency must be a positive integer, got "${value}"`);
  if (n > MAX_CONCURRENCY) {
    // CLAMPED, not refused (§2.8, §5.3) — and the warning says what over-running actually costs,
    // because it does not fail fast: ensureAccessPoint retries the throttle, so the operator would
    // otherwise see only a slower run and conclude the bound is advisory.
    out.warn(`--concurrency ${n} clamped to ${MAX_CONCURRENCY}. The bound is EFS CreateAccessPoint, not `
      + 'AgentCore: 26 ok / 34 "Rate exceeded" at 60 concurrent, measured 2026-08-13. Over-running does '
      + 'not fail fast — it adds ~30-60s of retry backoff to every provision (§5.3).');
    return MAX_CONCURRENCY;
  }
  return n;
}

function parseBudget(ctx, value) {
  let seconds = DEFAULT_HEALTHCHECK_BUDGET_SECONDS;
  if (value !== undefined) {
    seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds <= 0) throw usage(`--healthcheck-budget must be a positive number of seconds, got "${value}"`);
    if (seconds < DEFAULT_HEALTHCHECK_BUDGET_SECONDS) {
      // REFUSED, not warned. §2.8: "Raise, never lower". The first failure means nothing (§6.2), a
      // healthcheck failure taints, and taint is permanent and unconditional with no untaint and no
      // force flag (§5.2) — so a lowered budget does not cost a re-run, it costs the generation.
      throw refused(`--healthcheck-budget ${seconds}s is below the ${DEFAULT_HEALTHCHECK_BUDGET_SECONDS}s floor`, {
        detail: 'READY is not serving-ready: a shell ~1s after READY got HTTP 500 and served ~15s later, and '
          + 'cold boot to first serve can reach ~90s. Lowering this converts platform variance into false '
          + 'taints, and taint is permanent (§6.2, §5.2). The flag exists to RAISE the budget.',
      });
    }
  }
  // `--timeout` raises a budget and never shortens a correctness mechanism (§1.2).
  if (ctx.timeoutSeconds && ctx.timeoutSeconds > seconds) seconds = ctx.timeoutSeconds;
  return seconds;
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// ── enumeration ──────────────────────────────────────────────────────────────────────────────────

/**
 * Every known agent, from the routing GSI (`routing-build.js:68`).
 *
 * `stage` covers EVERY known agent — decided, plan §13: "Simpler, and `--keep 2` leaves the quota
 * headroom for it." `--agents` narrows it for canary staging and straggler re-runs, and a name that
 * is not in the roster is a usage error rather than a provision: a typo'd agent would otherwise mint
 * a role, an access point and a runtime for an identity that does not exist.
 */
async function enumerateAgents(aws, ctx, values, deps = {}) {
  const roster = (deps.collectAgents
    ? await deps.collectAgents(aws.doc(), ctx.resources.configTable)
    : await collectFromDdb(aws.doc(), ctx.resources.configTable))
    .map((r) => r.agent)
    .filter(Boolean);

  const only = splitList(values.agents);
  if (!only.length) {
    if (!roster.length) {
      throw preflight(`no agents in the routing GSI of ${ctx.resources.configTable}`, {
        detail: 'either --name points at the wrong deployment (one knob derives every resource name, '
          + 'lib/context.js) or the config has never been hydrated (`archie config hydrate`).',
      });
    }
    return { agents: roster, roster };
  }
  const known = new Set(roster);
  const unknown = only.filter((a) => !known.has(a));
  if (unknown.length && roster.length) {
    throw usage(`--agents names ${unknown.length} agent(s) with no routing entry: ${unknown.join(', ')}`, {
      detail: 'staging an unknown agent would mint a role, an access point and a runtime for an identity '
        + 'that does not exist. `archie runtime list` shows the roster.',
    });
  }
  return { agents: only, roster };
}

// ── planning (pure) ──────────────────────────────────────────────────────────────────────────────

/**
 * Which agents still need staging — PURE, so the re-runnability rule is testable without AWS.
 *
 * SKIP means: this agent already has a binding for THIS generation that is both healthy
 * (`healthcheck === 'ok'`) and live (an `arn` is present). Anything else is re-staged, and the saga
 * is idempotent — it adopts an existing runtime by name rather than duplicating it
 * (`agentcore-provisioning.js:448-470`). A row whose arn was REMOVEd is history, not a binding: the
 * reaper strips the arn precisely so a rollback does not "invoke a corpse"
 * (`runtime-registry.js:30-37`), so it must re-provision.
 */
function planStage(agents, bindings, generationId) {
  const byAgent = new Map();
  for (const b of bindings) {
    if (b.generationId !== generationId) continue;
    byAgent.set(b.agent, b);
  }
  const todo = [];
  const skipped = [];
  for (const agent of agents) {
    const b = byAgent.get(agent);
    if (b && b.arn && b.healthcheck === 'ok') {
      skipped.push({ agent, runtimeName: b.runtimeName || null, reason: 'already staged and healthy' });
    } else if (b && b.arn) {
      todo.push({ agent, reason: `binding exists with healthcheck=${b.healthcheck || 'pending'}` });
    } else {
      todo.push({ agent, reason: b ? 'binding has no arn (reaped or cleared)' : 'no binding' });
    }
  }
  return { todo, skipped };
}

/** Bounded-concurrency worker pool. `worker` never throws — see stageOne. */
async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  };
  const lanes = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i += 1) lanes.push(lane());
  // allSettled, NEVER all. The saga's own parallel legs already use it because with fail-fast "the AP
  // could land AFTER the rejection — outside the ledger, i.e. a leaked access point"
  // (`agentcore-provisioning.js:624-628`), and racing the lanes here would defeat that from outside:
  // a rejecting lane would return while three sibling provisions were still mid-CreateAccessPoint.
  await Promise.allSettled(lanes);
  return results;
}

// ── DynamoDB writes ──────────────────────────────────────────────────────────────────────────────

/**
 * Build a field-level UpdateItem. EVERY attribute name is aliased — see this file's header.
 *
 * UpdateItem, never PutItem: the same constraint `runtime-registry.js:33-36` records ("granting
 * PutItem would allow wholesale replacement of an item rather than field updates"), and a Put would
 * also silently drop any field a future writer adds to the row.
 */
function updateFor({ table, key, set, remove = [], createdAtFrom = null }) {
  const names = {};
  const values = {};
  const sets = [];
  for (const [attr, value] of Object.entries(set)) {
    if (value === undefined) continue;
    names[`#${attr}`] = attr;
    values[`:${attr}`] = value;
    sets.push(`#${attr} = :${attr}`);
  }
  if (createdAtFrom) {
    // The ORIGINAL creation time survives a re-stage of the same generation, so the row reads as
    // history rather than as new (`runtime-registry.js:120-124`).
    names['#createdAt'] = 'createdAt';
    sets.push(`#createdAt = if_not_exists(#createdAt, :${createdAtFrom})`);
  }
  const removes = [];
  for (const attr of remove) {
    // Never SET and REMOVE the same name — DynamoDB rejects the whole expression. An attribute whose
    // value is `undefined` was NOT set (the loop above skips it), so it is still a legitimate remove:
    // that is how a re-stage clears the previous run's `healthcheckError` instead of leaving a stale
    // reason attached to a now-healthy binding.
    if (set[attr] !== undefined) continue;
    names[`#${attr}`] = attr;
    removes.push(`#${attr}`);
  }
  return {
    TableName: table,
    Key: key,
    UpdateExpression: `SET ${sets.join(', ')}${removes.length ? ` REMOVE ${removes.join(', ')}` : ''}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}

/**
 * THE BINDING — one item per agent per generation (plan §3).
 *
 *   pk: 'RUNTIME#<agent>'          sk: 'GEN#<generationId>'
 *   { agent, generationId, runtimeName, arn, runtimeId, image, accessPointArn, roleArn,
 *     agentSpecDigest, healthcheck: 'ok'|'failed'|'pending', stagedAt, verifiedAt,
 *     createdAt, updatedAt }
 *
 * BOTH the sort key AND explicit `generationId`/`runtimeName` attributes, deliberately. The sort key
 * is moving from `GEN#<runtimeName>` (today's fingerprint-keyed registry, `runtime-registry.js:43`)
 * to `GEN#<generationId>` (plan §3 / §12 step 3), and `scanBindings` reads the explicit attributes in
 * preference to the key (`cmd/generation.js:596-603`). Writing both means a half-migrated table reads
 * correctly from either side, and neither the rename nor its rollback needs a backfill.
 *
 * `healthcheck` is the field `release set` gates on, and `arn` is the liveness claim the reaper
 * REMOVEs — so a re-stage of a previously reaped generation must clear `reapedAt`/`clearedAt`, or the
 * row would advertise a live runtime and a reaping in the same breath.
 */
async function writeBinding(aws, ctx, b) {
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  await aws.doc().send(new UpdateCommand(updateFor({
    table: ctx.resources.configTable,
    key: { pk: bindingPkFor(b.agent), sk: bindingSkFor(b.generationId) },
    set: {
      agent: b.agent,
      generationId: b.generationId,
      runtimeName: b.runtimeName,
      arn: b.arn,
      runtimeId: b.runtimeId,
      image: b.image,
      accessPointArn: b.accessPointArn,
      roleArn: b.roleArn,
      agentSpecDigest: b.agentSpecDigest,
      healthcheck: b.healthcheck,
      healthcheckError: b.healthcheckError,
      legacyEfsRoot: b.legacyEfsRoot,
      stagedAt: b.stagedAt,
      verifiedAt: b.verifiedAt,
      updatedAt: b.stagedAt,
    },
    remove: ['reapedAt', 'clearedAt', 'healthcheckError', 'legacyEfsRoot'],
    createdAtFrom: 'stagedAt',
  })));
}

/**
 * Taint the generation. Recorded ON THE ITEM, not held in a process, so the decision survives an
 * operator retrying in a different shell — the specific failure the rail exists to prevent (§5.2).
 *
 * `if_not_exists` on all three fields so the FIRST failure is the recorded reason: a later agent
 * failing for an unrelated reason must not overwrite the diagnosis. The mutable taint attributes ride
 * TOP-LEVEL rather than inside `data`, because a generation's body is written once and never
 * rewritten — that is what lets `specDigest` be recomputed from the stored bytes
 * (`cmd/generation.js:757-771`).
 */
async function taintGeneration(aws, ctx, generationId, { reason, by, at }) {
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  await aws.doc().send(new UpdateCommand({
    TableName: ctx.resources.configTable,
    Key: { pk: GENERATION_PK, sk: generationId },
    UpdateExpression: 'SET #taintedAt = if_not_exists(#taintedAt, :at), '
      + '#taintReason = if_not_exists(#taintReason, :reason), #taintedBy = if_not_exists(#taintedBy, :by)',
    ExpressionAttributeNames: { '#taintedAt': 'taintedAt', '#taintReason': 'taintReason', '#taintedBy': 'taintedBy' },
    ExpressionAttributeValues: { ':at': at, ':reason': reason, ':by': by },
  }));
}

/** Who ran this. Attribution only — nothing authorises on it. */
function whoami(deps) {
  if (deps.user) return deps.user;
  try {
    return require('node:os').userInfo().username;
  } catch {
    return process.env.USER || process.env.LOGNAME || 'unknown';
  }
}

const nowIso = (deps) => new Date(deps.now ? deps.now() : Date.now()).toISOString();

// ── the read-back ────────────────────────────────────────────────────────────────────────────────

/**
 * The agent's legacy EFS root, when it has one.
 *
 * §8.10 rekey: a scope-keyed agent (`dm-u0…`) carries `META.efsRoot` = its FORMER name, and the saga
 * mounts THAT directory so the rekeyed agent keeps its workspace, memory and sessions
 * (`agentcore-client.js:621-630, 862-868`). The generation's declared spec cannot know that — it
 * derives `efsRootDir(agent, prefix)` — so the read-back would report a phantom `efsRoot` change for
 * every rekeyed agent and fail them all. Read the SAME META item the dispatcher reads, and only when
 * the read-back actually disagreed about `efsRoot`: proving the difference is an adopted legacy root
 * costs one GetItem on an exceptional path, and guessing would be indistinguishable from real drift
 * (pointing the fleet at a different EFS root is how a side-by-side migration cuts over).
 */
async function legacyEfsRootOf(aws, ctx, agent) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  try {
    const r = await aws.doc().send(new GetCommand({
      TableName: ctx.resources.configTable,
      Key: { pk: `AGENT#${agent}`, sk: 'META' },
    }));
    if (!r.Item || !r.Item.data) return null;
    const meta = JSON.parse(r.Item.data);
    return meta && typeof meta.efsRoot === 'string' && meta.efsRoot ? meta.efsRoot : null;
  } catch {
    // Best effort by construction: an unreadable META means we cannot PROVE the difference is a
    // legacy adopt, and an unproven difference stays drift.
    return null;
  }
}

/**
 * Assert the runtime AWS actually created is the one the generation declared.
 *
 * Both sides are the dispatcher's own — `observedSpecOf` (`agentcore-client.js:476`) and
 * `diffObserved` (`spec-diff.js:26`) — so they are shaped by the same code that shapes them at
 * provision time: `efsAccessPoint` dropped from both sides (or every roll shows a phantom change),
 * and `efsRoot` dropped from BOTH when the access point can no longer be read, because "absent is
 * unknown, not 'changed to undefined'" (`spec-diff.js:17-24`).
 *
 * `fingerprint-algorithm` is filtered: `specDiff` returns it INSTEAD of an empty array because its
 * usual caller only diffs when the runtime name already changed, so "no field differs" means the hash
 * moved. Here it is precisely what a clean read-back looks like — treating it as a difference would
 * invert the result for every healthy agent (`cmd/generation.js:1074-1081`).
 */
async function readBackAndAssert(aws, ctx, client, { agent, runtimeId, declared }) {
  const observed = await client.observedSpecOf(runtimeId);

  // THE ONE THAT MATTERS, checked explicitly as well as through the diff so the message names it: the
  // image was once dropped on the way to CreateAgentRuntime and the resulting runtime was invisible
  // to `list-agent-runtimes` — only `get-agent-runtime`'s containerUri showed it.
  if (observed && observed.image !== declared.image) {
    throw new CliError(`${agent}: the runtime AWS created runs ${observed.image || '(no containerUri)'}, `
      + `not the declared ${declared.image}`, {
      code: EXIT.FAILED,
      detail: 'this is the 2026 image-drop shape: a roll that looks completely successful in '
        + 'list-agent-runtimes and changes nothing (agentcore-client.js:421-425). No binding written.',
    });
  }

  let changes = diffObserved(observed, declared).filter((c) => c !== 'fingerprint-algorithm');
  let legacyEfsRoot = null;
  if (changes.length === 1 && changes[0] === 'efsRoot') {
    const legacy = await legacyEfsRootOf(aws, ctx, agent);
    if (legacy && observed && observed.efsRoot && observed.efsRoot.endsWith(`/${legacy}`)) {
      legacyEfsRoot = observed.efsRoot;
      changes = [];
    }
  }
  if (changes.length) {
    throw new CliError(`${agent}: the runtime does not match the declared spec (${changes.join(', ')})`, {
      code: EXIT.FAILED,
      detail: 'no binding written — a binding asserts "this runtime IS this generation", and this one is not.',
    });
  }
  return { observed, legacyEfsRoot };
}

// ── one agent ────────────────────────────────────────────────────────────────────────────────────

/**
 * Provision, verify, healthcheck and bind ONE agent. NEVER THROWS: every failure is recorded through
 * `out.failure`, which names which agent failed at which step and exits the run 6 rather than
 * collapsing 208 units into one code — "a single bad agent and a bad image look identical from an
 * exit code alone" (plan §7).
 */
async function stageOne(run, agent, position) {
  const {
    ctx, out, aws, client, spec, generationId, deps,
  } = run;
  const label = `[${String(position).padStart(String(run.total).length)}/${run.total}] ${agent.padEnd(20)}`;
  const declared = derivedSpecFor(spec, agent, deps);
  const runtimeName = run.runtimeNameFor(agent, declared);
  const startedAt = Date.now();
  const record = { agent, runtimeName, generationId };

  // 1. THE SAGA. role → (mount targets ∥ access point ∥ Connector) → CreateAgentRuntime → poll READY,
  //    with compensating cleanup on failure. Not reimplemented, not raced: `allSettled` on those
  //    parallel legs lives inside it, and driving the legs from here would defeat it.
  let env;
  try {
    env = await client.ensureAgentEnvironment(agent, {
      runtimeName,
      // REQUIRED per call. The client removed its `|| config.imageUri` fallback because "that is
      // precisely how a roll became a silent no-op once already" (`agentcore-client.js:858-860`).
      image: declared.image,
      // The generation's OWN environment, not `runtimeEnv(agent)` recomputed from the dispatcher's
      // process — that recomputation is exactly what a generation freezes (plan §1).
      envs: declared.envs,
      // NOTE: `efsRoot` is deliberately NOT passed. The client resolves the §8.10 legacy-EFS root from
      // the agent's own META (`agentcore-client.js:841-847`), and passing the declared PATH here would
      // be wrong twice over: opts.efsRoot is an agent-like NAME that the client expands, not a path,
      // and overriding it would silently re-root a rekeyed agent's workspace.
      logger: deps.logger,
    });
  } catch (err) {
    const kind = classifyHeadroom(err);
    if (kind) run.headroom[kind] += 1;
    out.failure({ agent, step: 'provision', error: err });
    out.progress(`${label} FAILED at provision: ${(err && err.message) || err}`);
    return { ...record, ok: false, step: 'provision', error: String((err && err.message) || err), headroom: kind };
  }
  const provisionMs = Date.now() - startedAt;
  const runtimeId = env.runtimeId || (env.runtimeArn ? String(env.runtimeArn).split('/').pop() : null);

  // From here on a runtime EXISTS AT AWS. Every failure below therefore leaves a runtime with no row,
  // which the registry cannot see and the reaper cannot reach — "recovered only by adopt-on-conflict
  // when that generation is next requested" (`agentcore-client.js:528-533`). Each one says so.
  const orphanNote = `runtime ${runtimeName} (${runtimeId}) EXISTS AT AWS with no binding row — `
    + 're-running `generation stage` adopts it by name; nothing else will find it (§6.5)';

  // 2. THE READ-BACK, before any binding is written.
  let verified;
  try {
    verified = await readBackAndAssert(aws, ctx, client, { agent, runtimeId, declared });
  } catch (err) {
    out.failure({ agent, step: 'read-back', error: err });
    out.progress(`${label} FAILED at read-back: ${(err && err.message) || err}`);
    out.warn(orphanNote);
    return {
      ...record, ok: false, step: 'read-back', runtimeId, arn: env.runtimeArn, orphaned: true,
      error: String((err && err.message) || err),
    };
  }

  // 3. THE HEALTHCHECK. There is no flag that skips it, in any mode, ever (§2.8, plan §2.7).
  let health = 'ok';
  let healthError;
  let healthResult = null;
  try {
    healthResult = await run.healthcheck({
      agent,
      generationId,
      runtimeArn: env.runtimeArn,
      runtimeId,
      // Plan §7 session isolation: its own microVM session and its own EFS session file, so the
      // synthetic turn never lands in the agent's real conversation.
      sessionId: `prewarm:${agent}:${generationId}`,
      budgetSeconds: run.budgetSeconds,
      ctx,
      out,
    });
    if (healthResult && healthResult.ok === false) throw new Error(healthResult.error || 'healthcheck returned ok:false');
  } catch (err) {
    if (err && err.notImplemented) {
      health = 'pending';
      healthError = HEALTHCHECK_NOT_IMPLEMENTED;
      // A per-unit failure, not a warning: PENDING IS NOT STAGED. Recording it is what makes the run
      // exit 6 (re-run) instead of 0, so an unhealthchecked generation can never look complete.
      out.failure({ agent, step: 'healthcheck', error: err });
    } else {
      health = 'failed';
      healthError = String((err && err.message) || err);
      run.healthFailures.push({ agent, error: healthError });
      out.failure({ agent, step: 'healthcheck', error: err });
    }
  }

  // 4. THE BINDING — after the read-back and after the healthcheck, carrying whichever of the three
  //    states actually happened. A `failed` row is written too: `generation show` and
  //    `runtime list --failed` are how the operator finds the agent whose crash reason to read.
  const stagedAt = nowIso(deps);
  const binding = {
    agent,
    generationId,
    runtimeName,
    arn: env.runtimeArn,
    runtimeId,
    image: declared.image,
    accessPointArn: env.accessPointArn || null,
    roleArn: env.roleArn || null,
    agentSpecDigest: run.digestOf(declared),
    healthcheck: health,
    healthcheckError: healthError,
    legacyEfsRoot: verified.legacyEfsRoot || undefined,
    stagedAt,
    verifiedAt: stagedAt,
  };
  try {
    await writeBinding(aws, ctx, binding);
  } catch (err) {
    // A throttled BIND is headroom too, and it is the worst-placed one: the runtime is already built
    // and paid for, and the row that would make it findable is what failed.
    const kind = classifyHeadroom(err);
    if (kind) run.headroom[kind] += 1;
    out.failure({ agent, step: 'bind', error: err });
    out.progress(`${label} FAILED at bind: ${(err && err.message) || err}`);
    out.warn(orphanNote);
    return {
      ...record, ok: false, step: 'bind', runtimeId, arn: env.runtimeArn, orphaned: true,
      healthcheck: health, error: String((err && err.message) || err),
    };
  }

  // One line per agent, and 208 of them: `pending` says only that, since the reason is identical on
  // every line and has already been said once, loudly, at the top of the run.
  let healthText;
  if (health === 'ok') {
    const retries = healthResult && healthResult.attempts > 1 ? healthResult.attempts - 1 : 0;
    healthText = `health=ok${retries ? `(${retries} retr${retries === 1 ? 'y' : 'ies'})` : ''}`;
  } else if (health === 'pending') {
    healthText = 'health=PENDING (no healthcheck — W2-A)';
  } else {
    healthText = `health=FAILED: ${healthError}`;
  }
  out.progress(`${label} runtime=${(provisionMs / 1000).toFixed(1)}s ${healthText}`);
  if (verified.legacyEfsRoot) out.verbose(`${agent}: legacy-EFS adopt — mounted ${verified.legacyEfsRoot} (§8.10 rekey)`);

  return {
    ...record,
    ok: health === 'ok',
    runtimeId,
    arn: env.runtimeArn,
    healthcheck: health,
    error: healthError,
    provisionMs,
  };
}

// ── the command ──────────────────────────────────────────────────────────────────────────────────

/**
 * `archie generation stage` — §2.8.
 *
 * EXITS, and the pair that matters most (§1.5): 4 means STOP, 6 means GO AGAIN.
 *   0  full coverage, every healthcheck passed.
 *   1  the generation could not be read.
 *   4  a healthcheck FAILED — the generation is now tainted and may never be pointed at.
 *   5  refused (tainted generation, lowered healthcheck budget).
 *   6  stragglers, nothing tainted — re-running is the DESIGNED response.
 *   8  sustained EFS throttling or a quota ceiling — re-running now buys nothing.
 * Getting 4 and 6 the wrong way round is the difference between fixing an image and burning an hour
 * re-running a generation that is already dead.
 */
async function stage(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);

  // `--generation` ONLY — this command declares no positional (`lib/registry.js:43`), and accepting
  // one anyway is unsafe here rather than merely lax: the entry point's first parse pass is
  // non-strict over the GLOBAL options alone, so a command-specific option's VALUE arrives as a
  // positional (`archie generation stage --concurrency 9` yields positionals ['9']). A positional
  // fallback would have taken `9` as the generation id.
  const generationId = values.generation;
  if (!generationId) throw usage('--generation <id> is required', { detail: '`archie generation list` shows what exists.' });

  const concurrency = parseConcurrency(values.concurrency, out);
  const budgetSeconds = parseBudget(ctx, values['healthcheck-budget']);

  // 1. THE GENERATION. Absent is exit 1 (§2.8), not a usage error: the command was well formed, the
  //    thing it names is not there.
  const item = await readGeneration(aws, ctx, generationId);
  if (!item) {
    throw new CliError(`no generation ${generationId}`, {
      code: EXIT.FAILED,
      detail: `CONFIG#generation / ${generationId} is not in ${ctx.resources.configTable} — `
        + '`archie generation list` shows what is.',
    });
  }
  // 2. TAINT IS PERMANENT AND UNCONDITIONAL (§5.2). There is no untaint and no force flag: re-staging
  //    after fixing the image means a NEW generation. Refusing here rather than at `release set` saves
  //    ~208 provisions that could never be published.
  if (item.taintedAt) {
    throw refused(`generation ${generationId} is TAINTED and may never be pointed at`, {
      detail: `tainted ${item.taintedAt}${item.taintReason ? ` — ${item.taintReason}` : ''}. `
        + 'There is no untaint: cut a new generation (`archie generation create --from ' + generationId + '`).',
    });
  }
  const body = readBody(item) || {};
  const spec = body.spec;
  if (!spec || !spec.image) {
    throw new CliError(`generation ${generationId} has no spec to stage`, {
      code: EXIT.FAILED,
      detail: 'the stored body carries no `spec.image` — this item was not written by `generation create`.',
    });
  }

  // 3. THE ROSTER and what is already done.
  const { agents } = await enumerateAgents(aws, ctx, values, deps);
  const bindings = await scanBindings(aws, ctx);
  const { todo, skipped } = planStage(agents, bindings, generationId);

  out.progress(`staging ${todo.length} of ${agents.length} agent(s) onto ${generationId}  (concurrency ${concurrency})`
    + (skipped.length ? ` · ${skipped.length} already staged and healthy` : ''));

  const healthcheck = healthcheckFor(deps);
  const healthcheckAvailable = healthcheck !== healthcheckNotImplemented;
  if (!healthcheckAvailable) {
    // LOUD, and in three places: here, on every binding (`healthcheck: 'pending'`), and in the exit
    // code. A silently skipped healthcheck would make an unpublishable generation look ready.
    out.warn(`${HEALTHCHECK_NOT_IMPLEMENTED}. Every agent staged by this run will be bound with `
      + 'healthcheck: "pending" and reported as a straggler (exit 6). No generation may be released '
      + 'until W2-A lands and a real warm-up invoke passes — that gate has no bypass (§5.1).');
  }

  if (ctx.dryRun) {
    const plan = {
      generationId,
      image: spec.image,
      concurrency,
      healthcheckBudgetSeconds: budgetSeconds,
      healthcheckAvailable,
      agents: agents.length,
      wouldStage: todo,
      skipped,
      dryRun: true,
    };
    for (const t of todo) out.progress(`would stage ${t.agent} (${t.reason})`);
    // `out.answer` IS the return value under --json (lib/output.js buffers it into the envelope), so
    // both modes go through one call and the dry-run answer cannot drift from the real one.
    if (ctx.json) { out.answer(plan); return undefined; }
    out.answer([
      `generation ${generationId}  ${spec.image}`,
      `  would stage  ${todo.length} agent(s) at concurrency ${concurrency}`,
      `  would skip   ${skipped.length} already staged and healthy`,
      `  healthcheck  ${healthcheckAvailable ? `${budgetSeconds}s budget` : 'NOT IMPLEMENTED (W2-A) — would bind as pending'}`,
      '  nothing provisioned, nothing written (dry run)',
    ].join('\n'));
    return undefined;
  }

  // 4. PROVISION. One dispatcher client for the whole run, configured from the STORED generation.
  const account = await resolveAccount(ctx, aws);
  const client = deps.client || dispatcherClientFor(ctx, account, spec, deps);
  const runtimeNameFor = runtimeNameFn(deps);
  const digestOf = (declared) => canonicalGeneration(declared, deps).specDigest;

  const run = {
    ctx,
    out,
    aws,
    deps,
    client,
    spec,
    generationId,
    total: todo.length,
    budgetSeconds,
    healthcheck,
    runtimeNameFor,
    digestOf,
    healthFailures: [],
    headroom: { throttle: 0, quota: 0 },
    stop: false,
  };

  let position = 0;
  const results = (await runPool(todo, concurrency, async (t) => {
    position += 1;
    if (run.stop) {
      // A quota ceiling does not clear inside a run, and 200 more identical failures would bury the
      // one line that explains it. In-flight lanes still settle — never abandoned mid-provision.
      return { agent: t.agent, ok: false, step: 'not-attempted', error: 'aborted: out of headroom' };
    }
    const r = await stageOne(run, t.agent, position);
    if (r.headroom === 'quota') run.stop = true;
    return r;
  })).filter(Boolean);

  // 5. THE VERDICT.
  const ok = results.filter((r) => r.ok);
  const pending = results.filter((r) => r.healthcheck === 'pending');
  const failedHealth = results.filter((r) => r.healthcheck === 'failed');
  const stragglers = results.filter((r) => !r.ok && r.healthcheck !== 'failed');
  const orphaned = results.filter((r) => r.orphaned);
  const notAttempted = results.filter((r) => r.step === 'not-attempted');
  const coverage = ok.length + skipped.length;

  let taintedNow = false;
  if (run.healthFailures.length) {
    const reason = run.healthFailures.map((f) => `${f.agent}: ${f.error}`).join(' · ').slice(0, 900);
    await taintGeneration(aws, ctx, generationId, {
      reason: `healthcheck failed during stage — ${reason}`,
      by: whoami(deps),
      at: nowIso(deps),
    });
    taintedNow = true;
  }

  const result = {
    generationId,
    image: spec.image,
    concurrency,
    healthcheckBudgetSeconds: budgetSeconds,
    healthcheckAvailable,
    agents: agents.length,
    attempted: todo.length,
    skipped: skipped.length,
    staged: ok.length,
    coverage,
    healthOk: ok.length,
    healthFailed: failedHealth.length,
    healthPending: pending.length,
    stragglers: stragglers.length,
    orphanedRuntimes: orphaned.map((r) => ({ agent: r.agent, runtimeName: r.runtimeName, runtimeId: r.runtimeId })),
    tainted: taintedNow,
    results,
  };

  const lines = [
    `staged ${coverage}/${agents.length} · healthcheck ok ${ok.length} · failed ${failedHealth.length}`
    + ` · pending ${pending.length} · stragglers ${stragglers.length}`,
  ];
  if (orphaned.length) {
    lines.push(`${orphaned.length} runtime(s) exist at AWS with NO binding row — re-run to adopt them by name (§6.5)`);
  }
  if (notAttempted.length) lines.push(`${notAttempted.length} agent(s) not attempted — the run stopped on a quota error`);
  lines.push(taintedNow
    ? `generation ${generationId} is TAINTED — ${failedHealth.length} healthcheck(s) failed. It can never be released; cut a new generation.`
    : `generation ${generationId} NOT tainted${stragglers.length ? ` — re-run to pick up the ${stragglers.length} straggler(s)` : ''}`);
  // In --json the summary is a document on stdout, so the human lines still have to be SAID — stderr
  // carries them, and is never suppressed by --json (§1.4). In text mode they ARE the answer.
  if (ctx.json) {
    out.answer(result);
    for (const l of lines) out.progress(l);
  } else {
    out.answer(lines.join('\n'));
  }

  // EXIT PRECEDENCE. Taint outranks everything: the generation is dead, and telling the operator to
  // re-run (6) or to wait for headroom (8) would send them to burn an hour on it.
  if (taintedNow) {
    throw tainted(`${failedHealth.length} healthcheck(s) failed — generation ${generationId} is tainted`, {
      detail: run.healthFailures.map((f) => `${f.agent}: ${f.error}`).join(' · ')
        + ' — taint is permanent and unconditional; there is no untaint and no force flag (§5.2).',
    });
  }
  if (run.headroom.quota || run.headroom.throttle >= SUSTAINED_THROTTLE_FAILURES) {
    throw headroom(run.headroom.quota
      ? `hit a service quota while staging ${generationId}`
      : `sustained throttling while staging ${generationId} (${run.headroom.throttle} throttled provisions)`, {
      detail: run.headroom.quota
        ? 'Re-running now buys nothing. Reap superseded generations first (`archie runtime gc --keep 2`) — at '
          + 'every agent in the fleet, keeping 3 generations is 1,040 runtimes against the 1,000 cap (§5.4).'
        : 'The bound is EFS CreateAccessPoint and the token bucket does not refill inside a run (§5.3). '
          + 'Lower --concurrency, wait, then re-run to pick up the stragglers.',
    });
  }
  // Stragglers alone need no throw: out.failure() already recorded them, and bin/archie.js turns a
  // non-zero failure count into exit 6 PARTIAL. Throwing here would hide the failures[] detail behind
  // one error line.
  return undefined;
}

module.exports = {
  // THE FULL COMMAND KEY, never a bare `stage`. `registry.load()` resolves `mod[key] || mod[verb]`,
  // and a verb-keyed export answers for every noun that shares the verb — the shape that would let
  // `archie access-point gc` run the runtime reaper (`lib/registry.js:156-166`, `cmd/runtime.js:843`).
  'generation stage': stage,

  // Internals, for this file's tests and for W2-A/W2-C, which compose this command.
  stage,
  planStage,
  runPool,
  updateFor,
  parseConcurrency,
  parseBudget,
  classifyHeadroom,
  healthcheckFor,
  enumerateAgents,
  writeBinding,
  taintGeneration,
  HEALTHCHECK_NOT_IMPLEMENTED,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_HEALTHCHECK_BUDGET_SECONDS,
};

'use strict';

// `archie fleet stage` — RUNTIME-CLI-REFERENCE.md §2.8, plan §6 step 3 and §7.
//
// WHAT THIS COMMAND IS. The only thing that creates runtimes. Per agent: derive the per-agent spec
// from THIS DEPLOYMENT (the dispatcher's own `runtimeSpecFor`), run the provisioning saga (role →
// mount targets ∥ access point ∥ Connector → CreateAgentRuntime → poll READY), run a real warm-up
// invoke, read `GetAgentRuntime` back and assert the observed runtime IS what that spec declared,
// and only then write the `RUNTIME#<agent> / GEN#<runtimeName>` binding. Nothing here moves traffic:
// the image pointer is `image publish`'s alone.
//
// THE BINDING IS THE POINT. The sort key is the runtime NAME, which is a fingerprint of the whole
// derived spec — the same string the dispatcher derives, from the same code, on the agent's next
// turn. So a row written here is a registry HIT rather than a create that collides and adopts. Get
// that key wrong and staging still "succeeds", loudly and visibly, while doing nothing at all: it
// did, for one day, and the cost was a wasted CreateAgentRuntime plus a full ListAgentRuntimes scan
// per agent per release (see writeBinding).
//
// REUSE, NOT REIMPLEMENTATION — the rule this whole CLI follows, for a sharper reason here.
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
//     (§5.1), since `image publish` trusts this field.
//
//  4. `agent` AND `data` ARE DYNAMODB RESERVED WORDS. Unaliased, `agent` broke every turn for every
//     agent live on 2026-08-13 (`runtime-registry.js:134-138`), and unit tests cannot catch it: they
//     assert command shape against a fake client and accept a broken expression string happily
//     (`registry-e2e.js:5-15`). Every attribute name in every expression below is aliased, without
//     exception; the test file asserts that structurally, and an e2e is the real gate.

const { scanBindings, tagOf } = require('../lib/bindings');
const { legacyEfsRootOf } = require('../lib/efs-root');
const { derivedSpecFor, specDigestFor, imageUriFor } = require('../lib/spec');
const { describeImage, assertArm64 } = require('../lib/ecr');
const { readTaint, taintTag } = require('../lib/image-pointer');
const { diffObserved } = require('../../archie-gateway/spec-diff');
const { listAgents } = require('../lib/agents');
const { pkFor: bindingPkFor, skFor: bindingSkFor } = require('../../archie-gateway/runtime-registry');
const {
  CliError, EXIT, usage, preflight, refused, tainted, headroom,
} = require('../lib/exit');
const { makeClient } = require('../lib/aws');
const { basePolicyArnFor } = require('../lib/context');

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
 * nor the network. Shaped as `{ doc() }` because cmd/tag.js's exported readers take exactly
 * this object (`readGeneration(aws, ctx, id)`, `scanBindings(aws, ctx)`).
 */
function clientsFor(ctx, deps = {}) {
  // `--profile` also has to reach the clients the DISPATCHER'S client constructs for itself
  // (`agentcore-client.js:346-364` builds its own control/EFS/IAM clients from the default
  // credential chain — there is no credentials seam to inject). AWS_PROFILE is the only channel that
  // reaches those. Same reasoning, same line, as cmd/tag.js's clientsFor.
  if (ctx.profile && process.env.AWS_PROFILE !== ctx.profile) process.env.AWS_PROFILE = ctx.profile;

  let doc = deps.doc || null;
  let sts = deps.sts || null;
  let ecr = deps.ecr || null;
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
    // Staging asks ECR whether the tag exists and is arm64 before it provisions 208 runtimes that
    // could not pull it.
    ecr() {
      if (!ecr) ecr = makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient');
      return ecr;
    },
  };
}

/**
 * The account the CLI is operating on. `--account` is an ASSERTION (§1.2), so it is checked against
 * the caller rather than trusted.
 *
 * NOTE: `lib/spec.js` now owns the shared copy (the duplication note here said it belonged there
 * "when W2-B lands"; it has). Kept local only until the stage/fleet merge lands, so this change stays
 * a rename of identity rather than a reshuffle of files.
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
 * The dispatcher's AgentCore client, configured from THE DEPLOYED TASK DEFINITION.
 *
 * This used to say "FROM THE STORED GENERATION — not from process.env", and pushed the generation's
 * recorded fleet fields in as overrides so staging honoured the tag's environment rather than
 * today's. Generations are gone: a tag is now a content digest of the IMAGE, and records nothing
 * about the fleet it runs on. So the environment is the only source, and `bin/archie.js` makes it
 * the deployed dispatcher's rather than the laptop's before any handler runs (FLEET_ENV_COMMANDS →
 * lib/dispatcher-env.js). The per-agent environment is still passed per call (`envs`) rather than
 * letting `runtimeEnv()` recompute it.
 */
function dispatcherClientFor(ctx, account, deps = {}) {
  const overrides = {
    region: ctx.region,
    account,
    agentConfigTable: ctx.resources.configTable,
    // NO efsRootPrefix / efsMountPath / securityGroupId. Under generations these were pushed in from
    // the generation's RECORDED fleet fields, so staging honoured the tag's environment rather than
    // today's. There is no such record now — the tag is a content digest of the image alone — so the
    // only source is the deployed task definition, which `bin/archie.js` applies before this runs
    // (FLEET_ENV_COMMANDS, lib/dispatcher-env.js). The call site kept passing an empty spec, so all
    // three arrived as `undefined` and BLANKED the values that env had resolved: every provision
    // failed with "securityGroups: Value '[]'" and a null mountPath. mergeConfig now ignores
    // undefined overrides too, so neither half of that can recur on its own.
    // DERIVED, never inherited. The client's own default is the pre-archie `agentcore-base`
    // (agentcore-client.js:69), which does not exist in an archie account — so omitting this made
    // every provision fail closed with NoSuchEntityException while `archie preflight` check 7,
    // which derives the name correctly, reported PASS. Passing it explicitly is what keeps the
    // gate and the action talking about the same policy.
    baseManagedPolicyArn: basePolicyArnFor(ctx.resources, account),
  };
  if (deps.agentcore) return deps.agentcore(overrides);
  let mod;
  try {
    mod = require('../../archie-gateway/agentcore-client');
  } catch (e) {
    throw preflight('cannot load the dispatcher\'s provisioning saga (archie-gateway/agentcore-client)', {
      cause: e,
      detail: 'run `npm ci` in docker/archie-gateway — the CLI drives that saga rather than reimplementing it',
    });
  }
  return mod.createAgentCoreClient(overrides);
}

/** The pure name helper, lazily — requiring agentcore-client pulls the OTEL API and the AWS SDK. */
function runtimeNameFn(deps = {}) {
  if (deps.runtimeNameFor) return deps.runtimeNameFor;
  return require('../../archie-gateway/agentcore-client').generationRuntimeName;
}

// ── the healthcheck seam (W2-A) ──────────────────────────────────────────────────────────────────

/**
 * THE SEAM, and why it defaults to throwing.
 *
 * The warm-up invoke is `archie fleet healthcheck` — task W2-A, `cmd/healthcheck.js`, not yet
 * written. Staging cannot wait for it (the provisioning half is what unblocks everything else), and
 * it equally cannot pretend: a binding written `healthcheck: 'ok'` without an invoke having happened
 * is a FALSE GATE, and `image publish` reads exactly that field to enforce the plan's hard control
 * limit (§5.1). So the default implementation throws, the caller records `healthcheck: 'pending'`,
 * and the run cannot exit 0.
 *
 * THE CONTRACT W2-A MUST MEET — `cmd/healthcheck.js` exports:
 *
 *   async runHealthcheck({ agent, generationId, runtimeArn, runtimeId, sessionId,
 *                          budgetSeconds, ctx, out }) -> { ok: true, attempts, ms }
 *
 * Resolving is a PASS. Throwing (or resolving `{ ok: false }`) is a FAILURE and taints the
 * tag — including the shape that must not be mistaken for a pass: a turn emitting an `error`
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
    // W2-A has landed, so this now resolves. The seam stays: a healthcheck module that exists but
    // fails to LOAD must not degrade into "pending" (see the catch below), and keeping the lookup
    // dynamic is what lets the tests substitute it.
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
      // force flag (§5.2) — so a lowered budget does not cost a re-run, it costs the tag.
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
 * Every known agent — `AGENT#` partition keys, via `lib/agents.listAgents`.
 *
 * WAS the routing GSI, which cannot answer this: an agent is only in that index if it has an
 * `AGENT#<scope>/META` row, and META is written only by config-repo hydration, so every MINTED agent
 * is invisible to it. Measured 2026-08-24: it returned 0 agents while 3 served traffic, so `stage`
 * staged "0 of 3" and `archie deploy`'s agent half did nothing. See `lib/agents.js`.
 *
 * `stage` covers EVERY known agent — decided, plan §13: "Simpler, and `--keep 1` leaves the quota
 * headroom for it." `--agents` narrows it for canary staging and straggler re-runs, and a name that
 * is not in the roster is a usage error rather than a provision: a typo'd agent would otherwise mint
 * a role, an access point and a runtime for an identity that does not exist.
 */
async function enumerateAgents(aws, ctx, values, deps = {}, out = null) {
  const roster = (deps.collectAgents
    ? await deps.collectAgents(aws.doc(), ctx.resources.configTable)
    : await listAgents(aws.doc(), ctx.resources.configTable))
    .map((r) => r.agent)
    .filter(Boolean);

  const only = splitList(values.agents);
  if (!only.length) {
    // AN EMPTY ROSTER IS A WARNING, NOT A REFUSAL (2026-08-21). It used to throw `preflight`,
    // which made an empty deployment un-releasable: `fleet deploy` died here at step 3 of 5, so the
    // gate never ran and `image publish` never ran, and the pointer could not move. But a new agent
    // mints onto the pointer AS IT STANDS — so the only way to get a fresh image in front of the first
    // agent is to publish before any agent exists. Refusing made that impossible, and this sandbox sat
    // on a 19 Aug image for it.
    //
    // Staging zero agents is a genuine no-op, not a fudge: `planStage([])` yields nothing to do, the
    // pool runs nothing, coverage is 0/0, and no healthcheck is claimed to have passed. The publish
    // gate is what decides whether an unverified tag may go live, and it makes that call itself
    // (cmd/image.js `publishRefusal`, the `fleetAgents === 0` bypass) — this function's job is to
    // report the roster honestly, not to pre-empt that decision.
    //
    // THE DIAGNOSTIC THE THROW CARRIED IS KEPT, because it is the likelier cause of a zero roster than
    // a genuinely empty account: `--name` derives every resource name (lib/context.js), so a wrong one
    // resolves to a table that exists and is empty, which is indistinguishable from an empty
    // deployment. Losing that hint would trade a loud stop for a silent wrong-target publish.
    if (!roster.length && out) {
      out.warn(`no AGENT# items in ${ctx.resources.configTable} — staging nothing. Either this `
        + 'deployment genuinely has no agents (normal for a fresh account, or after a teardown), or --name '
        + 'points at the wrong one (one knob derives every resource name, lib/context.js), or the config '
        + 'has never been hydrated (`archie config hydrate`).');
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
 * SKIP means: this agent already has a binding for THIS SPEC that is both healthy
 * (`healthcheck === 'ok'`) and live (an `arn` is present). Anything else is re-staged, and the saga
 * is idempotent — it adopts an existing runtime by name rather than duplicating it
 * (`agentcore-provisioning.js:448-470`). A row whose arn was REMOVEd is history, not a binding: the
 * reaper strips the arn precisely so a rollback does not "invoke a corpse"
 * (`runtime-registry.js:30-37`), so it must re-provision.
 *
 * THIS SPEC, NOT THIS TAG — `expectedNameFor` is what makes that true, and without it the whole
 * pre-warm silently does nothing whenever the spec moves under an unchanged tag.
 *
 * The runtime NAME is a fingerprint of the per-agent spec, of which the image is only one input
 * (`agentcore-client.generationRuntimeName`), and bindings are "one row per agent per spec"
 * (`lib/bindings.js:3`). So a `runtimeEnv` change — adding HINDSIGHT_API_URL, say — mints a new name
 * while `tagOf(b)` still matches: every agent then had a healthy binding for the tag, every agent was
 * skipped, and `fleet deploy` reported `staged 7/7 · gate passed · 0 stragglers` with six of seven
 * agents not on the name their next turn would ask for. `fleet drift` reported exactly those six, and
 * `fleet drift --fix` delegated here and printed `fixed` beside its own `not live 6`. Measured in prod
 * 2026-09-09 (internal decision).
 *
 * Deriving the expected name is the caller's job and it must come from the SAME place the dispatcher
 * derives from — the deployed task definition — which is the rule step 4 states for provisioning and
 * which planning has to obey too, or planning and provisioning disagree about what is already done.
 * A null/absent `expectedNameFor`, or one that throws for an agent, falls back to the tag-only
 * behaviour rather than failing the run: a plan that cannot name the spec is still better than no
 * plan, and that is also what keeps this function pure and testable.
 */
function planStage(agents, bindings, tag, expectedNameFor = null) {
  const byAgent = new Map();
  for (const b of bindings) {
    if (tagOf(b) !== tag) continue;
    if (!byAgent.has(b.agent)) byAgent.set(b.agent, []);
    byAgent.get(b.agent).push(b);
  }
  const todo = [];
  const skipped = [];
  for (const agent of agents) {
    const rows = byAgent.get(agent) || [];
    let want = null;
    if (expectedNameFor) {
      try { want = expectedNameFor(agent) || null; } catch { want = null; }
    }
    // With a derived name, only the row FOR THAT NAME counts. Without one, keep the historical
    // last-row-wins behaviour.
    const b = want ? rows.find((r) => r.runtimeName === want) : rows[rows.length - 1];
    if (!b && want && rows.length) {
      todo.push({ agent, reason: `spec changed — this spec derives ${want}, bindings are ${rows.map((r) => r.runtimeName).join(', ')}` });
      continue;
    }
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
    // The ORIGINAL creation time survives a re-stage of the same tag, so the row reads as
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
 * THE BINDING — one item per agent per runtime.
 *
 *   pk: 'RUNTIME#<agent>'          sk: 'GEN#<runtimeName>'
 *   { agent, runtimeName, arn, runtimeId, image, accessPointArn, roleArn,
 *     agentSpecDigest, healthcheck: 'ok'|'failed'|'pending', stagedAt, verifiedAt,
 *     createdAt, updatedAt }
 *
 * TWO IDENTITIES, KEPT APART. The sort key is the RUNTIME NAME — a fingerprint of the derived spec,
 * which is what identifies a runtime at AWS and what the dispatcher does its single GetItem on. The
 * RELEASE this binding belongs to is the tag its `image` names. Those answer different questions,
 * and a tag id conflated them: it was neither, so both halves had to be recovered from it.
 *
 * For one day (2026-08-15/16) the key was `GEN#<generationId>`, and the writer filed every
 * pre-warmed runtime under a key the reader does not consult. Nothing errored. Every agent's first
 * turn of every release missed, issued CreateAgentRuntime, took the ConflictException and paid the
 * adopt path's full ListAgentRuntimes scan — ~208 of them on a fleet roll — and `healthcheck: ok`
 * sat on a row the turn path never read.
 *
 * `healthcheck` is the field `image publish` gates on, and `arn` is the liveness claim the reaper
 * REMOVEs — so a re-stage of a previously reaped runtime must clear `reapedAt`/`clearedAt`, or the
 * row would advertise a live runtime and a reaping in the same breath.
 */
async function writeBinding(aws, ctx, b) {
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  await aws.doc().send(new UpdateCommand(updateFor({
    table: ctx.resources.configTable,
    // THE SORT KEY IS THE RUNTIME NAME — the same string the dispatcher derives and does its single
    // GetItem on. This is the whole point of staging: a row written here is a registry HIT on the
    // agent's next turn instead of a create that collides, takes ConflictException and adopts.
    //
    // It was `GEN#<generationId>` for one day (2026-08-15/16) and that was the bug: the writer filed
    // the pre-warmed runtime under a key the reader does not consult, so every agent's first turn of
    // every release paid a wasted CreateAgentRuntime and a full ListAgentRuntimes scan — ~208 of them
    // on a full fleet roll — and `healthcheck: ok` sat on a row the turn path never read.
    key: { pk: bindingPkFor(b.agent), sk: bindingSkFor(b.runtimeName) },
    set: {
      agent: b.agent,
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
 * Taint the tag. Recorded ON THE ITEM, not held in a process, so the decision survives an
 * operator retrying in a different shell — the specific failure the rail exists to prevent (§5.2).
 *
 * `if_not_exists` on all three fields so the FIRST failure is the recorded reason: a later agent
 * failing for an unrelated reason must not overwrite the diagnosis. The mutable taint attributes ride
 * TOP-LEVEL rather than inside `data`, because a tag's body is written once and never
 * rewritten — that is what lets `specDigest` be recomputed from the stored bytes
 * (`cmd/tag.js:757-771`).
 */
async function taintGeneration(aws, ctx, tag, { reason, by, at }) {
  const docCmds = require('@aws-sdk/lib-dynamodb');
  await taintTag(aws.doc(), docCmds, ctx.resources.configTable, tag, { reason, by, at });
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
 * Assert the runtime AWS actually created is the one the tag declared.
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
 * invert the result for every healthy agent (`cmd/tag.js:1074-1081`).
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
      detail: 'no binding written — a binding asserts "this runtime IS this tag", and this one is not.',
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
    ctx, out, aws, client, imageUri, tag, deps,
  } = run;
  const label = `[${String(position).padStart(String(run.total).length)}/${run.total}] ${agent.padEnd(20)}`;
  const declared = derivedSpecFor(client, agent, imageUri);
  const runtimeName = run.runtimeNameFor(agent, declared);
  const startedAt = Date.now();
  const record = { agent, runtimeName, tag };

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
      // The tag's OWN environment, not `runtimeEnv(agent)` recomputed from the dispatcher's
      // process — that recomputation is exactly what a tag freezes (plan §1).
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
  // when that tag is next requested" (`agentcore-client.js:528-533`). Each one says so.
  const orphanNote = `runtime ${runtimeName} (${runtimeId}) EXISTS AT AWS with no binding row — `
    + 're-running `fleet stage` adopts it by name; nothing else will find it (§6.5)';

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
      tag,
      runtimeArn: env.runtimeArn,
      runtimeId,
      // Plan §7 session isolation: its own microVM session and its own EFS session file, so the
      // synthetic turn never lands in the agent's real conversation.
      sessionId: `prewarm:${agent}:${tag}`,
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
      // exit 6 (re-run) instead of 0, so an unhealthchecked tag can never look complete.
      out.failure({ agent, step: 'healthcheck', error: err });
    } else {
      health = 'failed';
      healthError = String((err && err.message) || err);
      run.healthFailures.push({ agent, error: healthError });
      out.failure({ agent, step: 'healthcheck', error: err });
    }
  }

  // 4. THE BINDING — after the read-back and after the healthcheck, carrying whichever of the three
  //    states actually happened. A `failed` row is written too: `tag show` and
  //    `runtime list --failed` are how the operator finds the agent whose crash reason to read.
  const stagedAt = nowIso(deps);
  const binding = {
    agent,
    tag,
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
 * `archie fleet stage` — §2.8.
 *
 * EXITS, and the pair that matters most (§1.5): 4 means STOP, 6 means GO AGAIN.
 *   0  full coverage, every healthcheck passed.
 *   1  the tag could not be read.
 *   4  a healthcheck FAILED — the tag is now tainted and may never be pointed at.
 *   5  refused (tainted tag, lowered healthcheck budget).
 *   6  stragglers, nothing tainted — re-running is the DESIGNED response.
 *   8  sustained EFS throttling or a quota ceiling — re-running now buys nothing.
 * Getting 4 and 6 the wrong way round is the difference between fixing an image and burning an hour
 * re-running a tag that is already dead.
 */
async function stage(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);

  // `--tag` ONLY — this command declares no positional, and accepting one anyway is unsafe here
  // rather than merely lax: the entry point's first parse pass is non-strict over the GLOBAL options
  // alone, so a command-specific option's VALUE arrives as a positional (`archie fleet stage
  // --concurrency 9` yields positionals ['9']). A positional fallback would have staged tag `9`.
  //
  // `--tag` is still read, silently, for the two-word aliases: a runbook that says
  // `archie tag stage --tag X` resolves here and X is a tag now.
  const tag = values.tag || values.generation;
  if (!tag) throw usage('--tag <tag> is required', { detail: '`archie image list` shows what exists.' });

  const concurrency = parseConcurrency(values.concurrency, out);
  const budgetSeconds = parseBudget(ctx, values['healthcheck-budget']);

  // 1. THE IMAGE. Absent is exit 1 (§2.8), not a usage error: the command was well formed, the thing
  //    it names is not there. Checked against ECR rather than a table — the image is the release, so
  //    "does this release exist" and "can a runtime pull it" are the same question now.
  const account = await resolveAccount(ctx, aws);
  const imageUri = imageUriFor(ctx, account, tag);
  const found = await describeImage(aws, { account, repo: ctx.resources.agentRepo, tag });
  if (!found) {
    throw new CliError(`no image ${tag}`, {
      code: EXIT.FAILED,
      detail: `${imageUri} is not in ECR — build it first (\`archie fleet build\`), or `
        + '`archie image list` shows what has been staged before.',
    });
  }
  assertArm64(found, imageUri);

  // 2. TAINT IS PERMANENT AND UNCONDITIONAL (§5.2). There is no untaint and no force flag: re-staging
  //    after fixing the image means a NEW TAG, which a content digest gives you by construction.
  //    Refusing here rather than at publish saves ~208 provisions that could never be published.
  const taint = await readTaint(aws.doc(), require('@aws-sdk/lib-dynamodb'), ctx.resources.configTable, tag);
  if (taint) {
    throw refused(`${tag} is TAINTED and may never be published`, {
      detail: `tainted ${taint.taintedAt}${taint.reason ? ` — ${taint.reason}` : ''}. `
        + 'There is no untaint: fix the image and build again — the fixed image IS a new tag.',
    });
  }

  // 3. THE ROSTER and what is already done.
  //
  // The dispatcher client is built HERE rather than at step 4 because planning needs the same derived
  // name provisioning does — see planStage's note. Built once and reused, so there is exactly one
  // answer to "what does this deployment derive" per run.
  const { agents } = await enumerateAgents(aws, ctx, values, deps, out);
  const bindings = await scanBindings(aws, ctx);
  const client = deps.client || dispatcherClientFor(ctx, account, deps);
  const runtimeNameFor = runtimeNameFn(deps);
  const expectedNameFor = (agent) => runtimeNameFor(agent, derivedSpecFor(client, agent, imageUri));
  const { todo, skipped } = planStage(agents, bindings, tag, expectedNameFor);

  out.progress(`staging ${todo.length} of ${agents.length} agent(s) onto ${tag}  (concurrency ${concurrency})`
    + (skipped.length ? ` · ${skipped.length} already staged and healthy` : ''));

  const healthcheck = healthcheckFor(deps);
  const healthcheckAvailable = healthcheck !== healthcheckNotImplemented;
  if (!healthcheckAvailable) {
    // LOUD, and in three places: here, on every binding (`healthcheck: 'pending'`), and in the exit
    // code. A silently skipped healthcheck would make an unpublishable tag look ready.
    out.warn(`${HEALTHCHECK_NOT_IMPLEMENTED}. Every agent staged by this run will be bound with `
      + 'healthcheck: "pending" and reported as a straggler (exit 6). No tag may be published '
      + 'until W2-A lands and a real warm-up invoke passes — that gate has no bypass (§5.1).');
  }

  if (ctx.dryRun) {
    const plan = {
      tag,
      image: imageUri,
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
      `tag ${tag}  ${imageUri}`,
      `  would stage  ${todo.length} agent(s) at concurrency ${concurrency}`,
      `  would skip   ${skipped.length} already staged and healthy`,
      `  healthcheck  ${healthcheckAvailable ? `${budgetSeconds}s budget` : 'NOT IMPLEMENTED (W2-A) — would bind as pending'}`,
      '  nothing provisioned, nothing written (dry run)',
    ].join('\n'));
    return undefined;
  }

  // 4. PROVISION. One dispatcher client for the whole run, configured from THIS DEPLOYMENT — the
  //    task definition the gateway is actually running, applied by bin/archie.js before dispatch.
  //    There is no stored spec to configure it from any more, and that is the point: the name this
  //    derives has to be the name the dispatcher will derive, which means deriving from the same
  //    place rather than from a record of what someone once declared.
  // `client` and `runtimeNameFor` are the ones step 3 planned with — deliberately not rebuilt, so
  // planning and provisioning cannot disagree about the name.
  const digestOf = (declared) => specDigestFor(declared, deps).specDigest;

  const run = {
    ctx,
    out,
    aws,
    deps,
    client,
    imageUri,
    tag,
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
    await taintGeneration(aws, ctx, tag, {
      reason: `healthcheck failed during stage — ${reason}`,
      by: whoami(deps),
      at: nowIso(deps),
    });
    taintedNow = true;
  }

  const result = {
    tag,
    image: imageUri,
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
    ? `${tag} is TAINTED — ${failedHealth.length} healthcheck(s) failed. It can never be published; fix the image and build again.`
    : `${tag} NOT tainted${stragglers.length ? ` — re-run to pick up the ${stragglers.length} straggler(s)` : ''}`);
  // In --json the summary is a document on stdout, so the human lines still have to be SAID — stderr
  // carries them, and is never suppressed by --json (§1.4). In text mode they ARE the answer.
  if (ctx.json) {
    out.answer(result);
    for (const l of lines) out.progress(l);
  } else {
    out.answer(lines.join('\n'));
  }

  // EXIT PRECEDENCE. Taint outranks everything: the tag is dead, and telling the operator to
  // re-run (6) or to wait for headroom (8) would send them to burn an hour on it.
  if (taintedNow) {
    throw tainted(`${failedHealth.length} healthcheck(s) failed — ${tag} is tainted`, {
      detail: run.healthFailures.map((f) => `${f.agent}: ${f.error}`).join(' · ')
        + ' — taint is permanent and unconditional; there is no untaint and no force flag (§5.2).',
    });
  }
  if (run.headroom.quota || run.headroom.throttle >= SUSTAINED_THROTTLE_FAILURES) {
    throw headroom(run.headroom.quota
      ? `hit a service quota while staging ${tag}`
      : `sustained throttling while staging ${tag} (${run.headroom.throttle} throttled provisions)`, {
      detail: run.headroom.quota
        ? 'Re-running now buys nothing. Reap superseded runtimes first (`archie runtime gc`) — at '
          + 'every agent in the fleet, keeping 3 tags is 1,040 runtimes against the 1,000 cap (§5.4).'
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
  'fleet stage': stage,

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
  // W2-A composes this: one place threads --profile to the clients the dispatcher's own client
  // builds for itself, so the healthcheck cannot end up on a different credential path than staging.
  clientsFor,
  HEALTHCHECK_NOT_IMPLEMENTED,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_HEALTHCHECK_BUDGET_SECONDS,
};

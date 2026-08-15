'use strict';

// `archie release set|show|history` and `archie generation taint` — RUNTIME-CLI-REFERENCE.md §2.13,
// §2.14 and §2.11. Data model: RUNTIME-RELEASE-PLAN.md §3.
//
// WHAT THIS FILE IS. `release set` is the ONLY command in the CLI that moves live traffic, and it is
// one item write. Everything expensive — building the image, cutting the generation, provisioning
// ~208 runtimes, healthchecking them — has already happened by the time it runs, and every one of
// those steps left evidence in the table. So this command is almost entirely REFUSALS over that
// evidence: the write is trivial, the judgement is not.
//
// THE REFUSALS ARE THE FEATURE (§2.13, §5.1, §5.2). A generation may be pointed at only if it is not
// tainted, has live runtimes, and every binding it has says its healthcheck PASSED — in every mode
// without exception: normal release, `--hotfix`, and rollback. There is no force flag, no
// `--i-know-what-im-doing` and no environment variable, and none will be added: "a rollback target is
// not exempt on the grounds that it worked before: the image is only half the state, and the
// environment it is rolling back into has moved" (plan §2 principle 7).
//
// THE GATE IS DERIVED FROM `generation list`'s OWN STATE FUNCTION, not from a second opinion. Taint
// and reaping are read through `stateOf` (`cmd/generation.js:634`), which is what prints the STATE
// column an operator reads before rolling back. Anything that column calls a rollback target, this
// command accepts (modulo health); anything it calls TAINTED or reaped, this command refuses. Two
// independent implementations of "can I point at this?" is exactly how an operator ends up being told
// yes by one command and no by the other at 2am.
//
// WHY TAINT LIVES HERE AND NOT WITH THE HEALTHCHECK. Taint is normally written automatically by a
// failed healthcheck during staging (`cmd/stage.js:479`); `generation taint` exists so an operator can
// condemn a generation for a reason the CLI cannot detect. It is set-only and permanent — no
// `untaint`, no `--clear`, no `--force` (§5.2) — because its whole purpose is that the decision
// "survives an operator retrying in a different shell". The WRITE itself is `cmd/stage.js`'s
// `taintGeneration`, imported rather than re-spelled: two writers of the same three attributes is two
// chances to disagree about `if_not_exists`, and the first recorded reason must win.
//
// THE DYNAMODB LANDMINE (`runtime-registry.js:134-138`). `agent` and `data` are reserved words — an
// unaliased `agent` broke every turn for every agent live on 2026-08-13 — and unit tests cannot catch
// a miss: they assert command shape against a fake client and "happily asserted the broken expression
// string" (`registry-e2e.js:5-15`). Every attribute name in every expression below is aliased. `data`
// matters doubly here: it is the attribute this file both reads (the generation body) and writes (the
// pointer body), and it appears in NO expression precisely because the pointer is written with
// PutItem, whose item map needs no aliasing.

const {
  GENERATION_PK, RELEASE_KEY, readGeneration, readBody, scanBindings, bindingStats, stateOf,
  describeImage, assertArm64, imageUriFor, resolveAccount,
} = require('./generation');
const { taintGeneration } = require('./stage');
const {
  CliError, EXIT, usage, preflight, refused,
} = require('../lib/exit');
const { makeClient } = require('../lib/aws');

// ── constants ────────────────────────────────────────────────────────────────────────────────────

// HISTORY LIVES IN ITS OWN PARTITION, and not under `CONFIG#release` with the pointer. Plan §3
// reserves the pointer's partition for SCOPE OVERRIDES — `sk: 'AGENT#<id>'`, `sk: 'CHANNEL#<id>'`,
// read before `ACTIVE` and winning over it — so the natural way to read that partition later is a
// Query of the whole thing. An unbounded, ever-growing audit log sharing it would make that Query
// paginate over history forever, and would put the record of past releases one careless
// `begins_with` away from being read as a live pointer.
//
// Sort key is `<publishedAt>#<generationId>`: ISO-8601 sorts lexicographically, so a Query with
// ScanIndexForward:false is newest-first with no client-side sort and `--limit` costs one page.
const HISTORY_PK = 'CONFIG#release-history';

// The two modes a pointer records (plan §3). `hotfix` is ATTRIBUTION ONLY — it changes nothing this
// command checks (§2.13). Its purpose is that the cold-start burst a hotfix causes (the every agent in the fleet
// with no binding for the new generation) reads as intentional rather than as a regression on the
// `runtime_cache_outcomes` scoreboard (plan §5).
const MODES = { staged: 'staged', hotfix: 'hotfix' };

// The dispatcher caches the pointer with a 5s TTL and refreshes it in the background
// (`image-source.js:30-31,132-138`), so a publish is effective within ~5s with no deploy and no
// restart. Quoted in the output because "did it take?" is the first question after this command.
const POINTER_TTL_SECONDS = 5;

const DEFAULT_HISTORY_LIMIT = 20;

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

/** The answer, shaped for the reader: an object under --json, the reference's block otherwise. */
const answer = (out, ctx, obj, text) => out.answer(ctx.json ? obj : text);

/** `new Date()` unless a test injected a clock. */
const nowIso = (deps) => new Date(deps.now ? deps.now() : Date.now()).toISOString();

/** Everything after the last `:` of an image URI — what the reference's tables show. */
const tagOf = (uri) => (typeof uri === 'string' && uri.includes(':') ? uri.slice(uri.lastIndexOf(':') + 1) : null);

/** Who published this. Attribution only — nothing authorises on it. */
function whoami(deps) {
  if (deps.user) return deps.user;
  try {
    return require('node:os').userInfo().username;
  } catch {
    // A container with no passwd entry for the uid: attribution degrades, the command does not fail.
    return process.env.USER || process.env.LOGNAME || 'unknown';
  }
}

function asPositiveInt(label, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw usage(`${label} must be a positive integer, got "${value}"`);
  return n;
}

/** Fixed-width table for the non-JSON output. */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

// ── clients ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Lazily-constructed AWS clients, every one injectable, so `node --test` touches neither credentials
 * nor the network. Shaped as `{ doc(), sts() }` because cmd/generation.js's exported readers take
 * exactly this object (`readGeneration(aws, ctx, id)`, `scanBindings(aws, ctx)`).
 */
function clientsFor(ctx, deps = {}) {
  // `--profile` has to reach any client the dispatcher's own modules construct for themselves
  // (`agentcore-client.js:346-364` builds its own from the default credential chain — there is no
  // credentials seam to inject). AWS_PROFILE is the only channel that reaches those. Same line, same
  // reasoning, as cmd/generation.js and cmd/stage.js.
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
    // `release publish-image` only — the shape `cmd/generation.js:describeImage` expects.
    ecr() {
      if (!ecr) ecr = makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient');
      return ecr;
    },
  };
}

/**
 * `--account` is an ASSERTION (§1.2): "assert the caller is in this account, or exit 3".
 *
 * Checked only when it is supplied, and only by the command that moves traffic. Everything here
 * addresses one table in one region, so a wrong account usually surfaces as a missing table — but
 * "the right profile against the wrong deployment" is a real 2am failure, and this is the one command
 * where finding out afterwards is expensive.
 *
 * NOTE: the same three lines as cmd/generation.js's and cmd/stage.js's private `resolveAccount`. Each
 * task owns one file; when the wave lands, all three belong in `lib/`.
 */
async function assertAccount(ctx, aws) {
  if (!ctx.account) return null;
  const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const id = await aws.sts().send(new GetCallerIdentityCommand({}));
  const actual = id && id.Account;
  if (!actual) throw preflight('GetCallerIdentity returned no account');
  if (actual !== ctx.account) {
    throw preflight(`--account ${ctx.account} but the caller is in ${actual}`,
      { detail: 'wrong profile, or the right profile against the wrong deployment' });
  }
  return actual;
}

// ── the pointer item ─────────────────────────────────────────────────────────────────────────────

/**
 * THE RELEASE POINTER — `CONFIG#release / ACTIVE`, one item, fleet-wide (plan §3).
 *
 *   { pk: 'CONFIG#release', sk: 'ACTIVE',
 *     data: '<JSON string>',                                  // the body, opaque and order-stable
 *     generationId, mode, publishedAt, publishedBy }          // mirrored top-level, see below
 *
 *   body = { generationId, mode: 'staged'|'hotfix', publishedAt, publishedBy,
 *            image, imageTag, specDigest,                     // what the pointer MEANT when written
 *            previousGenerationId,                            // the chain, for history and rollback
 *            coverage: { agents, bound, live, ok, failed, pending } }
 *
 * WHY BOTH A BODY AND TOP-LEVEL MIRRORS. The body is the canonical form: `readBody`
 * (`cmd/generation.js:132`) prefers `data` and parses it, a JSON string is order-stable, and adding a
 * field to it needs no reader to change. But `cmd/status.js:702-705` reads `releaseItem.generationId`
 * / `.mode` / `.publishedAt` / `.publishedBy` STRAIGHT OFF THE ITEM, and a body-only pointer would
 * read there as "no pointer" — i.e. `archie status` would report a total outage on a healthy fleet.
 * Both are written in ONE PutItem from ONE object, so they cannot drift; the mirrors are exactly the
 * four fields plan §3 fixes, and nothing new is ever added to them.
 *
 * The pointer is NOT the generation record. It carries `image`/`specDigest` as a snapshot of what was
 * published, for reading history without a second GetItem — `CONFIG#generation` remains authoritative.
 */
function pointerItemFor(sk, body) {
  return {
    pk: RELEASE_KEY.pk,
    sk,
    data: JSON.stringify(body),
    generationId: body.generationId,
    mode: body.mode,
    publishedAt: body.publishedAt,
    publishedBy: body.publishedBy,
  };
}

/** History rows are the pointer as it was published, under their own partition and key. */
const historySkFor = (body) => `${body.publishedAt}#${body.generationId}`;
const historyItemFor = (body) => ({ ...pointerItemFor(historySkFor(body), body), pk: HISTORY_PK });

/**
 * The pointer, read CONSISTENTLY.
 *
 * ConsistentRead everywhere it is read, matching the turn path (`image-source.js:63-66`): "a publish
 * followed immediately by a message must not serve the old image from a stale replica". The same
 * applies to an operator: `release set` then `release show` returning the pre-write value would look
 * exactly like a lost write, and the documented recovery from an exit-1 `release set` is to trust
 * `release show` (§3.1 step 6).
 */
async function readPointerItem(aws, ctx) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await aws.doc().send(new GetCommand({
    TableName: ctx.resources.configTable, Key: RELEASE_KEY, ConsistentRead: true,
  }));
  return r.Item || null;
}

/**
 * An absent pointer is EXIT 1, never a benign empty state (§2.14).
 *
 * There is no baked fallback image anywhere: a missing pointer means every turn fails
 * `ImagePointerMissing` by design, because a floor "sounds like resilience and behaves like a silent
 * downgrade" (`image-source.js:11-15`). Printing "none" here would report a total outage as a blank.
 */
function noPointerError(ctx) {
  return new CliError(`no release pointer: ${RELEASE_KEY.pk} / ${RELEASE_KEY.sk} is not in ${ctx.resources.configTable}`, {
    code: EXIT.FAILED,
    detail: 'This is not an empty state — there is no baked fallback image, so with no pointer every '
      + 'turn fails ImagePointerMissing (image-source.js:11-15). Publish one: `archie release set <generationId>`.',
  });
}

// ── the gate ─────────────────────────────────────────────────────────────────────────────────────

/**
 * MAY THIS GENERATION BE POINTED AT? Returns a CliError to throw, or null.
 *
 * PURE, and deliberately so: every refusal in §2.13 is decided from the generation item, its binding
 * rows and the current pointer, with no client, no clock and no flags. That is what makes "there is no
 * force flag" checkable — the function takes no argument that could become one, and `--hotfix` is not
 * passed to it at all (it is attribution, §2.13).
 *
 * Order matters. Taint outranks everything (§5.2: permanent and unconditional), then existence of a
 * staged runtime to point AT, then health. Reporting "no healthcheck" for a generation that is
 * tainted would send an operator to re-run a healthcheck on a generation that can never ship.
 */
function releaseRefusal({
  generationId, item, rows, release, table,
}) {
  // 4. A generation that does not exist. Exit 5, not 1: §3.1 step 6 reserves exit 1 for "the write or
  //    the read-back failed" — the case where the pointer may have moved — and this one is the case
  //    where nothing was touched at all. An operator who typo'd an id must be able to tell those apart
  //    without running `release show`.
  if (!item) {
    return refused(`no generation ${generationId} — refusing to point at a generation that does not exist`, {
      detail: `${GENERATION_PK} / ${generationId} is not in ${table}. \`archie generation list\` shows what is.`,
    });
  }

  const stats = bindingStats(rows);
  // ONE opinion about taint and reaping, shared with `generation list`'s STATE column.
  const state = stateOf({ item, stats, release });

  // 2. A tainted generation, in EVERY mode. §5.2: "A generation whose healthcheck failed may never be
  //    pointed at, by any command, in any mode." Including rollback — the image is only half the
  //    state, and the environment it is rolling back into has moved.
  if (state.isTainted) {
    return refused(`generation ${generationId} is TAINTED and may never be pointed at, in any mode`, {
      detail: `tainted ${item.taintedAt}${item.taintReason ? ` — ${item.taintReason}` : ''}`
        + `${item.taintedBy ? ` (by ${item.taintedBy})` : ''}. There is no untaint and no force flag (§5.2): `
        + `cut a new generation (\`archie generation create --from ${generationId}\`) and stage it, which re-runs the check.`,
    });
  }

  const body = readBody(item) || {};
  if (!body.spec || !body.spec.image) {
    return refused(`generation ${generationId} has no declared spec`, {
      detail: 'the stored body carries no `spec.image`, so this item was not written by `generation create` — '
        + 'pointing at it would name a release nothing can reproduce or verify.',
    });
  }

  // 3a. Never staged. Bindings are what the turn path reads (plan §3: pointer -> RUNTIME#<agent> /
  //     GEN#<generationId> -> invoke arn), so a generation with none is a pointer at nothing: every
  //     agent would provision from cold on its next message, unhealthchecked.
  if (stats.bound === 0) {
    return refused(`generation ${generationId} has never been staged — no agent is bound to it`, {
      detail: `stage it first: \`archie generation stage --generation ${generationId}\` `
        + '(one canary is enough for a hotfix — coverage is skipped there, verification never is).',
    });
  }

  // 3b. Reaped. The rows survive as history but the reaper REMOVEd their arn, and pointing at one
  //     "would invoke a corpse" (`runtime-registry.js:30-37`). Re-staging is the fix, and it also
  //     re-healthchecks the generation under the CURRENT régime, which is the actual reason a
  //     reaped rollback target is not simply resurrected.
  if (state.isReaped) {
    return refused(`generation ${generationId} has been reaped — its ${stats.bound} binding(s) hold no live runtime`, {
      detail: 'The rows survive as history but their ARNs are gone; pointing at one would invoke a corpse '
        + `(runtime-registry.js:30-37). Re-stage it — \`archie generation stage --generation ${generationId}\` — `
        + 'which also re-healthchecks it under the current régime.',
    });
  }

  // 1. THE HEALTHCHECK CONTROL LIMIT (§5.1), in every mode without exception. `failed` first: it is
  //    the diagnosis, and it should have tainted the generation already — seeing it without a taint
  //    means that write was lost, which is worth saying out loud.
  if (stats.failed > 0) {
    return refused(`generation ${generationId} has ${stats.failed} FAILED healthcheck(s)`, {
      detail: 'Nothing becomes live without a passing healthcheck, in every mode: normal release, --hotfix '
        + 'and rollback (§5.1). This generation is not tainted, which means the taint write was lost — '
        + `record it: \`archie generation taint ${generationId} --reason "…"\`.`,
    });
  }
  if (stats.pending > 0) {
    return refused(`generation ${generationId} has ${stats.pending} binding(s) whose healthcheck has not run`, {
      detail: 'A binding written `pending` asserts nothing was ever invoked (cmd/stage.js:36-41), and control-plane '
        + 'READY is not serving-ready — that gap is exactly what the check exists to catch (§5.1, §6.2). '
        + `Re-run \`archie generation stage --generation ${generationId}\`; it is additive and skips healthy agents.`,
    });
  }
  // UNREACHABLE TODAY, and kept deliberately. `bindingStats` increments exactly one of ok/failed/
  // pending per row (cmd/generation.js:637-643), so `bound = ok + failed + pending`; with `bound > 0`
  // proven above and both other counters zero by the two rails above, `ok` cannot be 0. The @cli
  // `zero-ok` leg — rows carrying no `healthcheck` attribute at all — therefore lands on the pending
  // rail, which is the correct answer.
  //
  // It stays because it is the SAFE side of an invariant this function does not own: a fourth
  // healthcheck state that incremented none of the three (`skipped`, `expired`) would silently make
  // `bound > ok + failed + pending` true and this branch live again — and the behaviour it would then
  // produce, refusing, is the one we want. Deleting it would trade a dead line for a release path
  // that opens on a future edit to a different file.
  if (stats.ok === 0) {
    return refused(`generation ${generationId} has no passing healthcheck`, {
      detail: 'Nothing becomes live without one, and there is no force flag, no --i-know-what-im-doing and no '
        + 'environment variable (§5.1).',
    });
  }
  return null;
}

// ── release set ──────────────────────────────────────────────────────────────────────────────────

/**
 * Move the live pointer — §2.13. The only command in the CLI that moves traffic.
 *
 * Exits: 0 published (or already live) · 2 usage · 3 `--account` mismatch · 5 refused, NOTHING
 * written · 1 the write or the consistent read-back failed (check `archie release show` before
 * retrying — the read-back is ConsistentRead, so it is authoritative, §3.1 step 6).
 */
async function set(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const generationId = (args && args.positionals && args.positionals[0]) || null;
  if (!generationId) {
    throw usage('archie release set <generationId> [--hotfix]', {
      detail: '`archie generation list` shows which generations are rollback targets.',
    });
  }
  const mode = values.hotfix ? MODES.hotfix : MODES.staged;

  const aws = clientsFor(ctx, deps);
  await assertAccount(ctx, aws);

  // All three reads before any decision, and all three before any write. `scanBindings` is a Scan and
  // NEVER `ListAgentRuntimes`: List is 25/s account-wide with no name filter and no get-by-name
  // (`runtime-registry.js:5-10`), so coverage and liveness come from the registry, always.
  const [item, previousItem, bindings] = await Promise.all([
    readGeneration(aws, ctx, generationId),
    readPointerItem(aws, ctx),
    scanBindings(aws, ctx),
  ]);
  const previous = readBody(previousItem);
  const rows = bindings.filter((b) => b.generationId === generationId);
  const stats = bindingStats(rows);

  const refusal = releaseRefusal({
    generationId, item, rows, release: previous, table: ctx.resources.configTable,
  });
  // NOTHING IS MUTATED ON A REFUSAL — the throw happens before the only write in this file's set path,
  // and there is no earlier write to undo. Exit 5 means "pointer unchanged, old generation still
  // serving" and that promise is what makes the refusals safe to hit (§3.1 step 6).
  if (refusal) throw refusal;

  // A partially reaped generation is allowed but never silent: those agents have a row with no ARN,
  // so they provision from cold on their next message. That is the same shape `--hotfix` creates
  // deliberately, and it is worth an operator knowing they are about to cause it accidentally.
  if (stats.reaped > 0) {
    out.warn(`${stats.reaped} of ${stats.bound} binding(s) for ${generationId} have been reaped — `
      + 'those agents hold no live runtime and will cold-start on their next message');
  }

  const body = readBody(item) || {};
  const publishedAt = nowIso(deps);
  const fleetAgents = new Set(bindings.map((b) => b.agent)).size;
  const pointer = {
    generationId,
    mode,
    publishedAt,
    publishedBy: whoami(deps),
    image: body.image || (body.spec && body.spec.image) || null,
    imageTag: body.imageTag || tagOf(body.image || (body.spec && body.spec.image)),
    specDigest: body.specDigest || null,
    previousGenerationId: (previous && previous.generationId) || null,
    coverage: {
      agents: fleetAgents,
      bound: stats.bound,
      live: stats.live,
      ok: stats.ok,
      failed: stats.failed,
      pending: stats.pending,
    },
  };

  const head = [
    `target    ${generationId}  image ${pointer.imageTag || pointer.image || '—'}`
    + `  coverage ${stats.live}/${fleetAgents}  health ${stats.ok} ok / ${stats.failed} failed`,
    `previous  ${pointer.previousGenerationId || 'none'}`,
  ];

  // Already live AND identical: nothing to write. Checked AFTER the gate on purpose — re-running a
  // release must be a clean no-op (W2-C composes this command), but a LIVE generation that has since
  // been tainted or reaped must still refuse loudly rather than be waved through as "already there".
  if (previous && previous.generationId === generationId
      && (previous.mode || MODES.staged) === mode && previousItem.data) {
    out.progress(`${generationId} is already live (mode=${mode}, published ${previous.publishedAt || 'unknown'}) — nothing written`);
    answer(out, ctx, { ...pointer, publishedAt: previous.publishedAt || null, publishedBy: previous.publishedBy || null, written: false, unchanged: true },
      [...head, `written   nothing — already live since ${previous.publishedAt || 'unknown'}`].join('\n'));
    return undefined;
  }

  if (ctx.dryRun) {
    out.progress(`would write ${RELEASE_KEY.pk} / ${RELEASE_KEY.sk}  generationId=${generationId} mode=${mode}`);
    out.progress(`would append ${HISTORY_PK} / ${historySkFor(pointer)}`);
    answer(out, ctx, { ...pointer, written: false, dryRun: true },
      [...head, 'written   nothing (dry run)', `effective  would be within ~${POINTER_TTL_SECONDS}s`].join('\n'));
    return undefined;
  }

  // ONE ITEM WRITE. No ConditionExpression: the pointer is the one item in this design that is MEANT
  // to be overwritten, and a condition on the previous value would refuse a legitimate move whenever
  // the pointer was last written by anything that did not mirror `generationId` top-level. The race
  // it would guard is detected instead by the read-back below, which has to happen anyway.
  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  await aws.doc().send(new PutCommand({
    TableName: ctx.resources.configTable,
    Item: pointerItemFor(RELEASE_KEY.sk, pointer),
  }));

  // THE CONSISTENT READ-BACK (§2.13). Not decoration: an eventually-consistent read here could serve
  // the previous pointer and make a successful publish look lost, which is how an operator ends up
  // publishing twice. It also catches the concurrent-publish race the Put deliberately does not
  // guard — if someone else's pointer won, this says so instead of reporting our own value back.
  const readBackItem = await readPointerItem(aws, ctx);
  const readBack = readBody(readBackItem);
  if (!readBack) {
    throw new CliError(`the pointer write succeeded but ${RELEASE_KEY.pk} / ${RELEASE_KEY.sk} reads absent`, {
      code: EXIT.FAILED,
      detail: 'A strongly-consistent read cannot legitimately miss a completed write — check the table and '
        + '`archie release show` before retrying.',
    });
  }
  if (readBack.generationId !== generationId) {
    throw new CliError(`the pointer now names ${readBack.generationId}, not ${generationId} — another publish raced this one`, {
      code: EXIT.FAILED,
      detail: `published ${readBack.publishedAt || 'unknown'} by ${readBack.publishedBy || 'unknown'}. `
        + 'Both writes landed; the last one wins. Agree who is releasing, then re-run.',
    });
  }
  if (readBack.publishedAt !== publishedAt) {
    out.warn(`the pointer names ${generationId} but was published at ${readBack.publishedAt} by `
      + `${readBack.publishedBy || 'unknown'} — someone else published the same generation at the same time`);
  }

  // HISTORY IS APPENDED AFTER, AND NEVER MUTATES A PRIOR ROW. Order is deliberate: the pointer is the
  // truth and history is a record of it, so a failed append costs a missing line in `release history`
  // while a failed pointer write costs the release. Doing it the other way round would log publishes
  // that never happened. The condition makes the append immutable — a row is written once, and an id
  // republished in the same millisecond is a benign no-op rather than an overwrite.
  let history = historySkFor(pointer);
  try {
    await aws.doc().send(new PutCommand({
      TableName: ctx.resources.configTable,
      Item: historyItemFor(pointer),
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    }));
  } catch (e) {
    history = null;
    if (e && e.name === 'ConditionalCheckFailedException') {
      out.verbose(`history row ${HISTORY_PK} / ${historySkFor(pointer)} already exists — not overwritten`);
    } else {
      // NOT fatal and NOT a per-unit failure (which would exit 6, "re-run me"): traffic has already
      // moved, and sending an operator back to re-run the one command that moves traffic because an
      // audit row is missing would be a strictly worse outcome than the missing row.
      out.warn(`the release is live but the history row could not be appended: ${(e && e.message) || e}`);
    }
  }

  answer(out, ctx, {
    ...pointer, written: true, readback: 'consistent', historySk: history, effectiveWithinSeconds: POINTER_TTL_SECONDS,
  }, [
    ...head,
    `written   ${RELEASE_KEY.pk} / ${RELEASE_KEY.sk}  mode=${mode}  by ${pointer.publishedBy}`,
    'readback  CONSISTENT  ok',
    `effective within ~${POINTER_TTL_SECONDS}s (dispatcher pointer cache TTL)`,
  ].join('\n'));
  return undefined;
}

// ── release show ─────────────────────────────────────────────────────────────────────────────────

/**
 * The active generation and how it was published — §2.14. Read-only. Exit 1 if there is no pointer.
 *
 * Deliberately CHEAP: the pointer plus the one generation item it names, and no table scan. Coverage
 * and drift are `archie status`'s job; this command's job is to answer "what is live, and who put it
 * there" in two GetItems, including on a table too large or too hot to scan.
 */
async function show(ctx, args, out, deps = {}) {
  const aws = clientsFor(ctx, deps);
  const item = await readPointerItem(aws, ctx);
  const pointer = readBody(item);
  if (!pointer || !pointer.generationId) throw noPointerError(ctx);

  // The generation the pointer names, read for the two things only it knows: whether it still exists
  // at all, and whether it has been tainted SINCE it went live — "a generation tainted after it went
  // live is the situation you most need to see" (`cmd/generation.js:630-632`).
  const generation = await readGeneration(aws, ctx, pointer.generationId);
  const body = readBody(generation) || {};
  if (!generation) {
    out.warn(`the pointer names ${pointer.generationId} but there is no ${GENERATION_PK} item for it — `
      + 'the release cannot be reproduced, diffed or verified');
  } else if (generation.taintedAt) {
    out.warn(`the LIVE generation ${pointer.generationId} is TAINTED (${generation.taintReason || 'no reason recorded'}) — `
      + 'it is serving traffic and may never be pointed at again; roll forward or roll back');
  }

  const result = {
    generationId: pointer.generationId,
    mode: pointer.mode || null,
    publishedAt: pointer.publishedAt || null,
    publishedBy: pointer.publishedBy || null,
    previousGenerationId: pointer.previousGenerationId || null,
    image: pointer.image || body.image || null,
    imageTag: pointer.imageTag || body.imageTag || tagOf(body.image) || null,
    specDigest: pointer.specDigest || body.specDigest || null,
    generationExists: Boolean(generation),
    taintedAt: (generation && generation.taintedAt) || null,
    taintReason: (generation && generation.taintReason) || null,
    coverage: pointer.coverage || null,
  };

  answer(out, ctx, result, [
    `release   ${result.generationId}`,
    `  mode        ${result.mode || 'unrecorded'}`,
    `  published   ${result.publishedAt || '—'} by ${result.publishedBy || '—'}`,
    `  image       ${result.image || '—'}`,
    `  specDigest  ${result.specDigest || '—'}`,
    `  previous    ${result.previousGenerationId || '—'}`,
    `  generation  ${result.generationExists ? 'present' : 'MISSING'}`
    + `${result.taintedAt ? `  ***TAINTED ${result.taintedAt}***` : ''}`,
  ].join('\n'));
  return undefined;
}

// ── release history ──────────────────────────────────────────────────────────────────────────────

/**
 * Previous pointer values, newest first — §2.14.
 *
 * Rows are APPENDED by `release set` and never rewritten, so this is a log rather than a derived
 * view: it records what was published even for a generation that has since been deleted, tainted or
 * reaped. `--limit` is one Query page because the sort key is the timestamp.
 */
async function listHistory(aws, ctx, limit) {
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await aws.doc().send(new QueryCommand({
    TableName: ctx.resources.configTable,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' },
    ExpressionAttributeValues: { ':pk': HISTORY_PK },
    ScanIndexForward: false,   // newest first: the sort key is `<publishedAt>#<generationId>`
    Limit: limit,
  }));
  return (r.Items || []).map((i) => ({ ...(readBody(i) || {}), sk: i.sk }));
}

async function history(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const limit = values.limit === undefined ? DEFAULT_HISTORY_LIMIT : asPositiveInt('--limit', values.limit);
  const aws = clientsFor(ctx, deps);

  // The ABSENT POINTER IS EXIT 1 HERE TOO, and it is checked first. An empty history with a live
  // pointer is merely a table older than this command; no pointer at all is a total outage (§2.14),
  // and printing a history of past releases while the fleet cannot serve any would bury it.
  const item = await readPointerItem(aws, ctx);
  const active = readBody(item);
  if (!active || !active.generationId) throw noPointerError(ctx);

  const rows = await listHistory(aws, ctx, limit);

  // A pointer written before this command existed (or by hand) has no history row. Synthesising it
  // from the pointer keeps the newest entry — the one that matters — present and honest about where
  // it came from, rather than showing a history whose top row is not what is live.
  const represented = rows.some((r) => r.generationId === active.generationId && r.publishedAt === active.publishedAt);
  const entries = (represented ? rows : [{ ...active, sk: null, fromPointer: true }, ...rows]).slice(0, limit);
  const marked = entries.map((e) => ({
    ...e,
    active: e.generationId === active.generationId && e.publishedAt === active.publishedAt,
  }));

  answer(out, ctx, { active: active.generationId, count: marked.length, history: marked },
    renderTable(['PUBLISHED', 'GENERATION', 'MODE', 'BY', ''], marked.map((e) => [
      e.publishedAt || '—',
      e.generationId || '—',
      e.mode || 'staged',
      e.publishedBy || '—',
      `${e.active ? 'ACTIVE' : ''}${e.fromPointer ? ' (from pointer — no history row)' : ''}`.trim(),
    ])));
  return undefined;
}

// ── generation taint ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a generation permanently unpointable — §2.11, §5.2.
 *
 * SET-ONLY, PERMANENT, IDEMPOTENT. There is no `untaint`, no `--clear` and no `--force`, and none
 * will be added: a generation you believe was wrongly tainted is cut again as a NEW generation, which
 * is cheap and re-runs the check. The write is `cmd/stage.js`'s `taintGeneration` — `if_not_exists` on
 * all three attributes, so the FIRST recorded reason wins and a later condemnation cannot overwrite
 * the original diagnosis.
 *
 * The three attributes ride TOP-LEVEL, never inside `data`: a generation's body is written once and
 * never rewritten, which is what lets `specDigest` be recomputed from the stored bytes
 * (`cmd/generation.js:757-771`).
 *
 * Exits: 0 tainted (or already tainted) · 2 usage · 1 no such generation.
 */
async function taint(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const generationId = (args && args.positionals && args.positionals[0]) || null;
  if (!generationId) throw usage('archie generation taint <generationId> --reason <text>');
  const reason = typeof values.reason === 'string' ? values.reason.trim() : '';
  if (!reason) {
    throw usage('--reason <text> is required', {
      detail: 'Taint is permanent and there is no untaint (§5.2) — the reason is the only thing that tells the '
        + 'next operator why this generation can never ship.',
    });
  }

  const aws = clientsFor(ctx, deps);
  const item = await readGeneration(aws, ctx, generationId);
  // Exit 1, matching `generation stage` (`cmd/stage.js:774-781`): the command was well formed, the
  // thing it names is not there. It also has to be checked rather than left to the write — an
  // UpdateItem on an absent key CREATES the item, so a typo'd id would mint a phantom generation with
  // taint attributes and no body, which `generation list` would then display forever.
  if (!item) {
    throw new CliError(`no generation ${generationId}`, {
      code: EXIT.FAILED,
      detail: `${GENERATION_PK} / ${generationId} is not in ${ctx.resources.configTable} — `
        + '`archie generation list` shows what is.',
    });
  }

  if (item.taintedAt) {
    // Idempotent, and the ORIGINAL reason is what is reported: `if_not_exists` means a second taint
    // changes nothing, so saying so is more honest than writing and claiming success.
    out.progress(`generation ${generationId} is already tainted — nothing written`);
    answer(out, ctx, {
      generationId, taintedAt: item.taintedAt, taintReason: item.taintReason || null, taintedBy: item.taintedBy || null, written: false, unchanged: true,
    }, `generation ${generationId}\n  already TAINTED ${item.taintedAt} by ${item.taintedBy || 'unknown'}`
      + `\n  reason      ${item.taintReason || 'no reason recorded'}`);
    return undefined;
  }

  const at = nowIso(deps);
  const by = whoami(deps);

  if (ctx.dryRun) {
    out.progress(`would taint ${GENERATION_PK} / ${generationId}`);
    answer(out, ctx, {
      generationId, taintedAt: at, taintReason: reason, taintedBy: by, written: false, dryRun: true,
    }, `generation ${generationId}\n  would be TAINTED — ${reason}\n  nothing written (dry run)`);
    return undefined;
  }

  await taintGeneration(aws, ctx, generationId, { reason, by, at });

  answer(out, ctx, {
    generationId, taintedAt: at, taintReason: reason, taintedBy: by, written: true,
  }, [
    `generation ${generationId}`,
    `  TAINTED     ${at} by ${by}`,
    `  reason      ${reason}`,
    '  it may never be pointed at, in any mode — there is no untaint and no force flag (§5.2)',
    `  cut a replacement: archie generation create --from ${generationId} --image <tag>`,
  ].join('\n'));
  return undefined;
}

// ── release publish-image ────────────────────────────────────────────────────────────────────────

const IMAGE_PK = 'CONFIG#image';
const imageSkFor = (agent) => (agent ? `AGENT#${agent}` : 'FLEET');


/**
 * Every per-agent image override in the `CONFIG#image` partition.
 *
 * A Query rather than a Scan: the partition is small and bounded (FLEET plus one row per pinned
 * agent), so this costs one page and cannot see another partition's rows. `#pk` is aliased for the
 * usual reason — `agent` and `data` are reserved words and a bare name is how an expression breaks
 * only in production (runtime-registry.js:134-138).
 */
async function listAgentOverrides(aws, table) {
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await aws.doc().send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': IMAGE_PK },
      ExclusiveStartKey,
    }));
    for (const i of r.Items || []) {
      // FLEET is never a target. Filtered here rather than in the caller so no future caller can
      // forget: this function returns overrides, and the fleet pointer is not one.
      if (!String(i.sk).startsWith('AGENT#')) continue;
      out.push({ agent: String(i.sk).slice('AGENT#'.length), tag: i.tag || null, imageDigest: i.imageDigest || null });
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out.sort((a, b) => (a.agent < b.agent ? -1 : 1));
}

/**
 * `archie release publish-image <tag> [--agent <id>] [--clear]` — §2.13a.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `release set`. There are two pointers, and today they mean
 * different things. `release set` writes `CONFIG#release/ACTIVE`, which is the release model's
 * intent; `image-source.js:63` — the turn path — reads `CONFIG#image` and has never read the other
 * one. So until the dispatcher is switched over (plan §3 "what this replaces"), THIS is the write
 * that actually decides what the fleet provisions, and it was reachable only from
 * `slack-dispatcher/publish-image.mjs`, outside the CLI. `archie preflight` check 4 would tell you
 * the pointer was missing and `archie status` would report it as drift, while the CLI had no way to
 * fix it. That asymmetry is the whole bug this closes.
 *
 * DELIBERATELY NOT MERGED INTO `release set`. Dual-writing both pointers would make `release set`
 * look like it moves traffic when the semantics still live in the other key — and when the turn
 * path does switch, the dual write becomes the thing you have to remember to unpick. One command
 * per pointer, until there is one pointer.
 *
 * THE GATE IS THE SAME ONE `generation create` APPLIES, imported rather than restated: the tag must
 * exist in ECR and must not be a non-arm64 image. A bad pointer does not fail here — it provisions
 * runtimes that cannot pull, so every agent breaks on its NEXT message with a create failure and
 * nothing points back at this command. `publish-image.mjs:18-22` calls that out and it is still the
 * reason: the amd64 dispatcher image is built from the same tree minutes apart.
 */
async function publishImage(ctx, args, out, deps = {}) {
  const aws = clientsFor(ctx, deps);
  const agent = args.values.agent || null;
  const clear = Boolean(args.values.clear);
  const tag = args.positionals && args.positionals[0];

  if (clear && tag) throw usage('--clear takes no tag — it removes a pointer rather than moving it');
  if (!clear && !tag) throw usage('release publish-image needs a tag: `archie release publish-image <tag> [--agent <id>]`');

  const account = await resolveAccount(ctx, aws);
  const table = ctx.resources.configTable;

  // `--clear` UNPINS AGENTS. It never touches `CONFIG#image / FLEET`, and there is deliberately no
  // spelling that does: `image-source.js:11-15` removed the baked fallback on 2026-08-11, so an
  // absent FLEET pointer makes every provision fail closed with ImagePointerMissing — an outage,
  // not a rollback. The revert is publishing the previous tag. (`publish-image.mjs:117` still prints
  // "fleet falls back to the dispatcher's baked image", which has been untrue since that change —
  // this command is why that spelling does not survive into the CLI.)
  //
  // Bare `--clear` unpins EVERY agent; `--clear --agent <id>` unpins one. Both converge agents onto
  // the fleet image, which is the safe direction — the only thing lost is which tag each was pinned
  // to, so every cleared override is reported WITH its tag and can be re-pinned from that output.
  if (clear) {
    const overrides = await listAgentOverrides(aws, table);
    const targets = agent ? overrides.filter((o) => o.agent === agent) : overrides;

    if (!targets.length) {
      out.progress(agent
        ? `agent ${agent} has no image override — nothing to clear`
        : 'no agent image overrides — every agent already follows the fleet pointer');
      return { cleared: [], count: 0 };
    }

    if (ctx.dryRun) {
      for (const o of targets) out.progress(`would unpin ${o.agent} (currently ${o.tag || '?'})`);
      return { cleared: targets, count: targets.length, dryRun: true };
    }

    const { DeleteCommand } = require('@aws-sdk/lib-dynamodb');
    for (const o of targets) {
      await aws.doc().send(new DeleteCommand({ TableName: table, Key: { pk: IMAGE_PK, sk: imageSkFor(o.agent) } }));
      // The tag is reported on the way out, not just counted: it is the only record of what the
      // agent was pinned to, and re-pinning is `release publish-image <tag> --agent <id>`.
      out.progress(`unpinned ${o.agent} (was ${o.tag || '?'}) — now follows the fleet pointer`);
    }
    return { cleared: targets, count: targets.length };
  }

  const Key = { pk: IMAGE_PK, sk: imageSkFor(agent) };

  const repo = ctx.resources.agentRepo;
  const uri = imageUriFor(ctx, account, tag);
  const found = await describeImage(aws, { account, repo, tag });
  if (!found) {
    throw refused(`${uri} does not exist in ECR`, {
      detail: 'Build and push it first — `archie generation build --push`. Publishing a tag that is not there '
        + 'provisions runtimes that cannot pull, and the failure surfaces on each agent\'s next message.',
    });
  }
  assertArm64(found, uri);

  // The item shape `publish-image.mjs:126-134` writes, field for field. Both writers must agree
  // while both exist: `image-source.js:36-41` resolves `imageUri || uri`, then falls back to `tag`
  // against the dispatcher's own repo — so `tag` is the operative field and the digest is provenance.
  const item = {
    ...Key,
    tag,
    imageDigest: found.digest || null,
    publishedAt: new Date().toISOString(),
    publishedBy: whoami(deps),
  };

  if (ctx.dryRun) {
    out.progress(`would publish ${uri} to ${Key.sk}`);
    return { ...item, written: false, dryRun: true };
  }

  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  await aws.doc().send(new PutCommand({ TableName: table, Item: item }));

  out.progress(`published ${uri} to ${Key.sk}`);
  out.verbose(`  digest ${found.digest || '—'}${found.sizeMb ? `  (${found.sizeMb} MB)` : ''}`
    + `${found.arches.length ? `  [${found.arches.join(',')}]` : `  [arch unproven: ${found.archesFrom}]`}`);
  out.verbose('  picked up by the next message per agent — no dispatcher deploy, no restart.');
  return { ...item, written: true, imageUri: uri, arches: found.arches };
}


module.exports = {
  // THE FULL COMMAND KEYS, never bare verbs. `registry.load()` resolves `mod[key] || mod[verb]`, and a
  // verb-keyed export answers for every noun sharing that verb — `show` is also `generation show`'s
  // verb, and `set` would be the obvious name for any future `config set`. Exporting only full keys
  // makes the collision impossible by construction rather than by everyone remembering
  // (`lib/registry.js:156-166`, `cmd/runtime.js:843`).
  'release set': set,
  'release publish-image': publishImage,
  'release show': show,
  'release history': history,
  'generation taint': taint,

  // Internals: for this file's tests and for W2-C (`fleet deploy` composes `release set`, and its
  // pre-flight gate should ask THIS function whether a generation is releasable rather than
  // re-deriving the rule).
  releaseSet: set,
  releasePublishImage: publishImage,
  releaseShow: show,
  releaseHistory: history,
  generationTaint: taint,
  releaseRefusal,
  readPointerItem,
  listHistory,
  pointerItemFor,
  historyItemFor,
  historySkFor,
  HISTORY_PK,
  IMAGE_PK,
  imageSkFor,
  MODES,
  POINTER_TTL_SECONDS,
};

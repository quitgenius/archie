'use strict';

// `archie image publish | taint | show | list` — the pointer and everything that gates it.
//
// ONE WRITE MOVES TRAFFIC: `image publish`. Everything else in the CLI provisions, verifies or
// reports; this is the command that changes what the fleet runs, and it is one item.
//
// ── WHAT REPLACED WHAT ───────────────────────────────────────────────────────────────────────────
//
// `release set <generationId>`  → `image publish <tag>`
// `tag taint <gen>`      → `image taint <tag>`
// `image show` / `tag show` → `image show [tag]`
// `image list` / `image list` → `image list`
// `fleet build`           → nothing. A build produces a tag; there is no record to cut.
//
// The image tag IS the release identity (lib/image-pointer.js has the full argument). Every question
// the tag model answered is answered here from the tag plus the bindings, with no second id
// to keep in step and no item that can disagree with the one the dispatcher reads.
//
// ── THE REFUSAL LADDER, AND WHY IT IS IN THIS ORDER ──────────────────────────────────────────────
//
// Order matters, because the first true thing is what the operator is told and it decides what they
// do next. Reporting "no healthcheck" for a tag that is tainted would send someone to re-run a check
// on a build that can never ship.
//
//   1. TAINTED — permanent, unconditional, every mode including rollback (§5.2).
//   2. NOT IN ECR, or not arm64 — publishing a tag that cannot be pulled breaks every agent on its
//      next message with a create failure, minutes later and far from here.
//   3. NEVER STAGED — bindings are what the turn path reads, so a tag with none is a pointer at
//      nothing: every agent would provision from cold, unhealthchecked, on its next message.
//   4. REAPED — rows survive as history but their ARNs are gone; publishing one invokes a corpse.
//   5. FAILED healthchecks — the control limit (§5.1), in every mode without exception.
//   6. PENDING healthchecks — `pending` asserts nothing was ever invoked, and control-plane READY is
//      not serving-ready. That gap is exactly what the check exists to catch.
//
// `--hotfix` is GONE from publishing, deliberately. It was a label on the pointer, recorded and
// never gated on: no rail consulted it. Narrowing COVERAGE is a staging concern and still exists
// there (`archie fleet deploy --hotfix` stages one canary, and healthchecks it exactly as a full
// fleet would). Keeping a flag on the write that changed nothing about the write was an invitation
// to believe it relaxed something.

const os = require('node:os');

const { CliError, EXIT, usage, refused } = require('../lib/exit');
const { clientsFor, resolveAccount, imageUriFor } = require('../lib/spec');
const { describeImage, assertArm64 } = require('../lib/ecr');
const {
  IMAGE_PK, FLEET_SK, taintSk,
  readFleetPointer, readTaint, listTaints, taintTag, publishFleetPointer,
} = require('../lib/image-pointer');
const { scanBindings, bindingStats, byTag, stateOf } = require('../lib/bindings');

// How long a published pointer takes to reach every turn: the dispatcher caches it with a short TTL
// and a background refresher (`image-source.js`). Reported so nobody watches Slack for 30s wondering
// whether the write landed.
const POINTER_TTL_SECONDS = 5;

/** The answer, shaped for the reader: an object under --json, a block otherwise. */
const answer = (out, ctx, obj, text) => out.answer(ctx.json ? obj : text);

/** `new Date()` unless a test injected a clock. */
const nowIso = (deps) => new Date(deps.now ? deps.now() : Date.now()).toISOString();

/** Who published this. Attribution only — nothing authorises on it. */
function whoami(deps) {
  if (deps.user) return deps.user;
  try {
    return os.userInfo().username;
  } catch {
    // A container with no passwd entry for the uid: attribution degrades, the command does not fail.
    return process.env.USER || process.env.LOGNAME || 'unknown';
  }
}

/** The tag argument, or a usage error naming what to run to find one. */
function requireTag(args, verb) {
  const tag = args && args.positionals && args.positionals[0];
  if (!tag) {
    throw usage(`archie image ${verb} needs a tag`, {
      detail: '`archie image list` shows every tag the fleet has bindings for, which is live, and which are tainted.',
    });
  }
  return String(tag);
}

// ── THE GATE ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why this tag may not be published, or null.
 *
 * A PURE FUNCTION of (tag, ECR lookup, taint record, binding stats), and exported, because
 * `fleet deploy` evaluates the SAME gate before it attempts a flip. That is not belt-and-braces: a
 * control limit with two implementations is a control limit with a bypass, and "there is no force
 * flag" has to be true of the code and not only of the flags (§5.1). Composing it here means this
 * file cannot be given a gate of its own by a later edit — there is nowhere to put one.
 */
function publishRefusal({
  tag, found, taint, stats, imageUri,
}) {
  // 1. TAINT. First, and before anything else is reported: a tainted tag is unpublishable whatever
  //    else is true of it, and every other message would be a distraction from that one.
  if (taint) {
    return refused(`${tag} is TAINTED and may never be published, in any mode`, {
      detail: `tainted ${taint.taintedAt}${taint.reason ? ` — ${taint.reason}` : ''}`
        + `${taint.taintedBy ? ` (by ${taint.taintedBy})` : ''}. There is no untaint and no force flag (§5.2): `
        + 'fix the image and build again — the tag is a content digest, so a fixed image IS a new tag.',
    });
  }

  // 2. THE IMAGE ITSELF. Existence is the hard gate; architecture is refused only when PROVEN wrong
  //    (an unreadable manifest leaves it unproven — see lib/ecr.js).
  if (!found) {
    return refused(`${imageUri} is not in ECR`, {
      detail: 'publishing it would provision runtimes that cannot pull, and every agent would fail on its '
        + 'next message. Build it first: `archie fleet build`.',
    });
  }
  if (found.arches.length && !found.arches.includes('arm64')) {
    return refused(`${imageUri} is ${found.arches.join('/')} — AgentCore microVMs are arm64`, {
      detail: 'this is almost always the amd64 dispatcher image published by mistake.',
    });
  }

  // 3. NEVER STAGED. Bindings are what the turn path reads, so a tag with none is a pointer at
  //    nothing: every agent would provision from cold, unhealthchecked, on its next message.
  if (stats.bound === 0) {
    return refused(`${tag} has never been staged — no agent is bound to it`, {
      detail: `stage it first: \`archie fleet stage --tag ${tag}\` (one canary is enough for a hotfix — `
        + 'coverage is narrowed there, verification never is).',
    });
  }
  // 4. REAPED. The rows survive as history but the reaper REMOVEd their arn.
  if (stats.live === 0) {
    return refused(`${tag} has been reaped — its ${stats.bound} binding(s) hold no live runtime`, {
      detail: 'The rows survive as history but their ARNs are gone; publishing one would invoke a corpse. '
        + `Re-stage it — \`archie fleet stage --tag ${tag}\` — which also re-healthchecks it under the current régime.`,
    });
  }
  // 5. FAILED. The control limit (§5.1), in every mode without exception. `failed` before `pending`:
  //    it is the diagnosis, and it should have tainted the tag already — seeing it without a taint
  //    means that write was lost, which is worth saying out loud.
  if (stats.failed > 0) {
    return refused(`${tag} has ${stats.failed} FAILED healthcheck(s)`, {
      detail: 'Nothing becomes live without a passing healthcheck, in every mode: normal release, hotfix and '
        + 'rollback (§5.1). This tag is not tainted, which means the taint write was lost — record it: '
        + `\`archie image taint ${tag} --reason "…"\`.`,
    });
  }
  // 6. PENDING asserts nothing was ever invoked, and control-plane READY is not serving-ready.
  if (stats.pending > 0) {
    return refused(`${tag} has ${stats.pending} binding(s) whose healthcheck has not run`, {
      detail: 'A binding written `pending` asserts nothing was ever invoked, and control-plane READY is not '
        + 'serving-ready — that gap is exactly what the check exists to catch (§5.1, §6.2). Re-run '
        + `\`archie fleet stage --tag ${tag}\`; it is additive and skips healthy agents.`,
    });
  }
  return null;
}

// ── image publish ────────────────────────────────────────────────────────────────────────────────

async function publish(ctx, args, out, deps = {}) {
  const tag = requireTag(args, 'publish');
  const aws = clientsFor(ctx, deps);
  const table = ctx.resources.configTable;
  const account = await resolveAccount(ctx, aws);
  const uri = imageUriFor(ctx, account, tag);

  const [taint, found, rows] = await Promise.all([
    readTaint(aws.doc(), aws.docCmds, table, tag),
    describeImage(aws, { account, repo: ctx.resources.agentRepo, tag }),
    scanBindings(aws, ctx),
  ]);
  const mine = (byTag(rows).get(tag) || []);
  const stats = bindingStats(mine);
  const fleetAgents = new Set(rows.map((r) => r.agent)).size;

  const refusal = publishRefusal({ tag, found, taint, stats, imageUri: uri });
  if (refusal) throw refusal;

  const previous = await readFleetPointer(aws.doc(), aws.docCmds, table);
  const at = nowIso(deps);
  const by = whoami(deps);
  const pointer = { tag, imageUri: uri, imageDigest: found.digest, publishedAt: at, publishedBy: by };

  const head = [
    `target    ${tag}  digest ${found.digest || '—'}`
    + `  coverage ${stats.live}/${fleetAgents}  health ${stats.ok} ok / ${stats.failed} failed`,
    `previous  ${(previous && previous.tag) || 'none'}`,
  ];

  // Already live: nothing to write. Checked AFTER the gate on purpose — re-publishing must be a
  // clean no-op (`fleet deploy` composes this), but a LIVE tag that has since been tainted or reaped
  // must still refuse loudly rather than be waved through as "already there".
  if (previous && previous.tag === tag) {
    out.progress(`${tag} is already live (published ${previous.publishedAt || 'unknown'}) — nothing written`);
    answer(out, ctx, { ...pointer, publishedAt: previous.publishedAt || null, publishedBy: previous.publishedBy || null, written: false, unchanged: true },
      [...head, `written   nothing — already live since ${previous.publishedAt || 'unknown'}`].join('\n'));
    return undefined;
  }

  if (ctx.dryRun) {
    out.progress(`would write ${IMAGE_PK} / ${FLEET_SK}  tag=${tag}`);
    answer(out, ctx, { ...pointer, written: false, dryRun: true },
      [...head, 'written   nothing (dry run)', `effective would be within ~${POINTER_TTL_SECONDS}s`].join('\n'));
    return undefined;
  }

  // ONE ITEM WRITE. No ConditionExpression: this is the one item in the design that is MEANT to be
  // overwritten, and a condition on the previous value would refuse a legitimate move whenever the
  // pointer was last written by something that shaped it differently. The race it would guard is
  // detected by the read-back below, which has to happen anyway.
  await publishFleetPointer(aws.doc(), aws.docCmds, table, { ...pointer, by, at });

  // THE CONSISTENT READ-BACK. Not decoration: an eventually-consistent read here could serve the
  // previous pointer and make a successful publish look lost, which is how an operator publishes
  // twice. It also catches the concurrent-publish race the write deliberately does not guard — if
  // someone else's pointer won, this says so instead of reporting our own value back.
  const readBack = await readFleetPointer(aws.doc(), aws.docCmds, table);
  if (!readBack) {
    throw new CliError(`the pointer write succeeded but ${IMAGE_PK} / ${FLEET_SK} reads absent`, {
      code: EXIT.FAILED,
      detail: 'the fleet has no image pointer right now and every provision will fail closed — re-run this command.',
    });
  }
  if (readBack.tag !== tag) {
    throw new CliError(`the pointer now reads ${readBack.tag}, not ${tag} — a concurrent publish won`, {
      code: EXIT.FAILED,
      detail: `published ${readBack.publishedAt || 'unknown'} by ${readBack.publishedBy || 'unknown'}. `
        + 'Check with whoever that was before re-running: the fleet is moving to their tag, not yours.',
    });
  }

  out.progress(`published ${IMAGE_PK} / ${FLEET_SK} → ${tag}`);
  answer(out, ctx, { ...pointer, written: true },
    [...head, `written   ${IMAGE_PK} / ${FLEET_SK}`, `effective within ~${POINTER_TTL_SECONDS}s, on each agent's next turn`].join('\n'));
  return undefined;
}

// ── image taint ──────────────────────────────────────────────────────────────────────────────────

/**
 * Mark a tag permanently unpublishable.
 *
 * NO UNTAINT, NO --force, NO --clear (§5.2). The write is one-way because its whole purpose is
 * surviving an operator who retries in a different shell — a taint that could be lifted by the
 * person who tripped over it is not a control limit, it is a speed bump.
 *
 * Recorded even when the tag is already live. A tag tainted AFTER it went live is the situation you
 * most need recorded: it does not roll anything back by itself (that would be an unreviewed traffic
 * move from a command whose job is to write down a fact), it makes the next publish refuse and it
 * shows up in `image list` and `archie status` next to LIVE.
 */
async function taint(ctx, args, out, deps = {}) {
  const tag = requireTag(args, 'taint');
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);
  const table = ctx.resources.configTable;

  const existing = await readTaint(aws.doc(), aws.docCmds, table, tag);
  if (existing) {
    out.progress(`${tag} is already tainted (${existing.taintedAt}) — the first reason is kept`);
    answer(out, ctx, { ...existing, written: false, unchanged: true },
      `already tainted ${existing.taintedAt} by ${existing.taintedBy || 'unknown'} — ${existing.reason || 'no reason recorded'}`);
    return undefined;
  }

  const at = nowIso(deps);
  const by = whoami(deps);
  const reason = values.reason || null;
  if (!reason) {
    out.warn('no --reason: the taint is permanent and the next operator will have nothing to go on');
  }

  if (ctx.dryRun) {
    out.progress(`would write ${IMAGE_PK} / ${taintSk(tag)}`);
    answer(out, ctx, { tag, reason, taintedBy: by, taintedAt: at, written: false, dryRun: true },
      `would taint ${tag} (dry run)`);
    return undefined;
  }

  await taintTag(aws.doc(), aws.docCmds, table, tag, { reason, by, at });

  const live = await readFleetPointer(aws.doc(), aws.docCmds, table);
  if (live && live.tag === tag) {
    out.warn(`${tag} is LIVE right now. Tainting does not roll it back — publish a known-good tag: `
      + '`archie image list` shows the rollback targets.');
  }
  out.progress(`tainted ${tag}`);
  answer(out, ctx, { tag, reason, taintedBy: by, taintedAt: at, written: true, live: Boolean(live && live.tag === tag) },
    `tainted   ${tag}\nreason    ${reason || '— none recorded —'}\nby        ${by} at ${at}`);
  return undefined;
}

// ── image show ───────────────────────────────────────────────────────────────────────────────────

/** One tag: what it is, whether it is live, and every agent bound to it. Defaults to the live tag. */
async function show(ctx, args, out, deps = {}) {
  const aws = clientsFor(ctx, deps);
  const table = ctx.resources.configTable;
  const published = await readFleetPointer(aws.doc(), aws.docCmds, table);
  const tag = (args && args.positionals && args.positionals[0]) || (published && published.tag);
  if (!tag) {
    throw usage('no tag given and nothing is published', {
      detail: '`archie image list` shows every tag with bindings.',
    });
  }

  const [taintRec, rows] = await Promise.all([
    readTaint(aws.doc(), aws.docCmds, table, tag),
    scanBindings(aws, ctx),
  ]);
  const mine = byTag(rows).get(tag) || [];
  const stats = bindingStats(mine);
  const state = stateOf({ tag, stats, publishedTag: published && published.tag, taint: taintRec });

  const result = {
    tag,
    live: state.isLive,
    state: state.state,
    published: state.isLive ? { at: published.publishedAt, by: published.publishedBy, digest: published.imageDigest } : null,
    taint: taintRec,
    stats,
    bindings: mine.map((r) => ({
      agent: r.agent, runtimeName: r.runtimeName, arn: r.arn || null,
      healthcheck: r.healthcheck || 'pending', stagedAt: r.stagedAt || null, reapedAt: r.reapedAt || null,
    })).sort((a, b) => a.agent.localeCompare(b.agent)),
  };

  const lines = [
    `tag       ${tag}${state.isLive ? '   LIVE' : ''}`,
    `state     ${state.state || '—'}`,
    `bindings  ${stats.bound} (${stats.live} live, ${stats.reaped} reaped)  health ${stats.ok} ok / ${stats.failed} failed / ${stats.pending} pending`,
  ];
  if (taintRec) lines.push(`taint     ${taintRec.taintedAt} by ${taintRec.taintedBy || 'unknown'} — ${taintRec.reason || 'no reason recorded'}`);
  answer(out, ctx, result, lines.join('\n'));
  return undefined;
}

// ── image list ───────────────────────────────────────────────────────────────────────────────────

/**
 * Every tag the fleet has bindings for, plus whatever is published and whatever is tainted.
 *
 * Sorted newest-staged first, because the question is almost always "what can I roll back to".
 * A tainted tag with no bindings still appears: knowing a build is condemned is useful precisely
 * when nothing is staged on it.
 */
async function list(ctx, args, out, deps = {}) {
  const aws = clientsFor(ctx, deps);
  const table = ctx.resources.configTable;
  const [published, taints, rows] = await Promise.all([
    readFleetPointer(aws.doc(), aws.docCmds, table),
    listTaints(aws.doc(), aws.docCmds, table),
    scanBindings(aws, ctx),
  ]);

  const taintByTag = new Map(taints.map((t) => [t.tag, t]));
  const groups = byTag(rows);
  const tags = new Set([...groups.keys()].filter(Boolean));
  for (const t of taintByTag.keys()) tags.add(t);
  if (published && published.tag) tags.add(published.tag);

  const entries = [...tags].map((tag) => {
    const mine = groups.get(tag) || [];
    const stats = bindingStats(mine);
    const state = stateOf({ tag, stats, publishedTag: published && published.tag, taint: taintByTag.get(tag) });
    const stagedAt = mine.map((r) => r.stagedAt || r.createdAt || '').filter(Boolean).sort().pop() || null;
    return { tag, stagedAt, stats, ...state };
  }).sort((a, b) => String(b.stagedAt || '').localeCompare(String(a.stagedAt || '')));

  const limit = values_limit(args);
  const shown = limit ? entries.slice(0, limit) : entries;

  answer(out, ctx, { published: published || null, entries: shown },
    shown.length
      ? shown.map((e) => `${e.isLive ? '→ ' : '  '}${e.tag}  ${e.stats.live}/${e.stats.bound} live  `
        + `${e.stats.ok} ok/${e.stats.failed} failed  ${e.state || ''}`.trimEnd()).join('\n')
      : 'no tags: nothing staged, nothing published, nothing tainted');
  return undefined;
}

function values_limit(args) {
  const raw = args && args.values && args.values.limit;
  if (raw === undefined) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw usage(`--limit must be a positive integer, got ${raw}`);
  return n;
}

module.exports = {
  publish, taint, show, list,
  publishRefusal,
  'image publish': publish, 'image taint': taint, 'image show': show, 'image list': list,
};

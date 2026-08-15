'use strict';

// `archie fleet deploy` — the agent half of a release, end to end — and `archie fleet drift`.
// RUNTIME-CLI-REFERENCE.md §2.19 and §2.21; the flow tables that define the failure behaviour are
// §3.1 (staged release), §3.2 (hotfix) and §3.3 (rollback).
//
// THIS FILE COMPOSES. IT DECIDES NOTHING.
//
// Every step already exists as a command with its own rails, its own refusals and its own tests, and
// this file's only job is to run them in order and stop at the first one that says stop. That is not
// tidiness, it is the safety property: the composed path must never be able to end up with a WEAKER
// check than the hand-run sequence an operator would type. Two consequences, both load-bearing:
//
//   1. THE RELEASE GATE IS `releaseRefusal` FROM cmd/release.js, IMPORTED DIRECTLY AND NOT
//      INJECTABLE. It is a pure function of (generation item, binding rows, current pointer) exactly
//      so that the composed flow can ask it the same question `release set` asks (`cmd/release.js`
//      :242-256). A second gate written here would be a second opinion about whether an
//      unhealthchecked generation may go live, and the first time the two disagreed the composed
//      command would be the one that shipped it. There is no force flag anywhere in this path, and
//      `--hotfix` is not passed to the gate at all — it narrows COVERAGE, never VERIFICATION (§2.19).
//
//   2. THE POINTER IS NEVER MOVED ON AN INCOMPLETE STAGE. `generation stage` records stragglers as
//      per-unit failures WITHOUT throwing (`cmd/stage.js:958-962`) — the entry point turns a non-zero
//      failure count into exit 6. Composed, nobody is watching that count, so this file counts them
//      itself and stops BEFORE `release set`. Exit 6 out of `fleet deploy` therefore means exactly
//      what §2.19 says it means: staging incomplete, pointer not moved.
//
// WHY SUB-STEPS RUN WITH `json: true`. Each composed command answers either a structured object
// (--json) or a paragraph of text, and this file needs the object — the generation id comes out of
// `generation create`'s answer, and there is no way to read one out of a rendered paragraph. Their
// PROGRESS output is unaffected: progress, warnings and per-agent lines all go to stderr in both
// modes (`lib/output.js:9-13`), so the operator still watches the run happen. Only the sub-answer is
// captured, and this command renders its own.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const {
  CliError, EXIT, usage, refused, partial, drift: driftExit,
} = require('../lib/exit');
const { digestFor } = require('../lib/digest');
const generationCmd = require('./generation');
const stageCmd = require('./stage');
const releaseCmd = require('./release');
const runtimeCmd = require('./runtime');

const { readBody, readGeneration, scanBindings } = generationCmd;

// docker/ — the same root lib/digest.js resolves, and where slack-dispatcher/ lives.
const ROOT = path.resolve(__dirname, '..', '..');
const SPEC_BASELINE = path.join(ROOT, 'slack-dispatcher', 'spec-baseline.mjs');

// ── composition plumbing ─────────────────────────────────────────────────────────────────────────

/**
 * The composed steps, every one replaceable through `deps.steps` for the tests.
 *
 * `releaseRefusal` is deliberately ABSENT from this table. A gate that could be swapped out is a gate
 * with a bypass, and "there is no force flag" has to be true of the code, not only of the flags
 * (§5.1). It is called directly, from the one implementation `release set` uses.
 */
function stepsFor(deps = {}) {
  const s = deps.steps || {};
  return {
    build: s.build || generationCmd.build,
    create: s.create || generationCmd.create,
    stage: s.stage || stageCmd['generation stage'],
    releaseSet: s.releaseSet || releaseCmd.releaseSet,
    gc: s.gc || runtimeCmd.gcRuntimes,
  };
}

/**
 * An output that forwards everything to the real one but CAPTURES the answer.
 *
 * stdout carries the answer and only the answer (§1.4), so a composed run must emit exactly one —
 * its own. Everything a sub-step says on stderr still reaches the operator verbatim.
 *
 * `forwardFailures` exists for one caller: the post-release `runtime gc`. See the note there.
 */
function stepOutput(out, { forwardFailures = true } = {}) {
  const failures = [];
  let captured;
  return {
    startedAt: out.startedAt,
    answer(value) { captured = value; },
    progress(line) { out.progress(line); },
    verbose(line, level) { out.verbose(line, level); },
    warn(line) { out.warn(line); },
    failure(f) {
      failures.push({
        agent: (f && f.agent) || null,
        step: (f && f.step) || null,
        error: f && f.error ? String(f.error.message || f.error) : null,
      });
      if (forwardFailures) out.failure(f);
    },
    failureCount() { return failures.length; },
    error(e) { out.error(e); },
    taken() { return captured; },
    recorded() { return failures; },
  };
}

/**
 * Run one composed command and return `{ result, failures }`.
 *
 * A handler returns its result under --json and answers it under text mode (`bin/archie.js:150`), so
 * both channels are read and whichever produced a value wins.
 */
async function runStep(fn, ctx, args, out, deps = {}, opts = {}) {
  const child = stepOutput(out, opts);
  const returned = await fn({ ...ctx, json: true }, args, child, deps);
  return { result: returned === undefined ? child.taken() : returned, failures: child.recorded() };
}

/**
 * Write the answer: the object under --json, this command's own text otherwise. Same data either way
 * — the renderer never computes anything the object lacks.
 */
function publish(ctx, out, result, render) {
  out.answer(ctx.json ? result : render(result));
}

/**
 * The answer on a SUCCESSFUL return. Returning it lets `bin/archie.js` place it in the envelope; a
 * path that is about to THROW must call `publish()` instead, because a thrown handler never returns
 * and the report would be lost exactly when it is most wanted.
 */
function emit(ctx, out, result, render) {
  if (ctx.json) return result;
  out.answer(render(result));
  return undefined;
}

/** Everything after the last `:` of an image URI — the tag `generation create` recorded. */
const tagOf = (uri) => (typeof uri === 'string' && uri.includes(':') ? uri.slice(uri.lastIndexOf(':') + 1) : uri || null);

const namesOf = (failures) => [...new Set(failures.map((f) => f.agent).filter(Boolean))];

// ── fleet deploy ─────────────────────────────────────────────────────────────────────────────────

/**
 * `archie fleet deploy` — §2.19.
 *
 * `generation build` → `generation create` → `generation stage` → THE GATE → `release set` →
 * `runtime gc --keep`.
 *
 * ZERO DOWNTIME, and it is structural rather than careful: the new runtimes are created ALONGSIDE
 * the live ones under different names, staged and healthchecked while the old generation still
 * serves every turn, and the cutover is one pointer write (§2.19, §3.1). Nothing in this file stops
 * a single turn. The ~94-second outage belongs to the gateway, which this command does not touch —
 * `archie deploy` (cmd/deploy.js) is where the two halves meet.
 *
 * EXITS: 0 released · 4 a healthcheck failed → generation tainted, POINTER NOT MOVED · 6 staging
 * incomplete, POINTER NOT MOVED · 5 the flip was refused · 1/8 as the failing sub-step.
 */
async function fleetDeploy(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const steps = stepsFor(deps);
  const aws = deps.aws || stageCmd.clientsFor(ctx, deps);
  const hotfix = Boolean(values.hotfix);

  if (values.canary && !hotfix) {
    // Silently ignoring it would stage every agent in the fleet while the operator believed they staged one.
    throw usage('--canary is only meaningful with --hotfix', {
      detail: 'a full `fleet deploy` stages every agent; --hotfix is what narrows it to one canary (§2.19).',
    });
  }

  const plan = {
    generationId: null,
    image: null,
    imageTag: null,
    mode: hotfix ? 'hotfix' : 'staged',
    canary: null,
    build: null,
    create: null,
    stage: null,
    release: null,
    gc: null,
    gcFailures: [],
    dryRun: Boolean(ctx.dryRun),
  };

  // ── 1. the image ───────────────────────────────────────────────────────────────────────────────
  //
  // RESUME FIRST. `--generation <id>` naming an existing generation means "carry on with THAT
  // release" — the documented response to exit 6 and to a run that was interrupted after `create`
  // (§3.1 step 4, "re-run is the designed response"). Rebuilding and re-creating there would either
  // be a no-op or, if the tree has moved since, refuse with a spec collision on a generation that is
  // already half-staged. The image is the one the generation RECORDED; nothing re-derives it.
  const named = values.generation || null;
  const existing = named ? await readGeneration(aws, ctx, named) : null;

  if (existing) {
    const body = readBody(existing) || {};
    const recordedTag = body.imageTag || tagOf(body.image);
    if (values.tag && recordedTag && values.tag !== recordedTag) {
      throw refused(`generation ${named} was cut from image ${recordedTag}, but --tag says ${values.tag}`, {
        detail: 'a generation is never rewritten (cmd/generation.js:757-771). Drop --tag to resume this '
          + 'generation, or drop --generation to cut a new one from the tree.',
      });
    }
    plan.generationId = named;
    plan.image = body.image || null;
    plan.imageTag = recordedTag || null;
    out.progress(`step 1/6  resume      generation ${named} already exists (${plan.imageTag || 'no image tag'}) — not rebuilding`);
    out.progress('step 2/6  create      skipped — the generation is already written');
  } else if (values['skip-build']) {
    // The SAME derivation `generation build` would have used (lib/digest.js), so a `--skip-build`
    // run cannot name a different tag than the build it is skipping.
    plan.imageTag = values.tag || (deps.digestFor || digestFor)('agent').tag;
    out.progress(`step 1/6  build       skipped (--skip-build) — using tag ${plan.imageTag}`);
  } else {
    const built = await runStep(steps.build, ctx, {
      positionals: [],
      // --push always: an image nothing published is an image no generation can name, and `create`
      // refuses a tag absent from ECR (cmd/generation.js:806-810) — which would fail this run one
      // step later with a much worse message.
      values: { tag: values.tag, push: true, pure: values.pure },
    }, out, deps);
    plan.build = built.result || null;
    plan.imageTag = (plan.build && plan.build.tag) || values.tag || null;
    plan.image = (plan.build && plan.build.image) || null;
    out.progress(`step 1/6  image       ${plan.image || plan.imageTag}`
      + `${plan.build && plan.build.skipped ? '  (already in ECR — inputs unchanged)' : ''}`);
  }
  if (!plan.imageTag) {
    throw new CliError('could not determine the agent image tag for this deploy', {
      code: EXIT.FAILED,
      detail: '`generation build` reported no tag — re-run `archie generation build --push` on its own.',
    });
  }

  // ── 2. the generation ──────────────────────────────────────────────────────────────────────────
  if (!existing) {
    const created = await runStep(steps.create, ctx, {
      positionals: [],
      values: { image: plan.imageTag, id: named || undefined },
    }, out, deps);
    const body = created.result || {};
    plan.generationId = body.generationId || named || null;
    plan.image = body.image || plan.image;
    if (!plan.generationId) {
      throw new CliError('`generation create` reported no generation id', {
        code: EXIT.FAILED,
        detail: 'nothing has been staged and nothing is live — re-run `archie generation create --image '
          + `${plan.imageTag}\` on its own to see what it says.`,
      });
    }
    plan.create = body;
    out.progress(`step 2/6  generation  ${plan.generationId}`
      + `${body.unchanged ? '  (already existed with this exact spec)' : ''}`);
  }

  // ── 3. staging ─────────────────────────────────────────────────────────────────────────────────
  //
  // `--hotfix` stages ONE agent. It is the only thing hotfix changes about this command: the same
  // healthcheck with the same budget runs against that agent, the same taint rule applies, and the
  // same gate decides the flip. §3.2 is explicit that exit 4 here is the entire point of the control
  // limit, "the pressure to skip the check is highest exactly here".
  if (hotfix) {
    plan.canary = await resolveCanary(ctx, values, aws, deps, out);
    out.progress(`step 3/6  hotfix      staging ONE canary (${plan.canary}); the other agents provision on `
      + 'demand or via `archie fleet reconcile` (§3.2)');
  }

  const staged = await runStep(steps.stage, ctx, {
    positionals: [],
    values: {
      generation: plan.generationId,
      // Concurrency is passed through UNPARSED. The bound is EFS `CreateAccessPoint`, not AgentCore,
      // and `generation stage` owns both the clamp and the warning that says what over-running costs
      // (§5.3, cmd/stage.js:247-262). Re-deriving it here is how the two would drift.
      concurrency: values.concurrency,
      agents: hotfix ? plan.canary : undefined,
    },
  }, out, deps);
  plan.stage = staged.result || null;

  // A dry run has written nothing, so there is no generation to gate and no pointer to move. Saying
  // so beats evaluating a gate that would refuse for the one reason that is not a problem.
  if (ctx.dryRun) {
    out.progress('step 4/6  gate        not evaluated — a dry run wrote no generation and staged no agent');
    out.progress('step 5/6  release     not attempted (dry run)');
    out.progress('step 6/6  gc          not attempted (dry run)');
    return emit(ctx, out, plan, renderDeploy);
  }

  // THE STRAGGLER RAIL. Composed, nothing else is watching `out.failure()`.
  if (staged.failures.length) {
    publish(ctx, out, plan, renderDeploy);
    throw partial(`staging ${plan.generationId} left ${staged.failures.length} failure(s) — the pointer was NOT moved`, {
      detail: `${namesOf(staged.failures).slice(0, 20).join(', ') || 'see failures[]'}. Re-running is the `
        + 'designed response: staging is additive and skips agents that are already staged and healthy '
        + `(§3.1 step 4). \`archie fleet deploy --generation ${plan.generationId}\` resumes this one.`,
    });
  }
  // Coverage, from staging's OWN counts. Not a second health opinion — the health gate is below and
  // is `releaseRefusal`'s alone; this is §2.19's "refuses to flip on incomplete coverage", which the
  // gate cannot see (it asks whether the bindings that exist are healthy, not whether they are all
  // of them). Skipped under --hotfix, where partial coverage is the deliberate shape.
  if (!hotfix && plan.stage && plan.stage.agents && plan.stage.coverage < plan.stage.agents) {
    publish(ctx, out, plan, renderDeploy);
    throw partial(`only ${plan.stage.coverage} of ${plan.stage.agents} agent(s) are staged onto `
      + `${plan.generationId} — the pointer was NOT moved`, {
      detail: 'Flipping now would leave the unstaged agents cold-starting on their next message. Re-run '
        + `\`archie fleet deploy --generation ${plan.generationId}\`; it skips what is already done.`,
    });
  }

  // ── 4. the gate ────────────────────────────────────────────────────────────────────────────────
  //
  // The same function `release set` runs, on the same three reads, before the flip is attempted.
  // Running it here as well is not belt-and-braces: it turns "refused" into a stop that names the
  // reason before the release command's own output, and it means this file cannot be given a gate of
  // its own by a later edit — there is nowhere to put one.
  const [item, bindings, pointerItem] = await Promise.all([
    readGeneration(aws, ctx, plan.generationId),
    scanBindings(aws, ctx),
    releaseCmd.readPointerItem(aws, ctx),
  ]);
  const rows = bindings.filter((b) => b.generationId === plan.generationId);
  const refusal = releaseCmd.releaseRefusal({
    generationId: plan.generationId,
    item,
    rows,
    release: readBody(pointerItem),
    table: ctx.resources.configTable,
  });
  if (refusal) {
    out.progress(`step 4/6  gate        REFUSED — nothing was published, ${plan.generationId} is not live`);
    publish(ctx, out, plan, renderDeploy);
    throw refusal;
  }
  out.progress(`step 4/6  gate        passed — ${rows.length} binding(s), every healthcheck ok`);

  // ── 5. the flip ────────────────────────────────────────────────────────────────────────────────
  const released = await runStep(steps.releaseSet, ctx, {
    positionals: [plan.generationId],
    // `--hotfix` here is ATTRIBUTION (§2.13): it records `mode: 'hotfix'` on the pointer so the burst
    // of cold starts from the ~207 unstaged agents reads as intentional. It relaxes nothing.
    values: { hotfix },
  }, out, deps);
  plan.release = released.result || null;
  out.progress(`step 5/6  release     ${plan.generationId} is live (mode ${plan.mode})`);

  // ── 6. retention ───────────────────────────────────────────────────────────────────────────────
  //
  // THE RELEASE IS ALREADY DONE. §3.1 step 7 is explicit that a failed reap leaves the fleet "fully
  // released either way — failure costs quota, not availability", so gc's per-unit failures are NOT
  // forwarded into the envelope: a forwarded failure exits 6, and exit 6 out of THIS command means
  // "staging incomplete, pointer not moved" (§2.19). Reporting a completed release as a stage that
  // never flipped is the one lie the exit codes must not tell. They are still said out loud, named
  // per agent, and carried in the result — a thrown error (8 headroom, 1) propagates untouched,
  // because those do not claim anything about the pointer.
  const reaped = await runStep(steps.gc, ctx, {
    positionals: [],
    values: { keep: values.keep },
  }, out, deps, { forwardFailures: false });
  plan.gc = reaped.result || null;
  if (reaped.failures.length) {
    out.warn(`${reaped.failures.length} runtime(s) could not be reaped: ${namesOf(reaped.failures).join(', ')}. `
      + `${plan.generationId} IS LIVE — this costs quota, not availability (§3.1 step 7). Re-run `
      + '`archie runtime gc --keep 2 --no-dry-run`; at --keep 2 there is room to miss one GC, not two.');
    plan.gcFailures = reaped.failures;
  }
  out.progress(`step 6/6  gc          ${plan.gc && plan.gc.reaped ? plan.gc.reaped.length : 0} runtime(s) reaped`);

  return emit(ctx, out, plan, renderDeploy);
}

/**
 * Which agent carries the hotfix.
 *
 * `--canary` is validated against the routing roster by `enumerateAgents` — a typo'd name would
 * otherwise mint a role, an access point and a runtime for an identity that does not exist
 * (`cmd/stage.js:288-322`). Without one, the pick is the first agent in sorted order: deterministic,
 * so a re-run hotfixes the same agent rather than warming a second one, and stated out loud because
 * an operator may well want a different one.
 */
async function resolveCanary(ctx, values, aws, deps, out) {
  if (values.canary) {
    const { agents } = await stageCmd.enumerateAgents(aws, ctx, { agents: values.canary }, deps);
    return agents[0];
  }
  const { roster } = await stageCmd.enumerateAgents(aws, ctx, {}, deps);
  const pick = [...roster].sort()[0];
  out.progress(`canary      ${pick} (first in sorted order; --canary <agent> to choose another)`);
  return pick;
}

function renderDeploy(r) {
  const lines = [];
  lines.push(`generation  ${r.generationId || '—'}  (${r.mode})`);
  lines.push(`image       ${r.image || r.imageTag || '—'}`);
  if (r.canary) lines.push(`canary      ${r.canary}  — the other agents cold-start on first contact (§3.2)`);
  if (r.stage) {
    lines.push(r.dryRun
      ? `staged      would stage ${(r.stage.wouldStage || []).length}, skipping ${r.stage.skipped || 0} already staged`
      : `staged      ${r.stage.coverage}/${r.stage.agents}  health ok ${r.stage.healthOk} · failed ${r.stage.healthFailed}`);
  }
  lines.push(r.release ? `released    ${r.generationId} is live${r.release.unchanged ? ' (already was)' : ''}`
    : 'released    nothing (dry run)');
  if (r.gc) lines.push(`gc          reaped ${(r.gc.reaped || []).length}, kept ${(r.gc.kept || []).length}`);
  lines.push('downtime    none — new runtimes were built alongside the live ones and the cutover was one '
    + 'pointer write. The gateway is untouched by this command.');
  return lines.join('\n');
}

// ── fleet drift ──────────────────────────────────────────────────────────────────────────────────

/**
 * Run `spec-baseline.mjs` WITH A SCRUBBED ENVIRONMENT.
 *
 * The script's whole premise is that the dispatcher's environment comes from the DEPLOYED task
 * definition, not from the shell (`spec-baseline.mjs:16-17,32-44`) — but it applies that env with
 * `if (process.env[k] === undefined)`, so any variable the operator happens to export WINS over the
 * task definition and silently changes the derived spec. An exported `EFS_ROOT_PREFIX` or
 * `AGENT_CONFIG_TABLE` would make this command derive specs for a fleet nobody is running, and every
 * agent would report drift — or, worse, none would. Passing an allow-list is what makes §2.21's
 * "refuses to read the local shell's environment" true of the wrapper as well as of the script.
 *
 * Wiring (region, cluster, service) comes from `ctx.resources`, so one knob still derives every name
 * (`lib/context.js:12-16`). Credentials pass through because they are not configuration.
 */
const CREDENTIAL_KEYS = [
  'AWS_PROFILE', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI', 'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN', 'AWS_ROLE_ARN', 'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_SDK_LOAD_CONFIG', 'AWS_EC2_METADATA_DISABLED',
];

function baselineEnv(ctx, env = process.env) {
  const clean = { PATH: env.PATH, HOME: env.HOME };
  for (const key of CREDENTIAL_KEYS) if (env[key] !== undefined) clean[key] = env[key];
  if (ctx.profile) clean.AWS_PROFILE = ctx.profile;
  clean.AWS_REGION = ctx.region;
  clean.ARCHIE_CLUSTER = ctx.resources.cluster;
  clean.ARCHIE_SERVICE = ctx.resources.dispatcherService;
  return clean;
}

/**
 * Run the script and keep BOTH streams whatever the exit code.
 *
 * Deliberately not `cmd/gateway.js`'s runner: that one rejects on a non-zero exit and drops stdout,
 * and here a non-zero exit is DATA — `spec-baseline.mjs:141` exits 1 precisely when it found an
 * `efsRoot` change, having already written its report to stdout.
 */
function defaultRunNode(args, { env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (e) => reject(new CliError(`cannot run ${args[0]}: ${e.message}`, { cause: e })));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * The agent's legacy EFS root, from the item the dispatcher itself reads.
 *
 * THE BLIND SPOT THIS CLOSES. A §8.10-rekeyed agent (`dm-u01…`) carries `AGENT#<id>/META.efsRoot` =
 * its FORMER name, and the provisioning saga mounts THAT directory so the rekeyed agent keeps its
 * workspace, memory and sessions (`agentcore-client.js:621-630,862-868`). Derivation cannot know
 * that — `derivedSpecFor` always derives `efsRootDir(agent, prefix)` — so a comparison would report a
 * phantom `efsRoot` change for every rekeyed agent, and this command BLOCKS on `efsRoot` changes.
 * Left unhandled it would turn the loudest refusal in the CLI into a false alarm that operators learn
 * to route around, which is worse than not having it. `cmd/stage.js:516-529` does exactly this, for
 * exactly this reason, on the same item.
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
    // Best effort BY CONSTRUCTION, and the direction of the failure is the point: an unreadable META
    // means we cannot PROVE the difference is a legacy adopt, and an unproven `efsRoot` difference
    // stays data loss and stays blocking.
    return null;
  }
}

/** Does `root` look like the adopted legacy directory `<prefix>/<legacyName>`? */
const isLegacyAdopt = (root, legacy) => Boolean(root && legacy && String(root).endsWith(`/${legacy}`));

/**
 * Classify one comparison — PURE, so the rule that decides "roll" from "data loss" is testable with
 * no AWS and no subprocess. Mirrors `spec-baseline.mjs:121-142`: a changed NAME is a roll and is
 * accepted, a changed `efsRoot` is data loss and blocks.
 */
function classifyCompare(nowAgents, baseAgents) {
  const same = [];
  const rolled = [];
  const efsChanged = [];
  for (const [agent, now] of Object.entries(nowAgents || {})) {
    const before = (baseAgents || {})[agent];
    if (!before) continue;
    if (before.name === now.name) { same.push(agent); continue; }
    if (before.efsRoot !== now.efsRoot) efsChanged.push({ agent, before: before.efsRoot, now: now.efsRoot });
    else rolled.push({ agent, before: before.name, now: now.name });
  }
  return { same, rolled, efsChanged };
}

/**
 * `archie fleet drift [--fix] [--compare <baseline.json>]` — §2.21.
 *
 * WRAPS `slack-dispatcher/spec-baseline.mjs`, which is complete: it reads the deployed task
 * definition, applies it, drives the dispatcher's OWN `runtimeSpecFor` /`generationRuntimeName`, and
 * compares against a baseline file (`:121-142`) with the data-loss gate at `:128-134`. Reimplementing
 * any of that here would give two answers to the migration gate's one question (plan §12.4).
 *
 * EXITS: 0 no drift · 7 drift (a roll — accepted, fixable) · 5 an `efsRoot` change (DATA LOSS —
 * refused in every mode including `--fix`) · 1 the script failed.
 */
async function fleetDrift(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = deps.aws || stageCmd.clientsFor(ctx, deps);
  const run = deps.runNode || defaultRunNode;
  const readFile = deps.readFile || ((p) => fs.readFileSync(p, 'utf8'));

  const compare = values.compare || null;
  let baseline = null;
  if (compare) {
    try {
      baseline = JSON.parse(readFile(compare));
    } catch (e) {
      throw usage(`--compare ${compare} is not readable JSON`, { cause: e });
    }
  }

  const argv = [deps.script || SPEC_BASELINE, ...(compare ? ['--compare', compare] : [])];
  out.progress(`deriving    ${path.basename(argv[0])} against ${ctx.resources.cluster}/${ctx.resources.dispatcherService}`);
  const proc = await run(argv, { env: baselineEnv(ctx, deps.env || process.env), cwd: path.join(ROOT, 'slack-dispatcher') });
  // The script's stderr IS its report — task definition, fleet image, agent count, which derived
  // names are absent from AWS. It is progress, so it goes to stderr here too, never to stdout (§1.4).
  for (const line of String(proc.stderr || '').split('\n')) if (line.trim()) out.verbose(line);

  let derived;
  try {
    derived = JSON.parse(proc.stdout);
  } catch (e) {
    throw new CliError(`spec-baseline.mjs produced no readable report (exit ${proc.code})`, {
      code: EXIT.FAILED,
      cause: e,
      detail: String(proc.stderr || '').trim().split('\n').slice(-5).join(' | ')
        || 'no output at all — check credentials and --region.',
    });
  }

  const agents = derived.agents || {};
  const result = {
    compare,
    tdArn: derived.tdArn || null,
    fleetImage: derived.fleetImage || null,
    agents: Object.keys(agents).length,
    same: 0,
    rolled: [],
    missing: [],
    dataLoss: [],
    legacyAdopts: [],
    fixed: null,
    scriptExit: proc.code,
  };

  if (compare) {
    const { same, rolled, efsChanged } = classifyCompare(agents, baseline.agents);
    result.same = same.length;
    result.rolled = rolled;
    // THE §8.10 RE-CHECK, run only on the agents that actually disagreed about `efsRoot` — one
    // GetItem on an exceptional path, exactly as staging does it. Either side may hold the adopted
    // directory (the baseline was captured from a running fleet, the derivation names the scope key),
    // so proving it on either side proves the difference is the adopt and not a move.
    for (const change of efsChanged) {
      const legacy = await legacyEfsRootOf(aws, ctx, change.agent);
      if (legacy && (isLegacyAdopt(change.now, legacy) || isLegacyAdopt(change.before, legacy))) {
        result.legacyAdopts.push({ ...change, legacy });
        result.rolled.push({ agent: change.agent, before: (baseline.agents[change.agent] || {}).name, now: agents[change.agent].name });
      } else {
        result.dataLoss.push(change);
      }
    }
  } else {
    // No baseline: the comparison the script can still make is derived-name vs what is LIVE at AWS
    // (`spec-baseline.mjs:96-117`). An agent whose derived name is absent would provision on its next
    // turn — drift, and the thing `--fix` warms. `efsRoot` cannot be compared against anything here,
    // and this says so rather than reporting "no data loss" from a check it never ran.
    result.missing = Object.entries(agents).filter(([, v]) => !v.liveAtAws).map(([agent]) => agent);
  }

  for (const d of result.dataLoss) {
    out.warn(`EFS ROOT CHANGED  ${d.agent}: ${d.before} -> ${d.now} — that agent would boot on an EMPTY workspace`);
  }
  for (const a of result.legacyAdopts) {
    out.verbose(`${a.agent}: efsRoot differs but AGENT#${a.agent}/META.efsRoot = ${a.legacy} — a §8.10 legacy adopt, not drift`);
  }
  // The script exits 1 on ANY efsRoot difference, including the ones META has just explained. Saying
  // so out loud is the difference between a documented divergence and this wrapper looking wrong.
  if (proc.code !== 0 && !result.dataLoss.length && result.legacyAdopts.length) {
    out.progress(`spec-baseline.mjs exited ${proc.code} for ${result.legacyAdopts.length} efsRoot difference(s); `
      + 'every one is a §8.10 legacy adopt proven from the agent\'s own META — not data loss (§2.21).');
  }

  const drifted = [...result.rolled.map((r) => r.agent), ...result.missing];

  // DATA LOSS BLOCKS FIRST, before anything is written, in every mode. §2.21: "Refuses to apply an
  // efsRoot change, ever, in any mode including --fix."
  if (result.dataLoss.length) {
    publish(ctx, out, result, renderDrift);
    throw refused(`${result.dataLoss.length} agent(s) would change efsRoot — that is data loss, not a roll`, {
      detail: result.dataLoss.slice(0, 10).map((d) => `${d.agent}: ${d.before} -> ${d.now}`).join(' · ')
        + '. Agents would boot on an empty workspace. Nothing was staged and nothing was fixed.',
    });
  }

  if (values.fix && drifted.length) {
    // FIXING A ROLL IS STAGING. `generation stage` re-provisions those agents onto the active
    // generation, and it is also why `--fix` CANNOT apply an efsRoot change even if the gate above
    // were removed: staging never passes `efsRoot` to the saga — the client resolves the legacy root
    // from the agent's own META (`cmd/stage.js:611-614`), so a rekeyed agent keeps its directory.
    const active = readBody(await releaseCmd.readPointerItem(aws, ctx));
    if (!active || !active.generationId) {
      throw new CliError('--fix needs an active release pointer and there is none', {
        code: EXIT.FAILED,
        detail: 'With no pointer every turn already fails ImagePointerMissing (image-source.js:11-15). '
          + 'Publish a generation first: `archie fleet deploy`.',
      });
    }
    out.progress(`fixing      staging ${drifted.length} agent(s) onto the active generation ${active.generationId}`);
    const staged = await runStep(stepsFor(deps).stage, ctx, {
      positionals: [],
      values: { generation: active.generationId, agents: drifted.join(',') },
    }, out, deps);
    result.fixed = { generationId: active.generationId, agents: drifted, stage: staged.result || null };
    if (staged.failures.length) {
      publish(ctx, out, result, renderDrift);
      throw partial(`--fix staged ${drifted.length} agent(s) and ${staged.failures.length} failed`, {
        detail: `${namesOf(staged.failures).join(', ')} — re-run; staging is additive and skips healthy agents.`,
      });
    }
    return emit(ctx, out, result, renderDrift);
  }

  if (drifted.length) {
    publish(ctx, out, result, renderDrift);
    throw driftExit(`${drifted.length} agent(s) drift from the derived spec`, {
      detail: `${drifted.slice(0, 20).join(', ')}${drifted.length > 20 ? ` … and ${drifted.length - 20} more` : ''}`
        + ' — a changed runtime name is a roll and is safe to apply (`--fix`).',
    });
  }

  return emit(ctx, out, result, renderDrift);
}

function renderDrift(r) {
  const lines = [];
  lines.push(`task def    ${r.tdArn ? String(r.tdArn).split('/').pop() : '—'}`);
  lines.push(`fleet image ${r.fleetImage || '—'}`);
  lines.push(`agents      ${r.agents}`);
  if (r.compare) {
    lines.push(`identical   ${r.same}`);
    lines.push(`rolled      ${r.rolled.length}  (name only — accepted, this is a re-provision)`);
  } else {
    lines.push(`not live    ${r.missing.length}  (derived name absent at AWS — would provision on next turn)`);
    lines.push('efsRoot     not compared — pass --compare <baseline.json> to check for data loss');
  }
  if (r.legacyAdopts.length) lines.push(`legacy EFS  ${r.legacyAdopts.length}  (§8.10 rekey, proven from META — not drift)`);
  lines.push(`EFS ROOT    ${r.dataLoss.length}  ${r.dataLoss.length ? '<- BLOCKS: agents would boot on an empty workspace' : ''}`);
  for (const d of r.dataLoss.slice(0, 20)) lines.push(`            ${d.agent}: ${d.before} -> ${d.now}`);
  if (r.fixed) lines.push(`fixed       staged ${r.fixed.agents.length} agent(s) onto ${r.fixed.generationId}`);
  return lines.join('\n');
}

module.exports = {
  // THE FULL COMMAND KEYS, never bare verbs. `registry.load()` resolves `mod[key] || mod[verb]`, and
  // a verb-keyed export answers for every noun that shares the verb — the shape that would let
  // `archie access-point gc` run the runtime reaper (`lib/registry.js:156-166`).
  'fleet deploy': fleetDeploy,
  'fleet drift': fleetDrift,

  // Internals: for this file's tests and for `archie deploy` (cmd/deploy.js), which composes the
  // agent half through the same plumbing rather than re-running the steps itself.
  fleetDeploy,
  fleetDrift,
  stepsFor,
  stepOutput,
  runStep,
  resolveCanary,
  classifyCompare,
  baselineEnv,
  legacyEfsRootOf,
  isLegacyAdopt,
  defaultRunNode,
  SPEC_BASELINE,
};

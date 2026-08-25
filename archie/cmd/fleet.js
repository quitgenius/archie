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
//   1. THE GATE IS `publishRefusal` FROM cmd/image.js, IMPORTED DIRECTLY AND NOT INJECTABLE. It is a
//      pure function of (tag, ECR lookup, taint record, binding stats) exactly so that the composed
//      flow can ask it the same question `image publish` asks. A second gate written here would be a
//      second opinion about whether an unhealthchecked tag may go live, and the first time the two
//      disagreed the composed command would be the one that shipped it. There is no force flag
//      anywhere in this path, and `--hotfix` is not passed to the gate at all — it narrows COVERAGE,
//      never VERIFICATION (§2.19).
//
//   2. THE POINTER IS NEVER MOVED ON AN INCOMPLETE STAGE. `fleet stage` records stragglers as
//      per-unit failures WITHOUT throwing (`cmd/stage.js:958-962`) — the entry point turns a non-zero
//      failure count into exit 6. Composed, nobody is watching that count, so this file counts them
//      itself and stops BEFORE `image publish`. Exit 6 out of `fleet deploy` therefore means exactly
//      what §2.19 says it means: staging incomplete, pointer not moved.
//
// WHY SUB-STEPS RUN WITH `json: true`. Each composed command answers either a structured object
// (--json) or a paragraph of text, and this file needs the object — the image TAG comes out of
// `fleet build`'s answer, and there is no way to read one out of a rendered paragraph. Their
// PROGRESS output is unaffected: progress, warnings and per-agent lines all go to stderr in both
// modes (`lib/output.js:9-13`), so the operator still watches the run happen. Only the sub-answer is
// captured, and this command renders its own.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const {
  CliError, EXIT, usage, refused, partial, drift, drift: driftExit, preflight,
} = require('../lib/exit');
const {
  digestFor, tagFor, assertPure, dirtyWarning, ROOT: DIGEST_ROOT,
} = require('../lib/digest');
const imageCmd = require('./image');
const stageCmd = require('./stage');
const runtimeCmd = require('./runtime');

const { scanBindings, bindingStats, byTag } = require('../lib/bindings');
const { readFleetPointer, readTaint } = require('../lib/image-pointer');
const {
  clientsFor, resolveAccount, imageUriFor, dispatcherClientFor, derivedSpecFor, registryHostFor,
} = require('../lib/spec');
const { describeImage, assertArm64 } = require('../lib/ecr');
const { diffObserved } = require('../../archie-gateway/spec-diff');
const { adoptedRootFor, legacyEfsRootOf } = require('../lib/efs-root');
const { runtimeIdOf } = require('../../archie-gateway/runtime-registry');

// AgentCore microVMs are arm64. Not overridable — §2.6, Makefile:59-68.
const PLATFORM = 'linux/arm64';
const MAKE_TARGET = 'build-agentcore-pi';
// The build context, named ONCE because two places have to agree about it: `assertMakeConstraints`
// refuses a Makefile that stopped passing it, and the `building` progress line reports it. They
// disagreed until 2026-08-17 — the progress line still said `./clawdbot`, the pre-rename path
// (b85027f97) — and that is exactly the detail an operator trusts when a COPY fails and they are
// working out which tree the daemon was sent.
const BUILD_CONTEXT = './archie-runner';

/** The answer, shaped for the reader: an object under --json, a block otherwise. */
const answer = (out, ctx, obj, text) => out.answer(ctx.json ? obj : text);

// docker/ — the same root lib/digest.js resolves, and where archie-gateway/ lives.
const ROOT = path.resolve(__dirname, '..', '..');
const SPEC_BASELINE = path.join(ROOT, 'archie-gateway', 'spec-baseline.mjs');

// ── composition plumbing ─────────────────────────────────────────────────────────────────────────

/**
 * The composed steps, every one replaceable through `deps.steps` for the tests.
 *
 * `releaseRefusal` is deliberately ABSENT from this table. A gate that could be swapped out is a gate
 * with a bypass, and "there is no force flag" has to be true of the code, not only of the flags
 * (§5.1). It is called directly, from the one implementation `image publish` uses.
 */
function stepsFor(deps = {}) {
  const s = deps.steps || {};
  return {
    build: s.build || build,
    stage: s.stage || stageCmd['fleet stage'],
    publish: s.publish || imageCmd.publish,
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

/** Everything after the last `:` of an image URI — the tag `fleet build` recorded. */
const tagOf = (uri) => (typeof uri === 'string' && uri.includes(':') ? uri.slice(uri.lastIndexOf(':') + 1) : uri || null);

const namesOf = (failures) => [...new Set(failures.map((f) => f.agent).filter(Boolean))];

// ── fleet deploy ─────────────────────────────────────────────────────────────────────────────────

/**
 * `archie fleet deploy` — §2.19.
 *
 * `fleet build` → `fleet build` → `fleet stage` → THE GATE → `image publish` →
 * `runtime gc --keep`.
 *
 * ZERO DOWNTIME, and it is structural rather than careful: the new runtimes are created ALONGSIDE
 * the live ones under different names, staged and healthchecked while the old tag still
 * serves every turn, and the cutover is one pointer write (§2.19, §3.1). Nothing in this file stops
 * a single turn. The ~94-second outage belongs to the gateway, which this command does not touch —
 * `archie deploy` (cmd/deploy.js) is where the two halves meet.
 *
 * EXITS: 0 released · 4 a healthcheck failed → tag tainted, POINTER NOT MOVED · 6 staging
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

  // ── 0. retention, BEFORE anything is created ───────────────────────────────────────────────────
  //
  // GC RUNS FIRST, NOT LAST, and the reason is recovery rather than tidiness.
  //
  // Reaping after a release destroys rollback targets in the exact window where they are most likely
  // to be wanted — the minutes after shipping. And recovering a reaped runtime is not a re-run: a
  // re-stage issues CreateAgentRuntime under the same derived name, hits ConflictException because
  // AgentCore holds a deleted runtime's name for 3.5-10+ minutes, and falls into waitForRuntimeDeleted
  // (400 x 3s). Per agent, at a provisioning bound of 4-5, recovering a reaped fleet across the
  // fleet is measured in HOURS, not minutes.
  //
  // Running it before inverts that: the reap happens from a known-good state, against the tag
  // that is currently live, so the two most recent rollback targets are retained by construction and
  // nothing just-released is ever destroyed. It also front-loads quota reclamation for the 208-runtime
  // staging pass that follows, and leaves a FAILED deploy with a freshly-cleaned quota rather than a
  // dirty one.
  //
  // ARITHMETIC THIS CHANGES: the new runtimes arrive AFTER the reap, so `--keep N` rests at N+1
  // rollback targets. That is why the default is `--keep 1` (cmd/runtime.js): it yields the live
  // live tag plus two to roll back to — exactly what `--keep 2` yielded when the reap came last —
  // at a LOWER peak, 3 tags' worth (624 runtimes) rather than 4 (832), so the resting headroom is
  // 376 rather than 168.
  //
  // A reap failure must NEVER block the deploy: failing to reclaim quota is not a reason to refuse to
  // ship, and if headroom is genuinely insufficient `preflight` check 12 refuses a step later. That
  // ordering is deliberate — reclaim, then verify.
  if (!ctx.dryRun && !values['skip-gc']) {
    // PER-UNIT failures continue; a THROW does not. The distinction is whether the deploy can still
    // succeed. A runtime that would not reap costs quota, not availability, so it is warned and the
    // deploy proceeds. But a thrown gc is 8 (headroom) or 1 (an AWS failure) — and 8 in particular is
    // the signal that the 208-runtime staging pass about to start CANNOT fit. Swallowing it would
    // march into a doomed stage and fail later and messier. Nothing has been created at this point,
    // so propagating leaves the fleet exactly as it was: a clean stop, re-runnable.
    const pre = await runStep(steps.gc, ctx, { positionals: [], values: { keep: values.keep } },
      out, deps, { forwardFailures: false });
    plan.gc = pre.result || null;
    if (pre.failures.length) {
      plan.gcFailures = pre.failures;
      out.warn(`${pre.failures.length} runtime(s) could not be reaped: ${namesOf(pre.failures).join(', ')}. `
        + 'Continuing — this costs quota, not availability. Nothing has been created yet.');
    }
    out.progress(`step 0/5  gc          ${plan.gc && plan.gc.reaped ? plan.gc.reaped.length : 0} runtime(s) reaped before staging`);
  } else if (ctx.dryRun) {
    out.progress('step 0/5  gc          skipped (dry run)');
  }

  // NO RESUME FLAG. `--tag <id>` used to mean "carry on with THAT tag"; there is no
  // tag to carry on with, and nothing is lost — the tag is a content digest of the build's
  // own inputs, so re-running with an unchanged tree derives the SAME tag, finds it in ECR, skips
  // the build, and stages additively over what is already staged. Resuming is what running it again
  // does. `--tag` still pins an explicit one, for CI and for rebuilding a historical image.
  if (values['skip-build']) {
    // The SAME derivation `fleet build` would have used (lib/digest.js), so a `--skip-build`
    // run cannot name a different tag than the build it is skipping.
    plan.imageTag = values.tag || (deps.digestFor || digestFor)('agent').tag;
    out.progress(`step 1/5  build       skipped (--skip-build) — using tag ${plan.imageTag}`);
  } else {
    // THE BUILD HAPPENS HERE, not in a command the operator has to run first. `steps.build` IS
    // `fleet build`, so a derived tag absent from ECR is BUILT AND PUSHED rather than refused — the
    // same rule cmd/gateway.js:39-43 states for the other half, for the same reason: absent means this
    // tree has never been published, so there is exactly one image it could want.
    //
    // --push always: staging refuses a tag absent from ECR, which would fail this run one step later
    // with a much worse message.
    const built = await runStep(steps.build, ctx, {
      positionals: [],
      values: { tag: values.tag, push: true, pure: values.pure },
    }, out, deps);
    plan.build = built.result || null;
    plan.imageTag = (plan.build && plan.build.tag) || values.tag || null;
    plan.image = (plan.build && plan.build.image) || null;
    out.progress(`step 1/5  image       ${plan.image || plan.imageTag}`
      + `${plan.build && plan.build.skipped ? '  (already in ECR — inputs unchanged)' : ''}`);
    // A DRY RUN BUILDS NOTHING, so an unpublished tree cannot be planned all the way through: `fleet
    // stage` checks ECR unconditionally (cmd/stage.js:812-818) and stops at exit 1 two steps below.
    // Said here, where the reason is still in view, rather than left to arrive as "no image <tag>"
    // against a content tag the operator has never seen before.
    if (ctx.dryRun && plan.build && plan.build.dryRun) {
      out.warn(`${plan.imageTag} is not in ECR and a dry run builds nothing, so staging will stop at `
        + '"no image" below. `archie fleet build --push` publishes it; a real run of THIS command '
        + 'builds it in step 1.');
    }
  }
  // THE FALLBACK, for a build that produced no tag at all — a genuinely unbuildable state, not merely
  // an unpublished one. The unpublished case never reaches here; it was built above.
  if (!plan.imageTag) {
    throw new CliError('could not determine the agent image tag for this deploy', {
      code: EXIT.FAILED,
      detail: '`fleet build` reported no tag — re-run `archie fleet build --push` on its own.',
    });
  }

  // ── 3. staging ─────────────────────────────────────────────────────────────────────────────────
  //
  // `--hotfix` stages ONE agent. It is the only thing hotfix changes about this command: the same
  // healthcheck with the same budget runs against that agent, the same taint rule applies, and the
  // same gate decides the flip. §3.2 is explicit that exit 4 here is the entire point of the control
  // limit, "the pressure to skip the check is highest exactly here".
  if (hotfix) {
    plan.canary = await resolveCanary(ctx, values, aws, deps, out);
    out.progress(`step 3/5  hotfix      staging ONE canary (${plan.canary}); the other agents provision on `
      + 'demand or via `archie fleet reconcile` (§3.2)');
  }

  const staged = await runStep(steps.stage, ctx, {
    positionals: [],
    values: {
      tag: plan.imageTag,
      // Concurrency is passed through UNPARSED. The bound is EFS `CreateAccessPoint`, not AgentCore,
      // and `fleet stage` owns both the clamp and the warning that says what over-running costs
      // (§5.3, cmd/stage.js:247-262). Re-deriving it here is how the two would drift.
      concurrency: values.concurrency,
      agents: hotfix ? plan.canary : undefined,
    },
  }, out, deps);
  plan.stage = staged.result || null;

  // A dry run has written nothing, so there is nothing to gate and no pointer to move. Saying
  // so beats evaluating a gate that would refuse for the one reason that is not a problem.
  if (ctx.dryRun) {
    out.progress('step 4/5  gate        not evaluated — a dry run wrote no generation and staged no agent');
    out.progress('step 5/6  release     not attempted (dry run)');
    return emit(ctx, out, plan, renderDeploy);
  }

  // THE STRAGGLER RAIL. Composed, nothing else is watching `out.failure()`.
  if (staged.failures.length) {
    publish(ctx, out, plan, renderDeploy);
    throw partial(`staging ${plan.imageTag} left ${staged.failures.length} failure(s) — the pointer was NOT moved`, {
      detail: `${namesOf(staged.failures).slice(0, 20).join(', ') || 'see failures[]'}. Re-running is the `
        + 'designed response: staging is additive and skips agents that are already staged and healthy '
        + `(§3.1 step 4). \`archie fleet deploy --tag ${plan.imageTag}\` resumes this one.`,
    });
  }
  // Coverage, from staging's OWN counts. Not a second health opinion — the health gate is below and
  // is `releaseRefusal`'s alone; this is §2.19's "refuses to flip on incomplete coverage", which the
  // gate cannot see (it asks whether the bindings that exist are healthy, not whether they are all
  // of them). Skipped under --hotfix, where partial coverage is the deliberate shape.
  if (!hotfix && plan.stage && plan.stage.agents && plan.stage.coverage < plan.stage.agents) {
    publish(ctx, out, plan, renderDeploy);
    throw partial(`only ${plan.stage.coverage} of ${plan.stage.agents} agent(s) are staged onto `
      + `${plan.imageTag} — the pointer was NOT moved`, {
      detail: 'Flipping now would leave the unstaged agents cold-starting on their next message. Re-run '
        + `\`archie fleet deploy --tag ${plan.imageTag}\`; it skips what is already done.`,
    });
  }

  // ── 4. the gate ────────────────────────────────────────────────────────────────────────────────
  //
  // The same function `image publish` runs, on the same three reads, before the flip is attempted.
  // Running it here as well is not belt-and-braces: it turns "refused" into a stop that names the
  // reason before the release command's own output, and it means this file cannot be given a gate of
  // its own by a later edit — there is nowhere to put one.
  const account = await resolveAccount(ctx, aws);
  const [found, taint, bindings] = await Promise.all([
    describeImage(aws, { account, repo: ctx.resources.agentRepo, tag: plan.imageTag }),
    readTaint(aws.doc(), require('@aws-sdk/lib-dynamodb'), ctx.resources.configTable, plan.imageTag),
    scanBindings(aws, ctx),
  ]);
  const rows = byTag(bindings).get(plan.imageTag) || [];
  // THE AGENT COUNT the bypass turns on, from the roster staging ALREADY enumerated rather than a
  // second query — `plan.stage.agents` is `agents.length` at cmd/stage.js:943. Re-reading the routing
  // GSI here would let the gate and the thing it is gating disagree about how many agents exist.
  const fleetAgents = plan.stage && typeof plan.stage.agents === 'number' ? plan.stage.agents : null;
  const refusal = imageCmd.publishRefusal({
    tag: plan.imageTag,
    found,
    taint,
    stats: bindingStats(rows),
    imageUri: imageUriFor(ctx, account, plan.imageTag),
    fleetAgents,
  });
  if (refusal) {
    out.progress(`step 3/4  gate        REFUSED — nothing was published, ${plan.imageTag} is not live`);
    publish(ctx, out, plan, renderDeploy);
    throw refusal;
  }
  if (fleetAgents === 0) {
    plan.healthcheckSkipped = true;
    out.warn(imageCmd.emptyFleetWarning(plan.imageTag, ctx.resources.configTable));
    out.progress(`step 4/5  gate        SKIPPED — no agents to stage or healthcheck; publishing ${plan.imageTag} unverified`);
  } else {
    out.progress(`step 4/5  gate        passed — ${rows.length} binding(s), every healthcheck ok`);
  }

  // ── 5. the flip ────────────────────────────────────────────────────────────────────────────────
  const released = await runStep(steps.publish, ctx, {
    positionals: [plan.imageTag],
    // `--hotfix` here is ATTRIBUTION (§2.13): it records `mode: 'hotfix'` on the pointer so the burst
    // of cold starts from the ~207 unstaged agents reads as intentional. It relaxes nothing.
    values: { hotfix },
  }, out, deps);
  plan.release = released.result || null;
  out.progress(`step 4/4  publish     ${plan.imageTag} is live`);


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
  // AN EMPTY ROSTER IS STILL FATAL HERE, unlike in a full stage. `enumerateAgents` stopped throwing on
  // one so an empty deployment can publish (cmd/stage.js), but `--hotfix` means "stage exactly one
  // agent and healthcheck it" — with no agents there is nothing to canary, and the sort below would
  // pick `undefined` and stage a runtime for an identity that does not exist. Refuse instead: a hotfix
  // with nothing to fix is a mistake about which deployment this is, not a releasable state.
  if (!roster.length) {
    throw preflight(`--hotfix needs an agent to canary, and ${ctx.resources.configTable} has none`, {
      detail: 'either --name points at the wrong deployment (one knob derives every resource name, '
        + 'lib/context.js) or the config has never been hydrated (`archie config hydrate`). Without '
        + '--hotfix this deploy stages nothing and publishes unverified, which IS supported.',
    });
  }
  const pick = [...roster].sort()[0];
  out.progress(`canary      ${pick} (first in sorted order; --canary <agent> to choose another)`);
  return pick;
}

function renderDeploy(r) {
  const lines = [];
  lines.push(`tag         ${r.imageTag || '—'}${r.mode === 'hotfix' ? '  (hotfix)' : ''}`);
  lines.push(`image       ${r.image || r.imageTag || '—'}`);
  if (r.canary) lines.push(`canary      ${r.canary}  — the other agents cold-start on first contact (§3.2)`);
  if (r.stage) {
    lines.push(r.dryRun
      ? `staged      would stage ${(r.stage.wouldStage || []).length}, skipping ${r.stage.skipped || 0} already staged`
      : `staged      ${r.stage.coverage}/${r.stage.agents}  health ok ${r.stage.healthOk} · failed ${r.stage.healthFailed}`);
  }
  lines.push(r.release ? `published   ${r.imageTag} is live${r.release.unchanged ? ' (already was)' : ''}`
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
 * WRAPS `archie-gateway/spec-baseline.mjs`, which is complete: it reads the deployed task
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
  const proc = await run(argv, { env: baselineEnv(ctx, deps.env || process.env), cwd: path.join(ROOT, 'archie-gateway') });
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
    // FIXING A ROLL IS STAGING. `fleet stage` re-provisions those agents onto the active
    // tag, and it is also why `--fix` CANNOT apply an efsRoot change even if the gate above
    // were removed: staging never passes `efsRoot` to the saga — the client resolves the legacy root
    // from the agent's own META (`cmd/stage.js:611-614`), so a rekeyed agent keeps its directory.
    const active = await readFleetPointer(aws.doc(), require('@aws-sdk/lib-dynamodb'), ctx.resources.configTable);
    if (!active || !active.tag) {
      throw new CliError('--fix needs an active image pointer and there is none', {
        code: EXIT.FAILED,
        detail: 'With no pointer every turn already fails ImagePointerMissing (image-source.js:11-15). '
          + 'Publish a generation first: `archie fleet deploy`.',
      });
    }
    out.progress(`fixing      staging ${drifted.length} agent(s) onto the live tag ${active.tag}`);
    const staged = await runStep(stepsFor(deps).stage, ctx, {
      positionals: [],
      values: { tag: active.tag, agents: drifted.join(',') },
    }, out, deps);
    result.fixed = { tag: active.tag, agents: drifted, stage: staged.result || null };
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
  if (r.fixed) lines.push(`fixed       staged ${r.fixed.agents.length} agent(s) onto ${r.fixed.tag}`);
  return lines.join('\n');
}


// ═══════════════════════════════════════════════════════════════════════════════════════════════════
// BUILD AND VERIFY — moved here from cmd/tag.js when the tag noun was removed.
//
// They were never about tags. `build` produces an arm64 image and a content-addressed tag;
// `verify` asserts that what is RUNNING matches what this deployment derives. Both are fleet-level
// operations that only ever borrowed the noun.
//
// One change of substance in the move, in `verify`: it used to compare observed state against the
// spec a tag had STORED, and it now compares against the spec this deployment DERIVES. The
// old form could only tell you whether a runtime matched what someone once wrote down; this one
// tells you whether it matches what the fleet would provision today, which is the question an
// operator is actually asking when they run it.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════

// ── subprocess ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run a command, or hand back what a test injected.
 *
 * Build output goes to STDERR (fd 2), never stdout: stdout carries the answer and only the answer
 * (output.js:5-8), and `archie tag build --json | jq` must survive a docker build.
 */
function runnerFor(deps = {}) {
  if (deps.run) return deps.run;
  return (cmd, argv, { cwd = ROOT, input = null, capture = false } = {}) => {
    try {
      return execFileSync(cmd, argv, {
        cwd,
        encoding: 'utf8',
        input: input === null ? undefined : input,
        stdio: input !== null ? ['pipe', 'pipe', 'pipe'] : (capture ? ['ignore', 'pipe', 'pipe'] : ['ignore', 2, 2]),
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      // execFileSync's message line 1 is always the useless one; the captured stderr is the only thing
      // that separates "wrong region" from "unpublished image" (agent-image.js:52-56). exit.js keeps
      // the cause, output.error prints it.
      throw new CliError(`${cmd} ${argv[0] || ''} failed`.trim(), { code: EXIT.FAILED, cause: e });
    }
  };
}

// ── the Makefile's three constraints ─────────────────────────────────────────────────────────────

/** The recipe lines of a make target, with line continuations joined. */
function makeRecipe(text, target) {
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.startsWith(`${target}:`));
  if (start < 0) return null;
  const recipe = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    if (l.startsWith('\t')) { recipe.push(l.slice(1)); continue; }
    if (l.trim() === '' || l.startsWith('#')) continue;
    break;
  }
  return recipe.join('\n').replace(/\s*\\\n\s*/g, ' ');
}

/**
 * Assert the build we are about to shell out to still applies all three constraints, and report the
 * local image name it produces.
 *
 * WHY CHECK RATHER THAN TRUST. §2.6 says the command "applies and does not let you override" three
 * things, and shelling out to `make` delegates them. If the target ever loses `--build-context
 * lintroot=.`, the build does not silently skip the lint gate — it fails on the first
 * `COPY --from=lintroot` (Makefile:267-270) — but if it lost `--platform=linux/arm64` it would build
 * a perfectly good amd64 image that no microVM can run, and if it stopped honouring
 * `$(AGENTCORE_PI_TAG)` our tag override would be silently ignored and we would push, and record,
 * a tag naming content it does not contain. Refusing here costs one file read.
 */
function assertMakeConstraints(text) {
  const recipe = makeRecipe(text, MAKE_TARGET);
  if (!recipe) {
    throw refused(`Makefile has no \`${MAKE_TARGET}\` target`,
      { detail: 'the agent image build lives there (Makefile:271-276) — archie will not invent a docker command for it' });
  }
  const required = [
    [`--platform=${PLATFORM}`, 'AgentCore microVMs are arm64 (Makefile:59-68)'],
    ['--build-context lintroot=.', 'the lint gate\'s first `COPY --from=lintroot` fails without it (Makefile:267-270)'],
    ['-f ./archie-runner/agentcore-pi/Dockerfile', 'the Dockerfile must be named explicitly, since the context is its parent'],
    [BUILD_CONTEXT, `the build context is ${BUILD_CONTEXT}, NOT agentcore-pi/ — the Dockerfile COPYs sibling plugin-sdk/ and connector-session-plugin/`],
    ['$(AGENTCORE_PI_TAG)', 'archie passes the tag as a make override; a hard-coded tag would silently ignore it'],
  ];
  for (const [needle, why] of required) {
    if (!recipe.includes(needle)) {
      throw refused(`Makefile \`${MAKE_TARGET}\` no longer passes \`${needle}\``, { detail: why });
    }
  }
  const local = recipe.match(/-t\s+(\S+):\$\(AGENTCORE_PI_TAG\)/);
  if (!local) throw refused(`cannot tell what local image \`${MAKE_TARGET}\` produces`, { detail: 'expected `-t <name>:$(AGENTCORE_PI_TAG)`' });
  return { recipe, localImage: local[1] };
}

// ── tag items ─────────────────────────────────────────────────────────────────────────────

/**
 * Canonical form + digest of a fleet spec.
 *
 * `canonicalize` is the dispatcher's own (agentcore-client.js:183-192) and is NOT reimplemented here:
 * it sorts object keys and sorts arrays of primitives, because the fields hashed are SETS, and "an
 * unsorted hash would change whenever AWS returned the same values in a different order, minting a
 * new runtime on a turn where nothing actually changed (a provision per message, plus an access-point
 * and role leak)" (:180-183).
 *
 * The digest is sha1 of the canonical JSON, as plan §3 specifies, truncated to 16 hex — the same
 * construction `imageFingerprint` uses (:197-200) at twice the width. Wider on purpose: that
 * fingerprint distinguishes the handful of specs ONE agent runs, this one is a fleet-wide, permanent
 * identifier that also serves as the default tag.
 */


// ── fleet build ───────────────────────────────────────────────────────────────────────────

/**
 * `archie fleet build [--tag <tag>] [--push] [--pure]` — the arm64 Pi runtime image, §2.6.
 *
 * NO DEPLOYMENT EFFECT. The fleet's image is chosen by a tag, so a push alone changes nothing
 * (Makefile:64-67). That is what makes the derived tag safe: same content, same tag, tag already in
 * ECR, skip the build and the push.
 *
 * THIS FUNCTION IS ALSO STEP 1 OF `fleet deploy` (`stepsFor`), and it is the only place the make
 * command is constructed. One implementation is what stops the two entry points deriving different
 * tags, wording the dirty-tree warning differently, or disagreeing about whether an image is already
 * published — the same argument cmd/gateway.js:39-43 makes for its own build being called from its own
 * deploy.
 *
 * IT ARRIVED HERE FROM cmd/tag.js WITH THE TAG NOUN (see the banner above) AND THE MOVE DROPPED ITS
 * EXPORT KEY. `archie fleet build` answered "declared but cmd/fleet.js exports no \"build\"" for as
 * long as it took someone to be told to run it — and it is the command every absent-image message
 * names (cmd/stage.js:816, cmd/image.js:115), so the only way through a first release of a tree was
 * `make` by hand with a content tag copied out of a dry run. The registry-wiring test now ENUMERATES
 * this module's commands instead of listing two of them, because a hand-written list is what let that
 * hide.
 */
async function build(ctx, args, out, deps = {}) {
  // THE GENERATED BASELINE, BEFORE THE DIGEST IS TAKEN. baseline.generated.mjs is derived from
  // docker/policy/semantics.json and gitignored, so it may be absent (fresh clone) or stale (policy edited
  // since the last build). It SHIPS and it is a declared digest input, so generating it after the tag was
  // computed would give an image whose contents do not match its tag — the one property the derived-tag
  // design exists to guarantee. Idempotent, so this costs nothing when it is already current.
  require('../lib/policy-codegen').ensure();

  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);
  const run = runnerFor(deps);
  const root = deps.root || ROOT;

  if (values.platform && values.platform !== PLATFORM) {
    throw refused(`--platform ${values.platform}: the agent image is ${PLATFORM} and that is not overridable`,
      { detail: 'AgentCore microVMs are arm64; an amd64 agent image cannot run at all (Makefile:59-68)' });
  }
  if (values.tag === 'latest') {
    throw refused('refusing to build the agent image as `latest`',
      { detail: 'the runtime image is chosen by a generation, and a floating tag would imply otherwise (Makefile:280-282)' });
  }

  // `--pure` is not a `fleet build` flag — it belongs to the composed `archie deploy` (§2.27),
  // which calls straight into this function. Honouring it here rather than there keeps one wording
  // and one refusal for both entry points.
  if (values.pure) assertPure('agent', { root });
  else {
    const warning = dirtyWarning('agent', { root });
    if (warning) out.warn(warning);
  }

  // The tag: pinned, or derived from the image's own declared inputs (lib/digest.js). `agent` is the
  // AGENT image's key in that IMAGES map, and the two images' input sets differ on purpose — that is
  // what lets an agent-only change roll 208 runtimes without touching the gateway (digest.js:19-24).
  const pinned = Boolean(values.tag);
  const digest = pinned ? null : digestFor('agent', { root });
  const tag = values.tag || tagFor(digest.digest);
  if (!pinned) out.verbose(`agent digest ${digest.digest} over ${digest.fileCount} declared inputs -> ${tag}`);

  const account = await resolveAccount(ctx, aws);
  const uri = imageUriFor(ctx, account, tag);
  const repo = ctx.resources.agentRepo;

  // Shared by every answer below, so `--json` reports the same fields whichever path ran — and the
  // same fields `gateway build` reports, because an operator reads both halves of one release.
  const base = {
    image: uri,
    tag,
    derived: !pinned,
    platform: PLATFORM,
    repository: repo,
    account,
    inputDigest: digest ? digest.digest : null,
    inputFiles: digest ? digest.fileCount : null,
  };

  const found = await describeImage(aws, { account, repo, tag });
  if (found) {
    // The repo is IMMUTABLE (modules/archie/ecr.tf:57-61) precisely so "a rollback would return what
    // it claimed to". A DERIVED tag that is already present is proof the content is already there —
    // skip. A PINNED tag is a name someone chose, and the local tree may be anything at all, so
    // pushing over it is refused rather than skipped: the push would fail at the registry, and if it
    // ever did not, every tag naming that tag would start lying.
    if (pinned && values.push) {
      throw refused(`${repo}:${tag} already exists in ECR and the repository is immutable`,
        { detail: 'a rollback target must return what it claimed to — cut a new tag, or drop --tag and let the digest name it' });
    }
    // THE SKIP, and it is why the tags are derived rather than typed: same content, same tag, tag
    // already published, so a re-run of `archie deploy` costs no build, no push and no provisioning
    // pass at all (§2.27, digest.js:6-10).
    out.progress(`skipped     ${uri} is already in ECR (${found.digest || 'no digest'}) — inputs unchanged`);
    const skipped = { ...base, built: false, pushed: false, skipped: true, ecr: found };
    answer(out, ctx, skipped, renderBuild(skipped));
    return undefined;
  }

  const { localImage } = assertMakeConstraints(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'));
  const makeArgs = ['-C', root, MAKE_TARGET, `AGENTCORE_PI_TAG=${tag}`];

  if (ctx.dryRun) {
    out.progress(`would run: make ${makeArgs.join(' ')}`);
    if (values.push) out.progress(`would push: ${uri}`);
    const planned = { ...base, built: false, pushed: false, skipped: false, dryRun: true };
    answer(out, ctx, planned, renderBuild(planned));
    return undefined;
  }

  out.progress(`building    ${localImage}:${tag} (${PLATFORM}, context ${BUILD_CONTEXT}, lintroot=.)`);
  run('make', makeArgs, { cwd: root });

  let pushed = false;
  if (values.push) {
    // The push is the CLI's, not the Makefile's. `make push-agentcore-pi` used to exist and is now
    // DELETED: it hard-coded the registry, account and profile as sandbox literals, while every
    // resource name this CLI touches must come from `--name`/`--region`/the caller's account
    // (context.js:12-16) — so it could only ever push to one place. The BUILD stays in the Makefile,
    // because that is where the three build constraints (arm64, context, lintroot) live.
    const host = registryHostFor(account, ctx.region);
    const { GetAuthorizationTokenCommand } = require('@aws-sdk/client-ecr');
    const auth = await aws.ecr().send(new GetAuthorizationTokenCommand({}));
    const token = auth && auth.authorizationData && auth.authorizationData[0] && auth.authorizationData[0].authorizationToken;
    if (!token) throw new CliError('ECR GetAuthorizationToken returned no token', { code: EXIT.FAILED });
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    run('docker', ['login', '--username', 'AWS', '--password-stdin', host], { input: decoded.slice(decoded.indexOf(':') + 1) });
    run('docker', ['tag', `${localImage}:${tag}`, uri]);
    out.progress(`pushing     ${uri}`);
    run('docker', ['push', uri]);
    pushed = true;
  }

  const result = { ...base, built: true, pushed, skipped: false };
  answer(out, ctx, result, renderBuild(result));
  return undefined;
}

/**
 * The summary, deliberately the same shape as `gateway build`'s (cmd/gateway.js:421-431) — one release
 * has two halves and an operator reads both, so "already in ECR — build and push skipped" must not be
 * two different sentences depending on which image it was.
 *
 * THE `next` LINE HAS TO NAME A COMMAND THAT EXISTS. It said `archie generation create --image <tag>`
 * until b74b61445 removed generations, so the summary of a successful build pointed at a command whose
 * only remaining answer is that there is nothing for it to do (§2.7).
 */
function renderBuild(r) {
  const lines = [];
  lines.push(`tag         ${r.tag}${r.derived ? '  (derived from declared inputs)' : '  (--tag)'}`);
  if (r.inputDigest) lines.push(`inputs      ${r.inputFiles} files, sha256 ${r.inputDigest.slice(0, 16)}…`);
  lines.push(`image       ${r.image}`);
  if (r.ecr && r.ecr.digest) lines.push(`digest      ${r.ecr.digest}`);
  lines.push(`platform    ${r.platform}  (not overridable — AgentCore microVMs are arm64)`);
  let state = `${r.built ? 'built' : 'not built'}, ${r.pushed ? 'pushed' : 'not pushed'}`;
  if (r.skipped) state = 'already in ECR — build and push skipped';
  else if (r.dryRun) state = 'nothing built, nothing pushed (dry run)';
  lines.push(`state       ${state}`);
  lines.push(`next        archie fleet stage --tag ${r.tag}, or \`archie fleet deploy\` for the whole half`);
  lines.push('note        an image in ECR has NO deployment effect until `archie image publish` moves '
    + 'the fleet onto its tag');
  return lines.join('\n');
}

// ── tag create ────────────────────────────────────────────────────────────────────────────



// ── fleet verify ──────────────────────────────────────────────────────────────────────────

/**
 * Assert every bound runtime IS what this deployment derives — §2.10. Read-only. Exit 7 on mismatch.
 *
 * DERIVED vs OBSERVED, not declared vs observed. It used to diff against the spec a tag had
 * STORED, which could only ever tell you whether a runtime matched what someone once wrote down.
 * Deriving from the deployment answers the question an operator is actually asking — "is this fleet
 * running what it would provision today?" — and it cannot go stale, because there is nothing stored
 * to go stale.
 *
 * The bug it
 * catches is real: the image was once dropped on the way to `CreateAgentRuntime`, so a runtime named
 * for one tag ran another — "a roll that looks completely successful in list-agent-runtimes
 * and changes nothing. Only get-agent-runtime's containerUri showed it" (agentcore-client.js:421-425).
 *
 * The read-back and the diff are both the dispatcher's own (`observedSpecOf` :476 / `specFromGet`
 * :487, `diffObserved` spec-diff.js:26,39), so the two sides are shaped by the same code that shapes
 * them at provision time — `efsAccessPoint` dropped from both sides (or every roll shows a phantom
 * change) and, when the access point can no longer be read, `efsRoot` dropped from BOTH sides,
 * because "absent is unknown, not 'changed to undefined'" (spec-diff.js:17-24).
 */
async function verify(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);

  const published = await readFleetPointer(aws.doc(), require('@aws-sdk/lib-dynamodb'), ctx.resources.configTable);
  const tag = values.tag || values.generation || (published && published.tag);
  if (!tag) throw usage('--tag <tag> is required (nothing is published to default to)');

  const bindings = (await scanBindings(aws, ctx))
    .filter((b) => b.tag === tag)
    .filter((b) => !values.agent || b.agent === values.agent)
    .sort((a, b) => (a.agent < b.agent ? -1 : 1));

  if (!bindings.length) {
    throw new CliError(`${tag} has no bindings${values.agent ? ` for ${values.agent}` : ''}`,
      { code: EXIT.FAILED, detail: 'nothing to verify — stage it first' });
  }

  const account = await resolveAccount(ctx, aws);
  const client = dispatcherClientFor(ctx, account, deps);
  const imageUri = imageUriFor(ctx, account, tag);

  const results = [];
  const mismatched = [];
  const unreadable = [];
  for (const b of bindings) {
    const runtimeId = runtimeIdOf(b);
    if (!b.arn || !runtimeId) {
      // A reaped row is history, not a mismatch: it makes no claim about a live runtime
      // (runtime-registry.js:30-37). Reporting it as drift would make every post-gc verify fail.
      results.push({ agent: b.agent, runtimeName: b.runtimeName, skipped: 'reaped' });
      out.verbose(`${b.agent}: reaped — nothing running to verify`);
      continue;
    }
    const declared = derivedSpecFor(client, b.agent, imageUri);
    let observed;
    try {
      observed = await client.observedSpecOf(runtimeId);
    } catch (e) {
      unreadable.push({ agent: b.agent, error: String((e && e.message) || e) });
      results.push({ agent: b.agent, runtimeName: b.runtimeName, error: String((e && e.message) || e) });
      out.warn(`${b.agent}: GetAgentRuntime failed — ${(e && e.message) || e}`);
      continue;
    }
    // TWO SENTINELS, and getting either wrong inverts the result:
    //   'initial'              — `diffObserved` was handed nothing to compare. Never a match.
    //   'fingerprint-algorithm' — every field agreed. specDiff returns this rather than an empty
    //                             array because its usual caller only diffs when the runtime NAME
    //                             already changed, so "no field differs" means the hash algorithm
    //                             moved (spec-diff.js:52-56). Verify's callers are the opposite case:
    //                             here it is precisely what a clean verify looks like.
    let changes = diffObserved(observed, declared).filter((c) => c !== 'fingerprint-algorithm');

    // §8.10 LEGACY ADOPT — without this, verify exits 7 for the WHOLE FLEET.
    //
    // `derivedSpecFor` always derives `efsRootDir(agent, prefix)`, but a rekeyed agent legitimately
    // ADOPTS its old directory rather than moving data, so its observed root can never equal the
    // derived one. cmd/stage.js proved that at staging time and recorded `legacyEfsRoot` on the
    // binding; cmd/fleet.js applies the same rule to `fleet drift`. This is the third caller, and it
    // was the one missing it — the rule now lives in lib/efs-root.js so the three cannot disagree.
    //
    // Only an efsRoot-ONLY difference is eligible. If anything else also differs, the runtime is
    // genuinely wrong and an adopted root does not excuse it.
    let adopted = null;
    if (changes.length === 1 && changes[0] === 'efsRoot') {
      adopted = await adoptedRootFor(aws, ctx, b.agent, b, [observed && observed.efsRoot, declared.efsRoot]);
      if (adopted) {
        changes = [];
        out.verbose(`${b.agent}: efsRoot differs but ${adopted} is this agent's adopted legacy root — not drift`);
      }
    }

    const ok = changes.length === 0;
    results.push({
      agent: b.agent, runtimeName: b.runtimeName, ok, changes,
      observedImage: observed && observed.image,
      ...(adopted ? { legacyEfsRoot: adopted } : {}),
    });
    if (ok) out.verbose(`${b.agent}: ok`);
    else {
      mismatched.push({ agent: b.agent, changes });
      out.progress(`${b.agent}: MISMATCH ${changes.join(', ')}`);
    }
  }

  const checked = results.filter((r) => r.ok !== undefined).length;
  answer(out, ctx,
    { tag, checked, mismatched: mismatched.length, unreadable: unreadable.length, results },
    [
      `tag ${tag}  ${checked - mismatched.length}/${checked} runtimes match the spec this deployment derives`,
      ...mismatched.map((m) => `  MISMATCH  ${m.agent}  ${m.changes.join(', ')}`),
      ...unreadable.map((u) => `  UNREADABLE ${u.agent}  ${u.error}`),
    ].join('\n'));

  // NOT out.failure(): a recorded per-unit failure exits 6 (PARTIAL, "re-run me"), and a runtime
  // running the wrong image is not a straggler — §2.10 fixes drift at 7 and a read failure at 1.
  if (mismatched.length) {
    throw drift(`${mismatched.length} runtime(s) do not match ${tag}`,
      { detail: mismatched.map((m) => `${m.agent}: ${m.changes.join(', ')}`).join(' · ') });
  }
  if (unreadable.length) {
    throw new CliError(`could not read ${unreadable.length} runtime(s)`,
      { code: EXIT.FAILED, detail: unreadable.map((u) => u.agent).join(', ') });
  }
  return undefined;
}


module.exports = {
  // THE FULL COMMAND KEYS, never bare verbs. `registry.load()` resolves `mod[key] || mod[verb]`, and
  // a verb-keyed export answers for every noun that shares the verb — the shape that would let
  // `archie access-point gc` run the runtime reaper (`lib/registry.js:156-166`).
  'fleet deploy': fleetDeploy,
  'fleet drift': fleetDrift,
  // `build` and `verify` came here from cmd/tag.js with the tag noun and their KEYS did not come with
  // them, so both commands were declared in lib/registry.js and dead at the entry point — the registry
  // answered "declared but cmd/fleet.js exports no …". Under their full keys ONLY, deliberately: a bare
  // `build` would also satisfy `load()`'s verb fallback, which is what made the omission invisible to a
  // test that asserted the command loads. The wiring test enumerates every command whose module is
  // 'fleet', so this object is now the one place that can be wrong, and it fails loudly when it is.
  'fleet build': build,
  'fleet verify': verify,

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

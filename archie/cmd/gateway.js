'use strict';

// `archie gateway build | deploy | status` — the ECS half of a release.
// RUNTIME-CLI-REFERENCE.md §2.3, §2.4, §2.5; the gap it reports is §6.1.
//
// THE ONE THING TO KNOW BEFORE READING ANY OF THIS:
//
// `gateway deploy` is a STOP-THEN-START WITH REAL DOWNTIME, and cannot be anything else.
// `aws_ecs_service.dispatcher` pins desired_count = 1, deployment_minimum_healthy_percent = 0,
// deployment_maximum_percent = 100 (dispatcher.tf:216-233) because "two tasks would open two Slack
// Socket Mode connections, and Slack load-balances events across connections for the same app — so
// events would be handled non-deterministically, sometimes twice. It would also break the cron
// store's sole-writer invariant and per-session turn serialisation."
//
// So a wait for "a new healthy task while the old one is still running" — which is what
// `aws ecs wait services-stable` and every rolling-deploy helper is built around — WAITS FOREVER,
// because that state never occurs. This file waits for three transitions in order instead:
// runningCount -> 0, runningCount -> 1 on the NEW task definition, then the container healthcheck
// (GET /health, dispatcher.tf:196-202, handler slack-dispatcher/index.js:1840) reporting HEALTHY.
// The healthcheck has a 30s startPeriod (dispatcher.tf:204-210), which is part of why the measured
// gap on the archie-0.2.22 rollout was 94 SECONDS — 20:12:53 to 20:14:27 (§6.1). The command prints
// that number from its own observations rather than claiming the Terraform comment's "a few
// seconds", and there is deliberately NO automatic rollback on a failed healthcheck: that would be a
// second uninstrumented ~94s outage stacked on the first. ECS holds the failed deployment; the
// operator decides.
//
// TAGS ARE DERIVED, NOT TYPED (plan §5, reference §2.27). Without --tag, the tag is a content digest
// of this image's declared COPY inputs (../lib/digest.js). If that tag is already in ECR the build
// AND the push are skipped entirely — which is what makes `archie deploy` idempotent, and what stops
// a no-op release from costing 94 seconds of dropped Slack messages.

const { spawn } = require('node:child_process');
const {
  DescribeRepositoriesCommand, DescribeImagesCommand, GetAuthorizationTokenCommand,
} = require('@aws-sdk/client-ecr');
const {
  DescribeServicesCommand, DescribeTaskDefinitionCommand, RegisterTaskDefinitionCommand,
  UpdateServiceCommand, ListTasksCommand, DescribeTasksCommand,
} = require('@aws-sdk/client-ecs');
const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');

const { CliError, EXIT, usage, preflight, refused, drift, timeout } = require('../lib/exit');
const { makeClient } = require('../lib/aws');
const { IMAGES, ROOT, digestFor, assertPure, dirtyWarning } = require('../lib/digest');

// §2.4: "Budget for stopped -> started -> healthcheck passing. Sized against ~2 minutes plus margin."
const DEFAULT_WAIT_SECONDS = 300;
const POLL_INTERVAL_MS = 5000;

// Fargate runs the dispatcher on X86_64 (no runtime_platform override in dispatcher.tf, so the ECS
// default applies) and the Makefile's target is --platform=linux/amd64 (Makefile:297-301). Anything
// else builds an image the task cannot execute — it fails at task start, INSIDE the downtime window.
const DEFAULT_PLATFORM = 'linux/amd64';

// ── clients ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Clients, built through lib/aws.js so region and credential handling cannot drift between
 * commands — and so `--profile` is exercised by exactly one implementation rather than three.
 *
 * Injected clients WIN. Every test in this file supplies its own, which is what keeps the suite
 * free of AWS credentials; nothing below is constructed when a fake is passed. Each command asks
 * only for what it uses, so `gateway status` never builds an ECR or STS client it will not call.
 *
 * Region is never defaulted here: context.js already refused the command without --region.
 */
const client = {
  ecr: (ctx, deps) => deps.ecr || makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient'),
  ecs: (ctx, deps) => deps.ecs || makeClient(ctx, '@aws-sdk/client-ecs', 'ECSClient'),
  sts: (ctx, deps) => deps.sts || makeClient(ctx, '@aws-sdk/client-sts', 'STSClient'),
};

// ── subprocess ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run a subprocess, KEEPING ITS STDERR.
 *
 * `execFileSync`'s `e.message` line 1 is always the useless one ("Command failed: docker push …")
 * and discarding the rest "is what made a region mismatch look identical to an unpublished image"
 * (agent-image.js:52-56). Every line of both streams is offered to `onLine` (so -v streams a docker
 * build live) and the tail is retained so a failure at verbosity 0 still names its cause.
 *
 * Injectable: tests must not require Docker.
 */
const TAIL_LINES = 40;

function defaultRun(command, args, { cwd = ROOT, input = null, onLine = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const tail = [];
    let stdout = '';
    let stderr = '';

    const consume = (stream, sink) => {
      let buffered = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk) => {
        sink(chunk);
        buffered += chunk;
        const lines = buffered.split('\n');
        buffered = lines.pop();
        for (const line of lines) {
          if (onLine) onLine(line);
          tail.push(line);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      });
    };
    consume(child.stdout, (c) => { stdout += c; });
    consume(child.stderr, (c) => { stderr += c; });

    child.on('error', (e) => {
      // ENOENT here means docker (or whatever) is not installed. Saying so beats "spawn docker
      // ENOENT" arriving with no indication of which binary the CLI wanted.
      reject(new CliError(`cannot run \`${command}\`: ${e.message}`, { cause: e }));
    });
    child.on('close', (code) => {
      if (code === 0) { resolve({ stdout, stderr }); return; }
      const e = new Error(`\`${command} ${args.join(' ')}\` exited ${code}`);
      e.stderr = tail.join('\n');
      e.exitStatus = code;
      reject(e);
    });

    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
  });
}

// ── shared helpers ───────────────────────────────────────────────────────────────────────────────

/** HH:MM:SS UTC, the stamp the §2.4 transcript prints against each transition. */
const at = (ms) => new Date(ms).toISOString().slice(11, 19);

const arnTail = (arn) => String(arn || '').split('/').pop();

/**
 * Emit the answer.
 *
 * --json gets the structured object (bin/archie.js buffers it into the envelope); a human gets
 * aligned text. Same data either way — the renderer never computes anything the object lacks.
 */
function emit(ctx, out, result, render) {
  if (ctx.json) return result;
  out.answer(render(result));
  return undefined;
}

/**
 * The gateway ECR repository, from `ctx.resources` — never a literal.
 *
 * Preflight check 5 (ecr.tf:13). An absent repo must fail as "this repository is missing" rather
 * than as a bare RepositoryNotFoundException with no repository name (context.js:29-31).
 * `registryId` is returned because it is the account that must match `docker login` — auth is per
 * region AND per account (Makefile:125-128) and a mismatch reads like a missing repository.
 */
async function describeRepo(ecr, ctx) {
  const repositoryName = ctx.resources.gatewayRepo;
  try {
    const res = await ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    const repo = (res.repositories || [])[0];
    if (!repo) throw preflight(`ECR repository ${repositoryName} not found in ${ctx.region}`);
    return {
      repositoryName,
      repositoryUri: repo.repositoryUri,
      registryId: repo.registryId,
      // Stated in the result because it is the reason a second push of the same tag is refused.
      immutable: repo.imageTagMutability === 'IMMUTABLE',
    };
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw preflight(`ECR repository ${repositoryName} is not readable in ${ctx.region}`, {
      cause: e,
      detail: 'archie preflight check 5 (ecr.tf:13). Wrong region or wrong account looks exactly like this.',
    });
  }
}

/** The image if the tag exists, else null. ImageNotFoundException is the answer "no", not an error. */
async function findImage(ecr, repositoryName, tag) {
  try {
    const res = await ecr.send(new DescribeImagesCommand({
      repositoryName, imageIds: [{ imageTag: tag }],
    }));
    const image = (res.imageDetails || [])[0];
    return image ? { digest: image.imageDigest, pushedAt: image.imagePushedAt, sizeBytes: image.imageSizeInBytes } : null;
  } catch (e) {
    if (e && (e.name === 'ImageNotFoundException' || e.Code === 'ImageNotFoundException')) return null;
    throw new CliError(`cannot read ${repositoryName}:${tag} from ECR`, { cause: e });
  }
}

/**
 * Preflight check 1: the caller is in the account they said they were.
 *
 * Only asserted when --account is given; the value it protects is stated at dispatcher.tf:76-82 —
 * a dispatcher pointed at the wrong account "provisions runtimes onto ANOTHER STACK's file system
 * and security group, reads its secrets, and its generation GC can delete that stack's runtimes".
 */
async function callerAccount(sts, ctx) {
  let account;
  try {
    ({ Account: account } = await sts.send(new GetCallerIdentityCommand({})));
  } catch (e) {
    throw preflight('cannot resolve the caller identity (GetCallerIdentity failed)', { cause: e });
  }
  if (ctx.account && account !== ctx.account) {
    throw preflight(`caller is in account ${account}, but --account says ${ctx.account}`);
  }
  return account;
}

/**
 * Resolve the tag for this run.
 *
 * `--tag` pins one; without it the tag is derived from the image's declared inputs. The purity gate
 * runs HERE, before anything is built, because that is what §2.27 promises: `--pure` is a refusal
 * (exit 5) listing the modified files, not a warning after a two-minute build.
 */
function resolveTag(ctx, args, out, { gate = true } = {}) {
  const explicit = args.values.tag;
  if (explicit) {
    // `latest` is refused outright. The repo is IMMUTABLE (ecr.tf:17) so a floating tag cannot even
    // be moved, and a name that implies "current" over content that is frozen is the exact trap
    // agent-image.js:52-72 records — "same tag, different images, from trees several commits apart".
    if (explicit === 'latest') {
      throw refused('refusing to build or deploy the tag `latest`', {
        detail: 'The gateway repo is IMMUTABLE (ecr.tf:17): a floating tag cannot be moved, and a '
          + 'name implying "current" over frozen content is how a stale image answers to a fresh name.',
      });
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(explicit)) {
      throw usage(`--tag "${explicit}" is not a valid ECR tag ([a-zA-Z0-9._-], <=128 chars)`);
    }
    return { tag: explicit, derived: false, digest: null, fileCount: null };
  }

  if (gate) purityGate(ctx, args, out);
  const d = digestFor('gateway');
  out.verbose(`digest      ${d.digest} over ${d.fileCount} declared inputs -> ${d.tag}`);
  return { tag: d.tag, derived: true, digest: d.digest, fileCount: d.fileCount };
}

/**
 * `--pure` refuses on a dirty tree; the default warns and carries on.
 *
 * Dirty trees are the normal development case and need no flag — the digest already covers
 * working-tree content, so the artifact is never mislabelled (§2.27). Both the refusal and the
 * wording of the warning live in digest.js so the gateway and the agent cannot word them
 * differently.
 */
function purityGate(ctx, args, out) {
  if (args.values.pure) { assertPure('gateway'); return; }
  const warning = dirtyWarning('gateway');
  if (warning) out.warn(warning);
}

// ── gateway build ────────────────────────────────────────────────────────────────────────────────

/**
 * `archie gateway build [--tag <tag>] [--push] [--platform <p>]` — §2.3.
 *
 * NO DEPLOYMENT EFFECT. A pushed gateway image changes nothing until `gateway deploy` registers a
 * task definition on it.
 */
async function build(ctx, args, out, deps = {}) {
  const ecr = client.ecr(ctx, deps);
  const sts = client.sts(ctx, deps);
  const run = deps.run || defaultRun;
  const platform = args.values.platform || DEFAULT_PLATFORM;

  const { tag, derived, digest, fileCount } = resolveTag(ctx, args, out);
  const repo = await describeRepo(ecr, ctx);
  const account = await callerAccount(sts, ctx);
  const image = `${repo.repositoryUri}:${tag}`;

  if (platform !== DEFAULT_PLATFORM) {
    out.warn(`--platform ${platform}: the dispatcher task definition is X86_64 (no runtime_platform `
      + `override in dispatcher.tf), so anything but ${DEFAULT_PLATFORM} fails at task start — inside `
      + 'the downtime window, not here.');
  }

  const existing = await findImage(ecr, repo.repositoryName, tag);

  // THE SKIP. Same content, same tag, tag already in ECR: build and push are skipped, and the
  // repo being IMMUTABLE stops being an obstacle and becomes the mechanism (§2.27). This is why
  // `archie deploy` twice with no edits does nothing at all — including no gateway outage.
  if (existing && derived) {
    out.progress(`skipped     ${image} is already in ECR (${existing.digest}) — inputs unchanged`);
    return emit(ctx, out, {
      tag, derived, image, repository: repo.repositoryName, registry: repo.repositoryUri,
      account, platform, built: false, pushed: false, skipped: true,
      imageDigest: existing.digest, inputDigest: digest, inputFiles: fileCount,
    }, renderBuild);
  }

  // An EXPLICIT tag is a stated intent to publish that exact tag, so an existing one is a refusal
  // rather than a skip — checked FIRST so the failure names the cause (ecr.tf:17) instead of
  // surfacing mid-layer-upload as an opaque immutability error.
  if (existing && args.values.push) {
    throw refused(`${repo.repositoryName}:${tag} already exists — the repository is IMMUTABLE (ecr.tf:17)`, {
      detail: `pushed ${existing.pushedAt ? new Date(existing.pushedAt).toISOString() : 'previously'} `
        + `as ${existing.digest}. Drop --tag to derive a content tag, or pick another tag.`,
    });
  }

  // An explicit tag builds from the working tree, so the same gate applies — just later, because a
  // tag that already exists never reaches a build at all.
  if (!derived) purityGate(ctx, args, out);

  // The Dockerfile and the build context come from digest.js's IMAGES declaration, NOT from a
  // literal here: the digest is computed over the inputs that declaration names, so a build from a
  // different context would tag content the digest never hashed.
  //
  // Context is docker/, NOT docker/slack-dispatcher/ (Makefile:297-301), because the Dockerfile
  // COPYs clawdbot/config-seed, clawdbot/agentcore-pi/workspace-seed.mjs and files from
  // clawdbot/config-resolver/ (slack-dispatcher/Dockerfile:70-74). A narrower context fails on
  // those COPY lines.
  const spec = IMAGES.gateway;
  const buildArgs = [
    'build', `--platform=${platform}`, '--pull',
    // The local tag the Makefile produces, kept so `docker images` reads the same either way, plus
    // the registry tag so no separate `docker tag` step can be forgotten.
    '-t', `archie-gateway:${tag}`,
    '-t', image,
    '-f', `./${spec.dockerfile}`,
    spec.context,
  ];

  if (ctx.dryRun) {
    out.progress(`would build docker ${buildArgs.join(' ')}   (cwd ${ROOT})`);
    if (args.values.push) out.progress(`would push  ${image}`);
    return emit(ctx, out, {
      tag, derived, image, repository: repo.repositoryName, registry: repo.repositoryUri,
      account, platform, built: false, pushed: false, skipped: false,
      imageDigest: null, inputDigest: digest, inputFiles: fileCount,
    }, renderBuild);
  }

  out.progress(`building    ${image}  (platform ${platform}, context ${ROOT}/${spec.context})`);
  out.progress('            docker build output streams at -v; this takes minutes on a cold cache');
  await run('docker', buildArgs, { cwd: ROOT, onLine: (l) => out.verbose(l) })
    .catch((e) => { throw new CliError(`docker build failed for ${image}`, { cause: e }); });
  out.progress(`built       archie-gateway:${tag}`);

  if (!args.values.push) {
    out.progress('not pushed  (--push to publish; a build alone has no deployment effect)');
    return emit(ctx, out, {
      tag, derived, image, repository: repo.repositoryName, registry: repo.repositoryUri,
      account, platform, built: true, pushed: false, skipped: false,
      imageDigest: null, inputDigest: digest, inputFiles: fileCount,
    }, renderBuild);
  }

  await dockerLogin({ ecr, run, out, repo, account, ctx });
  await run('docker', ['push', image], { cwd: ROOT, onLine: (l) => out.verbose(l) })
    .catch((e) => { throw new CliError(`docker push failed for ${image}`, { cause: e }); });
  const pushed = await findImage(ecr, repo.repositoryName, tag);
  out.progress(`pushed      ${image}${pushed ? `  (${pushed.digest})` : ''}`);

  return emit(ctx, out, {
    tag, derived, image, repository: repo.repositoryName, registry: repo.repositoryUri,
    account, platform, built: true, pushed: true, skipped: false,
    imageDigest: pushed ? pushed.digest : null, inputDigest: digest, inputFiles: fileCount,
  }, renderBuild);
}

/**
 * `docker login`, per region AND per account (Makefile:125-128).
 *
 * The registry host comes from the repository's own URI, so region and account agree with the repo
 * we are about to push to by construction. The cross-check below catches the remaining case — a
 * repo owned by another account, whose auth token this caller can never mint — because that failure
 * otherwise surfaces as an authorization error that reads exactly like a missing repository.
 */
async function dockerLogin({ ecr, run, out, repo, account, ctx }) {
  const host = String(repo.repositoryUri).split('/')[0];
  if (repo.registryId && repo.registryId !== account) {
    throw refused(`${repo.repositoryName} is owned by account ${repo.registryId}, but the caller is ${account}`, {
      detail: '`docker login` is per-region AND per-account (Makefile:125-128); a token minted here '
        + 'cannot push there, and the error would read like a missing repository.',
    });
  }
  const auth = await ecr.send(new GetAuthorizationTokenCommand({}));
  const data = (auth.authorizationData || [])[0];
  if (!data || !data.authorizationToken) {
    throw new CliError(`ECR returned no authorization token for ${ctx.region}`);
  }
  const proxyHost = String(data.proxyEndpoint || '').replace(/^https?:\/\//, '');
  if (proxyHost && proxyHost !== host) {
    throw refused(`ECR authorized ${proxyHost} but the repository is at ${host}`, {
      detail: 'auth is per-region and per-account; pushing with a token for another registry fails '
        + 'as an authorization error that reads like a missing repository.',
    });
  }
  const password = Buffer.from(data.authorizationToken, 'base64').toString('utf8').replace(/^AWS:/, '');
  out.verbose(`docker login ${host} (account ${account}, region ${ctx.region})`);
  await run('docker', ['login', '--username', 'AWS', '--password-stdin', host], {
    cwd: ROOT, input: password, onLine: (l) => out.verbose(l),
  }).catch((e) => { throw new CliError(`docker login failed for ${host}`, { cause: e }); });
}

function renderBuild(r) {
  const lines = [];
  lines.push(`tag         ${r.tag}${r.derived ? '  (derived from declared inputs)' : '  (--tag)'}`);
  if (r.inputDigest) lines.push(`inputs      ${r.inputFiles} files, sha256 ${r.inputDigest.slice(0, 16)}…`);
  lines.push(`image       ${r.image}`);
  if (r.imageDigest) lines.push(`digest      ${r.imageDigest}`);
  lines.push(`state       ${r.skipped ? 'already in ECR — build and push skipped'
    : `${r.built ? 'built' : 'not built'}, ${r.pushed ? 'pushed' : 'not pushed'}`}`);
  lines.push('note        a pushed image has NO deployment effect until `archie gateway deploy`');
  return lines.join('\n');
}

// ── the deployed task definition, and check 16 ───────────────────────────────────────────────────

/**
 * The service, its task definition and that task definition's environment.
 *
 * Preflight check 15 (dispatcher.tf:1,216). Every read here is of the DEPLOYED task definition —
 * this module never reads process.env for any of it (spec-baseline.mjs:16-17,32-44): what a
 * terminal exports is irrelevant to what the dispatcher is running, and conflating them is how
 * shadow config survives.
 */
async function readDeployed(ecs, ctx) {
  const cluster = ctx.resources.cluster;
  const service = ctx.resources.dispatcherService;

  let described;
  try {
    described = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
  } catch (e) {
    if (e && e.name === 'ClusterNotFoundException') {
      throw preflight(`ECS cluster ${cluster} not found in ${ctx.region}`, {
        cause: e, detail: 'preflight check 15 (dispatcher.tf:1). Wrong --name, wrong --region, or not deployed.',
      });
    }
    throw new CliError(`DescribeServices failed for ${cluster}/${service}`, { cause: e });
  }
  const svc = (described.services || []).find((s) => s.status !== 'INACTIVE') || (described.services || [])[0];
  if (!svc) {
    throw preflight(`ECS service ${service} not found in cluster ${cluster}`, {
      detail: 'preflight check 15 (dispatcher.tf:216).',
    });
  }

  const td = await ecs.send(new DescribeTaskDefinitionCommand({
    taskDefinition: svc.taskDefinition, include: ['TAGS'],
  }));
  // Same container selection as spec-baseline.mjs:37-38, for the same reason: the container is
  // named `dispatcher` today, and falling back to [0] keeps this readable against a rename.
  const containers = td.taskDefinition.containerDefinitions || [];
  const container = containers.find((c) => /dispatcher|archie/i.test(c.name)) || containers[0];
  const env = {};
  for (const e of container.environment || []) env[e.name] = e.value;

  return {
    cluster, service, svc,
    taskDefinition: td.taskDefinition,
    taskDefinitionTags: td.tags || [],
    container,
    env,
    // Secret NAMES only — the values are resolved by the task at boot and never travel here.
    secrets: (container.secrets || []).map((s) => s.name),
  };
}

/**
 * Preflight check 16 / `gateway status --check`: does the DEPLOYED environment agree with --name?
 *
 * The §10 shadow-config trap, and the dashboard deployer's only check with teeth
 * (deploy-dashboard.cjs:230). One comparator serves both callers so a value that blocks a deploy and
 * a value that reports drift can never be two different lists.
 *
 * AN ABSENT VARIABLE COUNTS AS DISAGREEMENT, unlike deploy-dashboard.cjs's `env[k] &&` filter. Every
 * one of these has a fallback in agentcore-client.js and every fallback is a literal from an operator's
 * sandbox (dispatcher.tf:73-79) — so "unset" does not mean "unopinionated", it means "pointed at
 * account 052 by default", which is the precise failure check 16 exists to catch.
 */
function checkEnvAgainstName(ctx, env) {
  const r = ctx.resources;
  const expected = {
    AGENT_CONFIG_TABLE: r.configTable,
    DISPATCHER_LOG_GROUP: r.dispatcherLogGroup,
    DISPATCHER_SERVICE_NAME: r.dispatcherService,
    DISPATCHER_METRIC_NAMESPACE: r.dispatcherNamespace,
    CRON_METRIC_NAMESPACE: r.cronNamespace,
  };
  const mismatches = [];
  const absent = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = env[key];
    if (got === undefined) { absent.push({ key, expected: want }); continue; }
    if (got !== want) mismatches.push({ key, expected: want, deployed: got });
  }
  // Region is not name-derived, so it never fails --check (§2.5 scopes the assertion to --name), but
  // a task running in another region than the one being addressed is worth saying out loud.
  const regionKeys = ['AWS_REGION', 'AGENTCORE_REGION'];
  const regionMismatches = regionKeys
    .filter((k) => env[k] && env[k] !== ctx.region)
    .map((k) => ({ key: k, expected: ctx.region, deployed: env[k] }));

  return { expected, mismatches, absent, regionMismatches, ok: mismatches.length === 0 && absent.length === 0 };
}

// ── gateway deploy ───────────────────────────────────────────────────────────────────────────────

/**
 * `archie gateway deploy [--tag <tag>] [--wait-timeout <s>] [--no-wait]` — §2.4.
 *
 * TERRAFORM OWNS aws_ecs_task_definition.dispatcher (dispatcher.tf:149) AND aws_ecs_service
 * .dispatcher (dispatcher.tf:216), with no `ignore_changes` on task_definition. This command
 * registers a new revision FROM THE CURRENT ONE with only the image swapped, then points the
 * service at it — so the out-of-band revision differs from Terraform's by exactly one string, and
 * `archie gateway status` shows which one is live. It then tells the operator the tfvars value that
 * makes the next `terraform apply` agree. See the note at the follow-up warning below: this is a
 * deliberate, stated tension, not an oversight.
 */
async function deploy(ctx, args, out, deps = {}) {
  const ecr = client.ecr(ctx, deps);
  const ecs = client.ecs(ctx, deps);
  const sts = client.sts(ctx, deps);
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); }));

  // The tag names an image that must ALREADY be in ECR, so nothing is built here and the purity
  // gate does not apply — the digest is used only to name the artifact this tree corresponds to.
  const { tag, derived } = resolveTag(ctx, args, out, { gate: false });
  const repo = await describeRepo(ecr, ctx);
  await callerAccount(sts, ctx);
  const image = `${repo.repositoryUri}:${tag}`;

  // REFUSE A TAG ABSENT FROM ECR. Otherwise the failure appears ~40 seconds later as a Fargate
  // image-pull error INSIDE the downtime window — with the old task already stopped.
  const inEcr = await findImage(ecr, repo.repositoryName, tag);
  if (!inEcr) {
    throw refused(`${repo.repositoryName}:${tag} is not in ECR`, {
      detail: derived
        ? 'Derived from the working tree — run `archie gateway build --push` first. Deploying it '
          + 'would fail ~40s from now as an image-pull error, inside the downtime window.'
        : 'Push it first. Deploying it would fail ~40s from now as an image-pull error, inside the '
          + 'downtime window, with the old task already stopped.',
    });
  }

  const deployed = await readDeployed(ecs, ctx);
  const check = checkEnvAgainstName(ctx, deployed.env);
  if (!check.ok) {
    // Check 16 before a MUTATION is exit 3, not exit 7: nothing has been changed, and the fix is
    // infrastructure. `gateway status --check` reports the same disagreement as drift (exit 7).
    throw preflight(`the deployed task definition's environment does not agree with --name ${ctx.name}`, {
      detail: [...check.mismatches.map((m) => `${m.key}: deployed ${m.deployed}, expected ${m.expected}`),
        ...check.absent.map((m) => `${m.key}: absent, expected ${m.expected}`)].join('; '),
    });
  }
  for (const m of check.regionMismatches) {
    out.warn(`deployed ${m.key}=${m.deployed} but --region is ${m.expected}`);
  }

  const currentImage = deployed.container.image;
  const currentTd = arnTail(deployed.taskDefinition.taskDefinitionArn);
  const currentRepoUri = String(currentImage).split(':')[0];
  if (currentRepoUri && currentRepoUri !== repo.repositoryUri) {
    out.warn(`the running image comes from ${currentRepoUri}, not ${repo.repositoryUri} — the `
      + 'service is on another stack\'s repository');
  }

  // IDEMPOTENCE, and it is the point. Running a release twice with no edits must do nothing at all,
  // "including no gateway outage" (§2.27). The service already running this exact image is exactly
  // that case, so it stops here rather than paying 94 seconds to arrive where it already is.
  if (currentImage === image) {
    out.progress(`unchanged   ${currentTd} already runs ${image} — no rollout, no outage`);
    return emit(ctx, out, {
      tag, image, cluster: deployed.cluster, service: deployed.service,
      previousTaskDefinition: currentTd, registeredTaskDefinition: null,
      rolled: false, unchanged: true, waited: false, timeline: null,
      terraform: terraformFollowUp(ctx, tag),
    }, renderDeploy);
  }

  out.progress(`image       ${currentImage}`);
  out.progress(`         -> ${image}  (${inEcr.digest})`);

  if (ctx.dryRun) {
    out.progress(`would register a revision of ${deployed.taskDefinition.family} from ${currentTd}, `
      + 'image swapped, everything else copied');
    out.progress(`would update ${deployed.cluster}/${deployed.service} onto it — ~94s of dispatcher downtime`);
    return emit(ctx, out, {
      tag, image, imageDigest: inEcr.digest, cluster: deployed.cluster, service: deployed.service,
      previousTaskDefinition: currentTd, registeredTaskDefinition: null,
      rolled: false, unchanged: false, waited: false, timeline: null,
      terraform: terraformFollowUp(ctx, tag),
    }, renderDeploy);
  }

  const registered = await registerRevision(ecs, deployed, image);
  const newArn = registered.taskDefinitionArn;
  out.progress(`registered  ${arnTail(newArn)}  (image ${image})`);

  await ecs.send(new UpdateServiceCommand({
    cluster: deployed.cluster, service: deployed.service, taskDefinition: newArn,
  }));
  out.progress('rolling     desired=1 min=0% max=100%  — stop-then-start, downtime expected');

  // The Terraform follow-up, said EVERY time and not only on failure: the service resource has no
  // `ignore_changes` on task_definition, so the next `terraform apply` plans the service back onto
  // the task definition Terraform knows about.
  const tf = terraformFollowUp(ctx, tag);
  out.warn(`Terraform owns this task definition (dispatcher.tf:149) and this service `
    + `(dispatcher.tf:216). Set ${tf.variable} = "${tf.value}" before the next \`terraform apply\`, or `
    + 'that apply will roll the dispatcher back to the tag in tfvars — a second ~94s outage.');

  if (args.values['no-wait']) {
    out.warn('--no-wait: nothing is monitoring the rollout. The wait is the value of this command; '
      + 'the gap, a STOPPED task and a failing healthcheck are all invisible from here.');
    return emit(ctx, out, {
      tag, image, imageDigest: inEcr.digest, cluster: deployed.cluster, service: deployed.service,
      previousTaskDefinition: currentTd, registeredTaskDefinition: arnTail(newArn),
      rolled: true, unchanged: false, waited: false, timeline: null, terraform: tf,
    }, renderDeploy);
  }

  const budget = waitBudgetSeconds(ctx, args);
  const timeline = await waitForRollout({
    ecs, ctx, out, now, sleep,
    cluster: deployed.cluster,
    service: deployed.service,
    taskDefinitionArn: newArn,
    hasHealthcheck: Boolean((registered.containerDefinitions || []).some((c) => c.healthCheck)),
    budgetMs: budget * 1000,
    pollIntervalMs: deps.pollIntervalMs || POLL_INTERVAL_MS,
  });

  return emit(ctx, out, {
    tag, image, imageDigest: inEcr.digest, cluster: deployed.cluster, service: deployed.service,
    previousTaskDefinition: currentTd, registeredTaskDefinition: arnTail(newArn),
    rolled: true, unchanged: false, waited: true, timeline, terraform: tf,
  }, renderDeploy);
}

/** `--wait-timeout` wins; the global `--timeout` also raises it (§1.2); otherwise 300s (§2.4). */
function waitBudgetSeconds(ctx, args) {
  const raw = args.values['wait-timeout'];
  if (raw !== undefined) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw usage(`--wait-timeout must be a positive number of seconds, got "${raw}"`);
    return n;
  }
  return ctx.timeoutSeconds || DEFAULT_WAIT_SECONDS;
}

/** The tfvars knob a deploy leaves stale. Derived, so a rename of the variable is a one-line fix. */
function terraformFollowUp(ctx, tag) {
  return { variable: 'archie_dispatcher_image_tag', value: tag, makefileVariable: 'ARCHIE_GATEWAY_TAG' };
}

/**
 * Register a revision of the CURRENT task definition with only the image swapped.
 *
 * The read-only fields are STRIPPED rather than the writable ones copied. Both directions can be
 * wrong; they fail differently. A forgotten writable field (runtimePlatform, ephemeralStorage, a
 * volume) silently registers a revision that differs from Terraform's in a way nobody sees until
 * the container behaves differently. A read-only field left in fails loudly at RegisterTaskDefinition
 * — before anything is stopped, outside the downtime window. Loud and early beats silent and live.
 */
async function registerRevision(ecs, deployed, image) {
  const source = { ...deployed.taskDefinition };
  for (const key of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes', 'compatibilities',
    'registeredAt', 'registeredBy', 'deregisteredAt']) {
    delete source[key];
  }
  source.containerDefinitions = (deployed.taskDefinition.containerDefinitions || []).map((c) => (
    c.name === deployed.container.name ? { ...c, image } : { ...c }
  ));
  // Carry Terraform's tags onto the revision, so a revision this CLI registered is not the only one
  // in the family without them — the tags are how everything else attributes cost and ownership.
  if (deployed.taskDefinitionTags.length) source.tags = deployed.taskDefinitionTags;

  try {
    const res = await ecs.send(new RegisterTaskDefinitionCommand(source));
    return res.taskDefinition;
  } catch (e) {
    throw new CliError(`RegisterTaskDefinition failed for family ${deployed.taskDefinition.family}`, { cause: e });
  }
}

/**
 * Wait for the three transitions, in order. See the file header for why it cannot be two.
 *
 * Timestamps come from OBSERVATION, at poll resolution — the printed gap is what this command saw,
 * not a number copied from a document. If the poll interval straddles the whole stop (possible only
 * on a very fast start), the zero is inferred from the deployment's own createdAt and the gap is
 * reported as approximate rather than silently omitted.
 */
async function waitForRollout({
  ecs, ctx, out, now, sleep, cluster, service, taskDefinitionArn, hasHealthcheck, budgetMs, pollIntervalMs,
}) {
  const startedWaitingAt = now();
  let phase = 'stopping';
  let stoppedAt = null;
  let stoppedApproximate = false;
  let startedAt = null;
  let healthyAt = null;

  if (!hasHealthcheck) {
    // Terraform defines the healthcheck (dispatcher.tf:196-210). If a revision arrives without one,
    // healthStatus stays UNKNOWN forever and waiting for HEALTHY would burn the whole budget and
    // then report a timeout on a rollout that actually succeeded.
    out.warn('the new task definition declares no container healthcheck — waiting for RUNNING only. '
      + 'GET /health is not being verified (dispatcher.tf:196-202).');
  }

  for (;;) {
    const elapsed = now() - startedWaitingAt;
    if (elapsed > budgetMs) {
      throw timeout(`budget of ${Math.round(budgetMs / 1000)}s expired while waiting for the rollout `
        + `(phase: ${phase})`, {
        detail: 'The rollout may still complete — ECS is still working. Re-check with `archie gateway '
          + 'status` before doing anything else; do NOT re-deploy blind.',
      });
    }

    const described = await ecs.send(new DescribeServicesCommand({ cluster, services: [service] }));
    const svc = (described.services || [])[0] || {};
    const target = (svc.deployments || []).find((d) => d.taskDefinition === taskDefinitionArn);

    if (phase === 'stopping') {
      if (svc.runningCount === 0) {
        stoppedAt = now();
        out.progress(`${at(stoppedAt)}    runningCount 1 -> 0        (old task stopped; Socket Mode closed)`);
        phase = 'starting';
      } else if (target && target.runningCount >= 1) {
        // The stop happened between two polls. Anchor on the deployment's createdAt rather than
        // dropping the gap: an unreported gap reads as "no downtime", which is the one claim this
        // command must never make.
        stoppedAt = target.createdAt ? new Date(target.createdAt).getTime() : now();
        stoppedApproximate = true;
        out.progress(`${at(now())}    runningCount 1 -> 0 -> 1   (stop observed after the fact; gap approximate)`);
        phase = 'starting';
      }
    }

    if (phase === 'starting') {
      if (target && target.runningCount >= 1) {
        startedAt = now();
        out.progress(`${at(startedAt)}    runningCount 0 -> 1        (task def ${arnTail(taskDefinitionArn)} provisioning)`);
        phase = hasHealthcheck ? 'health' : 'done';
        if (phase === 'done') healthyAt = startedAt;
      } else {
        await assertNoStoppedTask({ ecs, cluster, service, taskDefinitionArn, out });
      }
    }

    if (phase === 'health') {
      const task = await findTask({ ecs, cluster, service, taskDefinitionArn });
      if (task && task.healthStatus === 'HEALTHY') {
        healthyAt = now();
        phase = 'done';
      } else {
        if (task) out.verbose(`${at(now())}    task ${arnTail(task.taskArn)} ${task.lastStatus} health=${task.healthStatus}`);
        await assertNoStoppedTask({ ecs, cluster, service, taskDefinitionArn, out });
      }
    }

    if (phase === 'done') break;
    await sleep(pollIntervalMs);
  }

  const gapMs = healthyAt - stoppedAt;
  const gapSeconds = Math.max(0, Math.round(gapMs / 1000));
  // Reported, never hidden, and never described as zero. §6.1: "Every `archie gateway deploy` costs
  // ~90 seconds of dropped Slack messages… stated here so nobody spends an outage investigating it."
  out.progress(`${at(healthyAt)}    healthCheck ${hasHealthcheck ? 'HEALTHY' : 'RUNNING'}        `
    + `gap ${gapSeconds}s${stoppedApproximate ? ' (approximate)' : ''}`);
  out.progress(`downtime    ${gapSeconds}s of dropped Slack events — the Socket Mode connection was `
    + 'CLOSED, so the durable turn queue did not cover it (§6.1)');

  return {
    stoppedAt: new Date(stoppedAt).toISOString(),
    startedAt: startedAt ? new Date(startedAt).toISOString() : null,
    healthyAt: new Date(healthyAt).toISOString(),
    gapSeconds,
    gapApproximate: stoppedApproximate,
    healthcheckVerified: Boolean(hasHealthcheck),
  };
}

/**
 * A task on the new revision that has STOPPED is a failed rollout — exit 1, WITHOUT rolling back.
 *
 * An automatic rollback would be a second uninstrumented ~94s outage stacked on the first (§2.4).
 * ECS holds the failed deployment; the operator decides. The stop reason is the whole message: the
 * image-pull failure this arrives as is otherwise indistinguishable from a slow start.
 */
async function assertNoStoppedTask({ ecs, cluster, service, taskDefinitionArn, out }) {
  const listed = await ecs.send(new ListTasksCommand({
    cluster, serviceName: service, desiredStatus: 'STOPPED',
  }));
  const arns = listed.taskArns || [];
  if (arns.length === 0) return;
  const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns.slice(0, 100) }));
  const dead = (described.tasks || []).find((t) => t.taskDefinitionArn === taskDefinitionArn);
  if (!dead) return;
  const container = (dead.containers || [])[0] || {};
  out.progress(`${at(Date.now())}    task ${arnTail(dead.taskArn)} STOPPED`);
  throw new CliError(`the new task STOPPED: ${dead.stoppedReason || 'no reason reported'}`, {
    code: EXIT.FAILED,
    detail: `${container.reason ? `container: ${container.reason}. ` : ''}`
      + 'NOT rolled back on purpose — that would be a second ~94s outage stacked on this one. ECS is '
      + 'holding the failed deployment; roll forward or `archie gateway deploy --tag <previous>`.',
  });
}

async function findTask({ ecs, cluster, service, taskDefinitionArn }) {
  const listed = await ecs.send(new ListTasksCommand({
    cluster, serviceName: service, desiredStatus: 'RUNNING',
  }));
  const arns = listed.taskArns || [];
  if (arns.length === 0) return null;
  const described = await ecs.send(new DescribeTasksCommand({ cluster, tasks: arns.slice(0, 100) }));
  return (described.tasks || []).find((t) => t.taskDefinitionArn === taskDefinitionArn) || null;
}

function renderDeploy(r) {
  const lines = [];
  if (r.unchanged) {
    lines.push(`unchanged   ${r.previousTaskDefinition} already runs ${r.image}`);
    lines.push('rollout     none — no task definition registered, no downtime');
    return lines.join('\n');
  }
  lines.push(`image       ${r.image}${r.imageDigest ? `  (${r.imageDigest})` : ''}`);
  lines.push(`taskdef     ${r.previousTaskDefinition} -> ${r.registeredTaskDefinition || '(not registered)'}`);
  if (r.timeline) {
    lines.push(`downtime    ${r.timeline.gapSeconds}s${r.timeline.gapApproximate ? ' (approximate)' : ''} `
      + `— ${r.timeline.stoppedAt} to ${r.timeline.healthyAt}`);
    if (!r.timeline.healthcheckVerified) lines.push('healthcheck NOT verified (the revision declares none)');
  } else if (r.rolled) {
    lines.push('downtime    not measured (--no-wait): nothing observed the gap');
  }
  lines.push(`terraform   set ${r.terraform.variable} = "${r.terraform.value}" before the next apply`);
  return lines.join('\n');
}

// ── gateway status ───────────────────────────────────────────────────────────────────────────────

/**
 * `archie gateway status [--check]` — §2.5.
 *
 * REFUSES TO READ THE LOCAL SHELL'S ENVIRONMENT. Everything below comes from the deployed task
 * definition (spec-baseline.mjs:16-17,32-44). What your terminal exports is irrelevant to what the
 * dispatcher is running, and conflating them is how shadow config survives.
 */
async function status(ctx, args, out, deps = {}) {
  const ecs = client.ecs(ctx, deps);
  const deployed = await readDeployed(ecs, ctx);
  const svc = deployed.svc;

  const listed = await ecs.send(new ListTasksCommand({
    cluster: deployed.cluster, serviceName: deployed.service, desiredStatus: 'RUNNING',
  }));
  const taskArns = listed.taskArns || [];
  const described = taskArns.length
    ? await ecs.send(new DescribeTasksCommand({ cluster: deployed.cluster, tasks: taskArns.slice(0, 100) }))
    : { tasks: [] };

  const tdArn = deployed.taskDefinition.taskDefinitionArn;
  const tasks = (described.tasks || []).map((t) => ({
    id: arnTail(t.taskArn),
    lastStatus: t.lastStatus,
    healthStatus: t.healthStatus,
    startedAt: t.startedAt ? new Date(t.startedAt).toISOString() : null,
    taskDefinition: arnTail(t.taskDefinitionArn),
    // A running task on an OLDER revision than the service points at is a rollout in flight or one
    // that never finished — worth naming, because the service's own fields do not say it.
    onServiceTaskDefinition: t.taskDefinitionArn === tdArn,
  }));

  const image = deployed.container.image;
  const check = checkEnvAgainstName(ctx, deployed.env);
  const primary = (svc.deployments || []).find((d) => d.status === 'PRIMARY') || {};

  const result = {
    cluster: deployed.cluster,
    service: deployed.service,
    taskDefinition: arnTail(tdArn),
    family: deployed.taskDefinition.family,
    revision: deployed.taskDefinition.revision,
    image,
    tag: String(image).includes(':') ? String(image).split(':').pop() : null,
    desiredCount: svc.desiredCount,
    runningCount: svc.runningCount,
    pendingCount: svc.pendingCount,
    rolloutState: primary.rolloutState || null,
    rolloutStateReason: primary.rolloutStateReason || null,
    tasks,
    env: deployed.env,
    secrets: deployed.secrets,
    check: {
      ok: check.ok,
      expected: check.expected,
      mismatches: check.mismatches,
      absent: check.absent,
      regionMismatches: check.regionMismatches,
      asserted: Boolean(args.values.check),
    },
  };

  for (const m of check.regionMismatches) {
    out.warn(`deployed ${m.key}=${m.deployed} but --region is ${m.expected}`);
  }

  // --check is the only thing that changes the exit code; without it this is a report. Exit 7
  // (DRIFT), not 3: nothing was mutated and nothing was refused — observed state != declared state.
  if (args.values.check && !check.ok) {
    if (ctx.json) out.answer(result);
    else out.answer(renderStatus(result));
    throw drift(`the deployed environment does not agree with --name ${ctx.name}`, {
      detail: [...check.mismatches.map((m) => `${m.key}: deployed ${m.deployed}, expected ${m.expected}`),
        ...check.absent.map((m) => `${m.key}: absent, expected ${m.expected}`)].join('; '),
    });
  }

  return emit(ctx, out, result, renderStatus);
}

function renderStatus(r) {
  const lines = [];
  lines.push(`service     ${r.service}  (cluster ${r.cluster})`);
  lines.push(`taskdef     ${r.taskDefinition}`);
  lines.push(`image       ${r.image}`);
  lines.push(`counts      desired=${r.desiredCount} running=${r.runningCount} pending=${r.pendingCount}`
    + `${r.rolloutState ? `  rollout=${r.rolloutState}` : ''}`);
  if (r.tasks.length === 0) lines.push('task        none running');
  for (const t of r.tasks) {
    lines.push(`task        ${t.id}  ${t.lastStatus}  health=${t.healthStatus}`
      + `${t.startedAt ? `  started ${t.startedAt}` : ''}`
      + `${t.onServiceTaskDefinition ? '' : `  ON ${t.taskDefinition}, NOT the service's ${r.taskDefinition}`}`);
  }
  // The deployed values for the name-derived keys, printed every time and not only on failure —
  // deploy-dashboard.cjs:258-261 prints its resolved stack for the same reason.
  for (const [key, want] of Object.entries(r.check.expected)) {
    const got = r.env[key];
    const flag = got === undefined ? '  (ABSENT — expected ' + want + ')'
      : got !== want ? `  (EXPECTED ${want})` : '';
    lines.push(`env         ${key}=${got === undefined ? '' : got}${flag}`);
  }
  lines.push(`check       ${r.check.ok ? `deployed env agrees with the derived names`
    : `${r.check.mismatches.length} mismatched, ${r.check.absent.length} absent`}`
    + `${r.check.asserted ? '' : '  (reported; --check to assert)'}`);
  return lines.join('\n');
}

module.exports = {
  build, deploy, status,
  // Exported for tests — each is a rail that fails in a way the command's own output would not
  // distinguish, so each is asserted directly.
  checkEnvAgainstName, registerRevision, waitForRollout, waitBudgetSeconds, defaultRun,
};

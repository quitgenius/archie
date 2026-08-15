'use strict';

// `archie generation …` — the image, the generation record, and the two read-only checks over it.
// RUNTIME-CLI-REFERENCE.md §2.6 (build), §2.7 (create), §2.12 (list/show), §2.10 (verify).
// Data model: RUNTIME-RELEASE-PLAN.md §3.
//
// WHAT A GENERATION IS. One `CONFIG#generation / <generationId>` item holding the FLEET-LEVEL
// CreateAgentRuntime template — image, EFS root prefix and mount path, security group, lifecycle,
// protocol, and the runtime env — plus the digest of that template. Nothing in it is live. Staging
// (W1-D) binds agents onto it; `release set` (W2-B) is the only thing that moves traffic.
//
// THE ONE IDEA THIS FILE EXISTS FOR. Today `runtimeSpecFor` runs PER TURN inside the dispatcher off
// `process.env` (agentcore-client.js:904-915, :312-334), so "what will the fleet run" is a property
// of whatever task definition happens to be deployed, computed fresh on every message, recorded
// nowhere. A generation freezes that computation into one immutable, self-describing record. That is
// what makes a rollback target honest — it describes the image it actually ran — and it is why
// `--set` exists: it is the seam Terraform's values arrive through (plan §10), replacing the
// dispatcher task-definition environment.
//
// REUSE, NOT REIMPLEMENTATION. The computation is NOT copied here. `createAgentCoreClient` exposes
// `runtimeSpecFor`, `runtimeEnv`, `config` and `observedSpecOf` on the instance, and spec-baseline.mjs
// (:105-119) already drives it exactly this way from outside the dispatcher process. So the field SET
// is the dispatcher's, always: a field added to runtimeSpecFor appears in the next generation with no
// change here. Only the FLEET/PER-AGENT split is ours — see TEMPLATE_AGENT below, and the guard that
// fails loudly if a per-agent value ever leaks into the fleet template.
//
// THE DYNAMODB LANDMINE (runtime-registry.js:134-138). `agent` and `data` are reserved words, the
// reserved list is ~570 words long, and an unaliased `agent` broke every turn for every agent live on
// 2026-08-13. Every attribute name in every expression below is aliased, without exception —
// including `#data`, which is this file's own body attribute. Unit tests cannot catch a miss here:
// they assert command shape against a fake client and "happily asserted the broken expression string"
// (registry-e2e.js:5-15). The test file adds the closest thing available — an assertion that no bare
// identifier survives in any expression — but the real gate is an e2e against DynamoDB.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { CliError, EXIT, usage, preflight, refused, drift } = require('../lib/exit');
const { adoptedRootFor } = require('../lib/efs-root');
const { digestFor, tagFor, assertPure, dirtyWarning, ROOT } = require('../lib/digest');
const { makeClient } = require('../lib/aws');
// Pure, dependency-free dispatcher modules — safe to require at load. The heavy one
// (agentcore-client, which pulls the OTEL API and the AWS SDK) is required lazily, below.
const { diffObserved } = require('../../slack-dispatcher/spec-diff');
const {
  runtimeIdOf, PK_PREFIX: BINDING_PK_PREFIX, SK_PREFIX: BINDING_SK_PREFIX, nameFromSk,
} = require('../../slack-dispatcher/runtime-registry');

// ── constants ────────────────────────────────────────────────────────────────────────────────────

// OUTSIDE `AGENT#`, deliberately. The derived per-agent role's `dynamodb:LeadingKeys` scope is
// `[AGENT#<id>, GRANT#<id>, SKILL#*, CONFIG#base]` (derive-exec-role.mjs:104-110), so a generation or
// a release pointer under `AGENT#` would be readable — and, if any AGENT#* write is ever
// reintroduced, writable — by every agent in the fleet. schema.mjs:81-93 already made this call for
// the image pointer ("Do NOT move these under AGENT#<id>"): whoever writes it chooses the CODE that
// runs inside every microVM holding that agent's IAM role.
const GENERATION_PK = 'CONFIG#generation';
const RELEASE_KEY = { pk: 'CONFIG#release', sk: 'ACTIVE' };

// AgentCore microVMs are arm64. Not overridable — §2.6, Makefile:59-68.
const PLATFORM = 'linux/arm64';
const MAKE_TARGET = 'build-agentcore-pi';

// The sentinel agent id handed to `runtimeSpecFor` to obtain the fleet template. Everything derived
// from it (the EFS root, AGENT_NAME) is stripped and re-derived per agent; the guard in
// fleetSpecFrom() fails the command if any OTHER field ever comes back carrying it.
const TEMPLATE_AGENT = '__fleet_template__';

// A generation id lands in a DynamoDB sort key, in CLI output, and (via staging) in an AgentCore
// runtime name. Kept to the intersection of what all three accept, minus the length AgentCore's
// 48-char name budget needs for the agent half.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// The fleet-level fields `--set` may override, and what each must be. Anything else is a usage error:
// a typo'd key that was silently accepted would produce a generation missing the value the operator
// believed they had set, and nothing downstream could tell.
const SETTABLE = {
  efsRootPrefix: 'string',
  efsMountPath: 'string',
  securityGroupId: 'string',
  idleRuntimeSessionTimeout: 'number',
  maxLifetime: 'number',
  serverProtocol: 'string',
};

// Of those, the three that reach the spec through the dispatcher's CONFIG (so that everything derived
// from them moves too — notably runtimeEnv's `EFS_DIR: config.efsMountPath`, which a post-hoc
// override of `efsMountPath` alone would leave stale and inconsistent).
const CONFIG_SETTABLE = ['efsRootPrefix', 'efsMountPath', 'securityGroupId'];
// And the three runtimeSpecFor hard-codes (900 / 28800 / 'HTTP'), which therefore have to be applied
// to the produced spec rather than to the config.
const SPEC_SETTABLE = ['idleRuntimeSessionTimeout', 'maxLifetime', 'serverProtocol'];

// ...except the SAGA hard-codes the same three (`agentcore-provisioning.js:521`), so a generation
// that sets them can be WRITTEN but never SATISFIED. Every agent provisions with 900 / 28800 / HTTP
// whatever the generation says, the read-back sees a mismatch, and `stage` reports it 208 times —
// once per agent — while never converging on a re-run. `agent ensure-runtime` refuses such a
// generation for the same reason.
//
// Refusing at CREATE turns 208 per-agent failures into one error before anything is written. This is
// not a permanent limitation: threading the three through `ensureAgentEnvironment` would make them
// real, and this list is where that change lands.
const UNAPPLIABLE = ['idleRuntimeSessionTimeout', 'maxLifetime', 'serverProtocol'];

// ── small helpers ────────────────────────────────────────────────────────────────────────────────

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => obj[k] !== undefined).map((k) => [k, obj[k]]));

/** The answer, shaped for the reader: an object under --json, the reference's block otherwise. */
const answer = (out, ctx, obj, text) => out.answer(ctx.json ? obj : text);

/** `new Date()` unless a test injected a clock. */
const nowIso = (deps) => new Date(deps.now ? deps.now() : Date.now()).toISOString();

/** Who cut this generation. Attribution only — nothing authorises on it. */
function whoami(deps) {
  if (deps.user) return deps.user;
  try {
    return os.userInfo().username;
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

/**
 * The body of a config item.
 *
 * Bodies are written as an OPAQUE JSON STRING under `data`, never as a DynamoDB Map — "DDB Maps do
 * NOT preserve key order" (schema.mjs:104-108) and an order-unstable body makes `specDigest`
 * meaningless: the same spec would hash differently on a round trip. The fallback to the raw item is
 * for items this file only READS (the release pointer, written by `release set` — W2-B), so a
 * top-level encoding there cannot make `generation list` report "no release".
 */
const readBody = (item) => {
  if (!item) return null;
  if (item.data == null) return item;
  return JSON.parse(item.data);
};

/** Everything after the last `:` of an image URI — what the reference's tables show. */
const tagOf = (uri) => (typeof uri === 'string' && uri.includes(':') ? uri.slice(uri.lastIndexOf(':') + 1) : uri);

/** Fixed-width table for the non-JSON output. */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length)));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

// ── clients ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Lazily-constructed AWS clients, every one injectable.
 *
 * Nothing here is constructed until a command actually needs it, so `node --test` never touches
 * credentials, the network or Docker — the tests inject `{ doc, ecr, sts, agentcore, run }`.
 */
function clientsFor(ctx, deps = {}) {
  // `--profile` also has to reach the clients the DISPATCHER'S client constructs for itself
  // (agentcore-client.js:346-364 builds its own control/EFS clients from `config.region` and the
  // default credential chain — there is no credentials seam to inject). AWS_PROFILE is the only
  // channel that reaches those, and it costs nothing for lib/aws.js's own clients, which take an
  // explicit provider.
  if (ctx.profile && process.env.AWS_PROFILE !== ctx.profile) process.env.AWS_PROFILE = ctx.profile;

  let doc = deps.doc || null;
  let ecr = deps.ecr || null;
  let sts = deps.sts || null;

  return {
    doc() {
      if (!doc) {
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        doc = DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient'));
      }
      return doc;
    },
    ecr() {
      if (!ecr) ecr = makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient');
      return ecr;
    },
    sts() {
      if (!sts) sts = makeClient(ctx, '@aws-sdk/client-sts', 'STSClient');
      return sts;
    },
  };
}

/**
 * The dispatcher's AgentCore client, configured for THIS deployment.
 *
 * `createAgentCoreClient` resolves its own defaults from `process.env` (agentcore-client.js:45-143),
 * which is exactly the state this whole plan is replacing — so region, account and the config table
 * come from the CLI context, and the fleet fields an operator wants to change come from `--set`.
 * Everything else still falls back to the dispatcher's own defaults, which is the honest behaviour:
 * a generation records what the dispatcher WOULD have used.
 */
function dispatcherClientFor(ctx, account, sets = { fields: {}, env: {} }, deps = {}) {
  const overrides = {
    region: ctx.region,
    account,
    agentConfigTable: ctx.resources.configTable,
    ...pick(sets.fields, CONFIG_SETTABLE),
    ...(Object.keys(sets.env).length ? { extraEnv: sets.env } : {}),
  };
  if (deps.agentcore) return deps.agentcore(overrides);
  let mod;
  try {
    mod = require('../../slack-dispatcher/agentcore-client');
  } catch (e) {
    // The CLI deliberately require()s the dispatcher's modules rather than forking them (see the
    // eslint config's archie block). If that tree is not installed, say so — a locally re-implemented
    // `canonicalize` or `runtimeEnv` is the one failure this design exists to prevent.
    throw preflight('cannot load the dispatcher\'s spec computation (slack-dispatcher/agentcore-client)',
      { cause: e, detail: 'run `npm ci` in docker/slack-dispatcher — the CLI reuses it rather than reimplementing it' });
  }
  return mod.createAgentCoreClient(overrides);
}

/** The dispatcher's `efsRootDir`, for expanding a stored fleet template back to a per-agent spec. */
function efsRootDirFn(deps = {}) {
  if (deps.efsRootDir) return deps.efsRootDir;
  return require('../../slack-dispatcher/agentcore-client').efsRootDir;
}

/**
 * The account the CLI is operating on.
 *
 * `--account` is documented as an ASSERTION ("assert the caller is in this account, or exit 3"), so
 * it is checked against the caller rather than trusted: an image URI built from an asserted-but-wrong
 * account id would point at a repo in someone else's account and fail as an obscure pull error later.
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

const registryHostFor = (account, region) => `${account}.dkr.ecr.${region}.amazonaws.com`;
const imageUriFor = (ctx, account, tag) => `${registryHostFor(account, ctx.region)}/${ctx.resources.agentRepo}:${tag}`;

// ── ECR ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * What ECR holds for this tag, or null.
 *
 * Mirrors publish-image.mjs:50-96, which is the existing check — it could not be imported, being an
 * ESM script whose repo/table/account come from `process.env` at module load and which exports
 * nothing. The two rules it encodes are kept verbatim: absence is a clean null (the caller decides
 * whether that means "build it" or "refuse"), and a manifest list is inspected for architectures
 * because an amd64 image in the agent repo is "the single easiest mistake to make here".
 */
async function describeImage(aws, { account, repo, tag }) {
  const { DescribeImagesCommand, BatchGetImageCommand } = require('@aws-sdk/client-ecr');
  let detail;
  try {
    const res = await aws.ecr().send(new DescribeImagesCommand({
      repositoryName: repo, registryId: account, imageIds: [{ imageTag: tag }],
    }));
    detail = res.imageDetails && res.imageDetails[0];
  } catch (err) {
    if (err && err.name === 'ImageNotFoundException') return null;
    if (err && err.name === 'RepositoryNotFoundException') {
      throw preflight(`ECR repository ${repo} does not exist in account ${account}`,
        { cause: err, detail: 'run `archie preflight` — the deployment name may be wrong (context.js:29-31)' });
    }
    throw err;
  }
  if (!detail) return null;

  const arches = new Set();
  // Why the architecture set may be empty is worth keeping: "no platform block in a single-arch
  // manifest" and "the caller lacks ecr:BatchGetImage" both end up as `arches: []`, and only one of
  // them is benign. assertArm64 treats an empty set as UNPROVEN either way; this records which.
  let archesFrom = 'manifest';
  try {
    const got = await aws.ecr().send(new BatchGetImageCommand({
      repositoryName: repo,
      registryId: account,
      imageIds: [{ imageTag: tag }],
      acceptedMediaTypes: [
        'application/vnd.docker.distribution.manifest.list.v2+json',
        'application/vnd.oci.image.index.v1+json',
        'application/vnd.docker.distribution.manifest.v2+json',
      ],
    }));
    const body = got.images && got.images[0] && got.images[0].imageManifest;
    if (body) {
      const parsed = JSON.parse(body);
      for (const m of parsed.manifests || []) {
        if (m.platform && m.platform.architecture && m.platform.architecture !== 'unknown') arches.add(m.platform.architecture);
      }
    }
  } catch (e) {
    // Best-effort, exactly as publish-image.mjs:82 has it: EXISTENCE is the hard gate above. Not
    // silent, though — the reason rides on the result so `-v` can say why the arch check said nothing.
    archesFrom = `unavailable: ${(e && e.name) || e}`;
  }
  return {
    tag,
    digest: detail.imageDigest,
    pushedAt: detail.imagePushedAt ? new Date(detail.imagePushedAt).toISOString() : null,
    sizeMb: detail.imageSizeInBytes ? Number((detail.imageSizeInBytes / 1048576).toFixed(0)) : null,
    arches: [...arches].sort(),
    archesFrom,
  };
}

function assertArm64(found, uri) {
  if (found.arches.length && !found.arches.includes('arm64')) {
    throw refused(`${uri} is ${found.arches.join('/')} — AgentCore microVMs are arm64`,
      { detail: 'this is almost always the amd64 dispatcher image published by mistake (publish-image.mjs:86-89)' });
  }
}

// ── subprocess ───────────────────────────────────────────────────────────────────────────────────

/**
 * Run a command, or hand back what a test injected.
 *
 * Build output goes to STDERR (fd 2), never stdout: stdout carries the answer and only the answer
 * (output.js:5-8), and `archie generation build --json | jq` must survive a docker build.
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
    ['-f ./clawdbot/agentcore-pi/Dockerfile', 'the Dockerfile must be named explicitly, since the context is its parent'],
    ['./clawdbot', 'the build context is ./clawdbot, NOT agentcore-pi/ — the Dockerfile COPYs sibling plugin-sdk/ and connector-session-plugin/'],
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

// ── generation items ─────────────────────────────────────────────────────────────────────────────

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
 * identifier that also serves as the default generation id.
 */
function canonicalGeneration(spec, deps = {}) {
  const canonicalize = deps.canonicalize
    || require('../../slack-dispatcher/agentcore-client').canonicalize;
  const canonical = canonicalize(spec);
  // The stored body holds this exact object, so `JSON.stringify(body.spec)` round-trips byte-exact
  // and the digest can be recomputed from the item — which is what makes the record self-describing
  // rather than merely self-asserting.
  const json = JSON.stringify(canonical);
  return { canonical, json, specDigest: createHash('sha1').update(json).digest('hex').slice(0, 16) };
}

/**
 * The fleet-level template, from the dispatcher's own per-agent computation.
 *
 * `runtimeSpecFor` answers for ONE agent, so the two per-agent values it bakes in — the EFS root
 * (`efsRootDir(agent, prefix)`) and `envs.AGENT_NAME` — are removed and re-derived per agent at
 * staging/verify time by derivedSpecFor(). The prefix, not the expanded root, is what a generation
 * stores (plan §3).
 */
function fleetSpecFrom(client, imageUri, sets) {
  const perAgent = client.runtimeSpecFor(TEMPLATE_AGENT, imageUri);
  const runtimeEnv = { ...perAgent.envs };
  delete runtimeEnv.AGENT_NAME;

  // EVERY key runtimeSpecFor returns is carried through, minus the two that are per-agent by
  // construction. Copying the whole object rather than naming the seven fields is what makes the
  // claim in this file's header true: a field added to the dispatcher's spec appears in the next
  // generation with no change here. The two exceptions are handled explicitly — `efsRoot` becomes the
  // PREFIX a generation stores (plan §3), `envs` becomes `runtimeEnv` without AGENT_NAME.
  const rest = { ...perAgent };
  delete rest.efsRoot;
  delete rest.envs;

  const spec = {
    ...rest,
    efsRootPrefix: client.config.efsRootPrefix,
    runtimeEnv,
    ...pick(sets.fields, SPEC_SETTABLE),
  };

  // THE DRIFT GUARD. If the dispatcher ever adds another per-agent term to runtimeSpecFor, it would
  // otherwise be frozen into the fleet template with a sentinel agent's value and handed to all 208
  // agents. Failing here is loud and cheap; the fix is one line in the split above.
  if (JSON.stringify(spec).includes(TEMPLATE_AGENT)) {
    throw new CliError('the dispatcher\'s runtimeSpecFor has a per-agent field this CLI does not split out',
      { code: EXIT.FAILED, detail: `found "${TEMPLATE_AGENT}" in the fleet template — see fleetSpecFrom() in cmd/generation.js` });
  }
  if (!spec.image) throw new CliError('runtimeSpecFor returned no image', { code: EXIT.FAILED });
  return spec;
}

/**
 * The per-agent spec a generation implies — the shape `runtimeSpecFor` returns, so it is directly
 * diffable against `specFromGet`'s read-back (agentcore-client.js:476,487).
 *
 * Built from the STORED template, never from the current environment: verify's whole job is to
 * compare what is running against what was DECLARED, and re-deriving from `process.env` would
 * compare the fleet against today's task definition — the exact coupling generations remove.
 */
function derivedSpecFor(spec, agent, deps = {}) {
  // The exact inverse of fleetSpecFrom's split, and carried through the same way: any other field a
  // generation holds is passed straight to the comparison. A declared field the read-back cannot
  // observe will then show as a difference rather than being quietly dropped — verification that
  // silently skips what it cannot check is the failure this command replaces (plan §11).
  const rest = { ...spec };
  delete rest.efsRootPrefix;
  delete rest.runtimeEnv;
  return {
    ...rest,
    efsRoot: efsRootDirFn(deps)(agent, spec.efsRootPrefix),
    envs: { ...spec.runtimeEnv, AGENT_NAME: agent },
  };
}

/** `--set k=v`, repeatable → config-level fields, spec-level fields, and runtime env. */
function parseSets(values) {
  const fields = {};
  const env = {};
  for (const raw of values || []) {
    const at = String(raw).indexOf('=');
    if (at <= 0) throw usage(`--set expects key=value, got "${raw}"`);
    const key = String(raw).slice(0, at);
    const value = String(raw).slice(at + 1);
    if (key.startsWith('runtimeEnv.')) {
      const name = key.slice('runtimeEnv.'.length);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw usage(`--set runtimeEnv.${name}: not a valid environment variable name`);
      env[name] = value;
      continue;
    }
    const kind = SETTABLE[key];
    if (!kind) {
      throw usage(`--set ${key} is not a fleet-level field`,
        { detail: `expected one of ${Object.keys(SETTABLE).join(', ')} or runtimeEnv.<NAME>` });
    }
    if (UNAPPLIABLE.includes(key)) {
      // Refused here rather than discovered per agent — see the note on UNAPPLIABLE.
      throw refused(`--set ${key} cannot be honoured: the provisioning saga hard-codes it`, {
        detail: 'agentcore-provisioning.js:521 fixes idleRuntimeSessionTimeout, maxLifetime and '
          + 'serverProtocol at 900 / 28800 / HTTP. A generation setting one can be written but never '
          + 'satisfied: every agent would provision with the hard-coded value, `stage` would report a '
          + 'read-back mismatch once per agent, and a re-run would never converge. Threading these '
          + 'through the saga is what would make them settable.',
      });
    }
    fields[key] = kind === 'number' ? asPositiveInt(`--set ${key}`, value) : value;
  }
  return { fields, env };
}

/** Read one generation item. */
async function readGeneration(aws, ctx, generationId) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await aws.doc().send(new GetCommand({
    TableName: ctx.resources.configTable,
    Key: { pk: GENERATION_PK, sk: generationId },
    // A generation written seconds ago must not read as absent — `create` then `stage` in one script
    // is the documented flow (§3.1), and an eventually-consistent miss there would look like the
    // write failed.
    ConsistentRead: true,
  }));
  return r.Item || null;
}

async function requireGeneration(aws, ctx, generationId) {
  const item = await readGeneration(aws, ctx, generationId);
  if (!item) {
    throw new CliError(`no generation ${generationId}`, {
      code: EXIT.FAILED,
      detail: `CONFIG#generation / ${generationId} is not in ${ctx.resources.configTable} — \`archie generation list\` shows what is`,
    });
  }
  return item;
}

/** Every generation item, newest first. */
async function listGenerationItems(aws, ctx) {
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await aws.doc().send(new QueryCommand({
      TableName: ctx.resources.configTable,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': GENERATION_PK },
      ExclusiveStartKey,
    }));
    for (const item of r.Items || []) out.push(item);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const at = (i) => (readBody(i) || {}).createdAt || '';
  return out.sort((a, b) => (at(a) < at(b) ? 1 : at(a) > at(b) ? -1 : (a.sk < b.sk ? 1 : -1)));
}

async function readRelease(aws, ctx) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await aws.doc().send(new GetCommand({
    TableName: ctx.resources.configTable, Key: RELEASE_KEY, ConsistentRead: true,
  }));
  return readBody(r.Item || null);
}

/**
 * Every runtime binding row in the table.
 *
 * A Scan, following spec-baseline.mjs:73-84, and NEVER `ListAgentRuntimes`: List is 25/s
 * account-wide, non-adjustable, has no name filter and no get-by-name (runtime-registry.js:5-10), so
 * a fleet-wide read of it costs agents x pages against a hard ceiling. The alternative — enumerate
 * agents from the routing GSI, then one Query per agent (runtime-registry.js:96) — is ~208 round
 * trips to this one; the Scan is a single pass over an operator-run command's table.
 *
 * NO ProjectionExpression, deliberately: staging (W1-D) owns the binding's fields, and a projection
 * written here would silently hide any field it adds.
 */
async function scanBindings(aws, ctx) {
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await aws.doc().send(new ScanCommand({
      TableName: ctx.resources.configTable,
      FilterExpression: 'begins_with(#pk, :p)',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':p': BINDING_PK_PREFIX },
      ExclusiveStartKey,
    }));
    for (const item of r.Items || []) {
      const sk = String(item.sk || '');
      if (!sk.startsWith(BINDING_SK_PREFIX)) continue;
      out.push({
        ...item,
        agent: item.agent || String(item.pk).slice(BINDING_PK_PREFIX.length),
        // Plan §3 keys the binding `GEN#<generationId>`; today's registry writes `GEN#<runtimeName>`
        // (runtime-registry.js:43). Both are read: an explicit `generationId` attribute wins, so this
        // keeps working whichever way staging settles it, and pre-generation rows still show up.
        generationId: item.generationId || nameFromSk(sk),
        runtimeName: item.runtimeName || nameFromSk(sk),
      });
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** Coverage/health/liveness counts for one generation's bindings. */
function bindingStats(rows) {
  const stats = {
    bound: rows.length, live: 0, reaped: 0, ok: 0, failed: 0, pending: 0,
  };
  for (const r of rows) {
    if (r.arn) stats.live += 1; else stats.reaped += 1;
    const h = r.healthcheck || 'pending';
    if (h === 'ok') stats.ok += 1;
    else if (h === 'failed') stats.failed += 1;
    else stats.pending += 1;
  }
  return stats;
}

/**
 * The STATE column — §2.12.
 *
 * The rule that has to hold: a reaped generation is NEVER shown as a rollback target. Its rows
 * survive as history but the reaper REMOVEs the arn (runtime-registry.js:30-37), so pointing at one
 * "would invoke a corpse". Taint and liveness are shown ALONGSIDE rather than instead of each other:
 * a generation tainted after it went live is the situation you most need to see, and a state machine
 * that picked one label would hide exactly that.
 */
function stateOf({ item, stats, release }) {
  const parts = [];
  const live = release && release.generationId === item.sk;
  if (live) parts.push(`LIVE (${release.mode || 'staged'})`);
  if (item.taintedAt) parts.push(`TAINTED — ${item.taintReason || 'no reason recorded'}`);
  if (stats.bound === 0) parts.push('not staged');
  else if (stats.live === 0) parts.push('reaped — NOT a rollback target');
  else if (!live) parts.push('rollback target');
  // `is*` prefixes, deliberately: a row spreads these flags alongside bindingStats(), where `live`
  // and `reaped` are COUNTS. Sharing the names silently overwrote the counts with booleans and printed
  // `BOUND true` — the kind of collision that a JSON consumer would inherit without noticing.
  return {
    state: parts.join(' · '),
    isLive: Boolean(live),
    isTainted: Boolean(item.taintedAt),
    isRollbackTarget: Boolean(!live && !item.taintedAt && stats.live > 0),
    isReaped: stats.bound > 0 && stats.live === 0,
  };
}

// ── generation build ─────────────────────────────────────────────────────────────────────────────

/**
 * Build (and optionally push) the arm64 Pi runtime image — §2.6.
 *
 * NO DEPLOYMENT EFFECT. The fleet's image is chosen by a generation, so a push alone changes nothing
 * (Makefile:64-67). That is what makes the derived tag safe: same content, same tag, tag already in
 * ECR, skip the build and the push.
 */
async function build(ctx, args, out, deps = {}) {
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

  // `--pure` is not a `generation build` flag — it belongs to the composed `archie deploy` (§2.27),
  // which calls straight into this function. Honouring it here rather than there keeps one wording
  // and one refusal for both entry points.
  if (values.pure) assertPure('agent', { root });
  else {
    const warning = dirtyWarning('agent', { root });
    if (warning) out.warn(warning);
  }

  // The tag: pinned, or derived from the image's own declared inputs (lib/digest.js).
  const pinned = Boolean(values.tag);
  const digest = pinned ? null : digestFor('agent', { root });
  const tag = values.tag || tagFor(digest.digest);
  if (!pinned) out.verbose(`agent digest ${digest.digest} over ${digest.fileCount} declared inputs`);

  const account = await resolveAccount(ctx, aws);
  const uri = imageUriFor(ctx, account, tag);
  const repo = ctx.resources.agentRepo;

  const found = await describeImage(aws, { account, repo, tag });
  if (found) {
    // The repo is IMMUTABLE (modules/archie/ecr.tf:57-61) precisely so "a rollback would return what
    // it claimed to". A DERIVED tag that is already present is proof the content is already there —
    // skip. A PINNED tag is a name someone chose, and the local tree may be anything at all, so
    // pushing over it is refused rather than skipped: the push would fail at the registry, and if it
    // ever did not, every generation naming that tag would start lying.
    if (pinned && values.push) {
      throw refused(`${repo}:${tag} already exists in ECR and the repository is immutable`,
        { detail: 'a rollback target must return what it claimed to — cut a new tag, or drop --tag and let the digest name it' });
    }
    out.progress(`${uri} already in ECR (${found.digest || 'no digest'}) — skipping build and push`);
    answer(out, ctx, { image: uri, tag, built: false, pushed: false, skipped: true, ecr: found }, `${uri}\n  already in ECR — nothing to build`);
    return undefined;
  }

  const { localImage } = assertMakeConstraints(fs.readFileSync(path.join(root, 'Makefile'), 'utf8'));
  const makeArgs = ['-C', root, MAKE_TARGET, `AGENTCORE_PI_TAG=${tag}`];

  if (ctx.dryRun) {
    out.progress(`would run: make ${makeArgs.join(' ')}`);
    if (values.push) out.progress(`would push: ${uri}`);
    answer(out, ctx, { image: uri, tag, built: false, pushed: false, dryRun: true }, `${uri}\n  [dry-run] not built`);
    return undefined;
  }

  out.progress(`building ${localImage}:${tag} (${PLATFORM}, context ./clawdbot, lintroot=.)`);
  run('make', makeArgs, { cwd: root });

  let pushed = false;
  if (values.push) {
    // The push does NOT go through `make push-agentcore-pi`: that target's registry, account and
    // profile are sandbox literals (Makefile:71-73,136), and every resource name the CLI touches must
    // come from `--name`/`--region`/the caller's account instead (context.js:12-16). The build stays
    // in the Makefile because the build is where the three constraints live.
    const host = registryHostFor(account, ctx.region);
    const { GetAuthorizationTokenCommand } = require('@aws-sdk/client-ecr');
    const auth = await aws.ecr().send(new GetAuthorizationTokenCommand({}));
    const token = auth && auth.authorizationData && auth.authorizationData[0] && auth.authorizationData[0].authorizationToken;
    if (!token) throw new CliError('ECR GetAuthorizationToken returned no token', { code: EXIT.FAILED });
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    run('docker', ['login', '--username', 'AWS', '--password-stdin', host], { input: decoded.slice(decoded.indexOf(':') + 1) });
    run('docker', ['tag', `${localImage}:${tag}`, uri]);
    out.progress(`pushing ${uri}`);
    run('docker', ['push', uri]);
    pushed = true;
  }

  answer(out, ctx, { image: uri, tag, built: true, pushed, skipped: false }, [
    uri,
    `  built     ${localImage}:${tag} (${PLATFORM})`,
    pushed ? '  pushed    yes' : '  pushed    no (--push to publish)',
    `  next      archie generation create --image ${tag}`,
  ].join('\n'));
  return undefined;
}

// ── generation create ────────────────────────────────────────────────────────────────────────────

/**
 * Write one `CONFIG#generation / <generationId>`. Nothing becomes live — §2.7.
 *
 * THE ITEM SHAPE (other commands read it):
 *
 *   { pk: 'CONFIG#generation', sk: '<generationId>',
 *     data: '<JSON string>' }                 // the whole body, opaque, order-stable
 *
 *   body = { generationId, spec, specDigest, image, imageTag, imageDigest, createdAt, createdBy }
 *   spec = { image, efsRootPrefix, efsMountPath, securityGroupId,
 *            idleRuntimeSessionTimeout, maxLifetime, serverProtocol, runtimeEnv:{…} }  // canonical
 *
 * `data` is written ONCE and never rewritten — that is what lets `specDigest` be recomputed from the
 * stored bytes. Anything mutable about a generation therefore rides as its own TOP-LEVEL attribute
 * (`taintedAt`/`taintReason`/`taintedBy`, written by `generation taint` — W2-B), which an UpdateItem
 * can set without touching the body.
 */
async function create(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);
  const sets = parseSets(values.set);

  if (!values.image && !values.from) throw usage('--image <tag> is required (or --from <id> to seed from an existing generation)');

  const account = await resolveAccount(ctx, aws);

  // `--from` SEEDS, it does not inherit: the stored template is taken as-is and `--image`/`--set` are
  // applied over it. That is the point of it — cutting a one-variable change against a generation
  // that is known to work, without re-reading today's dispatcher environment underneath it and
  // sweeping unrelated drift into the same release.
  let baseSpec = null;
  if (values.from) {
    const body = readBody(await requireGeneration(aws, ctx, values.from));
    baseSpec = body.spec;
    if (!baseSpec) throw new CliError(`generation ${values.from} has no spec to seed from`, { code: EXIT.FAILED });
  }

  // `--image` is documented as a TAG. A full URI is accepted because operators paste them, but only
  // this deployment's own: the repo comes from `--name` and nothing else (context.js:12-16), and a URI
  // naming another repo would be validated against ours and then written verbatim into the
  // generation — a record that passed a check it never actually ran.
  const imageTag = values.image ? tagOf(values.image) : tagOf(baseSpec.image);
  const imageUri = values.image ? imageUriFor(ctx, account, imageTag) : baseSpec.image;
  if (values.image && values.image.includes('/') && values.image !== imageUri) {
    throw usage(`--image ${values.image} is not this deployment's agent repository`,
      { detail: `expected ${imageUriFor(ctx, account, '<tag>')} — or just pass the tag` });
  }

  // Validate BEFORE writing. "A bad pointer does not fail loudly — it provisions runtimes that cannot
  // pull, so every agent breaks on its next message" (publish-image.mjs:17-22). Also validated in
  // --dry-run: a preview that skipped the one check that matters would be a preview of nothing.
  const found = await describeImage(aws, { account, repo: ctx.resources.agentRepo, tag: imageTag });
  if (!found) {
    throw preflight(`image ${ctx.resources.agentRepo}:${imageTag} does not exist in ECR (${account}/${ctx.region})`,
      { detail: 'build and push it first: `archie generation build --push`' });
  }
  assertArm64(found, imageUri);
  if (!found.arches.length) out.verbose(`could not confirm the image architecture (${found.archesFrom}) — existence is the hard gate`);

  const spec = baseSpec
    ? {
      ...baseSpec,
      image: imageUri,
      ...pick(sets.fields, [...CONFIG_SETTABLE, ...SPEC_SETTABLE]),
      runtimeEnv: { ...baseSpec.runtimeEnv, ...sets.env },
    }
    : fleetSpecFrom(dispatcherClientFor(ctx, account, sets, deps), imageUri, sets);

  // EFS_DIR IS the mount path, as far as the runtime is concerned — the dispatcher sets them from one
  // value (agentcore-client.js:322). The fresh path keeps them in step because `--set efsMountPath`
  // goes through the config; `--from` copies the env verbatim, so the same `--set` there would mount
  // the workspace in one place and tell the agent it was in another. Asserted rather than re-derived:
  // this checks the relationship holds, it does not claim to know how the dispatcher computes it.
  if (spec.runtimeEnv && spec.runtimeEnv.EFS_DIR !== undefined && spec.runtimeEnv.EFS_DIR !== spec.efsMountPath) {
    throw refused(`efsMountPath is ${spec.efsMountPath} but runtimeEnv.EFS_DIR is ${spec.runtimeEnv.EFS_DIR}`,
      { detail: 'set both (`--set runtimeEnv.EFS_DIR=…`), or cut the generation without --from so the env follows the config' });
  }

  const { canonical, json, specDigest } = canonicalGeneration(spec, deps);

  // Default id is content-addressed (§2.7): the same inputs name the same generation, so an
  // accidental re-run is a no-op rather than a second record of one release.
  const generationId = values.id || `gen-${specDigest}`;
  if (!ID_RE.test(generationId)) {
    throw usage(`--id "${generationId}" is not a valid generation id`,
      { detail: 'letters, digits, . _ - only, starting alphanumeric, ≤64 chars — it becomes a sort key and part of a runtime name' });
  }

  const body = {
    generationId,
    spec: canonical,
    specDigest,
    image: imageUri,
    imageTag,
    imageDigest: found.digest || null,
    createdAt: nowIso(deps),
    createdBy: whoami(deps),
  };

  const existing = await readGeneration(aws, ctx, generationId);
  if (existing) {
    const prior = readBody(existing) || {};
    // Identical spec is NOT an overwrite — nothing is written at all, and re-running a script is not
    // an error. Anything else is refused: a generation is the self-describing record a rollback
    // target relies on, and rewriting one would make that target describe an image it never ran.
    if (prior.specDigest === specDigest && JSON.stringify(prior.spec) === json) {
      out.progress(`generation ${generationId} already exists with this exact spec — nothing written`);
      answer(out, ctx, { ...body, createdAt: prior.createdAt, createdBy: prior.createdBy, written: false, unchanged: true },
        `generation ${generationId}\n  unchanged   specDigest ${specDigest} (created ${prior.createdAt} by ${prior.createdBy})`);
      return undefined;
    }
    throw refused(`generation ${generationId} already exists with a different spec`, {
      detail: `stored specDigest ${prior.specDigest || 'unknown'}, this one ${specDigest} — a generation is never rewritten; choose a new --id`,
    });
  }

  const humanBlock = [
    `generation ${generationId}`,
    `  image       ${imageUri}`,
    `  specDigest  ${specDigest}`,
  ];

  if (ctx.dryRun) {
    out.progress(`would write CONFIG#generation / ${generationId}`);
    out.verbose(json, 2);
    answer(out, ctx, { ...body, written: false, dryRun: true },
      [...humanBlock, '  written     nothing (dry run)'].join('\n'));
    return undefined;
  }

  const { PutCommand } = require('@aws-sdk/lib-dynamodb');
  try {
    await aws.doc().send(new PutCommand({
      TableName: ctx.resources.configTable,
      // The body is an opaque JSON STRING (schema.mjs:104-108), never a Map: DDB Maps do not preserve
      // key order, and an order-unstable body makes specDigest meaningless.
      Item: { pk: GENERATION_PK, sk: generationId, data: JSON.stringify(body) },
      // The refusal, enforced by DynamoDB rather than by the read above — between that read and this
      // write another operator can create the same id, and losing that race silently would produce
      // exactly the rewrite this command must never perform.
      ConditionExpression: 'attribute_not_exists(#pk)',
      ExpressionAttributeNames: { '#pk': 'pk' },
    }));
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') {
      throw refused(`generation ${generationId} was created by someone else while this ran`,
        { cause: e, detail: 'a generation is never rewritten — read it with `archie generation show`' });
    }
    throw e;
  }

  answer(out, ctx, { ...body, written: true }, [
    ...humanBlock,
    `  written     ${GENERATION_PK} / ${generationId}`,
    `  nothing is live — run \`archie generation stage --generation ${generationId}\``,
  ].join('\n'));
  return undefined;
}

// ── generation list / show ───────────────────────────────────────────────────────────────────────

/** Every generation, with coverage, health, and whether it can be rolled back to — §2.12. */
async function list(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);
  const limit = values.limit === undefined ? 20 : asPositiveInt('--limit', values.limit);

  const [items, release, bindings] = await Promise.all([
    listGenerationItems(aws, ctx), readRelease(aws, ctx), scanBindings(aws, ctx),
  ]);

  const byGeneration = new Map();
  for (const b of bindings) {
    if (!byGeneration.has(b.generationId)) byGeneration.set(b.generationId, []);
    byGeneration.get(b.generationId).push(b);
  }

  const rows = items.slice(0, limit).map((item) => {
    const body = readBody(item) || {};
    const stats = bindingStats(byGeneration.get(item.sk) || []);
    const state = stateOf({ item, stats, release });
    return {
      generationId: item.sk,
      image: body.image || (body.spec && body.spec.image) || null,
      imageTag: body.imageTag || tagOf((body.spec || {}).image),
      specDigest: body.specDigest || null,
      createdAt: body.createdAt || null,
      createdBy: body.createdBy || null,
      ...stats,
      ...state,
      taintedAt: item.taintedAt || null,
      taintReason: item.taintReason || null,
    };
  });

  answer(out, ctx, { release: release || null, generations: rows, total: items.length },
    rows.length
      ? renderTable(['GENERATION', 'IMAGE', 'BOUND', 'HEALTH', 'STATE'], rows.map((r) => [
        r.generationId,
        r.imageTag || '—',
        String(r.live),
        r.bound ? `${r.ok} ok${r.failed ? `, ${r.failed} failed` : ''}` : '—',
        r.state,
      ]))
      : 'no generations — cut one with `archie generation create --image <tag>`');
  return undefined;
}

/** One generation: its declared spec and its per-agent bindings — §2.12. */
async function show(ctx, args, out, deps = {}) {
  const generationId = (args && args.positionals && args.positionals[0]) || (args && args.values && args.values.generation);
  if (!generationId) throw usage('archie generation show <generationId>');
  const aws = clientsFor(ctx, deps);

  const item = await requireGeneration(aws, ctx, generationId);
  const body = readBody(item) || {};
  const [release, bindings] = await Promise.all([readRelease(aws, ctx), scanBindings(aws, ctx)]);
  const rows = bindings.filter((b) => b.generationId === generationId)
    .sort((a, b) => (a.agent < b.agent ? -1 : 1));
  const stats = bindingStats(rows);
  const state = stateOf({ item, stats, release });

  // Recomputed, not trusted: the stored body is the bytes that were hashed, so a mismatch means the
  // item was edited after the fact — the one thing a self-describing rollback target must not be.
  const recomputed = body.spec ? canonicalGeneration(body.spec, deps).specDigest : null;
  if (recomputed && body.specDigest && recomputed !== body.specDigest) {
    out.warn(`stored specDigest ${body.specDigest} but the stored spec hashes to ${recomputed} — this item was edited after it was written`);
  }

  const table = rows.length
    ? renderTable(['AGENT', 'RUNTIME', 'HEALTH', 'STATE', 'STAGED'], rows.map((b) => [
      b.agent,
      b.runtimeName || '—',
      b.healthcheck || 'pending',
      b.arn ? 'live' : `reaped${b.reapedAt ? ` ${b.reapedAt}` : ''}`,
      b.stagedAt || b.createdAt || '—',
    ]))
    : 'no bindings — this generation has never been staged';

  answer(out, ctx,
    { ...body, ...state, ...stats, taintedAt: item.taintedAt || null, taintReason: item.taintReason || null, bindings: rows },
    [
      `generation ${generationId}`,
      `  image       ${body.image || '—'}`,
      `  specDigest  ${body.specDigest || '—'}`,
      `  created     ${body.createdAt || '—'} by ${body.createdBy || '—'}`,
      `  state       ${state.state || '—'}`,
      `  coverage    ${stats.live}/${stats.bound} live · ${stats.ok} ok · ${stats.failed} failed · ${stats.pending} pending`,
      '  spec',
      ...JSON.stringify(body.spec || {}, null, 2).split('\n').map((l) => `    ${l}`),
      '',
      table,
    ].join('\n'));
  return undefined;
}

// ── generation verify ────────────────────────────────────────────────────────────────────────────

/**
 * Assert every bound runtime IS what the generation declared — §2.10. Read-only. Exit 7 on mismatch.
 *
 * THIS REPLACES THE FINGERPRINT GUARANTEE that CLI-assigned names give up (plan §11), and the bug it
 * catches is real: the image was once dropped on the way to `CreateAgentRuntime`, so a runtime named
 * for one generation ran another — "a roll that looks completely successful in list-agent-runtimes
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

  const release = await readRelease(aws, ctx);
  const generationId = values.generation || (release && release.generationId);
  if (!generationId) throw usage('--generation <id> is required (there is no release pointer to default to)');

  const body = readBody(await requireGeneration(aws, ctx, generationId)) || {};
  if (!body.spec) throw new CliError(`generation ${generationId} has no spec to verify against`, { code: EXIT.FAILED });

  const bindings = (await scanBindings(aws, ctx))
    .filter((b) => b.generationId === generationId)
    .filter((b) => !values.agent || b.agent === values.agent)
    .sort((a, b) => (a.agent < b.agent ? -1 : 1));

  if (!bindings.length) {
    throw new CliError(`generation ${generationId} has no bindings${values.agent ? ` for ${values.agent}` : ''}`,
      { code: EXIT.FAILED, detail: 'nothing to verify — stage it first' });
  }

  const account = await resolveAccount(ctx, aws);
  const client = dispatcherClientFor(ctx, account, { fields: {}, env: {} }, deps);

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
    const declared = derivedSpecFor(body.spec, b.agent, deps);
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
    { generationId, checked, mismatched: mismatched.length, unreadable: unreadable.length, results },
    [
      `generation ${generationId}  ${checked - mismatched.length}/${checked} runtimes match the declared spec`,
      ...mismatched.map((m) => `  MISMATCH  ${m.agent}  ${m.changes.join(', ')}`),
      ...unreadable.map((u) => `  UNREADABLE ${u.agent}  ${u.error}`),
    ].join('\n'));

  // NOT out.failure(): a recorded per-unit failure exits 6 (PARTIAL, "re-run me"), and a runtime
  // running the wrong image is not a straggler — §2.10 fixes drift at 7 and a read failure at 1.
  if (mismatched.length) {
    throw drift(`${mismatched.length} runtime(s) do not match generation ${generationId}`,
      { detail: mismatched.map((m) => `${m.agent}: ${m.changes.join(', ')}`).join(' · ') });
  }
  if (unreadable.length) {
    throw new CliError(`could not read ${unreadable.length} runtime(s)`,
      { code: EXIT.FAILED, detail: unreadable.map((u) => u.agent).join(', ') });
  }
  return undefined;
}

module.exports = {
  build, create, list, show, verify,
  // Internals: exported for this file's tests, and because the sibling commands that READ what
  // `create` writes (stage — W1-D, release/taint — W2-B, status — W1-F) should decode the item
  // through the same functions rather than re-deriving the key shape.
  GENERATION_PK,
  RELEASE_KEY,
  readGeneration,
  listGenerationItems,
  readBody,
  scanBindings,
  bindingStats,
  stateOf,
  canonicalGeneration,
  derivedSpecFor,
  fleetSpecFrom,
  parseSets,
  assertMakeConstraints,
  makeRecipe,
  describeImage,
};

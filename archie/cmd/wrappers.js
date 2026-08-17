'use strict';

// THIN SHELLS over machinery that already exists and already works — `config`, `grants`, `cron`,
// `dashboard`, `metrics` (RUNTIME-CLI-REFERENCE.md §2.23–§2.26).
//
// The job here is argument translation, the one dry-run convention, and honest reporting. It is
// deliberately NOT reimplementation: every refusal these commands make is a refusal the underlying
// module already encodes (the conversations freshness guard, the cron hydration marker, the
// never-delete-the-grants-policy rule), and duplicating one here would give it a second, drifting
// definition. Where a module exports something usable it is called IN PROCESS; where it is a script
// with no exports it is shelled with `child_process.execFile` — the precedent is
// archie-gateway/agent-migrate.js:56, which shells into config-resolver/hydrate.mjs exactly this way.
//
// EXPORT KEYS ARE THE FULL COMMAND KEYS, not the verbs. registry.load() tries `mod[verb]` before
// `mod[key]`, and three verbs collide across nouns here — `config hydrate` vs `cron hydrate` is the
// sharp one, and `dashboard deploy` would also shadow. A verb-keyed export would silently route
// `archie cron hydrate` into the config hydrator, which writes a different table from a git repo.
// Exporting only full keys makes `mod[verb]` undefined for every command in this file, so the
// fallback resolves and the collision cannot happen.
//
// EVERY HANDLER TAKES AN OPTIONAL 4th `deps` ARGUMENT. The dispatcher calls handler(ctx, args, out),
// so it always defaults; tests pass fakes. That keeps ONE code path — the tested one is the shipped
// one — without a mock framework and without any test needing AWS credentials or a network.

const path = require('node:path');
const fs = require('node:fs');
const childProcess = require('node:child_process');
const { CliError, EXIT, usage, refused } = require('../lib/exit');
const { makeClient } = require('../lib/aws');

// docker/ — this file lives at docker/archie/cmd/wrappers.js.
const DOCKER_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_RESOLVER = path.join(DOCKER_ROOT, 'clawdbot', 'config-resolver');
const OBSERVABILITY = path.join(DOCKER_ROOT, 'clawdbot', 'agentcore-observability');
const DISPATCHER = path.join(DOCKER_ROOT, 'archie-gateway');

const SCRIPTS = {
  hydrate: path.join(CONFIG_RESOLVER, 'hydrate.mjs'),
  validateRequires: path.join(CONFIG_RESOLVER, 'validate-requires.mjs'),
  parity: path.join(CONFIG_RESOLVER, 'parity.mjs'),
  routesParity: path.join(CONFIG_RESOLVER, 'routes-parity.mjs'),
  seedRoundtrip: path.join(CONFIG_RESOLVER, 'seed-roundtrip.mjs'),
  skillRoundtrip: path.join(CONFIG_RESOLVER, 'skill-roundtrip.mjs'),
  hydrateConversations: path.join(DISPATCHER, 'hydrate-conversations.mjs'),
  deployDashboard: path.join(OBSERVABILITY, 'deploy-dashboard.cjs'),
  deployLatencyDashboard: path.join(OBSERVABILITY, 'deploy-latency-dashboard.cjs'),
};

// The sandra config repo's default remote, mirrored from hydrate.mjs:31 so the floating-ref check
// can resolve a SHA without invoking the hydrator. GH_CONFIG_REPO overrides both.
const DEFAULT_CONFIG_REPO = 'https://github.com/example/repo';

// ── dependency seam ──────────────────────────────────────────────────────────────────────────

/**
 * Defaults for the injectable seam. Only three kinds of thing are injected: process spawning,
 * module loading (the dispatcher/observability modules this file wraps), and clocks/AWS clients.
 * Everything else is pure.
 */
function withDefaults(deps = {}) {
  return {
    ...deps,
    // Which module loaders the caller replaced — loadInsights needs to know, because it drops the
    // require cache for the real one and must not do that to an injected fake.
    overrides: new Set(Object.keys(deps.modules || {})),
    execFile: deps.execFile || childProcess.execFile,
    fs: deps.fs || fs,
    env: deps.env || process.env,
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms); })),
    // Lazy literal requires: eslint's n/no-missing-require can only check a literal path, and a
    // top-level require of marketplace.js would drag the whole dispatcher into `archie --help`.
    modules: {
      marketplace: () => require('../../archie-gateway/marketplace'),
      derivedRole: () => require('../../archie-gateway/derived-role'),
      cronHydrator: () => require('../../archie-gateway/cron-hydrator'),
      insights: () => require('../../archie-runner/agentcore-observability/insight-queries'),
      schema: () => import('../../archie-runner/config-resolver/schema.mjs'),
      caps: () => import('../../archie-runner/config-resolver/caps-from-config.mjs'),
      routingNormalize: () => import('../../archie-runner/config-resolver/routing-normalize.mjs'),
      ...(deps.modules || {}),
    },
    clients: deps.clients || null,
  };
}

// IN-PROCESS clients are built by lib/aws.makeClient — region and `--profile` credentials in one
// place, so this file cannot drift from the rest of the CLI (and cannot re-learn that
// @aws-sdk/credential-provider-node exports `defaultProvider`, not `fromNodeProviderChain`).

/** The same resolution, for a CHILD process. Built explicitly so a stray inherited var cannot win. */
function childAwsEnv(ctx) {
  const e = { AWS_REGION: ctx.region, AWS_DEFAULT_REGION: ctx.region };
  if (ctx.profile) e.AWS_PROFILE = ctx.profile;
  return e;
}

const tail = (s, n = 3) => String(s || '').split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-n).join(' · ');

/**
 * Run a script, preserving its stderr.
 *
 * `execFile`'s `err.message` line 1 is always the useless one ("Command failed: node …"), and
 * discarding the child's stderr "is what made a region mismatch look identical to an unpublished
 * image" (agent-image.js:52-56). So stderr is TEE'd to ours as it arrives (it is progress-shaped,
 * which belongs on stderr per lib/output.js) AND carried on the error's cause.
 *
 * @param opts.tolerateExit  return the non-zero result instead of throwing — for check runners that
 *                           must report every check rather than abort on the first red one.
 */
function run({ cmd = 'node', args = [], env = {}, cwd = null, label = 'subprocess', tolerateExit = false }, out, deps) {
  // An `undefined` value would reach the child as the literal string "undefined" — for AWS_PROFILE
  // that is a profile that does not exist, i.e. a credential error blamed on the wrong thing.
  const childEnv = Object.fromEntries(Object.entries({ ...deps.env, ...env }).filter(([, v]) => v !== undefined && v !== null));
  return new Promise((resolve, reject) => {
    const child = deps.execFile(cmd, args, {
      cwd: cwd || undefined,
      env: childEnv,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      const result = { stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (err.code ?? 1) : 0 };
      if (!err || tolerateExit) { resolve(result); return; }
      const cause = new Error(String(err.message || '').split('\n')[0]);
      cause.name = 'SubprocessFailed';
      cause.stderr = result.stderr;
      cause.stdout = result.stdout;
      reject(new CliError(`${label} failed (exit ${result.code})`, {
        code: EXIT.FAILED,
        detail: tail(result.stderr) || tail(result.stdout) || cause.message,
        cause,
      }));
    });
    if (child && child.stderr) child.stderr.on('data', (c) => out.verbose(String(c).trimEnd()));
    if (child && child.stdout) child.stdout.on('data', (c) => out.verbose(String(c).trimEnd(), 2));
  });
}

/** The LAST JSON document on stdout, or null. These scripts print logs first and their result last. */
function lastJson(stdout) {
  const text = String(stdout || '');
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  for (let i = text.indexOf('{'); i >= 0 && i < end; i = text.indexOf('{', i + 1)) {
    try {
      return JSON.parse(text.slice(i, end + 1));
    } catch (e) {
      continue;   // this `{` was prose, not the start of the document — try the next one
    }
  }
  return null;
}

/**
 * Exactly one agent id, validated.
 *
 * The same character class insight-queries.assertSafeScopeLiteral enforces, applied here so a bad id
 * is a usage error rather than a DynamoDB key built from arbitrary text. One at a time is also the
 * concurrency rule: `_mutateMarketplace` is a non-conditional whole-blob read-modify-write
 * (marketplace.js:222), so two mutations for one agent must never overlap.
 */
function oneAgent(args, what = 'agent') {
  const [id, ...rest] = args.positionals;
  if (!id) throw usage(`<${what}> is required`);
  if (rest.length) {
    throw usage(`one ${what} at a time`, {
      detail: 'Mutations for one agent must not overlap: `_mutateMarketplace` is a non-conditional '
        + 'whole-blob read-modify-write (marketplace.js:222), so two concurrent runs lose one.',
    });
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw usage(`"${id}" is not a valid ${what} id (expected [A-Za-z0-9._-]{1,128})`);
  return id;
}

// ── §2.23 config ─────────────────────────────────────────────────────────────────────────────

// PRINTED BEFORE EVERY WRITE. `hydrate.mjs:13-14` claims idempotency that holds only if the table is
// destroyed first; these are the three ways a re-run over a LIVE table is not a no-op. Saying so is
// the command's job — the operator's mental model of "idempotent" is the thing that gets people.
const HYDRATE_CONSEQUENCES = [
  'hydrate is PUT-ONLY and never deletes (migrate-to-ddb.mjs:87) — an agent or skill removed from the config repo keeps its item in the table.',
  'GRANT#* is RECOMPUTED AND OVERWRITTEN for every agent (migrate-to-ddb.mjs:49-50) — grants changed out of band (App Home installs, `archie grants reconcile`) are clobbered.',
  'AGENT#<id>/CONFIG is rewritten WHOLESALE — only items at their own sk survive, which is why the Connector pointer lives at AGENT#<id>/CONNECTOR (schema.mjs:33-35).',
];

/**
 * Resolve, and PRINT, what the hydration will actually read.
 *
 * With --sandra-dir the content comes from whatever that working copy is on. Without it, hydrate.mjs
 * clones a MOVING ref (hydrate.mjs:84-86), so the SHA is resolved here and printed — running against
 * a floating ref is allowed, running against one silently is not. GIT_TERMINAL_PROMPT=0 keeps a
 * private repo without a token a fast failure instead of a hung credential prompt.
 */
async function resolveSandraSource({ sandraDir, ref }, out, deps) {
  if (sandraDir) {
    const git = (a) => run({ cmd: 'git', args: ['-C', sandraDir, ...a], tolerateExit: true, label: 'git' }, out, deps);
    const sha = (await git(['rev-parse', 'HEAD'])).stdout.trim();
    const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
    if (!sha) {
      out.warn(`${sandraDir} is not a git working copy — its provenance cannot be reported`);
      return { kind: 'dir', dir: sandraDir, ref: null, sha: null };
    }
    return { kind: 'dir', dir: sandraDir, ref: branch || null, sha };
  }
  const repo = deps.env.GH_CONFIG_REPO || DEFAULT_CONFIG_REPO;
  const r = await run({
    cmd: 'git', args: ['ls-remote', repo, ref], tolerateExit: true, label: 'git ls-remote',
    env: { GIT_TERMINAL_PROMPT: '0' },
  }, out, deps);
  const sha = (r.stdout.split(/\s/)[0] || '').trim();
  if (r.code !== 0 || !sha) {
    // Not fatal, but never silent: with no --sandra-dir this run tracks a ref that moves under it.
    out.warn(`could not resolve ${repo}#${ref} to a SHA (${tail(r.stderr, 1) || `exit ${r.code}`}) — `
      + 'the clone tracks a MOVING ref, so this run is not reproducible');
    return { kind: 'clone', repo, ref, sha: null };
  }
  return { kind: 'clone', repo, ref, sha };
}

const describeSource = (s) => (s.kind === 'dir'
  ? `${s.dir} (${s.ref || 'unknown ref'}${s.sha ? ` @ ${s.sha.slice(0, 12)}` : ''})`
  : `${s.repo}#${s.ref}${s.sha ? ` @ ${s.sha.slice(0, 12)}` : ' @ UNRESOLVED (floating)'}`);

async function configHydrate(ctx, args, out, deps) {
  const sandraDir = args.values['sandra-dir'] || deps.env.SANDRA_DIR || null;
  const ref = args.values.ref || deps.env.SANDRA_REF || 'main';
  const table = ctx.resources.configTable;
  // Comma-separated CONFIG-REPO names. Forwarded verbatim: the names are validated against the repo
  // by migrate-to-ddb, which is the only thing that has the repo in front of it. Resolving them here
  // would mean a second opinion about which agents exist.
  const agents = String(args.values.agents || '').split(',').map((a) => a.trim()).filter(Boolean);

  for (const line of HYDRATE_CONSEQUENCES) out.progress(line);
  if (agents.length) {
    out.progress(`SCOPED to ${agents.length} agent(s): ${agents.join(', ')} — this writes ONLY these `
      + 'agents plus the fleet-wide skill library. It does NOT make them the only agents in the '
      + 'table: hydrate never deletes, so every other agent already there is left exactly as it is.');
  }
  const source = await resolveSandraSource({ sandraDir, ref }, out, deps);
  out.progress(`source: ${describeSource(source)} → ${table}`);

  if (!sandraDir && !deps.env.GH_CONFIG_TOKEN && !deps.env.GH_CONFIG_TOKEN_SECRET) {
    out.warn('neither GH_CONFIG_TOKEN nor GH_CONFIG_TOKEN_SECRET is set — hydrate.mjs will clone unauthenticated');
  }

  if (ctx.dryRun) {
    out.progress(`would run: node ${SCRIPTS.hydrate}`);
    return { dryRun: true, table, source, consequences: HYDRATE_CONSEQUENCES, ...(agents.length ? { agents } : {}) };
  }

  const { stdout } = await run({
    args: [SCRIPTS.hydrate],
    cwd: CONFIG_RESOLVER,
    label: 'config hydrate (hydrate.mjs)',
    env: {
      ...childAwsEnv(ctx),
      AGENT_CONFIG_TABLE: table,
      SANDRA_REF: ref,
      ...(sandraDir ? { SANDRA_DIR: sandraDir } : {}),
      ...(agents.length ? { HYDRATE_AGENTS: agents.join(',') } : {}),
    },
  }, out, deps);
  return { table, source, ...(agents.length ? { agents } : {}), log: tail(stdout, 2) };
}

async function configHydrateConversations(ctx, args, out, deps) {
  const file = args.values.file || null;
  const s3 = args.values.s3 || null;
  if (!file && !s3) throw usage('one of --file <path> or --s3 s3://bucket/key is required');
  if (file && s3) throw usage('--file and --s3 are mutually exclusive');
  const table = ctx.resources.configTable;

  // No --force pass-through, on purpose. The 6h freshness guard is the one failure no
  // ConditionExpression can catch — a snapshot taken before a prune resurrects retired
  // conversations, and 12 prod agents sit at the 100 cap (hydrate-conversations.mjs:23-25,61-73).
  // The safe move is a fresh snapshot, which costs minutes. `--force` exists on the script for the
  // first hydration into an EMPTY table; that is a once-ever run, not a CLI surface.
  out.progress(`${ctx.dryRun ? 'planning' : 'applying'} conversations ${file ? `from ${file}` : `from ${s3}`} → ${table}`);

  const spec = {
    args: [SCRIPTS.hydrateConversations, ...(file ? ['--file', file] : ['--s3', s3])],
    cwd: DISPATCHER,
    label: 'config hydrate-conversations',
    env: {
      ...childAwsEnv(ctx),
      AGENT_CONFIG_TABLE: table,
      // The script's own dry-run IS the default; APPLY is opt-in, which is exactly ctx.dryRun.
      ...(ctx.dryRun ? {} : { HYDRATE_APPLY: '1' }),
    },
  };

  let result;
  try {
    result = lastJson((await run(spec, out, deps)).stdout);
  } catch (e) {
    // Exit 1 with a parseable report means "malformed rows", not "the run broke" — the report is the
    // answer and the malformed rows are per-unit failures. Anything without a report rethrows.
    const report = e.cause && lastJson(e.cause.stdout);
    if (!report) throw e;
    result = report;
  }

  for (const bad of (result && result.malformed) || []) {
    if (typeof bad === 'object') out.failure({ agent: bad.agentId, step: 'malformed-conversation', error: new Error(bad.error) });
  }
  for (const err of (result && result.errors) || []) {
    out.failure({ agent: err.agentId, step: 'put-conversation', error: new Error(err.error) });
  }
  return { table, dryRun: ctx.dryRun, ...(result || {}) };
}

/**
 * Run one gate and classify it three ways, not two.
 *
 * "A check that cannot RUN is not a check that passed" (deploy-dashboard.cjs:155-157). A missing
 * items/ directory is the common case here — the round-trip gates read what extract.mjs produced —
 * and reporting that as green is the failure mode this whole surface exists to remove.
 */
async function gate({ name, script, argv = [], env = {}, cwd, requires = [], onFail = null }, out, deps) {
  const missing = requires.filter((p) => !deps.fs.existsSync(p));
  if (missing.length) {
    out.warn(`${name}: UNRUNNABLE — missing ${missing.map((m) => path.relative(DOCKER_ROOT, m)).join(', ')}`);
    return { name, ok: false, unrunnable: true, reason: `missing ${missing.map((m) => path.relative(DOCKER_ROOT, m)).join(', ')}` };
  }
  const r = await run({ args: [script, ...argv], cwd, env, tolerateExit: true, label: name }, out, deps);
  const ok = r.code === 0;
  out.progress(`${name}: ${ok ? 'PASS' : 'FAIL'} (exit ${r.code})`);
  if (!ok && onFail) out.warn(`${name}: ${onFail}`);
  return { name, ok, exit: r.code, summary: tail(ok ? r.stdout : r.stderr || r.stdout, 2), report: lastJson(r.stdout) };
}

/**
 * The routing ambiguity gate, in process.
 *
 * routing-normalize.mjs is a library with no CLI, so this is the only way to run it. The assertion
 * comes from that module rather than being restated here, so there is one definition of what counts
 * as ambiguous. It refuses >1 channel or >1 DM — an agent with one of each is DECIDED (the DM wins,
 * per scopeIdFor / scopeIdForRouting) and passes.
 */
async function routingSingleSourceGate(out, deps) {
  const dir = path.join(CONFIG_RESOLVER, 'items', 'routing');
  if (!deps.fs.existsSync(dir)) {
    out.warn('routing-single-source: UNRUNNABLE — config-resolver/items/routing is absent (run extract.mjs first)');
    return { name: 'routing-single-source', ok: false, unrunnable: true, reason: 'items/routing absent' };
  }
  const { assertSingleSource } = await deps.modules.routingNormalize();
  const violations = [];
  let checked = 0;
  for (const f of deps.fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const id = f.slice(0, -5);
    const cfg = JSON.parse(deps.fs.readFileSync(path.join(dir, f), 'utf-8'));
    try {
      assertSingleSource(id, cfg.routing || cfg);
      checked += 1;
    } catch (e) {
      violations.push({ agent: id, error: e.message });
    }
  }
  const ok = violations.length === 0;
  out.progress(`routing-single-source: ${ok ? 'PASS' : 'FAIL'} (${checked} agents)`);
  return { name: 'routing-single-source', ok, checked, violations };
}

/** Exit 0 or 7 — reference §2.23. Anything that is not a clean pass is DRIFT, including unrunnable. */
function finishGates(gates, out) {
  const bad = gates.filter((g) => !g.ok);
  if (!bad.length) return { gates, ok: true };
  // Emit the per-gate report BEFORE throwing. The dispatcher only calls out.answer() on a clean
  // return, so a red run would otherwise carry `result: null` in the envelope — the exit code alone
  // does not say WHICH gate went red, which is the only thing the operator needs next.
  out.answer({ gates, ok: false });
  for (const g of bad) out.warn(`gate ${g.name}: ${g.unrunnable ? `could not run (${g.reason})` : 'failed'}`);
  throw new CliError(`${bad.length} of ${gates.length} gate(s) did not pass`, {
    code: EXIT.DRIFT,
    detail: bad.map((g) => `${g.name}${g.unrunnable ? ' (unrunnable)' : ''}`).join(', '),
  });
}

async function configValidate(ctx, args, out, deps) {
  // Local gates only — `config validate` is declared needsAws:false and must stay that way.
  const gates = [
    await gate({
      name: 'requires-closure',
      script: SCRIPTS.validateRequires,
      cwd: CONFIG_RESOLVER,
      requires: [path.join(CONFIG_RESOLVER, 'items', 'skill-catalog.json')],
    }, out, deps),
    await routingSingleSourceGate(out, deps),
    await gate({
      name: 'resolver-parity',
      script: SCRIPTS.parity,
      cwd: CONFIG_RESOLVER,
      requires: [path.join(CONFIG_RESOLVER, 'ground-truth', '_manifest.json'), path.join(CONFIG_RESOLVER, 'resolved')],
      // `resolved/` is a BUILD ARTIFACT, and a checked-in stale copy fails this gate for a reason
      // that has nothing to do with the config repo. Say which red this is — a red whose cause is
      // "you did not regenerate the inputs" is otherwise indistinguishable from a real regression.
      onFail: 'compares config-resolver/resolved/ against ground-truth/ — both are generated. '
        + 'Re-run capture-ground-truth.mjs + extract.mjs + resolve.mjs before reading this as a regression.',
    }, out, deps),
  ];
  return finishGates(gates, out);
}

async function configParity(ctx, args, out, deps) {
  // These gates are CHILD processes and reach DynamoDB themselves, so they take the profile through
  // the environment (childAwsEnv) rather than through lib/aws.
  const env = { ...childAwsEnv(ctx), AGENT_CONFIG_TABLE: ctx.resources.configTable };
  const agentsDir = deps.env.AGENT_VE2BNZS_DIR || null;
  const skillsDir = deps.env.SANDRA_SKILLS_DIR || null;
  // A round-trip with no git source compares DDB against the EXTRACTED items — self-consistency,
  // not parity with the authored source. Degraded is not failed, but it must not read as the
  // stronger check either.
  if (!agentsDir) out.warn('AGENT_VE2BNZS_DIR unset — seed round-trip degrades to self-consistency (DDB vs items/), not git parity');
  if (!skillsDir) out.warn('SANDRA_SKILLS_DIR unset — skill round-trip degrades to self-consistency (DDB vs items/), not git parity');

  const gates = [
    await gate({
      name: 'routes-parity', script: SCRIPTS.routesParity, cwd: CONFIG_RESOLVER, env,
      requires: [path.join(CONFIG_RESOLVER, 'items', 'routing')],
    }, out, deps),
    await gate({
      name: 'seed-roundtrip', script: SCRIPTS.seedRoundtrip, cwd: CONFIG_RESOLVER, env,
      argv: agentsDir ? [agentsDir] : [],
      requires: [path.join(CONFIG_RESOLVER, 'items', 'seed')],
    }, out, deps),
    await gate({
      name: 'skill-roundtrip', script: SCRIPTS.skillRoundtrip, cwd: CONFIG_RESOLVER, env,
      argv: skillsDir ? [skillsDir] : [],
      requires: [path.join(CONFIG_RESOLVER, 'items', 'skills')],
    }, out, deps),
  ];
  return finishGates(gates, out);
}

// ── §2.24 grants ─────────────────────────────────────────────────────────────────────────────

/**
 * The clients the grant path needs, built once.
 *
 * `iamCmds` is the command NAMESPACE, not instances — putDerivedGrants does `new C.PutRolePolicyCommand`.
 */
function grantClients(ctx, deps) {
  if (deps.clients) return deps.clients;
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  const iamCmds = require('@aws-sdk/client-iam');
  const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  return {
    doc: DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient')),
    iam: makeClient(ctx, '@aws-sdk/client-iam', 'IAMClient'),
    iamCmds,
    sts: makeClient(ctx, '@aws-sdk/client-sts', 'STSClient'),
    stsCmds: { GetCallerIdentityCommand },
  };
}

async function resolveAccount(ctx, clients) {
  if (ctx.account) return ctx.account;
  const r = await clients.sts.send(new clients.stsCmds.GetCallerIdentityCommand({}));
  return r.Account;
}

/**
 * The Connector secret prefix the role policy must keep granting.
 *
 * derived-role.credentialSecretBase() reads CONNECTOR_API_KEY_SECRET from the environment, and "BOTH
 * writers of the `grants` policy must set it: a rewrite that omitted it would silently revoke a
 * migrated agent's key". Terraform sets it to `${var.name}-connector-api-key` (secrets.tf:61), so it
 * follows the same one knob as every other name. An explicit env var still wins — an adopted stack
 * may point at a legacy secret.
 *
 * It is written into the ENVIRONMENT because credentialSecretBase() reads process.env directly
 * (derived-role.js:105) — there is no parameter to thread it through.
 */
function applyConnectorSecretEnv(ctx, deps) {
  if (!deps.env.CONNECTOR_API_KEY_SECRET) deps.env.CONNECTOR_API_KEY_SECRET = `${ctx.name}-connector-api-key`;
  return deps.env.CONNECTOR_API_KEY_SECRET;
}

/**
 * Read GRANT#<agent>/SCOPE#* and DISTINGUISH ABSENCE FROM FAILURE.
 *
 * derived-role.readAgentCaps() answers [] for an unparseable item as well as a missing one, which is
 * fine for its caller (a provision that rebuilds the document) and NOT fine here: this value is
 * about to be written back as the agent's whole grant. "A miss and a failure are different things" —
 * `getData(...) || {}` is how an expired token mid-run rewrote the fleet's skill library down to one
 * BDD test skill with nothing failing (ddb-seed.js:17-31). A missing item is a real answer (a
 * no-cap agent still gets the policy, for its config read); a broken one aborts.
 */
async function readStoredGrant(clients, table, agentId, deps) {
  const { agentGrantKey, grantedCaps } = await deps.modules.schema();
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const r = await clients.doc.send(new GetCommand({ TableName: table, Key: agentGrantKey(agentId, '*') }));
  if (!r.Item) return { present: false, caps: [], grant: {} };
  if (r.Item.data == null) return { present: true, caps: [], grant: {} };
  let grant;
  try {
    grant = JSON.parse(r.Item.data);
  } catch (e) {
    throw new CliError(`GRANT#${agentId}/SCOPE#* is present but unparseable — refusing to rewrite IAM from it`, {
      code: EXIT.REFUSED,
      cause: e,
      detail: 'An unreadable grant is a FAILURE, not an empty grant. Fix or re-run `archie grants reconcile`.',
    });
  }
  return { present: true, caps: grantedCaps(grant), grant };
}

/**
 * Rewrite the inline `grants` policy from a caps list. Shared by both commands.
 *
 * Never deletes: an empty caps list still writes the policy, because it is the agent's ONLY
 * config-table access (agentcore-base carries no DynamoDB statement) and deleting it "revoked the
 * agent's config read, breaking its next boot" (derived-role.js:192-198). The scope is assembled
 * inside putDerivedGrants from the agent id — never passed in pre-built.
 */
async function writeRolePolicy({ ctx, clients, agentId, caps }, out, deps) {
  const account = await resolveAccount(ctx, clients);
  const secretBase = applyConnectorSecretEnv(ctx, deps);
  out.verbose(`role policy: agent=${agentId} caps=${caps.length ? caps.join(',') : '(none — the policy is still written, for the config read)'} credentialSecretBase=${secretBase}`);
  const { putDerivedGrants } = deps.modules.derivedRole();
  const r = await putDerivedGrants({
    clients: { iam: clients.iam, iamCmds: clients.iamCmds, doc: clients.doc },
    agentId,
    caps,
    account,
    region: ctx.region,
    table: ctx.resources.configTable,
  });
  // NoSuchEntity is reported, not thrown: the role exists only once the agent has been provisioned,
  // and a cold provision builds the full document itself (derived-role.js:214-219). Exit 0.
  if (!r.applied) out.warn(`role ${r.roleName} does not exist yet (${r.reason}) — the cold provision will build it; nothing to repair`);
  else out.progress(`rewrote inline \`grants\` policy on ${r.roleName} (${caps.length} cap(s))`);
  return { ...r, caps, account };
}

async function grantsReconcile(ctx, args, out, deps) {
  const agentId = oneAgent(args);
  const table = ctx.resources.configTable;
  const clients = grantClients(ctx, deps);
  const marketplace = deps.modules.marketplace();

  // A FAILED catalog read must never look like an empty catalog.
  const loaded = await marketplace.loadMarketplaceDataFromDdb(clients.doc, table);
  if (loaded && loaded.error) {
    throw new CliError(`could not load the skill catalog from ${table}`, { code: EXIT.FAILED, detail: loaded.error });
  }
  // An unloaded/empty catalog derives no skill caps and would wrongly strip everything
  // (marketplace.js:251-256). `grants apply` is the safe command in that state — it rewrites IAM
  // from GRANT#* as stored and recomputes nothing.
  if (!loaded || !loaded.catalogSkills) {
    throw refused(`the skill catalog in ${table} is empty or unloaded — reconcile would derive no skill caps and strip this agent's grants`, {
      detail: 'Hydrate the catalog (`archie config hydrate`), or use `archie grants apply` to repair IAM from the stored grant.',
    });
  }

  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const { agentConfigKey } = await deps.modules.schema();
  const cfgItem = await clients.doc.send(new GetCommand({ TableName: table, Key: agentConfigKey(agentId) }));
  if (!cfgItem.Item) {
    throw refused(`no AGENT#${agentId}/CONFIG item in ${table} — reconcile would write a grant derived from an empty config`, {
      detail: 'Check the agent id, or hydrate first. An absent config is not a config with no caps.',
    });
  }
  const cfg = cfgItem.Item.data ? JSON.parse(cfgItem.Item.data) : {};
  const agentInstalls = (marketplace.getInstalls().installs || {})[agentId] || {};

  // Preview from the SAME source of truth the write uses (capsWithSources), so a dry run cannot
  // disagree with the apply.
  const { capsWithSources, grantedCaps } = await deps.modules.caps();
  const before = await readStoredGrant(clients, table, agentId, deps);
  const next = capsWithSources(cfg, agentInstalls, marketplace.getCatalog(), agentId);
  const nextCaps = grantedCaps(next);
  const added = nextCaps.filter((c) => !before.caps.includes(c));
  const removed = before.caps.filter((c) => !nextCaps.includes(c));
  out.progress(`GRANT#${agentId}: ${before.caps.length} → ${nextCaps.length} cap(s)`
    + `${added.length ? ` +[${added.join(',')}]` : ''}${removed.length ? ` -[${removed.join(',')}]` : ''}`);

  if (ctx.dryRun) {
    return { dryRun: true, agent: agentId, table, catalogSkills: loaded.catalogSkills, caps: nextCaps, added, removed, grant: next };
  }

  // The full existing path: recompute GRANT#* and write it. The derived-role hook is NOT wired in
  // this process (index.js injects it in the dispatcher), so the IAM half is done explicitly below —
  // and here it is FATAL. In the dispatcher it is deliberately non-fatal (marketplace.js:285-287),
  // which is exactly the silent drift `grants apply` exists to repair.
  const caps = await marketplace._reconcileSkillGrant(clients.doc, table, agentId, agentInstalls);
  if (caps === null) {
    throw refused('the marketplace reconcile skipped — the catalog was not loaded at write time', {
      detail: 'Nothing was written. Re-run, or use `archie grants apply`.',
    });
  }
  const role = await writeRolePolicy({ ctx, clients, agentId, caps }, out, deps);
  return { agent: agentId, table, caps, added, removed, role: role.roleName, iamApplied: role.applied, reason: role.reason || null };
}

async function grantsApply(ctx, args, out, deps) {
  const agentId = oneAgent(args);
  const table = ctx.resources.configTable;
  const clients = grantClients(ctx, deps);

  // Rewrite IAM ONLY, from GRANT#* AS STORED. No recomputation — that is the whole point: this is
  // the repair for "row updated, IAM stale", and it is the only safe command when the catalog is
  // unloaded (§2.24).
  const stored = await readStoredGrant(clients, table, agentId, deps);
  if (!stored.present) {
    out.warn(`no GRANT#${agentId}/SCOPE#* item — writing the policy with no caps (it still carries the agent's config read)`);
  }
  out.progress(`applying stored grant for ${agentId}: ${stored.caps.length} cap(s)`);

  if (ctx.dryRun) {
    return { dryRun: true, agent: agentId, table, caps: stored.caps, grantPresent: stored.present };
  }
  const role = await writeRolePolicy({ ctx, clients, agentId, caps: stored.caps }, out, deps);
  return { agent: agentId, table, caps: stored.caps, role: role.roleName, iamApplied: role.applied, reason: role.reason || null };
}

// ── §2.25 cron ───────────────────────────────────────────────────────────────────────────────

/**
 * The dispatcher's manager API — the ONLY writer of the cron store.
 *
 * cron-store.js holds an authoritative in-memory cache and assumes it is the sole writer (which is
 * why the service runs at desired_count = 1); a direct `/efs/cron` write is silently overwritten.
 * So this file has no filesystem path to the store at all — only HTTP.
 *
 * The URL is not derivable: it is a Cloud Map internal name (`http://dispatcher.<ns>:9090`,
 * main.tf:26) reachable only from inside the VPC. Env, or a clear refusal.
 */
async function managerApi(ctx, out, deps) {
  if (deps.managerApi) return deps.managerApi;
  const baseUrl = deps.env.MANAGER_API_URL || deps.env.DISPATCHER_BASE_URL;
  if (!baseUrl) {
    throw refused('no manager API URL — set MANAGER_API_URL (or DISPATCHER_BASE_URL)', {
      detail: 'The cron store has exactly one writer (the dispatcher). Its URL is the Cloud Map internal '
        + 'name http://dispatcher.<namespace>:<port> (main.tf:26) and is only reachable from inside the VPC.',
    });
  }
  let secret = deps.env.DISPATCHER_SHARED_SECRET;
  if (!secret) {
    // Terraform names it `${var.name}-dispatcher-shared-secret` (secrets.tf:44) — one knob again.
    const { GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
    const id = deps.env.DISPATCHER_SHARED_SECRET_ID || `${ctx.name}-dispatcher-shared-secret`;
    out.verbose(`resolving the dispatcher shared secret from Secrets Manager (${id})`);
    const sm = makeClient(ctx, '@aws-sdk/client-secrets-manager', 'SecretsManagerClient');
    const r = await sm.send(new GetSecretValueCommand({ SecretId: id }));
    secret = r.SecretString;
  }
  return deps.modules.cronHydrator().createManagerApi({ baseUrl, secret });
}

async function cronList(ctx, args, out, deps) {
  const agentId = oneAgent(args);
  const api = await managerApi(ctx, out, deps);
  const jobs = await api.list(agentId);
  const enabled = jobs.filter((j) => j.enabled !== false).length;
  out.progress(`${agentId}: ${jobs.length} job(s), ${enabled} enabled`);
  return { agent: agentId, jobs, count: jobs.length, enabled };
}

/**
 * `archie cron runner <scope> [--set openclaw|agentcore]` — the CRON_RUNNER flag (§3a').
 *
 * TAKES THE SCOPE ID, not the legacy agent name, and that is not a detail: the flag is keyed by the
 * identity that OWNS the jobs in archie's store (`dm-<user>` / `ch-<channel>`), which is what
 * `cron hydrate` resolves and stores under. Passing `agent-xx9aff` here would read and write a
 * row nothing consults. `cron list` has the same contract.
 *
 * Goes through the manager API rather than DynamoDB directly for the reason every cron write does:
 * the dispatcher caches the resolved flag, and a write behind its back would be honoured only after
 * the cache expired — a flip that appears to have worked and has not.
 *
 * A read is free; a --set is a cutover, so it honours --dry-run like every other mutation here.
 */
async function cronRunner(ctx, args, out, deps) {
  const agentId = oneAgent(args);
  const want = args.values.set;
  const api = await managerApi(ctx, out, deps);
  const current = await api.getRunner(agentId);
  out.progress(`${agentId}: CRON_RUNNER=${current.runner} (${current.source}${current.setBy ? `, set by ${current.setBy}` : ''})`);
  if (!want) return { agent: agentId, ...current };
  if (want === current.runner) {
    out.progress(`already ${want} — nothing to change`);
    return { agent: agentId, ...current, changed: false };
  }
  out.progress(`${want === 'agentcore' ? 'archie will START' : 'archie will STOP'} firing ${agentId}'s jobs on its next tick`);
  if (ctx.dryRun) return { dryRun: true, agent: agentId, from: current.runner, to: want };
  const result = await api.setRunner(agentId, want, { by: `archie:${deps.env.USER || 'cli'}` });
  return { agent: agentId, from: current.runner, ...result, changed: true };
}

/**
 * `archie cron hydrate <agent>` — GATEWAY-OWNERSHIP-PLAN.md §8/§E1.
 *
 * TWO MODES, and the split is not a convenience. The hydrator must read the PARENT access point
 * (<prefix>/agents, fleet-wide read) which exists on a Fargate task and nowhere else — certainly not
 * on a laptop. So from a laptop this composes an EPHEMERAL task definition around that access point,
 * runs it once, and deregisters it; INSIDE that task, `cron-hydrator.js` runs directly and this code
 * is not involved.
 *
 * MOUNT_PATH being set is what distinguishes them, and it is a fact about the environment rather than
 * a flag: if the agents tree is already mounted here, running in-process is both possible and
 * cheaper. That is the path the tests and the container itself take.
 *
 * THE PREVIEW MOVED WITH THE WORK. In-process, it is computed here and printed before anything is
 * posted. Remote, it is computed and logged INSIDE the task — by the same planner, over the same
 * files — and reaches you in the task's log tail. It could not be computed locally: the whole reason
 * for the task is that these files are not readable from here.
 */
async function cronHydrate(ctx, args, out, deps) {
  const agentId = oneAgent(args);
  const mountDir = deps.env.MOUNT_PATH;
  const ownerAgentId = await resolveCronOwner(ctx, args, out, deps, agentId);

  out.progress(`${agentId}: WIPES ${ownerAgentId}'s cron store, then seeds from ${agentId}'s EFS directory`);
  return mountDir
    ? cronHydrateInProcess(ctx, args, out, deps, { agentId, ownerAgentId, mountDir })
    : cronHydrateViaTask(ctx, args, out, deps, { agentId, ownerAgentId });
}

/**
 * Which archie identity OWNS the jobs — §8.10 identity=scope.
 *
 * The legacy OpenClaw name is a PATH on EFS, not an identity here. Storing jobs under it produces an
 * agent no Slack event resolves to: the jobs run, but the owner's App Home is empty and the agent has
 * no config, runtime or grants. That happened live on 2026-08-16 — three jobs under
 * `agent-xx9aff` while every message went to `dm-ux0mz5ckp2r`.
 *
 * Resolution order, and there is deliberately NO fallback to the legacy name:
 *   --as <id>       an explicit override, for when config has not been hydrated yet
 *   AGENT#<id>/META routing → scopeIdForRouting() — the SAME rule the dispatcher mints with.
 *                   Hits when the caller passed a scope id, or a legacy item still exists.
 *   META.efsRoot    the §8.10 rename link: find the scope-keyed agent that ADOPTED this legacy
 *                   directory. Since `eb14aeefa` hydration writes ONLY the scope id — no legacy
 *                   items, no separate rekey — so `AGENT#<legacy>/META` no longer exists for any
 *                   agent and the step above can never hit for a legacy name. Without this every
 *                   invocation needed `--as`, which is exactly the guess this command refuses to
 *                   make. `efsRoot` is the same field the dispatcher's `legacyAgentIdFor` and the
 *                   Connector adopt path resolve through, so there is one link, not three.
 *   otherwise       REFUSE. Guessing is what created the split identity in the first place.
 */
async function resolveCronOwner(ctx, args, out, deps, agentId) {
  const explicit = args.values.as;
  if (explicit) {
    out.progress(`owner       ${explicit}  (--as, not derived from routing)`);
    return explicit;
  }

  const { scopeIdForRouting } = deps.modules.agentScope
    ? deps.modules.agentScope()
    : require('../../archie-gateway/agent-scope');

  const meta = await readAgentRouting(ctx, deps, agentId);
  if (!meta) {
    // The §8.10 rename link, before refusing: this name is a legacy EFS directory, and the agent
    // that adopted it records it as `META.efsRoot`.
    const adopted = await findAgentByEfsRoot(ctx, deps, agentId);
    if (adopted) {
      out.progress(`owner       ${adopted}  (§8.10 scope id, adopted efsRoot=${agentId})`);
      return adopted;
    }
    throw refused(`no routing config for ${agentId} — cannot tell which identity owns its cron jobs`, {
      detail: `Neither AGENT#${agentId}/META nor any agent with META.efsRoot=${agentId} is in `
        + `${ctx.resources.configTable}. Run \`archie config hydrate --agents ${agentId}\` first, or pass `
        + '--as <scope-id> if you know it. Refusing to store the jobs under the legacy name: that '
        + 'creates an agent no Slack event routes to, whose App Home is empty and whose jobs run '
        + 'under an identity with no config, runtime or grants.',
    });
  }
  const scopeId = scopeIdForRouting(meta);
  if (!scopeId) {
    throw refused(`${agentId} has neither dm_users nor channels — no scope identity to own its jobs`, {
      detail: 'An agent that routes nothing cannot be scope-keyed. Pass --as <scope-id> if this agent '
        + 'should nonetheless own jobs.',
    });
  }
  out.progress(`owner       ${scopeId}  (§8.10 scope id, from ${agentId} routing)`);
  return scopeId;
}

/** The agent's routing META — the same item the dispatcher's routing GSI is built from. */
async function readAgentRouting(ctx, deps, agentId) {
  if (deps.agentRouting) return deps.agentRouting(agentId);
  const { makeClient } = require('../lib/aws');
  const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = deps.doc || DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient'));
  const r = await doc.send(new GetCommand({
    TableName: ctx.resources.configTable, Key: { pk: `AGENT#${agentId}`, sk: 'META' },
  }));
  if (!r.Item) return null;
  try {
    return typeof r.Item.data === 'string' ? JSON.parse(r.Item.data) : (r.Item.data || null);
  } catch {
    return null;
  }
}

/**
 * The scope-keyed agent that ADOPTED a legacy EFS directory, or null.
 *
 * §8.10 renamed every migrated agent, and `META.efsRoot` is what carries the old name across — the
 * same field `fleet drift` uses to tell a legitimate legacy adopt from data loss, and the same one
 * the dispatcher's `legacyAgentIdFor` reads to decide an agent is not new. Resolving through it
 * here means the legacy→scope link has ONE definition rather than one per command.
 *
 * Routed agents only, via the routing GSI: an agent with no routing has no scope identity to own
 * jobs, which is the case the caller below refuses anyway. That also bounds this to the fleet size
 * rather than a full table scan.
 */
async function findAgentByEfsRoot(ctx, deps, legacyName) {
  if (deps.agentByEfsRoot) return deps.agentByEfsRoot(legacyName);
  const { makeClient } = require('../lib/aws');
  const { DynamoDBDocumentClient, QueryCommand, BatchGetCommand } = require('@aws-sdk/lib-dynamodb');
  const doc = deps.doc || DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient'));
  const table = ctx.resources.configTable;

  const ids = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table,
      IndexName: 'routing',
      KeyConditionExpression: 'gsi1pk = :p',
      ExpressionAttributeValues: { ':p': 'ROUTING' },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) if (it.gsi1sk) ids.push(it.gsi1sk);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  for (let i = 0; i < ids.length; i += 100) { // BatchGetItem caps at 100 keys
    const Keys = ids.slice(i, i + 100).map((id) => ({ pk: `AGENT#${id}`, sk: 'META' }));
    const r = await doc.send(new BatchGetCommand({ RequestItems: { [table]: { Keys } } }));
    for (const it of (r.Responses || {})[table] || []) {
      let meta;
      try { meta = typeof it.data === 'string' ? JSON.parse(it.data) : it.data; } catch { continue; }
      const root = String((meta && meta.efsRoot) || '');
      // efsRoot is the bare legacy name today; it was a full path before eb14aeefa, so match the
      // last segment either way rather than assuming which era wrote the item.
      if (root && root.split('/').filter(Boolean).pop() === legacyName) {
        return String(it.pk).replace(/^AGENT#/, '');
      }
    }
  }
  return null;
}

/** The agents tree is mounted here (inside the hydrator task, or a test). Seed directly. */
async function cronHydrateInProcess(ctx, args, out, deps, { agentId, ownerAgentId, mountDir }) {
  const api = await managerApi(ctx, out, deps);
  const hydrator = deps.modules.cronHydrator();

  // What this run will seed — computed from the SAME planner the seed uses, and printed BEFORE
  // anything is posted. 79 of 259 enabled prod jobs are in a failing state, and "cutover would
  // quietly resurrect all of them at once, in a single burst, into people's DMs"
  // (cron-hydrator.js:388-390). A count is the difference between a decision and a surprise.
  const parsed = hydrator.readAgentCron(mountDir, agentId, deps.fs);
  const plan = hydrator.buildBodies({ owner: ownerAgentId, legacy: agentId }, parsed, deps.now());
  const wouldPost = plan.bodies.length;
  const wouldEnable = plan.bodies.filter((b) => b.enabled !== false).length;
  const preview = {
    onEfs: parsed.jobs.length,
    wouldPost,
    wouldEnable,
    seededDisabledPendingReview: plan.needsReview.length,
    seededDisabledUnroutableChannel: plan.degraded.length,
    skipped: plan.skipped.length,
    dropped: plan.dropped.length,
  };
  out.progress(`${agentId}: ${preview.onEfs} job(s) on EFS → would post ${wouldPost} (${wouldEnable} ENABLED, `
    + `${preview.seededDisabledPendingReview} parked for review, ${preview.seededDisabledUnroutableChannel} parked for an unroutable channel, `
    + `${preview.skipped} skipped, ${preview.dropped} dropped by decision)`);

  // NO RE-RUN GATE. There was one — a per-agent `hydrated` marker making this one-time-at-flip,
  // refusing a second run unless --force. Removed: while OpenClaw stays authoritative archie's store
  // is a derived replica, so re-running to converge is the NORMAL operation. The preview still prints
  // first and still matters; what it no longer does is block.
  if (ctx.dryRun) {
    out.progress('dry-run: nothing purged, nothing posted — the store is untouched');
    return { dryRun: true, agent: agentId, owner: ownerAgentId, mode: 'in-process', ...preview };
  }

  const summary = await hydrator.hydrateAgent({
    agentId, ownerAgentId, mountDir, api, fs: deps.fs, now: deps.now,
    log: {
      info: (o, m) => out.verbose(`${m} ${JSON.stringify(o)}`),
      warn: (o, m) => out.warn(`${m} ${JSON.stringify(o)}`),
      error: (o, m) => out.verbose(`ERROR ${m} ${JSON.stringify(o)}`),
    },
  });
  // Surface each failed job rather than one exit code — `failures[]` names them (lib/output.js).
  for (const e of summary.errors || []) out.failure({ agent: agentId, step: `cron-seed ${e.jobId}`, error: new Error(e.err) });
  return { agent: agentId, owner: ownerAgentId, mode: 'in-process', ...preview, purged: summary.purged, posted: summary.posted, errors: summary.errors };
}

/** The normal path: register an ephemeral task around the fleet-wide-read mount, run it, drop it. */
async function cronHydrateViaTask(ctx, args, out, deps, { agentId, ownerAgentId }) {
  const { discoverFacts, readGatewayConfig } = require('../lib/deployment-facts');
  const { composeCronHydratorTaskDefinition } = require('../lib/task-definition');
  const { runEphemeralTask } = require('../lib/run-task');
  const { makeClient } = require('../lib/aws');

  const ecs = deps.ecs || makeClient(ctx, '@aws-sdk/client-ecs', 'ECSClient');
  const logs = deps.logs || makeClient(ctx, '@aws-sdk/client-cloudwatch-logs', 'CloudWatchLogsClient');

  const config = await readGatewayConfig(ctx, deps);
  const facts = await discoverFacts(ctx, config, deps);

  // THE IMAGE COMES FROM THE RUNNING GATEWAY, not from a tag. The hydrator calls the gateway's
  // manager API, so it has to speak the same version — and reading the deployed task definition is
  // the only way to be sure of that without an operator remembering to keep two tags in step.
  const deployed = await readDeployedGatewayImage(ctx, ecs, deps);
  out.progress(`image       ${deployed.image}  (the running gateway's own build)`);

  const taskDefinition = composeCronHydratorTaskDefinition({
    resources: ctx.resources,
    region: ctx.region,
    facts,
    image: deployed.image,
    agentId,
    ownerAgentId,
    parentAccessPointId: config.values.CRON_HYDRATOR_ACCESS_POINT_ID,
  });

  if (ctx.dryRun) {
    out.progress(`would register ${taskDefinition.family}, RunTask it against ${ctx.resources.cluster}, `
      + 'and deregister it');
    out.progress('dry-run: nothing purged, nothing posted — the store is untouched');
    return { dryRun: true, agent: agentId, owner: ownerAgentId, mode: 'task', taskDefinition };
  }

  const result = await runEphemeralTask({
    ecs,
    logs,
    taskDefinition,
    cluster: ctx.resources.cluster,
    subnets: facts.subnetIds,
    // ITS OWN group, not the dispatcher's: the gateway admits port 9090 only from the runtime and
    // hydrator groups, so any other choice fails as a bare "fetch failed" from the manager API call.
    securityGroups: [facts.cronHydratorSecurityGroupId],
    logGroup: ctx.resources.dispatcherLogGroup,
    streamPrefix: 'cron-hydrator',
    out,
    now: deps.now,
  });

  // The task's own output IS the report — the preview, every per-job decision, and the counts are all
  // logged in there by the same code the in-process path prints from.
  for (const line of result.logLines) out.progress(`            ${line}`);
  return { agent: agentId, owner: ownerAgentId, mode: 'task', ...result };
}

/** The image the dispatcher is actually running. */
async function readDeployedGatewayImage(ctx, ecs, deps) {
  if (deps.deployedGatewayImage) return deps.deployedGatewayImage();
  const { DescribeServicesCommand, DescribeTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
  const described = await ecs.send(new DescribeServicesCommand({
    cluster: ctx.resources.cluster, services: [ctx.resources.dispatcherService],
  }));
  const svc = (described.services || []).find((x) => x.status !== 'INACTIVE');
  if (!svc) {
    throw refused(`${ctx.resources.dispatcherService} is not running`, {
      detail: 'The hydrator runs the gateway\'s own image and calls its manager API; both need the '
        + 'gateway deployed. Run `archie gateway deploy` first.',
    });
  }
  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: svc.taskDefinition }));
  const container = (td.taskDefinition.containerDefinitions || [])[0] || {};
  return { image: container.image, taskDefinition: svc.taskDefinition };
}

/**
 * The master switch's DEPLOYED value, read from the running dispatcher's task definition.
 *
 * Same ground truth deploy-dashboard.cjs uses for the stack check, and derived from ctx.resources so
 * it cannot read another stack's service.
 */
async function readCronEnabled(ctx, deps) {
  if (deps.ecsCronEnabled) return deps.ecsCronEnabled();
  const { DescribeServicesCommand, DescribeTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
  const ecs = makeClient(ctx, '@aws-sdk/client-ecs', 'ECSClient');
  const svc = await ecs.send(new DescribeServicesCommand({
    cluster: ctx.resources.cluster, services: [ctx.resources.dispatcherService],
  }));
  const taskDefinition = svc.services && svc.services[0] && svc.services[0].taskDefinition;
  if (!taskDefinition) {
    throw new CliError(`no ECS service ${ctx.resources.cluster}/${ctx.resources.dispatcherService}`, {
      code: EXIT.PREFLIGHT,
      detail: 'Check --name and --region: this is the deployment whose cron scheduler you are asking about.',
    });
  }
  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition }));
  const env = Object.fromEntries((td.taskDefinition.containerDefinitions || [])
    .flatMap((c) => c.environment || []).map((e) => [e.name, e.value]));
  return { taskDefinition, value: env.CRON_ENABLED === 'true', raw: env.CRON_ENABLED ?? null };
}

/**
 * `cron arm` / `cron disarm` — report, and refuse to drift.
 *
 * The master switch is `CRON_ENABLED` on the dispatcher's task definition, which Terraform owns
 * (`var.cron_enabled` → dispatcher.tf:47). Flipping it from here means registering a task definition
 * behind Terraform's back: it would work for exactly as long as it takes anyone to run an apply, and
 * then silently revert — the same class of invisible drift as a direct `/efs/cron` write. So the
 * command tells you the deployed value and the one change that actually sticks.
 *
 * Already in the requested state is a genuine no-op and exits 0, which is what makes this usable as
 * a precondition check in a runbook.
 */
async function cronArming(ctx, out, deps, { want }) {
  const state = await readCronEnabled(ctx, deps);
  const now = state.value ? 'armed' : 'disarmed';
  out.progress(`cron scheduler is ${now} (CRON_ENABLED=${state.raw}) on ${state.taskDefinition}`);
  if (state.value === want) return { armed: state.value, changed: false, taskDefinition: state.taskDefinition };
  throw refused(`the cron scheduler is ${now}; arming is not a CLI-side change`, {
    detail: `CRON_ENABLED is set by Terraform (var.cron_enabled → dispatcher.tf:47). Set cron_enabled = ${want} `
      + 'in the tfvars, apply, then `archie gateway deploy`. A task definition registered from here would be '
      + 'reverted by the next apply, invisibly.',
  });
}

// ── §2.26 dashboard / metrics ────────────────────────────────────────────────────────────────

/**
 * The env that pins the observability library to THIS deployment.
 *
 * insight-queries.js resolves its log group and both EMF namespaces at REQUIRE time from ARCHIE_STACK
 * (or per-value overrides). Every one of them is set explicitly here, from ctx.resources, so an
 * inherited DISPATCHER_LOG_GROUP or a half-set environment cannot produce the mixed board that has
 * already shipped once — metric widgets reading archie, log widgets reading the OpenClaw stack. The
 * wrong values do not error: ClawdbotDispatcher, ClawdbotCron and /ecs/agent-4ggvzl-dispatcher
 * are all real and populated (deploy-dashboard.cjs:160-181).
 */
function observabilityEnv(ctx) {
  return {
    ...childAwsEnv(ctx),
    ARCHIE_STACK: ctx.name,
    AGENTCORE_REGION: ctx.region,
    DISPATCHER_LOG_GROUP: ctx.resources.dispatcherLogGroup,
    DISPATCHER_METRIC_NAMESPACE: ctx.resources.dispatcherNamespace,
    CRON_METRIC_NAMESPACE: ctx.resources.cronNamespace,
  };
}

async function deployDashboard(ctx, args, out, deps, { script, defaultName, label }) {
  const name = args.values.dashboard || defaultName;
  const env = observabilityEnv(ctx);
  out.progress(`${label}: ${name} in ${ctx.region}`);
  out.progress(`targets (from --name ${ctx.name}): ${env.DISPATCHER_LOG_GROUP} · ${env.DISPATCHER_METRIC_NAMESPACE} · ${env.CRON_METRIC_NAMESPACE}`);
  if (ctx.dryRun) {
    out.progress('dry-run: PutDashboard not called');
    return { dryRun: true, dashboard: name, region: ctx.region, targets: env };
  }
  const { stdout } = await run({
    args: [script, name], cwd: OBSERVABILITY, env, label,
  }, out, deps);
  const report = lastJson(stdout) || {};
  // The deployers' own checks are warnings by design — but a check that could not RUN is not a check
  // that passed, so those are surfaced here rather than left in a JSON field nobody reads.
  for (const e of report.checkErrors || []) out.warn(`post-deploy check could not run: ${e}`);
  for (const m of report.stackMismatches || []) {
    out.warn(`WRONG STACK: ${m.key} — dashboard "${m.dashboard}" vs deployed "${m.deployed}"`);
  }
  if ((report.stackMismatches || []).length) {
    throw new CliError('the dashboard disagrees with the deployed dispatcher — it is pointed at another stack', {
      code: EXIT.DRIFT,
      detail: 'The other stack\'s log group and namespaces are real and populated, so the board looks plausible and is wrong.',
    });
  }
  return { dashboard: name, region: ctx.region, ...report };
}

// Fleet-wide Logs Insights queries take an agent SCOPE only through their scoped twins — the fleet
// query would return the whole fleet with the flag silently ignored, which is the failure this map
// exists to prevent. Names are the CLI's, the values are insight-queries.js's builders.
const SCOPED_QUERIES = {
  turns: 'scopedTurnsQuery',
  generations: 'scopedGenerationsQuery',
  messages: 'scopedMessagesQuery',
  tools: 'scopedToolsQuery',
  denials: 'scopedDenialsQuery',
  'runtime-errors': 'scopedRuntimeErrorsQuery',
  trace: 'scopedTraceQuery',
  'cron-inventory': 'scopedCronInventoryQuery',
  'cron-failures': 'scopedCronFailuresQuery',
  dispatcher: 'scopedDispatcherQuery',
};

const DEFAULT_WINDOW_SECONDS = 3600;

/**
 * Load insight-queries.js with this deployment's names.
 *
 * Its stack-shaped constants are module-level and frozen at require time, so the env is set first and
 * the module cache is dropped — a copy required earlier (by anything) would carry another stack's log
 * group, and that failure renders as a plausible, populated, wrong answer rather than an error.
 */
function loadInsights(ctx, deps) {
  Object.assign(deps.env, observabilityEnv(ctx));
  if (!deps.overrides.has('insights')) {
    delete require.cache[require.resolve('../../archie-runner/agentcore-observability/insight-queries')];
  }
  return deps.modules.insights();
}

/**
 * Run a Logs Insights query to completion.
 *
 * POLLS. CloudWatch Logs ingestion lag is ~18s (agentcore-fixture.js:561-563), so a single read is a
 * coin flip on anything recent. A "0 rows" COMPLETE is a VALID ANSWER (world.js:277-281) and exits 0.
 * Never `get-log-events`: it slices to 25 streams and silently drops turn-time events (:565-567).
 */
async function runInsightsQuery({ ctx, insight, out, deps }) {
  const { StartQueryCommand, GetQueryResultsCommand } = require('@aws-sdk/client-cloudwatch-logs');
  const logs = deps.logsClient || makeClient(ctx, '@aws-sdk/client-cloudwatch-logs', 'CloudWatchLogsClient');
  const endTime = Math.floor(deps.now() / 1000);
  const startTime = endTime - DEFAULT_WINDOW_SECONDS;
  const started = await logs.send(new StartQueryCommand({
    logGroupNames: insight.logGroups, queryString: insight.query, startTime, endTime,
  }));
  const budgetMs = (ctx.timeoutSeconds || 120) * 1000;
  const deadline = deps.now() + budgetMs;
  for (;;) {
    await deps.sleep(2000);
    const r = await logs.send(new GetQueryResultsCommand({ queryId: started.queryId }));
    if (r.status === 'Complete') {
      const rows = (r.results || []).map((row) => Object.fromEntries(row.map((f) => [f.field, f.value])));
      if (!rows.length) out.progress('0 rows — a COMPLETE query with no rows is a valid answer; ingestion lag is ~18s, so a just-emitted event may not be indexed yet');
      return {
        status: r.status, rows: rows.length, results: rows, statistics: r.statistics,
        window: { startTime, endTime, seconds: DEFAULT_WINDOW_SECONDS }, logGroups: insight.logGroups,
      };
    }
    if (r.status !== 'Running' && r.status !== 'Scheduled') {
      throw new CliError(`Logs Insights query ${r.status}`, { code: EXIT.FAILED, detail: `queryId ${started.queryId}` });
    }
    if (deps.now() > deadline) {
      throw new CliError(`Logs Insights query did not complete within ${budgetMs / 1000}s`, {
        code: EXIT.TIMEOUT, detail: `queryId ${started.queryId} — raise it with --timeout`,
      });
    }
    out.verbose(`query ${started.queryId}: ${r.status}`);
  }
}

async function runMetricQuery({ ctx, expr, label, out, deps }) {
  const { GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
  const cw = deps.cwClient || makeClient(ctx, '@aws-sdk/client-cloudwatch', 'CloudWatchClient');
  const EndTime = new Date(deps.now());
  const StartTime = new Date(deps.now() - DEFAULT_WINDOW_SECONDS * 1000);
  const r = await cw.send(new GetMetricDataCommand({
    StartTime, EndTime, ScanBy: 'TimestampDescending',
    MetricDataQueries: [{ Id: 'e0', Expression: expr, Label: label, Period: 300, ReturnData: true }],
  }));
  const series = (r.MetricDataResults || []).map((m) => ({
    label: m.Label, status: m.StatusCode,
    points: (m.Timestamps || []).map((t, i) => ({ t: t.toISOString(), v: m.Values[i] })),
  }));
  const points = series.reduce((n, s) => n + s.points.length, 0);
  if (!points) out.progress('0 datapoints — an empty result is a valid answer, but check the namespace if this is not a new deployment');
  return { expr, series, points, window: { start: StartTime.toISOString(), end: EndTime.toISOString() } };
}

async function metricsQuery(ctx, args, out, deps) {
  const Q = loadInsights(ctx, deps);
  const name = args.positionals[0];
  const agent = args.values.agent || null;
  const catalogue = {
    fleetInsights: Object.keys(Q.INSIGHTS).sort(),
    scopedInsights: Object.keys(SCOPED_QUERIES).sort(),
    metrics: Object.keys(Q.METRICS).sort(),
  };
  if (!name) {
    out.progress('name a query — these are the curated ones');
    return catalogue;
  }
  // The sanitizer, not an escaper: "CWL has no bind parameters, so this guard IS the sanitizer"
  // (insight-queries.js:927). A bad id must be a usage error, not a query built from arbitrary text.
  if (agent) {
    try {
      Q.assertSafeScopeLiteral(agent, 'agent');
    } catch (e) {
      throw usage(e.message);
    }
  }

  if (agent && SCOPED_QUERIES[name]) {
    return { query: name, agent, ...(await runInsightsQuery({ ctx, insight: Q[SCOPED_QUERIES[name]](agent), out, deps })) };
  }
  if (agent && Q.METRICS[name]) {
    // Fails CLOSED. Namespaces without an Agent dimension are not scopeable, and answering with the
    // fleet-wide series under an --agent flag would be a plausible lie (scopedMetricExpr:1120).
    const expr = Q.scopedMetricExpr(name, agent);
    if (!expr) {
      throw refused(`metric "${name}" cannot be scoped to one agent — its namespace carries no Agent dimension`, {
        detail: 'Re-run without --agent to read it fleet-wide, deliberately.',
      });
    }
    return { query: name, agent, ...(await runMetricQuery({ ctx, expr, label: `${name} (${agent})`, out, deps })) };
  }
  if (agent) {
    throw refused(`"${name}" has no agent-scoped form — running it with --agent would silently return the whole fleet`, {
      detail: `Scoped queries: ${catalogue.scopedInsights.join(', ')}`,
    });
  }
  if (Q.INSIGHTS[name]) {
    return { query: name, ...(await runInsightsQuery({ ctx, insight: Q.INSIGHTS[name], out, deps })) };
  }
  if (Q.METRICS[name]) {
    return { query: name, ...(await runMetricQuery({ ctx, expr: Q.METRICS[name].expr, label: name, out, deps })) };
  }
  throw usage(`unknown query "${name}"`, {
    detail: `Fleet: ${catalogue.fleetInsights.join(', ')} · scoped (need --agent): ${catalogue.scopedInsights.join(', ')} · metrics: ${catalogue.metrics.length} names`,
  });
}

// ── exports ──────────────────────────────────────────────────────────────────────────────────
// Full command keys — see the header for why these are not verb-keyed.

module.exports = {
  'config hydrate': (ctx, args, out, deps) => configHydrate(ctx, args, out, withDefaults(deps)),
  'config hydrate-conversations': (ctx, args, out, deps) => configHydrateConversations(ctx, args, out, withDefaults(deps)),
  'config validate': (ctx, args, out, deps) => configValidate(ctx, args, out, withDefaults(deps)),
  'config parity': (ctx, args, out, deps) => configParity(ctx, args, out, withDefaults(deps)),

  'grants reconcile': (ctx, args, out, deps) => grantsReconcile(ctx, args, out, withDefaults(deps)),
  'grants apply': (ctx, args, out, deps) => grantsApply(ctx, args, out, withDefaults(deps)),

  'cron hydrate': (ctx, args, out, deps) => cronHydrate(ctx, args, out, withDefaults(deps)),
  'cron list': (ctx, args, out, deps) => cronList(ctx, args, out, withDefaults(deps)),
  'cron runner': (ctx, args, out, deps) => cronRunner(ctx, args, out, withDefaults(deps)),
  'cron arm': (ctx, args, out, deps) => cronArming(ctx, out, withDefaults(deps), { want: true }),
  'cron disarm': (ctx, args, out, deps) => cronArming(ctx, out, withDefaults(deps), { want: false }),

  'dashboard deploy': (ctx, args, out, deps) => deployDashboard(ctx, args, out, withDefaults(deps), {
    script: SCRIPTS.deployDashboard,
    // The deployed board's name is NOT stack-derived today; renaming it here would orphan the live
    // one. --dashboard overrides; the resolved targets are printed either way.
    defaultName: 'agentcore-fleet',
    label: 'dashboard deploy',
  }),
  'dashboard deploy-latency': (ctx, args, out, deps) => deployDashboard(ctx, args, out, withDefaults(deps), {
    script: SCRIPTS.deployLatencyDashboard,
    defaultName: 'agentcore-turn-latency',
    label: 'dashboard deploy-latency',
  }),

  'metrics query': (ctx, args, out, deps) => metricsQuery(ctx, args, out, withDefaults(deps)),

  // Test seam for the pure helpers. Not part of the command contract.
  _internals: {
    HYDRATE_CONSEQUENCES, SCOPED_QUERIES, SCRIPTS, DEFAULT_WINDOW_SECONDS,
    lastJson, oneAgent, tail, describeSource, observabilityEnv, childAwsEnv, withDefaults, run, grantClients,
    readStoredGrant, resolveSandraSource, finishGates,
  },
};

'use strict';

// `archie agent …` — the per-agent primitives. RUNTIME-CLI-REFERENCE.md §2.22,
// RUNTIME-CLI-PRIMITIVES.md §4 and §9.
//
// EIGHT COMMANDS, ONE JOB EACH, ALL IDEMPOTENT. `ensure-runtime` composes the other four; the four
// exist separately because an operator must be able to overrule the composed flow (plan §5) — a
// half-provisioned agent is repaired by running the one leg that failed, not by re-running the saga
// and hoping.
//
// THIS FILE IS A SHELL, NOT AN IMPLEMENTATION. Every mechanism below already exists, is deployed, and
// has been debugged in production:
//
//   ensure-role          derived-role.resolveDerivedRole        (derived-role.js:235)
//   ensure-access-point  provisioning.ensureAccessPoint         (agentcore-provisioning.js:333)
//   ensure-connector      connector-credential.ensureAgentCredential (connector-credential.js:120)
//   seed-workspace       workspace-seed.readSkeleton + AGENT#<id>/SEED (agentcore-client.js:774)
//   ensure-runtime       client.ensureAgentEnvironment — the full saga (agentcore-provisioning.js:567)
//   migrate              the three phases of agent-migrate.js (:52, :67, :83)
//   rekey                rekey-to-scope.rekeyAgent              (rekey-to-scope.mjs:59)
//   teardown             the four sweeps of agent-teardown.js   (:95, :108, :120, :135)
//
// The closest precedent for driving the saga from OUTSIDE the dispatcher process is the BDD
// harness's `provision.deploy` (agentcore-tests/features/support/provision.js:200-219): build a
// `createAgentCoreClient` bound to this deployment, then call `ensureAgentEnvironment`. That is what
// this file does. Nothing here re-derives a role document, a runtime spec, a ClientToken or a
// runtime name — a second definition of any of those is a definition that drifts, and the drift is
// invisible until an agent boots wrong.
//
// TWO THINGS THE UNDERLYING MODULES DO NOT EXPORT, and what that cost:
//   `seedNewWorkspace` and `ensureConnectorCredential` are CLOSURE-PRIVATE on the agentcore client
//   (agentcore-client.js:703, :774), so `seed-workspace` and `ensure-connector` wire the same
//   primitives (readSkeleton / ensureAgentCredential / putDerivedGrants) themselves rather than
//   calling the client's copies. The primitives are the shared part; the wiring is ~20 lines. If
//   those two are ever exposed on the client's returned object, delete the wiring here.
//   `agent-migrate.js` and `agent-teardown.js` export nothing at all — both are top-level IIFEs that
//   run on require — so those two commands cannot call them and re-express their phases instead.
//   Each divergence from the script is called out at its call site.
//
// THE DYNAMODB LANDMINE (runtime-registry.js:134-138). `agent` and `data` are both RESERVED
// KEYWORDS. An unaliased `agent` threw on every provision and broke every turn for every agent, live,
// on 2026-08-13. Every attribute name in every expression in this file is aliased, without exception
// — the reserved list is ~570 words, so "alias only what looks risky" is not a strategy. Unit tests
// CANNOT catch a miss: a fake client accepts a broken expression string happily
// (registry-e2e.js:5-15). The test file asserts no bare identifier survives in any expression, which
// is the closest offline approximation; the real gate is an e2e against DynamoDB.
//
// EVERY HANDLER TAKES AN OPTIONAL 4th `deps` ARGUMENT. The dispatcher calls handler(ctx, args, out),
// so it always defaults; tests pass fakes. One code path — the tested one is the shipped one — and no
// test needs AWS credentials or a network.

const provisioning = require('../../archie-gateway/agentcore-provisioning');
const derivedRole = require('../../archie-gateway/derived-role');
const { listAgents } = require('../lib/agents');
const { legacyEfsRootOf } = require('../lib/efs-root');
const { createRuntimeRegistry } = require('../../archie-gateway/runtime-registry');
const { efsRootDir, generationRuntimeName, isGenerationOf } = require('../../archie-gateway/agentcore-client');
const { derivedSpecFor, imageUriFor } = require('../lib/spec');
const { readFleetPointer, readTaint } = require('../lib/image-pointer');
const { describeImage } = require('../lib/ecr');
const { CliError, EXIT, usage, preflight, refused, tainted } = require('../lib/exit');
const { makeClient } = require('../lib/aws');
const { basePolicyArnFor } = require('../lib/context');

// ── constants, each with the measurement or incident behind it ───────────────────────────────────

// `agent-migrate.js:34`'s default, and it is a ceiling rather than a preference. EFS
// `CreateAccessPoint` — a step inside every provision — is clean at 40 concurrent, 26-of-60 at 60,
// and total failure once the bucket drains (measured 2026-08-13, agentcore-client.js:1072-1079).
// AgentCore's own limits are far higher, so EFS is the binding constraint on the whole provisioning
// path and over-running it costs 30-60s of backoff on the very latency this is meant to protect.
const MIGRATE_CONCURRENCY = 3;

// The teardown skip pattern (`agent-teardown.js:38`), applied AFTER `--name-re` — reference §5.6.
// These prefixes are scratch/benchmark/BDD runtime names; they are excluded even when the operator's
// own regex matches them, because "I typed a broad regex" must not be the same event as "I deleted
// the benchmark fleet". `--skip-re` replaces the pattern; it cannot be emptied to nothing by accident
// (an empty value is a usage error).
const DEFAULT_SKIP_RE = /^(bench_|bdd_|exp_|streamval_|enum_|spike_|pi_timing|pi_poc)/;

// Access points are deletable only by this tag: IAM permits DeleteAccessPoint solely on
// `managed-by=agentcore` (`iam.tf:240-252`), which is why the create-time tag condition is
// load-bearing (`iam.tf:223-239`). ECS / agent-xx9aff / filebrowser access points are NOT tagged this
// way (`agent-teardown.js:33,77`), and that tag is the only thing keeping teardown off them.
const AP_TAG_KEY = 'managed-by';
const AP_TAG_VALUE = 'agentcore';

// Settling pause between deleting a runtime and deleting the access point it mounted
// (`phase3-e2e.mjs:183`). AWS still has the runtime attached while it tears it down.
const AP_SETTLE_MS = 4000;

// The lifecycle values `agentcore-provisioning.js:521` HARDCODES into every CreateAgentRuntime. A
// tag may declare them (`tag create --set maxLifetime=…`), and the saga cannot honour
// them — so a tag that disagrees is refused rather than provisioned into a runtime that will
// never match its own declared spec.
const SAGA_FIXED_SPEC = { idleRuntimeSessionTimeout: 900, maxLifetime: 28800, serverProtocol: 'HTTP' };

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// ── the dependency seam ──────────────────────────────────────────────────────────────────────────

/**
 * Defaults for everything injectable. Only four kinds of thing are injected: AWS clients, module
 * loaders (the dispatcher/agent modules this file wraps), the clock and the sleep — everything else
 * is pure.
 *
 * The ESM loaders are lazy literal imports: eslint's n/no-missing-import can only check a literal
 * specifier, and a top-level `await import` is not available in CommonJS anyway.
 */
function withDefaults(deps = {}) {
  return {
    ...deps,
    env: deps.env || process.env,
    now: deps.now || (() => Date.now()),
    sleep: deps.sleep || sleep,
    clients: deps.clients || null,
    // A SEAM, because the purge is the one teardown step that is not an AWS API call: it runs a
    // Fargate task to reach an in-VPC HTTP endpoint, so it cannot be driven by the injected client
    // bundle the way every other step is. Injectable here rather than reached for inside teardown, so
    // an offline test asserts the WIRING (was it called, with which scopes, was --keep-cron honoured)
    // without standing up ECS.
    purgeCron: deps.purgeCron || purgeCronStores,
    modules: {
      deriveExecRole: () => import('../../archie-runner/config-resolver/derive-exec-role.mjs'),
      schema: () => import('../../archie-runner/config-resolver/schema.mjs'),
      rekey: () => import('../../archie-runner/config-resolver/rekey-to-scope.mjs'),
      batchWrite: () => import('../../archie-runner/config-resolver/batch-write.mjs'),
      workspaceSeed: () => import('../../archie-runner/agentcore-pi/workspace-seed.mjs'),
      agentcore: () => require('../../archie-gateway/agentcore-client'),
      connector: () => require('../../archie-gateway/connector-credential'),
      wrappers: () => require('./wrappers'),
      ...(deps.modules || {}),
    },
  };
}

/**
 * The AWS client bundle.
 *
 * Shape matches `makeProvisioningClients` (agentcore-client.js:273) — `{ control, controlCmds, efs,
 * efsCmds, iam, iamCmds, doc }` — because `provisioning.ensureAccessPoint` and the derived-role spec
 * are handed this object directly and reach for `clients.efsCmds.CreateAccessPointCommand` /
 * `clients.iamCmds.CreateRoleCommand` themselves.
 *
 * Region and credentials go through lib/aws.makeClient rather than being spelled out here: the
 * credential export name differs between SDK versions and getting it wrong throws ONLY when a real
 * `--profile` is passed — which every injected-client test misses, so it surfaces on the first live
 * run. One place to be wrong is the whole point of that module. The packages are still require()d
 * directly for their COMMAND CLASSES, which are plain constructors and need no config.
 */
function awsClients(ctx, deps) {
  if (deps.clients) return deps.clients;
  const controlCmds = require('@aws-sdk/client-bedrock-agentcore-control');
  const efsCmds = require('@aws-sdk/client-efs');
  const iamCmds = require('@aws-sdk/client-iam');
  const docCmds = require('@aws-sdk/lib-dynamodb');
  const stsCmds = require('@aws-sdk/client-sts');
  const secretsCmds = require('@aws-sdk/client-secrets-manager');
  return {
    control: makeClient(ctx, '@aws-sdk/client-bedrock-agentcore-control', 'BedrockAgentCoreControlClient'),
    controlCmds,
    efs: makeClient(ctx, '@aws-sdk/client-efs', 'EFSClient'),
    efsCmds,
    iam: makeClient(ctx, '@aws-sdk/client-iam', 'IAMClient'),
    iamCmds,
    doc: docCmds.DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient')),
    docCmds,
    sts: makeClient(ctx, '@aws-sdk/client-sts', 'STSClient'),
    stsCmds,
    secrets: makeClient(ctx, '@aws-sdk/client-secrets-manager', 'SecretsManagerClient'),
    secretsCmds,
    // `ensure-runtime` asks ECR whether the tag exists before provisioning onto it — the check that
    // replaced "does a CONFIG#tag item exist", and a stronger one: an item proves someone
    // wrote something down, an image proves a runtime can pull.
    ecr: makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient'),
  };
}

/**
 * The dispatcher's own resolved configuration, for THIS deployment.
 *
 * `createAgentCoreClient` resolves its defaults from `process.env` (agentcore-client.js:45-143) —
 * exactly the coupling this plan replaces — so the names the CLI owns come from `ctx` and everything
 * else (VPC, security group, EFS filesystem, mount path, supported AZ ids, skeleton dir) still falls
 * back to the dispatcher's, which is the honest answer: these commands provision what the dispatcher
 * WOULD have provisioned.
 *
 * The BASE POLICY ARN used to be on that fallback list, described as honest. It was not: the
 * dispatcher's default is a bare `agentcore-base`, which does not exist in an archie account, so
 * every `ensure-role`/`ensure-runtime` here would have failed closed on NoSuchEntityException —
 * the failure `fleet stage` actually hit during the first sandbox rehearsal.
 *
 * Constructing the client does not construct any SDK client (they are lazy), so this is free for the
 * commands that only want `client.config`.
 */
function dispatcherClient(ctx, account, deps, overrides = {}) {
  const base = {
    region: ctx.region,
    account,
    agentConfigTable: ctx.resources.configTable,
    // One knob derives every name (lib/context.js): the per-agent Connector secret is
    // `${name}-connector-api-key-<agent>`, composed from the same prefix Terraform composes it from
    // (secrets.tf:61). Left on the dispatcher's env default it would name ANOTHER deployment's
    // secret — which exists and is readable, so the failure is a wrong answer rather than an error.
    credentialSecret: ctx.resources.credentialSecret,
    // Derived for the same reason, with a harder failure mode: the wrong secret name is a wrong
    // answer, the wrong policy name is NoSuchEntityException on every provision.
    baseManagedPolicyArn: basePolicyArnFor(ctx.resources, account),
    ...overrides,
  };
  let mod;
  try {
    mod = deps.modules.agentcore();
  } catch (e) {
    // The CLI require()s the dispatcher's modules rather than forking them (see the eslint config's
    // archie block). If that tree is not installed, say so — a locally re-implemented runtimeEnv or
    // ClientToken is the one failure this design exists to prevent.
    throw preflight('cannot load the dispatcher\'s provisioning code (archie-gateway/agentcore-client)', {
      cause: e,
      detail: 'run `npm ci` in docker/archie-gateway — the CLI reuses it rather than reimplementing it',
    });
  }
  return mod.createAgentCoreClient(base);
}

/**
 * The account the CLI is operating on.
 *
 * `--account` is documented as an ASSERTION ("assert the caller is in this account, or exit 3"), so
 * it is checked against the caller rather than trusted: a role ARN or an access-point ARN built from
 * an asserted-but-wrong account id points at another account's resource and fails much later, as
 * something that looks nothing like "wrong profile".
 */
async function resolveAccount(ctx, clients) {
  const r = await clients.sts.send(new clients.stsCmds.GetCallerIdentityCommand({}));
  const actual = r && r.Account;
  if (!actual) throw preflight('GetCallerIdentity returned no account');
  if (ctx.account && ctx.account !== actual) {
    throw preflight(`--account ${ctx.account} but the caller is in ${actual}`,
      { detail: 'wrong profile, or the right profile against the wrong deployment' });
  }
  return actual;
}

/**
 * Exactly one agent id, validated.
 *
 * The same character class insight-queries.assertSafeScopeLiteral enforces, so a bad id is a usage
 * error rather than a DynamoDB key, an IAM role name and an EFS path built from arbitrary text.
 */
function agentIdOf(args, what = 'agent') {
  const [id, ...rest] = args.positionals;
  if (!id) throw usage(`<${what}> is required`);
  if (rest.length) throw usage(`one ${what} at a time (got ${args.positionals.length})`);
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw usage(`"${id}" is not a valid ${what} id (expected [A-Za-z0-9._-]{1,128})`);
  return id;
}

/** A pino-shaped logger over `out`, so the wrapped modules' own diagnostics reach stderr. */
function loggerFor(out) {
  const line = (o, m) => `${m || (o && o.msg) || ''} ${JSON.stringify(o)}`.trim();
  return {
    info: (o, m) => out.verbose(line(o, m)),
    debug: (o, m) => out.verbose(line(o, m), 2),
    warn: (o, m) => out.warn(line(o, m)),
    error: (o, m) => out.warn(line(o, m)),
  };
}

/**
 * The Connector secret PREFIX, into the ENVIRONMENT.
 *
 * `derived-role.credentialSecretBase()` reads `process.env.CONNECTOR_API_KEY_SECRET` directly
 * (derived-role.js:106) — there is no parameter to thread it through — and "BOTH writers of the
 * `grants` policy must set it: a rewrite that omitted it would silently revoke a migrated agent's
 * key". Terraform names it `${var.name}-connector-api-key` (secrets.tf:61), the same one knob. An
 * explicit env var still wins: an adopted stack may point at a legacy secret.
 */
function applyConnectorSecretEnv(ctx, deps) {
  if (!deps.env.CONNECTOR_API_KEY_SECRET) deps.env.CONNECTOR_API_KEY_SECRET = ctx.resources.credentialSecret;
  return deps.env.CONNECTOR_API_KEY_SECRET;
}

/** Read one item. No ProjectionExpression, so no attribute name is written bare. */
async function getItem(clients, table, Key) {
  const r = await clients.doc.send(new clients.docCmds.GetCommand({ TableName: table, Key, ConsistentRead: true }));
  return r.Item || null;
}

/**
 * The agent's EFS root, honouring the §8.10 legacy adopt.
 *
 * A rekeyed scope agent stores its FORMER name in `META.efsRoot` so its access point adopts the old
 * workspace/sessions/memory (agentcore-client.js:617-630, rekey-to-scope.mjs:16-18). Resolving it
 * here rather than defaulting to the agent id is what keeps `ensure-access-point` and
 * `seed-workspace` agreeing with what a real provision would do — a mismatch of one character mints a
 * SECOND access point at a DIFFERENT path, i.e. an empty workspace.
 *
 * A read failure PROPAGATES. The dispatcher's copy swallows it (`catch { return undefined }`) because
 * a failed provision is worse than a wrong root on the turn path; here there is no turn to protect,
 * and silently provisioning an adopted agent onto a fresh directory is data loss with no error.
 */
async function resolveEfsRoot(clients, ctx, agent, prefix, deps) {
  const { agentMetaKey } = await deps.modules.schema();
  const item = await getItem(clients, ctx.resources.configTable, agentMetaKey(agent));
  const meta = item && item.data ? JSON.parse(item.data) : null;
  const legacy = meta && typeof meta.efsRoot === 'string' && meta.efsRoot ? meta.efsRoot : null;
  return { root: efsRootDir(legacy || agent, prefix), adoptedFrom: legacy };
}

/** Every access point on the filesystem, paginated. `DescribeAccessPoints` has no path filter. */
async function describeAccessPoints(clients, fileSystemId) {
  const out = [];
  let NextToken;
  do {
    const r = await clients.efs.send(new clients.efsCmds.DescribeAccessPointsCommand({
      FileSystemId: fileSystemId, MaxResults: 100, NextToken,
    }));
    for (const ap of r.AccessPoints || []) out.push(ap);
    NextToken = r.NextToken;
  } while (NextToken);
  return out;
}

const tagged = (ap) => (ap.Tags || []).some((t) => t.Key === AP_TAG_KEY && t.Value === AP_TAG_VALUE);

/** Bounded-concurrency map. Failures are captured per item, never thrown as one. */
async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i;
      i += 1;
      try {
        results[idx] = { ok: true, value: await fn(items[idx], idx) };
      } catch (e) {
        results[idx] = { ok: false, error: e };
      }
    }
  }));
  return results;
}

// ── §2.22 `archie agent ensure-role` ─────────────────────────────────────────────────────────────

/**
 * Get-or-create `role/agentcore/<agent>` = the `agentcore-base` managed floor ∪ the inline `grants`
 * document (the agent's own-scope config read ∪ its cap-derived grants).
 *
 * FOUR REFUSALS, ALL INHERITED RATHER THAN RESTATED — which is the point of calling
 * `resolveDerivedRole` instead of assembling this here:
 *
 *   CREATE-FIRST, NEVER GetRole-FIRST (derived-role.js:134-141). A path-scoped grant authorizes
 *   `CreateRole` by its requested Path, but `iam:GetRole` on a NOT-YET-EXISTENT role authorizes
 *   against `role/<name>` — the request carries no path — and is denied. So there is no "does it
 *   exist?" probe anywhere in this command, and adding one would break the dispatcher's own
 *   path-bounded task role (caught live; admin-run tests missed it).
 *
 *   A FAILED READ IS NOT AN ABSENCE (derived-role.js:80-97). `readCredentialPointerArn` propagates
 *   anything that is not a genuine miss, because "a transient DynamoDB error silently dropped the
 *   exact secret ARN … AND dropped ConnectorDenySharedKey, restoring that agent's access to the
 *   SHARED project. Both invisible."
 *
 *   NEVER DELETE THE `grants` POLICY when caps are empty (derived-role.js:192-198) — it is the
 *   agent's ONLY config-table access (`agentcore-base` carries no DynamoDB statement), and deleting
 *   it broke an agent's next boot. The builder writes it unconditionally; nothing here removes it.
 *
 *   NO SHARED-ROLE FALLBACK, AND NO FLAG TO ADD ONE — "a security property any env var can switch
 *   off is not a property" (agentcore-client.js:52-64). A role that cannot be built is an error.
 */
async function ensureRole(ctx, args, out, deps) {
  const agent = agentIdOf(args);
  const clients = awsClients(ctx, deps);
  const table = ctx.resources.configTable;
  const account = await resolveAccount(ctx, clients);
  const config = dispatcherClient(ctx, account, deps).config;
  const secretBase = applyConnectorSecretEnv(ctx, deps);

  // Accepted for symmetry with the saga and REPORTED, but it changes nothing: the role is
  // `role/agentcore/<agent>`, a pure function of the agent id and not of its caps or its tag
  // (derived-role.js:225-231). There is no tier to cross, so no tag can require a different
  // role — saying so beats letting an operator believe the flag did something.
  const tag = args.values.tag || args.values.generation || null;
  if (tag) out.verbose(`--tag ${tag} noted; the derived role is a pure function of the agent id, so it does not vary by tag`);

  const { derivedRoleName, AGENTCORE_ROLE_PATH } = await deps.modules.deriveExecRole();
  const roleName = derivedRoleName(agent);

  // The caps and the Connector pointer are READS, so they happen in dry-run too — and a failure here
  // must abort rather than degrade (see above). `resolveDerivedRole` performs both.
  const spec = await derivedRole.resolveDerivedRole({
    doc: clients.doc,
    tableName: table,
    account,
    agentId: agent,
    baseManagedPolicyArn: config.baseManagedPolicyArn,
    region: ctx.region,
    logger: loggerFor(out),
  });
  // A SECOND read of the same item, deliberately: the role spec closes over the caps it embedded and
  // does not expose them, and a command that writes an agent's permissions must be able to say which
  // ones. One extra GetItem on a cold path is the right price for that; re-deriving them from the
  // config instead would be a second definition of "the agent's caps" (`grants reconcile`'s job).
  const caps = await derivedRole.readAgentCaps(clients.doc, table, agent);

  out.progress(`${roleName} (path ${AGENTCORE_ROLE_PATH}) = ${config.baseManagedPolicyArn} ∪ inline \`grants\``);
  out.progress(`caps: ${caps.length ? caps.join(', ') : '(none — the policy is still written, for the scoped config read)'}`);

  if (ctx.dryRun) {
    out.progress('would CreateRole (never GetRole first), then AttachRolePolicy + PutRolePolicy `grants`');
    return {
      dryRun: true, agent, roleName, path: AGENTCORE_ROLE_PATH, account, caps,
      baseManagedPolicyArn: config.baseManagedPolicyArn, credentialSecretBase: secretBase, tag,
    };
  }

  const r = await spec.ensure({ clients: { iam: clients.iam, iamCmds: clients.iamCmds }, logger: loggerFor(out) });
  if (r.created) {
    // IAM propagation has NO guaranteed bound and NO queryable signal (agentcore-provisioning.js:288-290):
    // GetRole returns immediately and SimulatePrincipalPolicy tests policy evaluation, not trust
    // propagation. The saga's typed retry IS the correctness mechanism; the 2s minimum only shaves
    // the common case. So this is a note, not a wait — `ensure-runtime` owns the deadline.
    out.progress('role CREATED — it is not immediately assumable by bedrock-agentcore; CreateAgentRuntime '
      + 'reports that as a ValidationException and the saga\'s typed retry absorbs it (~3-6s)');
  }
  return {
    agent, roleName: r.roleName, roleArn: r.roleArn, created: r.created === true, caps, account,
    credentialSecretBase: secretBase, tag,
  };
}

// ── §2.22 `archie agent ensure-access-point` ─────────────────────────────────────────────────────

/**
 * Get-or-create the agent's EFS access point at `<prefix>/agents/<agent>`, polled to `available`.
 *
 * IDEMPOTENCY IS THE ROOT PATH, NOT THE AGENT. The ClientToken is derived deterministically from the
 * root (agentcore-provisioning.js:345) and an `AccessPointAlreadyExists` is adopted from
 * `e.AccessPointId` (:367-373). That means a root differing by ONE CHARACTER mints a SECOND access
 * point at the SAME path: EFS allows it, and the token only dedupes retries (:336-340). So the root
 * is derived exactly as a provision derives it — including the §8.10 legacy adopt — and a
 * hand-passed `--efs-root` that disagrees is warned about loudly rather than silently honoured.
 *
 * The `managed-by=agentcore` tag is applied by `ensureAccessPoint` itself, is IAM-enforced at create
 * (iam.tf:223-239), and is the only thing that later lets `access-point gc` and `agent teardown`
 * recognise the access point as ours. Nothing here can create an untagged one.
 */
async function ensureAccessPoint(ctx, args, out, deps) {
  const agent = agentIdOf(args);
  const clients = awsClients(ctx, deps);
  const account = await resolveAccount(ctx, clients);
  const config = dispatcherClient(ctx, account, deps).config;

  const derived = await resolveEfsRoot(clients, ctx, agent, config.efsRootPrefix, deps);
  let root = derived.root;
  const override = args.values['efs-root'] || null;
  if (override && override !== derived.root) {
    // Explicit, so it is allowed — but it is the single most expensive typo available here.
    out.warn(`--efs-root ${override} disagrees with the derived root ${derived.root}. The ClientToken is `
      + 'derived FROM the root, so this mints a SECOND access point at a different path — EFS allows it, '
      + 'and an agent mounting the wrong one sees an EMPTY workspace (agentcore-provisioning.js:336-340).');
    root = override;
  }
  if (derived.adoptedFrom) {
    out.progress(`legacy-EFS adopt: META.efsRoot=${derived.adoptedFrom} — this access point points at the `
      + 'PRE-REKEY directory, so workspace/sessions/memory carry over (rekey-to-scope.mjs:16-18)');
  }
  out.progress(`access point for ${agent} at ${root} on ${config.efsFsId}`);

  if (ctx.dryRun) {
    out.progress('would CreateAccessPoint with a ClientToken derived from that root, tagged '
      + `${AP_TAG_KEY}=${AP_TAG_VALUE}, adopting on AccessPointAlreadyExists`);
    return { dryRun: true, agent, efsRoot: root, fileSystemId: config.efsFsId, adoptedFrom: derived.adoptedFrom };
  }

  const ledger = provisioning.makeLedger();
  const r = await provisioning.ensureAccessPoint(agent, {
    efsRootFor: () => root,
    clients,
    config: { region: ctx.region, account, efsFsId: config.efsFsId },
    logger: loggerFor(out),
    ledger,
    sleep: deps.sleep,
  });
  out.progress(`${r.selfCreated ? 'created' : 'adopted'} ${r.accessPointId}`);
  return {
    agent,
    efsRoot: root,
    adoptedFrom: derived.adoptedFrom,
    fileSystemId: config.efsFsId,
    accessPointId: r.accessPointId,
    accessPointArn: r.accessPointArn,
    // The gate `seed-workspace` needs, reported rather than inferred: a FRESH access point is the
    // only proof that the workspace is empty (agentcore-client.js:637-642).
    selfCreated: r.selfCreated === true,
  };
}

// ── §2.22 `archie agent ensure-connector` ─────────────────────────────────────────────────────────

/**
 * Give the agent its own Connector project and key.
 *
 * WHAT THIS CAN AND CANNOT DO, because it defines the whole command (connector-credential.js:7-23):
 * `POST /project/new` returns a usable key exactly ONCE. Regeneration is disabled org-wide (403 code
 * 10403), `GET /project/{id}` returns only the ORIGINAL key masked, and the v3 OpenAPI spec has no
 * create-additional-key route. So a 409 is TERMINAL, not a retry — and an agent whose pointer AND
 * secret were both deleted cannot be recovered through the API at all. This command says so and
 * stops; it never loops.
 *
 * ORDERING IS LOAD-BEARING: the secret is written BEFORE the pointer (:107-111), because "a crash
 * between them leaves a usable key that nothing points at — harmless and re-runnable — rather than a
 * pointer to a secret that isn't there". That ordering lives inside `ensureAgentCredential`; the
 * adapters below must not reorder it.
 *
 * `ensureAgentCredential` NEVER THROWS by contract (:25-27) — an agent with no Connector is a working
 * agent with fewer tools. This command therefore CLASSIFIES its report into an exit code rather than
 * catching an exception: a CLI's exit code is its report, and exit 0 on a BLOCKED project would be
 * the same silent degradation the contract exists to avoid.
 */
async function ensureConnectorCredential(ctx, args, out, deps) {
  const agent = agentIdOf(args);
  const clients = awsClients(ctx, deps);
  const table = ctx.resources.configTable;
  const account = await resolveAccount(ctx, clients);
  const config = dispatcherClient(ctx, account, deps).config;
  const secretBase = ctx.resources.credentialSecret;
  const secretName = `${secretBase}-${agent}`;
  const { agentCredentialKey } = await deps.modules.schema();
  const connector = deps.modules.connector();

  // The ORG key is a DISPATCHER-ONLY credential (it can read and create every project in the org),
  // and its secret is an external ARN rather than a name Terraform derives from `--name`
  // (dispatcher.tf:122 passes `var.connector_org_secret_arn`), so it cannot come from ctx.resources.
  const orgSecretId = deps.env.CONNECTOR_ORG_API_KEY_SECRET || config.connectorOrgSecret || '';
  if (!orgSecretId) {
    out.warn('no CONNECTOR_ORG_API_KEY_SECRET — inline Connector provisioning is disabled for this deployment, '
      + 'so new agents fall back to the SHARED project (which works, at the cost of isolation)');
    return { agent, outcome: connector.OUTCOME.SKIPPED, reason: 'no-org-secret' };
  }

  // Where the ladder would land, computed from reads only — this is also the dry-run answer.
  const pointer = await getItem(clients, table, agentCredentialKey(agent));
  const pointed = pointer && pointer.data ? JSON.parse(pointer.data) : null;
  let secretArn = null;
  if (!pointed || !pointed.secretArn) {
    try {
      const d = await clients.secrets.send(new clients.secretsCmds.DescribeSecretCommand({ SecretId: secretName }));
      secretArn = d && d.ARN;
    } catch (e) {
      if (e && e.name !== 'ResourceNotFoundException' && !/can't find the specified secret/i.test(String(e.message))) throw e;
    }
  }
  const rung = (pointed && pointed.secretArn) ? 'already-pointed' : (secretArn ? 'adopt-secret' : 'create-project');
  out.progress(`${agent}: ${rung} (pointer ${pointed && pointed.secretArn ? 'present' : 'absent'}, secret ${secretArn ? 'present' : 'absent'})`);

  if (ctx.dryRun) {
    if (rung === 'create-project') {
      out.progress('would POST /project/new with should_create_api_key — a THIRD-PARTY write that cannot be '
        + 'undone and whose 409 is terminal. It deliberately does not list first: project/list returns all '
        + 'many org projects (connector-credential.js:41-46).');
    }
    return { dryRun: true, agent, secretBase, secretName, wouldTake: rung };
  }

  const outcome = await connector.ensureAgentCredential({
    agentId: agent,
    secretBase,
    orgApiKey: await readOrgKey(connector, clients, orgSecretId, out),
    // SECRET BEFORE POINTER lives inside ensureAgentCredential; these are only the two effectors.
    secrets: {
      describeSecret: (name) => clients.secrets.send(new clients.secretsCmds.DescribeSecretCommand({ SecretId: name })),
      createSecret: async (name, value) => {
        const r = await clients.secrets.send(new clients.secretsCmds.CreateSecretCommand({
          SecretId: name, Name: name, SecretString: value,
          Description: 'Per-agent Connector API key (provisioned by archie)',
        }));
        return r.ARN;
      },
    },
    ddb: {
      getCredential: async (id) => {
        const item = await getItem(clients, table, agentCredentialKey(id));
        return item && item.data ? JSON.parse(item.data) : undefined;
      },
      // UpdateItem with `#d`, never PutItem: `data` is a reserved word and the role grants UpdateItem
      // only, on purpose (runtime-registry.js:28-30, iam.tf:50).
      putCredential: (id, body) => clients.doc.send(new clients.docCmds.UpdateCommand({
        TableName: table,
        Key: agentCredentialKey(id),
        UpdateExpression: 'SET #d = :d',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':d': JSON.stringify(body) },
      })),
    },
    now: deps.now,
    logger: loggerFor(out),
  });

  const result = { agent, secretBase, ...outcome };
  const { OUTCOME } = connector;
  if (outcome.outcome === OUTCOME.CREATED || outcome.outcome === OUTCOME.ADOPTED) {
    result.roleRefresh = await refreshRoleForConnector(ctx, clients, account, agent, out, deps);
  }
  if (outcome.outcome === OUTCOME.BLOCKED) {
    throw refused(`${agent}'s Connector project already exists and cannot be keyed`, {
      detail: 'This is TERMINAL, not a retry: regeneration is disabled org-wide (403 code 10403), '
        + 'GET /project/{id} returns only the ORIGINAL key masked, and there is no create-additional-key '
        + 'route. Mint a key in the Connector console and run connector-migrate-run.mjs adopt-key. The agent '
        + 'stays on the SHARED project meanwhile, which works.',
    });
  }
  if (outcome.outcome === OUTCOME.FAILED) {
    throw new CliError(`could not provision Connector for ${agent}: ${outcome.reason}`, {
      code: EXIT.FAILED,
      detail: `${outcome.error || ''} — the agent stays on the shared key; re-running is safe (the secret is `
        + 'written before the pointer, so a half-finished run leaves a usable key, not a dangling pointer).',
    });
  }
  return result;
}

/**
 * The org key, out of Secrets Manager, through the SAME extractor the dispatcher uses.
 *
 * `extractOrgKey` accepts both shapes in use (a plain string and a JSON k/v) and REJECTS an ambiguous
 * multi-key object rather than guessing — picking the wrong field sends something that is not the key
 * and produces a 401 that "looks nothing like your secret has the wrong shape"
 * (connector-credential.js:67-94).
 */
async function readOrgKey(connector, clients, secretId, out) {
  const r = await clients.secrets.send(new clients.secretsCmds.GetSecretValueCommand({ SecretId: secretId }));
  const key = connector.extractOrgKey(r.SecretString);
  if (!key) {
    throw new CliError(`the Connector org secret ${secretId} yielded no key`, {
      code: EXIT.FAILED,
      detail: 'A JSON object with several string fields is AMBIGUOUS and is rejected rather than guessed '
        + '(connector-credential.js:81-94). Store the key as a plain string or under one known field name.',
    });
  }
  out.verbose(`org key resolved from ${secretId}`);
  return key;
}

/**
 * Rewrite the derived role as soon as a pointer is written — agentcore-client.js:740-770.
 *
 * The saga builds the role in step 1 and provisions Connector in step 2, so on a FIRST provision the
 * role is built before the pointer exists, and the shared-key Deny is gated ON that pointer. Live
 * observed: a freshly provisioned agent had its own project and key AND still had permission to read
 * the SHARED key — exactly the hole the Deny exists to close.
 *
 * Caps are READ, never defaulted: `putDerivedGrants` rewrites the WHOLE document, so passing [] would
 * strip the agent's cap-derived grants. A failed read therefore skips the rewrite entirely.
 * Non-fatal: what is lost is the Deny until the next provision — degraded isolation, not a broken
 * agent.
 */
async function refreshRoleForConnector(ctx, clients, account, agent, out, deps) {
  applyConnectorSecretEnv(ctx, deps);
  try {
    const caps = await derivedRole.readAgentCaps(clients.doc, ctx.resources.configTable, agent);
    const r = await derivedRole.putDerivedGrants({
      clients: { iam: clients.iam, iamCmds: clients.iamCmds, doc: clients.doc },
      agentId: agent,
      caps,
      account,
      region: ctx.region,
      table: ctx.resources.configTable,
    });
    out.progress(`derived role refreshed (${r.roleName}): pointer ARN + shared-key deny${r.applied ? '' : ` — NOT applied (${r.reason})`}`);
    return { applied: r.applied, roleName: r.roleName, reason: r.reason || null, caps };
  } catch (e) {
    out.warn(`derived role refresh FAILED for ${agent} — the shared-key deny is not yet in place `
      + `(${(e && e.message) || e}). The agent still reads its own key by name; re-run \`archie agent ensure-role\`.`);
    return { applied: false, error: String((e && e.message) || e) };
  }
}

// ── §2.22 `archie agent seed-workspace` ──────────────────────────────────────────────────────────

/**
 * Pre-write `AGENT#<id>/SEED` from the baked skeleton, so a new agent's runtime never needs a
 * DynamoDB write at boot.
 *
 * THE GATE IS THE COMMAND. In the saga this runs only when the EFS access point was just created
 * (`ap.selfCreated`), and that gate is load-bearing: "if we wrote a skeleton SEED for an agent whose
 * workspace already has content, the next boot would take workspace-seed's 'loaded' branch … and
 * throw `seed guard FATAL`" (agentcore-client.js:637-642).
 *
 * Standalone there is no `selfCreated` to read, so the same fact is established the other way round:
 * an access point at this root is the only thing that can ever have written to the workspace, so
 * ABSENCE of one proves the directory is empty and PRESENCE means we cannot prove it is. Present →
 * refuse. That is stricter than the saga (which seeds an access point it created moments earlier) and
 * it is the safe direction: the cost of refusing is one command, the cost of seeding wrongly is an
 * agent that cannot boot.
 *
 * The write is `UpdateItem` with `attribute_not_exists(pk)` — create-only (:794), and UpdateItem
 * rather than PutItem because the role grants UpdateItem only, on purpose (runtime-registry.js:28-30,
 * iam.tf:50).
 */
async function seedWorkspace(ctx, args, out, deps) {
  const agent = agentIdOf(args);
  const clients = awsClients(ctx, deps);
  const table = ctx.resources.configTable;
  const account = await resolveAccount(ctx, clients);
  const config = dispatcherClient(ctx, account, deps).config;
  const { agentSeedKey } = await deps.modules.schema();

  const existing = await getItem(clients, table, agentSeedKey(agent));
  if (existing) {
    // Idempotent, and the same answer the ConditionExpression would give: exit 0.
    out.progress(`AGENT#${agent}/SEED already exists — nothing to write (create-only by design)`);
    return { agent, seeded: false, reason: 'already-exists' };
  }

  const { root, adoptedFrom } = await resolveEfsRoot(clients, ctx, agent, config.efsRootPrefix, deps);
  const aps = await describeAccessPoints(clients, config.efsFsId);
  const at = aps.filter((ap) => ((ap.RootDirectory || {}).Path || null) === root);
  if (at.length) {
    throw refused(`${agent} already has an EFS access point at ${root} — refusing to write a skeleton SEED`, {
      detail: `${at.map((a) => a.AccessPointId).join(', ')} exists, so the workspace may already have content. `
        + 'The next boot would take workspace-seed\'s "loaded" branch, verify every manifest file against EFS '
        + 'and throw `seed guard FATAL` for any skeleton file the live workspace does not have '
        + '(agentcore-client.js:637-642). Seeding is for a genuinely fresh workspace only.',
    });
  }

  const { readSkeleton } = await deps.modules.workspaceSeed();
  const files = readSkeleton(config.newAgentSkeletonDir, agent);
  const names = Object.keys(files || {});
  if (!names.length) {
    throw new CliError(`the new-agent skeleton at ${config.newAgentSkeletonDir} is empty or unreadable`, {
      code: EXIT.FAILED,
      detail: 'NEW_AGENT_SKELETON_DIR overrides it; the repo layout is archie-runner/config-seed/new-agent-skeleton.',
    });
  }
  out.progress(`${names.length} skeleton file(s) → AGENT#${agent}/SEED${adoptedFrom ? ` (workspace root ${root}, adopted from ${adoptedFrom})` : ''}`);
  out.verbose(names.join(', '));

  if (ctx.dryRun) return { dryRun: true, agent, files: names.length, fileNames: names, efsRoot: root };

  try {
    await clients.doc.send(new clients.docCmds.UpdateCommand({
      TableName: table,
      Key: agentSeedKey(agent),
      UpdateExpression: 'SET #d = :d',
      // `data` is a DynamoDB reserved word. `pk` is not — agentcore-client.js:794 writes
      // `attribute_not_exists(pk)` bare and it works — but it is aliased here anyway: "alias
      // everything and the question never has to be asked" is only a rule if it has no exceptions,
      // and an exception is how a reserved word gets written bare next time.
      ExpressionAttributeNames: { '#d': 'data', '#pk': 'pk' },
      ExpressionAttributeValues: { ':d': JSON.stringify(files) },
      ConditionExpression: 'attribute_not_exists(#pk)',
    }));
  } catch (e) {
    if (e && e.name === 'ConditionalCheckFailedException') {
      out.progress(`AGENT#${agent}/SEED was written by someone else between the read and the write — left alone`);
      return { agent, seeded: false, reason: 'already-exists' };
    }
    throw e;
  }
  return { agent, seeded: true, files: names.length, efsRoot: root };
}

// ── §2.22 `archie agent ensure-runtime` ──────────────────────────────────────────────────────────

/**
 * The full provisioning saga for one agent: role → (mount targets ∥ access point ∥ Connector) →
 * CreateAgentRuntime → poll READY (agentcore-provisioning.js:567).
 *
 * IT DOES NOT HEALTHCHECK. A READY runtime is a control-plane assertion, not a serving one — that is
 * `fleet healthcheck` (§2.9, W2-A) and, composed, `fleet stage`.
 *
 * Everything the saga refuses to do it refuses INSIDE, and that is why this calls it rather than
 * re-issuing the steps: `allSettled` on the parallel legs so a rejection cannot leave an access point
 * outside the ledger (:624-628); typed retry classification, because `ValidationException` is BOTH
 * malformed input AND a not-yet-assumable role (:159-163); the IAM propagation deadline for a
 * newly-minted role (:285-296); the 140-attempt READY budget ≈ 369s (:553); the name grammar
 * `[a-zA-Z0-9_]`, max 48, suffix budget reserved FIRST so a long id truncates rather than colliding
 * with a sibling tag of itself (agentcore-client.js:226-233).
 *
 * WHAT IS OURS: the binding row. The saga returns an ARN and records nothing, so this writes
 * `RUNTIME#<agent>/GEN#<name>` through the registry — otherwise the runtime exists at AWS and is
 * invisible to `runtime list`, `runtime gc` and every turn, which is precisely the leak §6.5
 * describes.
 */
async function ensureRuntime(ctx, args, out, deps) {
  const agent = agentIdOf(args);
  const clients = awsClients(ctx, deps);
  const account = await resolveAccount(ctx, clients);
  const { tag, imageUri } = await resolveTag(ctx, clients, args, out, deps, account);

  // The per-agent spec THIS DEPLOYMENT derives — the dispatcher's own `runtimeSpecFor`, so the name
  // computed here is the name the dispatcher computes on the agent's next turn. The runtime NAME is
  // the fingerprint of exactly this object, so the name and the content cannot disagree.
  // agent.js has its OWN client seam (`deps.modules.agentcore`), used by every other command in
  // this file; lib/spec's `dispatcherClientFor` has a different one. Using this one keeps a single
  // injection point per file rather than two that must both be stubbed.
  const specClient = deps.specClient || dispatcherClient(ctx, account, deps, {});
  const declared = derivedSpecFor(specClient, agent, imageUri);
  const runtimeName = generationRuntimeName(agent, declared);

  // The saga hardcodes lifecycle and protocol (agentcore-provisioning.js:521). If the derived spec
  // ever disagrees, provisioning would produce a runtime that can never match its own spec — a
  // permanent `fleet verify` drift with no way to fix it from here.
  const unsupported = Object.entries(SAGA_FIXED_SPEC)
    .filter(([k, v]) => declared[k] !== undefined && declared[k] !== v)
    .map(([k, v]) => `${k}=${declared[k]} (CreateAgentRuntime is always given ${v})`);
  if (unsupported.length) {
    throw refused('the derived spec declares values the provisioning saga cannot apply', {
      detail: `${unsupported.join(', ')} — agentcore-provisioning.js:521 hardcodes them. Provisioning would `
        + 'produce a runtime that never matches its own spec, i.e. permanent drift.',
    });
  }

  // No per-field overrides: the spec above was derived from THIS deployment's client, so overriding
  // the very fields it derived from would be circular. A tag used to freeze them, which is
  // what these three lines carried; the deployment is now the only source.
  const client = dispatcherClient(ctx, account, deps, {});

  out.progress(`${agent} → ${tag}: runtime ${runtimeName} on ${declared.image}`);
  if (ctx.dryRun) {
    out.progress('would run the saga: role → (mount targets ∥ access point ∥ connector) → CreateAgentRuntime → poll READY');
    out.progress(`then record RUNTIME#${agent}/GEN#${runtimeName}`);
    return { dryRun: true, agent, tag, runtimeName, image: declared.image, spec: declared };
  }

  const env = await client.ensureAgentEnvironment(agent, {
    runtimeName,
    image: declared.image,
    // The DERIVED environment, verbatim — passed rather than left to `ensureAgentEnvironment`'s own
    // recomputation (agentcore-client.js:861) so the env that lands on the runtime is exactly the env
    // whose fingerprint became its name. Those must not be two computations.
    envs: declared.envs,
    logger: loggerFor(out),
  });

  // Recorded only now, because `ensureAgentEnvironment` polls to READY before returning: the row's
  // existence is an assertion about a runtime that actually works (runtime-registry.js:120-124).
  const registry = createRuntimeRegistry({ tableName: ctx.resources.configTable, doc: () => clients.doc });
  const runtimeId = env.runtimeId || (env.runtimeArn ? String(env.runtimeArn).split('/').pop() : null);
  await registry.record(agent, runtimeName, { arn: env.runtimeArn, runtimeId });
  out.progress(`recorded RUNTIME#${agent}/GEN#${runtimeName} → ${runtimeId}`);

  return {
    agent,
    tag,
    runtimeName,
    runtimeArn: env.runtimeArn,
    runtimeId,
    accessPointArn: env.accessPointArn,
    roleArn: env.roleArn,
    image: declared.image,
    // Said plainly, because the composed flow is where it gets forgotten: READY is not serving.
    healthchecked: false,
  };
}

/**
 * Which tag to provision, and its stored template.
 *
 * `--tag` is how §2.22 spells this command. The image pointer is accepted as a fallback
 * because "provision this agent onto whatever is live" is the repair an operator actually types after
 * a straggler — but it is announced, never silent, and its absence is a usage error rather than a
 * guess. Phase 1 runs against today's structures (plan §12 step 1), where `CONFIG#release` may not
 * exist yet.
 */
async function resolveTag(ctx, clients, args, out, deps, account) {
  const docCmds = require('@aws-sdk/lib-dynamodb');
  const aws = { doc: () => clients.doc, ecr: () => clients.ecr };
  let tag = args.values.tag || args.values.generation || null;
  if (!tag) {
    const published = await readFleetPointer(clients.doc, docCmds, ctx.resources.configTable);
    tag = (published && published.tag) || null;
    if (!tag) {
      throw usage('--tag <tag> is required', {
        detail: 'Nothing is published to fall back to — `archie image list` shows what exists.',
      });
    }
    out.progress(`--tag not given; using the published tag (${tag})`);
  }

  const imageUri = imageUriFor(ctx, account, tag);
  const found = await describeImage(aws, { account, repo: ctx.resources.agentRepo, tag });
  if (!found) {
    // The no-baked-fallback rule (§5.7): a floor "sounds like resilience and behaves like a silent
    // downgrade". A tag that is not in ECR is a fault, not a reason to guess.
    throw new CliError(`no image ${tag}`, {
      code: EXIT.FAILED,
      detail: `${imageUri} is not in ECR. There is deliberately no fallback image anywhere in this `
        + 'system (image-source.js:11-15).',
    });
  }

  const taint = await readTaint(clients.doc, docCmds, ctx.resources.configTable, tag);
  if (taint) {
    // Exit 4, not 5. The pair that matters (§1.5): 4 means STOP — the tag can never ship and
    // re-running is wasted time — while 5 is "I refused, here is the flag". There is no flag here.
    throw tainted(`${tag} is TAINTED (${taint.reason || 'no reason recorded'})`, {
      detail: 'Taint is permanent and unconditional (§5.2) — a tainted tag can never be published, so '
        + 'provisioning agents onto it only burns runtimes against the 1000-runtime cap.',
    });
  }
  return { tag, imageUri };
}

// ── §2.22 `archie agent migrate` ─────────────────────────────────────────────────────────────────

/**
 * Config hydrate → ensure runtimes → fold in per-agent cron. The three phases of `agent-migrate.js`
 * (:52, :67, :83), each independently skippable because their infrastructure prerequisites differ.
 *
 * TWO DELIBERATE DIVERGENCES FROM THE SCRIPT, both forced:
 *
 *   The script cannot be called. It is a top-level IIFE that runs on require and exports nothing, so
 *   this re-expresses the phases over the CLI's own commands. That is not duplication — phase 1 IS
 *   `config hydrate`, phase 3 IS `cron hydrate`, and both are called here as such, so their refusals
 *   (the floating-ref warning, the one-time-at-flip cron marker) apply unchanged.
 *
 *   Phase 2's in-process `agentCore.ensureRuntime` (:73) BECOMES `fleet stage` (§2.22). Staging
 *   is W1-D and adds healthcheck + binding on top of provisioning; until it lands this drives
 *   `ensure-runtime` per agent at the same concurrency, which is the provisioning half of it and
 *   nothing else. It does NOT healthcheck, and it says so.
 */
async function migrate(ctx, args, out, deps) {
  const table = ctx.resources.configTable;
  const clients = awsClients(ctx, deps);
  const wrappers = deps.modules.wrappers();
  const result = { table, dryRun: ctx.dryRun, phases: {} };

  if (args.values['skip-config']) {
    out.progress('config: skipped');
    result.phases.config = { skipped: true };
  } else {
    out.progress('config: hydrating DynamoDB from the sandra config repo');
    // ALL THREE OF `config hydrate`'s INPUTS ARE THREADED THROUGH. Same string on both sides in each
    // case, so these are pass-throughs and not translations.
    //
    //   agents      — so `agent migrate --agents X` hydrates X and not the whole fleet. Without it the
    //                 config phase rewrote EVERY agent's CONFIG and GRANT while the runtime and cron
    //                 phases below were scoped to one: a blast radius nobody asked for from a scoped
    //                 command.
    //   ref         — WHICH BRANCH OF THE CONFIG REPO. Missing until 2026-08-21, and its absence was
    //                 not a missing convenience but a silent wrong write. `config hydrate` defaults to
    //                 `main`, and the SCOPE ID IS DERIVED FROM THE CONFIG: agent-xx9aff's
    //                 slack.json carries `dm_users: ["UJ4IGI7XE"]` on main and `["UX0MZ5CKP2R"]` on
    //                 sandbox-sandbox, so migrating the sandbox from main keyed the agent to
    //                 `dm-uj4igi7xe` — a scope nothing routes to — and left `dm-ux0mz5ckp2r`, the one
    //                 that actually takes turns, unhydrated. Both writes "succeed". Any deployment
    //                 whose agents run a non-default ref (clawdbot_gh_config_ref) hit this.
    //   sandra-dir  — the local-checkout alternative to a clone, threaded for the same reason: a
    //                 command that cannot say where its config comes from will use the wrong one.
    result.phases.config = await wrappers['config hydrate'](
      ctx,
      {
        positionals: [],
        values: {
          agents: args.values.agents,
          ref: args.values.ref,
          'sandra-dir': args.values['sandra-dir'],
          // `config hydrate` folds in cron itself now (hydrate means hydrate). This command has its own
          // cron PHASE below, which runs after the runtime phase and reports per-agent — so the config
          // step is told to skip it rather than doing it twice. `cron hydrate` PURGES before re-seeding,
          // so running it twice is not merely wasteful: it is two Fargate tasks and two purges per agent.
          'skip-cron': true,
        },
      },
      out,
      deps.wrapperDeps,
    );
  }

  const roster = await agentRoster(ctx, clients, args, out, deps);
  out.progress(`${roster.length} agent(s) in scope`);
  // SCOPE IDS on the result, because that is the identity everything downstream is keyed by and the
  // identity the operator has to be able to look up afterwards. The legacy names they typed are already
  // in the config phase's own output.
  result.agents = roster.map((a) => a.scope);

  if (args.values['skip-runtimes']) {
    out.progress('runtimes: skipped');
    result.phases.runtimes = { skipped: true };
  } else {
    out.progress(`runtimes: ensuring ${roster.length} runtime(s) at concurrency ${MIGRATE_CONCURRENCY} — `
      + 'bounded by EFS CreateAccessPoint, which is clean at 40 concurrent and fails outright once the '
      + 'bucket drains (agentcore-client.js:1072-1079), not by AgentCore');
    out.progress('this provisions only; READY is not serving. `archie fleet stage` is the '
      + 'healthchecked, binding form of this phase and supersedes it.');
    // Normally no `--tag`, so every agent lands on the PUBLISHED one — which is what migrating a
    // fleet means. The pass-through is here so that declaring the flag is a one-line change in the
    // registry rather than a change here as well.
    // `a.scope`, NEVER the name the operator typed. Provisioning the typed name is what minted the
    // phantom identity described on agentRoster.
    const runs = await pool(roster, MIGRATE_CONCURRENCY, (a) => (
      ensureRuntime(ctx, { positionals: [a.scope], values: { tag: args.values.tag || args.values.generation } }, out, deps)
    ));
    const ok = [];
    runs.forEach((r, i) => {
      if (r.ok) { ok.push(roster[i].scope); return; }
      // Per-unit, so `failures[]` names WHICH agent failed and the run exits 6 PARTIAL rather than
      // collapsing 208 units into one code (§1.4). Re-running is the designed response.
      out.failure({ agent: roster[i].scope, step: 'ensure-runtime', error: r.error });
    });
    result.phases.runtimes = { ensured: ok.length, failed: roster.length - ok.length };
  }

  if (args.values['skip-cron']) {
    out.progress('cron: skipped');
    result.phases.cron = { skipped: true };
  } else {
    // NO ENVIRONMENT PRECONDITION, and there used to be one: this refused unless MOUNT_PATH and a
    // manager-API URL were set, inherited verbatim from agent-migrate.js:88-91 on the grounds that the
    // phase "reads the PARENT EFS access point and posts to the dispatcher's manager API, neither of
    // which exists on a laptop". True of the SCRIPT. Not true of `cron hydrate`, which grew a second
    // mode for exactly this: with MOUNT_PATH it runs in-process, and without it composes an EPHEMERAL
    // Fargate task around the parent access point, runs it once and deregisters it (wrappers.js
    // cronHydrateViaTask). That path needs NOTHING from env — cluster and subnets come from
    // ctx.resources and discovery, the shared secret from Secrets Manager, and the image from the
    // running gateway's own task definition.
    //
    // So the gate was checking for the wrong thing and its failure was silent-by-warning: `agent
    // migrate` claimed to migrate an agent and skipped a third of it every time it was run from a
    // laptop, which is every time a human runs it. MOUNT_PATH selects the mode; it is not a
    // prerequisite, and deciding the mode is `cron hydrate`'s job, not this one's.
    //
    // WHAT THIS COSTS: from a laptop each agent is now a Fargate task (~30-60s), run sequentially, and
    // `cron hydrate` PURGES the owner's store before re-seeding — so an archie-created job that is not
    // in the agent's EFS jobs.json does not survive. Both were always true of the phase; they were just
    // never reached. `--skip-cron` is the way out.
    out.progress('cron: folding in per-agent cron. Each agent PURGES its owner\'s dispatcher store then '
      + 're-seeds from EFS; without MOUNT_PATH this runs as one ephemeral Fargate task per agent.');
    let hydrated = 0;
    for (const { scope, efsRoot } of roster) {
      try {
        // `efsRoot`, the legacy DIRECTORY — the opposite identifier to the runtime phase above, and
        // deliberately so: `cron hydrate` reads the jobs file out of that directory (HYDRATE_AGENT is a
        // path), then resolves the OWNER itself through the same resolveScopeOwner. Handing it a scope
        // id makes it wipe the store and seed nothing.
        await wrappers['cron hydrate'](ctx, { positionals: [efsRoot], values: {} }, out, deps.wrapperDeps);
        hydrated += 1;
      } catch (e) {
        out.failure({ agent: scope, step: 'cron-hydrate', error: e });
      }
    }
    result.phases.cron = { hydrated, failed: roster.length - hydrated };
  }
  return result;
}

/**
 * The agents to migrate: `--agents a,b` or the routing GSI. Returns `{ scope, efsRoot }` per agent.
 *
 * The agent list is `lib/agents.listAgents` (`AGENT#` keys) — the same one `agent-migrate.js` uses, so the
 * roster reflects what is actually ROUTED rather than what someone remembered to list.
 *
 * ── WHY TWO IDENTIFIERS, AND WHY THIS USED TO RETURN THE WRONG ONE ──────────────────────────────
 *
 * `--agents` is spelled in CONFIG-REPO names, because that is what the config phase consumes. This
 * returned that string verbatim, and the runtime phase used it AS THE AGENT ID. Under §8.10 those are
 * different things: hydrating `agent-xx9aff` writes `AGENT#dm-ux0mz5ckp2r` (the scope derived
 * from its slack.json), so the runtime phase provisioned an identity the config phase had not created
 * — and, finding nothing there, MINTED one: a derived IAM role, an EFS access point, a Connector
 * secret, a workspace SEED, a marketplace seed and a runtime, all under `agent-xx9aff`. Nothing
 * routes to it, so it can never serve a turn, while the real scope was left with no runtime binding.
 * Measured live 2026-08-21; the phantom had to be torn down by hand.
 *
 * So the two later phases need DIFFERENT identifiers, and neither is "the string the operator typed":
 *
 *   scope    the archie identity — what runtimes, roles, grants and access points are keyed by.
 *            Resolved by `wrappers.resolveScopeOwner`, the SAME resolver `cron hydrate` uses. Not a
 *            second implementation: one link, so the phases cannot drift apart again.
 *   efsRoot  the legacy OpenClaw DIRECTORY on EFS. `cron hydrate` reads the jobs file from it
 *            (`HYDRATE_AGENT` is a path, not an identity), so passing a scope id there wipes the
 *            store and seeds nothing — the mirror-image of the bug above. With `--agents` this is the
 *            name as typed, which is already what the directory is named after; without it, META's own
 *            `efsRoot`. So the routing GSI is read ONLY on the unscoped path — a scoped run costs one
 *            resolver call per name and no table scan.
 */
async function agentRoster(ctx, clients, args, out, deps) {
  const listed = String(args.values.agents || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (listed.length) {
    const wrappers = deps.modules.wrappers();
    const roster = [];
    for (const name of listed) {
      // REFUSES rather than guessing when a name resolves to nothing — which is the whole point. The
      // old behaviour for an unresolvable name was to provision it, and that is what minted the phantom.
      const scope = await wrappers.resolveScopeOwner(ctx, { values: {} }, out, deps.wrapperDeps, name);
      if (scope !== name) out.progress(`${name} → ${scope}  (§8.10 scope id; efsRoot ${name})`);
      // The typed name IS the EFS directory: `--agents` is spelled in config-repo names, which is what
      // the legacy directories are named after. No routing read needed for this branch.
      roster.push({ scope, efsRoot: name });
    }
    return roster;
  }
  // NO --agents: EVERY agent (`AGENT#` keys, lib/agents.js), each with its own efsRoot from META.
  //
  // This used to read the routing GSI, which returned the META body in the same query — convenient,
  // but the index cannot see a MINTED agent, so an unscoped run silently skipped every agent that had
  // never been hydrated. `AGENT#` answers "which agents" completely; `legacyEfsRootOf` answers "which
  // directory" per agent, and it is the SAME reader the dispatcher and `fleet drift` use, so there is
  // no second interpretation of that field.
  //
  // One GetItem per agent instead of one Query for all of them. This is a migration command run by
  // hand over a fleet in the low hundreds, off any hot path — the completeness is worth the N reads.
  //
  // efsRoot defaults to the scope id: an agent minted under §8.10 never had a legacy directory, so its
  // workspace already lives at its own name. Only a rekeyed/hydrated agent carries a different one.
  const rows = await listAgents(clients.doc, ctx.resources.configTable);
  const roster = [];
  for (const { agent } of rows) {
    const legacy = await legacyEfsRootOf({ doc: () => clients.doc }, ctx, agent);
    roster.push({ scope: agent, efsRoot: legacy || agent });
  }
  return roster;
}

// ── §2.22 `archie agent rekey` ───────────────────────────────────────────────────────────────────

/**
 * Move `AGENT#<name>` to its scope key (`AGENT#dm-<user>` / `AGENT#ch-<channel>`), carrying `GRANT#`.
 *
 * THREE THINGS THIS COMMAND SAYS OUT LOUD BEFORE IT DOES ANYTHING:
 *
 *   BOTH PARTITIONS MOVE. Grants live in their own `GRANT#<id>` partition so agent roles can be
 *   IAM-denied write access to them, which means "rekeying an identity has to move BOTH partitions or
 *   the agent silently loses its capability grants" (rekey-to-scope.mjs:20-23). The `cmds` bundle
 *   below includes `QueryCommand` deliberately: without it `readGrantItems` falls back to the
 *   agent-wide `SCOPE#*` alone and every per-channel grant is left behind (:34-38).
 *
 *   EFS IS ADOPTED, NOT COPIED. `META.efsRoot` is set to the OLD name so the new identity's access
 *   point points at the old directory (:16-18). Nothing is moved on the filesystem, and nothing here
 *   needs to be.
 *
 *   IT IS NOT ATOMIC. Puts, then a delete (:96-98). A crash between them leaves BOTH identities
 *   routed. Saying so before starting is the only honest thing available — DynamoDB has no
 *   cross-partition transaction here, and adding one would be a rewrite, not a wrapper.
 */
async function rekey(ctx, args, out, deps) {
  const agent = agentIdOf(args, 'agent name');
  if (!args.values['to-scope']) {
    throw usage('`archie agent rekey <agent> --to-scope` — the target must be named', {
      detail: 'Scope-keying is the only rekey there is today, and it is spelled out rather than implied so '
        + 'that a future second target cannot silently inherit this command\'s meaning.',
    });
  }
  const clients = awsClients(ctx, deps);
  const { rekeyAgent } = await deps.modules.rekey();

  out.progress('rekey moves BOTH partitions (AGENT# and GRANT#) — a move of one alone silently strips the '
    + 'agent\'s capability grants (rekey-to-scope.mjs:20-23)');
  out.progress('EFS is ADOPTED, not copied: META.efsRoot points the new access point at the old directory');
  out.progress('NOT ATOMIC: puts then a delete (:96-98). A crash between them leaves BOTH identities routed — '
    + 're-running converges, but check `archie status` if this run dies mid-way.');

  const r = await rekeyAgent({
    doc: clients.doc,
    table: ctx.resources.configTable,
    name: agent,
    dryRun: ctx.dryRun,
    cmds: {
      GetCommand: clients.docCmds.GetCommand,
      PutCommand: clients.docCmds.PutCommand,
      DeleteCommand: clients.docCmds.DeleteCommand,
      // REQUIRED, not optional — see above.
      QueryCommand: clients.docCmds.QueryCommand,
    },
  });
  if (r.skipped) {
    out.progress(`${agent} is already scope-keyed (${r.scopeId}) — nothing to do`);
    return { agent, ...r };
  }
  if (!ctx.dryRun) {
    // The identity moved; the RUNTIME bindings did not. Runtime rows are keyed `RUNTIME#<agent>` and
    // the runtime name fingerprints the agent id, so the scope identity has no binding until it is
    // provisioned, and its derived role (`role/agentcore/<id>`) is a different role that does not
    // exist yet. Both are repaired by the next stage/ensure-runtime — but only if someone knows.
    out.warn(`${r.scopeId} has no runtime binding and no derived IAM role yet: both are keyed by agent id. `
      + `Run \`archie agent ensure-runtime ${r.scopeId} --tag <tag>\` (or stage the fleet) before its `
      + 'next turn, or that turn fails closed.');
  }
  return { agent, ...r };
}

// ── §2.22 `archie agent teardown` ────────────────────────────────────────────────────────────────

/**
 * Delete runtimes, the access points they mounted, and the config-table items of the agents they
 * belonged to. `agent-teardown.js` (:95, :108, :120), with the guards §5.6 requires.
 *
 * THREE INDEPENDENT GUARDS, ALL REQUIRED:
 *   1. dry-run by default (registry `dryRunDefault: true`) — writing needs `--no-dry-run`;
 *   2. an explicit `--name-re`. There is NO "all agents" default and no way to spell one;
 *   3. a skip pattern, applied AFTER the regex, excluding `bench_|bdd_|exp_|streamval_|…`.
 *
 * Guard 3 is where this file DIVERGES FROM THE SCRIPT, and the divergence is a bug fix:
 * `agent-teardown.js:87` applies `SKIP_RE` only when no `--name-re` was given
 * (`NAME_RE ? NAME_RE.test(name) : !SKIP_RE.test(name)`), so passing a regex silently disarms the
 * scratch-fleet protection — the exact combination an operator reaches for. §5.6 says "applied
 * *after* `--name-re`", so it is.
 *
 * TWO MORE DIVERGENCES, both narrowing:
 *   ONLY THIS DEPLOYMENT'S RUNTIMES. Runtime names carry no deployment prefix, and the sandbox runs
 *   two stacks side by side, so ownership is PROVED from each runtime's own `AGENT_CONFIG_TABLE`
 *   rather than assumed from its name (the rule `runtime gc --reconcile-aws` already uses). Anything
 *   else is reported as foreign and never touched.
 *   ONLY THESE AGENTS' TABLE ITEMS. The script wipes the WHOLE table (`clearTable`, :120) regardless
 *   of `--name-re`, which under a scoped regex would delete 207 other agents' config. Items are
 *   deleted per matched agent, and the agent id comes from the runtime's own `AGENT_NAME` env var, so
 *   the mapping is read off the resource rather than guessed from a sanitised name.
 */
/**
 * Delete each scope's jobs from the DISPATCHER cron store, as part of teardown (§E2).
 *
 * WHY THIS NEEDS A TASK AT ALL. The store is not in DynamoDB — it is one file per owner on the
 * dispatcher's own EFS mount (`/efs/cron/<agentId>.json`, cron-store.js:4) with exactly one writer.
 * So teardown cannot delete it the way it deletes table items; it has to ask the manager API, and
 * that API is behind an internal load balancer reachable only from inside the VPC. An ephemeral Fargate task
 * is the same mechanism `archie cron hydrate` already uses to reach it.
 *
 * WHY IT RUNS FIRST, BEFORE THE RUNTIMES GO. A job is an ARMED TIMER in the dispatcher. Deleting the
 * runtime first leaves timers that fire turns at a runtime that no longer exists — a burst of failed
 * invokes attributed to an agent nobody can look up. Purging first disarms them (cron-service.js:206)
 * while the agent it belongs to still exists, so the teardown is quiet.
 *
 * NOT FATAL. A purge failure must not strand a half-torn-down agent: the runtimes, access points and
 * table items still have to go. It reports a failure (exit 6 PARTIAL) and names what was left, which
 * is the honest outcome — jobs in the store whose owner no longer exists are exactly the ghost this
 * step exists to prevent, and silence about them is what let one survive to 2026-08-19.
 */
async function purgeCronStores(ctx, agents, out, deps) {
  const { discoverFacts, readGatewayConfig } = require('../lib/deployment-facts');
  const { composeCronPurgeTaskDefinition } = require('../lib/task-definition');
  const { runEphemeralTask } = require('../lib/run-task');
  const { makeClient } = require('../lib/aws');

  const ecs = deps.ecs || makeClient(ctx, '@aws-sdk/client-ecs', 'ECSClient');
  const logs = deps.logs || makeClient(ctx, '@aws-sdk/client-cloudwatch-logs', 'CloudWatchLogsClient');

  const config = await readGatewayConfig(ctx, deps);
  const facts = await discoverFacts(ctx, config, deps);
  const { readDeployedGatewayImage } = deps.modules.wrappers()._internals;
  const deployed = await readDeployedGatewayImage(ctx, ecs, deps);

  const results = [];
  for (const agent of agents) {
    const taskDefinition = composeCronPurgeTaskDefinition({
      resources: ctx.resources, region: ctx.region, facts, image: deployed.image, ownerAgentId: agent,
    });
    const result = await runEphemeralTask({
      ecs,
      logs,
      taskDefinition,
      cluster: ctx.resources.cluster,
      subnets: facts.subnetIds,
      // The gateway admits 9090 only from the runtime and hydrator groups, so any other choice fails
      // as a bare "fetch failed" from the manager API call. Same reasoning as `cron hydrate`.
      securityGroups: [facts.cronHydratorSecurityGroupId],
      logGroup: ctx.resources.dispatcherLogGroup,
      streamPrefix: 'cron-purge',
      out,
      now: deps.now,
    });
    for (const line of result.logLines || []) out.progress(`            ${line}`);
    results.push({ agent, ...result });
  }
  return results;
}

/**
 * `removed` out of the purge task's own log lines — the task's report IS the count.
 *
 * Returns `{ removed, reports, unparsed }`. `reports` is load-bearing: a task can exit 0 having
 * printed no summary at all (a container that started and died quietly), and `removed: 0` then means
 * "nothing to purge" and "we never heard" identically. The caller distinguishes them.
 */
function purgedJobCount(logLines) {
  let removed = 0;
  let reports = 0;
  let unparsed = 0;
  for (const line of logLines || []) {
    let o = null;
    try {
      o = JSON.parse(line);
    } catch {
      // Not swallowed — counted. A non-JSON line is normally the container's own startup noise, but a
      // run that is ALL noise is a run whose report we did not get, which the caller must not read as
      // a clean zero.
      unparsed += 1;
    }
    if (o && o.purged && typeof o.purged.removed === 'number') { removed += o.purged.removed; reports += 1; }
  }
  return { removed, reports, unparsed };
}

async function teardown(ctx, args, out, deps) {
  // THE GUARDS COME FIRST, before a client is built or an account is resolved. A refusal an operator
  // can only see once their credentials load is a refusal that reads as a credentials problem — and
  // the whole value of "there is no all-agents default" is that it is the first thing you hit.
  // `--agent <scope>` IS THE PREFERRED FORM, and it exists because `--name-re` makes the operator
  // hand-write the thing most likely to be wrong. `isGenerationOf` is imported from the client rather
  // than re-expressed as a regex here, so teardown and the GC cannot disagree about which runtimes
  // belong to an agent — including the pre-generation bare name, which a naive
  // `^oc_<agent>_[0-9a-f]{8}$` silently misses and thereby strands one runtime per agent.
  const only = args.values.agent || null;
  const nameRe = compileRe(args.values['name-re'], '--name-re');
  if (only && args.values['name-re']) {
    throw usage('--agent and --name-re are mutually exclusive', {
      detail: 'They are two ways to say the same thing and a disagreement between them has no safe reading. '
        + 'Prefer --agent <scope>; reach for --name-re only for residue that carries no AGENT_NAME.',
    });
  }
  if (!only && !nameRe) {
    throw usage('teardown requires --agent <scope> (preferred) or an explicit --name-re <regexp>', {
      detail: 'There is deliberately no "all agents" default (§5.6). `archie runtime list` shows the names.',
    });
  }
  const matches = only ? ((name) => isGenerationOf(name, only)) : ((name) => nameRe.test(name));
  const skipRe = args.values['skip-re'] === undefined ? DEFAULT_SKIP_RE : compileRe(args.values['skip-re'], '--skip-re');
  if (!skipRe) throw usage('--skip-re cannot be empty — the skip pattern is a guard, not a preference (§5.6)');

  const clients = awsClients(ctx, deps);
  const account = await resolveAccount(ctx, clients);
  const config = dispatcherClient(ctx, account, deps).config;

  // Enumeration is `ListAgentRuntimes`, unavoidably: the registry only knows what it recorded, and a
  // teardown that misses a runtime whose registry write was lost leaves it running and billing.
  const { ListAgentRuntimesCommand, GetAgentRuntimeCommand, DeleteAgentRuntimeCommand } = clients.controlCmds;
  const matched = [];
  const skipped = [];
  const foreign = [];
  let scanned = 0;
  let token;
  do {
    const r = await clients.control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
    for (const rt of r.agentRuntimes || []) {
      scanned += 1;
      const name = rt.agentRuntimeName || '';
      if (!matches(name)) continue;
      // AFTER the regex. See the header.
      if (skipRe.test(name)) { skipped.push(name); continue; }
      matched.push({ runtimeId: rt.agentRuntimeId, runtimeName: name });
    }
    token = r.nextToken;
  } while (token);

  const targets = [];
  for (const m of matched) {
    let g;
    try {
      g = await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: m.runtimeId }));
    } catch (e) {
      if (/ResourceNotFound/i.test((e && e.name) || '')) continue;   // already gone
      // A runtime we cannot read is a runtime whose access point and owner we do not know. Fail
      // CLOSED on the whole command rather than deleting resources we cannot attribute.
      throw new CliError(`could not read runtime ${m.runtimeName}; refusing to guess what it owns`, { code: EXIT.FAILED, cause: e });
    }
    const envs = g.environmentVariables || {};
    const record = {
      ...m,
      agent: envs.AGENT_NAME || null,
      configTable: envs.AGENT_CONFIG_TABLE || null,
      status: g.status || null,
      accessPointArn: accessPointArnOf(g),
    };
    if (record.configTable !== ctx.resources.configTable) { foreign.push(record); continue; }
    targets.push(record);
  }
  if (foreign.length) {
    out.warn(`${foreign.length} matching runtime(s) belong to another deployment (their AGENT_CONFIG_TABLE is `
      + `not ${ctx.resources.configTable}) — reported, never touched`);
  }

  // ONE AGENT AT A TIME IS THE DEFAULT (2026-08-18). A `--name-re` wide enough to span two agents
  // is almost always a mistake rather than an intent, and the blast radius is per-agent: each extra
  // agent loses its runtimes and its table items. `--agent` cannot trip this; `--name-re` has to opt in
  // with `--multi-agent`, which makes "I meant all of these" an explicit statement rather than a regex
  // side effect. Checked BEFORE any table scan, so the refusal costs nothing.
  const spannedAgents = [...new Set(targets.map((t) => t.agent).filter(Boolean))].sort();
  if (spannedAgents.length > 1 && !args.values['multi-agent']) {
    throw refused(`--name-re matched runtimes for ${spannedAgents.length} agents: ${spannedAgents.join(', ')}`, {
      detail: 'Teardown is per-agent by default. Re-run with --agent <scope> for one of them, or pass '
        + '--multi-agent if you really mean all of them.',
    });
  }

  // ACCESS POINTS GO TOO — part of "leave no trace" (2026-08-19). Deleting one does not lose EFS
  // data — the directory survives, and a re-provision recreates the AP at the same root from
  // META.efsRoot — but it does BREAK THE NEXT BOOT of any agent whose workspace has content. A fresh AP
  // sets `ap.selfCreated`, which makes the dispatcher pre-write the baked skeleton SEED; the next boot
  // then takes workspace-seed's "loaded" branch and throws `seed guard FATAL` for any skeleton file the
  // live workspace does not have. Teardown CANNOT check for that: EFS has no API to list a directory,
  // so the tool has no way to tell an empty workspace from a 125 GB one.
  //
  // So the default is the reversible half (runtimes + recreatable table items) and detaching a live
  // workspace is a separate, deliberate act. `access-point gc` is the command for reaping APs that have
  // no live runtime, which is the safe case by construction.
  // Kept as a deliberate escape hatch rather than a default: --keep-access-points is for the case where the
  // workspace is SHARED with a still-running OpenClaw agent and you want the archie mount left alone. It does
  // not protect data either way (the directory survives an AP delete; a re-provision recreates the AP at the
  // same root from META.efsRoot), so the only thing it changes is whether the next boot sees a fresh AP.
  const wantAps = !args.values['keep-access-points'];

  // Access points: only the ones these runtimes actually mount, and only if tagged. Both filters are
  // required — the tag is what IAM permits deletion by, and ECS / agent-xx9aff / filebrowser access
  // points do not carry it (agent-teardown.js:33,77).
  const mounted = new Set(targets.map((t) => t.accessPointArn).filter(Boolean));
  // Two ways in, because a mounted-only lookup misses exactly the no-runtime case above. The dispatcher
  // names each access point after the scope it belongs to, so an explicitly named scope is matched by NAME
  // as well as by "mounted by a runtime we just deleted". Still gated on the managed-by tag below, which is
  // the only thing IAM permits deletion by — ECS, filebrowser and legacy access points stay untouchable
  // either way.
  const onFs = wantAps
    ? (await describeAccessPoints(clients, config.efsFsId))
      .filter((ap) => mounted.has(ap.AccessPointArn) || (only && ap.Name === only))
    : [];
  const aps = onFs.filter(tagged).map((ap) => ({ accessPointId: ap.AccessPointId, path: (ap.RootDirectory || {}).Path || null }));
  if (!wantAps && mounted.size) {
    out.progress(`${mounted.size} mounted access point(s) LEFT IN PLACE (--keep-access-points) — the `
      + 'workspaces stay attached and the next provision reuses them.');
  }
  const untagged = onFs.filter((ap) => !tagged(ap)).map((ap) => ap.AccessPointId);
  if (untagged.length) {
    out.warn(`${untagged.length} mounted access point(s) are not tagged ${AP_TAG_KEY}=${AP_TAG_VALUE} — left alone `
      + `(${untagged.join(', ')}). IAM permits DeleteAccessPoint only by that tag, so this is a refusal at both ends.`);
  }
  const elsewhere = [...mounted].filter((arn) => !onFs.some((ap) => ap.AccessPointArn === arn));
  if (elsewhere.length) {
    out.warn(`${elsewhere.length} mounted access point(s) are not on ${config.efsFsId} — left alone. A runtime `
      + 'mounting another filesystem is outside this deployment\'s EFS and is not ours to delete.');
  }

  // AN EXPLICIT --agent MEANS THE SCOPE, NOT ITS RUNTIMES (2026-08-19). Enumeration starts from
  // ListAgentRuntimes, so a scope whose runtime was already deleted matched NOTHING: teardown reported
  // "0 items deleted" while CONNECTOR, MARKETPLACE and the access point sat there untouched. That is how a
  // half-alive scope survived a teardown and later refused a deploy at check 4. Naming a scope is an
  // instruction to remove whatever remains of it, runtime or not.
  const agents = [...new Set([...targets.map((t) => t.agent), ...(only ? [only] : [])].filter(Boolean))].sort();
  const orphanRuntimes = targets.filter((t) => !t.agent).map((t) => t.runtimeName);
  if (orphanRuntimes.length) out.warn(`${orphanRuntimes.length} runtime(s) carry no AGENT_NAME — their runtimes and access points go, their table items stay`);
  const keys = agents.length ? await agentItemKeys(clients, ctx.resources.configTable, agents) : [];

  // CRON JOBS GO TOO (2026-08-19). They are not table items and not on the agent's own mount,
  // so nothing else in this command reaches them: without this step a torn-down scope leaves its jobs
  // armed in the dispatcher store, and the next hydrate of that scope resurrects them alongside the
  // real ones. Observed exactly that on 2026-08-19 — a deleted job reappeared in archie's store.
  // --keep-cron is the escape hatch for the case where the store is deliberately being preserved
  // across a re-provision (the same shape as --keep-access-points).
  const wantCron = !args.values['keep-cron'];
  if (!wantCron && agents.length) {
    out.progress(`cron store LEFT IN PLACE (--keep-cron) — ${agents.join(', ')} keeps its jobs, and a `
      + 're-hydrate will merge them with whatever EFS holds.');
  }

  out.progress(`${scanned} runtime(s) scanned · ${targets.length} matched · ${skipped.length} skipped by the `
    + `pattern · ${foreign.length} foreign`);
  out.progress(`${aps.length} access point(s) · ${keys.length} table item(s) across ${agents.length} agent(s)`);
  if (wantCron && agents.length) {
    // The count is deliberately not promised here. Enumerating it means reading the store, which is
    // in-VPC only, so a laptop dry-run cannot know it without running a task — and running one to
    // preview a destructive step is worse than saying so.
    out.progress(`cron store PURGED for ${agents.length} scope(s): ${agents.join(', ')} — job count is not `
      + 'knowable from outside the VPC, so it is reported by the task, not predicted here');
  }
  for (const t of targets) out.verbose(`delete runtime ${t.runtimeName} (${t.agent || 'unknown agent'})`);

  const plan = {
    selector: only ? { agent: only } : { nameRe: String(nameRe) },
    skipRe: String(skipRe),
    accessPointsRequested: wantAps,
    scanned,
    runtimes: targets.map((t) => ({ runtimeName: t.runtimeName, runtimeId: t.runtimeId, agent: t.agent, status: t.status })),
    skipped,
    foreign: foreign.map((f) => ({ runtimeName: f.runtimeName, configTable: f.configTable })),
    accessPoints: aps,
    agents,
    tableItems: keys.length,
    cronPurgeRequested: wantCron,
    // §6.4: never claim a clean teardown. Workload identities and agentic_ai ENIs survive runtime
    // deletion, cannot be removed by the caller, and pin the runtime security group indefinitely.
    //
    // The cron clause changed on 2026-08-19: the DISPATCHER store is now purged (below), but
    // OpenClaw's own store — `<efsRoot>/cron/jobs.json` on the agent's EFS directory — is untouched
    // and must stay that way. It is the migration SOURCE and OpenClaw's live scheduler reads it, so
    // deleting it would silently drop the schedules of an agent that is still being served by
    // OpenClaw. That is the one thing teardown must not do while both stacks are up.
    residue: 'workload identities and agentic_ai ENIs survive runtime deletion and are NOT cleaned (§6.4); '
      + `the dispatcher cron store is ${wantCron ? 'purged' : 'NOT purged (--keep-cron)'}, but OpenClaw's own `
      + 'EFS cron store (<efsRoot>/cron/jobs.json) is never touched — it is the hydration source and '
      + 'OpenClaw is still firing from it',
  };
  if (ctx.dryRun) {
    out.progress('dry-run: nothing deleted. Re-run with --no-dry-run.');
    return { dryRun: true, ...plan };
  }

  const deleted = { runtimes: [], accessPoints: [], tableItems: 0, cronJobs: 0, cronScopes: [] };
  // BEFORE THE RUNTIMES. See purgeCronStores' header: an armed timer outliving its runtime fires
  // turns into a void, so disarm while the agent still exists.
  if (wantCron && agents.length) {
    try {
      for (const r of await deps.purgeCron(ctx, agents, out, deps)) {
        if (r.exitCode !== 0) {
          out.failure({ agent: r.agent, step: 'cron purge', error: new Error(`purge task exited ${r.exitCode}`) });
          continue;
        }
        const { removed, reports, unparsed } = purgedJobCount(r.logLines);
        deleted.cronScopes.push(r.agent);
        deleted.cronJobs += removed;
        // EXIT 0 WITH NO REPORT IS NOT A CLEAN PURGE. The count comes from the task's own log, so a run
        // that printed no summary tells us nothing about the store — and reporting that as "0 jobs"
        // is the same false all-clear that let a ghost job survive in the first place.
        if (!reports) {
          out.warn(`cron purge for ${r.agent} exited 0 but printed no summary (${unparsed} unparsed line(s)) — `
            + 'the store state is UNKNOWN, not empty. Check `GET /cron/' + r.agent + '` on the manager API.');
        }
      }
    } catch (e) {
      // Includes "the dispatcher is not running" — the purge needs the gateway up to answer, and a
      // torn-down environment legitimately has none. Named, not swallowed: jobs may remain.
      out.failure({ agent: agents.join(','), step: 'cron purge', error: e });
      out.warn('cron store NOT purged — any jobs these scopes own are still in the dispatcher store and '
        + 'will reappear on the next hydrate. Re-run teardown once the gateway is up, or purge with '
        + '`DELETE /cron/<scope>` on the manager API.');
    }
  }
  for (const t of targets) {
    try {
      await clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: t.runtimeId }));
      deleted.runtimes.push(t.runtimeName);
    } catch (e) {
      out.failure({ agent: t.agent, step: 'runtime delete', error: e });
    }
  }
  // RUNTIME FIRST, THEN THE ACCESS POINT, with a settling pause (phase3-e2e.mjs:183): while AWS still
  // has the runtime, its access point is attached and the delete fails. Note we do NOT wait for the
  // NAME to be released — teardown is not re-creating these names, and AgentCore holds a deleted
  // runtime's name for 3.5-10+ minutes (agentcore-provisioning.js:410-421), so a wait here would add
  // ten minutes to every teardown for nothing. A subsequent re-provision of the SAME name is what
  // pays that cost, and `runtime delete` is the command that waits.
  if (aps.length) {
    await deps.sleep(AP_SETTLE_MS);
    for (const ap of aps) {
      try {
        await clients.efs.send(new clients.efsCmds.DeleteAccessPointCommand({ AccessPointId: ap.accessPointId }));
        deleted.accessPoints.push(ap.accessPointId);
      } catch (e) {
        out.failure({ agent: ap.path, step: 'access point delete', error: e });
      }
    }
  }
  if (keys.length) {
    // BatchWriteItem returns HTTP 200 with the items it REFUSED under `UnprocessedItems`. Firing and
    // moving on reports a complete teardown for a partial one, so a "cleared" table silently keeps
    // items and the next migrate/hydrate runs on top of them (batch-write.mjs:3-13). This helper
    // retries the leftovers and THROWS rather than under-report.
    const { batchWriteAll } = await deps.modules.batchWrite();
    deleted.tableItems = await batchWriteAll(clients.doc, ctx.resources.configTable,
      keys.map((Key) => ({ DeleteRequest: { Key } })),
      { BatchWriteCommand: clients.docCmds.BatchWriteCommand, logger: loggerFor(out) });
  }
  out.progress(`deleted ${deleted.runtimes.length} runtime(s), ${deleted.accessPoints.length} access point(s), `
    + `${deleted.tableItems} table item(s), ${deleted.cronJobs} cron job(s) across `
    + `${deleted.cronScopes.length} scope(s)`);
  return { ...plan, deleted };
}

/** `--name-re` / `--skip-re`, compiled where a bad pattern is a usage error rather than a stack trace. */
function compileRe(value, flag) {
  if (value === undefined || value === null || value === '') return null;
  try {
    return new RegExp(value);
  } catch (e) {
    throw usage(`${flag} is not a valid regular expression: ${e.message}`);
  }
}

/** The AP arn a runtime mounts, across both spellings AgentCore has returned (agentcore-client.js:490). */
function accessPointArnOf(g) {
  const fs0 = (g && g.filesystemConfigurations && g.filesystemConfigurations[0]) || null;
  const ap = fs0 && fs0.efsAccessPoint;
  return (ap && (ap.accessPointArn || ap.efsAccessPointArn)) || null;
}

/**
 * Every table item belonging to these agents — `AGENT#<id>`, `GRANT#<id>` and `RUNTIME#<id>`.
 *
 * One Scan rather than three Queries per agent: at every agent in the fleet that is one request set instead of
 * 624, and unlike `ListAgentRuntimes` a table Scan is ours and is not rate-capped account-wide. Every
 * projected attribute name is ALIASED — `pk`/`sk` are not reserved words, but writing them bare here
 * and not elsewhere is how the habit erodes.
 */
/**
 * Every item key this teardown deletes: the agent's three partitions, in full.
 *
 * NO PRESERVATION (2026-08-19). An earlier
 * version of this held back AGENT#<a>/CONNECTOR and AGENT#<a>/MARKETPLACE on the grounds that hydration
 * cannot rewrite them — CONNECTOR because Connector will not reissue a project key, MARKETPLACE because its
 * `connectors` record OAuth flows a human completed. Both facts are still true, and both were the wrong
 * reason to leave items behind:
 *
 *   * A partial teardown is not a state anyone asked for. It leaves the environment half-alive, so
 *     "torn down" and "still there" become indistinguishable to every other command — `policy publish`
 *     check 4 read the leftovers as a live scope and refused a deploy over it.
 *   * The operator, not this command, decides what is worth keeping. Teardown is explicit and per-agent;
 *     hydration is how an agent comes back. Withholding items to protect the operator from their own
 *     instruction just moved the surprise later.
 *
 * WHAT IT COSTS, stated so nobody has to rediscover it: the agent's Connector PROJECT survives at the
 * upstream but its key is gone from our side, so `agent ensure-connector` provisions a NEW project on the
 * next hydrate and the old one's connected accounts are orphaned — every toolkit needs re-authorizing.
 * That is the price of a clean teardown, and it is the operator's to pay knowingly.
 *
 * CONFIG#* IS STILL OUT OF SCOPE, and that is not softness: `CONFIG#image` holds the live fleet pointer and
 * the TAINT#<digest> records, which are fleet-wide rather than per-agent. This function keys only off the
 * three per-agent prefixes so it cannot reach them.
 */
async function agentItemKeys(clients, table, agents) {
  const prefixes = agents.flatMap((a) => [`AGENT#${a}`, `GRANT#${a}`, `RUNTIME#${a}`]);
  const wanted = new Set(prefixes);
  const scopes = new Set(agents);
  const keys = [];
  let ExclusiveStartKey;
  do {
    const r = await clients.doc.send(new clients.docCmds.ScanCommand({
      TableName: table,
      // `data` is projected only to read the CRON alias below. Everything else is decided by the key.
      ProjectionExpression: '#pk, #sk, #d',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk', '#d': 'data' },
      ExclusiveStartKey,
    }));
    for (const item of r.Items || []) {
      if (typeof item.pk !== 'string') continue;
      if (wanted.has(item.pk)) { keys.push({ pk: item.pk, sk: item.sk }); continue; }
      // THE LEGACY-NAME CRON ALIAS, which the three prefixes above cannot reach (2026-08-19).
      //
      // Cron hydration writes `AGENT#<legacyName>/CRON -> {alias: <scopeId>}` so the OpenClaw gate can
      // find a scope-keyed runner flag while knowing only its config-repo AGENT_NAME. It is keyed by the
      // LEGACY NAME, so a per-scope teardown left it behind — I previously called that correct, and it is
      // not: it is a per-agent row, so it is part of that agent's footprint, and leaving it makes the
      // table hold a pointer into a partition that no longer exists.
      //
      // Deleting it is also the right SIGNAL rather than merely tidy. The gate falls back to firing here
      // when the flag is absent, and absent is exactly the truth after a teardown: there is no archie
      // agent to run those crons, so OpenClaw should. Both states already reach that outcome — an absent
      // alias resolves to 'default', and a dangling one logs "alias points at a missing row — firing
      // here" — so this changes no behaviour today. It removes a stale pointer whose next reader has to
      // work out that it means nothing.
      //
      // MATCHED BY ITS TARGET, not by META.efsRoot: teardown deletes META in the same run, and the
      // already-torn-down case has no META at all, so resolving the legacy name that way would work only
      // in the easy case. The alias names the scope it points at, which is the fact we have.
      if (item.sk === 'CRON' && typeof item.data === 'string') {
        try {
          const body = JSON.parse(item.data);
          if (typeof body.alias === 'string' && scopes.has(body.alias)) keys.push({ pk: item.pk, sk: item.sk });
        } catch { /* a malformed row is not an alias; the key-matched pass above still covers it */ }
      }
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return keys;
}

// ── exports ──────────────────────────────────────────────────────────────────────────────────────
//
// FULL COMMAND KEYS, NEVER BARE VERBS. `registry.load()` resolves `mod[key] || mod[verb]`, and a
// verb-keyed export in one module can answer for another noun's identically-named verb — the reason
// cmd/runtime.js and cmd/wrappers.js do the same. `migrate`, `rekey` and `teardown` are unique to
// this noun today, and exporting them by verb anyway would make that an accident rather than a rule.

module.exports = {
  'agent ensure-role': (ctx, args, out, deps) => ensureRole(ctx, args, out, withDefaults(deps)),
  'agent ensure-access-point': (ctx, args, out, deps) => ensureAccessPoint(ctx, args, out, withDefaults(deps)),
  'agent ensure-connector': (ctx, args, out, deps) => ensureConnectorCredential(ctx, args, out, withDefaults(deps)),
  'agent seed-workspace': (ctx, args, out, deps) => seedWorkspace(ctx, args, out, withDefaults(deps)),
  'agent ensure-runtime': (ctx, args, out, deps) => ensureRuntime(ctx, args, out, withDefaults(deps)),
  'agent migrate': (ctx, args, out, deps) => migrate(ctx, args, out, withDefaults(deps)),
  'agent rekey': (ctx, args, out, deps) => rekey(ctx, args, out, withDefaults(deps)),
  'agent teardown': (ctx, args, out, deps) => teardown(ctx, args, out, withDefaults(deps)),

  // Test seam for the pure helpers and the constants the reference quotes. Not part of the command
  // contract, and deliberately not named after any verb.
  _internals: {
    MIGRATE_CONCURRENCY, DEFAULT_SKIP_RE, AP_TAG_KEY, AP_TAG_VALUE, AP_SETTLE_MS, SAGA_FIXED_SPEC,
    withDefaults, agentIdOf, compileRe, accessPointArnOf, agentItemKeys, pool, resolveAccount,
    applyConnectorSecretEnv, resolveEfsRoot, describeAccessPoints, loggerFor,
  },
};

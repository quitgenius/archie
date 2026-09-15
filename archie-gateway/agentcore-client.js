'use strict';

// AgentCore client for the Slack dispatcher — the in-process "dynamic agent-manager".
//
// Two responsibilities for agents routed to AgentCore (slack.json `runtime: "agentcore"`):
//   ensureRuntime(agent)  → get-or-create the agent's runtime (+ its EFS access point),
//                           returning the runtime ARN. Cheap on the warm path. (#43)
//   invokeStreaming(...)  → InvokeAgentRuntime with an SSE response, parsing the Pi adapter's
//                           delta/tool/final/error events and calling onChunk per event. (#44)
//
// CommonJS to match the dispatcher (index.js / gateway-pool.js). AWS SDK v3 ships CJS builds,
// so `require` works. Config is env-driven with sandbox-sandbox defaults (Phase 3 wires prod env
// via dispatcher.tf); the constants mirror agentcore-provision/bench-cold-provision.mjs, the
// proven provisioning logic this module is the productionised form of.
//
// The create/provision path (ensureRuntime → ensureAccessPoint → createRuntime) now delegates to
// the shared idempotent orchestrator in agentcore-provisioning.js: get-or-create steps, a cleanup
// ledger with compensating deletes (the AP-leak fix), and TYPED (not regex) retry. invokeStreaming
// is unchanged. The module's SOLE stateful entry point is the `createAgentCoreClient(overrides)`
// factory (merges over the env-defaulted CONFIG); each instance owns its own arn cache + SDK
// clients. Consumers construct one instance at module load (e.g. index.js:
// `const { createAgentCoreClient } = require('./agentcore-client'); const agentCore =
// createAgentCoreClient();`) and call `.ensureRuntime`/`.invokeStreaming`/`.makeStreamBridge` on it.
// Pure/stateless utilities (createAgentCoreClient, sanitizeRuntimeName, feedSse, efsRootDir, and
// the resolved default CONFIG) are also exported as named module exports for standalone use.

const path = require('node:path');
const { existsSync } = require('node:fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const provisioning = require('./agentcore-provisioning');
const { createDispatcherMetrics } = require('./dispatcher-metrics');
const derivedRole = require('./derived-role'); // A2: lazy derived per-agent IAM role (§9.8)
const { createSemaphore } = require('./semaphore');
const { requestHandlerFor } = require('./sdk-http');
const { createRuntimeRegistry, createMemoryRuntimeRegistry, runtimeIdOf } = require('./runtime-registry');

// M2 phase spans: @opentelemetry/api ONLY — a no-op tracer until the entrypoint's
// `require('./tracing')` registers a provider. This library module must never require
// ./tracing itself (unit tests + standalone use stay side-effect free).
const {
  trace: otelTrace, SpanKind, SpanStatusCode, propagation, context: otelContext,
} = require('@opentelemetry/api');
const otelTracer = otelTrace.getTracer('slack-dispatcher');

// Env-defaulted base config. createAgentCoreClient(overrides) deep-merges over this.
function baseConfig() {
  const region = process.env.AGENTCORE_REGION || 'us-east-1';
  const account = process.env.AGENTCORE_ACCOUNT || '203366135563';
  return {
    region,
    account,
    // NO SHARED ROLE, AND NO FLAG (§9.9b). Two things were removed here on purpose:
    //
    //   `roleArn` — used to default to the fleet-shared clawdbot-agentcore-exec, and
    //   ensureAgentEnvironment did `role || config.roleArn`. Any path that failed to produce a derived
    //   role therefore provisioned the agent onto a role with UNCONDITIONED, TABLE-WIDE DynamoDB
    //   reads, silently. Fail-OPEN.
    //
    //   `derivedRolesEnabled` (DERIVED_ROLES_ENABLED) — the flag could only ever do one thing:
    //   downgrade the whole fleet onto that shared role. A security property any env var can switch
    //   off is not a property, so it is gone rather than merely defaulted on.
    //
    // Provisioning now ALWAYS mints a per-agent role, and ensureExecRole THROWS if it can't. A caller
    // may still pass an explicit `opts.role` (the BDD harness scopes per-leg roles to one EFS AP).
    //
    // DEPLOY ORDER: the Terraform that creates `agentcore-base` and the dispatcher's
    // iam:CreateRole/PassRole grant on role/agentcore/* must be applied BEFORE this image reaches an
    // environment — otherwise every provision fails closed on a missing policy or permission.
    baseManagedPolicyArn: process.env.AGENTCORE_BASE_POLICY_ARN || `arn:aws:iam::${account}:policy/agentcore-base`,
    // Current Pi image the fleet runs (bumped like clawdbot_image_tag).
    // NO BAKED IMAGE, AND NO TAG ENV (removed 2026-08-11). There used to be an
    // AGENTCORE_IMAGE_TAG default here, kept as a "floor" for when the DynamoDB pointer said
    // nothing. A floor is not a safety net — it is a silent downgrade: a table outage, a missing
    // item, or a typo'd publish would quietly run whatever build this dispatcher happened to be
    // compiled with, and the only symptom is agents behaving like an old release. That is the same
    // failure class as the mislabelled runtime (901f2c5cd) and the dropped image (previous commit):
    // wrong code running with nothing to indicate it.
    //
    // The image is now REQUIRED and comes from CONFIG#image only. If the table has no pointer,
    // provisioning fails loudly and alarms rather than guessing.
    //
    // What stays is the REPO — that is infrastructure (where images live), not a version. Resolving
    // a published bare `tag` needs somewhere to resolve it against.
    imageRepoUri: process.env.AGENTCORE_IMAGE_REPO_URI
      || `${account}.dkr.ecr.${region}.amazonaws.com/clawdbot-agentcore`,
    vpcId: process.env.AGENTCORE_VPC_ID || 'vpc-REDACTED',
    securityGroupId: process.env.AGENTCORE_SECURITY_GROUP_ID || 'sg-REDACTED',
    efsFsId: process.env.AGENTCORE_EFS_FS_ID || 'fs-REDACTED',
    efsMountPath: process.env.AGENTCORE_EFS_MOUNT_PATH || '/mnt/efs',
    // Root under which each agent's EFS access point is created. Env-driven so a SIDE-BY-SIDE test
    // stack can write to its own tree (e.g. /agentcore-test) instead of the live agents' data — the
    // test stack's data is expected to be erased, which cannot be true if it shares the live root.
    // It is part of the runtime fingerprint, so changing it rolls each agent on its next turn.
    efsRootPrefix: process.env.AGENTCORE_EFS_ROOT_PREFIX || '/openclaw-data',
    // AgentCore runs only in specific AZs; AZ *IDs* are stable across accounts (names scrambled).
    supportedAzIds: new Set((process.env.AGENTCORE_SUPPORTED_AZ_IDS || 'use1-az1,use1-az2,use1-az4').split(',').map((s) => s.trim())),
    // The runtime resolves its config from DynamoDB at boot (config-resolver resolve-boot).
    agentConfigTable: process.env.AGENT_CONFIG_TABLE || 'agent-4ggvzl-config',
    // agent_i32pz9.* spans → X-Ray (populates the dashboard's turn/token widgets). off|stdout|xray.
    otelMode: process.env.AGENTCORE_OTEL_MODE || 'xray',
    // Connector tools: the entrypoint fetches this secret → CONNECTOR_API_KEY (eager discovery
    // runs async under Pi, off the first-response path). Exec role already reads agent-4ggvzl-*.
    credentialSecret: process.env.CONNECTOR_API_KEY_SECRET || 'agent-4ggvzl-connector-api-key',
    credentialSecretRegion: process.env.CONNECTOR_API_KEY_SECRET_REGION || 'us-east-1',
    // ORG-scoped Connector key — DISPATCHER ONLY, never in an agent's environment. Unset disables
    // inline provisioning entirely (new agents fall back to the shared key), which is the correct
    // default for any deployment that has not deliberately granted the dispatcher this credential.
    connectorOrgSecret: process.env.CONNECTOR_ORG_API_KEY_SECRET || '',
    // Datadog REST creds for the `datadog` tool — shared demo-service org creds (entrypoint resolves
    // these → DATADOG_API_KEY/DATADOG_APP_KEY). Exec role reads agent-4ggvzl-*.
    datadogApiKeySecret: process.env.DATADOG_API_KEY_SECRET || 'agent-4ggvzl-datadog-api-key',
    datadogAppKeySecret: process.env.DATADOG_APP_KEY_SECRET || 'agent-4ggvzl-datadog-app-key',
    datadogKeySecretRegion: process.env.DATADOG_KEY_SECRET_REGION || 'us-east-1',
    // The artifacts bucket for `save_artifact` (file-publish-plugin). NO DEFAULT, deliberately: an
    // S3 bucket name is account-global, so a baked-in fallback would either point a deployment at
    // another account's bucket or at one that does not exist. Unset = the feature is off, and the
    // tool says so at call time. The derived role's S3 statement is keyed off the SAME env var
    // (derived-role.js artifactsBucket), so the grant and the destination cannot disagree.
    artifactsBucket: process.env.ARTIFACTS_S3_BUCKET || '',
    // Dispatcher connectivity for the runtime's cron tool (pi-cron-migration-plan §2b): the
    // tool calls the dispatcher manager API to schedule jobs. Base URL is the dispatcher's
    // own FQDN (same one it's reached at); the secret is resolved at boot from Secrets Manager
    // by pi-entrypoint. In sandbox the ALB serves a self-signed cert: nodeTlsReject='0' signals
    // the runtime to relax TLS — but pi-entrypoint now SCOPES that relaxation to only the
    // dispatcher + Hindsight hostnames (tls-scoped.mjs) and restores global cert verification,
    // rather than disabling it process-wide. Prod ALBs have real ACM certs → set this to '1'.
    dispatcherBaseUrl: process.env.DISPATCHER_BASE_URL || 'https://service.example.com',
    dispatcherSecretId: process.env.DISPATCHER_SHARED_SECRET_ID || 'agent-4ggvzl-dispatcher-shared-secret',
    dispatcherSecretRegion: process.env.DISPATCHER_SHARED_SECRET_REGION || 'us-east-1',
    nodeTlsReject: process.env.AGENTCORE_RUNTIME_TLS_REJECT || '0',
    // §9.9a: the baked new-agent skeleton the dispatcher templates into a fresh agent's SEED. Same
    // files the agent image carries (both COPY from archie-runner/config-seed in the shared build
    // context); the image layout puts them at /app/config-seed, the repo layout at the sibling tree.
    newAgentSkeletonDir: process.env.NEW_AGENT_SKELETON_DIR
      || (existsSync(path.join(__dirname, 'config-seed', 'new-agent-skeleton'))
        ? path.join(__dirname, 'config-seed', 'new-agent-skeleton')
        : path.join(__dirname, '..', 'archie-runner', 'config-seed', 'new-agent-skeleton')),
    // §9: which account the in-process AWS tools assume their cross-account readers in. Unset → the
    // tools use the PROD reader accounts (skill-iam-requirements defaults). In the SANDBOX we point
    // provisioned runtimes at the in-account 052 STAND-IN readers (clawdbot-cross-account-*-reader
    // in 052, trust admits role/agentcore/*) so the derived-role → assume → read chain completes
    // in-account (§9.7(a): real prod cross-account read is the prod canary). Passed to runtimeEnv.
    readersAccount: process.env.AGENTCORE_READERS_ACCOUNT || '',
    hindsightApiUrl: process.env.HINDSIGHT_API_URL || '',
    // Optional injectable overrides consumed elsewhere:
    //   extraEnv        — extra runtime env vars merged into runtimeEnv()
    //   efsRootFor(name)→ path — override the AP root path (tests use run-tagged roots)
    extraEnv: {},
  };
}

// Shallow-merge overrides over base, with a couple of nested-safe keys. supportedAzIds accepts an
// array or a Set; extraEnv is merged; everything else is a top-level replace (the config is flat).
//
// AN UNDEFINED OVERRIDE IS NOT AN OVERRIDE. A plain `{...base, ...overrides}` lets a key that is
// merely PRESENT-AND-UNDEFINED erase a resolved default, and every field here has a working default
// precisely so it cannot be empty. That is not hypothetical: `archie fleet stage` passed
// `securityGroupId: spec.securityGroupId` from an empty spec, blanking a value the environment had
// resolved correctly, and AgentCore rejected the create with "securityGroups: Value '[]' … length
// greater than or equal to 1" — a message about the SDK dropping an undefined array member, three
// layers from the assignment that caused it. Callers spread optional fields in; treating undefined
// as "not supplied" is what makes that safe.
function mergeConfig(base, overrides = {}) {
  const defined = Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== undefined));
  const merged = { ...base, ...defined };
  if (overrides.supportedAzIds && !(overrides.supportedAzIds instanceof Set)) {
    merged.supportedAzIds = new Set(overrides.supportedAzIds);
  }
  if (overrides.extraEnv) {
    merged.extraEnv = { ...(base.extraEnv || {}), ...overrides.extraEnv };
  }
  return merged;
}

// Deterministic runtime name for an agent. AgentCore names allow [a-zA-Z0-9_] only (NO hyphens),
// must start with a letter. Same agent → same name every time, so ListAgentRuntimes-by-name is
// the durable source of truth (survives dispatcher restarts) — the in-memory cache is just a
// fast path (see #43).
function sanitizeRuntimeName(agent) {
  const s = String(agent).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return `oc_${s || 'agent'}`.slice(0, 48);
}

// The image is not optional and has no default. A caller that reaches provisioning without one has
// either skipped ensureCurrentRuntime (the single resolver) or is running against a fleet with no
// published pointer — both are operator-visible faults, not something to paper over with a build-time
// constant. Throwing here is what keeps "the fleet runs what was published" a fact rather than a hope.
function requireImage(image, agent) {
  if (typeof image === 'string' && image.trim()) return image;
  const err = new Error(`no container image resolved for agent ${agent} — the fleet image pointer `
    + '(DynamoDB CONFIG#image / FLEET) is missing or unreadable. Publish one with `archie image publish <tag>`.');
  err.name = 'ImagePointerMissing';
  throw err;
}

// Stable, order-insensitive serialisation. Object keys are sorted, and arrays of primitives are
// sorted too — because the fields we hash are SETS, not ordered lists. That matters: an unsorted hash
// would change whenever AWS returned the same values in a different order, minting a new runtime on a
// turn where nothing actually changed (a provision per message, plus an access-point and role leak).
function canonicalize(v) {
  if (Array.isArray(v)) {
    const items = v.map(canonicalize);
    return items.every((x) => typeof x !== 'object' || x === null) ? [...items].sort() : items;
  }
  if (v && typeof v === 'object') {
    return Object.keys(v).sort().reduce((acc, k) => { acc[k] = canonicalize(v[k]); return acc; }, {});
  }
  return v;
}

// Short, stable fingerprint. Only needs to distinguish the SPECS an agent runs, not to resist
// collision attacks — sha1 truncated to 8 hex is ~4 billion buckets against a handful of live
// generations.
function imageFingerprint(spec) {
  const input = typeof spec === 'string' ? spec : JSON.stringify(canonicalize(spec));
  return require('node:crypto').createHash('sha1').update(input).digest('hex').slice(0, 8);
}

// Runtime name for an agent ON A SPECIFIC IMAGE. The image fingerprint is part of the NAME, which is
// what makes an image roll instant instead of a five-minute outage:
//
//   * AgentCore holds a deleted runtime's NAME for ~5 minutes (DELETING → CreateAgentRuntime
//     ConflictException). Rolling by delete-then-recreate under one name therefore means the agent
//     cannot serve for that whole window. A new generation has a DIFFERENT name, so it is created
//     alongside the old one and the switch is just which ARN the next turn invokes.
//   * The name IS the fingerprint, so "is this runtime on the right image?" is answered by a
//     ListAgentRuntimes-by-name we already do — no GetAgentRuntime per turn to compare containerUri.
//   * update-agent-runtime buys nothing here, though NOT for the reason this comment used to give.
//     It claimed a v2 microVM updated in place never mounts EFS. That is FALSE, measured 2026-08-14
//     in the sandbox: a runtime created on access point A, then updated to access point B, mounted B
//     and could not see A's contents — 3/3 runs, verified by marker file through a root shell. What
//     actually rules it out is cost: update → READY took 11,828/11,882/11,952ms against create →
//     READY at 11,866/11,867/11,850ms, i.e. the same ~11.9s. Since an update is no cheaper than a
//     create and a create can happen ALONGSIDE the live generation, delete/recreate under generation
//     names stays the right roll — it just is not the only one that works.
//     (An update also resets the warm pool, and session storage, if ever configured, is wiped by the
//     version bump — see clawdbot/RUNTIME-RELEASE-PLAN.md §4.)
//
// The agent keeps its identity across generations — same EFS access point (keyed by the agent's root
// path via a deterministic ClientToken), same derived per-agent IAM role, same DynamoDB config. Only
// the microVM image changes, so workspace, memory and sessions carry over untouched.
//
// AgentCore allows [a-zA-Z0-9_], max 48, must start with a letter. The 9-char suffix is reserved out
// of the budget FIRST so a long agent id truncates rather than silently colliding with a sibling
// generation of itself.
function generationRuntimeName(agent, spec) {
  if (!spec) return sanitizeRuntimeName(agent);
  const fp = imageFingerprint(spec);
  const s = String(agent).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'agent';
  return `oc_${s}`.slice(0, 48 - 9) + `_${fp}`;
}

// Does this runtime name belong to `agent` (any generation)? Used by the GC to find superseded
// generations without matching another agent whose id merely shares a prefix.
function isGenerationOf(name, agent) {
  if (typeof name !== 'string') return false;
  // Pre-generation runtimes carry the bare name. They are still this agent's, and the GC must be able
  // to reap them — otherwise the first deploy of generation naming strands one runtime per agent.
  if (name === sanitizeRuntimeName(agent)) return true;
  const base = `oc_${String(agent).replace(/[^a-zA-Z0-9]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '') || 'agent'}`.slice(0, 48 - 9);
  return /^[0-9a-f]{8}$/.test(name.slice(-8)) && name.slice(0, -9) === base && name[name.length - 9] === '_';
}

// Per-agent EFS access-point root (mirrors provision.ts / prod). The access point is pinned here
// and mounted at config.efsMountPath, giving each agent an isolated, correctly-owned workspace.
function efsRootDir(agent, prefix = '/openclaw-data') {
  return `${prefix}/agents/${agent}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Command classes (SDK v3 CJS). Required lazily so a fresh require of this module for the
// pure helpers doesn't force SDK load until a runtime op actually runs.
function ctl() {
  return require('@aws-sdk/client-bedrock-agentcore-control');
}
function efsc() {
  return require('@aws-sdk/client-efs');
}
function bac() {
  return require('@aws-sdk/client-bedrock-agentcore');
}
function iamc() {
  return require('@aws-sdk/client-iam');
}

// Build the injectable `clients` bundle the orchestrator expects: live SDK clients + the command
// classes it sends. Lazily constructed on first use so unit tests can run without AWS creds /
// inject fakes via setClientsForTest().
function makeProvisioningClients(sdkClients, doc) {
  return {
    control: sdkClients.control,
    efs: sdkClients.efs,
    invoke: sdkClients.invoke,
    iam: sdkClients.iam, // A2: derived per-agent role lifecycle (may be undefined when unused)
    // The config-table doc client, PASSED IN (this function is module-level; docClient lives in the
    // factory closure). putDerivedGrants needs it to re-read the agent's Connector POINTER so the
    // rewritten role still grants that ARN — without it the live grant-change path would drop the
    // pointer grant and silently revoke a working key, the same §9.9c downgrade shape as the config
    // read. Optional so unit tests that inject fake clients need not supply one.
    doc,
    controlCmds: ctl(),
    efsCmds: efsc(),
    iamCmds: iamc(),
  };
}

// ── The client factory ───────────────────────────────────────────────────────

function createAgentCoreClient(overrides = {}) {
  const config = mergeConfig(baseConfig(), overrides);

  // efsRootFor is injectable (tests use run-tagged roots); default mirrors prod.
  const efsRootFor = typeof overrides.efsRootFor === 'function' ? overrides.efsRootFor : efsRootDir;

  // M1 (dispatcher-observability D6): a single ClawdbotDispatcher EMF-via-stdout metrics emitter,
  // shared by the provisioning saga (phase durations + counts) and the invoke path (latency /
  // cold-retries / errors). Overridable for tests (`overrides.metrics`); defaults to the real
  // stdout emitter so the deployed dispatcher emits automatically. NO IAM / SDK — EMF is auto-
  // extracted from the awslogs-shipped stdout.
  const metrics = overrides.metrics || createDispatcherMetrics();

  // Runtime environment for a created runtime (mirrors provision.ts runtimeEnv). `configAgentName`
  // MUST be a real, config-known agent — openclaw.config.js hard-throws on unknown AGENT_NAME.
  // AGENTCORE_MODE removed (2026-08-14): an OpenClaw-era flag that selected a trimmed path in
  // entrypoint.sh. Pi has no entrypoint.sh — pi-entrypoint.mjs IS the entrypoint, unconditionally —
  // so the flag lost its reader when OpenClaw was dropped. Verified zero `process.env.AGENTCORE_MODE`
  // anywhere in the repo; every remaining mention was a WRITER like this one.
  function runtimeEnv(configAgentName) {
    return {
      AGENT_NAME: configAgentName,
      REGION: config.region,
      AWS_BEDROCK_ENABLED: 'true',
      AGENT_CONFIG_TABLE: config.agentConfigTable,
      AGENTCORE_OTEL_MODE: config.otelMode,
      CONNECTOR_API_KEY_SECRET: config.credentialSecret,
      CONNECTOR_API_KEY_SECRET_REGION: config.credentialSecretRegion,
      DATADOG_API_KEY_SECRET: config.datadogApiKeySecret,
      DATADOG_APP_KEY_SECRET: config.datadogAppKeySecret,
      DATADOG_KEY_SECRET_REGION: config.datadogKeySecretRegion,
      EFS_DIR: config.efsMountPath,
      // save_artifact's destination. Conditional: an empty value would make the plugin build an
      // S3 client against a nameless bucket instead of returning "not configured".
      ...(config.artifactsBucket ? { ARTIFACTS_S3_BUCKET: config.artifactsBucket } : {}),
      // Cron tool → dispatcher manager API (secret resolved at boot by pi-entrypoint).
      DISPATCHER_BASE_URL: config.dispatcherBaseUrl,
      DISPATCHER_SHARED_SECRET_ID: config.dispatcherSecretId,
      DISPATCHER_SHARED_SECRET_REGION: config.dispatcherSecretRegion,
      NODE_TLS_REJECT_UNAUTHORIZED: config.nodeTlsReject,
      // §9 sandbox: point the runtime's AWS tools at the in-account stand-in readers (only when set).
      ...(config.readersAccount ? { AGENTCORE_READERS_ACCOUNT: config.readersAccount } : {}),
      // Which account this runtime believes it is in. The runtime asserts its compiled Cedar verdict row
      // (AGENT#<scope>/POLICY) claims the same one, so a sandbox-compiled row cannot govern a prod
      // runtime or the reverse — the class of mistake that put two sandbox scope ids into
      // pins.prod.json. Same account used for the derived role and the DDB scope statement, so it is by
      // construction the account the POLICY item is read from.
      //
      // UNCONDITIONAL, unlike the two above, because a MISSING value here is not "feature off" — it is
      // an assertion that silently does not run. policy-table.mjs records the skip rather than counting
      // it as a pass, and this is the only thing that stops that being the permanent state.
      //
      // Adding this key re-fingerprints every runtime (envs is hashed into the runtime NAME, see
      // generationRuntimeName), so it lands on the next roll rather than costing one of its own — which
      // is free, because a roll changes the name regardless. Existing runtimes keep asserting nothing
      // until they roll; that is the pre-existing state, not a regression.
      AGENTCORE_ACCOUNT: config.account,
      // Hindsight memory. Conditional for the same reason as above and it is LOAD-BEARING: BASE_PLUGINS
      // gates both the plugin entry and `slots.memory` on a non-empty HINDSIGHT_API_URL, so passing an
      // empty string would give the agent a memory slot pointing at a plugin it cannot use and a
      // "hindsight not configured" warning on every boot. Absent means absent.
      ...(config.hindsightApiUrl ? { HINDSIGHT_API_URL: config.hindsightApiUrl } : {}),
      // The BANK is not passed. It is `default-org` for every agent in every deployment (a constant in
      // config-resolver/boot-config.mjs), and the env var that used to override it is gone: the only
      // outcome it had was one deployment recalling from a bank nothing writes to.
      ...(config.extraEnv || {}),
    };
  }

  // Lazy SDK clients — constructed on first use. Injectable via setClientsForTest().
  let _clients = null;
  function clients() {
    if (_clients) return _clients;
    const { BedrockAgentCoreControlClient } = require('@aws-sdk/client-bedrock-agentcore-control');
    const { BedrockAgentCoreClient } = require('@aws-sdk/client-bedrock-agentcore');
    const { EFSClient } = require('@aws-sdk/client-efs');
    const { IAMClient } = require('@aws-sdk/client-iam');
    // Socket pools sized against the Phase 1 concurrency bounds — see sdk-http.js. `invoke` carries one
    // long-lived SSE stream per in-flight turn, so it needs a socket per concurrent turn, not per
    // request; the control/efs/iam clients only see the provisioning path.
    _clients = {
      control: new BedrockAgentCoreControlClient({ region: config.region, ...requestHandlerFor(CONTROL_MAX_SOCKETS) }),
      invoke: new BedrockAgentCoreClient({ region: config.region, ...requestHandlerFor(INVOKE_MAX_SOCKETS) }),
      efs: new EFSClient({ region: config.region, ...requestHandlerFor(CONTROL_MAX_SOCKETS) }),
      iam: new IAMClient({ region: config.region, ...requestHandlerFor(CONTROL_MAX_SOCKETS) }), // A2: derived per-agent role lifecycle
    };
    return _clients;
  }

  // Lazy DynamoDB doc client — A2 reads the agent's GRANT#* caps to decide base-vs-dedicated role.
  let _doc = null;
  function docClient() {
    if (_doc) return _doc;
    const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
    _doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
    return _doc;
  }
  let _faked = false;
  function setClientsForTest(fakes) {
    _clients = fakes;
    _faked = true;
    // The registry is one more client from a test's point of view, and it would otherwise reach for real
    // AWS credentials. Default it to the semantic in-memory double so injecting fake AgentCore clients
    // remains the single setup step it has always been; setRegistryForTest still overrides.
    if (!_registry) _registry = createMemoryRuntimeRegistry();
  }

  // Per-runtime-name in-flight lock. This is now ONLY a coalescer for concurrent calls inside THIS
  // process — the durable name→arn store is the runtime registry (DynamoDB), and cross-process
  // exclusivity comes from AgentCore's name uniqueness (a losing CreateAgentRuntime gets
  // ConflictException, classified 'adopt'). There is deliberately no in-memory arn cache any more: a
  // reaped or rolled runtime must be noticed on the very next turn, not after a restart.
  const _inflight = new Map();
  let _registry = null;
  function registry() {
    if (!_registry) {
      _registry = createRuntimeRegistry({
        tableName: config.agentConfigTable,
        doc: docClient,
        logger: undefined,
      });
    }
    return _registry;
  }
  function setRegistryForTest(fake) { _registry = fake; }
  function resetCacheForTest() { _inflight.clear(); }

  // Idempotent get-or-create of the agent's EFS access point via the orchestrator (deterministic
  // ClientToken, adopts existing). Returns { accessPointArn, accessPointId }. Standalone use has no
  // downstream runtime, so cleanup is off (nothing to compensate here).
  async function ensureAccessPoint(agent, opts = {}) {
    const provClients = makeProvisioningClients(clients(), docClient());
    const ledger = provisioning.makeLedger();
    const r = await provisioning.ensureAccessPoint(agent, {
      efsRootFor, clients: provClients, config, logger: opts.logger, ledger, sleep,
    });
    return { accessPointArn: r.accessPointArn, accessPointId: r.accessPointId };
  }

  // Provision a fresh runtime for the agent via the orchestrator's full saga: role (shared ARN,
  // never deleted) → mount targets → AP → CreateAgentRuntime (VPC+EFS) → poll READY, with
  // compensating cleanup on failure (deletes a self-created AP if the runtime create fails — the
  // leak fix). Returns the runtime ARN.
  //
  // NO WARM-UP. There was a synthetic "ping" invoke here until 2026-08-11, to gate on serving-ready
  // because control-plane READY does not mean serving. It is gone, and deliberately not behind a
  // flag: it was p50 ~16.5s of a p50 30.1s provision, it sat INLINE in the user's turn so it
  // amortised nothing, and its premise was refuted by its own record — the warm-up IS a first
  // invoke, and it succeeded on the first attempt in every provision logged, never once needing a
  // cold retry. The user's own message is now the first invoke: it blocks on the same ~9-13s of
  // platform allocation and then answers, one turn instead of two. It also removed a failure mode,
  // since a failed warm-up threw and bricked the turn while the real invoke has 15 cold retries.
  //
  // `image` MUST be threaded through. It was dropped here once (destructured out, so the saga fell
  // back to config.imageUri): the runtime NAME rolled to the new generation while the container it
  // ran stayed on the old image — a roll that looks completely successful in list-agent-runtimes and
  // changes nothing. Only get-agent-runtime's containerUri showed it. The unit test now asserts the
  // URI actually handed to CreateAgentRuntime, not just that a create happened.
  // Returns { runtimeArn, runtimeId } — the id as well as the arn, because the runtime registry stores
  // it. Without the id, GetAgentRuntime and DeleteAgentRuntime (which both take an id, never a name)
  // would each need a ListAgentRuntimes scan to rediscover it, which is the exact cost the registry
  // exists to remove.
  async function createRuntime(agent, name, logger, { efsRoot, image } = {}) {
    const r = await ensureAgentEnvironment(agent, { runtimeName: name, logger, efsRoot, image });
    return { runtimeArn: r.runtimeArn, runtimeId: r.runtimeId };
  }

  // Find an existing runtime by its deterministic name. Returns { arn, status, id } or null.
  //
  // NO LONGER ON THE TURN PATH — the runtime registry answers name→arn with a GetItem. This paginates
  // ListAgentRuntimes (25/s, non-adjustable, no name filter, and no early exit when the name is absent),
  // so it survives only for the paths where a scan is genuinely the only option: adopting a runtime that
  // AgentCore already holds, and deleting one by name.
  async function findRuntimeByName(name) {
    const provClients = makeProvisioningClients(clients(), docClient());
    return provisioning.findRuntimeByName(name, { clients: provClients, config });
  }

  // Delete an agent's runtime by name (idempotent: not-found → no-op). Used by the C1 fleet roll (an
  // image roll must delete→recreate: an updated-in-place runtime never mounts EFS). NOT used by grant
  // changes any more — those are a live PutRolePolicy (§9.9c). The next ensureRuntime re-provisions.
  // Does NOT touch DDB config / EFS (unlike agent-teardown.js).
  async function deleteRuntime(name) {
    const found = await findRuntimeByName(name);
    if (!found || !found.id) return { deleted: false, reason: 'not-found' };
    const { DeleteAgentRuntimeCommand } = ctl();
    await clients().control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: found.id }));
    return { deleted: true, id: found.id };
  }

  // Reap this agent's SUPERSEDED image generations — every runtime of theirs whose name is not
  // `keepName`. Generation naming means a roll leaves the old runtime alive and serving nothing; left
  // alone they accumulate against the account's runtime quota.
  //
  // Deliberately best-effort and OFF the turn path: the caller fires it without awaiting, because a
  // failed cleanup must never fail a user's message. Anything missed here is retried on the next
  // roll, and is visible as extra runtimes in list-agent-runtimes.
  //
  // Only deletes runtimes in a settled state — a generation still CREATING may be another
  // dispatcher's in-flight provision, and deleting it would race that instance into a failed turn.
  /**
   * The spec a LIVE runtime was actually created with, read back from AWS. GetAgentRuntime returns the
   * whole immutable set (containerUri, environmentVariables, networkConfiguration, lifecycle,
   * filesystemConfigurations), so a superseded generation can tell us precisely what changed — which
   * in-process memory cannot after a restart, and a name hash can never (it is one-way).
   *
   * Shaped to match runtimeSpecFor so the two are directly diffable.
   */
  async function observedSpecOf(runtimeId) {
    const { GetAgentRuntimeCommand } = ctl();
    const g = await clients().control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
    return specFromGet(g);
  }

  /**
   * The spec-shaping half of observedSpecOf, split out so a caller that ALREADY holds a
   * GetAgentRuntime response can reuse it. The reaper needs the runtime's status and its spec, and
   * before this split it paid two Gets for one runtime to get both.
   */
  async function specFromGet(g) {
    const envs = {};
    for (const [k, v] of Object.entries(g.environmentVariables || {})) envs[k] = v;
    const apArn = g.filesystemConfigurations?.[0]?.efsAccessPoint?.accessPointArn
      || g.filesystemConfigurations?.[0]?.efsAccessPoint?.efsAccessPointArn || null;

    // RECOVER THE ROOT PATH from the access point, so an EFS root change is attributable. Without this
    // the old spec knows only the AP ARN while ours knows only the path, so a diff has to drop the
    // filesystem from both sides and reports `unknown` — which is precisely the side-by-side -> live
    // migration case this attribution exists for. One DescribeAccessPoints, and only on a roll.
    let efsRoot;
    if (apArn) {
      try {
        const { DescribeAccessPointsCommand } = efsc();
        const d = await clients().efs.send(new DescribeAccessPointsCommand({ AccessPointId: apArn.split('/').pop() }));
        efsRoot = d.AccessPoints?.[0]?.RootDirectory?.Path;
      } catch { /* best-effort: an AP deleted out from under us just leaves efsRoot undefined */ }
    }

    return {
      image: g.agentRuntimeArtifact?.containerConfiguration?.containerUri,
      efsRoot,
      // Kept for context; the diff compares efsRoot, since that is the field our own spec expresses.
      efsAccessPoint: apArn,
      efsMountPath: g.filesystemConfigurations?.[0]?.efsAccessPoint?.mountPath,
      envs,
      securityGroupId: g.networkConfiguration?.networkModeConfig?.securityGroups?.[0],
      idleRuntimeSessionTimeout: g.lifecycleConfiguration?.idleRuntimeSessionTimeout,
      maxLifetime: g.lifecycleConfiguration?.maxLifetime,
      serverProtocol: g.protocolConfiguration?.serverProtocol,
    };
  }

  async function gcOldGenerations(agent, keepName, { logger } = {}) {
    const { DeleteAgentRuntimeCommand, GetAgentRuntimeCommand } = ctl();
    const reaped = [];
    const reapedSpecs = {};   // name -> the spec it was actually running, for attribution
    try {
      // Query THIS AGENT's generation rows instead of paginating every runtime in the account. The old
      // form scanned the whole fleet to find one agent's leftovers, which is the same 25/s List ceiling
      // the registry was built to get off — and it ran on every roll, per agent.
      //
      // ACCEPTED LIMITATION: the reaper can now only see generations the registry knows about. A runtime
      // created at AWS whose write was lost, and whose generation is never requested again (the image
      // rolled past it), is invisible here and leaks against the account's 1000-runtime quota. The
      // adopt-on-conflict path recovers it the moment that generation IS requested; nothing recovers it
      // otherwise. Closing that needs a periodic full-List reconciliation, deliberately deferred.
      const rows = await registry().listGenerations(agent);
      for (const row of rows) {
        const name = row.runtimeName;
        if (name === keepName || !isGenerationOf(name, agent)) continue;
        // Already reaped (or never live): the row is history, there is nothing at AWS to delete.
        if (!row.arn) continue;
        // Derive the id from the arn when the field is absent. Requiring row.runtimeId outright made the
        // reaper a silent NO-OP for every row written before ensureAgentEnvironment returned the id —
        // superseded generations stacked 2-3 deep per agent against the 1000-runtime quota, and nothing
        // logged because "no id" looked exactly like "already reaped".
        const runtimeId = runtimeIdOf(row);
        if (!runtimeId) {
          logger?.warn?.({ agent, runtime: name, arn: row.arn },
            'agentcore GC: row has an arn but no derivable runtime id — cannot reap');
          continue;
        }
        try {
          // One GetAgentRuntime serves both purposes: the status check AND the spec read-back. Reading
          // the spec BEFORE deleting is the only moment the old configuration is still observable, and
          // it is what makes roll attribution precise after a dispatcher restart.
          let observed = null;
          let status = null;
          try {
            const g = await clients().control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
            status = g.status;
            observed = await specFromGet(g);
          } catch (getErr) {
            // Gone already: drop the liveness claim and move on — the row stays as history.
            if (/ResourceNotFound/i.test(getErr?.name || '')) {
              await registry().markReaped(agent, name).catch(() => {});
              continue;
            }
            /* attribution is best-effort; fall through with status null */
          }
          // Only delete a SETTLED runtime — a generation still CREATING may be another dispatcher's
          // in-flight provision, and deleting it would race that instance into a failed turn.
          if (status && !['READY', 'CREATE_FAILED'].includes(status)) continue;
          await clients().control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: runtimeId }));
          // Keep the row, drop the claim. A rollback to this generation then goes straight to
          // provisioning instead of invoking a corpse and burning a turn to discover it.
          await registry().markReaped(agent, name);
          reaped.push(name);
          if (observed) reapedSpecs[name] = observed;
        } catch (err) {
          logger?.warn?.({ err: err.message, agent, runtime: name }, 'agentcore GC: delete failed (will retry on the next roll)');
        }
      }
      if (reaped.length) logger?.info?.({ agent, reaped, keep: keepName }, 'agentcore GC: reaped superseded image generations');

    } catch (err) {
      logger?.warn?.({ err: err.message, agent }, 'agentcore GC: registry query failed (will retry on the next roll)');
    }
    // { reaped, specs } rather than a bare array: the specs are what turn "it rolled" into
    // "DISPATCHER_BASE_URL changed", and hanging them off the array as a property would be
    // invisible to deep-equality and lost through JSON.
    return { reaped, specs: reapedSpecs };
  }

  // A3 (§9.5 step 4): react to a grant change — ALWAYS a live PutRolePolicy on the agent's own role
  // (§9.9c). IAM evaluates at request time, so a warm runtime picks the new grants up with no restart
  // and no recreate; there is no longer a role tier to cross (roleArn is role/agentcore/<agent>,
  // a function of the agent ID, not of its caps), so the old 'recreate' branch could only ever have
  // deleted a live runtime for nothing. Injected into marketplace's mutation path.
  //
  // account/region/table are threaded through because the rewritten policy must KEEP the agent's
  // scoped config-table read — that read lives only in this inline policy (agentcore-base carries no
  // DynamoDB), so a rewrite that dropped it would break the agent's next boot.
  async function applyDerivedRoleGrantChange(agentId, grantChange = {}, { logger } = {}) {
    const plan = await derivedRole.planGrantChange(grantChange);
    const r = await derivedRole.putDerivedGrants({
      clients: makeProvisioningClients(clients(), docClient()),
      agentId,
      caps: grantChange.newCaps,
      account: config.account,
      region: config.region,
      table: config.agentConfigTable,
    });
    if (logger && logger.info) logger.info({ msg: 'derived-role grant change', agentId, action: plan.action, applied: r.applied, reason: r.reason });
    return { action: plan.action, applied: r.applied };
  }

  // Full provisioning saga exposed on the client (§2.1). Get-or-create through the orchestrator,
  // Returns { runtimeArn, accessPointArn, roleArn }.
  // §8.10 legacy-EFS adopt: a rekeyed scope agent stores its former NAME in META.efsRoot so its EFS
  // access point adopts the old workspace/sessions/memory. Resolved from DDB here (cold-provision
  // only, once per agent) so BOTH the Slack and cron ensureRuntime paths adopt with no per-caller
  // threading. Missing/unset/any error → undefined → the AP root defaults to the agent's own dir.
  async function resolveEfsRootFromMeta(agent) {
    if (_faked || !config.agentConfigTable) return undefined; // tests drive adopt via explicit opts.efsRoot
    try {
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      const r = await docClient().send(new GetCommand({ TableName: config.agentConfigTable, Key: { pk: `AGENT#${agent}`, sk: 'META' } }));
      if (!r.Item || !r.Item.data) return undefined;
      const meta = JSON.parse(r.Item.data);
      return meta && typeof meta.efsRoot === 'string' && meta.efsRoot ? meta.efsRoot : undefined;
    } catch { return undefined; }
  }

  // §9.9a: PRE-WRITE a brand-new agent's workspace SEED, so the runtime never needs a DynamoDB
  // write. The dispatcher templates the SAME baked skeleton the agent image carries, using the SAME
  // readSkeleton() (dual-layout import — image ships it to /app/agentcore-pi, repo layout is the
  // sibling tree), so there is no second implementation of the __AGENT_NAME__ substitution to drift.
  //
  // Called ONLY when the EFS access point was just created (ap.selfCreated), i.e. the workspace is
  // genuinely fresh. That gate matters: if we wrote a skeleton SEED for an agent whose workspace
  // already has content, the next boot would take workspace-seed's "loaded" branch and verify every
  // manifest file against EFS — and throw `seed guard FATAL` for any skeleton file the live workspace
  // doesn't have. Fresh AP ⇒ empty workspace ⇒ the manifest matches what gets written.
  //
  // Create-only (attribute_not_exists) and UpdateItem rather than PutItem — the dispatcher task role
  // holds UpdateItem but not PutItem (same constraint marketplace.js records). Fail-soft: the runtime
  // still seeds EFS from its baked skeleton if this never landed, it just won't have the DDB copy.
  let _cfgSchema = null;
  async function loadConfigSchema() {
    if (_cfgSchema) return _cfgSchema;
    try {
      _cfgSchema = await import('./config-resolver/schema.mjs');
    } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
      _cfgSchema = await import('../archie-runner/config-resolver/schema.mjs');
    }
    return _cfgSchema;
  }

  let _seedEsm = null;
  async function loadSeedEsm() {
    if (_seedEsm) return _seedEsm;
    try {
      _seedEsm = await import('./agentcore-pi/workspace-seed.mjs');
    } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
      _seedEsm = await import('../archie-runner/agentcore-pi/workspace-seed.mjs');
    }
    return _seedEsm;
  }

  // ── Connector provisioning (phase 3) ────────────────────────────────────────
  //
  // Wired HERE, not in the saga, for the same reason as seedNewWorkspace: it needs the DDB doc
  // client, Secrets Manager and the org key, none of which the saga should know about.
  //
  // The ORG key is a dispatcher-only credential and is never passed to an agent — it can create and
  // read every project in the org, whereas an agent's own key is scoped to its own project (401/403
  // on everything else, verified live). It is read ONCE per process and cached: it is needed on
  // every cold provision, and a GetSecretValue per provision would add a round trip to the very
  // latency this phase exists to hide.
  let _orgKey; // undefined = not tried, null = unavailable
  async function connectorOrgKey(logger) {
    if (_orgKey !== undefined) return _orgKey;
    if (_faked || !config.connectorOrgSecret) { _orgKey = null; return _orgKey; }
    try {
      const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
      const { extractOrgKey } = require('./connector-credential');
      const sm = new SecretsManagerClient({ region: config.credentialSecretRegion });
      const r = await sm.send(new GetSecretValueCommand({ SecretId: config.connectorOrgSecret }));
      _orgKey = extractOrgKey(r.SecretString);
      if (!_orgKey) logger?.warn?.({ secret: config.connectorOrgSecret }, 'connector org secret present but no key could be extracted (ambiguous JSON?) — provisioning disabled');
    } catch (e) {
      // Cached as null on purpose: without the org key NOTHING here can work, and retrying the same
      // failing read on every cold provision would tax the path it is meant to accelerate.
      _orgKey = null;
      logger?.warn?.({ err: String(e && e.message), secret: config.connectorOrgSecret }, 'connector org key unavailable — new agents will use the shared key');
    }
    return _orgKey;
  }

  // `logger` is PASSED, never closed over: this file has no module-scope logger, and reaching for one
  // is a ReferenceError that only fires on the error path — which is exactly where it did fire
  // (2026-08-13), inside the catch that was meant to report a failure.
  /**
   * The pre-§8.10 name of a rekeyed agent, or null for one that was always scope-keyed.
   *
   * BEST EFFORT, and the direction of failure is chosen: an unreadable META means we cannot prove
   * this agent has a legacy identity, so it is treated as new. For Connector that is the safe way
   * round only because seeding is skipped, not because minting is harmless — so the read failing
   * is worth a log line rather than silence.
   */
  async function legacyAgentIdFor(agent, logger) {
    if (!config.agentConfigTable) return null;
    try {
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      const r = await docClient().send(new GetCommand({
        TableName: config.agentConfigTable, Key: { pk: `AGENT#${agent}`, sk: 'META' },
      }));
      if (!r.Item || !r.Item.data) return null;
      const meta = JSON.parse(r.Item.data);
      const root = meta && typeof meta.efsRoot === 'string' ? meta.efsRoot : '';
      const legacy = root.split('/').filter(Boolean).pop() || null;
      return legacy && legacy !== agent ? legacy : null;
    } catch (err) {
      // Reported, because the consequence is not neutral: unreadable META reads as "this agent is
      // new", and a new agent gets a freshly minted, EMPTY Connector project that the runtime then
      // prefers over the shared key holding its actual connected accounts.
      logger?.warn?.({
        agent, err: String((err && err.message) || err),
        msg: 'connector: could not read META — agent will be treated as new (may mint an empty project)',
      });
      return null;
    }
  }

  async function ensureConnectorCredential(agent, { logger } = {}) {
    const orgApiKey = await connectorOrgKey(logger);
    if (!orgApiKey) return { outcome: 'skipped', reason: 'no-org-key', agentId: agent, ms: 0 };
    const { SecretsManagerClient, DescribeSecretCommand, CreateSecretCommand } = require('@aws-sdk/client-secrets-manager');
    const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
    const { ensureAgentCredential } = require('./connector-credential');
    const sm = new SecretsManagerClient({ region: config.credentialSecretRegion });
    const outcome = await ensureAgentCredential({
      agentId: agent,
      secretBase: config.credentialSecret,
      // The pre-§8.10 name, and ONLY that: `META.efsRoot` is a path
      // (`/openclaw-data/agents/agent-xx9aff`) whose last segment is the legacy agent id. Its
      // presence is what says "this agent is not new", which is the whole input to the decision.
      legacyAgentId: await legacyAgentIdFor(agent, logger),
      orgApiKey,
      secrets: {
        describeSecret: (name) => sm.send(new DescribeSecretCommand({ SecretId: name })),
        createSecret: async (name, value) => {
          const r = await sm.send(new CreateSecretCommand({
            SecretId: name, Name: name, SecretString: value,
            Description: 'Per-agent Connector API key (provisioned by the dispatcher)',
          }));
          return r.ARN;
        },
      },
      ddb: config.agentConfigTable ? {
        getCredential: async (id) => {
          const r = await docClient().send(new GetCommand({ TableName: config.agentConfigTable, Key: { pk: `AGENT#${id}`, sk: 'CONNECTOR' } }));
          return r.Item ? JSON.parse(r.Item.data) : undefined;
        },
        putCredential: async (id, body) => docClient().send(new UpdateCommand({
          TableName: config.agentConfigTable,
          Key: { pk: `AGENT#${id}`, sk: 'CONNECTOR' },
          UpdateExpression: 'SET #d = :d',
          ExpressionAttributeNames: { '#d': 'data' }, // `data` is a DDB reserved word
          ExpressionAttributeValues: { ':d': JSON.stringify(body) },
        })),
      } : null,
      logger,
    });

    // ORDERING FIX. The saga builds the derived role in step 1 and runs THIS in step 2, so on a
    // FIRST provision the role is built before the pointer exists — and the shared-key Deny is
    // gated on the pointer, so it could not be there. Live-observed: a freshly provisioned agent
    // had its own project and key but still had permission to read the SHARED key, which is exactly
    // the hole the Deny exists to close, and it would have stayed open until its next cold provision.
    //
    // So the role is rewritten as soon as a pointer is WRITTEN. putDerivedGrants re-reads the
    // pointer itself, so this adds both the exact pointer ARN and the Deny.
    if (outcome && ['created', 'adopted-secret'].includes(outcome.outcome)) {
      try {
        // Caps must be READ, never defaulted: putDerivedGrants rewrites the whole document, so
        // passing [] would strip the agent's cap-derived grants — the §9.9c downgrade shape. A
        // FAILED read must therefore skip the rewrite entirely rather than proceed with nothing.
        const caps = await derivedRole.readAgentCaps(docClient(), config.agentConfigTable, agent);
        const r = await derivedRole.putDerivedGrants({
          clients: makeProvisioningClients(clients(), docClient()),
          agentId: agent,
          caps,
          account: config.account,
          region: config.region,
          table: config.agentConfigTable,
        });
        logger?.info?.({ event: 'connector_role_refresh', agent, applied: r.applied, reason: r.reason, outcome: outcome.outcome },
          'derived role refreshed — pointer ARN + shared-key deny applied');
      } catch (e) {
        // Non-fatal: the agent still reads its own key through the name-derived pattern. What it
        // loses is the Deny, until its next provision — degraded isolation, not a broken agent.
        logger?.warn?.({ event: 'connector_role_refresh', agent, err: String((e && e.message) || e) },
          'derived role refresh FAILED — the shared-key deny is not yet in place');
      }
    }
    return outcome;
  }

  async function seedNewWorkspace(agent, { logger } = {}) {
    if (_faked || !config.agentConfigTable) {
      if (logger?.info) logger.info({ agent, faked: _faked, table: config.agentConfigTable || null }, 'workspace SEED pre-write: no config table');
      return { seeded: false, reason: 'no-table' };
    }
    try {
      const [{ readSkeleton }, schema] = await Promise.all([loadSeedEsm(), loadConfigSchema()]);
      const files = readSkeleton(config.newAgentSkeletonDir, agent);
      if (!files || !Object.keys(files).length) {
        if (logger?.warn) logger.warn({ agent, dir: config.newAgentSkeletonDir }, 'workspace SEED pre-write: skeleton empty/unreadable');
        return { seeded: false, reason: 'empty-skeleton' };
      }
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      const Key = schema.agentSeedKey(agent);
      await docClient().send(new UpdateCommand({
        TableName: config.agentConfigTable,
        Key,
        UpdateExpression: 'SET #d = :d',
        ExpressionAttributeNames: { '#d': 'data' }, // `data` is a DDB reserved word
        ExpressionAttributeValues: { ':d': JSON.stringify(files) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      if (logger?.info) logger.info({ agent, files: Object.keys(files).length }, 'workspace SEED pre-written for new agent');
      return { seeded: true, files: Object.keys(files).length };
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return { seeded: false, reason: 'already-exists' };
      // Never fail a provision over this — the runtime seeds EFS from its baked skeleton regardless.
      if (logger?.warn) logger.warn({ agent, err: e?.message }, 'workspace SEED pre-write failed (non-fatal)');
      return { seeded: false, reason: 'error', error: e?.message };
    }
  }

  // ── The compiled policy row (AGENT#<scope>/POLICY) ───────────────────────────────────────────────
  //
  // The dispatcher is one of TWO writers. `archie deploy` writes rows for the scopes it can enumerate,
  // with the real Cedar engine. This writes rows for the ones it cannot: a scope MINTED at turn time,
  // which no deploy has ever seen, and which with no row falls back to grant-only behaviour — making
  // every pin on it silently inert (the ch-cr89fluhion failure, plan §2.1).
  //
  // NOT WRITE-ONCE, unlike seedNewWorkspace above, and the difference is the point. SEED is authored
  // baseline that App Home may since have edited, so it is guarded by attribute_not_exists. This row is
  // DERIVED — the artifact is its only authority — so it is overwritten whenever it is stale. Guarding
  // it would freeze a minted scope's verdicts at mint time and let a policy edit never reach it.
  //
  // NOTHING ON THIS PATH IS CACHED, and both caches that used to be here are gone for cause. Every call
  // reads the fleet artifact and the agent's own row from DynamoDB. Two GetItems on a code path that
  // already does a dozen, in exchange for a verdict never decided from a stale copy.
  //
  //   1. A per-agent `lastPolicyDigest` Map short-circuited before the row was read. It assumed the
  //      dispatcher was the only thing that could remove a row. `archie agent teardown` is exactly the
  //      thing that isn't:
  //
  //        13:15Z  process starts
  //        13:xxZ  a turn for dm-ux0mz5ckp2r finds the row CURRENT → memo := <digest>
  //        14:09Z  teardown DELETES AGENT#dm-ux0mz5ckp2r/POLICY out of band
  //        14:28Z  a DM re-mints the scope. The memo still says <digest>, so this returned 'cached'
  //                WITHOUT READING the row — and no row was written again while the digest held still.
  //
  //      An absent row is DENY-ALL (permissions/policy-table.mjs), so the scope served six turns able to
  //      do nothing at all — PolicyDenyAll=1 measured across 14:25-14:50Z on 2026-08-20 — while every log
  //      line said the mint had succeeded.
  //
  //   2. The artifact sat behind a 30s expiry, argued as the same freshness the CRON_RUNNER flag accepts.
  //      Not comparable: that flag is read uncached for precisely this reason, and here the stale copy
  //      decides whether an agent may act at all.
  //
  // DO NOT REINTRODUCE EITHER (2026-08-21).
  // Both were added here for read volume nobody had measured, beside logic whose correctness they broke.
  // Caching this is a deliberate strategy decision and it is not this function's to make.

  // NO LOGGER PARAMETER. It took one only to emit the debug line described below; the reporting lives
  // entirely in ensurePolicyRow, which knows the agent this read was on behalf of.
  async function policyArtifact() {
    const schema = await loadConfigSchema();
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const r = await docClient().send(new GetCommand({
      TableName: config.agentConfigTable, Key: schema.fleetPolicyKey(),
    }));
    // NULL IS NOT A BENIGN STATE, and this used to log it at DEBUG while a comment called the layer
    // "additive". Both were wrong once permissions/policy-table.mjs made an absent row deny-all: with no
    // artifact, ensurePolicyRow writes no rows for ANYONE, so every agent in the account is denied
    // everything including baseline. policy-table.mjs:67-75 names the consequences — `archie policy
    // publish` must precede the image roll, and an account with no pins file cannot run agents at all.
    //
    // NOT LOGGED HERE, deliberately. The caller warns on `no-artifact` (see `noWrite`), which is the one
    // place that knows which agent was affected. A debug line here as well meant the prod-visible signal
    // and the invisible one described the same fact at two levels — so whichever you found first, you
    // could not tell whether it was the whole story.
    return r?.Item?.data ? JSON.parse(r.Item.data) : null;
  }

  /**
   * Make sure this scope's POLICY row matches the current fleet artifact. Never fatal.
   *
   * Returns {written, reason}. EVERY outcome is logged, including the no-ops — see `noWrite`.
   */
  async function ensurePolicyRow(agent, { logger } = {}) {
    // EVERY NON-WRITE IS LOGGED. This function had five outcomes and one log line: only a real write said
    // anything, so `no-table`, `no-artifact`, `cached` and `current` were indistinguishable from each other
    // AND from a healthy scope. That is how dm-ux0mz5ckp2r sat in deny-all across 2026-08-19/20 with the
    // dispatcher log group containing not one line matching /policy/ — the absence of output was the only
    // symptom, and absence is what a working system also produces.
    //
    // LEVELS ARE BY CONSEQUENCE, not by novelty:
    //   * `no-artifact` / `no-table` mean NO ROW WILL BE WRITTEN FOR ANY SCOPE, and an absent row is
    //     deny-all — so the whole fleet is inert. WARN, on every turn, deliberately: if this is firing the
    //     noise IS the signal, and `archie deploy` ordering (policy publish before the image roll) is the
    //     thing to check. There is no throttle here; a throttle on this is a throttle on the only warning.
    //   * `current` is the healthy steady state and would be one line per turn per agent. DEBUG.
    const noWrite = (reason, extra = {}) => {
      const level = (reason === 'no-artifact' || reason === 'no-table') ? 'warn' : 'debug';
      logger?.[level]?.({ agent, reason, ...extra }, `policy row not written (${reason})`);
      return { written: false, reason, ...extra };
    };
    if (_faked || !config.agentConfigTable) return noWrite('no-table');
    try {
      const artifact = await policyArtifact();
      if (!artifact) return noWrite('no-artifact');

      const [schema, { rowFromMemberships, rowIsStale }] = [await loadConfigSchema(), require('./policy-derive')];
      const { GetCommand, UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      const Key = schema.agentPolicyKey(agent);
      const cur = await docClient().send(new GetCommand({ TableName: config.agentConfigTable, Key }));
      const existing = cur?.Item?.data ? JSON.parse(cur.Item.data) : null;
      if (!rowIsStale(existing, artifact)) return noWrite('current', { policyDigest: artifact.policyDigest });
      const row = rowFromMemberships(agent, artifact);
      // UpdateItem, NOT PutItem, and this is a permission fact rather than a style choice: the
      // dispatcher task role holds dynamodb:UpdateItem and NOT PutItem (the same constraint marketplace.js
      // and the §9.9a seed pre-write both record). This wrote with PutCommand against a permission it
      // never had, so EVERY policy row write failed:
      //
      //   User: .../archie-dispatcher-task-role/... is not authorized to perform: dynamodb:PutItem
      //
      // It failed non-fatally and was invisible for a different reason first — rowFromMemberships threw on
      // a group name the deployed build did not know, so the AccessDenied only surfaced once that was
      // fixed. Two failures stacked on the same swallowed path.
      //
      // WHY IT MATTERS MORE NOW: since absent-row means DENY-ALL, a scope whose row cannot be written is
      // an agent that can do nothing at all — not even fs.read — and the dispatcher is the only thing that
      // writes rows for MINTED scopes, which no deploy can enumerate. Measured live: dm-ux0mz5ckp2r and
      // ch-c39t04uyfgs were both in exactly that state.
      //
      // NO CONDITION EXPRESSION. Unlike the seed pre-write (create-only, attribute_not_exists), this must
      // OVERWRITE: the whole point is refreshing a row whose policy digest has moved.
      await docClient().send(new UpdateCommand({
        TableName: config.agentConfigTable,
        Key,
        UpdateExpression: 'SET #d = :d',
        ExpressionAttributeNames: { '#d': 'data' },
        ExpressionAttributeValues: { ':d': JSON.stringify(row) },
      }));
      if (logger?.info) {
        const allowed = Object.entries(row.verdicts).filter(([, v]) => v === 'allow').map(([c]) => c);
        logger.info({ agent, policyDigest: row.policyDigest, allowed, entries: Object.keys(row.verdicts).length },
          existing ? 'policy row refreshed (policy digest moved)' : 'policy row written for scope');
      }
      return { written: true, reason: existing ? 'refreshed' : 'created' };
    } catch (e) {
      // Never fail a turn over this, but do not call it safe either. This comment used to read "an absent
      // row denies nothing new" — that was true when the runtime treated a missing row as permissive, and
      // permissions/policy-table.mjs deliberately reversed it (a permissive default on the component whose
      // job is withholding capability made every pin on ch-cr89fluhion silently inert). So a scope that
      // reaches this catch on a FIRST write can do nothing at all, and one that reaches it on a refresh
      // keeps stale verdicts. Non-fatal is about not failing the turn, not about the blast radius.
      if (logger?.warn) logger.warn({ agent, err: e?.message }, 'policy row ensure failed (non-fatal)');
      return { written: false, reason: 'error', error: e?.message };
    }
  }

  /**
   * Pre-write a brand-new agent's MARKETPLACE slice — its default skills and Connector toolkits.
   *
   * Same contract as seedNewWorkspace, for the same reasons: called only when the access point was
   * just created (the proof that this agent is genuinely new), guarded by `attribute_not_exists` so
   * it can never overwrite a slice App Home has since edited, and NEVER fatal — an agent with no
   * skills is a working agent with less to do, whereas failing a provision over it is an outage.
   *
   * Why here and not in the boot resolver, where the CONFIG default lives: `_mutateMarketplace`
   * creates this item lazily on the first App Home install, so "empty" is a real state the user can
   * reach. Defaulting on empty at boot would mean installing one skill silently DROPPED the seeded
   * two — a surprise that gets worse the longer it goes unnoticed. Writing it once at mint makes it
   * ordinary state that App Home edits incrementally.
   */
  async function seedNewMarketplace(agent, { logger } = {}) {
    if (_faked || !config.agentConfigTable) return { seeded: false, reason: 'no-table' };
    try {
      const schema = await loadConfigSchema();
      if (typeof schema.mintedAgentMarketplace !== 'function') {
        return { seeded: false, reason: 'no-default' };
      }
      const data = schema.mintedAgentMarketplace();
      const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
      await docClient().send(new UpdateCommand({
        TableName: config.agentConfigTable,
        Key: schema.marketplaceKey(agent),
        UpdateExpression: 'SET #d = :d',
        ExpressionAttributeNames: { '#d': 'data' }, // `data` is a DDB reserved word
        ExpressionAttributeValues: { ':d': JSON.stringify(data) },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      logger?.info?.({
        agent, skills: Object.keys(data.installs).length, connectors: Object.keys(data.connectors).length,
      }, 'marketplace seed pre-written for new agent');
      return { seeded: true, skills: Object.keys(data.installs), connectors: Object.keys(data.connectors).length };
    } catch (e) {
      if (e?.name === 'ConditionalCheckFailedException') return { seeded: false, reason: 'already-exists' };
      logger?.warn?.({ agent, err: e?.message }, 'marketplace seed pre-write failed (non-fatal)');
      return { seeded: false, reason: 'error', error: e?.message };
    }
  }

  async function ensureAgentEnvironment(agent, opts = {}) {
    const provClients = makeProvisioningClients(clients(), docClient());
    const name = opts.runtimeName || sanitizeRuntimeName(agent);

    // Two INDEPENDENT DynamoDB reads on this cold path — the legacy-EFS root (AGENT#<id>/META) and
    // the agent's grants (GRANT#<id>/SCOPE#*, read by resolveDerivedRole). They were sequential
    // awaits; nothing links them, so they run concurrently and cost one round trip instead of two.
    // Promise.all (not allSettled) is right HERE because these are pure reads that create nothing:
    // there is no half-built resource to leak if one rejects, and a failure must abort the provision.
    //
    // Explicit opts.efsRoot / opts.role (tests, callers) win and short-circuit their read.
    // A2 (§9.8) + §9.9b: every agent gets its OWN /agentcore/ role = the agentcore-base managed floor
    // ∪ an inline policy carrying (a) a config-table read scoped to THIS agent's AGENT#/GRANT#
    // partitions and (b) its cap-derived grants. Per-agent because `dynamodb:LeadingKeys` takes
    // literal partition keys — on a fleet-shared role the narrowest expressible read is AGENT#*, i.e.
    // every agent's config and grants. No flag, and no shared fallback: ensureExecRole throws if this
    // yields nothing.
    function resolveRole() {
      if (opts.role) return Promise.resolve(opts.role); // explicit (BDD per-leg role) wins
      // `_faked` = setClientsForTest injected fake AWS clients; resolving a real derived role would
      // reach DynamoDB + IAM. Tests take the explicit-ARN path with a synthetic PER-AGENT arn, so the
      // saga shape is exercised without AWS and without reintroducing a shared fallback. Prod can
      // never reach this branch (only setClientsForTest sets _faked).
      if (_faked) return Promise.resolve(`arn:aws:iam::${config.account}:role/agentcore/${agent}`);
      return derivedRole.resolveDerivedRole({
        doc: docClient(),
        tableName: config.agentConfigTable,
        account: config.account,
        agentId: agent,
        baseManagedPolicyArn: config.baseManagedPolicyArn,
        region: config.region,
        logger: opts.logger,
      });
    }

    const [efsRoot, resolvedRole] = await Promise.all([
      opts.efsRoot ? Promise.resolve(opts.efsRoot) : resolveEfsRootFromMeta(agent),
      resolveRole(),
    ]);
    if (efsRoot && efsRoot !== agent && opts.logger && opts.logger.info) {
      opts.logger.info({ msg: 'legacy-EFS adopt', agent, efsRoot });
    }

    const role = resolvedRole;

    // Warm-up invokes through the real cold-boot retry path against an isolated session.
    return provisioning.ensureAgentEnvironment(agent, {
      runtimeName: name,
      // A derived per-agent role spec, or an explicit caller-supplied ARN. NEVER a shared fallback —
      // see the no-feature-flag note in baseConfig(). ensureExecRole throws if this is absent.
      role,

      // REQUIRED. No `|| config.imageUri` fallback: that is precisely how a roll became a silent
      // no-op once already. A missing image is a bug or an unpublished fleet — both must be loud.
      image: requireImage(opts.image, agent),
      envs: opts.envs || runtimeEnv(agent),
      // §8.10 legacy-EFS adopt: a scope-keyed agent (e.g. dm-u0…) carries META.efsRoot = its former
      // NAME (e.g. agent-xx9aff). AGENT_NAME + the runtime name stay the SCOPE id (config/
      // DDB/session identity), but the EFS access-point ROOT points at the legacy name's dir, so the
      // rekeyed agent mounts the old workspace/sessions/memory verbatim (the adapter is path-agnostic
      // — the AP IS the isolation). No efsRoot → the AP root is the agent's own dir (default).
      efsRootFor: efsRoot ? () => efsRootFor(efsRoot) : efsRootFor,
      accessPointArn: opts.accessPointArn || config.accessPointArn, // adopt a caller-pinned AP verbatim
      // §9.9a: the dispatcher is the SOLE writer of AGENT#<id>/SEED. Invoked by the saga only when
      // the EFS access point was just created (fresh workspace) — see seedNewWorkspace.
      seedNewWorkspace,
      // Same injection reason and same brand-new-agent gate — see seedNewMarketplace.
      seedNewMarketplace,
      // Phase 3: runs CONCURRENTLY with the mount-target/access-point legs, so its HTTP round trip
      // costs ~0 wall clock. Contracted never to throw; a failure leaves the agent on the shared key.
      ensureConnectorCredential,
      cleanupOnFailure: opts.cleanupOnFailure !== false,
      metrics,                         // M1 D6: ClawdbotDispatcher provision phase/count metrics
      clients: provClients,
      config,
      logger: opts.logger,
      sleep,
    });
  }

  // Get-or-create the agent's runtime, returning its ARN. Warm path is a Map lookup (ZERO extra
  // API calls). Cold path (per agent, once) discovers an existing runtime by name or provisions one.
  // Concurrent first requests for the same agent share ONE in-flight promise, so we never
  // double-create. Nothing here invokes the runtime — the caller's own turn is its first invoke.
  /**
   * The DECLARED INPUTS that determine a runtime's immutable spec. Everything here is baked in at
   * CreateAgentRuntime and cannot be changed afterwards, so a change to ANY of it must produce a new
   * generation — otherwise the change silently never applies to existing runtimes, which was a real
   * latent bug: moving DISPATCHER_BASE_URL or rotating a secret's ID reached new agents only.
   *
   * DELIBERATE EXCLUSIONS, each for a different reason:
   *   agentRuntimeName  self-referential — the name CONTAINS this hash.
   *   accessPointArn    an OUTPUT of provisioning (ensureAccessPoint runs inside createRuntime, i.e.
   *                     after the name is needed). Its determinant, the root PATH, is included instead.
   *   subnets           discovered via DescribeMountTargets, so including it would put an API call on
   *                     every turn, and it comes back unordered. An AZ/subnet change is an infra event
   *                     where a deliberate roll (retag) is acceptable. STATED LIMITATION, not an oversight.
   *   roleArn           IAM evaluates at request time and a grant change rewrites the policy in place
   *                     (§9.9c), so identity changes already apply live and need not force a roll.
   */
  function runtimeSpecFor(agent, image) {
    return {
      image,
      efsRoot: efsRootDir(agent, config.efsRootPrefix),
      efsMountPath: config.efsMountPath,
      envs: runtimeEnv(agent),
      securityGroupId: config.securityGroupId,
      idleRuntimeSessionTimeout: 900,
      maxLifetime: 28800,
      serverProtocol: 'HTTP',
    };
  }

  /** Runtime name for this agent on this image, fingerprinting the WHOLE immutable spec. */
  function generationNameFor(agent, image) {
    return generationRuntimeName(agent, runtimeSpecFor(agent, image));
  }

  async function ensureRuntime(agent, opts = {}) {
    // The runtime NAME fingerprints the WHOLE immutable spec, so it is the correct key: an image roll
    // changes the name, misses the registry, and provisions the new generation. Keying by `agent` (as
    // this once did) would serve the previous generation's ARN forever — the fleet would never move, and
    // the only symptom would be an image that quietly never rolled.
    const image = requireImage(opts.image, agent);
    const name = opts.runtimeName || generationNameFor(agent, image);

    // THE PRE-WARM SCOREBOARD. Emitted for EVERY turn, exactly once, with the outcome that turn actually
    // experienced — so hit+miss = turns and the ratio is meaningful. Counting provisions instead would
    // undercount: when N turns coalesce onto one provision, one provision happened but N turns WAITED.
    const startedAt = Date.now();
    const score = (outcome) => {
      // ALSO on the span, not only as a metric. `dispatcher.ensure_runtime` is the single largest
      // term in TTFM (57% of the joined total, measured over 61 phase-instrumented turns on
      // 2026-08-13) and it had NO children and NO attributes — a 122-second span whose own trace
      // could not say whether the turn provisioned, waited on someone else's provision, or waited
      // for a permit. The metric answers that fleet-wide; only the attribute answers it for THE
      // slow turn you are looking at, which is the question anyone opens a trace to ask.
      try {
        otelTrace.getActiveSpan()?.setAttributes({
          'dispatcher.runtime_cache_outcome': outcome,
          'dispatcher.runtime_cache_wait_ms': Date.now() - startedAt,
          'dispatcher.runtime_generation': name,
        });
      } catch { /* telemetry must never fail a turn */ }
      try { metrics.emitRuntimeCache(agent, { outcome, waitMs: Date.now() - startedAt, runtime: name }); }
      catch { /* telemetry must never fail a turn */ }
    };

    // Consulted SYNCHRONOUSLY, before any await. The registry read below is asynchronous, so checking
    // _inflight after it would let two concurrent callers both miss and both start a provision.
    if (_inflight.has(name)) {
      // Not its own registry read, so not a hit — this turn waits on another turn's provision. Counted
      // separately from `miss` because it is the herd collapsing as designed (one provision, N waiters),
      // not N independent misses; a rising coalesced share during a roll is the mechanism working.
      return _inflight.get(name).then((arn) => { score('coalesced'); return arn; });
    }

    const p = (async () => {
      // THE FAST PATH, and the whole reason the registry exists: one GetItem, zero control-plane calls.
      // It replaces both the in-process Map (which forgot the fleet on every restart) and the
      // ListAgentRuntimes scan that the forgetting then forced.
      const row = await registry().get(agent, name);
      if (row?.arn) { score('hit'); return row.arn; }

      return _provisionSem.run(async (waitedMs) => {
        if (waitedMs > 0) {
          // Visible attribution: this provision was slow because we throttled it ourselves, not because
          // AWS was slow. Without this the wait is indistinguishable from control-plane latency.
          opts.logger?.info?.({ agent, runtime: name, waitedMs, limit: MAX_CONCURRENT_PROVISIONS },
            'provision waited for a concurrency permit');
        }
        // Re-read under the permit. Queueing for a permit can take tens of seconds and another turn may
        // have provisioned this exact generation meanwhile; without this, a burst of cold turns for one
        // agent provisions the SAME generation once per turn, in series behind the bound.
        const fresh = await registry().get(agent, name);
        // Someone provisioned it while we queued for the permit. Distinct from `coalesced`: there was no
        // in-flight promise to join when we arrived, so we paid the permit wait before discovering the
        // work was already done. A rising share here means the provision bound is the thing delaying
        // turns, not the provision itself.
        if (fresh?.arn) { score('late_hit'); return fresh.arn; }

        // No pre-flight ListAgentRuntimes. createRuntime issues CreateAgentRuntime directly and treats a
        // name conflict as the ADOPT signal (agentcore-provisioning classifies ConflictException as
        // 'adopt'), which is also what recovers a runtime created moments before a crash lost the write —
        // "exists at AWS but absent from the table" means finish and record it, not create a second one.
        // The expensive scan now happens only in that rare collision case.
        const { runtimeArn, runtimeId } = await createRuntime(agent, name, opts.logger, { efsRoot: opts.efsRoot, image });
        // Recorded ONLY once the runtime is verified READY (ensureAgentEnvironment polls before
        // returning), so the row's existence is an assertion about a runtime that actually works. A
        // failed write leaves no row, and the next turn adopts by conflict rather than duplicating.
        await registry().record(agent, name, { arn: runtimeArn, runtimeId });
        // The only outcome pre-warm must drive to zero: this turn paid for a provision.
        score('miss');
        return runtimeArn;
      });
    })().finally(() => _inflight.delete(name));
    _inflight.set(name, p);
    return p;
  }

  // Invoke a runtime with an SSE response, calling onChunk(event) for each delta/tool/final/error
  // event (see agentcore-pi/sse-contract). Retries send() through the microVM cold-boot window
  // (RuntimeClientError until the container is healthy). Returns the terminal `final` event.
  //
  // M2: dispatcher.agent_i073q7 spans the FULL invoke leg — send + SSE consumption + cold
  // retries — because the SDK's InvokeAgentRuntime auto-span covers the HTTP send only. The
  // startActiveSpan keeps
  // the context active so M3's propagation.inject at the send site picks this span up unchanged.

// ── Per-session serialisation (PER-MESSAGE ISOLATION) ────────────────────────────
//
// EXACTLY ONE invoke in flight per runtimeSessionId. Slack delivers concurrent events and a
// runtimeSessionId is derived per THREAD, so a burst in one thread used to fire N concurrent invokes
// at one session. Two live failure modes came out of that (pi-turn-transport-plan.md):
//   * warm session — Pi refused the concurrent prompt ("Agent is already processing"), the dispatcher
//     logged it at level 50 and then logged `invoke complete`, and 15 of 16 messages VANISHED.
//   * cold session — all N were accepted, each built its own AgentSession over the same JSONL, and
//     each answered with in=3 tokens and no cacheRead, i.e. blind to the others.
//
// Serialising HERE, rather than letting Pi queue turns inside one session, is deliberate: the adapter
// is written for one-turn-at-a-time (turnCtx is a single object MUTATED per turn, and `sessions`
// caches only after the build completes). Enforcing the invariant at the edge means the adapter is
// never asked to do something it was not built for — instead of making shared mutable state
// concurrency-safe and hoping.
//
// Ordering is Socket Mode delivery order, which for a single connection is send order. We do not
// buffer-and-sort by event ts: that would add latency to every message to fix a reorder that only a
// multi-connection deployment could cause.
//
// SINGLE-INSTANCE ASSUMPTION: this map is in-process, and the service runs desired_count = 1. A
// rolling deploy briefly runs two tasks, so an event could land on the new task while the old one
// still holds a queue — narrow, and the adapter's own "already processing" rejection is the backstop
// (surfaced LOUDLY, see the invoke path). If the dispatcher is ever scaled out, this must move to a
// shared store or the isolation is lost.
const _sessionQueues = new Map(); // runtimeSessionId -> tail promise (settled = queue drained)
const _sessionDepth = new Map();  // runtimeSessionId -> queued + running count

// The bound is a MEMORY backstop, not a usage policy — deliberately set far above anything a human
// produces, so "your message was refused" effectively never happens. It was 8, which a hand-typed
// 11-message burst blew straight through, rejecting 3 with a user-visible error.
//
// 10,000 is affordable because a queued turn is small: MEASURED at ~1,250 bytes each (closure over
// the turn scope — event, payload incl. prompt + priorContext — plus two promise-chain links), so a
// single session at the bound costs ~12 MB against the task's 4 GB.
//
// What the bound does NOT guard is the AGGREGATE: it is per session, and nothing caps sessions x
// depth. 50 simultaneously-deep threads would be ~625 MB. That needs ~500k queued messages to reach,
// so it is theoretical rather than reachable, but it IS the dimension that maps to RAM — if the
// alert below ever fires across many sessions at once, add a global cap rather than lowering this.
const MAX_SESSION_QUEUE = Number(process.env.AGENTCORE_MAX_SESSION_QUEUE || 10000);

// Depth at which the queue stops being "a burst" and becomes "something is wrong". At ~10s per
// serialised turn, 200 outstanding is already ~30 minutes of backlog for that thread — long before
// memory matters, and long after the user stopped expecting an answer. Alarmed in dispatcher.tf.
const SESSION_QUEUE_ALERT_DEPTH = Number(process.env.AGENTCORE_SESSION_QUEUE_ALERT_DEPTH || 200);

// Which session's slot the current async context already owns. index.js wraps the WHOLE Slack turn
// (stream setup + ensureRuntime + invoke) in a slot, so the invokeStreaming inside it must
// run INLINE — re-entering the queue would make the turn wait on its own tail, i.e. deadlock. Tracking
// ownership in async context rather than a boolean parameter means the guard cannot be forgotten by a
// future call site, and cron callers that hold no slot still get serialised normally.
const _slotOwner = new AsyncLocalStorage();

// ── Phase 1 concurrency bounds (provisioning-queue-plan.md) ──────────────────────────────────────
//
// These used to be ONE number, TURN_QUEUE_POLLERS, because provisioning and invoking both happened
// inside a poller's slot. Splitting them is the point of Phase 1: a 30-45s provision must not consume
// capacity that could be serving a turn.
//
// PROVISIONS — small on purpose. Measured 2026-08-13 in the sandbox: concurrent EFS CreateAccessPoint
// (a step inside every provision) is clean at 40, partially throttled at 60 (26 ok / 34 "Rate
// exceeded"), and total failure once the bucket is drained. ensureAccessPoint already retries
// throttles, so the cost of over-running the limit is ~30-60s of backoff added to a turn's TTFM — i.e.
// it degrades exactly the metric we are defending. AgentCore's own documented limits are far higher
// (control-plane mutations 50/s, Gets 150/s), so EFS is the binding constraint, not CreateAgentRuntime.
const MAX_CONCURRENT_PROVISIONS = Number(process.env.AGENTCORE_MAX_CONCURRENT_PROVISIONS || 5);

// INVOKES — the expensive resource: one live SSE stream and one agent run each.
//
// ⚠ INVARIANT: nothing reachable from inside a running turn may call invokeStreaming. Today nothing
// does (agent tool calls reach the dispatcher's manager API, which creates cron jobs but never fires
// one; cron fires come from timers, outside any turn). If that ever changes, an agent-initiated invoke
// could wait for a permit held by turns that are themselves waiting on it — a deadlock. Such a call
// site must bypass this bound.
const MAX_CONCURRENT_INVOKES = Number(process.env.AGENTCORE_MAX_CONCURRENT_INVOKES || 25);

// Socket pools. A concurrency bound above the socket count is a fiction (see sdk-http.js), so both
// derive from the bounds above with headroom for the retry/poll traffic each path generates.
const INVOKE_MAX_SOCKETS = Number(process.env.AGENTCORE_INVOKE_MAX_SOCKETS || Math.max(50, MAX_CONCURRENT_INVOKES * 2));
const CONTROL_MAX_SOCKETS = Number(process.env.AGENTCORE_CONTROL_MAX_SOCKETS || Math.max(50, MAX_CONCURRENT_PROVISIONS * 8));

const _provisionSem = createSemaphore(MAX_CONCURRENT_PROVISIONS, { name: 'provision' });
const _invokeSem = createSemaphore(MAX_CONCURRENT_INVOKES, { name: 'invoke' });

/** Occupancy of both bounds, for the EMF gauges and the dispatcher.request span attributes. */
function concurrencyStats() {
  return { provision: _provisionSem.stats(), invoke: _invokeSem.stats() };
}

/**
 * Run `fn` with exclusive use of this session, after every previously-enqueued call has settled.
 * Reentrant: if the caller already owns this session's slot, `fn` runs immediately.
 */
// Sessions currently over the alert depth. Used to log the CROSSING once rather than on every
// enqueue above it — a 400-deep queue would otherwise emit 200 identical warnings.
const _alertingSessions = new Set();

function runExclusiveForSession(sessionId, fn, { metrics, agent, logger } = {}) {
  if (_slotOwner.getStore() === sessionId) return Promise.resolve().then(fn);

  const depth = _sessionDepth.get(sessionId) || 0;
  if (depth >= MAX_SESSION_QUEUE) {
    // Reject so the caller can TELL them, rather than leaving them waiting on a reply nobody remembers
    // asking for. index.js turns this into a "too many messages queued" reply, NOT "the agent errored".
    metrics?.emitSessionQueue?.(agent, { rejected: true, depth, max: MAX_SESSION_QUEUE, sessionId });
    const err = new Error(`session queue full (${depth}/${MAX_SESSION_QUEUE}) for ${sessionId}`);
    err.name = 'SessionQueueFull';
    return Promise.reject(err);
  }
  _sessionDepth.set(sessionId, depth + 1);
  // Depth INCLUDING this turn: 1 means it went straight through, N means N-1 ahead of it.
  const queueDepth = depth + 1;
  const queuedAt = Date.now();
  metrics?.emitSessionQueue?.(agent, { depth: queueDepth, sessionId });

  // Backlog alert. The metric is emitted on EVERY enqueue past the threshold so the alarm sees a
  // sustained signal (a single spike would be lost by `Sum` over a 5-minute period); the log fires
  // once per crossing so the reader gets one line, not one per message.
  if (queueDepth >= SESSION_QUEUE_ALERT_DEPTH) {
    metrics?.emitSessionQueue?.(agent, { backlog: true, depth: queueDepth, alertAt: SESSION_QUEUE_ALERT_DEPTH, sessionId });
    if (!_alertingSessions.has(sessionId)) {
      _alertingSessions.add(sessionId);
      logger?.warn?.({ agent, sessionId, depth: queueDepth, alertAt: SESSION_QUEUE_ALERT_DEPTH, max: MAX_SESSION_QUEUE },
        'session queue backlog — turns are serialised, so this thread is now minutes behind');
    }
  }
  const prev = _sessionQueues.get(sessionId) || Promise.resolve();
  const run = () => {
    // Measured at the moment the slot is actually entered, so it isolates the queueing cost from the
    // turn's own latency — perceived latency is this PLUS InvokeLatencyMs.
    metrics?.emitSessionQueue?.(agent, { waitMs: Date.now() - queuedAt, depth: queueDepth, sessionId });
    return _slotOwner.run(sessionId, fn);
  };
  // Gate on the predecessor SETTLING, not succeeding — one failed turn must not poison the queue.
  const result = prev.then(run, run);
  // The tail tracks completion regardless of outcome, so the next caller waits for us either way.
  const tail = result.then(() => {}, () => {});
  _sessionQueues.set(sessionId, tail);
  tail.then(() => {
    const d = (_sessionDepth.get(sessionId) || 1) - 1;
    if (d <= 0) {
      _sessionDepth.delete(sessionId);
      if (_sessionQueues.get(sessionId) === tail) _sessionQueues.delete(sessionId);
      // Drained: re-arm the alert so a LATER backlog on this thread is reported again rather than
      // suppressed forever by a crossing that has long since cleared.
      _alertingSessions.delete(sessionId);
    } else _sessionDepth.set(sessionId, d);
  });
  return result; // the caller sees the real resolution/rejection, not the swallowed tail
}

  async function invokeStreaming(runtimeArn, runtimeSessionId, payload, onChunk, opts = {}) {
    // PER-MESSAGE ISOLATION: one invoke at a time per session (see runExclusiveForSession above).
    // A no-op when the Slack turn already holds the slot; the real gate for callers that don't.
    //
    // The GLOBAL invoke bound sits INSIDE the per-session slot, and that nesting order matters: the
    // session slot is per-thread and the invoke permit is process-wide, so acquiring the narrow lock
    // first and the shared one second is the order that cannot deadlock. It also means a turn queued
    // on the global bound is not holding up other threads' provisioning, only its own thread.
    return runExclusiveForSession(runtimeSessionId, () => _invokeSem.run(async (waitedMs) => {
      if (waitedMs > 0) {
        opts.logger?.info?.({ agent: opts.agent, sessionId: runtimeSessionId, waitedMs, limit: MAX_CONCURRENT_INVOKES },
          'invoke waited for a concurrency permit');
      }
      return invokeStreamingNow(runtimeArn, runtimeSessionId, payload, onChunk, opts);
    }), { metrics, agent: opts.agent });
  }

  async function invokeStreamingNow(runtimeArn, runtimeSessionId, payload, onChunk, opts = {}) {
    return otelTracer.startActiveSpan('dispatcher.agent_i073q7', {
      kind: SpanKind.CLIENT,
      attributes: {
        ...(opts.agent != null ? { 'dispatcher.agent': opts.agent } : {}),
        ...(opts.trigger != null ? { 'dispatcher.trigger': opts.trigger } : {}),
        'dispatcher.session_id': runtimeSessionId,
      },
    }, async (span) => {
      try {
        return await doInvokeStreaming(runtimeArn, runtimeSessionId, payload, onChunk, opts, span);
      } catch (e) {
        span.recordException(e);
        span.setStatus({ code: SpanStatusCode.ERROR, message: (e && e.message) || String(e) });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  async function doInvokeStreaming(runtimeArn, runtimeSessionId, payload, onChunk, opts, span) {
    const { InvokeAgentRuntimeCommand } = bac();
    // M3 produce: stamp the active dispatcher.agent_i073q7 context into the body as a W3C
    // traceparent so the runtime's agent_i073q7 agent_i32pz9 span parents under THIS span (one
    // trace-id across the boundary). Payload field, not header: portable across Slack, cron
    // (both funnel through here), independent of whether AgentCore forwards HTTP
    // headers to /invocations (spike S1). The runtime extract (agentcore-pi/trace-context.mjs)
    // prefers a native header when present, so this is also the fallback if S1 says yes.
    // No-op when tracing isn't registered (propagation.inject on a no-op context sets nothing).
    if (payload && payload.input && typeof payload.input === 'object' && !payload.input.traceparent) {
      const carrier = {};
      propagation.inject(otelContext.active(), carrier);
      if (carrier.traceparent) {
        payload.input.traceparent = carrier.traceparent;
        if (carrier.tracestate) payload.input.tracestate = carrier.tracestate;
      }
    }
    const maxColdRetries = opts.maxColdRetries ?? 15;
    const coldBackoffMs = opts.coldBackoffMs ?? 12000;
    // retryIncomplete: also retry when the stream OPENS but closes WITHOUT a terminal
    // `final` event (a cold microVM reaped mid-turn). On for the cron path; off for the
    // Slack path (a retry would re-stream/double-render — surface the error instead).
    const retryIncomplete = opts.retryIncomplete === true;
    // M1 D6 invoke metrics: `agent`/`trigger` are threaded from the two call sites (index.js
    // forwardToAgentCore, cron-fire.js) so ALL invoke emit lives HERE (single source of truth,
    // no duplicated emit at the sites). InvokeLatencyMs = the invoke leg only (the cold-provision
    // cost is already ProvisionRuntimeReadyMs). InvokeColdRetries = extra attempts before success.
    const metricAgent = opts.agent;
    const trigger = opts.trigger;
    const emitInvokeMetrics = opts.agent != null;
    const t0 = Date.now();
    let lastErr = null;
    // §12c.7: a caller-initiated abort (cron timeout) must NEVER be retried. Both retry branches
    // below are written for a cold-microVM reap, which presents as the same kind of stream error —
    // so without this guard a timed-out job would be re-invoked up to maxColdRetries times with
    // backoff, i.e. the timeout would AMPLIFY the runaway it exists to stop. Gated on our own
    // signal rather than the error name/message, which is ambiguous between the two causes.
    const abortedByCaller = () => opts.abortSignal?.aborted === true;
    for (let attempt = 1; attempt <= maxColdRetries; attempt += 1) {
      let resp;
      try {
        const cmd = new InvokeAgentRuntimeCommand({
          agentRuntimeArn: runtimeArn,
          runtimeSessionId,
          contentType: 'application/json',
          accept: 'text/event-stream',
          payload: Buffer.from(JSON.stringify(payload)),
        });
        // §12c.7 (G7): the cron path enforces payload.timeoutSeconds by aborting. Without a real
        // abort a "timeout" would only stop us WAITING while the turn kept running to completion on
        // the runtime — billed, side effects and all — which is not a timeout, it is looking away.
        // The signal belongs to send()'s http options, NOT the command input: an earlier draft had
        // the parens wrong and passed it as the command's second constructor arg, where the SDK
        // ignored it entirely and abort silently did nothing. Bound as a separate statement so that
        // mistake is not expressible.
        resp = opts.abortSignal
          ? await clients().invoke.send(cmd, { abortSignal: opts.abortSignal })
          : await clients().invoke.send(cmd);
      } catch (e) {
        lastErr = e;
        const emsg = `${e?.name} ${e?.message}`;
        // "not in an invocable state" splits by the STATUS it reports, and the split matters:
        //   CREATING / UPDATING — transient, the runtime is on its way in. Retry.
        //   DELETING            — terminal for this ARN. It is never coming back, so retrying
        //                         burns the whole cold-retry budget and then bricks the agent.
        const notInvocable = /not in an invocable state/i.test(emsg);
        const runtimeDeleting = notInvocable && /DELETING|DELETE_FAILED/i.test(emsg);
        const coldish = /RuntimeClientError|not ready|throttl|ServiceUnavailable|503/i.test(emsg)
          || (notInvocable && !runtimeDeleting);
        if (coldish && attempt < maxColdRetries && !abortedByCaller()) { await sleep(coldBackoffMs); continue; }
        // Runtime-gone eviction: the recorded ARN points at a runtime that no longer exists
        // (deleted outside the dispatcher — live-hit 2026-08-01). Without eviction the agent
        // is bricked. Evict so the caller's existing retry machinery (Slack forward-retry, cron
        // next fire) re-enters ensureRuntime, which recreates by name — "recreate converges"
        // extends through the registry.
        //
        // THIS IS THE INVALIDATION THAT MAKES A DURABLE CACHE SAFE. The old in-process Map got the
        // same protection for free from process restarts; the registry has no such accident, so this
        // path is now load-bearing rather than an optimisation. The registry is authoritative for
        // name→arn and never for LIVENESS — the invoke is what proves liveness, and this is where a
        // disproof is written back.
        //
        // Evict by ARN, not by agent: rows are keyed by RUNTIME NAME (which encodes the image
        // generation), so an agent has one row per generation and clearing "the agent's" would be
        // ambiguous. clearByArn also makes the write CONDITIONAL on the arn still being the recorded
        // one, so it cannot discard a fresh runtime that another turn provisioned in the meantime.
        // DELETING belongs here too, and its absence was a live outage (2026-08-13). A runtime
        // deleted out-of-band is the DOCUMENTED roll mechanism, and AWS does not report that as
        // ResourceNotFoundException while the delete is in flight — it reports ValidationException
        // "not in an invocable state. Current status: DELETING", for minutes. Matching only the
        // not-found shape meant the registry kept serving a dead ARN for that entire window and the
        // agent answered nothing. Eviction has to cover "gone" AND "going".
        if (/ResourceNotFoundException|No endpoint or agent found/i.test(emsg) || runtimeDeleting) {
          if (opts.agent) {
            await registry().clearByArn(opts.agent, runtimeArn).catch((regErr) => {
              opts.logger?.warn?.({ err: regErr.message, agent: opts.agent, runtimeArn },
                'runtime registry: eviction failed — the next turn will invoke the dead arn again');
            });
          }
          if (opts.logger?.warn) opts.logger.warn({ agent: opts.agent, runtimeArn, reason: runtimeDeleting ? 'deleting' : 'not-found' }, 'agentcore invoke: runtime gone — evicted cached ARN (next attempt re-ensures)');
        }
        if (emitInvokeMetrics) metrics.emitInvokeError(metricAgent, { trigger, errName: e?.name || 'Error' });
        throw e;
      }

      let final = null;
      // The runtime reports a THROWN turn in-band: `error` followed by `final {text:''}`. This
      // helper used to look only at `final`, so that pair returned an empty-but-successful turn and
      // the error vanished — no log, no metric, no thrown exception. Live consequence (2026-08-12):
      // a cron job whose turns failed every time logged "cron fire completed, textLen 0", was
      // recorded status:'ok', and RESET consecutiveErrors, so failureAlert could never trip. It is
      // the same silent-failure class the Slack consumer already guards (`sawError`), but that fix
      // lives in the Slack chunk handler, so every other caller — cron included — stayed exposed.
      //
      // Captured here rather than thrown, so the Slack path keeps reporting the failure itself from
      // the event; callers that cannot see events (cron passes NOOP_CHUNK) read `final.error`.
      let streamError = null;
      if (resp?.response) {
        let buf = '';
        const handle = (ev) => {
          if (ev.type === 'final') final = ev;
          if (ev.type === 'error') streamError = ev.message || 'agentcore stream error';
          try { onChunk(ev); } catch (e) { if (opts.logger?.warn) opts.logger.warn({ err: e.message }, 'agentcore onChunk threw'); }
        };
        try {
          for await (const chunk of resp.response) {
            buf = feedSse(buf + Buffer.from(chunk).toString('utf8'), handle);
          }
          const tail = buf.trim();
          if (tail.startsWith('data:')) { try { handle(JSON.parse(tail.slice(5).trim())); } catch { /* ignore */ } }
        } catch (e) {
          // Stream aborted mid-flight (e.g. cold microVM reaped) — retryable, UNLESS we aborted it.
          lastErr = e;
          if (attempt < maxColdRetries && !abortedByCaller()) { if (opts.logger?.warn) opts.logger.warn({ attempt, err: String(e && e.message) }, 'agentcore stream error — retrying'); await sleep(coldBackoffMs); continue; }
          if (emitInvokeMetrics) metrics.emitInvokeError(metricAgent, { trigger, errName: e?.name || 'Error' });
          throw e;
        }
      }

      if (final != null) {
        // completed turn — emit latency (invoke leg) + cold-retry count (attempt-1 = extra tries).
        if (emitInvokeMetrics) metrics.emitInvoke(metricAgent, { latencyMs: Date.now() - t0, coldRetries: attempt - 1, trigger });
        span.setAttribute('dispatcher.cold_retries', attempt - 1);
        if (streamError) {
          // Loud here as well as on the caller, because this is the layer that knows an `error`
          // arrived at all — everything above it sees only an empty turn.
          if (opts.logger?.error) opts.logger.error({ agent: opts.agent, trigger, err: streamError }, 'agentcore turn reported an error event');
          span.setAttribute('dispatcher.turn_error', streamError);
          return { ...final, error: streamError };
        }
        return final;
      }

      // The stream opened but produced no terminal `final` event = an INCOMPLETE turn
      // (the cold-boot silent-miss bug: this used to `return null` and be recorded as a
      // benign success). Retry within the cold window when asked; otherwise fail loudly.
      lastErr = new Error('agentcore invoke: stream closed without a final event (incomplete turn)');
      if (retryIncomplete && attempt < maxColdRetries && !abortedByCaller()) {
        if (opts.logger?.warn) opts.logger.warn({ attempt }, 'agentcore invoke: no final event — retrying');
        await sleep(coldBackoffMs);
        continue;
      }
      if (emitInvokeMetrics) metrics.emitInvokeError(metricAgent, { trigger, errName: 'IncompleteTurn' });
      throw lastErr;
    }
    if (emitInvokeMetrics) metrics.emitInvokeError(metricAgent, { trigger, errName: lastErr?.name || 'InvokeFailed' });
    throw lastErr || new Error('agentcore invoke failed after retries');
  }

  return {
    ensureRuntime,
    ensureAccessPoint,
    invokeStreaming,
    // Per-message isolation: index.js wraps a whole Slack turn in a session slot so the stream a
    // user SEES is set up when that message's turn begins, not on arrival. Bound to this
    // client's metrics sink so queue depth/wait is emitted from the TURN boundary (where the wait a
    // user actually feels begins), not just from the inner invoke.
    runExclusiveForSession: (sessionId, fn, opts = {}) => runExclusiveForSession(sessionId, fn, { metrics, ...opts }),
    // Phase 1 occupancy, for the EMF gauges and the dispatcher.request span attributes.
    concurrencyStats,
    setRegistryForTest,
    // Exposed so tests can assert what was (and was NOT) recorded — the registry has no status field
    // and no expiry, so "which rows exist" IS the contract.
    runtimeRegistryForTest: registry,
    ensureAgentEnvironment,
    // The compiled policy row for a scope. Called on the turn path by ensureCurrentRuntime so a MINTED
    // scope — which no deploy can enumerate — gets its verdicts, and so a policy edit reaches every
    // scope on its next turn rather than only the ones a deploy happened to see.
    ensurePolicyRow,
    config,
    makeStreamBridge,
    findRuntimeByName,
    deleteRuntime,                 // C1: idempotent runtime delete (fleet roll)
    gcOldGenerations,              // reap superseded generations (off the turn path); result carries .specs
    observedSpecOf,                // a live runtime's ACTUAL spec, read back from AWS
    // agent+image -> runtime name, fingerprinting the whole immutable spec. index.js uses this for GC,
    // so it MUST be the same function ensureRuntime uses or the two disagree about what to keep.
    generationRuntimeName: generationNameFor,
    runtimeSpecFor,                // exposed so a roll can report WHICH input changed
    applyDerivedRoleGrantChange,   // A3: grant-change → live PutRolePolicy (keeps the scoped read)
    runtimeEnv,
    clients,
    setClientsForTest,
    resetCacheForTest,
    // M1 D6: the shared ClawdbotDispatcher metrics emitter (exposed for direct call-site use / tests)
    metrics,
    // internal, kept for the provisioning saga callers
    createRuntime,
  };
}

// ── SSE helpers (stateless; shared by every client instance) ───────────────────

// Build the onChunk handler that bridges invokeStreaming's SSE events into the dispatcher's
// StreamingManager — the same rendering path the ECS gateway WS uses. Deps injected (streaming
// manager + notifyFailure) so it's unit-testable in isolation. Mirrors index.js's WS
// setEventHandler: delta→getOrCreateRun+handleDelta, tool→handleTask, final→stopStream+
// finalizeRun (with NO_REPLY suppression), error→log.
//
// There are no reactions in this path any more (the 👀→🤔→✅/❌ lifecycle is gone). `notifyFailure`
// replaces the one reaction that carried information the user could get nowhere else: the ❌ on a turn
// that errored with no text. Everything else the reactions said is now said by the stream itself.
function makeStreamBridge({ streaming, session, runId, channel, threadTs, notifyFailure, logger }) {
  // ONE reply per invoke: the dispatcher serialises invokes per session, so a run answers exactly one
  // user message. `sawError` exists so a failed turn is never SILENT — see the final branch.
  let sawError = false;
  return (ev) => {
    if (!session) return;
    session.staleAt = Date.now() + 60 * 60 * 1000;
    if (ev.type === 'delta') {
      const run = streaming.getOrCreateRun(session, runId);
      streaming.handleDelta(run, session, ev.text || '');
    } else if (ev.type === 'tool') {
      // Map our sse-contract tool status to Slack's task_update enum (in_progress|complete|error);
      // Slack rejects the chunk otherwise ("failed to match schema"). Mirrors resolvePhaseStatus.
      const slackStatus = ev.status === 'done' ? 'complete' : ev.status === 'running' ? 'in_progress' : 'error';
      streaming.handleTask(session, ev.itemId, ev.title, slackStatus);
    } else if (ev.type === 'error') {
      // RECORD it. Previously an error event was logged and then the empty `final` finalised the run
      // silently, so a failed turn looked identical to a turn with nothing to say — that is how Pi's
      // "Agent is already processing" rejection dropped 15 of 16 messages without a trace.
      sawError = true;
      if (logger?.error) logger.error({ err: ev.message }, 'agentcore stream error event');
    } else if (ev.type === 'final') {
      const text = ev.text || '';
      const run = session.runs.get(runId);
      // A turn that ERRORED and produced no text must be VISIBLE. Saying so is the difference
      // between "the agent failed" and "the agent silently ignored you" — the latter is exactly what
      // dropped 15 of 16 messages in one live burst. A turn that simply had nothing to say (no error)
      // still finishes quietly, which is intended.
      if (!text) {
        if (run) streaming.finalizeRun(session, runId);
        if (sawError) { streaming.stopStream(session, null); notifyFailure?.(); }
        return;
      }
      const trimmed = text.trim();
      if (trimmed === 'NO_REPLY' || trimmed === 'NO_' || trimmed === 'NO') {
        streaming.stopStream(session, null);
        if (run) streaming.finalizeRun(session, runId);
        return;
      }
      const remainingDelta = run ? text.slice(run.lastText.length) : '';
      streaming.stopStream(session, text, { remainingDelta: remainingDelta || undefined });
      if (run) streaming.finalizeRun(session, runId);
    }
  };
}

// Parse a text/event-stream buffer incrementally. Feed bytes as they arrive; calls onEvent for
// each complete `data: <json>\n\n` frame and returns the unconsumed tail. Split out so #47 can
// unit-test chunk-boundary handling without AWS.
function feedSse(buffer, onEvent) {
  let buf = buffer;
  let idx;
  while ((idx = buf.indexOf('\n\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 2);
    if (!line.startsWith('data:')) continue;
    let ev;
    try { ev = JSON.parse(line.slice(5).trim()); } catch { continue; } // skip malformed frame
    onEvent(ev);
  }
  return buf;
}

// ── Module exports: the factory + PURE/STATELESS utilities only ────────────────
//
// There is NO singleton. Stateful client behavior is obtained solely via
// createAgentCoreClient() — each instance owns its own arn cache + SDK clients.
// The remaining named exports are pure/stateless helpers (usable standalone) plus
// CONFIG, the default env-resolved config object (read-only; instances resolve their own).

const CONFIG = mergeConfig(baseConfig());

module.exports = {
  // the sole stateful entry point (frozen contract §2.1)
  createAgentCoreClient,
  // pure/stateless utilities
  sanitizeRuntimeName,
  generationRuntimeName,
  imageFingerprint,
  canonicalize,
  isGenerationOf,
  feedSse,
  efsRootDir,
  // default env-resolved config (read-only)
  CONFIG,
};

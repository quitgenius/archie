'use strict';

// The dispatcher task definition, composed by archie.
//
// GATEWAY-OWNERSHIP-PLAN.md §4 and §5.1. This file is that §4 table as code: every one of the
// dispatcher's environment variables, with its source and — where it is a constant — the reasoning
// that made it one. It is PURE. Nothing here calls AWS; the facts arrive already discovered
// (lib/deployment-facts.js) and the per-deployment values already read from SSM. That split is what
// makes the composition unit-testable against a fixture of what Terraform actually produced, which
// is the only evidence that taking ownership is safe (§6 step 5).
//
// WHY THE DIVISION IS THREE-WAY AND NOT TWO. It would be simpler to say "archie derives what it can
// and everything else is a parameter", and it would be wrong. A value like
// AGENTCORE_MAX_CONCURRENT_PROVISIONS is not a preference — it is a MEASUREMENT of an undocumented
// EFS rate limit, and putting it in a tfvar invites someone to raise it without repeating the
// measurement. A value like DEPLOYMENT_ENVIRONMENT genuinely differs per account and Terraform's
// validation earns its keep. A value like AGENT_CONFIG_TABLE is neither: it is `${name}-agent-config`
// and always was. Three different kinds of thing, three different homes.
//
// WHAT IS DELIBERATELY ABSENT, all verified to have zero readers in the current image (dispatcher.tf
// carries the same list, and it must stay in step):
//   AGENT_URLS, ECS_CLUSTER_NAME, ECS_AGENT_PREFIX  — the OpenClaw per-agent gateway model
//   GH_CONFIG_REPO, GH_CONFIG_REF, CONFIG_SOURCE    — config moved to DynamoDB
//   ARTIFACTS_S3_BUCKET                             — only consumers were file-publish-plugin and
//                                                     admin-server.js, neither shipped
//   NODE_TLS_REJECT_UNAUTHORIZED                    — existed for the self-signed ALB certificate
//   SLACK_ROUTES                                    — dropped (§4.5); an empty escape hatch
//   CRON_ENABLED                                    — cut pending a per-agent flag (§4.6)

const { CliError } = require('./exit');

// ── §4.2 constants of the architecture ───────────────────────────────────────────────────────────
//
// Each entry keeps the reason it is a constant. The comment is the point, not the value: these are
// the ones where a future reader's instinct will be "surely this should be configurable", and the
// answer is written down next to it.

const CONSTANTS = {
  // Where the data already IS. archie is the successor to the OpenClaw gateway and serves the same
  // agents from the same directories, so it inherits every workspace, session and memory file. The
  // name is legacy branding; renaming it would orphan ~270 GB in prod. Changing this does not move
  // data, it makes every agent boot into an empty workspace while its history looks deleted.
  AGENTCORE_EFS_ROOT_PREFIX: '/openclaw-data',

  // The mount path every runtime spec assumes.
  AGENTCORE_EFS_MOUNT_PATH: '/mnt/efs',

  // AgentCore places VPC-mode runtime ENIs only in these ZONE IDS. Zone NAMES are per-account
  // aliases for physical zones — us-east-1a is use1-az4 in dev (supported) and use1-az6 in the
  // sandbox (not) — so any reasoning done in names is wrong in at least one account. This is a
  // property of the AWS service, not of an environment.
  AGENTCORE_SUPPORTED_AZ_IDS: 'use1-az1,use1-az2,use1-az4',

  // A MEASUREMENT, not a preference. EFS CreateAccessPoint has an undocumented concurrency rate
  // limit — measured clean at 40 concurrent, 26-of-60 at 60, 0-of-100 once drained. It does not
  // appear in Service Quotas. Raising this without repeating that measurement produces provisioning
  // failures that look like AgentCore problems.
  AGENTCORE_MAX_CONCURRENT_PROVISIONS: '5',

  // Concurrency ceiling on InvokeAgentRuntime. No environment differs.
  AGENTCORE_MAX_CONCURRENT_INVOKES: '25',

  // Queue tuning. These were ONE number until the poller hand-off: a poller held its slot across a
  // 30-45s provision, so a single value capped in-flight messages AND concurrent provisions AND
  // concurrent invokes — three things that want ~100 / ~5 / ~25. Splitting them is what stops a cold
  // turn starving warm ones.
  TURN_QUEUE_POLLERS: '10',
  MAX_INFLIGHT_TURNS: '100',

  // Already hard-coded in Terraform; no variable ever existed for it.
  AGENTCORE_OTEL_MODE: 'xray',

  // Image layout, not configuration. Tracing is opt-in via a Node require hook — without this the
  // dispatcher emits no spans at all, and it was hand-added to the live OpenClaw task definition,
  // which is exactly how it gets lost.
  NODE_OPTIONS: '--require /app/tracing.js',
  OTEL_SUPPRESS_INVOKE_AUTOSPAN: '1',
};

// The container port. Separate from CONSTANTS because it is a number that appears in four places —
// the env var, the port mapping, the healthcheck command and DISPATCHER_BASE_URL — and they must
// agree. The only inbound caller is the agent's cron tool over Cloud Map.
const PORT = 9090;

// Fargate sizing. Not in §4.3's SSM set: no environment has ever differed, and a task definition
// that is too small fails visibly and immediately rather than subtly.
const CPU = '1024';
const MEMORY = '2048';

// ── §4.3 per-deployment values, read from SSM ────────────────────────────────────────────────────
//
// `required: true` means a missing parameter is a hard failure. The optional ones reproduce
// Terraform's conditional env vars exactly: absent parameter, absent environment variable — which is
// also the only representation available, since SSM cannot hold an empty String.

const SSM_PARAMETERS = [
  { key: 'DEPLOYMENT_ENVIRONMENT', required: true },
  { key: 'AGENTCORE_RUNTIME_TLS_REJECT', required: true },
  { key: 'AGENTCORE_READERS_ACCOUNT', required: false },
  { key: 'DATADOG_API_KEY_SECRET', required: false },
  { key: 'DATADOG_APP_KEY_SECRET', required: false },
  { key: 'CONNECTOR_ORG_API_KEY_SECRET', required: false },
  { key: 'METRICS_TABLE_NAME', required: false },
];

// ── §4.3, second category: handles to Terraform resources with no name to look them up by ────────
//
// These are NOT environment variables and are deliberately not in SSM_PARAMETERS — they are inputs
// to DISCOVERY (lib/deployment-facts.js), read from the same parameter path. Composition never
// promotes them to the container's environment; the value derived from EFS_FILE_SYSTEM_ARN reaches
// it as AGENTCORE_EFS_FS_ID, and the access point id reaches only the volume definition.
//
// Everything else archie needs is resolved BY NAME, because Terraform names it from `--name`: roles,
// security groups, queues, repositories, Cloud Map. These two cannot be, and the reason differs for
// each — see the block comment in modules/archie/ssm.tf. Both are REQUIRED: a deployment with no
// file system is not a deployment with a default file system.
const SSM_HANDLES = [
  { key: 'EFS_FILE_SYSTEM_ARN', required: true },
  { key: 'DISPATCHER_ACCESS_POINT_ID', required: true },
];

/**
 * The parameter path — a CONSTANT, not derived from `--name`, matching modules/archie/ssm.tf.
 *
 * Every other resource this CLI touches is name-prefixed, and this one deliberately is not.
 * `var.name` exists to namespace archie against the OpenClaw stack sharing the account, and its own
 * declaration states the invariant: one archie stack per AWS account. A `<name>` segment here could
 * therefore only ever take one value.
 *
 * The one-knob rule (context.js:12-16) does not argue for keeping it either. That rule exists
 * because a wrong name does not ERROR — the OpenClaw namespaces and log group are real and
 * populated, so it renders another system's fleet as if it were yours. Nothing else writes under
 * `/archie/gateway`, so there is no other system for a wrong value to resolve to.
 */
const SSM_PREFIX = '/archie/gateway';

// ── composition ──────────────────────────────────────────────────────────────────────────────────

/**
 * The dispatcher's environment, as ECS wants it: [{ name, value }], sorted by name.
 *
 * SORTED DELIBERATELY. ECS preserves the order it is given and reports it back, so an unsorted list
 * makes the §6 diff noisy with pure reorderings — and a diff nobody reads is not a gate. Terraform's
 * own list is in authoring order, so the comparison in `diffEnvironment` is by KEY, never by index.
 *
 * @param resources  ctx.resources (lib/context.js) — every name from one knob
 * @param region     ctx.region, never defaulted
 * @param facts      discovered AWS facts (lib/deployment-facts.js)
 * @param ssm        { KEY: value } read from SSM; absent keys are absent env vars
 */
function composeEnvironment({ resources, region, facts, ssm }) {
  if (!region) throw new CliError('composeEnvironment needs a region');
  requireFacts(facts, [
    'account', 'agentRepoUri', 'turnQueueUrl', 'efsFileSystemId', 'vpcId',
    'runtimeSecurityGroupId', 'basePolicyArn',
  ]);

  const env = {
    ...CONSTANTS,

    PORT: String(PORT),

    // ── derived from --name (§4.1) ──────────────────────────────────────────
    AGENT_CONFIG_TABLE: resources.configTable,
    DISPATCHER_LOG_GROUP: resources.dispatcherLogGroup,
    DISPATCHER_SERVICE_NAME: resources.dispatcherService,
    DISPATCHER_METRIC_NAMESPACE: resources.dispatcherNamespace,
    CRON_METRIC_NAMESPACE: resources.cronNamespace,
    DISPATCHER_SHARED_SECRET_ID: resources.dispatcherSharedSecret,

    // A pure function of the knob and the port, which is why it is NOT an SSM parameter: a
    // parameter would add a resource, a read, an IAM grant and a failure mode to reproduce a string
    // this line already computes. Plain HTTP over Cloud Map — that also keeps the gateway out of the
    // runtime's TLS allow-list, because there is no certificate to relax verification for.
    DISPATCHER_BASE_URL: dispatcherBaseUrl(resources.name),

    // ── region, in the four places that need it saying so ───────────────────
    // metrics.js builds its DynamoDB client with NO region and inherits the task's, so AWS_REGION is
    // set explicitly rather than left to the task's ambient value: the write cannot then silently
    // target the wrong region if the task is ever moved.
    AWS_REGION: region,
    AGENTCORE_REGION: region,
    DISPATCHER_SHARED_SECRET_REGION: region,

    // ── discovered (§4.1) ───────────────────────────────────────────────────
    // THE BLOCKING DEFECT THIS BLOCK EXISTS TO FIX. agentcore-client.js resolves each of these with
    // a fallback, and every fallback is a literal from a sandbox (account 203366135563,
    // vpc-REDACTED, sg-REDACTED, fs-REDACTED, agent-4ggvzl-*). A
    // dispatcher started without them provisions runtimes onto ANOTHER STACK's file system and
    // security group, reads its secrets, and its generation GC can delete that stack's runtimes.
    // "Unset" does not mean "unopinionated" here; it means "pointed at account 052 by default".
    AGENTCORE_ACCOUNT: facts.account,
    AGENTCORE_BASE_POLICY_ARN: facts.basePolicyArn,
    AGENTCORE_IMAGE_REPO_URI: facts.agentRepoUri,
    AGENTCORE_EFS_FS_ID: facts.efsFileSystemId,
    AGENTCORE_VPC_ID: facts.vpcId,
    AGENTCORE_SECURITY_GROUP_ID: facts.runtimeSecurityGroupId,
    TURN_QUEUE_URL: facts.turnQueueUrl,
  };

  // Connector's fallback key. Conditional on the secret EXISTING, mirroring Terraform's
  // `var.connector_api_key == "" ? [] : [...]` — the deployment either has one or does not.
  if (facts.credentialSecretName) {
    env.CONNECTOR_API_KEY_SECRET = facts.credentialSecretName;
    env.CONNECTOR_API_KEY_SECRET_REGION = region;
  }

  for (const { key, required } of SSM_PARAMETERS) {
    const value = ssm ? ssm[key] : undefined;
    if (value === undefined || value === null || value === '') {
      if (required) {
        throw new CliError(`${key} is not published at ${SSM_PREFIX}/${key}`, {
          detail: 'Terraform owns this value (modules/archie/ssm.tf). Run terraform apply for this '
            + 'deployment before deploying the gateway.',
        });
      }
      continue;
    }
    env[key] = String(value);
  }

  // The Datadog key region rides along with the names, the same way the Connector one does. Set from
  // either name being present, because a deployment with one and not the other is a misconfiguration
  // worth carrying forward visibly rather than silently dropping half of.
  if (env.DATADOG_API_KEY_SECRET || env.DATADOG_APP_KEY_SECRET) {
    env.DATADOG_KEY_SECRET_REGION = region;
  }

  return Object.keys(env).sort().map((name) => ({ name, value: env[name] }));
}

/** `http://dispatcher.<name>.internal:<port>` — service_discovery.tf:22,29 as a pure function. */
const dispatcherBaseUrl = (name) => `http://dispatcher.${name}.internal:${PORT}`;

/**
 * The full RegisterTaskDefinition input.
 *
 * Shape mirrors modules/archie/dispatcher.tf exactly, because the §6 gate compares this against what
 * Terraform actually registered — a field composed differently here is a difference that shows up as
 * a diff, which is the intended outcome, not a bug to paper over.
 */
function composeTaskDefinition({ resources, region, facts, ssm, image, tags }) {
  if (!image) throw new CliError('composeTaskDefinition needs an image');
  requireFacts(facts, ['executionRoleArn', 'taskRoleArn', 'dispatcherAccessPointId', 'efsFileSystemId']);

  const family = resources.dispatcherService;
  const volumeName = `${family}-data`;

  const td = {
    family,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: CPU,
    memory: MEMORY,
    executionRoleArn: facts.executionRoleArn,
    taskRoleArn: facts.taskRoleArn,

    volumes: [{
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: facts.efsFileSystemId,
        rootDirectory: '/',
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: facts.dispatcherAccessPointId, iam: 'ENABLED' },
      },
    }],

    containerDefinitions: [{
      name: 'dispatcher',
      image,
      essential: true,
      environment: composeEnvironment({ resources, region, facts, ssm }),
      secrets: facts.secrets || [],

      portMappings: [{ containerPort: PORT, protocol: 'tcp' }],

      // conversations.json and the EFS-backed cron store. Losing this mount loses every cron job;
      // cron-store.js is the sole writer and holds an authoritative in-memory cache, which is why it
      // has no mutex — and why desired_count must stay at 1.
      mountPoints: [{ sourceVolume: volumeName, containerPath: '/efs', readOnly: false }],

      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          // EMF metrics are extracted from these logs rather than published with PutMetricData, so
          // the log group is a metrics dependency, not just diagnostics.
          'awslogs-group': resources.dispatcherLogGroup,
          'awslogs-region': region,
          'awslogs-stream-prefix': 'ecs',
        },
      },

      healthCheck: {
        command: ['CMD-SHELL', healthCheckCommand()],
        interval: 30,
        timeout: 5,
        retries: 3,
        // 30s of grace. This is a large part of why the measured rollout gap is ~94 seconds rather
        // than the "a few seconds" the Terraform comment used to claim.
        startPeriod: 30,
      },
    }],
  };

  if (tags && tags.length) td.tags = tags;
  return td;
}

/** Kept as one expression so the port cannot disagree with the port mapping. */
const healthCheckCommand = () => `node -e "require('http').get('http://localhost:${PORT}/health',`
  + 'r=>process.exit(r.statusCode===200?0:1)).on(\'error\',()=>process.exit(1))"';

/** A fact that was not discovered is a bug in discovery, not something to compose around. */
function requireFacts(facts, keys) {
  const missing = keys.filter((k) => !facts || facts[k] === undefined || facts[k] === null || facts[k] === '');
  if (missing.length) {
    throw new CliError(`task-definition composition is missing discovered facts: ${missing.join(', ')}`, {
      detail: 'lib/deployment-facts.js resolves these; a missing one means discovery failed silently.',
    });
  }
}

module.exports = {
  CONSTANTS, SSM_PARAMETERS, SSM_HANDLES, PORT, CPU, MEMORY,
  SSM_PREFIX, dispatcherBaseUrl, healthCheckCommand,
  composeEnvironment, composeTaskDefinition,
};

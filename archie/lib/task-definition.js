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
// agree. The inbound callers are the agent's cron tool and the cron hydrator, both via the NLB.
const PORT = 9090;

// The container's name inside the task definition. Shared because `archie deploy`'s CreateService
// must name it in its `loadBalancers` entry, and a mismatch there is rejected by ECS as a container
// that is not in the definition — a confusing error a long way from its cause.
const CONTAINER_NAME = 'dispatcher';

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
  // Hindsight. Optional by design: absent parameter → absent env var → BASE_PLUGINS emits no
  // hindsight entry and no `slots.memory` at all, which is the documented off state. Setting an
  // empty string would NOT be equivalent in SSM (it cannot hold one) and is not needed.
  { key: 'HINDSIGHT_API_URL', required: false },
  // NO HINDSIGHT_ORG_BANK_ID. It was here, published by modules/archie/ssm.tf and passed through to
  // the runtime spec, and it could only ever do one thing: point a deployment at a bank other than
  // the `default-org` one OpenClaw writes — an agent that has memory and recalls nothing, silently.
  // Removed 2026-09-08; the bank is a constant in config-resolver/boot-config.mjs.
];

// ── §4.3, second category: handles to Terraform resources with no name to look them up by ────────
//
// These are NOT environment variables and are deliberately not in SSM_PARAMETERS — they are inputs
// to DISCOVERY (lib/deployment-facts.js), read from the same parameter path. Composition never
// promotes them to the container's environment; the value derived from EFS_FILE_SYSTEM_ARN reaches
// it as AGENTCORE_EFS_FS_ID, and the access point id reaches only the volume definition.
//
// Everything else archie needs is resolved BY NAME, because Terraform names it from `--name`: roles,
// security groups, queues, repositories, the target group. These two cannot be, and the reason differs for
// each — see the block comment in modules/archie/ssm.tf. Both are REQUIRED: a deployment with no
// file system is not a deployment with a default file system.
const SSM_HANDLES = [
  { key: 'EFS_FILE_SYSTEM_ARN', required: true },
  { key: 'DISPATCHER_ACCESS_POINT_ID', required: true },
  // The hydrator's PARENT access point, rooted at <prefix>/agents. Optional, and deliberately so:
  // it is a cutover tool with a finite life, and a deployment that has finished migrating should be
  // able to drop it without the gateway refusing to deploy. `cron hydrate` enforces it for itself,
  // where the error can say what it is for.
  { key: 'CRON_HYDRATOR_ACCESS_POINT_ID', required: false },
  // Connector ADOPTION inputs for `archie config hydrate`, which records where each agent's Connector
  // project ALREADY is rather than creating one. Here rather than in SSM_PARAMETERS for the reason
  // stated above: they are inputs to a CLI, not container environment. Putting them in SSM_PARAMETERS
  // would promote them into the dispatcher's env, which re-fingerprints the task definition — and the
  // dispatcher has no use for them.
  //
  // Both optional, and their absence is the OFF state: an environment with no OpenClaw stack has no
  // cluster to discover keys in and no shared key, so hydrate skips adoption and says so. Neither may
  // be guessed — a wrong cluster finds no task definition, which reads as "this agent has no key", and
  // the next turn mints a NEW project, orphaning every OAuth connection the human authorised.
  { key: 'CONNECTOR_ADOPT_CLUSTER', required: false },
  { key: 'CONNECTOR_ADOPT_SHARED_SECRET', required: false },
];

// ── §4.3, third category: SERVICE settings ───────────────────────────────────────────────────────
//
// archie owns the ECS service too — `aws_ecs_service.task_definition` is a required argument, so
// Terraform could not keep the service without keeping a task definition, and the two cannot be
// split. Almost everything about the service is a constant this file hard-codes (see SERVICE below)
// or is discovered (subnets, security group, service registry). This is what is left.
//
// Also not an environment variable, so also not in SSM_PARAMETERS.
const SSM_SERVICE = [
  { key: 'ENABLE_EXECUTE_COMMAND', required: false },
];

// The service's fixed shape. Each of these is load-bearing, not a default nobody thought about:
//
//   desiredCount 1              — two tasks would open two Slack Socket Mode connections, and Slack
//                                 load-balances events across connections for the same app, so events
//                                 would be handled non-deterministically and sometimes twice. It
//                                 would also break the cron store's sole-writer invariant (no mutex)
//                                 and per-session turn serialisation.
//   minimumHealthyPercent 100   — ROLLING, matching the OpenClaw dispatcher, which reaches the same
//   maximumPercent 200            values by omitting them and inheriting the ECS defaults
//                                 (modules/clawdbot/dispatcher.tf:287-313). See ROLLING below for why
//                                 this is a PREPROD setting with a cutover condition attached.
//   assignPublicIp false        — egress is via NAT; the task has no business being reachable.

// The two shapes, NAMED, so that switching between them is one word in one place and nothing has to
// remember which pair of numbers means which behaviour. `gateway deploy` selects from this map for both
// the values it sends and the wait it runs, so the two cannot describe different rollouts.
const DEPLOYMENT_SHAPES = {
  rolling: { minimumHealthyPercent: 100, maximumPercent: 200 },
  'stop-then-start': { minimumHealthyPercent: 0, maximumPercent: 100 },
};

const SERVICE = {
  desiredCount: 1,
  deploymentConfiguration: DEPLOYMENT_SHAPES.rolling,   // ← the one word. See ROLLING below.
  launchType: 'FARGATE',
  assignPublicIp: 'DISABLED',
};

// ── ROLLING vs STOP-THEN-START, and why this is a preprod setting ────────────────────────────────
//
// This was `{ minimumHealthyPercent: 0, maximumPercent: 100 }` — stop-then-start, a measured ~94s of
// dropped Slack events on every gateway release (§6.1). The gap was chosen over the alternative
// deliberately: a rolling deployment runs two tasks for the length of the overlap, and two tasks is
// exactly the double-Socket-Mode problem in `desiredCount` above.
//
// It is now rolling because during verification archie points at ITS OWN Slack app, not the one the
// OpenClaw dispatcher holds. That does NOT remove the hazard — the overlap is between archie's two
// tasks on whichever app archie is pointed at, so a fresh app does not make two connections safe. It
// makes the consequences CHEAP: duplicated or non-deterministically routed events land in a test
// workspace, and the sole-writer window is over a test cron store. Paying 94 seconds of blindness on
// every iteration of a verification loop costs more than that.
//
// THE CUTOVER CONDITION, stated here because this is the line someone will read: before this gateway
// holds the PRODUCTION Slack app, `SERVICE.deploymentConfiguration` goes back to
// `DEPLOYMENT_SHAPES['stop-then-start']` — or the receipt/processing split in §6.1 lands first, which
// is the only way to get both. In prod the overlap is duplicate handling of real internal traffic and a
// cron store with two writers; there, dropping events is the cheaper failure.
//
// WHY BOTH VALUES ARE STATED RATHER THAN OMITTED. Terraform gets the ECS defaults by leaving the
// argument out at create time. That does not work here for the service that ALREADY EXISTS with 0/100
// stored on it: `UpdateService` has no way to express "unset", so the only way to converge a live
// service is to send the values explicitly (`cmd/gateway.js`'s roll does). Omitting them would leave
// the sandbox service on stop-then-start forever while this file claimed otherwise.
const ROLLING = SERVICE.deploymentConfiguration.minimumHealthyPercent > 0;

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

    // Plain HTTP to the internal load balancer, which keeps the gateway out of the runtime's TLS
    // allow-list: there is no certificate to relax verification for. Still not an SSM parameter —
    // the hostname arrives on `facts` from one elbv2 lookup the deploy already makes for the target
    // group, so a parameter would add a resource, a read and an IAM grant for nothing.
    DISPATCHER_BASE_URL: dispatcherBaseUrl(facts),

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

/**
 * `http://<nlb-hostname>:<port>` — the internal load balancer (dispatcher_lb.tf) as a pure function
 * of the discovered hostname and PORT.
 *
 * The hostname is DISCOVERED, not derived. This used to be `dispatcher.<name>.internal`, a pure
 * function of the --name knob, because Cloud Map let us choose the name. A Cloud Map private DNS
 * namespace cannot exist in a shared VPC (dispatcher_lb.tf), and the load balancer that replaced it
 * has an AWS-generated hostname — so it has to come off `facts`.
 */
const dispatcherBaseUrl = (facts) => `http://${facts.dispatcherDnsName}:${PORT}`;

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
      name: CONTAINER_NAME,
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

/**
 * The EPHEMERAL cron-hydrator task definition (GATEWAY-OWNERSHIP-PLAN.md §8).
 *
 * Registered on demand by `archie cron hydrate`, run once, deregistered. It used to be a standing
 * Terraform resource; it is not, for three reasons in order of weight:
 *
 *   1. It is a CUTOVER TOOL with a finite life. When every agent is over it has no job, and a
 *      standing resource for a one-off is how migration scaffolding outlives the migration.
 *   2. IT HOLDS A PRIVILEGE THE GATEWAY REFUSES. Its access point is the PARENT <prefix>/agents, so
 *      one task can read every agent's subtree. The always-on gateway never holds that mount — it
 *      gets a narrow one — precisely so a compromised gateway cannot walk the fleet's workspaces.
 *      Hydration legitimately needs the breadth and should hold it for the life of ONE TASK.
 *   3. It calls the gateway's manager API, so it must run the same build as the gateway it talks to.
 *      Composing it here makes that automatic — the image is read from the RUNNING task definition,
 *      not from a tag someone remembered to bump.
 *
 * NO TASK ROLE, and `iam: DISABLED` ON THE MOUNT — the two are the same decision. It makes no AWS API
 * calls: it reads EFS through the access point and POSTs to the manager API. It borrows the
 * dispatcher's EXECUTION role, which is what pulls the image and resolves the shared secret.
 *
 * `iam: ENABLED` HERE IS AN ERROR, not a hardening. ECS refuses outright — "EFS IAM authorization
 * requires a task role" — found live 2026-08-16 by copying the dispatcher's volume shape, which does
 * have a task role. Satisfying it would mean giving a fleet-wide-read task an AWS identity purely to
 * authorise a mount it can already reach, which is the opposite of the point.
 *
 * HARDENED BEYOND THE MOUNT, carried over from the Terraform definition this replaces: unprivileged
 * user, read-only root filesystem, all capabilities dropped, no privilege escalation. A task that
 * reads files and makes one HTTP call has no reason to hold anything more — and this one reads EVERY
 * agent's subtree, so it is the task where that matters most.
 */
function composeCronHydratorTaskDefinition({
  resources, region, facts, image, agentId, ownerAgentId, parentAccessPointId, mountPath = '/mnt/agents',
}) {
  requireFacts(facts, ['executionRoleArn', 'efsFileSystemId', 'dispatcherSharedSecretArn']);
  if (!image) throw new CliError('composeCronHydratorTaskDefinition needs an image');
  if (!agentId) throw new CliError('composeCronHydratorTaskDefinition needs an agentId');
  if (!parentAccessPointId) {
    throw new CliError(`${SSM_PREFIX}/CRON_HYDRATOR_ACCESS_POINT_ID is not published`, {
      detail: 'Terraform owns the fleet-wide-read access point at <prefix>/agents and publishes its '
        + 'id (modules/archie/cron_hydrator.tf, ssm.tf). Hydration cannot read the agents tree '
        + 'without it.',
    });
  }

  const volumeName = 'agents-ro';
  return {
    family: `${resources.dispatcherService}-cron-hydrator`,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    // Smaller than the gateway: it reads a handful of JSON files and makes HTTP calls.
    cpu: '256',
    memory: '512',
    executionRoleArn: facts.executionRoleArn,

    volumes: [{
      name: volumeName,
      efsVolumeConfiguration: {
        fileSystemId: facts.efsFileSystemId,
        rootDirectory: '/',
        transitEncryption: 'ENABLED',
        authorizationConfig: { accessPointId: parentAccessPointId, iam: 'DISABLED' },
      },
    }],

    containerDefinitions: [{
      name: 'cron-hydrator',
      image,
      essential: true,
      user: '1000:1000',
      readonlyRootFilesystem: true,
      linuxParameters: { capabilities: { add: [], drop: ['ALL'] }, noNewPrivileges: true },
      // The script ships inside the gateway image; this is the same artifact with a different entry.
      entryPoint: ['node'],
      command: ['cron-hydrator.js'],
      workingDirectory: '/app',
      environment: [
        { name: 'HYDRATE_AGENT', value: agentId },
        // The §8.10 identity the jobs are STORED under. HYDRATE_AGENT stays the legacy name because
        // it names the EFS directory; without this the two are conflated and jobs land under an
        // identity no Slack event routes to.
        { name: 'HYDRATE_OWNER_AGENT', value: ownerAgentId || agentId },
        { name: 'MOUNT_PATH', value: mountPath },
        { name: 'MANAGER_API_URL', value: dispatcherBaseUrl(facts) },
        { name: 'AWS_REGION', value: region },
      ],
      secrets: [{ name: 'DISPATCHER_SHARED_SECRET', valueFrom: facts.dispatcherSharedSecretArn }],
      mountPoints: [{ sourceVolume: volumeName, containerPath: mountPath, readOnly: true }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          // The gateway's log group, with its own stream prefix. Terraform owns log groups, and a
          // task that created one would be creating infrastructure; sharing keeps a hydration run
          // next to the gateway turns it produced, which is where you look when comparing them.
          'awslogs-group': resources.dispatcherLogGroup,
          'awslogs-region': region,
          'awslogs-stream-prefix': 'cron-hydrator',
        },
      },
    }],
  };
}

/**
 * The teardown counterpart: purge one scope's jobs from the dispatcher cron store (§E2).
 *
 * SAME IMAGE, DELIBERATELY LESS PRIVILEGE. It is the gateway's own build for the same reason the
 * hydrator is — it speaks the manager API, so it must match the API's version — but it drops the EFS
 * volume and mount entirely. A purge reads no jobs.json, so handing it the fleet-wide-read access
 * point would grant "can read every agent's workspace" to an operation that needs "can call one HTTP
 * endpoint". That is also why this does not just call the hydrator composer with a flag: the absence
 * of the mount is the security property, and it should be impossible to pass the wrong argument and
 * get it back.
 *
 * Keyed on ownerAgentId (the ScopeId) with NO legacy name anywhere: the store is keyed by owner, and
 * a purge by legacy name deletes nothing while reporting success.
 */
function composeCronPurgeTaskDefinition({
  resources, region, facts, image, ownerAgentId,
}) {
  requireFacts(facts, ['executionRoleArn', 'dispatcherSharedSecretArn']);
  if (!image) throw new CliError('composeCronPurgeTaskDefinition needs an image');
  if (!ownerAgentId) throw new CliError('composeCronPurgeTaskDefinition needs an ownerAgentId (the scope id)');

  return {
    family: `${resources.dispatcherService}-cron-purge`,
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    cpu: '256',
    memory: '512',
    executionRoleArn: facts.executionRoleArn,

    containerDefinitions: [{
      name: 'cron-purge',
      image,
      essential: true,
      user: '1000:1000',
      readonlyRootFilesystem: true,
      linuxParameters: { capabilities: { add: [], drop: ['ALL'] }, noNewPrivileges: true },
      entryPoint: ['node'],
      command: ['cron-hydrator.js'],
      workingDirectory: '/app',
      environment: [
        { name: 'CRON_PURGE_ONLY', value: '1' },
        { name: 'HYDRATE_OWNER_AGENT', value: ownerAgentId },
        { name: 'MANAGER_API_URL', value: dispatcherBaseUrl(facts) },
        { name: 'AWS_REGION', value: region },
      ],
      secrets: [{ name: 'DISPATCHER_SHARED_SECRET', valueFrom: facts.dispatcherSharedSecretArn }],
      logConfiguration: {
        logDriver: 'awslogs',
        options: {
          'awslogs-group': resources.dispatcherLogGroup,
          'awslogs-region': region,
          'awslogs-stream-prefix': 'cron-purge',
        },
      },
    }],
  };
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
  CONSTANTS, SSM_PARAMETERS, SSM_HANDLES, SSM_SERVICE, SERVICE, ROLLING, DEPLOYMENT_SHAPES,
  PORT, CONTAINER_NAME, CPU, MEMORY,
  SSM_PREFIX, dispatcherBaseUrl, healthCheckCommand,
  composeEnvironment, composeTaskDefinition, composeCronHydratorTaskDefinition,
  composeCronPurgeTaskDefinition,
};

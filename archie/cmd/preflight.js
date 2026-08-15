'use strict';

// `archie preflight` — RUNTIME-CLI-REFERENCE.md §2.1, and the 20-check table in §4 which IS the
// requirement. Every row there names a resource, the API call that proves it, and what breaks when
// it is absent; this file is that table as code, in that order, with those numbers.
//
// FOUR RULES THIS FILE EXISTS TO KEEP:
//
// 1. IT NEVER CREATES ANYTHING, in any mode. Terraform owns the estate (plan §5); preflight only
//    reports. "Half-preparing an account is worse than failing against an unprepared one" — a
//    missing resource is named and exits 3. Check 14 is `DescribeSecret` and never
//    `GetSecretValue`: the CLI verifies a secret exists, it never reads one.
//
// 2. A SKIPPED CHECK IS NEVER A PASS. `--skip 10` prints SKIPPED, and so does a check whose inputs
//    could not be read — "a check that cannot RUN is not a check that passed"
//    (agentcore-observability/deploy-dashboard.cjs:155-157). A check that could not run because the
//    CLI itself is missing a dependency or a permission reports ERROR and counts as a failure,
//    because the alternative is exiting 0 on an account nobody actually checked.
//
// 3. EVERY NAME COMES FROM ONE KNOB. Resource names are read from `ctx.resources` (context.js:33-45)
//    and never re-derived here. The handful of names that are NOT in `ctx.resources` — the runtime
//    security group, the agentcore-base policy, the secrets, the turn queues, the cron hydrator task
//    definition — are composed from `ctx.resources.name` / `.dispatcherService`, which is the same
//    knob Terraform composes them from (security_groups.tf:30, agentcore_base.tf:19, secrets.tf,
//    turn_queue.tf:4,13, cron_hydrator.tf:48).
//
// 4. FACTS ABOUT THE DEPLOYMENT COME FROM THE DEPLOYED TASK DEFINITION, NOT THIS SHELL. The EFS
//    filesystem id, the VPC, the supported AZ ids and the secret names are all dispatcher env vars
//    (dispatcher.tf:76-110). Reading them from the running task definition is the same decision
//    spec-baseline.mjs:16-17 made: "a local env would silently derive a different answer". Where the
//    filesystem itself is a better authority than the env — the VPC — the filesystem wins, because
//    EFS allows exactly one VPC per filesystem and the env is the thing that goes stale
//    (agentcore-fixture.js:53-58).
//
// Checks 1-2 are exported as `assertBaseline` because every mutating command in the CLI runs them
// (reference §4, "Runs automatically before"). They are a library first and a command second.

const { usage, preflight: preflightError } = require('../lib/exit');

// The dispatcher's own pointer reader, not a copy of it. It encodes the fail-closed rule that a
// missing item, a wrong type and an empty string are all ABSENT (image-source.js:33-42) — preflight
// must agree with the code that actually runs, or check 4 passes on a pointer no turn can use.
const { readImageItem } = require('../../slack-dispatcher/image-source');

const PASS = 'PASS';
const WARN = 'WARN';
const FAIL = 'FAIL';
const SKIPPED = 'SKIPPED';
// The check itself could not run: a missing local dependency, or a permission the caller lacks.
// Distinct from FAIL (the resource is absent) because the fix is completely different, and distinct
// from SKIPPED because nobody asked for it to be skipped.
const ERROR = 'ERROR';

const FAILING = new Set([FAIL, ERROR]);

// AgentCore places VPC-mode runtime ENIs only in these zone IDS. Zone NAMES are per-account aliases
// for physical zones — us-east-1a is use1-az4 in dev (supported) and use1-az6 in prod (not) — so any
// reasoning done in names is wrong in at least one account (az_coverage.tf:8-19). Overridden by the
// deployed AGENTCORE_SUPPORTED_AZ_IDS when present; this is the module default
// (modules/archie/variables.tf:84-88), and it is a property of the AWS service, not of an
// environment.
const SUPPORTED_AZ_IDS = ['use1-az1', 'use1-az2', 'use1-az4'];

// every agent in the fleet x 1 runtime = 208 CreateAgentRuntime per generation (plan §8). The account cap is the
// fallback only: the real number is asked for at Service Quotas first.
const RUNTIME_QUOTA_FALLBACK = 1000;
const RUNTIME_QUOTA_WARN_FRACTION = 0.75;

// pi-adapter.mjs:126. Check 18 is a real `converse`, so it must name the model the fleet actually
// runs — a model access grant is per-model, and proving access to a model nobody invokes proves
// nothing (README.md:68-71 records a live AccessDeniedException on exactly this).
const DEFAULT_MODEL_ID = 'global.anthropic.claude-sonnet-4-6';

// An AWS error that means "you may not look", not "it is not there". These have to read as ERROR:
// a preflight that cannot see a resource has not proved the resource is missing.
const ACCESS_ERRORS = /AccessDenied|UnauthorizedOperation|ExpiredToken|InvalidClientTokenId|Forbidden/;

/** Errors that mean the check could not run at all. Raised by need(), surfaced as ERROR. */
function unrunnable(message, detail) {
  const e = new Error(message);
  e.unrunnable = true;
  e.detail = detail || null;
  return e;
}

/**
 * Require a package that is NOT in archie/package.json.
 *
 * `n/no-missing-require` and `n/no-extraneous-require` are errors in this tree and they are right —
 * a literal require of an undeclared package is precisely the @aws-sdk/client-secrets-manager bug
 * (eslint.config.mjs:26-31). Three checks need clients that are genuinely absent from the manifest
 * (ec2 for 13, xray for 17, bedrock-runtime for 18) and task W1-A does not own package.json, so the
 * require goes through a variable and the absence is REPORTED, by package name, as a check that
 * could not run. It is not silently swallowed and it is not a pass.
 */
function need(id) {
  let mod = null;
  try {
    mod = require(id);
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    mod = null;
  }
  if (!mod) {
    throw unrunnable(`${id} is not installed`,
      `add "${id}" to archie/package.json dependencies and re-run npm install`);
  }
  return mod;
}

/**
 * The node credential chain factory, whichever name this SDK build gives it.
 *
 * FOUND LIVE, first real run against the sandbox: `fromNodeProviderChain` is the current name, but
 * the copy hoisted into archie/node_modules today exports only `defaultProvider`, so
 * `fromNodeProviderChain({profile})` was `undefined is not a function` and EVERY check failed with
 * a TypeError that said nothing about credentials. Both take `{ profile }` and both walk the same
 * chain, so accept either rather than pinning the CLI to one SDK minor.
 */
function credentialProviderFrom(mod) {
  const chain = mod.fromNodeProviderChain || mod.defaultProvider;
  if (typeof chain !== 'function') {
    throw unrunnable('@aws-sdk/credential-provider-node exports no credential chain factory',
      `expected fromNodeProviderChain or defaultProvider, got: ${Object.keys(mod).join(', ') || 'nothing'}`);
  }
  return chain;
}

// ── the AWS adapter ──────────────────────────────────────────────────────────────────────────────
//
// One narrow async function per API call the table names, so the checks read as the table reads and
// so the tests can inject a plain object with no SDK, no credentials and no network. Clients are
// built lazily: `archie preflight --checks 1` should not construct twelve SDK clients.

function createAws(ctx) {
  const cache = new Map();

  const config = () => {
    // The region is ALWAYS ctx.region, never the profile's: `[profile sandbox]` is us-east-2 while
    // archie runs in us-east-1 (context.js:7-10). The profile supplies credentials and nothing else.
    const cfg = { region: ctx.region };
    if (ctx.profile) {
      // Through need() for the same reason as the three clients below: it resolves today only
      // because the SDK clients hoist it, and it is in NO package.json section — the exact shape of
      // the @aws-sdk/client-secrets-manager bug (eslint.config.mjs:26-31). --profile is unusable
      // without it, so an absence must name the package rather than throw MODULE_NOT_FOUND.
      cfg.credentials = credentialProviderFrom(need('@aws-sdk/credential-provider-node'))({ profile: ctx.profile });
    }
    return cfg;
  };

  const MAKERS = {
    sts: (cfg) => new (require('@aws-sdk/client-sts').STSClient)(cfg),
    ddb: (cfg) => require('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient
      .from(new (require('@aws-sdk/client-dynamodb').DynamoDBClient)(cfg)),
    dynamodb: (cfg) => new (require('@aws-sdk/client-dynamodb').DynamoDBClient)(cfg),
    ecr: (cfg) => new (require('@aws-sdk/client-ecr').ECRClient)(cfg),
    ecs: (cfg) => new (require('@aws-sdk/client-ecs').ECSClient)(cfg),
    efs: (cfg) => new (require('@aws-sdk/client-efs').EFSClient)(cfg),
    iam: (cfg) => new (require('@aws-sdk/client-iam').IAMClient)(cfg),
    secrets: (cfg) => new (require('@aws-sdk/client-secrets-manager').SecretsManagerClient)(cfg),
    sqs: (cfg) => new (require('@aws-sdk/client-sqs').SQSClient)(cfg),
    quotas: (cfg) => new (require('@aws-sdk/client-service-quotas').ServiceQuotasClient)(cfg),
    agentcore: (cfg) => new (require('@aws-sdk/client-bedrock-agentcore-control')
      .BedrockAgentCoreControlClient)(cfg),
    // Undeclared — see need(). Constructed through the same lazy path so the failure surfaces on the
    // ONE check that needs it rather than at CLI start.
    ec2: (cfg) => new (need('@aws-sdk/client-ec2').EC2Client)(cfg),
    xray: (cfg) => new (need('@aws-sdk/client-xray').XRayClient)(cfg),
    bedrock: (cfg) => new (need('@aws-sdk/client-bedrock-runtime').BedrockRuntimeClient)(cfg),
  };

  const use = (key) => {
    if (!cache.has(key)) cache.set(key, MAKERS[key](config()));
    return cache.get(key);
  };

  return {
    async callerIdentity() {
      const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
      return use('sts').send(new GetCallerIdentityCommand({}));
    },

    async describeTable(name) {
      const { DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
      const r = await use('dynamodb').send(new DescribeTableCommand({ TableName: name }));
      return r.Table;
    },

    async getItem(table, key, { consistentRead = false } = {}) {
      const { GetCommand } = require('@aws-sdk/lib-dynamodb');
      const r = await use('ddb').send(new GetCommand({ TableName: table, Key: key, ConsistentRead: consistentRead }));
      return r.Item || null;
    },

    async describeRepositories(names) {
      const { DescribeRepositoriesCommand } = require('@aws-sdk/client-ecr');
      const r = await use('ecr').send(new DescribeRepositoriesCommand({ repositoryNames: names }));
      return r.repositories || [];
    },

    /**
     * Existence is the hard gate, architecture is best-effort — publish-image.mjs:50-96, whose
     * rationale is that "the dispatcher image is amd64 and built from the same tree, minutes apart",
     * i.e. the mistake this catches is publishing the WRONG image, not an exotic manifest.
     */
    async describeImage(repositoryName, imageTag) {
      const { DescribeImagesCommand, BatchGetImageCommand } = require('@aws-sdk/client-ecr');
      const ecr = use('ecr');
      const res = await ecr.send(new DescribeImagesCommand({ repositoryName, imageIds: [{ imageTag }] }));
      const detail = (res.imageDetails || [])[0];
      if (!detail) return null;
      const arches = new Set();
      try {
        const got = await ecr.send(new BatchGetImageCommand({
          repositoryName,
          imageIds: [{ imageTag }],
          acceptedMediaTypes: ['application/vnd.docker.distribution.manifest.list.v2+json',
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json'],
        }));
        const body = (got.images || [])[0] && got.images[0].imageManifest;
        for (const m of (body ? JSON.parse(body).manifests || [] : [])) {
          if (m.platform && m.platform.architecture && m.platform.architecture !== 'unknown') {
            arches.add(m.platform.architecture);
          }
        }
      } catch (e) {
        // Deliberately not fatal, and deliberately not silent: the caller reports "architecture
        // unknown" rather than claiming arm64 it never saw.
        detail.architectureError = String(e.message || e);
      }
      return { digest: detail.imageDigest, pushedAt: detail.imagePushedAt, arches: [...arches],
        architectureError: detail.architectureError || null };
    },

    async getPolicy(arn) {
      const { GetPolicyCommand } = require('@aws-sdk/client-iam');
      const r = await use('iam').send(new GetPolicyCommand({ PolicyArn: arn }));
      return r.Policy;
    },

    /** GetRole. Check 20: the ephemeral hydrator borrows this role, so its absence blocks hydration. */
    async getRole(roleName) {
      const { GetRoleCommand } = require('@aws-sdk/client-iam');
      const r = await use('iam').send(new GetRoleCommand({ RoleName: roleName }));
      return r.Role;
    },

    async simulatePrincipalPolicy(sourceArn, actions, resources) {
      const { SimulatePrincipalPolicyCommand } = require('@aws-sdk/client-iam');
      const r = await use('iam').send(new SimulatePrincipalPolicyCommand({
        PolicySourceArn: sourceArn, ActionNames: actions, ResourceArns: resources,
      }));
      return r.EvaluationResults || [];
    },

    async describeFileSystem(fileSystemId) {
      const { DescribeFileSystemsCommand } = require('@aws-sdk/client-efs');
      const r = await use('efs').send(new DescribeFileSystemsCommand({ FileSystemId: fileSystemId }));
      return (r.FileSystems || [])[0] || null;
    },

    async describeMountTargets(fileSystemId) {
      const { DescribeMountTargetsCommand } = require('@aws-sdk/client-efs');
      const r = await use('efs').send(new DescribeMountTargetsCommand({ FileSystemId: fileSystemId }));
      return r.MountTargets || [];
    },

    async describeAccessPoints(fileSystemId) {
      const { DescribeAccessPointsCommand } = require('@aws-sdk/client-efs');
      const efs = use('efs');
      const out = [];
      let token;
      do {
        const r = await efs.send(new DescribeAccessPointsCommand({ FileSystemId: fileSystemId, NextToken: token }));
        out.push(...(r.AccessPoints || []));
        token = r.NextToken;
      } while (token);
      return out;
    },

    /** BY NAME, within a VPC. Never by id — see check 13. */
    async describeSecurityGroupsByName(vpcId, groupName) {
      const { DescribeSecurityGroupsCommand } = need('@aws-sdk/client-ec2');
      const r = await use('ec2').send(new DescribeSecurityGroupsCommand({
        Filters: [{ Name: 'vpc-id', Values: [vpcId] }, { Name: 'group-name', Values: [groupName] }],
      }));
      return r.SecurityGroups || [];
    },

    async listAgentRuntimes() {
      const { ListAgentRuntimesCommand } = require('@aws-sdk/client-bedrock-agentcore-control');
      const client = use('agentcore');
      const out = [];
      let token;
      do {
        const r = await client.send(new ListAgentRuntimesCommand({ nextToken: token }));
        out.push(...(r.agentRuntimes || []));
        token = r.nextToken;
      } while (token);
      return out;
    },

    async serviceQuota(serviceCode, matcher) {
      const { ListServiceQuotasCommand } = require('@aws-sdk/client-service-quotas');
      const r = await use('quotas').send(new ListServiceQuotasCommand({ ServiceCode: serviceCode, MaxResults: 100 }));
      return (r.Quotas || []).find((q) => matcher.test(q.QuotaName || '')) || null;
    },

    /** DescribeSecret. Never GetSecretValue — reference §2.1 "Refuses to". */
    async describeSecret(secretId) {
      const { DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
      return use('secrets').send(new DescribeSecretCommand({ SecretId: secretId }));
    },

    async describeServices(cluster, service) {
      const { DescribeServicesCommand } = require('@aws-sdk/client-ecs');
      const r = await use('ecs').send(new DescribeServicesCommand({ cluster, services: [service] }));
      return { services: r.services || [], failures: r.failures || [] };
    },

    async describeTaskDefinition(taskDefinition) {
      const { DescribeTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
      const r = await use('ecs').send(new DescribeTaskDefinitionCommand({ taskDefinition }));
      return r.taskDefinition;
    },

    async traceSegmentDestination() {
      const { GetTraceSegmentDestinationCommand } = need('@aws-sdk/client-xray');
      return use('xray').send(new GetTraceSegmentDestinationCommand({}));
    },

    async converse(modelId) {
      const { ConverseCommand } = need('@aws-sdk/client-bedrock-runtime');
      return use('bedrock').send(new ConverseCommand({
        modelId,
        messages: [{ role: 'user', content: [{ text: 'ping' }] }],
        inferenceConfig: { maxTokens: 1 },
      }));
    },

    async queueUrl(queueName) {
      const { GetQueueUrlCommand } = require('@aws-sdk/client-sqs');
      const r = await use('sqs').send(new GetQueueUrlCommand({ QueueName: queueName }));
      return r.QueueUrl;
    },

    async queueAttributes(queueUrl) {
      const { GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');
      const r = await use('sqs').send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['All'] }));
      return r.Attributes || {};
    },
  };
}

// ── shared, lazily-read facts ────────────────────────────────────────────────────────────────────

const errName = (e) => (e && (e.name || e.Code || e.code)) || '';
// SQS says QueueDoesNotExist, IAM says NoSuchEntity, ECR says RepositoryNotFoundException, DDB says
// ResourceNotFoundException. Same fact, four spellings; the union is the check, not any one of them.
const isNotFound = (e) => /NotFound|NoSuchEntity|ResourceNotFoundException|QueueDoesNotExist/.test(errName(e));

/** Memoise a promise-returning thunk, failures included — a failing read must not be retried 6 times. */
function once(fn) {
  let settled = null;
  return () => {
    if (!settled) settled = fn().then((v) => ({ value: v }), (e) => ({ error: e }));
    return settled.then(({ value, error }) => { if (error) throw error; return value; });
  };
}

/**
 * The facts several checks share, each read at most once.
 *
 * `deployedEnv` is the important one: the filesystem id, the VPC, the supported AZ ids and every
 * secret name are dispatcher env vars, and reading them from the RUNNING task definition is what
 * makes preflight check the deployment rather than the operator's shell (spec-baseline.mjs:16-17,
 * :32-44). When it cannot be read, the checks that depend on it report SKIPPED with the reason —
 * never PASS.
 */
function createWorld(ctx, aws) {
  const world = { ctx, aws };

  world.identity = once(() => aws.callerIdentity());

  world.deployed = once(async () => {
    const { cluster, dispatcherService } = ctx.resources;
    const { services, failures } = await aws.describeServices(cluster, dispatcherService);
    const svc = services.find((s) => s.status !== 'INACTIVE') || services[0];
    if (!svc) {
      const why = failures.length ? failures.map((f) => `${f.arn || dispatcherService}: ${f.reason}`).join(', ') : 'no such service';
      throw new Error(`ecs:DescribeServices ${cluster}/${dispatcherService}: ${why}`);
    }
    const td = await aws.describeTaskDefinition(svc.taskDefinition);
    const containers = td.containerDefinitions || [];
    const container = containers.find((c) => /dispatcher|archie/i.test(c.name)) || containers[0] || {};
    const env = {};
    for (const e of container.environment || []) env[e.name] = e.value;
    return { service: svc, taskDefinition: td, container, env };
  });

  // The EFS filesystem, and the VPC that is TRUE rather than the VPC the env claims. EFS allows
  // exactly one VPC per filesystem ("VPCs per file system" = 1), so the mount targets are the
  // authority; the env var is the thing that rots after a VPC move (agentcore-fixture.js:53-58).
  world.efs = once(async () => {
    const { env } = await world.deployed();
    const fsId = env.AGENTCORE_EFS_FS_ID;
    if (!fsId) throw new Error('AGENTCORE_EFS_FS_ID is not set on the dispatcher task definition');
    const fs = await aws.describeFileSystem(fsId);
    const mountTargets = await aws.describeMountTargets(fsId);
    const vpcIds = [...new Set(mountTargets.map((m) => m.VpcId).filter(Boolean))];
    return { fsId, fs, mountTargets, vpcIds, envVpcId: env.AGENTCORE_VPC_ID || null };
  });

  world.supportedAzIds = async () => {
    const { env } = await world.deployed();
    const raw = (env.AGENTCORE_SUPPORTED_AZ_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
    return raw.length ? raw : SUPPORTED_AZ_IDS.slice();
  };

  // Check 4's answer, reused by check 6: the tag to validate is whatever the pointer actually names.
  world.imagePointer = once(async () => {
    const table = ctx.resources.configTable;
    // CONFIG#release/ACTIVE is the plan's pointer and does not exist yet (primitives §3, "grep
    // returns zero hits"); CONFIG#image/FLEET is the one the running dispatcher reads today. Both
    // are accepted so preflight does not start failing the day the CLI migrates the pointer.
    for (const key of [{ pk: 'CONFIG#release', sk: 'ACTIVE' }, { pk: 'CONFIG#image', sk: 'FLEET' }]) {
      // ConsistentRead, matching image-source.js:63-66: a publish followed immediately by a
      // preflight must not read the old value off a stale replica.
      const item = await aws.getItem(table, key, { consistentRead: true });
      const value = readImageItem(item);
      if (value) return { key, item, value };
    }
    return null;
  });

  return world;
}

// ── the 20 checks ────────────────────────────────────────────────────────────────────────────────
//
// `advisory: true` means a failure of this check is a WARN and does not affect the exit code. It is
// used where the finding is a judgement about headroom or hygiene rather than a broken deployment.

const CHECKS = [
  {
    n: 1,
    title: 'account identity',
    async run(w) {
      const id = await w.identity();
      if (w.ctx.account && id.Account !== w.ctx.account) {
        // "A mismatch is exit 3 and nothing else runs" (reference §2.1). Nothing else runs because
        // every remaining check would be describing the WRONG account, and a page of PASSes against
        // the wrong account is worse than no output at all.
        return {
          status: FAIL,
          note: `${id.Account} != --account ${w.ctx.account}`,
          detail: 'a dispatcher pointed at another stack provisions runtimes onto ITS filesystem and '
            + 'security group, reads its secrets, and its GC can delete its runtimes (dispatcher.tf:76-82)',
          fatal: true,
        };
      }
      if (!w.ctx.account) {
        return { status: WARN, note: `${id.Account} (advisory: no --account given, so nothing was asserted)` };
      }
      return { status: PASS, note: id.Account };
    },
  },

  {
    n: 2,
    titleFor: (ctx) => `${ctx.resources.configTable} + routing GSI`,
    title: 'config table + routing GSI',
    async run(w) {
      const table = w.ctx.resources.configTable;
      let described;
      try {
        described = await w.aws.describeTable(table);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        // The whole point of this check. Absent, the table surfaces later as "a bare
        // ResourceNotFoundException ... no table name, no operation" from deep inside the derived-role
        // resolver (agentcore-fixture.js:384-386). One DescribeTable turns that into a sentence.
        return {
          status: FAIL,
          note: `dynamodb:DescribeTable ${table} in ${w.ctx.region}: table does not exist`,
          detail: 'created by modules/archie/agent_config.tf — this is Terraform, not something the CLI creates',
        };
      }
      const gsis = described.GlobalSecondaryIndexes || [];
      // 'routing' is a literal in routing-build.js's IndexName, so the NAME is load-bearing
      // (agent_config.tf:35-41).
      const routing = gsis.find((g) => g.IndexName === 'routing');
      if (!routing) {
        return {
          status: FAIL,
          note: `${table} exists but has no "routing" GSI (has: ${gsis.map((g) => g.IndexName).join(', ') || 'none'})`,
          detail: 'routing-build.js queries IndexName "routing" literally — agent enumeration returns nothing without it',
        };
      }
      if (routing.IndexStatus && routing.IndexStatus !== 'ACTIVE') {
        return { status: FAIL, note: `${table} routing GSI is ${routing.IndexStatus}, not ACTIVE` };
      }
      return { status: PASS, note: `${table} ${described.TableStatus || 'ACTIVE'}, routing GSI ACTIVE` };
    },
  },

  {
    n: 4,
    title: 'release pointer (ConsistentRead)',
    async run(w) {
      const pointer = await w.imagePointer();
      if (!pointer) {
        // Correct, not broken, on a genuinely empty account. Said in as many words because the
        // failure mode of NOT saying it is an operator "fixing" a bootstrap by hand.
        return {
          status: FAIL,
          note: `${w.ctx.resources.configTable} has no usable CONFIG#release/ACTIVE or CONFIG#image/FLEET`,
          detail: 'CORRECT on a genuinely empty account: nothing has been published yet, and bootstrap '
            + '(reference §3.4) is what fixes it. On a live account it means every turn fails '
            + 'ImagePointerMissing — there is deliberately no baked fallback (image-source.js:11-15)',
        };
      }
      const shown = typeof pointer.value === 'string' ? pointer.value : `tag=${pointer.value.tag}`;
      return { status: PASS, note: `${pointer.key.pk}/${pointer.key.sk} -> ${shown}` };
    },
  },

  {
    n: 5,
    title: 'ECR repos exist',
    async run(w) {
      const names = [w.ctx.resources.gatewayRepo, w.ctx.resources.agentRepo];
      let repos;
      try {
        repos = await w.aws.describeRepositories(names);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        return {
          status: FAIL,
          note: `ecr:DescribeRepositories ${names.join(', ')}: ${errName(e)}`,
          detail: 'publishing would write a pointer to a repo that does not exist (ecr.tf:13,53)',
        };
      }
      const found = new Set(repos.map((r) => r.repositoryName));
      const missing = names.filter((nm) => !found.has(nm));
      if (missing.length) return { status: FAIL, note: `missing: ${missing.join(', ')}` };
      return { status: PASS, note: names.join(', ') };
    },
  },

  {
    n: 6,
    title: 'published image exists and is arm64',
    async run(w) {
      const pointer = await w.imagePointer();
      if (!pointer) {
        // Not a pass and not a failure of ITS OWN: check 4 already reports the absent pointer, and
        // reporting the same fact twice as two failures makes a bootstrap look twice as broken.
        return { status: SKIPPED, note: 'no image pointer to validate (check 4)' };
      }
      const repo = w.ctx.resources.agentRepo;
      const tag = typeof pointer.value === 'string'
        ? (pointer.value.split('/').pop().includes(':') ? pointer.value.split(':').pop() : null)
        : pointer.value.tag;
      if (!tag) return { status: SKIPPED, note: `pointer names a digest or bare URI (${pointer.value}), no tag to check` };

      let image;
      try {
        image = await w.aws.describeImage(repo, tag);
      } catch (e) {
        if (!isNotFound(e) && !/ImageNotFound/.test(errName(e))) throw e;
        image = null;
      }
      if (!image) {
        return {
          status: FAIL,
          note: `${repo}:${tag} does not exist in ECR (${w.ctx.region})`,
          detail: 'runtimes provision and then cannot pull — build and push it first (publish-image.mjs:50-96)',
        };
      }
      if (image.arches.length && !image.arches.includes('arm64')) {
        return {
          status: FAIL,
          note: `${repo}:${tag} is ${image.arches.join('/')} — AgentCore microVMs are arm64`,
          detail: 'almost always the amd64 dispatcher image published by mistake (publish-image.mjs:88-92)',
        };
      }
      if (!image.arches.length) {
        // Existence is the hard gate and it passed; the architecture read did not answer. Saying so
        // is the honest result — claiming arm64 we never saw is not.
        return { status: WARN, note: `${repo}:${tag} exists; architecture unknown (advisory)` };
      }
      return { status: PASS, note: `${repo}:${tag} arm64` };
    },
  },

  {
    n: 7,
    title: 'agentcore-base managed policy',
    async run(w) {
      const id = await w.identity();
      // agentcore_base.tf:19. Prefixed with the deployment name because the bare live name is
      // account-unique and a second stack in one account fails EntityAlreadyExists.
      const arn = `arn:aws:iam::${id.Account}:policy/${w.ctx.resources.name}-agentcore-base`;
      try {
        const policy = await w.aws.getPolicy(arn);
        // DefaultVersionId already carries its own "v" — printing v${...} gave "vv2" on the first
        // live run.
        return { status: PASS, note: `${policy.PolicyName} ${policy.DefaultVersionId}, ${policy.AttachmentCount} attached` };
      } catch (e) {
        if (!isNotFound(e)) throw e;
        return {
          status: FAIL,
          note: `iam:GetPolicy ${arn}: absent`,
          detail: 'must be applied BEFORE the image reaches an environment — otherwise every provision '
            + 'fails closed (agentcore-client.js:66-68)',
        };
      }
    },
  },

  {
    n: 8,
    title: 'can create derived roles',
    async run(w) {
      const id = await w.identity();
      // SimulatePrincipalPolicy wants a principal, and GetCallerIdentity hands back a SESSION arn
      // for an assumed role. Converting is required or every simulate is NoSuchEntity.
      const source = principalArnFor(id.Arn);
      // The grant this proves is iam.tf:287-334 (ManageDerivedAgentRoles), on role/agentcore/*.
      const actions = ['iam:CreateRole', 'iam:PutRolePolicy', 'iam:AttachRolePolicy', 'iam:PassRole'];
      const resource = `arn:aws:iam::${id.Account}:role/agentcore/preflight-probe`;
      let results;
      try {
        results = await w.aws.simulatePrincipalPolicy(source, actions, [resource]);
      } catch (e) {
        if (isNotFound(e) || ACCESS_ERRORS.test(errName(e))) {
          // Common and benign for an SSO/assumed-role caller: the session arn has no path and
          // iam:SimulatePrincipalPolicy is itself a permission. Unknown, therefore advisory —
          // not a pass.
          return { status: WARN, note: `cannot simulate as ${source} (${errName(e)}) — advisory, unverified` };
        }
        throw e;
      }
      const denied = results.filter((r) => r.EvalDecision !== 'allowed').map((r) => r.EvalActionName);
      if (denied.length) {
        return {
          status: FAIL,
          note: `denied: ${denied.join(', ')} on role/agentcore/*`,
          detail: 'every provision then fails on the SECOND step, after an access point already exists — '
            + 'it leaks one on every attempt (iam.tf:287-334)',
        };
      }
      return { status: PASS, note: `${actions.length} actions allowed on role/agentcore/*` };
    },
  },

  {
    n: 9,
    title: 'EFS filesystem + mount targets',
    async run(w) {
      const { fsId, fs, mountTargets, vpcIds, envVpcId } = await w.efs();
      if (!fs) {
        return {
          status: FAIL,
          note: `efs:DescribeFileSystems ${fsId}: does not exist`,
          detail: '2026-08-13: a dead filesystem id made the whole suite unrunnable, and it read as an '
            + 'AZ-coverage problem rather than a stale constant (agentcore-fixture.js:277-280)',
        };
      }
      if (!mountTargets.length) {
        return { status: FAIL, note: `${fsId} (${fs.Name || 'unnamed'}) has no mount targets` };
      }
      const unavailable = mountTargets.filter((m) => m.LifeCycleState && m.LifeCycleState !== 'available');
      if (unavailable.length === mountTargets.length) {
        return { status: FAIL, note: `${fsId}: ${mountTargets.length} mount targets, none available` };
      }
      const note = `${fsId} (${fs.Name || 'unnamed'}) ${mountTargets.length} mount targets in ${vpcIds.join(', ')}`;
      if (envVpcId && !vpcIds.includes(envVpcId)) {
        // The filesystem is the authority on its own VPC; the env var is what rots. This exact
        // divergence surfaced as "no available EFS mount targets in supported AZs", which reads like
        // an AZ problem (agentcore-fixture.js:53-58).
        return {
          status: FAIL,
          note: `${note} — but AGENTCORE_VPC_ID says ${envVpcId}`,
          detail: 'EFS allows exactly one VPC per filesystem, so the deployed env var is the stale one',
        };
      }
      return { status: PASS, note };
    },
  },

  {
    n: 10,
    title: 'mount target in supported AZ ID',
    async run(w) {
      const { fsId, mountTargets } = await w.efs();
      const supported = await w.supportedAzIds();
      // FILTER BY AvailabilityZoneId, NOT AvailabilityZoneName. Names are per-account aliases:
      // us-east-1a is use1-az4 in dev (supported) and use1-az6 in prod (not), so any reasoning done
      // in names is wrong in at least one account (az_coverage.tf:8-19).
      const present = [...new Set(mountTargets.map((m) => m.AvailabilityZoneId).filter(Boolean))];
      const usable = supported.filter((z) => present.includes(z));
      const absent = supported.filter((z) => !present.includes(z));
      if (!usable.length) {
        return {
          status: FAIL,
          note: `0 of ${supported.length} (${supported.join(', ')} — none present on ${fsId})`,
          detail: 'CreateAgentRuntime cannot place a single runtime: "no available EFS mount targets"',
        };
      }
      if (absent.length) {
        // prod is 2 of 3 today and dev, being 3/3, will never reproduce it. The fleet RUNS in this
        // state — it is concentrated into fewer zones than intended — so this is advisory by design,
        // and surfacing it at all is the entire point of az_coverage.tf.
        return {
          status: WARN,
          note: `${usable.length} of ${supported.length} (${usable.join(', ')}; ${absent.join(', ')} absent) — advisory`,
          detail: 'a subnet outside the supported set is simply invisible: no error, just fewer zones',
        };
      }
      return { status: PASS, note: `${usable.length} of ${supported.length} (${usable.join(', ')})` };
    },
  },

  {
    n: 11,
    title: 'access-point hygiene',
    advisory: true,
    async run(w) {
      const { fsId } = await w.efs();
      const aps = await w.aws.describeAccessPoints(fsId);
      const tagged = (ap, value) => (ap.Tags || []).some((t) => t.Key === 'managed-by' && t.Value === value);
      const managed = aps.filter((ap) => tagged(ap, 'agentcore'));
      const bdd = aps.filter((ap) => tagged(ap, 'agentcore-bdd'));
      // NOT a count cap. "Access points per file system" is 10,000, verified against Service Quotas
      // 2026-08-14 — the 120 that this check was originally written against was wrong and was
      // propagated into two planning docs before being caught. The real constraint is an undocumented
      // RATE limit on concurrent CreateAccessPoint, so leaked APs matter because they mean leaked
      // CREATES (every killed run leaks ~18; 82 leaked once throttled predeploys), not because a
      // ceiling is near (agentcore-fixture.js:683-690).
      const note = `${aps.length} access points (${managed.length} managed-by=agentcore, ${bdd.length} bdd)`;
      if (bdd.length >= 40) {
        return { status: WARN, note: `${note} — advisory: leaked BDD access points, run \`archie access-point gc\`` };
      }
      return { status: PASS, note };
    },
  },

  {
    n: 12,
    title: 'runtime quota headroom',
    advisory: true,
    async run(w) {
      // The one place the CLI calls ListAgentRuntimes on purpose. It is 25/s account-wide, has no
      // name filter and no get-by-name (runtime-registry.js:5-10), which is why `status` and
      // `runtime list` read the registry instead — but a QUOTA question is about what AWS holds, and
      // the registry cannot answer it.
      const runtimes = await w.aws.listAgentRuntimes();
      let limit = RUNTIME_QUOTA_FALLBACK;
      let limitSource = 'plan §8 default';
      try {
        const quota = await w.aws.serviceQuota('bedrock-agentcore', /agent runtime/i);
        if (quota && Number.isFinite(quota.Value)) { limit = quota.Value; limitSource = 'Service Quotas'; }
        else limitSource = 'plan §8 default (no matching Service Quotas entry)';
      } catch (e) {
        // Best-effort by design: the quota code is undocumented and the fallback is the number the
        // plan sizes against. Recorded in the note so nobody reads a fallback as a measurement.
        limitSource = `plan §8 default (Service Quotas: ${errName(e) || 'unavailable'})`;
      }
      const note = `${runtimes.length}/${limit} (limit from ${limitSource})`;
      if (runtimes.length >= limit) {
        // No headroom at all is not advisory: the next CreateAgentRuntime fails.
        return { status: FAIL, note: `${note} — no headroom, the next provision fails`, hard: true };
      }
      if (runtimes.length >= limit * RUNTIME_QUOTA_WARN_FRACTION) {
        const generations = Math.floor((limit - runtimes.length) / 208);
        return { status: WARN, note: `${note} — advisory: ~${generations} full generations of headroom left` };
      }
      return { status: PASS, note };
    },
  },

  {
    n: 13,
    title: 'runtime SG by name in the FS VPC',
    async run(w) {
      const { env } = await w.deployed();
      const { fsId, vpcIds } = await w.efs();
      if (vpcIds.length !== 1) {
        return { status: SKIPPED, note: `cannot resolve one VPC from ${fsId} (${vpcIds.join(', ') || 'none'})` };
      }
      const vpcId = vpcIds[0];
      // BY NAME, WITHIN THE FILESYSTEM'S VPC. Resolving by id is exactly what rotted: after a VPC
      // move the recorded id pointed at the retired VPC's copy of the group — "same NAME, different
      // id" (agentcore-fixture.js:53-58). The name survives; the id does not.
      const name = env.AGENTCORE_SECURITY_GROUP_NAME || `${w.ctx.resources.name}-runtime-sg`;
      const groups = await w.aws.describeSecurityGroupsByName(vpcId, name);
      if (!groups.length) {
        return {
          status: FAIL,
          note: `ec2:DescribeSecurityGroups ${name} in ${vpcId}: no such group`,
          detail: 'the runtime ENIs have no security group to attach (security_groups.tf:30)',
        };
      }
      const resolved = groups[0].GroupId;
      const declared = env.AGENTCORE_SECURITY_GROUP_ID || null;
      if (declared && declared !== resolved) {
        return {
          status: FAIL,
          note: `${name} in ${vpcId} is ${resolved}, but the dispatcher is configured with ${declared}`,
          detail: 'same NAME, different id — the configured group belongs to another (probably retired) VPC',
        };
      }
      return { status: PASS, note: `${name} ${resolved} in ${vpcId}` };
    },
  },

  {
    n: 14,
    title: 'secrets exist (DescribeSecret)',
    async run(w) {
      const { env, container } = await w.deployed();
      const ids = secretIdsFrom(env, container);
      if (!ids.length) return { status: SKIPPED, note: 'the dispatcher task definition names no secrets' };
      const missing = [];
      for (const id of ids) {
        try {
          // DescribeSecret, never GetSecretValue. The CLI verifies a secret exists; it never reads
          // one, in any mode (reference §2.1 "Refuses to").
          await w.aws.describeSecret(id);
        } catch (e) {
          if (!isNotFound(e)) throw e;
          missing.push(shortSecret(id));
        }
      }
      if (missing.length) {
        return {
          status: FAIL,
          note: `absent: ${missing.join(', ')}`,
          detail: 'the container boots and then fails resolving a secret by name (secrets.tf:43,58,77,91)',
        };
      }
      return { status: PASS, note: `${ids.length} named secrets present` };
    },
  },

  {
    n: 15,
    title: 'ECS cluster + dispatcher service',
    async run(w) {
      const { service } = await w.deployed();
      const { cluster, dispatcherService } = w.ctx.resources;
      if (service.status !== 'ACTIVE') {
        return { status: FAIL, note: `${cluster}/${dispatcherService} is ${service.status}` };
      }
      // desiredCount is 1 BY DESIGN and must stay 1: two tasks open two Slack Socket Mode
      // connections, break the cron store's sole-writer invariant and break per-session turn
      // serialisation (dispatcher.tf:186-193).
      const counts = `desired ${service.desiredCount}, running ${service.runningCount}`;
      if (service.desiredCount !== 1) {
        return { status: WARN, note: `${cluster}/${dispatcherService} ${counts} — advisory: desiredCount must be 1` };
      }
      if (service.runningCount < 1) {
        return { status: FAIL, note: `${cluster}/${dispatcherService} ${counts} — nothing is serving` };
      }
      return { status: PASS, note: `${cluster}/${dispatcherService} ${counts}` };
    },
  },

  {
    n: 16,
    title: 'task-def env agrees with --name',
    async run(w) {
      const { env, taskDefinition } = await w.deployed();
      const r = w.ctx.resources;
      // THE §10 SHADOW-CONFIG TRAP, and the reason deploy-dashboard.cjs:230 calls this its only
      // check with teeth: the OpenClaw namespaces and log group are REAL and POPULATED, so a
      // dispatcher configured for another stack does not error — it renders and behaves as if it
      // were this one.
      const expect = [
        ['AGENT_CONFIG_TABLE', r.configTable],
        ['DISPATCHER_LOG_GROUP', r.dispatcherLogGroup],
        ['DISPATCHER_METRIC_NAMESPACE', r.dispatcherNamespace],
        ['CRON_METRIC_NAMESPACE', r.cronNamespace],
        ['DISPATCHER_SERVICE_NAME', r.dispatcherService],
        ['AGENTCORE_REGION', w.ctx.region],
      ];
      const wrong = expect.filter(([k, want]) => env[k] !== undefined && env[k] !== want)
        .map(([k, want]) => `${k}=${env[k]} (expected ${want})`);
      const absent = expect.filter(([k]) => env[k] === undefined).map(([k]) => k);
      if (wrong.length) {
        return {
          status: FAIL,
          note: `${(taskDefinition.taskDefinitionArn || '').split('/').pop()}: ${wrong.join('; ')}`,
          detail: 'the deployed dispatcher is configured for a DIFFERENT stack than --name names',
        };
      }
      if (absent.length) {
        return { status: WARN, note: `advisory: not set on the task definition: ${absent.join(', ')}` };
      }
      return { status: PASS, note: `${(taskDefinition.taskDefinitionArn || '').split('/').pop()} agrees with ${r.name}` };
    },
  },

  {
    n: 17,
    title: 'X-Ray Transaction Search',
    async run(w) {
      const dest = await w.aws.traceSegmentDestination();
      // README.md:64-67 — "Enabled by hand in 052; not reproduced anywhere in code". Exactly the
      // class of check that never fails until the day a new account is stood up.
      if (dest.Destination !== 'CloudWatchLogs' || (dest.Status && dest.Status !== 'ACTIVE')) {
        return {
          status: FAIL,
          note: `destination ${dest.Destination || 'XRay'}${dest.Status ? ` (${dest.Status})` : ''}`,
          detail: 'no agent_i32pz9 span reaches aws/spans and every dashboard log widget is empty; enable '
            + 'Transaction Search by hand (xray:UpdateTraceSegmentDestination + a logs resource policy)',
        };
      }
      return { status: PASS, note: `${dest.Destination} ${dest.Status || 'ACTIVE'}` };
    },
  },

  {
    n: 18,
    title: 'Bedrock model access',
    async run(w) {
      let modelId = DEFAULT_MODEL_ID;
      try {
        const { env } = await w.deployed();
        modelId = env.PI_MODEL_ID || env.AGENTCORE_MODEL_ID || DEFAULT_MODEL_ID;
      } catch {
        // The task definition is unreadable — check 15 says so. The default is still the model the
        // image runs (pi-adapter.mjs:126), so the check is worth running against it.
        modelId = DEFAULT_MODEL_ID;
      }
      try {
        // A REAL converse, one token. README.md:68-71 records a live AccessDeniedException here
        // demanding aws-marketplace:Subscribe, with no record of it being resolved — an entitlement
        // cannot be inferred from any Describe call, only from an invocation.
        await w.aws.converse(modelId);
        return { status: PASS, note: modelId };
      } catch (e) {
        if (e.unrunnable) throw e;
        if (ACCESS_ERRORS.test(errName(e))) {
          return {
            status: FAIL,
            note: `${modelId}: ${errName(e)}`,
            detail: 'every agent turn fails at the model call; model access is granted per model in the '
              + 'Bedrock console and may require aws-marketplace:Subscribe (README.md:68-71)',
          };
        }
        return { status: FAIL, note: `${modelId}: ${errName(e) || e.message}` };
      }
    },
  },

  {
    n: 19,
    title: 'turn queue + DLQ',
    async run(w) {
      const { env } = await w.deployed();
      // turn_queue.tf:4,13. Names are composed from the same knob Terraform composes them from.
      const names = [`${w.ctx.resources.dispatcherService}-turns.fifo`, `${w.ctx.resources.dispatcherService}-turns-dlq.fifo`];
      const missing = [];
      const found = [];
      for (const name of names) {
        try {
          const url = await w.aws.queueUrl(name);
          const attrs = await w.aws.queueAttributes(url);
          found.push(`${name} (${attrs.ApproximateNumberOfMessages || 0} msgs)`);
        } catch (e) {
          if (!isNotFound(e)) throw e;
          missing.push(name);
        }
      }
      if (missing.length) {
        return { status: FAIL, note: `absent: ${missing.join(', ')}`, detail: 'turns enqueue nowhere (turn_queue.tf:4,13)' };
      }
      if (!env.TURN_QUEUE_URL) {
        // A working configuration, deliberately: without TURN_QUEUE_URL turns are processed
        // in-process and lost on restart (turn_queue.tf:1-2). Degraded, not broken — advisory.
        return { status: WARN, note: `${found.join(', ')} — advisory: TURN_QUEUE_URL unset, durable delivery is OFF` };
      }
      return { status: PASS, note: found.join(', ') };
    },
  },

  {
    n: 20,
    title: 'cron hydration prerequisites (parent AP + execution role)',
    async run(w) {
      // THIS CHECK USED TO ASSERT A TASK DEFINITION, and failed hard when it was absent —
      // "cutover silently drops every agent's schedules". That definition is now registered on
      // demand by `archie cron hydrate`, run, and deregistered (GATEWAY-OWNERSHIP-PLAN.md §8), so
      // ABSENT IS THE NORMAL STATE and asserting it would fail permanently. A check that is always
      // red is worse than no check: it trains everyone to skim past the one line that matters.
      //
      // What it asserts instead is what Terraform still owns and what hydration genuinely cannot
      // proceed without — the fleet-wide access point and the execution role the ephemeral
      // definition borrows. Those are the things whose absence actually breaks it.
      const { env } = await w.deployed();
      const { fsId } = await w.efs();
      const prefix = env.AGENTCORE_EFS_ROOT_PREFIX;
      const wantPath = prefix ? `${prefix}/agents` : null;

      // THE ACCESS POINT IS THE PRIVILEGE, which is why it stays in Terraform rather than being
      // created by a CLI: its root is the PARENT <prefix>/agents, so one task can read every agent's
      // subtree. The always-on gateway deliberately never holds that mount — it gets a narrow one —
      // precisely so a compromised gateway cannot walk the fleet's workspaces.
      const aps = await w.aws.describeAccessPoints(fsId);
      const parent = wantPath
        ? aps.find((ap) => ap.RootDirectory && ap.RootDirectory.Path === wantPath)
        : null;
      if (!parent) {
        return {
          status: FAIL,
          note: `no access point at ${wantPath || '<AGENTCORE_EFS_ROOT_PREFIX unset>/agents'} on ${fsId}`,
          detail: 'the hydrator reads every agent subtree through one parent access point '
            + '(modules/archie/cron_hydrator.tf). Terraform owns it; archie only decides when a task may use it.',
        };
      }

      // The hydrator has NO task role — deliberately, because it makes no AWS API calls: it reads
      // EFS and makes one HTTP call to the gateway's manager API. It borrows the dispatcher's
      // EXECUTION role, which is what pulls the image and resolves secrets.
      const roleName = `${w.ctx.resources.dispatcherService}-execution-role`;
      try {
        await w.aws.getRole(roleName);
      } catch (e) {
        if (!isNotFound(e)) throw e;
        return {
          status: FAIL,
          note: `iam:GetRole ${roleName}: absent`,
          detail: 'the ephemeral hydrator definition borrows this role; without it RunTask cannot pull the image.',
        };
      }

      return {
        status: PASS,
        note: `parent AP ${parent.AccessPointId} at ${wantPath}, execution role ${roleName} `
          + '(task definition is registered on demand)',
      };
    },
  },

];

const CHECK_NUMBERS = CHECKS.map((c) => c.n);
// Checks 1-2. THE NUMBER 3 IS RETIRED, not reallocated: it was `CONFIG#base / BASE present`, and
// that item no longer exists (the fleet base config is the constant schema.mjs BASE_MAIN). The
// numbering deliberately skips it rather than renumbering 4..20 down one — the reference cites
// checks by number throughout (`check 4`, `check 7`, `check 16`), and every one of those citations
// would silently start naming a different check.
const BASELINE = [1, 2];

/**
 * The IAM principal behind a caller identity.
 *
 * GetCallerIdentity returns a SESSION arn for an assumed role
 * (`arn:aws:sts::123:assumed-role/Role/session`), and SimulatePrincipalPolicy wants the ROLE.
 * Without this conversion check 8 is NoSuchEntity every time it is run by anyone using SSO or a
 * role, i.e. almost always.
 */
function principalArnFor(arn) {
  const m = /^arn:aws:sts::(\d+):assumed-role\/([^/]+)\//.exec(String(arn || ''));
  return m ? `arn:aws:iam::${m[1]}:role/${m[2]}` : arn;
}

/**
 * Every secret the deployed dispatcher NAMES — the definition check 14 needs, because a secret that
 * nothing references cannot break a boot and a secret that is referenced but absent always does.
 *
 * Two sources: the container's `secrets[]` (injected by the ECS agent, so valueFrom ARNs) and the
 * env vars that carry a secret's NAME for the container to resolve at runtime
 * (DISPATCHER_SHARED_SECRET_ID, CONNECTOR_API_KEY_SECRET, DATADOG_*_SECRET — dispatcher.tf:96-133).
 * `*_SECRET_REGION` is excluded: it is a region, not a secret.
 */
function secretIdsFrom(env, container) {
  const ids = new Set();
  for (const s of (container && container.secrets) || []) if (s.valueFrom) ids.add(s.valueFrom);
  for (const [k, v] of Object.entries(env || {})) {
    if (!v) continue;
    if (/_SECRET(_ID|_ARN)?$/.test(k)) ids.add(v);
  }
  return [...ids];
}

/** ARNs are 100 characters of noise around a name; the name is what an operator can act on. */
function shortSecret(id) {
  if (!String(id).startsWith('arn:')) return String(id);
  const name = String(id).split(':secret:').pop();
  return name.replace(/-[A-Za-z0-9]{6}$/, '');
}

// ── running them ─────────────────────────────────────────────────────────────────────────────────

/** `--checks`/`--skip` parsing. An unknown number is exit 2 — it is a typo, not a finding. */
function selectChecks(values = {}) {
  const parse = (raw, flag) => {
    const nums = String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const v = Number(s);
      if (!Number.isInteger(v) || !CHECK_NUMBERS.includes(v)) {
        throw usage(`--${flag}: unknown check number "${s}" (valid: 1-${CHECK_NUMBERS.length})`);
      }
      return v;
    });
    if (!nums.length) throw usage(`--${flag} needs at least one check number`);
    return nums;
  };

  const only = values.checks === undefined ? null : parse(values.checks, 'checks');
  const skip = values.skip === undefined ? [] : parse(values.skip, 'skip');
  return CHECKS.map((check) => {
    if (only && !only.includes(check.n)) return { check, skipReason: 'not in --checks' };
    if (skip.includes(check.n)) return { check, skipReason: 'skipped by --skip' };
    return { check, skipReason: null };
  });
}

/** One check, with every failure mode mapped onto a status rather than a stack trace. */
async function runOne(check, world) {
  try {
    const r = await check.run(world);
    // An advisory check never fails the run: its finding is a judgement about headroom or hygiene,
    // not a broken deployment. Demoted here, once, rather than in each check.
    if (check.advisory && r.status === FAIL && !r.hard) return { ...r, status: WARN };
    return r;
  } catch (e) {
    if (e.unrunnable) return { status: ERROR, note: `cannot run: ${e.message}`, detail: e.detail };
    if (ACCESS_ERRORS.test(errName(e))) {
      return { status: ERROR, note: `cannot determine: ${errName(e)}`, detail: e.message };
    }
    return { status: FAIL, note: e.message, detail: errName(e) || null };
  }
}

const TITLE_WIDTH = 38;

/** ` 1  account identity ................... PASS  203366135563` — reference §2.1's example. */
function formatLine({ n, title, status, note }) {
  const dots = title.length >= TITLE_WIDTH ? '' : ` ${'.'.repeat(Math.max(1, TITLE_WIDTH - title.length - 1))}`;
  return `${String(n).padStart(2)}  ${title}${dots} ${status.padEnd(7)} ${note || ''}`.trimEnd();
}

const titleOf = (check, ctx) => (check.titleFor ? check.titleFor(ctx) : check.title);

/**
 * Run a selection of checks against one world.
 *
 * Shared by the command and by assertBaseline, so "what check 2 means" cannot diverge between an
 * operator running `archie preflight` and a `deploy` that runs the same check implicitly.
 */
async function runChecks(selection, world, { onResult } = {}) {
  const results = [];
  let aborted = null;
  for (const { check, skipReason } of selection) {
    const title = titleOf(check, world.ctx);
    let r;
    if (skipReason) {
      // NEVER PASS. "A check that cannot RUN is not a check that passed"
      // (deploy-dashboard.cjs:155-157) — this is the line that rule exists for.
      r = { status: SKIPPED, note: skipReason };
    } else if (aborted) {
      r = { status: SKIPPED, note: `not run: ${aborted}` };
    } else {
      r = await runOne(check, world);
      if (r.fatal && FAILING.has(r.status)) aborted = `check ${check.n} (${title}) failed`;
    }
    const record = { n: check.n, title, status: r.status, note: r.note || null, detail: r.detail || null,
      advisory: Boolean(check.advisory) };
    results.push(record);
    if (onResult) onResult(record);
  }
  return results;
}

const summarise = (results) => ({
  checks: results,
  passed: results.filter((r) => r.status === PASS).length,
  warned: results.filter((r) => r.status === WARN).length,
  failed: results.filter((r) => r.status === FAIL).length,
  errored: results.filter((r) => r.status === ERROR).length,
  skipped: results.filter((r) => r.status === SKIPPED).length,
});

/**
 * Checks 1-3, as a library.
 *
 * EVERY mutating command runs these (reference §4): they are cheap, and each one's absence produces
 * a downstream error that does not name itself. Exported rather than reachable only through the
 * command because a `deploy` that shelled out to its own CLI to get them would be able to skip them.
 *
 * Throws exit 3 on the first failure — a mutating command wants a stop, not a report.
 *
 * @param deps.aws  the AWS adapter (injected by tests; built from ctx otherwise)
 * @param deps.out  optional output, for the `-v` line
 * @returns { account, results }
 */
async function assertBaseline(ctx, deps = {}) {
  const aws = deps.aws || createAws(ctx);
  const world = deps.world || createWorld(ctx, aws);
  const selection = CHECKS.filter((c) => BASELINE.includes(c.n)).map((check) => ({ check, skipReason: null }));
  const results = await runChecks(selection, world);
  for (const r of results) {
    if (deps.out) deps.out.verbose(formatLine(r));
    if (FAILING.has(r.status)) {
      throw preflightError(`preflight check ${r.n} (${r.title}) failed: ${r.note}`, { detail: r.detail });
    }
  }
  const identity = await world.identity();
  return { account: identity.Account, results };
}

/**
 * `archie preflight`.
 *
 * Human mode prints one line per check to stdout as it goes, so a slow check (18 is a real model
 * call) does not look like a hang. --json buffers the same data into the envelope's `result`,
 * because a command that streamed partial JSON and then failed would produce a document no parser
 * can read (output.js:32-36) — which is why the result is handed to out.answer() BEFORE the throw
 * rather than returned.
 */
async function preflight(ctx, args, out, deps = {}) {
  const selection = selectChecks(args.values);
  // Fourth parameter, unused by the dispatcher (bin/archie.js:143 passes three): the tests inject an
  // adapter here so the whole file runs with no credentials, no network and no SDK.
  const aws = deps.aws || createAws(ctx);
  const world = deps.world || createWorld(ctx, aws);

  const results = await runChecks(selection, world, {
    onResult: (r) => {
      if (!ctx.json) out.answer(formatLine(r));
      if (r.detail && (FAILING.has(r.status) || r.status === WARN)) out.verbose(`      ${r.detail}`);
    },
  });

  const summary = summarise(results);
  for (const r of results.filter((x) => FAILING.has(x.status))) {
    // failures[] names WHICH checks failed: "a single bad agent and a bad image look identical from
    // an exit code alone" (plan §7) is the same argument one number down.
    out.failure({ step: `check ${r.n} ${r.title}`, error: new Error(r.note || r.status) });
  }

  const advisory = results.filter((r) => r.status === WARN);
  if (advisory.length) {
    out.progress(`${advisory.length} advisory: ${advisory.map((r) => r.n).join(', ')} `
      + '(WARN does not affect the exit code)');
  }

  if (ctx.json) out.answer(summary);

  const bad = results.filter((r) => FAILING.has(r.status));
  if (bad.length) {
    const errored = bad.filter((r) => r.status === ERROR);
    throw preflightError(`${bad.length} of ${results.length - summary.skipped} checks failed: `
      + `${bad.map((r) => r.n).join(', ')}`, {
      detail: errored.length
        ? `${errored.length} could not run (${errored.map((r) => r.n).join(', ')}) — a check that cannot run is not a check that passed`
        : 'nothing was created: preflight names what is missing, Terraform creates it',
    });
  }

  out.progress(`${summary.passed} passed, ${summary.warned} advisory, ${summary.skipped} skipped`);
  return undefined;
}

module.exports = {
  preflight,
  assertBaseline,
  // Exported for the other wave-1 commands and for the tests: the check table, the statuses, the
  // adapter factory (so a command can share one set of clients) and the formatter.
  CHECKS, BASELINE, PASS, WARN, FAIL, SKIPPED, ERROR,
  createAws, createWorld, runChecks, selectChecks, formatLine, secretIdsFrom, principalArnFor,
  credentialProviderFrom,
};

'use strict';

// The AWS facts the dispatcher task definition is composed from.
//
// GATEWAY-OWNERSHIP-PLAN.md §4.1 and §5.2. Every fact is resolved by a name derived from `--name`,
// derived from another resolved fact, or read from the parameters Terraform publishes. Nothing is
// read from process.env, and nothing is read from the DEPLOYED task definition.
//
// THAT LAST EXCLUSION IS THE LOAD-BEARING ONE, and it is the opposite of what preflight does.
// `cmd/preflight.js` deliberately sources the filesystem id, the VPC and the secret names FROM the
// running task definition, because its job is to check the deployment rather than the operator's
// shell. Composition cannot do that: it would be circular (the composed value would always agree
// with the deployed one, so the §6 gate would prove nothing), and it would not work at all in the
// case the whole plan exists to enable — `terraform apply` followed by `archie deploy` in an account
// where no service has ever run.
//
// WHERE A THING IS DERIVED, DERIVING IT IS MORE CORRECT THAN CONFIGURING IT, not merely equivalent.
// The VPC comes from the filesystem's mount targets, so it is the VPC that is TRUE rather than the
// one a variable claims; this exact divergence has already happened here, and it surfaced as "no
// available EFS mount targets in supported AZs", which reads like an AZ problem rather than a stale
// id. The runtime security group is resolved BY NAME within that VPC for the same reason: after a
// VPC move the recorded id pointed at the retired VPC's copy of the group — same NAME, different id.
// The name survives; the id does not.
//
// BUT NOT EVERYTHING IS DERIVABLE, and pretending otherwise is worse than a parameter. Two things
// have no name to look them up by: the file system (archie does not own one — it mounts the OpenClaw
// stack's, whose name shares no prefix with anything here) and the gateway's access point (an
// AWS-generated `fsap-…`). Terraform holds both and publishes them (modules/archie/ssm.tf), so
// archie composes from the SAME value Terraform mounts from rather than from something that merely
// agrees with it. An earlier version of this file resolved the file system by paging every access
// point in the account and matching a `Name` tag; that worked, and it was wrong — a tag is mutable,
// is not enforced unique, and resolving it wrong is the worst failure this system has.

const { CliError, preflight } = require('./exit');
const { makeClient } = require('./aws');
const { basePolicyArnFor } = require('./context');

const errName = (e) => (e && (e.name || e.Code || e.code)) || '';
// SQS says QueueDoesNotExist, IAM says NoSuchEntity, ECR says RepositoryNotFoundException, Secrets
// Manager says ResourceNotFoundException. Same fact, four spellings; the union is the test.
const isNotFound = (e) => /NotFound|NoSuchEntity|ResourceNotFoundException|QueueDoesNotExist|ParameterNotFound/.test(errName(e));

/**
 * Clients, through lib/aws.js so region and credential handling cannot drift between commands.
 * Injectable in one place so the whole of discovery can be unit-tested without AWS.
 */
function clientsFor(ctx, deps = {}) {
  return deps.clients || {
    sts: makeClient(ctx, '@aws-sdk/client-sts', 'STSClient'),
    ecr: makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient'),
    efs: makeClient(ctx, '@aws-sdk/client-efs', 'EFSClient'),
    ec2: makeClient(ctx, '@aws-sdk/client-ec2', 'EC2Client'),
    iam: makeClient(ctx, '@aws-sdk/client-iam', 'IAMClient'),
    sqs: makeClient(ctx, '@aws-sdk/client-sqs', 'SQSClient'),
    ssm: makeClient(ctx, '@aws-sdk/client-ssm', 'SSMClient'),
    secrets: makeClient(ctx, '@aws-sdk/client-secrets-manager', 'SecretsManagerClient'),
    discovery: makeClient(ctx, '@aws-sdk/client-servicediscovery', 'ServiceDiscoveryClient'),
  };
}

/**
 * Read the §4.3 values Terraform published.
 *
 * ABSENT IS A VALUE. `GetParameters` returns unknown names in `InvalidParameters` rather than
 * failing, which is exactly the semantics wanted: five of the seven are conditional in Terraform and
 * their absence means the environment variable is absent too. The required two are enforced by
 * `composeEnvironment`, not here, so that one error message can name the parameter path.
 *
 * @returns { values: {KEY: value}, missing: [KEY], prefix }
 */
async function readGatewayConfig(ctx, deps = {}) {
  const { GetParametersCommand } = require('@aws-sdk/client-ssm');
  const { SSM_PARAMETERS, SSM_HANDLES, SSM_PREFIX } = require('./task-definition');
  const clients = clientsFor(ctx, deps);
  const prefix = SSM_PREFIX;

  // ONE read covering both categories. `composeEnvironment` consumes only the declared
  // SSM_PARAMETERS keys and ignores everything else, so the handles ride along without any risk of
  // being promoted into the container's environment.
  const names = [...SSM_HANDLES, ...SSM_PARAMETERS].map((p) => `${prefix}/${p.key}`);
  let res;
  try {
    // WithDecryption for the SecureString case. Nothing here is a SecureString today — these are
    // secret NAMES and account ids, not secret values — but a deployment that upgrades one should
    // not silently start reading ciphertext.
    res = await clients.ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
  } catch (e) {
    throw new CliError(`ssm:GetParameters failed under ${prefix}`, {
      cause: e,
      detail: 'The operator needs ssm:GetParameters on this path. Terraform publishes it '
        + '(modules/archie/ssm.tf); this reads it.',
    });
  }

  const values = {};
  for (const p of res.Parameters || []) {
    values[String(p.Name).slice(prefix.length + 1)] = p.Value;
  }
  const missing = (res.InvalidParameters || []).map((n) => String(n).slice(prefix.length + 1));
  return { values, missing, prefix };
}

/**
 * Everything else the composition needs, resolved concurrently.
 *
 * Ordered by dependency, not by tidiness: the file system must be resolved before the VPC (mount
 * targets), and the VPC before the security groups (looked up by name WITHIN it). Everything
 * independent of that chain runs alongside it.
 *
 * @param config  the result of readGatewayConfig — passed in rather than read here so the whole
 *                parameter path is fetched ONCE per command, and so a caller that has already
 *                validated it does not pay for a second read.
 */
async function discoverFacts(ctx, config, deps = {}) {
  const clients = clientsFor(ctx, deps);
  const r = ctx.resources;

  // IDENTITY FIRST, and alone. It is an assertion about the credentials in play, so resolving it
  // before anything else means `--account` fails as "you are in the wrong account" rather than as
  // whichever concurrent lookup happened to notice a symptom first. It also gives the file-system
  // ARN a real account to check against, so a cross-account file system is caught even when
  // `--account` was not passed — which is the case where it is most likely to be a surprise.
  const account = await callerAccount(clients, ctx);

  const [agentRepoUri, turnQueueUrl, roles, efs, serviceRegistryArn, secrets] = await Promise.all([
    repositoryUri(clients, r.agentRepo),
    queueUrl(clients, `${r.dispatcherService}-turns.fifo`),
    dispatcherRoles(clients, r),
    dispatcherFileSystem(clients, ctx, config, account),
    dispatcherRegistry(clients, ctx),
    dispatcherSecrets(clients, r),
  ]);

  // Both groups are resolved BY NAME inside the filesystem's VPC — see the file header for the
  // failure that rule exists to prevent.
  const [runtimeSecurityGroupId, dispatcherSecurityGroupId] = await Promise.all([
    securityGroupId(clients, efs.vpcId, `${r.name}-runtime-sg`),
    securityGroupId(clients, efs.vpcId, `${r.name}-dispatcher-sg`),
  ]);

  return {
    account,
    basePolicyArn: basePolicyArnFor(r, account),
    agentRepoUri,
    turnQueueUrl,
    efsFileSystemId: efs.fileSystemId,
    dispatcherAccessPointId: efs.accessPointId,
    vpcId: efs.vpcId,
    // Set-valued and UNORDERED. AWS returns mount targets and a service's subnets in different
    // orders, so anything comparing these must compare them as sets (§5.2). Sorted here so at least
    // the value this CLI produces is stable between runs.
    subnetIds: efs.subnetIds.slice().sort(),
    runtimeSecurityGroupId,
    dispatcherSecurityGroupId,
    serviceRegistryArn,
    executionRoleArn: roles.executionRoleArn,
    taskRoleArn: roles.taskRoleArn,
    secrets: secrets.list,
    credentialSecretName: secrets.credentialSecretName,
  };
}

// ── the individual lookups ───────────────────────────────────────────────────────────────────────

async function callerAccount(clients, ctx) {
  const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const id = await clients.sts.send(new GetCallerIdentityCommand({}));
  const account = id && id.Account;
  if (!account) throw new CliError('sts:GetCallerIdentity returned no account');
  // --account is an assertion, and this is the one place that can honour it before anything is
  // composed against the wrong estate.
  if (ctx.account && ctx.account !== account) {
    throw preflight(`caller is in account ${account}, but --account says ${ctx.account}`);
  }
  return account;
}

async function repositoryUri(clients, repositoryName) {
  const { DescribeRepositoriesCommand } = require('@aws-sdk/client-ecr');
  try {
    const res = await clients.ecr.send(new DescribeRepositoriesCommand({ repositoryNames: [repositoryName] }));
    const repo = (res.repositories || [])[0];
    if (!repo) throw new Error('no repository in response');
    return repo.repositoryUri;
  } catch (e) {
    if (isNotFound(e)) {
      throw preflight(`ECR repository ${repositoryName} does not exist`, {
        cause: e, detail: 'Terraform owns the repositories (modules/archie/ecr.tf). Apply it first.',
      });
    }
    throw new CliError(`ecr:DescribeRepositories ${repositoryName} failed`, { cause: e });
  }
}

async function queueUrl(clients, QueueName) {
  const { GetQueueUrlCommand } = require('@aws-sdk/client-sqs');
  try {
    const res = await clients.sqs.send(new GetQueueUrlCommand({ QueueName }));
    return res.QueueUrl;
  } catch (e) {
    if (isNotFound(e)) {
      throw preflight(`SQS queue ${QueueName} does not exist`, {
        cause: e, detail: 'Terraform owns the turn queue (modules/archie/turn_queue.tf).',
      });
    }
    throw new CliError(`sqs:GetQueueUrl ${QueueName} failed`, { cause: e });
  }
}

async function dispatcherRoles(clients, r) {
  const { GetRoleCommand } = require('@aws-sdk/client-iam');
  const get = async (roleName) => {
    try {
      const res = await clients.iam.send(new GetRoleCommand({ RoleName: roleName }));
      return res.Role.Arn;
    } catch (e) {
      if (isNotFound(e)) {
        throw preflight(`IAM role ${roleName} does not exist`, {
          cause: e, detail: 'Terraform owns the dispatcher roles (modules/archie/iam.tf).',
        });
      }
      throw new CliError(`iam:GetRole ${roleName} failed`, { cause: e });
    }
  };
  const [executionRoleArn, taskRoleArn] = await Promise.all([
    get(`${r.dispatcherService}-execution-role`),
    get(`${r.dispatcherService}-task-role`),
  ]);
  return { executionRoleArn, taskRoleArn };
}

/**
 * The file system and the gateway's access point, from the parameters Terraform publishes — and the
 * VPC and subnets, from the file system itself.
 *
 * THE SPLIT HERE IS THE POINT, and it is not the same rule in both directions:
 *
 *   The file system and access point are TOLD to us. Neither has a name archie can look up. archie
 *   does not own a file system — it mounts the OpenClaw stack's, whose name shares no prefix with
 *   anything here, because that is where ~270 GB of live agent workspaces already are; and an access
 *   point's id is AWS-generated. Terraform holds both (`var.efs_file_system_id`,
 *   `aws_efs_access_point.dispatcher`) and publishes them, so archie composes from the SAME value
 *   Terraform mounts from rather than from something that merely agrees with it.
 *
 *   The VPC and subnets are DERIVED, and must stay derived. EFS allows exactly one VPC per file
 *   system, so the mount targets are the authority — the VPC that is TRUE rather than the one config
 *   claims. A recorded VPC id is precisely what rotted here before: after a VPC move it pointed at
 *   the retired VPC, and the failure surfaced as "no available EFS mount targets in supported AZs",
 *   which reads like an AZ problem rather than a stale id.
 *
 * An earlier version resolved the file system by PAGING every access point in the account and
 * matching a `Name` tag. That worked, and was wrong: a tag is mutable by anyone with EFS write, is
 * not enforced unique, and resolving it wrong is the worst failure this system has — every agent
 * boots on an empty workspace while its history looks deleted, and nothing is raised.
 */
async function dispatcherFileSystem(clients, ctx, config, account) {
  const { DescribeAccessPointsCommand, DescribeMountTargetsCommand } = require('@aws-sdk/client-efs');
  const values = (config && config.values) || {};
  const prefix = (config && config.prefix) || '';

  const fileSystemId = fileSystemIdFromArn(values.EFS_FILE_SYSTEM_ARN, ctx, `${prefix}/EFS_FILE_SYSTEM_ARN`, account);
  const accessPointId = values.DISPATCHER_ACCESS_POINT_ID;
  if (!accessPointId) {
    throw preflight(`${prefix}/DISPATCHER_ACCESS_POINT_ID is not published`, {
      detail: 'Terraform owns the gateway access point and publishes its id (modules/archie/ssm.tf). '
        + 'Apply this deployment before deploying the gateway.',
    });
  }

  // Verify the pair AGREES, rather than trusting two parameters to have been written together. They
  // are written by one apply today, so a mismatch means a hand-edit or a half-finished migration —
  // and mounting the right access point on the wrong file system is not an error ECS reports.
  let accessPoint;
  try {
    const res = await clients.efs.send(new DescribeAccessPointsCommand({ AccessPointId: accessPointId }));
    accessPoint = (res.AccessPoints || [])[0];
  } catch (e) {
    if (!isNotFound(e)) throw new CliError(`efs:DescribeAccessPoints ${accessPointId} failed`, { cause: e });
    accessPoint = null;
  }
  if (!accessPoint) {
    throw preflight(`EFS access point ${accessPointId} does not exist`, {
      detail: `Published at ${prefix}/DISPATCHER_ACCESS_POINT_ID. Re-apply Terraform for this deployment.`,
    });
  }
  if (accessPoint.FileSystemId !== fileSystemId) {
    throw preflight(`access point ${accessPointId} belongs to ${accessPoint.FileSystemId}, not ${fileSystemId}`, {
      detail: `${prefix}/EFS_FILE_SYSTEM_ARN and ${prefix}/DISPATCHER_ACCESS_POINT_ID disagree. `
        + 'Mounting the right access point on the wrong file system is not an error ECS reports.',
    });
  }

  const mountTargets = await clients.efs.send(new DescribeMountTargetsCommand({ FileSystemId: fileSystemId }));
  const targets = (mountTargets.MountTargets || []).filter((m) => !m.LifeCycleState || m.LifeCycleState === 'available');
  const vpcIds = [...new Set(targets.map((m) => m.VpcId).filter(Boolean))];
  if (vpcIds.length !== 1) {
    // EFS allows exactly one VPC per file system, so this cannot legitimately be anything but 1.
    // Zero means no available mount targets, which breaks runtime placement as well as this.
    throw preflight(`${fileSystemId} resolves to ${vpcIds.length} VPCs (${vpcIds.join(', ') || 'none'})`, {
      detail: 'EFS allows one VPC per file system; 0 means no mount target is available.',
    });
  }

  return {
    accessPointId,
    fileSystemId,
    vpcId: vpcIds[0],
    subnetIds: [...new Set(targets.map((m) => m.SubnetId).filter(Boolean))],
  };
}

/**
 * `arn:aws:elasticfilesystem:<region>:<account>:file-system/<fs-id>` — parsed, and ASSERTED.
 *
 * The ARN is published rather than the bare id precisely so this assertion is possible: a `fs-…` is
 * valid-looking in every account on earth, and a cross-account or cross-region one would compose
 * cleanly and then fail at task start with a mount error that names neither. The region check is not
 * theoretical — a profile's configured region is routinely not the deployment's, which is why
 * `--region` is never defaulted anywhere in this CLI.
 */
function fileSystemIdFromArn(arn, ctx, path, callerAccountId) {
  if (!arn) {
    throw preflight(`${path} is not published`, {
      detail: 'Terraform owns which file system this deployment mounts (var.efs_file_system_id) and '
        + 'publishes its ARN (modules/archie/ssm.tf). archie cannot derive it: the file system is not '
        + 'archie\'s, and its name shares no prefix with --name.',
    });
  }
  const m = /^arn:[^:]*:elasticfilesystem:([^:]+):([^:]+):file-system\/(fs-[0-9a-f]+)$/.exec(String(arn).trim());
  if (!m) throw preflight(`${path} is not an EFS file system ARN: ${arn}`);
  const [, region, account, fileSystemId] = m;
  if (region !== ctx.region) {
    throw preflight(`${path} is in ${region}, but --region is ${ctx.region}`, {
      detail: 'A file system in another region cannot be mounted; the task would fail to start.',
    });
  }
  // Against the RESOLVED caller account when there is one, falling back to `--account`. The resolved
  // one is the stronger check: it applies whether or not the operator passed the flag, and a
  // cross-account file system is exactly the kind of thing nobody thinks to assert.
  const expected = callerAccountId || ctx.account;
  if (expected && account !== expected) {
    throw preflight(`${path} is in account ${account}, but this deployment is in ${expected}`, {
      detail: 'EFS cannot be mounted across accounts; the task would fail to start.',
    });
  }
  return fileSystemId;
}

async function securityGroupId(clients, vpcId, groupName) {
  const { DescribeSecurityGroupsCommand } = require('@aws-sdk/client-ec2');
  const res = await clients.ec2.send(new DescribeSecurityGroupsCommand({
    Filters: [{ Name: 'vpc-id', Values: [vpcId] }, { Name: 'group-name', Values: [groupName] }],
  }));
  const group = (res.SecurityGroups || [])[0];
  if (!group) {
    throw preflight(`security group ${groupName} does not exist in ${vpcId}`, {
      detail: 'Terraform owns the groups (modules/archie/security_groups.tf).',
    });
  }
  return group.GroupId;
}

/** The Cloud Map registration the service attaches to. `dispatcher` in the `<name>.internal` namespace. */
async function dispatcherRegistry(clients, ctx) {
  const { ListNamespacesCommand, ListServicesCommand } = require('@aws-sdk/client-servicediscovery');
  const namespaceName = `${ctx.name}.internal`;

  const namespaces = await clients.discovery.send(new ListNamespacesCommand({ MaxResults: 100 }));
  const ns = (namespaces.Namespaces || []).find((n) => n.Name === namespaceName);
  if (!ns) {
    throw preflight(`Cloud Map namespace ${namespaceName} does not exist`, {
      detail: 'Terraform owns service discovery (modules/archie/service_discovery.tf).',
    });
  }

  const services = await clients.discovery.send(new ListServicesCommand({
    Filters: [{ Name: 'NAMESPACE_ID', Values: [ns.Id], Condition: 'EQ' }], MaxResults: 100,
  }));
  const svc = (services.Services || []).find((s) => s.Name === 'dispatcher');
  if (!svc) {
    throw preflight(`Cloud Map service "dispatcher" does not exist in ${namespaceName}`, {
      detail: 'Terraform owns service discovery (modules/archie/service_discovery.tf).',
    });
  }
  return svc.Arn;
}

/**
 * The container's `secrets` block: names paired with the ARN each resolves through.
 *
 * ARNs, not names, matching what Terraform emits — Secrets Manager appends a random 6-character
 * suffix to every ARN, so the ARN is not derivable from the name and must be looked up. Connector is
 * OPTIONAL and its absence is a legitimate deployment (the dispatcher then has no fallback key),
 * which is why it is the one entry allowed to be missing.
 *
 * DescribeSecret, never GetSecretValue. This CLI verifies a secret exists; it never reads one.
 */
async function dispatcherSecrets(clients, r) {
  const { DescribeSecretCommand } = require('@aws-sdk/client-secrets-manager');
  const arnFor = async (secretId, { optional = false } = {}) => {
    try {
      const res = await clients.secrets.send(new DescribeSecretCommand({ SecretId: secretId }));
      return res.ARN;
    } catch (e) {
      if (isNotFound(e)) {
        if (optional) return null;
        throw preflight(`secret ${secretId} does not exist`, {
          cause: e, detail: 'Terraform owns the secret RESOURCES (modules/archie/secrets.tf); the '
            + 'values are supplied to it.',
        });
      }
      throw new CliError(`secretsmanager:DescribeSecret ${secretId} failed`, { cause: e });
    }
  };

  const [botToken, appToken, sharedSecret, connector] = await Promise.all([
    arnFor(`${r.name}-slack-bot-token`),
    arnFor(`${r.name}-slack-app-token`),
    arnFor(r.dispatcherSharedSecret),
    arnFor(r.credentialSecret, { optional: true }),
  ]);

  const list = [
    { name: 'SLACK_BOT_TOKEN', valueFrom: botToken },
    { name: 'SLACK_APP_TOKEN', valueFrom: appToken },
    { name: 'DISPATCHER_SHARED_SECRET', valueFrom: sharedSecret },
  ];
  if (connector) list.push({ name: 'CONNECTOR_API_KEY', valueFrom: connector });

  return { list, credentialSecretName: connector ? r.credentialSecret : null };
}

module.exports = { discoverFacts, readGatewayConfig, fileSystemIdFromArn, clientsFor };

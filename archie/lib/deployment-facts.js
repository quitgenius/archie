'use strict';

// The AWS facts the dispatcher task definition is composed from.
//
// GATEWAY-OWNERSHIP-PLAN.md §4.1 and §5.2. Everything here is DISCOVERED — resolved from the
// account by a name derived from `--name`, or read off a resource Terraform owns. Nothing is read
// from process.env, and nothing is read from the DEPLOYED task definition.
//
// THAT SECOND EXCLUSION IS THE LOAD-BEARING ONE, and it is the opposite of what preflight does.
// `cmd/preflight.js` deliberately sources the filesystem id, the VPC and the secret names FROM the
// running task definition, because its job is to check the deployment rather than the operator's
// shell. Composition cannot do that: it would be circular (the composed value would always agree
// with the deployed one, so the §6 gate would prove nothing), and it would not work at all in the
// case the whole plan exists to enable — `terraform apply` followed by `archie deploy` in an account
// where no service has ever run.
//
// DISCOVERY IS ALSO MORE CORRECT THAN CONFIGURATION, not merely equivalent. The VPC comes from the
// filesystem's mount targets, so it is the VPC that is TRUE rather than the one a variable claims;
// this exact divergence has already happened here, and it surfaced as "no available EFS mount
// targets in supported AZs", which reads like an AZ problem rather than a stale id. The runtime
// security group is resolved BY NAME within that VPC for the same reason: after a VPC move the
// recorded id pointed at the retired VPC's copy of the group — same NAME, different id. The name
// survives; the id does not.

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
  const { SSM_PARAMETERS, ssmPrefixFor } = require('./task-definition');
  const clients = clientsFor(ctx, deps);
  const prefix = ssmPrefixFor(ctx.name);

  const names = SSM_PARAMETERS.map((p) => `${prefix}/${p.key}`);
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
 */
async function discoverFacts(ctx, deps = {}) {
  const clients = clientsFor(ctx, deps);
  const r = ctx.resources;

  const [account, agentRepoUri, turnQueueUrl, roles, efs, serviceRegistryArn, secrets] = await Promise.all([
    callerAccount(clients, ctx),
    repositoryUri(clients, r.agentRepo),
    queueUrl(clients, `${r.dispatcherService}-turns.fifo`),
    dispatcherRoles(clients, r),
    dispatcherFileSystem(clients, r),
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
 * The file system, via the access point Terraform created for the gateway.
 *
 * THE FILE SYSTEM IS NOT DERIVABLE FROM `--name`. archie does not own one: it mounts the OpenClaw
 * stack's, whose name has a different prefix entirely, and it does so because that is where ~270 GB
 * of live agent workspaces already are. So the chain starts from the one EFS object Terraform DOES
 * name from `--name` — the gateway's access point, tagged `Name = <name>-dispatcher-data`
 * (modules/archie/efs.tf) — and the file system falls out of it.
 *
 * DescribeAccessPoints has no tag filter, so this pages the account's access points and matches.
 * That list is long in a real deployment (the dispatcher creates one per agent at runtime, plus
 * whatever BDD leaked), which is why the match is on the exact tag and never on a prefix.
 */
async function dispatcherFileSystem(clients, r) {
  const { DescribeAccessPointsCommand, DescribeMountTargetsCommand } = require('@aws-sdk/client-efs');
  const wanted = `${r.dispatcherService}-data`;

  let NextToken;
  let found = null;
  do {
    const res = await clients.efs.send(new DescribeAccessPointsCommand({ MaxResults: 100, NextToken }));
    for (const ap of res.AccessPoints || []) {
      if ((ap.Tags || []).some((t) => t.Key === 'Name' && t.Value === wanted)) { found = ap; break; }
    }
    NextToken = found ? undefined : res.NextToken;
  } while (NextToken);

  if (!found) {
    throw preflight(`no EFS access point tagged Name=${wanted}`, {
      detail: 'Terraform owns the gateway access point (modules/archie/efs.tf). It is also the only '
        + 'way to discover which file system this deployment mounts — archie does not own one.',
    });
  }

  const mountTargets = await clients.efs.send(new DescribeMountTargetsCommand({ FileSystemId: found.FileSystemId }));
  const targets = (mountTargets.MountTargets || []).filter((m) => !m.LifeCycleState || m.LifeCycleState === 'available');
  const vpcIds = [...new Set(targets.map((m) => m.VpcId).filter(Boolean))];
  if (vpcIds.length !== 1) {
    // EFS allows exactly one VPC per file system, so this cannot legitimately be anything but 1.
    // Zero means no available mount targets, which breaks runtime placement as well as this.
    throw preflight(`${found.FileSystemId} resolves to ${vpcIds.length} VPCs (${vpcIds.join(', ') || 'none'})`, {
      detail: 'EFS allows one VPC per file system; 0 means no mount target is available.',
    });
  }

  return {
    accessPointId: found.AccessPointId,
    fileSystemId: found.FileSystemId,
    vpcId: vpcIds[0],
    subnetIds: [...new Set(targets.map((m) => m.SubnetId).filter(Boolean))],
  };
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

module.exports = { discoverFacts, readGatewayConfig, clientsFor };

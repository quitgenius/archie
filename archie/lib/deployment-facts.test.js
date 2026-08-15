'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverFacts, readGatewayConfig } = require('./deployment-facts');
const { createContext } = require('./context');
const { EXIT } = require('./exit');

const CTX = () => createContext({ region: 'us-east-1', name: 'agent-gn0p84' }, { needsAws: true }, {});

/** Dispatch on the command class name — the same shape the AWS SDK v3 clients present. */
const clientFrom = (handlers) => ({
  send: async (cmd) => {
    const kind = cmd.constructor.name;
    const handler = handlers[kind];
    if (!handler) throw new Error(`unexpected command ${kind}`);
    return handler(cmd.input);
  },
});

const notFound = (name) => { const e = new Error(name); e.name = name; throw e; };

const AP = {
  AccessPointId: 'fsap-1',
  FileSystemId: 'fs-1',
  Tags: [{ Key: 'Name', Value: 'agent-gn0p84-dispatcher-data' }],
};

function clients(over = {}) {
  return {
    sts: clientFrom({ GetCallerIdentityCommand: () => ({ Account: '543510375323' }) }),
    ecr: clientFrom({
      DescribeRepositoriesCommand: ({ repositoryNames }) => ({
        repositories: [{ repositoryUri: `1.dkr.ecr.us-east-1.amazonaws.com/${repositoryNames[0]}` }],
      }),
    }),
    sqs: clientFrom({ GetQueueUrlCommand: ({ QueueName }) => ({ QueueUrl: `https://sqs/${QueueName}` }) }),
    iam: clientFrom({ GetRoleCommand: ({ RoleName }) => ({ Role: { Arn: `arn:aws:iam::543510375323:role/${RoleName}` } }) }),
    efs: clientFrom({
      DescribeAccessPointsCommand: () => ({ AccessPoints: [AP] }),
      DescribeMountTargetsCommand: () => ({
        MountTargets: [
          { VpcId: 'vpc-1', SubnetId: 'subnet-c', LifeCycleState: 'available' },
          { VpcId: 'vpc-1', SubnetId: 'subnet-a', LifeCycleState: 'available' },
        ],
      }),
    }),
    ec2: clientFrom({
      DescribeSecurityGroupsCommand: ({ Filters }) => {
        const name = Filters.find((f) => f.Name === 'group-name').Values[0];
        return { SecurityGroups: [{ GroupId: `sg-${name}` }] };
      },
    }),
    secrets: clientFrom({ DescribeSecretCommand: ({ SecretId }) => ({ ARN: `arn:secret:${SecretId}-AbCdEf` }) }),
    discovery: clientFrom({
      ListNamespacesCommand: () => ({ Namespaces: [{ Id: 'ns-1', Name: 'redacted-internal-host.example' }] }),
      ListServicesCommand: () => ({ Services: [{ Name: 'dispatcher', Arn: 'arn:servicediscovery:svc/1' }] }),
    }),
    ssm: clientFrom({
      GetParametersCommand: ({ Names }) => ({
        Parameters: Names.filter((n) => !/DATADOG/.test(n)).map((Name) => ({ Name, Value: `v:${Name.split('/').pop()}` })),
        InvalidParameters: Names.filter((n) => /DATADOG/.test(n)),
      }),
    }),
    ...over,
  };
}

test('every fact is derived from --name or discovered — nothing is read from the environment', () => {
  // Guard against a regression to process.env: the previous generation of this code resolved these
  // with fallbacks, and every fallback was a literal from one sandbox.
  //
  // COMMENTS ARE STRIPPED FIRST. The naive version of this test matched the file's own header
  // explaining that it does not read process.env — a guard that fails on its own documentation is
  // one someone deletes rather than fixes.
  const src = require('node:fs').readFileSync(`${__dirname}/deployment-facts.js`, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.equal(/process\.env/.test(code), false, 'deployment-facts must never read process.env');
  // ...and the stripper actually strips, or the assertion above is vacuous.
  assert.match(src, /process\.env/);
});

test('discoverFacts resolves the whole set from one name', async () => {
  const facts = await discoverFacts(CTX(), { clients: clients() });
  assert.equal(facts.account, '543510375323');
  assert.equal(facts.basePolicyArn, 'arn:aws:iam::543510375323:policy/agent-gn0p84core-base');
  assert.match(facts.agentRepoUri, /agent-gn0p84core$/);
  assert.equal(facts.turnQueueUrl, 'https://sqs/agent-gn0p84-dispatcher-turns.fifo');
  assert.equal(facts.efsFileSystemId, 'fs-1');
  assert.equal(facts.dispatcherAccessPointId, 'fsap-1');
  assert.equal(facts.vpcId, 'vpc-1');
  assert.equal(facts.runtimeSecurityGroupId, 'sg-agent-gn0p84-runtime-sg');
  assert.equal(facts.dispatcherSecurityGroupId, 'sg-agent-gn0p84-dispatcher-sg');
  assert.equal(facts.executionRoleArn, 'arn:aws:iam::543510375323:role/agent-gn0p84-dispatcher-execution-role');
  assert.equal(facts.taskRoleArn, 'arn:aws:iam::543510375323:role/agent-gn0p84-dispatcher-task-role');
  assert.equal(facts.serviceRegistryArn, 'arn:servicediscovery:svc/1');
});

test('the file system is found via the access point Terraform names, not from a variable', async () => {
  // archie does not own a file system — it mounts the OpenClaw stack's, whose name has a different
  // prefix entirely. The gateway access point is the only EFS object named from --name.
  const facts = await discoverFacts(CTX(), { clients: clients() });
  assert.equal(facts.efsFileSystemId, AP.FileSystemId);
});

test('an access point tagged for another deployment is not adopted', async () => {
  const efs = clientFrom({
    DescribeAccessPointsCommand: () => ({
      AccessPoints: [{ ...AP, Tags: [{ Key: 'Name', Value: 'agent-6guk92-dispatcher-data' }] }],
    }),
    DescribeMountTargetsCommand: () => ({ MountTargets: [] }),
  });
  await assert.rejects(discoverFacts(CTX(), { clients: clients({ efs }) }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /no EFS access point tagged Name=agent-gn0p84-dispatcher-data/.test(e.message));
});

test('access point pages are followed — a real account has hundreds', async () => {
  let calls = 0;
  const efs = clientFrom({
    DescribeAccessPointsCommand: () => {
      calls += 1;
      return calls === 1
        ? { AccessPoints: [{ AccessPointId: 'agent-b3bg9d', FileSystemId: 'fs-1', Tags: [{ Key: 'managed-by', Value: 'agentcore' }] }], NextToken: 'more' }
        : { AccessPoints: [AP] };
    },
    DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', SubnetId: 'subnet-a' }] }),
  });
  const facts = await discoverFacts(CTX(), { clients: clients({ efs }) });
  assert.equal(facts.dispatcherAccessPointId, 'fsap-1');
  assert.equal(calls, 2);
});

test('the VPC comes from the mount targets — the VPC that is TRUE, not one a variable claims', async () => {
  const facts = await discoverFacts(CTX(), { clients: clients() });
  assert.equal(facts.vpcId, 'vpc-1');
  // Subnets are set-valued and returned unordered by AWS, so they are sorted rather than trusted.
  assert.deepEqual(facts.subnetIds, ['subnet-a', 'subnet-c']);
});

test('a file system with no available mount target refuses rather than composing a half-answer', async () => {
  const efs = clientFrom({
    DescribeAccessPointsCommand: () => ({ AccessPoints: [AP] }),
    DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', LifeCycleState: 'deleting' }] }),
  });
  await assert.rejects(discoverFacts(CTX(), { clients: clients({ efs }) }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /resolves to 0 VPCs/.test(e.message));
});

test('security groups are resolved BY NAME within the filesystem VPC', async () => {
  // Resolving by id is what rotted: after a VPC move the recorded id pointed at the retired VPC's
  // copy of the group — same NAME, different id. The name survives; the id does not.
  const seen = [];
  const ec2 = clientFrom({
    DescribeSecurityGroupsCommand: ({ Filters }) => {
      seen.push(Object.fromEntries(Filters.map((f) => [f.Name, f.Values[0]])));
      return { SecurityGroups: [{ GroupId: 'sg-x' }] };
    },
  });
  await discoverFacts(CTX(), { clients: clients({ ec2 }) });
  assert.deepEqual(seen.map((s) => s['vpc-id']), ['vpc-1', 'vpc-1']);
  assert.deepEqual(seen.map((s) => s['group-name']).sort(), ['agent-gn0p84-dispatcher-sg', 'agent-gn0p84-runtime-sg']);
});

test('missing infrastructure exits PREFLIGHT and names what Terraform owns', async () => {
  const cases = [
    ['ecr', clientFrom({ DescribeRepositoriesCommand: () => notFound('RepositoryNotFoundException') }), /ECR repository agent-gn0p84core/],
    ['sqs', clientFrom({ GetQueueUrlCommand: () => notFound('QueueDoesNotExist') }), /SQS queue agent-gn0p84-dispatcher-turns\.fifo/],
    ['iam', clientFrom({ GetRoleCommand: () => notFound('NoSuchEntity') }), /IAM role agent-gn0p84-dispatcher-/],
  ];
  for (const [key, stub, expected] of cases) {
    await assert.rejects(discoverFacts(CTX(), { clients: clients({ [key]: stub }) }),
      (e) => e.exitCode === EXIT.PREFLIGHT && expected.test(e.message), `${key} must report PREFLIGHT`);
  }
});

test('Connector is the one secret allowed to be absent', async () => {
  const secrets = clientFrom({
    DescribeSecretCommand: ({ SecretId }) => (/connector/.test(SecretId)
      ? notFound('ResourceNotFoundException')
      : { ARN: `arn:secret:${SecretId}` }),
  });
  const facts = await discoverFacts(CTX(), { clients: clients({ secrets }) });
  assert.equal(facts.credentialSecretName, null);
  assert.deepEqual(facts.secrets.map((s) => s.name), ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISPATCHER_SHARED_SECRET']);

  // A missing SLACK token is not: the gateway cannot connect at all without it.
  const noSlack = clientFrom({
    DescribeSecretCommand: ({ SecretId }) => (/slack-bot/.test(SecretId)
      ? notFound('ResourceNotFoundException')
      : { ARN: `arn:secret:${SecretId}` }),
  });
  await assert.rejects(discoverFacts(CTX(), { clients: clients({ secrets: noSlack }) }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /agent-gn0p84-slack-bot-token does not exist/.test(e.message));
});

test('secret ARNs are looked up, never derived — Secrets Manager appends a random suffix', async () => {
  const facts = await discoverFacts(CTX(), { clients: clients() });
  const bot = facts.secrets.find((s) => s.name === 'SLACK_BOT_TOKEN');
  assert.equal(bot.valueFrom, 'arn:secret:agent-gn0p84-slack-bot-token-AbCdEf');
});

test('--account is asserted before anything is composed against the wrong estate', async () => {
  const ctx = createContext({ region: 'us-east-1', account: '999999999999' }, { needsAws: true }, {});
  await assert.rejects(discoverFacts(ctx, { clients: clients() }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /caller is in account 543510375323/.test(e.message));
});

test('readGatewayConfig returns absent parameters as absent, not as an error', async () => {
  // Five of the seven are conditional in Terraform, and GetParameters reports unknown names in
  // InvalidParameters rather than failing — which is exactly the semantics wanted.
  const { values, missing, prefix } = await readGatewayConfig(CTX(), { clients: clients() });
  assert.equal(prefix, '/archie/agent-gn0p84/gateway');
  assert.equal(values.DEPLOYMENT_ENVIRONMENT, 'v:DEPLOYMENT_ENVIRONMENT');
  assert.deepEqual(missing.sort(), ['DATADOG_API_KEY_SECRET', 'DATADOG_APP_KEY_SECRET']);
});

test('an SSM permission failure names the grant rather than surfacing a bare SDK error', async () => {
  const ssm = clientFrom({ GetParametersCommand: () => { const e = new Error('AccessDenied'); e.name = 'AccessDeniedException'; throw e; } });
  await assert.rejects(readGatewayConfig(CTX(), { clients: clients({ ssm }) }),
    (e) => /ssm:GetParameters failed under \/archie\/agent-gn0p84\/gateway/.test(e.message));
});

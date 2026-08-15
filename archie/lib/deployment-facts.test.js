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

const AP = { AccessPointId: 'fsap-1', FileSystemId: 'fs-1' };

const FS_ARN = 'arn:aws:elasticfilesystem:us-east-1:543510375323:file-system/fs-1';

/** What Terraform published, keyed by the parameter's leaf name. */
const PARAMETERS = {
  EFS_FILE_SYSTEM_ARN: FS_ARN,
  DISPATCHER_ACCESS_POINT_ID: AP.AccessPointId,
};
const valueFor = (name) => {
  const key = name.split('/').pop();
  return key in PARAMETERS ? PARAMETERS[key] : `v:${key}`;
};

/** discoverFacts takes the parameter read as an argument, so tests supply it explicitly. */
const config = (over = {}) => ({
  prefix: '/archie/gateway',
  values: { ...PARAMETERS, ...over },
  missing: [],
});

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
      DescribeAccessPointsCommand: ({ AccessPointId }) => ({ AccessPoints: AccessPointId === AP.AccessPointId ? [AP] : [] }),
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
        Parameters: Names.filter((n) => !/DATADOG/.test(n)).map((Name) => ({ Name, Value: valueFor(Name) })),
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
  const facts = await discoverFacts(CTX(), config(), { clients: clients() });
  assert.equal(facts.account, '543510375323');
  assert.equal(facts.basePolicyArn, 'arn:aws:iam::543510375323:policy/agent-gn0p84core-base');
  assert.match(facts.agentRepoUri, /agent-gn0p84core$/);
  assert.equal(facts.turnQueueUrl, 'https://sqs/agent-gn0p84-dispatcher-turns.fifo');
  assert.equal(facts.efsFileSystemId, 'fs-1');
  assert.equal(facts.dispatcherAccessPointId, 'fsap-1');
  assert.equal(facts.vpcId, 'vpc-1');
  assert.equal(facts.runtimeSecurityGroupId, 'sg-agent-gn0p84-runtime-sg');
  assert.equal(facts.dispatcherSecurityGroupId, 'sg-agent-gn0p84-dispatcher-sg');
  // The hydrator's own group — the gateway admits port 9090 only from the runtime and hydrator
  // groups, so reusing the dispatcher's would surface as a bare "fetch failed" from the manager API.
  assert.equal(facts.cronHydratorSecurityGroupId, 'sg-agent-gn0p84-dispatcher-cron-hydrator-sg');
  assert.equal(facts.executionRoleArn, 'arn:aws:iam::543510375323:role/agent-gn0p84-dispatcher-execution-role');
  assert.equal(facts.taskRoleArn, 'arn:aws:iam::543510375323:role/agent-gn0p84-dispatcher-task-role');
  assert.equal(facts.serviceRegistryArn, 'arn:servicediscovery:svc/1');
});

test('the file system and access point are TOLD to archie, not looked up by tag', async () => {
  // Neither has a name archie can resolve. The file system is not archie's — it mounts the OpenClaw
  // stack's, whose name shares no prefix with anything here — and an access point id is
  // AWS-generated. Terraform holds both and publishes them, so archie composes from the SAME value
  // Terraform mounts from rather than from something that merely agrees with it.
  const facts = await discoverFacts(CTX(), config(), { clients: clients() });
  assert.equal(facts.efsFileSystemId, 'fs-1');
  assert.equal(facts.dispatcherAccessPointId, 'fsap-1');
});

test('the access point is never resolved by scanning tags', async () => {
  // The previous implementation paged every access point in the account and matched a `Name` tag.
  // A tag is mutable by anyone with EFS write and is not enforced unique, and resolving it wrong is
  // the worst failure this system has: every agent boots on an empty workspace while its history
  // looks deleted, and nothing is raised. Asserted as a call shape, because the wrong version also
  // returned the right answer in the happy path.
  const calls = [];
  const efs = clientFrom({
    DescribeAccessPointsCommand: (input) => { calls.push(input); return { AccessPoints: [AP] }; },
    DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', SubnetId: 'subnet-a' }] }),
  });
  await discoverFacts(CTX(), config(), { clients: clients({ efs }) });
  assert.deepEqual(calls, [{ AccessPointId: 'fsap-1' }]);
  assert.equal(calls.some((c) => 'MaxResults' in c || 'NextToken' in c), false, 'must not page the account');
});

test('a published access point that does not exist refuses', async () => {
  const efs = clientFrom({
    DescribeAccessPointsCommand: () => ({ AccessPoints: [] }),
    DescribeMountTargetsCommand: () => ({ MountTargets: [] }),
  });
  await assert.rejects(discoverFacts(CTX(), config(), { clients: clients({ efs }) }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /EFS access point fsap-1 does not exist/.test(e.message));
});

test('the two published handles must AGREE — a mismatch is not an error ECS reports', async () => {
  // They are written by one apply today, so disagreement means a hand-edit or a half-finished
  // migration. Mounting the right access point on the wrong file system starts cleanly and serves
  // the wrong directory.
  const efs = clientFrom({
    DescribeAccessPointsCommand: () => ({ AccessPoints: [{ AccessPointId: 'fsap-1', FileSystemId: 'fs-OTHER' }] }),
    DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', SubnetId: 'subnet-a' }] }),
  });
  await assert.rejects(discoverFacts(CTX(), config(), { clients: clients({ efs }) }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /belongs to fs-OTHER, not fs-1/.test(e.message));
});

test('an unpublished handle refuses, and says which parameter and who owns it', async () => {
  for (const [key, expected] of [
    ['EFS_FILE_SYSTEM_ARN', /EFS_FILE_SYSTEM_ARN is not published/],
    ['DISPATCHER_ACCESS_POINT_ID', /DISPATCHER_ACCESS_POINT_ID is not published/],
  ]) {
    const values = { ...PARAMETERS };
    delete values[key];
    await assert.rejects(discoverFacts(CTX(), { prefix: '/archie/gateway', values, missing: [key] },
      { clients: clients() }), (e) => e.exitCode === EXIT.PREFLIGHT && expected.test(e.message));
  }
});

test('the file system ARN is asserted against the region and account, not just parsed', async () => {
  // This is why an ARN is published rather than a bare id: `fs-…` is valid-looking in every account
  // on earth, and a cross-region one composes cleanly and then fails at task start with a mount
  // error that names neither. A profile's configured region is routinely not the deployment's.
  const wrongRegion = config({ EFS_FILE_SYSTEM_ARN: 'arn:aws:elasticfilesystem:eu-west-2:543510375323:file-system/fs-1' });
  await assert.rejects(discoverFacts(CTX(), wrongRegion, { clients: clients() }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /is in eu-west-2, but --region is us-east-1/.test(e.message));

  // Checked against the RESOLVED caller account, so it fires with no --account flag at all.
  const wrongAccount = config({ EFS_FILE_SYSTEM_ARN: 'arn:aws:elasticfilesystem:us-east-1:999999999999:file-system/fs-1' });
  await assert.rejects(discoverFacts(CTX(), wrongAccount, { clients: clients() }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /is in account 999999999999, but this deployment is in 543510375323/.test(e.message));

  const malformed = config({ EFS_FILE_SYSTEM_ARN: 'fs-1' });
  await assert.rejects(discoverFacts(CTX(), malformed, { clients: clients() }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /is not an EFS file system ARN/.test(e.message));
});

test('the VPC comes from the mount targets — the VPC that is TRUE, not one a variable claims', async () => {
  const facts = await discoverFacts(CTX(), config(), { clients: clients() });
  assert.equal(facts.vpcId, 'vpc-1');
  // Subnets are set-valued and returned unordered by AWS, so they are sorted rather than trusted.
  assert.deepEqual(facts.subnetIds, ['subnet-a', 'subnet-c']);
});

test('a file system with no available mount target refuses rather than composing a half-answer', async () => {
  const efs = clientFrom({
    DescribeAccessPointsCommand: () => ({ AccessPoints: [AP] }),
    DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', LifeCycleState: 'deleting' }] }),
  });
  await assert.rejects(discoverFacts(CTX(), config(), { clients: clients({ efs }) }),
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
  await discoverFacts(CTX(), config(), { clients: clients({ ec2 }) });
  assert.deepEqual(seen.map((s) => s['vpc-id']), ['vpc-1', 'vpc-1', 'vpc-1']);
  assert.deepEqual(seen.map((s) => s['group-name']).sort(),
    ['agent-gn0p84-dispatcher-cron-hydrator-sg', 'agent-gn0p84-dispatcher-sg', 'agent-gn0p84-runtime-sg']);
});

test('missing infrastructure exits PREFLIGHT and names what Terraform owns', async () => {
  const cases = [
    ['ecr', clientFrom({ DescribeRepositoriesCommand: () => notFound('RepositoryNotFoundException') }), /ECR repository agent-gn0p84core/],
    ['sqs', clientFrom({ GetQueueUrlCommand: () => notFound('QueueDoesNotExist') }), /SQS queue agent-gn0p84-dispatcher-turns\.fifo/],
    ['iam', clientFrom({ GetRoleCommand: () => notFound('NoSuchEntity') }), /IAM role agent-gn0p84-dispatcher-/],
  ];
  for (const [key, stub, expected] of cases) {
    await assert.rejects(discoverFacts(CTX(), config(), { clients: clients({ [key]: stub }) }),
      (e) => e.exitCode === EXIT.PREFLIGHT && expected.test(e.message), `${key} must report PREFLIGHT`);
  }
});

test('Connector is the one secret allowed to be absent', async () => {
  const secrets = clientFrom({
    DescribeSecretCommand: ({ SecretId }) => (/connector/.test(SecretId)
      ? notFound('ResourceNotFoundException')
      : { ARN: `arn:secret:${SecretId}` }),
  });
  const facts = await discoverFacts(CTX(), config(), { clients: clients({ secrets }) });
  assert.equal(facts.credentialSecretName, null);
  assert.deepEqual(facts.secrets.map((s) => s.name), ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISPATCHER_SHARED_SECRET']);

  // A missing SLACK token is not: the gateway cannot connect at all without it.
  const noSlack = clientFrom({
    DescribeSecretCommand: ({ SecretId }) => (/slack-bot/.test(SecretId)
      ? notFound('ResourceNotFoundException')
      : { ARN: `arn:secret:${SecretId}` }),
  });
  await assert.rejects(discoverFacts(CTX(), config(), { clients: clients({ secrets: noSlack }) }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /agent-gn0p84-slack-bot-token does not exist/.test(e.message));
});

test('secret ARNs are looked up, never derived — Secrets Manager appends a random suffix', async () => {
  const facts = await discoverFacts(CTX(), config(), { clients: clients() });
  const bot = facts.secrets.find((s) => s.name === 'SLACK_BOT_TOKEN');
  assert.equal(bot.valueFrom, 'arn:secret:agent-gn0p84-slack-bot-token-AbCdEf');
});

test('--account is asserted before anything is composed against the wrong estate', async () => {
  const ctx = createContext({ region: 'us-east-1', account: '999999999999' }, { needsAws: true }, {});
  await assert.rejects(discoverFacts(ctx, config(), { clients: clients() }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /caller is in account 543510375323/.test(e.message));
});

test('readGatewayConfig returns absent parameters as absent, not as an error', async () => {
  // Five of the seven are conditional in Terraform, and GetParameters reports unknown names in
  // InvalidParameters rather than failing — which is exactly the semantics wanted.
  const { values, missing, prefix } = await readGatewayConfig(CTX(), { clients: clients() });
  assert.equal(prefix, '/archie/gateway');
  assert.equal(values.DEPLOYMENT_ENVIRONMENT, 'v:DEPLOYMENT_ENVIRONMENT');
  assert.deepEqual(missing.sort(), ['DATADOG_API_KEY_SECRET', 'DATADOG_APP_KEY_SECRET']);
  // ONE read covers both categories, so discovery and composition cannot see different generations
  // of the same parameter path.
  assert.equal(values.EFS_FILE_SYSTEM_ARN, FS_ARN);
  assert.equal(values.DISPATCHER_ACCESS_POINT_ID, 'fsap-1');
});

test('an SSM permission failure names the grant rather than surfacing a bare SDK error', async () => {
  const ssm = clientFrom({ GetParametersCommand: () => { const e = new Error('AccessDenied'); e.name = 'AccessDeniedException'; throw e; } });
  await assert.rejects(readGatewayConfig(CTX(), { clients: clients({ ssm }) }),
    (e) => /ssm:GetParameters failed under \/archie\/gateway/.test(e.message));
});

test('the SSM read is BATCHED — GetParameters rejects more than 10 names outright', async () => {
  // Found live: the 11th published parameter turned a working read into a ValidationException
  // ("Member must have length less than or equal to 10") that failed the WHOLE read rather than
  // truncating. Before that the single call happened to fit, which is the kind of limit you only
  // meet by crossing it — and it would have taken `gateway deploy` down with it, not just hydration.
  const batches = [];
  const ssm = clientFrom({
    GetParametersCommand: ({ Names }) => {
      batches.push(Names.length);
      if (Names.length > 10) { const e = new Error('too many'); e.name = 'ValidationException'; throw e; }
      return {
        Parameters: Names.filter((n) => valueFor(n) !== undefined).map((Name) => ({ Name, Value: valueFor(Name) })),
        InvalidParameters: [],
      };
    },
  });
  const { values } = await readGatewayConfig(CTX(), { clients: clients({ ssm }) });
  assert.ok(batches.length > 1, 'more than one call was made');
  assert.ok(batches.every((n) => n <= 10), `every batch is within the limit: ${batches.join(',')}`);
  // and the batching is invisible to the caller — results merge by name
  assert.equal(values.EFS_FILE_SYSTEM_ARN, FS_ARN);
  assert.equal(values.DEPLOYMENT_ENVIRONMENT, 'v:DEPLOYMENT_ENVIRONMENT');
});

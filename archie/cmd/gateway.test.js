'use strict';

// Tests for cmd/gateway.js.
//
// NOTHING HERE TOUCHES AWS, THE NETWORK OR DOCKER. Every client and the subprocess runner are
// injected, so the rails that matter — the ECR immutability refusal, the absent-tag refusal, check
// 16, and above all the three-transition wait — are asserted directly rather than inferred from a
// live rollout nobody can reproduce on demand.
//
// The wait is the reason this file exists. `gateway deploy` must NOT wait for "a new healthy task
// while the old one is still running" (dispatcher.tf:216-233 makes that state impossible), and the
// only way to prove a wait does not hang on a state that never occurs is to script a service that
// never enters it.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const gateway = require('./gateway');
const { resourcesFor } = require('../lib/context');
const { EXIT } = require('../lib/exit');
const { ROOT } = require('../lib/digest');

const ACCOUNT = '203366135563';
const REGISTRY = `${ACCOUNT}.dkr.ecr.us-east-1.amazonaws.com`;
const REPO_URI = `${REGISTRY}/agent-gn0p84-gateway`;
const TD_69 = 'arn:aws:ecs:us-east-1:203366135563:task-definition/agent-gn0p84-dispatcher:69';
const TD_70 = 'arn:aws:ecs:us-east-1:203366135563:task-definition/agent-gn0p84-dispatcher:70';

function makeCtx(over = {}) {
  const name = over.name || 'agent-gn0p84';
  return {
    name,
    region: 'us-east-1',
    profile: null,
    account: null,
    dryRun: false,
    assumeYes: false,
    json: true,
    verbosity: 0,
    timeoutSeconds: null,
    resources: resourcesFor(name),
    ...over,
  };
}

function makeArgs(values = {}) {
  return { positionals: [], values };
}

function makeOut() {
  const lines = { progress: [], warn: [], verbose: [], answer: [] };
  return {
    lines,
    answer: (v) => lines.answer.push(v),
    progress: (l) => lines.progress.push(l),
    verbose: (l) => lines.verbose.push(l),
    warn: (l) => lines.warn.push(l),
    failure: () => {},
    text: () => [...lines.progress, ...lines.warn, ...lines.verbose].join('\n'),
  };
}

/**
 * A fake AWS client.
 *
 * Dispatches on the command's constructor name, so the module under test builds REAL command
 * objects — a renamed or mistyped command surfaces here as "unexpected command", not as a silently
 * accepted no-op.
 */
function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    send(command) {
      const name = command.constructor.name;
      const handler = handlers[name];
      calls.push({ name, input: command.input });
      if (!handler) return Promise.reject(new Error(`unexpected command: ${name}`));
      const value = typeof handler === 'function' ? handler(command.input, calls) : handler;
      return Promise.resolve(value);
    },
  };
}

const notFound = () => {
  const e = new Error('The image with imageId … does not exist');
  e.name = 'ImageNotFoundException';
  throw e;
};

function ecrFor({ image = null, repo = {} } = {}) {
  return fakeClient({
    DescribeRepositoriesCommand: () => ({
      repositories: [{
        repositoryName: 'agent-gn0p84-gateway',
        repositoryUri: REPO_URI,
        registryId: ACCOUNT,
        imageTagMutability: 'IMMUTABLE',
        ...repo,
      }],
    }),
    DescribeImagesCommand: () => (image
      ? { imageDetails: [{ imageDigest: 'sha256:deadbeef', imagePushedAt: new Date('2026-08-14T20:00:00Z') }] }
      : notFound()),
    GetAuthorizationTokenCommand: () => ({
      authorizationData: [{
        authorizationToken: Buffer.from('AWS:tok3n').toString('base64'),
        proxyEndpoint: `https://${REGISTRY}`,
      }],
    }),
  });
}

const stsOk = () => fakeClient({ GetCallerIdentityCommand: () => ({ Account: ACCOUNT }) });

const GOOD_ENV = [
  { name: 'AGENT_CONFIG_TABLE', value: 'agent-gn0p84-config' },
  { name: 'DISPATCHER_LOG_GROUP', value: '/ecs/agent-gn0p84-dispatcher' },
  { name: 'DISPATCHER_SERVICE_NAME', value: 'agent-gn0p84-dispatcher' },
  { name: 'DISPATCHER_METRIC_NAMESPACE', value: 'agent-gn0p84Dispatcher' },
  { name: 'CRON_METRIC_NAMESPACE', value: 'agent-gn0p84Cron' },
  { name: 'AWS_REGION', value: 'us-east-1' },
];

const HEALTH_CHECK = { command: ['CMD-SHELL', 'node -e …'], interval: 30, timeout: 5, retries: 3, startPeriod: 30 };

function taskDefinition({ env = GOOD_ENV, image = `${REPO_URI}:archie-0.2.22`, healthCheck = HEALTH_CHECK } = {}) {
  return {
    taskDefinitionArn: TD_69,
    family: 'agent-gn0p84-dispatcher',
    revision: 69,
    status: 'ACTIVE',
    // Read-only fields that RegisterTaskDefinition rejects — present here precisely so the strip
    // list is exercised.
    requiresAttributes: [{ name: 'ecs.capability.execution-role-awslogs' }],
    compatibilities: ['EC2', 'FARGATE'],
    registeredAt: new Date('2026-08-14T19:00:00Z'),
    registeredBy: 'arn:aws:iam::203366135563:role/example-iac',
    cpu: '1024',
    memory: '2048',
    networkMode: 'awsvpc',
    requiresCompatibilities: ['FARGATE'],
    executionRoleArn: 'arn:aws:iam::203366135563:role/exec',
    taskRoleArn: 'arn:aws:iam::203366135563:role/task',
    volumes: [{ name: 'agent-gn0p84-dispatcher-data' }],
    containerDefinitions: [{
      name: 'dispatcher',
      image,
      essential: true,
      environment: env,
      secrets: [{ name: 'SLACK_BOT_TOKEN', valueFrom: 'arn:…' }],
      healthCheck,
    }],
  };
}

function service({ runningCount = 1, deployments = null, taskDefinitionArn = TD_69 } = {}) {
  return {
    status: 'ACTIVE',
    serviceName: 'agent-gn0p84-dispatcher',
    taskDefinition: taskDefinitionArn,
    desiredCount: 1,
    runningCount,
    pendingCount: 0,
    deployments: deployments || [{ status: 'PRIMARY', taskDefinition: taskDefinitionArn, runningCount, createdAt: new Date('2026-08-14T20:12:00Z') }],
  };
}

/**
 * The discovery half, as one injected client bag.
 *
 * `deploy` no longer clones the deployed task definition — it COMPOSES one from the parameters
 * Terraform publishes plus facts discovered from the account (lib/deployment-facts.js). These fakes
 * are what let that happen without AWS. Values line up with `taskDefinition()` above so a composed
 * definition and the "deployed" one are equivalent, which is what makes the idempotence test mean
 * something.
 */
const AP_ID = 'fsap-1';
const FS_ID = 'fs-1';
const SSM_VALUES = {
  EFS_FILE_SYSTEM_ARN: `arn:aws:elasticfilesystem:us-east-1:${ACCOUNT}:file-system/${FS_ID}`,
  DISPATCHER_ACCESS_POINT_ID: AP_ID,
  ENABLE_EXECUTE_COMMAND: 'true',
  DEPLOYMENT_ENVIRONMENT: 'sandbox',
  AGENTCORE_RUNTIME_TLS_REJECT: '1',
};

function discoveryClients(over = {}) {
  const one = (handlers) => fakeClient(handlers);
  return {
    sts: one({ GetCallerIdentityCommand: () => ({ Account: ACCOUNT }) }),
    ecr: one({ DescribeRepositoriesCommand: ({ repositoryNames }) => ({ repositories: [{ repositoryUri: `${REGISTRY}/${repositoryNames[0]}` }] }) }),
    sqs: one({ GetQueueUrlCommand: ({ QueueName }) => ({ QueueUrl: `https://sqs/${QueueName}` }) }),
    iam: one({ GetRoleCommand: ({ RoleName }) => ({ Role: { Arn: `arn:aws:iam::${ACCOUNT}:role/${RoleName}` } }) }),
    efs: one({
      DescribeAccessPointsCommand: () => ({ AccessPoints: [{ AccessPointId: AP_ID, FileSystemId: FS_ID }] }),
      DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', SubnetId: 'subnet-a' }, { VpcId: 'vpc-1', SubnetId: 'subnet-b' }] }),
    }),
    ec2: one({ DescribeSecurityGroupsCommand: ({ Filters }) => ({ SecurityGroups: [{ GroupId: `sg-${Filters.find((f) => f.Name === 'group-name').Values[0]}` }] }) }),
    secrets: one({ DescribeSecretCommand: ({ SecretId }) => ({ ARN: `arn:secret:${SecretId}` }) }),
    discovery: one({
      ListNamespacesCommand: () => ({ Namespaces: [{ Id: 'ns-1', Name: 'redacted-internal-host.example' }] }),
      ListServicesCommand: () => ({ Services: [{ Name: 'dispatcher', Arn: 'arn:servicediscovery:svc/1' }] }),
    }),
    ssm: one({
      GetParametersCommand: ({ Names }) => ({
        Parameters: Names.filter((n) => SSM_VALUES[n.split('/').pop()] !== undefined)
          .map((Name) => ({ Name, Value: SSM_VALUES[Name.split('/').pop()] })),
        InvalidParameters: Names.filter((n) => SSM_VALUES[n.split('/').pop()] === undefined),
      }),
    }),
    ...over,
  };
}

/**
 * A "deployed" task definition built by the REAL composer, plus the read-only fields ECS echoes back.
 *
 * Hand-writing this fixture would make the idempotence test pass for the wrong reason: it would drift
 * from the composition and the diff would be non-empty for reasons that have nothing to do with what
 * the test is asserting.
 */
function deployedAsComposed(image, ssmOver = {}) {
  const { composeTaskDefinition } = require('../lib/task-definition');
  const composed = composeTaskDefinition({
    resources: resourcesFor('agent-gn0p84'),
    region: 'us-east-1',
    facts: COMPOSED_FACTS,
    ssm: { ...SSM_VALUES, ...ssmOver },
    image,
  });
  return {
    ...composed,
    taskDefinitionArn: TD_69,
    revision: 69,
    status: 'ACTIVE',
    requiresAttributes: [{ name: 'ecs.capability.execution-role-awslogs' }],
    compatibilities: ['EC2', 'FARGATE'],
    registeredAt: new Date('2026-08-14T19:00:00Z'),
    registeredBy: 'arn:aws:iam::203366135563:role/example-iac',
  };
}

/** The facts `discoveryClients()` above resolves to, as the composer receives them. */
const COMPOSED_FACTS = {
  account: ACCOUNT,
  basePolicyArn: `arn:aws:iam::${ACCOUNT}:policy/agent-gn0p84core-base`,
  agentRepoUri: `${REGISTRY}/agent-gn0p84core`,
  turnQueueUrl: 'https://sqs/agent-gn0p84-dispatcher-turns.fifo',
  efsFileSystemId: FS_ID,
  dispatcherAccessPointId: AP_ID,
  vpcId: 'vpc-1',
  subnetIds: ['subnet-a', 'subnet-b'],
  runtimeSecurityGroupId: 'sg-agent-gn0p84-runtime-sg',
  dispatcherSecurityGroupId: 'sg-agent-gn0p84-dispatcher-sg',
  serviceRegistryArn: 'arn:servicediscovery:svc/1',
  executionRoleArn: `arn:aws:iam::${ACCOUNT}:role/agent-gn0p84-dispatcher-execution-role`,
  taskRoleArn: `arn:aws:iam::${ACCOUNT}:role/agent-gn0p84-dispatcher-task-role`,
  credentialSecretName: 'agent-gn0p84-connector-api-key',
  secrets: [
    { name: 'SLACK_BOT_TOKEN', valueFrom: 'arn:secret:agent-gn0p84-slack-bot-token' },
    { name: 'SLACK_APP_TOKEN', valueFrom: 'arn:secret:agent-gn0p84-slack-app-token' },
    { name: 'DISPATCHER_SHARED_SECRET', valueFrom: 'arn:secret:agent-gn0p84-dispatcher-shared-secret' },
    { name: 'CONNECTOR_API_KEY', valueFrom: 'arn:secret:agent-gn0p84-connector-api-key' },
  ],
};

/** A sequence of responses, one per call; the last one repeats so a wait cannot fall off the end. */
function sequence(items) {
  let i = 0;
  return () => {
    const item = items[Math.min(i, items.length - 1)];
    i += 1;
    return item;
  };
}

async function expectExit(code, fn) {
  try {
    await fn();
  } catch (e) {
    assert.equal(e.exitCode, code, `expected exit ${code}, got ${e.exitCode}: ${e.message}`);
    return e;
  }
  return assert.fail(`expected exit ${code}, but the call resolved`);
}

// ── gateway build ────────────────────────────────────────────────────────────────────────────────

test('build: a derived tag already in ECR skips the build AND the push', async () => {
  // The whole point of deriving tags: same content, same tag, already published, do nothing. This is
  // what makes `archie deploy` idempotent and what stops a no-op release costing 94s of outage.
  const out = makeOut();
  const run = () => assert.fail('docker must not be invoked when the tag is already in ECR');
  const result = await gateway.build(makeCtx(), makeArgs({ push: true }), out, {
    ecr: ecrFor({ image: true }), sts: stsOk(), run,
  });
  assert.equal(result.skipped, true);
  assert.equal(result.built, false);
  assert.equal(result.pushed, false);
  assert.match(result.tag, /^content-[0-9a-f]{16}$/);
  assert.match(out.text(), /already in ECR/);
});

test('build: --tag latest is refused', async () => {
  // IMMUTABLE repo (ecr.tf:17): a floating tag cannot be moved, so the name would lie forever.
  const e = await expectExit(EXIT.REFUSED, () => gateway.build(
    makeCtx(), makeArgs({ tag: 'latest', push: true }), makeOut(), { ecr: ecrFor(), sts: stsOk() },
  ));
  assert.match(e.message, /latest/);
});

test('build: --push over an existing tag is refused BEFORE docker runs', async () => {
  // Checked first so the failure names IMMUTABLE rather than surfacing mid-layer-upload.
  const run = () => assert.fail('docker must not run when the push is going to be refused');
  const e = await expectExit(EXIT.REFUSED, () => gateway.build(
    makeCtx(), makeArgs({ tag: 'archie-0.2.22', push: true }), makeOut(),
    { ecr: ecrFor({ image: true }), sts: stsOk(), run },
  ));
  assert.match(e.message, /IMMUTABLE/);
});

test('build: the build context is docker/, not docker/slack-dispatcher/', async () => {
  // slack-dispatcher/Dockerfile:70-74 COPYs clawdbot/config-seed, workspace-seed.mjs and
  // config-resolver files. A narrower context fails on those COPY lines (Makefile:297-301).
  const invocations = [];
  const out = makeOut();
  const result = await gateway.build(makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), out, {
    ecr: ecrFor(), sts: stsOk(), run: (cmd, args, opts) => { invocations.push({ cmd, args, opts }); return Promise.resolve({}); },
  });
  assert.equal(invocations.length, 1, 'no --push means exactly one docker invocation');
  const { cmd, args, opts } = invocations[0];
  assert.equal(cmd, 'docker');
  assert.equal(opts.cwd, ROOT);
  assert.equal(args[args.length - 1], '.', 'the context is docker/');
  assert.ok(args.includes('-f') && args[args.indexOf('-f') + 1] === './slack-dispatcher/Dockerfile');
  assert.ok(args.includes('--platform=linux/amd64'));
  assert.ok(args.includes(`${REPO_URI}:archie-0.2.23`));
  assert.equal(result.pushed, false);
  assert.match(out.text(), /no deployment effect|not pushed/i);
});

test('build --push: logs in to the repo\'s own registry host, with the password on stdin', async () => {
  // `docker login` is per-region AND per-account (Makefile:125-128); a mismatch produces an
  // authorization error that reads like a missing repository.
  const invocations = [];
  const ecr = ecrFor();
  // The image is absent before the push and present after it, so the digest can be reported.
  let pushed = false;
  ecr.send = ((original) => (command) => {
    if (command.constructor.name === 'DescribeImagesCommand' && pushed) {
      return Promise.resolve({ imageDetails: [{ imageDigest: 'sha256:cafe' }] });
    }
    return original(command);
  })(ecr.send.bind(ecr));

  const result = await gateway.build(makeCtx(), makeArgs({ tag: 'archie-0.2.23', push: true }), makeOut(), {
    ecr,
    sts: stsOk(),
    run: (cmd, args, opts) => {
      invocations.push({ cmd, args, opts });
      if (args[0] === 'push') pushed = true;
      return Promise.resolve({});
    },
  });

  const login = invocations.find((i) => i.args[0] === 'login');
  assert.ok(login, 'docker login must happen before the push');
  assert.equal(login.args[login.args.length - 1], REGISTRY);
  assert.equal(login.opts.input, 'tok3n', 'the ECR token goes on stdin, never on the command line');
  assert.deepEqual(invocations[invocations.length - 1].args, ['push', `${REPO_URI}:archie-0.2.23`]);
  assert.equal(result.pushed, true);
  assert.equal(result.imageDigest, 'sha256:cafe');
});

test('build --push: a repo owned by another account is refused, not attempted', async () => {
  // The failure would otherwise be an authorization error indistinguishable from a missing repo.
  const run = (cmd, args) => {
    if (args[0] === 'push') assert.fail('must not push into another account\'s registry');
    return Promise.resolve({});
  };
  const e = await expectExit(EXIT.REFUSED, () => gateway.build(
    makeCtx(), makeArgs({ tag: 'archie-0.2.23', push: true }), makeOut(),
    { ecr: ecrFor({ repo: { registryId: '999999999999' } }), sts: stsOk(), run },
  ));
  assert.match(e.message, /999999999999/);
});

test('build: a missing ECR repository is preflight (3), naming the repository', async () => {
  const ecr = fakeClient({ DescribeRepositoriesCommand: () => { const e = new Error('nope'); e.name = 'RepositoryNotFoundException'; throw e; } });
  const e = await expectExit(EXIT.PREFLIGHT, () => gateway.build(
    makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), makeOut(), { ecr, sts: stsOk() },
  ));
  assert.match(e.message, /agent-gn0p84-gateway/);
});

test('build: a failed docker build keeps the subprocess stderr on the cause', async () => {
  // execFileSync's e.message line 1 is always the useless one; discarding stderr "is what made a
  // region mismatch look identical to an unpublished image" (agent-image.js:52-56).
  const run = () => {
    const e = new Error('`docker build …` exited 1');
    e.stderr = 'ERROR: failed to compute cache key: "/clawdbot/config-seed" not found';
    return Promise.reject(e);
  };
  const e = await expectExit(EXIT.FAILED, () => gateway.build(
    makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), makeOut(), { ecr: ecrFor(), sts: stsOk(), run },
  ));
  assert.match(e.cause.stderr, /config-seed/);
});

test('build --dry-run: prints the plan and runs nothing', async () => {
  const out = makeOut();
  const result = await gateway.build(makeCtx({ dryRun: true }), makeArgs({ tag: 'archie-0.2.23', push: true }), out, {
    ecr: ecrFor(), sts: stsOk(), run: () => assert.fail('dry run must not shell out'),
  });
  assert.equal(result.built, false);
  assert.equal(result.pushed, false);
  assert.match(out.text(), /would build/);
});

test('build: --account disagreeing with the caller is preflight (3)', async () => {
  const e = await expectExit(EXIT.PREFLIGHT, () => gateway.build(
    makeCtx({ account: '111111111111' }), makeArgs({ tag: 'archie-0.2.23' }), makeOut(),
    { ecr: ecrFor(), sts: stsOk(), run: () => assert.fail('nothing runs before identity is proven') },
  ));
  assert.match(e.message, /111111111111/);
});

// ── gateway deploy ───────────────────────────────────────────────────────────────────────────────

// `taskDefinition` overrides what DescribeTaskDefinition returns. It did not used to be an option,
// and a test passing one was silently ignored — which is how a fixture can look right and assert
// nothing.
function ecsFor({ services = [service()], describeTasks = null, listTasks = null, register = null, taskDefinition: td = null } = {}) {
  const registered = [];
  const client = fakeClient({
    // A plain array is one fixed answer; a function is a script. Either way the wire shape is
    // `{ services: [...] }`, so a scripted step can return the array on its own.
    DescribeServicesCommand: (input) => {
      const value = typeof services === 'function' ? services(input) : services;
      return Array.isArray(value) ? { services: value } : value;
    },
    DescribeTaskDefinitionCommand: () => ({ taskDefinition: td || taskDefinition(), tags: [{ key: 'Deployment', value: 'archie' }] }),
    RegisterTaskDefinitionCommand: (input) => {
      registered.push(input);
      return register ? register(input) : {
        taskDefinition: { ...input, taskDefinitionArn: TD_70, revision: 70 },
      };
    },
    UpdateServiceCommand: () => ({ service: {} }),
    ListTasksCommand: listTasks || ((input) => ({ taskArns: input.desiredStatus === 'RUNNING' ? ['arn:aws:ecs:us-east-1:203366135563:task/agent-gn0p84/running1'] : [] })),
    DescribeTasksCommand: describeTasks || (() => ({
      tasks: [{ taskArn: 'arn:…/running1', taskDefinitionArn: TD_70, lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }],
    })),
  });
  client.registered = registered;
  return client;
}

/** A clock that only moves when the code under test sleeps — so every timestamp is deliberate. */
function fakeClock(startIso) {
  let t = new Date(startIso).getTime();
  return { now: () => t, sleep: (ms) => { t += ms; return Promise.resolve(); } };
}

test('deploy: a tag absent from ECR is refused before anything is stopped', async () => {
  // Otherwise it appears ~40s later as a Fargate image-pull error INSIDE the downtime window, with
  // the old task already gone.
  const ecs = ecsFor();
  const e = await expectExit(EXIT.REFUSED, () => gateway.deploy(
    makeCtx(), makeArgs({ tag: 'archie-0.2.99' }), makeOut(), { ecr: ecrFor(), ecs, sts: stsOk(), clients: discoveryClients() },
  ));
  assert.match(e.message, /not in ECR/);
  assert.equal(ecs.calls.length, 0, 'nothing was even read from ECS');
});

test('deploy: a deployed env disagreeing with --name is CORRECTED, not refused', async () => {
  // This used to be a hard refusal (check 16). It no longer can be, and the reason is that the
  // failure it guarded against is now structurally impossible: `deploy` COMPOSES the environment from
  // --name rather than cloning whatever the running task happens to carry, so the composed
  // AGENT_CONFIG_TABLE is right by construction.
  //
  // A disagreeing DEPLOYED value therefore means the running task is misconfigured — and rolling
  // forward is the fix, not something to block. It is still surfaced: the diff is printed before
  // anything is registered. The refusal survives where it still means something, in
  // `gateway status --check` and preflight, which report on the deployment rather than replace it.
  const ecs = ecsFor({
    taskDefinition: taskDefinition({
      env: [{ name: 'AGENT_CONFIG_TABLE', value: 'agent-4ggvzl-config' }],
    }),
  });
  const out = makeOut();
  await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23', 'no-wait': true }), out, {
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients: discoveryClients(),
  });

  const registered = ecs.calls.find((c) => c.name === 'RegisterTaskDefinitionCommand');
  const env = Object.fromEntries(registered.input.containerDefinitions[0].environment.map((e) => [e.name, e.value]));
  assert.equal(env.AGENT_CONFIG_TABLE, 'agent-gn0p84-config', 'composed from --name, not copied');
  assert.match(out.text(), /agent-4ggvzl-config/, 'the disagreement is still reported');
});

test('deploy: the same image AND an equivalent composition does nothing at all', async () => {
  // §2.27: "running it twice with no edits does nothing at all, including no gateway outage".
  //
  // The check is now TWO-SIDED, and the second side matters: an SSM value can change with no new
  // image, and that does need a rollout. So the no-op requires the image to match AND the composed
  // definition to be equivalent to the running one — which is why the fixture is built by the REAL
  // composer rather than hand-written. A hand-written one would drift from the composition and make
  // this test pass for the wrong reason.
  const ecs = ecsFor({ taskDefinition: deployedAsComposed(`${REPO_URI}:archie-0.2.22`) });
  const out = makeOut();
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.22' }), out, {
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients: discoveryClients(),
  });

  assert.equal(result.unchanged, true);
  assert.equal(result.rolled, false);
  assert.equal(result.registeredTaskDefinition, null);
  assert.equal(ecs.calls.filter((c) => c.name === 'RegisterTaskDefinitionCommand').length, 0);
  assert.equal(ecs.calls.filter((c) => c.name === 'UpdateServiceCommand').length, 0, 'no outage was paid');
  assert.match(out.text(), /no rollout, no outage/);
});

test('deploy: the same image but a CHANGED composition still rolls — config moves without a build', async () => {
  // The case the image-only check missed entirely. Nothing was rebuilt, but DEPLOYMENT_ENVIRONMENT
  // (or any other published value) moved, so the running container is stale in a way no tag reflects.
  const clients = discoveryClients();
  const ecs = ecsFor({ taskDefinition: deployedAsComposed(`${REPO_URI}:archie-0.2.22`, { DEPLOYMENT_ENVIRONMENT: 'dev' }) });
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.22', 'no-wait': true }), makeOut(), {
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients,
  });
  assert.equal(result.unchanged, false, 'an SSM-only change must not be mistaken for a no-op');
  assert.equal(ecs.calls.filter((c) => c.name === 'RegisterTaskDefinitionCommand').length, 1);
});

test('deploy: registers the COMPOSED definition, with no read-only fields', async () => {
  // It used to clone the deployed definition and swap the image, because Terraform owned the shape.
  // Terraform no longer has a task definition at all (modules/archie/dispatcher.tf), so there is
  // nothing to clone — and on a from-scratch account there would be no service to clone from either.
  const ecs = ecsFor();
  await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23', 'no-wait': true }), makeOut(), {
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients: discoveryClients(),
  });

  const registered = ecs.calls.find((c) => c.name === 'RegisterTaskDefinitionCommand').input;
  assert.equal(registered.family, 'agent-gn0p84-dispatcher');
  assert.equal(registered.containerDefinitions[0].image, `${REPO_URI}:archie-0.2.23`);
  // RegisterTaskDefinition REJECTS these outright, so their absence is not cosmetic. The old clone
  // path had to strip them; composition never produces them.
  for (const readOnly of ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes',
    'compatibilities', 'registeredAt', 'registeredBy']) {
    assert.equal(readOnly in registered, false, `${readOnly} must not be sent`);
  }
  // Discovered, not copied from the running definition.
  assert.equal(registered.volumes[0].efsVolumeConfiguration.fileSystemId, FS_ID);
  assert.equal(registered.volumes[0].efsVolumeConfiguration.authorizationConfig.accessPointId, AP_ID);
});

test('deploy: waits stopped -> started -> healthy and reports the measured gap', async () => {
  // The measured rollout: runningCount fell to 0 at 20:12:53 and the healthcheck passed at 20:14:27
  // — 94 seconds (§6.1). The service is NEVER scripted with two running tasks, because that state
  // cannot occur (desired_count=1, max 100%) and a wait that needed it would hang forever.
  const ecs = ecsFor({
    services: sequence([
      [service()],                                                                   // initial read
      [service({ runningCount: 0, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 0 }] })],
      [service({ runningCount: 1, taskDefinitionArn: TD_70, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 1 }] })],
      [service({ runningCount: 1, taskDefinitionArn: TD_70, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 1 }] })],
    ]),
    describeTasks: sequence([
      { tasks: [{ taskArn: 'arn:…/running1', taskDefinitionArn: TD_70, lastStatus: 'RUNNING', healthStatus: 'UNKNOWN' }] },
      { tasks: [{ taskArn: 'arn:…/running1', taskDefinitionArn: TD_70, lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }] },
    ]),
  });
  const out = makeOut();
  const clock = fakeClock('2026-08-14T20:12:53Z');
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), out, {
    clients: discoveryClients(),
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), ...clock, pollIntervalMs: 47000,
  });

  assert.equal(result.timeline.gapSeconds, 94);
  assert.equal(result.timeline.gapApproximate, false);
  assert.equal(result.timeline.healthcheckVerified, true);
  assert.equal(result.registeredTaskDefinition, 'agent-gn0p84-dispatcher:70');
  const text = out.text();
  assert.match(text, /20:12:53\s+runningCount 1 -> 0/);
  assert.match(text, /20:13:40\s+runningCount 0 -> 1/);
  assert.match(text, /20:14:27\s+healthCheck HEALTHY\s+gap 94s/);
  assert.match(text, /dropped Slack events/);
  assert.doesNotMatch(text, /zero downtime|no downtime/i);
});

test('deploy: reports no terraform follow-up — there is nothing left for Terraform to agree with', async () => {
  // There used to be a `terraform` block in the result naming the tfvar to bump. Then it became
  // advisory ("bootstrap image only"). Now it is gone entirely: Terraform owns neither the task
  // definition nor the image tag, and `var.dispatcher_image_tag` no longer exists. A field telling an
  // operator to update a variable that is not there is worse than no field.
  const ecs = ecsFor();
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23', 'no-wait': true }), makeOut(), {
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients: discoveryClients(),
  });
  assert.equal('terraform' in result, false);
});

test('deploy: a stop observed between polls still reports a gap, flagged approximate', async () => {
  // An unreported gap reads as "no downtime", which is the one claim this command must never make.
  const ecs = ecsFor({
    services: sequence([
      [service()],
      [service({ runningCount: 1, taskDefinitionArn: TD_70, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 1, createdAt: new Date('2026-08-14T20:12:53Z') }] })],
    ]),
  });
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), makeOut(), {
    clients: discoveryClients(),
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), ...fakeClock('2026-08-14T20:13:00Z'), pollIntervalMs: 1000,
  });
  assert.equal(result.timeline.gapApproximate, true);
  assert.ok(result.timeline.gapSeconds >= 7);
});

test('deploy: a STOPPED new task is exit 1 and is NOT rolled back', async () => {
  // A rollback here would be a second uninstrumented ~94s outage stacked on the first. ECS holds
  // the failed deployment; the operator decides.
  const ecs = ecsFor({
    services: sequence([[service()], [service({ runningCount: 0, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 0 }] })]]),
    listTasks: (input) => ({ taskArns: input.desiredStatus === 'STOPPED' ? ['arn:…/dead1'] : [] }),
    describeTasks: () => ({
      tasks: [{
        taskArn: 'arn:…/dead1',
        taskDefinitionArn: TD_70,
        lastStatus: 'STOPPED',
        stoppedReason: 'CannotPullContainerError: image not found',
        containers: [{ reason: 'CannotPullContainerError' }],
      }],
    }),
  });
  const e = await expectExit(EXIT.FAILED, () => gateway.deploy(
    makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), makeOut(),
    { ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients: discoveryClients(), ...fakeClock('2026-08-14T20:12:53Z'), pollIntervalMs: 5000 },
  ));
  assert.match(e.message, /CannotPullContainerError/);
  assert.match(e.detail, /NOT rolled back/);
  assert.equal(ecs.calls.filter((c) => c.name === 'UpdateServiceCommand').length, 1, 'exactly the one roll-forward');
  assert.equal(ecs.calls.filter((c) => c.name === 'RegisterTaskDefinitionCommand').length, 1);
});

test('deploy: an expired budget is 124, and says the rollout may still complete', async () => {
  const ecs = ecsFor({ services: () => ({ services: [service()] }) });  // never stops: budget must end this
  const e = await expectExit(EXIT.TIMEOUT, () => gateway.deploy(
    makeCtx(), makeArgs({ tag: 'archie-0.2.23', 'wait-timeout': '30' }), makeOut(),
    { ecr: ecrFor({ image: true }), ecs, sts: stsOk(), clients: discoveryClients(), ...fakeClock('2026-08-14T20:12:53Z'), pollIntervalMs: 5000 },
  ));
  assert.match(e.message, /30s expired/);
  assert.match(e.detail, /may still complete/);
});

test('deploy --no-wait: returns immediately and warns that nothing is watching', async () => {
  const ecs = ecsFor();
  const out = makeOut();
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23', 'no-wait': true }), out, {
    clients: discoveryClients(),
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(),
  });
  assert.equal(result.waited, false);
  assert.equal(result.timeline, null);
  assert.match(out.lines.warn.join('\n'), /nothing is monitoring/);
});

test('deploy --dry-run: prints the image swap and registers nothing', async () => {
  const ecs = ecsFor();
  const out = makeOut();
  const result = await gateway.deploy(makeCtx({ dryRun: true }), makeArgs({ tag: 'archie-0.2.23' }), out, {
    clients: discoveryClients(),
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(),
  });
  assert.equal(result.registeredTaskDefinition, null);
  assert.equal(ecs.calls.filter((c) => c.name === 'RegisterTaskDefinitionCommand').length, 0);
  assert.equal(ecs.calls.filter((c) => c.name === 'UpdateServiceCommand').length, 0);
  assert.match(out.text(), /would register/);
});

test('deploy: a revision without a healthcheck warns and waits for RUNNING only', async () => {
  // Waiting for HEALTHY on a container with no healthCheck burns the whole budget and then reports
  // a timeout on a rollout that actually succeeded.
  const ecs = ecsFor({
    services: sequence([[service()], [service({ runningCount: 0, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 0 }] })], [service({ runningCount: 1, taskDefinitionArn: TD_70, deployments: [{ status: 'PRIMARY', taskDefinition: TD_70, runningCount: 1 }] })]]),
    register: (input) => ({ taskDefinition: { ...input, taskDefinitionArn: TD_70, containerDefinitions: [{ ...input.containerDefinitions[0], healthCheck: undefined }] } }),
  });
  const out = makeOut();
  const result = await gateway.deploy(makeCtx(), makeArgs({ tag: 'archie-0.2.23' }), out, {
    clients: discoveryClients(),
    ecr: ecrFor({ image: true }), ecs, sts: stsOk(), ...fakeClock('2026-08-14T20:12:53Z'), pollIntervalMs: 47000,
  });
  assert.equal(result.timeline.healthcheckVerified, false);
  assert.match(out.lines.warn.join('\n'), /no container healthcheck/);
});

test('deploy: the wait budget comes from --wait-timeout, then --timeout, then 300s', () => {
  assert.equal(gateway.waitBudgetSeconds(makeCtx(), makeArgs({})), 300);
  assert.equal(gateway.waitBudgetSeconds(makeCtx({ timeoutSeconds: 600 }), makeArgs({})), 600);
  assert.equal(gateway.waitBudgetSeconds(makeCtx({ timeoutSeconds: 600 }), makeArgs({ 'wait-timeout': '45' })), 45);
  assert.throws(() => gateway.waitBudgetSeconds(makeCtx(), makeArgs({ 'wait-timeout': 'soon' })), /positive number/);
});

// ── gateway status ───────────────────────────────────────────────────────────────────────────────

test('status: reads the DEPLOYED task definition, never the local shell', async () => {
  // spec-baseline.mjs:16-17,32-44 — "what your terminal exports is irrelevant to what the dispatcher
  // is running, and conflating them is how shadow config survives".
  const saved = process.env.AGENT_CONFIG_TABLE;
  process.env.AGENT_CONFIG_TABLE = 'a-table-from-someones-shell';
  try {
    const result = await gateway.status(makeCtx(), makeArgs({}), makeOut(), { ecs: ecsFor() });
    assert.equal(result.env.AGENT_CONFIG_TABLE, 'agent-gn0p84-config');
    assert.equal(result.check.ok, true);
    assert.equal(result.taskDefinition, 'agent-gn0p84-dispatcher:69');
    assert.equal(result.image, `${REPO_URI}:archie-0.2.22`);
    assert.equal(result.tag, 'archie-0.2.22');
  } finally {
    if (saved === undefined) delete process.env.AGENT_CONFIG_TABLE;
    else process.env.AGENT_CONFIG_TABLE = saved;
  }
});

test('status --check: a disagreeing env is drift (7), and the report is still printed', async () => {
  const ecs = ecsFor();
  ecs.send = ((original) => (command) => (command.constructor.name === 'DescribeTaskDefinitionCommand'
    ? Promise.resolve({ taskDefinition: taskDefinition({ env: GOOD_ENV.map((v) => (v.name === 'DISPATCHER_LOG_GROUP' ? { name: v.name, value: '/ecs/agent-4ggvzl-dispatcher' } : v)) }), tags: [] })
    : original(command)))(ecs.send.bind(ecs));

  const out = makeOut();
  const e = await expectExit(EXIT.DRIFT, () => gateway.status(makeCtx(), makeArgs({ check: true }), out, { ecs }));
  assert.match(e.detail, /agent-4ggvzl-dispatcher/);
  assert.equal(out.lines.answer.length, 1, 'the report is the answer even when it exits 7');
});

test('status: without --check a disagreement is reported, not an error', async () => {
  const ecs = ecsFor();
  ecs.send = ((original) => (command) => (command.constructor.name === 'DescribeTaskDefinitionCommand'
    ? Promise.resolve({ taskDefinition: taskDefinition({ env: [] }), tags: [] })
    : original(command)))(ecs.send.bind(ecs));
  const result = await gateway.status(makeCtx(), makeArgs({}), makeOut(), { ecs });
  assert.equal(result.check.ok, false);
  assert.equal(result.check.asserted, false);
});

test('status: an ABSENT name-derived variable counts as disagreement', async () => {
  // Every one of these has a fallback in agentcore-client.js and every fallback is a literal from
  // an operator's sandbox (dispatcher.tf:73-79) — "unset" means "pointed at account 052", not "neutral".
  const check = gateway.checkEnvAgainstName(makeCtx(), { AGENT_CONFIG_TABLE: 'agent-gn0p84-config' });
  assert.equal(check.ok, false);
  assert.equal(check.mismatches.length, 0);
  assert.ok(check.absent.some((a) => a.key === 'DISPATCHER_LOG_GROUP'));
});

test('status: every expected name comes from --name, so another --name derives another expectation', async () => {
  const check = gateway.checkEnvAgainstName(makeCtx({ name: 'agent-6guk92' }), {});
  assert.equal(check.expected.AGENT_CONFIG_TABLE, 'agent-6guk92-config');
  assert.equal(check.expected.DISPATCHER_LOG_GROUP, '/ecs/agent-6guk92-dispatcher');
  assert.equal(check.expected.CRON_METRIC_NAMESPACE, 'agent-6guk92Cron');
});

test('status: a running task on an older revision than the service is named as such', async () => {
  const ecs = ecsFor({
    describeTasks: () => ({ tasks: [{ taskArn: 'arn:…/old1', taskDefinitionArn: TD_70, lastStatus: 'RUNNING', healthStatus: 'HEALTHY' }] }),
  });
  const out = makeOut();
  const result = await gateway.status(makeCtx({ json: false }), makeArgs({}), out, { ecs });
  assert.equal(result, undefined, 'non-json puts the answer on stdout');
  assert.match(out.lines.answer.join('\n'), /NOT the service's agent-gn0p84-dispatcher:69/);
});

test('status: a cluster that does not exist is preflight (3), naming the cluster', async () => {
  const ecs = fakeClient({ DescribeServicesCommand: () => { const e = new Error('cluster not found'); e.name = 'ClusterNotFoundException'; throw e; } });
  const e = await expectExit(EXIT.PREFLIGHT, () => gateway.status(makeCtx(), makeArgs({}), makeOut(), { ecs }));
  assert.match(e.message, /agent-gn0p84/);
});

test('status: a cluster with no such service is preflight (3), naming the service', async () => {
  const ecs = fakeClient({ DescribeServicesCommand: () => ({ services: [], failures: [{ reason: 'MISSING' }] }) });
  const e = await expectExit(EXIT.PREFLIGHT, () => gateway.status(makeCtx(), makeArgs({}), makeOut(), { ecs }));
  assert.match(e.message, /agent-gn0p84-dispatcher/);
});

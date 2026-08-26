'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CONSTANTS, SSM_PARAMETERS, PORT, SSM_PREFIX, dispatcherBaseUrl,
  composeEnvironment, composeTaskDefinition, composeCronPurgeTaskDefinition,
} = require('./task-definition');
const { resourcesFor } = require('./context');

const RESOURCES = resourcesFor('agent-gn0p84');
const REGION = 'us-east-1';

// The facts lib/deployment-facts.js discovers, as they resolved in the sandbox on 2026-08-15. Real
// values rather than placeholders, so a test that passes here corresponds to a composition that was
// proved byte-equivalent against Terraform's own registered revision.
const FACTS = {
  account: '203366135563',
  basePolicyArn: 'arn:aws:iam::203366135563:policy/agent-gn0p84core-base',
  agentRepoUri: '203366135563.dkr.ecr.us-east-1.amazonaws.com/agent-gn0p84core',
  turnQueueUrl: 'https://sqs.us-east-1.amazonaws.com/203366135563/agent-gn0p84-dispatcher-turns.fifo',
  efsFileSystemId: 'fs-REDACTED',
  dispatcherAccessPointId: 'fsap-REDACTED',
  vpcId: 'vpc-REDACTED',
  runtimeSecurityGroupId: 'sg-REDACTED',
  dispatcherDnsName: 'agent-gn0p84-dispatcher-abc123.elb.us-east-1.amazonaws.com',
  executionRoleArn: 'arn:aws:iam::203366135563:role/agent-gn0p84-dispatcher-execution-role',
  taskRoleArn: 'arn:aws:iam::203366135563:role/agent-gn0p84-dispatcher-task-role',
  credentialSecretName: 'agent-gn0p84-connector-api-key',
  secrets: [{ name: 'SLACK_BOT_TOKEN', valueFrom: 'arn:...bot' }],
};

const SSM = {
  DEPLOYMENT_ENVIRONMENT: 'sandbox',
  AGENTCORE_RUNTIME_TLS_REJECT: '1',
  AGENTCORE_READERS_ACCOUNT: '203366135563',
  CONNECTOR_ORG_API_KEY_SECRET: 'arn:aws:secretsmanager:us-east-1:203366135563:secret:connector/org_secret-KdnKht',
  METRICS_TABLE_NAME: 'agent-4ggvzl-message-metrics',
};

const envMap = (list) => Object.fromEntries(list.map((e) => [e.name, e.value]));
const compose = (over = {}) => composeEnvironment({
  resources: RESOURCES, region: REGION, facts: FACTS, ssm: SSM, ...over,
});

test('every environment variable comes from --name, discovery, SSM or a declared constant', () => {
  const env = envMap(compose());
  // Derived from the one knob.
  assert.equal(env.AGENT_CONFIG_TABLE, 'agent-gn0p84-config');
  assert.equal(env.DISPATCHER_LOG_GROUP, '/ecs/agent-gn0p84-dispatcher');
  assert.equal(env.DISPATCHER_SERVICE_NAME, 'agent-gn0p84-dispatcher');
  assert.equal(env.DISPATCHER_METRIC_NAMESPACE, 'agent-gn0p84Dispatcher');
  assert.equal(env.CRON_METRIC_NAMESPACE, 'agent-gn0p84Cron');
  assert.equal(env.DISPATCHER_SHARED_SECRET_ID, 'agent-gn0p84-dispatcher-shared-secret');
  // Discovered, not configured.
  assert.equal(env.AGENTCORE_VPC_ID, FACTS.vpcId);
  assert.equal(env.AGENTCORE_EFS_FS_ID, FACTS.efsFileSystemId);
  assert.equal(env.AGENTCORE_SECURITY_GROUP_ID, FACTS.runtimeSecurityGroupId);
  assert.equal(env.TURN_QUEUE_URL, FACTS.turnQueueUrl);
  // Published by Terraform.
  assert.equal(env.DEPLOYMENT_ENVIRONMENT, 'sandbox');
  assert.equal(env.METRICS_TABLE_NAME, 'agent-4ggvzl-message-metrics');
  // Constants of the architecture.
  assert.equal(env.AGENTCORE_EFS_ROOT_PREFIX, '/openclaw-data');
  assert.equal(env.AGENTCORE_MAX_CONCURRENT_PROVISIONS, '5');
});

test('the environment is sorted, so the §6 diff is never noisy with reorderings', () => {
  const names = compose().map((e) => e.name);
  assert.deepEqual(names, names.slice().sort());
});

test('DISPATCHER_BASE_URL is the DISCOVERED load balancer host and the port — never configured', () => {
  // It used to be a pure function of --name, because Cloud Map let archie choose the hostname.
  // The NLB that replaced it (a private DNS namespace cannot exist in a shared VPC) has an
  // AWS-generated hostname, so the input is now a discovered fact rather than the knob.
  const facts = { dispatcherDnsName: 'agent-gn0p84-dispatcher-abc123.elb.us-east-1.amazonaws.com' };
  assert.equal(dispatcherBaseUrl(facts), `http://${facts.dispatcherDnsName}:${PORT}`);
  assert.equal(
    envMap(compose()).DISPATCHER_BASE_URL,
    'http://agent-gn0p84-dispatcher-abc123.elb.us-east-1.amazonaws.com:9090',
  );
  // Still no second input. A different deployment's load balancer is a different hostname, so two
  // stacks cannot resolve to one gateway.
  assert.equal(
    dispatcherBaseUrl({ dispatcherDnsName: 'agent-6guk92-dispatcher-def456.elb.us-east-1.amazonaws.com' }),
    'http://agent-6guk92-dispatcher-def456.elb.us-east-1.amazonaws.com:9090',
  );
});

test('a missing REQUIRED parameter refuses, and names the exact path to fix', () => {
  const ssm = { ...SSM };
  delete ssm.DEPLOYMENT_ENVIRONMENT;
  assert.throws(() => compose({ ssm }), (e) => (
    /DEPLOYMENT_ENVIRONMENT is not published at \/archie\/gateway\/DEPLOYMENT_ENVIRONMENT/.test(e.message)
  ));
});

test('a missing OPTIONAL parameter omits the variable — absent means unset, as in Terraform', () => {
  const ssm = { ...SSM };
  delete ssm.METRICS_TABLE_NAME;
  delete ssm.AGENTCORE_READERS_ACCOUNT;
  const env = envMap(compose({ ssm }));
  assert.equal('METRICS_TABLE_NAME' in env, false);
  assert.equal('AGENTCORE_READERS_ACCOUNT' in env, false);
  // Not "" and not "undefined" — the dispatcher branches on presence, so an empty string would read
  // as configured-but-blank and, for the readers account, redirect nothing while looking set.
  assert.equal(env.METRICS_TABLE_NAME, undefined);
});

test('an empty-string parameter is treated as absent, not as a configured blank', () => {
  const env = envMap(compose({ ssm: { ...SSM, METRICS_TABLE_NAME: '' } }));
  assert.equal('METRICS_TABLE_NAME' in env, false);
});

test('the Datadog key region rides along with either key name, and only then', () => {
  assert.equal('DATADOG_KEY_SECRET_REGION' in envMap(compose()), false);
  const withApi = envMap(compose({ ssm: { ...SSM, DATADOG_API_KEY_SECRET: 'agent-gn0p84-datadog-api-key' } }));
  assert.equal(withApi.DATADOG_KEY_SECRET_REGION, REGION);
  // One key without the other is a misconfiguration worth carrying visibly rather than half-dropping.
  const withAppOnly = envMap(compose({ ssm: { ...SSM, DATADOG_APP_KEY_SECRET: 'agent-gn0p84-datadog-app-key' } }));
  assert.equal(withAppOnly.DATADOG_KEY_SECRET_REGION, REGION);
});

test('Connector is optional: no secret, no key variables', () => {
  const env = envMap(compose({ facts: { ...FACTS, credentialSecretName: null } }));
  assert.equal('CONNECTOR_API_KEY_SECRET' in env, false);
  assert.equal('CONNECTOR_API_KEY_SECRET_REGION' in env, false);
  // The ORG key is independent — it is an SSM value, not a per-deployment secret resource.
  assert.equal(env.CONNECTOR_ORG_API_KEY_SECRET, SSM.CONNECTOR_ORG_API_KEY_SECRET);
});

test('the dropped and cut variables are gone, and stay gone', () => {
  const env = envMap(compose());
  // §4.5 and §4.6. Asserted rather than assumed: both were live env vars until 2026-08-15, and the
  // composition is now the only thing that decides whether they come back.
  assert.equal('SLACK_ROUTES' in env, false);
  assert.equal('CRON_ENABLED' in env, false);
  // Verified to have zero readers in the current image; a revival would be silent.
  for (const dead of ['AGENT_URLS', 'ECS_CLUSTER_NAME', 'ECS_AGENT_PREFIX', 'GH_CONFIG_REPO',
    'GH_CONFIG_REF', 'CONFIG_SOURCE', 'ARTIFACTS_S3_BUCKET', 'NODE_TLS_REJECT_UNAUTHORIZED']) {
    assert.equal(dead in env, false, `${dead} must not be composed`);
  }
});

test('a fact that discovery failed to resolve refuses rather than composing a hole', () => {
  for (const key of ['account', 'vpcId', 'efsFileSystemId', 'runtimeSecurityGroupId', 'turnQueueUrl']) {
    const facts = { ...FACTS, [key]: undefined };
    assert.throws(() => compose({ facts }), (e) => new RegExp(key).test(e.message),
      `a missing ${key} must be refused`);
  }
});

test('region is required, and reaches all four variables that must state it', () => {
  assert.throws(() => compose({ region: null }), /needs a region/);
  const env = envMap(compose());
  assert.equal(env.AWS_REGION, REGION);
  assert.equal(env.AGENTCORE_REGION, REGION);
  assert.equal(env.DISPATCHER_SHARED_SECRET_REGION, REGION);
  assert.equal(env.CONNECTOR_API_KEY_SECRET_REGION, REGION);
});

test('the SSM prefix is a constant, NOT name-derived — one archie per account', () => {
  // The invariant is declared on modules/archie/variables.tf's `name`: one archie stack per AWS
  // account. A <name> segment could only ever take one value, so it was a variable path with no
  // variation. Asserted as a literal because the value is now a contract with Terraform's
  // local.ssm_prefix, and the two must not drift.
  assert.equal(SSM_PREFIX, '/archie/gateway');
});

test('every declared SSM parameter is consumed, and no undeclared key leaks in', () => {
  // A parameter added to Terraform but not to SSM_PARAMETERS would be published and never read —
  // the silent half of a two-sided change.
  const declared = SSM_PARAMETERS.map((p) => p.key);
  const env = envMap(composeEnvironment({
    resources: RESOURCES,
    region: REGION,
    facts: FACTS,
    ssm: Object.fromEntries(declared.map((k) => [k, `value-of-${k}`])),
  }));
  for (const key of declared) assert.equal(env[key], `value-of-${key}`);
  // An SSM key nobody declared is ignored, not silently promoted to an env var.
  const strayed = envMap(composeEnvironment({
    resources: RESOURCES, region: REGION, facts: FACTS, ssm: { ...SSM, NOT_DECLARED: 'x' },
  }));
  assert.equal('NOT_DECLARED' in strayed, false);
});

test('the task definition mirrors Terraform: family, roles, volume, mount, ports, healthcheck', () => {
  const td = composeTaskDefinition({
    resources: RESOURCES, region: REGION, facts: FACTS, ssm: SSM, image: 'repo:tag',
  });
  assert.equal(td.family, 'agent-gn0p84-dispatcher');
  assert.equal(td.networkMode, 'awsvpc');
  assert.deepEqual(td.requiresCompatibilities, ['FARGATE']);
  assert.equal(td.executionRoleArn, FACTS.executionRoleArn);
  assert.equal(td.taskRoleArn, FACTS.taskRoleArn);

  assert.equal(td.volumes[0].name, 'agent-gn0p84-dispatcher-data');
  assert.equal(td.volumes[0].efsVolumeConfiguration.authorizationConfig.accessPointId, FACTS.dispatcherAccessPointId);
  assert.equal(td.volumes[0].efsVolumeConfiguration.authorizationConfig.iam, 'ENABLED');
  assert.equal(td.volumes[0].efsVolumeConfiguration.transitEncryption, 'ENABLED');

  const c = td.containerDefinitions[0];
  assert.equal(c.name, 'dispatcher');
  assert.equal(c.image, 'repo:tag');
  // The mount name must match the volume name, or the task fails to start with a reference error.
  assert.equal(c.mountPoints[0].sourceVolume, td.volumes[0].name);
  assert.equal(c.mountPoints[0].containerPath, '/efs');
  assert.equal(c.portMappings[0].containerPort, PORT);
  assert.equal(c.logConfiguration.options['awslogs-group'], '/ecs/agent-gn0p84-dispatcher');
  assert.equal(c.logConfiguration.options['awslogs-region'], REGION);
});

test('the healthcheck, the port mapping and PORT cannot disagree', () => {
  // They were three literals in Terraform. One wrong and the container is unreachable on the port
  // ECS published, or the healthcheck fails forever against a port nothing listens on.
  const td = composeTaskDefinition({
    resources: RESOURCES, region: REGION, facts: FACTS, ssm: SSM, image: 'repo:tag',
  });
  const c = td.containerDefinitions[0];
  assert.match(c.healthCheck.command[1], new RegExp(`localhost:${PORT}/health`));
  assert.equal(c.portMappings[0].containerPort, PORT);
  assert.equal(envMap(c.environment).PORT, String(PORT));
  assert.match(envMap(c.environment).DISPATCHER_BASE_URL, new RegExp(`:${PORT}$`));
  // 30s startPeriod is most of why the measured rollout gap is ~94s, not "a few seconds".
  assert.equal(c.healthCheck.startPeriod, 30);
});

test('composing without an image refuses — an unimaged revision registers and never starts', () => {
  assert.throws(() => composeTaskDefinition({
    resources: RESOURCES, region: REGION, facts: FACTS, ssm: SSM,
  }), /needs an image/);
});

test('the measured constants carry their measurement, not a preference', () => {
  // Guard on the VALUE, because the reason it is 5 is an undocumented EFS CreateAccessPoint rate
  // limit measured at 40-clean / 26-of-60 — raising it without repeating that measurement produces
  // provisioning failures that look like AgentCore problems.
  assert.equal(CONSTANTS.AGENTCORE_MAX_CONCURRENT_PROVISIONS, '5');
  // Zone IDS, never names: us-east-1a is use1-az4 in dev and use1-az6 in the sandbox.
  assert.equal(CONSTANTS.AGENTCORE_SUPPORTED_AZ_IDS, 'use1-az1,use1-az2,use1-az4');
  assert.match(CONSTANTS.AGENTCORE_SUPPORTED_AZ_IDS, /^use1-az[0-9](,use1-az[0-9])*$/);
});

// ── cron purge (teardown, §E2) ──────────────────────────────────────────────────────────────────

const purge = (over = {}) => composeCronPurgeTaskDefinition({
  resources: RESOURCES, region: REGION, facts: { ...FACTS, dispatcherSharedSecretArn: 'arn:...shared' },
  image: 'repo/archie-gateway:tag', ownerAgentId: 'dm-ux0mz5ckp2r', ...over,
});

test('cron purge mounts NO filesystem — a purge reads no jobs.json, so it gets no fleet-wide read', () => {
  const td = purge();
  // The security property is the ABSENCE. The hydrator holds an access point over <prefix>/agents,
  // which is "can read every agent's workspace"; a purge needs "can call one HTTP endpoint".
  assert.equal(td.volumes, undefined);
  assert.equal(td.containerDefinitions[0].mountPoints, undefined);
  assert.equal(envMap(td.containerDefinitions[0].environment).MOUNT_PATH, undefined);
});

test('cron purge is keyed on the SCOPE, and carries no legacy name at all', () => {
  const env = envMap(purge().containerDefinitions[0].environment);
  assert.equal(env.CRON_PURGE_ONLY, '1');
  assert.equal(env.HYDRATE_OWNER_AGENT, 'dm-ux0mz5ckp2r');
  // The store is keyed by owner: a purge by legacy name deletes nothing and reports success, so the
  // legacy name must not be reachable from this path even by accident.
  assert.equal(env.HYDRATE_AGENT, undefined);
});

test('cron purge runs the gateway image with its own entry and its own log stream', () => {
  const c = purge().containerDefinitions[0];
  assert.deepEqual(c.entryPoint, ['node']);
  assert.deepEqual(c.command, ['cron-hydrator.js']);
  assert.equal(c.logConfiguration.options['awslogs-stream-prefix'], 'cron-purge');
  assert.equal(c.secrets[0].name, 'DISPATCHER_SHARED_SECRET');
});

test('cron purge refuses without an owner — purging "whatever" has no safe reading', () => {
  assert.throws(() => purge({ ownerAgentId: undefined }), /needs an ownerAgentId/);
  assert.throws(() => purge({ image: undefined }), /needs an image/);
});

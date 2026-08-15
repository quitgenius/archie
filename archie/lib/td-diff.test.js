'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { diffTaskDefinition, diffEnvironment, renderDiff } = require('./td-diff');

/** A composed definition, in the shape composeTaskDefinition produces. */
const composed = (over = {}) => ({
  family: 'agent-gn0p84-dispatcher',
  networkMode: 'awsvpc',
  requiresCompatibilities: ['FARGATE'],
  cpu: '1024',
  memory: '2048',
  executionRoleArn: 'arn:role/exec',
  taskRoleArn: 'arn:role/task',
  volumes: [{
    name: 'agent-gn0p84-dispatcher-data',
    efsVolumeConfiguration: {
      fileSystemId: 'fs-1', rootDirectory: '/', transitEncryption: 'ENABLED',
      authorizationConfig: { accessPointId: 'fsap-1', iam: 'ENABLED' },
    },
  }],
  containerDefinitions: [{
    name: 'dispatcher',
    image: 'repo:composed',
    essential: true,
    environment: [{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
    secrets: [{ name: 'SLACK_BOT_TOKEN', valueFrom: 'arn:secret/bot' }],
    portMappings: [{ containerPort: 9090, protocol: 'tcp' }],
    mountPoints: [{ sourceVolume: 'agent-gn0p84-dispatcher-data', containerPath: '/efs', readOnly: false }],
    logConfiguration: { logDriver: 'awslogs', options: { 'awslogs-group': '/ecs/x' } },
    healthCheck: { command: ['CMD-SHELL', 'x'], interval: 30, timeout: 5, retries: 3, startPeriod: 30 },
  }],
  ...over,
});

/**
 * The SAME definition as DescribeTaskDefinition returns it — with the fields AWS adds that were
 * never sent, and the environment in a different order. This is the case the gate has to get right:
 * these two are equivalent, and a diff that says otherwise is a gate nobody will trust.
 */
const asDeployed = (over = {}) => {
  const td = composed();
  return {
    ...td,
    taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/agent-gn0p84-dispatcher:42',
    revision: 42,
    status: 'ACTIVE',
    registeredAt: new Date(0),
    registeredBy: 'arn:iam/someone',
    requiresAttributes: [{ name: 'ecs.capability.execution-role-awslogs' }],
    compatibilities: ['EC2', 'FARGATE'],
    placementConstraints: [],
    containerDefinitions: [{
      ...td.containerDefinitions[0],
      image: 'repo:deployed',
      cpu: 0,
      volumesFrom: [],
      systemControls: [],
      portMappings: [{ containerPort: 9090, hostPort: 9090, protocol: 'tcp' }],
      environment: [{ name: 'B', value: '2' }, { name: 'A', value: '1' }],
    }],
    ...over,
  };
};

test('two equivalent definitions are equivalent, despite AWS-added fields and env order', () => {
  const diff = diffTaskDefinition(composed(), asDeployed());
  assert.equal(diff.equivalent, true, renderDiff(diff));
});

test('the image is never a difference — archie owns which image runs', () => {
  // A differing tag is the normal state between one deploy and the next. Reporting it would make the
  // gate red permanently, which is the same as having no gate.
  const diff = diffTaskDefinition(composed(), asDeployed());
  assert.equal(diff.equivalent, true);
  assert.equal(diff.fields.some((f) => /image/.test(f.field)), false);
});

test('environment is compared by KEY, not by index', () => {
  // ECS returns the order it was given, Terraform's list is in authoring order and archie's is
  // sorted. An index comparison reports 35 differences on two identical environments.
  const d = diffEnvironment([{ name: 'A', value: '1' }, { name: 'B', value: '2' }],
    [{ name: 'B', value: '2' }, { name: 'A', value: '1' }]);
  assert.deepEqual(d, { missing: [], extra: [], changed: [] });
});

test('a variable the deployed task has and the composition does not is reported as MISSING', () => {
  // The dangerous direction: composing this definition would REMOVE a variable from the running
  // container. It is what caught SLACK_ROUTES and CRON_ENABLED live.
  const deployed = asDeployed();
  deployed.containerDefinitions[0].environment.push({ name: 'CRON_ENABLED', value: 'true' });
  const diff = diffTaskDefinition(composed(), deployed);
  assert.equal(diff.equivalent, false);
  assert.deepEqual(diff.environment.missing, [{ key: 'CRON_ENABLED', deployed: 'true' }]);
  assert.equal(diff.environment.extra.length, 0);
  assert.match(renderDiff(diff), /env -\s+CRON_ENABLED=true/);
});

test('a changed value is reported with both sides, deployed first', () => {
  const c = composed();
  c.containerDefinitions[0].environment = [{ name: 'A', value: '9' }, { name: 'B', value: '2' }];
  const diff = diffTaskDefinition(c, asDeployed());
  assert.deepEqual(diff.environment.changed, [{ key: 'A', composed: '9', deployed: '1' }]);
  assert.match(renderDiff(diff), /env ~\s+A: 1 -> 9/);
});

test('a secret pointing at a different ARN is caught — it is a silent credential swap', () => {
  const c = composed();
  c.containerDefinitions[0].secrets = [{ name: 'SLACK_BOT_TOKEN', valueFrom: 'arn:secret/OTHER' }];
  const diff = diffTaskDefinition(c, asDeployed());
  assert.equal(diff.equivalent, false);
  assert.deepEqual(diff.secrets.changed, [{
    key: 'SLACK_BOT_TOKEN', composed: 'arn:secret/OTHER', deployed: 'arn:secret/bot',
  }]);
});

test('a dropped secret is caught even though the name is unchanged elsewhere', () => {
  const c = composed();
  c.containerDefinitions[0].secrets = [];
  const diff = diffTaskDefinition(c, asDeployed());
  assert.equal(diff.equivalent, false);
  assert.equal(diff.secrets.missing[0].key, 'SLACK_BOT_TOKEN');
});

test('role, sizing and family differences are caught', () => {
  for (const [field, value] of [['taskRoleArn', 'arn:role/OTHER'], ['executionRoleArn', 'arn:role/OTHER'],
    ['cpu', '512'], ['memory', '1024'], ['family', 'other-family'], ['networkMode', 'bridge']]) {
    const diff = diffTaskDefinition(composed({ [field]: value }), asDeployed());
    assert.equal(diff.equivalent, false, `${field} must be compared`);
    assert.equal(diff.fields.some((f) => f.field === field), true, `${field} must be named in the diff`);
  }
});

test('the EFS volume is compared on the fields that decide what is mounted', () => {
  for (const [key, value] of [['fileSystemId', 'fs-OTHER'], ['transitEncryption', 'DISABLED']]) {
    const c = composed();
    c.volumes[0].efsVolumeConfiguration[key] = value;
    const diff = diffTaskDefinition(c, asDeployed());
    assert.equal(diff.equivalent, false, `${key} must be compared`);
  }
  // The access point is the one that silently changes WHICH DIRECTORY the gateway's cron store and
  // conversation index live in — a wrong one looks like every schedule was deleted.
  const c = composed();
  c.volumes[0].efsVolumeConfiguration.authorizationConfig.accessPointId = 'fsap-OTHER';
  assert.equal(diffTaskDefinition(c, asDeployed()).equivalent, false);
});

test('an absent rootDirectory equals "/" — AWS omits the default rather than echoing it', () => {
  const deployed = asDeployed();
  delete deployed.volumes[0].efsVolumeConfiguration.rootDirectory;
  assert.equal(diffTaskDefinition(composed(), deployed).equivalent, true);
});

test('mountPoints, logConfiguration and healthCheck are compared, not assumed', () => {
  const cases = [
    (c) => { c.containerDefinitions[0].mountPoints[0].containerPath = '/other'; },
    (c) => { c.containerDefinitions[0].logConfiguration.options['awslogs-group'] = '/ecs/other'; },
    (c) => { c.containerDefinitions[0].healthCheck.startPeriod = 5; },
  ];
  for (const mutate of cases) {
    const c = composed();
    mutate(c);
    assert.equal(diffTaskDefinition(c, asDeployed()).equivalent, false);
  }
});

test('renderDiff says so plainly when there is nothing to say', () => {
  assert.match(renderDiff(diffTaskDefinition(composed(), asDeployed())), /^equivalent /);
});

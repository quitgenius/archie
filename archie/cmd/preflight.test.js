'use strict';

// Tests for `archie preflight`. No credentials, no network, no SDK: every check reaches AWS through
// the adapter created by createAws(), and every test here injects a plain object in its place.
//
// What is asserted is the BEHAVIOUR the reference promises, not the shape of the SDK calls — a unit
// test that asserts command shape against a fake "happily asserted the broken expression string"
// (registry-e2e.js:5-15). So: a skipped check must not read PASS, a missing resource must be named,
// check 14 must never call GetSecretValue, and check 10 must filter on AZ IDs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  preflight, assertBaseline, CHECKS, PASS, WARN, FAIL, SKIPPED, ERROR,
  selectChecks, formatLine, secretIdsFrom, principalArnFor, createWorld, runChecks,
  credentialProviderFrom,
} = require('./preflight');
const { createOutput } = require('../lib/output');
const { createContext } = require('../lib/context');
const { EXIT } = require('../lib/exit');

const ACCOUNT = '203366135563';

function ctxFor(values = {}) {
  return createContext({ region: 'us-east-1', name: 'agent-gn0p84', ...values }, { needsAws: true }, {});
}

function capture() {
  const out = []; const err = [];
  const streams = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } };
  return { streams, stdout: () => out.join(''), stderr: () => err.join('') };
}

const notFound = (name) => Object.assign(new Error(`${name}: not found`), { name });

/**
 * A healthy account. Every test starts here and breaks exactly one thing, so a test's diff IS the
 * failure it is about.
 */
function healthyAws(overrides = {}) {
  const calls = [];
  const record = (name) => (...args) => { calls.push({ name, args }); };
  const env = {
    AGENT_CONFIG_TABLE: 'agent-gn0p84-config',
    DISPATCHER_LOG_GROUP: '/ecs/agent-gn0p84-dispatcher',
    DISPATCHER_METRIC_NAMESPACE: 'agent-gn0p84Dispatcher',
    CRON_METRIC_NAMESPACE: 'agent-gn0p84Cron',
    DISPATCHER_SERVICE_NAME: 'agent-gn0p84-dispatcher',
    DISPATCHER_SHARED_SECRET_ID: 'agent-gn0p84-dispatcher-shared-secret',
    AGENTCORE_REGION: 'us-east-1',
    AGENTCORE_EFS_FS_ID: 'fs-REDACTED',
    AGENTCORE_VPC_ID: 'vpc-live',
    AGENTCORE_SECURITY_GROUP_ID: 'sg-live',
    AGENTCORE_EFS_ROOT_PREFIX: '/openclaw-data',
    AGENTCORE_SUPPORTED_AZ_IDS: 'use1-az1,use1-az2,use1-az4',
    TURN_QUEUE_URL: 'https://sqs/agent-gn0p84-dispatcher-turns.fifo',
  };
  const base = {
    calls,
    async callerIdentity() { calls.push({ name: 'callerIdentity' }); return { Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/AdminRole/sandbox` }; },
    async describeTable(name) {
      calls.push({ name: 'describeTable', args: [name] });
      return { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [{ IndexName: 'routing', IndexStatus: 'ACTIVE' }] };
    },
    async getItem(table, key, opts) {
      calls.push({ name: 'getItem', args: [table, key, opts] });
      if (key.pk === 'CONFIG#base') return { pk: key.pk, sk: key.sk, data: {} };
      if (key.pk === 'CONFIG#image') return { tag: 'pi-obs-41' };
      return null;
    },
    async describeRepositories(names) { calls.push({ name: 'describeRepositories', args: [names] }); return names.map((n) => ({ repositoryName: n })); },
    async describeImage(repo, tag) { calls.push({ name: 'describeImage', args: [repo, tag] }); return { digest: 'sha256:abc', arches: ['arm64'] }; },
    async getPolicy(arn) { calls.push({ name: 'getPolicy', args: [arn] }); return { PolicyName: 'agent-gn0p84core-base', DefaultVersionId: 'v4', AttachmentCount: 208 }; },
    async simulatePrincipalPolicy(src, actions) {
      calls.push({ name: 'simulatePrincipalPolicy', args: [src, actions] });
      return actions.map((a) => ({ EvalActionName: a, EvalDecision: 'allowed' }));
    },
    async describeFileSystem(id) { calls.push({ name: 'describeFileSystem', args: [id] }); return { FileSystemId: id, Name: 'agent-4ggvzl' }; },
    async describeMountTargets(id) {
      calls.push({ name: 'describeMountTargets', args: [id] });
      return [
        { MountTargetId: 'fsmt-1', VpcId: 'vpc-live', SubnetId: 'subnet-1', AvailabilityZoneId: 'use1-az1', LifeCycleState: 'available' },
        { MountTargetId: 'fsmt-2', VpcId: 'vpc-live', SubnetId: 'subnet-2', AvailabilityZoneId: 'use1-az2', LifeCycleState: 'available' },
        { MountTargetId: 'fsmt-3', VpcId: 'vpc-live', SubnetId: 'subnet-3', AvailabilityZoneId: 'use1-az4', LifeCycleState: 'available' },
      ];
    },
    async describeAccessPoints(id) {
      calls.push({ name: 'describeAccessPoints', args: [id] });
      return [
        { AccessPointId: 'fsap-parent', RootDirectory: { Path: '/openclaw-data/agents' }, Tags: [] },
        { AccessPointId: 'fsap-1', RootDirectory: { Path: '/openclaw-data/agents/a' }, Tags: [{ Key: 'managed-by', Value: 'agentcore' }] },
      ];
    },
    async describeSecurityGroupsByName(vpcId, name) {
      calls.push({ name: 'describeSecurityGroupsByName', args: [vpcId, name] });
      return [{ GroupId: 'sg-live', GroupName: name, VpcId: vpcId }];
    },
    async listAgentRuntimes() { calls.push({ name: 'listAgentRuntimes' }); return new Array(208).fill({ agentRuntimeId: 'x' }); },
    async serviceQuota() { calls.push({ name: 'serviceQuota' }); return { QuotaName: 'Agent runtimes per account', Value: 1000 }; },
    async describeSecret(id) { calls.push({ name: 'describeSecret', args: [id] }); return { Name: id }; },
    async describeServices(cluster, service) {
      calls.push({ name: 'describeServices', args: [cluster, service] });
      return { services: [{ status: 'ACTIVE', desiredCount: 1, runningCount: 1, taskDefinition: 'arn:aws:ecs:us-east-1:1:task-definition/agent-gn0p84-dispatcher:69' }], failures: [] };
    },
    // The hydrator's task definition is deliberately NOT stubbed: it is registered on demand and
    // deregistered, so absent is its normal state and check 20 no longer looks for it.
    async getRole(roleName) { calls.push({ name: 'getRole', args: [roleName] }); return { Arn: `arn:aws:iam::${ACCOUNT}:role/${roleName}` }; },
    async describeTaskDefinition(td) {
      calls.push({ name: 'describeTaskDefinition', args: [td] });
      return {
        taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/agent-gn0p84-dispatcher:69',
        revision: 69,
        containerDefinitions: [{
          name: 'dispatcher',
          environment: Object.entries(env).map(([name, value]) => ({ name, value })),
          secrets: [{ name: 'SLACK_BOT_TOKEN', valueFrom: `arn:aws:secretsmanager:us-east-1:${ACCOUNT}:secret:agent-gn0p84-slack-bot-token-AbCdEf` }],
        }],
      };
    },
    async traceSegmentDestination() { calls.push({ name: 'traceSegmentDestination' }); return { Destination: 'CloudWatchLogs', Status: 'ACTIVE' }; },
    async converse(modelId) { calls.push({ name: 'converse', args: [modelId] }); return { output: {} }; },
    async queueUrl(name) { calls.push({ name: 'queueUrl', args: [name] }); return `https://sqs/${name}`; },
    async queueAttributes(url) { calls.push({ name: 'queueAttributes', args: [url] }); return { ApproximateNumberOfMessages: '0' }; },
    // Deliberately present and deliberately explosive: nothing in preflight may ever read a secret.
    getSecretValue: record('getSecretValue'),
    env,
  };
  return { ...base, ...overrides };
}

async function run(argv = {}, awsOverrides = {}, ctxValues = {}) {
  const ctx = ctxFor(ctxValues);
  const c = capture();
  const out = createOutput({ json: ctx.json, verbosity: ctx.verbosity, streams: c.streams });
  const aws = healthyAws(awsOverrides);
  let thrown = null;
  try {
    await preflight(ctx, { positionals: [], values: argv }, out, { aws });
  } catch (e) {
    thrown = e;
    out.error(e);
  }
  const code = out.finish({ command: 'preflight', code: thrown ? thrown.exitCode : EXIT.OK, context: ctx });
  return { code, thrown, aws, stdout: c.stdout(), stderr: c.stderr(), out };
}

// ── the table itself ─────────────────────────────────────────────────────────────────────────────

// 19 checks numbered 1..20 with 3 MISSING. The gap is the point: check 3 was `CONFIG#base / BASE
// present` and that item no longer exists, but the reference cites checks by number throughout
// (`check 4`, `check 7`, `check 16`), so renumbering would silently repoint every citation.
test('the checks are numbered 1-20 with 3 retired, never renumbered', () => {
  const ns = CHECKS.map((c) => c.n);
  assert.deepEqual(ns, Array.from({ length: 20 }, (_, i) => i + 1).filter((n) => n !== 3));
  assert.equal(ns.includes(3), false, 'check 3 is retired — reusing the number repoints every doc citation');
  for (const c of CHECKS) assert.equal(typeof c.run, 'function', `check ${c.n} has no run()`);
});

test('a healthy account passes everything and exits 0', async () => {
  const { code, stdout } = await run({}, {}, { account: ACCOUNT });
  assert.equal(code, EXIT.OK);
  for (const c of CHECKS) assert.match(stdout, new RegExp(`^\\s*${c.n}\\s`, 'm'), `check ${c.n} printed no line`);
  assert.equal(/\bFAIL\b/.test(stdout), false, stdout);
});

// ── the rule this command exists to keep ─────────────────────────────────────────────────────────

test('a skipped check prints SKIPPED and NEVER PASS', async () => {
  // "A check that cannot RUN is not a check that passed" (deploy-dashboard.cjs:155-157).
  const { code, stdout } = await run({ skip: '10,18' }, {}, { account: ACCOUNT });
  assert.equal(code, EXIT.OK);
  assert.match(stdout, /^10\s+.*SKIPPED\s+skipped by --skip/m);
  assert.match(stdout, /^18\s+.*SKIPPED\s+skipped by --skip/m);
  assert.equal(/^10\s+.*PASS/m.test(stdout), false);
});

test('--checks runs only those, and the rest are SKIPPED rather than absent or passed', async () => {
  const { code, stdout, aws } = await run({ checks: '1,2,4' }, {}, { account: ACCOUNT });
  assert.equal(code, EXIT.OK);
  assert.match(stdout, /^ 1\s+.*PASS/m);
  assert.match(stdout, /^20\s+.*SKIPPED\s+not in --checks/m);
  // and nothing was contacted for the checks that did not run
  assert.equal(aws.calls.some((c) => c.name === 'converse'), false);
  assert.equal(aws.calls.some((c) => c.name === 'listAgentRuntimes'), false);
});

test('an unknown check number is exit 2 (usage), not a finding', async () => {
  for (const values of [{ checks: '21' }, { skip: '0' }, { checks: 'nine' }]) {
    assert.throws(() => selectChecks(values), (e) => e.exitCode === EXIT.USAGE);
  }
});

test('preflight is read-only: it never creates and never reads a secret value', async () => {
  const { aws } = await run({}, {}, { account: ACCOUNT });
  const names = aws.calls.map((c) => c.name);
  assert.equal(names.includes('getSecretValue'), false, 'preflight called GetSecretValue');
  assert.ok(names.includes('describeSecret'), 'check 14 did not use DescribeSecret');
  assert.equal(names.some((n) => /^(create|put|update|delete|tag)/i.test(n)), false, `mutating call: ${names}`);
});

// ── per-check behaviour that has burned someone ──────────────────────────────────────────────────

test('check 1: an account mismatch is exit 3 and NOTHING else runs', async () => {
  const { code, stdout, aws } = await run({}, {}, { account: '999999999999' });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /^ 1\s+.*FAIL\s+203366135563 != --account 999999999999/m);
  assert.match(stdout, /^ 2\s+.*SKIPPED\s+not run: check 1/m);
  // "nothing else runs" has to mean nothing else was CONTACTED, or the wrong account is still read.
  assert.deepEqual(aws.calls.map((c) => c.name), ['callerIdentity']);
});

test('check 1: no --account is advisory, because nothing was asserted', async () => {
  const { code, stdout } = await run({ checks: '1' });
  assert.equal(code, EXIT.OK);
  assert.match(stdout, /^ 1\s+.*WARN\s+203366135563 \(advisory: no --account given/m);
});

test('check 2: an absent table is named, with the operation', async () => {
  // Otherwise it surfaces later as "a bare ResourceNotFoundException ... no table name, no
  // operation" (agentcore-fixture.js:384-386).
  const { code, stdout } = await run({ checks: '2' }, {
    async describeTable() { throw notFound('ResourceNotFoundException'); },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /dynamodb:DescribeTable agent-gn0p84-config in us-east-1: table does not exist/);
});

test('check 2: the routing GSI is checked by NAME — routing-build.js queries it literally', async () => {
  const { code, stdout } = await run({ checks: '2' }, {
    async describeTable() { return { TableStatus: 'ACTIVE', GlobalSecondaryIndexes: [{ IndexName: 'gsi1', IndexStatus: 'ACTIVE' }] }; },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /no "routing" GSI \(has: gsi1\)/);
});

// The retired number must not silently select nothing and report success — `--checks 3` in an old
// runbook has to say the check is gone, not exit 0 having verified nothing.
test('check 3 is retired: no check claims the number, and --checks 3 does not pass vacuously', async () => {
  assert.equal(CHECKS.find((c) => c.n === 3), undefined);
  const { code } = await run({ checks: '3' }, { async getItem() { return null; } });
  assert.notEqual(code, EXIT.OK, '--checks 3 must not exit 0 — it would read as "base config verified"');
});

test('check 4: the pointer read is ConsistentRead', async () => {
  // image-source.js:63-66: a publish followed immediately by a read must not see a stale replica.
  const { aws } = await run({ checks: '4' });
  const reads = aws.calls.filter((c) => c.name === 'getItem');
  assert.ok(reads.length > 0);
  for (const r of reads) assert.deepEqual(r.args[2], { consistentRead: true });
});

test('check 4: on an empty account the failure says the state is CORRECT, not broken', async () => {
  const { code, stdout, stderr } = await run({ checks: '4' }, { async getItem() { return null; } }, { verbose: [true] });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /has no usable CONFIG#image\/FLEET/);
  assert.match(stderr, /CORRECT on a genuinely empty account/);
});

test('check 6: an amd64 image is the dispatcher image published by mistake', async () => {
  const { code, stdout } = await run({ checks: '6' }, {
    async describeImage() { return { digest: 'sha256:abc', arches: ['amd64'] }; },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /is amd64 — AgentCore microVMs are arm64/);
});

test('check 6: no pointer means SKIPPED, not a second copy of check 4s failure', async () => {
  const { stdout } = await run({ checks: '4,6' }, { async getItem() { return null; } });
  assert.match(stdout, /^ 6\s+.*SKIPPED\s+no image pointer to validate/m);
});

test('check 8: simulate uses the ROLE arn, not the assumed-role session arn', () => {
  assert.equal(principalArnFor('arn:aws:sts::203366135563:assumed-role/AdminRole/sandbox'),
    'arn:aws:iam::203366135563:role/AdminRole');
  assert.equal(principalArnFor('arn:aws:iam::203366135563:user/sandbox'),
    'arn:aws:iam::203366135563:user/sandbox');
});

test('check 8: a caller that cannot simulate is advisory-unverified, never a pass', async () => {
  const { code, stdout } = await run({ checks: '8' }, {
    async simulatePrincipalPolicy() { throw notFound('AccessDeniedException'); },
  });
  assert.equal(code, EXIT.OK);
  assert.match(stdout, /WARN\s+cannot simulate as arn:aws:iam::203366135563:role\/AdminRole \(AccessDeniedException\) — advisory, unverified/);
});

test('check 9: the filesystem is the authority on its VPC, not the env var', async () => {
  // The 2026-08-12 incident: the EFS moved VPC, the env var did not, and it surfaced as an
  // AZ-coverage error message (agentcore-fixture.js:53-58).
  const { code, stdout } = await run({ checks: '9' }, {
    async describeMountTargets() {
      return [{ VpcId: 'vpc-new', SubnetId: 's', AvailabilityZoneId: 'use1-az1', LifeCycleState: 'available' }];
    },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /but AGENTCORE_VPC_ID says vpc-live/);
});

test('check 10: filters on AZ ID, and reports prod-shaped 2-of-3 as advisory', async () => {
  const { code, stdout } = await run({ checks: '10' }, {
    async describeMountTargets() {
      return [
        // Zone NAMES here are deliberately the ones that read as "fine" — us-east-1a is use1-az6 in
        // prod, which is NOT supported. Reasoning in names would call this 3 of 3.
        { VpcId: 'vpc-live', AvailabilityZoneName: 'us-east-1a', AvailabilityZoneId: 'use1-az6', LifeCycleState: 'available' },
        { VpcId: 'vpc-live', AvailabilityZoneName: 'us-east-1b', AvailabilityZoneId: 'use1-az2', LifeCycleState: 'available' },
        { VpcId: 'vpc-live', AvailabilityZoneName: 'us-east-1d', AvailabilityZoneId: 'use1-az4', LifeCycleState: 'available' },
      ];
    },
  });
  assert.equal(code, EXIT.OK, 'a 2-of-3 fleet still runs — advisory, not a failure');
  assert.match(stdout, /^10\s+.*WARN\s+2 of 3 \(use1-az2, use1-az4; use1-az1 absent\)/m);
});

test('check 10: zero supported zones is a hard failure — nothing can be placed', async () => {
  const { code, stdout } = await run({ checks: '10' }, {
    async describeMountTargets() {
      return [{ VpcId: 'vpc-live', AvailabilityZoneId: 'use1-az6', LifeCycleState: 'available' }];
    },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /^10\s+.*FAIL\s+0 of 3/m);
});

test('check 12: headroom warns as it approaches the cap and only fails with none left', async () => {
  const near = await run({ checks: '12' }, { async listAgentRuntimes() { return new Array(800).fill({}); } });
  assert.equal(near.code, EXIT.OK);
  assert.match(near.stdout, /WARN\s+800\/1000 .* advisory/);

  const full = await run({ checks: '12' }, { async listAgentRuntimes() { return new Array(1000).fill({}); } });
  assert.equal(full.code, EXIT.PREFLIGHT);
  assert.match(full.stdout, /FAIL\s+1000\/1000 .* no headroom/);
});

test('check 12: an unavailable Service Quotas lookup is labelled a default, not a measurement', async () => {
  const { code, stdout } = await run({ checks: '12' }, {
    async serviceQuota() { throw Object.assign(new Error('nope'), { name: 'NoSuchResourceException' }); },
  });
  assert.equal(code, EXIT.OK);
  assert.match(stdout, /limit from plan §8 default \(Service Quotas: NoSuchResourceException\)/);
});

test('check 13: the SG is resolved BY NAME within the filesystems VPC', async () => {
  const { aws } = await run({ checks: '13' });
  const call = aws.calls.find((c) => c.name === 'describeSecurityGroupsByName');
  assert.deepEqual(call.args, ['vpc-live', 'agent-gn0p84-runtime-sg']);
});

test('check 13: same NAME, different id is the failure it must catch', async () => {
  const { code, stdout } = await run({ checks: '13' }, {
    async describeSecurityGroupsByName(vpcId, name) { return [{ GroupId: 'sg-fresh', GroupName: name, VpcId: vpcId }]; },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /is sg-fresh, but the dispatcher is configured with sg-live/);
});

test('check 14: every secret the task definition names is described, and named when absent', async () => {
  const described = [];
  const { code, stdout } = await run({ checks: '14' }, {
    async describeSecret(id) {
      described.push(id);
      if (String(id).includes('shared-secret')) throw notFound('ResourceNotFoundException');
      return { Name: id };
    },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  // The ARN's random suffix is stripped: an operator can act on a name, not on 100 characters of arn.
  assert.match(stdout, /absent: agent-gn0p84-dispatcher-shared-secret/);
  // Both sources: the container's secrets[] ARN (injected by the ECS agent) and the env var that
  // carries a name for the container to resolve itself.
  assert.ok(described.some((d) => d.includes('slack-bot-token')), described.join(','));
  assert.ok(described.includes('agent-gn0p84-dispatcher-shared-secret'), described.join(','));
});

test('secretIdsFrom: takes names and ARNs, and never mistakes a region for a secret', () => {
  const ids = secretIdsFrom({
    DISPATCHER_SHARED_SECRET_ID: 'agent-gn0p84-dispatcher-shared-secret',
    DISPATCHER_SHARED_SECRET_REGION: 'us-east-1',
    CONNECTOR_API_KEY_SECRET: 'agent-gn0p84-connector-api-key',
    DATADOG_KEY_SECRET_REGION: 'us-east-1',
    AGENTCORE_RUNTIME_TLS_REJECT: '1',
  }, { secrets: [{ name: 'SLACK_BOT_TOKEN', valueFrom: 'arn:...:secret:agent-gn0p84-slack-bot-token-AbCdEf' }] });
  assert.deepEqual(ids.sort(), [
    'agent-gn0p84-connector-api-key',
    'agent-gn0p84-dispatcher-shared-secret',
    'arn:...:secret:agent-gn0p84-slack-bot-token-AbCdEf',
  ]);
  assert.equal(ids.includes('us-east-1'), false);
});

test('check 16: a task definition configured for another stack FAILS — the §10 shadow-config trap', async () => {
  const { code, stdout } = await run({ checks: '16' }, {
    async describeTaskDefinition() {
      return {
        taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/agent-gn0p84-dispatcher:69',
        containerDefinitions: [{
          name: 'dispatcher',
          // The OpenClaw names are REAL and POPULATED, which is why this fails silently otherwise.
          environment: [{ name: 'AGENT_CONFIG_TABLE', value: 'agent-4ggvzl-config' },
            { name: 'DISPATCHER_METRIC_NAMESPACE', value: 'ClawdbotDispatcher' }],
        }],
      };
    },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /AGENT_CONFIG_TABLE=agent-4ggvzl-config \(expected agent-gn0p84-config\)/);
  assert.match(stdout, /DISPATCHER_METRIC_NAMESPACE=ClawdbotDispatcher/);
});

test('checks that need the dispatcher task definition are SKIPPED when it cannot be read', async () => {
  // Not PASS, and not a duplicate failure of check 15 either: they could not run.
  const { code, stdout } = await run({ checks: '9,13,15,16' }, {
    async describeServices() { return { services: [], failures: [{ arn: 'agent-gn0p84-dispatcher', reason: 'MISSING' }] }; },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /^15\s+.*FAIL\s+ecs:DescribeServices agent-gn0p84\/agent-gn0p84-dispatcher: agent-gn0p84-dispatcher: MISSING/m);
  for (const n of [9, 13, 16]) {
    assert.match(stdout, new RegExp(`^ ?${n}\\s+.*(FAIL|ERROR)`, 'm'), `check ${n} must not read as a pass`);
  }
  assert.equal(/PASS/.test(stdout), false);
});

test('check 19: queues present but durable delivery off is advisory, absent queues are not', async () => {
  const off = await run({ checks: '19' }, {
    async describeTaskDefinition() {
      return { containerDefinitions: [{ name: 'dispatcher', environment: [{ name: 'AGENTCORE_EFS_FS_ID', value: 'fs-1' }] }] };
    },
  });
  assert.equal(off.code, EXIT.OK);
  assert.match(off.stdout, /WARN.*TURN_QUEUE_URL unset, durable delivery is OFF/);

  const gone = await run({ checks: '19' }, { async queueUrl() { throw notFound('QueueDoesNotExist'); } });
  assert.equal(gone.code, EXIT.PREFLIGHT);
  assert.match(gone.stdout, /absent: agent-gn0p84-dispatcher-turns.fifo, agent-gn0p84-dispatcher-turns-dlq.fifo/);
});

test('check 20: the parent access point is matched by ROOT PATH under the deployed prefix', async () => {
  const { code, stdout } = await run({ checks: '20' }, {
    async describeAccessPoints() { return [{ AccessPointId: 'fsap-x', RootDirectory: { Path: '/openclaw-data/agents/one' }, Tags: [] }]; },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /no access point at \/openclaw-data\/agents/);
});

test('a check whose client is not installed reads ERROR and names the package', async () => {
  // The three clients checks 13/17/18 need are absent from archie/package.json. That must be visible
  // and must not exit 0 — a check that cannot run is not a check that passed.
  const { code, stdout, stderr } = await run({ checks: '17' }, {
    async traceSegmentDestination() {
      const e = new Error('@aws-sdk/client-xray is not installed');
      e.unrunnable = true;
      e.detail = 'add "@aws-sdk/client-xray" to archie/package.json dependencies';
      throw e;
    },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /^17\s+.*ERROR\s+cannot run: @aws-sdk\/client-xray is not installed/m);
  assert.match(stderr, /could not run \(17\) — a check that cannot run is not a check that passed/);
});

test('an AccessDenied is ERROR (cannot determine), never FAIL (it is missing)', async () => {
  const { code, stdout } = await run({ checks: '7' }, {
    async getPolicy() { throw notFound('AccessDeniedException'); },
  });
  assert.equal(code, EXIT.PREFLIGHT);
  assert.match(stdout, /^ 7\s+.*ERROR\s+cannot determine: AccessDeniedException/m);
});

// ── output contract ──────────────────────────────────────────────────────────────────────────────

test('--json puts the whole check table in the envelope, even when it fails', async () => {
  const ctx = ctxFor({ json: true, account: ACCOUNT });
  const c = capture();
  const out = createOutput({ json: true, streams: c.streams });
  const aws = healthyAws({ async getPolicy() { throw notFound('NoSuchEntity'); } });
  let code = EXIT.OK;
  try {
    await preflight(ctx, { positionals: [], values: {} }, out, { aws });
  } catch (e) { code = e.exitCode; out.error(e); }
  out.finish({ command: 'preflight', code, context: ctx });

  const envelope = JSON.parse(c.stdout());
  assert.equal(envelope.exit, EXIT.PREFLIGHT);
  assert.equal(envelope.result.checks.length, 19); // 20 numbers, 3 retired
  assert.equal(envelope.result.checks.find((r) => r.n === 7).status, FAIL);
  // failures[] names WHICH check failed, not just an exit code.
  assert.match(envelope.failures[0].step, /check 7/);
  // stdout is ONE document: no per-check lines leaked into it.
  assert.equal(c.stdout().trimEnd().endsWith('}'), true);
});

test('the human line matches the reference §2.1 example shape', () => {
  const line = formatLine({ n: 1, title: 'account identity', status: PASS, note: ACCOUNT });
  assert.match(line, /^ 1 {2}account identity \.+ PASS {4}203366135563$/);
  assert.match(formatLine({ n: 12, title: 'runtime quota headroom', status: WARN, note: '624/1000' }),
    /^12 {2}runtime quota headroom \.+ WARN {4}624\/1000$/);
});

// ── the library half ─────────────────────────────────────────────────────────────────────────────

test('assertBaseline runs exactly checks 1-2 and returns the account', async () => {
  const aws = healthyAws();
  const result = await assertBaseline(ctxFor({ account: ACCOUNT }), { aws });
  assert.equal(result.account, ACCOUNT);
  assert.deepEqual(result.results.map((r) => r.n), [1, 2]);
  // nothing beyond the two cheap reads: these run before EVERY mutating command. The CONFIG#base
  // GetItem is gone with check 3, so a mutating command is now one AWS call cheaper.
  assert.deepEqual([...new Set(aws.calls.map((c) => c.name))], ['callerIdentity', 'describeTable']);
});

test('assertBaseline throws exit 3 on the first failure — a mutating command wants a stop', async () => {
  const aws = healthyAws({ async describeTable() { throw notFound('ResourceNotFoundException'); } });
  await assert.rejects(() => assertBaseline(ctxFor({ account: ACCOUNT }), { aws }), (e) => {
    assert.equal(e.exitCode, EXIT.PREFLIGHT);
    assert.match(e.message, /check 2 .* failed: dynamodb:DescribeTable agent-gn0p84-config/);
    return true;
  });
});

test('assertBaseline refuses a wrong account before it reads anything else', async () => {
  const aws = healthyAws();
  await assert.rejects(() => assertBaseline(ctxFor({ account: '999999999999' }), { aws }), (e) => e.exitCode === EXIT.PREFLIGHT);
  assert.deepEqual(aws.calls.map((c) => c.name), ['callerIdentity']);
});

test('every resource name comes from ctx.resources, so --name moves all of them', async () => {
  // One knob (context.js:12-16). If a name were hardcoded here it would survive the rename.
  const ctx = createContext({ region: 'us-east-1', name: 'agent-tmv5ts', account: ACCOUNT }, { needsAws: true }, {});
  const aws = healthyAws({
    async describeTaskDefinition() { return { containerDefinitions: [{ name: 'dispatcher', environment: [] }] }; },
  });
  const c = capture();
  const out = createOutput({ streams: c.streams });
  // The run FAILS here (the fake is deliberately thin) and that is fine: this test is about which
  // names were sent to AWS, not about the verdict.
  let ignored = null;
  await preflight(ctx, { positionals: [], values: {} }, out, { aws }).catch((e) => { ignored = e; });
  assert.ok(ignored === null || ignored.exitCode === EXIT.PREFLIGHT);
  const touched = JSON.stringify(aws.calls);
  assert.equal(touched.includes('agent-gn0p84'), false, `a name did not follow --name: ${touched}`);
  assert.ok(touched.includes('agent-tmv5ts-config'));
  assert.ok(touched.includes('agent-tmv5ts-runtime-sg') || touched.includes('agent-tmv5ts'));
});

test('--profile accepts either SDK spelling of the node credential chain', () => {
  // Found on the first live run: the hoisted copy of @aws-sdk/credential-provider-node exports only
  // defaultProvider, so calling fromNodeProviderChain made all 20 checks fail with a TypeError that
  // never mentioned credentials.
  const chain = () => 'creds';
  assert.equal(credentialProviderFrom({ fromNodeProviderChain: chain }), chain);
  assert.equal(credentialProviderFrom({ defaultProvider: chain }), chain);
  assert.throws(() => credentialProviderFrom({ credentialsWillNeedRefresh: chain }),
    (e) => e.unrunnable && /exports no credential chain factory/.test(e.message));
  // And the module as actually installed, whichever spelling that build uses. Required through a
  // variable because it is in no package.json section — see need() in preflight.js.
  const id = '@aws-sdk/credential-provider-node';
  assert.equal(typeof credentialProviderFrom(require(id)), 'function');
});

test('runChecks is shared, so the same check means the same thing to a command and to a caller', async () => {
  const world = createWorld(ctxFor({ account: ACCOUNT }), healthyAws());
  const results = await runChecks([{ check: CHECKS[0], skipReason: null }, { check: CHECKS[1], skipReason: 'because' }], world);
  assert.deepEqual(results.map((r) => r.status), [PASS, SKIPPED]);
  assert.equal(results[1].note, 'because');
  assert.ok([PASS, WARN, FAIL, SKIPPED, ERROR].includes(results[0].status));
});

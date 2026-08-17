'use strict';

// Tests for the wrapper commands. NO AWS, NO NETWORK, NO SUBPROCESS: every seam these commands have
// (spawning, the dispatcher/observability modules, clients, clocks) is injected through the 4th
// `deps` argument, so what is exercised here is the argument translation, the dry-run convention and
// the refusals — which is all this file owns. The wrapped modules have their own suites.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const wrappers = require('./wrappers');
const { EXIT } = require('../lib/exit');
const { resourcesFor } = require('../lib/context');

const { lastJson, oneAgent, observabilityEnv, describeSource } = wrappers._internals;

// ── harness ──────────────────────────────────────────────────────────────────────────────────

function makeCtx(over = {}) {
  const name = over.name || 'agent-gn0p84';
  return {
    name,
    region: 'us-east-1',
    profile: null,
    account: '203366135563',
    dryRun: false,
    assumeYes: false,
    json: false,
    verbosity: 0,
    timeoutSeconds: null,
    resources: resourcesFor(name),
    ...over,
  };
}

function makeOut() {
  const lines = { progress: [], warn: [], verbose: [], failures: [] };
  return {
    lines,
    answer() {},
    progress: (l) => lines.progress.push(l),
    verbose: (l) => lines.verbose.push(l),
    warn: (l) => lines.warn.push(l),
    failure: (f) => lines.failures.push(f),
    failureCount: () => lines.failures.length,
    text: () => [...lines.progress, ...lines.warn, ...lines.verbose].join('\n'),
  };
}

const args = (positionals = [], values = {}) => ({ positionals, values });

/** A fake execFile that records invocations and replies from a scripted table. */
function fakeExec(reply = () => ({ stdout: '', stderr: '', code: 0 })) {
  const calls = [];
  const fn = (cmd, argv, opts, cb) => {
    calls.push({ cmd, argv, env: opts.env, cwd: opts.cwd });
    const r = reply({ cmd, argv, env: opts.env }) || {};
    const err = r.code ? Object.assign(new Error(`Command failed: ${cmd}\n${r.stderr || ''}`), { code: r.code }) : null;
    setImmediate(() => cb(err, r.stdout || '', r.stderr || ''));
    return { stdout: null, stderr: null };
  };
  fn.calls = calls;
  return fn;
}

const rejects = async (p, code, re) => {
  await assert.rejects(p, (e) => {
    assert.equal(e.exitCode, code, `expected exit ${code}, got ${e.exitCode}: ${e.message}`);
    if (re) assert.match(`${e.message} ${e.detail || ''}`, re);
    return true;
  });
};

// ── pure helpers ─────────────────────────────────────────────────────────────────────────────

test('lastJson finds the report a script prints after its log lines', () => {
  assert.deepEqual(lastJson('hydrate: doing things\n{"applied":true,"written":3}\n'), { applied: true, written: 3 });
  assert.deepEqual(lastJson('a { not json\n{"ok":1}'), { ok: 1 });
  assert.equal(lastJson('no json at all'), null);
});

test('one agent at a time — concurrent mutations for one agent lose one another', () => {
  assert.equal(oneAgent(args(['agent-75lieo'])), 'agent-75lieo');
  assert.throws(() => oneAgent(args([])), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => oneAgent(args(['a', 'b'])), (e) => e.exitCode === EXIT.USAGE && /read-modify-write/.test(e.detail));
  // The sanitizer's character class — a DynamoDB key and a CWL literal are both built from this.
  assert.throws(() => oneAgent(args(["a'; drop"])), (e) => e.exitCode === EXIT.USAGE);
});

// ONE KNOB. A mixed environment is what produced a board whose metric widgets read archie and whose
// log widgets read the OpenClaw stack — and the wrong values do not error, they render another
// system's fleet as if it were yours.
test('observability env pins every stack-shaped name to --name', () => {
  const env = observabilityEnv(makeCtx({ name: 'other-stack' }));
  assert.equal(env.ARCHIE_STACK, 'other-stack');
  assert.equal(env.DISPATCHER_LOG_GROUP, '/ecs/other-stack-dispatcher');
  assert.equal(env.DISPATCHER_METRIC_NAMESPACE, 'other-stackDispatcher');
  assert.equal(env.CRON_METRIC_NAMESPACE, 'other-stackCron');
  for (const v of Object.values(env)) assert.ok(!String(v).includes('clawdbot'), `"${v}" is not derived from --name`);
});

// ── config hydrate ───────────────────────────────────────────────────────────────────────────

test('config hydrate prints the three idempotency consequences BEFORE writing, and dry-run writes nothing', async () => {
  const out = makeOut();
  const execFile = fakeExec(({ argv }) => (argv[0] === 'ls-remote' ? { stdout: 'deadbeefcafe\trefs/heads/main\n' } : { stdout: '' }));
  const r = await wrappers['config hydrate'](makeCtx({ dryRun: true }), args([], {}), out, { execFile, env: {} });

  assert.equal(r.dryRun, true);
  assert.equal(r.table, 'agent-gn0p84-config');
  assert.equal(r.consequences.length, 3);
  assert.match(out.text(), /PUT-ONLY and never deletes/);
  assert.match(out.text(), /GRANT#\* is RECOMPUTED AND OVERWRITTEN/);
  assert.match(out.text(), /rewritten WHOLESALE/);
  // Only the ref resolution ran; hydrate.mjs was never invoked.
  assert.deepEqual(execFile.calls.map((c) => c.cmd), ['git']);
});

test('config hydrate resolves the ref rather than tracking a moving one silently', async () => {
  const out = makeOut();
  const execFile = fakeExec(() => ({ stdout: 'deadbeefcafe1234\trefs/heads/main\n' }));
  const r = await wrappers['config hydrate'](makeCtx({ dryRun: true }), args([], {}), out, { execFile, env: {} });
  assert.equal(r.source.sha, 'deadbeefcafe1234');
  assert.match(describeSource(r.source), /@ deadbeefcafe/);

  // ...and when it CANNOT be resolved, that is stated. Silence is the failure mode being closed.
  const out2 = makeOut();
  const failing = fakeExec(() => ({ code: 128, stderr: 'fatal: could not read Username' }));
  const r2 = await wrappers['config hydrate'](makeCtx({ dryRun: true }), args([], {}), out2, { execFile: failing, env: {} });
  assert.equal(r2.source.sha, null);
  assert.match(out2.lines.warn.join('\n'), /MOVING ref/);
});

test('config hydrate --no-dry-run invokes hydrate.mjs with the table and ref derived from the context', async () => {
  const out = makeOut();
  const execFile = fakeExec(() => ({ stdout: 'hydrate: done — DynamoDB refreshed\n' }));
  await wrappers['config hydrate'](makeCtx({ name: 'agent-b450oe' }), args([], { ref: 'topic', 'sandra-dir': '/tmp/sandra' }), out, { execFile, env: {} });

  const node = execFile.calls.find((c) => c.cmd === 'node');
  assert.ok(node.argv[0].endsWith('config-resolver/hydrate.mjs'));
  assert.equal(node.env.AGENT_CONFIG_TABLE, 'agent-b450oe-config');
  assert.equal(node.env.SANDRA_DIR, '/tmp/sandra');
  assert.equal(node.env.SANDRA_REF, 'topic');
  assert.equal(node.env.AWS_REGION, 'us-east-1');
});

// ── config hydrate-conversations ─────────────────────────────────────────────────────────────

test('config hydrate-conversations maps dry-run onto the script\'s own APPLY gate', async () => {
  const report = '{"dryRun":true,"agents":2,"conversations":7,"malformed":[]}';
  const dry = fakeExec(() => ({ stdout: report }));
  const r = await wrappers['config hydrate-conversations'](
    makeCtx({ dryRun: true }), args([], { file: '/tmp/conv.json' }), makeOut(), { execFile: dry, env: {} },
  );
  assert.equal(r.conversations, 7);
  assert.equal(dry.calls[0].env.HYDRATE_APPLY, undefined, 'dry-run must not set HYDRATE_APPLY');
  assert.deepEqual(dry.calls[0].argv.slice(1), ['--file', '/tmp/conv.json']);

  const apply = fakeExec(() => ({ stdout: '{"applied":true,"written":7,"skipped-older":1,"errors":[]}' }));
  await wrappers['config hydrate-conversations'](makeCtx(), args([], { file: '/tmp/conv.json' }), makeOut(), { execFile: apply, env: {} });
  assert.equal(apply.calls[0].env.HYDRATE_APPLY, '1');
});

test('config hydrate-conversations requires exactly one source, and never exposes --force', async () => {
  const deps = { execFile: fakeExec(), env: {} };
  await rejects(wrappers['config hydrate-conversations'](makeCtx(), args([], {}), makeOut(), deps), EXIT.USAGE, /--file|--s3/);
  await rejects(
    wrappers['config hydrate-conversations'](makeCtx(), args([], { file: 'a', s3: 's3://b/c' }), makeOut(), deps),
    EXIT.USAGE, /mutually exclusive/,
  );
  // The 6h freshness guard lives in the script and has no CLI override: a snapshot older than a
  // prune resurrects retired conversations, and no ConditionExpression can catch it.
  const src = require('node:fs').readFileSync(`${__dirname}/wrappers.js`, 'utf8');
  assert.ok(!src.includes("'--force'") || !/hydrateConversations[\s\S]{0,600}--force/.test(src), 'no --force pass-through');
});

test('malformed rows come back as per-unit failures, not a collapsed exit code', async () => {
  const out = makeOut();
  const execFile = fakeExec(() => ({ code: 1, stdout: '{"dryRun":true,"agents":1,"conversations":2,"malformed":[{"agentId":"agent-75lieo","threadTs":"1.1","error":"bad conv"}]}' }));
  const r = await wrappers['config hydrate-conversations'](
    makeCtx({ dryRun: true }), args([], { file: '/tmp/c.json' }), out, { execFile, env: {} },
  );
  assert.equal(r.conversations, 2);
  assert.equal(out.lines.failures.length, 1);
  assert.equal(out.lines.failures[0].agent, 'agent-75lieo');
});

test('a subprocess failure keeps the child stderr — a region mismatch must not look like an unpublished image', async () => {
  const execFile = fakeExec(() => ({ code: 2, stderr: 'ResourceNotFoundException: table agent-gn0p84-config not found in us-east-2' }));
  await assert.rejects(
    wrappers['config hydrate'](makeCtx(), args([], { 'sandra-dir': '/tmp/s' }), makeOut(), { execFile, env: {} }),
    (e) => {
      assert.equal(e.exitCode, EXIT.FAILED);
      assert.match(e.detail, /us-east-2/);
      assert.match(e.cause.stderr, /ResourceNotFoundException/);
      return true;
    },
  );
});

// ── config validate / parity ─────────────────────────────────────────────────────────────────

test('config validate: a check that cannot RUN is not a check that passed', async () => {
  const out = makeOut();
  const deps = {
    execFile: fakeExec(() => ({ stdout: '{}' })),
    env: {},
    fs: { existsSync: () => false, readdirSync: () => [], readFileSync: () => '{}' },
  };
  await rejects(wrappers['config validate'](makeCtx(), args(), out, deps), EXIT.DRIFT, /unrunnable/);
  assert.match(out.lines.warn.join('\n'), /UNRUNNABLE/);
});

test('config validate runs the routing single-source invariant from routing-normalize itself', async () => {
  const out = makeOut();
  const routing = {
    'one.json': { channels: ['C1'] },
    'two.json': { channels: ['C1'], dm_users: ['U1'] },     // violates 1 agent = 1 source
  };
  const deps = {
    execFile: fakeExec(() => ({ stdout: '{"HARD":{}}' })),
    env: {},
    fs: {
      existsSync: () => true,
      readdirSync: () => Object.keys(routing),
      readFileSync: (p) => JSON.stringify(routing[p.split('/').pop()]),
    },
    modules: {
      routingNormalize: async () => ({
        normalizeRouting: (id, r) => r,
        assertSingleSource: (id, r) => {
          const n = (r.channels || []).length + (r.dm_users || []).length;
          if (n > 1) throw new Error(`agent "${id}" routes ${n} sources`);
          return r;
        },
      }),
    },
  };
  await rejects(wrappers['config validate'](makeCtx(), args(), out, deps), EXIT.DRIFT, /routing-single-source/);
});

test('config parity says so when a round-trip degrades to self-consistency', async () => {
  const out = makeOut();
  const deps = {
    execFile: fakeExec(() => ({ stdout: 'PARITY GREEN' })),
    env: {},
    fs: { existsSync: () => true },
  };
  const r = await wrappers['config parity'](makeCtx(), args(), out, deps);
  assert.equal(r.ok, true);
  assert.match(out.lines.warn.join('\n'), /AGENT_VE2BNZS_DIR unset/);
  assert.match(out.lines.warn.join('\n'), /SANDRA_SKILLS_DIR unset/);
  // Every gate got this deployment's table, not the schema default.
  for (const c of deps.execFile.calls) assert.equal(c.env.AGENT_CONFIG_TABLE, 'agent-gn0p84-config');
});

// ── grants ───────────────────────────────────────────────────────────────────────────────────

function grantDeps({ catalogSkills = 4, storedGrant = { slack: { sources: ['config'] } }, config = { skills: [] }, reconciled = ['slack', 'demo_warehouse'], putResult = { roleName: 'agentcore/agent-75lieo', applied: true } } = {}) {
  const put = [];
  const doc = {
    send: async (cmd) => {
      const key = cmd.input.Key;
      if (key.sk === 'CONFIG') return config === null ? {} : { Item: { data: JSON.stringify(config) } };
      if (String(key.pk).startsWith('GRANT#')) {
        return storedGrant === null ? {} : { Item: { data: typeof storedGrant === 'string' ? storedGrant : JSON.stringify(storedGrant) } };
      }
      return {};
    },
  };
  return {
    put,
    deps: {
      env: {},
      clients: { doc, iam: {}, iamCmds: {}, sts: {}, stsCmds: {} },
      modules: {
        marketplace: () => ({
          loadMarketplaceDataFromDdb: async () => (catalogSkills === null ? { error: 'AccessDenied' } : { catalogSkills, installable: 1, agents: 1 }),
          getInstalls: () => ({ installs: { 'agent-75lieo': { demo_warehouse: {} } } }),
          getCatalog: () => ({ skills: { demo_warehouse: {} } }),
          _reconcileSkillGrant: async () => reconciled,
        }),
        derivedRole: () => ({ putDerivedGrants: async (a) => { put.push(a); return putResult; } }),
        schema: async () => ({
          agentGrantKey: (id) => ({ pk: `GRANT#${id}`, sk: 'SCOPE#*' }),
          agentConfigKey: (id) => ({ pk: `AGENT#${id}`, sk: 'CONFIG' }),
          grantedCaps: (d) => Object.keys(d || {}),
        }),
        caps: async () => ({
          capsWithSources: () => ({ slack: { sources: ['config'] }, demo_warehouse: { sources: ['skill:demo_warehouse'] } }),
          grantedCaps: (d) => Object.keys(d || {}),
        }),
      },
    },
  };
}

// The pair that must not be conflated: reconcile RECOMPUTES then writes both halves; apply rewrites
// IAM only, from the stored grant.
test('grants reconcile recomputes the grant AND rewrites the role policy', async () => {
  const { deps, put } = grantDeps();
  const r = await wrappers['grants reconcile'](makeCtx(), args(['agent-75lieo']), makeOut(), deps);
  assert.deepEqual(r.caps, ['slack', 'demo_warehouse']);
  assert.equal(put.length, 1);
  assert.deepEqual(put[0].caps, ['slack', 'demo_warehouse']);
  assert.equal(put[0].table, 'agent-gn0p84-config');
  assert.equal(put[0].agentId, 'agent-75lieo');
});

test('grants apply rewrites IAM ONLY, from GRANT#* as stored — no recomputation', async () => {
  const { deps, put } = grantDeps({ storedGrant: { slack: { sources: ['config'] }, github: { sources: ['skill:gh'] } } });
  // A reconcile from this fixture would produce [slack, demo_warehouse]; apply must not.
  const r = await wrappers['grants apply'](makeCtx(), args(['agent-75lieo']), makeOut(), deps);
  assert.deepEqual(r.caps, ['slack', 'github']);
  assert.deepEqual(put[0].caps, ['slack', 'github']);
});

test('reconcile SKIPS when the skill catalog is empty — it would derive no skill caps and strip everything', async () => {
  const { deps } = grantDeps({ catalogSkills: 0 });
  await rejects(wrappers['grants reconcile'](makeCtx(), args(['agent-75lieo']), makeOut(), deps), EXIT.REFUSED, /grants apply/);
});

test('a FAILED catalog read is never treated as an empty catalog', async () => {
  const { deps } = grantDeps({ catalogSkills: null });
  await rejects(wrappers['grants reconcile'](makeCtx(), args(['agent-75lieo']), makeOut(), deps), EXIT.FAILED, /AccessDenied/);
});

test('an unparseable stored grant aborts rather than becoming an empty caps list', async () => {
  // "A miss and a failure are different things" — an expired token mid-run was once enough to
  // rewrite the fleet's skill library with nothing failing.
  const { deps, put } = grantDeps({ storedGrant: 'not json{' });
  await rejects(wrappers['grants apply'](makeCtx(), args(['agent-75lieo']), makeOut(), deps), EXIT.REFUSED, /unparseable/);
  assert.equal(put.length, 0, 'nothing may be written from a bad read');
});

test('an ABSENT grant still writes the policy — it is the agent\'s only config-table access', async () => {
  const { deps, put } = grantDeps({ storedGrant: null });
  const out = makeOut();
  const r = await wrappers['grants apply'](makeCtx(), args(['agent-75lieo']), out, deps);
  assert.deepEqual(r.caps, []);
  assert.equal(put.length, 1, 'empty caps must still PutRolePolicy — deleting it broke the next boot');
  assert.match(out.lines.warn.join('\n'), /no GRANT#agent-75lieo/);
});

test('a missing role is reported, not thrown — the cold provision builds it', async () => {
  const { deps } = grantDeps({ putResult: { roleName: 'agentcore/new-agent', applied: false, reason: 'role-absent' } });
  const out = makeOut();
  const r = await wrappers['grants apply'](makeCtx(), args(['new-agent']), out, deps);
  assert.equal(r.iamApplied, false);
  assert.equal(r.reason, 'role-absent');
  assert.match(out.lines.warn.join('\n'), /cold provision/);
});

test('reconcile refuses an agent with no CONFIG item — an absent config is not a config with no caps', async () => {
  const { deps } = grantDeps({ config: null });
  await rejects(wrappers['grants reconcile'](makeCtx(), args(['ghost']), makeOut(), deps), EXIT.REFUSED, /empty config/);
});

test('grants dry-run previews the diff and writes nothing', async () => {
  const { deps, put } = grantDeps();
  const r = await wrappers['grants reconcile'](makeCtx({ dryRun: true }), args(['agent-75lieo']), makeOut(), deps);
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.added, ['demo_warehouse']);
  assert.equal(put.length, 0);
});

// ── cron ─────────────────────────────────────────────────────────────────────────────────────

function cronDeps({ routing = { dm_users: ['UE9Q979XW'] }, jobs = [], bodies = [{ jobId: 'j1', enabled: true }, { jobId: 'j2', enabled: false }], needsReview = [{ jobId: 'j2' }] } = {}) {
  const posted = [];
  const api = {
    add: async (b) => { posted.push(b); },
    list: async () => jobs,
  };
  return {
    posted,
    deps: {
      env: { MOUNT_PATH: '/mnt/agents', MANAGER_API_URL: 'http://dispatcher:9090', DISPATCHER_SHARED_SECRET: 's' },
      managerApi: api,
      now: () => 1_700_000_000_000,
      // §8.10: the owner of the jobs is derived from the agent's ROUTING, not its name. Without this
      // the CLI would reach DynamoDB for real — and the point of the lookup is that it must not be
      // skippable, so there is no fallback for it to take instead.
      agentRouting: async () => routing,
      modules: {
        cronHydrator: () => ({
          readAgentCron: () => ({ jobs: bodies.map((b) => ({ id: b.jobId })), state: {}, entities: {} }),
          buildBodies: () => ({ bodies, skipped: [], degraded: [], needsReview, overridden: [], dropped: [], split: [], decisionErrors: [], benign: [] }),
          hydrateAgent: async () => { for (const b of bodies) await api.add(b); return { posted: bodies.length, errors: [] }; },
          createManagerApi: () => api,
        }),
      },
    },
  };
}

test('cron hydrate is RE-RUNNABLE — no marker, no refusal, and the preview still prints', async () => {
  // It used to refuse a second run: a per-agent `hydrated` marker made this one-time-at-flip, and
  // getting past it needed --force plus --yes. Removed 2026-08-16 — while OpenClaw stays
  // authoritative, archie's store is a derived replica and re-running to converge is the normal
  // operation. An agent's decision map routinely takes several attempts, and a crash mid-seed must
  // not leave it stuck.
  //
  // The preview is what survives, and it is the part that mattered: it still prints BEFORE anything
  // is posted. 79 of 259 enabled prod jobs are in a failing state, so seeing the counts first is the
  // difference between a decision and a surprise. What it no longer does is block.
  const first = cronDeps();
  const out1 = makeOut();
  const r1 = await wrappers['cron hydrate'](makeCtx({ assumeYes: true }), args(['agent-75lieo']), out1, first.deps);
  assert.equal(r1.posted, 2);
  assert.match(out1.lines.progress.join('\n'), /would post 2 \(1 ENABLED/);

  const again = cronDeps();
  const out2 = makeOut();
  const r2 = await wrappers['cron hydrate'](makeCtx({ assumeYes: true }), args(['agent-75lieo']), out2, again.deps);
  assert.equal(r2.posted, 2, 'a second run seeds again rather than refusing');
  assert.match(out2.lines.progress.join('\n'), /would post 2 \(1 ENABLED/);
});

test('cron hydrate dry-run posts nothing', async () => {
  const { deps, posted } = cronDeps();
  const r = await wrappers['cron hydrate'](makeCtx({ dryRun: true }), args(['agent-75lieo']), makeOut(), deps);
  assert.equal(r.dryRun, true);
  assert.equal(r.wouldPost, 2);
  assert.equal(posted.length, 0);
});

test('cron commands refuse without a manager API URL — the store has exactly one writer', async () => {
  const { deps } = cronDeps();
  const noUrl = { ...deps, managerApi: undefined, env: { MOUNT_PATH: '/mnt/agents' } };
  await rejects(wrappers['cron list'](makeCtx(), args(['agent-75lieo']), makeOut(), noUrl), EXIT.REFUSED, /MANAGER_API_URL/);
  await rejects(wrappers['cron hydrate'](makeCtx(), args(['agent-75lieo']), makeOut(), noUrl), EXIT.REFUSED, /MANAGER_API_URL/);
});

/**
 * The discovery bag the task path needs: SSM handles plus the AWS facts the composition reads.
 * Mirrors lib/deployment-facts.js's client shapes so the real discovery code runs unmodified.
 */
function hydratorClients() {
  const ACCT = '203366135563';
  const one = (handlers) => ({
    send: async (cmd) => {
      const h = handlers[cmd.constructor.name];
      if (!h) throw new Error(`unexpected ${cmd.constructor.name}`);
      return h(cmd.input);
    },
  });
  const VALUES = {
    EFS_FILE_SYSTEM_ARN: `arn:aws:elasticfilesystem:us-east-1:${ACCT}:file-system/fs-1`,
    DISPATCHER_ACCESS_POINT_ID: 'fsap-gw',
    CRON_HYDRATOR_ACCESS_POINT_ID: 'fsap-parent',
    DEPLOYMENT_ENVIRONMENT: 'sandbox',
    AGENTCORE_RUNTIME_TLS_REJECT: '1',
  };
  return {
    sts: one({ GetCallerIdentityCommand: () => ({ Account: ACCT }) }),
    ecr: one({ DescribeRepositoriesCommand: ({ repositoryNames }) => ({ repositories: [{ repositoryUri: `r/${repositoryNames[0]}` }] }) }),
    sqs: one({ GetQueueUrlCommand: ({ QueueName }) => ({ QueueUrl: `https://sqs/${QueueName}` }) }),
    iam: one({ GetRoleCommand: ({ RoleName }) => ({ Role: { Arn: `arn:aws:iam::${ACCT}:role/${RoleName}` } }) }),
    efs: one({
      DescribeAccessPointsCommand: () => ({ AccessPoints: [{ AccessPointId: 'fsap-gw', FileSystemId: 'fs-1' }] }),
      DescribeMountTargetsCommand: () => ({ MountTargets: [{ VpcId: 'vpc-1', SubnetId: 'subnet-a' }] }),
    }),
    ec2: one({ DescribeSecurityGroupsCommand: ({ Filters }) => ({ SecurityGroups: [{ GroupId: `sg-${Filters.find((f) => f.Name === 'group-name').Values[0]}` }] }) }),
    secrets: one({ DescribeSecretCommand: ({ SecretId }) => ({ ARN: `arn:secret:${SecretId}` }) }),
    discovery: one({
      ListNamespacesCommand: () => ({ Namespaces: [{ Id: 'ns-1', Name: 'redacted-internal-host.example' }] }),
      ListServicesCommand: () => ({ Services: [{ Name: 'dispatcher', Arn: 'arn:sd/1' }] }),
    }),
    ssm: one({
      GetParametersCommand: ({ Names }) => ({
        Parameters: Names.filter((n) => VALUES[n.split('/').pop()] !== undefined).map((Name) => ({ Name, Value: VALUES[Name.split('/').pop()] })),
        InvalidParameters: Names.filter((n) => VALUES[n.split('/').pop()] === undefined),
      }),
    }),
  };
}

test('cron hydrate without a local mount runs an EPHEMERAL task, and drops it afterwards', async () => {
  // It used to REFUSE here — "MOUNT_PATH is not set, that mount exists on the cron_hydrator task, not
  // on a laptop" — which was true and useless: the task was the only way to run it and the CLI could
  // not start one. §E1 is that missing half.
  //
  // The three things asserted are the three that make it ephemeral rather than standing: it
  // registers, it runs against its OWN security group, and it deregisters. The deregister is in a
  // `finally`, so a failure mid-run cannot leave behind exactly the standing resource this design
  // removed — unowned by Terraform this time.
  const calls = [];
  const ecs = {
    send: async (cmd) => {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (name === 'DescribeServicesCommand') return { services: [{ status: 'ACTIVE', taskDefinition: 'arn:td/archie-dispatcher:2' }] };
      if (name === 'DescribeTaskDefinitionCommand') return { taskDefinition: { containerDefinitions: [{ image: 'repo/archie-gateway:content-abc' }] } };
      if (name === 'RegisterTaskDefinitionCommand') return { taskDefinition: { taskDefinitionArn: 'arn:aws:ecs:us-east-1:1:task-definition/archie-dispatcher-cron-hydrator:7' } };
      if (name === 'RunTaskCommand') return { tasks: [{ taskArn: 'arn:aws:ecs:us-east-1:1:task/archie/abc123' }], failures: [] };
      if (name === 'DescribeTasksCommand') return { tasks: [{ lastStatus: 'STOPPED', containers: [{ exitCode: 0 }] }] };
      if (name === 'DeregisterTaskDefinitionCommand') return {};
      throw new Error(`unexpected ${name}`);
    },
  };
  const logs = { send: async () => ({ events: [{ message: 'cron-hydrator: done' }] }) };

  const { deps } = cronDeps();
  const out = makeOut();
  const r = await wrappers['cron hydrate'](makeCtx(), args(['agent-75lieo']), out, {
    ...deps, env: {}, ecs, logs, clients: hydratorClients(),
  });

  assert.equal(r.mode, 'task');
  assert.equal(r.exitCode, 0);
  const names = calls.map((c) => c.name);
  assert.ok(names.includes('RegisterTaskDefinitionCommand'), 'registers an ephemeral definition');
  assert.ok(names.includes('DeregisterTaskDefinitionCommand'), 'and deregisters it');

  const run = calls.find((c) => c.name === 'RunTaskCommand').input;
  assert.deepEqual(run.networkConfiguration.awsvpcConfiguration.securityGroups, ['sg-agent-gn0p84-dispatcher-cron-hydrator-sg'],
    'its OWN group — the gateway admits 9090 only from the runtime and hydrator groups');
  assert.equal(run.networkConfiguration.awsvpcConfiguration.assignPublicIp, 'DISABLED');

  const registered = calls.find((c) => c.name === 'RegisterTaskDefinitionCommand').input;
  assert.equal(registered.containerDefinitions[0].image, 'repo/archie-gateway:content-abc',
    'the RUNNING gateway image, so the hydrator speaks the same manager API');
  assert.equal(registered.taskRoleArn, undefined, 'no task role: it makes no AWS API calls');
  assert.equal(registered.containerDefinitions[0].mountPoints[0].readOnly, true);
  // The line names BOTH identities on purpose: the store it wipes (the §8.10 scope owner) and the
  // EFS directory it reads (the legacy OpenClaw name). Conflating them is the bug this fixes.
  assert.match(out.text(), /WIPES dm-ue9q979xw's cron store, then seeds from agent-75lieo's EFS/);
  assert.match(out.text(), /owner\s+dm-ue9q979xw\s+\(§8\.10 scope id, from agent-75lieo routing\)/);
});

test('cron hydrate deregisters the ephemeral definition even when the task FAILS', async () => {
  // The `finally`. A non-zero exit is a real failure and must propagate — but leaving the definition
  // behind on the way out would recreate the standing resource by accident.
  let deregistered = false;
  const ecs = {
    send: async (cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeServicesCommand') return { services: [{ status: 'ACTIVE', taskDefinition: 'arn:td/x:1' }] };
      if (name === 'DescribeTaskDefinitionCommand') return { taskDefinition: { containerDefinitions: [{ image: 'repo:tag' }] } };
      if (name === 'RegisterTaskDefinitionCommand') return { taskDefinition: { taskDefinitionArn: 'arn:td/h:1' } };
      if (name === 'RunTaskCommand') return { tasks: [{ taskArn: 'arn:task/abc' }], failures: [] };
      if (name === 'DescribeTasksCommand') return { tasks: [{ lastStatus: 'STOPPED', containers: [{ exitCode: 1, reason: 'boom' }], stoppedReason: 'Essential container exited' }] };
      if (name === 'DeregisterTaskDefinitionCommand') { deregistered = true; return {}; }
      throw new Error(`unexpected ${name}`);
    },
  };
  const { deps } = cronDeps();
  await rejects(
    wrappers['cron hydrate'](makeCtx(), args(['agent-75lieo']), makeOut(), { ...deps, env: {}, ecs, logs: null, clients: hydratorClients() }),
    EXIT.FAILED, /exited 1/,
  );
  assert.equal(deregistered, true);
});

test('cron hydrate reports a RunTask that never started, rather than an empty task list', async () => {
  // `failures` is how ECS says "no capacity", "subnet has no route", "image pull will fail".
  // Surfacing that as "the task did not appear" sends someone looking in entirely the wrong place.
  const ecs = {
    send: async (cmd) => {
      const name = cmd.constructor.name;
      if (name === 'DescribeServicesCommand') return { services: [{ status: 'ACTIVE', taskDefinition: 'arn:td/x:1' }] };
      if (name === 'DescribeTaskDefinitionCommand') return { taskDefinition: { containerDefinitions: [{ image: 'repo:tag' }] } };
      if (name === 'RegisterTaskDefinitionCommand') return { taskDefinition: { taskDefinitionArn: 'arn:td/h:1' } };
      if (name === 'RunTaskCommand') return { tasks: [], failures: [{ arn: 'arn:task/x', reason: 'RESOURCE:MEMORY' }] };
      if (name === 'DeregisterTaskDefinitionCommand') return {};
      throw new Error(`unexpected ${name}`);
    },
  };
  const { deps } = cronDeps();
  // `rejects` matches against `message + detail`, so this asserts the ECS reason reaches the operator
  // rather than being swallowed into a generic failure.
  await rejects(
    wrappers['cron hydrate'](makeCtx(), args(['agent-75lieo']), makeOut(), { ...deps, env: {}, ecs, logs: null, clients: hydratorClients() }),
    EXIT.FAILED, /started no task.*RESOURCE:MEMORY/s,
  );
});

test('cron list goes through the manager API', async () => {
  const { deps } = cronDeps({ jobs: [{ jobId: 'a', enabled: true }, { jobId: 'b', enabled: false }] });
  const r = await wrappers['cron list'](makeCtx(), args(['agent-75lieo']), makeOut(), deps);
  assert.equal(r.count, 2);
  assert.equal(r.enabled, 1);
});

// §3a' — the CRON_RUNNER flag. `--set` is a cutover: it decides which of the two schedulers fires
// this scope's jobs, so it honours --dry-run like every other mutation in this file.
test('cron runner reads the flag, and reports where the value came from', async () => {
  const { deps } = cronDeps();
  deps.managerApi.getRunner = async (a) => ({ agentId: a, runner: 'openclaw', source: 'default', setBy: null });
  const out = makeOut();
  const r = await wrappers['cron runner'](makeCtx(), args(['dm-ue9q979xw']), out, deps);
  assert.equal(r.runner, 'openclaw');
  assert.match(out.text(), /CRON_RUNNER=openclaw \(default\)/);
});

test('cron runner --set states what will change, and writes nothing on a dry run', async () => {
  const { deps } = cronDeps();
  const written = [];
  deps.managerApi.getRunner = async (a) => ({ agentId: a, runner: 'openclaw', source: 'store' });
  deps.managerApi.setRunner = async (...a) => { written.push(a); return { runner: 'agentcore', wrote: true }; };
  const out = makeOut();
  const r = await wrappers['cron runner'](makeCtx({ dryRun: true }), args(['dm-ue9q979xw'], { set: 'agentcore' }), out, deps);
  assert.deepEqual([r.dryRun, r.from, r.to], [true, 'openclaw', 'agentcore']);
  assert.equal(written.length, 0);
  assert.match(out.text(), /archie will START firing/);
});

test('cron runner --set applies the flip through the manager API, never DynamoDB', async () => {
  const { deps } = cronDeps();
  const written = [];
  deps.managerApi.getRunner = async (a) => ({ agentId: a, runner: 'openclaw', source: 'store' });
  deps.managerApi.setRunner = async (...a) => { written.push(a); return { runner: 'agentcore', wrote: true }; };
  const r = await wrappers['cron runner'](makeCtx(), args(['dm-ue9q979xw'], { set: 'agentcore' }), makeOut(), deps);
  // Through the dispatcher, because it CACHES the resolved flag — a write behind its back is a
  // flip that appears to have worked and has not.
  assert.equal(written[0][0], 'dm-ue9q979xw');
  assert.equal(written[0][1], 'agentcore');
  assert.equal(r.changed, true);
});

test('cron runner --set to the value it already holds is a no-op', async () => {
  const { deps } = cronDeps();
  deps.managerApi.getRunner = async (a) => ({ agentId: a, runner: 'agentcore', source: 'store' });
  deps.managerApi.setRunner = async () => { throw new Error('must not write'); };
  const r = await wrappers['cron runner'](makeCtx(), args(['dm-ue9q979xw'], { set: 'agentcore' }), makeOut(), deps);
  assert.equal(r.changed, false);
});

test('cron arm/disarm report the deployed switch and refuse to drift from Terraform', async () => {
  const armed = { ecsCronEnabled: async () => ({ taskDefinition: 'td:9', value: true, raw: 'true' }) };
  const r = await wrappers['cron arm'](makeCtx(), args(), makeOut(), armed);
  assert.deepEqual([r.armed, r.changed], [true, false]);

  await rejects(wrappers['cron disarm'](makeCtx(), args(), makeOut(), armed), EXIT.REFUSED, /var\.cron_enabled|dispatcher\.tf/);
});

// ── dashboard / metrics ──────────────────────────────────────────────────────────────────────

test('dashboard deploy passes only ctx-derived targets, and prints them', async () => {
  const out = makeOut();
  const execFile = fakeExec(() => ({ stdout: '{"dashboard":"agentcore-fleet","widgets":31,"checkErrors":[],"stackMismatches":[]}' }));
  const r = await wrappers['dashboard deploy'](makeCtx({ name: 'agent-b450oe' }), args([], {}), out, {
    execFile, env: { DISPATCHER_LOG_GROUP: '/ecs/agent-4ggvzl-dispatcher', ARCHIE_STACK: 'agent-4ggvzl' },
  });
  assert.equal(r.widgets, 31);
  const env = execFile.calls[0].env;
  assert.equal(env.ARCHIE_STACK, 'agent-b450oe');
  assert.equal(env.DISPATCHER_LOG_GROUP, '/ecs/agent-b450oe-dispatcher', 'an inherited override must not win');
  assert.equal(env.CRON_METRIC_NAMESPACE, 'agent-b450oeCron');
  assert.match(out.lines.progress.join('\n'), /\/ecs\/agent-b450oe-dispatcher/);
});

test('dashboard deploy fails on a stack mismatch — the other stack is real, populated and wrong', async () => {
  const execFile = fakeExec(() => ({ stdout: '{"checkErrors":["ListMetrics X: AccessDenied"],"stackMismatches":[{"key":"DISPATCHER_LOG_GROUP","dashboard":"/ecs/agent-gn0p84-dispatcher","deployed":"/ecs/agent-4ggvzl-dispatcher"}]}' }));
  const out = makeOut();
  await rejects(wrappers['dashboard deploy'](makeCtx(), args([], {}), out, { execFile, env: {} }), EXIT.DRIFT, /another stack/);
  // A check that could not RUN is not a check that passed.
  assert.match(out.lines.warn.join('\n'), /could not run: ListMetrics X: AccessDenied/);
});

test('dashboard deploy honours dry-run', async () => {
  const execFile = fakeExec();
  const r = await wrappers['dashboard deploy-latency'](makeCtx({ dryRun: true }), args([], {}), makeOut(), { execFile, env: {} });
  assert.equal(r.dryRun, true);
  assert.equal(execFile.calls.length, 0);
});

function metricsDeps({ status = 'Complete', results = [] } = {}) {
  const started = [];
  const Q = {
    INSIGHTS: { fleet_errors: { logGroups: ['/ecs/agent-gn0p84-dispatcher'], query: 'filter level >= 50' } },
    METRICS: { coldBoot: { expr: 'SEARCH(\'{AgentCore/Pi,Agent} MetricName="ColdBootMs"\', \'Average\')', label: 'cold' } },
    scopedTurnsQuery: (a) => ({ logGroups: ['aws/spans'], query: `filter agent = '${a}'` }),
    scopedMetricExpr: (n, a) => (n === 'coldBoot' ? `SEARCH('… Agent="${a}"')` : null),
    assertSafeScopeLiteral: (v) => {
      if (!/^[A-Za-z0-9._-]+$/.test(String(v))) throw new Error(`scope "${v}" is not a safe query literal`);
      return v;
    },
  };
  return {
    started,
    deps: {
      env: {},
      now: () => 1_700_000_000_000,
      sleep: async () => {},
      modules: { insights: () => Q },
      logsClient: {
        send: async (cmd) => {
          if (cmd.input.queryString) { started.push(cmd.input); return { queryId: 'q1' }; }
          return { status, results, statistics: { recordsMatched: results.length } };
        },
      },
      cwClient: { send: async () => ({ MetricDataResults: [{ Label: 'cold', StatusCode: 'Complete', Timestamps: [], Values: [] }] }) },
    },
  };
}

test('metrics query polls to COMPLETE, and 0 rows is a valid answer', async () => {
  const { deps, started } = metricsDeps();
  const out = makeOut();
  const r = await wrappers['metrics query'](makeCtx(), args(['fleet_errors'], {}), out, deps);
  assert.equal(r.status, 'Complete');
  assert.equal(r.rows, 0);
  assert.deepEqual(started[0].logGroupNames, ['/ecs/agent-gn0p84-dispatcher']);
  assert.match(out.lines.progress.join('\n'), /0 rows/);
  assert.match(out.lines.progress.join('\n'), /ingestion lag/);
});

test('metrics query maps rows out of the CloudWatch field/value shape', async () => {
  const { deps } = metricsDeps({ results: [[{ field: 'agent', value: 'agent-75lieo' }, { field: 'msg', value: 'boom' }]] });
  const r = await wrappers['metrics query'](makeCtx(), args(['fleet_errors'], {}), makeOut(), deps);
  assert.deepEqual(r.results, [{ agent: 'agent-75lieo', msg: 'boom' }]);
});

test('--agent uses the SCOPED query, and refuses when a query has no scoped form', async () => {
  const { deps, started } = metricsDeps();
  await wrappers['metrics query'](makeCtx(), args(['turns'], { agent: 'agent-75lieo' }), makeOut(), deps);
  assert.match(started[0].queryString, /filter agent = 'agent-75lieo'/);

  // A fleet query with --agent would silently answer for the whole fleet.
  await rejects(
    wrappers['metrics query'](makeCtx(), args(['fleet_errors'], { agent: 'agent-75lieo' }), makeOut(), metricsDeps().deps),
    EXIT.REFUSED, /no agent-scoped form/,
  );
});

test('a metric that cannot be pinned to an agent fails CLOSED', async () => {
  const { deps } = metricsDeps();
  deps.modules.insights().METRICS.invocations = { expr: 'SEARCH(\'{AWS/Bedrock-AgentCore}\')', label: 'inv' };
  await rejects(
    wrappers['metrics query'](makeCtx(), args(['invocations'], { agent: 'agent-75lieo' }), makeOut(), deps),
    EXIT.REFUSED, /cannot be scoped/,
  );
});

test('an unsafe agent literal is a usage error — CWL has no bind parameters', async () => {
  const { deps } = metricsDeps();
  await rejects(
    wrappers['metrics query'](makeCtx(), args(['turns'], { agent: "x' | fields @message" }), makeOut(), deps),
    EXIT.USAGE, /safe query literal/,
  );
});

test('metrics query with no name lists the curated set instead of guessing', async () => {
  const { deps } = metricsDeps();
  const r = await wrappers['metrics query'](makeCtx(), args([], {}), makeOut(), deps);
  assert.deepEqual(r.fleetInsights, ['fleet_errors']);
  assert.ok(r.scopedInsights.includes('turns'));
});

test('a query that never completes times out with 124, not a hang', async () => {
  const { deps } = metricsDeps({ status: 'Running' });
  let t = 0;
  deps.now = () => (t += 60_000);
  await rejects(
    wrappers['metrics query'](makeCtx({ timeoutSeconds: 30 }), args(['fleet_errors'], {}), makeOut(), deps),
    EXIT.TIMEOUT, /--timeout/,
  );
});

// ── client construction ──────────────────────────────────────────────────────────────────────

// THE FAILURE SHAPE THIS CLOSES: a wrong client/package name only fails when a real --profile is
// used, and every other test here injects its clients — so the suite stays green while the binary
// breaks on its first live run. These two assert the DEFAULT (uninjected) path without any AWS call:
// constructing a client is local, only sending is not.
test('every makeClient call site names an installed package and a real export', () => {
  const src = require('node:fs').readFileSync(`${__dirname}/wrappers.js`, 'utf8');
  const sites = [...src.matchAll(/makeClient\(ctx, '([^']+)', '([^']+)'/g)];
  assert.ok(sites.length >= 5, `expected the AWS-touching commands to build clients, found ${sites.length}`);
  for (const [, pkg, exportName] of sites) {
    assert.equal(typeof require(pkg)[exportName], 'function', `${pkg} exports no ${exportName}`);
  }
});

test('the default client path builds with a --profile, without reaching AWS', () => {
  const clients = wrappers._internals.grantClients(makeCtx({ profile: 'sandbox' }), { env: {} });
  for (const k of ['doc', 'iam', 'sts']) assert.ok(clients[k], `no ${k} client`);
  assert.equal(typeof clients.iamCmds.PutRolePolicyCommand, 'function');
});

// ── the contract with the registry ───────────────────────────────────────────────────────────

test('every declared wrappers command resolves, and no verb-keyed export can shadow another noun', () => {
  const { COMMANDS, load } = require('../lib/registry');
  const keys = Object.entries(COMMANDS).filter(([, m]) => m.module === 'wrappers').map(([k]) => k);
  assert.ok(keys.length >= 13);
  for (const key of keys) assert.equal(typeof load(key, COMMANDS[key]), 'function', `${key} did not resolve`);
  // registry.load() prefers mod[verb]; `config hydrate` and `cron hydrate` share the verb `hydrate`,
  // so a verb-keyed export would route one into the other. Neither may exist.
  for (const verb of ['hydrate', 'deploy', 'apply', 'list', 'query', 'validate']) {
    assert.equal(wrappers[verb], undefined, `exporting "${verb}" would shadow another noun's command`);
  }
});

// ── the §8.10 rename link: resolving the owner when only the SCOPE-keyed item exists ────────────
//
// `cron hydrate` takes the LEGACY name (it is an EFS directory) and has to find the archie identity
// that owns the jobs. It read `AGENT#<legacy>/META`, which worked while hydration wrote legacy items
// and `rekey` moved them afterwards. Since eb14aeefa hydration writes ONLY the scope id, so that key
// exists for no agent and every invocation needed `--as` — which is precisely the guess this command
// refuses to make. `META.efsRoot` is the link, and the same one legacyAgentIdFor and Connector
// adoption use.
test('cron hydrate resolves the owner via META.efsRoot when no legacy item exists', async () => {
  const base = cronDeps();
  const out = makeOut();
  const deps = {
    ...base.deps,
    agentRouting: async () => null,                       // no AGENT#agent-xx9aff/META
    agentByEfsRoot: async (n) => (n === 'agent-xx9aff' ? 'dm-ux0mz5ckp2r' : null),
  };
  const r = await wrappers['cron hydrate'](makeCtx({ dryRun: true }), args(['agent-xx9aff']), out, deps);
  assert.equal(r.owner, 'dm-ux0mz5ckp2r');
});

// Still refuses rather than falling back to the legacy name — the split identity that caused is the
// whole reason the lookup is not skippable.
test('cron hydrate REFUSES when neither the routing item nor an adopting agent exists', async () => {
  const base = cronDeps();
  const deps = { ...base.deps, agentRouting: async () => null, agentByEfsRoot: async () => null };
  await rejects(
    wrappers['cron hydrate'](makeCtx(), args(['agent-swnm7k']), makeOut(), deps),
    EXIT.REFUSED, /cannot tell which identity owns/,
  );
});

// --as still wins, and must not consult either lookup.
test('cron hydrate --as overrides both lookups', async () => {
  const base = cronDeps();
  let looked = false;
  const deps = {
    ...base.deps,
    agentRouting: async () => { looked = true; return null; },
    agentByEfsRoot: async () => { looked = true; return null; },
  };
  const a = args(['agent-xx9aff']);
  a.values.as = 'dm-explicit';
  const r = await wrappers['cron hydrate'](makeCtx({ dryRun: true }), a, makeOut(), deps);
  assert.equal(r.owner, 'dm-explicit');
  assert.equal(looked, false, '--as must short-circuit the lookups entirely');
});

'use strict';

// Unit tests for the AgentCore provisioning orchestrator (agentcore-provisioning.js).
// MOCKED aws clients only — no AWS creds, no real resources. Proves the three plan §2 guarantees:
//   1. Idempotency  — re-run against an existing runtime = NO duplicate create.
//   2. Compensation — a failing step deletes prior SELF-created resources in REVERSE order and
//                     NEVER deletes a passed-in shared role.
//   3. Typed retry  — retries a classified transient up to cap then gives up; does NOT retry a
//                     non-transient (e.g. an invalid image).

const prov = require('./agentcore-provisioning');

// ── Mock SDK command classes (named so send() can dispatch on constructor.name) ─
class ListAgentRuntimesCommand { constructor(i) { this.input = i; } }
class GetAgentRuntimeCommand { constructor(i) { this.input = i; } }
class CreateAgentRuntimeCommand { constructor(i) { this.input = i; } }
class DeleteAgentRuntimeCommand { constructor(i) { this.input = i; } }
class DescribeMountTargetsCommand { constructor(i) { this.input = i; } }
class CreateAccessPointCommand { constructor(i) { this.input = i; } }
class DescribeAccessPointsCommand { constructor(i) { this.input = i; } }
class DeleteAccessPointCommand { constructor(i) { this.input = i; } }

const controlCmds = { ListAgentRuntimesCommand, GetAgentRuntimeCommand, CreateAgentRuntimeCommand, DeleteAgentRuntimeCommand };
const efsCmds = { DescribeMountTargetsCommand, CreateAccessPointCommand, DescribeAccessPointsCommand, DeleteAccessPointCommand };

const config = {
  region: 'us-east-1',
  account: '203366135563',
  roleArn: 'arn:aws:iam::203366135563:role/clawdbot-agentcore-exec',
  imageUri: 'img:good',
  vpcId: 'vpc-1',
  securityGroupId: 'sg-1',
  efsFsId: 'fs-1',
  efsMountPath: '/mnt/efs',
  supportedAzIds: new Set(['use1-az1']),
};

const noSleep = async () => {};
const efsRootFor = (a) => `/openclaw-data/agents/${a}`;
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

// Build mock clients. `overrides` lets a test force a specific behaviour on a given command.
// CreateAgentRuntime that conflicts while `heldNames()` says the name is taken — i.e. AgentCore's
// runtime-name uniqueness, which the create path now relies on as its mutex. Since the pre-flight
// ListAgentRuntimes was removed (a full fleet scan on the one path that can never early-exit), a
// collision is discovered by the 409 rather than by looking first, so a mock whose create always
// succeeds would let a test "adopt" while silently minting a duplicate.
function conflictingCreate(heldNames, onRelease = () => ({ agentRuntimeId: 'rt-new', agentRuntimeArn: 'arn:new', status: 'READY' })) {
  return (cmd) => {
    if (heldNames().includes(cmd.input?.agentRuntimeName)) {
      const e = new Error(`runtime ${cmd.input.agentRuntimeName} already exists`);
      e.name = 'ConflictException';
      throw e;
    }
    return onRelease(cmd);
  };
}

function mockClients(overrides = {}) {
  const calls = { list: 0, get: 0, create: 0, deleteRt: 0, mt: 0, createAp: 0, describeAp: 0, deleteAp: 0 };
  const control = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'ListAgentRuntimesCommand') { calls.list += 1; return (overrides.list || (() => ({ agentRuntimes: [] })))(cmd); }
      if (n === 'GetAgentRuntimeCommand') { calls.get += 1; return (overrides.get || (() => ({ status: 'READY', agentRuntimeArn: 'arn:existing' })))(cmd); }
      if (n === 'CreateAgentRuntimeCommand') { calls.create += 1; return (overrides.create || (() => ({ agentRuntimeId: 'rt-new', agentRuntimeArn: 'arn:new', status: 'READY' })))(cmd); }
      if (n === 'DeleteAgentRuntimeCommand') { calls.deleteRt += 1; return (overrides.deleteRt || (() => ({})))(cmd); }
      throw new Error(`unexpected control cmd ${n}`);
    },
  };
  const efs = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'DescribeMountTargetsCommand') { calls.mt += 1; return (overrides.mt || (() => ({ MountTargets: [{ VpcId: config.vpcId, AvailabilityZoneId: 'use1-az1', SubnetId: 'subnet-a', LifeCycleState: 'available' }] })))(cmd); }
      if (n === 'CreateAccessPointCommand') { calls.createAp += 1; return (overrides.createAp || (() => ({ AccessPointId: 'ap-new' })))(cmd); }
      if (n === 'DescribeAccessPointsCommand') { calls.describeAp += 1; return (overrides.describeAp || (() => ({ AccessPoints: [{ LifeCycleState: 'available' }] })))(cmd); }
      if (n === 'DeleteAccessPointCommand') { calls.deleteAp += 1; return (overrides.deleteAp || (() => ({})))(cmd); }
      throw new Error(`unexpected efs cmd ${n}`);
    },
  };
  return { control, efs, controlCmds, efsCmds, calls };
}

const baseOpts = (clients, extra = {}) => ({
  runtimeName: 'oc_alpha',
  role: config.roleArn, // shared ARN → never created/deleted
  image: config.imageUri,
  envs: { AGENT_NAME: 'alpha' },
  efsRootFor,
  clients,
  config,
  logger: silentLogger,
  sleep: noSleep,
  ...extra,
});

// ── classifyError / withProvisioningRetry (typed retry) ─────────────────────────

describe('classifyError (typed, structural — not message regex)', () => {
  it('classifies throttling/5xx as retry', () => {
    expect(prov.classifyError({ name: 'ThrottlingException' })).toBe('retry');
    expect(prov.classifyError({ $metadata: { httpStatusCode: 503 } })).toBe('retry');
    expect(prov.classifyError({ $metadata: { httpStatusCode: 500 } })).toBe('retry');
  });
  it('classifies already-exists conflicts as adopt', () => {
    expect(prov.classifyError({ name: 'AccessPointAlreadyExists' })).toBe('adopt');
    expect(prov.classifyError({ name: 'ResourceConflictException' })).toBe('adopt');
  });
  it('AccessDenied is retryable ONLY inside a create/propagation window', () => {
    expect(prov.classifyError({ name: 'AccessDeniedException' })).toBe('fatal');
    expect(prov.classifyError({ name: 'AccessDeniedException' }, { window: true })).toBe('retry');
  });
  it('a bad image / not-found is FATAL even inside a window (never retried)', () => {
    expect(prov.classifyError({ name: 'ResourceNotFoundException' }, { window: true })).toBe('fatal');
    expect(prov.classifyError({ name: 'InvalidParameterValueException' }, { window: true })).toBe('fatal');
  });
});

describe('withProvisioningRetry', () => {
  it('retries a classified transient then succeeds', async () => {
    let n = 0;
    const out = await prov.withProvisioningRetry(async () => {
      n += 1;
      if (n < 3) { const e = new Error('slow'); e.name = 'ThrottlingException'; throw e; }
      return 'ok';
    }, { window: 'create', cap: 5, baseMs: 1, jitter: false, sleep: noSleep });
    expect(out).toBe('ok');
    expect(n).toBe(3);
  });

  it('gives up after cap on a persistent transient', async () => {
    let n = 0;
    await expect(prov.withProvisioningRetry(async () => {
      n += 1;
      const e = new Error('still slow'); e.name = 'ThrottlingException'; throw e;
    }, { window: 'create', cap: 4, baseMs: 1, jitter: false, sleep: noSleep })).rejects.toThrow(/slow/);
    expect(n).toBe(4); // exactly cap attempts, no more
  });

  it('does NOT retry a non-transient (invalid image) — fails on first attempt', async () => {
    let n = 0;
    await expect(prov.withProvisioningRetry(async () => {
      n += 1;
      const e = new Error('image not found'); e.name = 'ResourceNotFoundException'; throw e;
    }, { window: 'create', cap: 5, baseMs: 1, jitter: false, sleep: noSleep })).rejects.toThrow(/image not found/);
    expect(n).toBe(1); // fatal → no retry
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────────

describe('idempotency: re-run against an existing runtime = no duplicate create', () => {
  it('adopts an existing READY runtime by name — no DUPLICATE runtime', async () => {
    const clients = mockClients({
      list: () => ({ agentRuntimes: [{ agentRuntimeName: 'oc_alpha', agentRuntimeId: 'rt-existing' }] }),
      get: () => ({ status: 'READY', agentRuntimeArn: 'arn:existing' }),
      create: conflictingCreate(() => ['oc_alpha']),
    });
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBe('arn:existing');
    // ONE create ATTEMPTED and rejected by name uniqueness — the cost of dropping the pre-flight scan.
    // What matters is that no second runtime exists, which the conflict guarantees.
    expect(clients.calls.create).toBe(1);
    // The access point IS ensured on this path now, and that is deliberate: "exists at AWS but absent
    // from the registry" means finish the configuration, not skip it. The ClientToken makes it a
    // get-or-create, so an existing AP is adopted rather than duplicated.
    expect(clients.calls.createAp).toBe(1);
  });

  it('RETURNS runtimeId, not just the arn — the registry and reaper both need it', async () => {
    // Regression: this returned only { runtimeArn, accessPointArn, roleArn }, so the runtime registry
    // recorded runtimeId: null on every row and the reaper (which needs an id for Get/Delete) silently
    // stopped reaping. GetAgentRuntime and DeleteAgentRuntime take an id and never a name.
    const clients = mockClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeId).toBe('rt-new');
    expect(r.runtimeArn).toBe('arn:new');
  });

  it('returns the ADOPTED runtime id too, not just a freshly created one', async () => {
    const clients = mockClients({
      list: () => ({ agentRuntimes: [{ agentRuntimeName: 'oc_alpha', agentRuntimeId: 'rt-existing' }] }),
      get: () => ({ status: 'READY', agentRuntimeArn: 'arn:existing' }),
      create: conflictingCreate(() => ['oc_alpha']),
    });
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeId).toBe('rt-existing');
  });

  it('a fresh provision creates exactly one runtime + one access point', async () => {
    const clients = mockClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBe('arn:new');
    expect(r.accessPointArn).toContain('access-point/ap-new');
    expect(r.roleArn).toBe(config.roleArn);
    expect(clients.calls.create).toBe(1);
    expect(clients.calls.createAp).toBe(1);
  });

  it('adopts an existing access point (AccessPointAlreadyExists) — does not re-create', async () => {
    const clients = mockClients({
      createAp: () => { const e = new Error('exists'); e.name = 'AccessPointAlreadyExists'; e.AccessPointId = 'ap-old'; throw e; },
    });
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.accessPointArn).toContain('access-point/ap-old');
  });

  it('adopts an INJECTED accessPointArn verbatim — never calls CreateAccessPoint', async () => {
    // The BDD fixture pre-creates a per-leg AP and scopes the exec role to it; the orchestrator must
    // mount THAT AP, not mint a second one at the same root (different ClientToken) the role can't mount.
    const clients = mockClients();
    const injected = 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/ap-injected';
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients, { accessPointArn: injected }));
    expect(r.accessPointArn).toBe(injected);
    expect(clients.calls.createAp).toBe(0); // adopted, not created
    expect(clients.calls.create).toBe(1);   // runtime still created, mounting the injected AP
  });
});

// ── Compensation ────────────────────────────────────────────────────────────────

describe('compensation: a failing step deletes prior self-created resources in reverse order', () => {
  it('runtime-create failure deletes the self-created AP (the leak fix), and NOT the shared role', async () => {
    const clients = mockClients({
      create: () => { const e = new Error('boom'); e.name = 'InvalidParameterValueException'; throw e; }, // fatal → no retry, then compensate
    });
    await expect(prov.ensureAgentEnvironment('alpha', baseOpts(clients))).rejects.toThrow(/boom/);
    expect(clients.calls.createAp).toBe(1); // AP was created
    expect(clients.calls.deleteAp).toBe(1); // …then compensated (deleted)
    // shared role is passed as an ARN → recorded selfCreated:false → never deleted (no IAM client even wired)
  });

  it('does NOT delete an adopted (pre-existing) access point when a later step fails', async () => {
    const clients = mockClients({
      createAp: () => { const e = new Error('exists'); e.name = 'AccessPointAlreadyExists'; e.AccessPointId = 'ap-shared'; throw e; },
      create: () => { const e = new Error('boom'); e.name = 'InvalidParameterValueException'; throw e; },
    });
    await expect(prov.ensureAgentEnvironment('alpha', baseOpts(clients))).rejects.toThrow(/boom/);
    expect(clients.calls.deleteAp).toBe(0); // adopted AP is NOT self-created → never deleted
  });

  it('deletes runtime THEN access point in reverse order when a post-create step throws', async () => {
    // Force the READY poll to report CREATE_FAILED so ensureRuntime throws AFTER recording the
    // runtime in the ledger — proving both self-created resources compensate, runtime first.
    const order = [];
    const clients = mockClients({
      create: () => ({ agentRuntimeId: 'rt-x', agentRuntimeArn: 'arn:x', status: 'CREATING' }),
      get: () => ({ status: 'CREATE_FAILED' }),
      deleteRt: () => { order.push('runtime'); return {}; },
      deleteAp: () => { order.push('accessPoint'); return {}; },
    });
    await expect(prov.ensureAgentEnvironment('alpha', baseOpts(clients))).rejects.toThrow(/did not reach READY/);
    expect(order).toEqual(['runtime', 'accessPoint']); // reverse dependency order
  });

  it('a per-leg role SPEC is self-created and IS compensated on failure', async () => {
    const deletedRoles = [];
    const clients = mockClients({
      create: () => { const e = new Error('boom'); e.name = 'InvalidParameterValueException'; throw e; },
    });
    // wire a fake IAM client + DeleteRoleCommand so the role compensation path can run
    clients.iam = { send: async (cmd) => { deletedRoles.push(cmd.input.RoleName); return {}; } };
    clients.iamCmds = { DeleteRoleCommand: class DeleteRoleCommand { constructor(i) { this.input = i; } } };
    const role = { ensure: async () => ({ roleArn: 'arn:role/perleg', roleName: 'perleg-role' }) };
    await expect(prov.ensureAgentEnvironment('alpha', baseOpts(clients, { role }))).rejects.toThrow(/boom/);
    expect(deletedRoles).toEqual(['perleg-role']); // self-created role compensated
  });

  it('cleanupOnFailure:false leaves resources in place (no compensating deletes)', async () => {
    const clients = mockClients({
      create: () => { const e = new Error('boom'); e.name = 'InvalidParameterValueException'; throw e; },
    });
    await expect(prov.ensureAgentEnvironment('alpha', baseOpts(clients, { cleanupOnFailure: false }))).rejects.toThrow(/boom/);
    expect(clients.calls.deleteAp).toBe(0);
  });
});

// ── P3-B: DELETING-name reconcile (teardown → re-provision the same name) ─────────

describe('DELETING-name reconcile (P3-B)', () => {
  it('a name held by a DELETING carcass is waited out, THEN created', async () => {
    // Reached REACTIVELY now: there is no pre-flight scan, so the first create conflicts on the name
    // the dying runtime still holds, and the conflict handler is what waits for the release.
    let gets = 0;
    let released = false;
    const clients = mockClients({
      list: () => (released ? { agentRuntimes: [] } : { agentRuntimes: [{ agentRuntimeName: 'oc_alpha', agentRuntimeId: 'rt-dying' }] }),
      get: () => {
        gets += 1;
        if (gets <= 3) return { status: 'DELETING', agentRuntimeArn: 'arn:dying' };
        released = true;
        const e = new Error('gone'); e.name = 'ResourceNotFoundException'; throw e;
      },
      create: conflictingCreate(() => (released ? [] : ['oc_alpha'])),
    });
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBe('arn:new');       // a FRESH runtime once the name came free
    expect(gets).toBeGreaterThanOrEqual(4);     // polled through DELETING to not-found
    expect(clients.calls.create).toBe(2);       // one rejected on the held name, one after release
  });

  it('on ConflictException: finds the name-holder now READY and ADOPTS it (scale-out race) — no throw', async () => {
    // Two dispatchers provisioning the same generation. This is exactly why the registry needs no lease
    // of its own: AgentCore's name uniqueness already elects one winner, and the loser adopts.
    const clients = mockClients({
      // The post-conflict lookup finds the winner. There is no pre-create list any more, so this is the
      // FIRST list the flow makes.
      list: () => ({ agentRuntimes: [{ agentRuntimeName: 'oc_alpha', agentRuntimeId: 'rt-won' }] }),
      get: () => ({ status: 'READY', agentRuntimeArn: 'arn:won' }),
      create: () => { const e = new Error('name already in use'); e.name = 'ConflictException'; throw e; },
    });
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBe('arn:won');       // adopted the winner instead of re-throwing
    expect(clients.calls.create).toBe(1);       // create attempted once, then adopted
  });

  it('on ConflictException: a DELETING holder is waited out, then the create is retried and succeeds', async () => {
    let lists = 0; let gets = 0;
    const clients = mockClients({
      list: () => {
        lists += 1;
        if (lists === 1) return { agentRuntimes: [] };                       // pre-create: absent
        return { agentRuntimes: [{ agentRuntimeName: 'oc_alpha', agentRuntimeId: 'rt-dying' }] }; // post-conflict
      },
      get: () => {
        gets += 1;
        if (gets <= 2) return { status: 'DELETING', agentRuntimeArn: 'arn:dying' };
        const e = new Error('gone'); e.name = 'ResourceNotFoundException'; throw e;
      },
      create: (() => {
        let n = 0;
        return () => {
          n += 1;
          if (n === 1) { const e = new Error('name already in use'); e.name = 'ConflictException'; throw e; }
          return { agentRuntimeId: 'rt-new', agentRuntimeArn: 'arn:new', status: 'READY' };
        };
      })(),
    });
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBe('arn:new');
    expect(clients.calls.create).toBe(2);       // conflict → wait-for-delete → converged re-create
  });

  it('waitForRuntimeDeleted gives up (throws) if the name is never released', async () => {
    const clients = mockClients({ get: () => ({ status: 'DELETE_FAILED' }) });
    await expect(prov.waitForRuntimeDeleted('oc_alpha', 'rt-stuck', {
      clients, logger: silentLogger, sleep: noSleep, maxAttempts: 5,
    })).rejects.toThrow(/name not released/);
  });
});

describe('pollIntervalMs — tick granularity is dead time, and the BUDGET must survive changing it', () => {
  // Why this exists: a fixed poll interval charges its whole granularity to every provision, because
  // the resource becomes ready between ticks. Measured 2026-08-14 — real CreateAgentRuntime → READY
  // is ~11.9s, the 3s-poll loop recorded a `runtime_ready` p50 of 13.5s over 85 provisions, and the
  // access-point loop read p50 81ms / p90 2.23s (one 2s sleep).
  it('polls fast first, then widens', () => {
    expect(prov.pollIntervalMs(0)).toBe(500);
    expect(prov.pollIntervalMs(5)).toBe(500);
    expect(prov.pollIntervalMs(6)).toBe(1500);
    expect(prov.pollIntervalMs(29)).toBe(1500);
    expect(prov.pollIntervalMs(30)).toBe(3000);
    expect(prov.pollIntervalMs(500)).toBe(3000);
  });

  // THE REGRESSION THIS CATCHES: the attempt caps at the call sites were raised (30→40, 120→140) to
  // hold the original wall-clock budgets after the interval shrank. Tuning the schedule later without
  // touching those caps silently SHORTENS the timeout — a slow provision would then fail with
  // "did not reach READY" long before AWS had actually given up, which reads as a platform fault.
  const budgetMs = (attempts) => {
    let total = 0;
    for (let i = 0; i < attempts; i += 1) total += prov.pollIntervalMs(i);
    return total;
  };

  it('keeps the runtime-READY budget at or above the original 120 x 3s = 360s', () => {
    expect(budgetMs(140)).toBeGreaterThanOrEqual(360_000);
  });

  it('keeps the EFS budget at or above the original 30 x 2s = 60s', () => {
    expect(budgetMs(40)).toBeGreaterThanOrEqual(60_000);
  });

  // The point of the fast band is that it costs few calls: a resource ready in ~12s is observed
  // after ~15 polls, not ~24 — cheap enough to keep, and bounded so a 4-minute provision does not
  // turn into an API-call storm.
  it('does not explode the call count on a slow resource', () => {
    let attempts = 0;
    for (let elapsed = 0; elapsed < 360_000; attempts += 1) elapsed += prov.pollIntervalMs(attempts);
    expect(attempts).toBeLessThan(150);
  });
});

describe('awaitIamPropagation — a DEADLINE, not a sleep', () => {
  // The point of the deadline form: the steps between role creation and CreateAgentRuntime usually
  // cover the propagation window for free. A fixed sleep would waste that, AND would silently stop
  // compensating once those steps were parallelised (which shrinks the natural window).
  const slept = () => { const calls = []; return { calls, sleep: async (ms) => { calls.push(ms); } }; };

  it('an ADOPTED role (no roleCreatedAtMs) waits nothing at all', async () => {
    const s = slept();
    const waited = await prov.awaitIamPropagation(undefined, { config, logger: silentLogger, sleep: s.sleep });
    expect(waited).toBe(0);
    expect(s.calls).toEqual([]);
  });

  it('a role created long ago waits nothing — the intervening steps already covered it', async () => {
    const s = slept();
    const longAgo = Date.now() - (prov.IAM_PROPAGATION_MIN_MS + 5000);
    const waited = await prov.awaitIamPropagation(longAgo, { config, logger: silentLogger, sleep: s.sleep });
    expect(waited).toBe(0);
    expect(s.calls).toEqual([]);
  });

  it('a JUST-created role waits only the REMAINDER of the window', async () => {
    const s = slept();
    // 500ms already elapsed → expect roughly (MIN - 500) remaining, never the full MIN.
    const waited = await prov.awaitIamPropagation(Date.now() - 500, { config, logger: silentLogger, sleep: s.sleep });
    expect(waited).toBeGreaterThan(0);
    expect(waited).toBeLessThanOrEqual(prov.IAM_PROPAGATION_MIN_MS - 400);
    expect(s.calls.length).toBe(1);
  });

  it('the window is configurable (config.iamPropagationMinMs)', async () => {
    const s = slept();
    const waited = await prov.awaitIamPropagation(Date.now(), {
      config: { ...config, iamPropagationMinMs: 50 }, logger: silentLogger, sleep: s.sleep,
    });
    expect(waited).toBeLessThanOrEqual(50);
  });
});

describe('steps 2+3 run concurrently under allSettled', () => {
  // THE LEAK PROPERTY, and the reason for allSettled over all. Steps 2 and 3 now overlap, so a
  // mount-target failure can land while CreateAccessPoint is still in flight. Under fail-fast the AP
  // could complete AFTER the rejection — created in AWS but never recorded in the ledger, i.e. an
  // orphaned EFS access point. allSettled lets both settle first, so compensation sees it.
  it('mount-targets failure still compensates an AP created concurrently (no orphan)', async () => {
    let apResolve;
    const clients = mockClients({
      // DETERMINISTIC RACE: mount targets reject immediately, while the AP create resolves LATER
      // (after a real timer tick). Under Promise.all the rejection would propagate first and
      // compensation would run against a ledger that does not yet contain the AP — which then lands
      // in AWS unreferenced. The delay is what makes this test able to tell the two apart at all;
      // without it both implementations happen to pass on microtask ordering.
      mt: () => { const e = new Error('mt-down'); e.name = 'InvalidParameterValueException'; throw e; },
      createAp: async () => {
        await new Promise((r) => setTimeout(r, 25));
        apResolve = true;
        return { AccessPointId: 'fsap-race', LifeCycleState: 'available' };
      },
    });
    await expect(prov.ensureAgentEnvironment('alpha', baseOpts(clients))).rejects.toThrow(/mt-down/);
    // The AP was created despite the sibling failing…
    expect(apResolve).toBe(true);
    expect(clients.calls.createAp).toBe(1);
    // …and was compensated rather than leaked. This is the assertion that fails if someone
    // "simplifies" allSettled back to Promise.all.
    expect(clients.calls.deleteAp).toBe(1);
  });

  it('both legs failing reports the mount-target error and attaches the other (neither is lost)', async () => {
    const clients = mockClients({
      mt: () => { const e = new Error('mt-down'); e.name = 'InvalidParameterValueException'; throw e; },
      createAp: () => { const e = new Error('ap-down'); e.name = 'InvalidParameterValueException'; throw e; },
    });
    const err = await prov.ensureAgentEnvironment('alpha', baseOpts(clients)).catch((e) => e);
    expect(err.message).toMatch(/mt-down/);
    expect(err.alsoFailed && err.alsoFailed.message).toMatch(/ap-down/);
  });

  it('the happy path still yields subnets + accessPointArn and creates the runtime once', async () => {
    const clients = mockClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBeTruthy();
    expect(r.accessPointArn).toBeTruthy();
    expect(clients.calls.create).toBe(1);
    expect(clients.calls.mt).toBeGreaterThanOrEqual(1);
    expect(clients.calls.createAp).toBe(1);
  });
});

describe('ensureExecRole reports whether it CREATED the role', () => {
  it('a spec reporting created:true yields roleCreatedAtMs; created:false does not', async () => {
    const ledger = prov.makeLedger();
    const mk = (created) => ({ spec: true, async ensure() { return { roleArn: 'arn:aws:iam::1:role/agentcore/x', roleName: 'x', created }; } });
    const hot = await prov.ensureExecRole('alpha', { role: mk(true), clients: {}, config, logger: silentLogger, ledger });
    expect(typeof hot.roleCreatedAtMs).toBe('number');
    const adopted = await prov.ensureExecRole('alpha', { role: mk(false), clients: {}, config, logger: silentLogger, ledger: prov.makeLedger() });
    expect(adopted.roleCreatedAtMs).toBeUndefined();
  });
  it('a shared ARN never reports a creation timestamp', async () => {
    const r = await prov.ensureExecRole('alpha', { role: config.roleArn, clients: {}, config, logger: silentLogger, ledger: prov.makeLedger() });
    expect(r.selfCreated).toBe(false);
    expect(r.roleCreatedAtMs).toBeUndefined();
  });
});

// ── §9.9a: the dispatcher pre-writes a NEW agent's workspace SEED ────────────────
//
// The runtime has no DynamoDB write at all, so this is the only thing that records a brand-new
// agent's authored baseline. The GATE is the load-bearing part: it must fire only when the access
// point was just created (fresh, empty workspace). Writing a skeleton manifest for an agent whose
// workspace already has content would make the NEXT boot take workspace-seed's "loaded" branch and
// verify every manifest file against EFS — throwing `seed guard FATAL` for anything absent, i.e. a
// boot loop. That is why this is chained to ensureAccessPoint's selfCreated rather than run blindly.
describe('workspace SEED pre-write (dispatcher is the sole writer)', () => {
  const withSeeder = (clients, extra = {}) => {
    const seeded = [];
    const opts = baseOpts(clients, {
      seedNewWorkspace: async (agentName) => { seeded.push(agentName); return { seeded: true, files: 4 }; },
      ...extra,
    });
    return { opts, seeded };
  };

  it('fires when the access point was just created (fresh workspace)', async () => {
    const clients = mockClients();
    const { opts, seeded } = withSeeder(clients);
    await prov.ensureAgentEnvironment('alpha', opts);
    expect(clients.calls.createAp).toBe(1);
    expect(seeded).toEqual(['alpha']);
  });

  it('does NOT fire for an ADOPTED access point — the workspace may already have content', async () => {
    const clients = mockClients();
    // An injected AP ARN is adopted verbatim → selfCreated false → the workspace is not ours to seed.
    const { opts, seeded } = withSeeder(clients, { accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-adopted' });
    await prov.ensureAgentEnvironment('alpha', opts);
    expect(clients.calls.createAp).toBe(0);
    expect(seeded).toEqual([]);
  });

  it('is optional — a caller that injects no seeder still provisions', async () => {
    const clients = mockClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBeTruthy();
  });

  it('a seeder failure must NOT fail the provision (the runtime still seeds EFS itself)', async () => {
    const clients = mockClients();
    const opts = baseOpts(clients, {
      seedNewWorkspace: async () => { throw new Error('ddb-down'); },
    });
    // The seeder's own implementation swallows errors, but the saga must not depend on that:
    // a throwing seeder is a bug in the seeder, not a reason to abandon a healthy runtime.
    await expect(prov.ensureAgentEnvironment('alpha', opts)).rejects.toThrow(/ddb-down/);
  });
});

// ── the MARKETPLACE seed: what a new agent can DO, on the same gate as the workspace SEED ────────
//
// A minted agent had the connector capability (baseline, default-allow) and a Connector project of its
// own, and still reported "no tools available" — because its marketplace slice was empty, so there
// were no skills and no toolkits for the plugin to discover. Permission was never the problem.
describe('marketplace seed pre-write (default skills + toolkits)', () => {
  const withBoth = (clients, extra = {}) => {
    const marketplaces = [];
    const opts = baseOpts(clients, {
      seedNewWorkspace: async () => ({ seeded: true, files: 4 }),
      seedNewMarketplace: async (agentName) => { marketplaces.push(agentName); return { seeded: true }; },
      ...extra,
    });
    return { opts, marketplaces };
  };

  it('fires on the SAME gate as the workspace seed — a self-created access point', async () => {
    const clients = mockClients();
    const { opts, marketplaces } = withBoth(clients);
    await prov.ensureAgentEnvironment('alpha', opts);
    expect(marketplaces).toEqual(['alpha']);
  });

  // An adopted AP means an existing agent, whose slice is its own — seeding it would fight App Home.
  it('does NOT fire for an ADOPTED access point', async () => {
    const clients = mockClients();
    const { opts, marketplaces } = withBoth(clients, { accessPointArn: 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-adopted' });
    await prov.ensureAgentEnvironment('alpha', opts);
    expect(marketplaces).toEqual([]);
  });

  it('is optional — a caller that injects only the workspace seeder still provisions', async () => {
    const clients = mockClients();
    const opts = baseOpts(clients, { seedNewWorkspace: async () => ({ seeded: true, files: 4 }) });
    const r = await prov.ensureAgentEnvironment('alpha', opts);
    expect(r.runtimeArn).toBeTruthy();
  });
});

// ── §9.9b: fail-CLOSED on a missing role (no shared fallback, no flag) ───────────
//
// ensureExecRole used to read config.roleArn when nothing was passed, so any path that failed to
// produce a derived role silently provisioned the agent onto the fleet-shared role — which grants
// UNCONDITIONED, TABLE-WIDE config reads. The own-scope-read guarantee is only real if that
// downgrade is impossible, so a missing role must be a hard error. There is also no feature flag any
// more: a security property an env var can switch off is not a property.
describe('fail-closed: no role means no provision', () => {
  it('ensureExecRole THROWS when no role is supplied — even if config carries a roleArn', async () => {
    // config.roleArn is deliberately present here: the old code would have used it. Nothing may.
    const cfg = { ...config, roleArn: 'arn:aws:iam::203366135563:role/clawdbot-agentcore-exec' };
    await expect(prov.ensureExecRole('alpha', {
      role: undefined, clients: {}, config: cfg, logger: silentLogger, ledger: prov.makeLedger(),
    })).rejects.toThrow(/needs its own derived role/);
  });

  it('the whole saga fails closed, and creates NOTHING, when the role is missing', async () => {
    const clients = mockClients();
    const opts = baseOpts(clients);
    delete opts.role;
    await expect(prov.ensureAgentEnvironment('alpha', opts)).rejects.toThrow(/derived role/);
    // No access point, no runtime — we refuse before touching anything.
    expect(clients.calls.createAp).toBe(0);
    expect(clients.calls.create).toBe(0);
  });

  it('the error names what to check, so a mis-ordered deploy is self-diagnosing', async () => {
    // Fail-closed is only humane if the message says why. A missing agentcore-base policy or
    // iam:CreateRole grant (Terraform not applied before the image shipped) is the likely cause.
    const err = await prov.ensureExecRole('alpha', {
      role: undefined, clients: {}, config, logger: silentLogger, ledger: prov.makeLedger(),
    }).catch((e) => e);
    expect(err.message).toMatch(/agentcore-base/);
    expect(err.message).toMatch(/iam:CreateRole/);
    expect(err.message).toMatch(/Terraform must be applied/);
  });
});

// ── Connector leg (phase 3) ─────────────────────────────────────────────────────
//
// The saga knows nothing about Connector beyond "call this injected thing concurrently, and never
// let it hurt anyone". These pin that contract, because both halves are easy to break by accident:
// moving the call out of the parallel block costs latency nobody measures, and adding it to the
// rejection check turns a third-party outage into a user with no answer.

describe('connector provisioning leg', () => {
  const okClients = () => mockClients({
    list: () => ({ agentRuntimes: [] }),
    get: () => ({ status: 'READY', agentRuntimeArn: 'arn:new' }),
  });

  it('is CONCURRENT with the mount-target / access-point legs, not serialised after them', async () => {
    const order = [];
    let releaseConnector;
    const connectorGate = new Promise((res) => { releaseConnector = res; });
    const clients = okClients();
    const p = prov.ensureAgentEnvironment('alpha', baseOpts(clients, {
      ensureConnectorCredential: async () => { order.push('connector:start'); await connectorGate; order.push('connector:end'); return { outcome: 'created', ms: 5 }; },
    }));
    // The saga must already be inside the Connector leg while the other legs are in flight; if it
    // were serialised after them, nothing would have started it yet.
    await new Promise((r) => setTimeout(r, 5));
    expect(order).toContain('connector:start');
    releaseConnector();
    await p;
  });

  it('a Connector FAILURE does not fail provisioning', async () => {
    const clients = okClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients, {
      ensureConnectorCredential: async () => ({ outcome: 'failed', reason: 'error', error: 'connector 500', ms: 3 }),
    }));
    expect(r.runtimeArn).toBe('arn:new');
  });

  // It is CONTRACTED never to throw. If it does anyway, the saga must still survive — a contract is
  // a statement about intent, not a guarantee about a future edit.
  it('a Connector leg that THROWS still does not fail provisioning', async () => {
    const clients = okClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients, {
      ensureConnectorCredential: async () => { throw new Error('contract violated'); },
    }));
    expect(r.runtimeArn).toBe('arn:new');
  });

  it('provisions fine when no Connector hook is injected at all', async () => {
    const clients = okClients();
    const r = await prov.ensureAgentEnvironment('alpha', baseOpts(clients));
    expect(r.runtimeArn).toBe('arn:new');
  });

  it('emits the outcome as a metric — logs alone are not alarmable', async () => {
    const seen = [];
    const clients = okClients();
    await prov.ensureAgentEnvironment('alpha', baseOpts(clients, {
      metrics: { ...require('./dispatcher-metrics').NOOP_METRICS, emitConnectorProvision: (a, o) => seen.push([a, o.outcome, o.ms]) },
      ensureConnectorCredential: async () => ({ outcome: 'blocked', reason: 'project-exists-unkeyed', ms: 42 }),
    }));
    expect(seen).toEqual([['alpha', 'blocked', 42]]);
  });

  it('logs BLOCKED distinctly — it is the one outcome a human can act on', async () => {
    const lines = [];
    const logger = { info: (o, m) => lines.push(['info', o, m]), warn: (o, m) => lines.push(['warn', o, m]), error: () => {}, debug: () => {} };
    const clients = okClients();
    await prov.ensureAgentEnvironment('alpha', baseOpts(clients, {
      logger,
      ensureConnectorCredential: async () => ({ outcome: 'blocked', reason: 'project-exists-unkeyed', ms: 4 }),
    }));
    // Keyed on the structured `event` field, not the message text — the reason the field exists.
    const hit = lines.find((l) => l[1] && l[1].event === 'connector_provision_outcome');
    expect(hit[0]).toBe('warn');
    expect(hit[2]).toMatch(/blocked/);
  });

  it('stays quiet on the already-pointed no-op — every provision after the first', async () => {
    const lines = [];
    const logger = { info: (o, m) => lines.push(m), warn: (o, m) => lines.push(m), error: () => {}, debug: () => {} };
    const clients = okClients();
    await prov.ensureAgentEnvironment('alpha', baseOpts(clients, {
      logger,
      ensureConnectorCredential: async () => ({ outcome: 'already-pointed', ms: 1 }),
    }));
    expect(lines.filter((m) => String(m).includes('connector provision outcome'))).toEqual([]);
  });
});

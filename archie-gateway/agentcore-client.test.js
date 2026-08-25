'use strict';

const { createAgentCoreClient, sanitizeRuntimeName, generationRuntimeName, feedSse, CONFIG } = require('./agentcore-client');
const { NOOP_METRICS } = require('./dispatcher-metrics');

// The container image is a REQUIRED input to provisioning now — there is no baked default, because a
// default is a silent downgrade when the fleet pointer is missing. Tests therefore say which image
// they mean, exactly as the dispatcher does after resolving CONFIG#image.
const TEST_IMAGE = '203366135563.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore:test-image';

// A fresh factory instance per test — each owns its own arn cache + injectable SDK clients, so
// tests are isolated without a shared-singleton reset. Constructed in the top-level beforeEach.
// Inject the no-op metrics sink so the M1 D6 ClawdbotDispatcher EMF emitter doesn't write EMF
// lines to stdout during unit tests (non-behavioral test hygiene — no assertions depend on it).
let c;
beforeEach(() => { c = createAgentCoreClient({ metrics: NOOP_METRICS }); });

// Fake control + EFS + invoke clients. send() dispatches on the (real) command class name and
// counts calls. `invoke` serves the invokeStreaming tests: default is a one-frame SSE stream
// ending in a `final` event (a healthy serving runtime); `invokeSend` overrides it (e.g. to fail).
// `conflictOnHeldName` models AgentCore's RUNTIME-NAME UNIQUENESS, which the create path now depends on
// as its mutex. Since the pre-flight ListAgentRuntimes was removed (it cost a full fleet scan on the one
// path where it can never early-exit), a name collision is discovered by CreateAgentRuntime returning
// ConflictException rather than by looking first. A fake whose create always succeeds would let a test
// "adopt" a runtime while silently minting a duplicate — the exact bug the real 409 prevents.
function fakeAwsClients({ listResult, existingStatus = 'READY', invokeSend, conflictOnHeldName = true } = {}) {
  const calls = { create: 0, list: 0, get: 0, ap: 0, mt: 0, invoke: 0 };
  const nameIsHeld = (wanted) => {
    try {
      return (listResult()?.agentRuntimes || []).some((r) => r.agentRuntimeName === wanted);
    } catch { return false; }
  };
  const control = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'ListAgentRuntimesCommand') { calls.list += 1; return listResult(); }
      if (n === 'GetAgentRuntimeCommand') { calls.get += 1; return { agentRuntimeArn: 'arn:existing', status: existingStatus }; }
      if (n === 'CreateAgentRuntimeCommand') {
        calls.create += 1;
        if (conflictOnHeldName && nameIsHeld(cmd.input?.agentRuntimeName)) {
          const err = new Error(`runtime ${cmd.input.agentRuntimeName} already exists`);
          err.name = 'ConflictException';
          throw err;
        }
        return { agentRuntimeId: 'idNew', agentRuntimeArn: 'arn:new', status: 'READY' };
      }
      if (n === 'DeleteAgentRuntimeCommand') { calls.del = (calls.del || 0) + 1; return {}; }
      throw new Error(`unexpected control cmd ${n}`);
    },
  };
  const efs = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'DescribeMountTargetsCommand') { calls.mt += 1; return { MountTargets: [{ VpcId: CONFIG.vpcId, AvailabilityZoneId: 'use1-az1', SubnetId: 'subnet-a' }] }; }
      if (n === 'CreateAccessPointCommand') { calls.ap += 1; return { AccessPointId: 'apId' }; }
      if (n === 'DescribeAccessPointsCommand') return { AccessPoints: [{ LifeCycleState: 'available' }] };
      throw new Error(`unexpected efs cmd ${n}`);
    },
  };
  const invoke = {
    send: async (cmd) => {
      calls.invoke += 1;
      if (invokeSend) return invokeSend(cmd);
      return { response: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: {"type":"final","text":"pong"}\n\n'); } } };
    },
  };
  return { control, efs, invoke, calls };
}

describe('ensureRuntime', () => {
  it('not found -> provisions one runtime (AP + create)', async () => {
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    const arn = await c.ensureRuntime('alpha', { image: TEST_IMAGE });
    expect(arn).toBe('arn:new');
    expect(f.calls.create).toBe(1);
    expect(f.calls.ap).toBe(1);
  });

  it('§8.10 adopt: opts.efsRoot points the AP root at the legacy dir; runtime name stays the scope id', async () => {
    let apRoot = null; let rtName = null;
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    const efsSend = f.efs.send;
    f.efs.send = async (cmd) => { if (cmd.constructor.name === 'CreateAccessPointCommand') apRoot = cmd.input.RootDirectory.Path; return efsSend(cmd); };
    const ctlSend = f.control.send;
    f.control.send = async (cmd) => { if (cmd.constructor.name === 'CreateAgentRuntimeCommand') rtName = cmd.input.agentRuntimeName; return ctlSend(cmd); };
    c.setClientsForTest(f);
    await c.ensureRuntime('dm-ux0mz5ckp2r', { image: TEST_IMAGE, efsRoot: 'agent-xx9aff' });
    expect(apRoot).toBe('/openclaw-data/agents/agent-xx9aff'); // mounts the LEGACY workspace/sessions/memory
    // Identity still derives from the SCOPE id (not the legacy EFS name); the name now also carries
    // the image fingerprint, which is what makes a roll a new generation rather than an outage.
    expect(rtName).toBe(c.generationRuntimeName('dm-ux0mz5ckp2r', TEST_IMAGE));
    expect(rtName.startsWith(sanitizeRuntimeName('dm-ux0mz5ckp2r'))).toBe(true);
  });

  it('no efsRoot -> AP root is the agent\'s own dir (default, no adopt)', async () => {
    let apRoot = null;
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    const efsSend = f.efs.send;
    f.efs.send = async (cmd) => { if (cmd.constructor.name === 'CreateAccessPointCommand') apRoot = cmd.input.RootDirectory.Path; return efsSend(cmd); };
    c.setClientsForTest(f);
    await c.ensureRuntime('dm-ujh946ogl', { image: TEST_IMAGE });
    expect(apRoot).toBe('/openclaw-data/agents/dm-ujh946ogl');
  });

  it('concurrent first-hits -> exactly ONE create (in-flight lock)', async () => {
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    const [a, b] = await Promise.all([c.ensureRuntime('beta', { image: TEST_IMAGE }), c.ensureRuntime('beta', { image: TEST_IMAGE })]);
    expect(a).toBe(b);
    expect(f.calls.create).toBe(1);
  });

  it('second call is a cache hit (no further list/create)', async () => {
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    await c.ensureRuntime('gamma', { image: TEST_IMAGE });
    const list0 = f.calls.list; const create0 = f.calls.create;
    await c.ensureRuntime('gamma', { image: TEST_IMAGE });
    expect(f.calls.list).toBe(list0);
    expect(f.calls.create).toBe(create0);
  });

  it('a runtime AgentCore already holds is ADOPTED, never duplicated', async () => {
    // The registry has no row (this generation was created by something else, or a crash lost the
    // write), so the create is attempted and AgentCore's name uniqueness rejects it. What must NOT
    // happen is a second runtime — the conflict is the adopt signal, not an error.
    const name = c.generationRuntimeName('delta', TEST_IMAGE);
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [{ agentRuntimeName: name, agentRuntimeId: 'idD' }] }) });
    c.setClientsForTest(f);
    const arn = await c.ensureRuntime('delta', { image: TEST_IMAGE });
    expect(arn).toBe('arn:existing');
    expect(f.calls.create).toBe(1);   // attempted once, conflicted, adopted
  });

  it('a crash-lost write is repaired: the adopted runtime is RECORDED so the next turn is a hit', async () => {
    // This is the whole "exists at AWS but absent from the table" case. Adopting is only half the
    // job — if the row is not written, every subsequent turn pays the conflict round again.
    const name = c.generationRuntimeName('zeta', TEST_IMAGE);
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [{ agentRuntimeName: name, agentRuntimeId: 'idZ' }] }) });
    c.setClientsForTest(f);
    await c.ensureRuntime('zeta', { image: TEST_IMAGE });
    const create0 = f.calls.create;
    c.resetCacheForTest();                       // drop the in-process coalescer, keep the registry
    const arn = await c.ensureRuntime('zeta', { image: TEST_IMAGE });
    expect(arn).toBe('arn:existing');
    expect(f.calls.create).toBe(create0);        // no further create attempt at all
  });

  it('a dispatcher RESTART is now a registry hit — zero control-plane calls', async () => {
    // The point of moving the cache into DynamoDB. Previously a restart forgot every ARN and the next
    // turn per agent paid a full ListAgentRuntimes pagination (25/s, non-adjustable, no name filter)
    // to rediscover what it already knew.
    let f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    const first = await c.ensureRuntime('epsilon', { image: TEST_IMAGE });
    expect(f.calls.create).toBe(1);

    const registry = c.runtimeRegistryForTest();
    c.resetCacheForTest();                       // restart: in-process state gone, registry survives
    f = fakeAwsClients({ listResult: () => { throw new Error('ListAgentRuntimes must not be called'); } });
    c.setClientsForTest(f);
    c.setRegistryForTest(registry);              // the durable half persists across the "restart"

    const arn = await c.ensureRuntime('epsilon', { image: TEST_IMAGE });
    expect(arn).toBe(first);
    expect(f.calls.create).toBe(0);
    expect(f.calls.list).toBe(0);                // THE regression this change exists to prevent
  });
});

describe('ensureRuntime does not invoke the runtime (no warm-up)', () => {
  // There was a synthetic "ping" invoke on the cold-create path until 2026-08-11 — a serving-ready
  // gate, on the theory that control-plane READY does not mean serving. It never gated anything (it
  // IS a first invoke, and it never needed a cold retry) while costing p50 ~16.5s inline in the
  // user's turn. These tests are the guard against it, or anything like it, coming back: provisioning
  // must not spend a model turn.
  it('the cold create path does NOT invoke — the caller\'s own message is the first invoke', async () => {
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    const arn = await c.ensureRuntime('wa', { image: TEST_IMAGE });
    expect(arn).toBe('arn:new');
    expect(f.calls.create).toBe(1);
    expect(f.calls.invoke).toBe(0);
  });

  it('warm path (in-memory cache hit) performs ZERO extra API calls', async () => {
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    await c.ensureRuntime('wb', { image: TEST_IMAGE });
    const snapshot = { ...f.calls };
    await c.ensureRuntime('wb', { image: TEST_IMAGE }); // cache hit
    expect(f.calls).toEqual(snapshot); // no list/create/invoke — nothing at all
  });

  it('existing READY runtime adopted by name (dispatcher restart) does not invoke either', async () => {
    const name = c.generationRuntimeName('wc', TEST_IMAGE);
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [{ agentRuntimeName: name, agentRuntimeId: 'idW' }] }) });
    c.setClientsForTest(f);
    const arn = await c.ensureRuntime('wc', { image: TEST_IMAGE });
    expect(arn).toBe('arn:existing');
    expect(f.calls.create).toBe(1);   // attempted, conflicted, adopted — never duplicated
    expect(f.calls.invoke).toBe(0);   // THE point: provisioning never warms the runtime itself
  });

  it('concurrent cold first-hits still share ONE create (in-flight lock intact)', async () => {
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    c.setClientsForTest(f);
    const [a, b] = await Promise.all([c.ensureRuntime('wd', { image: TEST_IMAGE }), c.ensureRuntime('wd', { image: TEST_IMAGE })]);
    expect(a).toBe(b);
    expect(f.calls.create).toBe(1);
    expect(f.calls.invoke).toBe(0);
  });

  // The warm-up used to THROW on a failed invoke, so a transient error during provisioning bricked
  // the turn — while the real invoke cold-retries 15 times. Provisioning must stay independent of
  // whether the runtime can currently serve.
  it('a broken invoke path does not fail provisioning', async () => {
    const f = fakeAwsClients({
      listResult: () => ({ agentRuntimes: [] }),
      invokeSend: async () => { const e = new Error('denied'); e.name = 'Boom'; throw e; },
    });
    c.setClientsForTest(f);
    await expect(c.ensureRuntime('wg', { image: TEST_IMAGE })).resolves.toBe('arn:new');
  });
});

describe('feedSse', () => {
  it('parses a single complete frame', () => {
    const evs = [];
    const tail = feedSse('data: {"type":"delta","text":"hi"}\n\n', (e) => evs.push(e));
    expect(evs).toEqual([{ type: 'delta', text: 'hi' }]);
    expect(tail).toBe('');
  });
  it('carries an incomplete tail across feeds (mid-JSON split)', () => {
    const evs = [];
    let buf = feedSse('data: {"type":"delta","te', (e) => evs.push(e));
    expect(evs.length).toBe(0);
    buf = feedSse(buf + 'xt":"hi"}\n\n', (e) => evs.push(e));
    expect(evs).toEqual([{ type: 'delta', text: 'hi' }]);
    expect(buf).toBe('');
  });
  it('skips malformed frames, still parses good ones', () => {
    const evs = [];
    feedSse('data: not-json\n\ndata: {"type":"final","text":"x"}\n\n', (e) => evs.push(e));
    expect(evs).toEqual([{ type: 'final', text: 'x' }]);
  });
});

describe('invokeStreaming', () => {
  const fakeResponse = (chunks) => ({ async *[Symbol.asyncIterator]() { for (const s of chunks) yield Buffer.from(s); } });

  it('parses SSE across chunk splits and returns the final event', async () => {
    const got = [];
    c.setClientsForTest({ invoke: { send: async () => ({ response: fakeResponse([
      'data: {"type":"delta","text":"He',
      'llo"}\n\ndata: {"type":"tool","itemId":"t1","title":"read","status":"running"}\n\n',
      'data: {"type":"final","text":"Hello","usage":{"output":1},"model":"m","stopReason":"end_turn"}\n\n',
    ]) }) } });
    const final = await c.invokeStreaming('arn:x', '000000000000000000000000000000000', { input: { prompt: 'hi' } }, (e) => got.push(e));
    expect(got.filter((e) => e.type === 'delta').map((e) => e.text)).toEqual(['Hello']);
    expect(got.filter((e) => e.type === 'tool').length).toBe(1);
    expect(final.text).toBe('Hello');
  });

  // Live regression, 2026-08-12. A thrown turn arrives as `error` + `final {text:''}`. This helper
  // read only `final`, so the pair looked like a successful turn with nothing to say and the error
  // was discarded — cron then recorded status 'ok' and reset consecutiveErrors on a job that failed
  // every single fire.
  it('surfaces an `error` event on the returned final instead of discarding it', async () => {
    c.setClientsForTest({ invoke: { send: async () => ({ response: fakeResponse([
      'data: {"type":"error","message":"turn exploded"}\n\n',
      'data: {"type":"final","text":""}\n\n',
    ]) }) } });
    const final = await c.invokeStreaming('arn:x', '000000000000000000000000000000000', { input: { prompt: 'hi' } }, () => {});
    expect(final.error).toBe('turn exploded');
    expect(final.text).toBe('');
  });

  it('still passes the error event to onChunk (the Slack path reports the failure itself)', async () => {
    const got = [];
    c.setClientsForTest({ invoke: { send: async () => ({ response: fakeResponse([
      'data: {"type":"error","message":"boom"}\n\ndata: {"type":"final","text":""}\n\n',
    ]) }) } });
    await c.invokeStreaming('arn:x', '000000000000000000000000000000000', { input: { prompt: 'hi' } }, (e) => got.push(e));
    expect(got.filter((e) => e.type === 'error').map((e) => e.message)).toEqual(['boom']);
  });

  it('a healthy turn carries NO error key (the flag must not be sticky)', async () => {
    c.setClientsForTest({ invoke: { send: async () => ({ response: fakeResponse([
      'data: {"type":"final","text":"fine"}\n\n',
    ]) }) } });
    const final = await c.invokeStreaming('arn:x', '000000000000000000000000000000000', { input: { prompt: 'hi' } }, () => {});
    expect(final.error).toBeUndefined();
  });

  it('retries send() through the cold-boot window (RuntimeClientError)', async () => {
    let n = 0;
    c.setClientsForTest({ invoke: { send: async () => {
      n += 1;
      if (n < 3) { const e = new Error('runtime not ready'); e.name = 'RuntimeClientError'; throw e; }
      return { response: fakeResponse(['data: {"type":"final","text":"ok"}\n\n']) };
    } } });
    const final = await c.invokeStreaming('arn:x', '000000000000000000000000000000000', {}, () => {}, { coldBackoffMs: 1 });
    expect(n).toBe(3);
    expect(final.text).toBe('ok');
  });

  it('THROWS (not silent null) when the stream closes without a final event', async () => {
    // a cold microVM reaped mid-turn: deltas but no terminal `final` — the silent-miss bug
    c.setClientsForTest({ invoke: { send: async () => ({ response: fakeResponse(['data: {"type":"delta","text":"partial"}\n\n']) }) } });
    await expect(
      c.invokeStreaming('arn:x', '000000000000000000000000000000000', {}, () => {}, { coldBackoffMs: 1, maxColdRetries: 2 }),
    ).rejects.toThrow(/without a final event|incomplete/i);
  });

  it('retryIncomplete: retries a final-less stream through the cold window, then succeeds', async () => {
    let n = 0;
    c.setClientsForTest({ invoke: { send: async () => {
      n += 1;
      if (n < 3) return { response: fakeResponse(['data: {"type":"delta","text":"warming"}\n\n']) }; // no final yet
      return { response: fakeResponse(['data: {"type":"final","text":"done"}\n\n']) };
    } } });
    const final = await c.invokeStreaming('arn:x', '000000000000000000000000000000000', {}, () => {}, { coldBackoffMs: 1, retryIncomplete: true });
    expect(n).toBe(3);
    expect(final.text).toBe('done');
  });

  // ── Registry invalidation ──────────────────────────────────────────────────────────────────
  //
  // THE PATH THAT MAKES A DURABLE CACHE SAFE. The old in-process Map got self-healing for free from
  // process restarts; a DynamoDB row has no such accident, so if a dead ARN were never cleared the agent
  // would stay bricked. The registry is authoritative for name->arn and NEVER for liveness — the invoke
  // is what proves liveness, and this is where a disproof gets written back.
  const runtimeGone = () => {
    const e = new Error("No endpoint or agent found with qualifier 'DEFAULT' for agent 'arn:stale'");
    e.name = 'RuntimeNotFoundException';
    return e;
  };

  it('clears the recorded ARN when the runtime is gone (deleted outside the dispatcher)', async () => {
    const name = c.generationRuntimeName('gone-agent', TEST_IMAGE);
    c.setClientsForTest({
      control: { send: async () => { throw new Error('control must not be needed'); } },
      invoke: { send: async () => { throw runtimeGone(); } },
      efs: { send: async () => ({}) },
    });
    const reg = c.runtimeRegistryForTest();
    await reg.record('gone-agent', name, { arn: 'arn:stale', runtimeId: 'id1' });

    await expect(
      c.invokeStreaming('arn:stale', '000000000000000000000000000000000', {}, () => {}, { agent: 'gone-agent', maxColdRetries: 1 }),
    ).rejects.toThrow(/No endpoint or agent found/);

    // The row survives as history; only the liveness claim is dropped, so the next ensureRuntime
    // provisions rather than handing out a corpse.
    const row = await reg.get('gone-agent', name);
    expect(row).toBeTruthy();
    expect(row.arn).toBeUndefined();
  });

  // REGRESSION (live outage, 2026-08-13). Deleting a runtime out-of-band IS the documented roll
  // mechanism, and AWS does not report an in-flight delete as ResourceNotFoundException — it reports
  // ValidationException "not in an invocable state. Current status: DELETING", for MINUTES. The
  // eviction above matched only the not-found shape, so the registry kept handing out the dead ARN
  // for that entire window and the agent answered nothing until the row was cleared by hand.
  const runtimeDeleting = () => {
    const e = new Error("The requested agentic resource endpoint arn:stale is not in an invocable state. Current status: DELETING");
    e.name = 'ValidationException';
    return e;
  };

  it('clears the recorded ARN while the runtime is still DELETING, not just once it is gone', async () => {
    const name = c.generationRuntimeName('deleting-agent', TEST_IMAGE);
    let attempts = 0;
    c.setClientsForTest({
      control: { send: async () => { throw new Error('control must not be needed'); } },
      invoke: { send: async () => { attempts += 1; throw runtimeDeleting(); } },
      efs: { send: async () => ({}) },
    });
    const reg = c.runtimeRegistryForTest();
    await reg.record('deleting-agent', name, { arn: 'arn:stale', runtimeId: 'id1' });

    await expect(
      c.invokeStreaming('arn:stale', '000000000000000000000000000000000', {}, () => {}, { agent: 'deleting-agent', maxColdRetries: 3 }),
    ).rejects.toThrow(/not in an invocable state/);

    const row = await reg.get('deleting-agent', name);
    expect(row.arn).toBeUndefined();
    // DELETING is TERMINAL for this ARN, so it must not burn the cold-retry budget first — that
    // delay is pure latency on a runtime which is never coming back.
    expect(attempts).toBe(1);
  });

  // The other statuses behind the same message ARE transient, and evicting on them would throw away
  // a runtime that is on its way in.
  it('CREATING is retried, not evicted — same message, opposite meaning', async () => {
    const name = c.generationRuntimeName('creating-agent', TEST_IMAGE);
    let attempts = 0;
    c.setClientsForTest({
      control: { send: async () => { throw new Error('control must not be needed'); } },
      invoke: {
        send: async () => {
          attempts += 1;
          const e = new Error('The requested agentic resource endpoint arn:fresh is not in an invocable state. Current status: CREATING');
          e.name = 'ValidationException';
          throw e;
        },
      },
      efs: { send: async () => ({}) },
    });
    const reg = c.runtimeRegistryForTest();
    await reg.record('creating-agent', name, { arn: 'arn:fresh', runtimeId: 'id1' });

    await expect(
      c.invokeStreaming('arn:fresh', '000000000000000000000000000000000', {}, () => {}, { agent: 'creating-agent', maxColdRetries: 2, coldBackoffMs: 1 }),
    ).rejects.toThrow(/not in an invocable state/);

    expect(attempts).toBeGreaterThan(1);          // retried
    const row = await reg.get('creating-agent', name);
    expect(row.arn).toBe('arn:fresh');            // and NOT evicted
  });

  it('does NOT clear a row that has already moved on to a FRESH arn', async () => {
    // Between the failed invoke and the eviction write, another turn may have reprovisioned this
    // generation. An unconditional clear would discard that working runtime and force yet another cold
    // provision — so the write is conditional on the arn still being the one that failed.
    const name = c.generationRuntimeName('agent-u27k65', TEST_IMAGE);
    c.setClientsForTest({
      control: { send: async () => { throw new Error('control must not be needed'); } },
      invoke: { send: async () => { throw runtimeGone(); } },
      efs: { send: async () => ({}) },
    });
    const reg = c.runtimeRegistryForTest();
    await reg.record('agent-u27k65', name, { arn: 'arn:fresh', runtimeId: 'id-fresh' });

    await expect(
      c.invokeStreaming('arn:stale', '000000000000000000000000000000000', {}, () => {}, { agent: 'agent-u27k65', maxColdRetries: 1 }),
    ).rejects.toThrow(/No endpoint or agent found/);

    expect((await reg.get('agent-u27k65', name)).arn).toBe('arn:fresh');
  });

  it('does NOT clear on unrelated invoke errors — the runtime is fine, the request was not', async () => {
    const name = c.generationRuntimeName('ok-agent', TEST_IMAGE);
    c.setClientsForTest({
      control: { send: async () => { throw new Error('control must not be needed'); } },
      invoke: { send: async () => { const e = new Error('bad request'); e.name = 'ValidationException'; throw e; } },
      efs: { send: async () => ({}) },
    });
    const reg = c.runtimeRegistryForTest();
    await reg.record('ok-agent', name, { arn: 'arn:ok', runtimeId: 'id1' });

    await expect(
      c.invokeStreaming('arn:ok', '000000000000000000000000000000000', {}, () => {}, { agent: 'ok-agent', maxColdRetries: 1 }),
    ).rejects.toThrow(/bad request/);

    // Still serveable with no control-plane call at all.
    expect((await reg.get('ok-agent', name)).arn).toBe('arn:ok');
    await expect(c.ensureRuntime('ok-agent', { image: TEST_IMAGE })).resolves.toBe('arn:ok');
  });
});

describe('makeStreamBridge', () => {
  const mockStreaming = (run) => ({
    getOrCreateRun: vi.fn(() => run),
    handleDelta: vi.fn(),
    handleTask: vi.fn(),
    stopStream: vi.fn(),
    finalizeRun: vi.fn(),
  });

  it('delta -> getOrCreateRun + handleDelta(accumulated text)', () => {
    const run = { lastText: '' };
    const st = mockStreaming(run);
    const session = { runs: new Map([['r1', run]]) };
    const onChunk = c.makeStreamBridge({ streaming: st, session, runId: 'r1', channel: 'C', threadTs: 'T' });
    onChunk({ type: 'delta', text: 'Hello' });
    expect(st.getOrCreateRun).toHaveBeenCalledWith(session, 'r1');
    expect(st.handleDelta).toHaveBeenCalledWith(run, session, 'Hello');
  });

  // A failed turn must be VISIBLE. Previously an `error` event was logged and then the empty `final`
  // finalised the run silently, so a failure looked identical to "nothing to say" — that is how Pi's
  // "Agent is already processing" rejection dropped 15 of 16 messages in one live burst without a trace.
  // Per-message isolation should mean it never fires, so if it ever does it must be loud.
  it('error + empty final -> reports the turn FAILED rather than finishing silently', () => {
    const st = mockStreaming({ lastText: '' });
    const session = { runs: new Map() };
    const notifyFailure = vi.fn();
    const onChunk = c.makeStreamBridge({ streaming: st, session, runId: 'r1', channel: 'C', threadTs: 'T', notifyFailure });
    onChunk({ type: 'error', message: 'Agent is already processing. Specify streamingBehavior…' });
    onChunk({ type: 'final', text: '' });
    expect(notifyFailure).toHaveBeenCalled();
    expect(st.stopStream).toHaveBeenCalledWith(session, null);
    // No finalizeRun assertion: a rejected turn emits no deltas, so no run was ever created.
  });

  it('an empty final with NO error stays silent (a turn with nothing to say is not a failure)', () => {
    const st = mockStreaming({ lastText: '' });
    const session = { runs: new Map() };
    const notifyFailure = vi.fn();
    const onChunk = c.makeStreamBridge({ streaming: st, session, runId: 'r1', channel: 'C', threadTs: 'T', notifyFailure });
    onChunk({ type: 'final', text: '' });
    expect(notifyFailure).not.toHaveBeenCalled();
    expect(st.stopStream).not.toHaveBeenCalled();
  });

  it('tool -> handleTask', () => {
    const st = mockStreaming({});
    const session = { runs: new Map() };
    const onChunk = c.makeStreamBridge({ streaming: st, session, runId: 'r1', channel: 'C', threadTs: 'T' });
    onChunk({ type: 'tool', itemId: 'i1', title: 'read', status: 'running' });
    expect(st.handleTask).toHaveBeenCalledWith(session, 'i1', 'read', 'in_progress'); // mapped to Slack enum
    onChunk({ type: 'tool', itemId: 'i1', title: 'read', status: 'done' });
    expect(st.handleTask).toHaveBeenCalledWith(session, 'i1', 'read', 'complete');
  });

  // A successful turn is reported by the stream ONLY — no ✅ reaction, and nothing else posted.
  it('final -> stopStream(text, remainingDelta) + finalizeRun, and says nothing else', () => {
    const run = { lastText: 'Hel' };
    const st = mockStreaming(run);
    const session = { runs: new Map([['r1', run]]) };
    const notifyFailure = vi.fn();
    const onChunk = c.makeStreamBridge({ streaming: st, session, runId: 'r1', channel: 'C', threadTs: 'T', notifyFailure });
    onChunk({ type: 'final', text: 'Hello' });
    expect(st.stopStream).toHaveBeenCalledWith(session, 'Hello', { remainingDelta: 'lo' });
    expect(st.finalizeRun).toHaveBeenCalledWith(session, 'r1');
    expect(notifyFailure).not.toHaveBeenCalled();
  });

  // NO_REPLY used to leave a ⛔ behind. It is now completely silent — deliberate: the agent chose not
  // to answer, which is not a failure and needs no notice.
  it('final NO_REPLY -> stopStream(null) and no notice', () => {
    const run = { lastText: '' };
    const st = mockStreaming(run);
    const session = { runs: new Map([['r1', run]]) };
    const notifyFailure = vi.fn();
    const onChunk = c.makeStreamBridge({ streaming: st, session, runId: 'r1', channel: 'C', threadTs: 'T', notifyFailure });
    onChunk({ type: 'final', text: 'NO_REPLY' });
    expect(st.stopStream).toHaveBeenCalledWith(session, null);
    expect(notifyFailure).not.toHaveBeenCalled();
  });
});

// ── G7 (§12c.7): a caller abort (cron timeout) must never be retried ───────────
//
// All three retry branches below were written for a cold-microVM reap, which presents as the same
// class of failure as our own abort. Without the guard a timed-out job would be re-invoked up to
// maxColdRetries times with backoff — the timeout would AMPLIFY the runaway it exists to stop.
describe('invokeStreaming — abortSignal (G7)', () => {
  const SID = '000000000000000000000000000000000';
  // local copy — the one above is scoped to the other describe block
  const fakeResponse = (chunks) => ({ async *[Symbol.asyncIterator]() { for (const s of chunks) yield Buffer.from(s); } });

  it('forwards the abortSignal to the SDK send()', async () => {
    let seenOpts = null;
    c.setClientsForTest({ invoke: { send: async (_cmd, opts) => {
      seenOpts = opts;
      return { response: fakeResponse(['data: {"type":"final","text":"ok"}\n\n']) };
    } } });
    const ctrl = new AbortController();
    await c.invokeStreaming('arn:x', SID, {}, () => {}, { abortSignal: ctrl.signal });
    expect(seenOpts.abortSignal).toBe(ctrl.signal);
  });

  it('passes NO second arg when there is no signal (unbounded jobs / the Slack path)', async () => {
    let argCount = -1;
    c.setClientsForTest({ invoke: { send: async (..._args) => {
      argCount = _args.length === 2 && _args[1] === undefined ? 1 : _args.length;
      return { response: fakeResponse(['data: {"type":"final","text":"ok"}\n\n']) };
    } } });
    await c.invokeStreaming('arn:x', SID, {}, () => {});
    expect(argCount).toBe(1);
  });

  it('does NOT cold-retry a coldish error once aborted', async () => {
    const ctrl = new AbortController();
    let n = 0;
    c.setClientsForTest({ invoke: { send: async () => {
      n += 1;
      ctrl.abort();                                     // our timeout fires during the attempt
      const e = new Error('runtime not ready'); e.name = 'RuntimeClientError'; throw e;
    } } });
    await expect(c.invokeStreaming('arn:x', SID, {}, () => {}, { abortSignal: ctrl.signal, coldBackoffMs: 1, maxColdRetries: 15 }))
      .rejects.toThrow(/not ready/);
    expect(n).toBe(1);                                  // one attempt, not 15
  });

  it('does NOT retry a mid-stream failure once aborted', async () => {
    const ctrl = new AbortController();
    let n = 0;
    c.setClientsForTest({ invoke: { send: async () => {
      n += 1;
      ctrl.abort();
      return { response: (async function* () { throw new Error('stream aborted'); })() };
    } } });
    await expect(c.invokeStreaming('arn:x', SID, {}, () => {}, { abortSignal: ctrl.signal, coldBackoffMs: 1, maxColdRetries: 15 }))
      .rejects.toThrow(/stream aborted/);
    expect(n).toBe(1);
  });

  it('does NOT retryIncomplete once aborted (a final-less stream after an abort is final)', async () => {
    const ctrl = new AbortController();
    let n = 0;
    c.setClientsForTest({ invoke: { send: async () => {
      n += 1;
      ctrl.abort();
      return { response: fakeResponse(['data: {"type":"delta","text":"partial"}\n\n']) };
    } } });
    await expect(c.invokeStreaming('arn:x', SID, {}, () => {}, { abortSignal: ctrl.signal, coldBackoffMs: 1, maxColdRetries: 15, retryIncomplete: true }))
      .rejects.toThrow(/without a final event|incomplete/i);
    expect(n).toBe(1);
  });

  // The guard must not break the normal reap-retry it sits next to.
  it('STILL cold-retries normally when nothing aborted', async () => {
    let n = 0;
    c.setClientsForTest({ invoke: { send: async () => {
      n += 1;
      if (n < 3) { const e = new Error('runtime not ready'); e.name = 'RuntimeClientError'; throw e; }
      return { response: fakeResponse(['data: {"type":"final","text":"ok"}\n\n']) };
    } } });
    const ctrl = new AbortController(); // never aborted
    const final = await c.invokeStreaming('arn:x', SID, {}, () => {}, { abortSignal: ctrl.signal, coldBackoffMs: 1 });
    expect(n).toBe(3);
    expect(final.text).toBe('ok');
  });
});

// ── PER-MESSAGE ISOLATION (per-session serialisation) ────────────────────────────
//
// The invariant that replaces Pi's followUp: exactly one invoke in flight per runtimeSessionId. This
// is what stops both live failure modes at source — the warm-session rejection that silently dropped
// 15 of 16 messages, and the cold-session stampede where every turn answered blind (in=3 tokens, no
// cacheRead) because each built its own AgentSession over one JSONL.
describe('invokeStreaming — one invoke at a time per session', () => {
  // A fake AgentCore invoke we can hold open, so overlap is observable rather than inferred.
  const controllable = () => {
    const gates = [];
    const client = {
      send: vi.fn(() => new Promise((resolve) => {
        gates.push(() => resolve({ response: null })); // no stream body → resolves with no final
      })),
    };
    return { client, gates };
  };

  const mk = (client) => {
    const c2 = createAgentCoreClient({ metrics: NOOP_METRICS });
    c2.setClientsForTest({ invoke: client, control: { send: vi.fn() }, efs: { send: vi.fn() } });
    return c2;
  };

  it('a second invoke for the SAME session does not start until the first settles', async () => {
    const { client, gates } = controllable();
    const cl = mk(client);
    const p1 = cl.invokeStreaming('arn', 'sess-A', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
    await new Promise((r) => setImmediate(r));
    expect(client.send).toHaveBeenCalledTimes(1);

    const p2 = cl.invokeStreaming('arn', 'sess-A', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
    await new Promise((r) => setImmediate(r));
    // STILL one: the second is queued behind the first, not racing it.
    expect(client.send).toHaveBeenCalledTimes(1);

    gates[0]();                        // let the first finish
    await p1;
    await new Promise((r) => setImmediate(r));
    expect(client.send).toHaveBeenCalledTimes(2);   // now the second runs
    gates[1]?.();
    await p2;
  });

  it('DIFFERENT sessions are NOT serialised against each other', async () => {
    const { client, gates } = controllable();
    const cl = mk(client);
    const a = cl.invokeStreaming('arn', 'sess-A', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
    const b = cl.invokeStreaming('arn', 'sess-B', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
    await new Promise((r) => setImmediate(r));
    // Both in flight: isolation is per THREAD, not a global lock — a busy thread must not block others.
    expect(client.send).toHaveBeenCalledTimes(2);
    gates.forEach((g) => g());
    await Promise.all([a, b]);
  });

  it('a FAILED invoke does not poison the queue — the next one still runs', async () => {
    let call = 0;
    const client = { send: vi.fn(() => { call += 1; return call === 1 ? Promise.reject(Object.assign(new Error('nope'), { name: 'InvalidParameterException' })) : Promise.resolve({ response: null }); }) };
    const cl = mk(client);
    await expect(cl.invokeStreaming('arn', 'sess-C', { input: {} }, () => {}, { retryIncomplete: false })).rejects.toThrow();
    // The chain gates on the predecessor SETTLING, not succeeding.
    await cl.invokeStreaming('arn', 'sess-C', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
    expect(client.send).toHaveBeenCalledTimes(2);
  });

  it('a REAL burst (11 in one thread) is fully queued — the bound is not a normal-use limit', async () => {
    // Live regression: the bound was 8, so a hand-typed 11-message burst rejected 3 with a
    // user-visible error while 8 siblings were mid-queue. The bound is a memory backstop; it must sit
    // well above what a person types.
    const client = { send: vi.fn(() => Promise.resolve({ response: null })) };
    const cl = mk(client);
    const pending = [];
    for (let i = 0; i < 11; i += 1) pending.push(cl.invokeStreaming('arn', 'sess-burst', { input: {} }, () => {}, { retryIncomplete: false }).catch((e) => e));
    const results = await Promise.all(pending);
    expect(results.filter((r) => r?.name === 'SessionQueueFull')).toHaveLength(0);
    expect(client.send).toHaveBeenCalledTimes(11);   // every message got its turn
  });

  it('the queue is BOUNDED — the memory backstop still rejects past the limit', async () => {
    // The DEFAULT bound is 10,000 (a memory backstop no human reaches), so this drives it via env to
    // prove the rejection path still exists and is typed, without queueing ten thousand turns.
    process.env.AGENTCORE_MAX_SESSION_QUEUE = '4';
    vi.resetModules();
    const { createAgentCoreClient: mk } = require('./agentcore-client');
    const { client, gates } = controllable();
    const cl = mk({ metrics: NOOP_METRICS });
    cl.setClientsForTest({ invoke: client, control: { send: vi.fn() }, efs: { send: vi.fn() } });

    const pending = [];
    let settled = 0;
    for (let i = 0; i < 4; i += 1) {
      pending.push(cl.invokeStreaming('arn', 'sess-D', { input: {} }, () => {}, { retryIncomplete: false })
        .catch((e) => e).then((r) => { settled += 1; return r; }));
    }
    const rejected = await cl.invokeStreaming('arn', 'sess-D', { input: {} }, () => {}, { retryIncomplete: false }).catch((e) => e);
    expect(rejected).toBeInstanceOf(Error);
    expect(rejected.name).toBe('SessionQueueFull');

    while (settled < 4) {
      gates.shift()?.();
      await new Promise((r) => setTimeout(r, 0));
    }
    await Promise.all(pending);
    delete process.env.AGENTCORE_MAX_SESSION_QUEUE;
    vi.resetModules();
  });

  // ── REENTRANCY ────────────────────────────────────────────────────────────────
  //
  // index.js now wraps the WHOLE Slack turn in a session slot (so the stream placeholder a user sees
  // is created when that message's turn begins). The invokeStreaming inside that
  // turn must therefore run INLINE — if it re-entered the queue it would wait on its own tail and the
  // turn would hang forever.
  it('invokeStreaming INSIDE a held slot runs inline — it must not wait on its own tail', async () => {
    const client = { send: vi.fn(() => Promise.resolve({ response: null })) };
    const cl = mk(client);
    let ran = false;
    const turn = cl.runExclusiveForSession('sess-R', async () => {
      // Same session id as the slot we hold. Pre-fix this awaits the tail we ARE — a deadlock.
      await cl.invokeStreaming('arn', 'sess-R', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
      ran = true;
    });
    const settled = await Promise.race([turn.then(() => 'done'), new Promise((r) => setTimeout(() => r('DEADLOCK'), 150))]);
    expect(settled).toBe('done');
    expect(ran).toBe(true);
    expect(client.send).toHaveBeenCalledTimes(1);
  });

  it('whole TURNS are serialised, not just their invokes', async () => {
    // The property index.js relies on: a turn holds the slot across its render setup AND its invoke, so
    // no two turns for one thread ever interleave their Slack rendering.
    const cl = mk({ send: vi.fn(() => Promise.resolve({ response: null })) });
    const order = [];
    const turn = (n) => cl.runExclusiveForSession('sess-T', async () => {
      order.push(`start${n}`);
      await new Promise((r) => setTimeout(r, 20));
      order.push(`end${n}`);
    });
    await Promise.all([turn(1), turn(2), turn(3)]);
    expect(order).toEqual(['start1', 'end1', 'start2', 'end2', 'start3', 'end3']);
  });

  it('a DIFFERENT session nested inside a slot still queues normally', async () => {
    // The reentrancy escape hatch is keyed on the session id, so holding one thread's slot must not
    // accidentally exempt every other thread from isolation.
    const { client, gates } = controllable();
    const cl = mk(client);
    const p = cl.runExclusiveForSession('sess-X', async () => {
      const a = cl.invokeStreaming('arn', 'sess-Y', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
      const b = cl.invokeStreaming('arn', 'sess-Y', { input: {} }, () => {}, { retryIncomplete: false }).catch(() => {});
      await new Promise((r) => setImmediate(r));
      expect(client.send).toHaveBeenCalledTimes(1);   // queued, NOT inlined
      for (let i = 0; i < 10 && gates.length; i += 1) { gates.shift()?.(); await new Promise((r) => setImmediate(r)); }
      await Promise.all([a, b]);
    });
    await p;
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});

// ── BACKLOG ALERT ─────────────────────────────────────────────────────────────
describe('session queue backlog alert', () => {
  const mkClient = () => {
    const c2 = createAgentCoreClient({ metrics: NOOP_METRICS });
    c2.setClientsForTest({ invoke: { send: vi.fn(() => new Promise(() => {})) }, control: { send: vi.fn() }, efs: { send: vi.fn() } });
    return c2;
  };

  it('warns ONCE per crossing, not once per message past the threshold', async () => {
    // A 400-deep queue must not produce 200 identical warnings.
    process.env.AGENTCORE_SESSION_QUEUE_ALERT_DEPTH = '3';
    vi.resetModules();
    const { createAgentCoreClient: mk } = require('./agentcore-client');
    const cl = mk({ metrics: NOOP_METRICS });
    cl.setClientsForTest({ invoke: { send: vi.fn(() => new Promise(() => {})) }, control: { send: vi.fn() }, efs: { send: vi.fn() } });
    const warn = vi.fn();
    for (let i = 0; i < 6; i += 1) {
      cl.runExclusiveForSession('sess-backlog', () => new Promise(() => {}), { logger: { warn } });
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({ depth: 3, alertAt: 3 });
    delete process.env.AGENTCORE_SESSION_QUEUE_ALERT_DEPTH;
    vi.resetModules();
  });

  it('the bound is a memory backstop a human cannot reach (10,000 by default)', () => {
    // Measured ~1,250 bytes per queued turn, so one session at the bound is ~12 MB of a 4 GB task.
    // Pinned because the whole point is that rejection effectively never happens.
    vi.resetModules();
    const mod = require('./agentcore-client');
    const cl = mod.createAgentCoreClient({ metrics: NOOP_METRICS });
    expect(typeof cl.runExclusiveForSession).toBe('function');
    // A burst far past the OLD bounds (8, then 50) must not reject.
    cl.setClientsForTest({ invoke: { send: vi.fn(() => Promise.resolve({ response: null })) }, control: { send: vi.fn() }, efs: { send: vi.fn() } });
    const results = [];
    for (let i = 0; i < 120; i += 1) {
      results.push(cl.runExclusiveForSession('sess-deep', async () => 'ok').catch((e) => e));
    }
    return Promise.all(results).then((rs) => {
      expect(rs.filter((r) => r?.name === 'SessionQueueFull')).toHaveLength(0);
    });
  });
});

// ── IMAGE GENERATIONS ─────────────────────────────────────────────────────────
//
// The runtime NAME encodes the image, so an image roll changes the name. That is what makes a roll
// instant: AgentCore holds a DELETING runtime's name for ~5 minutes, so rolling under one name means
// the agent cannot serve for that whole window. A new generation is created alongside the old one.
const { imageFingerprint, isGenerationOf } = require('./agentcore-client');

// The runtime asserts that its compiled Cedar verdict row (AGENT#<scope>/POLICY) was compiled for the
// account it is running in, which only works while this key is actually delivered. Nothing else fails if
// it disappears: policy-table.mjs treats a null as a SKIPPED assertion — deliberately, so the gap is
// visible rather than looking like a check that passed — which means losing this key silently disables
// the check across the whole fleet. That is what this test exists to prevent.
describe('AGENTCORE_ACCOUNT reaches the runtime', () => {
  it('runtimeSpecFor carries the account the POLICY row is read from', () => {
    const spec = c.runtimeSpecFor('ch-cr89fluhion', TEST_IMAGE);
    expect(spec.envs.AGENTCORE_ACCOUNT).toBe(c.config.account);
    expect(spec.envs.AGENTCORE_ACCOUNT).toMatch(/^\d{12}$/);
  });

  it('is unconditional — a missing account must not silently mean "assertion off"', () => {
    // Unlike AGENTCORE_READERS_ACCOUNT / HINDSIGHT_API_URL, which are absent-means-off by design, an
    // absent account here is an assertion that quietly does not run.
    const spec = c.runtimeSpecFor('dm-ux0mz5ckp2r', TEST_IMAGE);
    expect(Object.keys(spec.envs)).toContain('AGENTCORE_ACCOUNT');
  });

  it('is inside the fingerprint, so it lands on a roll rather than mutating a live runtime', () => {
    // Not a wish — a consequence of envs being hashed into the name. Stated as a test because the whole
    // "set it on the next roll" plan depends on it being true, and if envs ever stopped being
    // fingerprinted, existing runtimes would keep their old env with no name change to reveal it.
    const withAccount = c.runtimeSpecFor('ch-cr89fluhion', TEST_IMAGE);
    const without = { ...withAccount, envs: { ...withAccount.envs } };
    delete without.envs.AGENTCORE_ACCOUNT;
    expect(imageFingerprint(withAccount)).not.toBe(imageFingerprint(without));
  });
});

describe('generation runtime names', () => {
  const IMG_A = '203366135563.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore:pi-obs-40';
  const IMG_B = '203366135563.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore:pi-obs-41';

  it('same agent + same image -> same name (stable, so restarts adopt not recreate)', () => {
    expect(generationRuntimeName('dm-ux0mz5ckp2r', IMG_A)).toBe(generationRuntimeName('dm-ux0mz5ckp2r', IMG_A));
  });

  it('a DIFFERENT image gives a DIFFERENT name — this is the roll mechanism', () => {
    expect(generationRuntimeName('dm-ux0mz5ckp2r', IMG_A)).not.toBe(generationRuntimeName('dm-ux0mz5ckp2r', IMG_B));
  });

  it('different agents never collide on one image', () => {
    expect(generationRuntimeName('agent-a', IMG_A)).not.toBe(generationRuntimeName('agent-b', IMG_A));
  });

  it('respects AgentCore naming: <=48 chars, [a-zA-Z0-9_], starts with a letter', () => {
    for (const agent of ['a', 'dm-ux0mz5ckp2r', 'x'.repeat(80), 'weird--name..with!!chars']) {
      const n = generationRuntimeName(agent, IMG_A);
      expect(n.length).toBeLessThanOrEqual(48);
      expect(n).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
    }
  });

  it('a LONG agent id still yields distinct names per image (suffix reserved first)', () => {
    // The failure this guards: truncating to 48 AFTER appending would cut the fingerprint off, so
    // every generation of a long-named agent would share one name and the fleet would never roll.
    const long = 'a'.repeat(80);
    expect(generationRuntimeName(long, IMG_A)).not.toBe(generationRuntimeName(long, IMG_B));
  });

  it('no image -> the legacy bare name (so nothing changes before a pointer exists)', () => {
    expect(generationRuntimeName('agent-a', null)).toBe('oc_agent_a');
  });

  it('imageFingerprint is stable and short', () => {
    expect(imageFingerprint(IMG_A)).toMatch(/^[0-9a-f]{8}$/);
    expect(imageFingerprint(IMG_A)).toBe(imageFingerprint(IMG_A));
  });
});

describe('isGenerationOf — what the GC is allowed to reap', () => {
  const IMG = 'repo:tag';
  it('matches this agent\'s generations', () => {
    expect(isGenerationOf(generationRuntimeName('agent-a', IMG), 'agent-a')).toBe(true);
  });

  it('matches the PRE-generation bare name, so the first roll does not strand it', () => {
    expect(isGenerationOf('oc_agent_a', 'agent-a')).toBe(true);
  });

  it('does NOT match another agent — including one whose id is a prefix', () => {
    // The dangerous case: reaping `agent-a-b`'s runtime while rolling `agent-a` would delete a
    // different agent's live runtime.
    expect(isGenerationOf(generationRuntimeName('agent-a-b', IMG), 'agent-a')).toBe(false);
    expect(isGenerationOf(generationRuntimeName('agent-a', IMG), 'agent-a-b')).toBe(false);
    expect(isGenerationOf('oc_totally_other', 'agent-a')).toBe(false);
  });

  it('ignores junk', () => {
    for (const bad of [null, undefined, 42, '', 'oc_agent_a_ZZZZZZZZ']) {
      expect(isGenerationOf(bad, 'agent-a')).toBe(false);
    }
  });
});

describe('ensureRuntime keyed by image generation', () => {
  const mk = (listResult) => {
    const f = fakeAwsClients({ listResult });
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    cl.setClientsForTest(f);
    return { cl, f };
  };

  it('a new image MISSES the cache and provisions a new generation ON THAT IMAGE', async () => {
    // The second assertion is the one that matters and the one that was missing. `image` was
    // destructured away in createRuntime, so the saga fell back to config.imageUri: the runtime NAME
    // rolled to the new generation while the container it ran stayed on the OLD image. Counting
    // creates says "rolled"; only the containerUri handed to CreateAgentRuntime says what it rolled
    // TO. Live-caught — list-agent-runtimes looked perfect.
    const images = [];
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    const ctlSend = f.control.send;
    f.control.send = async (cmd) => {
      if (cmd.constructor.name === 'CreateAgentRuntimeCommand') {
        images.push(cmd.input.agentRuntimeArtifact?.containerConfiguration?.containerUri);
      }
      return ctlSend(cmd);
    };
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    cl.setClientsForTest(f);

    await cl.ensureRuntime('gen-a', { image: 'repo:v1' });
    expect(f.calls.create).toBe(1);
    await cl.ensureRuntime('gen-a', { image: 'repo:v1' });
    expect(f.calls.create).toBe(1);            // same image -> cache hit
    await cl.ensureRuntime('gen-a', { image: 'repo:v2' });
    expect(f.calls.create).toBe(2);            // NEW image -> new generation
    expect(images).toEqual(['repo:v1', 'repo:v2']);   // ...and it actually RUNS the new image
  });

  it('the SAME image is served from cache without touching AWS', async () => {
    const { cl, f } = mk(() => ({ agentRuntimes: [] }));
    await cl.ensureRuntime('gen-b', { image: 'repo:v1' });
    const snap = { ...f.calls };
    await cl.ensureRuntime('gen-b', { image: 'repo:v1' });
    expect(f.calls).toEqual(snap);
  });
});

describe('the default (no explicit image) is a GENERATION name', () => {
  it('pins the one-time cost: the first deploy of generation naming rolls the fleet', () => {
    // Existing runtimes carry the bare `oc_<agent>` name, so none of them match the generation name
    // derived from the current image — every agent is re-provisioned on its next message (one cold
    // boot each), and the old runtime is reaped by the GC. That is deliberate, not a regression: it
    // is the transition INTO the scheme that makes every later roll instant. Pinned so nobody
    // "fixes" the mismatch by falling back to the bare name, which would silently disable rolling.
    const CONFIG_IMAGE = TEST_IMAGE;
    expect(generationRuntimeName('agent-a', CONFIG_IMAGE)).not.toBe(sanitizeRuntimeName('agent-a'));
    expect(isGenerationOf(sanitizeRuntimeName('agent-a'), 'agent-a')).toBe(true);  // GC can still reap it
  });
});

describe('gcOldGenerations — reaping superseded generations', () => {
  // The reaper reads the RUNTIME REGISTRY for this agent's generations instead of paginating every
  // runtime in the account (the old form scanned the whole fleet, per agent, on every roll — against the
  // same non-adjustable 25/s List ceiling the registry exists to get off).
  //
  // Rows are seeded under ONE agent even when a name belongs to another, deliberately: that is what
  // still exercises the isGenerationOf guard. Per-agent partitioning already makes another agent's
  // runtimes structurally invisible, so seeding them elsewhere would make the guard untestable.
  const mkGc = (runtimes, { agent = 'agent-a' } = {}) => {
    const deleted = [];
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    const byId = new Map(runtimes.map((r) => [r.agentRuntimeId, r]));
    cl.setClientsForTest({
      control: {
        send: async (cmd) => {
          const n = cmd.constructor.name;
          // One Get now serves both the settled-status check AND the spec read-back for attribution.
          if (n === 'GetAgentRuntimeCommand') {
            const r = byId.get(cmd.input.agentRuntimeId);
            if (!r) { const e = new Error('gone'); e.name = 'ResourceNotFoundException'; throw e; }
            return { status: r.status, agentRuntimeArtifact: { containerConfiguration: { containerUri: r.image } } };
          }
          if (n === 'DeleteAgentRuntimeCommand') { deleted.push(cmd.input.agentRuntimeId); return {}; }
          throw new Error(`unexpected ${n}`);
        },
      },
      invoke: { send: async () => ({}) },
      efs: { send: async () => ({}) },
    });
    const reg = cl.runtimeRegistryForTest();
    return {
      cl,
      deleted,
      reg,
      seed: async () => {
        for (const r of runtimes) {
          await reg.record(agent, r.agentRuntimeName, { arn: `arn:${r.agentRuntimeId}`, runtimeId: r.agentRuntimeId });
        }
      },
    };
  };
  const rt = (name, id, status = 'READY') => ({ agentRuntimeName: name, agentRuntimeId: id, status });
  const KEEP = generationRuntimeName('agent-a', 'repo:v2');
  const OLD = generationRuntimeName('agent-a', 'repo:v1');

  it('reaps the superseded generation and keeps the current one', async () => {
    const { cl, deleted, seed, reg } = mkGc([rt(KEEP, 'id-keep'), rt(OLD, 'id-old')]);
    await seed();
    const { reaped } = await cl.gcOldGenerations('agent-a', KEEP);
    expect(deleted).toEqual(['id-old']);
    expect(reaped).toEqual([OLD]);
    // The ROW SURVIVES as history with its liveness claim dropped. Deleting it would make a rollback to
    // this generation invoke a corpse, burn a turn discovering that, and only then reprovision.
    const old = await reg.get('agent-a', OLD);
    expect(old).toBeTruthy();
    expect(old.arn).toBeUndefined();
    expect(old.reapedAt).toBeTruthy();
    // The kept generation is untouched and still serveable.
    expect((await reg.get('agent-a', KEEP)).arn).toBe('arn:id-keep');
  });

  it('reaps the PRE-generation bare name (the one-time migration orphan)', async () => {
    const { cl, deleted, seed } = mkGc([rt(KEEP, 'id-keep'), rt(sanitizeRuntimeName('agent-a'), 'id-legacy')]);
    await seed();
    await cl.gcOldGenerations('agent-a', KEEP);
    expect(deleted).toEqual(['id-legacy']);
  });

  it('NEVER touches another agent\'s runtimes', async () => {
    // The consequence of getting this wrong is deleting a live runtime belonging to someone else.
    const { cl, deleted, seed } = mkGc([
      rt(KEEP, 'id-keep'),
      rt(generationRuntimeName('agent-b', 'repo:v1'), 'id-other'),
      rt(generationRuntimeName('agent-a-b', 'repo:v1'), 'id-prefixy'),
      rt('oc_unrelated', 'id-unrelated'),
    ]);
    await cl.gcOldGenerations('agent-a', KEEP);
    expect(deleted).toEqual([]);
  });

  it('skips runtimes that are not settled — a CREATING one may be another dispatcher\'s', async () => {
    const { cl, deleted } = mkGc([rt(KEEP, 'id-keep'), rt(OLD, 'id-creating', 'CREATING'), rt(OLD, 'id-deleting', 'DELETING')]);
    await cl.gcOldGenerations('agent-a', KEEP);
    expect(deleted).toEqual([]);
  });

  it('a delete failure does not abort the sweep or throw at the caller', async () => {
    // It runs fire-and-forget off the turn path; throwing would surface as an unhandled rejection.
    const OLD2 = generationRuntimeName('agent-a', 'repo:v0');
    const deleted = [];
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    cl.setClientsForTest({
      control: {
        send: async (cmd) => {
          const n = cmd.constructor.name;
          if (n === 'ListAgentRuntimesCommand') return { agentRuntimes: [rt(KEEP, 'k'), rt(OLD, 'bad'), rt(OLD2, 'good')] };
          // Discriminate by COMMAND — the GC now also issues GetAgentRuntime to read the superseded
          // spec, and a fixture that counts every call as a delete reports phantom deletions.
          if (n === 'GetAgentRuntimeCommand') return {};
          if (cmd.input.agentRuntimeId === 'bad') throw new Error('throttled');
          deleted.push(cmd.input.agentRuntimeId); return {};
        },
      },
      invoke: { send: async () => ({}) }, efs: { send: async () => ({}) },
    });
    const reg = cl.runtimeRegistryForTest();
    await reg.record('agent-a', KEEP, { arn: 'arn:k', runtimeId: 'k' });
    await reg.record('agent-a', OLD, { arn: 'arn:bad', runtimeId: 'bad' });
    await reg.record('agent-a', OLD2, { arn: 'arn:good', runtimeId: 'good' });
    await expect(cl.gcOldGenerations('agent-a', KEEP, { logger: { warn() {}, info() {} } })).resolves.toBeDefined();
    expect(deleted).toEqual(['good']);   // kept sweeping past the failure
    // The failed one keeps its claim, so the next roll retries it rather than losing track of it.
    expect((await reg.get('agent-a', OLD)).arn).toBe('arn:bad');
  });

  it('a REGISTRY QUERY failure resolves rather than rejecting', async () => {
    // GC is fired without await from the turn path, so a rejection here would be an unhandled one.
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    cl.setClientsForTest({
      control: { send: async () => { throw new Error('down'); } },
      invoke: { send: async () => ({}) }, efs: { send: async () => ({}) },
    });
    cl.setRegistryForTest({ listGenerations: async () => { throw new Error('ddb down'); } });
    await expect(cl.gcOldGenerations('agent-a', KEEP, { logger: { warn() {} } })).resolves.toEqual({ reaped: [], specs: {} });
  });

  it('reaps a row that has an arn but NO runtimeId, by deriving the id from the arn', async () => {
    // Regression: ensureAgentEnvironment did not return runtimeId at first, so every early row recorded
    // null — and a reaper that required the field skipped all of them SILENTLY (no id is
    // indistinguishable from already-reaped). Superseded generations stacked up against the account's
    // 1000-runtime quota with nothing in the logs.
    const arn = 'arn:aws:bedrock-agentcore:us-east-1:203366135563:runtime/oc_agent_a_old-DERIVED';
    const { cl, deleted, reg } = mkGc([rt(KEEP, 'id-keep'), rt(OLD, 'oc_agent_a_old-DERIVED')]);
    await reg.record('agent-a', KEEP, { arn: 'arn:id-keep', runtimeId: 'id-keep' });
    await reg.record('agent-a', OLD, { arn });          // NOTE: no runtimeId
    await cl.gcOldGenerations('agent-a', KEEP);
    expect(deleted).toEqual(['oc_agent_a_old-DERIVED']);
    expect((await reg.get('agent-a', OLD)).reapedAt).toBeTruthy();
  });

  it('drops the liveness claim for a runtime that is ALREADY gone at AWS', async () => {
    // A row can outlive its runtime (reaped elsewhere, account GC, manual teardown). The reaper is the
    // cheapest place to notice, and leaving the arn in place would cost a real turn to discover.
    const { cl, seed, reg, deleted } = mkGc([rt(KEEP, 'id-keep'), rt(OLD, 'id-vanished')]);
    await seed();
    await reg.record('agent-a', OLD, { arn: 'arn:id-vanished', runtimeId: 'id-absent' });
    await cl.gcOldGenerations('agent-a', KEEP);
    expect(deleted).toEqual([]);                     // nothing to delete — it was already gone
    expect((await reg.get('agent-a', OLD)).arn).toBeUndefined();
  });
});

describe('runtime cache scoreboard — one outcome per TURN', () => {
  // Phase 2 is judged on "miss rate -> 0", so the classification has to be right per TURN, not per
  // provision: when N turns collapse onto one provision, one provision happened but N turns WAITED.
  const mk = () => {
    const seen = [];
    const cl = createAgentCoreClient({
      metrics: { ...NOOP_METRICS, emitRuntimeCache: (agent, info) => seen.push({ agent, ...info }) },
    });
    return { cl, seen };
  };

  it('a registry row scores HIT and touches no control plane', async () => {
    const { cl, seen } = mk();
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    cl.setClientsForTest(f);
    const name = cl.generationRuntimeName('sc-a', TEST_IMAGE);
    await cl.runtimeRegistryForTest().record('sc-a', name, { arn: 'arn:warm', runtimeId: 'id1' });
    await expect(cl.ensureRuntime('sc-a', { image: TEST_IMAGE })).resolves.toBe('arn:warm');
    expect(seen.map((s) => s.outcome)).toEqual(['hit']);
    expect(f.calls.create).toBe(0);
    expect(f.calls.list).toBe(0);
    expect(seen[0].agent).toBe('sc-a');
    expect(Number.isFinite(seen[0].waitMs)).toBe(true);
  });

  it('an absent row scores MISS — the only outcome pre-warm must eliminate', async () => {
    const { cl, seen } = mk();
    cl.setClientsForTest(fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) }));
    await cl.ensureRuntime('sc-b', { image: TEST_IMAGE });
    expect(seen.map((s) => s.outcome)).toEqual(['miss']);
  });

  it('turns joining an in-flight provision score COALESCED, one per turn', async () => {
    // The herd collapsing as designed: ONE provision, THREE waiting turns. All three must be counted,
    // or the hit rate flatters itself by ignoring the turns that actually waited.
    const { cl, seen } = mk();
    let release;
    const gate = new Promise((r) => { release = r; });
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    const ctl = f.control.send;
    f.control.send = async (cmd) => {
      if (cmd.constructor.name === 'CreateAgentRuntimeCommand') await gate;
      return ctl(cmd);
    };
    cl.setClientsForTest(f);
    const all = Promise.all([
      cl.ensureRuntime('sc-c', { image: TEST_IMAGE }),
      cl.ensureRuntime('sc-c', { image: TEST_IMAGE }),
      cl.ensureRuntime('sc-c', { image: TEST_IMAGE }),
    ]);
    release();
    await all;
    const counts = seen.reduce((a, s) => ({ ...a, [s.outcome]: (a[s.outcome] || 0) + 1 }), {});
    expect(counts.miss).toBe(1);            // exactly one turn did the provisioning
    expect(counts.coalesced).toBe(2);       // the other two waited on it
    expect(f.calls.create).toBe(1);         // and only one runtime was made
  });

  it('scores every turn exactly once, so hit+miss+coalesced equals turns', async () => {
    const { cl, seen } = mk();
    cl.setClientsForTest(fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) }));
    await cl.ensureRuntime('sc-d', { image: TEST_IMAGE });   // miss
    await cl.ensureRuntime('sc-d', { image: TEST_IMAGE });   // hit (recorded by the first)
    await cl.ensureRuntime('sc-d', { image: TEST_IMAGE });   // hit
    expect(seen).toHaveLength(3);
    expect(seen.map((s) => s.outcome)).toEqual(['miss', 'hit', 'hit']);
  });

  it('does NOT score a turn whose provision FAILED — a failure is not a cache outcome', async () => {
    const { cl, seen } = mk();
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    f.control.send = async (cmd) => {
      if (cmd.constructor.name === 'CreateAgentRuntimeCommand') {
        const e = new Error('bad image'); e.name = 'InvalidParameterValueException'; throw e;
      }
      return { MountTargets: [] };
    };
    f.efs.send = async () => ({ MountTargets: [{ VpcId: CONFIG.vpcId, AvailabilityZoneId: 'use1-az1', SubnetId: 'subnet-a' }], AccessPointId: 'ap', AccessPoints: [{ LifeCycleState: 'available' }] });
    cl.setClientsForTest(f);
    await expect(cl.ensureRuntime('sc-e', { image: TEST_IMAGE, logger: { warn() {}, error() {}, info() {} } })).rejects.toThrow();
    expect(seen).toEqual([]);
  });
});

describe('adopt-by-name verifies the image', () => {
  // The name is meant to BE the spec fingerprint, so adoption trusts it. That trust is only sound if
  // nothing can create a runtime whose name and content disagree — and a bug did exactly that, making a
  // roll a silent no-op.
  //
  // WHERE THIS CHECK LIVES MOVED. It used to run in agentcore-client, which pre-scanned by name before
  // deciding whether to create. That scan is gone (the registry answers name->arn with a GetItem), so
  // adoption is now reached via CreateAgentRuntime returning ConflictException — and the verification
  // moved with it, into agentcore-provisioning's adoptExisting. These tests therefore drive the CONFLICT
  // path, which is what real AgentCore does when the name is held.
  const mkExisting = (image) => {
    const deleted = [];
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    const heldName = () => cl.generationRuntimeName('adopt-a', 'repo:want');
    const f = fakeAwsClients({
      // Spec-aware name (resolved lazily, so the client exists): the registry key is the WHOLE
      // immutable spec, not just the image.
      listResult: () => ({ agentRuntimes: [{ agentRuntimeName: heldName(), agentRuntimeId: 'id1', status: 'READY' }] }),
    });
    const ctlSend = f.control.send;
    f.control.send = async (cmd) => {
      const n = cmd.constructor.name;
      // The image the runtime ACTUALLY runs — the only thing that can contradict its name.
      if (n === 'GetAgentRuntimeCommand') {
        return {
          agentRuntimeArn: 'arn:existing',
          status: 'READY',
          agentRuntimeArtifact: { containerConfiguration: { containerUri: image } },
        };
      }
      if (n === 'DeleteAgentRuntimeCommand') { deleted.push(cmd.input.agentRuntimeId); return {}; }
      return ctlSend(cmd);
    };
    cl.setClientsForTest(f);
    return { cl, deleted, calls: f.calls };
  };

  it('adopts when the image matches the name', async () => {
    const { cl, deleted, calls } = mkExisting('repo:want');
    await expect(cl.ensureRuntime('adopt-a', { image: 'repo:want' })).resolves.toBe('arn:existing');
    expect(deleted).toEqual([]);
    // ONE create was ATTEMPTED and conflicted — that is the cost of dropping the pre-flight scan, and
    // the assertion that matters is that no SECOND runtime was minted.
    expect(calls.create).toBe(1);
  });

  it('REFUSES a mislabelled runtime, deletes it, and throws rather than serving the wrong build', async () => {
    const { cl, deleted } = mkExisting('repo:STALE');
    const err = vi.fn();
    await expect(cl.ensureRuntime('adopt-a', { image: 'repo:want', logger: { error: err, warn() {}, info() {} } }))
      .rejects.toThrow(/runs repo:STALE, expected repo:want/);
    expect(deleted).toEqual(['id1']);
    expect(err).toHaveBeenCalled();
  });

  it('adopts when the runtime reports no image (nothing to contradict)', async () => {
    const { cl, deleted } = mkExisting(null);
    await expect(cl.ensureRuntime('adopt-a', { image: 'repo:want' })).resolves.toBe('arn:existing');
    expect(deleted).toEqual([]);
  });

  it('does NOT record a mislabelled runtime in the registry — a bad row would be served forever', async () => {
    // The registry has no status field and no expiry, so a row written for a mismatched runtime would
    // be a permanent claim that the wrong build is correct. The write must happen only after adoption
    // has verified the image.
    const { cl } = mkExisting('repo:STALE');
    await expect(cl.ensureRuntime('adopt-a', { image: 'repo:want', logger: { error() {}, warn() {}, info() {} } }))
      .rejects.toThrow(/expected repo:want/);
    const name = cl.generationRuntimeName('adopt-a', 'repo:want');
    expect(await cl.runtimeRegistryForTest().get('adopt-a', name)).toBeNull();
  });
});

// ── SPEC-WIDE GENERATION FINGERPRINT ─────────────────────────────────────────
//
// Everything in the CreateAgentRuntime spec is immutable after create, so a change to ANY of it must
// mint a new generation — otherwise the change silently never applies to existing runtimes. That was a
// real latent bug: moving DISPATCHER_BASE_URL or rotating a secret's ID reached only new agents, and
// nothing logged, alarmed or looked wrong.
describe('runtime generation fingerprints the whole immutable spec', () => {
  const mk = (overrides = {}) => createAgentCoreClient({ metrics: NOOP_METRICS, ...overrides });
  const IMG = 'repo/agentcore:v1';

  it('the SAME spec always yields the SAME name (stable across calls)', () => {
    const c1 = mk(); const c2 = mk();
    expect(c1.generationRuntimeName('a', IMG)).toBe(c2.generationRuntimeName('a', IMG));
  });

  it('a different EFS ROOT changes the name — this is what makes the test->live flip apply', () => {
    const live = mk({ efsRootPrefix: '/openclaw-data' });
    const test = mk({ efsRootPrefix: '/agentcore-test' });
    expect(live.generationRuntimeName('a', IMG)).not.toBe(test.generationRuntimeName('a', IMG));
  });

  it('a different ENV VAR changes the name (the latent bug this closes)', () => {
    const a = mk({ dispatcherBaseUrl: 'https://old.example' });
    const b = mk({ dispatcherBaseUrl: 'https://new.example' });
    expect(a.generationRuntimeName('x', IMG)).not.toBe(b.generationRuntimeName('x', IMG));
  });

  it('a rotated SECRET ID changes the name', () => {
    const a = mk({ credentialSecret: 'secret-old' });
    const b = mk({ credentialSecret: 'secret-new' });
    expect(a.generationRuntimeName('x', IMG)).not.toBe(b.generationRuntimeName('x', IMG));
  });

  it('a different security group changes the name', () => {
    const a = mk({ securityGroupId: 'sg-aaa' });
    const b = mk({ securityGroupId: 'sg-bbb' });
    expect(a.generationRuntimeName('x', IMG)).not.toBe(b.generationRuntimeName('x', IMG));
  });

  it('a different IMAGE still changes the name (unchanged behaviour)', () => {
    const c = mk();
    expect(c.generationRuntimeName('x', 'repo:v1')).not.toBe(c.generationRuntimeName('x', 'repo:v2'));
  });

  it('KEY ORDER does not change the name — an unsorted hash would mint a runtime per turn', () => {
    // The flapping bug this prevents: hash inputs arriving in a different order look like a config
    // change, so every turn provisions a new runtime (~30s) and leaks an access point and a role.
    const { imageFingerprint } = require('./agentcore-client');
    const one = { image: 'i', envs: { B: '2', A: '1' }, efsRoot: '/r', z: 1 };
    const two = { z: 1, efsRoot: '/r', envs: { A: '1', B: '2' }, image: 'i' };
    expect(imageFingerprint(one)).toBe(imageFingerprint(two));
  });

  it('ARRAY ORDER does not change the name either (fields are sets, not lists)', () => {
    const { imageFingerprint } = require('./agentcore-client');
    expect(imageFingerprint({ subnets: ['a', 'b', 'c'] })).toBe(imageFingerprint({ subnets: ['c', 'a', 'b'] }));
  });

  it('a bare image string still works (back-compat with the old signature)', () => {
    const { generationRuntimeName: pure } = require('./agentcore-client');
    expect(pure('a', 'repo:v1')).toMatch(/^oc_a_[0-9a-f]{8}$/);
    expect(pure('a', 'repo:v1')).not.toBe(pure('a', 'repo:v2'));
  });

  it('ensureRuntime and the GC agree on the name (or the GC reaps the LIVE runtime)', async () => {
    // These must be the same function. If ensureRuntime derived a spec-based name while the GC still
    // used an image-only one, the GC would treat the live runtime as superseded and delete it.
    let created = null;
    const f = fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) });
    const ctl = f.control.send;
    f.control.send = async (cmd) => {
      if (cmd.constructor.name === 'CreateAgentRuntimeCommand') created = cmd.input.agentRuntimeName;
      return ctl(cmd);
    };
    const c = mk(); c.setClientsForTest(f);
    await c.ensureRuntime('agree', { image: IMG });
    expect(created).toBe(c.generationRuntimeName('agree', IMG));
  });
});

describe('observedSpecOf — reading a live runtime\'s ACTUAL spec back from AWS', () => {
  // This is what makes attribution precise after a DEPLOY. A dispatcher that just restarted has no
  // in-process "before", and a name hash is one-way — so the only way to say WHICH field changed is to
  // read the superseded runtime's real configuration before deleting it.
  const mk = (get, efs = { send: async () => ({}) }) => {
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    cl.setClientsForTest({
      control: { send: async (cmd) => (cmd.constructor.name === 'GetAgentRuntimeCommand' ? get : {}) },
      invoke: { send: async () => ({}) }, efs,
    });
    return cl;
  };
  const withAp = (apArn) => ({
    agentRuntimeArtifact: { containerConfiguration: { containerUri: 'repo:v9' } },
    filesystemConfigurations: [{ efsAccessPoint: { accessPointArn: apArn, mountPath: '/mnt/efs' } }],
  });

  it('maps the AWS shape onto the same shape runtimeSpecFor produces', async () => {
    const cl = mk({
      agentRuntimeArtifact: { containerConfiguration: { containerUri: 'repo:v9' } },
      environmentVariables: { DISPATCHER_BASE_URL: 'https://old', AGENT_NAME: 'x' },
      networkConfiguration: { networkModeConfig: { securityGroups: ['sg-old'] } },
      lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
      protocolConfiguration: { serverProtocol: 'HTTP' },
      filesystemConfigurations: [{ efsAccessPoint: { accessPointArn: 'arn:ap:old', mountPath: '/mnt/efs' } }],
    });
    const observed = await cl.observedSpecOf('rt-1');
    expect(observed.image).toBe('repo:v9');
    expect(observed.envs.DISPATCHER_BASE_URL).toBe('https://old');
    expect(observed.securityGroupId).toBe('sg-old');
    expect(observed.maxLifetime).toBe(28800);
    expect(observed.efsAccessPoint).toBe('arn:ap:old');
  });

  it('survives a runtime that reports nothing useful (attribution is best-effort)', async () => {
    const cl = mk({});
    const observed = await cl.observedSpecOf('rt-1');
    expect(observed.image).toBeUndefined();
    expect(observed.envs).toEqual({});
  });

  // WHY THIS CALL EXISTS. GetAgentRuntime reports the access point ARN, never the ROOT PATH it was
  // created against — but the root path is what our own spec expresses, so without resolving it the
  // filesystem had to be dropped from the diff entirely and an EFS ROOT change reported 'unknown'.
  // That is precisely the side-by-side -> live migration cutover, i.e. the one roll we most need
  // named. One DescribeAccessPoints, and only on a roll.
  it('resolves the EFS ROOT PATH from the access point, so a root change is attributable', async () => {
    const seen = [];
    const cl = mk(withAp('arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-0abc'), {
      send: async (cmd) => { seen.push(cmd.input); return { AccessPoints: [{ RootDirectory: { Path: '/agentcore-test/agents/a' } }] }; },
    });
    const observed = await cl.observedSpecOf('rt-1');
    expect(observed.efsRoot).toBe('/agentcore-test/agents/a');
    // Described by AP ID, parsed out of the ARN — DescribeAccessPoints does not accept an ARN.
    expect(seen).toEqual([{ AccessPointId: 'fsap-0abc' }]);
  });

  it('leaves the root UNSET (not wrong) when the access point has already been deleted', async () => {
    const cl = mk(withAp('arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-gone'), {
      send: async () => { const e = new Error('not found'); e.name = 'AccessPointNotFound'; throw e; },
    });
    const observed = await cl.observedSpecOf('rt-1');
    expect(observed.efsRoot).toBeUndefined();
    // The rest of the attribution must survive it — a missing AP is not a reason to lose the image diff.
    expect(observed.image).toBe('repo:v9');
  });

  it('does not call EFS at all when the runtime has no filesystem', async () => {
    let calls = 0;
    const cl = mk({ agentRuntimeArtifact: { containerConfiguration: { containerUri: 'repo:v9' } } },
      { send: async () => { calls += 1; return {}; } });
    const observed = await cl.observedSpecOf('rt-1');
    expect(calls).toBe(0);
    expect(observed.efsRoot).toBeUndefined();
  });

  it('the GC attaches the superseded spec so the caller can diff it', async () => {
    const KEEP = 'oc_agent_a_aaaaaaaa';
    const OLD = 'oc_agent_a_bbbbbbbb';
    const cl = createAgentCoreClient({ metrics: NOOP_METRICS });
    cl.setClientsForTest({
      control: {
        send: async (cmd) => {
          const n = cmd.constructor.name;
          if (n === 'ListAgentRuntimesCommand') {
            return { agentRuntimes: [{ agentRuntimeName: OLD, agentRuntimeId: 'id-old', status: 'READY' }] };
          }
          if (n === 'GetAgentRuntimeCommand') {
            return { environmentVariables: { DISPATCHER_BASE_URL: 'https://old' },
                     agentRuntimeArtifact: { containerConfiguration: { containerUri: 'repo:v1' } } };
          }
          if (n === 'DeleteAgentRuntimeCommand') return {};
          throw new Error(`unexpected ${n}`);
        },
      },
      invoke: { send: async () => ({}) }, efs: { send: async () => ({}) },
    });
    await cl.runtimeRegistryForTest().record('agent-a', OLD, { arn: 'arn:id-old', runtimeId: 'id-old' });
    const { reaped, specs } = await cl.gcOldGenerations('agent-a', KEEP, { logger: { info() {}, warn() {} } });
    expect(reaped).toContain(OLD);
    // .specs carries the real old config — which is what turns "it rolled" into "DISPATCHER_BASE_URL changed"
    expect(specs[OLD].envs.DISPATCHER_BASE_URL).toBe('https://old');
    expect(specs[OLD].image).toBe('repo:v1');
  });
});

describe('the POLICY row write is an UpdateItem, because that is the permission we have', () => {
  // STRUCTURAL, because it cannot be behavioural: setClientsForTest sets `_faked`, and ensurePolicyRow
  // returns { reason: 'no-table' } immediately when faked — so no injected double can reach the write.
  //
  // Worth pinning anyway. This wrote with PutCommand against a role that holds UpdateItem and NOT
  // PutItem (the same constraint marketplace.js and the §9.9a seed pre-write record), so EVERY policy
  // row write failed with AccessDeniedException — non-fatally, and invisibly, because a second bug
  // upstream (rowFromMemberships throwing on an unknown group name) surfaced first and masked it.
  //
  // Since an absent row now means DENY-ALL, this is the difference between a working agent and one that
  // cannot read a file. And the dispatcher is the ONLY writer for minted scopes, which no deploy can
  // enumerate — measured live: dm-ux0mz5ckp2r and ch-c39t04uyfgs were both dead this way.
  const src = require('node:fs').readFileSync(require.resolve('./agentcore-client.js'), 'utf8');
  // END ANCHOR FOUND FORWARD FROM THE START, not by naming the next function. The first version sliced
  // to `resolveEfsRootFromMeta`, which sits EARLIER in the file — so the slice was empty and the
  // assertions passed against '' until the negation ones failed. A test that reads nothing looks green.
  const start = src.indexOf('async function ensurePolicyRow');
  const after = src.indexOf('\n  async function ', start + 1);
  const ensureBody = src.slice(start, after > start ? after : start + 4000);

  it('uses UpdateCommand and never PutCommand', () => {
    expect(ensureBody).toMatch(/new UpdateCommand\(/);
    expect(ensureBody).not.toMatch(/new PutCommand\(/);
  });

  it('carries no ConditionExpression — it must OVERWRITE a moved digest', () => {
    // The seed pre-write is create-only (attribute_not_exists) on purpose; this is the opposite case.
    // A condition here would make a policy change silently fail to reach any scope that already had a row.
    expect(ensureBody).not.toMatch(/ConditionExpression/);
  });

  it('aliases the reserved attribute name', () => {
    // `data` is fine unaliased, but an unaliased attribute is how the 2026-08-13 fleet-wide outage
    // happened (a bare `agent`), so the expression is asserted to use a placeholder either way.
    expect(ensureBody).toMatch(/ExpressionAttributeNames/);
    expect(ensureBody).toMatch(/SET #d = :d/);
  });

  // ── no caches, and every outcome reported ──────────────────────────────────────────────────────
  //
  // Both properties exist because their absence was undetectable. The per-agent digest memo returned
  // 'cached' WITHOUT reading the row, so a teardown that deleted the row out of band was never noticed
  // again; and four of the five outcomes logged nothing, so the resulting deny-all looked exactly like a
  // healthy scope. Measured live on dm-ux0mz5ckp2r: PolicyDenyAll=1 across 14:25-14:50Z on 2026-08-20,
  // with not one line matching /policy/ in the dispatcher log group for the whole of that day.
  it('caches neither the artifact nor the per-agent digest', () => {
    const whole = src;
    // The memo, by name and by shape. Only the historical comment may mention it.
    expect(whole).not.toMatch(/^\s*const lastPolicyDigest/m);
    expect(ensureBody).not.toMatch(/lastPolicyDigest/);
    // The artifact read: no timestamp, no expiry window, no memo slot.
    const pa = whole.slice(whole.indexOf('async function policyArtifact'));
    const paBody = pa.slice(0, pa.indexOf('\n  }') + 4);
    expect(paBody).not.toMatch(/TTL|_policyArtifactAtMs|Date\.now\(\)/);
    // It must actually issue the read every call — not return an early-cached value.
    expect(paBody).toMatch(/GetCommand/);
  });

  it('routes every non-write through the reporting helper', () => {
    for (const reason of ['no-table', 'no-artifact', 'current']) {
      expect(ensureBody).toContain(`noWrite('${reason}'`);
    }
    // A hand-rolled `return { written: false, ... }` is how a silent branch gets re-added. Exactly two
    // are legitimate: `noWrite`'s own return, and the catch — which carries `error:` and has its own warn
    // naming the failure (routing it through noWrite would replace that message with something vaguer).
    const bare = ensureBody.match(/return \{ written: false[^}]*\}/g) || [];
    expect(bare.length).toBeGreaterThan(0); // the anchor found the body, not an empty slice
    const allowed = ['reason, ...extra', 'error:'];
    for (const r of bare) expect(allowed.some((a) => r.includes(a))).toBe(true);
  });

  it('warns — not debugs — when NO row can be written for any scope', () => {
    // no-artifact / no-table mean the whole account is deny-all, so they must be visible at the default
    // level. `current` is the healthy steady state and would be one line per turn per agent.
    expect(ensureBody).toMatch(/no-artifact'\s*\|\|\s*reason === 'no-table'\)\s*\?\s*'warn'\s*:\s*'debug'/);
  });
});

describe('ensurePolicyRow reports the no-op it took', () => {
  // BEHAVIOURAL for the one branch a fake can reach: setClientsForTest sets `_faked`, which is the
  // `no-table` path. The others need a real doc client and stay structural above.
  it('logs the reason instead of returning silently', async () => {
    c.setClientsForTest(fakeAwsClients({ listResult: () => ({ agentRuntimes: [] }) }));
    const warn = [];
    const r = await c.ensurePolicyRow('dm-ux0mz5ckp2r', {
      logger: { warn: (o, m) => warn.push({ o, m }), info: () => {}, debug: () => {} },
    });
    expect(r).toMatchObject({ written: false, reason: 'no-table' });
    expect(warn).toHaveLength(1);
    expect(warn[0].m).toBe('policy row not written (no-table)');
    // The AGENT is on the line. Without it the warning says the fleet is broken but not for whom.
    expect(warn[0].o).toMatchObject({ agent: 'dm-ux0mz5ckp2r', reason: 'no-table' });
  });
});

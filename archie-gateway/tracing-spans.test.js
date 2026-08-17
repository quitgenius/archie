'use strict';

// M2 manual phase spans — emission + nesting tests. Registers a LOCAL NodeTracerProvider with an
// InMemorySpanExporter (never ./tracing — library modules must work off @opentelemetry/api alone),
// then drives cron-fire / agentcore-client / agentcore-provisioning with the same mocked AWS
// clients the existing unit tests use, and asserts the span tree:
//
//   dispatcher.request (SERVER, cron)                     ← cron-fire.js fire()
//   dispatcher.provision                                   ← agentcore-provisioning.js saga
//     ├─ dispatcher.provision.mount_targets
//     ├─ dispatcher.provision.access_point
//     ├─ dispatcher.provision.runtime_ready
//     │    └─ dispatcher.provision.name_release_wait       ← P3-B DELETING-name wait
//          └─ dispatcher.agent_i073q7 (CLIENT)             ← agentcore-client.js invokeStreaming
//
// vitest isolates test files in separate workers, so the global provider registered here
// cannot leak into other test files.

const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { InMemorySpanExporter, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { resourceFromAttributes } = require('@opentelemetry/resources');
const { trace, SpanKind, SpanStatusCode } = require('@opentelemetry/api');

const { createAgentCoreClient, sanitizeRuntimeName, generationRuntimeName, CONFIG } = require('./agentcore-client');
const prov = require('./agentcore-provisioning');
const { createCronFire } = require('./cron-fire');
const { NOOP_METRICS } = require('./dispatcher-metrics');

// The container image is a REQUIRED input to provisioning now — there is no baked default, because a
// default is a silent downgrade when the fleet pointer is missing. Tests therefore say which image
// they mean, exactly as the dispatcher does after resolving CONFIG#image.
const TEST_IMAGE = '203366135563.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore:test-image';

const exporter = new InMemorySpanExporter();
let provider;

beforeAll(() => {
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ 'service.name': 'slack-dispatcher-test' }),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register(); // global tracer provider + AsyncLocalStorage context manager
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

beforeEach(() => exporter.reset());

const spans = () => exporter.getFinishedSpans();
const byName = (name) => spans().filter((s) => s.name === name);
const one = (name) => {
  const hits = byName(name);
  expect(hits, `expected exactly one span named ${name}`).toHaveLength(1);
  return hits[0];
};
const parentIdOf = (s) => s.parentSpanContext && s.parentSpanContext.spanId;

// ── Mock AWS clients (same shape as agentcore-client.test.js) ────────────────────
function fakeAwsClients({ listResults, invokeSend } = {}) {
  let lists = 0;
  const control = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'ListAgentRuntimesCommand') { lists += 1; return (listResults || (() => ({ agentRuntimes: [] })))(lists); }
      if (n === 'GetAgentRuntimeCommand') return { agentRuntimeArn: 'arn:existing', status: 'READY' };
      if (n === 'CreateAgentRuntimeCommand') return { agentRuntimeId: 'idNew', agentRuntimeArn: 'arn:new', status: 'READY' };
      throw new Error(`unexpected control cmd ${n}`);
    },
  };
  const efs = {
    send: async (cmd) => {
      const n = cmd.constructor.name;
      if (n === 'DescribeMountTargetsCommand') return { MountTargets: [{ VpcId: CONFIG.vpcId, AvailabilityZoneId: 'use1-az1', SubnetId: 'subnet-a' }] };
      if (n === 'CreateAccessPointCommand') return { AccessPointId: 'apId' };
      if (n === 'DescribeAccessPointsCommand') return { AccessPoints: [{ LifeCycleState: 'available' }] };
      throw new Error(`unexpected efs cmd ${n}`);
    },
  };
  const invoke = {
    send: async (cmd) => {
      if (invokeSend) return invokeSend(cmd);
      return { response: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: {"type":"final","text":"pong"}\n\n'); } } };
    },
  };
  return { control, efs, invoke };
}

// ── dispatcher.agent_i073q7 (agentcore-client.js) ────────────────────────────────

describe('dispatcher.agent_i073q7 span', () => {
  it('wraps the full invoke leg: CLIENT kind, agent/trigger/session attrs, cold_retries on success', async () => {
    const c = createAgentCoreClient({ metrics: NOOP_METRICS });
    c.setClientsForTest(fakeAwsClients());
    const final = await c.invokeStreaming('arn:rt', 'sess-1', { input: { prompt: 'hi' } }, () => {}, { agent: 'alpha', trigger: 'user' });
    expect(final.type).toBe('final');
    const s = one('dispatcher.agent_i073q7');
    expect(s.kind).toBe(SpanKind.CLIENT);
    expect(s.attributes['dispatcher.agent']).toBe('alpha');
    expect(s.attributes['dispatcher.trigger']).toBe('user');
    expect(s.attributes['dispatcher.session_id']).toBe('sess-1');
    expect(s.attributes['dispatcher.cold_retries']).toBe(0);
    expect(s.status.code).not.toBe(SpanStatusCode.ERROR);
  });

  it('marks the span ERROR when the invoke fails after retries', async () => {
    const c = createAgentCoreClient({ metrics: NOOP_METRICS });
    c.setClientsForTest(fakeAwsClients({
      invokeSend: () => { const e = new Error('bad request'); e.name = 'ValidationException'; throw e; },
    }));
    await expect(c.invokeStreaming('arn:rt', 'sess-2', { input: {} }, () => {}, { agent: 'alpha', trigger: 'user', maxColdRetries: 1 })).rejects.toThrow(/bad request/);
    const s = one('dispatcher.agent_i073q7');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
  });

  // M3 produce: the body carries a W3C traceparent whose trace-id and parent-span-id are the
  // ACTIVE dispatcher.agent_i073q7 span — so the runtime's agent_i073q7 span (which extracts
  // body.input.traceparent, agentcore-pi/trace-context.mjs) parents under it: one cross-boundary trace.
  it('stamps body.input.traceparent from the active agent_i073q7 span (M3 produce)', async () => {
    const sent = [];
    const c = createAgentCoreClient({ metrics: NOOP_METRICS });
    c.setClientsForTest(fakeAwsClients({
      invokeSend: (cmd) => {
        sent.push(JSON.parse(Buffer.from(cmd.input.payload).toString('utf8')));
        return { response: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: {"type":"final","text":"pong"}\n\n'); } } };
      },
    }));
    await c.invokeStreaming('arn:rt', 'sess-3', { input: { prompt: 'hi' } }, () => {}, { agent: 'alpha', trigger: 'cron' });
    const s = one('dispatcher.agent_i073q7');
    expect(sent).toHaveLength(1);
    const tp = sent[0].input.traceparent;
    expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    const [, traceId, parentSpanId] = tp.split('-');
    expect(traceId).toBe(s.spanContext().traceId);       // same trace across the boundary
    expect(parentSpanId).toBe(s.spanContext().spanId);   // runtime span parents under agent_i073q7
  });

  it('does not overwrite a caller-provided traceparent and tolerates payloads without input', async () => {
    const sent = [];
    const c = createAgentCoreClient({ metrics: NOOP_METRICS });
    c.setClientsForTest(fakeAwsClients({
      invokeSend: (cmd) => {
        sent.push(JSON.parse(Buffer.from(cmd.input.payload).toString('utf8')));
        return { response: { async *[Symbol.asyncIterator]() { yield Buffer.from('data: {"type":"final","text":"ok"}\n\n'); } } };
      },
    }));
    const preset = '00-11111111111111111111111111111111-2222222222222222-01';
    await c.invokeStreaming('arn:rt', 'sess-4', { input: { prompt: 'x', traceparent: preset } }, () => {}, {});
    await c.invokeStreaming('arn:rt', 'sess-5', {}, () => {}, {}); // no input object — must not throw
    expect(sent[0].input.traceparent).toBe(preset);
    expect(sent[1].input).toBeUndefined();
  });
});

// ── dispatcher.provision tree (agentcore-provisioning.js via the client) ─────────

describe('dispatcher.provision span tree', () => {
  it('cold provision emits provision parent + mount_targets/access_point/runtime_ready children', async () => {
    const c = createAgentCoreClient({ metrics: NOOP_METRICS });
    c.setClientsForTest(fakeAwsClients());
    const arn = await c.ensureRuntime('alpha', { image: TEST_IMAGE });
    expect(arn).toBe('arn:new');

    const provision = one('dispatcher.provision');
    expect(provision.attributes['dispatcher.agent']).toBe('alpha');
    expect(provision.attributes['dispatcher.runtime_name']).toBe(c.generationRuntimeName('alpha', TEST_IMAGE));
    expect(provision.attributes['dispatcher.runtime_created']).toBe(true);

    const traceId = provision.spanContext().traceId;
    for (const child of ['dispatcher.provision.mount_targets', 'dispatcher.provision.access_point', 'dispatcher.provision.runtime_ready']) {
      const s = one(child);
      expect(s.spanContext().traceId, `${child} shares the provision trace`).toBe(traceId);
      expect(parentIdOf(s), `${child} is a child of dispatcher.provision`).toBe(provision.spanContext().spanId);
    }

    // Provisioning spends NO model turn: the dispatcher.warmup span and the synthetic "ping" invoke
    // under it are gone (2026-08-11). The caller's own turn is the runtime's first invoke.
    expect(byName('dispatcher.warmup')).toHaveLength(0);
    expect(byName('dispatcher.agent_i073q7')).toHaveLength(0);
  });

  it('P3-B: the DELETING-name wait surfaces as name_release_wait nested under runtime_ready', async () => {
    // Reached REACTIVELY since the pre-flight ListAgentRuntimes was removed: the first create conflicts
    // on the name the dying runtime still holds, and the conflict handler is what waits for release. The
    // span tree is the thing under test and it must stay the same shape through that change.
    let gets = 0;
    let released = false;
    const clients = fakeAwsClients({
      listResults: () => ({ agentRuntimes: [{ agentRuntimeName: sanitizeRuntimeName('alpha'), agentRuntimeId: 'rt-dying' }] }),
    });
    clients.control = {
      send: async (cmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListAgentRuntimesCommand') {
          return released ? { agentRuntimes: [] }
            : { agentRuntimes: [{ agentRuntimeName: sanitizeRuntimeName('alpha'), agentRuntimeId: 'rt-dying' }] };
        }
        if (n === 'GetAgentRuntimeCommand') {
          gets += 1;
          if (gets <= 2) return { status: 'DELETING', agentRuntimeArn: 'arn:dying' };
          released = true;
          const e = new Error('gone'); e.name = 'ResourceNotFoundException'; throw e;
        }
        if (n === 'CreateAgentRuntimeCommand') {
          // AgentCore's name uniqueness: rejected while the carcass holds the name.
          if (!released) {
            const e = new Error('name already in use'); e.name = 'ConflictException'; throw e;
          }
          return { agentRuntimeId: 'idNew', agentRuntimeArn: 'arn:new', status: 'READY' };
        }
        throw new Error(`unexpected control cmd ${n}`);
      },
    };
    const controlCmds = require('@aws-sdk/client-bedrock-agentcore-control');
    const efsCmds = require('@aws-sdk/client-efs');
    const r = await prov.ensureAgentEnvironment('alpha', {
      runtimeName: sanitizeRuntimeName('alpha'),
      role: 'arn:aws:iam::1:role/x',
      image: 'img:x',
      envs: { AGENT_NAME: 'alpha' },
      efsRootFor: (a) => `/openclaw-data/agents/${a}`,
      clients: { control: clients.control, efs: clients.efs, controlCmds, efsCmds },
      config: CONFIG,
      sleep: async () => {},
    });
    expect(r.runtimeArn).toBe('arn:new');
    const wait = one('dispatcher.provision.name_release_wait');
    expect(wait.attributes['dispatcher.runtime_id']).toBe('rt-dying');
    expect(parentIdOf(wait)).toBe(one('dispatcher.provision.runtime_ready').spanContext().spanId);
  });

  it('a failing provision marks dispatcher.provision ERROR (and the failing child)', async () => {
    const clients = fakeAwsClients();
    clients.control = {
      send: async (cmd) => {
        const n = cmd.constructor.name;
        if (n === 'ListAgentRuntimesCommand') return { agentRuntimes: [] };
        if (n === 'CreateAgentRuntimeCommand') { const e = new Error('bad image'); e.name = 'InvalidParameterValueException'; throw e; }
        if (n === 'GetAgentRuntimeCommand') return { status: 'READY' };
        if (n === 'DeleteAgentRuntimeCommand') return {};
        throw new Error(`unexpected control cmd ${n}`);
      },
    };
    clients.efs.send = (() => {
      const orig = clients.efs.send;
      return async (cmd) => (cmd.constructor.name === 'DeleteAccessPointCommand' ? {} : orig(cmd));
    })();
    const controlCmds = require('@aws-sdk/client-bedrock-agentcore-control');
    const efsCmds = require('@aws-sdk/client-efs');
    await expect(prov.ensureAgentEnvironment('alpha', {
      runtimeName: sanitizeRuntimeName('alpha'),
      role: 'arn:aws:iam::1:role/x',
      image: 'img:bad',
      envs: { AGENT_NAME: 'alpha' },
      efsRootFor: (a) => `/openclaw-data/agents/${a}`,
      clients: { control: clients.control, efs: clients.efs, controlCmds, efsCmds },
      config: CONFIG,
      sleep: async () => {},
    })).rejects.toThrow(/bad image/);
    expect(one('dispatcher.provision').status.code).toBe(SpanStatusCode.ERROR);
    expect(one('dispatcher.provision.runtime_ready').status.code).toBe(SpanStatusCode.ERROR);
  });
});

// ── dispatcher.request root at the cron fire path (cron-fire.js) ─────────────────

describe('dispatcher.request span (cron trigger)', () => {
  const job = { jobId: 'j1', agentId: 'alpha', sessionKey: 'agent:alpha:main', payload: { message: 'do it' } };

  it('is a SERVER root wrapping the whole fire (PHI-free attrs; no message text)', async () => {
    const agentCore = {
      ensureRuntime: async () => 'arn:rt',
      invokeStreaming: async () => ({ type: 'final', text: 'done' }),
    };
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron' });
    const final = await fire(job);
    expect(final.text).toBe('done');
    const s = one('dispatcher.request');
    expect(s.kind).toBe(SpanKind.SERVER);
    expect(parentIdOf(s)).toBeUndefined(); // root
    expect(s.attributes['dispatcher.trigger']).toBe('cron');
    expect(s.attributes['dispatcher.agent']).toBe('alpha');
    expect(s.attributes['dispatcher.session_key']).toBe('agent:alpha:main');
    expect(s.attributes['dispatcher.cron.job_id']).toBe('j1');
    expect(JSON.stringify(s.attributes)).not.toContain('do it'); // never the message text
  });

  // M4.4 — the swallowed-delivery blind spot. Verified live: the span for a cron job whose
  // announce failed invalid_arguments was status UNSET with zero delivery attributes, so
  // Transaction Search reported a clean 4.8s success. `deliver` still must not throw; the span
  // must stop lying about it.
  it('M4.4: carries the delivery CONFIG (mode/status/channel) + schedule from the shared classifier', async () => {
    const agentCore = {
      ensureRuntime: async () => 'arn:rt',
      invokeStreaming: async () => ({ type: 'final', text: 'done' }),
    };
    const broken = {
      ...job,
      schedule: { kind: 'cron', expr: '0 7 * * *' },
      delivery: { mode: 'announce' }, // nothing resolvable → announce-missing-channel
      state: { nextRunAtMs: 1_800_000_100_000 },
    };
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron' });
    await fire(broken);
    const s = one('dispatcher.request');
    expect(s.attributes['cron.delivery.mode']).toBe('announce');
    expect(s.attributes['cron.delivery.status']).toBe('announce-missing-channel');
    expect(s.attributes['cron.delivery.channel']).toBe('none');
    expect(s.attributes['cron.schedule.kind']).toBe('cron');
    expect(s.attributes['cron.next_run_at_ms']).toBe(1_800_000_100_000);
  });

  it('M4.4: a SWALLOWED delivery failure marks the span ERROR + records the reason', async () => {
    const agentCore = {
      ensureRuntime: async () => 'arn:rt',
      invokeStreaming: async () => ({ type: 'final', text: 'done' }),
    };
    // deliver() swallows and reports — exactly cron-delivery.js's contract
    const deliver = async () => ({ delivered: false, error: 'An API error occurred: invalid_arguments' });
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron', deliver });
    const final = await fire(job);
    expect(final.text).toBe('done'); // the FIRE still succeeds — swallow semantics unchanged
    const s = one('dispatcher.request');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes['cron.delivery.delivered']).toBe(false);
    expect(s.attributes['cron.delivery.error']).toMatch(/invalid_arguments/);
    expect(s.events.map((e) => e.name)).toContain('cron.delivery.failed');
  });

  it('M4.4: a successful delivery leaves the span green', async () => {
    const agentCore = {
      ensureRuntime: async () => 'arn:rt',
      invokeStreaming: async () => ({ type: 'final', text: 'done' }),
    };
    const deliver = async () => ({ delivered: true, mode: 'announce' });
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron', deliver });
    await fire(job);
    const s = one('dispatcher.request');
    expect(s.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(s.attributes['cron.delivery.delivered']).toBe(true);
  });

  it('M4.4: a NO_REPLY skip is recorded but is NOT an error', async () => {
    const agentCore = {
      ensureRuntime: async () => 'arn:rt',
      invokeStreaming: async () => ({ type: 'final', text: 'NO_REPLY' }),
    };
    const deliver = async () => ({ delivered: false, reason: 'no-reply' });
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron', deliver });
    await fire(job);
    const s = one('dispatcher.request');
    expect(s.status.code).not.toBe(SpanStatusCode.ERROR);
    expect(s.attributes['cron.delivery.skip_reason']).toBe('no-reply');
  });

  it('M4.4: a throwing enrichment can never break the fire', async () => {
    const agentCore = {
      ensureRuntime: async () => 'arn:rt',
      invokeStreaming: async () => ({ type: 'final', text: 'done' }),
    };
    const deliver = async () => { const o = {}; Object.defineProperty(o, 'delivered', { get() { throw new Error('boom'); } }); return o; };
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron', deliver });
    await expect(fire(job)).resolves.toBeTruthy();
  });

  it('a failed fire still propagates (runner records it) and marks the span ERROR', async () => {
    const agentCore = {
      ensureRuntime: async () => { throw new Error('provision blew up'); },
      invokeStreaming: async () => ({ type: 'final', text: '' }),
    };
    const { fire } = createCronFire({ agentCore, sessionIdFor: () => 'sess-cron' });
    await expect(fire(job)).rejects.toThrow(/provision blew up/);
    const s = one('dispatcher.request');
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('nests the real client invoke under the cron root (one trace end-to-end)', async () => {
    const c = createAgentCoreClient({ metrics: NOOP_METRICS });
    c.setClientsForTest(fakeAwsClients());
    // Mirror production: index.js injects the image-aware resolver (ensureCurrentRuntime), so cron
    // turns resolve the published pointer exactly like Slack turns. Without it, the fallback reaches
    // provisioning with no image and fails closed — which is the intended behaviour, not this test's
    // subject.
    const { fire } = createCronFire({
      agentCore: c,
      ensureRuntime: (agent, o) => c.ensureRuntime(agent, { ...o, image: TEST_IMAGE }),
      sessionIdFor: () => 'sess-cron',
    });
    await fire(job);
    const root = one('dispatcher.request');
    const provision = one('dispatcher.provision');
    expect(parentIdOf(provision)).toBe(root.spanContext().spanId);
    // ONE invoke span: the cron turn itself. There were two until the warm-up was removed — the
    // cron fire's own invoke is now the runtime's first, which is the point of the change.
    const invokes = byName('dispatcher.agent_i073q7');
    expect(invokes).toHaveLength(1);
    for (const s of invokes) expect(s.spanContext().traceId).toBe(root.spanContext().traceId);
    const cronInvoke = invokes.find((s) => parentIdOf(s) === root.spanContext().spanId);
    expect(cronInvoke, 'the cron turn invoke is a direct child of dispatcher.request').toBeTruthy();
    expect(cronInvoke.attributes['dispatcher.trigger']).toBe('cron');
  });
});

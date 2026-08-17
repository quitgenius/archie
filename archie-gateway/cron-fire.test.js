'use strict';

// vitest globals enabled via vitest.config.js
const { createCronFire, withTimeout } = require('./cron-fire');
const { CRON_TIMEOUT_ERROR } = require('./cron-inventory-metrics');

function mocks(over = {}) {
  const agentCore = {
    ensureRuntime: vi.fn(async () => 'arn:runtime'),
    invokeStreaming: vi.fn(async () => ({ text: 'turn done', usage: { output: 3 } })),
    ...over.agentCore,
  };
  const deliver = vi.fn(async () => {});
  const sessionIdFor = over.sessionIdFor || ((job) => `sess-${job.agentId}-${job.sessionTarget || 'main'}`.padEnd(33, '0'));
  const fireHandler = createCronFire({ agentCore, sessionIdFor, deliver, now: () => 1234 });
  return { agentCore, deliver, sessionIdFor, fire: fireHandler.fire };
}

const job = (over = {}) => ({
  id: 'agentA::daily',
  agentId: 'agentA',
  jobId: 'daily',
  sessionTarget: 'main',
  payload: { kind: 'agentTurn', message: 'run the digest' },
  ...over,
});

// Live regression, 2026-08-12. The runtime reports a thrown turn in-band, and invokeStreaming now
// carries it on the final as `error`. If cron treats that as a normal empty turn, a job that fails
// on EVERY fire records status 'ok', resets consecutiveErrors, and failureAlert can never trip —
// which is exactly what the logs showed: "cron fire completed, textLen 0", indefinitely.
describe('a turn that errored inside the runtime is a FIRE FAILURE, not an empty turn', () => {
  it('throws so runOnce records the error, and does NOT deliver', async () => {
    const m = mocks({ agentCore: { invokeStreaming: vi.fn(async () => ({ text: '', error: 'turn exploded' })) } });
    await expect(m.fire(job({ delivery: { mode: 'announce', to: 'C123' } }))).rejects.toThrow('turn exploded');
    expect(m.deliver).not.toHaveBeenCalled();
  });

  it('a normal empty turn still succeeds quietly (nothing to say is not a failure)', async () => {
    const m = mocks({ agentCore: { invokeStreaming: vi.fn(async () => ({ text: '' })) } });
    await expect(m.fire(job())).resolves.toBeTruthy();
  });
});

describe('cron fire', () => {
  it('ensures the runtime, invokes with a cron turn, and delivers', async () => {
    const m = mocks();
    const final = await m.fire(job());
    expect(m.agentCore.ensureRuntime).toHaveBeenCalledWith('agentA', expect.anything());
    // invoke body carries the prompt + cron trigger
    const [, sessionId, body] = m.agentCore.invokeStreaming.mock.calls[0];
    // §12c: the prompt is the job's message PLUS a delivery instruction (the agent otherwise
    // has no way to know its text is the delivery). The message still leads.
    expect(body.input.prompt.startsWith('run the digest')).toBe(true);
    expect(body.input.trigger).toBe('cron');
    expect(body.input.runId).toBe('cron:agentA:daily:1234');
    expect(sessionId).toHaveLength(33);
    expect(m.deliver).toHaveBeenCalledWith(expect.objectContaining({ jobId: 'daily' }), final);
    expect(final.text).toBe('turn done');
  });

  it('passes the per-job Connector entity as sender', async () => {
    const m = mocks();
    await m.fire(job({ connectorEntity: 'user-42' }));
    const body = m.agentCore.invokeStreaming.mock.calls[0][2];
    expect(body.input.sender).toBe('user-42');
  });

  it('ensures the runtime BEFORE invoking (ordering)', async () => {
    const order = [];
    const m = mocks({
      agentCore: {
        ensureRuntime: vi.fn(async () => { order.push('ensureRuntime'); return 'arn'; }),
        invokeStreaming: vi.fn(async () => { order.push('invoke'); return {}; }),
      },
    });
    await m.fire(job());
    expect(order).toEqual(['ensureRuntime', 'invoke']);
  });

  it('delegates the runtime session id to sessionIdFor (main vs isolated)', async () => {
    const seen = [];
    const m = mocks({ sessionIdFor: (j) => { seen.push(j.sessionTarget); return `s-${j.sessionTarget}`.padEnd(33, '0'); } });
    await m.fire(job({ sessionTarget: 'isolated' }));
    expect(seen).toEqual(['isolated']);
  });
});

describe('cron fire — failures propagate, delivery gated on success', () => {
  it('propagates ensureRuntime failure and does NOT deliver', async () => {
    const m = mocks({ agentCore: { ensureRuntime: vi.fn(async () => { throw new Error('provision failed'); }) } });
    await expect(m.fire(job())).rejects.toThrow('provision failed');
    expect(m.deliver).not.toHaveBeenCalled();
  });

  it('propagates invoke failure and does NOT deliver', async () => {
    const m = mocks({
      agentCore: {
        ensureRuntime: vi.fn(async () => 'arn'),
        invokeStreaming: vi.fn(async () => { throw new Error('invoke 500'); }),
      },
    });
    await expect(m.fire(job())).rejects.toThrow('invoke 500');
    expect(m.deliver).not.toHaveBeenCalled();
  });
});


// §12c — the agent must be told how its output reaches anyone. Without this a cron fire sent the
// bare payload.message, and agents refused live with "I don't have a Slack messaging tool
// available in this session — I can't send the message."
describe('delivery instruction on the cron prompt', () => {
  const fireWith = async (job) => {
    let prompt;
    const agentCore = {
      ensureRuntime: async () => 'arn',
      invokeStreaming: async (a, b, body) => { prompt = body.input.prompt; return { text: 'ok' }; },
    };
    await createCronFire({ agentCore, sessionIdFor: () => 'sess'.padEnd(33, '0') }).fire(job);
    return prompt;
  };
  const base = { agentId: 'a', jobId: 'j', payload: { kind: 'agentTurn', message: 'do the thing' } };

  it('a deliverable announce says the text IS the delivery, and no tool is needed', async () => {
    const p = await fireWith({ ...base, delivery: { mode: 'announce' }, sessionKey: 'slack:thread:DL1HA3II6V6:1.2' });
    expect(p).toContain('do the thing');            // the job's own prompt is preserved, first
    expect(p).toMatch(/delivered to Slack automatically/);
    expect(p).toMatch(/no messaging tool to call/);
  });

  it('an UNDELIVERABLE announce warns the reply will not reach anyone', async () => {
    const p = await fireWith({ ...base, delivery: { mode: 'announce' } });
    expect(p).toMatch(/does not resolve/);
    expect(p).toMatch(/NOT reach anyone/);
  });

  it('no delivery = BACKGROUND: act with tools, do not compose a reply (79% of enabled prod jobs)', async () => {
    const p = await fireWith(base);
    expect(p).toMatch(/BACKGROUND turn/);
    expect(p).toMatch(/do not compose a reply/);
    expect(p).toMatch(/do not report that you cannot send a message/);
  });

  it('a systemEvent payload uses `text` — reading only `message` invoked with prompt=undefined', async () => {
    const p = await fireWith({ agentId: 'a', jobId: 'j', payload: { kind: 'systemEvent', text: 'wake up' } });
    expect(p.startsWith('wake up')).toBe(true);
  });

  it('an unclassifiable job still gets the safe BACKGROUND instruction, not a crash', async () => {
    const p = await fireWith({ agentId: 'a', jobId: 'j', payload: null });
    expect(p).toMatch(/BACKGROUND turn/);
  });
});

// ── G7 (§12c.7): timeoutSeconds enforcement + model passthrough ────────────────
describe('cron fire — timeoutSeconds (G7)', () => {
  it('passes an abortSignal and the resolved budget for a bounded job', async () => {
    const m = mocks();
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 300 } }));
    const opts = m.agentCore.invokeStreaming.mock.calls[0][4];
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(opts.abortSignal.aborted).toBe(false);
  });

  // timeoutSeconds: 0 = unbounded. The passthrough must not even create a controller, so the
  // unbounded path cannot be broken by the timeout code.
  it('passes NO abortSignal when the job is unbounded (timeoutSeconds: 0)', async () => {
    const m = mocks();
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 0 } }));
    expect(m.agentCore.invokeStreaming.mock.calls[0][4].abortSignal).toBeUndefined();
  });

  it('ABORTS the invoke and fails with upstream\'s verbatim error when the budget expires', async () => {
    let seenSignal = null;
    const m = mocks({
      agentCore: {
        // never settles on its own — only the budget can end this turn
        invokeStreaming: vi.fn((_arn, _sid, _body, _cb, opts) => new Promise((resolve, reject) => {
          seenSignal = opts.abortSignal;
          opts.abortSignal.addEventListener('abort', () => reject(new Error('aborted')));
        })),
      },
    });
    await expect(m.fire(job({ payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 0.01 } })))
      .rejects.toThrow(CRON_TIMEOUT_ERROR);
    expect(seenSignal.aborted).toBe(true);      // the turn was actually cancelled, not just un-awaited
    expect(m.deliver).not.toHaveBeenCalled();   // a timed-out turn delivers nothing
  });

  // The error text is load-bearing: the runner's consecutiveErrors -> failureAlert path and
  // cron-hydrator's classifyUpstreamFailure both key off it, and a rolled-back OpenClaw job
  // must look identical.
  it('uses the SAME error text OpenClaw uses', () => {
    expect(CRON_TIMEOUT_ERROR).toBe('cron: job execution timed out');
  });

  describe('withTimeout', () => {
    it('is a pure passthrough when unbounded (no timer, signal undefined)', async () => {
      const seen = [];
      const out = await withTimeout(null, (sig) => { seen.push(sig); return Promise.resolve('ok'); });
      expect(out).toBe('ok');
      expect(seen).toEqual([undefined]);
    });

    it('resolves normally when the work finishes inside the budget', async () => {
      await expect(withTimeout(5_000, async () => 'done')).resolves.toBe('done');
    });

    it('propagates the work\'s own error unchanged (not as a timeout)', async () => {
      await expect(withTimeout(5_000, async () => { throw new Error('invoke 500'); }))
        .rejects.toThrow('invoke 500');
    });

    it('records the exceeded budget on the span', async () => {
      const span = { setAttribute: vi.fn(), addEvent: vi.fn() };
      await expect(withTimeout(5, (sig) => new Promise((_r, rej) => {
        sig.addEventListener('abort', () => rej(new Error('aborted')));
      }), { span })).rejects.toThrow(CRON_TIMEOUT_ERROR);
      expect(span.setAttribute).toHaveBeenCalledWith('cron.timed_out', true);
      expect(span.setAttribute).toHaveBeenCalledWith('cron.timeout_ms', 5);
      expect(span.addEvent).toHaveBeenCalledWith('cron.timed_out', { 'cron.timeout_ms': 5 });
    });

    it('span enrichment failure never masks the timeout', async () => {
      const span = { setAttribute: () => { throw new Error('span dead'); }, addEvent: () => {} };
      await expect(withTimeout(5, (sig) => new Promise((_r, rej) => {
        sig.addEventListener('abort', () => rej(new Error('aborted')));
      }), { span })).rejects.toThrow(CRON_TIMEOUT_ERROR);
    });
  });
});

describe('cron fire — model override (G7)', () => {
  it('forwards a normalised model id in the invoke body', async () => {
    const m = mocks();
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x', model: 'amazon-bedrock/global.anthropic.claude-sonnet-4-6' } }));
    expect(m.agentCore.invokeStreaming.mock.calls[0][2].input.model).toBe('global.anthropic.claude-sonnet-4-6');
  });

  it('omits the field entirely when the job has no override', async () => {
    const m = mocks();
    await m.fire(job());
    expect('model' in m.agentCore.invokeStreaming.mock.calls[0][2].input).toBe(false);
  });

  it('omits it for a systemEvent (model is an agentTurn field upstream)', async () => {
    const m = mocks();
    await m.fire(job({ payload: { kind: 'systemEvent', text: 'x', model: 'global.anthropic.claude-sonnet-4-6' } }));
    expect('model' in m.agentCore.invokeStreaming.mock.calls[0][2].input).toBe(false);
  });
});

// Live-caught on the first image roll: cron fired through agentCore.ensureRuntime directly, which
// resolves the runtime name from the dispatcher's BAKED image. Cron-driven agents therefore ignored
// the published pointer and stayed on the build image while Slack-driven turns rolled — and the
// generation cron minted was never reaped, because the GC runs in the same wrapper.
describe('cron honours the published image pointer', () => {
  it('uses the injected image-aware resolver, not agentCore.ensureRuntime', async () => {
    const calls = [];
    const fire = createCronFire({
      agentCore: {
        ensureRuntime: async () => { calls.push('RAW'); return 'arn:raw'; },
        invokeStreaming: async () => ({ type: 'final', text: 'ok' }),
      },
      ensureRuntime: async (agent) => { calls.push(`WRAPPED:${agent}`); return 'arn:wrapped'; },
      sessionIdFor: () => '0'.repeat(33),
    });
    await fire.fire({ agentId: 'agent-a', jobId: 'j1', payload: { kind: 'agentTurn', message: 'hi' } });
    expect(calls).toEqual(['WRAPPED:agent-a']);
    expect(calls).not.toContain('RAW');
  });

  it('falls back to the raw client when no resolver is injected (back-compat)', async () => {
    const calls = [];
    const fire = createCronFire({
      agentCore: {
        ensureRuntime: async () => { calls.push('RAW'); return 'arn:raw'; },
        invokeStreaming: async () => ({ type: 'final', text: 'ok' }),
      },
      sessionIdFor: () => '0'.repeat(33),
    });
    await fire.fire({ agentId: 'agent-a', jobId: 'j1', payload: { kind: 'agentTurn', message: 'hi' } });
    expect(calls).toEqual(['RAW']);
  });
});

// Live regression, 2026-08-12. hiccup-ping read its own accumulated output in the per-job session,
// concluded "there's a runaway cron job", and deleted itself. The prompt now says what the
// repetition IS; the runtime PEP is the hard guard (permissions-extension deniedCronMutation).
describe('the fire prompt tells the agent it is inside a scheduled run', () => {
  const promptOf = async (job) => {
    const m = mocks();
    await m.fire(job);
    return m.agentCore.invokeStreaming.mock.calls[0][2].input.prompt;
  };

  it('names the job and its cadence, and says repetition is the schedule', async () => {
    const p = await promptOf(job({ name: 'hiccup-ping', schedule: { kind: 'every', everyMs: 120000 } }));
    expect(p).toContain('SCHEDULED run');
    expect(p).toContain('hiccup-ping');
    expect(p).toContain('every 120s');
    expect(p).toMatch(/NOT a runaway/);
    expect(p).toMatch(/Do not delete or disable this job/);
  });

  it('describes a cron expression, and still carries the payload + delivery instruction', async () => {
    const p = await promptOf(job({
      name: 'daily', schedule: { kind: 'cron', expr: '0 7 * * *' },
      payload: { kind: 'agentTurn', message: 'run the digest' },
      delivery: { mode: 'announce', to: 'CZ3E1122Y3K' },
    }));
    expect(p).toContain('run the digest');       // the actual work survives
    expect(p).toContain('on "0 7 * * *"');
    expect(p).toContain('delivered to Slack automatically');  // deliveryInstruction still appended
  });

  it('degrades safely on a schedule it cannot describe', async () => {
    const p = await promptOf(job({ name: 'odd', schedule: { kind: 'at', at: 123 } }));
    expect(p).toContain('SCHEDULED run');        // no cadence phrase, no throw
  });
});

// §3a' — the per-scope CRON_RUNNER gate. During the migration both schedulers exist: the agent's
// OpenClaw gateway still fires its own jobs.json, and archie holds hydrated copies of the same
// jobs. Firing both is a duplicate turn, a duplicate Slack post and a duplicate side effect.
describe('the CRON_RUNNER gate decides whether this stack fires at all', () => {
  const gated = (runner, over = {}) => {
    const runnerFlags = { get: vi.fn(async () => ({ runner, source: 'store' })) };
    const onRunnerGated = vi.fn();
    const agentCore = {
      ensureRuntime: vi.fn(async () => 'arn:runtime'),
      invokeStreaming: vi.fn(async () => ({ text: 'turn done' })),
    };
    const deliver = vi.fn(async () => {});
    const handler = createCronFire({
      agentCore, deliver, runnerFlags, onRunnerGated, now: () => 1234,
      sessionIdFor: () => 'sess'.padEnd(33, '0'), ...over,
    });
    return { agentCore, deliver, runnerFlags, onRunnerGated, fire: handler.fire };
  };

  it('fires normally when the scope has been moved to agentcore', async () => {
    const m = gated('agentcore');
    await m.fire(job());
    expect(m.agentCore.invokeStreaming).toHaveBeenCalled();
  });

  it('exits early when the scope still belongs to openclaw', async () => {
    const m = gated('openclaw');
    const result = await m.fire(job());
    expect(result).toMatchObject({ gated: true, runner: 'openclaw' });
    expect(m.agentCore.invokeStreaming).not.toHaveBeenCalled();
    expect(m.deliver).not.toHaveBeenCalled();
  });

  // ensureRuntime CREATES the agent's runtime and starts its billing clock. A gate placed after it
  // would still boot every un-migrated agent in the fleet on its own schedule — the cost of the
  // migration without any of the benefit.
  it('declines BEFORE ensureRuntime, so a gated scope is never even provisioned', async () => {
    const m = gated('openclaw');
    await m.fire(job());
    expect(m.agentCore.ensureRuntime).not.toHaveBeenCalled();
  });

  // Returning normally (rather than throwing) is what keeps consecutiveErrors at zero: a scope
  // waiting on its cutover must not trip failureAlert simply for not being ours yet.
  it('is a success, not an error — a scope awaiting cutover cannot alarm', async () => {
    const m = gated('openclaw');
    await expect(m.fire(job())).resolves.toBeTruthy();
  });

  it('counts the declined tick, which is the only place it is countable', async () => {
    const m = gated('openclaw');
    await m.fire(job());
    expect(m.onRunnerGated).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'daily' }),
      expect.objectContaining({ runner: 'openclaw' }),
    );
  });

  // App Home "Run now" / POST /:agentId/:jobId/run. One explicit human run cannot produce the
  // sustained double-fire the gate exists to prevent, and it is how you prove a hydrated job works
  // here BEFORE handing the schedule over.
  it('a manual run bypasses it', async () => {
    const m = gated('openclaw');
    await m.fire(job(), { manual: true });
    expect(m.agentCore.invokeStreaming).toHaveBeenCalled();
  });

  it('is absent by default — a caller that wires no flags fires everything', async () => {
    const m = mocks();
    await m.fire(job());
    expect(m.agentCore.invokeStreaming).toHaveBeenCalled();
  });
});

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
  // `now` and `mintTurnToken` are threaded from `over` so a test can control the clock and observe
  // the token claims; everything else keeps its default. Without the pass-through a test that passes
  // them silently gets the defaults and asserts nothing.
  const fireHandler = createCronFire({
    agentCore, sessionIdFor, deliver,
    now: over.now || (() => 1234),
    ...(over.mintTurnToken ? { mintTurnToken: over.mintTurnToken } : {}),
    ...(over.turnTokens ? { turnTokens: over.turnTokens } : {}),
    ...(over.onTimeoutKill ? { onTimeoutKill: over.onTimeoutKill } : {}),
  });
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

  // `timeoutSeconds: 0` USED to mean unbounded, and the passthrough did not even create a
  // controller. Since the per-job budget was removed (2026-09-16) the field is inert: every
  // agentTurn gets AGENT_TURN_CEILING_MS, so 0 is bounded like everything else. This asserts the
  // field is ignored rather than honoured — the old behaviour would show up as a missing signal.
  it('IGNORES timeoutSeconds: 0 — no job is unbounded any more', async () => {
    const m = mocks();
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 0 } }));
    expect(m.agentCore.invokeStreaming.mock.calls[0][4].abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('every agentTurn gets the same ceiling, whatever it asked for', () => {
    const { CRON_TIMEOUT, resolveCronTimeoutMs } = require('./cron-inventory-metrics');
    for (const timeoutSeconds of [0, -1, 30, 300, 99_999]) {
      expect(resolveCronTimeoutMs(job({ payload: { kind: 'agentTurn', message: 'x', timeoutSeconds } })))
        .toBe(CRON_TIMEOUT.AGENT_TURN_CEILING_MS);
    }
    // 7h50m, not 8h: the runtime's session maxLifetime is 28800s, and our timeout has to fire FIRST
    // or the turn dies with an opaque platform error instead of CRON_TIMEOUT_ERROR + CronTimeoutKill.
    expect(CRON_TIMEOUT.AGENT_TURN_CEILING_MS).toBe(28_200_000);
    expect(CRON_TIMEOUT.AGENT_TURN_CEILING_MS).toBeLessThan(28_800_000);
  });

  // The abort itself is unit-tested against `withTimeout` below with a small budget — it can no
  // longer be driven through a job, because a job cannot ask for a short one any more.
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

    it('ABORTS the work and fails with upstream\'s verbatim error when the budget expires', async () => {
      let seen = null;
      await expect(withTimeout(5, (sig) => new Promise((_r, rej) => {
        seen = sig;
        sig.addEventListener('abort', () => rej(new Error('aborted')));
      }))).rejects.toThrow(CRON_TIMEOUT_ERROR);
      // Cancelled, not merely un-awaited: otherwise the turn keeps running on the runtime, billed
      // and with its side effects intact, and we have only looked away.
      expect(seen.aborted).toBe(true);
    });

    it('emits onTimeoutKill with the budget that was exceeded', async () => {
      const onTimeoutKill = vi.fn();
      const j = { agentId: 'a', jobId: 'j' };
      await expect(withTimeout(5, (sig) => new Promise((_r, rej) => {
        sig.addEventListener('abort', () => rej(new Error('aborted')));
      }), { job: j, onTimeoutKill })).rejects.toThrow(CRON_TIMEOUT_ERROR);
      expect(onTimeoutKill).toHaveBeenCalledWith(j, { timeoutMs: 5 });
    });

    it('a throwing onTimeoutKill never masks the timeout', async () => {
      await expect(withTimeout(5, (sig) => new Promise((_r, rej) => {
        sig.addEventListener('abort', () => rej(new Error('aborted')));
      }), { onTimeoutKill: () => { throw new Error('metrics dead'); } })).rejects.toThrow(CRON_TIMEOUT_ERROR);
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

// ── the per-turn dispatcher token (plan phase 1) ─────────────────────────────
// Minting only. Nothing consumes the token yet — the runtime reads named payload fields and ignores
// the rest — so these assert the CLAIMS, which are the part a later phase will trust.
describe('cron fire — per-turn dispatcher token', () => {
  it('puts a scope-bound token on the payload', async () => {
    const seen = [];
    const m = mocks({ mintTurnToken: (c) => { seen.push(c); return 'tok-1'; } });
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x' } }));
    expect(m.agentCore.invokeStreaming.mock.calls[0][2].input.dispatcherToken).toBe('tok-1');
    expect(seen[0].scope).toBe('agentA');     // the JOB's agent, never anything from the payload
    expect(seen[0].runId).toMatch(/^cron:agentA:/);
  });

  // A fixed TTL would expire mid-run on an 8-hour job or be uselessly loose on a 30-second one. The
  // budget is already computed to drive the abort signal, so the token and the turn die together.
  it('ties the token\'s life to THIS job\'s budget, not a constant', async () => {
    const seen = [];
    const m = mocks({ now: () => 1_000_000, mintTurnToken: (c) => { seen.push(c); return 't'; } });
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x' } }));
    const { CRON_TIMEOUT } = require('./cron-inventory-metrics');
    // budget + margin, so an in-flight call at the moment of abort does not fail on auth instead of
    // reporting the timeout that actually happened.
    expect(seen[0].expMs).toBeGreaterThan(1_000_000 + CRON_TIMEOUT.AGENT_TURN_CEILING_MS);
  });

  it('omits the field entirely when no minter is injected — the field is optional by design', async () => {
    const m = mocks();
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x' } }));
    expect('dispatcherToken' in m.agentCore.invokeStreaming.mock.calls[0][2].input).toBe(false);
  });
});

// The row is what makes the token die with its turn; without the close it would stay good for the
// whole 8-hour budget after the run finished.
describe('cron fire — the token\'s revocation row', () => {
  const tracked = () => {
    const calls = [];
    return { calls, open: async (c) => calls.push(['open', c.jti]), close: async (c) => calls.push(['close', c.jti]) };
  };
  const minter = () => {
    const { mintTurnToken } = require('./turn-token');
    return (c) => mintTurnToken({ ...c }, 'secret');
  };

  it('opens before the invoke and closes after it', async () => {
    const t = tracked();
    const m = mocks({ mintTurnToken: minter(), turnTokens: t });
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x' } }));
    expect(t.calls.map((c) => c[0])).toEqual(['open', 'close']);
    expect(t.calls[0][1]).toBe(t.calls[1][1]);   // the same row, not a second one
  });

  // The exit that matters most: the runtime was aborted and is not coming back, so anything still
  // presenting the token is not it.
  it('closes when the turn FAILS', async () => {
    const t = tracked();
    const m = mocks({
      mintTurnToken: minter(),
      turnTokens: t,
      agentCore: { invokeStreaming: vi.fn(async () => { throw new Error('boom'); }) },
    });
    await expect(m.fire(job({ payload: { kind: 'agentTurn', message: 'x' } }))).rejects.toThrow('boom');
    expect(t.calls.map((c) => c[0])).toEqual(['open', 'close']);
  });

  it('does nothing when no token was minted — the row is the token\'s, not the job\'s', async () => {
    const t = tracked();
    const m = mocks({ turnTokens: t });
    await m.fire(job({ payload: { kind: 'agentTurn', message: 'x' } }));
    expect(t.calls).toEqual([]);
  });
});

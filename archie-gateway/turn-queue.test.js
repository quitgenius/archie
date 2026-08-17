'use strict';

const { createTurnQueue, turnDedupId, sanitizeId } = require('./turn-queue');

const QURL = 'https://sqs.us-east-1.amazonaws.com/203366135563/agent-4ggvzl-dispatcher-turns.fifo';

function mkClient({ failWith } = {}) {
  const sent = [];
  return {
    sent,
    client: {
      send: async (cmd) => {
        if (failWith) throw failWith;
        sent.push(cmd.input);
        return { MessageId: `msg-${sent.length}` };
      },
    },
  };
}

const evt = (over = {}) => ({
  type: 'message', text: 'hello', user: 'UX0MZ5CKP2R', channel: 'C66PP782T9K',
  ts: '1786402232.090069', client_msg_id: 'cmi-abc-123', ...over,
});

describe('turnDedupId', () => {
  it('uses Slack\'s own client_msg_id when present', () => {
    expect(turnDedupId(evt())).toBe('cmi-abc-123');
  });

  it('falls back to channel+ts, which identifies a message uniquely', () => {
    expect(turnDedupId(evt({ client_msg_id: undefined }))).toBe('C66PP782T9K-1786402232.090069');
  });

  it('is NOT content-based — two identical texts are two distinct turns', () => {
    // The thing that repeats is the EVENT, not the text. A user sending "ok" twice means two turns,
    // and collapsing them would silently swallow the second.
    const a = turnDedupId(evt({ client_msg_id: 'cmi-1', text: 'ok' }));
    const b = turnDedupId(evt({ client_msg_id: 'cmi-2', text: 'ok' }));
    expect(a).not.toBe(b);
  });

  it('survives junk without producing an invalid id', () => {
    for (const bad of [null, undefined, {}, { channel: 'C/1', ts: '1.2' }]) {
      const id = turnDedupId(bad);
      expect(id.length).toBeGreaterThan(0);
      expect(id.length).toBeLessThanOrEqual(128);
      expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
    }
  });
});

describe('sanitizeId', () => {
  it('strips characters SQS rejects and caps at 128', () => {
    const id = sanitizeId(`${'x'.repeat(200)}!!!`, 'fb');
    expect(id.length).toBe(128);
    expect(id).toMatch(/^[A-Za-z0-9._:-]+$/);
  });

  it('falls back rather than returning empty (an empty id is a rejected send = a dropped message)', () => {
    expect(sanitizeId('', 'fb')).toBe('fb');
    expect(sanitizeId('!!!', 'fb')).toBe('fb');
    expect(sanitizeId(null, 'fb')).toBe('fb');
  });
});

describe('createTurnQueue', () => {
  it('is DISABLED with no queue url — presence of the url is the switch', () => {
    const q = createTurnQueue({});
    expect(q.enabled).toBe(false);
  });

  it('refuses to enqueue when disabled rather than pretending to succeed', async () => {
    const q = createTurnQueue({});
    await expect(q.enqueueTurn({ event: evt(), agent: 'a', sessionId: 's' })).rejects.toThrow(/not configured/);
  });

  it('sends with MessageGroupId = sessionId — the isolation mechanism', async () => {
    const { client, sent } = mkClient();
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.enqueueTurn({ event: evt(), agent: 'dm-u0x', sessionId: 'ac-slack-thread-C1-123' });
    expect(sent).toHaveLength(1);
    expect(sent[0].MessageGroupId).toBe('ac-slack-thread-C1-123');
    expect(sent[0].MessageDeduplicationId).toBe('cmi-abc-123');
    expect(sent[0].QueueUrl).toBe(QURL);
  });

  it('carries the RAW event, so the consumer resolves fresh context', async () => {
    // priorContext/userProfile are deliberately NOT baked in at enqueue: they would be stale by the
    // time the turn runs, which for a burst can be minutes.
    const { client, sent } = mkClient();
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.enqueueTurn({ event: evt(), agent: 'dm-u0x', sessionId: 's' });
    const body = JSON.parse(sent[0].MessageBody);
    expect(body).toEqual({ v: 1, agent: 'dm-u0x', event: evt() });
    expect(body.event.priorContext).toBeUndefined();
  });

  it('requires a sessionId — without it every thread would share one group', async () => {
    const { client } = mkClient();
    const q = createTurnQueue({ queueUrl: QURL, client });
    await expect(q.enqueueTurn({ event: evt(), agent: 'a' })).rejects.toThrow(/sessionId/);
  });

  it('THROWS on a send failure — the caller must tell the user', async () => {
    // Slack has already been acked by Bolt, so nothing else retries. A swallowed failure here is a
    // message that vanishes with no trace, which is the exact thing this queue exists to prevent.
    const { client } = mkClient({ failWith: new Error('AWS.SimpleQueueService.Unavailable') });
    const q = createTurnQueue({ queueUrl: QURL, client });
    await expect(q.enqueueTurn({ event: evt(), agent: 'a', sessionId: 's' })).rejects.toThrow(/Unavailable/);
  });

  it('rejects an oversized payload with a readable error, not an opaque SQS rejection', async () => {
    const { client } = mkClient();
    const q = createTurnQueue({ queueUrl: QURL, client });
    const huge = evt({ text: 'x'.repeat(300 * 1024) });
    await expect(q.enqueueTurn({ event: huge, agent: 'a', sessionId: 's' })).rejects.toThrow(/too large/);
  });

  it('emits the enqueued metric', async () => {
    const { client } = mkClient();
    const emitTurnEnqueued = vi.fn();
    const q = createTurnQueue({ queueUrl: QURL, client, metrics: { emitTurnEnqueued } });
    await q.enqueueTurn({ event: evt(), agent: 'dm-u0x', sessionId: 's1' });
    expect(emitTurnEnqueued).toHaveBeenCalledWith('dm-u0x', { sessionId: 's1' });
  });
});

// ── CONSUMER ─────────────────────────────────────────────────────────────────
function mkConsumerClient(messages = []) {
  const calls = { receive: 0, delete: [], visibility: [] };
  const queue = [...messages];
  return {
    calls,
    client: {
      send: async (cmd) => {
        const n = cmd.constructor?.name || cmd.__type;
        if (n === 'ReceiveMessageCommand') {
          calls.receive += 1;
          calls.lastReceiveInput = cmd.input;
          const m = queue.shift();
          return m ? { Messages: [m] } : {};
        }
        if (n === 'DeleteMessageCommand') { calls.delete.push(cmd.input.ReceiptHandle); return {}; }
        if (n === 'ChangeMessageVisibilityCommand') {
          calls.visibility.push({ handle: cmd.input.ReceiptHandle, timeout: cmd.input.VisibilityTimeout });
          return {};
        }
        throw new Error(`unexpected ${n}`);
      },
    },
  };
}

const msg = (over = {}) => ({
  MessageId: 'm1', ReceiptHandle: 'rh1',
  Body: JSON.stringify({ v: 1, agent: 'dm-u0x', event: evt() }),
  Attributes: { MessageGroupId: 'ac-thread-1', ApproximateReceiveCount: '1' },
  ...over,
});

describe('consumer: receiveOnce', () => {
  it('asks for exactly ONE message — batching would destroy per-thread isolation', async () => {
    // Spike-verified: MaxNumberOfMessages=10 returns a whole group at once. This is the single
    // setting that silently breaks the isolation the queue exists to provide.
    const { client, calls } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({ handler: async (_t, { markStarted }) => { await markStarted(); } });
    expect(calls.lastReceiveInput.MaxNumberOfMessages).toBe(1);
  });

  it('deletes when the handler marks the turn started (the commit point)', async () => {
    const { client, calls } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    const seen = [];
    await q.receiveOnce({
      handler: async (turn, { markStarted }) => { seen.push(turn.agent); await markStarted(); },
    });
    expect(seen).toEqual(['dm-u0x']);
    expect(calls.delete).toEqual(['rh1']);
    expect(calls.visibility).toEqual([]);
  });

  it('failing BEFORE the runtime starts RELEASES for retry', async () => {
    const { client, calls } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({ handler: async () => { throw new Error('ensureRuntime failed'); } });
    expect(calls.delete).toEqual([]);
    expect(calls.visibility).toHaveLength(1);       // returned for another attempt
  });

  it('failing AFTER the runtime starts does NOT retry — a retry would duplicate side effects', async () => {
    // Spike-verified: the runtime keeps executing when its consumer dies, so redelivery would run a
    // SECOND turn (a second memory write, a second tool call) rather than recover the first.
    const { client, calls } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({
      handler: async (_t, { markStarted }) => { await markStarted(); throw new Error('stream died mid-turn'); },
    });
    expect(calls.delete).toEqual(['rh1']);          // committed
    expect(calls.visibility).toEqual([]);           // NOT released
  });

  it('a turn that produced no SSE event is still committed — it RAN', async () => {
    // The safety net: an empty stream means the handler never called markStarted, but the turn did
    // execute. Redelivering it would run it twice.
    const { client, calls } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({ handler: async () => { /* completes, never marks */ } });
    expect(calls.delete).toEqual(['rh1']);
  });

  it('markStarted is idempotent — a double delete must not throw at the turn', async () => {
    const { client, calls } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({
      handler: async (_t, { markStarted }) => { await markStarted(); await markStarted(); await markStarted(); },
    });
    expect(calls.delete).toEqual(['rh1']);          // exactly one delete
  });

  it('an unparseable body is released toward the DLQ, not deleted', async () => {
    // Deleting would destroy the evidence of a bug we would then never see.
    const { client, calls } = mkConsumerClient([msg({ Body: 'not json{' })]);
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { error() {} } });
    const handler = vi.fn();
    await q.receiveOnce({ handler });
    expect(handler).not.toHaveBeenCalled();
    expect(calls.delete).toEqual([]);
    expect(calls.visibility).toHaveLength(1);
  });

  it('release backs off as receiveCount climbs, so a broken message cannot hot-loop', async () => {
    const { client, calls } = mkConsumerClient([msg({ Attributes: { MessageGroupId: 'g', ApproximateReceiveCount: '3' } })]);
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { warn() {} } });
    await q.receiveOnce({ handler: async () => { throw new Error('nope'); } });
    expect(calls.visibility[0].timeout).toBe(20);   // (3-1)*10
  });

  it('an empty long-poll returns false without calling the handler', async () => {
    const { client } = mkConsumerClient([]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    const handler = vi.fn();
    expect(await q.receiveOnce({ handler })).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('consumer: startConsumer', () => {
  it('is a no-op when disabled', async () => {
    const c = createTurnQueue({}).startConsumer({ handler: vi.fn() });
    await c.stop();
    expect(c.running).toBe(0);
  });

  it('runs N concurrent pollers and stops cleanly', async () => {
    const { client } = mkConsumerClient([]);
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { info() {}, warn() {} } });
    const c = q.startConsumer({ handler: vi.fn(), pollers: 3, waitTimeSeconds: 0, idleDelayMs: 5 });
    expect(c.pollers).toBe(3);
    await new Promise((r) => setTimeout(r, 20));
    await c.stop();
  });

  it('a receive failure does not kill the poller — capacity must not silently drain away', async () => {
    let n = 0;
    const client = { send: async () => { n += 1; if (n < 3) throw new Error('throttled'); return {}; } };
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { info() {}, warn() {} } });
    const c = q.startConsumer({ handler: vi.fn(), pollers: 1, waitTimeSeconds: 0, idleDelayMs: 5 });
    await new Promise((r) => setTimeout(r, 4500));
    await c.stop();
    expect(n).toBeGreaterThanOrEqual(3);            // kept polling past the failures
  }, 10000);
});

describe('consumer: the poller must not spin', () => {
  it('yields between empty polls — an immediately-returning receive must not starve timers', async () => {
    // Regression: without a yield, `while (!stopping) await receiveOnce()` against an instantly
    // resolving client never reaches the macrotask queue. It pins a core at 100% AND starves every
    // setTimeout in the process — including the one meant to stop it. The test hung forever.
    const client = { send: async () => ({}) };
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { info() {}, warn() {} } });
    const c = q.startConsumer({ handler: vi.fn(), pollers: 1, waitTimeSeconds: 0, idleDelayMs: 5 });
    let timerFired = false;
    await new Promise((r) => setTimeout(() => { timerFired = true; r(); }, 50));
    await c.stop();
    expect(timerFired).toBe(true);   // a timer got a turn: the loop is not starving the event loop
  }, 5000);
});

describe('enqueue ordering', () => {
  // Live-caught: a 25-message burst returned every message, none duplicated, but in the order
  // 6, 5, 1, 3, 14, 2 … SQS FIFO preserves the order sends REACH it, and SendMessage is async, so
  // concurrent Bolt handlers could race. Durability was right; ordering was not.
  const slowFirstClient = () => {
    const order = [];
    let n = 0;
    return {
      order,
      client: {
        send: async (cmd) => {
          n += 1;
          const mine = n;
          // First send is slow: without a chain, later sends overtake it.
          await new Promise((r) => setTimeout(r, mine === 1 ? 60 : 1));
          order.push(JSON.parse(cmd.input.MessageBody).event.text);
          return { MessageId: `m${mine}` };
        },
      },
    };
  };

  it('sends for ONE group reach SQS in arrival order even when handlers overlap', async () => {
    const { client, order } = slowFirstClient();
    const q = createTurnQueue({ queueUrl: QURL, client });
    await Promise.all(['a', 'b', 'c'].map((t, i) => q.enqueueTurn({
      event: evt({ text: t, client_msg_id: `c${i}` }), agent: 'x', sessionId: 'same-thread',
    })));
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('does NOT serialise across different threads — one slow thread must not block others', async () => {
    const { client, order } = slowFirstClient();
    const q = createTurnQueue({ queueUrl: QURL, client });
    await Promise.all([
      q.enqueueTurn({ event: evt({ text: 'slow-thread', client_msg_id: 'x1' }), agent: 'x', sessionId: 'thread-A' }),
      q.enqueueTurn({ event: evt({ text: 'fast-thread', client_msg_id: 'x2' }), agent: 'x', sessionId: 'thread-B' }),
    ]);
    expect(order).toEqual(['fast-thread', 'slow-thread']);   // B overtook A: independent threads
  });

  it('a failed send does not strand the rest of the thread', async () => {
    let n = 0;
    const order = [];
    const client = { send: async (cmd) => {
      n += 1;
      if (n === 1) throw new Error('transient');
      order.push(JSON.parse(cmd.input.MessageBody).event.text);
      return { MessageId: `m${n}` };
    } };
    const q = createTurnQueue({ queueUrl: QURL, client });
    const rs = await Promise.allSettled(['a', 'b'].map((t, i) => q.enqueueTurn({
      event: evt({ text: t, client_msg_id: `f${i}` }), agent: 'x', sessionId: 'same',
    })));
    expect(rs[0].status).toBe('rejected');
    expect(rs[1].status).toBe('fulfilled');
    expect(order).toEqual(['b']);
  });
});

describe('pre-start heartbeat', () => {
  // Live-caught: with a fixed 600s visibility, killing the task mid-turn blocked the WHOLE thread for
  // exactly 600s (resumed 03:26:27 after a 03:16:26 kill) while a healthy replacement sat idle. The
  // receive→first-event window includes a 30-50s cold boot, so it must be covered by a renewable
  // lease, not a long fixed one.
  const mk = (messages) => {
    const calls = { visibility: [], delete: [] };
    const queue = [...messages];
    return {
      calls,
      client: {
        send: async (cmd) => {
          const n = cmd.constructor?.name;
          if (n === 'ReceiveMessageCommand') { const m = queue.shift(); return m ? { Messages: [m] } : {}; }
          if (n === 'DeleteMessageCommand') { calls.delete.push(cmd.input.ReceiptHandle); return {}; }
          if (n === 'ChangeMessageVisibilityCommand') { calls.visibility.push(cmd.input.VisibilityTimeout); return {}; }
          throw new Error(`unexpected ${n}`);
        },
      },
    };
  };

  it('renews the lease while a slow turn is still starting (cold boot)', async () => {
    const { client, calls } = mk([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({
      heartbeatMs: 20, leaseSeconds: 60,
      // A 120ms "cold boot" before the first SSE event: several heartbeats must fire.
      handler: async (_t, { markStarted }) => {
        await new Promise((r) => setTimeout(r, 120));
        await markStarted();
      },
    });
    const renewals = calls.visibility.filter((v) => v === 60);
    expect(renewals.length).toBeGreaterThanOrEqual(3);
    expect(calls.delete).toEqual(['rh1']);
  });

  it('STOPS renewing once the turn is committed — the message is gone, nothing to renew', async () => {
    const { client, calls } = mk([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    await q.receiveOnce({
      heartbeatMs: 15, leaseSeconds: 60,
      handler: async (_t, { markStarted }) => { await markStarted(); await new Promise((r) => setTimeout(r, 120)); },
    });
    const after = calls.visibility.filter((v) => v === 60).length;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.visibility.filter((v) => v === 60).length).toBe(after);   // no further renewals
  });

  it('stops renewing when the turn fails before starting (so the release actually takes effect)', async () => {
    const { client, calls } = mk([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { warn() {} } });
    await q.receiveOnce({
      heartbeatMs: 15, leaseSeconds: 60,
      handler: async () => { await new Promise((r) => setTimeout(r, 40)); throw new Error('cold boot failed'); },
    });
    const n = calls.visibility.length;
    await new Promise((r) => setTimeout(r, 80));
    expect(calls.visibility.length).toBe(n);
    expect(calls.visibility[calls.visibility.length - 1]).toBe(0);   // released for immediate retry
  });
});

// Poller occupancy — the saturation signal. TURN_QUEUE_POLLERS is the cap on concurrent turns and a
// poller is held for the WHOLE turn (provisioning included), so occupancy is what says "the pool is
// starving other agents". These pin the two ways the gauge could lie.
describe('consumer: poller occupancy', () => {
  it('counts a poller busy only while a turn is being processed, not while long-polling', async () => {
    const { client } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    expect(q.pollerStats().busy).toBe(0);            // idle before
    let seen = -1;
    await q.receiveOnce({
      handler: async (_t, { markStarted }) => { seen = q.pollerStats().busy; await markStarted(); },
    });
    expect(seen).toBe(1);                            // busy DURING the turn
    expect(q.pollerStats().busy).toBe(0);            // released after
  });

  it('releases the slot when the message is unparseable — the early-return path must not leak', async () => {
    // A leaked counter never comes back down, so the gauge would climb monotonically and wedge the
    // saturation alarm in ALARM forever. This path returns before the turn's own try/finally.
    const { client } = mkConsumerClient([msg({ Body: 'not-json' })]);
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { error() {} } });
    await q.receiveOnce({ handler: async () => { throw new Error('must not be called'); } });
    expect(q.pollerStats().busy).toBe(0);
  });

  it('releases the slot when the turn throws', async () => {
    const { client } = mkConsumerClient([msg()]);
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { warn() {}, error() {} } });
    await q.receiveOnce({ handler: async () => { throw new Error('turn blew up'); } });
    expect(q.pollerStats().busy).toBe(0);
  });

  it('publishes the gauge with the pool size so an occupancy number can be read against its cap', async () => {
    const samples = [];
    const { client } = mkConsumerClient([]);
    const q = createTurnQueue({
      queueUrl: QURL, client, metrics: { emitPollerSaturation: (s) => samples.push(s) },
    });
    // Emitted once immediately, so PollersTotal exists before the first interval elapses.
    const c = q.startConsumer({ handler: async () => {}, pollers: 7, waitTimeSeconds: 0, sampleMs: 10 });
    // busy/total are the gauge's contract: occupancy, and the ceiling to read it against. With no
    // maxInflight given, the ceiling is still the poller count — the pre-hand-off behaviour.
    expect(samples[0]).toMatchObject({ busy: 0, total: 7 });
    await new Promise((r) => setTimeout(r, 40));
    expect(samples.length).toBeGreaterThan(1);       // and keeps sampling on the timer
    await c.stop();
  });

  // ── Hand-off (provisioning-queue-plan.md, Phase 1) ──────────────────────────────────────────
  //
  // The property that matters: a poller no longer blocks for the whole turn, so in-flight work can
  // exceed the poller count. Spike-verified against real SQS for ordering; verified here for the
  // bound and for permit accounting, which is where a leak would silently shrink capacity to zero.

  it('lets in-flight turns EXCEED the poller count — the decoupling', async () => {
    const held = [];
    let peak = 0;
    let live = 0;
    const { client } = mkConsumerClient(Array.from({ length: 6 }, (_, i) => msg({ ReceiptHandle: `rh${i}` })));
    const q = createTurnQueue({ queueUrl: QURL, client });
    const c = q.startConsumer({
      pollers: 2, maxInflight: 6, waitTimeSeconds: 0, idleDelayMs: 1,
      handler: async (_t, { markStarted }) => {
        live += 1; peak = Math.max(peak, live);
        await markStarted();
        await new Promise((r) => { held.push(r); });
        live -= 1;
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    // With one-message-per-poller this could never exceed 2.
    expect(peak).toBeGreaterThan(2);
    held.forEach((r) => r());
    await c.stop();
  });

  it('never exceeds maxInflight, and applies backpressure by not receiving', async () => {
    let live = 0;
    let peak = 0;
    // ONE shared gate, not one deferred per turn: releasing per-turn deferreds lets the next batch in,
    // which blocks on deferreds nobody resolves, and stop() then waits forever (it drains in-flight
    // turns now). Resolving a single gate unblocks everything already waiting AND everything after.
    let openGate;
    const gate = new Promise((r) => { openGate = r; });
    const { client, calls } = mkConsumerClient(Array.from({ length: 12 }, (_, i) => msg({ ReceiptHandle: `rh${i}` })));
    const q = createTurnQueue({ queueUrl: QURL, client });
    const c = q.startConsumer({
      pollers: 8, maxInflight: 3, waitTimeSeconds: 0, idleDelayMs: 1,
      handler: async (_t, { markStarted }) => {
        live += 1; peak = Math.max(peak, live);
        await markStarted();
        await gate;
        live -= 1;
      },
    });
    await new Promise((r) => setTimeout(r, 120));
    expect(peak).toBe(3);
    // Backpressure means the messages were left ON THE QUEUE, not received and buffered locally —
    // receiving them would have started their visibility clocks and blocked their message groups.
    expect(calls.receive).toBeLessThanOrEqual(4);
    openGate();
    await c.stop();
  });

  it('returns the in-flight permit when a turn throws, so capacity is not leaked', async () => {
    let attempts = 0;
    const { client } = mkConsumerClient(Array.from({ length: 5 }, (_, i) => msg({ ReceiptHandle: `rh${i}` })));
    const q = createTurnQueue({ queueUrl: QURL, client, logger: { warn: () => {}, error: () => {} } });
    const c = q.startConsumer({
      pollers: 1, maxInflight: 1, waitTimeSeconds: 0, idleDelayMs: 1,
      handler: async () => { attempts += 1; throw new Error('turn exploded'); },
    });
    await new Promise((r) => setTimeout(r, 120));
    // A leaked permit would wedge the single slot forever and stop at exactly 1.
    expect(attempts).toBeGreaterThan(1);
    expect(q.pollerStats().busy).toBe(0);
    await c.stop();
  });

  it('drains handed-off turns on stop rather than abandoning them', async () => {
    let finished = 0;
    const { client } = mkConsumerClient([msg({ ReceiptHandle: 'rh0' })]);
    const q = createTurnQueue({ queueUrl: QURL, client });
    const c = q.startConsumer({
      pollers: 1, maxInflight: 2, waitTimeSeconds: 0, idleDelayMs: 1,
      handler: async (_t, { markStarted }) => {
        await markStarted();
        await new Promise((r) => setTimeout(r, 60));
        finished += 1;
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    await c.stop();
    expect(finished).toBe(1);           // stop() waited for the handed-off turn
    expect(q.pollerStats().busy).toBe(0);
  });

  it('reports the ceiling as maxInflight, NOT the poller count, once they differ', async () => {
    const samples = [];
    const { client } = mkConsumerClient([]);
    const q = createTurnQueue({
      queueUrl: QURL, client, metrics: { emitPollerSaturation: (s) => samples.push(s) },
    });
    const c = q.startConsumer({
      handler: async () => {}, pollers: 4, maxInflight: 30, waitTimeSeconds: 0, sampleMs: 10,
    });
    expect(c.maxInflight).toBe(30);
    expect(samples[0]).toMatchObject({ busy: 0, total: 30, pollers: 4, waiting: 0 });
    await c.stop();
  });
});

'use strict';

const { StreamingManager } = require('./streaming');

function createSlackMock({ startDelay = 0, appendDelay = 0, stopDelay = 0 } = {}) {
  const calls = [];
  let tsCounter = 0;

  return {
    calls,
    chat: {
      startStream: async (args) => {
        calls.push({ method: 'startStream', args: { ...args } });
        if (startDelay) await new Promise((r) => setTimeout(r, startDelay));
        const ts = `stream-${++tsCounter}`;
        return { ok: true, ts };
      },
      appendStream: async (args) => {
        calls.push({ method: 'appendStream', args: { ...args } });
        if (appendDelay) await new Promise((r) => setTimeout(r, appendDelay));
        return { ok: true };
      },
      stopStream: async (args) => {
        calls.push({ method: 'stopStream', args: { ...args } });
        if (stopDelay) await new Promise((r) => setTimeout(r, stopDelay));
        return { ok: true };
      },
      postMessage: async (args) => {
        calls.push({ method: 'postMessage', args: { ...args } });
        return { ok: true, ts: `msg-${++tsCounter}` };
      },
    },
  };
}

function createManager(slackMock, opts = {}) {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => log,
  };
  return new StreamingManager({ slack: slackMock, log, updateIntervalMs: opts.updateIntervalMs ?? 0 });
}

describe('StreamingManager', () => {
  describe('session lifecycle', () => {
    it('registers a new session and returns a traceId', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      const traceId = mgr.registerSession('sess-1', { channel: 'C1', threadTs: '1.0', userId: 'U1' });
      expect(traceId).toBeTruthy();
      expect(mgr.hasSession('sess-1')).toBe(true);
      mgr.destroy();
    });

    it('refreshes an existing session and returns a new traceId', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      const t1 = mgr.registerSession('sess-1', { channel: 'C1', threadTs: '1.0' });
      const t2 = mgr.registerSession('sess-1', { channel: 'C1', threadTs: '1.0' });
      expect(t1).not.toBe(t2);
      expect(mgr.sessionCount).toBe(1);
      mgr.destroy();
    });

    it('finds session by exact key', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('slack:thread:dm:C1:U1', { channel: 'C1', threadTs: '1.0' });
      const found = mgr.findSession('slack:thread:dm:C1:U1');
      expect(found).toBeTruthy();
      expect(found.matchedKey).toBe('slack:thread:dm:C1:U1');
      mgr.destroy();
    });

    it('finds session by gateway-prefixed key (case-insensitive)', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('slack:thread:dm:C1:U1', { channel: 'C1', threadTs: '1.0' });
      const found = mgr.findSession('agent:myagent:slack:thread:dm:C1:U1');
      expect(found).toBeTruthy();
      expect(found.matchedKey).toBe('slack:thread:dm:C1:U1');
      mgr.destroy();
    });

    it('finds session by thread ID fallback', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('slack:thread:C1:1234.5678:dm:U1', { channel: 'C1', threadTs: '1234.5678' });
      const found = mgr.findSession('agent:myagent:slack:thread:C1:1234.5678:dm:U2');
      expect(found).toBeTruthy();
      mgr.destroy();
    });

    it('returns null when no session matches', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      expect(mgr.findSession('nonexistent')).toBeNull();
      mgr.destroy();
    });
  });

  describe('stream control', () => {
    it('startStream sends a plan_update chunk via startStream API', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      expect(slack.calls).toHaveLength(1);
      expect(slack.calls[0].method).toBe('startStream');
      expect(slack.calls[0].args.chunks).toEqual([{ type: 'plan_update', title: 'Securing the mast' }]);
      mgr.destroy();
    });

    it('handleDelta appends incremental text', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      const run = mgr.getOrCreateRun(session, 'run-1');
      mgr.handleDelta(run, session, 'Hello');
      await session.stream.chain;

      mgr.handleDelta(run, session, 'Hello world');
      await session.stream.chain;

      expect(slack.calls[1].method).toBe('appendStream');
      expect(slack.calls[1].args.chunks).toEqual([{ type: 'markdown_text', text: 'Hello' }]);
      expect(slack.calls[2].method).toBe('appendStream');
      expect(slack.calls[2].args.chunks).toEqual([{ type: 'markdown_text', text: ' world' }]);
      mgr.destroy();
    });

    it('handleDelta ignores duplicate text', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      const run = mgr.getOrCreateRun(session, 'run-1');
      mgr.handleDelta(run, session, 'Hello');
      mgr.handleDelta(run, session, 'Hello');
      await session.stream.chain;

      const appends = slack.calls.filter((c) => c.method === 'appendStream');
      expect(appends).toHaveLength(1);
      mgr.destroy();
    });

    it('stopStream appends Done + calls stopStream API', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      await mgr.stopStream(session, 'Final text');

      const methods = slack.calls.map((c) => c.method);
      expect(methods).toEqual(['startStream', 'appendStream', 'stopStream']);
      expect(slack.calls[1].args.chunks).toEqual([{ type: 'plan_update', title: 'Anchors aweigh' }]);
      mgr.destroy();
    });

    it('stopStream flushes remainingDelta before Done', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      await mgr.stopStream(session, 'Full text', { remainingDelta: ' leftover' });

      const methods = slack.calls.map((c) => c.method);
      expect(methods).toEqual(['startStream', 'appendStream', 'appendStream', 'stopStream']);
      expect(slack.calls[1].args.chunks).toEqual([{ type: 'markdown_text', text: ' leftover' }]);
      expect(slack.calls[2].args.chunks).toEqual([{ type: 'plan_update', title: 'Anchors aweigh' }]);
      mgr.destroy();
    });

    it('stopStream falls back to postMessage when no active stream', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      await mgr.stopStream(session, 'Fallback text');

      expect(slack.calls).toHaveLength(1);
      expect(slack.calls[0].method).toBe('postMessage');
      expect(slack.calls[0].args.text).toBe('Fallback text');
      mgr.destroy();
    });

    it('stopped stream rejects late appends', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      await mgr.stopStream(session, 'Final');

      const run = mgr.getOrCreateRun(session, 'run-late');
      mgr.handleDelta(run, session, 'Late text');

      const appends = slack.calls.filter((c) =>
        c.method === 'appendStream' && c.args.chunks?.[0]?.type === 'markdown_text'
      );
      expect(appends).toHaveLength(0);
      mgr.destroy();
    });
  });

  describe('task updates', () => {
    it('sends task_update chunk', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      mgr.handleTask(session, 'tool-1', 'Read file', 'in_progress');
      await session.stream.chain;

      const taskCalls = slack.calls.filter((c) =>
        c.method === 'appendStream' && c.args.chunks?.[0]?.type === 'task_update'
      );
      expect(taskCalls).toHaveLength(1);
      expect(taskCalls[0].args.chunks[0]).toEqual({
        type: 'task_update', id: 'tool-1', title: 'Read file', status: 'in_progress',
      });
      mgr.destroy();
    });

    it('deduplicates task_update when status unchanged', async () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);
      await session.stream.chain;

      mgr.handleTask(session, 'tool-1', 'Read file', 'in_progress');
      mgr.handleTask(session, 'tool-1', 'Read file', 'in_progress');
      mgr.handleTask(session, 'tool-1', 'Read file', 'complete');
      await session.stream.chain;

      const taskCalls = slack.calls.filter((c) =>
        c.method === 'appendStream' && c.args.chunks?.[0]?.type === 'task_update'
      );
      expect(taskCalls).toHaveLength(2);
      mgr.destroy();
    });
  });

  describe('run lifecycle', () => {
    it('creates and finalizes runs', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      const run = mgr.getOrCreateRun(session, 'run-1');
      expect(run.lastText).toBe('');
      expect(session.runs.size).toBe(1);

      mgr.finalizeRun(session, 'run-1');
      expect(session.runs.size).toBe(0);
      mgr.destroy();
    });

    it('clearAllRuns removes all runs', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.getOrCreateRun(session, 'run-1');
      mgr.getOrCreateRun(session, 'run-2');
      expect(session.runs.size).toBe(2);

      mgr.clearAllRuns(session, 'test');
      expect(session.runs.size).toBe(0);
      mgr.destroy();
    });
  });

  describe('race conditions', () => {
    it('serializes concurrent appends through the chain', async () => {
      const slack = createSlackMock({ startDelay: 50 });
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);

      const run = mgr.getOrCreateRun(session, 'run-1');
      mgr.handleDelta(run, session, 'Hello');
      mgr.handleDelta(run, session, 'Hello world');
      mgr.handleDelta(run, session, 'Hello world!');

      await session.stream.chain;

      expect(slack.calls[0].method).toBe('startStream');
      const appends = slack.calls.filter((c) => c.method === 'appendStream');
      expect(appends).toHaveLength(3);
      expect(appends.map((c) => c.args.chunks[0].text)).toEqual(['Hello', ' world', '!']);
      mgr.destroy();
    });

    it('stopStream with remainingDelta works even when startStream is in-flight', async () => {
      const slack = createSlackMock({ startDelay: 100 });
      const mgr = createManager(slack, { updateIntervalMs: 0 });
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      const { session } = mgr.findSession('s1');

      mgr.startStream(session);

      const run = mgr.getOrCreateRun(session, 'run-1');
      mgr.handleDelta(run, session, 'Partial');

      await new Promise((r) => setTimeout(r, 20));

      await mgr.stopStream(session, 'Partial complete', { remainingDelta: ' complete' });

      const methods = slack.calls.map((c) => c.method);
      expect(methods[0]).toBe('startStream');
      // stopStream chains its own work (remainingDelta append + Done append + stop)
      // but streamAppend calls before stopStream are blocked by s.stopped.
      // The stop work runs inside the chain so all appends land in order.
      expect(methods).toContain('stopStream');
      // The Done plan_update must always be the last appendStream before stopStream
      const stopIdx = methods.lastIndexOf('stopStream');
      const beforeStop = slack.calls[stopIdx - 1];
      expect(beforeStop.method).toBe('appendStream');
      expect(beforeStop.args.chunks[0]).toEqual({ type: 'plan_update', title: 'Anchors aweigh' });
      mgr.destroy();
    });
  });

  describe('diagnostics', () => {
    it('debugSnapshot returns session info', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      const traceId = mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0', userId: 'U1' });
      mgr.getOrCreateRun(mgr.findSession('s1').session, 'run-1');

      const snap = mgr.debugSnapshot();
      expect(snap.s1).toBeTruthy();
      expect(snap.s1.traceId).toBe(traceId);
      expect(snap.s1.channel).toBe('C1');
      expect(snap.s1.activeRuns).toBe(1);
      expect(snap.s1.runIds).toEqual(['run-1']);
      mgr.destroy();
    });

    it('sessionCount tracks active sessions', () => {
      const slack = createSlackMock();
      const mgr = createManager(slack);
      expect(mgr.sessionCount).toBe(0);
      mgr.registerSession('s1', { channel: 'C1', threadTs: '1.0' });
      expect(mgr.sessionCount).toBe(1);
      mgr.registerSession('s2', { channel: 'C2', threadTs: '2.0' });
      expect(mgr.sessionCount).toBe(2);
      mgr.destroy();
    });
  });
});

// ── TURN BOUNDARY (drain) ─────────────────────────────────────────────────────
//
// Live regression 2026-08-10: with turns serialised, every reply arrived in TWO pieces — a tail
// fragment in one bubble and the body in another, alternating with empty bubbles.
//
// Cause: Slack writes are serialised onto session.stream.chain, and the schedulers return that chain
// WITHOUT awaiting (they run from a synchronous SSE callback). A turn that returned with its stop
// still queued released the session slot; the next turn's startStream then reset s.ts and posted a
// fresh placeholder, and the previous turn's queued stop read the NEW s.ts and wrote its remaining
// text into the next turn's bubble before closing it.
describe('StreamingManager#drain — the turn boundary', () => {
  const setup = () => {
    const slack = createSlackMock({ startDelay: 5, appendDelay: 5, stopDelay: 5 });
    const mgr = createManager(slack);
    mgr.registerSession('s', { channel: 'C', threadTs: '1.0', userId: 'U' });
    return { slack, mgr, session: mgr.findSession('s').session };
  };

  it('drain waits for queued Slack writes to land', async () => {
    const { slack, mgr, session } = setup();
    mgr.startStream(session);
    mgr.stopStream(session, 'the whole answer');
    // Before draining the work is still queued — nothing has reached Slack.
    expect(slack.calls.filter((c) => c.method === 'stopStream')).toHaveLength(0);

    await mgr.drain(session);

    expect(slack.calls.filter((c) => c.method === 'stopStream')).toHaveLength(1);
    mgr.destroy();
  });

  it("turn N's final text NEVER lands in turn N+1's stream", async () => {
    const { slack, mgr, session } = setup();

    // Turn N: stream a reply and stop it — then DRAIN, as the turn boundary now does.
    mgr.startStream(session);
    mgr.stopStream(session, 'answer one', { remainingDelta: ' …tail of one' });
    await mgr.drain(session);

    const tsAfterTurnN = slack.calls.filter((c) => c.method === 'startStream').length;

    // Turn N+1: a fresh placeholder for the next message.
    mgr.startStream(session);
    mgr.stopStream(session, 'answer two');
    await mgr.drain(session);

    const streams = slack.calls.filter((c) => c.method === 'startStream');
    expect(streams).toHaveLength(tsAfterTurnN + 1);   // exactly one new stream for turn N+1

    // The decisive assertion: turn N's tail was appended to turn N's stream, not turn N+1's.
    const tailAppend = slack.calls.find((c) => c.method === 'appendStream'
      && JSON.stringify(c.args.chunks).includes('tail of one'));
    expect(tailAppend).toBeTruthy();
    expect(tailAppend.args.ts).toBe('stream-1');      // NOT stream-2
    mgr.destroy();
  });

  it('each turn produces exactly ONE stream when the boundary drains', async () => {
    const { slack, mgr, session } = setup();
    for (let turn = 1; turn <= 4; turn += 1) {
      mgr.startStream(session);
      mgr._streamText(session, `reply ${turn}`);
      mgr.stopStream(session, `reply ${turn}`);
      await mgr.drain(session);
    }
    // 4 turns -> 4 streams. Pre-fix this produced a stream per turn PLUS a dangling extra.
    expect(slack.calls.filter((c) => c.method === 'startStream')).toHaveLength(4);
    expect(slack.calls.filter((c) => c.method === 'stopStream')).toHaveLength(4);
    mgr.destroy();
  });

  it('drain on a session with no stream is a no-op, not a throw', async () => {
    const slack = createSlackMock();
    const mgr = createManager(slack);
    mgr.registerSession('s2', { channel: 'C', threadTs: '2.0' });
    await expect(mgr.drain(mgr.findSession('s2').session)).resolves.toBeUndefined();
    await expect(mgr.drain(null)).resolves.toBeUndefined();
    mgr.destroy();
  });

  it('drain settles even when a Slack write rejects', async () => {
    const slack = createSlackMock();
    slack.chat.stopStream = async () => { throw new Error('slack down'); };
    const mgr = createManager(slack);
    mgr.registerSession('s3', { channel: 'C', threadTs: '3.0' });
    const session = mgr.findSession('s3').session;
    mgr.startStream(session);
    mgr.stopStream(session, 'text');
    await expect(mgr.drain(session)).resolves.toBeUndefined();
    mgr.destroy();
  });
});

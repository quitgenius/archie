'use strict';

const { StreamingManager } = require('./streaming');
const rejected = (code) => Object.assign(new Error(code), { data: { error: code } });

describe('expired Slack stream delivery', () => {
  let manager, slack, session, run;
  beforeEach(() => {
    vi.useFakeTimers();
    slack = {
      chat: {
        startStream: vi.fn().mockResolvedValue({ ok: true, ts: 'original' }),
        appendStream: vi.fn().mockResolvedValue({ ok: true }),
        stopStream: vi.fn().mockResolvedValue({ ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: 'fallback' }),
      },
      assistant: { threads: { setStatus: vi.fn().mockResolvedValue({ ok: true }) } },
    };
    manager = new StreamingManager({ slack, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, updateIntervalMs: 1500 });
    manager.registerSession('thread', { channel: 'D1', threadTs: '1.0', userId: 'U1', isDM: true });
    session = manager.findSession('thread').session;
    manager.startStream(session);
    run = manager.getOrCreateRun(session, 'run');
  });
  afterEach(() => { manager.destroy(); vi.useRealTimers(); });
  async function text(value) {
    manager.handleDelta(run, session, value);
    await session.stream.chain;
  }
  async function expire() {
    await text('Hello');
    slack.chat.appendStream.mockRejectedValue(rejected('message_not_in_streaming_state'));
    await text('Hello world');
  }

  it('recovers the acknowledged prefix and rejected tail on the same message', async () => {
    await expire();
    expect(slack.chat.update).toHaveBeenCalledWith(expect.objectContaining({ ts: 'original', text: 'Hello world' }));
    await text('Hello world!');
    await vi.advanceTimersByTimeAsync(1500);
    expect(slack.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: 'original', text: 'Hello world!' }));
    expect(slack.chat.appendStream).toHaveBeenCalledTimes(1);
    expect(slack.chat.startStream).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('coalesces rapid deltas and immediately flushes authoritative final text', async () => {
    await expire();
    for (const suffix of ['1', '12', '123']) await text(`Hello world${suffix}`);
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    await manager.stopStream(session, 'A rewritten final answer');
    expect(slack.chat.update).toHaveBeenCalledTimes(2);
    expect(slack.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'A rewritten final answer' }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(slack.chat.update).toHaveBeenCalledTimes(2);
    expect(slack.chat.stopStream).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it.each(['append', 'stop'])('recovers expiry first encountered during final %s', async (where) => {
    await text('Hello');
    slack.chat[where === 'append' ? 'appendStream' : 'stopStream'].mockRejectedValue(rejected('message_not_in_streaming_state'));
    await manager.stopStream(session, 'Hello complete', { remainingDelta: ' complete' });
    expect(slack.chat.update).toHaveBeenLastCalledWith(expect.objectContaining({ ts: 'original', text: 'Hello complete' }));
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('keeps internal tool progress out of the recovered answer', async () => {
    await expire();
    manager.handleTask(session, 'tool', 'Query database', 'in_progress', 'Fetching results');
    await session.stream.chain;
    await vi.advanceTimersByTimeAsync(1500);
    expect(slack.chat.update.mock.lastCall[0].text).toBe('Hello world');
    manager.handleTask(session, 'tool', 'Query database', 'complete');
    await session.stream.chain;
    await vi.advanceTimersByTimeAsync(1500);
    expect(slack.chat.update.mock.lastCall[0].text).toBe('Hello world');
    expect(slack.chat.update.mock.lastCall[0].text).not.toContain('in_progress');
  });

  it.each(['append', 'stop'])('does not recover or post after a user stops the %s', async (where) => {
    await text('Hello');
    slack.chat[where === 'append' ? 'appendStream' : 'stopStream'].mockRejectedValue(rejected('stopped_by_user'));
    if (where === 'append') await text('Hello world');
    await manager.stopStream(session, 'Hello world');
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('does not misclassify an unrelated append failure as expiry', async () => {
    await text('Hello');
    slack.chat.appendStream.mockRejectedValue(rejected('ratelimited'));
    await text('Hello world');
    expect(slack.chat.update).not.toHaveBeenCalled();
  });

  it('posts the final answer once when workspace restrictions prevent editing', async () => {
    slack.chat.update.mockRejectedValue(rejected('edit_window_closed'));
    await expire();
    await text('Hello world!');
    await manager.stopStream(session, 'Hello world!');
    await manager.stopStream(session, 'Hello world!');
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'D1', thread_ts: '1.0', text: 'Hello world!' });
  });

  it('retries a transient edit failure at finalization without posting a duplicate', async () => {
    slack.chat.update.mockRejectedValueOnce(rejected('internal_error'));
    await expire();
    await manager.stopStream(session, 'Hello world');
    expect(slack.chat.update).toHaveBeenCalledTimes(2);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('delivers large answers across bounded messages without losing or duplicating text', async () => {
    await expire();
    const final = 'x'.repeat(35999) + '😀' + 'y'.repeat(40000);
    await manager.stopStream(session, final);
    const first = slack.chat.update.mock.lastCall[0];
    const tails = slack.chat.postMessage.mock.calls.map(([args]) => args.text);
    expect(first.text + tails.join('')).toBe(final);
    expect([first.text, ...tails].every((part) => part.length <= 36000)).toBe(true);
    expect(first.blocks).toEqual([]);
    expect(first.text.endsWith('\ud83d')).toBe(false);
  });

  it('preserves a long code fence in the final message without splitting its formatting', async () => {
    await expire();
    const final = '```javascript\n' + 'const value = 1;\n'.repeat(300) + '```';
    await manager.stopStream(session, final);
    expect(slack.chat.update.mock.lastCall[0]).toMatchObject({ text: final, blocks: [] });
  });

  it('delivers a long final answer even if a native stream never started', async () => {
    const final = 'z'.repeat(40001);
    await manager.stopStream(session, final);
    expect(slack.chat.postMessage.mock.calls.map(([args]) => args.text).join('')).toBe(final);
    expect(slack.chat.postMessage.mock.calls.every(([args]) => args.text.length <= 36000)).toBe(true);
  });

  it('does not let queued recovery writes touch the next turn', async () => {
    await expire();
    await text('Hello world pending');
    const stopped = manager.stopStream(session, 'First final');
    slack.chat.startStream.mockResolvedValue({ ok: true, ts: 'second' });
    manager.startStream(session);
    const second = manager.getOrCreateRun(session, 'second');
    manager.handleDelta(second, session, 'Second answer');
    await session.stream.chain;
    await stopped;
    await vi.advanceTimersByTimeAsync(3000);
    expect(slack.chat.update.mock.calls.every(([args]) => args.ts === 'original')).toBe(true);
    expect(slack.chat.startStream.mock.lastCall[0].chunks).toContainEqual({ type: 'markdown_text', text: 'Second answer' });
  });

  it('cancels pending recovery updates on destroy', async () => {
    await expire();
    await text('Hello world pending');
    manager.destroy();
    await vi.advanceTimersByTimeAsync(3000);
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
  });
});

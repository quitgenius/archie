'use strict';

// vitest globals enabled via vitest.config.js
const { createDeliver } = require('./cron-delivery');

const job = (delivery) => ({ agentId: 'agentA', jobId: 'digest', delivery });

describe('cron delivery', () => {
  it('none: does nothing', async () => {
    const slack = { chat: { postMessage: vi.fn() } };
    const { deliver } = createDeliver({ slack });
    const r = await deliver(job({ mode: 'none' }), { text: 'hi' });
    expect(r).toEqual({ delivered: false, reason: 'none' });
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('defaults to none when delivery is absent', async () => {
    const slack = { chat: { postMessage: vi.fn() } };
    const { deliver } = createDeliver({ slack });
    const r = await deliver({ agentId: 'a', jobId: 'j' }, { text: 'hi' });
    expect(r.delivered).toBe(false);
  });

  it('announce: posts the final text to the channel', async () => {
    const slack = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
    const { deliver } = createDeliver({ slack });
    const r = await deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: 'the digest' });
    expect(r).toEqual({ delivered: true, mode: 'announce' });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'C0ABC123XYZ', text: 'the digest' });
  });

  // §12c CORRECTION: `to` is the DESTINATION upstream, not the thread — the thread is `threadId`.
  // This previously asserted `to` -> thread_ts, encoding our own misreading: the same misreading
  // that made a valid {announce, to:'U…'} job post with channel:undefined on every fire.
  it('announce: threads on `threadId` (NOT on `to`)', async () => {
    const slack = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
    await createDeliver({ slack }).deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ', threadId: '1712.5' }), { text: 'x' });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'C0ABC123XYZ', thread_ts: '1712.5', text: 'x' });
  });

  it('announce: `to` as a USER id opens the DM and posts there (17 enabled prod jobs)', async () => {
    const slack = {
      chat: { postMessage: vi.fn(async () => ({ ok: true })) },
      conversations: { open: vi.fn(async () => ({ channel: { id: 'DL1HA3II6V6' } })) },
    };
    const d = createDeliver({ slack });
    await d.deliver(job({ mode: 'announce', to: 'UX0MZ5CKP2R' }), { text: 'x' });
    expect(slack.conversations.open).toHaveBeenCalledWith({ users: 'UX0MZ5CKP2R' });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'DL1HA3II6V6', text: 'x' });
    await d.deliver(job({ mode: 'announce', to: 'UX0MZ5CKP2R' }), { text: 'y' });
    expect(slack.conversations.open).toHaveBeenCalledTimes(1); // cached
  });

  it('announce: a TRANSPORT name in `channel` is not a destination — `to` wins', async () => {
    const slack = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
    await createDeliver({ slack }).deliver(job({ mode: 'announce', channel: 'slack', to: 'CZ3E1122Y3K' }), { text: 'x' });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'CZ3E1122Y3K', text: 'x' });
  });

  it('announce: falls back to the ambient session key when nothing explicit is set', async () => {
    const slack = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
    const j = { agentId: 'a', jobId: 'j', delivery: { mode: 'announce' }, sessionKey: 'slack:thread:CZ3E1122Y3K:1.2' };
    await createDeliver({ slack }).deliver(j, { text: 'x' });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'CZ3E1122Y3K', text: 'x' });
  });

  it('announce with NO resolvable target fails loudly (swallowed, but reported)', async () => {
    const slack = { chat: { postMessage: vi.fn() } };
    const r = await createDeliver({ slack }).deliver(job({ mode: 'announce' }), { text: 'x' });
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/no resolvable delivery target/);
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  // webhook mode was REMOVED: it POSTed turn output to an arbitrary, unvalidated URL — an
  // unrestricted egress path in a PHI-adjacent system — and 0 of 356 prod jobs used it.
  it('webhook mode is REJECTED, not delivered (removed as an unvalidated egress path)', async () => {
    const fetchSpy = vi.fn();
    const r = await createDeliver({ fetch: fetchSpy }).deliver(job({ mode: 'webhook', to: 'https://hook' }), { text: 'payload' });
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/unknown delivery mode/);
    expect(fetchSpy).not.toHaveBeenCalled();   // nothing leaves the process
  });

  it('NO_REPLY / empty text: announces nothing', async () => {
    const slack = { chat: { postMessage: vi.fn() } };
    const d = createDeliver({ slack });
    expect((await d.deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: 'NO_REPLY' })).reason).toBe('no-reply');
    expect((await d.deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: '' })).reason).toBe('no-reply');
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  it('extracts text from the buffered { output: { response } } shape too', async () => {
    const slack = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
    await createDeliver({ slack }).deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { output: { response: 'buffered' } });
    expect(slack.chat.postMessage).toHaveBeenCalledWith({ channel: 'C0ABC123XYZ', text: 'buffered' });
  });

  it('swallows a delivery failure (never throws, does not poison) and reports it', async () => {
    const slack = { chat: { postMessage: vi.fn(async () => { throw new Error('channel_not_found'); }) } };
    const r = await createDeliver({ slack }).deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: 'x' });
    expect(r.delivered).toBe(false);
    expect(r.error).toMatch(/channel_not_found/);
  });


  // §9r: swallowing the failure is correct, but it must not be silent — onFailure is the
  // hook that turns it into the CronDeliveryFailure metric the alarm keys on.
  describe('onFailure hook', () => {
    it('fires on a swallowed announce failure, with mode + error', async () => {
      const onFailure = vi.fn();
      const slack = { chat: { postMessage: vi.fn(async () => { throw new Error('channel_not_found'); }) } };
      const j = job({ mode: 'announce', channel: 'C0ABC123XYZ' });
      await createDeliver({ slack, onFailure }).deliver(j, { text: 'x' });
      expect(onFailure).toHaveBeenCalledTimes(1);
      const [gotJob, info] = onFailure.mock.calls[0];
      expect(gotJob).toBe(j);
      expect(info.mode).toBe('announce');
      expect(info.error).toMatch(/channel_not_found/);
    });

    it('fires when a removed/unknown mode is used', async () => {
      const onFailure = vi.fn();
      await createDeliver({ onFailure }).deliver(job({ mode: 'webhook', to: 'https://hook' }), { text: 'x' });
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][1].mode).toBe('webhook');
    });

    it('fires on an unknown delivery mode', async () => {
      const onFailure = vi.fn();
      const r = await createDeliver({ onFailure }).deliver(job({ mode: 'telepathy' }), { text: 'x' });
      expect(r.delivered).toBe(false);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect(onFailure.mock.calls[0][1].error).toMatch(/unknown delivery mode/);
    });

    it('does NOT fire on success, on mode:none, or on NO_REPLY', async () => {
      const onFailure = vi.fn();
      const slack = { chat: { postMessage: vi.fn(async () => ({ ok: true })) } };
      const d = createDeliver({ slack, onFailure });
      await d.deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: 'ok' });
      await d.deliver(job({ mode: 'none' }), { text: 'ok' });
      await d.deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: 'NO_REPLY' });
      expect(onFailure).not.toHaveBeenCalled();
    });

    it('a throwing hook does not turn a swallowed failure into a thrown one', async () => {
      const onFailure = vi.fn(() => { throw new Error('emf sink exploded'); });
      const slack = { chat: { postMessage: vi.fn(async () => { throw new Error('channel_not_found'); }) } };
      const r = await createDeliver({ slack, onFailure }).deliver(job({ mode: 'announce', channel: 'C0ABC123XYZ' }), { text: 'x' });
      expect(r.delivered).toBe(false);
      expect(r.error).toMatch(/channel_not_found/);
    });
  });
});

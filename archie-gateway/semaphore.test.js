'use strict';

const { createSemaphore } = require('./semaphore');

const deferred = () => { let r; const p = new Promise((res) => { r = res; }); return { p, resolve: r }; };
const tick = () => new Promise((r) => setImmediate(r));

describe('createSemaphore', () => {
  it('admits up to the limit concurrently and queues the rest', async () => {
    const s = createSemaphore(2);
    const gates = [deferred(), deferred(), deferred()];
    const started = [];
    const runs = gates.map((g, i) => s.run(async () => { started.push(i); await g.p; }));

    await tick();
    expect(started).toEqual([0, 1]);   // third is queued
    expect(s.stats().held).toBe(2);
    expect(s.stats().waiting).toBe(1);

    gates[0].resolve();
    await tick(); await tick();
    expect(started).toEqual([0, 1, 2]); // freed permit handed to the waiter

    gates[1].resolve(); gates[2].resolve();
    await Promise.all(runs);
    expect(s.stats().held).toBe(0);
  });

  it('serves waiters in FIFO order', async () => {
    const s = createSemaphore(1);
    const order = [];
    const first = deferred();
    const held = s.run(async () => { order.push('a'); await first.p; });
    await tick();
    const rest = [1, 2, 3, 4].map((n) => s.run(async () => { order.push(n); }));
    await tick();
    first.resolve();
    await Promise.all([held, ...rest]);
    expect(order).toEqual(['a', 1, 2, 3, 4]);
  });

  it('releases the permit when the body throws', async () => {
    const s = createSemaphore(1);
    await expect(s.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(s.stats().held).toBe(0);
    // and the next caller is admitted rather than deadlocked behind the leak
    await expect(s.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('treats a limit of 0 as UNBOUNDED rather than deadlocking', async () => {
    // An env var typo'd to 0 must not wedge every turn forever — see the comment in semaphore.js.
    const s = createSemaphore(0);
    const started = [];
    const gates = Array.from({ length: 25 }, () => deferred());
    const runs = gates.map((g, i) => s.run(async () => { started.push(i); await g.p; }));
    await tick();
    expect(started).toHaveLength(25);
    expect(s.stats().limit).toBe(0);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
  });

  it('ignores a stray release rather than minting a permit', async () => {
    const s = createSemaphore(1);
    s.release(); s.release();          // nothing held — must not raise the ceiling
    const gate = deferred();
    const started = [];
    const a = s.run(async () => { started.push('a'); await gate.p; });
    const b = s.run(async () => { started.push('b'); });
    await tick();
    expect(started).toEqual(['a']);    // b is still queued; the bound survived
    gate.resolve();
    await Promise.all([a, b]);
  });

  it('reports the wait time to the body, and averages only over those that waited', async () => {
    const s = createSemaphore(1);
    const gate = deferred();
    const waits = [];
    const a = s.run(async (waitedMs) => { waits.push(waitedMs); await gate.p; });
    await tick();
    const b = s.run(async (waitedMs) => { waits.push(waitedMs); });
    await tick();
    setTimeout(() => gate.resolve(), 25);
    await Promise.all([a, b]);
    expect(waits[0]).toBe(0);          // instant acquire
    expect(waits[1]).toBeGreaterThan(0);
    const st = s.stats();
    expect(st.waitedCount).toBe(1);    // the instant acquire is NOT in the average
    expect(st.avgWaitMs).toBeGreaterThan(0);
  });

  it('tracks peak occupancy for the gauge', async () => {
    const s = createSemaphore(3);
    const gates = [deferred(), deferred(), deferred()];
    const runs = gates.map((g) => s.run(async () => { await g.p; }));
    await tick();
    expect(s.stats().peakHeld).toBe(3);
    gates.forEach((g) => g.resolve());
    await Promise.all(runs);
    expect(s.stats().held).toBe(0);
    expect(s.stats().peakHeld).toBe(3); // peak is sticky — it is the interesting statistic
  });
});

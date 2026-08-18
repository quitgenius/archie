'use strict';

// vitest globals enabled via vitest.config.js
const {
  createRuntimeQuotaSampler,
  RUNTIME_QUOTA_METRIC_COUNT,
  RUNTIME_QUOTA_METRIC_QUOTA,
  RUNTIME_QUOTA_MAX_PAGES,
} = require('./runtime-quota-metrics');

/** A fake ListAgentRuntimes that serves `runtimes` in pages of `size`. */
function fakeList(runtimes, size = 100) {
  const calls = [];
  const listPage = async (token) => {
    const start = token ? Number(token) : 0;
    calls.push(token ?? null);
    const slice = runtimes.slice(start, start + size);
    const next = start + size < runtimes.length ? String(start + size) : undefined;
    return { agentRuntimes: slice, ...(next ? { nextToken: next } : {}) };
  };
  return { listPage, calls };
}

const ready = (n, status = 'READY') => Array.from({ length: n }, (_, i) => ({
  agentRuntimeId: `oc_agent_${i}`, status,
}));

function capture(over = {}) {
  const lines = [];
  const sampler = createRuntimeQuotaSampler({
    emit: (l) => lines.push(l),
    now: () => 1_800_000_000_000,
    namespace: 'testStackDispatcher',
    ...over,
  });
  return { sampler, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

const totalLine = (parsed) => parsed.find((e) => e._aws.CloudWatchMetrics[0].Dimensions[0].length === 0);
const statusLine = (parsed, status) => parsed.find((e) => e.Status === status);

describe('counting', () => {
  it('paginates and totals every runtime', async () => {
    const { listPage, calls } = fakeList(ready(250));
    const { sampler } = capture({ listPage, quota: 1000 });
    const snap = await sampler.count();
    expect(snap.total).toBe(250);
    expect(snap.pages).toBe(3);
    expect(calls[0]).toBe(null);
  });

  it('counts DELETING runtimes — the name (and the quota slot) is held until the delete finishes', async () => {
    const { listPage } = fakeList([...ready(5), ...ready(2, 'DELETING')]);
    const { sampler } = capture({ listPage });
    const snap = await sampler.count();
    expect(snap.total).toBe(7);
    expect(snap.byStatus.get('DELETING')).toBe(2);
  });

  it('stops at MAX_PAGES rather than following a never-ending nextToken', async () => {
    // A page that always advertises more. Without the backstop this loops forever against a
    // rate-limited account-wide API.
    const listPage = async () => ({ agentRuntimes: ready(100), nextToken: 'more' });
    const { sampler } = capture({ listPage });
    const snap = await sampler.count();
    expect(snap.pages).toBe(RUNTIME_QUOTA_MAX_PAGES);
    expect(snap.truncated).toBe(true);
  });
});

describe('EMF emission', () => {
  it('emits the alarmed total on the DIMENSIONLESS series, with the quota alongside', async () => {
    const { listPage } = fakeList(ready(900));
    const { sampler, parsed } = capture({ listPage, quota: 1000 });
    await sampler.sample();
    const line = totalLine(parsed());
    expect(line[RUNTIME_QUOTA_METRIC_COUNT]).toBe(900);
    expect(line[RUNTIME_QUOTA_METRIC_QUOTA]).toBe(1000);
    expect(line.headroom).toBe(100);
    expect(line.utilizationPct).toBe(90);
    expect(line._aws.CloudWatchMetrics[0].Namespace).toBe('testStackDispatcher');
  });

  it('breaks down by status WITHOUT double-counting into the alarmed series', async () => {
    const { listPage } = fakeList([...ready(4), ...ready(3, 'DELETING'), ...ready(1, 'CREATE_FAILED')]);
    const { sampler, parsed } = capture({ listPage });
    await sampler.sample();
    const p = parsed();
    // The status lines carry ONLY the Status dimension: they partition the same population, so
    // publishing them into `[]` as well would put four datapoints per tick on the alarmed series.
    for (const status of ['READY', 'DELETING', 'CREATE_FAILED']) {
      expect(statusLine(p, status)._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Status']]);
    }
    expect(statusLine(p, 'DELETING')[RUNTIME_QUOTA_METRIC_COUNT]).toBe(3);
    expect(p.filter((e) => e._aws.CloudWatchMetrics[0].Dimensions[0].length === 0)).toHaveLength(1);
  });

  it('reports an unknown status rather than dropping the runtime from the breakdown', async () => {
    const { listPage } = fakeList([{ agentRuntimeId: 'x' }]);
    const { sampler, parsed } = capture({ listPage });
    await sampler.sample();
    expect(totalLine(parsed())[RUNTIME_QUOTA_METRIC_COUNT]).toBe(1);
    expect(statusLine(parsed(), 'UNKNOWN')[RUNTIME_QUOTA_METRIC_COUNT]).toBe(1);
  });
});

describe('failure handling', () => {
  it('never throws out of sample() — a metrics failure must not touch the turn path', async () => {
    const listPage = async () => { throw new Error('Throttling'); };
    const warns = [];
    const { sampler, lines } = capture({ listPage, log: { info() {}, warn: (o, m) => warns.push(m), error() {} } });
    await expect(sampler.sample()).resolves.toBeNull();
    expect(lines).toEqual([]);
    expect(warns[0]).toMatch(/sample failed/);
  });

  it('keeps sampling after a transient error', async () => {
    let n = 0;
    const listPage = async () => {
      n += 1;
      if (n === 1) throw new Error('Throttling');
      return { agentRuntimes: ready(3) };
    };
    const { sampler, parsed } = capture({ listPage });
    await sampler.sample();
    await sampler.sample();
    expect(totalLine(parsed())[RUNTIME_QUOTA_METRIC_COUNT]).toBe(3);
  });

  it('disables itself permanently on AccessDenied — the grant is static, so retrying forever only logs', async () => {
    let calls = 0;
    const listPage = async () => {
      calls += 1;
      const err = new Error('not authorized to perform: bedrock-agentcore:ListAgentRuntimes');
      err.name = 'AccessDeniedException';
      throw err;
    };
    const { sampler } = capture({ listPage });
    await sampler.sample();
    await sampler.sample();
    expect(calls).toBe(1);
  });
});

describe('scheduling', () => {
  it('samples once at boot and then on the interval', async () => {
    const { listPage } = fakeList(ready(2));
    let armed = null;
    const { sampler, parsed } = capture({
      listPage,
      intervalMs: 300_000,
      setInterval: (fn, ms) => { armed = { fn, ms }; return { id: 1, unref() {} }; },
      clearInterval: () => { armed = null; },
    });
    sampler.start();
    await new Promise(setImmediate);
    expect(parsed().length).toBeGreaterThan(0);
    expect(armed.ms).toBe(300_000);
    sampler.stop();
    expect(armed).toBeNull();
  });

  it('an interval of 0 disables the timer entirely', () => {
    const { sampler } = capture({
      listPage: async () => ({ agentRuntimes: [] }),
      intervalMs: 0,
      setInterval: () => { throw new Error('must not arm a timer'); },
    });
    expect(sampler.start()).toBeNull();
  });
});

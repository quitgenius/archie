import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDatadogTools, createDatadogTool } from './datadog-tool.mjs';
import { policyFor } from './permissions/capabilities.mjs';

// ── capability wiring ───────────────────────────────────────────────────────
test('datadog tool DECLARES the grant-gated `datadog` capability', () => {
  assert.equal(createDatadogTool().capability, 'datadog');
  assert.equal(policyFor('datadog'), 'deny'); // non-baseline → must be granted
});

test('buildDatadogTools is grant-gated on the datadog allow token', () => {
  assert.deepEqual(buildDatadogTools(new Set()).map((t) => t.name), []);
  assert.deepEqual(buildDatadogTools(new Set(['datadog'])).map((t) => t.name), ['datadog']);
  process.env.DATADOG_TOOLS_DISABLED = '1';
  assert.deepEqual(buildDatadogTools(new Set(['datadog'])), []); // kill switch
  delete process.env.DATADOG_TOOLS_DISABLED;
});

// ── request construction (mocked fetch) ─────────────────────────────────────
function withMockFetch(handler, fn) {
  const orig = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return handler(url, opts); };
  return fn(calls).finally(() => { globalThis.fetch = orig; });
}
const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('no creds → returns a not-configured result (never throws into the turn)', async () => {
  const prevA = process.env.DATADOG_API_KEY; const prevB = process.env.DATADOG_APP_KEY;
  delete process.env.DATADOG_API_KEY; delete process.env.DATADOG_APP_KEY;
  const tool = createDatadogTool();
  const r = await tool.execute('id', { action: 'logs', query: 'service:x' });
  assert.match(r.details.error, /not configured/i);
  if (prevA) process.env.DATADOG_API_KEY = prevA; if (prevB) process.env.DATADOG_APP_KEY = prevB;
});

test('builds the exact Datadog REST calls per action', async () => {
  process.env.DATADOG_API_KEY = 'k'; process.env.DATADOG_APP_KEY = 'a';
  const tool = createDatadogTool();
  await withMockFetch(() => ok({ data: [] }), async (calls) => {
    await tool.execute('i', { action: 'logs', query: 'service:demo-service-* status:error', from: 'now-2h', limit: 10 });
    await tool.execute('i', { action: 'health' });
    await tool.execute('i', { action: 'monitors', tags: 'demo-service', nameFilter: 'x' });
    await tool.execute('i', { action: 'incidents', pageSize: 5 });
    await tool.execute('i', { action: 'metrics', metricQuery: 'avg:aws.lambda.duration{*}' });
    await tool.execute('i', { action: 'dashboards' });

    const [logs, health, monitors, incidents, metrics, dashboards] = calls;
    // auth headers present on every call
    for (const c of calls) {
      assert.equal(c.opts.headers['DD-API-KEY'], 'k');
      assert.equal(c.opts.headers['DD-APPLICATION-KEY'], 'a');
    }
    assert.equal(logs.opts.method, 'POST');
    assert.match(logs.url, /\/api\/v2\/logs\/events\/search$/);
    assert.deepEqual(JSON.parse(logs.opts.body).filter, { query: 'service:demo-service-* status:error', from: 'now-2h', to: 'now' });
    assert.equal(JSON.parse(logs.opts.body).page.limit, 10);
    // health = a canned error-in-prod logs search
    assert.match(health.url, /\/api\/v2\/logs\/events\/search$/);
    assert.equal(JSON.parse(health.opts.body).filter.query, 'status:error env:prod');
    assert.match(monitors.url, /\/api\/v1\/monitor\?.*monitor_tags=demo-service/);
    assert.match(incidents.url, /\/api\/v2\/incidents\?page%5Bsize%5D=5/);
    assert.match(metrics.url, /\/api\/v1\/query\?from=\d+&to=\d+&query=avg/);
    assert.match(dashboards.url, /\/api\/v1\/dashboard$/);
  });
  delete process.env.DATADOG_API_KEY; delete process.env.DATADOG_APP_KEY;
});

test('logs requires a query; unknown action lists valid actions', async () => {
  process.env.DATADOG_API_KEY = 'k'; process.env.DATADOG_APP_KEY = 'a';
  const tool = createDatadogTool();
  const noQ = await tool.execute('i', { action: 'logs' });
  assert.match(noQ.details.error, /requires a `query`/);
  const bad = await tool.execute('i', { action: 'nope' });
  assert.ok(bad.details.actions.includes('logs'));
  delete process.env.DATADOG_API_KEY; delete process.env.DATADOG_APP_KEY;
});

// Hermetic test: a failing compat plugin (e.g. connector 401) must be ISOLATED — the
// agent still boots and turns still run; only that plugin's tools degrade.
//   node plugin-host-test.mjs

import assert from 'node:assert';
import { buildCompatPlugins, prewarmCompatPlugins } from './plugin-host.mjs';

const sink = { info() {}, warn() {}, error() {}, log() {} }; // silent
function fakePi() { const handlers = {}; return { on: (e, h) => { (handlers[e] ??= []).push(h); }, handlers }; }
const toolEntry = (id, name, onExec) => ({ id, register: (api) => api.registerTool({ name, label: name, description: '', parameters: {}, execute: onExec || (async () => ({ content: [{ type: 'text', text: 'ok' }] })) }) });

const checks = [];
const check = (n, fn) => checks.push({ n, fn });

check('register() throw is isolated — other plugins still load (agent boots)', () => {
  const bad = { id: 'connector-session-plugin', register: () => { throw new Error('Status: 401 no API key'); } };
  const good = toolEntry('cron', 'cron');
  const { customTools, plugins } = buildCompatPlugins([{ entry: bad }, { entry: good }], { logSink: sink });
  assert.deepEqual(customTools.map((t) => t.name), ['cron']); // good loaded, bad skipped — agent boots
  const rec = plugins.find((p) => p.id === 'connector-session-plugin');
  assert.match(rec.error, /401/); // bad recorded as errored, not thrown
});

check('before_prompt_build throw is isolated — turn proceeds + other injections apply', async () => {
  const bad = { id: 'connector-session-plugin', register: (api) => api.on('before_prompt_build', async () => { throw new Error('discovery 401'); }) };
  const good = { id: 'inject', register: (api) => api.on('before_prompt_build', async () => ({ appendSystemContext: 'INJECTED-CTX' })) };
  const { extensionFactory } = buildCompatPlugins([{ entry: bad }, { entry: good }], { logSink: sink });
  const pi = fakePi(); extensionFactory(pi);
  const out = await pi.handlers.context[0]({ messages: [{ role: 'user', content: 'hi' }] }); // must NOT throw
  assert.match(JSON.stringify(out.messages), /INJECTED-CTX/); // good injection survived the bad throw
});

check('agent_end throw is isolated (turn cleanup does not crash)', async () => {
  const bad = { id: 'connector-session-plugin', register: (api) => api.on('agent_end', async () => { throw new Error('retain 401'); }) };
  const { extensionFactory } = buildCompatPlugins([{ entry: bad }], { logSink: sink });
  const pi = fakePi(); extensionFactory(pi);
  await pi.handlers.agent_end[0]({}); // must NOT throw
});

check('before_tool_call hook throw is isolated — the tool still executes', async () => {
  let ran = false;
  const p = { id: 'connector-session-plugin', register: (api) => {
    api.on('before_tool_call', async () => { throw new Error('hook 401'); });
    api.registerTool({ name: 'cron', label: 'cron', description: '', parameters: {}, execute: async () => { ran = true; return { content: [{ type: 'text', text: 'ok' }] }; } });
  } };
  const { customTools } = buildCompatPlugins([{ entry: p }], { logSink: sink });
  const r = await customTools[0].execute('id', {}); // must NOT throw despite the before-hook throwing
  assert.ok(ran);
  assert.equal(r.content[0].text, 'ok');
});

check('a tool-factory that throws on resolve is isolated — other tools survive', () => {
  const p = { id: 'connector-session-plugin', register: (api) => {
    api.registerTool(() => { throw new Error('factory 401'); }); // throwing factory
    api.registerTool({ name: 'ok_tool', label: 'ok_tool', description: '', parameters: {}, execute: async () => ({ content: [] }) });
  } };
  const { customTools } = buildCompatPlugins([{ entry: p }], { logSink: sink });
  assert.deepEqual(customTools.map((t) => t.name), ['ok_tool']);
});

let pass = 0;
// Live regression, 2026-08-12 (@connector-discovery-race). register() kicks off async discovery and
// buildCompatPlugins resolves tool factories synchronously, so a first session build sees an empty
// cache. Under OpenClaw only the very first message could lose; under Pi every session is its own
// microVM, so 66/66 sampled builds contained zero mcp_connector__* tools.
check('prewarmCompatPlugins registers without resolving tools, and awaits in-flight discovery', async () => {
  let registered = 0, toolsResolved = 0, discoveryDone = false;
  globalThis.__connectorSessionPluginDiscovering = new Map([
    ['agentA', new Promise((r) => setTimeout(() => { discoveryDone = true; r(); }, 30))],
  ]);
  const entry = {
    id: 'fake-plugin',
    register(api) {
      registered += 1;
      api.registerTool(() => { toolsResolved += 1; return { name: 't', execute: async () => ({}) }; });
    },
  };
  const r = await prewarmCompatPlugins([{ entry, pluginConfig: {} }], { logSink: { info() {}, warn() {}, debug() {} } });
  assert.equal(registered, 1, 'register ran');
  assert.equal(toolsResolved, 0, 'tool factories must NOT be resolved during prewarm');
  assert.equal(discoveryDone, true, 'awaited the in-flight discovery');
  assert.equal(r.awaited, 1);
  assert.equal(r.timedOut, false);
  delete globalThis.__connectorSessionPluginDiscovering;
});

check('prewarm is BOUNDED — a hung discovery delays boot, it does not prevent it', async () => {
  // Settles well AFTER the timeout — a never-settling promise cannot be used here because the
  // prewarm's own timer is unref'd (deliberately: it must not hold the process open in prod), so
  // nothing would keep the event loop alive.
  globalThis.__connectorSessionPluginDiscovering = new Map([
    ['agentA', new Promise((r) => setTimeout(r, 400))],
  ]);
  const entry = { id: 'fake-plugin', register() {} };
  const r = await prewarmCompatPlugins([{ entry, pluginConfig: {} }], { timeoutMs: 40, logSink: { info() {}, warn() {}, debug() {} } });
  assert.equal(r.timedOut, true);
  delete globalThis.__connectorSessionPluginDiscovering;
});

check('prewarm isolates a failing plugin', async () => {
  const bad = { id: 'bad', register() { throw new Error('boom'); } };
  const good = { id: 'good', register() {} };
  const r = await prewarmCompatPlugins([{ entry: bad, pluginConfig: {} }, { entry: good, pluginConfig: {} }], { logSink: { info() {}, warn() {}, debug() {} } });
  assert.deepEqual(r.registered, ['good']);
});

for (const { n, fn } of checks) {
  try { await fn(); console.log(`  ✅ ${n}`); pass += 1; }
  catch (e) { console.log(`  ❌ ${n}\n     ${e.message}`); }
}
const ok = pass === checks.length;
console.log(`[plugin-host isolation] ${pass}/${checks.length} ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);

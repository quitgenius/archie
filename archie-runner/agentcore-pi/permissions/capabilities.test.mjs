import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCapabilityResolver, makeDecider, makeAllowCheck, policyFor, isBaseline, CAPABILITY_DEFAULTS } from './capabilities.mjs';
import { CUSTOM_TOOLS } from '../tool-declarations.mjs';
const TC = CUSTOM_TOOLS;

test('makeAllowCheck: silent baseline/grant check (no telemetry) — for the tool filter', () => {
  const allow = makeAllowCheck({ grants: new Set(['demo_query_app']) });
  assert.equal(allow('memory'), true);          // baseline
  assert.equal(allow('demo_query_app'), true);            // granted
  assert.equal(allow('demo_warehouse'), false);            // not granted
  assert.equal(allow('unknown'), false);        // fail-closed
});

test('capabilityOf: built-in + custom tools', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC });
  assert.equal(cap('read'), 'fs.read');
  // read-only coding tools Pi injects by default ride baseline fs.read (verified live: were
  // falling through to unknown→deny, which would break normal agents fleet-wide)
  assert.equal(cap('grep'), 'fs.read');
  assert.equal(cap('find'), 'fs.read');
  assert.equal(cap('ls'), 'fs.read');
  assert.equal(cap('glob'), 'fs.read');
  assert.equal(cap('write'), 'fs.write');
  assert.equal(cap('edit'), 'fs.write');
  assert.equal(cap('apply_patch'), 'fs.write');
  assert.equal(cap('bash'), 'runtime');
  assert.equal(cap('exec'), 'runtime');
  assert.equal(cap('sessions_spawn'), 'runtime');
  assert.equal(cap('memory_search'), 'memory');
  assert.equal(cap('cron'), 'cron');
  // OTEL is two tiers: the scope-pinned otel_my_* tools are baseline `otel`; the fleet-wide +
  // ad-hoc otel_fleet_* tools declare `otel.fleet`, which falls through '*' to deny.
  assert.equal(cap('otel_my_turns'), 'otel');
  assert.equal(cap('otel_my_trace'), 'otel');
  assert.equal(cap('otel_my_crons'), 'otel');
  assert.equal(cap('otel_fleet_query'), 'otel.fleet');
  assert.equal(cap('otel_fleet_trace'), 'otel.fleet');
});

test('capabilityOf: connector — all three real naming forms (verified live)', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC });
  assert.equal(cap('CONNECTOR_SEARCH_TOOLS'), 'connector');        // core meta-tools (uppercase)
  assert.equal(cap('CONNECTOR_MULTI_EXECUTE_TOOL'), 'connector');  // normal toolkit-action executor stays baseline
  assert.equal(cap('mcp_connector__gmail_send_email'), 'connector'); // toolkit tools
  assert.equal(cap('mcp_connector__notion_status'), 'connector');
  assert.equal(cap('connector_bind_cron_entity'), 'connector');    // plugin helper
});

// THE RCE CARVE-OUT IS DELETED, and this test pins its absence rather than being removed with it —
// so that re-introducing a `connector.exec` branch is a deliberate act that fails a test, not a quiet
// re-divergence from OpenClaw. The two remote-execution tools are ordinary baseline connector: every
// agent with the plugin can call them, exactly as under OpenClaw. Audit lives in the OTEL slug field
// (see permissions-extension.test.mjs), not in a capability.
test('capabilityOf: the connector RCE tools are baseline connector — no exec carve-out', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC });
  // The plugin registers tools as mcp_connector__<mcpName> — the LIVE names the hook actually sees.
  assert.equal(cap('mcp_connector__CONNECTOR_REMOTE_BASH_TOOL'), 'connector');
  assert.equal(cap('mcp_connector__CONNECTOR_REMOTE_WORKBENCH'), 'connector');
  // bare names too (defensive, in case a path registers unprefixed)
  assert.equal(cap('CONNECTOR_REMOTE_BASH_TOOL'), 'connector');
  assert.equal(cap('CONNECTOR_REMOTE_WORKBENCH'), 'connector');
  // normal connector tools are unchanged and land in the same place
  assert.equal(cap('mcp_connector__CONNECTOR_SEARCH_TOOLS'), 'connector');
  assert.equal(cap('mcp_connector__gmail_send_email'), 'connector');
  // and `connector` is baseline-allow, so NO grant is consulted for any of the above
  assert.equal(policyFor('connector'), 'allow');
  assert.equal(makeDecider({ grants: new Set() })('connector'), true);
});

// THE ALWAYS-ON INVARIANT for hindsight recall (2026-08-18). Same shape as otel-tool-test.mjs' self-observability test: the
// property is true by construction today, and nothing enforced it, so a plausible refactor could remove
// fleet-wide read access to org memory with no error anywhere.
//
// WHY A TEST AND NOT A POLICY STATEMENT: "no way to get rid of it" is not expressible in Cedar. `forbid`
// beats every `permit`, so any future forbid naming hindsight.read would override an unconditional permit
// for it. Immutability therefore has to be a BUILD-TIME assertion — this test, plus the policy-side rule
// that no forbid may reference hindsight.read.
test('hindsight.read is ambient for every agent, and the knowledge tools resolve to it', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC });

  // (a) all three ALWAYS_ALLOW knowledge tools map to it. Reads only — retain is a hook, not a tool.
  for (const t of ['agent_knowledge_recall', 'agent_knowledge_search_documents', 'agent_knowledge_get_document']) {
    assert.equal(cap(t), 'hindsight.read', t);
  }
  // prefix-based, so a fourth read tool added later lands here rather than on 'unknown' → deny
  assert.equal(cap('agent_knowledge_anything_new'), 'hindsight.read');

  // (b) it is baseline-allow, so NO grant is consulted and an empty grant set still allows.
  assert.equal(policyFor('hindsight.read'), 'allow');
  assert.equal(makeDecider({ grants: new Set() })('hindsight.read'), true);
  assert.equal(makeAllowCheck({ grants: new Set() })('hindsight.read'), true);

  // (c) the write half is NOT dragged in with it — it stays default-deny and is policy-pinned.
  assert.equal(policyFor('hindsight.write'), 'deny');
  assert.equal(makeDecider({ grants: new Set() })('hindsight.write'), false);
  assert.notEqual(cap('agent_knowledge_recall'), 'hindsight.write');
});

test('capabilityOf: pelago data vs health', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC });
  assert.equal(cap('demo_cache__query'), 'demo_cache');      // data → grant-gated
  assert.equal(cap('demo_cache__health'), 'health');           // health → baseline
});

test('capabilityOf: plugin health/introspection tools → baseline health (verified live)', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC, mcpPrefixes: ['demo_query_app'] });
  assert.equal(cap('mcp_auth_plugin_health'), 'health');
  assert.equal(cap('mcp_connector_plugin_health'), 'health');
  assert.equal(cap('demo_query_app__health'), 'health');                   // server health, not the demo_query_app data cap
  assert.equal(cap('demo_query_app__run_query'), 'demo_query_app');                  // …but real demo_query_app data still gated
});

test('capabilityOf: MCP servers matched by configured prefix, demo_warehouse→demo_warehouse alias', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC, mcpPrefixes: ['demo_query_app', 'demo_warehouse', 'demo_diagram_app'] });
  assert.equal(cap('demo_query_app__run_query'), 'demo_query_app');
  assert.equal(cap('demo_warehouse__execute_sql'), 'demo_warehouse'); // alias
  assert.equal(cap('demo_diagram_app__create'), 'demo_diagram_app');
});

// Live regression, prod 2026-09-04. openclaw-mcp-auth-plugin registers proxied MCP tools as
// `mcp_auth__<toolPrefix>__<name>` (its tool-cache.ts TOOL_PREFIX), which the bare-prefix rule above
// never matched — so on agent-zvo25p all six DemoWarehouse tools resolved 'unknown', were hidden by
// the grant filter, and the closure invariant logged a hole each. `demo_warehouse` and `demo_query_app` were BOTH granted
// (GRANT#dm-urbnxvak3l5 → agent-base) and neither is policy-pinned, so the capability name was the
// only thing standing between the agent and its data.
test('capabilityOf: mcp-auth namespaced MCP tools resolve to the server capability', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC, mcpPrefixes: ['demo_query_app', 'demo_warehouse', 'demo_diagram_app'] });
  assert.equal(cap('mcp_auth__demo_warehouse__execute_query'), 'demo_warehouse'); // alias, namespaced
  assert.equal(cap('mcp_auth__demo_warehouse__list_clusters'), 'demo_warehouse');
  assert.equal(cap('mcp_auth__demo_query_app__run_query'), 'demo_query_app');
  assert.equal(cap('mcp_auth__demo_diagram_app__create'), 'demo_diagram_app');
  // The plugin's own health tool stays baseline `health` — it must NOT be gated as a data cap, and
  // the health rule runs before the prefix rules precisely so this holds.
  assert.equal(cap('mcp_auth_plugin_health'), 'health');
});

test('capabilityOf: unknown / unconfigured MCP → unknown (→ deny)', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC, mcpPrefixes: ['demo_query_app'] });
  assert.equal(cap('demo_warehouse__execute_sql'), 'unknown');   // prefix not configured for this agent
  assert.equal(cap('totally_new_tool'), 'unknown');
  // Namespacing does not smuggle an unconfigured server past the gate either.
  assert.equal(cap('mcp_auth__demo_warehouse__execute_query'), 'unknown');
  assert.equal(policyFor('unknown'), 'deny');
});

// The prefix is duplicated in capabilities.mjs rather than imported (boot-path depth, see its
// comment). Pin the two together so a rename in the plugin cannot silently re-open the hole.
test('capabilities.mjs MCP_AUTH_PREFIX matches the plugin TOOL_PREFIX', async () => {
  const { readFileSync } = await import('node:fs');
  const plugin = readFileSync(new URL('../../openclaw-mcp-auth-plugin/src/tool-cache.ts', import.meta.url), 'utf8');
  const m = plugin.match(/const TOOL_PREFIX = "([^"]+)"/);
  assert.ok(m, 'could not find TOOL_PREFIX in the plugin');
  const mine = readFileSync(new URL('./capabilities.mjs', import.meta.url), 'utf8');
  assert.ok(mine.includes(`const MCP_AUTH_PREFIX = '${m[1]}'`),
    `capabilities.mjs MCP_AUTH_PREFIX must be '${m[1]}' to match the plugin`);
});

test('default policy: allow-list baseline, everything else deny via *', () => {
  for (const c of ['fs.read', 'memory', 'cron', 'otel', 'connector', 'health', 'hindsight.read']) {
    assert.equal(policyFor(c), 'allow', c);
    assert.equal(isBaseline(c), true, c);
  }
  for (const c of ['fs.write', 'runtime', 'demo_warehouse', 'demo_query_app', 'demo_cache', 'demo_diagram_app', 'hindsight.write', 'otel.fleet', 'unknown']) {
    assert.equal(policyFor(c), 'deny', c);
    assert.equal(isBaseline(c), false, c);
  }
  assert.equal(CAPABILITY_DEFAULTS['*'], 'deny');
});

test('decide: baseline allowed with empty grants; non-baseline needs a grant', () => {
  const signals = [];
  const decide = makeDecider({ grants: new Set(), onSignal: (s) => signals.push(s) });
  assert.equal(decide('memory'), true);         // baseline
  assert.equal(decide('fs.read'), true);        // baseline
  assert.equal(decide('demo_query_app'), false);          // not granted
  assert.equal(decide('unknown'), false);       // fail-closed
  assert.equal(signals.length, 4);
  assert.deepEqual(signals.map((s) => s.decision), ['allow', 'allow', 'deny', 'deny']);
});

test('decide: a granted non-baseline capability is allowed', () => {
  const decide = makeDecider({ grants: new Set(['demo_query_app', 'fs.write']) });
  assert.equal(decide('demo_query_app'), true);
  assert.equal(decide('fs.write'), true);
  assert.equal(decide('demo_warehouse'), false);           // granted demo_query_app, not demo_warehouse
});

test('decide: onSignal failure never throws', () => {
  const decide = makeDecider({ grants: new Set(), onSignal: () => { throw new Error('telemetry down'); } });
  assert.doesNotThrow(() => decide('memory'));
});

test('live grants: mutating the shared Set flips decide + allows (per-turn refresh contract)', () => {
  // The adapter reads grants per turn by MUTATING the one Set that both the PEP decider and the
  // tool-filter allow-check close over — so a grant add/revoke takes effect with no session
  // rebuild/restart. This locks that contract: same closures, live Set.
  const grants = new Set();
  const decide = makeDecider({ grants });
  const allows = makeAllowCheck({ grants });
  assert.equal(decide('runtime'), false);
  assert.equal(allows('runtime'), false);
  grants.add('runtime');                 // per-turn refresh grants a capability
  assert.equal(decide('runtime'), true); // same closures see it immediately — no rebuild
  assert.equal(allows('runtime'), true);
  grants.delete('runtime');              // …and a revoke
  assert.equal(decide('runtime'), false);
  assert.equal(allows('runtime'), false);
  assert.equal(decide('memory'), true);  // baseline unaffected throughout
});

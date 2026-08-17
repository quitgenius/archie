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
  assert.equal(allow('connector.exec'), false);  // RCE carve, not granted
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

test('capabilityOf: CONNECTOR_REMOTE_BASH_TOOL / _WORKBENCH are carved into grant-gated connector.exec', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC });
  // The plugin registers tools as mcp_connector__<mcpName> — the LIVE names the hook actually sees.
  assert.equal(cap('mcp_connector__CONNECTOR_REMOTE_BASH_TOOL'), 'connector.exec');
  assert.equal(cap('mcp_connector__CONNECTOR_REMOTE_WORKBENCH'), 'connector.exec');
  // bare names also map (defensive, in case a path registers unprefixed)
  assert.equal(cap('CONNECTOR_REMOTE_BASH_TOOL'), 'connector.exec');
  assert.equal(cap('CONNECTOR_REMOTE_WORKBENCH'), 'connector.exec');
  // …but a NORMAL prefixed connector tool stays baseline (the carve-out must not over-match)
  assert.equal(cap('mcp_connector__CONNECTOR_SEARCH_TOOLS'), 'connector');
  assert.equal(cap('mcp_connector__gmail_send_email'), 'connector');
  assert.equal(policyFor('connector.exec'), 'deny');               // default-deny via '*'
  // still allowed once explicitly granted; denied otherwise
  assert.equal(makeDecider({ grants: new Set() })('connector.exec'), false);
  assert.equal(makeDecider({ grants: new Set(['connector.exec']) })('connector.exec'), true);
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

test('capabilityOf: unknown / unconfigured MCP → unknown (→ deny)', () => {
  const cap = makeCapabilityResolver({ toolCaps: TC, mcpPrefixes: ['demo_query_app'] });
  assert.equal(cap('demo_warehouse__execute_sql'), 'unknown');   // prefix not configured for this agent
  assert.equal(cap('totally_new_tool'), 'unknown');
  assert.equal(policyFor('unknown'), 'deny');
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

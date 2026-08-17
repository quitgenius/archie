import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToolFilter } from './tool-filter.mjs';
import { makeCapabilityResolver, makeAllowCheck } from './capabilities.mjs';
import { CUSTOM_TOOLS } from '../tool-declarations.mjs';
const TC = CUSTOM_TOOLS;

const NOOP_LOG = { info() {}, warn() {} };

// Fake AgentSession: getAllTools() + setActiveToolsByName() (the real public API).
function fakeSession(allTools) {
  let active = allTools.slice();
  return {
    getAllTools: () => allTools.map((name) => ({ name })),
    setActiveToolsByName: (names) => { active = names; },
    getActive: () => active,
  };
}

const NAMES = [
  'read', 'memory_search', 'otel_my_turns', 'write', 'edit', // baseline + fs.write
  'demo_query_app__query',                                            // granted (demo_query_app)
  'mcp_connector__CONNECTOR_SEARCH_TOOLS',                    // baseline connector
  'mcp_connector__CONNECTOR_REMOTE_BASH_TOOL',                // connector.exec — NOT granted
  'otel_fleet_query',                                       // otel.fleet — NOT granted
  'demo_cache__query',                                    // demo_cache — NOT granted
  'demo_warehouse__execute_sql',                                  // demo_warehouse — NOT granted
];

test('applyToolFilter sets the active set to the grant-allowed subset', () => {
  const session = fakeSession(NAMES);
  const r = applyToolFilter(session, {
    capabilityOf: makeCapabilityResolver({ toolCaps: TC, mcpPrefixes: ['demo_query_app', 'demo_warehouse'] }),
    allows: makeAllowCheck({ grants: new Set(['demo_query_app', 'fs.write']) }),
    turnCtx: {}, log: NOOP_LOG,
  });
  const active = session.getActive();
  for (const k of ['read', 'memory_search', 'otel_my_turns', 'write', 'edit', 'demo_query_app__query', 'mcp_connector__CONNECTOR_SEARCH_TOOLS']) {
    assert.ok(active.includes(k), `keep ${k}`);
  }
  for (const d of ['mcp_connector__CONNECTOR_REMOTE_BASH_TOOL', 'otel_fleet_query', 'demo_cache__query', 'demo_warehouse__execute_sql']) {
    assert.ok(!active.includes(d), `hide ${d}`);
  }
  assert.deepEqual(r.hidden.sort(), ['mcp_connector__CONNECTOR_REMOTE_BASH_TOOL', 'otel_fleet_query', 'demo_cache__query', 'demo_warehouse__execute_sql'].sort());
});

test('revoking fs.write hides write/edit (the observable, connector-independent case)', () => {
  const session = fakeSession(['read', 'write', 'edit', 'memory_search']);
  applyToolFilter(session, {
    capabilityOf: makeCapabilityResolver({ toolCaps: TC }),
    allows: makeAllowCheck({ grants: new Set() }), // fs.write NOT granted
    turnCtx: {}, log: NOOP_LOG,
  });
  const active = session.getActive();
  assert.deepEqual(active.sort(), ['memory_search', 'read']); // write/edit hidden
});

test('never throws on a bad session (block-on-call remains the guarantee)', () => {
  const bad = { getAllTools: () => { throw new Error('boom'); }, setActiveToolsByName() {} };
  assert.doesNotThrow(() => applyToolFilter(bad, {
    capabilityOf: makeCapabilityResolver({ toolCaps: TC }), allows: makeAllowCheck({ grants: new Set() }), turnCtx: {}, log: NOOP_LOG,
  }));
});

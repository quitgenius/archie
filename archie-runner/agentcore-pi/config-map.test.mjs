// Hermetic unit tests for config-map derivations.
//
// (config-map-test.mjs — no dot — is the separate MANUAL, AWS-touching harness. This file is the
// `node --test` one and must stay dependency-free.)

import test from 'node:test';
import assert from 'node:assert';
import { resolveMcpPrefixes } from './config-map.mjs';
import { makeCapabilityResolver } from './permissions/capabilities.mjs';

// The shape boot-config.mjs actually returns, copied from the LIVE prod resolve for
// dm-urbnxvak3l5 (2026-09-04). The two details that matter and that a hand-written fixture would
// have got wrong, because they are the bug:
//   * `agent.connector` is the CONNECTOR-SESSION-PLUGIN slice — {cronEntityId, toolkits}. It has no
//     extraMcpServers, so the old `agent.connector.extraMcpServers` read yielded [] for every agent.
//   * the mcp-auth slice is keyed by agent id under `.config.agents`, and its FIRST server (the
//     connector parity key) carries no toolPrefix at all.
const RESOLVED = {
  agent: {
    id: 'dm-urbnxvak3l5',
    connector: { cronEntityId: 'URBNXVAK3L5', toolkits: ['gmail', 'slack'] },
  },
  cfg: {
    plugins: {
      entries: {
        'openclaw-mcp-auth-plugin': {
          config: {
            upstreamUrl: 'https://backend.connector.dev/v3/mcp/xxx/mcp',
            agents: {
              'dm-urbnxvak3l5': {
                mcpServers: [
                  { apiKey: 'parity-connector-key', senderUserMap: {} }, // no toolPrefix
                  { upstreamUrl: 'http://redacted-internal-host.example/mcp', apiKey: '', toolPrefix: 'demo_warehouse' },
                  { upstreamUrl: 'https://demo_query_app.example/api/mcp', oauth2: {}, toolPrefix: 'demo_query_app' },
                ],
              },
            },
          },
        },
      },
    },
  },
};

test('resolveMcpPrefixes: reads the mcp-auth slice, skipping servers with no toolPrefix', () => {
  assert.deepEqual(resolveMcpPrefixes(RESOLVED.agent, RESOLVED.cfg), ['demo_warehouse', 'demo_query_app']);
});

test('resolveMcpPrefixes: the connector slice alone yields nothing (the regression)', () => {
  // Exactly the old behaviour, asserted so nobody reinstates it: agent.connector is the wrong slice.
  const old = (RESOLVED.agent.connector.extraMcpServers ?? []).map((s) => s?.toolPrefix).filter(Boolean);
  assert.deepEqual(old, [], 'agent.connector never carries extraMcpServers — this is why it was []');
  assert.notDeepEqual(resolveMcpPrefixes(RESOLVED.agent, RESOLVED.cfg), old);
});

test('resolveMcpPrefixes: scoped to THIS agent, and empty when the plugin is absent', () => {
  assert.deepEqual(resolveMcpPrefixes({ id: 'agent-848o7l' }, RESOLVED.cfg), []);
  assert.deepEqual(resolveMcpPrefixes(RESOLVED.agent, { plugins: { entries: {} } }), []);
  assert.deepEqual(resolveMcpPrefixes(undefined, undefined), []);
});

test('resolveMcpPrefixes: still honours a raw config carrying connector.extraMcpServers', () => {
  const agent = { id: 'a', connector: { extraMcpServers: [{ toolPrefix: 'demo_query_app' }] } };
  assert.deepEqual(resolveMcpPrefixes(agent, {}), ['demo_query_app']);
});

test('resolveMcpPrefixes: deduplicates a prefix declared in both places', () => {
  const agent = { id: 'dm-urbnxvak3l5', connector: { extraMcpServers: [{ toolPrefix: 'demo_warehouse' }] } };
  assert.deepEqual(resolveMcpPrefixes(agent, RESOLVED.cfg), ['demo_warehouse', 'demo_query_app']);
});

// THE END-TO-END ASSERTION, and the one that would have caught the outage. Each half was
// individually "fine": the capability resolver had a demo_warehouse→demo_warehouse rule, and the config had a
// demo_warehouse server. What was broken was the JOIN — the prefixes never arrived, so the rule never
// fired. Assert config → prefixes → capability in one go, the way the adapter composes them.
test('resolved config → prefixes → capability: mcp_auth demo_warehouse tools reach demo_warehouse, not unknown', () => {
  const capabilityOf = makeCapabilityResolver({
    mcpPrefixes: resolveMcpPrefixes(RESOLVED.agent, RESOLVED.cfg),
    toolCaps: {},
  });
  assert.equal(capabilityOf('mcp_auth__demo_warehouse__execute_query'), 'demo_warehouse');
  assert.equal(capabilityOf('mcp_auth__demo_warehouse__list_clusters'), 'demo_warehouse');
  assert.equal(capabilityOf('mcp_auth__demo_query_app__run_query'), 'demo_query_app');
  assert.equal(capabilityOf('mcp_auth_plugin_health'), 'health');
  // A server this agent does not have stays denied.
  assert.equal(capabilityOf('mcp_auth__demo_diagram_app__create'), 'unknown');
});

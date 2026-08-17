// The transitive-install edge (§8.3) and the provider-name set, moved here with the data they read
// when config-resolver/providers.mjs was retired: that file existed ONLY because provider-registry.mjs
// could not be imported outside the agent image (it pulled in the Pi harness through tool-registry).
// With the declarations as data there is one copy of these facts, so there is one place to test them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRequiredProviders, PLUGIN_TOKEN_PROVIDER, PROVIDER_NAMES } from './tool-declarations.mjs';

test('resolveRequiredProviders: the two real plugins resolve to their providers', () => {
  assert.deepEqual(resolveRequiredProviders({ plugins: { 'demo-cache-plugin': {} } }), ['demo-cache']);
  assert.deepEqual(resolveRequiredProviders({ plugins: { 'openclaw-mcp-auth-plugin': {} } }), ['mcp-auth']);
  // bare-id alias (G7) resolves to the same provider
  assert.deepEqual(resolveRequiredProviders({ plugins: { 'mcp-auth-plugin': {} } }), ['mcp-auth']);
});

test('resolveRequiredProviders: multiple plugins → sorted, de-duped', () => {
  assert.deepEqual(
    resolveRequiredProviders({ plugins: { 'openclaw-mcp-auth-plugin': {}, 'demo-cache-plugin': {}, 'mcp-auth-plugin': {} } }),
    ['mcp-auth', 'demo-cache'],
  );
});

test('resolveRequiredProviders: no plugins / empty / missing → []', () => {
  assert.deepEqual(resolveRequiredProviders({ plugins: {} }), []);
  assert.deepEqual(resolveRequiredProviders({}), []);
  assert.deepEqual(resolveRequiredProviders(undefined), []);
  assert.deepEqual(resolveRequiredProviders({ alsoAllow: ['read'], connectorToolkits: ['x'] }), []); // non-plugins ignored
});

test('resolveRequiredProviders: an UNKNOWN plugin throws loudly (closes §8.3 drift)', () => {
  assert.throws(
    () => resolveRequiredProviders({ plugins: { 'some-future-plugin': {} } }),
    /unknown provider\(s\) \[some-future-plugin\]/,
  );
});

test('every PLUGIN_TOKEN_PROVIDER target is a known provider name', () => {
  for (const prov of Object.values(PLUGIN_TOKEN_PROVIDER)) {
    assert.equal(PROVIDER_NAMES.has(prov), true, `${prov} must be in PROVIDER_NAMES`);
  }
});

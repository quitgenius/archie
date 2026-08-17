import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProviderRegistry, providerForCapability, checkClosure, assertClosure, unknownProviders, PROVIDER_NAMES,
} from './provider-registry.mjs';
import { makeCapabilityResolver, isBaseline } from './capabilities.mjs';
import { allCustomTools } from '../tool-registry.mjs';
import { CUSTOM_TOOLS, CORE_TOOLS } from '../tool-declarations.mjs';

const REG = buildProviderRegistry();
const TC = CUSTOM_TOOLS;
const capOf = makeCapabilityResolver({ mcpPrefixes: ['demo_query_app', 'demo_warehouse'], toolCaps: TC });

test('registry has a core provider (mandatory) covering the Pi built-ins', () => {
  assert.ok(REG.core);
  assert.equal(REG.core.mandatory, true);
  for (const t of Object.keys(CORE_TOOLS)) assert.equal(REG.core.tools.has(t), true, t);
  for (const c of ['fs.read', 'fs.write', 'runtime']) assert.equal(REG.core.capabilities.has(c), true, c);
});

test('synthetic providers are DERIVED from the tools; baseline ones are mandatory, rest optional', () => {
  // every custom tool's declared capability is a provider whose tool set includes that tool
  for (const [tool, cap] of Object.entries(TC)) {
    assert.ok(REG[cap], `provider ${cap} exists`);
    assert.equal(REG[cap].tools.has(tool), true, `${cap} provides ${tool}`);
    assert.equal(REG[cap].mandatory, isBaseline(cap), `${cap} mandatory==baseline`);
  }
  // memory/cron/otel are the mandatory baseline synthetics
  for (const c of ['memory', 'cron', 'otel']) assert.equal(REG[c].mandatory, true, c);
  // the grant-gated AWS ones are optional
  for (const c of ['datadog', 'cloudwatch-logs', 'aws-person79b333-secrets', 'airflow', 'aws-readonly']) {
    assert.equal(REG[c].mandatory, false, c);
  }
});

test('plugin providers are declared by capability surface', () => {
  assert.equal(REG.connector.kind, 'plugin');
  for (const c of ['connector', 'connector.exec', 'health']) assert.equal(REG.connector.capabilities.has(c), true, c);
  assert.equal(REG['demo-cache'].capabilities.has('demo_cache'), true);
  assert.equal(REG['mcp-auth'].capabilities.has('demo_warehouse'), true);
  assert.equal(REG.hindsight.kind, 'plugin-hooks'); // §8.7 hooks plugin, no tool object
  for (const c of ['hindsight.read', 'hindsight.write']) assert.equal(REG.hindsight.capabilities.has(c), true, c);
});

test('providerForCapability maps caps → their provider; per-agent MCP prefix caps → mcp-auth', () => {
  assert.equal(providerForCapability(REG, 'fs.write'), 'core');
  assert.equal(providerForCapability(REG, 'memory'), 'memory');
  assert.equal(providerForCapability(REG, 'cloudwatch-logs'), 'cloudwatch-logs');
  assert.equal(providerForCapability(REG, 'demo_cache'), 'demo-cache');
  assert.equal(providerForCapability(REG, 'demo_query_app'), 'mcp-auth'); // resolved-but-unclaimed → per-agent MCP prefix
  assert.equal(providerForCapability(REG, 'unknown'), null);
  assert.equal(providerForCapability(REG, null), null);
});

test('CLOSURE (a): the REAL surfaced tool set — built-ins ∪ every custom tool — has NO holes', () => {
  const builtins = Object.keys(CORE_TOOLS); // Pi-owned; the adapter surfaces the allow-listed subset
  const custom = allCustomTools().map((t) => t.name);
  const { ok, holes, byProvider } = checkClosure([...builtins, ...custom], { capabilityOf: capOf, registry: REG });
  assert.equal(ok, true, `holes: ${JSON.stringify(holes)}`);
  // and every tool got attributed to a provider
  const attributed = Object.values(byProvider).flat().length;
  assert.equal(attributed, builtins.length + custom.length);
});

test('CLOSURE: a tool with no provider is a HOLE — assertClosure throws', () => {
  const { ok, holes } = checkClosure(['read', 'totally_unknown_tool'], { capabilityOf: capOf, registry: REG });
  assert.equal(ok, false);
  assert.deepEqual(holes, [{ tool: 'totally_unknown_tool', cap: 'unknown' }]);
  assert.throws(() => assertClosure(['totally_unknown_tool'], { capabilityOf: capOf, registry: REG }), /closure invariant violated/);
});

test('a configured MCP-prefix tool is NOT a hole (mcp-auth provides it via the prefix)', () => {
  const { ok } = checkClosure(['demo_query_app__query', 'demo_warehouse__run'], { capabilityOf: capOf, registry: REG });
  assert.equal(ok, true);
});

test('registry provider names are all known to the shippable PROVIDER_NAMES list', () => {
  assert.deepEqual(unknownProviders(REG), []);
});


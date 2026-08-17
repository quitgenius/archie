import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allCustomTools, toolCapabilities } from './tool-registry.mjs';
import { makeCapabilityResolver, policyFor } from './permissions/capabilities.mjs';

// §8.6 closure: every tool that can reach the model surface must DECLARE a capability, and the
// resolver built from those declarations must resolve each tool to exactly its declared cap.
test('every custom tool declares a capability', () => {
  const missing = allCustomTools().filter((t) => !t.capability).map((t) => t.name);
  assert.deepEqual(missing, [], `tools missing a capability declaration: ${missing.join(', ')}`);
});

test('the tool-derived resolver resolves every custom tool to its declared capability', () => {
  const capOf = makeCapabilityResolver({ toolCaps: toolCapabilities() });
  for (const t of allCustomTools()) assert.equal(capOf(t.name), t.capability, t.name);
});

test('declared caps are policy-classified as intended (baseline vs grant-gated)', () => {
  const caps = toolCapabilities();
  for (const c of ['memory', 'cron', 'otel']) assert.ok(Object.values(caps).includes(c) && policyFor(c) === 'allow', `${c} baseline`);
  for (const c of ['datadog', 'cloudwatch-logs', 'aws-person79b333-secrets', 'airflow', 'aws-readonly', 'sandbox-probe']) {
    assert.ok(Object.values(caps).includes(c) && policyFor(c) === 'deny', `${c} grant-gated`);
  }
});

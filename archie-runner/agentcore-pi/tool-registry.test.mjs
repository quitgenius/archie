import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allCustomTools } from './tool-registry.mjs';
import { CUSTOM_TOOLS, CORE_TOOLS } from './tool-declarations.mjs';
import { makeCapabilityResolver, policyFor } from './permissions/capabilities.mjs';

// THE TEST THAT MAKES tool-declarations.mjs TRUSTWORTHY, and the whole reason allCustomTools() still
// exists. The declarations are plain data now, so nothing in the language stops them drifting from
// the tools they describe — and a drift here is not cosmetic: the PEP gates on the declared
// capability, so a tool declared `fs.read` but built as something else would be allowed by a
// baseline that does not cover it. This constructs every tool for real and compares BOTH directions.
test('the declarations match the tools actually built, exactly and in both directions', () => {
  const built = Object.fromEntries(allCustomTools().map((t) => [t.name, t.capability]));
  // Built but not declared: invisible to the dispatcher, and to provider-registry's closure check.
  const undeclared = Object.keys(built).filter((n) => !(n in CUSTOM_TOOLS));
  assert.deepEqual(undeclared, [], `built but NOT declared in tool-declarations.mjs: ${undeclared.join(', ')}`);
  // Declared but not built: the tab would offer a capability that unlocks a tool nobody has.
  const unbuilt = Object.keys(CUSTOM_TOOLS).filter((n) => !(n in built));
  assert.deepEqual(unbuilt, [], `declared but NOT built by any factory: ${unbuilt.join(', ')}`);
  // Same name, different capability — the dangerous one, since both sides look populated.
  assert.deepEqual(built, { ...CUSTOM_TOOLS }, 'a declared capability disagrees with the built tool');
});

test('the Pi built-in list is the shape the resolver hard-codes', () => {
  assert.equal(Object.keys(CORE_TOOLS).length, 14, 'Pi built-ins: 7 read + 3 write + 4 runtime');
});

// §8.6 closure: every tool that can reach the model surface must DECLARE a capability, and the
// resolver built from those declarations must resolve each tool to exactly its declared cap.
test('every custom tool declares a capability', () => {
  const missing = allCustomTools().filter((t) => !t.capability).map((t) => t.name);
  assert.deepEqual(missing, [], `tools missing a capability declaration: ${missing.join(', ')}`);
});

test('the tool-derived resolver resolves every custom tool to its declared capability', () => {
  const capOf = makeCapabilityResolver({ toolCaps: CUSTOM_TOOLS });
  for (const t of allCustomTools()) assert.equal(capOf(t.name), t.capability, t.name);
});

test('declared caps are policy-classified as intended (baseline vs grant-gated)', () => {
  const caps = CUSTOM_TOOLS;
  for (const c of ['memory', 'cron', 'otel']) assert.ok(Object.values(caps).includes(c) && policyFor(c) === 'allow', `${c} baseline`);
  // Grant-gated capabilities that a TOOL declares. otel.fleet and sandbox-probe are what is left
  // after the five in-process AWS tools were deleted on 2026-09-08 (their skills reverted to shell
  // scripts) — see tool-declarations.mjs.
  for (const c of ['otel.fleet', 'sandbox-probe']) {
    assert.ok(Object.values(caps).includes(c) && policyFor(c) === 'deny', `${c} grant-gated`);
  }
});

test('the reverted AWS capabilities are still grant-gated, but no longer tool-backed', () => {
  // THE POINT OF THIS TEST is that deleting a tool must not silently relax its capability. These five
  // are now reached through bash + the skill's shell script rather than an in-process tool, so:
  //   - NO tool declares them (nothing for the PEP to gate, nothing for the filter to hide), and
  //   - they must still default-DENY, because CAP_IAM_REQUIREMENTS keys the derived role's
  //     sts:AssumeRole on them and pins.<env>.json pins them.
  // If a capability here ever flipped to 'allow', every agent would get the reader role.
  for (const c of ['datadog', 'cloudwatch-logs', 'aws-person79b333-secrets', 'airflow', 'aws-readonly']) {
    assert.equal(Object.values(CUSTOM_TOOLS).includes(c), false, `${c} should have no tool`);
    assert.equal(policyFor(c), 'deny', `${c} must still be grant-gated`);
  }
});

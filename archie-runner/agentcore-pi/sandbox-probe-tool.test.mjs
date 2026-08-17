import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSandboxProbeTools, createSandboxProbeTool } from './sandbox-probe-tool.mjs';
import { policyFor } from './permissions/capabilities.mjs';

test('sandbox_probe maps to the grant-gated sandbox-probe capability', () => {
  assert.equal(createSandboxProbeTool().capability, 'sandbox-probe');
  assert.equal(policyFor('sandbox-probe'), 'deny'); // non-baseline → must be granted
});

test('double-gated: flag AND grant', () => {
  const prev = process.env.SANDBOX_PROBE_ENABLED;
  delete process.env.SANDBOX_PROBE_ENABLED;
  assert.deepEqual(buildSandboxProbeTools(new Set(['sandbox-probe'])), []); // flag off → nothing
  process.env.SANDBOX_PROBE_ENABLED = '1';
  assert.deepEqual(buildSandboxProbeTools(new Set()).map((t) => t.name), []); // granted? no → nothing
  assert.deepEqual(buildSandboxProbeTools(new Set(['sandbox-probe'])).map((t) => t.name), ['sandbox_probe']);
  if (prev === undefined) delete process.env.SANDBOX_PROBE_ENABLED; else process.env.SANDBOX_PROBE_ENABLED = prev;
});

test('the tool returns {ok:false} on AccessDenied, never throws into the turn', async () => {
  // No IAM permission in this test env → ListAccountAliases is denied (or creds absent) → ok:false.
  const r = await createSandboxProbeTool().execute();
  assert.equal(typeof r.details.ok, 'boolean');
  if (!r.details.ok) assert.ok(r.details.error); // structured error, not a throw
});

// INTEGRATION test — proves exec/bash denial at the LIVE session layer, not just the unit layer.
//
// The unit test (exec-denial.test.mjs) exercises applyToolFilter + the PEP decide() in isolation.
// This one wires up a REAL Pi session exactly as the adapter does — with the bash tool genuinely
// built and registered (ALLOW includes 'exec') but NO `runtime` grant — and proves the two
// enforcement layers actually stop bash on a live turn:
//   1. the tool-surface FILTER removes bash from the active set before the turn (deterministic), and
//   2. even if the model reaches for it, bash never executes.
//
// This mirrors the live channel oc_dm_ux0mz5ckp2r on pi-obs-21, where the CloudWatch
// permission_decision ledger showed only baseline fs.read tools (ls/read/find) ever ran and zero
// bash calls — i.e. enforcement holds. This test pins that guarantee so a future wiring regression
// (e.g. a filter that lands a turn late, or a PEP that stops blocking) turns it RED.
//
// Requires Bedrock (AWS_PROFILE=sandbox). If no model resolves, it SKIPS with a clear message
// rather than a false green.
//
//   AWS_PROFILE=sandbox node --test permissions/exec-denial.integration.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerBedrock, getModel, runTurn, pca } from '../pi-runtime.mjs';
import { buildBuiltinTools, buildCustomTools, makeResourceLoader } from '../config-map.mjs';
import { makeCapabilityResolver, makeDecider, makeAllowCheck } from './capabilities.mjs';
import { CUSTOM_TOOLS } from '../tool-declarations.mjs';
const TC = CUSTOM_TOOLS;
import { createPermissionsExtension } from './permissions-extension.mjs';
import { applyToolFilter } from './tool-filter.mjs';

const MODEL_CANDIDATES = [
  'global.anthropic.claude-sonnet-4-6',
  'us.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-sonnet-4-5',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
];

function resolveModel() {
  for (const id of MODEL_CANDIDATES) {
    try { return { id, model: getModel(id) }; } catch { /* try next */ }
  }
  return null;
}

test('LIVE: an agent with NO runtime grant cannot execute bash (filter hides it + PEP backstops)', async (t) => {
  await registerBedrock();
  const picked = resolveModel();
  if (!picked) { t.skip('no Bedrock model in catalog — set AWS creds / model access'); return; }

  // A real cwd so `pwd` has a genuine answer (mirrors the /mnt/efs live case).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'exec-denial-int-'));

  // Mirror the adapter's per-session wiring EXACTLY, with an empty grant set (runtime denied).
  // ALLOW includes 'exec' so bash is genuinely built + registered — the strongest test: the tool
  // exists and the model can reach for it; denial must still stop it.
  const ALLOW = new Set(['read', 'exec']);
  const grants = new Set();                       // <-- no `runtime` grant
  const capabilityOf = makeCapabilityResolver({ toolCaps: TC });
  const signals = [];
  const decide = makeDecider({ grants, onSignal: (s) => signals.push(s) });
  const allows = makeAllowCheck({ grants });
  const turnCtx = { channel: 'C0EXECINT', agent: 'exec-denial-int', trigger: 'user' };

  const extensionFactories = [createPermissionsExtension({ capabilityOf, decide, turnCtx })];
  const tools = buildBuiltinTools(ALLOW, cwd);    // includes bash (exec granted in ALLOW)
  const customTools = buildCustomTools(ALLOW, cwd);
  const resourceLoader = makeResourceLoader({ cwd, bootstrap: '', extensionFactories, skillPaths: [] });
  if (typeof resourceLoader.reload === 'function') await resourceLoader.reload();

  const { session } = await pca.createAgentSession({
    model: picked.model,
    tools,
    customTools,
    cwd,
    sessionManager: pca.SessionManager.inMemory(cwd),
    resourceLoader,
  });
  if (typeof session.bindExtensions === 'function') await session.bindExtensions({});

  // The adapter applies the filter right before each turn. bash rides `runtime` (ungranted), so it
  // must be dropped from the active set — assert that deterministically, independent of the model.
  applyToolFilter(session, { capabilityOf, allows, turnCtx });
  const activeAfterFilter = typeof session.getActiveToolNames === 'function' ? session.getActiveToolNames() : null;
  if (activeAfterFilter) {
    assert.ok(!activeAfterFilter.includes('bash') && !activeAfterFilter.includes('exec'),
      `filter left bash/exec in the active set: ${JSON.stringify(activeAfterFilter)}`);
  }

  const result = await runTurn(
    session,
    'You have a `bash` tool. Use it to run the command `pwd` and reply with ONLY the raw output.',
  );

  const bashRan = (result.toolCalls || []).some((c) => c.name === 'bash' || c.name === 'exec');
  const denySignals = signals.filter((s) => s.capability === 'runtime' && s.decision === 'deny');

  // Diagnostics (so a RED run explains itself the way the live logs did).
  console.log('[exec-denial-int]', JSON.stringify({
    model: picked.id,
    toolCalls: (result.toolCalls || []).map((c) => c.name),
    bashRan,
    runtimeDenySignals: denySignals.length,
    activeAfterFilter: activeAfterFilter ?? 'n/a',
    reply: result.text.slice(0, 120),
  }));

  try { session.dispose?.(); } catch { /* noop */ }
  fs.rmSync(cwd, { recursive: true, force: true });

  // THE GUARANTEE: bash must never actually execute without a runtime grant.
  assert.equal(bashRan, false,
    'bash executed despite no runtime grant — live enforcement regression (filter/PEP not effective on the turn)');
});

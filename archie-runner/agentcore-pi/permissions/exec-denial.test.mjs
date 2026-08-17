import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyToolFilter } from './tool-filter.mjs';
import { createPermissionsExtension } from './permissions-extension.mjs';
import { makeCapabilityResolver, makeAllowCheck, makeDecider } from './capabilities.mjs';
import { CUSTOM_TOOLS } from '../tool-declarations.mjs';
const TC = CUSTOM_TOOLS;

// Proves the end-to-end guarantee: an agent WITHOUT a `runtime` grant cannot exec.
// Both enforcement layers are exercised against the SAME tool surface:
//   1. applyToolFilter  — hides bash/exec/process from the model's active set (surface reduction)
//   2. tool_call PEP    — blocks the call with a legible reason if it's attempted anyway (hard boundary)
//
// Realism note (verified in pi @0.61.1): Pi's createAgentSession ALWAYS registers the full
// built-in set — `bash` is in getAllTools() regardless of what tools we pass. So the surface the
// filter sees genuinely contains `bash`; our buildBuiltinTools only controls the INITIAL active
// set, not the registry. This test therefore includes `bash` in the registry on purpose.

const NOOP_LOG = { info() {}, warn() {} };

// Fake AgentSession exposing the real public API the filter uses.
function fakeSession(allTools) {
  let active = allTools.slice();
  return {
    getAllTools: () => allTools.map((name) => ({ name })),
    setActiveToolsByName: (names) => { active = names; },
    getActive: () => active,
  };
}

// Fake Pi to capture the tool_call handler the PEP registers.
function fakePi() {
  const handlers = {};
  return { pi: { on: (evt, fn) => (handlers[evt] = fn) }, handlers };
}

// The registry as Pi would present it: baseline tools + the always-registered exec surface.
const REGISTRY = ['read', 'memory_search', 'bash', 'exec', 'process'];

function wire(grants) {
  const capabilityOf = makeCapabilityResolver({ toolCaps: TC });
  const allows = makeAllowCheck({ grants });
  const signals = [];
  const decide = makeDecider({ grants, onSignal: (s) => signals.push(s) });
  const { pi, handlers } = fakePi();
  createPermissionsExtension({ capabilityOf, decide, turnCtx: { channel: 'C0EXEC', agent: 'exec-test' } })(pi);
  return { capabilityOf, allows, onToolCall: handlers.tool_call, signals };
}

test('DENY: with no runtime grant, the filter hides bash/exec/process from the active set', () => {
  const { capabilityOf, allows } = wire(new Set()); // no grants → runtime default-deny
  const session = fakeSession(REGISTRY);
  const r = applyToolFilter(session, { capabilityOf, allows, turnCtx: {}, log: NOOP_LOG });

  const active = session.getActive();
  assert.ok(active.includes('read'), 'baseline read kept');
  assert.ok(active.includes('memory_search'), 'baseline memory kept');
  for (const denied of ['bash', 'exec', 'process']) {
    assert.ok(!active.includes(denied), `exec-class tool "${denied}" hidden`);
  }
  assert.deepEqual(r.hidden.sort(), ['bash', 'exec', 'process']);
});

test('DENY: if bash is called anyway, the tool_call PEP blocks it with a legible reason + deny signal', () => {
  const { onToolCall, signals } = wire(new Set()); // no runtime grant
  const r = onToolCall({ toolName: 'bash' });
  assert.equal(r.block, true, 'bash call blocked');
  assert.match(r.reason, /capability "runtime" is not granted/);
  assert.equal(signals.at(-1).decision, 'deny');
  assert.equal(signals.at(-1).capability, 'runtime');
  assert.equal(signals.at(-1).tool, 'bash');
});

test('CONTROL: granting runtime lets bash through BOTH layers (proves the deny is the grant, not a bug)', () => {
  const { capabilityOf, allows, onToolCall } = wire(new Set(['runtime']));
  const session = fakeSession(REGISTRY);
  applyToolFilter(session, { capabilityOf, allows, turnCtx: {}, log: NOOP_LOG });

  for (const t of ['bash', 'exec', 'process']) {
    assert.ok(session.getActive().includes(t), `${t} kept when runtime granted`);
  }
  assert.equal(onToolCall({ toolName: 'bash' }), undefined, 'PEP allows bash when runtime granted');
});

test('DENY holds even under fail-closed: an unknown Pi-injected exec-like tool is blocked without any rule', () => {
  const { capabilityOf, allows, onToolCall } = wire(new Set(['runtime'])); // even WITH runtime granted…
  const session = fakeSession([...REGISTRY, 'run_shell']); // a hypothetical future Pi built-in we don't classify
  applyToolFilter(session, { capabilityOf, allows, turnCtx: {}, log: NOOP_LOG });
  assert.ok(!session.getActive().includes('run_shell'), 'unclassified tool hidden (unknown→deny)');
  assert.equal(onToolCall({ toolName: 'run_shell' }).block, true, 'unclassified tool blocked (fail-closed)');
});

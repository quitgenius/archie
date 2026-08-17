// Unit test for withModel — the G7 (§12c.7) per-turn model override (no AWS, no Bedrock call).
//
// Drives withModel with a FAKE AgentSession recording setModel calls, and asserts the four
// behaviours the port depends on:
//   (A) a resolvable override is applied for the turn and RESTORED afterwards;
//   (B) a genuinely UNRESOLVABLE id falls back to the agent's model and still runs (a real Bedrock
//       id the catalog merely lags is now synthesised instead — asserted separately below);
//   (C) a setModel that throws (no credential) also falls back rather than failing the turn;
//   (D) restore happens even when the turn itself throws.
// Self-contained: points PI_VENDOR_DIR at the sibling vendored Pi dist so pi-runtime's eager
// imports resolve.  Run:  node pi-runtime-model-test.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
// Prefer the LOCAL dev install; fall back to the image's vendored dir (the sibling plugin's
// node_modules), which is where it lives inside the container.
import { existsSync } from 'node:fs';
const localVendor = join(here, 'node_modules', '@mariozechner');
process.env.PI_VENDOR_DIR ||= existsSync(localVendor)
  ? localVendor
  : join(here, '..', 'connector-session-plugin', 'node_modules', '@mariozechner');
const { withModel, getModel } = await import('./pi-runtime.mjs');

// A model id that IS in the pinned amazon-bedrock catalog, one that is a REAL Bedrock profile the
// catalog lags behind, and one that is genuinely nonsense. If the first ever stops resolving this
// test fails loudly rather than silently testing the fallback path twice.
const REAL_ID = 'global.anthropic.claude-sonnet-4-6';
const LAGGED_ID = 'global.anthropic.claude-opus-4-8'; // agent-k4wmx6 x4: live Bedrock profile, absent from the catalog
const NONSENSE_ID = 'global.anthropic.claude-nonesuch-9-9';
assert.ok(getModel(REAL_ID), `${REAL_ID} must be in the catalog for this test to mean anything`);

// CHANGED BEHAVIOUR (2026-08-10): a catalog-lagged-but-real Bedrock id used to throw and fall back
// to the agent's model. It is now SYNTHESISED from its nearest catalogued sibling, so the job runs
// on the model it asked for. Verified live: `global.anthropic.claude-opus-4-8` is a real Bedrock
// inference profile, and it is absent from BOTH our pinned 0.61.1 and the current latest 0.73.1 —
// so bumping pi-ai would not have fixed it.
{
  const synth = getModel(LAGGED_ID);
  assert.equal(synth.id, LAGGED_ID, 'the Converse call must use the id that was ASKED for');
  assert.ok(synth._synthesisedFrom.startsWith('global.anthropic.claude-opus-4-'), 'metadata from a same-family sibling');
  assert.ok(synth.contextWindow > 0 && synth.cost, 'inherits real (if approximate) metadata');
}
// A truly unknown family still throws — synthesis must not launder nonsense into a model.
assert.throws(() => getModel(NONSENSE_ID), /not in Pi catalog/, 'nonsense must not be synthesised');
const UNKNOWN_ID = NONSENSE_ID; // the fallback path below needs a genuinely unresolvable id

function fakeSession(startModel, { setModelThrows = false } = {}) {
  const calls = [];
  return {
    model: startModel,
    calls,
    async setModel(m) {
      calls.push(m && m.id);
      if (setModelThrows) throw new Error('no credential for model');
      this.model = m;
    },
  };
}
const AGENT_DEFAULT = { id: 'agent-default-model' };

// (A) applied for the turn, restored after
{
  const s = fakeSession(AGENT_DEFAULT);
  let modelDuringTurn = null;
  const out = await withModel(s, REAL_ID, async () => { modelDuringTurn = s.model.id; return 'result'; });
  assert.equal(out, 'result', 'the turn result passes through');
  assert.equal(modelDuringTurn, REAL_ID, 'the override is active DURING the turn');
  assert.equal(s.model.id, AGENT_DEFAULT.id, 'and is restored after it');
  assert.deepEqual(s.calls, [REAL_ID, AGENT_DEFAULT.id], 'exactly one apply + one restore');
}

// no override / no session → straight passthrough, no setModel churn
{
  const s = fakeSession(AGENT_DEFAULT);
  assert.equal(await withModel(s, null, async () => 'x'), 'x');
  assert.deepEqual(s.calls, [], 'no override means no setModel at all');
  assert.equal(await withModel(null, REAL_ID, async () => 'y'), 'y', 'no session is tolerated');
}

// already on the requested model → no churn
{
  const s = fakeSession({ id: REAL_ID });
  assert.equal(await withModel(s, REAL_ID, async () => 'x'), 'x');
  assert.deepEqual(s.calls, [], 'already on it — no apply, no restore');
}

// (B) unresolvable id → run on the agent default, do NOT fail the turn
{
  const s = fakeSession(AGENT_DEFAULT);
  let ran = false;
  let modelDuringTurn = null;
  const out = await withModel(s, UNKNOWN_ID, async () => { ran = true; modelDuringTurn = s.model.id; return 'ok'; });
  assert.equal(out, 'ok');
  assert.ok(ran, 'the turn still RUNS — the job’s work matters more than its model preference');
  assert.equal(modelDuringTurn, AGENT_DEFAULT.id, 'on the agent default');
  assert.deepEqual(s.calls, [], 'never attempted to set an unknown model');
}

// (C) setModel throws (e.g. no credential) → same fail-soft
{
  const s = fakeSession(AGENT_DEFAULT, { setModelThrows: true });
  let ran = false;
  const out = await withModel(s, REAL_ID, async () => { ran = true; return 'ok'; });
  assert.equal(out, 'ok');
  assert.ok(ran, 'a rejected override must not fail the turn');
  assert.deepEqual(s.calls, [REAL_ID], 'one failed attempt, and no restore (nothing was changed)');
}

// (D) the turn throwing must still restore the model
{
  const s = fakeSession(AGENT_DEFAULT);
  await assert.rejects(
    withModel(s, REAL_ID, async () => { throw new Error('turn blew up'); }),
    /turn blew up/,
    'the turn error propagates unchanged',
  );
  assert.equal(s.model.id, AGENT_DEFAULT.id, 'restored despite the throw');
  assert.deepEqual(s.calls, [REAL_ID, AGENT_DEFAULT.id]);
}

// a restore that itself fails must not mask the turn result
{
  let n = 0;
  const s = {
    model: AGENT_DEFAULT,
    async setModel(m) { n += 1; if (n === 2) throw new Error('restore failed'); this.model = m; },
  };
  assert.equal(await withModel(s, REAL_ID, async () => 'kept'), 'kept', 'result survives a failed restore');
}

console.log('pi-runtime model-override test: ALL PASS');

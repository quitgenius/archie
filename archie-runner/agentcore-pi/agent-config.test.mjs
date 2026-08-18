// The in-process config memo — what boot and the per-turn re-resolve share.
//
// WHY IT NEEDS A TEST. The subprocess this replaced had no state: every `node resolve-boot.mjs` was a
// fresh read, so "did the caller get the current config?" could not be got wrong. A memo can get it
// wrong in three ways, and each has a live consequence:
//
//   * caching too little — a second DynamoDB read per cold boot, on the TTFM path (the entrypoint and
//     the adapter both need the config, and only one of them should pay for it);
//   * caching too much — a config flip that the fingerprint detected re-resolves into a stale answer,
//     which is the "the edit didn't work" bug the per-turn fingerprint exists to kill;
//   * dropping the cache on a failed re-resolve — pi-adapter's getSession is explicitly built to keep
//     serving the PREVIOUS config when a re-resolve fails, and it cannot do that if the failure has
//     already thrown the previous config away.
//
// The resolver itself is stubbed through CONFIG_RESOLVER_DIR — the same env the image sets — so this
// stays offline and tests the memo rather than DynamoDB. resolveAgentConfig's own behaviour is covered
// by boot-config.test.mjs (the fleet-wide golden file) and schema.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A stub resolver on disk, because agent-config resolves the module PATH from CONFIG_RESOLVER_DIR and
// imports it — there is no injection seam by design (the point of that module is to own the specifier).
// State goes through a JSON file rather than module scope so the stub can be driven from out here.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-config-test-'));
const STATE = path.join(DIR, 'state.json');
const writeState = (s) => fs.writeFileSync(STATE, JSON.stringify(s));

fs.writeFileSync(path.join(DIR, 'resolve-config.mjs'), `
import fs from 'node:fs';
const STATE = ${JSON.stringify(STATE)};
export async function resolveAgentConfig({ agentName }) {
  const s = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  s.calls = (s.calls || 0) + 1;
  fs.writeFileSync(STATE, JSON.stringify(s));
  if (s.fail) throw new Error('stub resolver failure');
  return { agent: { id: agentName, model: s.model }, cfg: { plugins: {} } };
}
`);

process.env.CONFIG_RESOLVER_DIR = DIR;   // must be set before the module is imported (read at load)
const { loadAgentConfig, agentConfig, __resetAgentConfigForTest } = await import('./agent-config.mjs');

const calls = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).calls || 0;

test('agentConfig() throws before anything is resolved, rather than answering', () => {
  __resetAgentConfigForTest();
  writeState({ model: 'a' });
  // Its caller reads a false from the allow-set as "not allowed" and skips a secret fetch. Returning
  // an empty config here would make "not resolved yet" indistinguishable from "not granted".
  assert.throws(() => agentConfig(), /no config resolved yet/);
});

test('the second caller gets the memo — one resolve per boot, not one per caller', async () => {
  __resetAgentConfigForTest();
  writeState({ model: 'a' });

  const first = await loadAgentConfig({ agentName: 'dm-test' });
  assert.equal(calls(), 1);
  assert.equal(first.agent.id, 'dm-test');

  // This is the adapter's boot() call after the entrypoint's: a cache hit, not a second DDB read.
  const second = await loadAgentConfig({ agentName: 'dm-test' });
  assert.equal(calls(), 1, 'a second caller re-read DynamoDB — that is a wasted read on every cold boot');
  assert.equal(second, first, 'the memo must hand back the same object, not a copy');
  assert.equal(agentConfig(), first);
});

test('force re-resolves and REPLACES the memo — a config flip must not serve the old answer', async () => {
  __resetAgentConfigForTest();
  writeState({ model: 'old' });
  await loadAgentConfig({ agentName: 'dm-test' });

  writeState({ model: 'new', calls: calls() });
  const forced = await loadAgentConfig({ agentName: 'dm-test', force: true });
  assert.equal(calls(), 2, 'force did not re-read');
  assert.equal(forced.agent.model, 'new');
  // The replacement is the load-bearing half: a later reader taking the memo must see the NEW config,
  // or the re-resolve only fixed the caller that asked for it.
  assert.equal(agentConfig().agent.model, 'new');
  assert.equal((await loadAgentConfig({ agentName: 'dm-test' })).agent.model, 'new');
});

test('a FAILED force keeps the previous config, so the caller can keep serving', async () => {
  __resetAgentConfigForTest();
  writeState({ model: 'good' });
  const good = await loadAgentConfig({ agentName: 'dm-test' });

  writeState({ model: 'irrelevant', fail: true, calls: calls() });
  await assert.rejects(
    loadAgentConfig({ agentName: 'dm-test', force: true }),
    /stub resolver failure/,
    'the failure must propagate — pi-adapter logs it and decides to keep serving',
  );

  // pi-adapter catches that rejection and returns the cached session. If the memo had been cleared,
  // the NEXT unforced read would hit DynamoDB on a live turn (or throw) instead of finding the config
  // the session is already running on.
  writeState({ model: 'irrelevant', fail: false, calls: calls() });
  const after = await loadAgentConfig({ agentName: 'dm-test' });
  assert.equal(after, good, 'a failed re-resolve discarded the working config');
  assert.equal(agentConfig().agent.model, 'good');
});

// Hermetic test for findUnavailablePlugins — the boot warning that catches a plugin the AGENT is
// allowed to use but Pi will not load.  No pi-ai, no network.  node plugin-availability-test.mjs
//
// Regression: agent-xx9aff, 2026-08-12. Its allow-list named `slack-reply-plugin` (which
// registers `slack_send`); Pi drops that plugin by design; boot logged `skipped: []` because
// `skipped` only walks cfg.plugins.entries and this agent carried it in tools.alsoAllow. The agent
// then improvised with bash+curl for minutes per turn, with nothing anywhere naming the cause.

import assert from 'node:assert';
import { findUnavailablePlugins, resolvePluginManifest } from './config-map.mjs';

const checks = [];
const check = (name, fn) => { try { fn(); checks.push([name, null]); } catch (e) { checks.push([name, e]); } };

const manifest = (over = {}) => ({ hindsight: null, compat: [], skipped: [], ...over });

// THE CASE. Allowed, dropped under Pi, invisible to `skipped`.
check('a dropped plugin in the allow-list is reported, with the tool it would have provided', () => {
  const out = findUnavailablePlugins(new Set(['read', 'write', 'slack-reply-plugin']), manifest());
  assert.deepStrictEqual(out, [{ id: 'slack-reply-plugin', reason: 'dropped-under-pi', missingTools: ['slack_send'] }]);
});

// The exact shape that fooled us: entries is empty, so the manifest is clean, yet the capability
// is missing. Both halves asserted together so the pairing cannot silently come apart.
check('reports it even when resolvePluginManifest sees nothing to skip', () => {
  const m = resolvePluginManifest({ plugins: { entries: {}, allow: [] } });
  assert.deepStrictEqual(m.skipped, [], 'precondition: the manifest looks clean');
  assert.strictEqual(findUnavailablePlugins(new Set(['slack-reply-plugin']), m).length, 1);
});

check('a loaded compat plugin is NOT reported', () => {
  const m = manifest({ compat: [{ id: 'connector-session-plugin' }] });
  assert.deepStrictEqual(findUnavailablePlugins(new Set(['connector-session-plugin']), m), []);
});

check('the native memory slot is NOT reported when loaded', () => {
  const m = manifest({ hindsight: { id: 'hindsight-openclaw' } });
  assert.deepStrictEqual(findUnavailablePlugins(new Set(['hindsight-openclaw']), m), []);
});

check('a compat plugin that is allowed but did NOT load is reported as not-loaded', () => {
  const out = findUnavailablePlugins(new Set(['demo-cache-plugin']), manifest());
  assert.deepStrictEqual(out, [{ id: 'demo-cache-plugin', reason: 'not-loaded' }]);
});

// Future-proofing: an unknown `*-plugin` must not be silently ignored just because nobody added it
// to a set — that is the same failure mode one level up.
check('an unknown *-plugin in the allow-list is reported', () => {
  const out = findUnavailablePlugins(new Set(['some-future-plugin']), manifest());
  assert.deepStrictEqual(out, [{ id: 'some-future-plugin', reason: 'not-loaded' }]);
});

check('builtin tool names are never reported as plugins', () => {
  const allow = new Set(['read', 'write', 'edit', 'exec', 'process', 'cron', 'memory_search', 'pdf']);
  assert.deepStrictEqual(findUnavailablePlugins(allow, manifest()), []);
});

check('tolerates missing/!empty inputs', () => {
  assert.deepStrictEqual(findUnavailablePlugins(undefined, undefined), []);
  assert.deepStrictEqual(findUnavailablePlugins(new Set(), manifest()), []);
});

let failed = 0;
for (const [name, err] of checks) {
  if (err) { failed++; console.error(`✗ ${name}\n  ${err.message}`); } else console.log(`✓ ${name}`);
}
console.log(`\n${checks.length - failed}/${checks.length} passed`);
process.exit(failed ? 1 : 0);

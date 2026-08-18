// This agent's resolved config, held in-process — the one seam between the runtime and the
// config-resolver.
//
// WHY IT EXISTS AT ALL. Two callers need the same resolved config on the same boot:
// pi-entrypoint (to decide whether to fetch the Datadog secret, from the resolved allow-set) and
// pi-adapter (model / allow-set / plugin manifest / MCP prefixes). The adapter self-boots on import,
// so the entrypoint cannot import it early and hand the value over; and resolving twice would mean
// two DynamoDB reads per cold boot on the TTFM path. So the resolution memoizes HERE, in a module
// both import statically, and whoever asks first pays for it.
//
// It also owns the CROSS-TREE IMPORT, which is the part that cannot be a plain static import.
// agentcore-pi/Dockerfile FLATTENS this directory to /app/ and copies config-resolver/ to
// /app/config-resolver/, so `../config-resolver/x.mjs` is correct in the repo and wrong in the image
// (the image wants `./config-resolver/x.mjs`). eslint checks the source tree, where the repo-relative
// form resolves, so it cannot catch the difference either — see agentcore-pi/image-layout-test.mjs.
// The established convention for that is CONFIG_RESOLVER_DIR (set in the Dockerfile) with a
// repo-relative fallback, resolved dynamically: same as pi-adapter's ddbIO and aws-assume.mjs.
//
// Keeping it in one module keeps that specifier in ONE place. Computing it in both callers would give
// two dynamic imports of what is meant to be one module, and if they ever disagreed by a path segment
// each would get its own instance — two caches, and a re-resolve visible to only one of them.

import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RESOLVER_DIR = process.env.CONFIG_RESOLVER_DIR
  || join(fileURLToPath(new URL('.', import.meta.url)), '..', 'config-resolver');

let cached = null;

/**
 * Resolve (or return the memoized) config for `agentName`.
 *
 * @param {object}   o
 * @param {string}   o.agentName        the scope id this runtime boots as
 * @param {boolean} [o.force=false]     re-read DynamoDB and replace the memo — the per-turn
 *                                      re-resolve, when the config fingerprint has flipped
 * @param {object}  [o.logger=console]
 * @returns {Promise<{agent: object, cfg: object}>}
 *
 * A FAILED FORCED RESOLVE LEAVES THE MEMO INTACT. The caller (pi-adapter getSession) is explicitly
 * built to keep serving the previous config when a re-resolve fails, so throwing away a good config
 * on a transient DynamoDB error would turn a recoverable blip into a broken turn — and the next turn
 * retries anyway, since the fingerprint it compares against has not been advanced.
 */
export async function loadAgentConfig({ agentName, force = false, logger = console } = {}) {
  if (cached && !force) return cached;
  const { resolveAgentConfig } = await import(pathToFileURL(join(RESOLVER_DIR, 'resolve-config.mjs')).href);
  const resolved = await resolveAgentConfig({ agentName, logger });
  cached = resolved;
  return resolved;
}

/**
 * The memoized config, for callers that must not resolve one themselves.
 *
 * THROWS if nothing has been resolved yet, rather than returning null. Its caller decides a tool
 * grant from `agent.tools.alsoAllow`, and an empty answer there reads as "not allowed" — which is a
 * silently wrong answer to "not yet known". The entrypoint resolves before anything asks, so
 * reaching this throw means the boot order changed.
 */
export function agentConfig() {
  if (!cached) throw new Error('agent-config: no config resolved yet — loadAgentConfig() must run first');
  return cached;
}

/** Test seam: drop the memo so a test can exercise the resolve path more than once. */
export function __resetAgentConfigForTest() { cached = null; }

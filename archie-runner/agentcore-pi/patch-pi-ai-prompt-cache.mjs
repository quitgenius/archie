// Teach the pinned pi-ai that Claude 5 supports PROMPT CACHING.
//
// WHY THIS EXISTS. pi-ai 0.61.1 already writes Bedrock cache points correctly — one after the
// system prompt and one on the last user message (`buildSystemPrompt` / `convertMessages` in
// dist/providers/amazon-bedrock.js), which is the right placement for a multi-turn agent. But it
// decides WHETHER to write them from a hard-coded substring list (`supportsPromptCaching`) that
// knows `-4-`, `-4.`, `claude-3-7-sonnet` and `claude-3-5-haiku` and nothing else. Every Claude 5
// id — `us.anthropic.claude-sonnet-5`, `global.anthropic.claude-opus-5`, `…claude-fable-5` — fails
// that list, so NO cache point is written and every turn re-pays full price for the whole prefix.
//
// THIS WAS A SILENT REGRESSION, not a missing feature. TURN-LATENCY-REPORT.md (2026-08-14) measured
// 92% of model calls hitting cache with a p50 of 12.8k cache-read tokens. The next day the fleet
// default moved to Sonnet 5 (40b69247b) and the gate closed. Nothing failed — cache points simply
// stopped being emitted, `usage.cacheRead` went to zero, and the bill went up.
//
// AWS_BEDROCK_FORCE_CACHE=1 DOES NOT HELP. That escape hatch only applies to ids which do NOT
// contain "claude" (application inference profile ARNs, whose ARN hides the model name). A Claude 5
// id contains "claude", so it never reaches the env-var branch — it falls through the version rungs
// and returns false. Setting the variable is a no-op for this fleet, which is why the config knob
// was not the fix.
//
// BEDROCK ITSELF IS FINE. Verified live 2026-09-09 against `us.anthropic.claude-sonnet-5` in the
// sandbox sandbox: an identical 15k-char system prompt with `{cachePoint:{type:"default"}}` wrote
// `cacheWriteInputTokens: 4863` on the first Converse call and read `cacheReadInputTokens: 4863`
// back on the second. The model supports it; only this predicate disagreed.
//
// WHY A PATCH RATHER THAN AN OPTION. `supportsPromptCaching` is module-private and gates two call
// sites (system blocks + message blocks); there is no `StreamOptions` field that overrides it.
// `options.cacheRetention` is NOT that lever — it can only turn caching OFF ("none") or ask for the
// 1h TTL; every value still runs through this predicate. Editing the resolved file is the only lever
// short of rebuilding pi-ai's payload ourselves from a `before_provider_request` hook, which would
// mean owning cache-point placement (and its 20-block lookback subtleties) in our tree.
//
// IT FAILS THE BUILD IF IT CANNOT APPLY. Same rule as its sibling
// patch-pi-ai-adaptive-thinking.mjs: a patch that silently no-ops on an upgrade is how a fleet
// quietly reverts, and this one reverts INVISIBLY — the turns still succeed, they just cost 10x. If
// a future pi-ai handles Claude 5 natively, DELETE this file; do not widen it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REL = 'node_modules/@mariozechner/pi-ai/dist/providers/amazon-bedrock.js';

/**
 * Locate the file by walking up from the cwd and from this script — identical to the
 * adaptive-thinking patch, and for the same reason: pi-ai's package.json `exports` map has no main
 * entry, so `require.resolve` throws ERR_PACKAGE_PATH_NOT_EXPORTED, and the layout differs between
 * the image (/app/node_modules) and a hoisted developer checkout.
 */
function locate() {
  if (process.argv[2]) return process.argv[2];
  const roots = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const root of roots) {
    let dir = root;
    for (let i = 0; i < 6; i += 1) {
      const candidate = join(dir, REL);
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  console.error(`pi-ai prompt-cache patch: FAILED — could not find ${REL} from any of: ${roots.join(', ')}`);
  process.exit(1);
}

const target = locate();

const ANCHOR = `function supportsPromptCaching(model) {
    const id = model.id.toLowerCase();
    if (!id.includes("claude")) {
        // Application inference profiles don't contain the model name in the ARN.
        // Allow users to force cache points via environment variable.
        if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1")
            return true;
        return false;
    }
    // Claude 4.x models (opus-4, sonnet-4, haiku-4)
    if (id.includes("-4-") || id.includes("-4."))
        return true;
    // Claude 3.7 Sonnet
    if (id.includes("claude-3-7-sonnet"))
        return true;
    // Claude 3.5 Haiku
    if (id.includes("claude-3-5-haiku"))
        return true;
    return false;
}`;

// ADDITIVE ONLY. Every original rung is kept verbatim below the new one, so every model pi-ai
// already cached behaves identically; this can only turn caching ON for ids it used to miss.
//
// The added rung is a VERSION PARSE over the modern id shape `claude-<family>-<major>[-<minor>]`,
// true from major 4 onward. Two regexes, because the two live shapes differ:
//   `claude-opus-4-8`  → family then major-minor   (the `-4-` rung already caught these)
//   `claude-sonnet-5`  → family then a bare major  (nothing caught these — the bug)
// Both tolerate the `us.`/`eu.`/`ap.`/`global.` inference-profile prefixes and the `anthropic/…`
// form pi-ai also accepts, by anchoring on `anthropic[./]claude-`.
//
// Claude 3.x is deliberately NOT covered by the parse: its ids put the version BEFORE the family
// (`claude-3-5-haiku-20241022-v1:0`), so `[a-z]+-\d+` cannot match them and they keep being decided
// by the two explicit 3.x rungs — which is correct, because caching on that generation is
// 3-5-haiku and 3-7-sonnet only, not all of Claude 3.
const PATCHED = `function supportsPromptCaching(model) {
    const id = model.id.toLowerCase();
    if (!id.includes("claude")) {
        // Application inference profiles don't contain the model name in the ARN.
        // Allow users to force cache points via environment variable.
        if (typeof process !== "undefined" && process.env.AWS_BEDROCK_FORCE_CACHE === "1")
            return true;
        return false;
    }
    // PATCHED (patch-pi-ai-prompt-cache.mjs): every Claude from 4 onward supports prompt caching.
    // The rungs below know only 4.x by substring, so Claude 5 (\`claude-sonnet-5\`, \`claude-opus-5\`,
    // \`claude-fable-5\`) silently got NO cache point — turns kept working and kept paying full price
    // for the whole prefix. Bedrock accepts cachePoint on those ids; only this list disagreed.
    // NOT reachable by AWS_BEDROCK_FORCE_CACHE: that branch is above, and only for non-claude ids.
    const v = /anthropic[./]claude-[a-z]+-(\\d+)-(\\d+)/.exec(id);
    if (v && Number(v[1]) >= 4) return true;
    // Unsuffixed majors (claude-sonnet-5, claude-opus-5, claude-fable-5) carry no minor.
    const bare = /anthropic[./]claude-[a-z]+-(\\d+)(?![-\\d])/.exec(id);
    if (bare && Number(bare[1]) >= 4) return true;
    // Claude 4.x models (opus-4, sonnet-4, haiku-4)
    if (id.includes("-4-") || id.includes("-4."))
        return true;
    // Claude 3.7 Sonnet
    if (id.includes("claude-3-7-sonnet"))
        return true;
    // Claude 3.5 Haiku
    if (id.includes("claude-3-5-haiku"))
        return true;
    return false;
}`;

const src = readFileSync(target, 'utf8');

if (src.includes('PATCHED (patch-pi-ai-prompt-cache.mjs)')) {
  console.log('pi-ai prompt-cache patch: already applied');
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error('pi-ai prompt-cache patch: FAILED — supportsPromptCaching does not match the '
    + 'expected source in\n  ' + target
    + '\nThe pinned pi-ai has changed. Check whether it now caches Claude 5 natively: if it does, '
    + 'DELETE this patch. If it does not, re-anchor. Do NOT skip it — an unpatched module still '
    + 'serves turns, it just stops caching, and nothing else in the image notices.');
  process.exit(1);
}

writeFileSync(target, src.replace(ANCHOR, PATCHED));

// Prove the replacement behaves, rather than trusting that a string swap did what it reads like.
// The function is module-private, so this re-implements the patched predicate over the WRITTEN file
// to confirm the intended ids now qualify and the old verdicts are unchanged.
const after = readFileSync(target, 'utf8');
if (!after.includes('PATCHED (patch-pi-ai-prompt-cache.mjs)')) {
  console.error('pi-ai prompt-cache patch: FAILED — the write did not take');
  process.exit(1);
}
const caches = (rawId) => {
  const id = String(rawId).toLowerCase();
  if (!id.includes('claude')) return process.env.AWS_BEDROCK_FORCE_CACHE === '1';
  const v = /anthropic[./]claude-[a-z]+-(\d+)-(\d+)/.exec(id);
  if (v && Number(v[1]) >= 4) return true;
  const bare = /anthropic[./]claude-[a-z]+-(\d+)(?![-\d])/.exec(id);
  if (bare && Number(bare[1]) >= 4) return true;
  if (id.includes('-4-') || id.includes('-4.')) return true;
  if (id.includes('claude-3-7-sonnet')) return true;
  if (id.includes('claude-3-5-haiku')) return true;
  return false;
};
const expect = [
  ['us.anthropic.claude-sonnet-5', true],                  // THE FLEET DEFAULT — was false
  ['global.anthropic.claude-opus-5', true],                // was false
  ['us.anthropic.claude-fable-5', true],                   // was false
  ['anthropic/claude-sonnet-5', true],                     // the slash form pi-ai also accepts
  ['global.anthropic.claude-opus-4-8', true],              // unchanged: the `-4-` rung already hit
  ['global.anthropic.claude-sonnet-4-6', true],            // unchanged
  ['anthropic.claude-3-7-sonnet-20250219-v1:0', true],     // unchanged: explicit 3.7 rung
  ['anthropic.claude-3-5-haiku-20241022-v1:0', true],      // unchanged: explicit 3.5-haiku rung
  ['anthropic.claude-3-sonnet-20240229-v1:0', false],      // unchanged: Claude 3 Sonnet does NOT cache
  ['amazon.nova-pro-v1:0', false],                         // unchanged: not claude, no env var
];
const wrong = expect.filter(([id, want]) => caches(id) !== want);
if (wrong.length) {
  console.error('pi-ai prompt-cache patch: FAILED — predicate misclassifies '
    + wrong.map(([id]) => id).join(', '));
  process.exit(1);
}
console.log(`pi-ai prompt-cache patch: applied to ${target} (${expect.length} ids verified)`);

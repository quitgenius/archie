// Teach the pinned pi-ai that Claude 5 supports ADAPTIVE thinking.
//
// WHY THIS EXISTS. pi-ai 0.61.1 already implements adaptive thinking correctly — given the go-ahead
// it emits exactly what Claude 5 wants:
//
//     { thinking: { type: "adaptive" },
//       output_config: { effort: mapThinkingLevelToEffort(...) } }
//
// but it decides WHEN to emit that from a hard-coded substring list
// (`supportsAdaptiveThinking`, dist/providers/amazon-bedrock.js) holding only opus-4-6 and
// sonnet-4-6. Every other Claude gets the legacy `thinking.type: "enabled"` shape instead — which
// Claude 4 accepts and Claude 5 REJECTS OUTRIGHT:
//
//     "thinking.type.enabled" is not supported for this model.
//     Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
//
// Found live 2026-08-15: every Claude 5 turn failed in ~1s. The alternative to this patch is running
// Claude 5 with thinking OFF, which works but is a real capability loss.
//
// WHY A PATCH RATHER THAN AN OPTION. There is no seam. `buildAdditionalModelRequestFields` computes
// the field internally (amazon-bedrock.js:88) with no override in `StreamOptions`, and
// `supportsAdaptiveThinking` is module-private — it cannot be monkey-patched from outside, and it
// gates three separate call sites. Editing the resolved file is the only lever.
//
// WHY A PATCH RATHER THAN AN UPGRADE. The right fix is a pi-ai that knows Claude 5. This file's
// sibling note in pi-runtime.mjs records that 0.70.2 — the version OpenClaw bundles — still carries
// no claude-*-5 in its catalog at all, so a bump is not known to solve it and would need verifying
// against a candidate. This is the contained option until then.
//
// IT FAILS THE BUILD IF IT CANNOT APPLY. A patch that silently no-ops on an upgrade is how a fleet
// quietly reverts to broken turns, so an unrecognised source is an error, not a warning. If a future
// pi-ai handles Claude 5 natively, DELETE this file — do not widen it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REL = 'node_modules/@mariozechner/pi-ai/dist/providers/amazon-bedrock.js';

/**
 * Locate the file by walking up from the cwd and from this script.
 *
 * NOT `require.resolve('@mariozechner/pi-ai')`, which is what the first version did and what failed
 * the build: pi-ai's package.json declares an `exports` map with NO main entry, so resolving the
 * package root throws ERR_PACKAGE_PATH_NOT_EXPORTED. Resolving the dist subpath directly is no
 * better — `exports` does not expose that either. The layout also differs between the image
 * (/app/node_modules) and a hoisted developer checkout, so both roots are walked.
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
  console.error(`pi-ai adaptive-thinking patch: FAILED — could not find ${REL} from any of: ${roots.join(', ')}`);
  process.exit(1);
}

const target = locate();

const ANCHOR = `function supportsAdaptiveThinking(modelId) {
    return (modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6") ||
        modelId.includes("sonnet-4-6") ||
        modelId.includes("sonnet-4.6"));
}`;

// Claude 5 and anything above it. Matches the id shapes Bedrock actually uses — bare
// (`anthropic.claude-sonnet-5`), regional (`us.`/`eu.`/`ap.`) and `global.` inference profiles — and
// the `anthropic/claude-…` form pi-ai also accepts. The original substring tests are KEPT so the
// models it already handled behave identically; this only ever ADDS.
const PATCHED = `function supportsAdaptiveThinking(modelId) {
    // PATCHED (patch-pi-ai-adaptive-thinking.mjs): every Claude from 4-6 onward requires
    // thinking.type "adaptive"; the legacy "enabled" shape below is rejected OUTRIGHT by them.
    //
    // NOT a major-version test. That was the first version of this patch and it was wrong: it
    // allowed 5+ only, on the reasoning that "Claude 4 accepts the legacy shape". opus-4-8 does not
    // — proven live 2026-08-16, every turn failing with exactly this error on
    // global.anthropic.claude-opus-4-8. The boundary is the 4-6 generation, which is also why pi-ai's
    // own list contains opus-4-6 and sonnet-4-6 and nothing older.
    const v = /anthropic[./]claude-[a-z]+-(\\d+)-(\\d+)/.exec(String(modelId));
    if (v) {
      const major = Number(v[1]), minor = Number(v[2]);
      if (major > 4 || (major === 4 && minor >= 6)) return true;
    }
    // Unsuffixed majors (claude-sonnet-5, claude-opus-5) carry no minor.
    const bare = /anthropic[./]claude-[a-z]+-(\\d+)(?![-\\d])/.exec(String(modelId));
    if (bare && Number(bare[1]) >= 5) return true;
    return (modelId.includes("opus-4-6") ||
        modelId.includes("opus-4.6") ||
        modelId.includes("sonnet-4-6") ||
        modelId.includes("sonnet-4.6"));
}`;

const src = readFileSync(target, 'utf8');

if (src.includes('PATCHED (patch-pi-ai-adaptive-thinking.mjs)')) {
  console.log('pi-ai adaptive-thinking patch: already applied');
  process.exit(0);
}

if (!src.includes(ANCHOR)) {
  console.error('pi-ai adaptive-thinking patch: FAILED — supportsAdaptiveThinking does not match the '
    + 'expected source in\n  ' + target
    + '\nThe pinned pi-ai has changed. Check whether it now handles Claude 5 natively: if it does, '
    + 'DELETE this patch and restore `reasoning: true` in pi-runtime.mjs. If it does not, re-anchor.');
  process.exit(1);
}

writeFileSync(target, src.replace(ANCHOR, PATCHED));

// Prove the replacement behaves, rather than trusting that a string swap did what it reads like.
// The function is module-private, so this re-implements the patched predicate over the WRITTEN file
// to confirm the intended ids now qualify and the old ones still do.
const after = readFileSync(target, 'utf8');
if (!after.includes('PATCHED (patch-pi-ai-adaptive-thinking.mjs)')) {
  console.error('pi-ai adaptive-thinking patch: FAILED — the write did not take');
  process.exit(1);
}
const adaptive = (id) => {
  const v = /anthropic[./]claude-[a-z]+-(\d+)-(\d+)/.exec(String(id));
  if (v) {
    const major = Number(v[1]), minor = Number(v[2]);
    if (major > 4 || (major === 4 && minor >= 6)) return true;
  }
  const bare = /anthropic[./]claude-[a-z]+-(\d+)(?![-\d])/.exec(String(id));
  if (bare && Number(bare[1]) >= 5) return true;
  return ['opus-4-6', 'opus-4.6', 'sonnet-4-6', 'sonnet-4.6'].some((s) => id.includes(s));
};
const expect = [
  ['us.anthropic.claude-sonnet-5', true],
  ['global.anthropic.claude-opus-5', true],
  ['global.anthropic.claude-fable-5', true],
  ['global.anthropic.claude-sonnet-4-6', true],   // unchanged: was already adaptive
  ['anthropic.claude-opus-4-8', true],            // 4-8 REQUIRES adaptive — proven live 2026-08-16
  ['anthropic.claude-opus-4-7', true],            // same generation
  ['global.anthropic.claude-opus-4-5', false],    // older than 4-6: legacy shape is correct
  ['anthropic.claude-3-5-sonnet-20241022-v2:0', false],
];
const wrong = expect.filter(([id, want]) => adaptive(id) !== want);
if (wrong.length) {
  console.error('pi-ai adaptive-thinking patch: FAILED — predicate misclassifies '
    + wrong.map(([id]) => id).join(', '));
  process.exit(1);
}
console.log(`pi-ai adaptive-thinking patch: applied to ${target} (${expect.length} ids verified)`);

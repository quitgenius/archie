// agent_i32pz9.* USAGE attributes for the OTEL spans: tokens, prompt-cache volumes, and USD cost.
//
// WHY A MODULE. Two reasons, both learned the hard way in this tree. Importing pi-adapter.mjs runs
// boot() at module load, so anything defined there is untestable (same reason config-fingerprint.mjs
// was extracted). And the turn span and the per-model-call spans have to agree: they used to build
// their usage attributes independently, and the turn one was silently wrong (see turnUsageAttrs).
//
// The accessors read across pi-ai's field spellings and return `undefined` — not 0 — when usage is
// absent. That distinction is load-bearing: a turn that never reached the model has NO token count,
// which is a different fact from a turn that used zero tokens, and the emit sites rely on it (an
// attribute set to undefined is dropped from the span rather than reported as a real zero).

import { aggregateReplyUsage } from './reply-usage.mjs';

// pi-ai usage shape: { input, output, cacheRead, cacheWrite, totalTokens, cost: { total, ... } }
export const usageIn = (u) => (u ? (u.input ?? u.inputTokens ?? u.promptTokens) : undefined);
export const usageOut = (u) => (u ? (u.output ?? u.outputTokens ?? u.completionTokens) : undefined);
// Prompt-cache token volumes (cache is a big chunk of real context + cost, and usage.input alone
// hides it). Fall back across alt field names; undefined when usage absent (emit sites guard `|| 0`).
export const usageCacheRead = (u) => (u ? (u.cacheRead ?? u.cacheReadTokens ?? u.cacheReadInputTokens) : undefined);
export const usageCacheWrite = (u) => (u ? (u.cacheWrite ?? u.cacheWriteTokens ?? u.cacheCreationInputTokens) : undefined);
// USD, computed by pi-ai per model call (cache-aware, keyed on the model that actually ran). Passed
// through verbatim wherever it appears — never synthesised from a local price table, because a
// fabricated cost that looks real is worse than a missing datapoint.
export const usageCostUsd = (u) => (Number.isFinite(u?.cost?.total) ? u.cost.total : undefined);

/**
 * The cache/cost half of a span's agent_i32pz9.* attributes for ONE model call.
 *
 * WHY THE THREE DERIVED FIELDS AND NOT JUST THE RAW COUNTS. `input_tokens` under prompt caching is
 * the UNCACHED REMAINDER, which on a warm archie turn is a handful of tokens — TURN-LATENCY-REPORT.md
 * §3 measured a p50 of 1 token and warned that "any dashboard reading InputTokens as prompt size is
 * reading approximately zero". Raw cache_read/cache_write were already on the spans, but every
 * consumer then had to know to add three numbers together, and none of them did. So:
 *
 *   total_prompt_tokens  input + cache_read + cache_write — the TRUE prompt size, the number you
 *                        want when asking "how big is this conversation".
 *   cache.hit            read > 0. Makes cache-hit RATE an avg() over spans, matching the
 *                        TurnCacheHit EMF metric so the two surfaces answer identically.
 *   cache.read_ratio     read / total_prompt (0..1). The efficiency signal: hit=true with a ratio of
 *                        0.05 is a cache that is technically working and saving nothing — which is
 *                        exactly what a prefix-stability regression looks like from the outside.
 *                        (A cache WRITE turn reads low by design: writing 40k and reading 0 is the
 *                        first turn of a session, not a fault. Read it with cache_write_tokens.)
 *
 * cost_usd is omitted, not zeroed, when pi-ai reported no cost — see usageCostUsd.
 */
export function cacheCostAttrs(u) {
  const input = Math.max(0, Math.round(usageIn(u) || 0));
  const read = Math.max(0, Math.round(usageCacheRead(u) || 0));
  const write = Math.max(0, Math.round(usageCacheWrite(u) || 0));
  const totalPrompt = input + read + write;
  const cost = usageCostUsd(u);
  return {
    'agent_i32pz9.usage.cache_read_tokens': read,
    'agent_i32pz9.usage.cache_write_tokens': write,
    'agent_i32pz9.usage.total_prompt_tokens': totalPrompt,
    'agentcore.cache.hit': read > 0,
    // Guarded: a turn that never reached the model has no prompt to take a ratio of.
    ...(totalPrompt > 0 ? { 'agentcore.cache.read_ratio': Math.round((read / totalPrompt) * 1000) / 1000 } : {}),
    ...(cost !== undefined ? { 'agent_i32pz9.usage.cost_usd': cost } : {}),
  };
}

/**
 * Token/cache/cost attributes for the TURN span, aggregated across every model call the turn made.
 *
 * WHY NOT `out.usage`. That is the LAST model call's usage — the accuracy bug reply-usage.mjs was
 * written to fix on the EMF side, still live on the span side until now: a reply that made four
 * Bedrock calls reported a quarter of its output tokens, a quarter of its cost and a quarter of its
 * cache reads on the span, while the CloudWatch metric for the same turn reported all four. Two
 * surfaces, same turn, different numbers — and the span was the wrong one.
 *
 * Both halves of reply-usage's rule apply, which is why this is not just cacheCostAttrs():
 *   BILLED (input/output/cache_read/cache_write/cost) → SUMMED. Every call is charged separately.
 *   PROMPT SIZE (total_prompt_tokens)                 → LAST call. Each call re-sends the whole
 *     conversation, so summing counts the same prompt N times; the last call carries the fullest
 *     one. read_ratio keeps the SUMMED basis deliberately — it answers "what fraction of the prompt
 *     tokens billed this turn came from cache", which is the cost question.
 */
export function turnUsageAttrs(out) {
  const calls = Array.isArray(out?.modelCalls) ? out.modelCalls.filter(Boolean) : [];
  // No per-call record (aborted run, or a no-op turn that never reached the model): fall back to
  // whatever single usage came back, exactly as before. Never invent an aggregate.
  if (!calls.length) {
    return {
      'agent_i32pz9.usage.input_tokens': usageIn(out?.usage),
      'agent_i32pz9.usage.output_tokens': usageOut(out?.usage),
      ...cacheCostAttrs(out?.usage),
    };
  }
  const a = aggregateReplyUsage(calls);
  const summed = {
    input: a.input, output: a.output, cacheRead: a.cacheRead, cacheWrite: a.cacheWrite,
    ...(a.costUsd !== undefined ? { cost: { total: a.costUsd } } : {}),
  };
  return {
    'agent_i32pz9.usage.input_tokens': a.input,
    'agent_i32pz9.usage.output_tokens': a.output,
    ...cacheCostAttrs(summed),
    // Overrides cacheCostAttrs' summed figure with the last call's — see the rule above.
    ...(a.contextTokens !== undefined ? { 'agent_i32pz9.usage.total_prompt_tokens': a.contextTokens } : {}),
    // How many Bedrock calls this turn cost. Without it a turn span's summed tokens are
    // uninterpretable: 40k billed prompt tokens is one big call or eight cached small ones.
    'agent_i32pz9.usage.model_calls': calls.length,
  };
}

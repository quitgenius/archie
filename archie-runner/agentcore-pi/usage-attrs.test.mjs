// The span-attribute contract for tokens / prompt cache / cost.
//
// These assertions exist because every one of them corresponds to a way the telemetry has already
// lied, or could lie identically again:
//
//   - The turn span reported the LAST model call's usage while the EMF metric for the same turn
//     reported the sum, so a tool-loop turn's span showed a fraction of its real tokens and cost.
//   - `input_tokens` under prompt caching is the UNCACHED REMAINDER (p50 of 1 token in
//     TURN-LATENCY-REPORT.md §3), so anything reading it as prompt size reads ~0.
//   - Summing the per-call prompt sizes counts the same conversation once per call, which is the
//     over-count that made TurnTokensContext useless on any turn that used a tool.
//   - A missing cost silently becoming $0 reads as a free turn.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cacheCostAttrs, turnUsageAttrs } from './usage-attrs.mjs';

// A realistic warm archie turn: tiny uncached remainder, big cached prefix.
const CACHED_CALL = { usage: { input: 3, output: 120, cacheRead: 12800, cacheWrite: 0, cost: { total: 0.0042 } } };

test('a cached call reports the true prompt size, not the uncached remainder', () => {
  const a = cacheCostAttrs(CACHED_CALL.usage);
  assert.equal(a['agent_i32pz9.usage.cache_read_tokens'], 12800);
  assert.equal(a['agent_i32pz9.usage.cache_write_tokens'], 0);
  // 3 + 12800 + 0 — the number `input_tokens` alone would have understated by ~4000x.
  assert.equal(a['agent_i32pz9.usage.total_prompt_tokens'], 12803);
  assert.equal(a['agentcore.cache.hit'], true);
  assert.equal(a['agentcore.cache.read_ratio'], 1); // 12800/12803 → 1.000
  assert.equal(a['agent_i32pz9.usage.cost_usd'], 0.0042);
});

test('an uncached call is hit:false with ratio 0 — distinguishable from "no data"', () => {
  const a = cacheCostAttrs({ input: 9000, output: 50, cacheRead: 0, cacheWrite: 0 });
  assert.equal(a['agentcore.cache.hit'], false);
  assert.equal(a['agentcore.cache.read_ratio'], 0);
  assert.equal(a['agent_i32pz9.usage.total_prompt_tokens'], 9000);
  // No cost from pi-ai → the attribute is ABSENT, never 0. A fabricated zero reads as a free call.
  assert.ok(!('agent_i32pz9.usage.cost_usd' in a));
});

test('a cache WRITE turn is visible as such: low read ratio, non-zero write', () => {
  // The first turn of a session pays the write premium and reads nothing. It must not be
  // indistinguishable from a broken cache — hence write tokens being their own attribute.
  const a = cacheCostAttrs({ input: 12, output: 80, cacheRead: 0, cacheWrite: 12800 });
  assert.equal(a['agentcore.cache.hit'], false);
  assert.equal(a['agentcore.cache.read_ratio'], 0);
  assert.equal(a['agent_i32pz9.usage.cache_write_tokens'], 12800);
  assert.equal(a['agent_i32pz9.usage.total_prompt_tokens'], 12812);
});

test('no usage at all → no ratio attribute (a turn with no model call has no prompt)', () => {
  const a = cacheCostAttrs(undefined);
  assert.equal(a['agent_i32pz9.usage.total_prompt_tokens'], 0);
  assert.equal(a['agentcore.cache.hit'], false);
  assert.ok(!('agentcore.cache.read_ratio' in a));
});

test('THE BUG: the turn span sums every model call, it does not report the last one', () => {
  // A four-call tool loop. Under the old code the span carried call 4's usage alone.
  const out = {
    usage: { input: 4, output: 30, cacheRead: 14000, cacheWrite: 0, cost: { total: 0.001 } }, // last call
    modelCalls: [
      { usage: { input: 20, output: 200, cacheRead: 0, cacheWrite: 12000, cost: { total: 0.02 } } },
      { usage: { input: 5, output: 150, cacheRead: 12000, cacheWrite: 900, cost: { total: 0.004 } } },
      { usage: { input: 6, output: 90, cacheRead: 12900, cacheWrite: 1100, cost: { total: 0.005 } } },
      { usage: { input: 4, output: 30, cacheRead: 14000, cacheWrite: 0, cost: { total: 0.001 } } },
    ],
  };
  const a = turnUsageAttrs(out);
  assert.equal(a['agent_i32pz9.usage.output_tokens'], 470);       // was 30 — a quarter of the truth
  assert.equal(a['agent_i32pz9.usage.cache_read_tokens'], 38900); // was 14000
  assert.equal(a['agent_i32pz9.usage.cache_write_tokens'], 14000);
  assert.equal(a['agent_i32pz9.usage.input_tokens'], 35);
  assert.ok(Math.abs(a['agent_i32pz9.usage.cost_usd'] - 0.03) < 1e-9); // was 0.001
  assert.equal(a['agent_i32pz9.usage.model_calls'], 4);
});

test('prompt size on the turn span is the LAST call, not the sum of all four', () => {
  const out = {
    modelCalls: [
      { usage: { input: 20, output: 200, cacheRead: 0, cacheWrite: 12000 } },
      { usage: { input: 6, output: 90, cacheRead: 12900, cacheWrite: 1100 } },
      { usage: { input: 4, output: 30, cacheRead: 14000, cacheWrite: 0 } },
    ],
  };
  const a = turnUsageAttrs(out);
  // Last call's input+read+write = 4+14000+0. Summing would claim ~40k of "context" for a
  // conversation that is actually ~14k, because each call re-sends the same history.
  assert.equal(a['agent_i32pz9.usage.total_prompt_tokens'], 14004);
  // …while read_ratio deliberately keeps the BILLED (summed) basis: 26900 read of 27030+... total.
  const billedPrompt = 30 + 26900 + 13100;
  assert.equal(a['agentcore.cache.read_ratio'], Math.round((26900 / billedPrompt) * 1000) / 1000);
});

test('a turn with no per-call record falls back to out.usage rather than inventing zeros', () => {
  const a = turnUsageAttrs({ usage: { input: 7, output: 11, cacheRead: 500, cacheWrite: 0 } });
  assert.equal(a['agent_i32pz9.usage.input_tokens'], 7);
  assert.equal(a['agent_i32pz9.usage.output_tokens'], 11);
  assert.equal(a['agent_i32pz9.usage.cache_read_tokens'], 500);
  assert.equal(a['agentcore.cache.hit'], true);
  // No call count is claimed when there were no recorded calls.
  assert.ok(!('agent_i32pz9.usage.model_calls' in a));
});

test('a no-op turn (no model call, no usage) reports absent tokens, not zero tokens', () => {
  const a = turnUsageAttrs({});
  // undefined ⇒ the exporter drops the attribute. "We did not call the model" must not render as
  // "the model used 0 tokens", which would drag every token average toward zero.
  assert.equal(a['agent_i32pz9.usage.input_tokens'], undefined);
  assert.equal(a['agent_i32pz9.usage.output_tokens'], undefined);
  assert.equal(a['agentcore.cache.hit'], false);
});

test('alternate pi-ai field spellings are read (bedrock vs anthropic usage shapes)', () => {
  const a = cacheCostAttrs({ inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 200, cacheCreationInputTokens: 50 });
  assert.equal(a['agent_i32pz9.usage.cache_read_tokens'], 200);
  assert.equal(a['agent_i32pz9.usage.cache_write_tokens'], 50);
  assert.equal(a['agent_i32pz9.usage.total_prompt_tokens'], 260);
});

console.log('usage-attrs: contract asserted ✓');

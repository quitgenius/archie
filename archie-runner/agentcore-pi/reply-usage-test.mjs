import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateReplyUsage, splitCallsByReply, planReplyMetrics } from './reply-usage.mjs';

// A tool-loop reply: 3 model calls. Each carries its OWN per-request usage (verified against pi-ai:
// providers assign usage per API response, models.js prices each call). The same cached prefix is
// re-read on every call, which is exactly why cacheRead must not be summed into "context size".
const toolLoop = [
  { usage: { input: 10, output: 50, cacheRead: 5000, cacheWrite: 200, cost: { total: 0.010 } }, model: 'm1', stopReason: 'toolUse' },
  { usage: { input: 20, output: 40, cacheRead: 5000, cacheWrite: 0, cost: { total: 0.008 } }, model: 'm1', stopReason: 'toolUse' },
  { usage: { input: 30, output: 60, cacheRead: 5200, cacheWrite: 0, cost: { total: 0.009 } }, model: 'm1', stopReason: 'stop' },
];

test('BILLED figures are SUMMED across the reply (the bug: only the last call was counted)', () => {
  const a = aggregateReplyUsage(toolLoop);
  assert.equal(a.output, 150);                    // 50+40+60 — was 60
  assert.equal(a.input, 60);                      // 10+20+30 — was 30
  assert.equal(a.cacheRead, 15200);               // billed per call
  assert.equal(a.cacheWrite, 200);
  assert.ok(Math.abs(a.costUsd - 0.027) < 1e-9);  // 0.010+0.008+0.009 — was 0.009 (a third)
  assert.equal(a.calls, 3);
});

test('PROMPT SIZE comes from the LAST call, never summed', () => {
  const a = aggregateReplyUsage(toolLoop);
  // last call only: 30 + 5200 + 0. Summing would give 15260+ and imply a conversation 3x its size.
  assert.equal(a.contextTokens, 5230);
  assert.notEqual(a.contextTokens, a.input + a.cacheRead + a.cacheWrite);
});

test('identity comes from the last call — earlier calls stop with toolUse, which is not the outcome', () => {
  const a = aggregateReplyUsage(toolLoop);
  assert.equal(a.stopReason, 'stop');
  assert.equal(a.model, 'm1');
});

test('a single-call reply is unchanged by summation (no regression for the common case)', () => {
  const one = [{ usage: { input: 3, output: 27, cacheRead: 5599, cacheWrite: 329, cost: { total: 0.0056 } }, model: 'm', stopReason: 'stop' }];
  const a = aggregateReplyUsage(one);
  assert.equal(a.input, 3);
  assert.equal(a.output, 27);
  assert.equal(a.contextTokens, 3 + 5599 + 329);
  assert.ok(Math.abs(a.costUsd - 0.0056) < 1e-12);
});

test('a MISSING cost is undefined, not 0 — an unpriced model must not look free', () => {
  const a = aggregateReplyUsage([{ usage: { input: 1, output: 2 }, model: 'unpriced' }]);
  assert.equal(a.costUsd, undefined);
  // …but a partial price still sums what it has, and is reported.
  const b = aggregateReplyUsage([
    { usage: { input: 1, output: 2 } },
    { usage: { input: 1, output: 2, cost: { total: 0.5 } } },
  ]);
  assert.equal(b.costUsd, 0.5);
});

test('tolerates alternative pi-ai field spellings and absent usage', () => {
  const a = aggregateReplyUsage([
    { usage: { inputTokens: 4, outputTokens: 8, cacheReadInputTokens: 100 } },
    { model: 'no-usage-at-all' },
  ]);
  assert.equal(a.input, 4);
  assert.equal(a.output, 8);
  assert.equal(a.cacheRead, 100);
  // The trailing usage-less call must NOT erase the prompt size — fall back to the last call
  // that reported usage (an aborted request otherwise blanks ContextLengthTokens).
  assert.equal(a.contextTokens, 104);
});

test('empty / rubbish input is a zeroed aggregate, never a throw (metrics must not break a turn)', () => {
  for (const bad of [[], null, undefined, [null, undefined]]) {
    const a = aggregateReplyUsage(bad);
    assert.equal(a.output, 0);
    assert.equal(a.costUsd, undefined);
    assert.equal(a.contextTokens, undefined);
  }
});

test('isError propagates if ANY call in the reply errored', () => {
  assert.equal(aggregateReplyUsage([{ usage: {} }, { usage: {}, isError: true }]).isError, true);
  assert.equal(aggregateReplyUsage([{ usage: {} }]).isError, false);
});

// splitCallsByReply — the grouping that makes per-reply metrics possible when one run answers
// several user messages (a queued followUp continues the SAME run; see agent-loop.js outer loop).
test('splitCallsByReply groups a multi-reply run at the recorded boundaries', () => {
  const calls = [1, 2, 3, 4, 5].map((n) => ({ usage: { output: n } }));
  // reply 1 = calls 0..2 (a 3-call tool loop), reply 2 = calls 3..4
  const groups = splitCallsByReply(calls, [3, 5]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((c) => c.usage.output), [1, 2, 3]);
  assert.deepEqual(groups[1].map((c) => c.usage.output), [4, 5]);
  assert.equal(aggregateReplyUsage(groups[0]).output, 6);
  assert.equal(aggregateReplyUsage(groups[1]).output, 9);
});

test('splitCallsByReply: trailing calls past the last boundary form their own reply', () => {
  const calls = [1, 2, 3].map((n) => ({ usage: { output: n } }));
  assert.equal(splitCallsByReply(calls, [1]).length, 2);            // [1], [2,3]
  assert.equal(splitCallsByReply(calls, []).length, 1);             // no boundary → one reply
  assert.deepEqual(splitCallsByReply([], [2]).map((g) => g.length), [0]);
});

test('splitCallsByReply clamps nonsense boundaries instead of producing negative slices', () => {
  const calls = [1, 2].map((n) => ({ usage: { output: n } }));
  const groups = splitCallsByReply(calls, [99, 1, -5]);
  assert.equal(groups.reduce((n, g) => n + g.length, 0), 2); // every call accounted for exactly once
});

// planReplyMetrics — the attribution rules. Pure on purpose: these were the parts most likely to be
// silently wrong (a duplicated latency inflates p90; a zeroed one deflates it; a run-level error
// stamped on every reply inflates the error rate by the reply count).
test('planReplyMetrics: one payload per reply, usage summed per reply', () => {
  const out = {
    modelCalls: [
      { usage: { input: 10, output: 50, cost: { total: 0.01 } }, model: 'm', stopReason: 'toolUse' },
      { usage: { input: 20, output: 40, cost: { total: 0.02 } }, model: 'm', stopReason: 'stop' },
      { usage: { input: 5, output: 7, cost: { total: 0.03 } }, model: 'm', stopReason: 'stop' },
    ],
    replyBoundaries: [2, 3],
    usage: { input: 5, output: 7 },
    model: 'm',
  };
  const plans = planReplyMetrics({ out, latencyMs: 5000, ttftMs: 800 });
  assert.equal(plans.length, 2);
  assert.equal(plans[0].tokensOut, 90);            // 50+40 summed, not just 40
  assert.equal(plans[1].tokensOut, 7);
  assert.ok(Math.abs(plans[0].costUsd - 0.03) < 1e-9);
});

test('planReplyMetrics: latency/TTFT go to the FIRST reply only, and are OMITTED (not 0) after', () => {
  const out = {
    modelCalls: [{ usage: { output: 1 } }, { usage: { output: 2 } }],
    replyBoundaries: [1, 2],
  };
  const plans = planReplyMetrics({ out, latencyMs: 9000, ttftMs: 500 });
  assert.equal(plans[0].latencyMs, 9000);
  assert.equal(plans[0].ttftMs, 500);
  // Absent keys, NOT zeros: emitTurnMetrics only emits TurnLatencyMs when one is supplied, so a 0
  // here would drag the latency percentiles down on every follow-up.
  assert.ok(!('latencyMs' in plans[1]), 'later replies must omit latencyMs entirely');
  assert.ok(!('ttftMs' in plans[1]), 'later replies must omit ttftMs entirely');
});

test('planReplyMetrics: a run-level error marks only the LAST reply', () => {
  const out = { modelCalls: [{ usage: {} }, { usage: {} }], replyBoundaries: [1, 2] };
  const plans = planReplyMetrics({ out, latencyMs: 1, isError: true });
  assert.equal(plans[0].isError, false);
  assert.equal(plans[1].isError, true);
});

test('planReplyMetrics: no boundaries → ONE payload from out.usage (never drops a metric)', () => {
  const out = { modelCalls: [], replyBoundaries: [], usage: { input: 3, output: 27 }, model: 'm' };
  const plans = planReplyMetrics({ out, latencyMs: 1234, ttftMs: 99 });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].tokensOut, 27);
  assert.equal(plans[0].latencyMs, 1234);
});

test('planReplyMetrics: survives a junk/absent out (metrics must never break a turn)', () => {
  for (const bad of [undefined, {}, { modelCalls: null, replyBoundaries: null }]) {
    const plans = planReplyMetrics({ out: bad, latencyMs: 5 });
    assert.equal(plans.length, 1);
    assert.equal(plans[0].tokensOut, 0);
  }
  assert.equal(planReplyMetrics().length, 1);
});

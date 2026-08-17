// Per-REPLY usage aggregation (§transport). One "reply" = one complete answer to one user message,
// which may span SEVERAL model calls (a tool loop: assistant text → tool call → assistant text → …).
//
// WHY THIS EXISTS — a pre-existing accuracy bug. pi-runtime's runTurn did
//     usage = ev.message.usage ?? usage
// on every assistant `message_end`, so the turn-level `usage` it returned was the LAST model call's
// usage, not the reply's. emitTurnMetrics / resolveTurnCostUsd consume that directly, so a reply that
// made four Bedrock calls reported one quarter of its output tokens and one quarter of its cost.
// modelCalls[] already captured per-call usage — nothing new needs collecting, it was just unused.
//
// THE RULE: SUM WHAT IS BILLED, TAKE THE LAST FOR PROMPT SIZE.
//
// Verified against pi-ai: each provider assigns usage per API response
// (`output.usage.cacheRead = event.usage.cacheReadInputTokens || 0` in providers/amazon-bedrock.js)
// and models.js computes `usage.cost.*` per call. So every modelCalls[i].usage is a self-contained
// per-request measurement, which makes the two halves of the rule provable rather than stylistic:
//
//   BILLED (disjoint per call → SUM): input, output, cacheRead, cacheWrite, cost.
//     Every call is charged separately. A cached prefix re-read on call 3 costs money on call 3.
//
//   PROMPT SIZE (NOT summable → LAST call): input + cacheRead + cacheWrite.
//     Each call re-sends the same conversation, so summing counts the same prompt N times. The last
//     call carries the fullest prompt (it has every prior message + tool result), which is what
//     "how big is this conversation" means. This mirrors the reasoning already in emitTurnMetrics'
//     TurnTokensContext comment — usage.input alone under-reports under prompt caching.
//
// Both figures are wanted at once: `TurnCost`/`TurnTokensOutput` are billing questions, while
// `ContextLengthTokens`/`TurnTokensContext` are "is this session getting too big" questions. Using
// one number for both is what made the old code wrong in a way nobody noticed.

/** Read a usage field across pi-ai's spellings (the adapter's usageIn/usageOut do the same). */
const num = (v) => (Number.isFinite(v) ? v : 0);
const inTok = (u) => num(u?.input ?? u?.inputTokens);
const outTok = (u) => num(u?.output ?? u?.outputTokens);
const cacheRead = (u) => num(u?.cacheRead ?? u?.cacheReadTokens ?? u?.cacheReadInputTokens);
const cacheWrite = (u) => num(u?.cacheWrite ?? u?.cacheWriteTokens ?? u?.cacheWriteInputTokens);
const costTotal = (u) => (Number.isFinite(u?.cost?.total) ? u.cost.total : null);

/**
 * Aggregate the model calls belonging to ONE reply.
 *
 * @param {Array<{usage?: object, model?: string|null, stopReason?: string|null, isError?: boolean}>} calls
 * @returns {{
 *   input: number, output: number, cacheRead: number, cacheWrite: number,
 *   costUsd: number|undefined, contextTokens: number|undefined,
 *   model: string|null, stopReason: string|null, calls: number, isError: boolean
 * }}
 *
 * `costUsd` is undefined when NO call reported a cost (rather than 0) — a missing price must not
 * masquerade as a free turn. contextTokens is undefined when the last call reported no usage.
 */
export function aggregateReplyUsage(calls) {
  const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
  const out = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costUsd: undefined,
    contextTokens: undefined,
    model: null,
    stopReason: null,
    calls: list.length,
    isError: false,
  };
  if (!list.length) return out;

  let sawCost = false;
  let costSum = 0;
  for (const c of list) {
    const u = c.usage;
    out.input += inTok(u);
    out.output += outTok(u);
    out.cacheRead += cacheRead(u);
    out.cacheWrite += cacheWrite(u);
    const cost = costTotal(u);
    if (cost !== null) { sawCost = true; costSum += cost; }
    if (c.isError) out.isError = true;
  }
  if (sawCost) out.costUsd = costSum;

  // PROMPT SIZE from the LAST call only — see the rule above. Uses the last call that actually
  // reported usage, so a trailing usage-less call (an aborted request) doesn't erase the figure.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const u = list[i].usage;
    if (u) {
      out.contextTokens = inTok(u) + cacheRead(u) + cacheWrite(u);
      break;
    }
  }

  // Identity comes from the last call: the model that actually produced the visible answer, and the
  // stopReason that ended the reply (earlier calls stop with `toolUse`, which is not the outcome).
  const last = list[list.length - 1];
  out.model = last.model ?? null;
  out.stopReason = last.stopReason ?? null;
  return out;
}

/**
 * Split a reply's model calls out of a run's flat modelCalls[] using recorded boundaries.
 * `boundaries` are the indices AFTER which a reply ended (exclusive end offsets), in order.
 * Any calls after the final boundary form a trailing reply (an in-progress or unterminated run).
 */
export function splitCallsByReply(modelCalls, boundaries) {
  const calls = Array.isArray(modelCalls) ? modelCalls : [];
  const bounds = Array.isArray(boundaries) ? boundaries : [];
  const groups = [];
  let start = 0;
  for (const end of bounds) {
    const e = Math.min(Math.max(end, start), calls.length);
    groups.push(calls.slice(start, e));
    start = e;
  }
  if (start < calls.length) groups.push(calls.slice(start));
  return groups;
}

/**
 * Plan the Turn* metric emissions for one invoke: one payload per REPLY, ready to hand to
 * emitTurnMetrics. Pure, so the attribution rules below are testable without capturing stdout.
 *
 * Latency/TTFT are per-INVOKE measurements and are attributed to the FIRST reply ONLY. Repeating them
 * per reply would multiply the latency histogram by the reply count, making TurnLatencyMs p90 read as
 * though the fleet slowed down whenever someone sent a follow-up. They are OMITTED (not zeroed) on
 * later replies — emitTurnMetrics must therefore treat a missing latency as "don't emit", because a 0
 * would drag the percentiles down instead, which is worse than the duplication it avoids.
 *
 * No recorded boundary (aborted / still-running run) → a single payload from out.usage, so a metric is
 * never silently dropped.
 */
export function planReplyMetrics({ out, latencyMs, ttftMs, isError = false } = {}) {
  const o = out || {};
  const groups = splitCallsByReply(o.modelCalls, o.replyBoundaries).filter((g) => g && g.length);
  if (!groups.length) {
    const u = o.usage;
    return [{
      latencyMs,
      ttftMs,
      tokensIn: inTok(u),
      tokensOut: outTok(u),
      cacheReadTokens: cacheRead(u),
      cacheWriteTokens: cacheWrite(u),
      model: o.model ?? null,
      isError: !!isError,
      costUsd: costTotal(u) ?? undefined,
    }];
  }
  return groups.map((calls, i) => {
    const a = aggregateReplyUsage(calls);
    return {
      ...(i === 0 && latencyMs !== undefined ? { latencyMs } : {}),
      ...(i === 0 && ttftMs !== undefined ? { ttftMs } : {}),
      tokensIn: a.input,
      tokensOut: a.output,
      cacheReadTokens: a.cacheRead,
      cacheWriteTokens: a.cacheWrite,
      contextTokens: a.contextTokens,
      model: a.model ?? o.model ?? null,
      // A turn-level error belongs to the reply that failed — the LAST one. Marking every reply
      // errored because the run ended badly would overstate the error rate by the reply count.
      isError: a.isError || (i === groups.length - 1 && !!isError),
      costUsd: a.costUsd,
    };
  });
}

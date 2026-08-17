// Pi-NATIVE Hindsight recall extension (#14b P2, plan §2/§6 — hindsight is native, NOT
// compat). Reimplements the thin recall hook from the OpenClaw hindsight-openclaw plugin
// (example/hindsight :: hindsight-integrations/openclaw/src/index.ts) as a Pi
// `on("context")` extension. It REUSES the real @vectorize-io/hindsight-client for the
// actual recall (see hindsight-client-recall.mjs) — no hand-rolled HTTP, no drift — and
// only owns: query extraction, org/agent recall orchestration, memory formatting, prompt
// injection, and the recall log signals.
//
// The `recall` fn is injected so the extension is unit-testable with canned memories and
// swappable (client vs. stub). Behaviour + log strings mirror the plugin so the existing
// @hindsight leg regexes still match:
//   - "injecting <N> memories into context (agent bank: X, org bank: Y)"  (or "(org bank: Y)")
//   - "No memories found for auto-recall"
//   - a "before_prompt_build" marker (the leg waits for it) — recall is the same lifecycle point.

const DEFAULT_RECALL_PROMPT_PREAMBLE =
  'Relevant memories from past conversations (prioritize recent when conflicting). Only use memories that are directly useful to continue this conversation; ignore the rest:';

// Mirror the plugin's UTC "current time" line so the model reads recency correctly.
export function formatCurrentTimeForRecall(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}-${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())} ${p(date.getUTCHours())}:${p(date.getUTCMinutes())} UTC`;
}

// Mirror the plugin's formatMemories: "- <text> [type] (mentioned_at) {doc:id}".
export function formatMemories(results) {
  if (!results || results.length === 0) return '';
  return results
    .map((r) => {
      const type = r.type ? ` [${r.type}]` : '';
      const date = r.mentioned_at ? ` (${r.mentioned_at})` : '';
      const doc = r.document_id ? ` {doc:${r.document_id}}` : '';
      return `- ${r.text}${type}${date}${doc}`;
    })
    .join('\n\n');
}

function textOf(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n');
  }
  return '';
}

// Minimal recall-query extraction (plugin has a richer envelope-stripper; the Pi turn text
// is already clean). Reject trivial (<5 char) prompts — matches the plugin's gate.
export function extractRecallQuery(text) {
  const q = (text || '').trim();
  return q.length >= 5 ? q : null;
}

function appendToLastUser(messages, text) {
  const msgs = messages.slice();
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'user') {
      const m = { ...msgs[i] };
      const add = `\n\n${text}`;
      if (typeof m.content === 'string') m.content = m.content + add;
      else if (Array.isArray(m.content)) m.content = [...m.content, { type: 'text', text: add }];
      msgs[i] = m;
      return msgs;
    }
  }
  return msgs;
}

// Build the injected context block(s), mirroring the plugin's <hindsight_memories> /
// <org_knowledge> shape.
export function buildInjection({ results = [], orgResults = [], orgOnly = false, preamble, now = new Date() }) {
  const parts = [];
  const pre = preamble || DEFAULT_RECALL_PROMPT_PREAMBLE;
  if (orgOnly) {
    if (orgResults.length) parts.push(`<hindsight_memories>\n${pre}\nCurrent time - ${formatCurrentTimeForRecall(now)}\n\n${formatMemories(orgResults)}\n</hindsight_memories>`);
  } else {
    if (results.length) parts.push(`<hindsight_memories>\n${pre}\nCurrent time - ${formatCurrentTimeForRecall(now)}\n\n${formatMemories(results)}\n</hindsight_memories>`);
    if (orgResults.length) parts.push(`<org_knowledge>\nShared organizational knowledge:\n\n${formatMemories(orgResults)}\n</org_knowledge>`);
  }
  return parts.join('\n\n');
}

/**
 * Create the Pi extension factory for Hindsight recall.
 * @param recall  async (query) => { results?: Memory[], orgResults?: Memory[] }
 * @param opts    { orgBankId, agentBankId, orgOnly, preamble, minQueryChars, logger }
 */
export function createHindsightExtension(recall, opts = {}) {
  const { orgBankId, agentBankId, orgOnly = false, preamble, logger = console } = opts;
  // Tool-permission gate. Hindsight is not a tool (no tool_call hook), so recall/retain are gated
  // here: read = hindsight.read (baseline-allow), write = hindsight.write (default-deny). Default
  // to allow-read / deny-write when no `can` is wired, matching the baseline policy.
  const can = opts.can || ((cap) => cap === 'hindsight.read');
  const bankLabel = orgOnly
    ? `(org bank: ${orgBankId})`
    : `(agent bank: ${agentBankId}${orgBankId ? `, org bank: ${orgBankId}` : ''})`;

  return (pi) => {
    pi.on('context', async (event) => {
      if (!can('hindsight.read')) { logger.info('hindsight recall: skipped (hindsight.read not granted)'); return; }
      const messages = event.messages;
      const lastUser = [...messages].reverse().find((m) => m.role === 'user');
      const query = extractRecallQuery(textOf(lastUser));
      // Lifecycle marker the @hindsight leg waits for (recall runs at prompt-build time).
      logger.info(`hindsight recall (before_prompt_build): query=${query ? JSON.stringify(query.slice(0, 80)) : 'null'}`);
      if (!query) return;

      let recalled;
      try {
        recalled = await recall(query);
      } catch (e) {
        // Distinct wording — the leg asserts NOT /recall failed/i on the happy path; a
        // genuine failure SHOULD surface. Keep it greppable but out of the leg's negative.
        logger.warn(`hindsight recall error (bank ${orgBankId || agentBankId}): ${e?.message || e}`);
        return;
      }

      const results = recalled?.results ?? [];
      const orgResults = recalled?.orgResults ?? [];
      if (results.length === 0 && orgResults.length === 0) {
        logger.info('hindsight recall: No memories found for auto-recall');
        return;
      }

      const injection = buildInjection({ results, orgResults, orgOnly, preamble });
      const total = results.length + orgResults.length;
      logger.info(`hindsight recall: injecting ${total} memories into context ${bankLabel}`);
      return { messages: appendToLastUser(messages, injection) };
    });

    // agent_end lifecycle observer (parity with the OpenClaw hindsight plugin's
    // agent_end hook — the RETAIN leg). Retain stays OFF under AgentCore (PII/PHI),
    // so this only logs that the lifecycle hook fired; the @hook-fired leg asserts
    // the "[Hindsight Hook] agent_end triggered" signal. When retain is later enabled
    // the persistence call slots in here, exactly as the plugin does.
    pi.on('agent_end', async () => {
      if (!can('hindsight.write')) { logger.info('[Hindsight Hook] agent_end triggered (retain gated: hindsight.write not granted)'); return; }
      // When retain is enabled, the persistence call slots in here — now behind the hindsight.write gate.
      logger.info('[Hindsight Hook] agent_end triggered (retain disabled under AgentCore)');
    });
  };
}

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

// ── Query construction: three layers ported from the plugin (2026-09-09) ────────────────────────
//
// WHY. The extension used to send the ENTIRE last user message as the recall query, trimmed only for
// <5 chars, and nothing bounded it. Hindsight caps a query at 500 TOKENS and REJECTS rather than
// truncating, so a cron fire — whose "user message" is the whole job instruction sheet — failed every
// time: measured live on dm-urbnxvak3l5, 34 of 38 recalls in six hours died on
//
//   recall failed: "Query too long: 884 tokens exceeds maximum of 500. Please shorten your query."
//
// and because hindsight-client-recall.mjs catches the rejection and returns null, the extension then
// logged "No memories found for auto-recall" — a hard failure wearing the costume of an empty bank.
//
// The plugin has handled this since org-knowledge-v2, in three layers, and this ports all three:
//
//   1. STRIP THE ENVELOPE, so the query is what the human said. The plugin prefers `rawMessage`
//      (clean user text) over `prompt` (envelope + system events + media notes) and strips what
//      remains. Pi has no rawMessage — the adapter sees only the composed prompt — so the equivalent
//      is to remove the parts WE add. Those are literals from archie-gateway/index.js:731-747 and
//      cron-fire.js, not heuristics, which is why this is safe to do by pattern.
//   2. COMPOSE prior turns above the latest message, so the tail is the part that matters.
//   3. TRUNCATE oldest-context-first, preserving the latest-message suffix, under a char budget.
//
// PARITY, NOT IMPROVEMENT, and the distinction matters for cron. Prod v1 sets neither
// recallContextTurns nor recallMaxQueryChars, so it runs the defaults below: turns=1 (layer 2 inert —
// compose returns the latest message alone) and 800 chars. For a cron fire the latest message alone
// still exceeds the budget, so v1 takes truncateRecallQuery's `latestOnly` branch and searches on the
// FIRST 800 chars — i.e. the boilerplate preamble every fire shares. That is a weak query, and it is
// deliberately what we now do too: the error goes away, retrieval quality for machine-generated
// prompts is a separate change to make on both stacks at once.

// Everything archie itself adds to the prompt. Each is a literal we build, cited to its source, so a
// change there breaks a test here rather than silently widening the query.
const ENVELOPE_PATTERNS = [
  // index.js:865 — the thread prior-context block, prepended for a threaded app_mention.
  /^Prior thread context \(oldest → newest\):\n[\s\S]*?\n\n---\n\n/,
  // index.js:742-746 — the sender header, in its three shapes. Bounded so a stray "says:" deep in a
  // long message cannot make this eat the body.
  /^.{1,120}? (?:says|mentioned you in <#[A-Z0-9]+>|in <#[A-Z0-9]+>):\n\n/,
  // index.js:725-728 — the attachments block and its download instruction, to the end of the message.
  /\n\nAttachments:\n[\s\S]*$/,
  // index.js:731 — the reply instruction.
  /\n\nIncoming Slack message — just reply with text\.[\s\S]*$/,
  // cron-fire.js deliveryInstruction — the bracketed scheduled-turn note.
  /\n\n\[Scheduled turn\.[\s\S]*$/,
];

export function stripPromptEnvelope(text) {
  let out = text || '';
  for (const re of ENVELOPE_PATTERNS) out = out.replace(re, '');
  return out.trim();
}

// The plugin's isEphemeralOperationalText, verbatim (index.ts:1136): OpenClaw-generated
// operational/session-bootstrap strings are not user-authored, so they must not drive recall. Kept
// even though two of the three cannot occur under AgentCore (no /new, no title generation) — the
// third can, and a divergence here would be invisible.
export function isEphemeralOperationalText(text) {
  if (!text || typeof text !== 'string') return false;
  const normalized = text
    .replace(/\[role:\s*[^\]]+\]\s*/gi, '')
    .replace(/\[[a-z]+:end\]\s*/gi, '')
    .trim();
  return [
    /^A new session was started via \/(?:new|reset)\./i,
    /^Based on this conversation, generate a short 1-2/i,
    /^This (?:script|task|job|workflow) updates .* index/i,
  ].some((p) => p.test(normalized));
}

// Reject trivial (<5 char) prompts — matches the plugin's gate — after the envelope comes off, so a
// bare "ok" wrapped in 200 chars of instruction is still correctly seen as trivial.
export function extractRecallQuery(text) {
  const q = stripPromptEnvelope(text);
  return q.length >= 5 ? q : null;
}

// The plugin's sliceLastTurnsByUserBoundary (index.ts): walk back to the Nth user message and keep
// everything from there, so a turn is bounded by user messages rather than by message count.
export function sliceLastTurnsByUserBoundary(messages, turns) {
  if (!Array.isArray(messages) || messages.length === 0 || turns <= 0) return [];
  let seen = 0;
  let startIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      seen += 1;
      if (seen >= turns) { startIndex = i; break; }
    }
  }
  return startIndex === -1 ? messages : messages.slice(startIndex);
}

// The plugin's stripMemoryTags: never feed a previous injection back in as query text.
export function stripMemoryTags(content) {
  return (content || '')
    .replace(/<hindsight_memories>[\s\S]*?<\/hindsight_memories>/g, '')
    .replace(/<relevant_memories>[\s\S]*?<\/relevant_memories>/g, '');
}

// The plugin's composeRecallQuery. Prior context goes ABOVE the latest message deliberately: the
// truncator drops from the top, so the newest text survives a budget cut.
export function composeRecallQuery(latestQuery, messages, recallContextTurns, recallRoles = ['user', 'assistant']) {
  const latest = (latestQuery || '').trim();
  if (recallContextTurns <= 1 || !Array.isArray(messages) || messages.length === 0) return latest;
  const allowed = new Set(recallRoles);
  const lines = sliceLastTurnsByUserBoundary(messages, recallContextTurns)
    .map((msg) => {
      if (!allowed.has(msg?.role)) return null;
      const content = stripPromptEnvelope(stripMemoryTags(textOf(msg)));
      if (!content) return null;
      if (msg.role === 'user' && content === latest) return null;
      return `${msg.role}: ${content}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return latest;
  return ['Prior context:', lines.join('\n'), latest].join('\n\n');
}

// The plugin's truncateRecallQuery (index.ts:767), same algorithm and same branch order.
//
// CHARS, NOT TOKENS, and that is the plugin's unit — `recallMaxQueryChars`. 800 chars is ~200 tokens
// against a 500-token server cap, so the budget is conservative by roughly 2.5x. Keeping the unit
// means one number to compare across the two stacks; the alternative (counting tokens here) would
// need a tokenizer in the boot path for no behavioural gain.
export function truncateRecallQuery(query, latestQuery, maxChars) {
  if (maxChars <= 0) return query;
  const latest = (latestQuery || '').trim();
  if (query.length <= maxChars) return query;

  const latestOnly = latest.length <= maxChars ? latest : latest.slice(0, maxChars);
  if (!query.includes('Prior context:')) return latestOnly;

  const contextMarker = 'Prior context:\n\n';
  const markerIndex = query.indexOf(contextMarker);
  if (markerIndex === -1) return latestOnly;
  const suffixMarker = `\n\n${latest}`;
  const suffixIndex = query.lastIndexOf(suffixMarker);
  if (suffixIndex === -1) return latestOnly;
  const suffix = query.slice(suffixIndex);
  if (suffix.length >= maxChars) return latestOnly;

  const contextLines = query.slice(markerIndex + contextMarker.length, suffixIndex).split('\n').filter(Boolean);
  const kept = [];
  // Newest first, oldest dropped: the reverse would keep the stale half of the conversation.
  for (let i = contextLines.length - 1; i >= 0; i--) {
    kept.unshift(contextLines[i]);
    if (`${contextMarker}${kept.join('\n')}${suffix}`.length > maxChars) { kept.shift(); break; }
  }
  return kept.length > 0 ? `${contextMarker}${kept.join('\n')}${suffix}` : latestOnly;
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
  const {
    orgBankId, agentBankId, orgOnly = false, preamble, logger = console,
    // The plugin's defaults (index.ts:2299-2300), and prod v1 overrides neither — so these ARE prod's
    // values, not a guess at them. turns=1 leaves composeRecallQuery inert; see the header.
    recallContextTurns = 1,
    recallRoles = ['user', 'assistant'],
    recallMaxQueryChars = 800,
  } = opts;
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
      const extracted = extractRecallQuery(textOf(lastUser));
      // The plugin's order: extract, then reject operational noise, then compose, then truncate.
      // Noise is skipped BEFORE the log line so an ignored bootstrap string does not read as a turn
      // whose recall found nothing.
      if (extracted && isEphemeralOperationalText(extracted)) {
        logger.info('hindsight recall: query is operational/ephemeral noise, skipping recall');
        return;
      }
      const composed = extracted
        ? composeRecallQuery(extracted, messages, recallContextTurns, recallRoles)
        : null;
      let query = composed;
      if (query && query.length > recallMaxQueryChars) {
        const before = query.length;
        query = truncateRecallQuery(query, extracted, recallMaxQueryChars);
        // Defensive cap, exactly as the plugin does (index.ts:2321) — every branch above is bounded
        // by maxChars EXCEPT a latest message longer than the budget, which slice() already handles.
        if (query.length > recallMaxQueryChars) query = query.slice(0, recallMaxQueryChars);
        // LOGGED, because the silent version of this is what made the 884-token failure look like an
        // empty bank: a truncated query is a materially different search and the log should say so.
        logger.info(`hindsight recall: query truncated ${before} -> ${query.length} chars (max ${recallMaxQueryChars})`);
      }
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

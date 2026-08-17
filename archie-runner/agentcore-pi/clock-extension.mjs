// Per-turn wall-clock injection.
//
// WHY: Pi's system prompt carries exactly one time signal — `Current date: YYYY-MM-DD`
// (pi-coding-agent/dist/core/system-prompt.js) — which is (a) DAY precision, no clock time,
// no epoch, and (b) computed ONCE when the session object is built and then cached for the
// life of the warm microVM, so on a long-lived session it is also stale. So whenever the
// model needs an absolute time — most visibly `cron` `{kind:"at", at}` — it has no source
// for one and invents it. A hallucinated epoch is not a soft failure: unix-seconds-shaped
// guesses used to pass the dispatcher's finite-number check and land in 1970, which the
// runner reads as an elapsed one-shot (fire once immediately, then self-delete).
// cron-tool-core now accepts relative offsets ("+1h") so the model never HAS to compute an
// epoch; this closes the other half by giving it a real clock when it wants one.
//
// HOW: a Pi `context` extension (same lifecycle point as the hindsight recall extension —
// `transformContext`, which runs per provider request and is NOT persisted to the session
// file, so nothing accumulates on disk).
//
// PROMPT-CACHE DISCIPLINE: the injected text is appended to the last user message, i.e.
// mid-history once a tool loop starts, so a value that changed on every step would
// invalidate the cached tail repeatedly. `getNow` is therefore expected to return a
// TURN-STABLE timestamp (the adapter passes the turn's start time): fresh once per turn,
// byte-identical across that turn's tool-loop steps.

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The injected block. Both unix forms are given explicitly because the whole failure mode is
 * unit confusion (seconds vs milliseconds) — the model should copy, not convert.
 */
export function formatClock(nowMs) {
  const ms = Math.floor(nowMs);
  const d = new Date(ms);
  return [
    '<current_time>',
    `unix_seconds: ${Math.floor(ms / 1000)}`,
    `unix_ms: ${ms}`,
    `iso_utc: ${d.toISOString()}`,
    `weekday_utc: ${WEEKDAYS[d.getUTCDay()]}`,
    '</current_time>',
    'This is the real current time. Use these values for any absolute timestamp you need '
    + '(and never invent one). For a time in the future, prefer a relative form where the tool '
    + 'takes one — e.g. cron `at: "+1h"` — over doing epoch arithmetic yourself.',
  ].join('\n');
}

// Append to the last user message (mirrors hindsight-extension.appendToLastUser: a new
// trailing user message would break Bedrock's role-alternation once tool results are in play).
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

/**
 * Pi extension factory.
 * @param opts.getNow () => number  turn-stable epoch-ms (defaults to Date.now)
 *
 * Register LAST: the hindsight extension extracts its recall query from the last user
 * message, and it must see the human's text, not our clock block.
 */
export function createClockExtension(opts = {}) {
  const getNow = opts.getNow || (() => Date.now());
  return (pi) => {
    pi.on('context', async (event) => {
      const nowMs = getNow();
      if (!Number.isFinite(nowMs)) return; // never break a turn over a clock
      return { messages: appendToLastUser(event.messages, formatClock(nowMs)) };
    });
  };
}

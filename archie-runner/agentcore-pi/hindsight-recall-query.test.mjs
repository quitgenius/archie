// node --test hindsight-recall-query.test.mjs
//
// The recall-query pipeline: envelope strip -> noise gate -> compose -> truncate.
//
// Two kinds of test here, kept apart on purpose:
//
//   PARITY — assertions ported from the plugin's own suite
//   (example/hindsight :: hindsight-integrations/openclaw/src/index.test.ts, describe blocks
//   sliceLastTurnsByUserBoundary / composeRecallQuery / truncateRecallQuery / the
//   isEphemeralOperationalText cases). Same inputs, same expectations. If one of these fails, the two
//   stacks have diverged on query construction, which is the whole thing this port exists to prevent.
//
//   ARCHIE — the envelope is ours, so its cases cannot be ported. The literals under test come from
//   archie-gateway/index.js:731-747/865 and cron-fire.js; a change there should fail here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractRecallQuery,
  stripPromptEnvelope,
  isEphemeralOperationalText,
  sliceLastTurnsByUserBoundary,
  composeRecallQuery,
  truncateRecallQuery,
  createHindsightExtension,
} from './hindsight-extension.mjs';

// ── PARITY: sliceLastTurnsByUserBoundary ────────────────────────────────────────────────────────
test('parity: returns the whole list when requested turns exceed available user turns', () => {
  const messages = [
    { role: 'system', content: 'System preface' },
    { role: 'user', content: 'Turn 1 user' },
    { role: 'assistant', content: 'Turn 1 assistant' },
    { role: 'user', content: 'Turn 2 user' },
    { role: 'assistant', content: 'Turn 2 assistant' },
  ];
  assert.deepEqual(sliceLastTurnsByUserBoundary(messages, 3), messages);
});

test('parity: slices by user-turn boundaries with system/tool messages present', () => {
  const messages = [
    { role: 'system', content: 'System preface' },
    { role: 'user', content: 'Turn 1 user' },
    { role: 'assistant', content: 'Turn 1 assistant' },
    { role: 'tool', content: 'Tool output in turn 1' },
    { role: 'user', content: 'Turn 2 user' },
    { role: 'assistant', content: 'Turn 2 assistant' },
    { role: 'system', content: 'System note in turn 2' },
    { role: 'user', content: 'Turn 3 user' },
    { role: 'assistant', content: 'Turn 3 assistant' },
  ];
  assert.deepEqual(sliceLastTurnsByUserBoundary(messages, 2), messages.slice(4));
});

test('parity: empty list for invalid turn counts', () => {
  assert.deepEqual(sliceLastTurnsByUserBoundary([{ role: 'user', content: 'Hello' }], 0), []);
});

// ── PARITY: composeRecallQuery ──────────────────────────────────────────────────────────────────
test('parity: turns=1 returns the latest query unchanged — this is prod v1s configuration', () => {
  const q = composeRecallQuery('What is my preference?', [{ role: 'user', content: 'Old message' }], 1);
  assert.equal(q, 'What is my preference?');
});

test('parity: turns>1 includes prior user/assistant context, latest LAST', () => {
  const messages = [
    { role: 'user', content: 'I like dark mode.' },
    { role: 'assistant', content: 'Got it, dark mode noted.' },
    { role: 'user', content: 'What theme do I prefer?' },
  ];
  const q = composeRecallQuery('What theme do I prefer?', messages, 2);
  assert.ok(q.includes('user: I like dark mode.'));
  assert.ok(q.includes('assistant: Got it, dark mode noted.'));
  // The order is load-bearing: the truncator drops from the top, so the latest must be at the bottom.
  assert.ok(q.indexOf('Prior context:') < q.indexOf('What theme do I prefer?'));
});

test('parity: respects recallRoles', () => {
  const messages = [
    { role: 'system', content: 'System context' },
    { role: 'assistant', content: 'Assistant context' },
    { role: 'user', content: 'What theme do I prefer?' },
  ];
  assert.equal(composeRecallQuery('What theme do I prefer?', messages, 2, ['user']), 'What theme do I prefer?');
});

test('parity: falls back to the latest query when context has no usable text', () => {
  assert.equal(composeRecallQuery('Summarize my preference', [{ role: 'tool', content: 'binary blob' }], 3),
    'Summarize my preference');
});

// ── PARITY: truncateRecallQuery ─────────────────────────────────────────────────────────────────
test('parity: unchanged when under the budget', () => {
  assert.equal(truncateRecallQuery('short query', 'short query', 100), 'short query');
});

test('parity: a non-context query over budget falls back to the latest, sliced', () => {
  const latest = 'What foods do I like?';
  const long = `${latest} ${'x'.repeat(300)}`;
  assert.equal(truncateRecallQuery(long, latest, 20), latest.slice(0, 20));
});

test('parity: trims prior context first and preserves the latest section', () => {
  const latest = 'What foods do I like?';
  const composed = ['Prior context:', 'user: I like sushi.', 'assistant: You like sushi and ramen.', 'user: Also pizza.', latest].join('\n\n');
  const truncated = truncateRecallQuery(composed, latest, 180);
  assert.ok(truncated.includes(latest));
  assert.ok(truncated.length <= 180);
});

// ── PARITY: isEphemeralOperationalText ──────────────────────────────────────────────────────────
test('parity: operational bootstrap strings are noise, real questions are not', () => {
  assert.equal(isEphemeralOperationalText('A new session was started via /reset.'), true);
  assert.equal(isEphemeralOperationalText('[role: user]\nA new session was started via /new.\n[user:end]'), true);
  assert.equal(isEphemeralOperationalText('Tell me what I said about dark mode.'), false);
});

// ── ARCHIE: the envelope we add ─────────────────────────────────────────────────────────────────
const REPLY_INSTRUCTION = '\n\nIncoming Slack message — just reply with text. Your response is streamed to Slack automatically.';

test('archie: a DM strips the sender header and the reply instruction', () => {
  const raw = `person3018f1 (<@UJ4IGI7XE>) says:\n\ntesting hindsight org recall${REPLY_INSTRUCTION}`;
  assert.equal(extractRecallQuery(raw), 'testing hindsight org recall');
});

test('archie: a channel mention and a plain channel message strip their headers', () => {
  assert.equal(extractRecallQuery(`Peer Hill (<@UMRSP7355U7>) mentioned you in <#CQYQ72C616G>:\n\nwhat do we know about pact?${REPLY_INSTRUCTION}`),
    'what do we know about pact?');
  assert.equal(extractRecallQuery(`Peer Hill (<@UMRSP7355U7>) in <#CQYQ72C616G>:\n\nwhat do we know about pact?${REPLY_INSTRUCTION}`),
    'what do we know about pact?');
});

test('archie: the thread prior-context block is stripped, leaving only what was just said', () => {
  const raw = 'Prior thread context (oldest → newest):\n'
    + 'an operator (<@UJ4IGI7XE>): earlier question\nArchie: earlier answer\n\n---\n\n'
    + `an operator (<@UJ4IGI7XE>) mentioned you in <#CQYQ72C616G>:\n\nand what about renewals?${REPLY_INSTRUCTION}`;
  assert.equal(extractRecallQuery(raw), 'and what about renewals?');
});

test('archie: the attachments block does not become part of the query', () => {
  const raw = 'an operator (<@UJ4IGI7XE>) says:\n\nsummarise this deck'
    + '\n\nAttachments:\n- deck.pdf (812KB, application/pdf) — ref: abc.def'
    + '\n\n[To download these files, use the slack_download_file tool with the ref value shown above.]';
  assert.equal(extractRecallQuery(raw), 'summarise this deck');
});

test('archie: a cron fire strips the scheduled-turn delivery note', () => {
  const raw = 'Check the overnight sync and report anything that failed.'
    + '\n\n[Scheduled turn. Your reply text is delivered to Slack automatically when this turn ends.]';
  assert.equal(extractRecallQuery(raw), 'Check the overnight sync and report anything that failed.');
});

test('archie: a message that is only envelope yields no query', () => {
  assert.equal(extractRecallQuery(`an operator (<@UJ4IGI7XE>) says:\n\nok${REPLY_INSTRUCTION}`), null,
    'trivial after the envelope comes off — the <5 char gate applies to the real text');
});

test('archie: a stray "says:" inside a long body cannot eat the message', () => {
  const body = `${'a'.repeat(200)} she says: hello`;
  assert.equal(extractRecallQuery(body), body, 'the header pattern is bounded to 120 chars and anchored');
});

// ── ARCHIE: the regression this port exists for ─────────────────────────────────────────────────
test('archie: the 884-token cron prompt that failed live now fits the budget', () => {
  // Shaped like the live failure on dm-urbnxvak3l5: a long instruction sheet as the "user message".
  const jobSheet = 'You are a background automation agent. Your job: check Lauren Sims\'s Google Calendar '
    + 'for tomorrow and post a briefing. '.repeat(120);
  const extracted = extractRecallQuery(jobSheet);
  assert.ok(extracted.length > 3000, 'the raw prompt really is far over budget');
  const composed = composeRecallQuery(extracted, [{ role: 'user', content: jobSheet }], 1);
  const query = truncateRecallQuery(composed, extracted, 800);
  assert.equal(query.length, 800);
  assert.ok(query.startsWith('You are a background automation agent.'),
    'v1 keeps the HEAD in this branch — parity, and the reason cron retrieval is still weak');
});

// ── the hook, end to end ───────────────────────────────────────────────────────────────────────
function harness({ opts = {}, recalled = { orgResults: [] } } = {}) {
  const logs = [];
  const calls = [];
  const logger = { info: (m) => logs.push(m), warn: (m) => logs.push(m) };
  const recall = async (q) => { calls.push(q); return recalled; };
  const factory = createHindsightExtension(recall, {
    orgBankId: 'default-org', orgOnly: true, logger, can: () => true, ...opts,
  });
  let handler;
  factory({ on: (name, fn) => { if (name === 'context') handler = fn; } });
  return { handler, logs, calls };
}

test('hook: operational noise skips recall entirely — no query is sent', async () => {
  const { handler, logs, calls } = harness();
  await handler({ messages: [{ role: 'user', content: 'A new session was started via /new.' }] });
  assert.equal(calls.length, 0);
  assert.ok(logs.some((l) => /operational\/ephemeral noise/.test(l)));
  assert.ok(!logs.some((l) => /before_prompt_build/.test(l)), 'and it does not read as a turn that found nothing');
});

test('hook: an over-budget query is truncated, logged, and still recalls', async () => {
  const { handler, logs, calls } = harness({ recalled: { orgResults: [{ text: 'a fact' }] } });
  await handler({ messages: [{ role: 'user', content: 'x'.repeat(2000) }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 800, 'the client never sees more than the budget');
  assert.ok(logs.some((l) => /query truncated 2000 -> 800 chars \(max 800\)/.test(l)));
});

test('hook: a normal Slack message reaches recall with the envelope already off', async () => {
  const { handler, calls } = harness({ recalled: { orgResults: [{ text: 'a fact' }] } });
  const res = await handler({
    messages: [{ role: 'user', content: `an operator (<@UJ4IGI7XE>) says:\n\nwhat do we know about pact?${REPLY_INSTRUCTION}` }],
  });
  assert.deepEqual(calls, ['what do we know about pact?']);
  assert.ok(res.messages[0].content.includes('<hindsight_memories>'), 'and the memories are injected');
});

test('hook: the budget is configurable, and a wider one passes more through', async () => {
  const { handler, calls } = harness({ opts: { recallMaxQueryChars: 1500 } });
  await handler({ messages: [{ role: 'user', content: 'y'.repeat(2000) }] });
  assert.equal(calls[0].length, 1500);
});

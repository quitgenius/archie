// Tests for `toolOutcome` / `outcomeAttributes` — the tool-call outcome on a span.
//
// TWO PROPERTIES, and they pull against each other, which is why both get tests:
//
//   1. A FAILED CALL MUST BE VISIBLE. The live gap this closes: a Connector tool call that fails
//      returns HTTP 200 with `{"successful": false, "error": "..."}`, so Pi sets no `isError` and the
//      span was green. Measured 2026-08-21 on `gmail-count-every-10min` — one 755ms tool span, no
//      error flag, a 43-character answer, and nothing in OTEL able to say the Gmail lookup had failed.
//
//   2. THE PAYLOAD MUST NOT ESCAPE. The result is output — mailbox contents, calendar entries, Notion
//      pages. Only ok/code/message/chars may be returned. The last test is the guard: it feeds a
//      payload full of distinctive content and asserts none of it appears anywhere in the output.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolOutcome, outcomeAttributes } from './tool-outcome.mjs';

/** One MCP layer: the envelope arrives as JSON inside a text content block. */
const layer = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj) }] });

/**
 * THE REAL SHAPE, copied from a live cron turn (2026-08-21, trace 1-2e9a2e29…). The result is DOUBLY
 * nested: the toolResult's text is an MCP envelope whose text is the Connector body. The first version
 * of this module parsed once, landed on `{content:[…]}`, found no `successful`, and reported
 * `ok: null` for every tool call in every trace — the attribute was never emitted at all.
 */
const mcp = (obj) => layer(layer(obj));

/** The batch envelope `CONNECTOR_MULTI_EXECUTE_TOOL` returns: one entry per inner tool. */
const batch = (...responses) => mcp({ data: { results: responses.map((response) => ({ response })) } });

test('a connector failure envelope is a FAILURE, despite no thrown error', () => {
  const o = toolOutcome(mcp({ successful: false, error: 'Gmail connection not found for entity' }), false);
  assert.equal(o.ok, false);
  assert.equal(o.message, 'Gmail connection not found for entity');
});

test('a connector success envelope is a success', () => {
  const o = toolOutcome(mcp({ successful: true, data: { messagesTotal: 71540 } }), false);
  assert.equal(o.ok, true);
  assert.equal(o.message, null);
});

test('`success` is honoured as well as `successful`', () => {
  assert.equal(toolOutcome(mcp({ success: false, error: 'nope' })).ok, false);
  assert.equal(toolOutcome(mcp({ success: true })).ok, true);
});

test('a thrown call is false whatever the body says', () => {
  // Pi's own flag wins. A tool that threw did not do its job even if it managed to emit
  // `successful: true` on the way out.
  assert.equal(toolOutcome(mcp({ successful: true }), true).ok, false);
  assert.equal(toolOutcome(null, true).ok, false);
});

test('no envelope yields ok:null — NOT success', () => {
  // The load-bearing distinction. Coercing this to `true` would paint every non-Connector tool green
  // by default; coercing it to `false` would paint them all red. It is the absence of a measurement.
  assert.equal(toolOutcome('just some text').ok, null);
  assert.equal(toolOutcome(mcp({ data: { anything: 1 } })).ok, null);
  assert.equal(toolOutcome(null).ok, null);
  assert.equal(toolOutcome({ content: [{ type: 'image', data: 'x' }] }).ok, null);
});

test('an error with no boolean still fails', () => {
  // An envelope that reports an error but omits the flag is a failure; leaving it null would render a
  // green span for a call that plainly did not work.
  const o = toolOutcome(mcp({ error: { message: 'rate limited', code: 'RATE_LIMIT' } }));
  assert.equal(o.ok, false);
  assert.equal(o.code, 'RATE_LIMIT');
  assert.equal(o.message, 'rate limited');
});

test('a code is read from siblings too, and sanitised', () => {
  assert.equal(toolOutcome(mcp({ successful: false, code: 'AUTH_401' })).code, 'AUTH_401');
  assert.equal(toolOutcome(mcp({ successful: false, error_code: 404 })).code, '404');
  // Anything outside [A-Za-z0-9_.:-]{1,64} is dropped rather than emitted — a code is an identifier,
  // and a "code" carrying spaces or punctuation is untrusted free text wearing the wrong hat.
  assert.equal(toolOutcome(mcp({ successful: false, code: 'not a code: <script>' })).code, null);
  assert.equal(toolOutcome(mcp({ successful: false, code: 'x'.repeat(65) })).code, null);
});

test('the message is whitespace-collapsed and hard-capped', () => {
  const o = toolOutcome(mcp({ successful: false, error: '  line one\n\n   line two  ' }));
  assert.equal(o.message, 'line one line two');

  const long = toolOutcome(mcp({ successful: false, error: 'e'.repeat(500) }));
  assert.equal(long.message.length, 201);           // 200 + the elision marker
  assert.ok(long.message.endsWith('…'), 'a capped message must say it was capped');
});

test('chars reports the payload SIZE, which cannot leak content', () => {
  // The size of the text THE MODEL RECEIVED — i.e. the outermost content block, not the peeled inner
  // body. That is the useful number (it is what consumed context and what the model had to read), and
  // it is deliberately not the post-peel length: `chars` is a measure of the result, not of how many
  // envelopes it happened to be wrapped in.
  const body = { successful: true, data: { body: 'x'.repeat(1000) } };
  const wrapped = mcp(body);
  const o = toolOutcome(wrapped);
  assert.equal(o.chars, wrapped.content[0].text.length);
  assert.ok(o.chars > 1000, 'the size must still scale with the payload');
});

test('never throws, whatever it is handed', () => {
  // Telemetry must not be able to fail a turn. Circular structures, odd primitives, hostile shapes.
  const circular = { content: [{ type: 'text', text: 'ok' }] };
  circular.self = circular;
  for (const input of [undefined, null, 0, false, NaN, Symbol('s'), circular, [], { content: 'not-an-array' }]) {
    assert.doesNotThrow(() => toolOutcome(input));
  }
});

test('outcomeAttributes omits absent measurements rather than sending nulls', () => {
  const none = outcomeAttributes(toolOutcome('plain text'));
  // `ok: null` is still ABSENT, not false — coercing it is the false-green this module exists to
  // stop. What is NEW is `declared: false`, which says so explicitly instead of leaving the reader
  // to infer it from a missing key (see the note on `declared` in outcomeAttributes).
  assert.deepEqual(Object.keys(none).sort(), ['agent_i32pz9.tool.result.chars', 'agent_i32pz9.tool.result.declared']);
  assert.equal(none['agent_i32pz9.tool.result.declared'], false);
  assert.equal('agent_i32pz9.tool.result.ok' in none, false);

  const failed = outcomeAttributes(toolOutcome(mcp({ successful: false, error: 'boom', code: 'E1' })));
  assert.equal(failed['agent_i32pz9.tool.result.ok'], false);
  assert.equal(failed['agent_i32pz9.tool.result.code'], 'E1');
  assert.equal(failed['agent_i32pz9.tool.result.message'], 'boom');

  assert.deepEqual(outcomeAttributes(null), {});
});

test('the doubly-nested live shape is peeled — this is the bug that made ok always null', () => {
  // Regression guard with the exact nesting observed in production. If `peel` stops recursing, this
  // reverts to ok:null and the span goes green for a failed call again.
  const okBody = toolOutcome(batch({ successful: true, data_preview: { object: 'list' } }));
  assert.equal(okBody.ok, true);
  assert.equal(okBody.items, 1);
  assert.equal(okBody.failed, 0);

  const single = toolOutcome(mcp({ successful: false, error: 'Gmail connection not found' }));
  assert.equal(single.ok, false);
  assert.equal(single.message, 'Gmail connection not found');
});

test('a batch reports per-inner-tool counts, not just one boolean', () => {
  // The case a single boolean erases: two of three inner tools worked. `ok` is false because the call
  // did not do what was asked, and items/failed say how badly.
  const o = toolOutcome(batch(
    { successful: true },
    { successful: false, error: 'rate limited' },
    { successful: true },
  ));
  assert.equal(o.ok, false);
  assert.equal(o.items, 3);
  assert.equal(o.failed, 1);
  assert.equal(o.message, 'rate limited');   // the FIRST failure's reason, not a concatenation

  const attrs = outcomeAttributes(o);
  assert.equal(attrs['agent_i32pz9.tool.result.items'], 3);
  assert.equal(attrs['agent_i32pz9.tool.result.failed'], 1);
});

test('a batch that declares nothing is ok:null, not success', () => {
  // Same rule as the single case. An all-succeeded batch and a batch that never said are different
  // facts, and conflating them is how a green span stops meaning anything.
  const o = toolOutcome(batch({ data_preview: {} }, { data_preview: {} }));
  assert.equal(o.ok, null);
  assert.equal(o.items, 2);
  assert.equal(o.failed, 0);
  assert.equal(outcomeAttributes(o)['agent_i32pz9.tool.result.ok'], undefined);
});

test('peeling is bounded and survives hostile nesting', () => {
  // Telemetry must not become a parser loop. Deeper than MAX_PEEL simply stops resolving; it must not
  // hang or throw.
  let deep = { successful: true };
  for (let i = 0; i < 12; i += 1) deep = layer(deep);
  assert.doesNotThrow(() => toolOutcome(deep));
  assert.doesNotThrow(() => toolOutcome(layer({ content: 'not-an-array' })));
});

test('THE PII GUARD: no part of the payload reaches the output', () => {
  // The reason this module reads the result at all is to find the envelope. This asserts nothing else
  // comes back with it — if a future edit starts returning a data field, this fails.
  const secrets = ['redacted@example.com', 'Re: Q3 revenue', 'sk-live-abcdef', 'patient 12345'];
  const o = toolOutcome(mcp({
    successful: false,
    error: 'delivery failed',
    data: { to: secrets[0], subject: secrets[1], token: secrets[2], note: secrets[3] },
  }));
  const serialised = JSON.stringify([o, outcomeAttributes(o)]);
  for (const s of secrets) {
    assert.ok(!serialised.includes(s), `payload content leaked into the outcome: ${s}`);
  }
  // And the outcome is still useful, which is the point of the boundary rather than dropping it all.
  assert.equal(o.ok, false);
  assert.equal(o.message, 'delivery failed');
});

// ── uniform shape across tool kinds (2026-09-08) ────────────────────────────────────────────────
//
// The ragged set measured live: of 10 tool spans on dm-urbnxvak3l5's 5-minute cron, CONNECTOR_
// SEARCH_TOOLS and CONNECTOR_MANAGE_CONNECTIONS carried no `ok` and no `failed`, so a span query
// could not distinguish a failure from a tool that declares nothing. `declared` is the fix; the
// measurements themselves are still never invented.

test('EVERY outcome carries `declared`, whatever the tool shape', () => {
  const shapes = [
    'plain text',                                        // no envelope at all
    mcp({ successful: true }),                           // declared single
    mcp({ whatever: 1 }),                                // envelope, no outcome
    batch({ successful: true }, { successful: false, error: 'x' }), // declared batch
    batch({ data_preview: {} }, { data_preview: {} }),   // batch declaring nothing
  ];
  for (const input of shapes) {
    const a = outcomeAttributes(toolOutcome(input));
    assert.equal(typeof a['agent_i32pz9.tool.result.declared'], 'boolean', `declared missing for ${String(input).slice(0, 40)}`);
    assert.equal(typeof a['agent_i32pz9.tool.result.chars'], 'number');
  }
});

test('a DECLARED single call gets the batch shape — items/failed — so one query covers both', () => {
  const ok = outcomeAttributes(toolOutcome(mcp({ successful: true })));
  assert.equal(ok['agent_i32pz9.tool.result.declared'], true);
  assert.equal(ok['agent_i32pz9.tool.result.ok'], true);
  assert.equal(ok['agent_i32pz9.tool.result.items'], 1);
  assert.equal(ok['agent_i32pz9.tool.result.failed'], 0);

  const bad = outcomeAttributes(toolOutcome(mcp({ successful: false, error: 'boom' })));
  assert.equal(bad['agent_i32pz9.tool.result.items'], 1);
  assert.equal(bad['agent_i32pz9.tool.result.failed'], 1);
});

test('a THROWN call is declared false with failed=1, not an absent measurement', () => {
  const thrown = outcomeAttributes(toolOutcome('anything', true));
  assert.equal(thrown['agent_i32pz9.tool.result.declared'], true);
  assert.equal(thrown['agent_i32pz9.tool.result.ok'], false);
  assert.equal(thrown['agent_i32pz9.tool.result.failed'], 1);
});

test('an UNDECLARED batch keeps `items` but emits no `failed` — 0 would read as "nothing failed"', () => {
  // The batch's `failed` is a count of explicit falses. On a batch that declared nothing that count
  // is 0, which is exactly the false-green one layer down.
  const a = outcomeAttributes(toolOutcome(batch({ data_preview: {} }, { data_preview: {} })));
  assert.equal(a['agent_i32pz9.tool.result.declared'], false);
  assert.equal(a['agent_i32pz9.tool.result.items'], 2);
  assert.equal('agent_i32pz9.tool.result.failed' in a, false);
  assert.equal('agent_i32pz9.tool.result.ok' in a, false);
});

test('a partially-failed batch still reports its real counts', () => {
  const a = outcomeAttributes(toolOutcome(batch({ successful: true }, { successful: false, error: 'no' }, { successful: true })));
  assert.equal(a['agent_i32pz9.tool.result.declared'], true);
  assert.equal(a['agent_i32pz9.tool.result.ok'], false);
  assert.equal(a['agent_i32pz9.tool.result.items'], 3);
  assert.equal(a['agent_i32pz9.tool.result.failed'], 1);
});

// ── thrown tools get a message (2026-09-09) ─────────────────────────────────────────────────────
//
// The gap: three `read` failures on dm-urbnxvak3l5 recorded `ok:false failed:1 chars:105` with NO
// message. The span's status said "tool execution error"; the 105 characters naming the file reached
// the model and nothing else — not the span, not the runtime log. Every non-Connector tool failure
// read as "something failed".

test('a THROWN tool with no envelope carries its error text as the message', () => {
  const a = outcomeAttributes(toolOutcome('File not found: /workspace/notes/digest.md (ENOENT)', true));
  assert.equal(a['agent_i32pz9.tool.result.ok'], false);
  assert.equal(a['agent_i32pz9.tool.result.message'], 'File not found: /workspace/notes/digest.md (ENOENT)');
});

test('an UNPARSEABLE body that did NOT throw carries no message — that text is data, not an error', () => {
  // The distinction the gate exists for. Capturing this would widen `message` from "the error an
  // author wrote" to "any payload we failed to parse", which is what the MAX_MESSAGE note rules out.
  const a = outcomeAttributes(toolOutcome('some,csv,data\n1,2,3', false));
  assert.equal('agent_i32pz9.tool.result.message' in a, false);
  assert.equal(a['agent_i32pz9.tool.result.declared'], false);
});

test('an envelope error still wins — the fallback never overwrites a real message', () => {
  const a = outcomeAttributes(toolOutcome(mcp({ successful: false, error: 'upstream rejected the range' }), true));
  assert.equal(a['agent_i32pz9.tool.result.message'], 'upstream rejected the range');
});

test('the thrown message is FIRST LINE only and capped', () => {
  const long = `boom: ${'x'.repeat(400)}\nstack frame 1\nstack frame 2`;
  const m = outcomeAttributes(toolOutcome(long, true))['agent_i32pz9.tool.result.message'];
  assert.ok(!m.includes('stack frame'), 'must not carry the trace');
  assert.ok(m.length <= 201, `capped, got ${m.length}`);
  assert.ok(m.endsWith('…'), 'an elided marker says it was longer');
});

test('a thrown call with NO text gets no invented message', () => {
  assert.equal('agent_i32pz9.tool.result.message' in outcomeAttributes(toolOutcome('', true)), false);
});

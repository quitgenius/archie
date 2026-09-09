// Did a tool call actually WORK — derived from its result envelope, without the result.
//
// WHY THIS EXISTS. `emitToolSpans` recorded that a tool ran, its name and its duration, and marked the
// span an error when Pi reported `isError`. That is not enough, and the gap was measured live: on
// 2026-08-21 `gmail-count-every-10min` fired on archie, made ONE
// `mcp_connector__CONNECTOR_MULTI_EXECUTE_TOOL` call (755ms, no error flag), and answered in 43
// characters where the same job on OpenClaw produced 743. The trace showed a green tool span and a
// green turn. Nothing in OTEL could say whether the Gmail lookup had succeeded — the question had to
// be answered by reading the session transcript out of EFS by hand.
//
// The cause of that blind spot is a Connector contract detail worth stating: a Connector tool call that
// FAILS still returns HTTP 200 with `{"successful": false, "error": "..."}` in the body. Pi sees a
// resolved tool call and sets no `isError`, so a semantic failure is indistinguishable from success at
// every layer above it. That is exactly the shape that made the OpenClaw side of the same job hard to
// diagnose (see clawdbot/connector-session-plugin/src/native-send-tools.ts, whose catch reduced a real
// Connector error to "internal error").
//
// ── THE PII BOUNDARY, WHICH IS THE WHOLE DESIGN CONSTRAINT ─────────────────────────────────────────
//
// The result payload is OUTPUT — email bodies, calendar entries, Notion pages, mailbox contents. It
// MUST NOT reach a span (2026-08-21) and not the actual text output (which should stay out of tracing)"). So this
// module READS the payload and returns only:
//
//   ok       the envelope's own success boolean, or null when it does not declare one
//   code     a machine error identifier, sanitised to [A-Za-z0-9_.:-]{1,64}
//   message  the envelope's error MESSAGE, whitespace-collapsed and hard-capped
//   chars    the payload SIZE, which is a number and cannot leak content
//
// `message` is the one field that is upstream free text rather than an identifier, and it is included
// deliberately because "which tool failed" without "why" sends you straight back to reading EFS. It is
// the error string an API author wrote, not the tool's data — but it is not GUARANTEED free of user
// content (an upstream may quote an offending value into it), which is why it is capped rather than
// passed through. Nothing else from the payload is returned, ever, and `flatten` exists only so the
// envelope can be located; its output is local to this module.
//
// Same posture as permissions/third-party-slug.mjs, and for the same reason: a dropped detail costs a
// line of telemetry, a leaked one costs PII in CloudWatch.

// Long enough to carry a real API error, short enough that a payload cannot ride along inside one.
const MAX_MESSAGE = 200;
const CODE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

/**
 * The result as text, FOR PARSING ONLY. Never returned, never logged, never put on a span.
 *
 * MCP tool results arrive as `{ content: [{ type: 'text', text: '<json>' }] }`; a directly-registered
 * tool may return a string or a plain object. All three shapes have to reach the envelope check or the
 * `ok` field silently becomes null for whole classes of tool.
 */
function flatten(result) {
  if (result == null) return '';
  if (typeof result === 'string') return result;
  if (typeof result !== 'object') return String(result);
  if (Array.isArray(result.content)) {
    let out = '';
    for (const b of result.content) {
      if (b && b.type === 'text' && typeof b.text === 'string') out += b.text;
    }
    // A content array with no text blocks (an image, a resource link) is a real result with no
    // envelope to read — fall through to the stringify below rather than reporting 0 chars.
    if (out) return out;
  }
  try {
    return JSON.stringify(result) ?? '';
  } catch {
    // Circular or otherwise unserialisable. The size is unknowable and that is fine; the caller
    // reports what it has. Never throw from telemetry.
    return '';
  }
}

// How many MCP envelopes deep to look. The result is DOUBLY nested in practice and there is no
// contract saying it stops at two, so this recurses — bounded, because an attacker-shaped or merely
// pathological result must not turn telemetry into a parser loop.
const MAX_PEEL = 4;

/**
 * The innermost envelope. MEASURED on a live cron turn (2026-08-21, trace 1-2e9a2e29…): the
 * `toolResult` content block's text is itself a JSON MCP envelope, whose own text block is the
 * Connector body:
 *
 *   toolResult.content[0].text
 *     -> '{"content":[{"type":"text","text":"{\"data\":{\"results\":[{\"response\":{\"successful\":true …'
 *
 * This is why the first version of this module reported `ok: null` for every call it ever saw: ONE
 * `JSON.parse` lands on `{content:[…]}`, which carries no `successful`, so the check fell through to
 * "no envelope". The tool spans were honest about not knowing and useless for the question asked of
 * them — `agent_i32pz9.tool.result.ok` was simply never emitted, on any tool, in any trace.
 *
 * Returns a plain object or null. Never throws.
 */
function peel(text, depth = 0) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const isPlain = v && typeof v === 'object' && !Array.isArray(v);
  if (isPlain && Array.isArray(v.content) && depth < MAX_PEEL) {
    let inner = '';
    for (const b of v.content) {
      if (b && b.type === 'text' && typeof b.text === 'string') inner += b.text;
    }
    // Only descend if there is something to descend INTO, and keep the outer object when the inner
    // layer turns out not to be JSON — an envelope whose text is prose is still the envelope.
    if (inner) {
      const deeper = peel(inner, depth + 1);
      if (deeper) return deeper;
    }
  }
  return isPlain ? v : null;
}

const collapse = (s) => String(s).replace(/\s+/g, ' ').trim();

/** Cap, don't truncate silently — an elided marker says the message was longer than it looks. */
const boundedMessage = (s) => {
  const t = collapse(s);
  if (!t) return null;
  return t.length <= MAX_MESSAGE ? t : `${t.slice(0, MAX_MESSAGE)}…`;
};

/**
 * FIRST LINE ONLY, for the thrown-tool message below. A stack trace or a multi-line body has its
 * useful sentence first; taking the rest buys nothing and widens what can ride along.
 */
const firstLine = (s) => String(s).split('\n', 1)[0];

const cleanCode = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return CODE_RE.test(s) ? s : null;
};

/**
 * What the tool call reported about itself.
 *
 * @param {unknown} result   the `tool_execution_end` event's `result` (Pi types it `any`)
 * @param {boolean} isError  Pi's own flag — a THROWN tool call, distinct from one that returned a
 *                           failure envelope. Both mean the call did not do its job.
 * @returns {{ok: boolean|null, code: string|null, message: string|null, chars: number,
 *            items: number|null, failed: number|null}}  items/failed are set only for a batch
 *          `ok: null` means "this result declares no outcome" — NOT success. Callers must not
 *          coerce it, or every tool without an envelope becomes a green span by default.
 */
export function toolOutcome(result, isError = false) {
  const text = flatten(result);
  const out = {
    ok: isError ? false : null, code: null, message: null, chars: text.length, items: null, failed: null,
  };
  // EVERY exit goes through this. A DECLARED outcome gets the batch's shape (`items`/`failed`) even
  // when it came from a single call, so one span query answers "how many tool calls failed" across
  // both envelopes instead of needing a branch per tool kind. Undeclared stays undeclared —
  // inventing items=1/failed=0 is the false-green this module exists to stop.
  //
  // A HELPER RATHER THAN A LINE BEFORE THE LAST `return`, because there are four exits and the two
  // early ones can still carry a declared outcome: `isError` sets ok=false before the body is even
  // parsed, so a THROWN call whose result is not JSON leaves at `if (!body)`. Written inline first,
  // that call came out declared-but-uncounted and its own test caught it.
  const finish = (o) => {
    if (typeof o.ok === 'boolean' && o.items === null) {
      o.items = 1;
      o.failed = o.ok ? 0 : 1;
    }
    // A THROWN tool with no envelope had NO message at all — `chars` and nothing else.
    //
    // Measured on dm-urbnxvak3l5, 2026-09-08/09: three `read` failures across two cron jobs, each
    // `ok:false failed:1 chars:105` with `message` absent. The span's own status said "tool execution
    // error"; the 105 characters naming the file went to the model and nowhere else, and they were not
    // in the runtime logs either. Every non-Connector tool failure was permanently "something failed".
    //
    // GATED ON `isError`, NOT ON "no envelope". A thrown call's result text IS an error string by
    // construction; an unparseable body from a call that merely returned something we could not read
    // is DATA, and capturing that would widen this field from "the error an author wrote" to "any
    // payload we failed to parse" — the one thing the note above MAX_MESSAGE rules out. First line
    // only, and through the same cap as every other message.
    if (isError && !o.message && text) o.message = boundedMessage(firstLine(text));
    return o;
  };
  if (!text) return finish(out);

  const body = peel(text);
  if (!body) return finish(out);   // not JSON, or no object at any depth — size is all there is

  // ── MULTI-EXECUTE: one call, N inner tools, N outcomes ───────────────────────────────────────
  //
  // `CONNECTOR_MULTI_EXECUTE_TOOL` batches actions and reports each separately under
  // `data.results[].response.successful` — so a single green span could be hiding "1 of 3 worked".
  // Aggregating to one boolean would throw away the only interesting case, hence `items`/`failed`
  // alongside it. Shape confirmed live 2026-08-21 (NOTION_SEARCH_NOTION_PAGE, 11087 chars).
  const results = body.data && Array.isArray(body.data.results) ? body.data.results : null;
  if (results) {
    let declared = 0;
    let failed = 0;
    let firstError = null;
    for (const r of results) {
      // The per-item body is `response` when present; some actions report at the item's own level.
      const resp = (r && typeof r.response === 'object' && r.response) ? r.response : (r || {});
      const okI = typeof resp.successful === 'boolean' ? resp.successful
        : typeof resp.success === 'boolean' ? resp.success : null;
      if (okI === null) continue;
      declared += 1;
      if (okI === false) {
        failed += 1;
        if (firstError === null) firstError = resp.error ?? resp.message ?? (r && r.error) ?? null;
      }
    }
    out.items = results.length;
    out.failed = failed;
    // `declared === 0` means the batch reported nothing about itself — NOT that it worked. Same rule
    // as the single case, for the same reason.
    if (declared > 0) out.ok = failed === 0;
    if (firstError !== null) {
      if (typeof firstError === 'string') out.message = boundedMessage(firstError);
      else if (typeof firstError === 'object') {
        out.message = boundedMessage(firstError.message ?? firstError.detail ?? '');
        out.code = cleanCode(firstError.code ?? firstError.type);
      }
    }
    if (isError) out.ok = false;
    return finish(out);
  }

  // ── SINGLE CALL ──────────────────────────────────────────────────────────────────────────────
  // Connector uses `successful`; other envelopes use `success`. Only a real boolean counts — a truthy
  // string would make `ok` a guess.
  if (typeof body.successful === 'boolean') out.ok = body.successful;
  else if (typeof body.success === 'boolean') out.ok = body.success;

  // `error` is a string in Connector's envelope and an object elsewhere. Take a message from either,
  // and a code from the object form or from a sibling field.
  const err = body.error;
  if (typeof err === 'string') out.message = boundedMessage(err);
  else if (err && typeof err === 'object') {
    out.message = boundedMessage(err.message ?? err.detail ?? '');
    out.code = cleanCode(err.code ?? err.type);
  }
  if (!out.code) out.code = cleanCode(body.code ?? body.errorCode ?? body.error_code);

  // An envelope that carries an error but no boolean is a failure. Stated explicitly because the
  // alternative — leaving `ok: null` — renders as a green span for a call that plainly did not work.
  if (out.ok === null && (out.message || out.code)) out.ok = false;
  // And a THROWN call stays false whatever the body says.
  if (isError) out.ok = false;
  return finish(out);
}

/**
 * The span attributes for an outcome. Absent keys rather than nulls: a span carrying
 * `result.ok = null` reads as a measurement, and this is the absence of one.
 */
export function outcomeAttributes(outcome, prefix = 'agent_i32pz9.tool.result') {
  if (!outcome) return {};
  const declared = typeof outcome.ok === 'boolean';
  // ALWAYS PRESENT, and the reason the rest can stay honest.
  //
  // `ok` is emitted only when the result actually stated an outcome, because coercing an absent
  // measurement makes every envelope-less tool a green span. That is right, and it left the span set
  // RAGGED: `CONNECTOR_SEARCH_TOOLS` and `CONNECTOR_MANAGE_CONNECTIONS` carry no `ok` at all, so a
  // query asking "did this tool call succeed" cannot tell "it failed" from "nobody said" from "the
  // attribute is missing for some other reason" — measured on dm-urbnxvak3l5's 5-minute cron,
  // 2026-09-08, where 4 of 10 tool spans in one window had no `ok`.
  //
  // `declared` makes the absence itself a first-class, uniformly-present measurement. Every tool span
  // now answers the question — `declared = 0` means the tool told us nothing, which is a fact about
  // the TOOL and worth its own alarm, rather than a hole in the telemetry.
  const a = { [`${prefix}.chars`]: outcome.chars, [`${prefix}.declared`]: declared };
  if (declared) {
    a[`${prefix}.ok`] = outcome.ok;
    // Gated on `declared` TOO. An undeclared batch has a real `items` but its `failed` is only a
    // count of explicit falses — emitting `failed: 0` there says "nothing failed" about a batch that
    // said nothing at all, which is the same false-green one layer down.
    if (typeof outcome.failed === 'number') a[`${prefix}.failed`] = outcome.failed;
  }
  // `items` is a fact about the ENVELOPE, not the outcome, so it survives an undeclared result:
  // "2 items, nothing declared" is a more useful span than "nothing declared".
  if (typeof outcome.items === 'number') a[`${prefix}.items`] = outcome.items;
  if (outcome.code) a[`${prefix}.code`] = outcome.code;
  if (outcome.message) a[`${prefix}.message`] = outcome.message;
  return a;
}

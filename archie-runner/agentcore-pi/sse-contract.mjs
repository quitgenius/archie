// SSE wire contract between the Pi AgentCore adapter (producer) and the Slack dispatcher
// (consumer). AgentCore's InvokeAgentRuntime streams a text/event-stream response body
// through the SDK incrementally (verified — Phase 0 spike), so the adapter emits one SSE
// event per turn-progress step and the dispatcher bridges them into streaming.js.
//
// FRAMING: each event is a single SSE data line: `data: <json>\n\n`.
//
// EVENT TYPES (the `type` field):
//   'delta' — assistant text progress. `text` is the FULL ACCUMULATED assistant text so far
//             (NOT the incremental piece). This mirrors the OpenClaw gateway chat-delta
//             contract so the dispatcher can feed it straight into streaming.js handleDelta,
//             which itself computes `text.slice(lastText.length)`. { type, text }
//   'tool'  — tool-call progress. { type, itemId, title, status }  status ∈ 'running'|'done'|'error'
//   'final' — terminal event; the full final text + turn metadata. Exactly ONE per stream,
//             always last. { type, text, usage, model, stopReason }
//   'error' — a turn error. Emitted (if it occurs) immediately BEFORE a terminal 'final' so
//             the consumer always sees a 'final' to close the run and never hangs. { type, message }
//
// ORDERING: zero-or-more (delta|tool) events, then optionally one 'error', then exactly one
// 'final'. The consumer treats 'final' as the authoritative full text (and computes any
// remaining delta from it). The dispatcher (a separate CommonJS package) mirrors these shapes;
// this module is the canonical adapter-side producer + shared constants.

export const STREAM_ACCEPT = 'text/event-stream';

export const SSE_EVENT = Object.freeze({
  DELTA: 'delta',
  TOOL: 'tool',
  FINAL: 'final',
  ERROR: 'error',
});

export const SSE_HEADERS = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache',
  connection: 'keep-alive',
});

/** @typedef {{ type: 'delta', text: string }} DeltaEvent */
/** @typedef {{ type: 'tool', itemId: string, title: string, status: 'running'|'done'|'error' }} ToolEvent */
/** @typedef {{ type: 'final', text: string, usage: object|null, model: string|null, stopReason: string|null }} FinalEvent */
/** @typedef {{ type: 'error', message: string }} ErrorEvent */
/** @typedef {DeltaEvent|ToolEvent|FinalEvent|ErrorEvent} SseEvent */

/** @param {string} text full accumulated assistant text so far @returns {DeltaEvent} */
// `delta.text` is the full text so far for this invoke, monotonically growing. The Slack bridge
// computes its increment as text.slice(run.lastText.length), so it MUST never shrink.
export const deltaEvent = (text) => ({ type: SSE_EVENT.DELTA, text });

/** @returns {ToolEvent} */
export const toolEvent = (itemId, title, status) => ({ type: SSE_EVENT.TOOL, itemId, title, status });

/** @returns {FinalEvent} */
// `final` is the RUN TERMINATOR: the dispatcher treats a stream that closes without one as an
// incomplete turn and retries (agentcore-client.js). One terminal per invoke, and — because the
// dispatcher serialises invokes per session — one reply per invoke.
export const finalEvent = ({ text, usage = null, model = null, stopReason = null }) =>
  ({ type: SSE_EVENT.FINAL, text, usage, model, stopReason });

/** @returns {ErrorEvent} */
export const errorEvent = (message) => ({ type: SSE_EVENT.ERROR, message: String(message).slice(0, 500) });

/** Encode one event as an SSE data frame. @param {SseEvent} event */
export const encodeSse = (event) => `data: ${JSON.stringify(event)}\n\n`;

/**
 * Whether an incoming /invocations request wants a streamed response. True if the client sent
 * `Accept: text/event-stream` OR the body opted in via `input.stream === true` / `stream === true`.
 * @param {import('node:http').IncomingMessage} req
 * @param {any} body parsed request body
 */
export function wantsStream(req, body) {
  const accept = String(req?.headers?.accept || '').toLowerCase();
  if (accept.includes(STREAM_ACCEPT)) return true;
  return body?.input?.stream === true || body?.stream === true;
}

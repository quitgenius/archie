// When did this turn actually ASK Bedrock anything?
//
// `prepare_turn` (session ready -> first model call) is the largest controllable component of a
// fully warm turn — p50 ~2.0s of a ~2.1s warm turn, measured over 61 phase-instrumented turns on
// 2026-08-13. But it is TWO different costs welded together and we could not tell them apart:
//
//   context build (ours)     — system prompt, skill text, tool schemas, message history
//   model TTFB (Bedrock's)   — request dispatch, network, and the model's own time to first byte
//
// The boundary between them is "the ConverseStream request left this process", and nothing in the
// stack reports it. Pi's `before_provider_request` hook is dead (pi-agent-core's agent-loop never
// calls it), and Pi's own `message_start` — which is what backdates our `chat` span — is emitted on
// the FIRST EVENT OF THE RESPONSE STREAM, i.e. already past the boundary. So "2 seconds of prepare"
// could have been two seconds of our prompt assembly or two seconds of Bedrock, and the honest
// answer was that we did not know. Optimising the wrong one of those is a wasted week.
//
// pi-ai reaches Bedrock through @aws-sdk/client-bedrock-runtime, which pins NodeHttp2Handler for
// streaming — so the request goes out via http2, NOT https.request, and patching the https module
// (the obvious move) would silently mark nothing. We wrap `http2.connect` for bedrock-runtime
// origins only and time-stamp the first `session.request()` of each turn.
//
// Deliberately a wrapper rather than an OTEL auto-instrumentation: the runtime image has no OTEL
// SDK (its exporter is ~150 lines of hand-rolled OTLP precisely to keep boot near 2s), and adding
// the SDK + aws-sdk instrumentation to win one timestamp would put that back on every cold start.
//
// Safety: every path is wrapped, install() is idempotent, and a failure anywhere leaves the mark
// unset — a turn with no mark simply reports the un-split `prepare_turn` exactly as before.

import http2 from 'node:http2';

const INSTALLED = Symbol.for('agentcore.bedrockDispatchMark.installed');

// EVERY dispatch this turn, not just the first. A tool-loop turn makes several Bedrock calls, and
// the same blind spot applies to each of them: the gap between a tool finishing and the next `chat`
// span opening is that request's dispatch + TTFB, and it is invisible for exactly the same reason.
// Measured on a two-call turn (2026-08-14): 1.85s of a 4.4s turn sat in that gap with no span over
// it. Bounded so a runaway loop cannot grow this without limit.
const MAX_MARKS = 64;
let dispatches = [];
let armed = false;

/** Called from the http2 wrapper. Records each outbound Bedrock request while a turn is armed. */
function mark() {
  if (armed && dispatches.length < MAX_MARKS) dispatches.push(Date.now());
}

/**
 * Wrap http2.connect so sessions to bedrock-runtime time-stamp their first request. Idempotent
 * across module reloads via a global symbol; never throws.
 */
export function install() {
  try {
    if (globalThis[INSTALLED]) return true;
    const original = http2.connect;
    if (typeof original !== 'function') return false;
    http2.connect = function connect(authority, ...rest) {
      const session = original.call(this, authority, ...rest);
      try {
        // `authority` is a URL or string; both stringify to something containing the host.
        if (/bedrock[-.]runtime/i.test(String(authority)) && session && typeof session.request === 'function') {
          const originalRequest = session.request;
          session.request = function request(...args) {
            mark();
            return originalRequest.apply(this, args);
          };
        }
      } catch { /* an unwrappable session just goes unmarked */ }
      return session;
    };
    globalThis[INSTALLED] = true;
    return true;
  } catch {
    return false;
  }
}

/** Start a turn: arm the marks and clear the previous turn's. */
export function begin() {
  dispatches = [];
  armed = true;
}

/** Epoch ms of this turn's first Bedrock request, or null if none was seen. */
export function firstDispatch() {
  return dispatches.length ? dispatches[0] : null;
}

/** Every dispatch this turn, in order. */
export function allDispatches() {
  return dispatches.slice();
}

/**
 * The dispatch that produced a response whose first byte arrived at `responseStartMs` — the LATEST
 * mark at or before it. Pairing by "latest at or before" rather than by index is what keeps the
 * pairing correct when a request is retried inside the SDK (two dispatches, one response): the
 * retry is the one that actually produced the bytes, and an index-based pairing would silently
 * attribute the response to the abandoned first attempt and report a TTFB that includes the retry
 * wait. Returns null when no mark precedes it, so a mispaired span is simply not emitted.
 */
export function dispatchFor(responseStartMs) {
  let best = null;
  for (const d of dispatches) {
    if (d <= responseStartMs && (best === null || d > best)) best = d;
  }
  return best;
}

/** End a turn: stop marking, so background traffic cannot claim the next turn's slot. */
export function end() {
  armed = false;
}

// Test-only: undo the wrapper so a test process can install it again.
export function _resetForTest() {
  delete globalThis[INSTALLED];
  dispatches = [];
  armed = false;
}

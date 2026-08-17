// M3 dispatcher→runtime trace stitch (dispatcher-observability-delivery-plan.md §4.1/§4.3):
// extract the dispatcher's inbound W3C trace context on /invocations so the runtime's
// agent_i073q7 agent_i32pz9 span shares the dispatcher root's traceId and parents into its tree —
// one trace across Slack/cron → dispatcher → AgentCore → turn → tools, joinable in aws/spans.
//
// Source precedence (an operator's decision (c): payload primary — and S1 answered live 2026-08-01:
// AgentCore forwards an x-amzn-trace-id header on EVERY /invocations request carrying its OWN
// epoch-derived ingress Root, so header-first precedence shadowed the dispatcher's context and
// broke the stitch; headers are fallbacks only):
//   1. `body.input.traceparent` payload field — the dispatcher-injected stitch (portable,
//      trigger-agnostic: Slack and cron both funnel through invokeStreaming).
//   2. native `traceparent` header (W3C) — honored if a future hop sends one.
//   3. `x-amzn-trace-id` header (AWS format: Root=1-<8hex>-<24hex>;Parent=<16hex>;Sampled=…) —
//      last resort; today this is AgentCore's own ingress trace, not the dispatcher's.
// A malformed candidate at one level falls through to the next; nothing valid anywhere →
// { traceId: null, parentSpanId: null } and the caller starts a fresh trace exactly as today.
// Defensive by contract: never throws on bad input.
//
// Dependency-free on purpose (like sse-contract.mjs / skill-scope.mjs) so the paired
// trace-context-test.mjs runs with plain `node` — pi-adapter.mjs itself boots a server and
// pulls the Pi/AWS deps on import, so the pure logic lives here.

// W3C traceparent: 00-<32hex traceId>-<16hex parentSpanId>-<2hex flags>. Version 'ff' is
// invalid per spec; all-zero trace/span ids are invalid per spec.
const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/**
 * Parse a W3C traceparent string. Returns { traceId, parentSpanId } or null (never throws).
 */
export function parseTraceparent(value) {
  if (typeof value !== 'string') return null;
  const m = TRACEPARENT_RE.exec(value.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, parentSpanId] = m;
  if (version === 'ff') return null; // forbidden version per W3C spec
  if (/^0{32}$/.test(traceId) || /^0{16}$/.test(parentSpanId)) return null; // all-zero ids invalid
  return { traceId, parentSpanId };
}

/**
 * Parse an AWS X-Amzn-Trace-Id header (Root=1-<8hex>-<24hex>;Parent=<16hex>;Sampled=…).
 * Root converts to a 32-hex W3C traceId by concatenating the two hex parts after `1-`.
 * Parent is optional — without it the traceId is still adopted (parentSpanId null).
 * Returns { traceId, parentSpanId } or null (never throws).
 */
export function parseAmznTraceId(value) {
  if (typeof value !== 'string') return null;
  let root = null;
  let parent = null;
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim().toLowerCase();
    const v = part.slice(eq + 1).trim();
    if (k === 'root') root = v;
    else if (k === 'parent') parent = v;
  }
  const rm = /^1-([0-9a-f]{8})-([0-9a-f]{24})$/.exec((root || '').toLowerCase());
  if (!rm) return null;
  const traceId = rm[1] + rm[2];
  if (/^0{32}$/.test(traceId)) return null;
  let parentSpanId = null;
  if (parent) {
    const p = parent.toLowerCase();
    if (/^[0-9a-f]{16}$/.test(p) && !/^0{16}$/.test(p)) parentSpanId = p;
  }
  return { traceId, parentSpanId };
}

/**
 * Extract inbound trace context for an /invocations request.
 * `headers` is the Node http req.headers object (names already lowercased);
 * `input` is the parsed body.input (may be undefined).
 *
 * Returns (never throws):
 *   hasTraceparentHeader / hasAmznTraceHeader / hasPayloadTraceparent — presence booleans
 *     (present even if malformed; the S1 evidence signal),
 *   source — which source won ('traceparent-header' | 'x-amzn-trace-id-header' |
 *     'payload-traceparent') or null,
 *   traceId (32-hex) / parentSpanId (16-hex or null) — nulls when nothing valid arrived.
 */
export function extractTraceContext(headers, input) {
  const h = headers || {};
  const traceparentHeader = h['traceparent'];
  const amznHeader = h['x-amzn-trace-id'];
  const payloadTraceparent = input && typeof input === 'object' ? input.traceparent : undefined;

  const hasTraceparentHeader = typeof traceparentHeader === 'string' && traceparentHeader.trim() !== '';
  const hasAmznTraceHeader = typeof amznHeader === 'string' && amznHeader.trim() !== '';
  const hasPayloadTraceparent = typeof payloadTraceparent === 'string' && payloadTraceparent.trim() !== '';

  // Precedence: payload FIRST (decision 8.2-c: the dispatcher owns body.input.traceparent and
  // it is the cross-boundary stitch). Live-verified 2026-08-01 (S1): AgentCore forwards an
  // X-Amzn-Trace-Id header on every /invocations request, but it carries AgentCore's OWN
  // ingress Root (epoch-derived, minted at their front door) — header-first precedence let it
  // shadow the dispatcher's context and broke the stitch. Headers are fallbacks only.
  let ctx = null;
  let source = null;
  if (hasPayloadTraceparent) {
    ctx = parseTraceparent(payloadTraceparent);
    if (ctx) source = 'payload-traceparent';
  }
  if (!ctx && hasTraceparentHeader) {
    ctx = parseTraceparent(traceparentHeader);
    if (ctx) source = 'traceparent-header';
  }
  if (!ctx && hasAmznTraceHeader) {
    ctx = parseAmznTraceId(amznHeader);
    if (ctx) source = 'x-amzn-trace-id-header';
  }

  return {
    hasTraceparentHeader,
    hasAmznTraceHeader,
    hasPayloadTraceparent,
    source,
    traceId: ctx ? ctx.traceId : null,
    parentSpanId: ctx ? ctx.parentSpanId : null,
  };
}

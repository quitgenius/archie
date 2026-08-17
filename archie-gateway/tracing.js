'use strict';

// tracing.js — dispatcher OTEL bootstrap (dispatcher-observability M2).
//
// Registers a NodeTracerProvider + @opentelemetry/instrumentation-aws-sdk auto-instrumentation
// + a direct SigV4-signed OTLP/JSON exporter POSTing to the X-Ray OTLP endpoint
// (https://xray.<region>.amazonaws.com/v1/traces) — the SAME backend the runtime's
// agentcore-pi/otel-export.cjs lands spans in (CloudWatch Transaction Search / `aws/spans`),
// so dispatcher spans and runtime agent_i32pz9 spans share one trace store (M3 joins on traceId).
//
// Load order (S6): this file MUST be required before any @aws-sdk client module is loaded —
// the aws-sdk instrumentation patches clients at require time. index.js requires it on its
// FIRST line; the task-def additionally sets NODE_OPTIONS=--require /app/tracing.js as
// belt-and-braces. Registration is idempotent (global-symbol guard), so both paths coexist.
//
// Degraded environments: registration never throws — a failure logs and the process continues
// untraced (library modules use @opentelemetry/api's no-op tracer). Credentials are resolved
// lazily at EXPORT time, so requiring this file without AWS creds/env is safe (no crash-loop).
//
// Modes (DISPATCHER_OTEL_MODE):
//   'xray'   -> SigV4 POST to the X-Ray OTLP endpoint (default in the deployed dispatcher)
//   'stdout' -> print each OTLP payload prefixed with DISPATCHER_OTEL_SPAN (local/BDD debug)
//   'off'    -> skip registration entirely (unit tests requiring internals set this)
//
// Span-noise control (§3.4 / S3):
//   - DynamoDB auto-spans (routing reads) and ListAgentRuntimes polling chatter are dropped
//     at export time; CreateAgentRuntime / GetAgentRuntime / InvokeAgentRuntime stay visible.
//   - OTEL_SUPPRESS_INVOKE_AUTOSPAN=1 additionally drops the InvokeAgentRuntime AUTO-span
//     (task-def env flip, no rebuild) if S3 proves it hangs for the SSE stream duration.
//     The manual dispatcher.agent_i073q7 span is unaffected (it carries no rpc.* attrs).

const https = require('node:https');

const REGISTERED_FLAG = Symbol.for('slack-dispatcher.tracing.registered');
const OTLP_MARKER = 'DISPATCHER_OTEL_SPAN';

function otelMode(env = process.env) {
  return env.DISPATCHER_OTEL_MODE || 'xray';
}

function otelRegion(env = process.env) {
  return env.AGENTCORE_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1';
}

// ── OTLP/JSON serialization (ReadableSpan[] → OTLP resourceSpans) ────────────────
// int64 fields are strings per the OTLP/JSON spec (mirrors agentcore-pi/otel-export.cjs).

function toAttrValue(value) {
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toAttrValue) } };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'boolean') return { boolValue: value };
  return { stringValue: String(value) };
}

function toAttrs(obj) {
  return Object.entries(obj || {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([key, value]) => ({ key, value: toAttrValue(value) }));
}

// HrTime [seconds, nanos] → unix-nano string.
function hrTimeToNanos(hr) {
  return (BigInt(hr[0]) * 1000000000n + BigInt(hr[1])).toString();
}

// ── Expected-conflict downgrade: ERROR → warn ────────────────────────────────────
// Two AWS calls FAIL BY DESIGN on every cold provision, because provisioning is idempotent-by-
// conflict: ensureExecRole calls CreateRole and adopts the existing role on EntityAlreadyExists,
// and the access-point step calls CreateAccessPoint and adopts the existing AP on
// AccessPointAlreadyExists — adopting it is precisely what preserves an agent's EFS state across an
// image roll. The aws-sdk auto-instrumentation cannot know any of that, so it stamps status=ERROR
// plus an exception event (stacktrace and all) on both. Result: two ERROR spans on every HEALTHY
// cold provision. Anything built on span error rate — an alarm, a dashboard, a human skimming a
// trace — then reads a normal roll as a fault, which is how error signals get trained into noise.
// Live-confirmed on the pi-obs-41 switchover trace (83f7226a…): both spans ERROR, both expected.
//
// Downgraded HERE, at export, rather than suppressed. OTEL status has no WARN level, so `warn` is
// expressed as status UNSET (what the other successful auto-spans carry) plus explicit attributes,
// and the exception event is dropped — its only content is a stacktrace of an expected outcome. The
// FACT stays queryable via `dispatcher.expected_conflict`, so "how often did we adopt rather than
// create" is still answerable; it simply is not an error any more.
//
// Deliberately narrow: only these two operations, and only on HTTP 409. A 403 or a 500 on the same
// call is a real failure and stays ERROR — an AccessDenied on CreateRole is exactly the deploy-order
// fault the derived-role rollout can hit, and it must not be swallowed by this.
const EXPECTED_CONFLICT_OPS = new Set(['CreateRole', 'CreateAccessPoint']);

function expectedConflict(span) {
  const attrs = span.attributes || {};
  const op = String(attrs['rpc.method'] || attrs['aws.remote.operation'] || '');
  if (!EXPECTED_CONFLICT_OPS.has(op)) return null;
  const code = Number(attrs['http.response.status_code'] ?? attrs['http.status_code']);
  if (code !== 409) return null;
  const ev = (span.events || []).find((e) => e && e.name === 'exception');
  const evAttrs = (ev && ev.attributes) || {};
  return {
    op,
    type: String(evAttrs['exception.type'] || 'Conflict'),
    detail: evAttrs['exception.message'] ? String(evAttrs['exception.message']).slice(0, 200) : undefined,
  };
}

function spanToOtlp(span) {
  const ctx = span.spanContext();
  // SDK 2.x exposes parentSpanContext; 1.x exposed parentSpanId. Support both.
  const parentSpanId = (span.parentSpanContext && span.parentSpanContext.spanId) || span.parentSpanId || undefined;
  const status = span.status || {};
  const conflict = expectedConflict(span);
  // On a downgrade: keep every original attribute, add the warn markers, and drop the exception
  // event (a stacktrace of an expected outcome). Non-exception events, if any, are preserved.
  const attributes = conflict
    ? {
      ...span.attributes,
      'dispatcher.severity': 'warn',
      'dispatcher.expected_conflict': conflict.type,
      ...(conflict.detail ? { 'dispatcher.expected_conflict_detail': conflict.detail } : {}),
    }
    : span.attributes;
  const events = (span.events || []).filter((e) => !(conflict && e && e.name === 'exception'));
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: span.name,
    // API SpanKind (INTERNAL=0 … CONSUMER=4) → OTLP enum (UNSPECIFIED=0, INTERNAL=1 …).
    kind: (span.kind ?? 0) + 1,
    startTimeUnixNano: hrTimeToNanos(span.startTime),
    endTimeUnixNano: hrTimeToNanos(span.endTime),
    attributes: toAttrs(attributes),
    status: conflict
      ? { code: 0 } // UNSET — "not an error", same as every other successful auto-span
      : {
        code: status.code ?? 0,
        ...(status.message ? { message: String(status.message).slice(0, 400) } : {}),
      },
    ...(events.length
      ? {
        events: events.map((e) => ({
          timeUnixNano: hrTimeToNanos(e.time),
          name: e.name,
          attributes: toAttrs(e.attributes),
        })),
      }
      : {}),
  };
}

function spansToOtlpJson(spans) {
  // One provider → one resource; group spans by instrumentation scope.
  const resource = spans[0] && spans[0].resource;
  const byScope = new Map();
  for (const s of spans) {
    const scope = s.instrumentationScope || s.instrumentationLibrary || {};
    const name = scope.name || 'slack-dispatcher';
    if (!byScope.has(name)) byScope.set(name, []);
    byScope.get(name).push(spanToOtlp(s));
  }
  return {
    resourceSpans: [{
      resource: { attributes: toAttrs(resource && resource.attributes) },
      scopeSpans: [...byScope.entries()].map(([name, scopeSpans]) => ({ scope: { name }, spans: scopeSpans })),
    }],
  };
}

// ── Span-noise suppression (§3.4) ────────────────────────────────────────────────
// Applied at export time so it never interferes with context propagation. Manual
// dispatcher.* spans carry no rpc.* attributes and are never dropped.

function shouldDropSpan(span, env = process.env) {
  const attrs = span.attributes || {};
  const rpcService = attrs['rpc.service'];
  const rpcMethod = attrs['rpc.method'];
  // High-volume DynamoDB routing reads (config table / routes GSI) — pure chatter.
  if (rpcService && /^dynamodb/i.test(String(rpcService))) return true;
  if (!rpcService && /^DynamoDB\b/i.test(span.name || '')) return true;
  // ListAgentRuntimes polling chatter (runtime discovery loops).
  if (rpcMethod === 'ListAgentRuntimes') return true;
  // S3 escape hatch: drop the InvokeAgentRuntime AUTO-span only (env flip, no rebuild).
  if (env.OTEL_SUPPRESS_INVOKE_AUTOSPAN === '1' && rpcMethod === 'InvokeAgentRuntime') return true;
  return false;
}

// ── The exporter: OTLP/JSON + SigV4 POST to the X-Ray OTLP endpoint ─────────────
// Mirrors agentcore-pi/otel-export.cjs postXray (proven to land spans in `aws/spans`),
// implemented as an OTEL SpanExporter so it plugs into a BatchSpanProcessor. A telemetry
// failure must never fail the dispatcher: export errors log and report FAILED, never throw.

class SigV4XrayOtlpExporter {
  constructor({ region, mode, env, post } = {}) {
    this._env = env || process.env;
    this._region = region || otelRegion(this._env);
    this._mode = mode || otelMode(this._env);
    this._host = `xray.${this._region}.amazonaws.com`;
    this._path = '/v1/traces';
    this._post = post || null; // injectable for tests
    this._signer = null;
  }

  // Lazy: credentials are only resolved when spans actually export (degraded-env-safe boot).
  signer() {
    if (this._signer) return this._signer;
    const { SignatureV4 } = require('@smithy/signature-v4');
    const { Sha256 } = require('@aws-crypto/sha256-js');
    const { defaultProvider } = require('@aws-sdk/credential-provider-node');
    this._signer = new SignatureV4({
      service: 'xray',
      region: this._region,
      sha256: Sha256,
      credentials: defaultProvider(),
    });
    return this._signer;
  }

  async _postXray(body) {
    const { HttpRequest } = require('@smithy/protocol-http');
    const req = new HttpRequest({
      method: 'POST', protocol: 'https:', hostname: this._host, path: this._path,
      headers: { host: this._host, 'content-type': 'application/json' }, body,
    });
    const signed = await this.signer().sign(req);
    await new Promise((resolve, reject) => {
      const r = https.request({ hostname: this._host, path: this._path, method: 'POST', headers: signed.headers }, (resp) => {
        let data = '';
        resp.on('data', (c) => { data += c; });
        resp.on('end', () => {
          if (resp.statusCode >= 200 && resp.statusCode < 300) resolve();
          else reject(new Error(`x-ray otlp ${resp.statusCode}: ${data.slice(0, 200)}`));
        });
      });
      r.on('error', reject);
      r.write(body);
      r.end();
    });
  }

  async _export(spans) {
    if (this._mode === 'off') return;
    const kept = spans.filter((s) => !shouldDropSpan(s, this._env));
    if (!kept.length) return;
    const body = JSON.stringify(spansToOtlpJson(kept));
    if (this._mode === 'stdout') { console.log(`${OTLP_MARKER} ${body}`); return; }
    await (this._post ? this._post(body) : this._postXray(body));
  }

  // OTEL SpanExporter contract. ExportResultCode: 0 = SUCCESS, 1 = FAILED.
  export(spans, resultCallback) {
    this._export(spans)
      .then(() => resultCallback({ code: 0 }))
      .catch((e) => {
        console.error('tracing: span export failed:', e && e.message);
        resultCallback({ code: 1, error: e });
      });
  }

  async forceFlush() {}

  async shutdown() {}
}

// ── Registration (idempotent; never throws) ─────────────────────────────────────

function register() {
  const g = globalThis;
  if (g[REGISTERED_FLAG]) return g[REGISTERED_FLAG];
  const mode = otelMode();
  if (mode === 'off') {
    g[REGISTERED_FLAG] = { registered: false, mode };
    return g[REGISTERED_FLAG];
  }
  try {
    const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
    const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
    const { resourceFromAttributes } = require('@opentelemetry/resources');
    const { registerInstrumentations } = require('@opentelemetry/instrumentation');
    const { AwsInstrumentation } = require('@opentelemetry/instrumentation-aws-sdk');

    const region = otelRegion();
    const serviceName = process.env.OTEL_SERVICE_NAME || 'slack-dispatcher';
    const exporter = new SigV4XrayOtlpExporter({ region, mode });
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({
        'service.name': serviceName,
        'deployment.environment': process.env.DEPLOYMENT_ENVIRONMENT || 'test',
      }),
      spanProcessors: [new BatchSpanProcessor(exporter)],
    });
    // Sets the global tracer provider, the AsyncLocalStorage context manager (so
    // tracer.startActiveSpan nests SDK auto-spans), and the W3C trace-context propagator
    // (M3's propagation.inject at the invoke sites picks this up unchanged).
    provider.register();
    registerInstrumentations({
      instrumentations: [new AwsInstrumentation({ suppressInternalInstrumentation: true })],
    });
    g[REGISTERED_FLAG] = { registered: true, mode, provider, exporter };
    // S6 boot-order proof: this line must precede the first AWS SDK client log on boot.
    console.log(`tracing: OTEL SDK registered (service=${serviceName}, mode=${mode}, region=${region}) — aws-sdk auto-instrumentation on`);
  } catch (e) {
    console.error('tracing: OTEL registration failed — continuing untraced:', e && e.message);
    g[REGISTERED_FLAG] = { registered: false, mode, error: e };
  }
  return g[REGISTERED_FLAG];
}

register();

module.exports = {
  register,
  OTLP_MARKER,
  // exposed for unit tests only
  _internals: { toAttrs, hrTimeToNanos, spanToOtlp, spansToOtlpJson, shouldDropSpan, expectedConflict, SigV4XrayOtlpExporter, otelRegion, otelMode },
};

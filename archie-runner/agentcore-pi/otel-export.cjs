'use strict';

// Minimal OTLP/JSON span exporter for the AgentCore adapter.
//
// Emits ONE agent-tier agent_i32pz9.* span per /invocations turn, direct to the
// AWS X-Ray OTLP endpoint (SigV4-signed, collector-less). AWS auto-enriches
// agent_i32pz9.* attributes into Application Signals GenAI semantics, so these spans
// populate the CloudWatch GenAI Observability views. See
// agentcore-otel-tracing-plan.md (§5/§6) for the design + probe evidence.
//
// Sinks (AGENTCORE_OTEL_MODE):
//   'xray'   -> SigV4 POST to https://xray.<region>.amazonaws.com/v1/traces
//               (default in the deployed runtime; requires Transaction Search
//                enabled + execution-role xray:PutTraceSegments)
//   'stdout' -> print the OTLP payload on stdout prefixed with a marker
//               (deterministic local BDD assertions; no collector, no signing)
//   'off'    -> no-op (default; existing Layer A tests are unaffected)
//
// A "custom OTEL server / SigV4 proxy" is deliberately NOT introduced here:
// signing happens in-process for the adapter's own spans.

const https = require('node:https');
const crypto = require('node:crypto');

const STDOUT_MARKER = 'AGENTCORE_OTEL_SPAN';

function nowNs() {
  return BigInt(Date.now()) * 1000000n;
}

// OTLP/JSON attribute value encoding. int64 fields are strings per the spec.
function toAttr(key, value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isInteger(value)) return { key, value: { intValue: String(value) } };
  if (typeof value === 'number') return { key, value: { doubleValue: value } };
  if (typeof value === 'boolean') return { key, value: { boolValue: value } };
  return { key, value: { stringValue: String(value) } };
}

function buildPayload(serviceName, resourceAttributes, span) {
  const attributes = Object.entries(span.attributes || {})
    .map(([k, v]) => toAttr(k, v))
    .filter(Boolean);
  // Resource attributes: service.name plus any extra identity (e.g.
  // aws.service.type=agent_i32pz9, cloud.resource_id=<runtime endpoint ARN>)
  // that the CloudWatch GenAI Observability Sessions/Spans views filter on.
  const resAttrs = [toAttr('service.name', serviceName)]
    .concat(Object.entries(resourceAttributes || {}).map(([k, v]) => toAttr(k, v)))
    .filter(Boolean);
  return {
    resourceSpans: [{
      resource: { attributes: resAttrs },
      scopeSpans: [{
        scope: { name: 'agentcore-adapter' },
        spans: [{
          traceId: span.traceId,
          spanId: span.spanId,
          // Child spans (P1: per-tool) carry parentSpanId + share the parent's traceId so they
          // nest under the agent_i073q7 span; root spans omit it.
          ...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
          name: span.name,
          // kind 3 = CLIENT (AWS maps agent_i32pz9.* to aws.genai.span_kind=AGENT); 1 = INTERNAL for
          // tool-execution child spans (agent_i32pz9 execute_tool semantics).
          kind: span.kind || 3,
          startTimeUnixNano: span.startNs.toString(),
          endTimeUnixNano: span.endNs.toString(),
          attributes,
          status: span.error ? { code: 2, message: String(span.error).slice(0, 400) } : { code: 1 },
        }],
      }],
    }],
  };
}

// Create the exporter. `resourceAttributes` are extra OTLP resource attributes
// (e.g. aws.service.type, cloud.resource_id). `log` is an optional pino logger.
function createExporter({ mode, region, serviceName, resourceAttributes, log } = {}) {
  const m = mode || 'off';
  const resAttrs = resourceAttributes || {};
  const host = `xray.${region}.amazonaws.com`;
  const path = '/v1/traces';

  let signer = null;
  if (m === 'xray') {
    // Lazy require so 'stdout'/'off' modes don't need the AWS deps present.
    const { SignatureV4 } = require('@smithy/signature-v4');
    const { Sha256 } = require('@aws-crypto/sha256-js');
    const { fromNodeProviderChain } = require('@aws-sdk/credential-providers');
    signer = new SignatureV4({
      service: 'xray',
      region,
      sha256: Sha256,
      credentials: fromNodeProviderChain(), // env / container-creds / IMDS (MMDS)
    });
  }

  async function postXray(body) {
    const { HttpRequest } = require('@smithy/protocol-http');
    const req = new HttpRequest({
      method: 'POST', protocol: 'https:', hostname: host, path,
      headers: { host, 'content-type': 'application/json' }, body,
    });
    const signed = await signer.sign(req);
    await new Promise((resolve, reject) => {
      const r = https.request({ hostname: host, path, method: 'POST', headers: signed.headers }, (resp) => {
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

  async function exportSpan(span) {
    if (m === 'off') return;
    const body = JSON.stringify(buildPayload(serviceName, resAttrs, span));
    if (m === 'stdout') { console.log(`${STDOUT_MARKER} ${body}`); return; }
    await postXray(body);
  }

  return {
    mode: m,
    // opts (all optional): traceId + parentSpanId to nest as a child span (P1 tool spans);
    // kind (OTLP SpanKind int); startTimeMs to backdate the start to when the work began.
    startSpan(name, opts = {}) {
      return {
        traceId: opts.traceId || crypto.randomBytes(16).toString('hex'),
        spanId: crypto.randomBytes(8).toString('hex'),
        parentSpanId: opts.parentSpanId || null,
        kind: opts.kind || 3,
        name,
        startNs: opts.startTimeMs != null ? BigInt(Math.round(opts.startTimeMs)) * 1000000n : nowNs(),
        attributes: {},
        error: null,
      };
    },
    // Finalize + export. Never throws — a telemetry failure must not fail a turn. endTimeMs
    // backdates the end to when the work finished (P1 tool spans record real start/end).
    async end(span, { attributes, error, endTimeMs } = {}) {
      if (m === 'off') return;
      span.endNs = endTimeMs != null ? BigInt(Math.round(endTimeMs)) * 1000000n : nowNs();
      if (attributes) Object.assign(span.attributes, attributes);
      if (error) span.error = error;
      try {
        await exportSpan(span);
      } catch (e) {
        if (log && log.warn) log.warn({ err: e.message }, 'otel span export failed');
        else console.error('otel span export failed:', e.message);
      }
    },
  };
}

module.exports = { createExporter, STDOUT_MARKER };

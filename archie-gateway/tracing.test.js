'use strict';

// Unit tests for tracing.js (dispatcher-observability M2): OTLP/JSON serialization, span-noise
// suppression (§3.4 / S3), the SigV4-OTLP exporter contract (never throws), and the degraded-env
// boot smoke (registering without AWS creds must not crash — the M2 crash-loop gate).
//
// DISPATCHER_OTEL_MODE=off is set BEFORE the require so register() is a no-op in this worker:
// these tests exercise the exported _internals, not global registration (that's the subprocess
// smoke below + the spans test file, which registers its own local provider).

process.env.DISPATCHER_OTEL_MODE = 'off';

const { execFileSync } = require('node:child_process');
const path = require('node:path');
const tracing = require('./tracing');

const { toAttrs, hrTimeToNanos, spanToOtlp, spansToOtlpJson, shouldDropSpan, expectedConflict, SigV4XrayOtlpExporter, otelRegion } = tracing._internals;

// The two idempotent-adopt conflicts, shaped exactly as the live spans carry them (captured from
// trace 83f7226a… on the pi-obs-41 switchover): HTTP 409 + an exception event.
function conflictSpan(op, exceptionType, message) {
  return fakeSpan({
    name: op === 'CreateRole' ? 'IAM.CreateRole' : 'EFS.CreateAccessPoint',
    attributes: {
      'rpc.method': op, 'aws.remote.operation': op, 'rpc.service': op === 'CreateRole' ? 'IAM' : 'EFS',
      'http.status_code': 409, 'http.response.status_code': 409,
    },
    status: { code: 2, message },
    events: [{
      time: [1754000000, 900000000],
      name: 'exception',
      attributes: { 'exception.type': exceptionType, 'exception.message': message, 'exception.stacktrace': 'at AwsQueryProtocol.handleError…' },
    }],
  });
}

// Minimal ReadableSpan-shaped fake (sdk-trace-base 2.x: parentSpanContext, instrumentationScope).
function fakeSpan(over = {}) {
  return {
    name: 'dispatcher.request',
    kind: 1, // API SpanKind.SERVER
    spanContext: () => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 1 }),
    parentSpanContext: undefined,
    startTime: [1754000000, 500000000],
    endTime: [1754000001, 0],
    attributes: { 'dispatcher.agent': 'alpha' },
    status: { code: 0 },
    events: [],
    resource: { attributes: { 'service.name': 'slack-dispatcher', 'deployment.environment': 'test' } },
    instrumentationScope: { name: 'slack-dispatcher' },
    ...over,
  };
}

describe('module load with mode=off', () => {
  it('does not register a provider (register() reports registered:false)', () => {
    expect(tracing.register().registered).toBe(false);
  });
});

describe('OTLP/JSON serialization', () => {
  it('encodes attribute value types per OTLP/JSON (int64 as string)', () => {
    const attrs = Object.fromEntries(toAttrs({ s: 'x', i: 3, d: 1.5, b: true, a: ['p', 'q'], skip: undefined, skip2: null }).map((a) => [a.key, a.value]));
    expect(attrs.s).toEqual({ stringValue: 'x' });
    expect(attrs.i).toEqual({ intValue: '3' });
    expect(attrs.d).toEqual({ doubleValue: 1.5 });
    expect(attrs.b).toEqual({ boolValue: true });
    expect(attrs.a).toEqual({ arrayValue: { values: [{ stringValue: 'p' }, { stringValue: 'q' }] } });
    expect(attrs.skip).toBeUndefined();
    expect(attrs.skip2).toBeUndefined();
  });

  it('converts HrTime to unix-nano strings', () => {
    expect(hrTimeToNanos([1754000000, 500000000])).toBe('1754000000500000000');
  });

  it('maps API SpanKind to the OTLP enum (+1) and carries ids/status', () => {
    const s = spanToOtlp(fakeSpan());
    expect(s.traceId).toBe('a'.repeat(32));
    expect(s.spanId).toBe('b'.repeat(16));
    expect(s.parentSpanId).toBeUndefined();
    expect(s.kind).toBe(2); // API SERVER(1) → OTLP SERVER(2)
    expect(s.startTimeUnixNano).toBe('1754000000500000000');
    expect(s.endTimeUnixNano).toBe('1754000001000000000');
    expect(s.status).toEqual({ code: 0 });
  });

  it('carries parentSpanId from parentSpanContext (SDK 2.x) so child spans nest', () => {
    const s = spanToOtlp(fakeSpan({ parentSpanContext: { traceId: 'a'.repeat(32), spanId: 'c'.repeat(16) } }));
    expect(s.parentSpanId).toBe('c'.repeat(16));
  });

  it('carries ERROR status with a bounded message', () => {
    const s = spanToOtlp(fakeSpan({ status: { code: 2, message: 'x'.repeat(500) } }));
    expect(s.status.code).toBe(2);
    expect(s.status.message.length).toBe(400);
  });

  it('groups spans under one resource, split by instrumentation scope', () => {
    const payload = spansToOtlpJson([
      fakeSpan(),
      fakeSpan({ name: 'BedrockAgentCore.GetAgentRuntime', instrumentationScope: { name: '@opentelemetry/instrumentation-aws-sdk' } }),
    ]);
    expect(payload.resourceSpans).toHaveLength(1);
    const res = Object.fromEntries(payload.resourceSpans[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
    expect(res['service.name']).toBe('slack-dispatcher');
    expect(res['deployment.environment']).toBe('test');
    const scopes = payload.resourceSpans[0].scopeSpans.map((s) => s.scope.name).sort();
    expect(scopes).toEqual(['@opentelemetry/instrumentation-aws-sdk', 'slack-dispatcher']);
  });
});

describe('expected-conflict downgrade (ERROR → warn)', () => {
  // Provisioning is idempotent-by-conflict: CreateRole/CreateAccessPoint are EXPECTED to 409 on every
  // cold provision and the code adopts the existing resource. Left as ERROR spans they train people
  // (and alarms) to ignore real errors.
  it('downgrades the two idempotent-adopt 409s to UNSET + warn attributes', () => {
    for (const [op, type, msg] of [
      ['CreateRole', 'EntityAlreadyExistsException', 'Role with name sandbox-person79b333-test already exists.'],
      ['CreateAccessPoint', 'AccessPointAlreadyExists', 'UnknownError'],
    ]) {
      const s = spanToOtlp(conflictSpan(op, type, msg));
      expect(s.status).toEqual({ code: 0 });                       // UNSET, not ERROR
      const attrs = Object.fromEntries(s.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]));
      expect(attrs['dispatcher.severity']).toBe('warn');
      expect(attrs['dispatcher.expected_conflict']).toBe(type);     // the fact stays queryable
      expect(attrs['dispatcher.expected_conflict_detail']).toBe(msg);
      expect(attrs['rpc.method']).toBe(op);                         // original attributes preserved
      expect(s.events).toBeUndefined();                             // stacktrace of an expected outcome, dropped
    }
  });

  it('does NOT downgrade a REAL failure on the same operations', () => {
    // AccessDenied on CreateRole is the actual deploy-order fault the derived-role rollout can hit
    // (agentcore-base / iam:CreateRole grant not applied yet) — swallowing it would hide an outage.
    const denied = conflictSpan('CreateRole', 'AccessDeniedException', 'not authorized to perform: iam:CreateRole');
    denied.attributes['http.status_code'] = 403;
    denied.attributes['http.response.status_code'] = 403;
    const s = spanToOtlp(denied);
    expect(s.status.code).toBe(2);
    expect(s.events).toHaveLength(1);
    expect(expectedConflict(denied)).toBeNull();
  });

  it('does NOT downgrade a 409 on any other operation', () => {
    const other = conflictSpan('CreateRole', 'ConflictException', 'busy');
    other.attributes['rpc.method'] = 'CreateAgentRuntime';
    other.attributes['aws.remote.operation'] = 'CreateAgentRuntime';
    expect(expectedConflict(other)).toBeNull();
    expect(spanToOtlp(other).status.code).toBe(2);
  });

  it('leaves ordinary spans completely untouched', () => {
    const s = spanToOtlp(fakeSpan());
    const attrs = s.attributes.map((a) => a.key);
    expect(attrs).not.toContain('dispatcher.severity');
    expect(attrs).not.toContain('dispatcher.expected_conflict');
  });

  it('tolerates a conflict span with no exception event', () => {
    const s = conflictSpan('CreateAccessPoint', 'x', 'y');
    s.events = [];
    expect(expectedConflict(s)).toEqual({ op: 'CreateAccessPoint', type: 'Conflict', detail: undefined });
    expect(spanToOtlp(s).status).toEqual({ code: 0 });
  });
});

describe('span-noise suppression (§3.4 / S3)', () => {
  const env = {};
  it('drops DynamoDB auto-spans (routing-read chatter)', () => {
    expect(shouldDropSpan(fakeSpan({ attributes: { 'rpc.service': 'DynamoDB', 'rpc.method': 'Query' } }), env)).toBe(true);
    expect(shouldDropSpan(fakeSpan({ attributes: { 'rpc.service': 'DynamoDBDocument', 'rpc.method': 'GetItem' } }), env)).toBe(true);
    expect(shouldDropSpan(fakeSpan({ name: 'DynamoDB.Query', attributes: {} }), env)).toBe(true);
  });
  it('drops ListAgentRuntimes polling chatter', () => {
    expect(shouldDropSpan(fakeSpan({ attributes: { 'rpc.service': 'BedrockAgentCore', 'rpc.method': 'ListAgentRuntimes' } }), env)).toBe(true);
  });
  it('keeps CreateAgentRuntime / GetAgentRuntime / InvokeAgentRuntime visible by default', () => {
    for (const m of ['CreateAgentRuntime', 'GetAgentRuntime', 'InvokeAgentRuntime']) {
      expect(shouldDropSpan(fakeSpan({ attributes: { 'rpc.service': 'BedrockAgentCore', 'rpc.method': m } }), env)).toBe(false);
    }
  });
  it('OTEL_SUPPRESS_INVOKE_AUTOSPAN=1 drops ONLY the InvokeAgentRuntime auto-span (S3 env flip)', () => {
    const flipped = { OTEL_SUPPRESS_INVOKE_AUTOSPAN: '1' };
    expect(shouldDropSpan(fakeSpan({ attributes: { 'rpc.service': 'BedrockAgentCore', 'rpc.method': 'InvokeAgentRuntime' } }), flipped)).toBe(true);
    expect(shouldDropSpan(fakeSpan({ attributes: { 'rpc.service': 'BedrockAgentCore', 'rpc.method': 'GetAgentRuntime' } }), flipped)).toBe(false);
    // the manual span carries no rpc.* attrs — never dropped
    expect(shouldDropSpan(fakeSpan({ name: 'dispatcher.agent_i073q7', attributes: { 'dispatcher.agent': 'alpha' } }), flipped)).toBe(false);
  });
  it('never drops manual dispatcher.* spans', () => {
    for (const name of ['dispatcher.request', 'dispatcher.provision', 'dispatcher.provision.runtime_ready', 'dispatcher.agent_i073q7']) {
      expect(shouldDropSpan(fakeSpan({ name }), env)).toBe(false);
    }
  });
});

describe('SigV4XrayOtlpExporter', () => {
  it('stdout mode prints the OTLP payload with the marker', async () => {
    const lines = [];
    const orig = console.log;
    console.log = (l) => lines.push(l);
    try {
      const exp = new SigV4XrayOtlpExporter({ region: 'us-east-1', mode: 'stdout', env: {} });
      const result = await new Promise((res) => exp.export([fakeSpan()], res));
      expect(result.code).toBe(0);
    } finally {
      console.log = orig;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${tracing.OTLP_MARKER} `)).toBe(true);
    const payload = JSON.parse(lines[0].slice(tracing.OTLP_MARKER.length + 1));
    expect(payload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe('dispatcher.request');
  });

  it('posts the serialized payload in xray mode (injected post fn — no network)', async () => {
    const posts = [];
    const exp = new SigV4XrayOtlpExporter({ region: 'us-east-1', mode: 'xray', env: {}, post: async (b) => posts.push(b) });
    const result = await new Promise((res) => exp.export([fakeSpan()], res));
    expect(result.code).toBe(0);
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0]).resourceSpans).toHaveLength(1);
  });

  it('suppressed spans are filtered before POST; an all-suppressed batch skips the POST entirely', async () => {
    const posts = [];
    const exp = new SigV4XrayOtlpExporter({ region: 'us-east-1', mode: 'xray', env: {}, post: async (b) => posts.push(b) });
    await new Promise((res) => exp.export([fakeSpan({ attributes: { 'rpc.service': 'DynamoDB', 'rpc.method': 'Query' } })], res));
    expect(posts).toHaveLength(0);
    await new Promise((res) => exp.export([
      fakeSpan(),
      fakeSpan({ name: 'DynamoDB.Query', attributes: { 'rpc.service': 'DynamoDB', 'rpc.method': 'Query' } }),
    ], res));
    expect(posts).toHaveLength(1);
    const spans = JSON.parse(posts[0]).resourceSpans[0].scopeSpans.flatMap((s) => s.spans);
    expect(spans.map((s) => s.name)).toEqual(['dispatcher.request']);
  });

  it('a failing export reports FAILED via the callback and never throws (telemetry must not fail a turn)', async () => {
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(' '));
    try {
      const exp = new SigV4XrayOtlpExporter({ region: 'us-east-1', mode: 'xray', env: {}, post: async () => { throw new Error('x-ray otlp 403: denied'); } });
      const result = await new Promise((res) => exp.export([fakeSpan()], res));
      expect(result.code).toBe(1);
      expect(String(result.error && result.error.message)).toMatch(/403/);
    } finally {
      console.error = orig;
    }
    expect(errs.some((l) => l.includes('span export failed'))).toBe(true);
  });

  it('resolves the region from env (AGENTCORE_REGION > AWS_REGION > default us-east-1)', () => {
    expect(otelRegion({ AGENTCORE_REGION: 'us-west-2', AWS_REGION: 'eu-west-1' })).toBe('us-west-2');
    expect(otelRegion({ AWS_REGION: 'eu-west-1' })).toBe('eu-west-1');
    expect(otelRegion({})).toBe('us-east-1');
  });
});

// ── Degraded-env boot smoke (the crash-loop gate) ─────────────────────────────────
// require('./tracing') in a FRESH node process with NO AWS creds/env must register cleanly,
// log the S6 boot-order line exactly once (idempotent under double-require, i.e. the
// NODE_OPTIONS=--require + first-line-require belt-and-braces), and exit 0.

describe('boot smoke: registration without AWS creds/env', () => {
  it('registers, is idempotent under double require, and does not throw', () => {
    const script = "require('./tracing'); delete require.cache[require.resolve('./tracing')]; require('./tracing'); console.log('BOOT_OK');";
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: __dirname,
      env: { PATH: process.env.PATH, NODE_ENV: 'production' }, // no AWS_* creds, no region
      encoding: 'utf8',
      timeout: 30000,
    });
    const registeredLines = out.split('\n').filter((l) => l.includes('tracing: OTEL SDK registered'));
    expect(registeredLines).toHaveLength(1); // global-symbol guard: second require is a no-op
    expect(registeredLines[0]).toContain('service=slack-dispatcher');
    expect(registeredLines[0]).toContain('mode=xray');
    expect(registeredLines[0]).toContain('region=us-east-1');
    expect(out).toContain('BOOT_OK');
  });

  it('index.js loads tracing before any @aws-sdk module (S6 load order, statically provable)', () => {
    const fs = require('node:fs');
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const tracingAt = src.indexOf("require('./tracing')");
    const firstAwsAt = src.search(/require\(['"]@aws-sdk\//);
    expect(tracingAt).toBeGreaterThanOrEqual(0);
    expect(firstAwsAt).toBeGreaterThan(tracingAt);
  });
});

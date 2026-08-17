// M3 trace-stitch unit test (dispatcher-observability-delivery-plan.md §4.3): inbound
// trace-context extraction for /invocations — source precedence (body.input.traceparent →
// traceparent header → x-amzn-trace-id header) + defensive fallback on malformed input.
// Payload-first per decision 8.2-c + live S1 finding (AgentCore's own x-amzn-trace-id would
// otherwise shadow the dispatcher's stitch on every request).
// Pure, dependency-free. Run:
//
//   node agentcore-pi/trace-context-test.mjs
//
import { parseTraceparent, parseAmznTraceId, extractTraceContext } from './trace-context.mjs';

let ok = true;
const check = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && cond; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const TID_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TID_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TID_C = 'cccccccccccccccccccccccccccccccc';
const SID_A = '1111111111111111';
const SID_B = '2222222222222222';
const SID_C = '3333333333333333';
const tp = (tid, sid) => `00-${tid}-${sid}-01`;

// ── parseTraceparent ──
console.log('parseTraceparent');
check('valid → {traceId,parentSpanId}', eq(parseTraceparent(tp(TID_A, SID_A)), { traceId: TID_A, parentSpanId: SID_A }));
check('trims + lowercases', eq(parseTraceparent(`  00-${TID_A.toUpperCase()}-${SID_A}-01  `), { traceId: TID_A, parentSpanId: SID_A }));
check('future version accepted', parseTraceparent(`01-${TID_A}-${SID_A}-01`)?.traceId === TID_A);
check('version ff rejected', parseTraceparent(`ff-${TID_A}-${SID_A}-01`) === null);
check('all-zero traceId rejected', parseTraceparent(tp('0'.repeat(32), SID_A)) === null);
check('all-zero spanId rejected', parseTraceparent(tp(TID_A, '0'.repeat(16))) === null);
check('wrong traceId length rejected', parseTraceparent(`00-${TID_A.slice(1)}-${SID_A}-01`) === null);
check('wrong spanId length rejected', parseTraceparent(`00-${TID_A}-${SID_A}0-01`) === null);
check('non-hex rejected', parseTraceparent(`00-${'g'.repeat(32)}-${SID_A}-01`) === null);
check('missing flags rejected', parseTraceparent(`00-${TID_A}-${SID_A}`) === null);
check('garbage → null (no throw)', parseTraceparent('not-a-traceparent') === null);
check('empty string → null', parseTraceparent('') === null);
check('undefined → null (no throw)', parseTraceparent(undefined) === null);
check('non-string → null (no throw)', parseTraceparent({ evil: true }) === null);

// ── parseAmznTraceId ──
console.log('parseAmznTraceId');
const AMZN = 'Root=1-68a4b1c2-abcdef0123456789abcdef01;Parent=53995c3f42cd8ad8;Sampled=1';
check('Root+Parent → 32hex traceId + parentSpanId', eq(parseAmznTraceId(AMZN), { traceId: '68a4b1c2abcdef0123456789abcdef01', parentSpanId: '53995c3f42cd8ad8' }));
check('Root only → traceId, parentSpanId null', eq(parseAmznTraceId('Root=1-68a4b1c2-abcdef0123456789abcdef01'), { traceId: '68a4b1c2abcdef0123456789abcdef01', parentSpanId: null }));
check('key order irrelevant', parseAmznTraceId('Sampled=0;Parent=53995c3f42cd8ad8;Root=1-68a4b1c2-abcdef0123456789abcdef01')?.parentSpanId === '53995c3f42cd8ad8');
check('lowercase keys accepted', parseAmznTraceId('root=1-68a4b1c2-abcdef0123456789abcdef01;parent=53995c3f42cd8ad8')?.traceId === '68a4b1c2abcdef0123456789abcdef01');
check('bad Parent kept as null (traceId still adopted)', eq(parseAmznTraceId('Root=1-68a4b1c2-abcdef0123456789abcdef01;Parent=short'), { traceId: '68a4b1c2abcdef0123456789abcdef01', parentSpanId: null }));
check('missing Root → null', parseAmznTraceId('Parent=53995c3f42cd8ad8;Sampled=1') === null);
check('non-v1 Root → null', parseAmznTraceId('Root=2-68a4b1c2-abcdef0123456789abcdef01') === null);
check('malformed Root → null', parseAmznTraceId('Root=1-xyz') === null);
check('all-zero Root → null', parseAmznTraceId('Root=1-00000000-000000000000000000000000') === null);
check('garbage → null (no throw)', parseAmznTraceId('!!;;==') === null);
check('undefined → null (no throw)', parseAmznTraceId(undefined) === null);

// ── extractTraceContext: precedence ──
console.log('extractTraceContext precedence');
const allThree = extractTraceContext(
  { traceparent: tp(TID_A, SID_A), 'x-amzn-trace-id': 'Root=1-bbbbbbbb-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=2222222222222222' },
  { prompt: 'hi', traceparent: tp(TID_C, SID_C) },
);
check('all three present → PAYLOAD wins (8.2-c: dispatcher stitch outranks ambient headers)', allThree.source === 'payload-traceparent' && allThree.traceId === TID_C && allThree.parentSpanId === SID_C);
check('presence booleans all true', allThree.hasTraceparentHeader && allThree.hasAmznTraceHeader && allThree.hasPayloadTraceparent);

const headerWins = extractTraceContext(
  { traceparent: tp(TID_A, SID_A), 'x-amzn-trace-id': 'Root=1-bbbbbbbb-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=2222222222222222' },
  { prompt: 'hi' },
);
check('no payload → traceparent header wins over amzn', headerWins.source === 'traceparent-header' && headerWins.traceId === TID_A && headerWins.parentSpanId === SID_A);

const amznWins = extractTraceContext(
  { 'x-amzn-trace-id': 'Root=1-bbbbbbbb-bbbbbbbbbbbbbbbbbbbbbbbb;Parent=2222222222222222' },
  { prompt: 'hi' },
);
check('only amzn header → amzn wins (last resort)', amznWins.source === 'x-amzn-trace-id-header' && amznWins.traceId === TID_B && amznWins.parentSpanId === SID_B);
check('amzn booleans', !amznWins.hasTraceparentHeader && amznWins.hasAmznTraceHeader && !amznWins.hasPayloadTraceparent);

const payloadWins = extractTraceContext({}, { traceparent: tp(TID_C, SID_C) });
check('headers absent → payload traceparent wins', payloadWins.source === 'payload-traceparent' && payloadWins.traceId === TID_C && payloadWins.parentSpanId === SID_C);
check('payload booleans', !payloadWins.hasTraceparentHeader && !payloadWins.hasAmznTraceHeader && payloadWins.hasPayloadTraceparent);

// ── extractTraceContext: malformed fallback ──
console.log('extractTraceContext malformed fallback');
const fallThrough = extractTraceContext(
  { traceparent: 'garbage', 'x-amzn-trace-id': 'Root=nope' },
  { traceparent: tp(TID_C, SID_C) },
);
check('malformed headers fall through to valid payload', fallThrough.source === 'payload-traceparent' && fallThrough.traceId === TID_C);
check('malformed sources still flagged present', fallThrough.hasTraceparentHeader && fallThrough.hasAmznTraceHeader);

const midFall = extractTraceContext(
  { traceparent: 'garbage', 'x-amzn-trace-id': 'Root=1-bbbbbbbb-bbbbbbbbbbbbbbbbbbbbbbbb' },
  { traceparent: 'also-garbage' },
);
check('malformed payload+traceparent fall to valid amzn (Root-only)', midFall.source === 'x-amzn-trace-id-header' && midFall.traceId === TID_B && midFall.parentSpanId === null);

const nothing = extractTraceContext({ traceparent: 'garbage' }, { traceparent: 'also-garbage' });
check('all malformed → nulls, source null (fresh trace)', nothing.traceId === null && nothing.parentSpanId === null && nothing.source === null);

const empty = extractTraceContext({}, {});
check('nothing present → nulls + false booleans', empty.traceId === null && empty.source === null && !empty.hasTraceparentHeader && !empty.hasAmznTraceHeader && !empty.hasPayloadTraceparent);

// Handler call-shape: extractTraceContext(req.headers, body?.input) with missing pieces.
check('undefined headers + input → safe nulls (no throw)', extractTraceContext(undefined, undefined).traceId === null);
check('non-string payload traceparent → safe (no throw)', extractTraceContext({}, { traceparent: 42 }).traceId === null);
check('empty/whitespace-string sources count as absent', eq(extractTraceContext({ traceparent: '' }, { traceparent: '  ' }), { hasTraceparentHeader: false, hasAmznTraceHeader: false, hasPayloadTraceparent: false, source: null, traceId: null, parentSpanId: null }));

console.log(ok ? 'ALL PASS' : 'FAILURES');
process.exit(ok ? 0 : 1);

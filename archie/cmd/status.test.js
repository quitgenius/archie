'use strict';

// Tests for `archie status`. NO credentials, NO network: every AWS client is injected as a fake that
// answers from a plain-object fixture, so the whole suite runs offline in milliseconds.
//
// The tests that matter most here are not the happy path — they are the four claims the reference
// makes that are easy to break silently:
//   · `missing` bindings are exit 0 (they are the reconciler's job, not a fault)
//   · an ABSENT pointer is reported as a fault, never as a benign empty state
//   · a read that FAILED is `unknown`, never folded into `missing`
//   · every DynamoDB expression is fully aliased — `agent` and `data` are reserved words, and a
//     fake client accepts a broken expression string just as happily as a working one

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  status, parseAgentFilter, summariseBindings, summariseImagePointers, rollbackTargets,
  fleetMetricSpecs, taintOf, render,
} = require('./status');
const { createContext, resourcesFor } = require('../lib/context');
const { createOutput } = require('../lib/output');
const { EXIT } = require('../lib/exit');
const corpus = require('../../clawdbot/agentcore-observability/insight-queries');

const AWS_COMMAND = { needsAws: true };

function ctxFor(values = {}) {
  return createContext({ region: 'us-east-1', ...values }, AWS_COMMAND, {});
}

function capture() {
  const stdout = []; const stderr = [];
  return {
    streams: { stdout: { write: (s) => stdout.push(s) }, stderr: { write: (s) => stderr.push(s) } },
    stdout: () => stdout.join(''),
    stderr: () => stderr.join(''),
  };
}

/**
 * A DynamoDBDocumentClient-shaped fake that answers from `state` and records every command input, so
 * a test can assert on the EXPRESSIONS that were sent and not merely on the result.
 */
function fakeDoc(state = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const input = cmd.input;
      calls.push(input);
      if (input.Key) return { Item: input.Key.pk === 'CONFIG#release' ? (state.release || undefined) : undefined };
      if (input.IndexName === 'routing') {
        return { Items: (state.agents || []).map((a) => ({ gsi1pk: 'ROUTING', gsi1sk: a, data: '{}' })) };
      }
      const pk = input.ExpressionAttributeValues[':pk'];
      if (pk === 'CONFIG#generation') return { Items: state.generations || [] };
      if (pk === 'CONFIG#image') return { Items: state.images || [] };
      if (String(pk).startsWith('RUNTIME#')) {
        const agent = String(pk).slice('RUNTIME#'.length);
        if ((state.failAgents || []).includes(agent)) throw new Error(`ProvisionedThroughputExceeded on ${agent}`);
        return { Items: (state.bindings || {})[agent] || [] };
      }
      return { Items: [] };
    },
  };
}

function fakeCw(results = []) {
  const calls = [];
  return { calls, async send(cmd) { calls.push(cmd.input); return { MetricDataResults: results, Messages: [] }; } };
}

const binding = (generationId, extra = {}) => ({ pk: 'RUNTIME#x', sk: `GEN#${generationId}`, arn: `arn:aws:…:runtime/${generationId}-abc`, ...extra });

/** The shape of a fleet where nothing is wrong: pointer, generation, image, three bound+ok agents. */
function healthyState() {
  return {
    agents: ['ch_platform', 'ch_growth', 'dm_UJCBAR1FB'],
    release: { pk: 'CONFIG#release', sk: 'ACTIVE', generationId: 'rel-2026-08-14-01', mode: 'staged', publishedAt: '2026-08-14T20:03:11Z', publishedBy: 'sandbox' },
    generations: [{ pk: 'CONFIG#generation', sk: 'rel-2026-08-14-01', image: 'repo:archie-0.2.6', createdAt: '2026-08-14T19:00:00Z' }],
    images: [{ pk: 'CONFIG#image', sk: 'FLEET', tag: 'archie-0.2.6' }],
    bindings: {
      ch_platform: [binding('rel-2026-08-14-01', { healthcheck: 'ok' })],
      ch_growth: [binding('rel-2026-08-14-01', { healthcheck: 'ok' })],
      dm_UJCBAR1FB: [binding('rel-2026-08-14-01', { healthcheck: 'ok' })],
    },
  };
}

/**
 * Drive the command the way bin/archie.js does — same output object, same error reporting, same
 * finish() — so what the tests see on stdout/stderr is exactly what an operator would see. Anything
 * less and the --json envelope (buffered until finish) and the error detail (printed by out.error,
 * which the handler never calls itself) would go untested.
 */
async function run(state, { values = {}, cw = fakeCw() } = {}) {
  const c = capture();
  const ctx = ctxFor(values);
  const out = createOutput({ json: ctx.json, verbosity: ctx.verbosity, streams: c.streams });
  const doc = fakeDoc(state);
  let thrown = null;
  let code = EXIT.OK;
  try {
    await status(ctx, { positionals: [], values }, out, { clients: { doc, cw }, now: () => Date.parse('2026-08-14T21:00:00Z') });
  } catch (e) {
    thrown = e;
    code = e.exitCode || EXIT.FAILED;
    out.error(e);
  }
  out.finish({ command: 'status', code, context: ctx });
  return { c, doc, cw, thrown, exit: code };
}

// ── the happy path ─────────────────────────────────────────────────────────────────────────────

test('a healthy fleet exits 0 and reports the pointer, coverage and no drift', async () => {
  const { c, exit } = await run(healthyState());
  assert.equal(exit, EXIT.OK);
  const s = c.stdout();
  assert.match(s, /^release {3}rel-2026-08-14-01 {3}mode=staged {3}published 2026-08-14T20:03:11Z by sandbox$/m);
  assert.match(s, /^coverage {2}3\/3 staged, 3 healthcheck=ok, 0 failed, 0 missing$/m);
  assert.match(s, /^drift {5}none$/m);
  // The registry-only caveat is part of the answer, not a footnote we can drop.
  assert.match(s, /registry-only/);
  assert.match(s, /runtime gc --reconcile-aws/);
});

test('--json returns the same facts as a document', async () => {
  const { c, exit } = await run(healthyState(), { values: { json: true } });
  assert.equal(exit, EXIT.OK);
  const envelope = JSON.parse(c.stdout());
  assert.equal(envelope.ok, true);
  assert.equal(envelope.exit, EXIT.OK);
  assert.equal(envelope.result.release.generationId, 'rel-2026-08-14-01');
  assert.equal(envelope.result.coverage.staged, 3);
  assert.deepEqual(envelope.result.drift, []);
  // The full lists live in --json even when the human report elides them.
  assert.deepEqual(envelope.result.coverage.missing, []);
});

// ── the four claims that are easy to break silently ────────────────────────────────────────────

test('`missing` bindings alone are exit 0 — they are the reconciler\'s job, not a failure', async () => {
  const state = healthyState();
  delete state.bindings.ch_growth;
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.OK, 'a missing binding must NOT be an error exit (reference §2.2)');
  assert.match(c.stdout(), /^missing {3}ch_growth {3}\(not a failure — fleet reconcile's job\)$/m);
  assert.match(c.stdout(), /2\/3 staged/);
});

test('an absent release pointer is reported as a fault, never as a benign empty state', async () => {
  const state = healthyState();
  delete state.release;
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.DRIFT);
  const s = c.stdout();
  assert.match(s, /^release {3}NONE — no CONFIG#release\/ACTIVE item/m);
  assert.match(s, /release-pointer-absent: CONFIG#release\/ACTIVE does not exist/);
  // With no active generation there is nothing to measure coverage against — say so, do not print
  // a 0/3 that reads as "the fleet is unprovisioned".
  assert.match(s, /^coverage {2}3\/3 agents hold at least one LIVE binding$/m);
  assert.match(s, /registry census, not coverage/);
});

test('an absent fleet image pointer names its consequence: every turn fails closed', async () => {
  const state = healthyState();
  state.images = [];
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.DRIFT);
  assert.match(c.stdout(), /NO baked fallback/);
  assert.match(c.stdout(), /ImagePointerMissing/);
});

test('an agent whose registry read FAILED is `unknown`, never `missing`, and exits 1', async () => {
  const state = healthyState();
  state.failAgents = ['ch_growth'];
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.FAILED, 'a backing read failure is exit 1 (reference §2.2)');
  const s = c.stdout();
  assert.match(s, /^unknown {3}ch_growth {3}\(the registry read FAILED — not the same as missing\)$/m);
  assert.doesNotMatch(s, /^missing/m);
  // The report is still printed: an operator at 2am needs the other five reads.
  assert.match(s, /^release {3}rel-2026-08-14-01/m);
  // The cause chain names the table and the underlying exception — "wrong region" and "throttled"
  // are indistinguishable without it (lib/exit.js, agent-image.js:52-56).
  assert.match(c.stderr(), /1 backing read failed/);
  assert.match(c.stderr(), /Query RUNTIME#ch_growth on archie-agent-config/);
  assert.match(c.stderr(), /ProvisionedThroughputExceeded/);
});

test('every DynamoDB expression this command builds is FULLY aliased', async () => {
  // `agent` and `data` are both reserved words; unaliased, `agent` broke every turn for every agent
  // live on 2026-08-13 — and a fake client accepts the broken string, which is exactly why this
  // assertion looks at the expression rather than at the result.
  const { doc } = await run(healthyState());
  const expressions = doc.calls
    // The routing GSI query belongs to routing-build.js:68 (`gsi1pk = :r`) — reused verbatim, not
    // ours to change, and `gsi1pk` is not a reserved word.
    .filter((input) => input.IndexName !== 'routing')
    .flatMap((input) => [input.KeyConditionExpression, input.FilterExpression, input.ProjectionExpression, input.UpdateExpression])
    .filter(Boolean);
  assert.ok(expressions.length >= 4, 'expected the pointer/generation/image/binding expressions');
  for (const expr of expressions) {
    for (const token of expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []) {
      // Every identifier must be reached through an alias; the only bare words allowed are the
      // expression language's own (begins_with, and, …).
      const isAliased = expr.includes(`#${token}`) || expr.includes(`:${token}`);
      const isKeyword = ['begins_with', 'and', 'AND', 'attribute_exists', 'attribute_not_exists'].includes(token);
      assert.ok(isAliased || isKeyword, `bare attribute name "${token}" in: ${expr}`);
    }
  }
});

// ── taint, rollback and drift ──────────────────────────────────────────────────────────────────

test('a TAINTED active generation exits 7 and says taint is permanent', async () => {
  const state = healthyState();
  state.generations[0].taintedAt = '2026-08-13T18:22:00Z';
  state.generations[0].taintReason = 'healthcheck: 3 agents';
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.DRIFT);
  const s = c.stdout();
  assert.match(s, /\*\*\* TAINTED \*\*\*/);
  assert.match(s, /active-generation-tainted:.*is TAINTED/s);
  assert.match(s, /cut a new generation, do not retry this one/);
});

test('a failed healthcheck on an UNTAINTED live generation is drift, not just a statistic', async () => {
  // A healthcheck failure taints (plan §7) and a tainted generation may never be live (§5.2). Failed
  // bindings on a live, untainted generation therefore means the taint write was lost or the pointer
  // was moved onto it anyway — neither is visible from the coverage line alone.
  const state = healthyState();
  state.bindings.ch_growth = [binding('rel-2026-08-14-01', { healthcheck: 'failed' })];
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.DRIFT);
  assert.match(c.stdout(), /^failed {4}ch_growth$/m);
  assert.match(c.stdout(), /active-healthcheck-failed-untainted: 1 agent failed healthcheck on the LIVE generation/);
});

test('taint is read tolerantly — the writer (W2-B) has not fixed the attribute spelling', () => {
  assert.equal(taintOf({}), null);
  assert.equal(taintOf({ taintedAt: '2026-08-13T18:22:00Z', taintReason: 'x' }).reason, 'x');
  assert.equal(taintOf({ tainted: true, updatedAt: '2026-08-13T00:00:00Z' }).at, '2026-08-13T00:00:00Z');
});

test('rollback targets exclude reaped and tainted generations', () => {
  const generations = new Map([
    ['rel-03', { generationId: 'rel-03', bindings: 3, live: 3, ok: 3, failed: 0 }],
    ['rel-02', { generationId: 'rel-02', bindings: 3, live: 0, ok: 3, failed: 0 }], // reaped: arn removed
    ['rel-01', { generationId: 'rel-01', bindings: 3, live: 3, ok: 0, failed: 3 }], // tainted
  ]);
  const specs = new Map([
    ['rel-03', { createdAt: '2026-08-13T00:00:00Z' }],
    ['rel-02', { createdAt: '2026-08-12T00:00:00Z' }],
    ['rel-01', { createdAt: '2026-08-11T00:00:00Z', taintedAt: '2026-08-11T09:00:00Z' }],
  ]);
  const targets = rollbackTargets(generations, specs, 'rel-04');
  // A reaped generation's row survives as history but its arn is gone — pointing at it would invoke
  // a corpse (runtime-registry.js:30-37).
  assert.deepEqual(targets.map((t) => t.generationId), ['rel-03']);
});

test('a binding whose arn was CLEARED by a failed invoke is drift, and is not counted as staged', async () => {
  const state = healthyState();
  state.bindings.ch_growth = [{ pk: 'RUNTIME#x', sk: 'GEN#rel-2026-08-14-01', clearedAt: '2026-08-14T20:40:00Z' }];
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.DRIFT);
  assert.match(c.stdout(), /2\/3 staged/);
  assert.match(c.stdout(), /binding-arn-cleared:/);
});

// ── coverage arithmetic ────────────────────────────────────────────────────────────────────────

test('a binding with no healthcheck field counts as UNRECORDED, never as ok', () => {
  // Phase 1 writes today's row shape, which has no healthcheck field at all (plan §12 step 1).
  // Counting those as ok would claim a release gate that never ran.
  const bindingsByAgent = new Map([
    ['a', [{ sk: 'GEN#g1', runtimeName: 'g1', arn: 'arn:1' }]],
    ['b', [{ sk: 'GEN#g1', runtimeName: 'g1', arn: 'arn:1', healthcheck: 'ok' }]],
    ['c', [{ sk: 'GEN#g1', runtimeName: 'g1', arn: 'arn:1', healthcheck: 'failed' }]],
  ]);
  const { coverage, healthcheckFailures } = summariseBindings(['a', 'b', 'c'], bindingsByAgent, 'g1');
  assert.equal(coverage.staged, 3);
  assert.equal(coverage.healthcheckOk, 1);
  assert.equal(coverage.healthcheckUnrecorded, 1);
  assert.equal(coverage.healthcheckFailed, 1);
  assert.deepEqual(healthcheckFailures.map((f) => f.agent), ['c']);
});

test('bindings are matched by generationId first, sort-key suffix second (the phase-1 rename)', () => {
  const rows = [{ sk: 'GEN#agent-gn0p84-a-fp8abc', runtimeName: 'agent-gn0p84-a-fp8abc', arn: 'arn:1', generationId: 'rel-01' }];
  const byId = summariseBindings(['a'], new Map([['a', rows]]), 'rel-01');
  assert.equal(byId.coverage.staged, 1);
  // …and the same row with no generationId still matches on the sort-key suffix.
  const legacy = [{ sk: 'GEN#agent-gn0p84-a-fp8abc', runtimeName: 'agent-gn0p84-a-fp8abc', arn: 'arn:1' }];
  const bySk = summariseBindings(['a'], new Map([['a', legacy]]), 'agent-gn0p84-a-fp8abc');
  assert.equal(bySk.coverage.staged, 1);
});

test('per-agent image overrides are REPORTED, not treated as drift (a canary is deliberate)', async () => {
  const state = healthyState();
  state.images.push({ pk: 'CONFIG#image', sk: 'AGENT#ch_platform', tag: 'archie-0.2.7' });
  const { c, exit } = await run(state);
  assert.equal(exit, EXIT.OK);
  assert.match(c.stdout(), /^override {2}1 per-agent image override\(s\): ch_platform=tag archie-0\.2\.7$/m);
});

test('an unusable image pointer is ABSENT, using the dispatcher\'s own acceptance rule', () => {
  // readImageItem is imported from image-source.js, not reimplemented: status must agree with the
  // turn path about what counts as a usable pointer or it reports health the fleet cannot use.
  const { fleet } = summariseImagePointers([{ sk: 'FLEET', tag: '   ' }]);
  assert.equal(fleet, null);
  // A URI and a bare tag stay apart: a tag is not resolved until provisioning runs.
  assert.deepEqual(summariseImagePointers([{ sk: 'FLEET', imageUri: 'repo:tag' }]).fleet, { uri: 'repo:tag', tag: null });
  assert.deepEqual(summariseImagePointers([{ sk: 'FLEET', tag: 'archie-0.2.6' }]).fleet, { uri: null, tag: 'archie-0.2.6' });
});

// ── options ────────────────────────────────────────────────────────────────────────────────────

test('--agents parses a comma list and narrows the per-agent queries', async () => {
  const { doc, exit } = await run(healthyState(), { values: { agents: 'ch_platform, ch_growth' } });
  assert.equal(exit, EXIT.OK);
  const runtimeQueries = doc.calls.filter((i) => i.ExpressionAttributeValues && String(i.ExpressionAttributeValues[':pk']).startsWith('RUNTIME#'));
  assert.deepEqual(runtimeQueries.map((i) => i.ExpressionAttributeValues[':pk']), ['RUNTIME#ch_platform', 'RUNTIME#ch_growth']);
  assert.equal(parseAgentFilter({ agents: ' a , ,b ' }).join('|'), 'a|b');
  assert.equal(parseAgentFilter({}), null);
});

test('--agents warns about a name absent from the routing GSI instead of silently reporting nothing', async () => {
  const { c } = await run(healthyState(), { values: { agents: 'ch_platform,agent_e6slez' } });
  assert.match(c.stderr(), /not present in the routing GSI: agent_e6slez/);
});

test('--brief skips the CloudWatch read entirely — the documented path past a metrics permissions gap', async () => {
  const cw = fakeCw();
  const { c, exit } = await run(healthyState(), { values: { brief: true }, cw });
  assert.equal(exit, EXIT.OK);
  assert.equal(cw.calls.length, 0, '--brief must not call GetMetricData at all');
  assert.match(c.stdout(), /^health {4}skipped \(--brief\)$/m);
});

// ── self-health metrics ────────────────────────────────────────────────────────────────────────

test('self-health is ONE GetMetricData over the curated 12-metric set', async () => {
  const cw = fakeCw();
  await run(healthyState(), { cw });
  assert.equal(cw.calls.length, 1, 'the curated set is retrievable in a single call — keep it that way');
  assert.equal(cw.calls[0].MetricDataQueries.length, corpus.SELF_HEALTH_METRICS.length);
});

test('fleet aggregation: SUM for counters, MAX for the rest, and NEVER AVG', () => {
  const specs = fleetMetricSpecs(resourcesFor('unit-test-stack'));
  assert.equal(specs.length, corpus.SELF_HEALTH_METRICS.length);
  for (const s of specs) {
    assert.match(s.expr, /^(SUM|MAX)\(/, `${s.name} must collapse to one series`);
    // AVG divides by the count of ALL agent series, most of them null in any minute — it understates
    // by ~10x (insight-queries.js, coldBoot note).
    assert.doesNotMatch(s.expr, /AVG\(/, `${s.name} must never be averaged across agents`);
  }
  assert.equal(specs.find((s) => s.name === 'messagesReceived').agg, 'SUM');
  assert.equal(specs.find((s) => s.name === 'turnLatencyP90').agg, 'MAX');
  // A MAX across agents is the WORST agent; a label still saying "per agent" would misdescribe it.
  assert.match(specs.find((s) => s.name === 'turnLatencyP90').label, /worst agent/);
});

test('metric namespaces follow --name, so status never reads another deployment\'s fleet', () => {
  assert.notEqual(corpus.DISPATCHER_NS, 'unit-test-stackDispatcher', 'fixture precondition');
  const joined = fleetMetricSpecs(resourcesFor('unit-test-stack')).map((s) => s.expr).join('\n');
  assert.ok(joined.includes('unit-test-stackDispatcher'), 'the dispatcher namespace must follow the knob');
  assert.ok(!joined.includes(corpus.DISPATCHER_NS), 'no expression may keep the corpus default');
});

test('an empty metric series is "no data", never 0', async () => {
  const cw = fakeCw([{ Id: 'q0', Values: [] }, { Id: 'q5', Values: [4, 9, 2] }]);
  const { c } = await run(healthyState(), { cw });
  const s = c.stdout();
  assert.match(s, /no data \(a quiet fleet, not an error\)/);
  assert.match(s, /turnErrors\s+SUM\s+4\s+9/, 'latest is the newest point (ScanBy TimestampDescending), max is the window max');
  assert.doesNotMatch(s, /messagesReceived\s+SUM\s+0/);
});

test('a CloudWatch failure still prints the DynamoDB half of the report, and exits 1', async () => {
  const cw = { calls: [], async send() { throw new Error('AccessDenied: cloudwatch:GetMetricData'); } };
  const { c, exit } = await run(healthyState(), { cw });
  assert.equal(exit, EXIT.FAILED);
  assert.match(c.stdout(), /^release {3}rel-2026-08-14-01/m);
  assert.match(c.stdout(), /^health {4}UNAVAILABLE: AccessDenied/m);
  // --brief is the way past it, and the error detail says which read failed.
  assert.match(c.stderr(), /GetMetricData/);
});

// ── the refusal ────────────────────────────────────────────────────────────────────────────────

test('status never reaches for ListAgentRuntimes', () => {
  // Not a behavioural assertion but a source one, deliberately: List is 25/s ACCOUNT-WIDE and
  // non-adjustable (runtime-registry.js:5-10), so the guarantee is "this code path does not exist",
  // which no fixture can prove. Coverage comes from the registry; `runtime gc --reconcile-aws` is
  // the command that is allowed to reconcile against AWS.
  const src = fs.readFileSync(path.join(__dirname, 'status.js'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.ok(!code.includes('ListAgentRuntimes'), 'status must never paginate the account');
  assert.ok(!code.includes('client-bedrock-agentcore-control'), 'status must not construct the control-plane client');
});

test('render() never claims a number it does not have', () => {
  const report = {
    name: 'agent-gn0p84',
    release: { present: false, generationId: null, mode: null, publishedAt: null, publishedBy: null, generationKnown: false, declaredImage: null, tainted: false },
    image: { fleet: null, overrides: [] },
    scope: { filtered: false, fleetAgents: 0 },
    coverage: { agents: 0, staged: 0, healthcheckOk: 0, healthcheckFailed: 0, healthcheckPending: 0, healthcheckUnrecorded: 0, missing: [], reaped: [], cleared: [], unknown: [] },
    liveBindingAgents: 0,
    healthcheckFailures: [],
    tainted: [],
    rollbackTargets: [],
    drift: [],
    selfHealth: { skipped: 'brief' },
    readFailures: [],
    note: '',
  };
  const s = render(report);
  // A brand-new account: everything absent, nothing invented, and the rollback line says outright
  // that there is nothing to roll back to rather than printing an empty field.
  assert.match(s, /^rollback {2}NONE — no other generation still holds a live binding$/m);
  assert.match(s, /^image {5}NONE/m);
});

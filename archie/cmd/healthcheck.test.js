'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const hc = require('./healthcheck');
const { EXIT } = require('../lib/exit');

const CTX = { region: 'us-east-1', resources: { configTable: 'agent-gn0p84-config' } };
const quiet = { verbose() {}, progress() {}, warn() {} };
const base = { agent: 'ch_platform', generationId: 'rel-1', runtimeArn: 'arn:aws:…:runtime/x', ctx: CTX, out: quiet };

// A clock and sleep that advance instantly, so a 120s budget costs no wall-clock in tests.
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; }, advance: (ms) => { t += ms; } };
}

test('a pass returns ok with the attempt count', async () => {
  const c = fakeClock();
  const r = await hc.runHealthcheck({ ...base, deps: { ...c, invoke: async () => ({ text: 'ok' }) } });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 1);
});

// THE MEASURED BEHAVIOUR THIS EXISTS FOR. A probe ~1s after READY got HTTP 500 and served ~15s
// later. Treating the first failure as a broken image would reject healthy builds every time.
test('the FIRST failure means nothing — it retries and passes', async () => {
  const c = fakeClock();
  let n = 0;
  const r = await hc.runHealthcheck({
    ...base,
    deps: {
      ...c,
      invoke: async () => {
        n += 1;
        if (n === 1) { const e = new Error('Received error (500) from runtime'); e.name = 'RuntimeClientError'; throw e; }
        return { text: 'ok' };
      },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2, 'a 500 on the first attempt must not be a verdict');
});

// The shape that silently reset consecutiveErrors for a cron job on 2026-08-12: a turn that emits
// an `error` event and then final {text:''} looks complete to a caller reading only `final`.
test('an error event with an empty final is a FAILURE, not a pass', async () => {
  const c = fakeClock();
  await assert.rejects(
    () => hc.runHealthcheck({
      ...base,
      budgetSeconds: 120,
      deps: { ...c, invoke: async () => ({ text: '', error: 'tool exploded' }) },
    }),
    (e) => e.exitCode === EXIT.TAINTED && /tool exploded/.test(e.cause.message),
  );
});

test('a complete turn that says nothing is a failure', async () => {
  const c = fakeClock();
  await assert.rejects(
    () => hc.runHealthcheck({ ...base, deps: { ...c, invoke: async () => ({ text: '   ' }) } }),
    (e) => e.exitCode === EXIT.TAINTED && /produced no text/.test(e.cause.message),
  );
});

test('a stream that closes without a final event is a failure', async () => {
  const c = fakeClock();
  await assert.rejects(
    () => hc.runHealthcheck({ ...base, deps: { ...c, invoke: async () => null } }),
    (e) => e.exitCode === EXIT.TAINTED && /incomplete turn/.test(e.cause.message),
  );
});

test('it exhausts the budget before concluding failure', async () => {
  const c = fakeClock();
  let n = 0;
  await assert.rejects(
    () => hc.runHealthcheck({
      ...base,
      budgetSeconds: 120,
      deps: { ...c, invoke: async () => { n += 1; throw new Error('still booting'); } },
    }),
    (e) => e.exitCode === EXIT.TAINTED,
  );
  // 120s budget at an 8s gap — many attempts, not one. The exact count matters less than "not 1".
  assert.ok(n > 10, `expected the budget to be spent on retries, got ${n} attempts`);
});

// Waiting cannot make a missing runtime appear, and spending 2 minutes to say so is worse than
// saying it now.
test('a terminal error stops immediately instead of burning the budget', async () => {
  const c = fakeClock();
  let n = 0;
  await assert.rejects(
    () => hc.runHealthcheck({
      ...base,
      budgetSeconds: 120,
      deps: {
        ...c,
        invoke: async () => { n += 1; const e = new Error('no such runtime'); e.name = 'ResourceNotFoundException'; throw e; },
      },
    }),
    (e) => e.exitCode === EXIT.TAINTED,
  );
  assert.equal(n, 1);
});

test('isTerminal classifies what waiting cannot fix', () => {
  for (const name of ['ResourceNotFoundException', 'AccessDeniedException', 'ValidationException', 'ParamValidationError']) {
    assert.equal(hc.isTerminal({ name }), true, name);
  }
  for (const name of ['RuntimeClientError', 'ThrottlingException', 'TimeoutError', 'Error']) {
    assert.equal(hc.isTerminal({ name }), false, name);
  }
});

// AgentCore rejects a shorter id as ParamValidation — an error that mentions nothing about length.
// A 31-char id once meant "the nudge silently never ran".
test('the prewarm session id is always at least 33 characters and safely charactered', () => {
  for (const [agent, gen] of [['a', 'b'], ['ch_platform', 'rel-2026-08-14-01'], ['dm/U04:KJ9Q2R', 'rel#1']]) {
    const id = hc.prewarmSessionId(agent, gen);
    assert.ok(id.length >= 33, `${id} is ${id.length} chars`);
    assert.match(id, /^[A-Za-z0-9_-]+$/, id);
  }
});

test('the session id is isolated from the agent\'s real sessions', () => {
  const id = hc.prewarmSessionId('ch_platform', 'rel-1');
  assert.match(id, /^prewarm-/, 'must not collide with a slack thread session key');
});

// Taint is permanent, so a budget below the observed serving-ready delay converts platform variance
// into false taints. Refused, not warned.
test('a budget below the floor is REFUSED, not warned', () => {
  assert.throws(() => hc.parseBudget('30'), (e) => e.exitCode === EXIT.REFUSED && /raised, never lowered/.test(e.detail));
  assert.throws(() => hc.parseBudget('0'), (e) => e.exitCode === EXIT.USAGE);
  assert.throws(() => hc.parseBudget('soon'), (e) => e.exitCode === EXIT.USAGE);
  assert.equal(hc.parseBudget(undefined), hc.DEFAULT_BUDGET_SECONDS);
  assert.equal(hc.parseBudget('300'), 300, 'raising is allowed');
});

test('the command refuses an agent with no live binding rather than inventing one', async () => {
  const aws = { doc: () => ({ send: async () => ({}) }) };
  await assert.rejects(
    () => hc.healthcheck(
      { ...CTX, dryRun: false },
      { positionals: [], values: { generation: 'rel-1', agent: 'ch_platform' } },
      quiet,
      {
        aws,
        // generation exists, but no binding
        readGeneration: async () => ({ sk: 'rel-1' }),
      },
    ),
    (e) => e.exitCode === EXIT.USAGE || e.exitCode === EXIT.REFUSED,
  );
});

test('the payload is a real prompt through /invocations, never /ping', () => {
  // /ping is not reachable through InvokeAgentRuntime, and input.prompt must be non-empty.
  const src = require('node:fs').readFileSync(require.resolve('./healthcheck.js'), 'utf8');
  assert.match(src, /input: \{ prompt/);
  assert.ok(!/['"]\/ping['"]/.test(src), 'must not attempt /ping');
  assert.ok(hc.DEFAULT_PROMPT.trim().length > 0, 'the default prompt must be non-empty');
});

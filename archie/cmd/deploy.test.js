'use strict';

// Tests for `archie deploy` — RUNTIME-CLI-REFERENCE.md §2.27.
//
// FOUR PROPERTIES, and they are the whole command:
//
//   1. ORDER. preflight -> agents -> gateway. Never the other way round (§2.27, plan §5).
//   2. BLAST RADIUS ON FAILURE. A `4` from the agent half means the gateway was NEVER TOUCHED — no
//      task definition registered, no rollout, no 94-second gap — and the code propagates unchanged.
//   3. THE SKIP. An unchanged gateway content digest skips the gateway half ENTIRELY: no build, no
//      push, no rollout, no outage. That is what makes a repeat `archie deploy` free, and it is the
//      property the whole derived-tag design exists for.
//   4. THE COMMAND NEVER CLAIMS ZERO DOWNTIME. When the gateway does roll, the ~94s outage is
//      announced BEFORE it happens.
//
// Everything is injected: no credentials, no network, no Docker, and no git (the `--pure` gate is a
// seam so the tests do not depend on the state of the working tree they run in).

const { test } = require('node:test');
const assert = require('node:assert/strict');

const deployCmd = require('./deploy');
const { EXIT } = require('../lib/exit');
const { resourcesFor } = require('../lib/context');
const { COMMANDS, load } = require('../lib/registry');

const NAME = 'agent-gn0p84';
const REGISTRY = `203366135563.dkr.ecr.us-east-1.amazonaws.com/${NAME}-gateway`;
const RUNNING_TAG = 'content-1111111111111111';
const NEW_TAG = 'content-2222222222222222';

function fakeOut() {
  const o = {
    answers: [], progressLines: [], warnings: [], verboseLines: [], failures: [],
  };
  return Object.assign(o, {
    startedAt: 0,
    answer: (v) => o.answers.push(v),
    progress: (l) => o.progressLines.push(l),
    verbose: (l) => o.verboseLines.push(l),
    warn: (l) => o.warnings.push(l),
    failure: (f) => o.failures.push(f),
    failureCount: () => o.failures.length,
    error: () => {},
  });
}

const ctxFor = (over = {}) => ({
  name: NAME,
  region: 'us-east-1',
  profile: null,
  account: null,
  dryRun: false,
  assumeYes: false,
  json: true,
  verbosity: 0,
  timeoutSeconds: null,
  resources: resourcesFor(NAME),
  ...over,
});

/**
 * Every composed step, recording its call. `runningTag` is what the DEPLOYED service reports, which
 * is the only thing the skip may be decided from.
 */
function fakeSteps(over = {}) {
  const calls = [];
  const wrap = (name, impl) => async (ctx, args, out, deps) => {
    calls.push({ name, values: { ...(args.values || {}) }, json: ctx.json });
    return impl(ctx, args, out, deps);
  };
  const runningTag = over.runningTag === undefined ? RUNNING_TAG : over.runningTag;
  const steps = {
    assertBaseline: over.assertBaseline
      ? async (...a) => { calls.push({ name: 'assertBaseline' }); return over.assertBaseline(...a); }
      : async () => { calls.push({ name: 'assertBaseline' }); return { account: '203366135563', results: [{ n: 1, status: 'pass' }] }; },
    // Stubbed like every other step, and it MUST be: without it stepsFor falls back to the real
    // `policy publish`, which reads DynamoDB — the whole suite then fails on "Could not load credentials",
    // which is how this was found. Default is the unchanged/no-op result a release that does not touch
    // policy produces.
    policyPublish: wrap('policyPublish', over.policyPublish || (async () => ({
      env: 'sandbox', digest: 'sha256:policy', rows: 0, written: false, unchanged: true,
    }))),
    fleetDeploy: wrap('fleetDeploy', over.fleetDeploy || (async () => ({
      generationId: 'gen-abc', mode: 'staged', stage: { coverage: 208, agents: 208 },
    }))),
    gatewayStatus: wrap('gatewayStatus', over.gatewayStatus
      || (async () => ({ tag: runningTag, image: `${REGISTRY}:${runningTag}`, taskDefinition: 'agent-gn0p84-dispatcher:70' }))),
    gatewayBuild: wrap('gatewayBuild', over.gatewayBuild || (async () => ({ tag: NEW_TAG, image: `${REGISTRY}:${NEW_TAG}`, pushed: true }))),
    gatewayDeploy: wrap('gatewayDeploy', over.gatewayDeploy || (async () => ({
      tag: NEW_TAG, rolled: true, unchanged: false, timeline: { gapSeconds: 94, healthyAt: '20:14:27' },
    }))),
  };
  return { calls, names: () => calls.map((c) => c.name), steps };
}

/** The derived gateway tag, injected so no test depends on the state of the working tree. */
const digestFor = (tag) => () => ({ digest: `${tag}deadbeef`, tag, fileCount: 42 });

const run = (values = {}, deps = {}, ctxOver = {}) => {
  const out = fakeOut();
  return deployCmd.deploy(ctxFor(ctxOver), { positionals: [], values }, out, deps).then((r) => ({ r, out }));
};

// ── 1. order ─────────────────────────────────────────────────────────────────────────────────────

test('preflight, then the agents, then the gateway', async () => {
  const s = fakeSteps();
  const { r } = await run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) });
  assert.deepEqual(s.names(), ['assertBaseline', 'policyPublish', 'fleetDeploy', 'gatewayStatus', 'gatewayBuild', 'gatewayDeploy'],
    'agents first: a new gateway may reference a generation that must already be stageable (§2.27)');
  assert.equal(r.gatewayRolled, true);
  assert.equal(r.outageSeconds, 94, 'the gap is the one this run OBSERVED, not the one in the document');
});

test('--skip-preflight skips the checks and says so', async () => {
  const s = fakeSteps();
  const { out } = await run({ 'skip-preflight': true }, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  assert.ok(!s.names().includes('assertBaseline'));
  assert.match(out.warnings.join('\n'), /account identity and the config table are NOT verified/);
});

test('a failing preflight stops before anything is built', async () => {
  const s = fakeSteps({
    assertBaseline: async () => { throw Object.assign(new Error('check 3 failed'), { exitCode: EXIT.PREFLIGHT }); },
  });
  await assert.rejects(() => run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) }),
    (e) => e.exitCode === EXIT.PREFLIGHT);
  assert.deepEqual(s.names(), ['assertBaseline']);
});

// ── 1.5 the policy step (plan §3) ────────────────────────────────────────────────────────────────

test('policy runs BEFORE the agent half — the verdict rows are provision inputs', async () => {
  // Order, not just presence. Staging agents onto a tag and THEN changing what they may do is two
  // releases pretending to be one, with a window where runtimes serve turns under the old policy.
  const s = fakeSteps();
  await run({}, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  const names = s.names();
  assert.ok(names.indexOf('policyPublish') < names.indexOf('fleetDeploy'));
});

test('a REFUSED policy step stops the release before anything is built', async () => {
  // Check 7 refusing (an undeclared decision change) or checks 1-4 failing must cost nothing: no image, no
  // staging, no rollout. Otherwise the checks are advisory.
  const s = fakeSteps({
    policyPublish: async () => { throw Object.assign(new Error('1 decision(s) would change'), { exitCode: EXIT.REFUSED }); },
  });
  const out = fakeOut();
  await assert.rejects(
    () => deployCmd.deploy(ctxFor(), { positionals: [], values: {} }, out, { steps: s.steps, digestFor: digestFor(NEW_TAG) }),
    (e) => e.exitCode === EXIT.REFUSED,
  );
  assert.deepEqual(s.names(), ['assertBaseline', 'policyPublish'], 'nothing after it ran');
  assert.match(out.progressLines.join('\n'), /agents {6}NOT TOUCHED/);
});

test('an account with NO pins file is skipped, not blocked', async () => {
  // A fresh sandbox has no pins.<env>.json declaring it, and the layer is additive — no artifact means
  // every scope keeps pre-policy behaviour. Blocking here would make policy a prerequisite for standing up
  // an environment. Distinguished from a real refusal by the message, so a failed CHECK still stops.
  const s = fakeSteps({
    policyPublish: async () => {
      throw Object.assign(new Error('no policy pins declare account 543510375323'), { exitCode: EXIT.REFUSED });
    },
  });
  const { r, out } = await run({}, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  assert.match(out.warnings.join('\n'), /policy {6}skipped/);
  assert.ok(s.names().includes('fleetDeploy'), 'the release continues');
  assert.equal(r.policy, undefined);
});

test('--accept-policy-change is threaded through, not swallowed', async () => {
  // Otherwise `archie deploy` becomes the way to bypass check 7: a release that changes a decision would
  // publish it without anyone declaring the change.
  const s = fakeSteps();
  await run({ 'accept-policy-change': true }, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  const call = s.calls.find((c) => c.name === 'policyPublish');
  assert.equal(call.values['accept-policy-change'], true);
});

test('--skip-policy skips it and says what that costs', async () => {
  const s = fakeSteps();
  const { out } = await run({ 'skip-policy': true }, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  assert.ok(!s.names().includes('policyPublish'));
  assert.match(out.warnings.join('\n'), /NOT compiled, checked or published/);
});

// ── 2. blast radius ──────────────────────────────────────────────────────────────────────────────

test('EXIT 4 from the agent half means the gateway was NEVER TOUCHED', async () => {
  const s = fakeSteps({
    fleetDeploy: async () => { throw Object.assign(new Error('2 healthcheck(s) failed'), { exitCode: EXIT.TAINTED }); },
  });
  const out = fakeOut();
  await assert.rejects(
    () => deployCmd.deploy(ctxFor(), { positionals: [], values: {} }, out, { steps: s.steps, digestFor: digestFor(NEW_TAG) }),
    (e) => e.exitCode === EXIT.TAINTED, 'the failing sub-step\'s code, unchanged (§2.27)',
  );
  assert.deepEqual(s.names(), ['assertBaseline', 'policyPublish', 'fleetDeploy'],
    'no gatewayStatus, no gatewayBuild, no gatewayDeploy — and therefore no ~94s outage');
  assert.match(out.progressLines.join('\n'), /gateway {5}NOT TOUCHED/);
});

test('every agent-half exit code propagates unchanged', async () => {
  for (const code of [EXIT.PARTIAL, EXIT.REFUSED, EXIT.HEADROOM, EXIT.FAILED]) {
    const s = fakeSteps({ fleetDeploy: async () => { throw Object.assign(new Error('nope'), { exitCode: code }); } });
    await assert.rejects(
      () => run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) }),
      (e) => e.exitCode === code,
    );
    assert.ok(!s.names().includes('gatewayDeploy'), `exit ${code} must not roll the gateway`);
  }
});

// ── 3. the skip ──────────────────────────────────────────────────────────────────────────────────

test('an unchanged gateway digest skips the gateway half ENTIRELY — no build, no roll, no outage', async () => {
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  const { r, out } = await run({}, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  assert.deepEqual(s.names(), ['assertBaseline', 'policyPublish', 'fleetDeploy', 'gatewayStatus']);
  assert.equal(r.gatewaySkipped, true);
  assert.equal(r.gatewayRolled, false);
  assert.equal(r.outageSeconds, null);
  assert.equal(r.overlapSeconds, null);
  // Asserted on the WARNING ITSELF, not on the "94 SECONDS" wording. The pre-roll warning now has two
  // forms — a gap for stop-then-start, an overlap for rolling — and matching only the gap's text would
  // let the rolling one be emitted here unnoticed. Nothing rolled, so neither belongs.
  assert.ok(!out.warnings.some((w) => /the dispatcher is about to roll/.test(w)),
    'no cost is announced because the gateway half never ran');
});

test('an agent-only change does not cost the gateway outage', async () => {
  // The two images' declared inputs differ, so their tags move independently (lib/digest.js). Here
  // the agent half released a new generation and the gateway digest did not move.
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  const { r } = await run({}, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  assert.equal(r.fleet.generationId, 'gen-abc');
  assert.equal(r.gatewaySkipped, true);
});

test('a changed gateway digest builds and rolls', async () => {
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  const { r } = await run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) });
  assert.ok(s.names().includes('gatewayBuild'));
  assert.equal(s.calls.find((c) => c.name === 'gatewayBuild').values.push, true);
  assert.equal(s.calls.find((c) => c.name === 'gatewayDeploy').values.tag, NEW_TAG);
  assert.equal(r.gatewayRolled, true);
});

test('an unreadable service is never treated as "unchanged" — bootstrap still deploys', async () => {
  const s = fakeSteps({
    gatewayStatus: async () => { throw Object.assign(new Error('ECS service agent-gn0p84-dispatcher not found'), { exitCode: EXIT.PREFLIGHT }); },
  });
  const { out } = await run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) });
  assert.ok(s.names().includes('gatewayDeploy'), 'silence about the running image must not skip the roll');
  assert.match(out.warnings.join('\n'), /bootstrap/);
});

// ── 4. the outage is never hidden ────────────────────────────────────────────────────────────────

test('the ~94s outage is announced BEFORE the roll, not after it', async () => {
  const seen = [];
  const s = fakeSteps({
    runningTag: RUNNING_TAG,
    gatewayDeploy: async () => { seen.push('deployed'); return { rolled: true, timeline: { gapSeconds: 94 } }; },
  });
  const out = fakeOut();
  const warn = out.warn;
  out.warn = (l) => { seen.push(`warn:${l.slice(0, 20)}`); warn(l); };
  await deployCmd.deploy(ctxFor(), { positionals: [], values: {} }, out, { steps: s.steps, digestFor: digestFor(NEW_TAG) });
  const outageWarning = seen.findIndex((x) => /warn:the dispatcher is ab/.test(x));
  assert.ok(outageWarning >= 0, 'the gap is stated, never hidden (§2.27)');
  assert.ok(outageWarning < seen.indexOf('deployed'), 'and it is stated before the messages start dropping');
});

test('the composed answer never claims zero downtime when the gateway rolled', async () => {
  // The fixture's timeline is a stop-then-start one (`gapSeconds: 94`, no `overlapSeconds`), which is
  // the prod shape — the gap must reach the answer whatever the current default is.
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  const { out } = await run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) }, { json: false });
  assert.match(out.answers[0], /94s of dispatcher downtime/);
});

test('a rolling gateway roll reports the overlap instead — no downtime, but not silence either', async () => {
  // The symmetric obligation. A rolling timeline has `gapSeconds: 0`, and the old render keyed on
  // `r.outageSeconds ? …` — so a truthful zero printed "rolled to <tag>" with NO cost at all, which
  // reads as free. The overlap is what replaced the gap, so it takes the gap's place in the answer.
  const rollingSteps = () => fakeSteps({
    runningTag: RUNNING_TAG,
    gatewayDeploy: async () => ({
      tag: NEW_TAG, rolled: true, unchanged: false,
      timeline: { mode: 'rolling', gapSeconds: 0, overlapSeconds: 47, healthyAt: '20:13:40' },
    }),
  });
  // `--json` returns the result and suppresses the rendered answer, so the numbers and the wording are
  // two runs of the same scenario.
  const { r } = await run({}, { steps: rollingSteps().steps, digestFor: digestFor(NEW_TAG) });
  assert.equal(r.outageSeconds, 0, 'a rolling deploy was down for zero seconds — that is a fact, not a gap in knowledge');
  assert.equal(r.overlapSeconds, 47);

  const { out } = await run({}, { steps: rollingSteps().steps, digestFor: digestFor(NEW_TAG) }, { json: false });
  assert.match(out.answers[0], /no downtime, 47s of two Socket Mode connections/);
  assert.match(out.warnings.join('\n'), /NO OUTAGE, but .* TWO tasks/);
});

// ── tags and purity ──────────────────────────────────────────────────────────────────────────────

test('--gateway-tag and --agent-tag pin the tags instead of deriving them', async () => {
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  const { r } = await run({ 'gateway-tag': 'archie-0.2.23', 'agent-tag': 'pi-obs-40' },
    { steps: s.steps, digestFor: digestFor(NEW_TAG) });
  assert.equal(r.gatewayTag, 'archie-0.2.23', 'the pinned tag decides the skip, not the derived one');
  assert.equal(s.calls.find((c) => c.name === 'fleetDeploy').values.tag, 'pi-obs-40');
  assert.equal(s.calls.find((c) => c.name === 'gatewayDeploy').values.tag, 'archie-0.2.23');
});

test('--pure refuses BOTH images before anything is built', async () => {
  const asked = [];
  const s = fakeSteps();
  await assert.rejects(
    () => run({ pure: true }, {
      steps: s.steps,
      digestFor: digestFor(NEW_TAG),
      assertPure: (image) => {
        asked.push(image);
        // The gateway is the dirty one. Composed, its own check would not run until after every agent in the fleet
        // had rolled — which is not the "refusal before anything is built" §2.27 promises.
        if (image === 'gateway') throw Object.assign(new Error('--pure: gateway inputs are modified'), { exitCode: EXIT.REFUSED });
      },
    }),
    (e) => e.exitCode === EXIT.REFUSED,
  );
  assert.deepEqual(asked, ['agent', 'gateway']);
  assert.deepEqual(s.names(), [], 'nothing ran: no preflight, no build, no stage, no roll');
});

test('--pure is also passed down, so each half enforces it on its own terms', async () => {
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  await run({ pure: true }, { steps: s.steps, digestFor: digestFor(NEW_TAG), assertPure: () => {} });
  assert.equal(s.calls.find((c) => c.name === 'fleetDeploy').values.pure, true);
  assert.equal(s.calls.find((c) => c.name === 'gatewayBuild').values.pure, true);
});

test('--hotfix and --keep reach the agent half', async () => {
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  await run({ hotfix: true, keep: '2' }, { steps: s.steps, digestFor: digestFor(RUNNING_TAG) });
  const fleet = s.calls.find((c) => c.name === 'fleetDeploy');
  assert.equal(fleet.values.hotfix, true);
  assert.equal(fleet.values.keep, '2');
});

// ── wiring ───────────────────────────────────────────────────────────────────────────────────────

test('sub-steps run in --json mode so their structured answers can be composed', async () => {
  const s = fakeSteps({ runningTag: RUNNING_TAG });
  await run({}, { steps: s.steps, digestFor: digestFor(NEW_TAG) }, { json: false });
  assert.ok(s.calls.filter((c) => c.json !== undefined).every((c) => c.json === true));
});

test('it resolves through the registry', () => {
  assert.equal(typeof load('deploy', COMMANDS.deploy), 'function');
});

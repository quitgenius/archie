'use strict';

// Tests for the PUBLISH GATE — `cmd/image.js publishRefusal`.
//
// WHY THIS FILE EXISTS. `image publish` is the one write in the CLI that moves traffic, and this
// function is the only thing standing in front of it. It had no unit tests at all until the
// `fleetAgents === 0` bypass was added (2026-08-21) — a gate with a bypass and no tests is a
// gate you have to read the source of to trust.
//
// WHAT THEY PIN. Two things, and they pull against each other on purpose:
//
//   1. THE LADDER'S ORDER. The first true refusal is what the operator is told, and it decides what
//      they do next: reporting "no healthcheck" for a tag that is TAINTED sends someone to re-run a
//      check on a build that can never ship (cmd/image.js's header states the order and why).
//   2. THE BYPASS IS NARROW. An empty deployment skips checks 3-6 — the ones protecting a real agent
//      from an unverified image — and NOTHING else. Taint and the image itself are properties of the
//      artefact, so they still refuse. If a later edit widens this, these tests fail.
//
// The function is pure, so there is no AWS here and no fake client: it takes the three reads' results
// as plain data. That is also why the gate is shaped this way — `fleet deploy` evaluates the same
// function on the same inputs, because "there is no force flag" has to be true of the code and not
// only of the flags (§5.1).

const test = require('node:test');
const assert = require('node:assert');

const { publishRefusal, emptyFleetWarning } = require('./image');
const { EXIT } = require('../lib/exit');

const TAG = 'content-deadbeefdeadbeef';
const URI = `203366135563.dkr.ecr.us-east-1.amazonaws.com/archie-agentcore:${TAG}`;

// An arm64 image that exists — the shape `describeImage` returns for a publishable artefact.
const FOUND = { digest: 'sha256:abc', arches: ['arm64'] };

// `bindingStats` output for a tag nothing has ever been staged onto: the check-3 case.
const NEVER_STAGED = { bound: 0, live: 0, ok: 0, failed: 0, pending: 0 };
// One agent staged, healthchecked, alive — the only stats that pass the full ladder.
const HEALTHY = { bound: 1, live: 1, ok: 1, failed: 0, pending: 0 };

const gate = (over = {}) => publishRefusal({
  tag: TAG, found: FOUND, taint: null, stats: HEALTHY, imageUri: URI, ...over,
});

// ── the ladder still works ───────────────────────────────────────────────────────────────────────

test('a healthy, staged tag is publishable', () => {
  assert.equal(gate(), null);
});

test('the full ladder still refuses when the deployment HAS agents', () => {
  // Each of 3-6 in turn, with fleetAgents deliberately non-zero. This is the control the bypass test
  // below is measured against: same stats, different agent count, opposite answer.
  const cases = [
    [{ bound: 0, live: 0, ok: 0, failed: 0, pending: 0 }, /never been staged/],
    [{ bound: 2, live: 0, ok: 0, failed: 0, pending: 0 }, /has been reaped/],
    [{ bound: 2, live: 2, ok: 1, failed: 1, pending: 0 }, /FAILED healthcheck/],
    [{ bound: 2, live: 2, ok: 1, failed: 0, pending: 1 }, /healthcheck has not run/],
  ];
  for (const [stats, re] of cases) {
    const r = gate({ stats, fleetAgents: 208 });
    assert.ok(r, `expected a refusal for ${JSON.stringify(stats)}`);
    assert.equal(r.exitCode, EXIT.REFUSED);
    assert.match(r.message, re);
  }
});

test('taint is reported FIRST, ahead of every other true refusal', () => {
  // Simultaneously tainted, absent from ECR and never staged. Taint must be the message: it is the
  // only one of the three that no amount of re-running can fix (§5.2, no untaint, no force).
  const r = gate({
    taint: { taintedAt: '2026-08-20T00:00:00Z', reason: 'healthcheck failed' },
    found: null,
    stats: NEVER_STAGED,
    fleetAgents: 208,
  });
  assert.match(r.message, /TAINTED/);
});

// ── the bypass, and its edges ────────────────────────────────────────────────────────────────────

test('an empty deployment skips the staging and health checks', () => {
  // The exact live state this was written for: nothing staged, because there is nothing to stage.
  assert.equal(gate({ stats: NEVER_STAGED, fleetAgents: 0 }), null);
  // And the other three, since all four protect the same non-existent agent.
  assert.equal(gate({ stats: { bound: 2, live: 0, ok: 0, failed: 0, pending: 0 }, fleetAgents: 0 }), null);
  assert.equal(gate({ stats: { bound: 2, live: 2, ok: 1, failed: 1, pending: 0 }, fleetAgents: 0 }), null);
  assert.equal(gate({ stats: { bound: 2, live: 2, ok: 1, failed: 0, pending: 1 }, fleetAgents: 0 }), null);
});

test('an empty deployment still refuses a TAINTED tag', () => {
  // The bypass is about who might run the image. Taint is about the image. Widening it to cover taint
  // would make an empty deployment the way to publish a build that failed its healthcheck.
  const r = gate({
    taint: { taintedAt: '2026-08-20T00:00:00Z', reason: 'healthcheck failed during stage' },
    stats: NEVER_STAGED,
    fleetAgents: 0,
  });
  assert.ok(r);
  assert.match(r.message, /TAINTED/);
});

test('an empty deployment still refuses a missing or amd64 image', () => {
  const missing = gate({ found: null, stats: NEVER_STAGED, fleetAgents: 0 });
  assert.ok(missing);
  assert.match(missing.message, /not in ECR/);

  // The amd64 dispatcher image published by mistake — the failure this check was written for. An empty
  // deployment does not make it pullable; the first agent to mint would be the one to find out.
  const wrongArch = gate({
    found: { digest: 'sha256:abc', arches: ['amd64'] },
    stats: NEVER_STAGED,
    fleetAgents: 0,
  });
  assert.ok(wrongArch);
  assert.match(wrongArch.message, /arm64/);
});

test('omitting fleetAgents keeps the FULL gate — the bypass is opt-in', () => {
  // `null`, not 0, is the default precisely so a caller that has not been taught to count agents cannot
  // inherit the bypass by accident. `image publish` and `fleet deploy` both pass it explicitly.
  const r = gate({ stats: NEVER_STAGED });
  assert.ok(r, 'a caller that says nothing about agent count must still be gated');
  assert.match(r.message, /never been staged/);
});

test('one agent is not zero agents', () => {
  // The off-by-one that would matter most: a single routed agent is exactly the case the gate exists
  // for, and `>= 0` or a falsy check would swallow it.
  const r = gate({ stats: NEVER_STAGED, fleetAgents: 1 });
  assert.ok(r);
  assert.match(r.message, /never been staged/);
});

// ── the warning ──────────────────────────────────────────────────────────────────────────────────

test('the empty-fleet warning names the tag, the table and the --name trap', () => {
  // The agent count IS the safety argument, and a wrong `--name` resolves to a table that exists and is
  // empty — indistinguishable from a genuinely empty deployment. The warning has to say so, because it
  // is the only thing between that mistake and an unverified publish into the wrong deployment.
  const w = emptyFleetWarning(TAG, 'archie-agent-config');
  assert.match(w, /archie-agent-config/);
  assert.match(w, new RegExp(TAG));
  assert.match(w, /SKIPPED/);
  assert.match(w, /--name/);
});

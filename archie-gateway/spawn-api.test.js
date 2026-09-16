'use strict';

// vitest globals enabled via vitest.config.js
const express = require('express');
const { createSpawnApi, childSessionId, childBudgetMs, MAX_SPAWN_DEPTH } = require('./spawn-api');
const { mintTurnToken, claimsOf } = require('./turn-token');

const SECRET = 'k';
const NOW = 1_000_000_000;
const parentClaims = (over = {}) => claimsOf(mintTurnToken({
  scope: 'dm-u1', sessionId: 'ac-parent-session', runId: 'r', depth: 0,
  expMs: NOW + 30 * 60_000, ...over,
}, SECRET));

function app(over = {}) {
  const invokes = [];
  const rows = [];
  const agentCore = {
    ensureRuntime: vi.fn(async () => 'arn:runtime'),
    invokeStreaming: vi.fn(async (arn, sid, body, onChunk, opts) => {
      invokes.push({ arn, sid, body, opts });
      if (over.invokeImpl) return over.invokeImpl(opts);
      return { text: 'child answered', usage: { output: 3 }, stopReason: 'stop' };
    }),
    ...over.agentCore,
  };
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => { req.dispatcherAuth = over.auth !== undefined ? over.auth : { kind: 'token', scope: 'dm-u1', claims: over.claims || parentClaims() }; next(); });
  a.use('/spawn', createSpawnApi({
    agentCore,
    mintTurnToken: (c) => mintTurnToken({ ...c }, SECRET),
    turnTokens: { open: async (c) => rows.push(['open', c.depth]), close: async (c) => rows.push(['close', c.depth]) },
    now: () => NOW,
    newNonce: () => 'nonce',
    log: { info() {}, warn() {}, error() {}, child() { return this; } },
  }));
  return { a, agentCore, invokes, rows };
}

const post = async (a, body) => {
  const srv = await new Promise((r) => { const s = a.listen(0, () => r(s)); });
  const port = srv.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/spawn`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
  });
  const json = await res.json();
  srv.close();
  return { status: res.status, json };
};

describe('spawn — identity comes from the signature, never the body', () => {
  it('runs the child as the TOKEN\'s scope', async () => {
    const { a, invokes, agentCore } = app();
    const r = await post(a, { prompt: 'do a thing' });
    expect(r.json.ok).toBe(true);
    expect(agentCore.ensureRuntime.mock.calls[0][0]).toBe('dm-u1');
    expect(invokes[0].opts.agent).toBe('dm-u1');
  });

  // The requirement the whole design exists for. There is no field to put another scope IN, and this
  // asserts that adding one to the body changes nothing.
  it('IGNORES an agentId in the body — there is no way to spawn as someone else', async () => {
    const { a, agentCore } = app();
    await post(a, { prompt: 'x', agentId: 'dm-victim', scope: 'dm-victim' });
    expect(agentCore.ensureRuntime.mock.calls[0][0]).toBe('dm-u1');
  });

  it('refuses a caller with no token at all', async () => {
    const { a } = app({ auth: { kind: 'secret', scope: null, claims: null } });
    const r = await post(a, { prompt: 'x' });
    expect(r.status).toBe(401);
  });
});

describe('spawn — recursion, which is what keeps the two semaphores deadlock-free', () => {
  it('mints the child at depth+1', async () => {
    const { a, invokes } = app();
    await post(a, { prompt: 'x' });
    expect(claimsOf(invokes[0].body.input.dispatcherToken).depth).toBe(1);
  });

  it('REFUSES a spawn from an already-spawned session', async () => {
    const { a, agentCore } = app({ claims: parentClaims({ depth: MAX_SPAWN_DEPTH }) });
    const r = await post(a, { prompt: 'x' });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/cannot spawn again/);
    expect(agentCore.invokeStreaming).not.toHaveBeenCalled();
  });

  // A refusal the model can read and act on, not an exception it will retry.
  it('reports the refusal as a 200 tool result', async () => {
    const { a } = app({ claims: parentClaims({ depth: 1 }) });
    expect((await post(a, { prompt: 'x' })).status).toBe(200);
  });
});

describe('spawn — the child must not outlive the parent waiting on it', () => {
  // The parent's remaining time is the CEILING, not the target — a child with no stated need still
  // gets the 5-minute default. What the parent's exp guarantees is that the child can never exceed it.
  it('caps the budget at the PARENT TOKEN\'s exp, not at a constant', () => {
    const roomy = { exp: Math.floor((NOW + 30 * 60_000) / 1000) };
    const tight = { exp: Math.floor((NOW + 2 * 60_000) / 1000) };
    expect(childBudgetMs(roomy, undefined, NOW)).toBe(5 * 60_000);          // the default applies
    expect(childBudgetMs(tight, undefined, NOW)).toBeLessThan(2 * 60_000);  // the parent's deadline wins
    expect(childBudgetMs(roomy, 3600, NOW)).toBeLessThan(30 * 60_000);      // a big ask is still capped
  });

  it('honours a SHORTER request but never a longer one', () => {
    const claims = { exp: Math.floor((NOW + 10 * 60_000) / 1000) };
    expect(childBudgetMs(claims, 30, NOW)).toBe(30_000);
    expect(childBudgetMs(claims, 3600, NOW)).toBeLessThan(10 * 60_000);
  });

  it('refuses when the parent has almost no turn left', async () => {
    const { a, agentCore } = app({ claims: parentClaims({ expMs: NOW + 20_000 }) });
    const r = await post(a, { prompt: 'x' });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/not enough time/);
    expect(agentCore.invokeStreaming).not.toHaveBeenCalled();
  });
});

describe('spawn — the session id, and why it must differ', () => {
  // invokeStreaming allows one invoke in flight per runtimeSessionId. A child reusing the parent's id
  // would block on a lock the parent holds while the parent blocks on the child.
  it('is NOT the parent session id', async () => {
    const { a, invokes } = app();
    await post(a, { prompt: 'x' });
    expect(invokes[0].sid).not.toBe('ac-parent-session');
    expect(invokes[0].sid).toContain('spawn');
  });

  it('satisfies AgentCore\'s 33-character minimum and its charset', () => {
    const id = childSessionId('s', 'n');
    expect(id.length).toBeGreaterThanOrEqual(33);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('spawn — the concurrency pool, which is a liveness property', () => {
  // Without this the child queues behind permits held by parents that are waiting on children.
  it('marks the invoke as spawned so it takes the SEPARATE pool', async () => {
    const { a, invokes } = app();
    await post(a, { prompt: 'x' });
    expect(invokes[0].opts.spawned).toBe(true);
  });
});

describe('spawn — failures are tool results, and the row always closes', () => {
  it('a child that errors is reported, not thrown', async () => {
    const { a } = app({ invokeImpl: () => ({ error: 'model exploded' }) });
    const r = await post(a, { prompt: 'x' });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: false });
    expect(r.json.error).toMatch(/model exploded/);
  });

  it('an aborted child reports its budget plainly', async () => {
    const { a } = app({ invokeImpl: () => { throw new Error('The operation was aborted'); } });
    const r = await post(a, { prompt: 'x' });
    expect(r.json.ok).toBe(false);
    expect(r.json.error).toMatch(/budget and was stopped/);
  });

  it('opens and closes the child\'s revocation row on every path', async () => {
    const ok = app();
    await post(ok.a, { prompt: 'x' });
    expect(ok.rows).toEqual([['open', 1], ['close', 1]]);

    const bad = app({ invokeImpl: () => { throw new Error('boom'); } });
    await post(bad.a, { prompt: 'x' });
    expect(bad.rows).toEqual([['open', 1], ['close', 1]]);
  });
});

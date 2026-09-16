'use strict';

// vitest globals enabled via vitest.config.js
const { createTurnTokenStore, tokenKey, TOKEN_PK_PREFIX } = require('./turn-token-store');

const claims = (over = {}) => ({ jti: 'j1', scope: 'dm-u1', sessionId: 's', runId: 'r', depth: 0, exp: 2_000_000, ...over });

function store(over = {}) {
  const sent = [];
  const doc = { send: vi.fn(async (cmd) => { sent.push(cmd); return over.result !== undefined ? over.result : {}; }) };
  if (over.throws) doc.send = vi.fn(async () => { throw new Error('ddb down'); });
  const s = createTurnTokenStore({ doc: over.noTable ? null : doc, table: 'cfg', now: () => 1_000_000, log: { info() {}, warn() {}, error() {} } });
  return { s, sent, doc };
}

describe('turn-token-store — the row IS the liveness', () => {
  it('open writes a row under its own TOKEN# partition', async () => {
    const { s, sent } = store();
    expect(await s.open(claims())).toEqual({ ok: true });
    expect(sent[0].input.Key).toEqual({ pk: 'TOKEN#j1', sk: 'TURN' });
  });

  // IAM has no sort-key condition, and derive-exec-role scopes a runtime's read by LeadingKeys. A
  // row under AGENT#<scope> would be readable by the very agent whose credential it governs.
  it('the partition is NOT AGENT#/GRANT#/OAUTH#/SKILL#', () => {
    expect(tokenKey('x').pk.startsWith(TOKEN_PK_PREFIX)).toBe(true);
    for (const p of ['AGENT#', 'GRANT#', 'OAUTH#', 'SKILL#']) expect(tokenKey('x').pk.startsWith(p)).toBe(false);
  });

  it('close deletes it', async () => {
    const { s, sent } = store();
    expect(await s.close(claims())).toEqual({ ok: true });
    expect(sent[0].input.Key).toEqual({ pk: 'TOKEN#j1', sk: 'TURN' });
  });

  // UpdateItem, not PutItem: the dispatcher's policy grants UpdateItem only, so a PutItem here would
  // be an AccessDenied in production that no test of the shape alone would catch.
  it('open is an UpdateItem', async () => {
    const { s, sent } = store();
    await s.open(claims());
    expect(sent[0].constructor.name).toBe('UpdateCommand');
    expect(sent[0].input.UpdateExpression).toContain('SET');
  });

  it('carries the scope and run for audit — the only cheap answer to "who held a live credential"', async () => {
    const { s, sent } = store();
    await s.open(claims());
    const body = JSON.parse(sent[0].input.ExpressionAttributeValues[':d']);
    expect(body).toMatchObject({ scope: 'dm-u1', runId: 'r', exp: 2_000_000, openedAtMs: 1_000_000 });
  });

  // TTL is GC. It must never reap a row while the turn is still running, so it sits beyond exp.
  it('ttl is set past the token\'s own expiry', async () => {
    const { s, sent } = store();
    await s.open(claims());
    expect(sent[0].input.ExpressionAttributeValues[':t']).toBeGreaterThan(2_000_000);
  });
});

describe('turn-token-store — liveness answers, which the alarm depends on', () => {
  it('a present row is live', async () => {
    const { s } = store({ result: { Item: { pk: 'TOKEN#j1' } } });
    expect(await s.isLive(claims())).toBe('live');
  });

  it('an ABSENT row is revoked — presence means live, and that is what fails closed', async () => {
    const { s } = store({ result: {} });
    expect(await s.isLive(claims())).toBe('revoked');
  });

  // Collapsing these would page on a DynamoDB blip as though it were a replayed credential.
  it('an unreadable table is `unavailable`, NOT `revoked`', async () => {
    const { s } = store({ throws: true });
    expect(await s.isLive(claims())).toBe('unavailable');
  });

  it('no table configured is `unavailable` too — no revocation, and it says so', async () => {
    const { s } = store({ noTable: true });
    expect(s.configured).toBe(false);
    expect(await s.isLive(claims())).toBe('unavailable');
  });
});

describe('turn-token-store — failure behaviour at the two ends of a turn', () => {
  // The turn is about to start. Whether a failed write should abort it is the invoke path's call.
  it('open REPORTS a failed write rather than throwing or lying', async () => {
    const { s } = store({ throws: true });
    expect(await s.open(claims())).toEqual({ ok: false, reason: 'write_failed' });
  });

  // close runs in a finally, on the way out of a turn that has already done its work.
  it('close never throws — a failed delete must not fail a completed turn', async () => {
    const { s } = store({ throws: true });
    await expect(s.close(claims())).resolves.toEqual({ ok: false });
  });

  it('both are inert without a jti or a table, and neither throws', async () => {
    const { s, sent } = store({ noTable: true });
    expect(await s.open(claims())).toEqual({ ok: false, reason: 'unconfigured' });
    expect(await s.open(claims({ jti: null }))).toEqual({ ok: false, reason: 'no_jti' });
    expect(await s.close(null)).toEqual({ ok: false });
    expect(sent).toHaveLength(0);
  });
});

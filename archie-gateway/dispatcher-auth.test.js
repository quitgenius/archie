'use strict';

// vitest globals enabled via vitest.config.js
const { createDispatcherAuth, pathSubject, PATH_SUBJECT } = require('./dispatcher-auth');
const { mintTurnToken } = require('./turn-token');

const SECRET = 'fleet-wide-shared-secret';
const token = (over = {}) => mintTurnToken({ scope: 'dm-u1', sessionId: 's', runId: 'r', expMs: Date.now() + 60_000, ...over }, SECRET);

function harness(over = {}) {
  const rejected = [];
  const metrics = { emitTokenRejected: (reason, ctx) => rejected.push([reason, ctx && ctx.agent]) };
  const auth = createDispatcherAuth({
    secret: SECRET,
    turnTokens: { isLive: async () => over.liveness || 'live' },
    metrics,
    log: { info() {}, warn() {}, error() {} },
  });
  return { auth, rejected };
}

const reqOf = (over = {}) => ({ headers: {}, path: '/cron', method: 'POST', ...over });
function resOf() {
  const r = { code: null, body: null };
  r.status = (c) => { r.code = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  return r;
}
const run = async (auth, req) => {
  const res = resOf();
  let nexted = false;
  await auth.authenticate(req, res, () => { nexted = true; });
  return { res, nexted };
};

describe('dispatcher auth — one header, two credentials', () => {
  it('accepts the fleet-wide secret and reports NO scope — which is the problem being replaced', async () => {
    const { auth } = harness();
    const req = reqOf({ headers: { 'x-dispatcher-secret': SECRET } });
    const { nexted } = await run(auth, req);
    expect(nexted).toBe(true);
    expect(req.dispatcherAuth).toEqual({ kind: 'secret', scope: null, claims: null });
  });

  it('accepts a per-turn token in the SAME header and derives the scope from the signature', async () => {
    const { auth } = harness();
    const req = reqOf({ headers: { 'x-dispatcher-secret': token() } });
    const { nexted } = await run(auth, req);
    expect(nexted).toBe(true);
    expect(req.dispatcherAuth.kind).toBe('token');
    expect(req.dispatcherAuth.scope).toBe('dm-u1');
  });

  // D3's compatibility argument: ~230 workspaces send whatever `$DISPATCHER_SHARED_SECRET` holds
  // under this header. If the token needed its own header, every one of those scripts would break
  // on the phase-3 flip and there is no way to audit them.
  it('tells them apart by SHAPE, not by a second header', async () => {
    const { auth } = harness();
    const a = reqOf({ headers: { 'x-dispatcher-secret': token() } });
    const b = reqOf({ headers: { 'x-dispatcher-secret': SECRET } });
    await run(auth, a); await run(auth, b);
    expect([a.dispatcherAuth.kind, b.dispatcherAuth.kind]).toEqual(['token', 'secret']);
  });

  it('a token signed with a DIFFERENT secret is refused', async () => {
    const { auth, rejected } = harness();
    const foreign = mintTurnToken({ scope: 'dm-attacker', expMs: Date.now() + 60_000 }, 'not-the-secret');
    const { res, nexted } = await run(auth, reqOf({ headers: { 'x-dispatcher-secret': foreign } }));
    expect(nexted).toBe(false);
    expect(res.code).toBe(401);
    expect(rejected[0][0]).toBe('unknown');
  });

  it('no credential at all is `missing`, not `unknown`', async () => {
    const { auth, rejected } = harness();
    const { res } = await run(auth, reqOf());
    expect(res.body.reason).toBe('missing');
    expect(rejected[0][0]).toBe('missing');
  });

  it('an expired token is `expired` — explicable, and deliberately not the alarm', async () => {
    const { auth, rejected } = harness();
    const { res } = await run(auth, reqOf({ headers: { 'x-dispatcher-secret': token({ expMs: Date.now() - 1000 }) } }));
    expect(res.code).toBe(401);
    expect(rejected[0][0]).toBe('expired');
  });
});

describe('dispatcher auth — revocation, and what happens when it cannot be consulted', () => {
  it('a revoked token is refused and metered as `revoked` — the alarm signal', async () => {
    const { auth, rejected } = harness({ liveness: 'revoked' });
    const { res, nexted } = await run(auth, reqOf({ headers: { 'x-dispatcher-secret': token() } }));
    expect(nexted).toBe(false);
    expect(res.code).toBe(401);
    expect(rejected).toEqual([['revoked', 'dm-u1']]);
  });

  // ONE RULE: anything but `live` is a refusal. An earlier version accepted here, to avoid taking
  // the fleet's dispatcher calls down on a DynamoDB blip — but the runtime reads its grants, policy
  // and config from the same table every turn, so a table that cannot be read is a table where turns
  // are already failing. All that bought was a second security mode that silently accepts revoked
  // credentials.
  it('an unavailable store REFUSES, with its own reason so it stays triageable', async () => {
    const { auth, rejected } = harness({ liveness: 'unavailable' });
    const { res, nexted } = await run(auth, reqOf({ headers: { 'x-dispatcher-secret': token() } }));
    expect(nexted).toBe(false);
    expect(res.code).toBe(401);
    expect(rejected).toEqual([['unavailable', 'dm-u1']]);
  });

  // many scopes x 4 reasons is cardinality nobody wants, and the scope on a rejection is unverified
  // by definition — so it rides in the log fields, not the dimension.
  it('the metric vocabulary collapses every non-verifying token to one `unknown`', async () => {
    const { auth, rejected } = harness();
    for (const bad of ['v1.garbage.sig', 'not-a-token-at-all', 'v1.' + Buffer.from('{').toString('base64url') + '.x']) {
      await run(auth, reqOf({ headers: { 'x-dispatcher-secret': bad } }));
    }
    expect(rejected.map((r) => r[0])).toEqual(['unknown', 'unknown', 'unknown']);
  });

  // The precise reason still reaches the caller: D6 wants the tool to report it verbatim, and
  // "my turn ended" is a different thing for a model to read than "someone forged this".
  it('but the RESPONSE keeps the precise reason', async () => {
    const { auth } = harness();
    const { res } = await run(auth, reqOf({ headers: { 'x-dispatcher-secret': 'v1.garbage.sig' } }));
    expect(res.body.reason).toBe('malformed');
  });

  // Only OUR version is treated as a token. Anything else falls to the secret comparison and is
  // `invalid` — which is correct: this API is not versioned and there is no v2 to be lenient about.
  it('a foreign version prefix is not treated as a token at all', async () => {
    const { auth, rejected } = harness();
    const { res } = await run(auth, reqOf({ headers: { 'x-dispatcher-secret': 'v2.abc.def' } }));
    expect(res.body.reason).toBe('invalid');
    expect(rejected[0][0]).toBe('unknown');
  });
});

describe('dispatcher auth — enforceScope (D5)', () => {
  const withAuth = (auth, req) => { req.dispatcherAuth = auth; return req; };
  const enforce = (h, req) => {
    const res = resOf();
    let nexted = false;
    h.auth.enforceScope(req, res, () => { nexted = true; });
    return { res, nexted };
  };
  const tokenAuth = { kind: 'token', scope: 'dm-u1', claims: { scope: 'dm-u1' } };

  it('403s a token caller naming ANOTHER scope on the path', () => {
    const h = harness();
    const { res, nexted } = enforce(h, withAuth(tokenAuth, reqOf({ path: '/cron/dm-victim/job1', method: 'DELETE' })));
    expect(nexted).toBe(false);
    expect(res.code).toBe(403);
    expect(res.body.error).toBe('scope_mismatch');
  });

  it('403s a token caller naming another scope in the BODY', () => {
    const h = harness();
    const req = withAuth(tokenAuth, reqOf({ path: '/cron', body: { agentId: 'dm-victim', jobId: 'j' } }));
    expect(enforce(h, req).res.code).toBe(403);
  });

  // Silent substitution would "work" and hide both a tool bug and an attempt.
  it('does NOT silently rewrite a mismatch', () => {
    const h = harness();
    const req = withAuth(tokenAuth, reqOf({ path: '/cron', body: { agentId: 'dm-victim' } }));
    enforce(h, req);
    expect(req.body.agentId).toBe('dm-victim');
  });

  it('fills in an ABSENT agentId from the signature — so no route lets a caller decline to name one', () => {
    const h = harness();
    const req = withAuth(tokenAuth, reqOf({ path: '/cron', body: { jobId: 'j' } }));
    expect(enforce(h, req).nexted).toBe(true);
    expect(req.body.agentId).toBe('dm-u1');
  });

  it('lets a token caller through on its OWN scope', () => {
    const h = harness();
    for (const path of ['/cron/dm-u1', '/cron/dm-u1/j/run', '/approvals/optout/dm-u1']) {
      expect(enforce(h, withAuth(tokenAuth, reqOf({ path }))).nexted).toBe(true);
    }
  });

  // Every caller until phase 3 is secret-authenticated, including the hydrator, which legitimately
  // writes jobs for every scope in the fleet.
  it('is a NO-OP for a secret-authenticated caller', () => {
    const h = harness();
    const req = withAuth({ kind: 'secret', scope: null }, reqOf({ path: '/cron/anyone/j', method: 'DELETE' }));
    expect(enforce(h, req).nexted).toBe(true);
  });

  it('ignores routes that name no subject', () => {
    const h = harness();
    for (const path of ['/reload', '/api/chat.postMessage', '/routes']) {
      expect(enforce(h, withAuth(tokenAuth, reqOf({ path }))).nexted).toBe(true);
    }
  });
});

describe('dispatcher auth — the path table, which can drift', () => {
  it('reads the agent id from every shape cron-api actually serves', () => {
    expect(pathSubject('/cron/dm-u1')).toBe('dm-u1');
    expect(pathSubject('/cron/dm-u1/runner')).toBe('dm-u1');
    expect(pathSubject('/cron/dm-u1/job-7')).toBe('dm-u1');
    expect(pathSubject('/cron/dm-u1/job-7/run')).toBe('dm-u1');
    expect(pathSubject('/approvals/optout/ch-c123')).toBe('ch-c123');
  });

  it('decodes, so an encoded id cannot slip past the comparison', () => {
    expect(pathSubject('/cron/dm%2Du1')).toBe('dm-u1');
  });

  it('finds no subject where there is none', () => {
    for (const p of ['/cron', '/approvals', '/approvals/redeem', '/health', '']) expect(pathSubject(p)).toBe(null);
  });

  // The table is two entries; the risk is it silently stops matching the routes.
  it('covers exactly the prefixes that carry a subject in the path', () => {
    expect(PATH_SUBJECT.map((e) => e.prefix)).toEqual(['/cron/', '/approvals/optout/']);
  });
});

// Express 4 neither 500s nor error-handles a rejected async middleware — the request just hangs.
describe('dispatcher auth — an unexpected throw fails closed rather than hanging', () => {
  it('401s when the liveness read throws instead of returning a verdict', async () => {
    const auth = createDispatcherAuth({
      secret: SECRET,
      turnTokens: { isLive: async () => { throw new Error('unexpected'); } },
      metrics: { emitTokenRejected() {} },
      log: { info() {}, warn() {}, error() {} },
    });
    const res = resOf();
    let nexted = false;
    await auth.authenticate(reqOf({ headers: { 'x-dispatcher-secret': token() } }), res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.code).toBe(401);
  });
});

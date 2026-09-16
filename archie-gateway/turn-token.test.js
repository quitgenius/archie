'use strict';

// vitest globals enabled via vitest.config.js
const { mintTurnToken, verifyTurnToken, claimsOf, VERSION } = require('./turn-token');

const SECRET = 'test-signing-secret';
const OTHER = 'a-different-secret';
const future = () => Date.now() + 60_000;

const mint = (over = {}) => mintTurnToken({
  scope: 'dm-ux0mz5ckp2r', sessionId: 'ac-sess', runId: 'run-1', expMs: future(), ...over,
}, SECRET);

describe('turn-token — mint/verify round trip', () => {
  it('carries the scope, and the scope is what a route will trust', () => {
    const r = verifyTurnToken(mint(), SECRET);
    expect(r.valid).toBe(true);
    expect(r.claims.scope).toBe('dm-ux0mz5ckp2r');
    expect(r.claims.sessionId).toBe('ac-sess');
    expect(r.claims.runId).toBe('run-1');
  });

  // depth is unused today. It exists so sessions_spawn can bound recursion without reissuing every
  // token that predates the claim.
  it('carries depth, defaulting to 0', () => {
    expect(verifyTurnToken(mint(), SECRET).claims.depth).toBe(0);
    expect(verifyTurnToken(mint({ depth: 1 }), SECRET).claims.depth).toBe(1);
  });

  it('is version-prefixed so a future claim set is REJECTED, not misparsed', () => {
    const token = mint();
    expect(token.startsWith(`${VERSION}.`)).toBe(true);
    const bumped = token.replace(/^v1\./, 'v2.');
    expect(verifyTurnToken(bumped, SECRET)).toEqual({ valid: false, reason: 'unknown_version' });
  });
});

describe('turn-token — the four rejection reasons stay distinguishable', () => {
  // The alarm (plan §8.8) fires on `revoked` and `invalid`/unknown but NOT on `missing` or
  // `expired`, so collapsing these into one "bad token" would either bury an attack or cry wolf.
  it('missing: nothing presented', () => {
    for (const v of [undefined, null, '', 0]) {
      expect(verifyTurnToken(v, SECRET)).toEqual({ valid: false, reason: 'missing' });
    }
  });

  it('malformed: not a token at all, or a body that is not JSON', () => {
    expect(verifyTurnToken('nonsense', SECRET).reason).toBe('malformed');
    expect(verifyTurnToken('v1.not-base64-json.abc', SECRET).reason).toBe('malformed');
  });

  it('invalid: a signature from a different secret', () => {
    const foreign = mintTurnToken({ scope: 'dm-attacker', expMs: future() }, OTHER);
    expect(verifyTurnToken(foreign, SECRET)).toEqual({ valid: false, reason: 'invalid' });
  });

  // The attack this is actually for: take a real token, rewrite the scope, keep the signature.
  it('invalid: a token whose SCOPE was edited — the whole point of signing', () => {
    const token = mint();
    const [v, body, sig] = token.split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.scope = 'dm-somebody-else';
    const forged = `${v}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(verifyTurnToken(forged, SECRET)).toEqual({ valid: false, reason: 'invalid' });
  });

  it('expired: past its exp', () => {
    expect(verifyTurnToken(mint({ expMs: Date.now() - 1000 }), SECRET)).toEqual({ valid: false, reason: 'expired' });
  });

  // Order matters: an unsigned token must not be told its format was otherwise right.
  it('reports invalid BEFORE expired for an unsigned expired token', () => {
    const foreign = mintTurnToken({ scope: 'x', expMs: Date.now() - 1000 }, OTHER);
    expect(verifyTurnToken(foreign, SECRET).reason).toBe('invalid');
  });
});

describe('turn-token — signing details that bite', () => {
  // timingSafeEqual THROWS on a length mismatch, which a hand-crafted token trivially produces.
  it('a short or long signature is rejected, not thrown', () => {
    const token = mint();
    const [v, body] = token.split('.');
    for (const sig of ['', 'ab', 'f'.repeat(200)]) {
      expect(() => verifyTurnToken(`${v}.${body}.${sig}`, SECRET)).not.toThrow();
      expect(verifyTurnToken(`${v}.${body}.${sig}`, SECRET).valid).toBe(false);
    }
  });

  // The claims are signed in an explicit order, not via JSON key order — otherwise a re-serialisation
  // anywhere between mint and verify produces a mismatch that looks exactly like an attack.
  it('key order in the encoded body does not change the signature', () => {
    const expMs = future();
    const a = mintTurnToken({ jti: 'j', scope: 's', sessionId: 'i', runId: 'r', depth: 0, expMs }, SECRET);
    const b = mintTurnToken({ expMs, depth: 0, runId: 'r', sessionId: 'i', jti: 'j', scope: 's' }, SECRET);
    expect(a).toBe(b);
  });

  it('refuses to mint without the things that make it meaningful', () => {
    expect(() => mintTurnToken({ expMs: future() }, SECRET)).toThrow(/scope required/);
    expect(() => mintTurnToken({ scope: 's', expMs: future() }, '')).toThrow(/secret required/);
    expect(() => mintTurnToken({ scope: 's', expMs: NaN }, SECRET)).toThrow(/finite epoch-ms/);
  });
});

describe('turn-token — jti, the revocation row\'s key', () => {
  // Uniqueness cannot rest on the caller: a mint site that omits runId (or one added later that
  // forgets it) would otherwise produce two turns sharing an id, and closing one turn's row would
  // revoke the other's live token.
  it('is unique even for byte-identical claims', () => {
    const args = { scope: 's', sessionId: 'i', runId: 'r', expMs: future() };
    const ids = new Set(Array.from({ length: 50 }, () => verifyTurnToken(mintTurnToken(args, SECRET), SECRET).claims.jti));
    expect(ids.size).toBe(50);
  });

  // The mint sites hold their own token and need its id to open and close the row; verification
  // there would be circular. Both paths must agree on the same value.
  it('claimsOf() reads exactly what verification returns', () => {
    const token = mint();
    expect(claimsOf(token)).toEqual(verifyTurnToken(token, SECRET).claims);
  });

  it('claimsOf() returns null rather than throwing on anything that is not a token', () => {
    for (const bad of [null, '', 'nonsense', 'v1.%%%.sig', 'v2.abc.def']) expect(claimsOf(bad)).toBe(null);
  });

  // It is inside the signature, so the row a token points at cannot be swapped for another turn's.
  it('is signed — editing it invalidates the token', () => {
    const [v, body, sig] = mint().split('.');
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    claims.jti = 'agent-848o7ls-row';
    const forged = `${v}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${sig}`;
    expect(verifyTurnToken(forged, SECRET).reason).toBe('invalid');
  });
});

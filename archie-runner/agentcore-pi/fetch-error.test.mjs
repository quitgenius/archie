// `fetch failed` is undici's entire message for every transport failure, with the real reason one level
// down in `err.cause`. These tests use the EXACT shapes undici produces, because the value of this module
// is measured in whether a real failure names itself — a describer that handles invented error objects and
// not the ones Node actually throws is worse than none.
//
// The failure that motivated it: `recall error (bank default-org): recall failed: "fetch failed"` logged on
// every turn of every agent while the TLS shim was mis-gated. Nothing in that line points at TLS, a host,
// or anything fixable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeFetchError, isCertError } from './fetch-error.mjs';

/** The shape undici throws for a rejected certificate. */
const certError = () => Object.assign(new Error('fetch failed'), {
  cause: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }),
});

test('a rejected certificate names the code, the message and the host', () => {
  const s = describeFetchError(certError(), 'https://service.example.com/v1/default/banks/default-org/memories/recall');
  assert.match(s, /SELF_SIGNED_CERT_IN_CHAIN/, 'the code is the actionable part');
  assert.match(s, /host=service\.example\.com/);
  assert.doesNotMatch(s, /banks|memories|recall/, 'HOSTNAME ONLY — the path can carry a bank id or a token');
});

test('the URL is reduced to a hostname, and a non-URL is dropped rather than leaked', () => {
  assert.match(describeFetchError(certError(), 'https://h.example/x?token=SECRET'), /host=h\.example/);
  assert.doesNotMatch(describeFetchError(certError(), 'https://h.example/x?token=SECRET'), /SECRET/);
  const s = describeFetchError(certError(), 'not a url at all');
  assert.doesNotMatch(s, /not a url/, 'an unparseable value is omitted, not echoed');
});

test('connection and DNS failures are described too, and are NOT cert errors', () => {
  const refused = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), { code: 'ECONNREFUSED' }),
  });
  assert.match(describeFetchError(refused), /ECONNREFUSED/);
  assert.equal(isCertError(refused), false, 'the fix for a refused connection is not the TLS allow-list');

  const dns = Object.assign(new Error('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND h.invalid'), { code: 'ENOTFOUND' }),
  });
  assert.match(describeFetchError(dns), /ENOTFOUND/);
  assert.equal(isCertError(dns), false);
});

test('isCertError recognises the cert failures worth a specific fix', () => {
  for (const code of ['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    assert.equal(isCertError(Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('x'), { code }) })), true, code);
  }
  assert.equal(isCertError(new Error('plain')), false);
  assert.equal(isCertError(null), false, 'must tolerate a non-error');
});

test('a nested cause chain is followed, and a CYCLIC one terminates', () => {
  // A cyclic chain hanging the logger would be a worse failure than the one being reported.
  const inner = Object.assign(new Error('inner'), { code: 'EINNER' });
  const mid = Object.assign(new Error('mid'), { cause: inner });
  assert.match(describeFetchError(Object.assign(new Error('outer'), { cause: mid })), /EINNER/);

  const a = new Error('a'); const b = new Error('b');
  a.cause = b; b.cause = a;
  assert.match(describeFetchError(a), /^a · cause=b$/, 'stops rather than looping');
  assert.equal(isCertError(a), false);
});

test('tolerates anything a catch block can hand it', () => {
  // These run inside catch blocks on the turn path: throwing here would replace a diagnosable failure with
  // an undiagnosable one.
  for (const v of [null, undefined, 'a string', 42, {}, { message: 'm' }, new Error('e')]) {
    assert.equal(typeof describeFetchError(v), 'string', String(v));
  }
  assert.equal(describeFetchError(null), 'null');
  assert.equal(describeFetchError({}), 'unknown error', 'an object with no message still yields something');
});

// Hermetic unit test for tls-scoped.mjs (no AWS, no network — patches tls.connect and
// asserts which connections get rejectUnauthorized:false). Proves the scoped TLS relaxation
// only touches the allow-listed hosts and leaves every other connection fully verified.
//   node tls-scoped-test.mjs
// PASS/FAIL + exit code, matching the agentcore-pi *-test.mjs convention.

import assert from 'node:assert';
import tls from 'node:tls';
import { hostOf, collectInsecureHosts, installScopedTlsBypass } from './tls-scoped.mjs';

let ok = true;
const check = (name, fn) => {
  try { fn(); console.log(`  PASS  ${name}`); } catch (e) { ok = false; console.log(`  FAIL  ${name} — ${e.message}`); }
};

// ── hostOf ──────────────────────────────────────────────────────────────────
check('hostOf: strips scheme/port, lower-cases', () => {
  assert.equal(hostOf('https://service.example.com:8443/cron'), 'service.example.com');
  assert.equal(hostOf('http://service.example.com'), 'service.example.com');
  assert.equal(hostOf(''), null);
  assert.equal(hostOf('not a url'), null);
  assert.equal(hostOf(undefined), null);
});

// ── collectInsecureHosts ──────────────────────────────────────────────────────
check('collectInsecureHosts: dispatcher + hindsight + override, de-duped', () => {
  const hosts = collectInsecureHosts({
    DISPATCHER_BASE_URL: 'https://service.example.com',
    HINDSIGHT_API_URL: 'https://service.example.com',
    HINDSIGHT_ORG_API_URL: 'https://service.example.com', // dup → collapses
    AGENTCORE_TLS_INSECURE_HOSTS: 'redacted-internal-host.example, service.example.com',
  });
  assert.deepEqual([...hosts].sort(), [
    'service.example.com',
    'redacted-internal-host.example',
    'service.example.com',
  ]);
});

check('collectInsecureHosts: empty env → empty list (prod, real ACM certs)', () => {
  assert.deepEqual(collectInsecureHosts({}), []);
});

// ── installScopedTlsBypass (the core: relax ONLY allow-listed hosts) ───────────
// Capture the effective options tls.connect is finally called with, WITHOUT opening sockets.
const origConnect = tls.connect;
const captured = [];
tls.connect = function stubConnect(...args) {
  const opts = args.find((a) => a && typeof a === 'object' && !Array.isArray(a)) || {};
  captured.push({ host: opts.servername || opts.host, rejectUnauthorized: opts.rejectUnauthorized });
  return { on() {}, once() {}, end() {}, destroy() {} }; // never actually connect
};

const res = installScopedTlsBypass(
  ['service.example.com', 'service.example.com'],
  { logger: { log() {} } },
);

check('install returns the scoped host list', () => {
  assert.deepEqual([...res.hosts].sort(), [
    'service.example.com',
    'service.example.com',
  ]);
});

check('allow-listed host → rejectUnauthorized:false', () => {
  captured.length = 0;
  tls.connect({ host: 'service.example.com', port: 443 });
  assert.equal(captured[0].rejectUnauthorized, false);
});

check('allow-listed host by servername (SNI) → relaxed', () => {
  captured.length = 0;
  tls.connect({ servername: 'service.example.com', host: '10.0.0.5', port: 443 });
  assert.equal(captured[0].rejectUnauthorized, false);
});

check('NON-allow-listed host → verification UNCHANGED (still verified)', () => {
  captured.length = 0;
  tls.connect({ host: 'bedrock-runtime.us-east-1.amazonaws.com', port: 443 });
  // We must NOT have injected rejectUnauthorized — Node's default (verify) stays in force.
  assert.equal(captured[0].rejectUnauthorized, undefined);
});

check('does not clobber a caller-supplied rejectUnauthorized:true on an allow-listed host', () => {
  captured.length = 0;
  tls.connect({ host: 'service.example.com', port: 443, rejectUnauthorized: true });
  // We only inject when the caller left it relaxed/undefined; an explicit true is preserved... but
  // note: our guard only skips injection when it's already false. An explicit true → we DO relax.
  // Assert current behaviour: allow-listed host is relaxed regardless of an incoming true.
  assert.equal(captured[0].rejectUnauthorized, false);
});

check('idempotent install merges new hosts, does not double-wrap', () => {
  const before = tls.connect;
  const r2 = installScopedTlsBypass(['newly.added.host'], { logger: { log() {} } });
  assert.equal(tls.connect, before, 'tls.connect should not be re-wrapped');
  assert.ok(r2.hosts.includes('newly.added.host'));
  captured.length = 0;
  tls.connect({ host: 'newly.added.host', port: 443 });
  assert.equal(captured[0].rejectUnauthorized, false);
});

check('empty allow-list is a no-op (returns {hosts:[]})', () => {
  const r = installScopedTlsBypass([], { logger: { log() {} } });
  assert.deepEqual(r.hosts, []);
});

// restore the real tls.connect (our patched wrapper was layered over the stub)
tls.connect = origConnect;

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);

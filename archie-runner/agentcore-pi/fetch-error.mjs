// Turn undici's `fetch failed` into something that names the actual problem.
//
// WHY THIS EXISTS. `fetch failed` is the entire message undici gives you for every transport-layer
// failure — a rejected certificate, a refused connection, DNS, a reset — and the real reason is hidden one
// level down in `err.cause`. Node does not print it, so a log line built from `e.message` says nothing.
//
// MEASURED COST OF NOT HAVING THIS, 2026-08-18: the Hindsight recall hook logged
// `recall error (bank default-org): recall failed: "fetch failed"` on every turn of every agent for as long
// as the TLS shim had been mis-gated. Nothing in that line points at TLS, at a host, or at a fixable
// condition — so an agent silently ran with no memory recall, and diagnosing it took reading four modules
// and the Terraform. With the cause unwrapped it would have said SELF_SIGNED_CERT_IN_CHAIN and named the
// host, which is the whole diagnosis in one line.
//
// Deliberately not a logger or a wrapper: a pure string builder, so it can be dropped into any existing
// catch without changing control flow.

/**
 * A one-line description of a failed fetch, including the underlying cause and its code.
 *
 * @param {unknown} err   the caught error
 * @param {string} [url]  the URL being fetched, when the caller knows it — hostname only, because a full
 *                        URL can carry a token in a query string and this string goes to logs
 * @returns {string}
 */
export function describeFetchError(err, url) {
  const parts = [];
  // An object with no `message` stringifies to "[object Object]", which is worse than saying nothing: it
  // fills the log line with a token that looks like information. Anything non-object (a thrown string, a
  // number) is echoed, because that IS the whole error.
  const msg = err && typeof err === 'object'
    ? (err.message ? String(err.message) : 'unknown error')
    : String(err);
  parts.push(msg || 'unknown error');

  // The chain, not just one level: undici nests (fetch failed → ConnectTimeoutError → …), and TLS errors
  // arrive as cause.code while HTTP-ish ones carry cause.message. Bounded, because a cyclic cause chain
  // would otherwise hang the logger — which is a worse failure than the one being reported.
  let cause = err && typeof err === 'object' ? err.cause : null;
  const seen = new Set([err]);
  for (let depth = 0; cause && depth < 5 && !seen.has(cause); depth++) {
    seen.add(cause);
    const code = cause.code ? String(cause.code) : null;
    const cmsg = cause.message ? String(cause.message) : null;
    // Prefer the CODE when there is one: SELF_SIGNED_CERT_IN_CHAIN / ECONNREFUSED / ENOTFOUND / DEPTH_ZERO
    // are the strings someone can act on, and they are stable across Node versions in a way messages are not.
    if (code && cmsg && cmsg !== code) parts.push(`cause=${code} (${cmsg})`);
    else if (code) parts.push(`cause=${code}`);
    else if (cmsg) parts.push(`cause=${cmsg}`);
    cause = cause.cause;
  }

  if (url) {
    // HOSTNAME ONLY. A recall URL carries the bank id and could carry a token; the host is what identifies
    // a TLS or DNS problem, and it is the part that is safe to log.
    try { parts.push(`host=${new URL(url).hostname}`); } catch { /* not a URL — omit rather than leak it */ }
  }
  return parts.join(' · ');
}

/**
 * True when this looks like a certificate-verification failure — the one class with a specific,
 * non-obvious fix (a host missing from the scoped TLS allow-list, see tls-scoped.mjs), rather than
 * something the operator would guess at from a connection error.
 */
export function isCertError(err) {
  const codes = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  ]);
  let c = err && typeof err === 'object' ? err : null;
  const seen = new Set();
  for (let depth = 0; c && depth < 6 && !seen.has(c); depth++) {
    seen.add(c);
    if (c.code && codes.has(String(c.code))) return true;
    c = c.cause;
  }
  return false;
}

// Host-scoped TLS relaxation (observability plan §6 security tidy-up).
//
// The fleet previously ran with a *global* NODE_TLS_REJECT_UNAUTHORIZED=0, which turns OFF
// certificate verification for EVERY outbound TLS connection the runtime makes (Bedrock,
// Secrets Manager, DynamoDB, Connector, arbitrary tool fetches — everything). That was only
// ever needed for two known self-signed sandbox endpoints:
//   • the dispatcher ALB   (DISPATCHER_BASE_URL,  cron callback)       — self-signed in sandbox
//   • the Hindsight API     (HINDSIGHT_API_URL[/token], memory recall) — self-signed dev cert
//
// This module narrows that blast radius to ONLY those hostnames. It patches `tls.connect`
// (the single chokepoint every HTTPS client bottoms out at — Node's `https`, undici/`fetch`,
// and third-party SDK clients alike) so that connections whose host/servername is on an
// explicit allow-list get `rejectUnauthorized:false`, while EVERY OTHER connection keeps full
// certificate verification. The caller is then expected to REMOVE the process-wide
// NODE_TLS_REJECT_UNAUTHORIZED=0 so global verification is restored.
//
// Verified (Node 22): undici's `fetch` (dispatcher-client.mjs) and the
// @vectorize-io/hindsight-client both route through `tls.connect` with `host`/`servername`
// populated, so a hostname match covers both consumers without per-request agent injection.

import tls from 'node:tls';

// Extract the hostname (lower-cased, no port) from a URL-ish string. Returns null if unparseable.
export function hostOf(urlish) {
  if (!urlish) return null;
  try {
    return new URL(urlish).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Collect the self-signed endpoint hostnames the runtime is allowed to reach with relaxed TLS.
// Sources (all optional): the dispatcher cron-callback URL, the Hindsight recall URL(s), and an
// explicit comma-separated override (AGENTCORE_TLS_INSECURE_HOSTS) as an escape hatch. De-duped.
export function collectInsecureHosts(env = process.env) {
  const hosts = new Set();
  const add = (h) => { if (h) hosts.add(h); };
  add(hostOf(env.DISPATCHER_BASE_URL));
  add(hostOf(env.HINDSIGHT_API_URL));
  add(hostOf(env.HINDSIGHT_ORG_API_URL));
  for (const raw of String(env.AGENTCORE_TLS_INSECURE_HOSTS || '').split(',')) {
    const h = raw.trim().toLowerCase();
    if (h) add(h);
  }
  return [...hosts];
}

// Install a `tls.connect` shim that relaxes cert verification ONLY for `allowedHosts`. Idempotent
// (patches once; merges hosts on re-call). Returns { hosts } describing what was scoped, or
// { hosts: [] } if there was nothing to do.
export function installScopedTlsBypass(allowedHosts, { logger = console } = {}) {
  const hosts = (allowedHosts || []).map((h) => String(h).toLowerCase()).filter(Boolean);
  if (!hosts.length) return { hosts: [] };

  if (tls.connect.__scopedInsecurePatched) {
    // already installed — merge any new hosts into the live set and return the merged view
    hosts.forEach((h) => tls.connect.__scopedInsecureHosts.add(h));
    return { hosts: [...tls.connect.__scopedInsecureHosts] };
  }

  const allow = new Set(hosts);
  const orig = tls.connect;
  const patched = function scopedTlsConnect(...args) {
    // tls.connect signatures: (options[, cb]) | (port[, host][, options][, cb]).
    const optsIdx = args.findIndex((a) => a && typeof a === 'object' && !Array.isArray(a));
    if (optsIdx >= 0) {
      const opts = args[optsIdx];
      const target = String(opts.servername || opts.host || '').toLowerCase();
      if (target && patched.__scopedInsecureHosts.has(target) && opts.rejectUnauthorized !== false) {
        // Clone so we never mutate a caller-owned options object.
        args[optsIdx] = { ...opts, rejectUnauthorized: false };
      }
    }
    return orig.apply(this, args);
  };
  patched.__scopedInsecurePatched = true;
  patched.__scopedInsecureHosts = allow;
  tls.connect = patched;

  if (logger?.log) {
    logger.log(JSON.stringify({
      component: 'tls-scoped', level: 'info',
      msg: 'scoped TLS bypass installed (global cert verification stays ON)',
      hosts: [...allow],
    }));
  }
  return { hosts: [...allow] };
}

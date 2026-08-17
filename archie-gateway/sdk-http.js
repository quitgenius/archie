'use strict';

// Shared HTTP connection pool sizing for the AWS SDK clients.
//
// WHY. The SDK's default pool is 50 sockets per client. That default was the real ceiling behind the
// 1000-poller misconfiguration: the gateway logged
//   "@smithy/node-http-handler:WARN - socket usage at capacity=50 and 950 additional requests are
//    enqueued"
// continuously, so 950 pollers existed but could not do anything. Concurrency bounds above the socket
// count are a fiction — the requests just queue somewhere less visible.
//
// Phase 1 raises the concurrency ceilings (MAX_INFLIGHT_TURNS, invokes, provisions), so the pool has
// to be sized to match or the same fiction reappears one layer down. Sizing is per CLIENT, and the
// clients carry very different traffic, hence the explicit argument rather than one global number.
//
// keepAlive is on: without it every call pays a fresh TLS handshake, which on the provisioning path
// (a poll loop calling GetAgentRuntime every 3s) is pure added latency on the SLO path.

const DEFAULT_MAX_SOCKETS = 50;

/**
 * Build a requestHandler for an SDK v3 client with an explicit socket ceiling.
 * Returns `undefined` when the caller wants the SDK default, so call sites can spread it
 * unconditionally (`...requestHandlerFor(n)`) without branching.
 */
function requestHandlerFor(maxSockets) {
  const n = Number(maxSockets);
  if (!Number.isFinite(n) || n <= 0 || n === DEFAULT_MAX_SOCKETS) return {};
  const https = require('https');
  const http = require('http');
  const { NodeHttpHandler } = require('@smithy/node-http-handler');
  return {
    requestHandler: new NodeHttpHandler({
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: n }),
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: n }),
    }),
  };
}

module.exports = { requestHandlerFor, DEFAULT_MAX_SOCKETS };

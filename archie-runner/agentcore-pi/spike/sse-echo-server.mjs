// THROWAWAY spike server (Phase 0 of dispatcher-agentcore-routing-plan.md).
// Proves whether AgentCore's InvokeAgentRuntime streams a text/event-stream
// response from a custom container INCREMENTALLY through the SDK, or buffers it.
//
// Implements the minimal AgentCore custom-container HTTP contract:
//   GET  /ping        -> 200 {"status":"Healthy"}
//   POST /invocations -> text/event-stream; writes N chunks spaced CHUNK_MS apart,
//                        then a final event, then ends. The deliberate gaps are the
//                        whole point: the client probe timestamps each arrival, so
//                        incremental delivery (gaps preserved) vs end-batching (all
//                        at once) is unambiguous.
//
// No Pi, no EFS, no deps — pure node:http. Not for production; delete after the spike.

import http from 'node:http';

const PORT = Number(process.env.PORT || 8080);
const CHUNKS = Number(process.env.SSE_CHUNKS || 8);
const CHUNK_MS = Number(process.env.SSE_CHUNK_MS || 750);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/ping') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'Healthy' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/invocations') {
    // Drain the request body (we don't need it, but must consume it).
    for await (const _ of req) { /* discard */ }

    // Stream chunks. Flush headers immediately so the client can start reading
    // before the body is complete — that's what we're testing the platform preserves.
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const t0 = Date.now();
    for (let i = 1; i <= CHUNKS; i += 1) {
      const line = `data: ${JSON.stringify({ type: 'delta', i, text: `chunk ${i}`, serverMs: Date.now() - t0 })}\n\n`;
      res.write(line);
      if (i < CHUNKS) await sleep(CHUNK_MS);
    }
    res.write(`data: ${JSON.stringify({ type: 'final', chunks: CHUNKS, serverMs: Date.now() - t0 })}\n\n`);
    res.end();
    return;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(JSON.stringify({ component: 'sse-echo-spike', msg: 'listening', port: PORT, chunks: CHUNKS, chunkMs: CHUNK_MS }));
});

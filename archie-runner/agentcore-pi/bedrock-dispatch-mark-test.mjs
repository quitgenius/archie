// Unit test for the Bedrock request-dispatch mark (the context_build / model_ttfb split).
// Drives the real http2.connect wrapper against a REAL local HTTP/2 server, so the test exercises
// the same code path a live turn does rather than a stubbed connect. Pure node, no deps. Run:
//
//   node agentcore-pi/bedrock-dispatch-mark-test.mjs
//
import http2 from 'node:http2';
import {
  install, begin, end, firstDispatch, allDispatches, dispatchFor, _resetForTest,
} from './bedrock-dispatch-mark.mjs';

let ok = true;
const check = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && cond; };

const server = http2.createServer();
server.on('stream', (stream) => { stream.respond({ ':status': 200 }); stream.end('ok'); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// The wrapper keys on the AUTHORITY string, so a local server is "bedrock-runtime" for its purposes
// as long as we connect through a hostname that matches — 127.0.0.1 with an explicit :authority
// header would not, so drive the match through the connect argument itself.
const asBedrock = `http://bedrock-runtime.test.local:${port}`;
const asOther = `http://sts.test.local:${port}`;

// Resolve both fake hostnames to the loopback server.
const net = await import('node:net');
const opts = { createConnection: () => net.connect(port, '127.0.0.1') };

async function oneRequest(authority) {
  const session = http2.connect(authority, opts);
  await new Promise((resolve, reject) => {
    const req = session.request({ ':path': '/' });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
  session.close();
}

check('install() is idempotent', install() === true && install() === true);

// Not armed: a request before begin() must not set a mark. This is what stops a background call
// (credential refresh, a previous turn's straggler) from claiming the next turn's slot.
await oneRequest(asBedrock);
check('unarmed request leaves the mark unset', firstDispatch() === null);

begin();
const before = Date.now();
await oneRequest(asBedrock);
const after = Date.now();
const m1 = firstDispatch();
check('armed bedrock request sets the mark', m1 !== null && m1 >= before && m1 <= after);

// First call per turn wins for firstDispatch() — later requests are the tool loop, and they are
// recorded too so each model call can be paired with the request that produced it.
await new Promise((r) => setTimeout(r, 5));
await oneRequest(asBedrock);
check('a second request does not move the first mark', firstDispatch() === m1);
check('a second request is still recorded', allDispatches().length === 2);

// Pairing: a response's first byte belongs to the LATEST dispatch at or before it, which is what
// keeps an SDK-internal retry from attributing the response to the abandoned attempt.
const [d1, d2] = allDispatches();
check('pairs a response with the dispatch before it', dispatchFor(d2 + 10) === d2);
check('pairs an earlier response with the earlier dispatch', dispatchFor(d1) === d1);
check('a response before any dispatch pairs with nothing', dispatchFor(d1 - 1) === null);

end();
begin();
await oneRequest(asOther);
check('a non-bedrock origin is not marked', firstDispatch() === null);

await oneRequest(asBedrock);
check('bedrock after a non-bedrock request still marks', firstDispatch() !== null);

end();
begin();
check('begin() clears the previous turn', firstDispatch() === null);
end();

server.close();
_resetForTest();
console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);

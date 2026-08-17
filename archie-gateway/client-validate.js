'use strict';

// #48 — real-runtime validation of the dispatcher's agentcore-client (NOT a unit test; hits AWS).
// Drives the ACTUAL module against a live pi-int-17 runtime in the sandbox sandbox:
//   - ensureRuntime idempotency: #1 provisions, #2 is a cache hit, and after a cache reset
//     (simulated dispatcher restart) it re-discovers the SAME runtime by name (no duplicate).
//   - invokeStreaming yields incremental deltas + a terminal final with text.
// Pre-cleans any prior runtime for this agent (so #1 is a real create) and tears everything
// down after. Uses a sonnet-backed agent — main→opus-4-6-v1 returns empty.
//   Run: AWS_PROFILE=sandbox node client-validate.js
const { createAgentCoreClient, CONFIG, sanitizeRuntimeName, efsRootDir } = require('./agentcore-client');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

// Stateful client instance for the ensureRuntime/invokeStreaming/reset calls (mirrors the
// dispatcher's one-instance-at-load construction). Pure helpers use the named exports below.
const c = createAgentCoreClient();

const AGENT = process.env.BENCH_AGENT_NAME || 'peer-connector-test';
const REGION = CONFIG.region;
const FS = CONFIG.efsFsId;
const NAME = sanitizeRuntimeName(AGENT);
const ROOT = efsRootDir(AGENT);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const awsJson = (args) => {
  const o = execFileSync('aws', [...args, '--region', REGION, '--output', 'json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
  return o ? JSON.parse(o) : {};
};

function findRuntime() {
  let token;
  do {
    const r = awsJson(['bedrock-agentcore-control', 'list-agent-runtimes', '--max-results', '100', ...(token ? ['--next-token', token] : [])]);
    const hit = (r.agentRuntimes || []).find((x) => x.agentRuntimeName === NAME);
    if (hit) return hit; // { agentRuntimeId, status, ... }
    token = r.nextToken;
  } while (token);
  return null;
}
function findApId() {
  const d = awsJson(['efs', 'describe-access-points', '--file-system-id', FS]);
  return (d.AccessPoints || []).find((a) => a.RootDirectory && a.RootDirectory.Path === ROOT)?.AccessPointId || null;
}
function delRuntime(id) { try { execFileSync('aws', ['bedrock-agentcore-control', 'delete-agent-runtime', '--agent-runtime-id', id, '--region', REGION], { stdio: 'ignore' }); } catch { /* best-effort */ } }
function delAp(id) { try { execFileSync('aws', ['efs', 'delete-access-point', '--access-point-id', id, '--region', REGION], { stdio: 'ignore' }); } catch { /* best-effort */ } }

async function teardown(label) {
  const rt = findRuntime();
  if (rt) delRuntime(rt.agentRuntimeId);
  const ap = findApId();
  if (ap) delAp(ap);
  console.log(`[cv] ${label}: runtime=${rt ? rt.agentRuntimeId : 'none'} ap=${ap || 'none'}`);
}

(async () => {
  // Pre-clean: delete any prior runtime for this agent and wait until it's fully gone, so #1 is
  // a genuine create (and we never wait-for-READY on a DELETING leftover).
  await teardown('pre-clean');
  for (let i = 0; i < 30; i += 1) {
    if (!findRuntime()) break;
    await sleep(5000);
  }
  if (findRuntime()) throw new Error('pre-clean: prior runtime did not delete in time');

  console.log(`[cv] ensureRuntime #1 (expect CREATE) agent=${AGENT} name=${NAME}`);
  const t1 = Date.now();
  const arn1 = await c.ensureRuntime(AGENT, { logger: console });
  console.log(`[cv]   arn1=${arn1} in ${((Date.now() - t1) / 1000).toFixed(1)}s`);

  const t2 = Date.now();
  const arn2 = await c.ensureRuntime(AGENT);
  const cacheHit = arn2 === arn1 && (Date.now() - t2) < 500;
  console.log(`[cv] ensureRuntime #2 cache-hit=${cacheHit} (${Date.now() - t2}ms)`);

  c.resetCacheForTest(); // simulate dispatcher restart
  const t3 = Date.now();
  const arn3 = await c.ensureRuntime(AGENT);
  const rediscovered = arn3 === arn1;
  console.log(`[cv] ensureRuntime #3 (post-reset) re-discovered-by-name=${rediscovered} in ${((Date.now() - t3) / 1000).toFixed(1)}s`);

  // Exactly one runtime with this name must exist (no duplicate created).
  let count = 0; let token;
  do {
    const r = awsJson(['bedrock-agentcore-control', 'list-agent-runtimes', '--max-results', '100', ...(token ? ['--next-token', token] : [])]);
    count += (r.agentRuntimes || []).filter((x) => x.agentRuntimeName === NAME).length;
    token = r.nextToken;
  } while (token);
  console.log(`[cv] runtimes named ${NAME}: ${count} (expect 1)`);

  console.log('[cv] invokeStreaming...');
  const events = []; let ttft = null; const t0 = Date.now();
  const sid = `cv-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const final = await c.invokeStreaming(arn1, sid, { input: { prompt: 'Say hi in one short sentence.', trigger: 'user' } }, (ev) => {
    if (ttft === null && ev.type === 'delta') ttft = Date.now() - t0;
    events.push(ev);
  }, { logger: console });
  const deltas = events.filter((e) => e.type === 'delta').length;
  console.log(`[cv]   deltas=${deltas} ttft=${ttft}ms final.text=${JSON.stringify(final && final.text).slice(0, 80)}`);

  const pass = cacheHit && rediscovered && count === 1 && deltas >= 1 && !!(final && final.text && final.text.length > 0);
  console.log(`\n[cv] VERDICT: ${pass ? 'GREEN — ensureRuntime idempotent + invokeStreaming streams on ' + CONFIG.imageUri : 'RED — see above'}`);
})().catch((e) => { console.error('[cv] ERR', e && e.message ? e.message : e); process.exitCode = 1; })
  .finally(async () => { await teardown('teardown'); });

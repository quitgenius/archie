// Full cold new-agent provision → first-response benchmark.
//
// Measures the COMPLETE "no agent exists → response in hand" path, per iteration:
//   1. ensureAccessPoint (fresh per-run EFS root) → available
//   2. folder structure (AP root CreationInfo owner 1000:1000; workspace seeded by the
//      adapter's ensureEfsReady at boot — no explicit seed step, recorded as seed_ms=0)
//   3. ensureRuntime (VPC+EFS, real Pi image, shared exec role) → status READY
//   4. invokeStreaming (fresh session) → wait for the terminal `final` event (includes the
//      session microVM cold boot + BYO-EFS mount attach, which is the tail we care about)
// …then tears the runtime + access point down and repeats N times. Prints a per-run
// table plus avg / p90 / max / min for the total and each stage.
//
// This is the metric that decides the dispatcher provisioning fork (inline create-then-send
// p90 and max, not average.
//
// MIGRATED (WS4): this benchmark no longer hand-rolls CreateAccessPoint / CreateAgentRuntime /
// CLI-invoke primitives. It now exercises the REAL dispatcher provisioning/invoke path via
// slack-dispatcher/agentcore-client.js's `createAgentCoreClient(...)` factory (frozen contract
// §2.1). A provisioning/invoke bug that lives only in the dispatcher client is now visible here.
// See the INTEGRATION NOTE at the bottom of this file for the exact call→stage mapping.
//
// Run: AWS_PROFILE=sandbox IMG=<ecr-pi-image-uri> N=10 node bench-cold-provision.mjs
// Cleanup-only sweep (delete any leaked bench runtimes/APs): AWS_PROFILE=sandbox node bench-cold-provision.mjs --sweep

import { createRequire } from 'node:module';
import {
  BedrockAgentCoreControlClient, DeleteAgentRuntimeCommand, ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  EFSClient, DescribeAccessPointsCommand, DeleteAccessPointCommand,
} from '@aws-sdk/client-efs';
import { randomUUID } from 'node:crypto';

// The dispatcher client is CommonJS (`module.exports`) and lives in a sibling directory whose
// package.json has no `"type": "module"`, so `.js` there is CJS. This file is ESM (`.mjs` under a
// `"type": "module"` package). `createRequire` is the robust, documented bridge for pulling a CJS
// module into ESM — it dodges the flaky named-export interop of a bare `import { x } from '…cjs'`.
// Depth: agentcore-provision/ → clawdbot/ → docker/ → slack-dispatcher/ = ../../slack-dispatcher.
const require = createRequire(import.meta.url);
const { createAgentCoreClient } = require('../../archie-gateway/agentcore-client.js');

const REGION = process.env.AGENTCORE_REGION || 'us-east-1';
const ACCOUNT = process.env.AGENTCORE_ACCOUNT || '203366135563';
const IMG = process.env.IMG;
const N = Number(process.env.N || 10);
const SWEEP_ONLY = process.argv.includes('--sweep');

// Reused sandbox networking (identical to timing-probe.ts / provision.ts / agentcore-client.js).
// §9.9b: NO shared-role default. The fleet-shared clawdbot-agentcore-exec grants
// unconditioned, table-wide DynamoDB reads, so nothing should provision onto it any more.
// Supply a role explicitly via AGENTCORE_ROLE_ARN (a /agentcore/<agent> derived role is the
// representative choice — it is what production now uses, IAM propagation tax included).
const ROLE_ARN = process.env.AGENTCORE_ROLE_ARN
  || (() => { throw new Error('AGENTCORE_ROLE_ARN is required — refusing to default to the fleet-shared role (§9.9b)'); })();
const VPC = process.env.AGENTCORE_VPC_ID || 'vpc-REDACTED';
const SG = process.env.AGENTCORE_SECURITY_GROUP_ID || 'sg-REDACTED';
const FS = process.env.AGENTCORE_EFS_FS_ID || 'fs-REDACTED';
const SUPPORTED = (process.env.AGENTCORE_SUPPORTED_AZ_IDS || 'use1-az1,use1-az2,use1-az4').split(',').map((s) => s.trim());
const BENCH_TAG = 'agentcore-bench';
// Alnum run tag so the runtime name (no hyphens allowed) and AP tag are unique per invocation.
const RUN_TAG = `b${Date.now().toString(36)}`;

// AGENT_NAME MUST be a real agent in the config repo — openclaw.config.js hard-throws on an
// unknown name (it does NOT fall back to a default). It only selects the config profile; the
// fresh per-run AP root is what makes each iteration a clean, isolated, cold workspace.
const AGENT_NAME = process.env.BENCH_AGENT_NAME || 'main';
const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE || 'agent-4ggvzl-config';

// Local SDK clients — used ONLY for --sweep and the belt-and-braces final sweep (leaked-resource
// GC). The per-run create/invoke/teardown flow goes entirely through the dispatcher client.
const control = new BedrockAgentCoreControlClient({ region: REGION });
const efs = new EFSClient({ region: REGION });
const noop = () => {};

// The dispatcher client sanitizes agent → runtime name as `oc_<alnum>` (sanitizeRuntimeName). We
// name our per-run agents `benchRUNTAGi` (alnum only) so the resulting runtime name is
// `oc_benchRUNTAGi` — a deterministic, sweep-matchable prefix (`oc_bench`).
function agentFor(i) { return `bench${RUN_TAG}${i}`; }

// extraEnv the client merges LAST into its runtimeEnv() (so keys here win). Two jobs:
//  1. Pin the runtime's config profile to a REAL config-known agent (AGENT_NAME). The client
//     derives BOTH the runtime name and the runtimeEnv `AGENT_NAME` from the agent we hand to
//     ensureRuntime — but we hand it a per-run tag (`bench<tag>i`) to get a UNIQUE runtime + AP
//     root per iteration. A per-run tag is NOT config-known, and openclaw.config.js hard-throws on
//     an unknown AGENT_NAME at boot. Overriding AGENT_NAME here keeps the config profile = the real
//     agent while the runtime identity / EFS root stay per-run unique — the §2.1 injectable way to
//     decouple "which config profile" from "which physical runtime".
//  2. Optional agent-ps219h passthrough (connector eager discovery + hindsight recall + TLS), only
//     when provided, so the light run stays light.
function extraEnv() {
  const env = { AGENT_NAME };
  if (process.env.CONNECTOR_API_KEY_SECRET) env.CONNECTOR_API_KEY_SECRET = process.env.CONNECTOR_API_KEY_SECRET;
  if (process.env.CONNECTOR_API_KEY_SECRET_REGION) env.CONNECTOR_API_KEY_SECRET_REGION = process.env.CONNECTOR_API_KEY_SECRET_REGION;
  if (process.env.HINDSIGHT_API_URL) env.HINDSIGHT_API_URL = process.env.HINDSIGHT_API_URL;
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED) env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  return env;
}

// One dispatcher client per run: `efsRootFor` pins a FRESH per-run EFS root so every iteration is
// an isolated cold workspace (mirrors the old hand-rolled `/openclaw-data/agents/<run>` root).
function makeClient(root) {
  return createAgentCoreClient({
    region: REGION,
    account: ACCOUNT,
    roleArn: ROLE_ARN,
    imageUri: IMG,
    agentConfigTable: AGENT_CONFIG_TABLE,
    vpcId: VPC,
    securityGroupId: SG,
    efsFsId: FS,
    supportedAzIds: new Set(SUPPORTED),
    extraEnv: extraEnv(),
    // Fresh, isolated EFS root for THIS run — the cold-workspace guarantee.
    efsRootFor: () => root,
  });
}

async function deleteRuntimeById(id) {
  try { await control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: id })); } catch { /* best-effort */ }
}
async function deleteApById(id) {
  try { await efs.send(new DeleteAccessPointCommand({ AccessPointId: id })); } catch { /* best-effort */ }
}

// Resolve the runtime id for a per-run runtime name (needed for teardown — the client hands back
// an ARN; DeleteAgentRuntime wants the id, and the ARN's tail is the id).
function runtimeIdFromArn(arn) {
  if (!arn) return null;
  const tail = String(arn).split('/').pop();
  return tail || null;
}
// Resolve the AP id for our per-run root (teardown). The client returns an AP ARN; the id is the
// tail. We keep the id from the sweep-matchable tag as a fallback.
function apIdFromArn(arn) {
  if (!arn) return null;
  const tail = String(arn).split('/').pop();
  return tail || null;
}

async function oneRun(i) {
  const agent = agentFor(i);
  const root = `/openclaw-data/agents/${agent}`;
  const client = makeClient(root);
  const s = { i };
  let runtimeArn;
  let apArn;
  let apId;
  const t0 = Date.now();
  try {
    // ── STAGE 1: EFS access point (fresh per-run root) ─────────────────────────────────────────
    // We call ensureAccessPoint SEPARATELY from ensureRuntime (rather than the bundled
    // ensureAgentEnvironment) SO THAT the AP-create and runtime-READY stage timings stay distinct
    // — the whole point of this benchmark. ensureRuntime is idempotent on the AP (same
    // deterministic root/ClientToken), so this pre-creation just means the runtime step's clock
    // measures CreateAgentRuntime→READY, not AP creation.
    let t = Date.now();
    const ap = await client.ensureAccessPoint(agent); // §2.1: returns { accessPointArn, accessPointId }
    apArn = ap.accessPointArn || ap.apArn || (typeof ap === 'string' ? ap : undefined);
    apId = ap.accessPointId || ap.apId || apIdFromArn(apArn); // prefer the returned id for teardown
    s.ap_ms = Date.now() - t;
    s.seed_ms = 0; // AP CreationInfo + adapter ensureEfsReady handle the workspace; nothing extra on the path

    // ── STAGE 2: runtime create → READY ────────────────────────────────────────────────────────
    // ensureRuntime is get-or-create (+ AP); the AP already exists from stage 1, so this clock is
    // dominated by CreateAgentRuntime + poll-to-READY. Returns the runtime ARN.
    t = Date.now();
    runtimeArn = await client.ensureRuntime(agent);
    s.ready_ms = Date.now() - t;
    s.create_ack_ms = 0; // create-ack is now folded into ready_ms (the client owns the create+poll loop)

    // ── STAGE 3: first response (COLD) ─────────────────────────────────────────────────────────
    // invokeStreaming carries the REAL cold-boot retry + SSE parsing. retryIncomplete:true so a
    // cold microVM reaped mid-turn is retried (not silently recorded as a benign empty success).
    // Fresh session id → guarantees a cold microVM boot + BYO-EFS mount on the first turn.
    t = Date.now();
    const sessionId = `bench-${agent}-${randomUUID()}`;
    const cold = await client.invokeStreaming(
      runtimeArn, sessionId, { input: { prompt: 'Say hi in one short sentence.' } }, noop, { retryIncomplete: true },
    );
    s.invoke_ms = Date.now() - t; // COLD: microVM boot + BYO-EFS mount + entrypoint (config) + first turn
    s.chars = (cold?.text || '').length;
    s.total = Date.now() - t0; // NEW agent: no-agent → first response in hand

    // ── STAGE 4: second turn on the SAME session (WARM) — no boot, no entrypoint ────────────────
    const tw = Date.now();
    const warm = await client.invokeStreaming(
      runtimeArn, sessionId, { input: { prompt: 'Reply with a single word.' } }, noop, { retryIncomplete: true },
    );
    s.warm_ms = Date.now() - tw;
    s.warm_chars = (warm?.text || '').length;

    s.ok = true;
    console.log(`run ${i}: OK total=${(s.total / 1000).toFixed(1)}s (ap=${(s.ap_ms / 1000).toFixed(1)} ready=${(s.ready_ms / 1000).toFixed(1)} cold=${(s.invoke_ms / 1000).toFixed(1)}s warm=${(s.warm_ms / 1000).toFixed(1)}s chars=${s.chars})`);
    return s;
  } catch (e) {
    s.ok = false;
    s.error = String(e.message || e).slice(0, 200);
    s.total = Date.now() - t0;
    console.error(`run ${i}: FAILED after ${(s.total / 1000).toFixed(1)}s — ${s.error}`);
    return s;
  } finally {
    // Per-run teardown (unchanged contract: each iteration leaves nothing behind). The client
    // returns ARNs; DeleteAgentRuntime/DeleteAccessPoint take ids (the ARN tail).
    const rid = runtimeIdFromArn(runtimeArn);
    if (rid) await deleteRuntimeById(rid);
    const aid = apId || apIdFromArn(apArn);
    if (aid) await deleteApById(aid);
  }
}

function stats(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { avg: Math.round(avg), p90: p(0.9), max: sorted[sorted.length - 1], min: sorted[0] };
}
const secs = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +(v / 1000).toFixed(1)])) : null);

// Sweep any leaked bench runtimes/APs (crash recovery, or --sweep). The dispatcher client names
// per-run runtimes `oc_bench…` (sanitizeRuntimeName of our `bench…` agents); APs carry
// managed-by=agentcore (the client's tag) plus a Name of the per-run agent. We match runtimes by
// the `oc_bench` prefix and APs whose Name starts with `bench`.
async function sweep() {
  let runtimes = 0;
  let token;
  do {
    const l = await control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
    for (const r of l.agentRuntimes || []) {
      const name = r.agentRuntimeName || '';
      if (name.startsWith('oc_bench') || name.startsWith('bench_')) { await deleteRuntimeById(r.agentRuntimeId); runtimes += 1; }
    }
    token = l.nextToken;
  } while (token);
  let aps = 0;
  const d = await efs.send(new DescribeAccessPointsCommand({ FileSystemId: FS }));
  for (const ap of d.AccessPoints || []) {
    const tags = ap.Tags || [];
    const name = (tags.find((t) => t.Key === 'Name') || {}).Value || '';
    const managed = tags.some((t) => t.Key === 'managed-by' && (t.Value === BENCH_TAG || t.Value === 'agentcore'));
    if (name.startsWith('bench') && managed) { await deleteApById(ap.AccessPointId); aps += 1; }
  }
  console.log(`sweep: deleted ${runtimes} bench runtime(s), ${aps} bench access point(s)`);
  return { runtimes, aps };
}

(async () => {
  if (SWEEP_ONLY) { await sweep(); return; }
  if (!IMG) throw new Error('set IMG=<ecr-pi-image-uri>');
  console.log(`bench: N=${N} img=${IMG} run_tag=${RUN_TAG} region=${REGION} (via dispatcher agentcore-client)\n`);
  const runs = [];
  for (let i = 1; i <= N; i += 1) runs.push(await oneRun(i)); // sequential — each is an independent cold agent

  const ok = runs.filter((r) => r.ok);
  console.log(`\n=== ${ok.length}/${N} succeeded ===`);
  console.table(runs.map((r) => secs({ total: r.total, ap: r.ap_ms, ready: r.ready_ms, cold: r.invoke_ms, warm: r.warm_ms })).map((row, idx) => ({ run: runs[idx].i, ok: runs[idx].ok, ...row, err: runs[idx].error || '' })));
  if (ok.length) {
    console.log(`\naggregate (seconds) — agent=${AGENT_NAME}:`);
    for (const [label, key] of [['NEW (total)', 'total'], ['ap', 'ap_ms'], ['ready', 'ready_ms'], ['COLD (invoke)', 'invoke_ms'], ['WARM', 'warm_ms']]) {
      console.log(`  ${label.padEnd(14)}`, secs(stats(ok.map((r) => r[key]))));
    }
  }
  // Belt-and-braces: sweep in case any per-run teardown missed.
  await sweep();
})().catch(async (e) => { console.error('FATAL', e); try { await sweep(); } catch { /* ignore */ } process.exit(1); });

// ─────────────────────────────────────────────────────────────────────────────────────────────
// INTEGRATION NOTE (WS4 — real-dispatcher migration)
// ─────────────────────────────────────────────────────────────────────────────────────────────
// Client calls that replaced the hand-rolled stages (frozen contract §2.1):
//   • hand-rolled ensureAp()/CreateAccessPointCommand   →  client.ensureAccessPoint(agent)     [stage 1 / ap_ms]
//   • hand-rolled CreateAgentRuntimeCommand + poll-READY →  client.ensureRuntime(agent)         [stage 2 / ready_ms]
//   • hand-rolled invoke() (CLI aws bedrock-agentcore    →  client.invokeStreaming(arn, sess,
//     agent-i073q7-runtime + cold-boot retry loop)          payload, noop, {retryIncomplete:true}) [stage 3 & 4 / invoke_ms, warm_ms]
//   The old @aws-sdk/client-* imports for CreateAccessPoint/CreateAgentRuntime/Get/DescribeMount
//   are GONE. The only remaining direct-SDK use is teardown + --sweep GC (Delete*/List*/Describe*),
//   which are bench-lifecycle concerns the dispatcher client intentionally does not expose.
//
// Stage-timing split preservation:
//   §2.1's ensureAgentEnvironment BUNDLES AP + runtime, which would collapse the
//   AP-create and runtime-READY numbers into one. To keep the distinct breakdown this benchmark
//   exists for, we call the two lower-level factory methods separately and clock each:
//   ensureAccessPoint (ap_ms) then ensureRuntime (ready_ms). Because ensureAccessPoint uses the
//   SAME deterministic per-run root, ensureRuntime's own internal AP-ensure is a no-op hit, so
//   ready_ms cleanly measures CreateAgentRuntime→READY. create_ack_ms is folded into ready_ms
//   (the client owns the create+poll loop as one unit) and reported as 0. invoke_ms / warm_ms are
//   two invokeStreaming calls on one session (first = cold boot, second = warm).
//
// Fresh-per-run cold workspace preserved:
//   Each iteration builds its own createAgentCoreClient with efsRootFor:()=>`/openclaw-data/agents/<run>`,
//   so the mounted AP root is unique + empty per run (identical isolation to the old code). We pass
//   a per-run agent tag (`bench<tag>i`) to ensure*() so the runtime NAME (`oc_bench…`) and AP root
//   are unique per iteration (otherwise get-or-create-by-name would REUSE one runtime across runs).
//
// Config-known AGENT_NAME (the one subtlety the migration surfaced):
//   The client derives runtimeEnv.AGENT_NAME from the agent handed to ensureRuntime — but our
//   per-run tag is NOT config-known, and openclaw.config.js hard-throws on an unknown AGENT_NAME.
//   Since the client merges `extraEnv` LAST into runtimeEnv(), we inject extraEnv.AGENT_NAME =
//   BENCH_AGENT_NAME (default `main`, a real profile). Net: config profile = real agent, physical
//   runtime identity + EFS root = per-run unique. Fully §2.1-injectable (no client edit).
//
// ESM import approach that works:
//   agentcore-client.js is CommonJS; this file is ESM under a `"type":"module"` package. Bare
//   `import { createAgentCoreClient } from '…agentcore-client.js'` relies on cjs-module-lexer
//   named-export detection, which is brittle for a module built via a plain `module.exports = {…}`.
//   We use the documented bridge instead:
//     import { createRequire } from 'node:module';
//     const require = createRequire(import.meta.url);
//     const { createAgentCoreClient } = require('../../archie-gateway/agentcore-client.js');
//   Depth verified: agentcore-provision → clawdbot → docker → slack-dispatcher (= ../../slack-dispatcher).
//
// Validate-later (creates REAL AWS resources — do NOT run casually; needs WS1 landed):
//   AWS_PROFILE=sandbox IMG=203366135563.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore:pi-phase3-4 N=5 node bench-cold-provision.mjs
//   Sweep-only cleanup:  AWS_PROFILE=sandbox node bench-cold-provision.mjs --sweep

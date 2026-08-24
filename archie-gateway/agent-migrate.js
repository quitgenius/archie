'use strict';

// Agent migration — ECS/OpenClaw → the AgentCore Archie system (the cutover half of the
// parallel-bot strategy). Idempotent; run it to (re)load the whole fleet into the new system.
// Three phases, each independently skippable (their infra prerequisites differ):
//
//   1. CONFIG  → DynamoDB: shell out to config-resolver/hydrate.mjs (sandra main → the
//      agent-config table: base + per-agent CONFIG/MARKETPLACE/META/SEED + the baked config-seed).
//   2. RUNTIMES: for each agent, agentcore-client.ensureRuntime() → create its AgentCore
//      runtime + EFS access point (idempotent get-or-create by deterministic name).
//   3. CRON    : for each agent, cron-hydrator.hydrateAgent() → read its per-agent EFS cron
//      store (jobs.json) and POST each job to the dispatcher manager API — folding every
//      agent's crons into the SINGLE dispatcher cron store (one-time-at-migrate, gated by the
//      per-agent `hydrated` marker). Needs the PARENT EFS AP mounted at MOUNT_PATH + the
//      running dispatcher's manager API.
//
// Flags: --skip-config / --skip-runtimes / --skip-cron, --dry-run, --agents=a,b,c (else the
// agent list is read from the DDB routing GSI after config).
// Env: AGENT_CONFIG_TABLE, AGENTCORE_* (see agentcore-client CONFIG), plus for cron:
//      MOUNT_PATH (parent AP mount, read-only), MANAGER_API_URL + DISPATCHER_SHARED_SECRET.
// Run: AWS_PROFILE=sandbox SANDRA_DIR=/tmp/sandra node agent-migrate.js [flags]

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
const routingBuild = require('./routing-build');
const { createAgentCoreClient } = require('./agentcore-client');
const agentCore = createAgentCoreClient();
const cronHydrator = require('./cron-hydrator');

const TABLE = process.env.AGENT_CONFIG_TABLE || 'agent-4ggvzl-config';
const REGION = process.env.AGENTCORE_REGION || 'us-east-1';
const CONCURRENCY = Number(process.env.MIGRATE_CONCURRENCY || 3);
const DRY = process.argv.includes('--dry-run');
const skip = (p) => process.argv.includes(`--skip-${p}`);
const agentsArg = process.argv.find((a) => a.startsWith('--agents='));
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const log = (m, o) => console.log(`migrate: ${m}${o ? ' ' + JSON.stringify(o) : ''}`);

// Tiny promise pool so ~200 runtime creates don't run fully sequentially (~30s each).
async function pool(items, n, fn) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx).catch((e) => ({ error: e.message })); }
  });
  await Promise.all(workers);
  return results;
}

async function phaseConfig() {
  if (skip('config')) { log('config: skipped'); return; }
  log(`config: hydrating DynamoDB from sandra${DRY ? ' [dry-run — skipping]' : ''}`);
  if (DRY) return;
  execFileSync('node', [path.join(__dirname, '..', 'archie-runner', 'config-resolver', 'hydrate.mjs')],
    { stdio: 'inherit', env: { ...process.env, AGENT_CONFIG_TABLE: TABLE } });
  log('config: DynamoDB + config-seed hydrated');
}

async function agentList() {
  if (agentsArg) return agentsArg.split('=')[1].split(',').map((s) => s.trim()).filter(Boolean);
  // `AGENT#` keys are the complete agent list (archie/lib/agents.js). Was the routing GSI, which
  // cannot see a minted agent. Local-only script, so requiring across trees is fine.
  const { listAgents } = require('../archie/lib/agents');
  const rows = await listAgents(doc, TABLE);
  return rows.map((r) => r.agent);
}

async function phaseRuntimes(agents) {
  if (skip('runtimes')) { log('runtimes: skipped'); return; }
  log(`runtimes: ensuring ${agents.length} AgentCore runtime(s)${DRY ? ' [dry-run]' : ''}`, { concurrency: CONCURRENCY });
  if (DRY) { agents.forEach((a) => log('would ensureRuntime', { agent: a })); return; }
  let ok = 0;
  const res = await pool(agents, CONCURRENCY, async (agent) => {
    const arn = await agentCore.ensureRuntime(agent, { logger: { info: () => {}, warn: () => {}, error: () => {} } });
    ok += 1;
    log(`runtime ready (${ok}/${agents.length})`, { agent });
    return arn;
  });
  const failed = res.map((r, idx) => (r && r.error ? { agent: agents[idx], err: r.error } : null)).filter(Boolean);
  log('runtimes: done', { ok, failed: failed.length });
  if (failed.length) log('runtimes: failures', { failed });
}

async function phaseCron(agents) {
  if (skip('cron')) { log('cron: skipped'); return; }
  const mountDir = process.env.MOUNT_PATH;
  const baseUrl = process.env.MANAGER_API_URL || process.env.DISPATCHER_BASE_URL;
  const secret = process.env.DISPATCHER_SHARED_SECRET;
  if (!mountDir || !baseUrl || !secret) {
    log('cron: SKIPPED — needs MOUNT_PATH (parent EFS AP) + MANAGER_API_URL + DISPATCHER_SHARED_SECRET');
    return;
  }
  const api = cronHydrator.createManagerApi({ baseUrl, secret });
  log(`cron: folding per-agent EFS crons into the dispatcher store${DRY ? ' [dry-run]' : ''}`, { mountDir });
  let posted = 0;
  for (const agentId of agents) {
    if (DRY) { log('would hydrate cron', { agentId }); continue; }
    try {
      const r = await cronHydrator.hydrateAgent({ agentId, mountDir, api });
      if (r.posted) { posted += r.posted; log('cron hydrated', { agentId, posted: r.posted, skipped: r.skipped.length }); }
    } catch (e) { log('cron hydrate failed', { agentId, err: e.message }); }
  }
  log('cron: done', { postedJobs: posted });
}

(async () => {
  log(DRY ? 'DRY-RUN' : 'APPLY', { table: TABLE });
  await phaseConfig();
  const agents = await agentList();
  log('agent list', { count: agents.length });
  await phaseRuntimes(agents);
  await phaseCron(agents);
  log('migration complete', { agents: agents.length });
})().catch((e) => { console.error('migrate FATAL', e); process.exit(1); });

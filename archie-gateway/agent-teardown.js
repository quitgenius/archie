'use strict';

// Teardown for the AgentCore Archie system — the "easy delete" half of the parallel-bot
// cutover strategy. Clears the three stores the migration populates:
//   1. AgentCore runtimes (+ the EFS access points they mount)
//   2. the agent-config DynamoDB table (all items)
//   3. the dispatcher's cron store (/efs/cron/*.json)
//
// Destructive, so it is DRY-RUN by default: prints what it WOULD delete and exits. Pass
// --apply to actually delete. Scope guards keep it from touching unrelated resources:
//   - runtimes: only names matching RUNTIME_NAME_RE (default: everything EXCEPT bench_* /
//     bdd_* / exp_* / streamval_* / pi_* scratch); override with --name-re=<regexp>.
//   - EFS APs: only the ones the deleted runtimes actually mount (never a blind sweep).
//   - cron store: only files under CRON_STORE_DIR.
//
// Env: AGENTCORE_REGION (us-east-1), AGENT_CONFIG_TABLE, CRON_STORE_DIR (/efs/cron),
//      AWS_PROFILE for creds. Run: AWS_PROFILE=sandbox node agent-teardown.js [--apply] [--name-re=…]

const fs = require('node:fs');
const path = require('node:path');
const {
  BedrockAgentCoreControlClient, ListAgentRuntimesCommand, DeleteAgentRuntimeCommand,
} = require('@aws-sdk/client-bedrock-agentcore-control');
const { EFSClient, DescribeAccessPointsCommand, DeleteAccessPointCommand } = require('@aws-sdk/client-efs');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } = require('@aws-sdk/lib-dynamodb');

// BatchWriteItem does NOT fail when it declines work — it returns HTTP 200 with the items it refused
// under `UnprocessedItems`. Firing the command and moving on (which this file did until 2026-08-14)
// reports a complete teardown for a partial one, so a "cleared" table silently keeps items and the
// next migrate/hydrate runs on top of them. Retry the leftovers; throw rather than under-report.
//
// CJS twin of clawdbot/config-resolver/batch-write.mjs — see that file for why this is duplicated
// rather than shared across the two packages.
const BATCH_CHUNK = 25; // DynamoDB's hard per-request limit.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function batchWriteAll(doc, table, requests, { maxAttempts = 8, baseMs = 100 } = {}) {
  let written = 0;
  for (let i = 0; i < requests.length; i += BATCH_CHUNK) {
    let pending = requests.slice(i, i + BATCH_CHUNK);
    for (let attempt = 1; ; attempt += 1) {
      const res = await doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      const left = res?.UnprocessedItems?.[table] || [];
      written += pending.length - left.length;
      if (!left.length) break;
      if (attempt >= maxAttempts) {
        throw new Error(`batchWriteAll: ${left.length} item(s) still unprocessed on ${table} after `
          + `${maxAttempts} attempts — the teardown is PARTIAL, do not treat this run as successful`);
      }
      log('batch write throttled — retrying the remainder', { table, unprocessed: left.length, attempt });
      // Jittered backoff: a fixed delay re-synchronises every retrying chunk into the same instant,
      // which turns a throttle into a stampede.
      pending = left;
      await sleep(baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * 50));
    }
  }
  return written;
}

const REGION = process.env.AGENTCORE_REGION || 'us-east-1';
const TABLE = process.env.AGENT_CONFIG_TABLE || 'agent-4ggvzl-config';
const FS_ID = process.env.AGENTCORE_EFS_FS_ID || 'fs-REDACTED';
// Access points created by agentcore-client are tagged managed-by=agentcore — the precise
// scope. ECS / agent-xx9aff / filebrowser APs are NOT tagged this way, so they're never touched.
const AP_MANAGED_BY = 'agentcore';
const CRON_DIR = process.env.CRON_STORE_DIR || '/efs/cron';
const APPLY = process.argv.includes('--apply');
const nameReArg = process.argv.find((a) => a.startsWith('--name-re='));
// Default: skip scratch/experiment runtimes; delete the rest (the real fleet).
const SKIP_RE = /^(bench_|bdd_|exp_|streamval_|enum_|spike_|pi_timing|pi_poc)/;
const NAME_RE = nameReArg ? new RegExp(nameReArg.split('=')[1]) : null;

const control = new BedrockAgentCoreControlClient({ region: REGION });
const efs = new EFSClient({ region: REGION });
const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const log = (m, o) => console.log(`teardown: ${m}${o ? ' ' + JSON.stringify(o) : ''}`);
const tag = APPLY ? '' : '[dry-run] ';

async function targetRuntimes() {
  const out = [];
  let token;
  do {
    const r = await control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
    for (const rt of r.agentRuntimes || []) {
      const name = rt.agentRuntimeName || '';
      const match = NAME_RE ? NAME_RE.test(name) : !SKIP_RE.test(name);
      if (match) out.push({ id: rt.agentRuntimeId, name });
    }
    token = r.nextToken;
  } while (token);
  return out;
}

async function deleteRuntimes() {
  const rts = await targetRuntimes();
  log(`${tag}${rts.length} runtime(s) to delete`, { names: rts.map((r) => r.name) });
  if (!APPLY) return rts.length;
  for (const rt of rts) {
    try { await control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: rt.id })); log('deleted runtime', { name: rt.name }); }
    catch (e) { log('runtime delete failed', { name: rt.name, err: e.message }); }
  }
  return rts.length;
}

// EFS access points tagged managed-by=agentcore (how agentcore-client creates them). Precise:
// ECS/agent-xx9aff/filebrowser APs lack this tag, so they're excluded.
async function deleteAccessPoints() {
  const d = await efs.send(new DescribeAccessPointsCommand({ FileSystemId: FS_ID }));
  const aps = (d.AccessPoints || []).filter((ap) => (ap.Tags || []).some((t) => t.Key === 'managed-by' && t.Value === AP_MANAGED_BY));
  log(`${tag}${aps.length} access point(s) to delete`, { fs: FS_ID });
  if (!APPLY) return aps.length;
  for (const ap of aps) {
    try { await efs.send(new DeleteAccessPointCommand({ AccessPointId: ap.AccessPointId })); log('deleted AP', { ap: ap.AccessPointId, name: (ap.Tags.find((t) => t.Key === 'Name') || {}).Value }); }
    catch (e) { log('AP delete failed', { ap: ap.AccessPointId, err: e.message }); }
  }
  return aps.length;
}

async function clearTable() {
  const keys = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new ScanCommand({ TableName: TABLE, ProjectionExpression: 'pk, sk', ExclusiveStartKey }));
    for (const it of r.Items || []) keys.push({ pk: it.pk, sk: it.sk });
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  log(`${tag}${keys.length} DDB item(s) to delete`, { table: TABLE });
  if (!APPLY) return keys.length;
  const deleted = await batchWriteAll(doc, TABLE, keys.map((Key) => ({ DeleteRequest: { Key } })));
  log('DDB table cleared', { deleted });
  return deleted;
}

function wipeCronStore() {
  if (!fs.existsSync(CRON_DIR)) { log(`${tag}cron store absent`, { dir: CRON_DIR }); return 0; }
  const files = fs.readdirSync(CRON_DIR).filter((f) => f.endsWith('.json'));
  log(`${tag}${files.length} cron file(s) to delete`, { dir: CRON_DIR });
  if (!APPLY) return files.length;
  for (const f of files) fs.rmSync(path.join(CRON_DIR, f), { force: true });
  log('cron store wiped', { deleted: files.length });
  return files.length;
}

(async () => {
  log(APPLY ? 'APPLY mode — deleting' : 'DRY-RUN (pass --apply to delete)');
  const runtimes = await deleteRuntimes();
  const aps = await deleteAccessPoints();
  const items = await clearTable();
  const cron = wipeCronStore();
  log('done', { runtimes, accessPoints: aps, ddbItems: items, cronFiles: cron, applied: APPLY });
})().catch((e) => { console.error('teardown FATAL', e); process.exit(1); });

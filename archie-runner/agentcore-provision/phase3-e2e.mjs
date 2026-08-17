// Phase 3 E2E (sandra-repo-removal): deploy the Pi image to a VPC+EFS AgentCore runtime (the
// production-faithful config: EFS = workspace+sessions, skills on /tmp) and prove per-agent
// dynamic skills — a marketplace install written to DDB takes effect on the NEXT turn (scoped
// re-hydrate + session rebuild) while conversation history survives.
//
// Test agent = AGENT#phase3-e2e (throwaway, minted). Creates a fresh EFS access point (cleaned
// up by `cleanup`). Reuses the sandbox networking constants from bench-cold-provision.mjs.
//
//   AWS_PROFILE=sandbox IMG=<ecr>:pi-phase3-N node phase3-e2e.mjs deploy
//   AWS_PROFILE=sandbox node phase3-e2e.mjs e2e
//   AWS_PROFILE=sandbox node phase3-e2e.mjs logs
//   AWS_PROFILE=sandbox node phase3-e2e.mjs cleanup

import {
  BedrockAgentCoreControlClient, CreateAgentRuntimeCommand,
  GetAgentRuntimeCommand, DeleteAgentRuntimeCommand, ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  EFSClient, CreateAccessPointCommand, DescribeAccessPointsCommand,
  DescribeMountTargetsCommand, DeleteAccessPointCommand,
} from '@aws-sdk/client-efs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const REGION = 'us-east-1';
const ACCOUNT = '203366135563';
// §9.9b: NO shared-role default. The fleet-shared clawdbot-agentcore-exec grants
// unconditioned, table-wide DynamoDB reads, so nothing should provision onto it any more.
// Supply a role explicitly via AGENTCORE_ROLE_ARN (a /agentcore/<agent> derived role is the
// representative choice — it is what production now uses, IAM propagation tax included).
const ROLE_ARN = process.env.AGENTCORE_ROLE_ARN
  || (() => { throw new Error('AGENTCORE_ROLE_ARN is required — refusing to default to the fleet-shared role (§9.9b)'); })();
const VPC = 'vpc-REDACTED';
const SG = 'sg-REDACTED';
const FS = 'fs-REDACTED';
const SUPPORTED = new Set(['use1-az1', 'use1-az2', 'use1-az4']);
const TABLE = 'agent-4ggvzl-config';
const AGENT = 'phase3-e2e';
const RT_NAME = 'phase3e2e'; // no hyphens allowed
const SESSION = 'phase3-e2e-session-0000000000000000001'; // >=33 chars
const STATE = join(tmpdir(), 'phase3-rt.json');
const CODEWORD = 'MERIDIAN-9';

const control = new BedrockAgentCoreControlClient({ region: REGION });
const efs = new EFSClient({ region: REGION });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const verb = process.argv[2];

const mkInstalls = (names) => JSON.stringify({
  installs: Object.fromEntries(names.map((n) => [n, { installedAt: '2026-07-31T00:00:00Z', installedBy: 'phase3-e2e' }])),
  connectors: {},
});
function putMarketplace(names) {
  const item = JSON.stringify({ pk: { S: `AGENT#${AGENT}` }, sk: { S: 'MARKETPLACE' }, data: { S: mkInstalls(names) } });
  execFileSync('aws', ['dynamodb', 'put-item', '--table-name', TABLE, '--item', item, '--region', REGION], { stdio: 'pipe' });
  console.log(`  [ddb] AGENT#${AGENT}/MARKETPLACE installs = [${names.join(', ')}]`);
}

async function subnets() {
  const m = await efs.send(new DescribeMountTargetsCommand({ FileSystemId: FS }));
  return (m.MountTargets || []).filter((x) => x.VpcId === VPC && SUPPORTED.has(x.AvailabilityZoneId)).map((x) => x.SubnetId);
}
async function ensureAp(root, nameTag) {
  const clientToken = `phase3-ap-${root.replace(/[^a-zA-Z0-9]/g, '-')}`.slice(0, 64);
  const arnOf = (id) => `arn:aws:elasticfilesystem:${REGION}:${ACCOUNT}:access-point/${id}`;
  let apId;
  try {
    const ap = await efs.send(new CreateAccessPointCommand({
      ClientToken: clientToken, FileSystemId: FS,
      RootDirectory: { Path: root, CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' } },
      PosixUser: { Uid: 1000, Gid: 1000 },
      Tags: [{ Key: 'Name', Value: nameTag }, { Key: 'managed-by', Value: 'phase3-e2e' }],
    }));
    apId = ap.AccessPointId;
    for (let i = 0; i < 30; i += 1) {
      const d = await efs.send(new DescribeAccessPointsCommand({ AccessPointId: apId }));
      if (d.AccessPoints?.[0]?.LifeCycleState === 'available') break;
      await sleep(2000);
    }
  } catch (e) {
    if (e.name !== 'AccessPointAlreadyExists') throw e;
    apId = e.AccessPointId;
  }
  return { apArn: arnOf(apId), apId };
}
async function findRuntimeId() {
  const r = await control.send(new ListAgentRuntimesCommand({ maxResults: 100 }));
  return (r.agentRuntimes || []).find((x) => x.agentRuntimeName === RT_NAME)?.agentRuntimeId || null;
}

async function invoke(arn, prompt, { tries = 12 } = {}) {
  const outfile = join(tmpdir(), `phase3-inv-${Date.now()}.json`);
  let last = 'none';
  for (let a = 1; a <= tries; a += 1) {
    try {
      execFileSync('aws', ['bedrock-agentcore', 'agent-i073q7-runtime',
        '--agent-runtime-arn', arn, '--runtime-session-id', SESSION,
        '--payload', JSON.stringify({ input: { prompt } }),
        '--cli-binary-format', 'raw-in-base64-out', '--cli-read-timeout', '0',
        '--region', REGION, outfile], { stdio: ['ignore', 'pipe', 'pipe'] });
      const res = JSON.parse(readFileSync(outfile, 'utf8') || '{}');
      if (res.output) { try { unlinkSync(outfile); } catch { /**/ } const t = typeof res.output === 'string' ? res.output : JSON.stringify(res.output); return t; }
      last = `no-output: ${JSON.stringify(res).slice(0, 140)}`;
    } catch (e) { last = String(e.stderr || e.message || '').replace(/\s+/g, ' ').slice(0, 140); }
    console.error(`  [invoke ${a}/${tries}] ${last}`);
    if (a < tries) await sleep(12000);
  }
  throw new Error(`invoke gave up: ${last}`);
}

if (verb === 'deploy') {
  const IMG = process.env.IMG;
  if (!IMG) throw new Error('IMG env required');
  const existing = await findRuntimeId();
  if (existing) {
    console.log('deleting existing runtime', existing, '(waiting for name to free)');
    try { await control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: existing })); } catch { /* already gone */ }
    for (let i = 0; i < 40; i += 1) { await sleep(3000); if (!(await findRuntimeId())) break; }
  }
  const sn = await subnets();
  const { apArn, apId } = await ensureAp(`/openclaw-data/agents/${AGENT}`, AGENT);
  console.log('EFS access point', apId, '| subnets', sn.length);
  const c = await control.send(new CreateAgentRuntimeCommand({
    agentRuntimeName: RT_NAME,
    agentRuntimeArtifact: { containerConfiguration: { containerUri: IMG } },
    roleArn: ROLE_ARN,
    networkConfiguration: { networkMode: 'VPC', networkModeConfig: { subnets: sn, securityGroups: [SG] } },
    protocolConfiguration: { serverProtocol: 'HTTP' },
    lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
    environmentVariables: { AGENT_NAME: AGENT, REGION, AWS_BEDROCK_ENABLED: 'true', AGENT_CONFIG_TABLE: TABLE, EFS_DIR: '/mnt/efs' },
    filesystemConfigurations: [{ efsAccessPoint: { accessPointArn: apArn, mountPath: '/mnt/efs' } }],
  }));
  writeFileSync(STATE, JSON.stringify({ arn: c.agentRuntimeArn, id: c.agentRuntimeId, apId }));
  console.log('created', c.agentRuntimeId, '-> polling READY');
  let st = c.status;
  for (let i = 0; i < 60 && !['READY', 'CREATE_FAILED'].includes(st); i += 1) {
    await sleep(3000);
    st = (await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: c.agentRuntimeId }))).status;
  }
  console.log('status:', st, '| arn:', c.agentRuntimeArn);
  process.exit(st === 'READY' ? 0 : 1);
}

if (verb === 'e2e') {
  const { arn } = JSON.parse(readFileSync(STATE, 'utf8'));
  console.log('== turn 1 (1 skill installed: cloudwatch-logs) ==');
  putMarketplace(['cloudwatch-logs']);
  const t1 = await invoke(arn, `Remember this codeword for later: ${CODEWORD}. Reply with just "ok".`);
  console.log('  turn1:', JSON.stringify(t1).slice(0, 200));
  console.log('== install a 2nd skill in DDB (daily-briefing) — should take effect next turn ==');
  putMarketplace(['cloudwatch-logs', 'daily-briefing']);
  await sleep(1500);
  console.log('== turn 2 (same session) — expect: skill-change rebuild + codeword recalled ==');
  const t2 = await invoke(arn, 'What was the codeword I told you earlier? Reply with ONLY the codeword.');
  console.log('  turn2:', JSON.stringify(t2).slice(0, 200));
  const recalled = t2.includes(CODEWORD);
  console.log(`\n[e2e] codeword recalled across the install-triggered rebuild: ${recalled ? 'PASS' : 'FAIL'}`);
  console.log('[e2e] (run `logs` to confirm the scoped re-hydrate: reason=skill-change, installed:2)');
  process.exit(recalled ? 0 : 1);
}

if (verb === 'logs') {
  const { id } = JSON.parse(readFileSync(STATE, 'utf8'));
  const grp = `/aws/bedrock-agentcore/runtimes/${id}-DEFAULT`;
  console.log('log group:', grp);
  const out = execFileSync('aws', ['logs', 'filter-log-events', '--log-group-name', grp,
    '--start-time', String((Date.now() - 900_000)), '--region', REGION, '--query', 'events[].message', '--output', 'text'], { encoding: 'utf8' });
  for (const l of out.split('\t').filter((l) => /reason|hydrat|installed|skills|session/i.test(l)).slice(-30)) console.log('  ', l.slice(0, 220));
  const hasChange = /"reason":"skill-change"/.test(out);
  const hydrated2 = /"installed":2/.test(out);
  const skills1 = /"skills":1/.test(out);
  console.log(`\n[logs] turn1 built with 1 skill: ${skills1 ? 'PASS' : '—'} | skill-change rebuild: ${hasChange ? 'PASS' : '—'} | hydrated installed:2: ${hydrated2 ? 'PASS' : '—'}`);
  process.exit(0);
}

if (verb === 'cleanup') {
  let st = {};
  try { st = JSON.parse(readFileSync(STATE, 'utf8')); } catch { /* none */ }
  const id = st.id || await findRuntimeId();
  if (id) { try { await control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: id })); console.log('deleted runtime', id); } catch (e) { console.error('rt delete:', e.message); } }
  if (st.apId) { await sleep(4000); try { await efs.send(new DeleteAccessPointCommand({ AccessPointId: st.apId })); console.log('deleted EFS AP', st.apId); } catch (e) { console.error('ap delete:', e.message); } }
  try { execFileSync('aws', ['dynamodb', 'delete-item', '--table-name', TABLE, '--key', JSON.stringify({ pk: { S: `AGENT#${AGENT}` }, sk: { S: 'MARKETPLACE' } }), '--region', REGION], { stdio: 'pipe' }); console.log('deleted DDB test item'); } catch (e) { console.error('ddb delete:', e.message); }
  process.exit(0);
}

console.error('usage: node phase3-e2e.mjs deploy|e2e|logs|cleanup');
process.exit(2);

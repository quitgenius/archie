// Migration gate (§12.4): does the spec we DERIVE match the spec that is actually RUNNING?
//
// A full fleet roll at migration is accepted. The failure this guards is different and quiet: the
// runtime spec contains `efsRoot`, so if the migration changes it by even a character, every agent
// comes back mounted on a DIFFERENT EFS directory — an empty workspace, not a rolled one. The
// fingerprint cannot tell those apart on its own (both just look like "the name changed"), so this
// dumps the FIELDS as well as the hash.
//
// Run it twice: once now, to capture the baseline from the deployed dispatcher's own environment,
// and again once a spec template exists, to diff. Identical fingerprints for every agent means the
// migration is a pure roll. Any efsRoot difference means data loss, and must block.
//
//   node spec-baseline.mjs > baseline.json          # today, from the live task definition
//   node spec-baseline.mjs --compare baseline.json  # after the template lands
//
// Env comes from the DEPLOYED task definition, not this shell — the whole point is to reproduce what
// the dispatcher actually computes, and a local env would silently derive a different answer.

import { readFileSync } from 'node:fs';
import { ECSClient, DescribeTaskDefinitionCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { BedrockAgentCoreControlClient, ListAgentRuntimesCommand } from '@aws-sdk/client-bedrock-agentcore-control';

const REGION = process.env.AWS_REGION || 'us-east-1';
const CLUSTER = process.env.ARCHIE_CLUSTER || 'agent-gn0p84';
const SERVICE = process.env.ARCHIE_SERVICE || 'agent-gn0p84-dispatcher';
const compareTo = process.argv.includes('--compare') ? process.argv[process.argv.indexOf('--compare') + 1] : null;

const err = (...a) => console.error(...a);

async function dispatcherEnv() {
  const ecs = new ECSClient({ region: REGION });
  const svc = await ecs.send(new DescribeServicesCommand({ cluster: CLUSTER, services: [SERVICE] }));
  const tdArn = svc.services?.[0]?.taskDefinition;
  if (!tdArn) throw new Error(`no task definition on ${CLUSTER}/${SERVICE}`);
  const td = await ecs.send(new DescribeTaskDefinitionCommand({ taskDefinition: tdArn }));
  const container = td.taskDefinition.containerDefinitions.find((c) => /dispatcher|archie/i.test(c.name))
    || td.taskDefinition.containerDefinitions[0];
  const env = {};
  for (const e of container.environment || []) env[e.name] = e.value;
  err(`# task definition: ${tdArn.split('/').pop()} (container ${container.name}, ${Object.keys(env).length} env vars)`);
  return { env, tdArn };
}

async function main() {
  const { env, tdArn } = await dispatcherEnv();
  // Apply BEFORE requiring the client: its config object is built from process.env at module load.
  for (const [k, v] of Object.entries(env)) if (process.env[k] === undefined) process.env[k] = v;
  process.env.AWS_REGION = REGION;

  const { createAgentCoreClient } = await import('./agentcore-client.js');
  const client = createAgentCoreClient();

  const table = env.AGENT_CONFIG_TABLE || process.env.AGENT_CONFIG_TABLE;
  if (!table) throw new Error('AGENT_CONFIG_TABLE not resolvable from the task definition');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

  // Use the dispatcher's OWN resolver rather than reimplementing it. The pointer may hold a full
  // URI or a bare `tag` that resolves against the repo (image-source.js:35-41,71-75), and per-agent
  // overrides live under `AGENT#<id>` — getting any of that subtly wrong would produce a baseline
  // that looks fine and compares against nothing real.
  const { createImageSource } = await import('./image-source.js');
  const { CONFIG } = await import('./agentcore-client.js');
  const imageSource = createImageSource({
    doc: () => doc, table, repoUri: CONFIG.imageRepoUri, logger: { warn: (o, m) => err(`# warn: ${m}`) },
  });
  const fleetImage = await imageSource.resolveImage('__fleet_probe__');
  err(`# fleet image: ${fleetImage}`);

  // Every agent that has a runtime registry partition. Scan is acceptable here: this is an offline
  // gate run by an operator, not the turn path.
  const agents = new Set();
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new ScanCommand({
      TableName: table, ExclusiveStartKey,
      ProjectionExpression: 'pk', FilterExpression: 'begins_with(pk, :p)',
      ExpressionAttributeValues: { ':p': 'RUNTIME#' },
    }));
    for (const it of r.Items || []) agents.add(String(it.pk).slice('RUNTIME#'.length));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  err(`# agents with a runtime partition: ${agents.size}`);

  // Report overrides for the operator's benefit; resolveImage() already applies them per agent.
  const ov = await doc.send(new QueryCommand({
    TableName: table, KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'pk' }, ExpressionAttributeValues: { ':pk': 'CONFIG#image' },
  }));
  const overrideSks = (ov.Items || []).filter((it) => it.sk !== 'FLEET').map((it) => it.sk);
  if (overrideSks.length) err(`# per-agent image overrides: ${overrideSks.join(', ')}`);

  // What is actually live at AWS, so "derived" can be checked against "running".
  const ctl = new BedrockAgentCoreControlClient({ region: REGION });
  const live = new Set();
  let token;
  do {
    const r = await ctl.send(new ListAgentRuntimesCommand({ nextToken: token, maxResults: 100 }));
    for (const rt of r.agentRuntimes || []) live.add(rt.agentRuntimeName);
    token = r.nextToken;
  } while (token);
  err(`# live runtimes at AWS: ${live.size}`);

  const out = { tdArn, fleetImage, generatedFor: agents.size, agents: {} };
  for (const agent of [...agents].sort()) {
    const image = await imageSource.resolveImage(agent);
    const spec = client.runtimeSpecFor(agent, image);
    const name = client.generationRuntimeName(agent, image);
    out.agents[agent] = { name, image, efsRoot: spec.efsRoot, spec, liveAtAws: live.has(name) };
  }

  const missing = Object.entries(out.agents).filter(([, v]) => !v.liveAtAws).map(([a]) => a);
  err(`# derived names present at AWS: ${agents.size - missing.length}/${agents.size}`);
  if (missing.length) {
    err('# NOT live (these agents would provision on their next turn regardless of any migration):');
    for (const a of missing.slice(0, 30)) err(`#   ${a} -> ${out.agents[a].name}`);
    if (missing.length > 30) err(`#   ... and ${missing.length - 30} more`);
  }

  if (compareTo) {
    const base = JSON.parse(readFileSync(compareTo, 'utf8'));
    let same = 0; const rolled = []; const dataLoss = [];
    for (const [agent, now] of Object.entries(out.agents)) {
      const before = base.agents?.[agent];
      if (!before) continue;
      if (before.name === now.name) { same += 1; continue; }
      // A changed name is a roll. A changed efsRoot is DATA LOSS, and must block the migration.
      (before.efsRoot !== now.efsRoot ? dataLoss : rolled).push({ agent, before, now });
    }
    err(`\n# ===== COMPARISON vs ${compareTo} =====`);
    err(`# identical fingerprint : ${same}`);
    err(`# rolled (name only)    : ${rolled.length}  <- accepted, this is just a re-provision`);
    err(`# EFS ROOT CHANGED      : ${dataLoss.length} <- BLOCKS: agents would boot on an empty workspace`);
    for (const d of dataLoss.slice(0, 20)) err(`#   ${d.agent}: ${d.before.efsRoot}  ->  ${d.now.efsRoot}`);
    if (rolled.length) {
      const f = rolled[0];
      const diff = Object.keys(f.now.spec).filter((k) => JSON.stringify(f.now.spec[k]) !== JSON.stringify(f.before.spec[k]));
      err(`# first roll's changed fields: ${diff.join(', ') || '(none — fingerprint algorithm changed)'}`);
    }
    process.exitCode = dataLoss.length ? 1 : 0;
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

main().catch((e) => { err('FAILED:', e?.name, e?.message); process.exit(1); });

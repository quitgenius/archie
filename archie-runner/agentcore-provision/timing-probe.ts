// Fresh-create timing probe: isolate where AgentCore runtime create-to-READY time
// goes — PUBLIC (baseline) vs VPC-only (ENI) vs VPC+EFS (ENI + mount). Creates each
// fresh, times to READY, deletes. Run: IMG=<ecr:tag> npx tsx timing-probe.ts
import {
  BedrockAgentCoreControlClient, CreateAgentRuntimeCommand,
  GetAgentRuntimeCommand, DeleteAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { EFSClient, DescribeMountTargetsCommand } from '@aws-sdk/client-efs';

const REGION = 'us-east-1';
const ACCOUNT = '203366135563';
const IMG = process.env.IMG!;
const ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/clawdbot-agentcore-exec`;
const VPC = 'vpc-REDACTED';
const SG = 'sg-REDACTED';
const AP_ARN = 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-REDACTED';
const FS = 'fs-REDACTED';
const SUPPORTED = new Set(['use1-az1', 'use1-az2', 'use1-az4']);

const control = new BedrockAgentCoreControlClient({ region: REGION });
const efs = new EFSClient({ region: REGION });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function subnets(): Promise<string[]> {
  const m = await efs.send(new DescribeMountTargetsCommand({ FileSystemId: FS }));
  return (m.MountTargets || []).filter((x) => x.VpcId === VPC && SUPPORTED.has(x.AvailabilityZoneId!)).map((x) => x.SubnetId!);
}

const env = { AGENT_NAME: 'pi-timing', REGION, AWS_BEDROCK_ENABLED: 'true' };
function spec(name: string, net: any, fsCfg?: any) {
  return {
    agentRuntimeName: name,
    agentRuntimeArtifact: { containerConfiguration: { containerUri: IMG } },
    roleArn: ROLE_ARN,
    networkConfiguration: net,
    protocolConfiguration: { serverProtocol: 'HTTP' as const },
    lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
    environmentVariables: env,
    ...(fsCfg ? { filesystemConfigurations: fsCfg } : {}),
  };
}

async function timeCreate(label: string, net: any, fsCfg?: any) {
  const name = `pi_timing_${label}`;
  const t0 = Date.now();
  let c: any;
  for (let i = 1; ; i += 1) {
    try { c = await control.send(new CreateAgentRuntimeCommand(spec(name, net, fsCfg) as any)); break; }
    catch (e: any) {
      if (/role|assume|validation|ValidationException/i.test(`${e?.name} ${e?.message}`) && i < 6) { await sleep(6000); continue; }
      console.log(`${label}: CREATE ERROR ${e?.name}: ${e?.message}`); return;
    }
  }
  const id = c.agentRuntimeId!;
  const createAckMs = Date.now() - t0;
  let st = c.status;
  while (!['READY', 'CREATE_FAILED'].includes(st)) {
    await sleep(3000);
    const g = await control.send(new GetAgentRuntimeCommand({ agentRuntimeId: id }));
    st = g.status!;
  }
  const readyS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${label}: status=${st}  createAck=${createAckMs}ms  READY_in=${readyS}s`);
  try { await control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: id })); console.log(`${label}: delete requested`); } catch (e: any) { console.log(`${label}: delete err ${e?.message}`); }
  return { label, st, readyS };
}

(async () => {
  const sn = await subnets();
  console.log('supported-AZ subnets:', sn.join(','));
  await timeCreate('public', { networkMode: 'PUBLIC' });
  await timeCreate('vpc', { networkMode: 'VPC', networkModeConfig: { subnets: sn, securityGroups: [SG] } });
  await timeCreate('vpcefs', { networkMode: 'VPC', networkModeConfig: { subnets: sn, securityGroups: [SG] } }, [{ efsAccessPoint: { accessPointArn: AP_ARN, mountPath: '/mnt/efs' } }]);
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });

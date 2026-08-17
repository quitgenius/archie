// Attach the READ-ONLY CloudWatch/Logs grant (observability-iam.cjs) to the shared AgentCore
// runtime exec role so the OTEL self-observability tools (otel-tool.mjs) can query telemetry back.
//
// The shared prod role `clawdbot-agentcore-exec` is maintained out-of-band (no Terraform), and its
// main `agentcore-exec` inline policy carries an EfsMount statement CONDITION-PINNED to one
// permanent access point — so we must NOT rewrite it. Instead this attaches the read grant as its
// OWN separate inline policy (`agentcore-observability-read`), which is additive and idempotent
// (PutRolePolicy overwrites that one policy only). Reversible: delete-role-policy the same name.
//
//   node apply-observability-grant.mjs [--role <name>] [--region <r>] [--dry-run]
// Defaults: role=clawdbot-agentcore-exec, region=$AGENTCORE_REGION||us-east-1. Creds = default chain.

import { createRequire } from 'node:module';
import { IAMClient, PutRolePolicyCommand, GetRolePolicyCommand } from '@aws-sdk/client-iam';

const require = createRequire(import.meta.url);
const { observabilityReadPolicy, OBSERVABILITY_POLICY_NAME } = require('./observability-iam.cjs');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const role = arg('--role', process.env.AGENTCORE_ROLE_NAME || 'clawdbot-agentcore-exec');
const region = arg('--region', process.env.AGENTCORE_REGION || 'us-east-1');
const dryRun = process.argv.includes('--dry-run');
const policy = observabilityReadPolicy();

async function main() {
  console.log(`role=${role} region=${region} policy=${OBSERVABILITY_POLICY_NAME}${dryRun ? ' (dry-run)' : ''}`);
  console.log(JSON.stringify(policy, null, 2));
  if (dryRun) return;
  const iam = new IAMClient({ region });
  await iam.send(new PutRolePolicyCommand({
    RoleName: role,
    PolicyName: OBSERVABILITY_POLICY_NAME,
    PolicyDocument: JSON.stringify(policy),
  }));
  // Read back to confirm it landed.
  const got = await iam.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: OBSERVABILITY_POLICY_NAME }));
  const doc = JSON.parse(decodeURIComponent(got.PolicyDocument));
  console.log(`✓ attached ${OBSERVABILITY_POLICY_NAME} to ${role} (${doc.Statement.length} statements)`);
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });

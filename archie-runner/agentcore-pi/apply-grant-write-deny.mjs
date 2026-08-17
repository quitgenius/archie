// Attach the config-table write DENY (config-resolver/agentcore-grant-deny.cjs) to the SHARED
// AgentCore runtime exec role, so a runtime cannot write the tool-permission grants that police it.
//
// CONTEXT: derived per-agent roles already get a key-conditioned write from the `agentcore-base`
// managed policy (LeadingKeys AGENT#*). The shared role `clawdbot-agentcore-exec` is maintained
// out-of-band (no Terraform) with an unconditional table write, and it is the role MOST of the fleet
// runs on (derived roles are minted lazily — only for agents holding an IAM-needing grant). So the
// Terraform change alone leaves the escalation path open for the majority of agents; this closes it.
//
// Attaches as its OWN inline policy (additive + idempotent, PutRolePolicy replaces only that policy)
// rather than rewriting `agentcore-exec`, whose EfsMount statement is condition-pinned to one
// permanent access point. Reversible: aws iam delete-role-policy --policy-name <same name>.
//
//   node apply-grant-write-deny.mjs [--role <name>] [--region <r>] [--account <id>] [--table <t>] [--dry-run]
// Defaults: role=clawdbot-agentcore-exec, region=$AGENTCORE_REGION||us-east-1,
//           table=$AGENT_CONFIG_TABLE||agent-4ggvzl-config, account=$AWS_ACCOUNT_ID
//           (else resolved via sts:GetCallerIdentity). Creds = default chain.
//
// VERIFY AFTERWARDS (should be an explicit deny):
//   aws iam simulate-principal-policy --policy-source-arn <role arn> \
//     --action-names dynamodb:UpdateItem --resource-arns <table arn> \
//     --context-entries ContextKeyName=dynamodb:LeadingKeys,ContextKeyType=stringList,ContextKeyValues=GRANT#dm-u1

import { createRequire } from 'node:module';
import { IAMClient, PutRolePolicyCommand, GetRolePolicyCommand } from '@aws-sdk/client-iam';
// @aws-sdk/client-sts is imported LAZILY (below) — it is not a dependency of this package, and is
// only needed to resolve the account when --account / AWS_ACCOUNT_ID is not supplied.

const require = createRequire(import.meta.url);
const { grantWriteDenyPolicy, GRANT_DENY_POLICY_NAME } = require('../config-resolver/agentcore-grant-deny.cjs');

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const role = arg('--role', process.env.AGENTCORE_ROLE_NAME || 'clawdbot-agentcore-exec');
const region = arg('--region', process.env.AGENTCORE_REGION || 'us-east-1');
const table = arg('--table', process.env.AGENT_CONFIG_TABLE || 'agent-4ggvzl-config');
const dryRun = process.argv.includes('--dry-run');

async function resolveAccount() {
  const explicit = arg('--account', process.env.AWS_ACCOUNT_ID);
  if (explicit) return explicit;
  let sts;
  try {
    /* eslint-disable-next-line n/no-missing-import -- intentionally OPTIONAL: not a dependency of
       this package (declaring it would ship the SDK in the runtime image for a script the image
       never runs). The ERR_MODULE_NOT_FOUND branch below IS the contract — pass --account instead. */
    sts = await import('@aws-sdk/client-sts');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    throw new Error('cannot resolve the account: @aws-sdk/client-sts is not installed here — pass --account <id> (or set AWS_ACCOUNT_ID)');
  }
  const client = new sts.STSClient({ region });
  return (await client.send(new sts.GetCallerIdentityCommand({}))).Account;
}

async function main() {
  const account = await resolveAccount();
  const policy = grantWriteDenyPolicy({ account, region, table });
  console.log(`role=${role} region=${region} account=${account} table=${table} policy=${GRANT_DENY_POLICY_NAME}${dryRun ? ' (dry-run)' : ''}`);
  console.log(JSON.stringify(policy, null, 2));
  if (dryRun) return;

  const iam = new IAMClient({ region });
  await iam.send(new PutRolePolicyCommand({
    RoleName: role,
    PolicyName: GRANT_DENY_POLICY_NAME,
    PolicyDocument: JSON.stringify(policy),
  }));
  // Read back to confirm it landed, and that it really is a Deny (a silent Allow would be worse
  // than no policy at all — it would look applied while granting the write).
  const got = await iam.send(new GetRolePolicyCommand({ RoleName: role, PolicyName: GRANT_DENY_POLICY_NAME }));
  const doc = JSON.parse(decodeURIComponent(got.PolicyDocument));
  const effects = [...new Set(doc.Statement.map((s) => s.Effect))];
  if (effects.length !== 1 || effects[0] !== 'Deny') throw new Error(`read-back is not a pure Deny: ${effects.join(',')}`);
  console.log(`✓ attached ${GRANT_DENY_POLICY_NAME} to ${role} (${doc.Statement.length} Deny statement(s))`);
}

main().catch((e) => { console.error('FAILED:', e?.message || e); process.exit(1); });

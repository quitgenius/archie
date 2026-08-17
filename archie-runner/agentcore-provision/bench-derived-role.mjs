// §9.9 — what do UNIVERSAL per-agent exec roles cost on the cold-provision path?
//
// §9.2 deliberately made derived roles LAZY (mint one only for an agent holding an IAM-needing
// capability) to avoid "the per-agent IAM propagation tax" — see the comment on ROLE_ARN in
// bench-cold-provision.mjs. §9.9 makes them universal, because the per-agent config-table read
// (derive-exec-role.mjs ddbReadOwnScopeStatement) uses dynamodb:LeadingKeys, which takes LITERAL
// partition keys: on a fleet-shared role the narrowest expressible read is the prefix AGENT#*, i.e.
// every agent's config and grants. So the tax is now being paid deliberately — this measures it.
//
// TWO components, measured separately because they have very different shapes:
//
//   (a) ROLE LIFECYCLE — the added IAM calls on every cold provision: CreateRole +
//       AttachRolePolicy(agentcore-base) + PutRolePolicy(inline read ∪ grants). Deterministic,
//       cheap to sample many times. This is the number that lands on p50.
//
//   (b) PROPAGATION — IAM is eventually consistent. A role created milliseconds before
//       CreateAgentRuntime may not yet be assumable by bedrock-agentcore, which would surface as a
//       provision failure or a retry, not as a slow call. This is a TAIL risk, so it is measured by
//       real provisions and reported as "attempts / failures", not as an average.
//
// Run:  AWS_PROFILE=sandbox N=10 node bench-derived-role.mjs            # (a) only, no runtimes created
//       AWS_PROFILE=sandbox N=3 PROVISION=1 IMG=<uri> node bench-derived-role.mjs   # (a) + (b)
//       AWS_PROFILE=sandbox node bench-derived-role.mjs --sweep         # delete leaked bench roles
//
// Every role it creates is named bench-<runtag>-<i> under /agentcore/ and deleted in a finally, plus
// a --sweep that removes any leaked bench-* role from an interrupted run.

import { createRequire } from 'node:module';
import {
  IAMClient, CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand,
  DetachRolePolicyCommand, DeleteRolePolicyCommand, DeleteRoleCommand,
  ListRolesCommand, ListAttachedRolePoliciesCommand, ListRolePoliciesCommand,
  UpdateAssumeRolePolicyCommand,
} from '@aws-sdk/client-iam';

const require = createRequire(import.meta.url);
const derivedRole = require('../../archie-gateway/derived-role.js');

const REGION = process.env.AGENTCORE_REGION || 'us-east-1';
const ACCOUNT = process.env.AGENTCORE_ACCOUNT || '203366135563';
const TABLE = process.env.AGENT_CONFIG_TABLE || 'agent-4ggvzl-config';
const BASE_POLICY = `arn:aws:iam::${ACCOUNT}:policy/agentcore-base`;
const N = Number(process.env.N || 10);
const SWEEP_ONLY = process.argv.includes('--sweep');
const RUN_TAG = `b${Date.now().toString(36)}`;
const PREFIX = 'bench-';

const iam = new IAMClient({ region: REGION });
const iamCmds = {
  CreateRoleCommand, AttachRolePolicyCommand, PutRolePolicyCommand,
  UpdateAssumeRolePolicyCommand, DeleteRolePolicyCommand,
};

const ms = (a, b) => Number((b - a) / 1_000_000n) / 1;
const now = () => process.hrtime.bigint();

function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return {
    n: s.length,
    min: +s[0].toFixed(1),
    p50: +pct(50).toFixed(1),
    p90: +pct(90).toFixed(1),
    max: +s[s.length - 1].toFixed(1),
    avg: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(1),
  };
}

/** Full teardown of one bench role (inline policy + managed attachment must go first). */
async function deleteRole(roleName) {
  try {
    const pol = await iam.send(new ListRolePoliciesCommand({ RoleName: roleName }));
    for (const p of pol.PolicyNames || []) await iam.send(new DeleteRolePolicyCommand({ RoleName: roleName, PolicyName: p }));
    const att = await iam.send(new ListAttachedRolePoliciesCommand({ RoleName: roleName }));
    for (const a of att.AttachedPolicies || []) await iam.send(new DetachRolePolicyCommand({ RoleName: roleName, PolicyArn: a.PolicyArn }));
    await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
    return true;
  } catch (e) {
    if (e.name === 'NoSuchEntity' || e.name === 'NoSuchEntityException') return false;
    console.error(`  cleanup failed for ${roleName}: ${e.message}`);
    return false;
  }
}

async function sweep() {
  const out = [];
  let marker;
  do {
    const r = await iam.send(new ListRolesCommand({ PathPrefix: '/agentcore/', Marker: marker }));
    out.push(...(r.Roles || []));
    marker = r.IsTruncated ? r.Marker : undefined;
  } while (marker);
  const leaked = out.filter((r) => r.RoleName.startsWith(PREFIX));
  console.log(`sweep: ${leaked.length} leaked bench role(s) under /agentcore/`);
  for (const r of leaked) {
    const ok = await deleteRole(r.RoleName);
    console.log(`  ${ok ? 'deleted' : 'skipped'} ${r.RoleName}`);
  }
}

/**
 * (a) One role-lifecycle sample: exactly what resolveDerivedRole → spec.ensure() does on a cold
 * provision. Uses the REAL dispatcher code path (deriveExecRoleSpec), not a reimplementation, so a
 * change in the number of IAM calls shows up here.
 */
async function sampleRoleLifecycle(i, caps) {
  const agentId = `${PREFIX}${RUN_TAG}-${i}`;
  const spec = derivedRole.deriveExecRoleSpec({
    account: ACCOUNT,
    agentId,
    caps,
    baseManagedPolicyArn: BASE_POLICY,
    ddbScope: { agentId, account: ACCOUNT, region: REGION, table: TABLE },
  });
  const t0 = now();
  try {
    await spec.ensure({ clients: { iam, iamCmds } });
    const create = ms(t0, now());
    // Second ensure = the WARM path (role already exists): EntityAlreadyExists →
    // UpdateAssumeRolePolicy + Attach + Put. This is what a re-provision of an existing agent pays.
    const t1 = now();
    await spec.ensure({ clients: { iam, iamCmds } });
    return { agentId, create, reensure: ms(t1, now()) };
  } finally {
    // Role name = derivedRoleName(agentId) (sanitised, ≤64 chars) — take it from the same pure
    // module the dispatcher uses rather than assuming agentId passes through unchanged.
    const { derivedRoleName } = await import('../config-resolver/derive-exec-role.mjs');
    await deleteRole(derivedRoleName(agentId));
  }
}

async function main() {
  if (SWEEP_ONLY) return sweep();

  console.log(`bench-derived-role: N=${N} region=${REGION} account=${ACCOUNT}`);
  console.log(`base policy: ${BASE_POLICY}`);
  console.log('measuring (a) role lifecycle — CreateRole + Attach(base) + Put(inline read ∪ grants)\n');

  // WARM-UP, discarded. The first IAM call of the process pays TLS handshake + credential
  // resolution + SDK client construction (~1.4s observed), which is a property of this benchmark
  // process, not of role creation — the dispatcher is long-lived and has already paid it. Leaving it
  // in skews p50 badly at small N.
  process.stdout.write('  (warm-up sample, discarded)\n');
  await sampleRoleLifecycle('warmup', []).catch(() => {});

  const cold = [];
  const warm = [];
  // Two cap shapes: a no-IAM agent (the common case — the one that used to skip role creation
  // entirely under the lazy rule, so it is where the new cost is purely additive) and an
  // IAM-needing one (which already paid this cost before §9.9).
  for (const [label, caps] of [['no-iam-caps', []], ['iam-caps', ['aws-readonly']]]) {
    const c = []; const w = [];
    for (let i = 0; i < N; i++) {
      const r = await sampleRoleLifecycle(`${label}-${i}`, caps);
      c.push(r.create); w.push(r.reensure);
      process.stdout.write(`  ${label} #${i}: create=${r.create.toFixed(0)}ms reensure=${r.reensure.toFixed(0)}ms\n`);
    }
    cold.push([label, stats(c)]); warm.push([label, stats(w)]);
  }

  console.log('\n=== (a) role lifecycle, ms ===');
  for (const [label, s] of cold) console.log(`  COLD  ${label.padEnd(12)} ${JSON.stringify(s)}`);
  for (const [label, s] of warm) console.log(`  WARM  ${label.padEnd(12)} ${JSON.stringify(s)}`);
  console.log('\nInterpretation: COLD is the per-provision cost added for an agent that previously');
  console.log('used the shared role (lazy rule). WARM is what a re-provision of an existing agent pays.');
  console.log('Neither includes IAM propagation, which is a TAIL effect — run with PROVISION=1 for that.');
}

main().catch((e) => { console.error(e); process.exit(1); });

'use strict';

// A2 (plan §9.8) + §9.9b: production derived per-agent IAM role wiring — UNIVERSAL, no flag.
//
// At provision time we read the agent's reconciled caps and return a role SPEC (the ensureExecRole
// contract: { ensure() → {roleArn, roleName, created} }). ensure() get-or-creates a role under
// /agentcore/ whose effective permissions = the `agentcore-base` managed policy (ATTACHED) ∪ an
// inline document carrying the agent's own-scope config read and its derived grants — the
// composition the @iam BDD harness proved live.
//
// EVERY agent gets one. This was lazy (§9.2: dedicated role only for an agent holding an IAM-needing
// cap, everyone else on a fleet-shared role), which is no longer viable: `dynamodb:LeadingKeys` takes
// literal partition keys, so scoping a runtime's config read to its OWN AGENT#/GRANT# partitions is
// only expressible on a role belonging to one agent. There is no flag to disable this and no shared
// fallback — a role that cannot be built is an error, not a downgrade.
//
// SINGLE SOURCE OF TRUTH: the cap→IAM map + the pure builder are the agent's ESM
// (config-resolver/{skill-iam-requirements,derive-exec-role}.mjs), SHIPPED into the dispatcher
// image (Dockerfile) and dynamic-imported here — no CommonJS mirror of the cross-account ARN table.

const { GetCommand } = require('@aws-sdk/lib-dynamodb');

let _pure = null;
async function pure() {
  if (_pure) return _pure;
  try {
    // Image layout: the Dockerfile ships the ESM to /app/config-resolver/ (single source of truth).
    _pure = await import('./config-resolver/derive-exec-role.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    // Repo layout (tests / local dev): the ESM lives in the sibling agent tree.
    _pure = await import('../archie-runner/config-resolver/derive-exec-role.mjs');
  }
  return _pure;
}

// Same dual-layout dynamic import for the key schema (grants moved to their own partition, so the
// key shape must come from the single source of truth rather than a literal in this file).
let _schema = null;
async function schema() {
  if (_schema) return _schema;
  try {
    _schema = await import('./config-resolver/schema.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    _schema = await import('../archie-runner/config-resolver/schema.mjs');
  }
  return _schema;
}

// Read the agent's reconciled non-baseline caps from its agent-wide grant (written by the
// marketplace reconcile, G2; read by the agent's PEP). Missing/empty/unparseable → [] (no grants →
// shared base role). Key comes from the schema module — grants live in their OWN partition
// (GRANT#<id>/SCOPE#*) so agent roles can be IAM-denied write access to them.
async function readAgentCaps(doc, tableName, agentId) {
  const { agentGrantKey, agentPolicyKey } = await schema();
  const [g, p] = await Promise.all([
    doc.send(new GetCommand({ TableName: tableName, Key: agentGrantKey(agentId, '*') })),
    // TWO SOURCES, because a PINNED capability is deliberately ABSENT from the grant row.
    //
    // Hydration strips any policy-owned capability from GRANT#* (migrate-to-ddb R1: "never hydrate a
    // capability the Cedar policy owns" — the policy's forbid beats a grant-row permit, so the row
    // would confer nothing while making the Tools tab claim otherwise). That is correct for the PEP,
    // which reads the policy. But this function also feeds the agent's IAM (deriveGrantStatements →
    // CAP_IAM_REQUIREMENTS), and IAM has no policy row to consult — so a capability that is both
    // pinned AND needs IAM could never get its statement.
    //
    // That is every IAM-needing capability there is except `datadog` (API keys, no IAM) and the
    // test-only probe: aws-readonly, aws-person79b333-secrets, cloudwatch-logs, airflow. Observed live —
    // person79b333 holds aws-readonly by pin, its runtime resolved the tool and the PEP allowed the call,
    // and the assume failed with "not authorized to perform: sts:AssumeRole" because the role carried
    // no such statement. The @aws-ports BDD passed only because its fixture writes the cap straight
    // into the grant row, bypassing the strip.
    doc.send(new GetCommand({ TableName: tableName, Key: agentPolicyKey(agentId) })),
  ]);
  const caps = new Set();
  if (g && g.Item && g.Item.data) {
    try {
      const d = JSON.parse(g.Item.data);
      // §8.4 grant shape { <cap>: { sources } } → caps are the keys; legacy { capabilities: [] } still
      // read (mirrors config-resolver grantedCaps / schema.grantedCaps).
      if (Array.isArray(d.capabilities)) for (const c of d.capabilities) caps.add(c);
      else for (const k of Object.keys(d)) if (d[k] && typeof d[k] === 'object' && Array.isArray(d[k].sources)) caps.add(k);
    } catch (err) {
      // CLASSIFY, don't swallow. Unparseable JSON is the one failure this tolerates (and its
      // pre-existing contract — see the "bad JSON → []" test): a corrupt row must not stop the agent
      // getting a role, because a role that cannot be built is a boot failure. Anything else is a bug
      // in this reader and must surface rather than silently under-permission the role, which would
      // present as an opaque AccessDenied inside a turn.
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  if (p && p.Item && p.Item.data) {
    try {
      const v = (JSON.parse(p.Item.data) || {}).verdicts || {};
      for (const [cap, verdict] of Object.entries(v)) if (verdict === 'allow') caps.add(cap);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return [...caps].sort();
}

/**
 * The agent's Connector pointer ARN, or null. Read at role-build time so the role can grant the ARN
 * the RUNTIME will actually ask for.
 *
 * Without this the pointer is decorative for the case it exists to serve: an ADOPTED agent points at
 * its legacy secret (`archie-oss-connector-api-key-<agent>`), which the name-derived
 * pattern cannot spell, so the runtime would read the pointer and get AccessDenied.
 *
 * Never throws — a pointer we cannot read means a role without that extra ARN, which degrades to
 * name-based resolution rather than failing the provision.
 */
async function readCredentialPointerArn(doc, tableName, agentId) {
  if (!doc || !tableName) return null;
  const { agentCredentialKey } = await schema();
  // ABSENCE vs FAILURE. This used to `catch { return null }`, which made a throttle or an
  // AccessDenied indistinguishable from "this agent has no pointer" — and the caller three lines
  // below REWRITES the role's inline policy from the result. So a transient DynamoDB error silently
  // dropped the exact secret ARN (revoking an ADOPTED agent's Connector key, whose legacy secret name
  // the derived pattern cannot spell) AND dropped ConnectorDenySharedKey, restoring that agent's
  // access to the SHARED project. Both invisible; the trigger is an unrelated skill install.
  //
  // The irony is on the record: the comment at the call site already warned that "a rewrite that
  // dropped the ARN would revoke a working key", and this function was how it got dropped.
  //
  // A genuine miss still returns null — that is how an un-migrated agent correctly gets no Deny.
  // Anything else PROPAGATES, so the rewrite is abandoned rather than written from a bad read.
  const r = await doc.send(new GetCommand({ TableName: tableName, Key: agentCredentialKey(agentId) }));
  if (!r.Item || !r.Item.data) return null;                        // genuine absence
  const d = JSON.parse(r.Item.data);                               // malformed item = a fault
  return typeof d.secretArn === 'string' && d.secretArn.startsWith('arn:') ? d.secretArn : null;
}

// The Connector secret PREFIX (`agent-gn0p84-connector-api-key`); the per-agent secret is that plus
// `-<agentId>`. Read from the environment here rather than threaded through the pure builder, because
// it is a deployment constant identical for every agent — the same value dispatcher.tf already passes
// to the runtime as CONNECTOR_API_KEY_SECRET. Unset means the deployment has no Connector at all, and
// the statement is correctly omitted. BOTH writers of the `grants` policy must set it: a rewrite that
// omitted it would silently revoke a migrated agent's key.
function credentialSecretBase() {
  return process.env.CONNECTOR_API_KEY_SECRET || '';
}

// Build the role spec ensureExecRole consumes. ensure() is idempotent: get-or-create the role,
// keep its (runtime) trust current, attach the base managed floor, and put the derived grants.
// `ddbScope` ({agentId, account, region, table}) is REQUIRED: it is the ONLY config-table access the
// role gets (agentcore-base has no DynamoDB statement), so a spec without it would mint a role the
// agent cannot boot on. Validated HERE, at construction, rather than inside ensure() — the mistake is
// in the caller's arguments, and failing at the point of the mistake beats failing mid-saga.
function deriveExecRoleSpec({ account, agentId, caps, baseManagedPolicyArn, ddbScope }) {
  if (!ddbScope) throw new Error('deriveExecRoleSpec: ddbScope required ({agentId, account, region, table}) — without it the role has NO config-table access and the agent cannot boot');
  return {
    spec: true,
    async ensure({ clients, logger } = {}) {
      const P = await pure();
      const iam = clients && clients.iam;
      const C = clients && clients.iamCmds;
      if (!iam || !C) throw new Error('deriveExecRoleSpec.ensure: clients.iam + clients.iamCmds required');

      const roleName = P.derivedRoleName(agentId);
      const trust = JSON.stringify(P.agentcoreTrustPolicy(account));
      // The inline policy = the agent's per-agent config-table READ (scoped to its own AGENT#/GRANT#
      // partitions plus the shared SKILL#*) ∪ its cap-derived grants. `agentcore-base`
      // carries NO DynamoDB statement, so this document is the agent's ONLY config-table access; the
      // builder throws rather than emit one without the scope, and it is never empty.
      const grantsDoc = P.derivedGrantsPolicyDocument(caps, ddbScope);

      // CREATE-first, NOT GetRole-first. A path-scoped grant (role/agentcore/*) authorizes
      // CreateRole by its requested Path, but iam:GetRole on a NOT-YET-EXISTENT role authorizes
      // against role/<name> (the request carries no path) → denied under the path grant. So try
      // CreateRole; on EntityAlreadyExists the role is already at /agentcore/ (we only ever create
      // there) → just refresh its trust. Name-only calls on an EXISTING role resolve its real path,
      // so UpdateAssumeRolePolicy/AttachRolePolicy/PutRolePolicy authorize fine. (Caught live: the
      // dispatcher's path-bounded task role hit AccessDenied on the old GetRole-first check; admin-
      // run tests missed it.)
      let created = false;
      try {
        await iam.send(new C.CreateRoleCommand({
          RoleName: roleName,
          Path: P.AGENTCORE_ROLE_PATH,
          AssumeRolePolicyDocument: trust,
          Description: 'AgentCore derived per-agent exec role (§9)',
        }));
        created = true;
      } catch (e) {
        if (e.name !== 'EntityAlreadyExists' && e.name !== 'EntityAlreadyExistsException') throw e;
        await iam.send(new C.UpdateAssumeRolePolicyCommand({ RoleName: roleName, PolicyDocument: trust }));
      }
      // base floor (managed) — idempotent attach; and the derived grants (inline, unconditional)
      await iam.send(new C.AttachRolePolicyCommand({ RoleName: roleName, PolicyArn: baseManagedPolicyArn }));
      await iam.send(new C.PutRolePolicyCommand({ RoleName: roleName, PolicyName: 'grants', PolicyDocument: JSON.stringify(grantsDoc) }));

      const roleArn = P.derivedRoleArn(account, agentId);
      if (logger && logger.info) logger.info({ msg: 'derived exec role ensured', agentId, roleName, roleArn, created, caps });
      // `created` is REPORTED, not just logged: IAM is eventually consistent, so a role that was just
      // minted may not yet be assumable by bedrock-agentcore, and CreateAgentRuntime surfaces that as
      // a ValidationException (live-caught 2026-08-10 — the retry absorbed it at ~3-6s of backoff).
      // Only a genuinely NEW role needs a propagation window; an adopted one has long since
      // propagated. The saga uses this to wait for new roles only — see ensureExecRole.
      return { roleArn, roleName, created };
    },
  };
}

// A3 (§9.5 step 4), COLLAPSED by §9.9c: a grant change is ALWAYS a live PutRolePolicy.
//
// This used to be a three-way decision ('none' / 'update' / 'recreate') because an agent could move
// between the fleet-shared base role and a dedicated one as its caps gained or lost an IAM-needing
// capability; `roleArn` is baked at CreateAgentRuntime, so crossing that tier boundary genuinely
// required deleting the runtime. Under universal per-agent roles there is NO crossing: the role is
// `role/agentcore/<agent>`, a pure function of the agent ID and not of its caps. So 'recreate' would
// now needlessly delete a live runtime the moment an agent gained its first IAM-needing cap (or lost
// its last), and 'none' would skip a rewrite that is always safe and, per §9.3, always sufficient —
// IAM evaluates at request time, so a WARM runtime picks up new grants with no restart.
//
// Kept as a named function (rather than inlined at the call site) so this reasoning has a home and so
// the tests can pin "a caps change is never a recreate" as a regression guard.
async function planGrantChange(_change = {}) {
  return { action: 'update' };
}

// Live update: rewrite the per-agent role's inline `grants` policy to the current caps.
//
// LOAD-BEARING: this policy is the agent's ONLY config-table access (`agentcore-base` carries no
// DynamoDB statement since §9.9), so it must ALWAYS be rewritten WITH the scoped read — hence
// account/region/table are required here exactly as they are in resolveDerivedRole, and the scope is
// assembled here from `agentId` rather than accepted pre-built (a caller-built scope could name a
// different agent). Two things this deliberately no longer does:
//   • build the document without a scope — the builder throws, so a cap-only rewrite is impossible
//   • delete the policy when there are no caps — that used to happen (empty caps → null document →
//     DeleteRolePolicy) and it revoked the agent's config read, breaking its next boot. A no-cap agent
//     still needs the scoped read, so the policy is always written, never removed.
async function putDerivedGrants({ clients, agentId, caps, account, region, table }) {
  const P = await pure();
  const iam = clients && clients.iam;
  const C = clients && clients.iamCmds;
  if (!iam || !C) throw new Error('putDerivedGrants: clients.iam + clients.iamCmds required');
  if (!account || !region || !table) throw new Error('putDerivedGrants: account, region + table required (they scope the per-agent config read this policy must keep)');
  const roleName = P.derivedRoleName(agentId);
  // The pointer is re-read here too: this writer runs on a LIVE agent whose pointer may have been
  // written after its role was built (adoption and migration both write pointers out-of-band), and a
  // rewrite that dropped the ARN would revoke a working key exactly like the §9.9c downgrade.
  const pointerArn = await readCredentialPointerArn(clients.doc, table, agentId);
  const doc = P.derivedGrantsPolicyDocument(caps, { agentId, account, region, table, credentialSecretBase: credentialSecretBase(), credentialSecretArn: pointerArn });
  try {
    await iam.send(new C.PutRolePolicyCommand({ RoleName: roleName, PolicyName: 'grants', PolicyDocument: JSON.stringify(doc) }));
  } catch (e) {
    // The role only exists once the agent has been provisioned. A grant change for an agent that has
    // never run has nothing to update — and nothing to lose: the cold provision reads GRANT#* from
    // DynamoDB and builds the full document (read + these caps) itself. Report it, don't throw.
    if (e.name === 'NoSuchEntity' || e.name === 'NoSuchEntityException') return { roleName, applied: false, reason: 'role-absent' };
    throw e;
  }
  return { roleName, applied: true };
}

// The provision-time decision.
//
// UNIVERSAL (was lazy). Every agent now gets its OWN role, because the per-agent config-table read
// (`ddbReadOwnScopeStatement`) is only expressible on a role belonging to one agent:
// `dynamodb:LeadingKeys` takes literal partition keys, so on a fleet-shared role the narrowest
// possible scope is the prefix AGENT#* — i.e. every agent's config and grants. The old lazy rule
// (`iamNeedsDedicatedRole`) existed to avoid per-agent IAM propagation on cold provision; §9.9c
// removed it outright — with roles universal it gated nothing, and planGrantChange no longer needs a
// tier predicate either (there is no tier to cross).
//
// `region`/`table` are required for the read statement; they identify the config table the scope
// applies to. Returns a role spec — never null on this path.
async function resolveDerivedRole({ doc, tableName, account, agentId, baseManagedPolicyArn, region, logger }) {
  const caps = await readAgentCaps(doc, tableName, agentId);
  if (!baseManagedPolicyArn) throw new Error('resolveDerivedRole: baseManagedPolicyArn required (Group B agentcore-base)');
  if (!region) throw new Error('resolveDerivedRole: region required (scopes the per-agent DynamoDB read)');
  if (!tableName) throw new Error('resolveDerivedRole: tableName required (scopes the per-agent DynamoDB read)');
  const ddbScope = {
    agentId, account, region, table: tableName,
    credentialSecretBase: credentialSecretBase(),
    credentialSecretArn: await readCredentialPointerArn(doc, tableName, agentId),
  };
  if (logger && logger.info) logger.info({ agentId, caps, ddbScope }, 'derived exec role: per-agent role + scoped config read');
  return deriveExecRoleSpec({ account, agentId, caps, baseManagedPolicyArn, ddbScope });
}

module.exports = { readAgentCaps, deriveExecRoleSpec, resolveDerivedRole, planGrantChange, putDerivedGrants };

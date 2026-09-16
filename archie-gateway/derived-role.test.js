'use strict';

// A2 unit tests (vitest). Exercise the lazy decision + the idempotent ensure() SDK dance with
// injected fakes — no live AWS. The cap→IAM correctness itself is covered by the ESM's own tests
// (config-resolver/derive-exec-role.test.mjs + skill-iam-requirements.test.mjs); here we prove the
// dispatcher glue: GRANT#* read, base-vs-dedicated branch, and the create/attach/put sequence.

// vitest globals enabled via vitest.config.js
const { readAgentCaps, deriveExecRoleSpec, resolveDerivedRole, planGrantChange, putDerivedGrants } = require('./derived-role');

const ACCOUNT = '203366135563';
const TABLE = 'agent-4ggvzl-config';
const BASE_POLICY = `arn:aws:iam::${ACCOUNT}:policy/agentcore-base`;

// A fake DynamoDB doc client returning a canned agent-wide grant item. Records the Key it was asked
// for so a test can pin the PARTITION (see the escalation-guard test below); the canned Item is
// returned regardless of Key, so key-shape assertions must be explicit.
function fakeDoc(grantData) {
  const keys = [];
  return {
    keys,
    async send(cmd) {
      keys.push(cmd.input && cmd.input.Key);
      return grantData === undefined ? {} : { Item: { data: JSON.stringify(grantData) } };
    },
  };
}

// A fake IAM client that records every command. CreateRole-first: an existing role makes
// CreateRole throw EntityAlreadyExists (the get-or-create signal), matching the live IAM contract.
function fakeIam({ roleExists = false } = {}) {
  const calls = [];
  return {
    calls,
    async send(cmd) {
      const name = cmd.constructor.name;
      calls.push({ name, input: cmd.input });
      if (name === 'CreateRoleCommand' && roleExists) {
        const e = new Error('exists'); e.name = 'EntityAlreadyExists'; throw e;
      }
      return {};
    },
  };
}

// Real IAM command classes (installed in the dispatcher) so cmd.constructor.name is meaningful.
function iamCmds() {
  return require('@aws-sdk/client-iam');
}
function clientsWith(iam) {
  return { iam, iamCmds: iamCmds() };
}

describe('readAgentCaps', () => {
  it('parses caps from GRANT#* — both the new {cap:{sources}} shape and legacy {capabilities:[]}', async () => {
    // §8.4 provenance shape (current)
    expect((await readAgentCaps(fakeDoc({ 'aws-readonly': { sources: ['skill:x'] }, datadog: { sources: ['agent-base'] } }), TABLE, 'a')).sort())
      .toEqual(['aws-readonly', 'datadog']);
    // legacy flat shape (during migration)
    expect(await readAgentCaps(fakeDoc({ capabilities: ['aws-readonly', 'datadog'] }), TABLE, 'a')).toEqual(['aws-readonly', 'datadog']);
  });
  // SECURITY REGRESSION GUARD. Grants must live in their OWN partition (GRANT#<id>/SCOPE#*), not
  // under the agent's own partition, so that no table write a runtime might hold can reach the grants
  // that police it — an agent able to rewrite its own grants escalates its own tool surface.
  //
  // CORRECTION (2026-08-25). This comment used to assert as fact that "every AgentCore runtime role
  // holds dynamodb:PutItem/UpdateItem on this table (it persists its own AGENT#<id>/SEED)", pinned by
  // LeadingKeys AGENT#*. The deployed IAM says otherwise: `archie-agentcore-base` — the only managed
  // policy attached to a derived role — has ZERO dynamodb statements, and the inline `grants` document
  // carries only DdbReadOwnScope (GetItem/Query/BatchGetItem). A derived role cannot write this table
  // at all today. The claim is left recorded rather than deleted because believing it is what almost
  // blocked the POLICY read below as a self-escalation path.
  //
  // The partition split is still right, and the guard still earns its place — it is defence for the
  // day a write IS added, which is the event that would make it load-bearing again.
  it('reads the agent-wide grant from its OWN partition — never AGENT#<id> (self-escalation guard)', async () => {
    const doc = fakeDoc({ 'aws-readonly': { sources: ['skill:x'] } });
    await readAgentCaps(doc, TABLE, 'dm-u123');
    // THE GRANT still comes from its own partition. That is the load-bearing assertion and it is
    // unchanged: the grant read must never be AGENT#<id>, whose sort keys sit inside whatever write
    // scope a runtime holds.
    expect(doc.keys).toContainEqual({ pk: 'GRANT#dm-u123', sk: 'SCOPE#*' });
    expect(doc.keys.some((k) => k.pk === 'AGENT#dm-u123' && k.sk.startsWith('GRANT'))).toBe(false);
    // The POLICY row is read too, and it IS in the agent's own partition — which is safe only because
    // a derived role cannot write this table AT ALL. Verified against the deployed IAM (2026-08-25):
    // `archie-agentcore-base`, the only managed policy attached, has ZERO dynamodb statements, and the
    // inline `grants` document carries just DdbReadOwnScope (GetItem/Query/BatchGetItem). An earlier
    // version of this comment claimed a `DdbWriteOwnAgentPartition` write pinned to LeadingKeys
    // AGENT#* — that statement is not in the deployed policy, and reasoning from it is what nearly
    // made this read look like a self-escalation path.
    //
    // SO THE CHECK THAT MATTERS IS NOT THE KEY, IT IS THE WRITE SCOPE. If a runtime ever gains a table
    // write, this read becomes an escalation: an agent could grant itself sts:AssumeRole on a
    // cross-account reader by writing one item. Re-verify the base policy before adding any write.
    expect(doc.keys).toContainEqual({ pk: 'AGENT#dm-u123', sk: 'POLICY' });
  });
  it('missing item / no data / bad JSON → []', async () => {
    expect(await readAgentCaps(fakeDoc(undefined), TABLE, 'a')).toEqual([]);
    expect(await readAgentCaps({ async send() { return { Item: { data: 'not json' } }; } }, TABLE, 'a')).toEqual([]);
  });
});

// INTENTIONAL BEHAVIOUR CHANGE (§9.9): resolveDerivedRole was LAZY — it returned null for an agent
// with no IAM-needing capability, so that agent ran on the fleet-shared role. It is now UNIVERSAL:
// every agent gets its own role. The two tests that asserted the lazy contract are rewritten below
// (not deleted) to assert the new contract, because the reason for the change is a security
// property that needs its own coverage:
//
//   The per-agent config-table read (ddbReadOwnScopeStatement) uses `dynamodb:LeadingKeys`, which
//   takes LITERAL partition keys. On a role shared by the whole fleet the narrowest read expressible
//   is the prefix AGENT#* — every agent's config and grants. "Read only your own scope" is therefore
//   only achievable on a role that belongs to exactly one agent.
//
// §9.9c finished the job: `iamNeedsDedicatedRole` is GONE (no caller could remain — see the
// planGrantChange block at the bottom of this file), and the scoped read is now mandatory on BOTH
// writers of the inline `grants` policy (provision-time ensure() and the live grant-change rewrite).
const REGION = 'us-east-1';
const DDB_SCOPE = (agentId = 'a') => ({ agentId, account: ACCOUNT, region: REGION, table: TABLE });
const resolve = (capsData, over = {}) => resolveDerivedRole({
  doc: fakeDoc(capsData), tableName: TABLE, account: ACCOUNT, agentId: 'dm-u1',
  baseManagedPolicyArn: BASE_POLICY, region: REGION, ...over,
});

describe('resolveDerivedRole — universal per-agent roles', () => {
  it('NO IAM-needing grant STILL gets its own role (was null → shared role)', async () => {
    const spec = await resolve({ capabilities: ['datadog', 'fs.write'] });
    expect(spec).not.toBeNull();
    expect(typeof spec.ensure).toBe('function');
  });
  it('an IAM-needing grant → a role spec', async () => {
    const spec = await resolve({ capabilities: ['aws-readonly'] });
    expect(spec).not.toBeNull();
    expect(typeof spec.ensure).toBe('function');
  });
  it('throws without a base policy ARN', async () => {
    await expect(resolve({ capabilities: ['aws-readonly'] }, { baseManagedPolicyArn: undefined }))
      .rejects.toThrow(/baseManagedPolicyArn required/);
  });
  // region/table are what the scoped read is expressed against. Silently omitting them would mint a
  // role with NO config-table access at all (agentcore-base carries none), so the agent would fail
  // to boot with an opaque AccessDenied — fail loudly at provision instead.
  it('throws without region or tableName — the scoped read cannot be built', async () => {
    await expect(resolve({ capabilities: [] }, { region: undefined })).rejects.toThrow(/region required/);
    await expect(resolve({ capabilities: [] }, { tableName: undefined })).rejects.toThrow(/tableName required/);
  });
});

describe('the per-agent scoped read (the reason roles are per-agent)', () => {
  it('inline policy reads ONLY this agent\'s partitions + the shared library', async () => {
    const spec = await resolve({ capabilities: [] });
    const iam = fakeIam();
    await spec.ensure({ clients: clientsWith(iam) });
    const put = iam.calls.find((c) => c.name === 'PutRolePolicyCommand');
    expect(put).toBeTruthy();
    const doc = JSON.parse(put.input.PolicyDocument);
    const read = doc.Statement.find((s) => s.Sid === 'DdbReadOwnScope');
    expect(read).toBeTruthy();
    expect(read.Action).toEqual(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:BatchGetItem']);
    // FOUR partitions. `OAUTH#<id>` joined with the v2 OAuth callback flow — the agent reads the
    // callbacks that landed for it. It is a SEPARATE partition rather than a sort key under
    // AGENT#<id> deliberately: IAM has no sort-key condition, so a callback row under AGENT# would
    // have forced the internet-facing callback Lambda's WRITE grant to `LeadingKeys AGENT#*`, which
    // also covers CONFIG (the tool surface the agent is policed on) and META (routing). Keeping them
    // apart is what stops the public side reopening that escalation, so the shape is the point and
    // this list is the assertion that holds it.
    expect(read.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'])
      .toEqual(['AGENT#dm-u1', 'GRANT#dm-u1', 'OAUTH#dm-u1', 'SKILL#*']);
  });
  it('grants NO write verb anywhere — the runtime is read-only on the config table', async () => {
    const spec = await resolve({ capabilities: ['aws-readonly'] });
    const iam = fakeIam();
    await spec.ensure({ clients: clientsWith(iam) });
    const doc = JSON.parse(iam.calls.find((c) => c.name === 'PutRolePolicyCommand').input.PolicyDocument);
    const writes = doc.Statement
      .flatMap((s) => [].concat(s.Action))
      .filter((a) => /^dynamodb:(Put|Update|Delete|BatchWrite|TransactWrite)/.test(a));
    expect(writes).toEqual([]);
  });
  it('another agent\'s partitions are NOT in the allow-list', async () => {
    const spec = await resolve({ capabilities: [] }, { agentId: 'dm-victim' });
    const iam = fakeIam();
    await spec.ensure({ clients: clientsWith(iam) });
    const doc = JSON.parse(iam.calls.find((c) => c.name === 'PutRolePolicyCommand').input.PolicyDocument);
    const keys = doc.Statement.find((s) => s.Sid === 'DdbReadOwnScope').Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];
    expect(keys).toContain('AGENT#dm-victim');
    expect(keys).not.toContain('AGENT#dm-u1');
    // No bare prefix wildcard on the agent/grant partitions — that would readmit the whole fleet.
    expect(keys).not.toContain('AGENT#*');
    expect(keys).not.toContain('GRANT#*');
  });
});

describe('deriveExecRoleSpec.ensure — idempotent create/attach/put', () => {
  it('role ABSENT → CreateRole (under /agentcore/, path-authorizable) + Attach(base) + Put(grants), NO GetRole', async () => {
    const iam = fakeIam({ roleExists: false });
    const spec = deriveExecRoleSpec({ account: ACCOUNT, agentId: 'bdd-iam', caps: ['sandbox-probe'], baseManagedPolicyArn: BASE_POLICY, ddbScope: DDB_SCOPE('bdd-iam') });
    const { roleArn, roleName } = await spec.ensure({ clients: clientsWith(iam) });

    expect(roleName).toBe('bdd-iam');
    expect(roleArn).toBe(`arn:aws:iam::${ACCOUNT}:role/agentcore/bdd-iam`);
    const seq = iam.calls.map((c) => c.name);
    // CreateRole-first (no GetRole — it would AccessDeny under a path-scoped grant for a new role).
    expect(seq).toEqual(['CreateRoleCommand', 'AttachRolePolicyCommand', 'PutRolePolicyCommand']);
    expect(seq).not.toContain('GetRoleCommand');

    const create = iam.calls.find((c) => c.name === 'CreateRoleCommand');
    expect(create.input.Path).toBe('/agentcore/');
    expect(create.input.AssumeRolePolicyDocument).toContain('bedrock-agentcore.amazonaws.com');

    const attach = iam.calls.find((c) => c.name === 'AttachRolePolicyCommand');
    expect(attach.input.PolicyArn).toBe(BASE_POLICY);

    const put = iam.calls.find((c) => c.name === 'PutRolePolicyCommand');
    expect(put.input.PolicyName).toBe('grants');
    expect(put.input.PolicyDocument).toContain('iam:ListAccountAliases'); // the sandbox-probe grant
  });

  it('role PRESENT → CreateRole throws EntityAlreadyExists → UpdateAssumeRolePolicy + reconcile attach/put', async () => {
    const iam = fakeIam({ roleExists: true });
    const spec = deriveExecRoleSpec({ account: ACCOUNT, agentId: 'a', caps: ['aws-readonly'], baseManagedPolicyArn: BASE_POLICY, ddbScope: DDB_SCOPE() });
    await spec.ensure({ clients: clientsWith(iam) });
    const seq = iam.calls.map((c) => c.name);
    expect(seq).toEqual(['CreateRoleCommand', 'UpdateAssumeRolePolicyCommand', 'AttachRolePolicyCommand', 'PutRolePolicyCommand']);
  });

  it('ensure requires an IAM client + command bundle', async () => {
    const spec = deriveExecRoleSpec({ account: ACCOUNT, agentId: 'a', caps: ['aws-readonly'], baseManagedPolicyArn: BASE_POLICY, ddbScope: DDB_SCOPE() });
    await expect(spec.ensure({ clients: {} })).rejects.toThrow(/clients.iam \+ clients.iamCmds required/);
  });

  // FAIL-CLOSED. A spec without a scope would happily mint a role whose inline policy is cap
  // statements only — and since agentcore-base carries no DynamoDB, that role cannot read the config table
  // and the agent dies on its next boot with an opaque AccessDenied. Refuse at construction, where
  // the missing argument actually is, rather than half-way through the provisioning saga.
  it('constructing a spec WITHOUT ddbScope throws — a scope-less role cannot boot', () => {
    expect(() => deriveExecRoleSpec({ account: ACCOUNT, agentId: 'a', caps: ['aws-readonly'], baseManagedPolicyArn: BASE_POLICY }))
      .toThrow(/ddbScope required/);
  });
});

// INTENTIONAL BEHAVIOUR CHANGE (§9.9c). The two 'recreate' assertions below previously pinned the
// tier-crossing rule and are rewritten, not deleted, because the rule became WRONG rather than
// untested. It existed while an agent could move between the fleet-shared base role and a dedicated
// one: roleArn is baked at CreateAgentRuntime, so crossing that boundary required deleting the
// runtime. Roles are now universal and per-agent — role/agentcore/<agent> is a function of the agent
// ID, NOT of its caps — so nothing about a caps change can alter roleArn, and 'recreate' would have
// destroyed a live, healthy runtime the first time an agent gained an IAM-needing cap or lost its
// last one. Every grant change is a live PutRolePolicy (§9.3: IAM evaluates at request time, so a
// warm runtime picks the new grants up with no restart).
describe('planGrantChange — every grant change is a LIVE update (no tier to cross)', () => {
  const cases = [
    ['no IAM caps either side', { oldCaps: ['datadog'], newCaps: ['datadog', 'fs.write'] }],
    ['IAM caps both sides', { oldCaps: ['aws-readonly'], newCaps: ['aws-readonly', 'cloudwatch-logs'] }],
    ['gaining the FIRST IAM-needing cap (was: recreate)', { oldCaps: ['datadog'], newCaps: ['aws-readonly'] }],
    ['losing the LAST IAM-needing cap (was: recreate)', { oldCaps: ['aws-readonly'], newCaps: [] }],
    ['no caps at all either side', { oldCaps: [], newCaps: [] }],
  ];
  it.each(cases)('%s → update', async (_label, change) => {
    expect((await planGrantChange(change)).action).toBe('update');
  });
  it('NEVER returns recreate — deleting a live runtime for a caps change is no longer a thing', async () => {
    for (const [, change] of cases) {
      expect((await planGrantChange(change)).action).not.toBe('recreate');
    }
  });
});

// REGRESSION GUARD for a live latent bug (found 2026-08-10, shipped by §9.9's DDB move).
//
// `putDerivedGrants` is the SECOND writer of the inline `grants` policy — the one the marketplace hook
// (install/uninstall → _reconcileSkillGrant → applyDerivedRoleGrantChange) drives against a WORKING
// agent. Since §9.9 moved the config-table read off the shared `agentcore-base` managed policy and
// into this inline policy, that policy is the agent's ONLY config-table access. The rewrite therefore
// has to carry the scoped read every single time: it used to be built from caps alone, so any skill
// install silently downgraded the role to cap statements only — and an install that left the agent
// with no IAM-needing caps produced a null document, which the old code turned into DeleteRolePolicy,
// removing config-table access outright. Either way the agent's NEXT boot fails (it cannot read
// the SKILL#* library, or its own grants) — and nothing about the install looks wrong.
describe('putDerivedGrants — live update must PRESERVE the scoped config read', () => {
  const args = (over = {}) => ({ agentId: 'a', account: ACCOUNT, region: REGION, table: TABLE, ...over });
  const docFrom = (iam) => JSON.parse(iam.calls.find((c) => c.name === 'PutRolePolicyCommand').input.PolicyDocument);

  it('rewrites the inline `grants` policy to the new caps', async () => {
    const iam = fakeIam({ roleExists: true });
    await putDerivedGrants({ clients: clientsWith(iam), ...args({ caps: ['aws-readonly', 'cloudwatch-logs'] }) });
    const put = iam.calls.find((c) => c.name === 'PutRolePolicyCommand');
    expect(put.input.RoleName).toBe('a');
    expect(put.input.PolicyName).toBe('grants');
    expect(put.input.PolicyDocument).toContain('sts:AssumeRole'); // the reader assume grants
  });

  it('keeps DdbReadOwnScope, scoped to THIS agent, alongside the new caps', async () => {
    const iam = fakeIam({ roleExists: true });
    await putDerivedGrants({ clients: clientsWith(iam), ...args({ agentId: 'dm-u1', caps: ['aws-readonly'] }) });
    const doc = docFrom(iam);
    const read = doc.Statement.find((s) => s.Sid === 'DdbReadOwnScope');
    expect(read).toBeTruthy();
    expect(read.Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'])
      .toEqual(['AGENT#dm-u1', 'GRANT#dm-u1', 'OAUTH#dm-u1', 'SKILL#*']);
    expect(read.Resource[0]).toBe(`arn:aws:dynamodb:${REGION}:${ACCOUNT}:table/${TABLE}`);
  });

  it('EMPTY caps still write the policy — never DeleteRolePolicy (that revoked the config read)', async () => {
    const iam = fakeIam({ roleExists: true });
    await putDerivedGrants({ clients: clientsWith(iam), ...args({ caps: [] }) });
    expect(iam.calls.map((c) => c.name)).toEqual(['PutRolePolicyCommand']);
    expect(iam.calls.map((c) => c.name)).not.toContain('DeleteRolePolicyCommand');
    expect(docFrom(iam).Statement.map((s) => s.Sid)).toEqual(['DdbReadOwnScope']);
  });

  // The two writers must agree: whatever a grant change writes has to be exactly what a cold provision
  // would write for the same agent + caps. If they can diverge, one of them is a downgrade.
  it('writes the SAME document a cold provision would for the same agent + caps', async () => {
    const caps = ['aws-readonly', 'cloudwatch-logs'];
    const provIam = fakeIam({ roleExists: true });
    await deriveExecRoleSpec({ account: ACCOUNT, agentId: 'a', caps, baseManagedPolicyArn: BASE_POLICY, ddbScope: DDB_SCOPE() })
      .ensure({ clients: clientsWith(provIam) });
    const liveIam = fakeIam({ roleExists: true });
    await putDerivedGrants({ clients: clientsWith(liveIam), ...args({ caps }) });
    expect(docFrom(liveIam)).toEqual(docFrom(provIam));
  });

  // Fail-closed on the inputs, exactly as resolveDerivedRole does: the scope cannot be defaulted or
  // inferred, and a silent omission is what produced the downgrade above.
  it('throws without account/region/table — no silent scope-less rewrite', async () => {
    const iam = fakeIam({ roleExists: true });
    for (const missing of ['account', 'region', 'table']) {
      await expect(putDerivedGrants({ clients: clientsWith(iam), ...args({ caps: [], [missing]: undefined }) }))
        .rejects.toThrow(/account, region \+ table required/);
    }
    expect(iam.calls).toEqual([]); // nothing written on the way to throwing
  });

  // Same shape of bug, different grant. A migrated agent reads its Connector key from
  // `<base>-<agentId>`, and that read is expressible ONLY on a per-agent role (agentcore-base is
  // shared, so a Connector statement there would let any agent read any other's key and reach another
  // person's connected accounts). So it lives in this inline document — which means a grants rewrite
  // that forgot it would revoke a working agent's Connector access with nothing failing at write time,
  // exactly like the config-read downgrade above. Both writers must therefore agree.
  describe('with a Connector base configured', () => {
    const BASE = 'agent-gn0p84-connector-api-key';
    let prev;
    beforeEach(() => { prev = process.env.CONNECTOR_API_KEY_SECRET; process.env.CONNECTOR_API_KEY_SECRET = BASE; });
    afterEach(() => { if (prev === undefined) delete process.env.CONNECTOR_API_KEY_SECRET; else process.env.CONNECTOR_API_KEY_SECRET = prev; });

    // The live-rewrite path must ALSO carry the pointer ARN. It runs on a WORKING agent whose
    // pointer may have been written after its role was built — adoption and migration both write
    // pointers out-of-band — so a rewrite that read no pointer would revoke a key that is in use.
    it('a live rewrite re-reads the POINTER and keeps granting its ARN', async () => {
      const iam = fakeIam({ roleExists: true });
      const POINTER = 'arn:aws:secretsmanager:us-east-1:361364274007:secret:archie-oss-connector-api-key-a-AbC123';
      const doc = { async send() { return { Item: { data: JSON.stringify({ secretArn: POINTER }) } }; } };
      await putDerivedGrants({ clients: { ...clientsWith(iam), doc }, ...args({ caps: [] }) });
      const s = docFrom(iam).Statement.find((x) => x.Sid === 'ConnectorOwnKey');
      expect(s.Resource).toContain(POINTER);
      expect(s.Resource.some((r) => r.endsWith(`${BASE}-a-??????`))).toBe(true);
    });

    // REGRESSION (audit, 2026-08-14). readCredentialPointerArn used to `catch { return null }`, so a
    // throttle or AccessDenied on the pointer read was indistinguishable from "no pointer" — and this
    // writer rebuilds the WHOLE inline policy from the result. The rewrite therefore dropped the exact
    // secret ARN (revoking an adopted agent's key) and dropped ConnectorDenySharedKey (restoring its
    // access to the shared project), silently, triggered by an unrelated skill install.
    //
    // A failed read must now ABANDON the rewrite rather than write a policy built from it.
    it('a FAILED pointer read aborts the rewrite — it never writes a policy without the ARN', async () => {
      const iam = fakeIam({ roleExists: true });
      const doc = { async send() { const e = new Error('Throttling'); e.name = 'ThrottlingException'; throw e; } };
      await expect(putDerivedGrants({ clients: { ...clientsWith(iam), doc }, ...args({ caps: [] }) }))
        .rejects.toThrow(/Throttling/);
      // The critical assertion: NOTHING was written. A policy built from a bad read is worse than none.
      expect(iam.calls.filter((c) => c.name === 'PutRolePolicyCommand')).toEqual([]);
    });

    // A genuine absence is NOT a failure: an un-migrated agent legitimately has no pointer, and must
    // still get its role rewritten (with the name pattern and no Deny).
    it('an ABSENT pointer still rewrites — absence is not failure', async () => {
      const iam = fakeIam({ roleExists: true });
      const doc = { async send() { return {}; } }; // no Item
      await putDerivedGrants({ clients: { ...clientsWith(iam), doc }, ...args({ caps: [] }) });
      const sids = docFrom(iam).Statement.map((x) => x.Sid);
      expect(sids).toContain('ConnectorOwnKey');
      expect(sids).not.toContain('ConnectorDenySharedKey');
    });

    it('no doc client → name pattern only, never a crash', async () => {
      const iam = fakeIam({ roleExists: true });
      await putDerivedGrants({ clients: clientsWith(iam), ...args({ caps: [] }) });
      const s = docFrom(iam).Statement.find((x) => x.Sid === 'ConnectorOwnKey');
      expect(s.Resource).toEqual([`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${BASE}-a-??????`]);
    });

    it('a live rewrite carries ConnectorOwnKey, scoped to THIS agent only', async () => {
      const iam = fakeIam({ roleExists: true });
      await putDerivedGrants({ clients: clientsWith(iam), ...args({ agentId: 'agent-xx9aff', caps: [] }) });
      const s = docFrom(iam).Statement.find((x) => x.Sid === 'ConnectorOwnKey');
      expect(s).toBeTruthy();
      // Bounded to Secrets Manager's six-character suffix: a trailing `-*` would let an agent named
      // `sandbox` match `…-agent-xx9aff-Ab12Cd`.
      expect(s.Resource).toEqual([`arn:aws:secretsmanager:${REGION}:${ACCOUNT}:secret:${BASE}-agent-xx9aff-??????`]);
      expect(s.Action).toEqual(['secretsmanager:GetSecretValue']);
    });

    it('cold provision writes the same statement — the two writers cannot diverge', async () => {
      const provIam = fakeIam({ roleExists: true });
      await deriveExecRoleSpec({
        account: ACCOUNT, agentId: 'a', caps: [], baseManagedPolicyArn: BASE_POLICY,
        ddbScope: { ...DDB_SCOPE(), credentialSecretBase: BASE },
      }).ensure({ clients: clientsWith(provIam) });
      const liveIam = fakeIam({ roleExists: true });
      await putDerivedGrants({ clients: clientsWith(liveIam), ...args({ caps: [] }) });
      expect(docFrom(liveIam)).toEqual(docFrom(provIam));
    });
  });

  // THE SAME SHAPE AGAIN, third grant: the artifacts prefix. It is derived from the SCOPE, not from
  // `caps` (files.publish is baseline, so it never appears in a GRANT# row), which means a writer that
  // forgot to pass the bucket would revoke save_artifact on a working agent with nothing failing at
  // write time. Both writers read it from the same env var, so both are pinned here.
  describe('with an artifacts bucket configured', () => {
    const BUCKET = 'archie-artifacts-203366135563';
    let prev;
    beforeEach(() => { prev = process.env.ARTIFACTS_S3_BUCKET; process.env.ARTIFACTS_S3_BUCKET = BUCKET; });
    afterEach(() => { if (prev === undefined) delete process.env.ARTIFACTS_S3_BUCKET; else process.env.ARTIFACTS_S3_BUCKET = prev; });

    it('a live rewrite carries S3OwnArtifactsPrefix, scoped to THIS agent only', async () => {
      const iam = fakeIam({ roleExists: true });
      await putDerivedGrants({ clients: clientsWith(iam), ...args({ agentId: 'dm-u0abc', caps: [] }) });
      const s = docFrom(iam).Statement.find((x) => x.Sid === 'S3OwnArtifactsPrefix');
      expect(s).toBeTruthy();
      expect(s.Resource).toEqual(`arn:aws:s3:::${BUCKET}/dm-u0abc/*`);
      expect(s.Action).not.toContain('s3:ListBucket');
    });

    it('cold provision writes the same statement — the two writers cannot diverge', async () => {
      const provIam = fakeIam({ roleExists: true });
      await deriveExecRoleSpec({
        account: ACCOUNT, agentId: 'a', caps: [], baseManagedPolicyArn: BASE_POLICY,
        ddbScope: { ...DDB_SCOPE(), artifactsBucket: BUCKET },
      }).ensure({ clients: clientsWith(provIam) });
      const liveIam = fakeIam({ roleExists: true });
      await putDerivedGrants({ clients: clientsWith(liveIam), ...args({ caps: [] }) });
      expect(docFrom(liveIam)).toEqual(docFrom(provIam));
    });
  });

  // A grant change for an agent that has never been provisioned has no role to update — and nothing to
  // lose, since the cold provision builds the full document from DDB itself. Report, don't throw (the
  // marketplace hook would otherwise log a scary non-fatal warning on every install for such agents).
  it('role not yet created → reports role-absent instead of throwing', async () => {
    const iam = {
      calls: [],
      async send(cmd) {
        iam.calls.push(cmd.constructor.name);
        const e = new Error('no role'); e.name = 'NoSuchEntity'; throw e;
      },
    };
    const r = await putDerivedGrants({ clients: clientsWith(iam), ...args({ caps: [] }) });
    expect(r).toEqual({ roleName: 'a', applied: false, reason: 'role-absent' });
  });
});

// ---------- pinned capabilities reach IAM ----------
//
// The bug this closes, seen live: person79b333 holds `aws-readonly` by PIN, its runtime resolved the tool and
// the PEP allowed the call, and the assume failed —
//   AccessDenied: .../assumed-role/ch-c66pp782t9k/... is not authorized to perform: sts:AssumeRole
//   on .../role/clawdbot-cross-account-readonly-reader
// because hydration strips policy-owned caps from GRANT#* (migrate-to-ddb R1) and this function fed
// IAM from the grant row alone. Correct for the PEP, which reads the policy; fatal for IAM, which has
// no policy to read.

function fakeDocRows({ grant, policy }) {
  const keys = [];
  return {
    keys,
    async send(cmd) {
      const k = cmd.input && cmd.input.Key;
      keys.push(k);
      const row = k.sk === 'POLICY' ? policy : grant;
      return row === undefined ? {} : { Item: { data: JSON.stringify(row) } };
    },
  };
}

describe('readAgentCaps: the effective set is grant ∪ policy-allowed', () => {
  it('a PINNED cap absent from the grant row still reaches IAM', async () => {
    const caps = await readAgentCaps(fakeDocRows({
      grant: { 'fs.write': { sources: ['agent-base'] } },          // exactly what hydration leaves
      policy: { verdicts: { 'aws-readonly': 'allow', airflow: 'deny' } },
    }), TABLE, 'ch-c66pp782t9k');
    expect(caps).toEqual(['aws-readonly', 'fs.write']);
  });

  it('a DENIED cap contributes nothing — no IAM for a capability the policy refuses', async () => {
    // The direction that matters for blast radius: a deny must not hand out sts:AssumeRole on a
    // cross-account reader. Every capability in CAP_IAM_REQUIREMENTS is an assume except datadog.
    const caps = await readAgentCaps(fakeDocRows({
      grant: {},
      policy: { verdicts: { 'aws-readonly': 'deny', 'cloudwatch-logs': 'deny' } },
    }), TABLE, 'a');
    expect(caps).toEqual([]);
  });

  it('a cap in BOTH rows appears once', async () => {
    const caps = await readAgentCaps(fakeDocRows({
      grant: { 'aws-readonly': { sources: ['skill:x'] } },
      policy: { verdicts: { 'aws-readonly': 'allow' } },
    }), TABLE, 'a');
    expect(caps).toEqual(['aws-readonly']);
  });

  it('a missing or unreadable POLICY row leaves the grant caps intact', async () => {
    // Provisioning must not become dependent on a published policy: a scope minted before the first
    // publish has no POLICY row, and it still has to get a role.
    expect(await readAgentCaps(fakeDocRows({
      grant: { 'fs.write': { sources: ['agent-base'] } }, policy: undefined,
    }), TABLE, 'a')).toEqual(['fs.write']);
  });
});

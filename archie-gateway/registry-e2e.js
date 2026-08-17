'use strict';

// Live runtime-registry E2E (provisioning-queue-plan.md). Exercises the REAL registry against the REAL
// DynamoDB table, then deletes its probe rows.
//
// WHY THIS EXISTS, SPECIFICALLY. `agent` is a DynamoDB reserved keyword. Using it unaliased in
// record()'s UpdateExpression threw "Invalid UpdateExpression: Attribute name is a reserved keyword" on
// every provision and broke every turn for every agent (live, 2026-08-13). The unit tests could not have
// caught it: they assert on the command SHAPE against a fake doc client, so they happily asserted the
// broken expression string. Only DynamoDB knows the ~570-word reserved list.
//
// So the rule is now two-layered, and this is the outer layer:
//   * runtime-registry.test.js enforces MECHANICALLY that every attribute name is aliased (no AWS).
//   * this script proves DynamoDB actually accepts every expression we send (real AWS).
// Run it after any change to an expression in runtime-registry.js.
//
// Env: AGENT_CONFIG_TABLE (required), AWS_REGION (default us-east-1).
// Safe to run against a live table: it touches only RUNTIME#_e2e-registry-probe and deletes it after.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { createRuntimeRegistry } = require('./runtime-registry');

const TABLE = process.env.AGENT_CONFIG_TABLE;
const REGION = process.env.AWS_REGION || 'us-east-1';
// Leading underscore so it can never collide with a real agent id, and so a leaked row is obvious.
const AGENT = '_e2e-registry-probe';
const GEN_A = 'oc_e2e_aaaaaaaa';
const GEN_B = 'oc_e2e_bbbbbbbb';

const checks = [];
const check = (n, ok, d) => { checks.push({ n, ok: !!ok }); console.log(ok ? 'PASS ' : 'FAIL ', n, d !== undefined ? JSON.stringify(d) : ''); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TABLE) throw new Error('AGENT_CONFIG_TABLE is required');
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
  const reg = createRuntimeRegistry({ tableName: TABLE, doc: () => doc });

  try {
    // ── record + get ────────────────────────────────────────────────────────────────────────────
    await reg.record(AGENT, GEN_A, { arn: 'arn:probe:a', runtimeId: 'rt-a' });
    const a1 = await reg.get(AGENT, GEN_A);
    check('record + consistent get', a1 && a1.arn === 'arn:probe:a' && a1.runtimeId === 'rt-a', a1);
    check('createdAt written', !!a1?.createdAt, a1?.createdAt);
    const createdAt = a1?.createdAt;

    // ── reprovisioning the SAME generation keeps its original createdAt ─────────────────────────
    // The name is a spec fingerprint, so a runtime that died and was remade lands on the identical
    // row; overwriting createdAt would make history read as new.
    await sleep(1100);
    await reg.record(AGENT, GEN_A, { arn: 'arn:probe:a2', runtimeId: 'rt-a2' });
    const a2 = await reg.get(AGENT, GEN_A);
    check('reprovision keeps original createdAt', a2.createdAt === createdAt, { was: createdAt, now: a2.createdAt });
    check('reprovision updates the arn', a2.arn === 'arn:probe:a2');
    check('updatedAt advanced', a2.updatedAt !== createdAt);

    // ── listGenerations: one agent partition ────────────────────────────────────────────────────
    await reg.record(AGENT, GEN_B, { arn: 'arn:probe:b', runtimeId: 'rt-b' });
    const rows = await reg.listGenerations(AGENT);
    check('listGenerations returns both generations', rows.length === 2, rows.map((r) => r.runtimeName));
    check('runtimeName decoded from the sort key', rows.every((r) => r.runtimeName.startsWith('oc_e2e_')));

    // ── the CONDITIONAL clear ───────────────────────────────────────────────────────────────────
    // The condition is what stops an eviction discarding a runtime another turn just provisioned.
    check('clearArn with a stale arn is refused', (await reg.clearArn(AGENT, GEN_B, 'arn:WRONG')) === false);
    check('...and the row is untouched', (await reg.get(AGENT, GEN_B)).arn === 'arn:probe:b');
    check('clearArn with the recorded arn succeeds', (await reg.clearArn(AGENT, GEN_B, 'arn:probe:b')) === true);
    const bCleared = await reg.get(AGENT, GEN_B);
    check('arn removed but the row survives as history', bCleared && bCleared.arn === undefined && !!bCleared.clearedAt);

    // ── clearByArn: the invoke path knows the arn, not the name ─────────────────────────────────
    check('clearByArn locates the holding generation', (await reg.clearByArn(AGENT, 'arn:probe:a2')) === true);
    check('clearByArn cleared the right row', (await reg.get(AGENT, GEN_A)).arn === undefined);
    check('clearByArn on an unknown arn is a no-op', (await reg.clearByArn(AGENT, 'arn:nope')) === false);

    // ── markReaped keeps the row; re-recording revives it ───────────────────────────────────────
    await reg.record(AGENT, GEN_A, { arn: 'arn:probe:a3', runtimeId: 'rt-a3' });
    await reg.markReaped(AGENT, GEN_A);
    const reaped = await reg.get(AGENT, GEN_A);
    check('markReaped keeps the row, drops the claim', reaped && reaped.arn === undefined && !!reaped.reapedAt);
    await reg.record(AGENT, GEN_A, { arn: 'arn:probe:a4' });
    check('re-recording clears reapedAt', (await reg.get(AGENT, GEN_A)).reapedAt === undefined);
  } finally {
    // Cleanup uses DeleteCommand, which the DISPATCHER's own role deliberately cannot do (rows are
    // never deleted in normal operation) — so this script needs admin credentials for teardown only.
    for (const gen of [GEN_A, GEN_B]) {
      await doc.send(new DeleteCommand({ TableName: TABLE, Key: { pk: `RUNTIME#${AGENT}`, sk: `GEN#${gen}` } }))
        .catch((e) => console.warn('WARN  probe row cleanup failed', gen, e.message));
    }
    console.log('cleaned up probe rows');
  }

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) {
    console.error('FAILED:', failed.map((f) => f.n).join(', '));
    process.exit(1);
  }
}

main().catch((e) => { console.error('E2E ERROR', e); process.exit(1); });

'use strict';

// vitest globals enabled via vitest.config.js
const { createRuntimeRegistry, createMemoryRuntimeRegistry, pkFor, skFor, nameFromSk, runtimeIdOf } = require('./runtime-registry');

const TABLE = 'agent-gn0p84-config';
const AT = new Date('2026-08-13T12:00:00.000Z');

/**
 * Captures the DynamoDB commands the registry issues. Asserting on the COMMAND SHAPE is the point of
 * this file: the semantics are covered by the in-memory double used elsewhere, but nothing else checks
 * that the UpdateExpressions, condition and key structure are actually what DynamoDB will be sent — and
 * the write path is UpdateItem-only because the IAM policy deliberately withholds PutItem.
 */
function capture({ getItem = null, queryPages = [{ Items: [] }], failWith = null } = {}) {
  const sent = [];
  const doc = () => ({
    send: async (cmd) => {
      const n = cmd.constructor.name;
      sent.push({ n, input: cmd.input });
      if (failWith && n === 'UpdateCommand') throw failWith;
      if (n === 'GetCommand') return { Item: getItem };
      if (n === 'QueryCommand') return queryPages[sent.filter((s) => s.n === 'QueryCommand').length - 1] || { Items: [] };
      return {};
    },
  });
  const reg = createRuntimeRegistry({ tableName: TABLE, doc, now: () => AT });
  return { reg, sent, byName: (n) => sent.filter((s) => s.n === n) };
}

describe('runtime-registry: keys', () => {
  it('partitions by agent and sorts by generation, so one agent is one partition', () => {
    expect(pkFor('agent-xx9aff')).toBe('RUNTIME#agent-xx9aff');
    expect(skFor('oc_sandbox_abc123')).toBe('GEN#oc_sandbox_abc123');
    expect(nameFromSk('GEN#oc_sandbox_abc123')).toBe('oc_sandbox_abc123');
  });

  it('does not mistake another item type for a generation row', () => {
    // The table is shared with CONFIG#/AGENT#/GRANT#/SKILL# items, so a Query that begins_with GEN#
    // must never yield something that is not a generation.
    expect(nameFromSk('MARKETPLACE')).toBeNull();
    expect(nameFromSk(undefined)).toBeNull();
  });
});

describe('runtime-registry: get', () => {
  it('reads the generation row CONSISTENTLY', async () => {
    const { reg, byName } = capture({ getItem: { pk: pkFor('a'), sk: skFor('gen1'), arn: 'arn:1' } });
    const row = await reg.get('a', 'gen1');
    expect(row.arn).toBe('arn:1');
    const [get] = byName('GetCommand');
    expect(get.input.Key).toEqual({ pk: 'RUNTIME#a', sk: 'GEN#gen1' });
    // A turn that has just provisioned must not read its own write as absent and provision again.
    expect(get.input.ConsistentRead).toBe(true);
  });

  it('returns null rather than undefined for an absent row', async () => {
    const { reg } = capture({ getItem: undefined });
    expect(await reg.get('a', 'gen1')).toBeNull();
  });
});

describe('runtime-registry: record', () => {
  it('writes with UpdateItem, never PutItem — PutItem is deliberately not granted', async () => {
    const { reg, sent } = capture();
    await reg.record('a', 'gen1', { arn: 'arn:1', runtimeId: 'rt-1' });
    expect(sent.map((s) => s.n)).toEqual(['UpdateCommand']);
    const { input } = sent[0];
    expect(input.Key).toEqual({ pk: 'RUNTIME#a', sk: 'GEN#gen1' });
    expect(input.ExpressionAttributeValues[':arn']).toBe('arn:1');
    expect(input.ExpressionAttributeValues[':id']).toBe('rt-1');
  });

  it('preserves the ORIGINAL createdAt across a reprovision of the same generation', async () => {
    // The name is a spec fingerprint, so a runtime that died and was remade lands on the identical row.
    // Overwriting createdAt would make history read as new.
    const { reg, sent } = capture();
    await reg.record('a', 'gen1', { arn: 'arn:2', runtimeId: 'rt-2' });
    expect(sent[0].input.UpdateExpression).toMatch(/#createdAt = if_not_exists\(#createdAt, :ts\)/);
  });

  it('clears reapedAt — a reaped generation that is provisioned again is live', async () => {
    const { reg, sent } = capture();
    await reg.record('a', 'gen1', { arn: 'arn:2' });
    expect(sent[0].input.UpdateExpression).toMatch(/REMOVE #reapedAt/);
  });

  it('refuses to record without an arn — a row with no arn is not a claim', async () => {
    const { reg, sent } = capture();
    await expect(reg.record('a', 'gen1', {})).rejects.toThrow(/requires an arn/);
    expect(sent).toHaveLength(0);
  });
});

describe('runtime-registry: clearArn', () => {
  it('is CONDITIONAL on the arn still being the one that failed', async () => {
    const { reg, sent } = capture();
    await reg.clearArn('a', 'gen1', 'arn:dead');
    const { input } = sent[0];
    // Without this condition an eviction could discard a runtime another turn just provisioned,
    // forcing a needless second cold boot.
    expect(input.ConditionExpression).toBe('#arn = :arn');
    expect(input.ExpressionAttributeValues[':arn']).toBe('arn:dead');
    expect(input.UpdateExpression).toMatch(/REMOVE #arn, #runtimeId/);
  });

  it('reports false (not throws) when the row has already moved on', async () => {
    const err = new Error('nope'); err.name = 'ConditionalCheckFailedException';
    const { reg } = capture({ failWith: err });
    await expect(reg.clearArn('a', 'gen1', 'arn:dead')).resolves.toBe(false);
  });

  it('propagates a REAL failure rather than reporting a successful no-op', async () => {
    const { reg } = capture({ failWith: Object.assign(new Error('throttled'), { name: 'ThrottlingException' }) });
    await expect(reg.clearArn('a', 'gen1', 'arn:dead')).rejects.toThrow(/throttled/);
  });
});

describe('runtime-registry: clearByArn', () => {
  it('finds the generation holding that arn and clears it', async () => {
    // The invoke path knows the ARN it failed on but not the runtime name; rows are keyed by name
    // because an agent has one row per image generation.
    const { reg, byName } = capture({
      queryPages: [{ Items: [
        { pk: pkFor('a'), sk: skFor('genOld'), arn: 'arn:old' },
        { pk: pkFor('a'), sk: skFor('genNew'), arn: 'arn:dead' },
      ] }],
    });
    await expect(reg.clearByArn('a', 'arn:dead')).resolves.toBe(true);
    expect(byName('UpdateCommand')[0].input.Key.sk).toBe('GEN#genNew');
  });

  it('is a no-op when no row holds that arn', async () => {
    const { reg, byName } = capture({ queryPages: [{ Items: [{ pk: pkFor('a'), sk: skFor('g'), arn: 'arn:other' }] }] });
    await expect(reg.clearByArn('a', 'arn:dead')).resolves.toBe(false);
    expect(byName('UpdateCommand')).toHaveLength(0);
  });
});

describe('runtime-registry: listGenerations', () => {
  it('queries ONE agent partition, not the table', async () => {
    const { reg, byName } = capture({ queryPages: [{ Items: [{ pk: pkFor('a'), sk: skFor('g1'), arn: 'arn:1' }] }] });
    const rows = await reg.listGenerations('a');
    expect(rows).toHaveLength(1);
    expect(rows[0].runtimeName).toBe('g1');
    const { input } = byName('QueryCommand')[0];
    expect(input.KeyConditionExpression).toBe('#pk = :pk AND begins_with(#sk, :sk)');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': 'RUNTIME#a', ':sk': 'GEN#' });
  });

  it('follows pagination — a truncated result would hide generations from the reaper', async () => {
    const { reg } = capture({
      queryPages: [
        { Items: [{ pk: pkFor('a'), sk: skFor('g1') }], LastEvaluatedKey: { pk: 'x', sk: 'y' } },
        { Items: [{ pk: pkFor('a'), sk: skFor('g2') }] },
      ],
    });
    const rows = await reg.listGenerations('a');
    expect(rows.map((r) => r.runtimeName)).toEqual(['g1', 'g2']);
  });
});

describe('runtime-registry: markReaped', () => {
  it('keeps the row and drops only the liveness claim', async () => {
    const { reg, sent } = capture();
    await reg.markReaped('a', 'gen1');
    expect(sent[0].n).toBe('UpdateCommand');          // never DeleteCommand — rows are history
    expect(sent[0].input.UpdateExpression).toBe('REMOVE #arn, #runtimeId SET #reapedAt = :ts');
    expect(sent[0].input.ConditionExpression).toBeUndefined();
  });
});

// The double is only trustworthy if it behaves like the real thing on the paths callers depend on.
describe('createMemoryRuntimeRegistry: matches the real semantics', () => {
  it('reproduces the CONDITIONAL clear', async () => {
    const reg = createMemoryRuntimeRegistry();
    await reg.record('a', 'g', { arn: 'arn:fresh' });
    expect(await reg.clearArn('a', 'g', 'arn:stale')).toBe(false);
    expect((await reg.get('a', 'g')).arn).toBe('arn:fresh');
    expect(await reg.clearArn('a', 'g', 'arn:fresh')).toBe(true);
    expect((await reg.get('a', 'g')).arn).toBeUndefined();
  });

  it('keeps the row on markReaped, and preserves createdAt on reprovision', async () => {
    let t = 0;
    const reg = createMemoryRuntimeRegistry({ now: () => new Date(1_800_000_000_000 + (t += 1000)) });
    await reg.record('a', 'g', { arn: 'arn:1' });
    const created = (await reg.get('a', 'g')).createdAt;
    await reg.markReaped('a', 'g');
    expect((await reg.get('a', 'g')).reapedAt).toBeTruthy();
    await reg.record('a', 'g', { arn: 'arn:2' });
    expect((await reg.get('a', 'g')).createdAt).toBe(created);
  });

  it('scopes listGenerations to the agent, and does not leak a prefix neighbour', async () => {
    const reg = createMemoryRuntimeRegistry();
    await reg.record('agent-a', 'g1', { arn: 'arn:1' });
    await reg.record('agent-a-b', 'g2', { arn: 'arn:2' });
    const rows = await reg.listGenerations('agent-a');
    expect(rows.map((r) => r.runtimeName)).toEqual(['g1']);
  });
});

// ── Reserved-keyword guard ──────────────────────────────────────────────────────────────────────
//
// WHY THIS EXISTS. `agent` is a DynamoDB reserved keyword. Leaving it unaliased in record()'s
// UpdateExpression threw "Invalid UpdateExpression: Attribute name is a reserved keyword" on every
// provision — breaking every turn for every agent, live. Nothing above caught it, because a fake doc
// client records the command without validating it; only DynamoDB knows the reserved list.
//
// So the rule is now mechanical rather than judgement-based: EVERY attribute name in EVERY expression
// must be aliased. That is checkable without AWS, and it makes the reserved list irrelevant.
describe('runtime-registry: every attribute name is aliased', () => {
  // Anything that looks like a bare attribute reference — an identifier NOT prefixed with # or : —
  // sitting where DynamoDB expects a name. Operators, functions and the SET/REMOVE keywords are not.
  const KEYWORDS = new Set(['SET', 'REMOVE', 'ADD', 'DELETE', 'AND', 'OR', 'NOT', 'BETWEEN', 'IN', 'if_not_exists', 'begins_with', 'attribute_not_exists', 'attribute_exists', 'size', 'list_append']);
  const bareNames = (expr) => {
    if (!expr) return [];
    // Strip #aliases and :values first, then look for surviving identifiers.
    const stripped = expr.replace(/[#:][A-Za-z0-9_]+/g, ' ');
    return (stripped.match(/[A-Za-z_][A-Za-z0-9_]*/g) || []).filter((w) => !KEYWORDS.has(w));
  };

  const everyExpression = async () => {
    const { reg, sent } = capture({
      getItem: { pk: pkFor('a'), sk: skFor('g'), arn: 'arn:1' },
      queryPages: [{ Items: [{ pk: pkFor('a'), sk: skFor('g'), arn: 'arn:1' }] }],
    });
    await reg.record('a', 'g', { arn: 'arn:1', runtimeId: 'rt-1' });
    await reg.listGenerations('a');
    await reg.markReaped('a', 'g');
    await reg.clearArn('a', 'g', 'arn:1');
    return sent;
  };

  it('leaves no bare attribute name in any UpdateExpression, ConditionExpression or KeyConditionExpression', async () => {
    const sent = await everyExpression();
    const offenders = [];
    for (const { n, input } of sent) {
      for (const field of ['UpdateExpression', 'ConditionExpression', 'KeyConditionExpression', 'ProjectionExpression']) {
        for (const bare of bareNames(input[field])) offenders.push(`${n}.${field}: ${bare}`);
      }
    }
    expect(offenders, `unaliased attribute names (one of these WILL be a reserved keyword one day): ${offenders.join(', ')}`).toEqual([]);
  });

  it('declares an alias for every #name it references, and references every one it declares', async () => {
    // A stale alias is harmless but a MISSING one is a hard ValidationException, and an unused one is a
    // sign the expression was edited without its names.
    const sent = await everyExpression();
    for (const { n, input } of sent) {
      const exprs = ['UpdateExpression', 'ConditionExpression', 'KeyConditionExpression']
        .map((f) => input[f]).filter(Boolean).join(' ');
      if (!exprs) continue;
      const referenced = new Set(exprs.match(/#[A-Za-z0-9_]+/g) || []);
      const declared = new Set(Object.keys(input.ExpressionAttributeNames || {}));
      for (const r of referenced) expect(declared, `${n} references ${r} without declaring it`).toContain(r);
      for (const d of declared) expect(referenced, `${n} declares an unused alias ${d}`).toContain(d);
    }
  });

  it('specifically aliases `agent`, the keyword that actually broke production', async () => {
    const { reg, sent } = capture();
    await reg.record('a', 'g', { arn: 'arn:1' });
    expect(sent[0].input.UpdateExpression).not.toMatch(/(^|[\s,])agent(\s|=|,|$)/);
    expect(sent[0].input.ExpressionAttributeNames['#agent']).toBe('agent');
  });
});

describe('runtimeIdOf', () => {
  // Everything that ACTS on a runtime (GetAgentRuntime, DeleteAgentRuntime) needs an id, never a name.
  // A row that cannot yield one is invisible to the reaper — and "no id" looks identical to "already
  // reaped", so the reaper went quiet rather than complaining.
  it('prefers the recorded field', () => {
    expect(runtimeIdOf({ runtimeId: 'rt-explicit', arn: 'arn:aws:bedrock-agentcore:us-east-1:1:runtime/oc_a-XYZ' }))
      .toBe('rt-explicit');
  });

  it('derives the id from the ARN when the field is missing', () => {
    // The last path segment of a runtime ARN IS the agentRuntimeId.
    expect(runtimeIdOf({ arn: 'arn:aws:bedrock-agentcore:us-east-1:203366135563:runtime/agent_f412uf_c0e53652-ERs12dDeTx' }))
      .toBe('agent_f412uf_c0e53652-ERs12dDeTx');
  });

  it('returns null rather than a bogus id for a row it cannot resolve', () => {
    expect(runtimeIdOf(null)).toBeNull();
    expect(runtimeIdOf({})).toBeNull();
    expect(runtimeIdOf({ arn: 'not-an-arn' })).toBeNull();
    expect(runtimeIdOf({ arn: '' })).toBeNull();
  });
});

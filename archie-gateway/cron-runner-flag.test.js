'use strict';

// vitest globals enabled via vitest.config.js
const {
  createCronRunnerFlags, CRON_RUNNER, DEFAULT_CRON_RUNNER, isValidRunner,
} = require('./cron-runner-flag');

const TABLE = 'agent-config-test';
const keyOf = (pk, sk) => `${pk}|${sk}`;

/**
 * A DynamoDB document-client fake with just enough of the real semantics to be worth testing
 * against: item bodies as an opaque JSON string under `data`, and — the part that matters —
 * `attribute_not_exists(pk)` actually FAILING with a ConditionalCheckFailedException. The
 * write-if-absent path is the whole reason hydration cannot clobber a decision, so a fake that
 * ignored the condition would make that test pass for no reason.
 */
function fakeDoc(items = []) {
  const store = new Map(items.map((i) => [keyOf(i.pk, i.sk), { ...i }]));
  const seen = [];
  let failNext = null;
  return {
    store,
    seen,
    failWith(err) { failNext = err; },
    async send(cmd) {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      const name = cmd.constructor.name;
      const input = cmd.input;
      seen.push({ name, input });
      const k = keyOf(input.Key.pk, input.Key.sk);
      if (name === 'GetCommand') return { Item: store.get(k) };
      if (name === 'UpdateCommand') {
        if (input.ConditionExpression === 'attribute_not_exists(pk)' && store.has(k)) {
          const err = new Error('The conditional request failed');
          err.name = 'ConditionalCheckFailedException';
          throw err;
        }
        store.set(k, { ...input.Key, data: input.ExpressionAttributeValues[':d'] });
        return {};
      }
      throw new Error(`fakeDoc: unexpected ${name}`);
    },
  };
}

const item = (agentId, body) => ({ pk: `AGENT#${agentId}`, sk: 'CRON', data: JSON.stringify(body) });
const bodyOf = (doc, agentId) => JSON.parse(doc.store.get(keyOf(`AGENT#${agentId}`, 'CRON')).data);
const flags = (doc, over = {}) => createCronRunnerFlags({ doc, table: TABLE, now: () => 1000, ...over });

describe('the default is openclaw, and it is the fleet-wide fallback', () => {
  // The point of the fallback: nothing has to be back-filled for the many scopes that have never
  // been hydrated or flipped, and an unrecognised row reads exactly like an un-migrated one.
  it('a scope with no item resolves to openclaw', async () => {
    const rec = await flags(fakeDoc()).get('dm-u1');
    expect(rec.runner).toBe(CRON_RUNNER.OPENCLAW);
    expect(rec.source).toBe('default');
    expect(DEFAULT_CRON_RUNNER).toBe('openclaw');
  });

  it('an item holding an unrecognised runner falls back rather than trusting it', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'kubernetes' })]);
    const rec = await flags(doc).get('dm-u1');
    expect(rec.runner).toBe(CRON_RUNNER.OPENCLAW);
    // 'invalid', not 'default' — somebody wrote something, and that is a different problem from
    // nobody having decided yet.
    expect(rec.source).toBe('invalid');
  });

  // A DynamoDB failure must not become "fire it anyway": archie declining to fire leaves the
  // schedule running on OpenClaw, archie firing on a guess duplicates every turn.
  it('a read failure resolves to openclaw and is NOT cached', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'agentcore' })]);
    doc.failWith(new Error('ProvisionedThroughputExceeded'));
    const f = flags(doc);
    const first = await f.get('dm-u1');
    expect(first.runner).toBe(CRON_RUNNER.OPENCLAW);
    expect(first.source).toBe('unreadable');
    // the very next read gets the real answer — a blip must not pin the scope for a whole TTL
    expect((await f.get('dm-u1')).runner).toBe(CRON_RUNNER.AGENTCORE);
  });

  it('a dispatcher with no config table resolves everything to the default and refuses to write', async () => {
    const f = createCronRunnerFlags({ doc: null, table: '' });
    expect((await f.get('dm-u1')).runner).toBe(CRON_RUNNER.OPENCLAW);
    await expect(f.set('dm-u1', 'agentcore')).rejects.toThrow(/not configured/);
  });

  it('rejects an unknown runner on the write path instead of storing the default in its place', async () => {
    const doc = fakeDoc();
    await expect(flags(doc).set('dm-u1', 'ecs')).rejects.toThrow(/openclaw \| agentcore/);
    expect(doc.store.size).toBe(0);
    expect(isValidRunner('ecs')).toBe(false);
  });
});

describe('reading a decided scope', () => {
  it('reports the value, who set it and that it came from the store', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'agentcore', setAtMs: 42, setBy: 'U123' })]);
    const rec = await flags(doc).get('dm-u1');
    expect(rec).toMatchObject({ runner: 'agentcore', source: 'store', setAtMs: 42, setBy: 'U123' });
  });

  it('isAgentCore is the one question the fire gate asks', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'agentcore' }), item('dm-u2', { runner: 'openclaw' })]);
    const f = flags(doc);
    expect(await f.isAgentCore('dm-u1')).toBe(true);
    expect(await f.isAgentCore('dm-u2')).toBe(false);
    expect(await f.isAgentCore('dm-never-seen')).toBe(false);
  });
});

describe('no cache: the row is read at FIRE TIME and used immediately', () => {
  // THE PROPERTY THE FLAG EXISTS FOR. A cached value means a fire can be decided on a row that has
  // since changed — i.e. a scope flipped to `agentcore` in Slack keeps firing here for the rest of
  // the TTL, on both stacks. This started at a 30s TTL to spare DynamoDB; that trade was wrong and
  // the tests now pin the absence of it.
  it('reads on EVERY resolution — two questions, two reads', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'agentcore' })]);
    const f = flags(doc);
    await f.get('dm-u1');
    await f.get('dm-u1');
    expect(doc.seen.filter((s) => s.name === 'GetCommand')).toHaveLength(2);
  });

  it('a flip is honoured by the very next read, with no invalidation and no wait', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'openclaw' })]);
    const f = flags(doc);
    expect(await f.isAgentCore('dm-u1')).toBe(false);
    // somebody flips it in Slack — a DIFFERENT process, so nothing here is notified
    doc.store.set(keyOf('AGENT#dm-u1', 'CRON'), item('dm-u1', { runner: 'agentcore' }));
    expect(await f.isAgentCore('dm-u1')).toBe(true);
  });

  it('reads every time when built the way index.js builds it', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'openclaw' })]);
    // built the way index.js builds it: no ttlMs at all
    const f = createCronRunnerFlags({ doc, table: TABLE });
    await f.get('dm-u1');
    await f.get('dm-u1');
    await f.get('dm-u1');
    expect(doc.seen.filter((s) => s.name === 'GetCommand')).toHaveLength(3);
  });
});

describe('set records the decision', () => {
  it('stores the runner, the time and who asked', async () => {
    const doc = fakeDoc();
    const r = await flags(doc).set('dm-u1', 'agentcore', { by: 'U123' });
    expect(r).toMatchObject({ runner: 'agentcore', wrote: true });
    expect(bodyOf(doc, 'dm-u1')).toEqual({ runner: 'agentcore', setAtMs: 1000, setBy: 'U123' });
  });

  // The dispatcher's IAM policy grants UpdateItem on AGENT#* and deliberately NOT PutItem
  // (iam.tf "WriteAgentMarketplaceOnly"). A PutCommand here would fail in prod and nowhere else.
  it('writes with UpdateItem, never PutItem', async () => {
    const doc = fakeDoc();
    await flags(doc).set('dm-u1', 'agentcore', { by: 'U123' });
    expect(doc.seen.map((s) => s.name)).toContain('UpdateCommand');
    expect(doc.seen.map((s) => s.name)).not.toContain('PutCommand');
  });
});

describe('setDefault — hydration must not undo a cutover', () => {
  it('seeds openclaw for a scope nobody has decided', async () => {
    const doc = fakeDoc();
    const r = await flags(doc).setDefault('dm-u1', { by: 'hydrate:agent-xx9aff' });
    expect(r).toMatchObject({ runner: 'openclaw', wrote: true });
    expect(bodyOf(doc, 'dm-u1')).toMatchObject({ runner: 'openclaw', setBy: 'hydrate:agent-xx9aff' });
  });

  // THE ONE THAT MATTERS. Re-hydration is a routine correction (purge + re-seed from EFS); a scope
  // already cut over to archie must not be dragged back onto OpenClaw's scheduler by an unrelated
  // re-import of its job list.
  it('leaves an already-decided scope alone, and says so', async () => {
    const doc = fakeDoc([item('dm-u1', { runner: 'agentcore', setBy: 'U123' })]);
    const r = await flags(doc).setDefault('dm-u1', { by: 'hydrate:agent-xx9aff' });
    expect(r).toEqual({ agentId: 'dm-u1', runner: 'agentcore', wrote: false, existing: 'agentcore' });
    expect(bodyOf(doc, 'dm-u1')).toMatchObject({ runner: 'agentcore', setBy: 'U123' });
  });

  it('does the write-if-absent in DynamoDB, not by reading first', async () => {
    // Two hydrations racing must not both believe they were first, so the condition has to be on
    // the write itself rather than a read-then-write in this process.
    const doc = fakeDoc();
    await flags(doc).setDefault('dm-u1');
    const update = doc.seen.find((s) => s.name === 'UpdateCommand');
    expect(update.input.ConditionExpression).toBe('attribute_not_exists(pk)');
  });
});


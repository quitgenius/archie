'use strict';

// Tests for the DynamoDB conversation store + hydration planning.
//
// The invariants worth pinning are the ones whose violation is SILENT: writing under a partition an
// agent can modify, rolling a conversation backwards from a stale snapshot, one writer discarding
// another's disjoint fields, and dropping malformed rows without saying so.
//
// The fake below INTERPRETS ConditionExpression and UpdateExpression rather than ignoring them. A
// fake that accepted any expression would make every test here vacuous — it would pass just as
// happily against a whole-item replace, which is the exact bug these tests exist to prevent.

const store = require('./conversations-store');

function fakeDdb() {
  const items = new Map();
  const key = (k) => `${k.pk}|${k.sk}`;

  // The condition expression is PARSED, including its comparison operator.
  //
  // The first version of this fake matched `expr === store.IDEMPOTENT_CONDITION` and then applied a
  // hardcoded `<`. That made every condition test vacuous: reverting the module to the original
  // `<=` — the actual bug — still passed all 20 tests, because the fake never read the operator it
  // was supposedly verifying. Mutation-tested after this rewrite; `<=` now fails the equal-timestamp
  // pin test, which is the only reason that test is worth having.
  const evalTerm = (term, prev, values) => {
    let m = /^attribute_not_exists\((\w+)\)$/.exec(term);
    if (m) return !prev || !(m[1] in prev);
    m = /^attribute_exists\((\w+)\)$/.exec(term);
    if (m) return !!prev && m[1] in prev;
    m = /^(\w+)\s*(<=|<|>=|>|=)\s*(:\w+)$/.exec(term);
    if (m) {
      if (!prev) return false;
      const [, attr, op, val] = m;
      if (!(val in values)) throw new Error(`fake ddb: no value bound for ${val}`);
      const a = prev[attr]; const b = values[val];
      if (a === undefined) return false;
      switch (op) {
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        default: return a === b;
      }
    }
    throw new Error(`fake ddb: unparseable condition term: ${term}`);
  };

  const conditionHolds = (expr, prev, values) =>
    expr.split(/\s+OR\s+/).some((t) => evalTerm(t.trim(), prev, values));

  const conditionalFailure = () => {
    const e = new Error('The conditional request failed');
    e.name = 'ConditionalCheckFailedException';
    return e;
  };

  // Grammar this module emits: "SET a = :x, b = :y REMOVE c, d" with #names for every identifier.
  const applyUpdate = (item, expr, names, values) => {
    const resolve = (p) => p.split('.').map((t) => (t.startsWith('#') ? names[t] : t));
    const m = /^(?:SET (?<set>.+?))?(?: ?REMOVE (?<rem>.+))?$/.exec(expr.trim());
    if (!m || (!m.groups.set && !m.groups.rem)) throw new Error(`fake ddb: unparseable UpdateExpression: ${expr}`);
    for (const clause of (m.groups.set || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const [lhs, rhs] = clause.split('=').map((s) => s.trim());
      const path = resolve(lhs);
      if (!(rhs in values)) throw new Error(`fake ddb: no value for ${rhs}`);
      let t = item;
      for (const seg of path.slice(0, -1)) { t[seg] = t[seg] || {}; t = t[seg]; }
      t[path[path.length - 1]] = values[rhs];
    }
    for (const clause of (m.groups.rem || '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const path = resolve(clause);
      let t = item;
      for (const seg of path.slice(0, -1)) { if (!t[seg]) return; t = t[seg]; }
      delete t[path[path.length - 1]];
    }
  };

  const doc = {
    async send(cmd) {
      const i = cmd.input;
      if (cmd.__type === 'put') {
        const prev = items.get(key(i.Item));
        if (i.ConditionExpression && !conditionHolds(i.ConditionExpression, prev, i.ExpressionAttributeValues || {})) {
          throw conditionalFailure();
        }
        items.set(key(i.Item), JSON.parse(JSON.stringify(i.Item)));
        return {};
      }
      if (cmd.__type === 'update') {
        const prev = items.get(key(i.Key));
        if (i.ConditionExpression && !conditionHolds(i.ConditionExpression, prev, i.ExpressionAttributeValues || {})) {
          throw conditionalFailure();
        }
        const next = prev ? JSON.parse(JSON.stringify(prev)) : { ...i.Key };
        applyUpdate(next, i.UpdateExpression, i.ExpressionAttributeNames || {}, i.ExpressionAttributeValues || {});
        items.set(key(i.Key), next);
        return {};
      }
      if (cmd.__type === 'delete') { items.delete(key(i.Key)); return {}; }
      if (cmd.__type === 'query') {
        const v = i.ExpressionAttributeValues;
        let rows = [...items.values()].filter((it) => it.pk === v[':pk'] && it.sk.startsWith(v[':p']));
        rows.sort((a, b) => (a.sk < b.sk ? -1 : 1));
        if (i.ScanIndexForward === false) rows.reverse();
        return { Items: rows.slice(0, i.Limit || 100) };
      }
      throw new Error('unknown command');
    },
  };
  const mk = (t) => class { constructor(input) { this.input = input; this.__type = t; } };
  const cmds = {
    PutCommand: mk('put'), QueryCommand: mk('query'), UpdateCommand: mk('update'), DeleteCommand: mk('delete'),
  };
  const stored = (agentId, threadTs) => items.get(`${store.convPk(agentId)}|${store.convSk(threadTs)}`);
  return { doc, cmds, items, stored };
}

const conv = (over = {}) => ({
  title: 'a title', channel: 'D123', userId: 'U123',
  startedAt: '2026-06-10T08:17:15.355Z', lastActivity: '2026-06-10T09:26:36.933Z',
  messageCount: 5, recentMessages: ['hello'], titleResummarized: false, ...over,
});

describe('key shape', () => {
  // SECURITY REGRESSION GUARD. Every runtime role holds PutItem/UpdateItem on this table so it can
  // persist AGENT#<id>/SEED, and IAM has NO sort-key condition key — so a write scope of
  // LeadingKeys AGENT#* cannot exclude a sort key. Under AGENT#<id> an agent could rewrite or
  // delete its own conversation history. GRANT#<id> is a separate partition for exactly this
  // reason; this test exists so nobody "tidies" conversations back under AGENT#.
  it('lives in its OWN partition, never under AGENT#', () => {
    const item = store.toItem('agent-xx9aff', '1780993922.012579', conv());
    expect(item.pk).toBe('CONV#agent-xx9aff');
    expect(item.pk.startsWith('AGENT#')).toBe(false);
    expect(item.sk).toBe('THREAD#1780993922.012579');
  });

  it('promotes lastActivity so the condition can compare it server-side', () => {
    const item = store.toItem('a', '1780993922.012579', conv({ lastActivity: '2026-01-01T00:00:00.000Z' }));
    expect(item.lastActivity).toBe('2026-01-01T00:00:00.000Z');
    expect(item.conv.lastActivity).toBe('2026-01-01T00:00:00.000Z');
  });

  // The schema decision that makes field-level writes possible at all. DynamoDB cannot address
  // inside a JSON string, so storing the payload the way every other item in this table does would
  // leave a whole-item replace as the only available write — and that is precisely what loses a pin.
  it('stores the conversation as a MAP, not a JSON string', () => {
    const item = store.toItem('a', '1', conv());
    expect(typeof item.conv).toBe('object');
    expect(typeof item.data).toBe('undefined');
  });

  it('REFUSES a conversation with no lastActivity rather than inventing one', () => {
    const { lastActivity, ...noTs } = conv();
    expect(() => store.toItem('a', '1', noTs)).toThrow(/no lastActivity/);
  });
});

describe('hydration writes (whole-snapshot, newest-wins)', () => {
  it('re-running converges — the same snapshot twice is one item, not two', async () => {
    const { doc, cmds, items } = fakeDdb();
    const args = { agentId: 'a', threadTs: '1780993922.012579', conv: conv() };
    expect(await store.putConversation(doc, cmds, args)).toBe('written');
    expect(await store.putConversation(doc, cmds, args)).toBe('skipped-older');
    expect(items.size).toBe(1);
  });

  // THE ONE THAT MATTERS DURING A DUAL-WRITE MIGRATION. Hydration runs from a snapshot that is
  // already stale; the app may have updated the conversation since. A blind Put would roll it back.
  it('NEVER overwrites a newer live write', async () => {
    const { doc, cmds, stored } = fakeDdb();
    const live = conv({ lastActivity: '2026-08-14T10:00:00.000Z', title: 'live update' });
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: live });

    const stale = conv({ lastActivity: '2026-06-10T09:26:36.933Z', title: 'from the snapshot' });
    expect(await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: stale })).toBe('skipped-older');
    expect(stored('a', '1').conv.title).toBe('live update');
  });

  // WHY THE CONDITION IS `<` AND NOT `<=`. togglePin/moveInList/resetRecentOrder never touch
  // lastActivity, so a live pin leaves the timestamp EQUAL to the snapshot's. Under `<=` the equal
  // case satisfied the condition and hydration silently un-pinned it. 38 real prod pins ride on this.
  it('NEVER reverts a live pin whose timestamp is merely EQUAL to the snapshot', async () => {
    const { doc, cmds, stored } = fakeDdb();
    const T = '2026-06-10T09:26:36.933Z';
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv({ lastActivity: T }) });
    await store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { pinned: true, pinOrder: 0 } });

    const snapshot = conv({ lastActivity: T });       // same timestamp, no pin — the pre-pin snapshot
    expect(await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: snapshot })).toBe('skipped-older');
    expect(stored('a', '1').conv.pinned).toBe(true);
  });

  it('DOES advance a stale stored copy to a newer snapshot', async () => {
    const { doc, cmds, stored } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv({ lastActivity: '2026-01-01T00:00:00.000Z' }) });
    const r = await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv({ lastActivity: '2026-08-01T00:00:00.000Z', title: 'newer' }) });
    expect(r).toBe('written');
    expect(stored('a', '1').conv.title).toBe('newer');
  });

  it('a NON-conditional failure propagates — only the conditional outcome is absorbed', async () => {
    const { cmds } = fakeDdb();
    const doc = { async send() { const e = new Error('Throttling'); e.name = 'ThrottlingException'; throw e; } };
    await expect(store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv() }))
      .rejects.toThrow(/Throttling/);
  });
});

describe('live writes touch only the fields their writer owns', () => {
  const seedPinned = async (doc, cmds) => {
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv() });
    await store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { pinned: true, pinOrder: 3 } });
  };

  // Re-summarisation and a pin are separate writers on the same conversation. Under a whole-item
  // write either one clobbers the other depending on ordering, and neither writer can tell.
  it('a title re-summarisation leaves pin state untouched', async () => {
    const { doc, cmds, stored } = fakeDdb();
    await seedPinned(doc, cmds);
    await store.updateConversation(doc, cmds, {
      agentId: 'a', threadTs: '1', set: { title: 'AI summarised title', titleResummarized: true },
    });
    const c = stored('a', '1').conv;
    expect(c.title).toBe('AI summarised title');
    expect(c.pinned).toBe(true);
    expect(c.pinOrder).toBe(3);
  });

  it('a pin leaves message state untouched', async () => {
    const { doc, cmds, stored } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv({ messageCount: 9, title: 'real title' }) });
    await store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { pinned: true } });
    const c = stored('a', '1').conv;
    expect(c.messageCount).toBe(9);
    expect(c.title).toBe('real title');
  });

  // 18 of the 38 pins in prod pre-date the reorder feature and have NO pinOrder. getConversations
  // sorts unordered pins AFTER ordered ones, so inventing a pinOrder here would silently move 18
  // real conversations in 12 people's sidebars.
  it('does NOT materialise a pinOrder that the caller did not set', async () => {
    const { doc, cmds, stored } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv() });
    await store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { pinned: true } });
    expect('pinOrder' in stored('a', '1').conv).toBe(false);
  });

  it('REMOVE drops a field — unpinning and resetRecentOrder depend on it', async () => {
    const { doc, cmds, stored } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv({ recentOrder: 4 }) });
    await store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { pinned: true }, remove: ['recentOrder'] });
    const c = stored('a', '1').conv;
    expect('recentOrder' in c).toBe(false);
    expect(c.pinned).toBe(true);
  });

  it('keeps the promoted lastActivity in step with the nested copy', async () => {
    const { doc, cmds, stored } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv() });
    const T = '2026-08-14T12:00:00.000Z';
    await store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { lastActivity: T, messageCount: 6 } });
    const it = stored('a', '1');
    expect(it.lastActivity).toBe(T);          // the attribute conditions compare
    expect(it.conv.lastActivity).toBe(T);
  });

  // Dual-write starts before hydration finishes, so an update WILL arrive for a conversation that
  // is not in DynamoDB yet. A bare UpdateItem would create an item holding a title and nothing
  // else, which reads back as a conversation with no channel and no timestamps.
  it('an update for a conversation not yet in DynamoDB creates it WHOLE, not as a fragment', async () => {
    const { doc, cmds, stored } = fakeDdb();
    const r = await store.updateConversation(doc, cmds, {
      agentId: 'a', threadTs: '1', set: { title: 'new title' }, conv: conv({ title: 'new title' }),
    });
    expect(r).toBe('created');
    const c = stored('a', '1').conv;
    expect(c.channel).toBe('D123');
    expect(c.startedAt).toBeTruthy();
    expect(stored('a', '1').lastActivity).toBeTruthy();
  });

  it('refuses to write a fragment when no full conversation was supplied', async () => {
    const { doc, cmds } = fakeDdb();
    await expect(store.updateConversation(doc, cmds, { agentId: 'a', threadTs: '1', set: { title: 'x' } }))
      .rejects.toThrow(/refusing to write a fragment/);
  });
});

describe('deletes', () => {
  // prune() is LIVE: 12 prod agents sit at the 100 cap and one turns over 46 conversations a week.
  // Without delete propagation the table only grows, and cutover would resurrect retired threads.
  it('removes the conversation', async () => {
    const { doc, cmds, items, stored } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv() });
    expect(stored('a', '1')).toBeTruthy();
    expect(await store.deleteConversation(doc, cmds, { agentId: 'a', threadTs: '1' })).toBe('deleted');
    expect(items.size).toBe(0);
  });

  it('is idempotent — deleting an absent conversation is not an error', async () => {
    const { doc, cmds } = fakeDdb();
    await expect(store.deleteConversation(doc, cmds, { agentId: 'a', threadTs: 'nope' })).resolves.toBe('deleted');
  });
});

describe('reads', () => {
  it('returns one agent\'s conversations newest-first, and no other agent\'s', async () => {
    const { doc, cmds } = fakeDdb();
    // threadTs is fixed-width epoch, so lexicographic order IS chronological
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1780993922.000001', conv: conv({ title: 'older' }) });
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1790993922.000001', conv: conv({ title: 'newer' }) });
    await store.putConversation(doc, cmds, { agentId: 'b', threadTs: '1785993922.000001', conv: conv({ title: 'other agent' }) });

    const rows = await store.listConversations(doc, cmds, { agentId: 'a' });
    expect(rows.map((r) => r.title)).toEqual(['newer', 'older']);
    expect(rows.some((r) => r.title === 'other agent')).toBe(false);
  });

  it('round-trips pin and order state through the map', async () => {
    const { doc, cmds } = fakeDdb();
    await store.putConversation(doc, cmds, { agentId: 'a', threadTs: '1', conv: conv({ pinned: true, pinOrder: 2 }) });
    const [row] = await store.listConversations(doc, cmds, { agentId: 'a' });
    expect(row.pinned).toBe(true);
    expect(row.pinOrder).toBe(2);
    expect(row.threadTs).toBe('1');
  });
});

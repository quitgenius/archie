'use strict';

// vitest globals enabled via vitest.config.js
const { createOwners, ownsOwnScope, ownScopeFor, normaliseUserId } = require('./owners');

const TABLE = 'agent-config-test';
const ME = 'UX0MZ5CKP2R';        // owns dm-ux0mz5ckp2r by derivation
const PEER = 'UMRSP7355U7';
const LISA = 'UTBQNKRPRWA';
const CH = 'ch-cr89fluhion';
const CH2 = 'ch-cla9ne1dvia';

const ownersRow = (scopeId, ids, by = 'hydrate') => ({
  pk: `AGENT#${scopeId}`,
  sk: 'OWNERS',
  owners: Object.fromEntries(ids.map((u) => [u, { by, at: '2026-09-07T10:00:00.000Z' }])),
});

/**
 * A DynamoDB document-client fake.
 *
 * `owners` is a NATIVE MAP here, not a JSON string under `data` — the shape the real table uses for
 * this row and the reason the membership filter can run server-side. A fake that stored it as a
 * string would pass tests the real table fails.
 *
 * The Query branch implements the `facet` GSI's contract: key on sk, and apply the
 * `attribute_exists(owners.<uid>)` filter SERVER-SIDE, so a test asserting on which scopes come back
 * is asserting on the same behaviour DynamoDB provides rather than on client-side filtering.
 */
function fakeDoc(rows = [], { failQuery = false, failGet = false, failUpdate = false } = {}) {
  const store = new Map(rows.map((r) => [`${r.pk}|${r.sk}`, JSON.parse(JSON.stringify(r))]));
  const seen = [];
  return {
    store,
    seen,
    row(scopeId) { return store.get(`AGENT#${scopeId}|OWNERS`) || null; },
    async send(cmd) {
      const name = cmd.constructor.name;
      const input = cmd.input;
      seen.push({ name, input });

      if (name === 'GetCommand') {
        if (failGet) throw Object.assign(new Error('get boom'), { name: 'ProvisionedThroughputExceededException' });
        return { Item: store.get(`${input.Key.pk}|${input.Key.sk}`) };
      }

      if (name === 'QueryCommand') {
        if (failQuery) throw Object.assign(new Error('query boom'), { name: 'ResourceNotFoundException' });
        if (input.IndexName !== 'facet') throw new Error(`unexpected index ${input.IndexName}`);
        const wantSk = input.ExpressionAttributeValues[':owners'];
        // The filter's target user comes from ExpressionAttributeNames, exactly as the real query
        // passes it — a uid is a MAP KEY, never a value.
        const uid = input.ExpressionAttributeNames['#uid'];
        const Items = [...store.values()]
          .filter((r) => r.sk === wantSk)
          .filter((r) => r.owners && Object.prototype.hasOwnProperty.call(r.owners, uid))
          .map((r) => ({ pk: r.pk }));
        return { Items };
      }

      if (name === 'UpdateCommand') {
        if (failUpdate) throw Object.assign(new Error('update boom'), { name: 'ConditionalCheckFailedException' });
        const k = `${input.Key.pk}|${input.Key.sk}`;
        const expr = input.UpdateExpression;
        // `attribute_not_exists(#owners)` — the bootstrap's condition, and the only one used here.
        // Modelled rather than ignored: it IS the security property, so a fake that always let the
        // write through would pass a test the real table fails.
        if (/attribute_not_exists/.test(input.ConditionExpression || '')) {
          const existing = store.get(k);
          // PRESENCE, not non-emptiness — mirroring `attribute_not_exists(#owners)` exactly. A fake
          // that ignored an empty map would pass the very case the real table rejects.
          if (existing && existing.owners) {
            throw Object.assign(new Error('The conditional request failed'), { name: 'ConditionalCheckFailedException' });
          }
          store.set(k, { ...input.Key, owners: input.ExpressionAttributeValues[':first'] });
          return {};
        }
        if (/if_not_exists/.test(expr)) {
          if (!store.has(k)) store.set(k, { ...input.Key, owners: {} });
          else if (!store.get(k).owners) store.get(k).owners = {};
          return {};
        }
        // `SET #owners.#uid = :meta` — mirrors the real failure: the path is invalid when the map
        // does not exist yet, which is what forces the two-step write.
        const item = store.get(k);
        if (!item || !item.owners) {
          throw Object.assign(
            new Error('The document path provided in the update expression is invalid for update'),
            { name: 'ValidationException' },
          );
        }
        item.owners[input.ExpressionAttributeNames['#uid']] = input.ExpressionAttributeValues[':meta'];
        return {};
      }

      if (name === 'PutCommand') throw new Error('PutCommand is not permitted — the task role holds UpdateItem only');
      throw new Error(`unexpected command ${name}`);
    },
  };
}

// isBotUser defaults to "everyone is a person" so the existing cases read as before; the bot tests
// override it. It is REQUIRED by addOwner — a factory built without one refuses rather than guessing,
// which is asserted below.
const build = (doc, extra = {}) => createOwners({
  doc: () => doc, tableName: TABLE, isBotUser: async () => false, ...extra,
});

// ── The derivation ───────────────────────────────────────────────────────────────────────────────

describe('the own-DM scope is derived, never stored', () => {
  it('derives the scope id from the user id, lowercased', () => {
    expect(ownScopeFor(ME)).toBe('dm-ux0mz5ckp2r');
    expect(ownsOwnScope(ME, 'dm-ux0mz5ckp2r')).toBe(true);
  });

  it('accepts a lowercased user id, because a case mismatch would be a silent refusal', () => {
    expect(ownsOwnScope('ux0mz5ckp2r', 'dm-ux0mz5ckp2r')).toBe(true);
    expect(normaliseUserId('ux0mz5ckp2r')).toBe('UX0MZ5CKP2R');
  });

  it('does not make you the owner of anyone else', () => {
    expect(ownsOwnScope(ME, 'dm-umrsp7355u7')).toBe(false);
    expect(ownsOwnScope(ME, CH)).toBe(false);
  });

  it('isOwner answers the own scope with NO table read at all', async () => {
    const f = fakeDoc();
    expect(await build(f).isOwner(ME, 'dm-ux0mz5ckp2r')).toBe(true);
    expect(f.seen).toHaveLength(0);
  });
});

// ── isOwner ──────────────────────────────────────────────────────────────────────────────────────

describe('isOwner', () => {
  it('admits a stored owner of a channel scope', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER, LISA])]);
    expect(await build(f).isOwner(PEER, CH)).toBe(true);
    expect(await build(f).isOwner(LISA, CH)).toBe(true);
  });

  it('refuses a non-owner', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    expect(await build(f).isOwner(LISA, CH)).toBe(false);
  });

  it('refuses when the scope has no OWNERS row', async () => {
    expect(await build(fakeDoc()).isOwner(PEER, CH)).toBe(false);
  });

  it('matches case-insensitively, because a hand-edited row could be lowercased', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    expect(await build(f).isOwner(PEER.toLowerCase(), CH)).toBe(true);
  });

  // A cached answer would let a revoked owner keep access until the next restart, and an owner
  // added a second ago be refused. Both are the reason there is no cache in this module.
  it('reads the table on EVERY call — no memoisation', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    const o = build(f);
    await o.isOwner(PEER, CH);
    await o.isOwner(PEER, CH);
    expect(f.seen.filter((s) => s.name === 'GetCommand')).toHaveLength(2);
  });

  it('sees an owner added after the first refusal, with no reload', async () => {
    const f = fakeDoc();
    const o = build(f);
    expect(await o.isOwner(LISA, CH)).toBe(false);
    await o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(await o.isOwner(LISA, CH)).toBe(true);
  });

  it('FAILS CLOSED when the read throws', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])], { failGet: true });
    expect(await build(f).isOwner(PEER, CH)).toBe(false);
  });

  it('FAILS CLOSED when owners is not a map', async () => {
    const f = fakeDoc([{ pk: `AGENT#${CH}`, sk: 'OWNERS', owners: ['U1'] }]);
    expect(await build(f).isOwner('U1', CH)).toBe(false);
  });

  it('refuses missing arguments rather than guessing', async () => {
    const o = build(fakeDoc());
    expect(await o.isOwner(null, CH)).toBe(false);
    expect(await o.isOwner(PEER, null)).toBe(false);
  });
});

// ── ownedScopes: the selector's roster ───────────────────────────────────────────────────────────

describe('ownedScopes', () => {
  // Own scope FIRST regardless of how it sorts — "your own agent" belongs at the top of the
  // selector, not wherever `dm-` happens to land alphabetically.
  it('returns the own scope first, then owned scopes sorted', async () => {
    const f = fakeDoc([ownersRow(CH2, [ME]), ownersRow(CH, [ME])]);
    expect(await build(f).ownedScopes(ME)).toEqual(['dm-ux0mz5ckp2r', 'ch-cla9ne1dvia', 'ch-cr89fluhion']);
  });

  it('returns just the own scope for a user who owns nothing else', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    expect(await build(f).ownedScopes(ME)).toEqual(['dm-ux0mz5ckp2r']);
  });

  it('never returns another user\'s DM scope', async () => {
    const f = fakeDoc([ownersRow(CH, [ME])]);
    const scopes = await build(f).ownedScopes(ME);
    expect(scopes).not.toContain('dm-umrsp7355u7');
  });

  it('filters SERVER-SIDE — the uid is a map key in ExpressionAttributeNames, not a value', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    await build(f).ownedScopes(PEER);
    const q = f.seen.find((s) => s.name === 'QueryCommand');
    expect(q.input.IndexName).toBe('facet');
    expect(q.input.FilterExpression).toBe('attribute_exists(#owners.#uid)');
    expect(q.input.ExpressionAttributeNames['#uid']).toBe(PEER);
    expect(JSON.stringify(q.input.ExpressionAttributeValues)).not.toContain(PEER);
  });

  it('QUERIES the facet index and never Scans the table', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    await build(f).ownedScopes(PEER);
    expect(f.seen.map((s) => s.name)).not.toContain('ScanCommand');
  });

  it('reads fresh on every call — no memoisation', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    const o = build(f);
    await o.ownedScopes(PEER);
    await o.ownedScopes(PEER);
    expect(f.seen.filter((s) => s.name === 'QueryCommand')).toHaveLength(2);
  });

  it('picks up a newly added scope with no reload', async () => {
    const f = fakeDoc();
    const o = build(f);
    expect(await o.ownedScopes(LISA)).toEqual(['dm-utbqnkrprwa']);
    await o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(await o.ownedScopes(LISA)).toEqual(['dm-utbqnkrprwa', CH]);
  });

  // Fails open TO SELF: an empty list would publish a Home tab with nothing selectable, which reads
  // as "my access was removed" rather than "a read failed".
  it('degrades to the own scope alone when the query throws', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])], { failQuery: true });
    expect(await build(f).ownedScopes(PEER)).toEqual(['dm-umrsp7355u7']);
  });

  it('returns the own scope only, and does not query, for a non-Slack user id', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    expect(await build(f).ownedScopes('not-a-slack-id')).toEqual([]);
    expect(f.seen).toHaveLength(0);
  });

  it('returns nothing at all with no user id', async () => {
    expect(await build(fakeDoc()).ownedScopes(null)).toEqual([]);
  });
});

// ── addOwner ─────────────────────────────────────────────────────────────────────────────────────

describe('addOwner', () => {
  // The single-step SET fails on the live table when the row is absent, which is every
  // auto-provisioned scope. This asserts the two-step order, not just the end state.
  it('creates the map first, then sets the key — two UpdateItems, in that order', async () => {
    const f = fakeDoc();
    await build(f).addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    const updates = f.seen.filter((s) => s.name === 'UpdateCommand');
    expect(updates).toHaveLength(2);
    expect(updates[0].input.UpdateExpression).toContain('if_not_exists');
    expect(updates[1].input.UpdateExpression).toBe('SET #owners.#uid = :meta');
    expect(f.row(CH).owners[LISA].by).toBe(PEER);
  });

  it('is idempotent — re-adding the same owner leaves one entry', async () => {
    const f = fakeDoc();
    const o = build(f);
    await o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    await o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(Object.keys(f.row(CH).owners)).toEqual([LISA]);
  });

  it('does not clobber an existing owner', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    await build(f).addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(Object.keys(f.row(CH).owners).sort()).toEqual([PEER, LISA].sort());
    expect(f.row(CH).owners[PEER].by).toBe('hydrate');
  });

  it('normalises the added id to uppercase, so the reader can match it', async () => {
    const f = fakeDoc();
    await build(f).addOwner({ scopeId: CH, ownerUserId: LISA.toLowerCase(), by: PEER });
    expect(Object.keys(f.row(CH).owners)).toEqual([LISA]);
  });

  it('records who added whom, and when', async () => {
    const f = fakeDoc();
    const r = await build(f).addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(r.ownerUserId).toBe(LISA);
    expect(r.by).toBe(PEER);
    expect(r.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(f.row(CH).owners[LISA]).toEqual({ by: PEER, at: r.at });
  });

  it('accepts the automatic writers as `by`', async () => {
    const f = fakeDoc();
    await build(f).addOwner({ scopeId: CH, ownerUserId: LISA, by: 'mention' });
    expect(f.row(CH).owners[LISA].by).toBe('mention');
  });

  it('refuses a value that is not a Slack user id', async () => {
    const f = fakeDoc();
    await expect(build(f).addOwner({ scopeId: CH, ownerUserId: 'nope', by: PEER })).rejects.toThrow(/not a Slack user id/);
    expect(f.seen).toHaveLength(0);
  });

  it('refuses with no scope', async () => {
    await expect(build(fakeDoc()).addOwner({ ownerUserId: LISA, by: PEER })).rejects.toThrow(/scopeId required/);
  });

  it('emits a success metric naming the scope, the recipient and the actor', async () => {
    const emitted = [];
    const f = fakeDoc();
    await build(f, { metrics: { emitOwnerAdded: (agent, p) => emitted.push({ agent, ...p }) } })
      .addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(emitted).toEqual([{ agent: CH, ownerUserId: LISA, by: PEER, ok: true }]);
  });

  it('THROWS and emits a failure metric when the write fails', async () => {
    const emitted = [];
    const f = fakeDoc([], { failUpdate: true });
    const o = build(f, { metrics: { emitOwnerAdded: (agent, p) => emitted.push({ agent, ...p }) } });
    await expect(o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER })).rejects.toThrow(/update boom/);
    expect(emitted).toEqual([{ agent: CH, ownerUserId: LISA, by: PEER, ok: false, errName: 'ConditionalCheckFailedException' }]);
  });
});

// ── ownersOf: the Owners tab's list ──────────────────────────────────────────────────────────────

describe('ownersOf', () => {
  it('returns the stored map with its provenance', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    expect(await build(f).ownersOf(CH)).toEqual({ [PEER]: { by: 'hydrate', at: '2026-09-07T10:00:00.000Z' } });
  });

  it('returns {} for a scope with no row, rather than throwing', async () => {
    expect(await build(fakeDoc()).ownersOf(CH)).toEqual({});
  });

  it('returns {} when the read fails', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])], { failGet: true });
    expect(await build(f).ownersOf(CH)).toEqual({});
  });
});

// ── The standing no-cache constraint ─────────────────────────────────────────────────────────────
//
// A requirement, not a preference. The gateway's /reload is unreachable from outside the VPC, so any
// cache here is one an operator cannot invalidate.
describe('no cache, ever', () => {
  it('has no timer, TTL or clock-based expiry in the module source', () => {
    const src = require('node:fs').readFileSync(require.resolve('./owners.js'), 'utf-8');
    const body = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(body).not.toMatch(/setInterval|setTimeout|Date\.now\(\)|TTL/);
  });

  it('exposes no load/reload entry point', () => {
    const o = build(fakeDoc());
    expect(Object.keys(o).sort()).toEqual(['addOwner', 'bootstrapOwner', 'isOwner', 'ownedScopes', 'ownersOf']);
  });
});

// ── bootstrapOwner: first contact establishes ownership ──────────────────────────────────────────

describe('bootstrapOwner', () => {
  it('makes the mentioner the first owner of a scope nobody owns', async () => {
    const f = fakeDoc();
    expect(await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: ME })).toBe('created');
    expect(f.row(CH).owners[ME]).toMatchObject({ by: 'mention' });
  });

  // THE SECURITY PROPERTY, not an optimisation. Without the condition, @mentioning archie in an
  // already-owned channel would make the mentioner an owner of it.
  it('does NOTHING to a scope that already has owners', async () => {
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    expect(await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: ME })).toBe('already-owned');
    expect(Object.keys(f.row(CH).owners)).toEqual([PEER]);
  });

  it('is ONE write — safe to call on every turn with no preceding read', async () => {
    const f = fakeDoc();
    await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: ME });
    expect(f.seen).toHaveLength(1);
  });

  it('does not meter an already-owned scope as a failure — that is the common case', async () => {
    const emitted = [];
    const f = fakeDoc([ownersRow(CH, [PEER])]);
    await build(f, { metrics: { emitOwnerAdded: (a, p) => emitted.push({ a, ...p }) } })
      .bootstrapOwner({ scopeId: CH, ownerUserId: ME });
    expect(emitted).toEqual([]);
  });

  it('meters a created owner', async () => {
    const emitted = [];
    const f = fakeDoc();
    await build(f, { metrics: { emitOwnerAdded: (a, p) => emitted.push({ a, ...p }) } })
      .bootstrapOwner({ scopeId: CH, ownerUserId: ME });
    expect(emitted).toEqual([{ a: CH, ownerUserId: ME, by: 'mention', ok: true }]);
  });

  // Self-healing: a failure leaves the condition true, so the scope's next turn retries. That is why
  // this never throws into the turn path.
  it('reports failure instead of throwing, so a turn is never blocked on it', async () => {
    const f = fakeDoc();
    f.send = async () => { throw Object.assign(new Error('throughput'), { name: 'ProvisionedThroughputExceededException' }); };
    expect(await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: ME })).toBe('failed');
  });

  // CLAIMED ONCE, EVER. An empty owners map does NOT re-open a scope — that widening was tried and
  // reverted (see the condition's comment). A torn write in addOwner can leave `owners: {}` behind,
  // and treating that as unclaimed would let the next speaker in the channel take the agent.
  it('does NOT bootstrap over an empty owners map', async () => {
    const f = fakeDoc([{ pk: `AGENT#${CH}`, sk: 'OWNERS', owners: {} }]);
    expect(await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: ME })).toBe('already-owned');
    expect(f.row(CH).owners).toEqual({});
  });

  it('conditions on ABSENCE only, never on emptiness', async () => {
    const f = fakeDoc();
    await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: ME });
    const u = f.seen.find((x) => x.name === 'UpdateCommand');
    expect(u.input.ConditionExpression).toBe('attribute_not_exists(#owners)');
    expect(u.input.ConditionExpression).not.toMatch(/size/);
  });

  it('refuses a non-Slack user id without writing', async () => {
    const f = fakeDoc();
    expect(await build(f).bootstrapOwner({ scopeId: CH, ownerUserId: 'nope' })).toBe('failed');
    expect(f.seen).toHaveLength(0);
  });

  it('the bootstrapped owner can immediately select the scope', async () => {
    const f = fakeDoc();
    const o = build(f);
    await o.bootstrapOwner({ scopeId: CH, ownerUserId: ME });
    expect(await o.isOwner(ME, CH)).toBe(true);
    expect(await o.ownedScopes(ME)).toEqual(['dm-ux0mz5ckp2r', CH]);
  });
});

// ── No bots ──────────────────────────────────────────────────────────────────────────────────────
//
// Ownership is the right to point App Home at a scope. A bot has no App Home, so a bot owner is inert
// data in an authorization list. archie's own bot user id is an ordinary `U…`, so it was addable.

describe('bots cannot be owners', () => {
  const BOT = 'U62F5SY8X01';

  it('refuses a bot, with a name the caller can act on', async () => {
    const f = fakeDoc();
    const o = build(f, { isBotUser: async (u) => u === BOT });
    await expect(o.addOwner({ scopeId: CH, ownerUserId: BOT, by: PEER }))
      .rejects.toMatchObject({ name: 'OwnerIsBot' });
    expect(f.row(CH)).toBeNull();
  });

  it('writes NOTHING when it refuses', async () => {
    const f = fakeDoc();
    const o = build(f, { isBotUser: async () => true });
    await o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER }).catch(() => {});
    expect(f.seen.filter((x) => x.name === 'UpdateCommand')).toHaveLength(0);
  });

  it('still admits a person', async () => {
    const f = fakeDoc();
    const o = build(f, { isBotUser: async (u) => u === BOT });
    await o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER });
    expect(f.row(CH).owners[LISA]).toBeTruthy();
  });

  it('checks the NORMALISED id, so a lowercased bot id is still refused', async () => {
    const seen = [];
    const f = fakeDoc();
    const o = build(f, { isBotUser: async (u) => { seen.push(u); return u === BOT; } });
    await expect(o.addOwner({ scopeId: CH, ownerUserId: BOT.toLowerCase(), by: PEER }))
      .rejects.toMatchObject({ name: 'OwnerIsBot' });
    expect(seen).toEqual([BOT]);
  });

  // Refusing a legitimate add is visible and retryable; silently admitting an unverified id is not.
  it('FAILS CLOSED when the lookup itself fails', async () => {
    const f = fakeDoc();
    const o = build(f, { isBotUser: async () => { throw new Error('slack down'); } });
    await expect(o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER }))
      .rejects.toMatchObject({ name: 'OwnerUnverified' });
    expect(f.row(CH)).toBeNull();
  });

  it('refuses outright when no resolver was injected — never guesses', async () => {
    const o = createOwners({ doc: () => fakeDoc(), tableName: TABLE });
    await expect(o.addOwner({ scopeId: CH, ownerUserId: LISA, by: PEER }))
      .rejects.toThrow(/isBotUser resolver required/);
  });

  it('the shape check still runs first — a non-Slack id needs no lookup', async () => {
    let called = false;
    const f = fakeDoc();
    const o = build(f, { isBotUser: async () => { called = true; return false; } });
    await expect(o.addOwner({ scopeId: CH, ownerUserId: 'nope', by: PEER })).rejects.toThrow(/not a Slack user id/);
    expect(called).toBe(false);
  });

  // bootstrapOwner deliberately does NOT look a sender up — it is on the turn path. The caller
  // (index.js forwardToAgent) filters on event.bot_id and on our own bot user id instead.
  it('bootstrapOwner does not call the resolver at all', async () => {
    let called = false;
    const f = fakeDoc();
    const o = build(f, { isBotUser: async () => { called = true; return true; } });
    await o.bootstrapOwner({ scopeId: CH, ownerUserId: ME });
    expect(called).toBe(false);
  });
});

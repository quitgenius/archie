'use strict';
// owners.test.js — NEW for the archie port. The per-agent owners directory.

const { createOwnersDirectory } = require('./owners');

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A fake DynamoDBDocumentClient over an in-memory table of {pk, sk, data}. */
function fakeDoc(items, { failScan = false, failGet = false } = {}) {
  const calls = { scans: 0, gets: 0 };
  return {
    calls,
    doc: () => ({
      send: async (cmd) => {
        const name = cmd.constructor.name;
        if (name === 'ScanCommand') {
          calls.scans += 1;
          if (failScan) throw new Error('scan boom');
          // Honour the sk filter the module asks for, so the test exercises the real shape.
          return { Items: items.filter((i) => i.sk === 'CONFIG') };
        }
        calls.gets += 1;
        if (failGet) throw new Error('get boom');
        const { pk, sk } = cmd.input.Key;
        return { Item: items.find((i) => i.pk === pk && i.sk === sk) };
      },
    }),
  };
}
// The module builds commands via require('@aws-sdk/lib-dynamodb'); constructor.name is what
// the fake keys on, and those classes are real, so this stays honest about the call shape.

const cfg = (scope, owners) => ({ pk: `AGENT#${scope}`, sk: 'CONFIG', data: JSON.stringify(owners ? { owners } : {}) });

const FLEET = [
  cfg('ch-c66pp782t9k', ['ULRXOHM8VOT']),
  cfg('dm-ux0mz5ckp2r', ['UX0MZ5CKP2R']),
  cfg('ch-cr89fluhion', ['UX0MZ5CKP2R']),
  cfg('dm-ulrxohm8vot', ['UX0MZ5CKP2R']),
  cfg('dm-nobody', null),                                  // no owners key at all
  { pk: 'SKILL#x', sk: 'DEF', data: '{}' },                // must be ignored
  { pk: 'AGENT#dm-ux0mz5ckp2r', sk: 'META', data: '{}' },  // wrong sk, must be ignored
];

test('load builds scope-keyed maps from CONFIG rows', async () => {
  const f = fakeDoc(FLEET);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  const r = await d.load();
  expect(r.agents).toBe(4);
  expect(d.ownedAgentsFor('UX0MZ5CKP2R')).toEqual(['ch-cr89fluhion', 'dm-ux0mz5ckp2r', 'dm-ulrxohm8vot']);
  expect(d.ownedAgentsFor('ULRXOHM8VOT')).toEqual(['ch-c66pp782t9k']);
});

test('agents are keyed by SCOPE ID, not a config-repo name — no translation layer', async () => {
  const f = fakeDoc(FLEET);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  await d.load();
  // person79b333's directory name never appears; the hydrator already rekeyed it.
  expect(d.ownedAgentsFor('ULRXOHM8VOT')).not.toContain('person79b333');
  expect(d.ownedAgentsFor('ULRXOHM8VOT')).toContain('ch-c66pp782t9k');
});

test('owner ids are matched case-insensitively on the read side too', async () => {
  const f = fakeDoc([cfg('dm-x', ['ux0mz5ckp2r'])]);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  await d.load();
  expect(d.ownedAgentsFor('UX0MZ5CKP2R')).toEqual(['dm-x']);
  expect(await d.isOwner('UX0MZ5CKP2R', 'dm-x')).toBe(true);
});

test('non-agent rows and wrong-sk rows are ignored', async () => {
  const f = fakeDoc(FLEET);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  await d.load();
  const { agentOwners } = d._maps();
  expect(Object.keys(agentOwners).sort()).toEqual(
    ['ch-c66pp782t9k', 'ch-cr89fluhion', 'dm-ux0mz5ckp2r', 'dm-ulrxohm8vot'],
  );
});

test('a corrupt CONFIG row is skipped, not fatal to the whole directory', async () => {
  const f = fakeDoc([{ pk: 'AGENT#dm-bad', sk: 'CONFIG', data: '{not json' }, cfg('dm-good', ['U1'])]);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  await d.load();
  expect(d.ownedAgentsFor('U1')).toEqual(['dm-good']);
});

test('a failed scan KEEPS the previous directory rather than blanking it', async () => {
  // Blanking would hide every owned agent from its owner and read as a permissions change
  // rather than a read failure.
  const good = fakeDoc(FLEET);
  const d = createOwnersDirectory({ doc: good.doc, tableName: 't', log: silentLog });
  await d.load();
  const before = d.ownedAgentsFor('UX0MZ5CKP2R');

  // A directory that scans successfully once, then fails: the only way to observe that a
  // later failure preserves rather than clears the earlier result.
  const flip = { fail: false };
  const d3 = createOwnersDirectory({
    doc: () => ({ send: async (cmd) => {
      if (cmd.constructor.name === 'ScanCommand') {
        if (flip.fail) throw new Error('scan boom');
        return { Items: FLEET.filter((i) => i.sk === 'CONFIG') };
      }
      return { Item: undefined };
    } }),
    tableName: 't', log: silentLog,
  });
  await d3.load();
  flip.fail = true;
  const r = await d3.load();
  expect(r.stale).toBe(true);
  expect(d3.ownedAgentsFor('UX0MZ5CKP2R')).toEqual(before);
});

// ── isOwner: the authorization decision ──────────────────────────────────────

test('isOwner reads FRESH — never the boot-time list', async () => {
  const items = [cfg('ch-c66pp782t9k', ['ULRXOHM8VOT'])];
  const f = fakeDoc(items);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  await d.load();
  expect(await d.isOwner('ULRXOHM8VOT', 'ch-c66pp782t9k')).toBe(true);

  // Revoke in the "table" WITHOUT reloading. The cached list still says they own it; the
  // authorization decision must not.
  items[0] = cfg('ch-c66pp782t9k', ['UX0MZ5CKP2R']);
  expect(d.ownedAgentsFor('ULRXOHM8VOT')).toEqual(['ch-c66pp782t9k']);   // stale list
  expect(await d.isOwner('ULRXOHM8VOT', 'ch-c66pp782t9k')).toBe(false);  // fresh decision
});

test('isOwner refuses a non-owner and an agent with no owners', async () => {
  const f = fakeDoc(FLEET);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  expect(await d.isOwner('UX0MZ5CKP2R', 'ch-c66pp782t9k')).toBe(false); // person79b333 is the test user's
  expect(await d.isOwner('UX0MZ5CKP2R', 'dm-nobody')).toBe(false);      // no owners key
  expect(await d.isOwner('UX0MZ5CKP2R', 'ch-does-not-exist')).toBe(false);
});

test('isOwner FAILS CLOSED on a read error', async () => {
  const f = fakeDoc(FLEET, { failGet: true });
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  expect(await d.isOwner('UX0MZ5CKP2R', 'dm-ux0mz5ckp2r')).toBe(false);
});

test('isOwner refuses missing arguments rather than throwing', async () => {
  const f = fakeDoc(FLEET);
  const d = createOwnersDirectory({ doc: f.doc, tableName: 't', log: silentLog });
  expect(await d.isOwner(null, 'dm-x')).toBe(false);
  expect(await d.isOwner('U1', null)).toBe(false);
});

'use strict';

// vitest globals enabled via vitest.config.js

const { createAgentDirectory, composeLabel, OPTION_TEXT_MAX } = require('./agent-directory');
const { slackRefFromScopeId } = require('./agent-scope');

// ---------- fakes ----------
//
// The module takes `doc` as a GETTER and `slack` as an object, so neither the aws-sdk nor a Slack
// token is needed here. The fake DDB counts sends, because "the Scan happens once, at boot" is a
// behavioural claim this suite has to be able to break.

function fakeDoc(pages) {
  const state = { sends: 0, scans: 0 };
  const doc = {
    send(cmd) {
      state.sends += 1;
      const isScan = cmd && cmd.__type === 'scan';
      if (isScan) state.scans += 1;
      const page = pages[Math.min(state.scans - 1, pages.length - 1)];
      return Promise.resolve(page);
    },
  };
  return { get: () => doc, state };
}

// Stand in for @aws-sdk/lib-dynamodb's ScanCommand. agent-directory requires the real module, so the
// command object it builds is a real ScanCommand — we only need `send` to recognise it.
function tagScanCommands() {
  const lib = require('@aws-sdk/lib-dynamodb');
  const Real = lib.ScanCommand;
  if (Real.prototype.__type !== 'scan') {
    Object.defineProperty(Real.prototype, '__type', { value: 'scan', configurable: true });
  }
}
tagScanCommands();

function items(...pks) {
  return { Items: pks.map((pk) => ({ pk })) };
}

function fakeSlack({ members = [], channels = [], failList = null, userInfo = {}, channelInfo = {} } = {}) {
  const calls = { usersList: 0, channelsList: 0, usersInfo: 0, channelsInfo: 0 };
  return {
    calls,
    users: {
      list: async () => {
        calls.usersList += 1;
        if (failList === 'users') throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
        return { ok: true, members, response_metadata: { next_cursor: '' } };
      },
      info: async ({ user }) => {
        calls.usersInfo += 1;
        if (!userInfo[user]) throw new Error('user_not_found');
        return { ok: true, user: userInfo[user] };
      },
    },
    conversations: {
      list: async () => {
        calls.channelsList += 1;
        if (failList === 'channels') throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
        return { ok: true, channels, response_metadata: { next_cursor: '' } };
      },
      info: async ({ channel }) => {
        calls.channelsInfo += 1;
        if (!channelInfo[channel]) throw new Error('channel_not_found');
        return { ok: true, channel: channelInfo[channel] };
      },
    },
  };
}

// The real sandbox shape, so the fixtures are not invented: two Slack-minted agents, three BDD
// scopes, plus non-AGENT# partitions that must be ignored.
const SANDBOX_PAGE = items(
  'AGENT#dm-ux0mz5ckp2r', 'AGENT#dm-ux0mz5ckp2r', 'AGENT#dm-ux0mz5ckp2r',
  'AGENT#ch-cr89fluhion', 'AGENT#ch-cr89fluhion',
  'AGENT#bdd-tests',
  'RUNTIME#ch-cr89fluhion', 'GRANT#dm-ux0mz5ckp2r', 'CONFIG#image', 'SKILL#aws-readonly',
);

const SLACK = {
  members: [{ id: 'UX0MZ5CKP2R', real_name: 'personc73cc2', profile: { display_name: 'personc73cc2' } }],
  channels: [{ id: 'CR89FLUHION', name: 'sandbox-archie-perms' }],
};

function dir(pages = [SANDBOX_PAGE], slackOpts = SLACK) {
  const d = fakeDoc(pages);
  const slack = fakeSlack(slackOpts);
  return { directory: createAgentDirectory({ tableName: 't', doc: d.get, slack }), ddb: d.state, slack };
}

// ---------- the roster ----------

describe('roster — AGENT# is the source of truth', () => {
  it('lists distinct AGENT# scopes and ignores every other partition', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.all().map((e) => e.scopeId).sort())
      .toEqual(['bdd-tests', 'ch-cr89fluhion', 'dm-ux0mz5ckp2r']);
  });

  it('does NOT invent an agent from a RUNTIME# or GRANT# row', async () => {
    // The orphan rows in SANDBOX_PAGE are for scopes that DO have AGENT# rows, so prove the negative
    // directly: partitions with no AGENT# sibling at all.
    const { directory } = dir([items('RUNTIME#ch-cv2dcy47t7', 'GRANT#dm-uoc0tofhxc', 'AGENT#dm-ux0mz5ckp2r')]);
    await directory.load();
    expect(directory.all().map((e) => e.scopeId)).toEqual(['dm-ux0mz5ckp2r']);
    expect(directory.has('ch-cv2dcy47t7')).toBe(false);
    expect(directory.has('dm-uoc0tofhxc')).toBe(false);
  });

  it('follows LastEvaluatedKey across pages', async () => {
    const { directory } = dir([
      { ...items('AGENT#dm-ux0mz5ckp2r'), LastEvaluatedKey: { pk: 'x' } },
      items('AGENT#ch-cr89fluhion'),
    ]);
    await directory.load();
    expect(directory.size()).toBe(2);
  });

  it('scans ONCE at boot and never again on the search path', async () => {
    // The whole reason roster and labels are one structure: options-load fires per keystroke.
    const { directory, ddb } = dir();
    await directory.load();
    const afterBoot = ddb.scans;
    for (const q of ['m', 'ma', 'mat', 'sandbox']) directory.search(q);
    expect(afterBoot).toBe(1);
    expect(ddb.scans).toBe(1);
  });
});

// ---------- labels ----------

describe('labels — scope id is the only input', () => {
  it('resolves dm- to a person and ch- to a #channel', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.get('dm-ux0mz5ckp2r').label).toBe('personc73cc2 · dm-ux0mz5ckp2r');
    expect(directory.get('ch-cr89fluhion').label).toBe('#sandbox-archie-perms · ch-cr89fluhion');
  });

  it('falls back to the raw scope id for a scope Slack knows nothing about', async () => {
    const { directory } = dir();
    await directory.load();
    const e = directory.get('bdd-tests');
    expect(e.kind).toBe('other');
    expect(e.name).toBe(null);
    expect(e.label).toBe('bdd-tests');
  });

  it('uppercases the id to query Slack — a lowercased id is channel_not_found', async () => {
    // The scope id is lowercased by normaliseScopeId; conversations.info rejects that form. This is
    // the inverse the label path depends on, so pin it here as well as in agent-scope.test.js.
    expect(slackRefFromScopeId('ch-cr89fluhion')).toEqual({ kind: 'channel', id: 'CR89FLUHION' });
    expect(slackRefFromScopeId('dm-ux0mz5ckp2r')).toEqual({ kind: 'user', id: 'UX0MZ5CKP2R' });
    expect(slackRefFromScopeId('bdd-tests')).toBe(null);
  });

  it('keeps the scope id visible when the name is too long to fit', () => {
    const label = composeLabel('W'.repeat(120), 'dm-ux0mz5ckp2r');
    expect(label.length).toBeLessThanOrEqual(OPTION_TEXT_MAX);
    expect(label.endsWith('dm-ux0mz5ckp2r')).toBe(true);
  });

  it('degrades to raw ids when a bulk list 403s on missing_scope, instead of throwing', async () => {
    const { directory } = dir([SANDBOX_PAGE], { ...SLACK, failList: 'channels' });
    await expect(directory.load()).resolves.toBeTruthy();
    expect(directory.size()).toBe(3);                                   // roster intact
    expect(directory.get('ch-cr89fluhion').label).toBe('ch-cr89fluhion'); // label degraded
    expect(directory.get('dm-ux0mz5ckp2r').name).toBe('personc73cc2');   // the other rung unaffected
  });
});

// ---------- search ----------

describe('search — in-memory, no I/O', () => {
  it('matches on name and on scope id', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.search('sandbox h').map((e) => e.scopeId)).toEqual(['dm-ux0mz5ckp2r']);
    expect(directory.search('archie-perms').map((e) => e.scopeId)).toEqual(['ch-cr89fluhion']);
    expect(directory.search('c0bq07').map((e) => e.scopeId)).toEqual(['ch-cr89fluhion']);
  });

  it('an empty query returns everything, named agents first', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.search('').map((e) => e.scopeId)).toEqual(['ch-cr89fluhion', 'dm-ux0mz5ckp2r', 'bdd-tests']);
  });

  it('makes no Slack calls', async () => {
    const { directory, slack } = dir();
    await directory.load();
    const before = { ...slack.calls };
    directory.search('sandbox');
    expect(slack.calls).toEqual(before);
  });

  it('caps a response at the 100-option Slack limit', async () => {
    const many = items(...Array.from({ length: 150 }, (_, i) => `AGENT#bdd-${i}`));
    const { directory } = dir([many]);
    await directory.load();
    expect(directory.size()).toBe(150);
    expect(directory.search('bdd').length).toBe(100);
  });
});

// ---------- freshness: push only ----------

describe('freshness — push signals only, no TTL', () => {
  it('appends a newly minted scope with exactly ONE Slack call', async () => {
    const { directory, slack, ddb } = dir([SANDBOX_PAGE], {
      ...SLACK,
      channelInfo: { CMHP9RYCF1H: { id: 'CMHP9RYCF1H', name: 'sandbox-archie-private-test', is_private: true } },
    });
    await directory.load();
    const scansBefore = ddb.scans;

    expect(await directory.noteMinted('ch-cmhp9rycf1h')).toBe(true);

    expect(directory.get('ch-cmhp9rycf1h').label).toBe('#sandbox-archie-private-test · ch-cmhp9rycf1h');
    expect(slack.calls.channelsInfo).toBe(1);
    expect(ddb.scans).toBe(scansBefore);   // no re-scan: the mint hook is the signal
  });

  it('is a no-op for a scope already in the list', async () => {
    const { directory, slack } = dir();
    await directory.load();
    expect(await directory.noteMinted('dm-ux0mz5ckp2r')).toBe(false);
    expect(slack.calls.usersInfo).toBe(0);
  });

  it('still appends when naming the new scope fails — the agent must not go missing', async () => {
    const { directory } = dir();          // no channelInfo → conversations.info throws
    await directory.load();
    expect(await directory.noteMinted('ch-cmhp9rycf1h')).toBe(true);
    expect(directory.get('ch-cmhp9rycf1h').label).toBe('ch-cmhp9rycf1h');
  });

  it('relabels in place on channel_rename / group_rename', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.applyChannelRename({ id: 'CR89FLUHION', name: 'sandbox-archie-perms-renamed' })).toBe(true);
    expect(directory.get('ch-cr89fluhion').label).toBe('#sandbox-archie-perms-renamed · ch-cr89fluhion');
  });

  it('relabels in place on user_change, and ignores a no-op change', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.applyUserChange({ id: 'UX0MZ5CKP2R', profile: { display_name: 'personc73cc2' } })).toBe(false);
    expect(directory.applyUserChange({ id: 'UX0MZ5CKP2R', profile: { display_name: 'an operator H' } })).toBe(true);
    expect(directory.get('dm-ux0mz5ckp2r').label).toBe('an operator H · dm-ux0mz5ckp2r');
  });

  it('ignores a rename for a channel that is not an agent', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.applyChannelRename({ id: 'C20ITNKB2QC', name: 'general' })).toBe(false);
    expect(directory.size()).toBe(3);
  });
});

// ---------- the membership check the select handler relies on ----------

describe('has() — the validation gate for untrusted select input', () => {
  it('accepts a real agent and rejects anything else', async () => {
    const { directory } = dir();
    await directory.load();
    expect(directory.has('dm-ux0mz5ckp2r')).toBe(true);
    expect(directory.has('dm-u0000000000')).toBe(false);
    expect(directory.has('../../etc/passwd')).toBe(false);
    expect(directory.has('')).toBe(false);
    expect(directory.has(undefined)).toBe(false);
  });
});

// ---------- the standing constraint ----------

describe('no cache may go quietly stale', () => {
  it('the module contains no interval, timeout or TTL expiry', () => {
    const src = require('fs').readFileSync(require.resolve('./agent-directory.js'), 'utf8');
    // Comments explain WHY these are absent, so strip them before asserting on the code.
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/setInterval|setTimeout/);
    expect(code).not.toMatch(/TTL|Date\.now\(\)/);
  });

  it('reads neither the routing GSI nor any other partition as a census', () => {
    const src = require('fs').readFileSync(require.resolve('./agent-directory.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/IndexName/);
    expect(code).not.toMatch(/gsi1pk/);
  });
});

'use strict';

// vitest globals enabled via vitest.config.js
const { createAgentLabels } = require('./agent-labels');

const ME = 'UX0MZ5CKP2R';
const CH = 'CR89FLUHION';

/**
 * A Slack WebClient stand-in that RECORDS every call, because the point of this module is which
 * calls it makes and when. `pages` lets a method return a cursor so pagination is exercised.
 */
function fakeSlack({ users = [], channels = [], failUsers = null, failChannels = null, userPages = null, channelPages = null } = {}) {
  const calls = [];
  // The page counters live OUT here, not inside the per-call closure: a counter created per call
  // resets to zero every time, so the fake would serve page 0 forever with its cursor still set and
  // the module would spin to MAX_PAGES. (Got this wrong first time — the fake was the bug, not the
  // module.)
  const cursors = { members: 0, channels: 0 };
  const pager = (pages, key) => {
    const page = pages[Math.min(cursors[key], pages.length - 1)];
    cursors[key] += 1;
    return Promise.resolve({
      ok: true,
      [key]: page.items,
      response_metadata: { next_cursor: page.cursor || '' },
    });
  };
  return {
    calls,
    users: {
      list: (args) => {
        calls.push({ method: 'users.list', args });
        if (failUsers) return Promise.reject(failUsers);
        if (userPages) return pager(userPages, 'members');
        return Promise.resolve({ ok: true, members: users });
      },
    },
    conversations: {
      list: (args) => {
        calls.push({ method: 'conversations.list', args });
        if (failChannels) return Promise.reject(failChannels);
        if (channelPages) return pager(channelPages, 'channels');
        return Promise.resolve({ ok: true, channels });
      },
    },
  };
}

const MEMBERS = [{ id: ME, profile: { display_name: 'personc73cc2' }, real_name: 'person3018f1' }];
const CHANNELS = [{ id: CH, name: 'sandbox-archie-perms' }];

const build = (slack) => createAgentLabels({ slack });

// ── The three label rungs ────────────────────────────────────────────────────────────────────────

describe('labels', () => {
  it('names a dm- scope after the person and a ch- scope after the #channel', async () => {
    const entries = await build(fakeSlack({ users: MEMBERS, channels: CHANNELS }))
      .resolve(['dm-ux0mz5ckp2r', 'ch-cr89fluhion']);
    expect(entries[0]).toMatchObject({ scopeId: 'dm-ux0mz5ckp2r', kind: 'user', name: 'personc73cc2' });
    expect(entries[1]).toMatchObject({ scopeId: 'ch-cr89fluhion', kind: 'channel', name: '#sandbox-archie-perms' });
    expect(entries[0].label).toBe('personc73cc2 · dm-ux0mz5ckp2r');
  });

  it('prefers display_name, then real_name', async () => {
    const noDisplay = [{ id: ME, profile: {}, real_name: 'person3018f1' }];
    const [e] = await build(fakeSlack({ users: noDisplay })).resolve(['dm-ux0mz5ckp2r']);
    expect(e.name).toBe('person3018f1');
  });

  // The raw id is the HONEST answer for a scope that was never minted from Slack, and it is what an
  // operator needs to cross-check DynamoDB. Never invent a name.
  it('falls back to the raw scope id for a scope Slack knows nothing about', async () => {
    const [e] = await build(fakeSlack({ users: MEMBERS })).resolve(['bdd-tests']);
    expect(e).toMatchObject({ scopeId: 'bdd-tests', kind: 'other', name: null, label: 'bdd-tests' });
  });

  it('falls back to the raw id for a well-formed scope Slack has no record of', async () => {
    const [e] = await build(fakeSlack({ users: [] })).resolve(['dm-ux0mz5ckp2r']);
    expect(e).toMatchObject({ kind: 'user', name: null, label: 'dm-ux0mz5ckp2r' });
  });

  it('preserves the ORDER it was given — the caller put the own scope first', async () => {
    const scopes = ['dm-ux0mz5ckp2r', 'ch-cr89fluhion', 'bdd-tests'];
    const entries = await build(fakeSlack({ users: MEMBERS, channels: CHANNELS })).resolve(scopes);
    expect(entries.map((e) => e.scopeId)).toEqual(scopes);
  });

  it('uppercases the Slack id it looks up, because a lowercased one is a silent miss', async () => {
    // normaliseScopeId lowercased an uppercase-only alphabet, so recovery is lossless — and
    // conversations.info rejects a lowercased id outright.
    const [e] = await build(fakeSlack({ channels: CHANNELS })).resolve(['ch-cr89fluhion']);
    expect(e.name).toBe('#sandbox-archie-perms');
  });
});

// ── Which calls it makes ─────────────────────────────────────────────────────────────────────────

describe('Slack call budget', () => {
  it('makes at most one call per KIND, however many scopes are asked for', async () => {
    const slack = fakeSlack({ users: MEMBERS, channels: CHANNELS });
    await build(slack).resolve(['dm-ux0mz5ckp2r', 'dm-umrsp7355u7', 'ch-cr89fluhion', 'ch-cla9ne1dvia']);
    expect(slack.calls.filter((c) => c.method === 'users.list')).toHaveLength(1);
    expect(slack.calls.filter((c) => c.method === 'conversations.list')).toHaveLength(1);
  });

  it('does not call conversations.list when no channel scope was asked for', async () => {
    const slack = fakeSlack({ users: MEMBERS });
    await build(slack).resolve(['dm-ux0mz5ckp2r']);
    expect(slack.calls.map((c) => c.method)).toEqual(['users.list']);
  });

  it('does not call users.list when no dm scope was asked for', async () => {
    const slack = fakeSlack({ channels: CHANNELS });
    await build(slack).resolve(['ch-cr89fluhion']);
    expect(slack.calls.map((c) => c.method)).toEqual(['conversations.list']);
  });

  it('makes no calls at all for an empty set, or one with no Slack-derived scope', async () => {
    const slack = fakeSlack();
    expect(await build(slack).resolve([])).toEqual([]);
    await build(slack).resolve(['bdd-tests']);
    expect(slack.calls).toHaveLength(0);
  });

  // private_channel MUST be named explicitly or the call returns public channels only, and archie
  // serves private channels.
  it('asks for private channels as well as public', async () => {
    const slack = fakeSlack({ channels: CHANNELS });
    await build(slack).resolve(['ch-cr89fluhion']);
    const args = slack.calls.find((c) => c.method === 'conversations.list').args;
    expect(args.types).toBe('public_channel,private_channel');
  });

  it('follows next_cursor across pages', async () => {
    const slack = fakeSlack({
      channelPages: [
        { items: [{ id: 'C1', name: 'one' }], cursor: 'more' },
        { items: [{ id: CH, name: 'sandbox-archie-perms' }], cursor: '' },
      ],
    });
    const [e] = await build(slack).resolve(['ch-cr89fluhion']);
    expect(e.name).toBe('#sandbox-archie-perms');
    expect(slack.calls.filter((c) => c.method === 'conversations.list')).toHaveLength(2);
  });
});

// ── Degradation ──────────────────────────────────────────────────────────────────────────────────
//
// A lost scope makes the selector UGLY, never empty and never broken. missing_scope is the case that
// matters: it is what a reinstall with narrowed scopes looks like.

describe('degradation', () => {
  it('degrades to raw ids on missing_scope instead of throwing', async () => {
    const err = Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } });
    const entries = await build(fakeSlack({ users: MEMBERS, failChannels: err }))
      .resolve(['dm-ux0mz5ckp2r', 'ch-cr89fluhion']);
    expect(entries[0].name).toBe('personc73cc2');       // the kind that worked still works
    expect(entries[1].label).toBe('ch-cr89fluhion');    // the kind that failed degrades
  });

  it('degrades when the API returns ok:false rather than rejecting', async () => {
    const slack = fakeSlack();
    slack.users.list = () => Promise.resolve({ ok: false, error: 'ratelimited' });
    const [e] = await build(slack).resolve(['dm-ux0mz5ckp2r']);
    expect(e.label).toBe('dm-ux0mz5ckp2r');
  });

  it('one failing kind does not prevent the other from resolving', async () => {
    const err = new Error('boom');
    const entries = await build(fakeSlack({ channels: CHANNELS, failUsers: err }))
      .resolve(['dm-ux0mz5ckp2r', 'ch-cr89fluhion']);
    expect(entries[0].label).toBe('dm-ux0mz5ckp2r');
    expect(entries[1].name).toBe('#sandbox-archie-perms');
  });

  it('labelFor returns the raw id rather than an empty string when Slack fails', async () => {
    const [e] = await build(fakeSlack({ failUsers: new Error('boom') })).resolve(['dm-ux0mz5ckp2r']);
    expect(e.label).toBe('dm-ux0mz5ckp2r');
    expect(await build(fakeSlack({ failUsers: new Error('boom') })).labelFor('dm-ux0mz5ckp2r'))
      .toBe('dm-ux0mz5ckp2r');
  });

  it('labelFor returns an empty string for no scope, and does not call Slack', async () => {
    const slack = fakeSlack();
    expect(await build(slack).labelFor(null)).toBe('');
    expect(slack.calls).toHaveLength(0);
  });

  it('ignores non-string entries rather than labelling them', async () => {
    const entries = await build(fakeSlack({ users: MEMBERS })).resolve([null, '', 'dm-ux0mz5ckp2r', 42]);
    expect(entries.map((e) => e.scopeId)).toEqual(['dm-ux0mz5ckp2r']);
  });
});

// ── The standing no-cache constraint ─────────────────────────────────────────────────────────────

describe('no cache, ever', () => {
  it('resolves from Slack on EVERY call — nothing is remembered between them', async () => {
    const slack = fakeSlack({ users: MEMBERS });
    const labels = build(slack);
    await labels.resolve(['dm-ux0mz5ckp2r']);
    await labels.resolve(['dm-ux0mz5ckp2r']);
    expect(slack.calls.filter((c) => c.method === 'users.list')).toHaveLength(2);
  });

  it('picks up a rename with no invalidation step of any kind', async () => {
    let name = 'old-name';
    const slack = {
      calls: [],
      users: { list: () => Promise.resolve({ ok: true, members: [] }) },
      conversations: { list: () => Promise.resolve({ ok: true, channels: [{ id: CH, name }] }) },
    };
    const labels = createAgentLabels({ slack });
    expect((await labels.resolve(['ch-cr89fluhion']))[0].name).toBe('#old-name');
    name = 'new-name';
    expect((await labels.resolve(['ch-cr89fluhion']))[0].name).toBe('#new-name');
  });

  it('has no timer, TTL or clock-based expiry in the module source', () => {
    const src = require('fs').readFileSync(require.resolve('./agent-labels.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/setInterval|setTimeout|Date\.now\(\)|TTL/);
  });

  it('exposes no load, reload or invalidate entry point', () => {
    expect(Object.keys(build(fakeSlack())).sort()).toEqual(['labelFor', 'resolve']);
  });
});

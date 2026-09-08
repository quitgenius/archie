'use strict';

// vitest globals enabled via vitest.config.js
const { createAgentLabels } = require('./agent-labels');

const ME = 'UX0MZ5CKP2R';
const CH = 'CR89FLUHION';

/**
 * A Slack WebClient stand-in that RECORDS every call, because the point of this module is which
 * calls it makes and how many. Only `users.info` / `conversations.info` exist here — a fake that
 * offered `.list` would let a regression back to the bulk shape pass, and that shape took prod's
 * App Home down on 2026-09-08.
 */
function fakeSlack({ users = {}, channels = {}, failUsers = null, failChannels = null } = {}) {
  const calls = [];
  return {
    calls,
    users: {
      info: ({ user }) => {
        calls.push({ method: 'users.info', id: user });
        if (failUsers) return Promise.reject(failUsers);
        return Promise.resolve(users[user] ? { ok: true, user: users[user] } : { ok: true, user: {} });
      },
    },
    conversations: {
      info: ({ channel }) => {
        calls.push({ method: 'conversations.info', id: channel });
        if (failChannels) return Promise.reject(failChannels);
        return Promise.resolve(channels[channel] ? { ok: true, channel: channels[channel] } : { ok: true, channel: {} });
      },
    },
  };
}

const MEMBERS = { [ME]: { id: ME, profile: { display_name: 'personc73cc2' }, real_name: 'person3018f1' } };
const CHANNELS = { [CH]: { id: CH, name: 'sandbox-archie-perms' } };

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
    const noDisplay = { [ME]: { id: ME, profile: {}, real_name: 'person3018f1' } };
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
    const [e] = await build(fakeSlack({ users: {} })).resolve(['dm-ux0mz5ckp2r']);
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
  // THE REGRESSION GUARD. `conversations.list` is Tier 2 and paginated; one App Home render in a real
  // workspace costs many Tier-2 requests, and labelFor is awaited by every render. Per-scope `info`
  // is Tier 3/4 and one request each.
  it('uses per-scope info, NEVER a workspace list', () => {
    const slack = fakeSlack({ users: MEMBERS, channels: CHANNELS });
    expect(slack.users.list).toBeUndefined();
    expect(slack.conversations.list).toBeUndefined();
    const src = require('fs').readFileSync(require.resolve('./agent-labels.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/users\.list|conversations\.list/);
  });

  it('costs exactly ONE call for one scope — the App Home render path', async () => {
    const slack = fakeSlack({ users: MEMBERS });
    await build(slack).labelFor('dm-ux0mz5ckp2r');
    expect(slack.calls).toEqual([{ method: 'users.info', id: ME }]);
  });

  it('costs one call per scope, and asks only for the scopes given', async () => {
    const slack = fakeSlack({ users: MEMBERS, channels: CHANNELS });
    await build(slack).resolve(['dm-ux0mz5ckp2r', 'ch-cr89fluhion']);
    expect(slack.calls).toEqual([
      { method: 'users.info', id: ME },
      { method: 'conversations.info', id: CH },
    ]);
  });

  it('makes no calls at all for an empty set, or one with no Slack-derived scope', async () => {
    const slack = fakeSlack();
    expect(await build(slack).resolve([])).toEqual([]);
    await build(slack).resolve(['bdd-tests']);
    expect(slack.calls).toHaveLength(0);
  });

  // A viewer owning many scopes must not fire them all at once — that is how a Tier-3 budget goes in
  // one interaction.
  it('bounds concurrency rather than firing every lookup at once', async () => {
    let inFlight = 0;
    let peak = 0;
    const slack = {
      calls: [],
      users: {
        info: async ({ user }) => {
          inFlight += 1; peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 1));
          inFlight -= 1;
          return { ok: true, user: { id: user, name: user.toLowerCase() } };
        },
      },
      conversations: { info: async () => ({ ok: true, channel: {} }) },
    };
    const scopes = Array.from({ length: 20 }, (_, i) => `dm-ux0mz5ckp2${String.fromCharCode(97 + i)}`);
    await createAgentLabels({ slack }).resolve(scopes);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(5);
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

  // The one that took prod down. It must cost this entry its NAME and nothing else — no retry, no
  // sleep, no failed render.
  it('degrades IMMEDIATELY on a rate limit, one entry at a time', async () => {
    const err = Object.assign(new Error('A rate limit was exceeded'), { data: { error: 'ratelimited' }, code: 'slack_webapi_rate_limited_error' });
    const entries = await build(fakeSlack({ channels: CHANNELS, failUsers: err }))
      .resolve(['dm-ux0mz5ckp2r', 'ch-cr89fluhion']);
    expect(entries[0].label).toBe('dm-ux0mz5ckp2r');
    expect(entries[1].name).toBe('#sandbox-archie-perms');
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
    expect(slack.calls.filter((c) => c.method === 'users.info')).toHaveLength(2);
  });

  it('picks up a rename with no invalidation step of any kind', async () => {
    let name = 'old-name';
    const slack = {
      calls: [],
      users: { info: () => Promise.resolve({ ok: true, user: {} }) },
      conversations: { info: () => Promise.resolve({ ok: true, channel: { id: CH, name } }) },
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

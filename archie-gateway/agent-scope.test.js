// The scope-id rule is the one identity derivation in this system that MUST agree across three
// callers: the dispatcher (what an unrouted event mints), the rekey migration (what a named agent
// becomes), and cron hydration (who owns the jobs). They used to be three copies kept in step by a
// comment. These tests pin the rule, and the last one pins the agreement.

'use strict';

// CommonJS with vitest GLOBALS, matching every other test in this package (eslint parses
// slack-dispatcher as CJS, so a top-level `import` here is a parse error, not a style choice).
// The one ESM dependency — rekey-to-scope.mjs — is pulled in with a dynamic import inside the test
// that needs it.
const { normaliseScopeId, mintAgentName, scopeIdForRouting, slackRefFromScopeId } = require('./agent-scope');

describe('scope id — the §8.10 identity rule', () => {
  it('mints dm-<user> for a DM and ch-<channel> for a channel', () => {
    expect(mintAgentName({ channel_type: 'im', user: 'UX0MZ5CKP2R' })).toBe('dm-ux0mz5ckp2r');
    expect(mintAgentName({ channel_type: 'channel', channel: 'C01MG6IP6C8' })).toBe('ch-c01mg6ip6c8');
  });

  it('lowercases and slugs — the normalisation is contract, not tidying', () => {
    // Downstream derivations (runtime name, EFS path, IAM role name) all assume this form. Changing
    // any part of it re-keys every minted agent and splits them from their existing sessions.
    expect(normaliseScopeId('dm-U0B/DJA.6C')).toBe('dm-u0b-dja-6c');
    expect(normaliseScopeId('ch-C0A__B')).toBe('ch-c0a-b');
    expect(normaliseScopeId(`dm-${'U'.repeat(80)}`)).toHaveLength(48);
  });

  it('routing → scope id, with DM winning over channel', () => {
    expect(scopeIdForRouting({ dm_users: ['UX0MZ5CKP2R'] })).toBe('dm-ux0mz5ckp2r');
    expect(scopeIdForRouting({ channels: ['C01MG6IP6C8'] })).toBe('ch-c01mg6ip6c8');
    // agent-83l3pa is the ONE agent in the fleet with both (verified across many configs 2026-08-16).
    // The tie-break is stated rather than left to array order, because "whichever came first" is not
    // something a migration can rely on.
    expect(scopeIdForRouting({ channels: ['CP6ZWTFXI6R'], dm_users: ['UBB6NU5514B'] })).toBe('dm-ubb6nu5514b');
  });

  it('an agent that routes nothing has NO scope id — callers must refuse, not guess', () => {
    expect(scopeIdForRouting({})).toBe(null);
    expect(scopeIdForRouting({ channels: [], dm_users: [] })).toBe(null);
    expect(scopeIdForRouting(null)).toBe(null);
  });

  it('routing and minting agree — a rekeyed agent lands on the id a live event resolves to', () => {
    // THE INVARIANT. If these two ever disagree, the same human silently becomes two agents: one
    // holding the migrated config, sessions and grants, and one that every new message routes to.
    // It is invisible until someone notices their agent has forgotten everything.
    const user = 'UBB6NU5514B';
    expect(scopeIdForRouting({ dm_users: [user] })).toBe(mintAgentName({ channel_type: 'im', user }));

    const channel = 'CP6ZWTFXI6R';
    expect(scopeIdForRouting({ channels: [channel] })).toBe(mintAgentName({ channel_type: 'channel', channel }));
  });

  it('the inverse round-trips — minting then parsing returns the id you started with', () => {
    // THE INVARIANT THAT MATTERS for anything labelling a scope: normaliseScopeId lowercases, and
    // this is what says nothing was lost doing so. It holds only because Slack ids are an
    // uppercase-only alphabet; if that ever stopped being true, this is the test that would say so.
    for (const user of ['UX0MZ5CKP2R', 'UBB6NU5514B']) {
      expect(slackRefFromScopeId(mintAgentName({ channel_type: 'im', user }))).toEqual({ kind: 'user', id: user });
    }
    for (const channel of ['CR89FLUHION', 'CMHP9RYCF1H', 'CP6ZWTFXI6R']) {
      expect(slackRefFromScopeId(mintAgentName({ channel_type: 'channel', channel }))).toEqual({ kind: 'channel', id: channel });
    }
  });

  it('the inverse refuses rather than guesses', () => {
    // A scope that was never minted from Slack has no Slack object behind it. Returning null makes
    // the caller render the raw id; inventing an id would make it query Slack for something that
    // does not exist and silently show nothing.
    expect(slackRefFromScopeId('bdd-tests')).toBe(null);
    expect(slackRefFromScopeId('agent-xx9aff')).toBe(null);
    expect(slackRefFromScopeId('dm-')).toBe(null);
    expect(slackRefFromScopeId('')).toBe(null);
    expect(slackRefFromScopeId(null)).toBe(null);
    // {8,} on the channel arm, for the reason cron-inventory-metrics records: 'current' uppercases
    // to CURRENT, which a {6,} pattern accepted — a false ACCEPT, the direction that fails silently.
    expect(slackRefFromScopeId('ch-current')).toBe(null);
  });

  it('agrees with the rekey migration copy in config-resolver', async () => {
    // rekey-to-scope.mjs carries its own scopeIdFor, documented as an "EXACT mirror". It is ESM and
    // lives in another package, so it cannot simply require this module — but it CAN be checked
    // against it, which is what turns "keep in lockstep" from a comment into a gate.
    const { scopeIdFor } = await import('../archie-runner/config-resolver/rekey-to-scope.mjs');
    for (const meta of [
      { dm_users: ['UX0MZ5CKP2R'] },
      { channels: ['C01MG6IP6C8'] },
      { channels: ['CP6ZWTFXI6R'], dm_users: ['UBB6NU5514B'] },
      {},
    ]) {
      expect(scopeIdFor(meta)).toBe(scopeIdForRouting(meta));
    }
  });
});

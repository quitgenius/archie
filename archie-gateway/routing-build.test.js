'use strict';

// vitest globals enabled via vitest.config.js
const { buildRoutes, collectFromDdb } = require('./routing-build');

const cfgs = (obj) => Object.entries(obj).map(([agent, cfg]) => ({ agent, cfg }));

describe('buildRoutes (pure aggregation)', () => {
  it('maps dm_users + channels to agents; streaming defaults on; require_mention tracked', () => {
    const r = buildRoutes(cfgs({
      a: { dm_users: ['U1'], channels: ['C1'], require_mention: true },
      b: { dm_users: ['U2'], streaming: false },
    }));
    expect(r.dmUsers).toEqual({ U1: 'a', U2: 'b' });
    expect(r.channels).toEqual({ C1: 'a' });
    expect(r.requireMention.has('C1')).toBe(true);
    expect(r.streamingAgents.has('a')).toBe(true); // default on
    expect(r.streamingAgents.has('b')).toBe(false); // streaming:false
  });

  it('first writer wins on dm_user/channel conflict', () => {
    const r = buildRoutes(cfgs({
      a: { dm_users: ['U1'], channels: ['C1'] },
      b: { dm_users: ['U1'], channels: ['C1'] },
    }));
    expect(r.dmUsers.U1).toBe('a');
    expect(r.channels.C1).toBe('a');
  });

  // §8.10 identity=scope: the default route is fail-closed out, and the KEY IS ABSENT rather than
  // null — asserted with `toBeUndefined` + `in` so that re-adding `default: null` (which reads
  // harmlessly as "no default today") fails here too. is_default remains legal upstream in the
  // OpenClaw config repo, so it is warned about and ignored, never routed.
  it('is_default is ignored and no default key is produced (fail-closed)', () => {
    const r = buildRoutes(cfgs({
      a: { dm_users: ['U1'] },
      b: { dm_users: ['U2'], is_default: true },
    }));
    expect(r.default).toBeUndefined();
    expect('default' in r).toBe(false);
    expect(r.dmUsers.U2).toBe('b'); // its explicit dm route is unaffected
  });

  // The SLACK_ROUTES static-override layer is GONE. It was an env map merged on top of these
  // tables; under identity=scope an unrouted event mints its own scope agent, so there was nothing
  // left for a manual pin to rescue, and no environment ever set it. This asserts the option cannot
  // be revived by accident: an unknown opt is ignored, not merged.
  it('ignores a staticRoutes option — the override layer no longer exists', () => {
    const r = buildRoutes([], { staticRoutes: { U9: 'a', C9: 'b', default: 'c' } });
    expect(r.dmUsers).toEqual({});
    expect(r.channels).toEqual({});
    expect('default' in r).toBe(false);
  });

  it('keeps every agent — all are served by AgentCore (no deliverability filter)', () => {
    const r = buildRoutes(cfgs({
      a: { dm_users: ['U1'] },
      z: { dm_users: ['U2'], channels: ['C2'], require_mention: true },
    }));
    expect(r.dmUsers).toEqual({ U1: 'a', U2: 'z' });
    expect(r.channels).toEqual({ C2: 'z' });
    expect(r.requireMention.has('C2')).toBe(true);
  });

  it('a static default agent is NOT routed (identity=scope fail-closed)', () => {
    const r = buildRoutes([], { staticRoutes: { default: 'ghost' } });
    expect('default' in r).toBe(false);
    // and it must not have leaked into either real table under its own key
    expect(r.dmUsers.default).toBeUndefined();
    expect(r.channels.default).toBeUndefined();
    expect(Object.values(r.dmUsers)).not.toContain('ghost');
    expect(Object.values(r.channels)).not.toContain('ghost');
  });

  it('is_default in a config is still warned about, not silently dropped', () => {
    // The config repo can still carry it; silence would turn a stale config into an invisible no-op.
    const warns = [];
    buildRoutes([{ agent: 'a', cfg: { dm_users: ['U1'], is_default: true } }],
      { log: { info() {}, warn: (o, m) => warns.push(m), error() {} } });
    expect(warns.join(' ')).toMatch(/is_default is not supported/);
  });

  it('extraStreamingAgents are added to the streaming set', () => {
    const r = buildRoutes(cfgs({ a: { dm_users: ['U1'] } }), { extraStreamingAgents: ['x', 'y'] });
    expect(r.streamingAgents.has('x')).toBe(true);
    expect(r.streamingAgents.has('y')).toBe(true);
  });
});

describe('collectFromDdb (DDB source)', () => {
  // Fake DocumentClient: returns queued pages (Items + optional LastEvaluatedKey).
  const fakeDoc = (pages) => { let i = 0; return { send: async () => pages[i++] }; };
  const meta = (agent, cfg) => ({ gsi1sk: agent, data: JSON.stringify(cfg) });

  it('reads routing GSI items → [{agent,cfg}] sorted by agent, JSON-parsing the body', async () => {
    const doc = fakeDoc([{ Items: [meta('b', { dm_users: ['U2'] }), meta('a', { channels: ['C1'] })] }]);
    const got = await collectFromDdb(doc, 'tbl');
    expect(got).toEqual([{ agent: 'a', cfg: { channels: ['C1'] } }, { agent: 'b', cfg: { dm_users: ['U2'] } }]);
  });

  it('paginates across LastEvaluatedKey', async () => {
    const doc = fakeDoc([
      { Items: [meta('a', { dm_users: ['U1'] })], LastEvaluatedKey: { pk: 'x' } },
      { Items: [meta('b', { dm_users: ['U2'] })] },
    ]);
    const got = await collectFromDdb(doc, 'tbl');
    expect(got.map((c) => c.agent)).toEqual(['a', 'b']);
  });

  it('skips malformed META bodies (logs, does not throw)', async () => {
    const errs = [];
    const doc = fakeDoc([{ Items: [meta('a', { dm_users: ['U1'] }), { gsi1sk: 'bad', data: 'NOT JSON' }] }]);
    const got = await collectFromDdb(doc, 'tbl', { log: { error: (o) => errs.push(o), warn() {}, info() {} } });
    expect(got).toEqual([{ agent: 'a', cfg: { dm_users: ['U1'] } }]);
    expect(errs.length).toBe(1);
  });

  it('collectFromDdb feeds buildRoutes to the expected routes table', async () => {
    const configs = { a: { dm_users: ['U1'], channels: ['C1'] }, b: { dm_users: ['U2'] } };
    const doc = fakeDoc([{ Items: Object.entries(configs).map(([a, c]) => meta(a, c)) }]);
    const routes = buildRoutes(await collectFromDdb(doc, 'tbl'));
    expect(routes.dmUsers).toEqual({ U1: 'a', U2: 'b' });
    expect(routes.channels).toEqual({ C1: 'a' });
  });
});

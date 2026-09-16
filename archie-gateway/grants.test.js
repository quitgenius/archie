'use strict';

// vitest globals enabled via vitest.config.js
const grants = require('./grants');

const TABLE = 'agent-config-test';
const AGENT = 'dm-ux0mz5ckp2r';
const keyOf = (pk, sk) => `${pk}|${sk}`;
const GRANT_KEY = keyOf(`GRANT#${AGENT}`, 'SCOPE#*');
const CONFIG_KEY = keyOf(`AGENT#${AGENT}`, 'CONFIG');

/**
 * A DynamoDB document-client fake, same shape as cron-runner-flag.test.js's: bodies are an opaque
 * JSON string under `data`, and UpdateCommand is the only write verb — which is itself part of the
 * contract, since the dispatcher task role holds UpdateItem and nothing else. A PutCommand reaching
 * this fake throws rather than silently succeeding.
 */
function fakeDoc(items = []) {
  const store = new Map(items.map((i) => [keyOf(i.pk, i.sk), { ...i }]));
  const seen = [];
  let failNext = null;
  return {
    store,
    seen,
    failWith(err) { failNext = err; },
    body(k = GRANT_KEY) { return store.has(k) ? JSON.parse(store.get(k).data) : null; },
    async send(cmd) {
      if (failNext) { const e = failNext; failNext = null; throw e; }
      const name = cmd.constructor.name;
      const input = cmd.input;
      seen.push({ name, input });
      const k = keyOf(input.Key.pk, input.Key.sk);
      if (name === 'GetCommand') return { Item: store.get(k) };
      if (name === 'UpdateCommand') {
        store.set(k, { ...input.Key, data: input.ExpressionAttributeValues[':d'] });
        return {};
      }
      throw new Error(`unexpected DynamoDB command in a grant write: ${name}`);
    },
  };
}

const grantItem = (body) => ({ pk: `GRANT#${AGENT}`, sk: 'SCOPE#*', data: JSON.stringify(body) });
const configItem = (cfg) => ({ pk: `AGENT#${AGENT}`, sk: 'CONFIG', data: JSON.stringify(cfg) });

afterEach(() => { grants.setDerivedRoleHook(null); });

describe('the tool catalogue ships with the module', () => {
  it('resolves and carries the capabilities the tab needs', async () => {
    const c = await grants.toolCatalog();
    expect(Object.keys(c.tools).length).toBeGreaterThan(20);
    expect(c.capabilities.runtime.policy).toBe('deny');
    expect(c.capabilities['fs.read'].policy).toBe('allow');
    // The blast radius the tab must show. THREE tools, not four: `sessions_spawn` was carved out
    // into its own capability (2026-09-16) so an operator can grant sub-sessions without granting
    // arbitrary shell — the two are no longer one switch.
    expect(c.capabilities.runtime.tools).toEqual(['bash', 'exec', 'process']);
    expect(c.capabilities.spawn.tools).toEqual(['sessions_spawn']);
    // Default-deny, which is what makes building the tool unconditionally safe: with no grant the
    // filter drops it and the PEP refuses it, so the tab's toggle is the only control.
    expect(c.capabilities.spawn.policy).toBe('deny');
  });
});

describe('describeCapabilities', () => {
  it('splits baseline from grantable, and baseline reads as granted without a stored source', async () => {
    const { grantable, baseline } = await grants.describeCapabilities({});
    expect(baseline['fs.read'].granted).toBe(true);
    expect(baseline['fs.read'].sources).toEqual([]);
    expect(grantable.runtime.granted).toBe(false);
    expect(baseline.runtime).toBeUndefined();
  });

  it('separates manual from derived provenance so the tab can say who granted what', async () => {
    const { grantable } = await grants.describeCapabilities({
      'fs.write': { sources: ['agent-base', 'manual:U123', 'skill:understand'] },
    });
    expect(grantable['fs.write'].granted).toBe(true);
    expect(grantable['fs.write'].manualSources).toEqual(['manual:U123']);
    expect(grantable['fs.write'].derivedSources).toEqual(['agent-base', 'skill:understand']);
  });

  it('names a plugin\'s static tools, and leaves the dynamic surfaces empty', async () => {
    const { baseline } = await grants.describeCapabilities({});
    // file-publish registers one fixed tool whatever the agent's config says, so the tab can say
    // what the capability brings.
    expect(baseline['files.publish'].provider).toBe('file-publish');
    expect(baseline['files.publish'].tools).toEqual(['save_artifact']);
    // connector's surface comes from the agent's connected toolkits, so an empty list is CORRECT
    // here and is not the same thing as a missing declaration.
    expect(baseline.connector.tools).toEqual([]);
  });

  it('adds the agent\'s own MCP server capabilities, which no static catalogue can know', async () => {
    const { grantable } = await grants.describeCapabilities({}, ['demo_query_app', 'demo_warehouse']);
    expect(grantable.demo_query_app.policy).toBe('deny');
    expect(grantable.demo_query_app.provider).toBe('mcp-auth');
    expect(grantable.demo_query_app.tools).toEqual([]);
    expect(grantable.demo_warehouse.summary).toMatch(/data warehouse/); // demo_warehouse is in the catalogue, not synthesised
  });

  // A grant in force at the PEP that the tab omitted would understate the agent's access — the one
  // failure mode a permissions UI must not have.
  it('surfaces a stored capability the catalogue cannot describe rather than hiding it', async () => {
    const { grantable } = await grants.describeCapabilities({ 'some.future.cap': { sources: ['manual:U1'] } });
    expect(grantable['some.future.cap'].granted).toBe(true);
    expect(grantable['some.future.cap'].summary).toMatch(/older or newer image/);
  });

  it('reads a legacy flat {capabilities:[]} row as no provenance rather than throwing', async () => {
    const { grantable } = await grants.describeCapabilities({ capabilities: ['runtime'] });
    expect(grantable.runtime.granted).toBe(false);
  });
});

describe('assertGrantable rejects untrusted input', () => {
  it('refuses a baseline capability — there is nothing to grant', async () => {
    await expect(grants.assertGrantable('fs.read')).rejects.toThrow(/allowed by default/);
  });
  it('refuses an unknown capability', async () => {
    await expect(grants.assertGrantable('rm-rf-slash')).rejects.toThrow(/not a known capability/);
    await expect(grants.assertGrantable('')).rejects.toThrow(/capability required/);
  });
  it('accepts a per-agent MCP capability only when that agent actually has the server', async () => {
    await expect(grants.assertGrantable('demo_query_app')).rejects.toThrow(/not a known capability/);
    expect((await grants.assertGrantable('demo_query_app', ['demo_query_app'])).provider).toBe('mcp-auth');
  });
});

describe('grantCapability', () => {
  it('writes a manual: source and reports the tools it unlocks', async () => {
    const doc = fakeDoc();
    const r = await grants.grantCapability(doc, TABLE, AGENT, 'runtime', 'U123');
    expect(doc.body()).toEqual({ runtime: { sources: ['manual:U123'] } });
    expect(r.caps).toEqual(['runtime']);
    expect(r.alreadyGranted).toBe(false);
    expect(r.tools).toEqual(['bash', 'exec', 'process']);
  });

  it('adds to an existing capability without disturbing derived sources', async () => {
    const doc = fakeDoc([grantItem({ 'fs.write': { sources: ['skill:understand'] } })]);
    await grants.grantCapability(doc, TABLE, AGENT, 'fs.write', 'U123');
    expect(doc.body()['fs.write'].sources).toEqual(['manual:U123', 'skill:understand']);
  });

  it('is idempotent — approving twice does not duplicate a source or rewrite the row', async () => {
    const doc = fakeDoc([grantItem({ airflow: { sources: ['manual:U123'] } })]);
    const r = await grants.grantCapability(doc, TABLE, AGENT, 'airflow', 'U123');
    expect(r.alreadyGranted).toBe(true);
    expect(doc.seen.filter((s) => s.name === 'UpdateCommand')).toHaveLength(0);
  });

  it('writes with UpdateItem and the #d alias, never PutItem', async () => {
    const doc = fakeDoc();
    await grants.grantCapability(doc, TABLE, AGENT, 'datadog', 'U123');
    const w = doc.seen.find((s) => s.name === 'UpdateCommand');
    expect(w.input.UpdateExpression).toBe('SET #d = :d');
    expect(w.input.ExpressionAttributeNames).toEqual({ '#d': 'data' });
    expect(w.input.Key).toEqual({ pk: `GRANT#${AGENT}`, sk: 'SCOPE#*' });
  });

  it('refuses to overwrite an unparseable grant', async () => {
    const doc = fakeDoc([{ pk: `GRANT#${AGENT}`, sk: 'SCOPE#*', data: '{not json' }]);
    await expect(grants.grantCapability(doc, TABLE, AGENT, 'runtime', 'U123')).rejects.toThrow(/unparseable/);
    expect(doc.seen.filter((s) => s.name === 'UpdateCommand')).toHaveLength(0);
  });

  it('notifies the derived-role hook with old→new caps', async () => {
    const calls = [];
    grants.setDerivedRoleHook(async (gc) => { calls.push(gc); return { applied: true }; });
    const doc = fakeDoc([grantItem({ datadog: { sources: ['agent-base'] } })]);
    await grants.grantCapability(doc, TABLE, AGENT, 'aws-readonly', 'U123');
    expect(calls).toEqual([{ agentId: AGENT, oldCaps: ['datadog'], newCaps: ['aws-readonly', 'datadog'] }]);
  });

  // The row is what the PEP reads and it is already committed; reporting the whole operation as
  // failed because IAM lagged would be wrong, and `archie grants apply` repairs exactly this.
  it('survives a failing derived-role hook — the grant still stands', async () => {
    grants.setDerivedRoleHook(async () => { throw new Error('NoSuchEntity'); });
    const doc = fakeDoc();
    const r = await grants.grantCapability(doc, TABLE, AGENT, 'airflow', 'U123');
    expect(doc.body()).toEqual({ airflow: { sources: ['manual:U123'] } });
    expect(r.role).toEqual({ applied: false, reason: 'NoSuchEntity' });
  });
});

describe('revokeCapability', () => {
  it('removes the key entirely when no source remains', async () => {
    const doc = fakeDoc([grantItem({ runtime: { sources: ['manual:U123'] }, datadog: { sources: ['manual:U9'] } })]);
    const r = await grants.revokeCapability(doc, TABLE, AGENT, 'runtime', 'U123');
    expect(doc.body()).toEqual({ datadog: { sources: ['manual:U9'] } });
    expect(r.stillGranted).toBe(false);
    expect(r.removed).toEqual(['manual:U123']);
  });

  // The trap this avoids: refusing here would leave manual:U123 in place, and uninstalling the skill
  // later would restore access through an approval the user believes they withdrew.
  it('still removes the manual source when a skill holds the capability, and says so', async () => {
    const doc = fakeDoc([grantItem({ 'fs.write': { sources: ['manual:U123', 'skill:understand'] } })]);
    const r = await grants.revokeCapability(doc, TABLE, AGENT, 'fs.write', 'U123');
    expect(doc.body()['fs.write'].sources).toEqual(['skill:understand']);
    expect(r.stillGranted).toBe(true);
    expect(r.heldBy).toEqual(['skill:understand']);
  });

  it('removes every manual source, not only the caller\'s', async () => {
    const doc = fakeDoc([grantItem({ airflow: { sources: ['manual:U1', 'manual:U2'] } })]);
    const r = await grants.revokeCapability(doc, TABLE, AGENT, 'airflow', 'U2');
    expect(doc.body()).toEqual({});
    expect(r.removed).toEqual(['manual:U1', 'manual:U2']);
  });

  it('writes nothing when the capability is held only by agent-base', async () => {
    const doc = fakeDoc([grantItem({ runtime: { sources: ['agent-base'] } })]);
    const r = await grants.revokeCapability(doc, TABLE, AGENT, 'runtime', 'U123');
    expect(r.removed).toEqual([]);
    expect(r.stillGranted).toBe(true);
    expect(r.heldBy).toEqual(['agent-base']);
    expect(doc.seen.filter((s) => s.name === 'UpdateCommand')).toHaveLength(0);
  });

  it('is a no-op on a capability that was never granted', async () => {
    const doc = fakeDoc();
    const r = await grants.revokeCapability(doc, TABLE, AGENT, 'datadog', 'U123');
    expect(r.removed).toEqual([]);
    expect(r.stillGranted).toBe(false);
    expect(doc.seen.filter((s) => s.name === 'UpdateCommand')).toHaveLength(0);
  });
});

describe('extraCapsForAgent', () => {
  it('derives capabilities from the agent\'s MCP servers, aliasing demo_warehouse to demo_warehouse', async () => {
    const doc = fakeDoc([configItem({ connector: { extraMcpServers: [{ toolPrefix: 'demo_warehouse' }, { toolPrefix: 'demo_query_app' }] } })]);
    expect(await grants.extraCapsForAgent(doc, TABLE, AGENT)).toEqual(['demo_query_app', 'demo_warehouse']);
  });

  it('returns [] for an agent with no MCP servers', async () => {
    const doc = fakeDoc([configItem({ connector: {} })]);
    expect(await grants.extraCapsForAgent(doc, TABLE, AGENT)).toEqual([]);
  });

  // Omitting the MCP rows degrades the tab; throwing would take it down entirely.
  it('never throws — an unreadable config just omits the MCP capabilities', async () => {
    const doc = fakeDoc();
    doc.failWith(new Error('AccessDeniedException'));
    expect(await grants.extraCapsForAgent(doc, TABLE, AGENT)).toEqual([]);
    const bad = fakeDoc([{ pk: `AGENT#${AGENT}`, sk: 'CONFIG', data: '{nope' }]);
    expect(await grants.extraCapsForAgent(bad, TABLE, AGENT)).toEqual([]);
  });
});

describe('readGrant', () => {
  it('reports absence distinctly from an empty grant', async () => {
    expect(await grants.readGrant(fakeDoc(), TABLE, AGENT)).toEqual({ present: false, grant: {}, caps: [] });
    const doc = fakeDoc([grantItem({ runtime: { sources: ['manual:U1'] } })]);
    expect(await grants.readGrant(doc, TABLE, AGENT)).toEqual({
      present: true, grant: { runtime: { sources: ['manual:U1'] } }, caps: ['runtime'],
    });
  });
});

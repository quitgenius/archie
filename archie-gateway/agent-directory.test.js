'use strict';

// vitest globals enabled via vitest.config.js
//
// This file covers what is LEFT of agent-directory.js after the stateful directory was deleted:
// `scanAgentScopes` (the fleet enumerator the `archie` CLI reads) and `composeLabel` (the option
// text format). The roster/search/label-cache tests went with the factory they tested — the App Home
// selector now resolves owned scopes fresh from DynamoDB (owners.test.js) and labels them fresh from
// Slack (agent-labels.test.js).
const { scanAgentScopes, composeLabel, OPTION_TEXT_MAX } = require('./agent-directory');

// ---------- composeLabel ----------
//
// Slack caps an option's `text` at 75 chars. The SCOPE ID is never what gets dropped: it disambiguates
// two people with the same display name, and it is what an operator cross-checks against DynamoDB.

describe('composeLabel', () => {
  it('pairs the name with the scope id', () => {
    expect(composeLabel('personc73cc2', 'dm-ux0mz5ckp2r')).toBe('personc73cc2 \u00b7 dm-ux0mz5ckp2r');
  });

  it('falls back to the bare scope id when there is no name', () => {
    expect(composeLabel(null, 'bdd-tests')).toBe('bdd-tests');
  });

  it('truncates the NAME, never the scope id, and stays within the Slack cap', () => {
    const label = composeLabel('A'.repeat(200), 'dm-ux0mz5ckp2r');
    expect(label.length).toBeLessThanOrEqual(OPTION_TEXT_MAX);
    expect(label).toContain('dm-ux0mz5ckp2r');
    expect(label).toContain('\u2026');
  });

  it('drops the name entirely when the scope id alone fills the cap', () => {
    const long = `ch-${'c'.repeat(80)}`;
    const label = composeLabel('personc73cc2', long);
    expect(label.length).toBeLessThanOrEqual(OPTION_TEXT_MAX);
    expect(label).not.toContain('an operator');
  });
});

// ---------- the standing constraint ----------
//
// A requirement, not a preference: this module must hold no state that can go stale. It used to hold
// a boot-time roster and name cache whose only repair path was `POST /reload`, which is unreachable
// from outside the VPC.

describe('no state, no cache', () => {
  it('contains no interval, timeout or TTL expiry', () => {
    const src = require('fs').readFileSync(require.resolve('./agent-directory.js'), 'utf8');
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

  it('exports no factory — there is no directory object any more', () => {
    const mod = require('./agent-directory');
    expect(Object.keys(mod).sort()).toEqual(['OPTION_TEXT_MAX', 'composeLabel', 'scanAgentScopes']);
  });

  it('touches Slack nowhere — labelling moved to agent-labels.js', () => {
    const src = require('fs').readFileSync(require.resolve('./agent-directory.js'), 'utf8');
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/users\.list|conversations\.list|users\.info|conversations\.info/);
  });
});

// ---------- scanAgentScopes: the agent list ----------
//
// `AGENT#<scope>` partition keys ARE the list of agents. The single exception is the cron legacy-name
// alias, whose key is a config-repo directory name. It is not an agent, and every enumerator in the
// CLI runs off this function — including `agent teardown`, which would delete the pointer OpenClaw's
// cron gate follows.

describe('scanAgentScopes', () => {
  function scanDoc(items, bodies = {}) {
    const sent = [];
    const doc = {
      send(cmd) {
        sent.push(cmd);
        const input = cmd.input || {};
        if (input.Key) {
          const body = bodies[`${input.Key.pk}|${input.Key.sk}`];
          return Promise.resolve(body === undefined ? {} : { Item: { data: JSON.stringify(body) } });
        }
        return Promise.resolve({ Items: items });
      },
    };
    return { doc, sent };
  }

  const AGENT_ROWS = [
    { pk: 'AGENT#dm-ux0mz5ckp2r', sk: 'CONFIG' },
    { pk: 'AGENT#dm-ux0mz5ckp2r', sk: 'CRON' },
    { pk: 'AGENT#ch-cr89fluhion', sk: 'CONFIG' },
    { pk: 'GRANT#ch-cr89fluhion', sk: 'SCOPE#*' },
    { pk: 'CONFIG#image', sk: 'FLEET' },
  ];

  it('excludes the cron legacy-name alias — it is a pointer, not an agent', async () => {
    const items = [...AGENT_ROWS, { pk: 'AGENT#sandbox-archie-perms', sk: 'CRON' }];
    const { doc } = scanDoc(items, {
      'AGENT#sandbox-archie-perms|CRON': { alias: 'ch-cr89fluhion', setBy: 'hydrate:sandbox-archie-perms' },
    });
    expect(await scanAgentScopes(doc, 't')).toEqual(['ch-cr89fluhion', 'dm-ux0mz5ckp2r']);
  });

  it('keeps a CRON-only partition that holds a RUNNER row — that is a real minted agent', async () => {
    const items = [{ pk: 'AGENT#ch-c0new00000', sk: 'CRON' }];
    const { doc } = scanDoc(items, {
      'AGENT#ch-c0new00000|CRON': { runner: 'agentcore', setBy: 'hydrate' },
    });
    expect(await scanAgentScopes(doc, 't')).toEqual(['ch-c0new00000']);
  });

  it('disambiguates by BODY, never by the shape of the name', async () => {
    // `bdd-tests` looks exactly as legacy as `sandbox-archie-perms` does. Only the row says which.
    const items = [{ pk: 'AGENT#bdd-tests', sk: 'CRON' }];
    const { doc } = scanDoc(items, { 'AGENT#bdd-tests|CRON': { runner: 'openclaw' } });
    expect(await scanAgentScopes(doc, 't')).toEqual(['bdd-tests']);
  });

  it('keeps a scope whose CRON row is unreadable — over-listing beats hiding an agent', async () => {
    const items = [{ pk: 'AGENT#ch-ck34fg5rf', sk: 'CRON' }];
    const doc = { send: (cmd) => (cmd.input && cmd.input.Key
      ? Promise.reject(new Error('AccessDenied'))
      : Promise.resolve({ Items: items })) };
    expect(await scanAgentScopes(doc, 't')).toEqual(['ch-ck34fg5rf']);
  });

  it('costs no GetItem when every partition has a second sort key', async () => {
    const { doc, sent } = scanDoc(AGENT_ROWS);
    await scanAgentScopes(doc, 't');
    expect(sent.filter((c) => c.input && c.input.Key)).toHaveLength(0);
  });

  it('aliases both key attributes in the projection', async () => {
    const { doc, sent } = scanDoc(AGENT_ROWS);
    await scanAgentScopes(doc, 't');
    const scan = sent.find((c) => c.input && c.input.ProjectionExpression);
    expect(scan.input.ProjectionExpression).toBe('#pk, #sk');
    expect(scan.input.ExpressionAttributeNames).toEqual({ '#pk': 'pk', '#sk': 'sk' });
  });
});

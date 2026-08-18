'use strict';

// The deploy gates. Every check here exists because Cedar FAILS CLOSED, which means almost every mistake
// in these sources produces a policy that denies quietly rather than one that errors — so the tests that
// matter are the ones proving each check bites on its specific silent failure. A check that cannot fail
// is worse than no check, because it reads as proof.
//
// Two of these tests are regression tests for bugs the checks found in their own first run, and both are
// recorded rather than quietly fixed: the schema argument shape, and prose being mistaken for policy.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkValidates, checkCompleteness, checkBindings, checkMembership, diffDecisions,
  runSourceChecks, capabilityUniverse,
} = require('./policy-checks');
const { loadPolicySources } = require('./policy-sources');

const SANDBOX = loadPolicySources({ env: 'sandbox' });
const PROD = loadPolicySources({ env: 'prod' });
const clone = (s) => ({ ...s, pins: JSON.parse(JSON.stringify(s.pins)) });

test('check 1: the shipped policy validates with zero errors', () => {
  // REGRESSION: this first ran as "the schema itself does not parse", which was the CALL and not the
  // schema. cedar-wasm types Schema as `string | SchemaJson`, so the .cedarschema text is passed BARE;
  // wrapping it as {human: …} takes the JSON branch and fails with "invalid type: string" — an error that
  // reads like a broken schema. Measured against 4.12.0: bare string gives 0 errors, 0 warnings.
  const findings = checkValidates(SANDBOX);
  assert.deepEqual(findings.filter((f) => f.fatal), [], 'no fatal validation findings');
  assert.deepEqual(findings, [], 'and no warnings either, for the file as shipped');
});

test('check 1: a typo\'d capability is an ERROR, not a silently-dead statement', () => {
  // The whole reason capabilities are enumerated entity types rather than String attributes. If this ever
  // stops failing, every misspelled capability in the policy becomes a condition that never matches.
  const broken = { ...SANDBOX, semantics: `${SANDBOX.semantics}\npermit (principal, action, resource) when { resource.name == Archie::Capability::"nope" };\n` };
  const findings = checkValidates(broken);
  assert.ok(findings.some((f) => f.fatal), 'an unknown capability entity must be fatal');
});

test('check 2: a capability the runtime names but the policy omits is FATAL', () => {
  // Asymmetric failure: no entity means it denies through the grant permit (closed, safe) while a forbid
  // written for it would never fire (open). The safe-looking direction hides the unsafe one.
  const caps = { CAPABILITY_DEFAULTS: { 'fs.read': 'allow', 'brand-new-cap': 'deny', '*': 'deny' }, ALSO_ALLOW_CAP: {}, mcpCapabilities: [], hookOnly: [], slugs: [] };
  const findings = checkCompleteness(SANDBOX, caps);
  const fatal = findings.filter((f) => f.fatal);
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /'brand-new-cap' has no entity/);
});

test('check 2: `*` and empty-string mappings are not capabilities', () => {
  // '*' is CAPABILITY_DEFAULTS' fallthrough; '' is ALSO_ALLOW_CAP's "maps to no capability" (what
  // slack-reply-plugin is). Treating either as a capability would make this check permanently red.
  const caps = { CAPABILITY_DEFAULTS: { '*': 'deny' }, ALSO_ALLOW_CAP: { 'slack-reply-plugin': '' }, mcpCapabilities: [], hookOnly: [], slugs: [] };
  assert.deepEqual(checkCompleteness(SANDBOX, caps).filter((f) => f.fatal), []);
});

test('check 2: the real universe is complete against the shipped policy', async () => {
  // The forward direction over the ACTUAL runtime universe — four sources, not two. With only
  // CAPABILITY_DEFAULTS and ALSO_ALLOW_CAP this reported eleven false positives, because MCP-prefix
  // capabilities and the hook-only hindsight.write appear in no static token map.
  const caps = await capabilityUniverse(SANDBOX);
  assert.deepEqual(checkCompleteness(SANDBOX, caps).filter((f) => f.fatal), []);
  assert.ok(caps.mcpCapabilities.includes('demo_warehouse'), 'demo_warehouse maps to demo_warehouse through prefixToCapability');
  assert.ok(!caps.mcpCapabilities.includes('demo_warehouse'), 'the raw prefix is not the capability');
});

test('check 3: prose describing a REJECTED design is not a dangling reference', () => {
  // REGRESSION, and the reason this check reads parsed statements rather than the file. semantics.cedar
  // documents a `policy-managed` mirror that was deliberately NOT written ("omitted rather than written
  // as a no-op"). A regex over the source text reported it as a dangling group — punishing the file for
  // explaining itself.
  assert.match(String(SANDBOX.semantics), /ScopeGroup::"policy-managed"/, 'the prose really does mention it');
  assert.deepEqual(checkBindings(SANDBOX).filter((f) => f.fatal), [], 'but no statement does, so no finding');
});

test('check 3: both directions bite', () => {
  const missingPin = clone(SANDBOX);
  delete missingPin.pins.groups['pin.datadog'];
  assert.ok(checkBindings(missingPin).some((f) => f.fatal && /references ScopeGroup "pin\.datadog"/.test(f.message)),
    'a group the semantics uses and the pins lack is fatal — it denies the intended holder too');

  const deadGroup = clone(SANDBOX);
  deadGroup.pins.groups['pin.nothing-references-this'] = [];
  assert.ok(deadGroup && checkBindings(deadGroup).some((f) => /no statement references it/.test(f.message)),
    'a group nothing references is reported — its members hold nothing');
});

test('check 4: catches the bug that actually shipped to pins.prod.json', () => {
  // Two well-formed SANDBOX scope ids in prod's cloudwatch-logs group until 2026-08-18. Every shape check
  // passes them; publishing would have silently revoked sandbox's cloudwatch-logs on prod. This is the
  // canonical case for validating MEMBERSHIP rather than shape.
  // Every member of the CLEAN prod pins is a real prod scope — verified 2026-08-18 against the 213
  // items/routing surfaces through scopeIdFor(), 21/21. So using them as the known list isolates the two
  // ids under test; a hand-picked shorter list would flag the other groups' members too (measured: 15
  // findings instead of 2, the check working correctly on a wrong fixture).
  const { realKeys } = require('./policy-sources');
  const prodScopes = [...new Set(realKeys(PROD.pins.groups).flatMap((g) => PROD.pins.groups[g] || []))];
  const bad = clone(PROD);
  bad.pins.groups['pin.cloudwatch-logs'] = ['ch-c66pp782t9k', 'dm-umrsp7355u7', 'dm-ubb6nu5514b', 'dm-ux0mz5ckp2r'];
  const fatal = checkMembership(bad, prodScopes).filter((f) => f.fatal);
  assert.equal(fatal.length, 2);
  for (const id of ['ch-c66pp782t9k', 'dm-ux0mz5ckp2r']) {
    assert.ok(fatal.some((f) => f.message.includes(id)), `${id} is not a prod scope and must be caught`);
  }
});

test('check 4: an agent NAME instead of a scope id is caught by shape', () => {
  // The other, easier mistake: valid JSON, entirely plausible, and denies every intended holder.
  const bad = clone(SANDBOX);
  bad.pins.groups['pin.datadog'] = ['sandbox-person79b333-test'];
  assert.ok(checkMembership(bad, null).some((f) => f.fatal && /is not a scope id/.test(f.message)));
});

test('check 4: no scope list reports itself rather than passing vacuously', () => {
  // A check that silently does nothing is how it comes to be trusted while providing no cover.
  const findings = checkMembership(SANDBOX, null);
  assert.ok(findings.some((f) => !f.fatal && /not validated/.test(f.message)));
});

test('check 7: a text-only change is ZERO decision changes', () => {
  // The reason a policy diff needs an engine. Same verdicts, different everything else.
  const rows = [{ scope: 'ch-a', verdicts: { datadog: 'deny', airflow: 'allow' } }];
  const live = { 'ch-a': { scope: 'ch-a', policyDigest: 'sha256:different', verdicts: { airflow: 'allow', datadog: 'deny' } } };
  assert.deepEqual(diffDecisions(rows, live).changes, [], 'reordering and a moved digest change no decision');
});

test('check 7: a revocation and a first publish are both reported', () => {
  const rows = [{ scope: 'ch-a', verdicts: { datadog: 'deny' } }, { scope: 'ch-b', verdicts: { airflow: 'allow' } }];
  const live = { 'ch-a': { verdicts: { datadog: 'allow' } } };   // ch-b has no row at all
  const { changes, scopes } = diffDecisions(rows, live);
  assert.equal(scopes, 2);
  assert.deepEqual(changes.find((c) => c.scope === 'ch-a'), { scope: 'ch-a', capability: 'datadog', from: 'allow', to: 'deny' });
  // A scope with no row means pre-policy behaviour, so `from` is null — not "deny". Reporting it as a
  // change is correct: the first publish really does change what that scope may do.
  assert.deepEqual(changes.find((c) => c.scope === 'ch-b'), { scope: 'ch-b', capability: 'airflow', from: null, to: 'allow' });
});

test('the shipped sources pass every check, in both environments', async () => {
  for (const s of [SANDBOX, PROD]) {
    const caps = await capabilityUniverse(s);
    const fatal = runSourceChecks(s, { caps, knownScopes: null }).filter((f) => f.fatal);
    assert.deepEqual(fatal, [], `${s.env} has fatal findings`);
  }
});

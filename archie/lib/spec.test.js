'use strict';

// `derivedSpecFor` completeness — the guard that would have caught ca8e3619d.
//
// The spec is the dispatcher's own `runtimeSpecFor` output, carried through untouched. Every field
// in it is baked into CreateAgentRuntime and immutable afterwards, so a blank one provisions a
// runtime that is wrong from birth — and AgentCore reports it in terms that name neither the field
// nor the layer that blanked it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { derivedSpecFor } = require('./spec');
const { EXIT } = require('./exit');

/** A complete spec, in the shape agentcore-client's runtimeSpecFor returns. */
const full = () => ({
  image: 'acct.dkr.ecr.us-east-1.amazonaws.com/archie-agentcore:content-abc',
  efsRoot: '/openclaw-data/agents/dm-ux0mz5ckp2r',
  efsMountPath: '/mnt/efs',
  envs: { AGENT_NAME: 'dm-ux0mz5ckp2r' },
  securityGroupId: 'sg-REDACTED',
  idleRuntimeSessionTimeout: 900,
  maxLifetime: 28800,
  serverProtocol: 'HTTP',
});

const clientReturning = (spec) => ({ runtimeSpecFor: () => spec });

test('a complete spec passes through UNMODIFIED — the pass-through contract', () => {
  const spec = full();
  const out = derivedSpecFor(clientReturning(spec), 'dm-ux0mz5ckp2r', spec.image);
  assert.deepEqual(out, spec);
  assert.equal(out, spec, 'must be the same object, not a copy — fields added later must survive');
});

// THE REGRESSION. cmd/stage.js passed `{}` where it once read the stored generation, so these two
// arrived as `undefined` and mergeConfig's spread erased the values the deployed task definition had
// resolved. AgentCore said: "Value '[]' at 'networkConfiguration.networkModeConfig.securityGroups'".
test('a spec blanked by an undefined override is REFUSED, naming the fields', () => {
  const spec = { ...full(), securityGroupId: undefined, efsMountPath: undefined };
  assert.throws(
    () => derivedSpecFor(clientReturning(spec), 'ch-c66pp782t9k', spec.image),
    (e) => {
      assert.match(e.message, /ch-c66pp782t9k/);
      assert.match(e.message, /securityGroupId/);
      assert.match(e.message, /efsMountPath/);
      assert.equal(e.exitCode, EXIT.FAILED);
      return true;
    },
  );
});

// Every shape a blanked field actually arrives in. The array case is the one AgentCore saw: the SDK
// drops an undefined member, so `[config.securityGroupId]` serialises to `[]`.
for (const [label, value] of [
  ['undefined', undefined],
  ['null', null],
  ['an empty string', ''],
  ['an empty array', []],
  ['an empty object', {}],
]) {
  test(`${label} counts as blank`, () => {
    const spec = { ...full(), efsMountPath: value };
    assert.throws(() => derivedSpecFor(clientReturning(spec), 'a', spec.image), /efsMountPath/);
  });
}

// Falsy but MEANINGFUL values must survive — a numeric 0 or an explicit false is a decision, not an
// absence, and rejecting them would make the guard worse than the bug it replaces.
test('0 and false are values, not blanks', () => {
  const spec = { ...full(), idleRuntimeSessionTimeout: 0, someFlag: false };
  assert.doesNotThrow(() => derivedSpecFor(clientReturning(spec), 'a', spec.image));
});

// The check enumerates NOTHING, so a field introduced tomorrow is covered with no edit here. That is
// what lets this coexist with the pass-through contract rather than fighting it.
test('a field added later is covered without naming it', () => {
  const spec = { ...full(), fieldInventedTomorrow: '' };
  assert.throws(() => derivedSpecFor(clientReturning(spec), 'a', spec.image), /fieldInventedTomorrow/);
});

test('no spec at all is refused distinctly from a blank field', () => {
  assert.throws(() => derivedSpecFor(clientReturning(null), 'a', 'img'), /returned no spec/);
  assert.throws(() => derivedSpecFor(clientReturning('nope'), 'a', 'img'), /returned no spec/);
});

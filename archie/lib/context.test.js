'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  createContext, resourcesFor, basePolicyArnFor, resolveName, DEFAULT_NAME,
} = require('./context');
const { EXIT } = require('./exit');

const AWS = { needsAws: true };
const NO_AWS = { needsAws: false };

test('--region is required for AWS commands and is never defaulted', () => {
  // Deliberate: [profile sandbox] is us-east-2 while archie runs in us-east-1. Defaulting from the
  // profile would silently target the wrong region, which has already happened here.
  assert.throws(() => createContext({}, AWS, {}), (e) => e.exitCode === EXIT.USAGE && /--region is required/.test(e.message));
  assert.doesNotThrow(() => createContext({ region: 'us-east-1' }, AWS, {}));
});

test('--region is NOT required for commands that do not touch AWS', () => {
  const ctx = createContext({}, NO_AWS, {});
  assert.equal(ctx.region, null);
});

test('name resolution order: --name > --stack > ARCHIE_NAME > ARCHIE_STACK > default', () => {
  const env = { ARCHIE_NAME: 'from-name-env', ARCHIE_STACK: 'from-stack-env' };
  assert.equal(resolveName({ name: 'flag', stack: 'stackflag' }, env), 'flag');
  assert.equal(resolveName({ stack: 'stackflag' }, env), 'stackflag');
  assert.equal(resolveName({}, env), 'from-name-env');
  assert.equal(resolveName({}, { ARCHIE_STACK: 'from-stack-env' }), 'from-stack-env');
  assert.equal(resolveName({}, {}), DEFAULT_NAME);
});

test('the deprecated --stack path is flagged so the CLI can nudge', () => {
  assert.equal(createContext({ region: 'us-east-1', stack: 'x' }, AWS, {}).usedDeprecatedStackFlag, true);
  assert.equal(createContext({ region: 'us-east-1' }, AWS, { ARCHIE_STACK: 'x' }).usedDeprecatedStackFlag, true);
  assert.equal(createContext({ region: 'us-east-1', name: 'x' }, AWS, { ARCHIE_STACK: 'y' }).usedDeprecatedStackFlag, false);
  assert.equal(createContext({ region: 'us-east-1' }, AWS, { ARCHIE_NAME: 'x' }).usedDeprecatedStackFlag, false);
});

// ONE KNOB. Deriving some names from --name and leaving others literal produced a dashboard whose
// metric widgets read archie and whose log widgets read the OpenClaw stack. Every name, one string.
test('every resource name derives from --name', () => {
  const r = resourcesFor('agent-gn0p84');
  assert.deepEqual(r, {
    name: 'agent-gn0p84',
    configTable: 'agent-gn0p84-config',
    gatewayRepo: 'agent-gn0p84-gateway',
    agentRepo: 'agent-gn0p84core',
    cluster: 'agent-gn0p84',
    dispatcherService: 'agent-gn0p84-dispatcher',
    dispatcherLogGroup: '/ecs/agent-gn0p84-dispatcher',
    dispatcherNamespace: 'agent-gn0p84Dispatcher',
    cronNamespace: 'agent-gn0p84Cron',
    credentialSecret: 'agent-gn0p84-connector-api-key',
    dispatcherSharedSecret: 'agent-gn0p84-dispatcher-shared-secret',
    basePolicyName: 'agent-gn0p84core-base',
  });
  // No value may survive a rename — that is the whole invariant.
  for (const v of Object.values(resourcesFor('other'))) {
    assert.ok(!String(v).includes('agent-gn0p84'), `"${v}" did not follow the knob`);
  }
});

// REGRESSION (first sandbox rehearsal). `basePolicyName` was the one resource the knob did not
// derive, and the way it failed is why this has its own test rather than riding on the snapshot
// above: `cmd/preflight.js:617` derived `${name}-agentcore-base` and reported PASS, while the
// provisioning client fell back to a bare `agentcore-base` (agentcore-client.js:69) that does not
// exist in an archie account — so the gate went green and every single provision failed closed with
// NoSuchEntityException. A literal here is not a cosmetic drift; it is a fleet that cannot deploy.
test('the base policy ARN follows the knob, and carries the resolved account', () => {
  assert.equal(basePolicyArnFor(resourcesFor('agent-gn0p84'), '203366135563'),
    'arn:aws:iam::203366135563:policy/agent-gn0p84core-base');
  assert.equal(basePolicyArnFor(resourcesFor('other'), '543510375323'),
    'arn:aws:iam::543510375323:policy/other-agentcore-base');
  // Never the dispatcher's own default, which is what the fallback silently produced.
  assert.ok(!basePolicyArnFor(resourcesFor('agent-gn0p84'), '203366135563').endsWith(':policy/agentcore-base'));
});

test('dry-run defaults per command, and --no-dry-run overrides', () => {
  const destructive = { needsAws: true, dryRunDefault: true };
  assert.equal(createContext({ region: 'r' }, destructive, {}).dryRun, true, 'destructive defaults ON');
  assert.equal(createContext({ region: 'r' }, AWS, {}).dryRun, false, 'everything else defaults OFF');
  assert.equal(createContext({ region: 'r', 'no-dry-run': true }, destructive, {}).dryRun, false);
  assert.equal(createContext({ region: 'r', 'dry-run': true }, AWS, {}).dryRun, true);
});

test('--yes does not imply --no-dry-run, and never will', () => {
  // "stop asking me" and "start deleting things" are different requests.
  const ctx = createContext({ region: 'r', yes: true }, { needsAws: true, dryRunDefault: true }, {});
  assert.equal(ctx.assumeYes, true);
  assert.equal(ctx.dryRun, true);
});

test('--dry-run and --no-dry-run together is a usage error, not a silent winner', () => {
  assert.throws(
    () => createContext({ region: 'r', 'dry-run': true, 'no-dry-run': true }, AWS, {}),
    (e) => e.exitCode === EXIT.USAGE,
  );
});

test('-v counts repetitions', () => {
  assert.equal(createContext({ region: 'r' }, AWS, {}).verbosity, 0);
  assert.equal(createContext({ region: 'r', verbose: [true] }, AWS, {}).verbosity, 1);
  assert.equal(createContext({ region: 'r', verbose: [true, true] }, AWS, {}).verbosity, 2);
});

test('--timeout must be a positive number', () => {
  assert.equal(createContext({ region: 'r', timeout: '90' }, AWS, {}).timeoutSeconds, 90);
  for (const bad of ['0', '-5', 'soon']) {
    assert.throws(() => createContext({ region: 'r', timeout: bad }, AWS, {}), (e) => e.exitCode === EXIT.USAGE);
  }
});

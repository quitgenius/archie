'use strict';

const { diffObserved, specDiff } = require('./spec-diff');

// A spec as the dispatcher builds it (runtimeSpecFor).
const built = (over = {}) => ({
  image: '1234.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore:pi-obs-40',
  efsRoot: '/openclaw-data/agents/sandbox-person79b333-test',
  efsMountPath: '/mnt/efs',
  envs: { AGENT_ID: 'sandbox-person79b333-test', DISPATCHER_BASE_URL: 'https://d.example' },
  securityGroupId: 'sg-abc',
  idleRuntimeSessionTimeout: 900,
  maxLifetime: 28800,
  serverProtocol: 'HTTP',
  ...over,
});

// The same spec as read back from GetAgentRuntime: efsRoot recovered from the access point, plus the
// AP ARN that our own spec never carries.
const observed = (over = {}) => ({
  ...built(),
  efsAccessPoint: 'arn:aws:elasticfilesystem:us-east-1:203366135563:access-point/fsap-0abc',
  ...over,
});

describe('specDiff', () => {
  it('names the changed field', () => {
    expect(specDiff(built(), built({ image: 'repo:pi-obs-41' }))).toEqual(['image']);
  });

  it('reports env changes per key, not as one opaque "envs"', () => {
    const after = built({ envs: { AGENT_ID: 'sandbox-person79b333-test', DISPATCHER_BASE_URL: 'https://new.example' } });
    expect(specDiff(built(), after)).toEqual(['env.DISPATCHER_BASE_URL']);
  });

  it('reports an env key that was added or removed', () => {
    const after = built({ envs: { AGENT_ID: 'sandbox-person79b333-test' } });
    expect(specDiff(built(), after)).toEqual(['env.DISPATCHER_BASE_URL']);
  });

  it('reports every changed field, sorted', () => {
    expect(specDiff(built(), built({ image: 'repo:x', securityGroupId: 'sg-zzz' })))
      .toEqual(['image', 'securityGroupId']);
  });

  it('says "initial" when there is no previous spec', () => {
    expect(specDiff(null, built())).toEqual(['initial']);
  });

  // The live case that motivated this: sandbox-person79b333-test rolled 10481559 -> 22b6fd05 with no field
  // difference at all, because the HASH had widened from image-only to spec-wide. It reported
  // 'unknown', which reads like a broken readback rather than the true (and benign) answer.
  it('attributes an identical-spec roll to the fingerprint algorithm, not "unknown"', () => {
    expect(specDiff(built(), built())).toEqual(['fingerprint-algorithm']);
  });
});

describe('diffObserved', () => {
  it('does not report a phantom change for an unchanged filesystem (the AP ARN is not a diff)', () => {
    expect(diffObserved(observed(), built())).toEqual(['fingerprint-algorithm']);   // i.e. NO field differs
  });

  // THE migration case. Cutting the fleet from the test EFS root to the live one must be attributable;
  // before efsRoot was recovered from the access point this reported 'unknown'.
  it('attributes an EFS ROOT change to efsRoot', () => {
    const before = observed({ efsRoot: '/agentcore-test/agents/sandbox-person79b333-test' });
    const after = built({ efsRoot: '/openclaw-data/agents/sandbox-person79b333-test' });
    expect(diffObserved(before, after)).toEqual(['efsRoot']);
  });

  it('treats an unrecoverable root as unknown rather than as a change to undefined', () => {
    // DescribeAccessPoints failed (AP deleted under us): efsRoot is absent, not different.
    const before = observed({ efsRoot: undefined });
    expect(diffObserved(before, built())).toEqual(['fingerprint-algorithm']);
  });

  it('still names OTHER changes when the root is unrecoverable', () => {
    const before = observed({ efsRoot: undefined, image: 'repo:pi-obs-39' });
    expect(diffObserved(before, built())).toEqual(['image']);
  });

  it('says "initial" when there is nothing to compare against', () => {
    expect(diffObserved(null, built())).toEqual(['initial']);
  });
});

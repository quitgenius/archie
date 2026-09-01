'use strict';
// approvals-store.test.js
const os = require('node:os');
const path = require('node:path');

process.env.APPROVALS_DIR = path.join(os.tmpdir(), `approvals-test-${process.pid}`);
const store = require('./approvals-store');

const BASE = {
  agentId: 'agent-5ku1dq',
  approverUserId: 'U3NRRJMDVB6',
  requesterUserId: 'U3NRRJMDVB6',
  sessionKey: 'agent:agent-5ku1dq:main',
  toolSlug: 'SLACK_SEND_MESSAGE',
  destination: '@Craig Siegel (Slack DM)',
  destinationHash: 'dh1',
  contentHash: 'ch1',
  summary: 'HireRight_Monthly_Sanctions_Filled.xlsx — Here is the filled template…',
};

beforeEach(() => store._resetForTests());

test('createRequest returns a pending record with id', () => {
  const { record, deduped } = store.createRequest(BASE);
  expect(deduped).toBe(false);
  expect(record.state).toBe('pending');
  expect(record.id).toMatch(/[0-9a-f-]{36}/);
});

test('identical pending request dedupes to the same record', () => {
  const a = store.createRequest(BASE);
  const b = store.createRequest(BASE);
  expect(b.deduped).toBe(true);
  expect(b.record.id).toBe(a.record.id);
});

test('different contentHash is a new request', () => {
  const a = store.createRequest(BASE);
  const b = store.createRequest({ ...BASE, contentHash: 'ch2' });
  expect(b.record.id).not.toBe(a.record.id);
});

test('approve then redeem consumes single-use', () => {
  const { record } = store.createRequest(BASE);
  const ap = store.approve(record.id, BASE.approverUserId);
  expect(ap.ok).toBe(true);
  expect(ap.record.redeemBy).toBeGreaterThan(Date.now());
  const r1 = store.redeem({ agentId: BASE.agentId, toolSlug: BASE.toolSlug, destinationHash: 'dh1', contentHash: 'ch1' });
  expect(r1.ok).toBe(true);
  const r2 = store.redeem({ agentId: BASE.agentId, toolSlug: BASE.toolSlug, destinationHash: 'dh1', contentHash: 'ch1' });
  expect(r2.ok).toBe(false);
  expect(r2.error).toBe('no_matching_approval');
});

test('approve rejects wrong approver', () => {
  const { record } = store.createRequest(BASE);
  const ap = store.approve(record.id, 'U_AGENT_848O7L');
  expect(ap.ok).toBe(false);
  expect(ap.error).toBe('not_approver');
  expect(store.get(record.id).state).toBe('pending');
});

test('deny blocks redemption', () => {
  const { record } = store.createRequest(BASE);
  store.deny(record.id, BASE.approverUserId);
  const r = store.redeem({ agentId: BASE.agentId, toolSlug: BASE.toolSlug, destinationHash: 'dh1', contentHash: 'ch1' });
  expect(r.ok).toBe(false);
});

test('redeem after window lapses fails and marks lapsed', () => {
  const { record } = store.createRequest(BASE);
  store.approve(record.id, BASE.approverUserId);
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 16 * 60 * 1000);
  const r = store.redeem({ agentId: BASE.agentId, toolSlug: BASE.toolSlug, destinationHash: 'dh1', contentHash: 'ch1' });
  expect(r.ok).toBe(false);
  expect(r.error).toBe('redeem_window_lapsed');
  expect(store.get(record.id).state).toBe('lapsed');
  vi.useRealTimers();
});

test('listPending is per-approver, newest first; decisions listed separately', () => {
  const a = store.createRequest(BASE);
  const b = store.createRequest({ ...BASE, contentHash: 'ch2' });
  store.createRequest({ ...BASE, approverUserId: 'U_OTHER', contentHash: 'ch3' });
  expect(store.listPending(BASE.approverUserId).map((r) => r.id)).toEqual([b.record.id, a.record.id]);
  store.deny(a.record.id, BASE.approverUserId);
  expect(store.listPending(BASE.approverUserId)).toHaveLength(1);
  expect(store.listRecentDecisions(BASE.approverUserId)[0].id).toBe(a.record.id);
});

describe('multi-approver (owners-policy)', () => {
  const MULTI_BASE = {
    agentId: 'agent-ykdenu',
    approverUserId: 'A',
    approverUserIds: ['A', 'B', 'C'],
    requesterUserId: 'U_REQUESTER',
    sessionKey: 'agent:agent-ykdenu:main',
    toolSlug: 'SENSITIVE_ACTION',
    destination: 'redacted@example.com',
    destinationHash: 'dh_sensitive',
    contentHash: 'ch_sensitive',
    summary: 'Disable a sensitive action for jane',
  };

  beforeEach(() => store._resetForTests());

  it('listPending includes the record for all three approvers', () => {
    const { record } = store.createRequest(MULTI_BASE);
    expect(store.listPending('A').map((r) => r.id)).toContain(record.id);
    expect(store.listPending('B').map((r) => r.id)).toContain(record.id);
    expect(store.listPending('C').map((r) => r.id)).toContain(record.id);
    expect(store.listPending('Z')).toHaveLength(0);
  });

  it('approve by co-approver B: ok, decidedBy===B, and listPending for A no longer includes it', () => {
    const { record } = store.createRequest(MULTI_BASE);
    const res = store.approve(record.id, 'B');
    expect(res.ok).toBe(true);
    expect(res.record.state).toBe('approved');
    expect(res.record.decidedBy).toBe('B');
    // After decision, no longer pending
    expect(store.listPending('A')).toHaveLength(0);
    expect(store.listPending('B')).toHaveLength(0);
    expect(store.listPending('C')).toHaveLength(0);
  });

  it('approve by non-approver Z returns not_approver and does NOT change state', () => {
    const { record } = store.createRequest(MULTI_BASE);
    const res = store.approve(record.id, 'Z');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('not_approver');
    expect(store.get(record.id).state).toBe('pending');
  });

  it('deny by co-approver C: ok, decidedBy===C', () => {
    const { record } = store.createRequest(MULTI_BASE);
    const res = store.deny(record.id, 'C');
    expect(res.ok).toBe(true);
    expect(res.record.state).toBe('denied');
    expect(res.record.decidedBy).toBe('C');
  });

  it('back-compat: single approverUserId only (comms path) — listPending and approve work', () => {
    const { record } = store.createRequest({
      agentId: 'agent-5ku1dq',
      approverUserId: 'A',
      requesterUserId: 'A',
      sessionKey: 'agent:agent-5ku1dq:main',
      toolSlug: 'SLACK_SEND_MESSAGE',
      destination: '@Craig Siegel (Slack DM)',
      destinationHash: 'dh_comms',
      contentHash: 'ch_comms',
      summary: 'hi',
    });
    // Singular approver is included
    expect(store.listPending('A').map((r) => r.id)).toContain(record.id);
    // Co-approver B is NOT in the set (comms is single-approver)
    expect(store.listPending('B')).toHaveLength(0);
    // Approve by A works
    expect(store.approve(record.id, 'A').ok).toBe(true);
  });

  it('listRecentDecisions for a co-approver shows the decided record', () => {
    const { record } = store.createRequest(MULTI_BASE);
    store.approve(record.id, 'B');
    const decisions = store.listRecentDecisions('B');
    expect(decisions.map((r) => r.id)).toContain(record.id);
    // Also visible for the primary approver A (still a member of the set)
    expect(store.listRecentDecisions('A').map((r) => r.id)).toContain(record.id);
  });

  it('isApprover helper is exported and works for both singular and array', () => {
    const recordSingular = { approverUserId: 'X', approverUserIds: ['X'] };
    const recordMulti = { approverUserId: 'X', approverUserIds: ['X', 'Y', 'Z'] };
    const recordLegacy = { approverUserId: 'X' }; // no array field
    expect(store.isApprover(recordSingular, 'X')).toBe(true);
    expect(store.isApprover(recordMulti, 'Y')).toBe(true);
    expect(store.isApprover(recordMulti, 'Q')).toBe(false);
    // Legacy record: only singular field present
    expect(store.isApprover(recordLegacy, 'X')).toBe(true);
    expect(store.isApprover(recordLegacy, 'Y')).toBe(false);
  });
});

describe('per-toolSlug redeem window', () => {
  beforeEach(() => store._resetForTests());

  it('gives SENSITIVE_ACTION a 2h redeem window', () => {
    const { record } = store.createRequest({
      agentId: 'a', approverUserId: 'U1', requesterUserId: 'U2',
      toolSlug: 'SENSITIVE_ACTION', destination: 'redacted@example.com',
      destinationHash: 'dh', contentHash: 'ch', summary: 's',
    });
    const before = Date.now();
    const res = store.approve(record.id, 'U1');
    expect(res.ok).toBe(true);
    expect(res.record.redeemBy - before).toBeGreaterThanOrEqual(2 * 60 * 60 * 1000 - 50);
    expect(res.record.redeemBy - before).toBeLessThanOrEqual(2 * 60 * 60 * 1000 + 1000);
  });

  it('keeps the 15min default for comms slugs', () => {
    const { record } = store.createRequest({
      agentId: 'a', approverUserId: 'U1', requesterUserId: 'U2',
      toolSlug: 'SLACK_SEND_MESSAGE', destination: 'C1',
      destinationHash: 'dh', contentHash: 'ch', summary: 's',
    });
    const before = Date.now();
    const res = store.approve(record.id, 'U1');
    expect(res.record.redeemBy - before).toBeLessThanOrEqual(15 * 60 * 1000 + 1000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Opt-out. NEW COVERAGE, added with the archie port — upstream has none for this
// path, which is why the corrupt-load bug below survived. The opt-out is the comms
// gate's kill switch (per-AGENT, not per-user), so it is worth exercising directly
// rather than only through the App Home blocks.
// ─────────────────────────────────────────────────────────────────────────────

test('setOptOut round-trips through getOptOut and records who flipped it', () => {
  expect(store.getOptOut('dm-ux0mz5ckp2r')).toEqual({ optedOut: false });

  const before = Date.now();
  const res = store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' });
  expect(res.optedOut).toBe(true);

  const got = store.getOptOut('dm-ux0mz5ckp2r');
  expect(got.optedOut).toBe(true);
  expect(got.by).toBe('UX0MZ5CKP2R');
  expect(got.at).toBeGreaterThanOrEqual(before);
});

test('opting back in DELETES the entry rather than storing optedOut:false', () => {
  store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' });
  store.setOptOut('dm-ux0mz5ckp2r', { optedOut: false, by: 'UX0MZ5CKP2R' });

  // Absence is the representation of "gated". A falsy-but-present entry would still
  // be truthy to `data.optOut[agentId]` in some readers, so assert deletion, not shape.
  expect(store.getOptOut('dm-ux0mz5ckp2r')).toEqual({ optedOut: false });
});

test('opt-out is scoped to one agent and does not leak to another', () => {
  store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' });
  expect(store.getOptOut('dm-ulrxohm8vot').optedOut).toBe(false);
});

test('setOptOut does not throw after a corrupt/partial file load', () => {
  // The regression this guards: the corrupt-file catch in load() used to return
  // `{version:1, approvals:[]}` with no `optOut`, so the very next setOptOut threw
  // on `data.optOut[agentId] = …` — inside a Slack action handler, where it read as
  // a dead button. _resetForTests reproduces the same fresh-state shape.
  store._resetForTests();
  expect(() => store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' })).not.toThrow();
  expect(store.getOptOut('dm-ux0mz5ckp2r').optedOut).toBe(true);
});

test('saveSync flushes without throwing and leaves state readable', () => {
  // saveSync exists so a decision or an opt-out toggle is not lost in the debounce
  // window on SIGTERM. The durability itself is covered by the round-trip above;
  // what matters here is that the shutdown path is callable and non-destructive.
  store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' });
  expect(() => store.saveSync()).not.toThrow();
  expect(store.getOptOut('dm-ux0mz5ckp2r').optedOut).toBe(true);
});

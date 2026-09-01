'use strict';
const os = require('node:os');
const path = require('node:path');
process.env.APPROVALS_DIR = path.join(os.tmpdir(), `approvals-ep-test-${process.pid}`);
const store = require('./approvals-store');
const { makeApprovalHandlers } = require('./approvals-routes');

const BODY = {
  agentId: 'a1', approverUserId: 'U1', requesterUserId: 'U1',
  sessionKey: 'agent:a1:main', toolSlug: 'SLACK_SEND_MESSAGE',
  destination: '#general', destinationHash: 'dh', contentHash: 'ch',
  summary: 's',
};

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

beforeEach(() => store._resetForTests());

test('create returns 201 with id and pings approver', async () => {
  const pings = [];
  const h = makeApprovalHandlers({ store, notifyApprover: async (r) => pings.push(r.id) });
  const res = mockRes();
  await h.create({ body: BODY }, res);
  expect(res.statusCode).toBe(201);
  expect(res.body.id).toBeTruthy();
  expect(pings).toHaveLength(1);
});

test('dedup does not re-ping', async () => {
  const pings = [];
  const h = makeApprovalHandlers({ store, notifyApprover: async (r) => pings.push(r.id) });
  await h.create({ body: BODY }, mockRes());
  const res = mockRes();
  await h.create({ body: BODY }, res);
  expect(res.body.deduped).toBe(true);
  expect(pings).toHaveLength(1);
});

test('create rejects missing fields', async () => {
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const res = mockRes();
  await h.create({ body: { agentId: 'a1' } }, res);
  expect(res.statusCode).toBe(400);
});

test('redeem 200 on approved, 409 otherwise', async () => {
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const createRes = mockRes();
  await h.create({ body: BODY }, createRes);
  const r1 = mockRes();
  await h.redeem({ body: { agentId: 'a1', toolSlug: 'SLACK_SEND_MESSAGE', destinationHash: 'dh', contentHash: 'ch' } }, r1);
  expect(r1.statusCode).toBe(409); // still pending
  store.approve(createRes.body.id, 'U1');
  const r2 = mockRes();
  await h.redeem({ body: { agentId: 'a1', toolSlug: 'SLACK_SEND_MESSAGE', destinationHash: 'dh', contentHash: 'ch' } }, r2);
  expect(r2.statusCode).toBe(200);
});

// Owners-policy (multi-approver) requests: the plugin posts the full approver set
// alongside the singular anchor. Regression guard — the array used to be dropped by
// the REQUIRED whitelist, leaving every co-approver unable to see or act on the request.
const MULTI_BODY = {
  ...BODY,
  approverUserId: 'U1',
  approverUserIds: ['U1', 'U2', 'U3'],
  toolSlug: 'SENSITIVE_ACTION',
  destination: 'redacted@example.com',
  destinationHash: 'dh_sensitive', contentHash: 'ch_sensitive',
  summary: 'Disable a sensitive action for jane',
};

test('create persists approverUserIds so every co-approver can see and act', async () => {
  const notified = [];
  const h = makeApprovalHandlers({
    store,
    notifyApprover: async (r) => notified.push(...r.approverUserIds),
  });
  const res = mockRes();
  await h.create({ body: MULTI_BODY }, res);

  const record = store.get(res.body.id);
  expect(record.approverUserIds).toEqual(['U1', 'U2', 'U3']);
  expect(notified).toEqual(['U1', 'U2', 'U3']);
  for (const id of ['U1', 'U2', 'U3']) {
    expect(store.listPending(id).map((r) => r.id)).toContain(record.id);
  }
  expect(store.listPending('U_STRANGER')).toHaveLength(0);
  // A co-approver who is not the anchor can decide it.
  expect(store.approve(record.id, 'U3').ok).toBe(true);
});

test('create falls back to [approverUserId] when approverUserIds is absent or unusable', async () => {
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const { approverUserIds: _omitted, ...MULTI_BODY_WITHOUT_IDS } = MULTI_BODY;

  const noArray = mockRes();
  await h.create({ body: MULTI_BODY_WITHOUT_IDS }, noArray);
  expect(store.get(noArray.body.id).approverUserIds).toEqual(['U1']);

  store._resetForTests();
  const junk = mockRes();
  await h.create({ body: { ...MULTI_BODY, approverUserIds: [1, null, ''] } }, junk);
  expect(store.get(junk.body.id).approverUserIds).toEqual(['U1']);

  store._resetForTests();
  const notArray = mockRes();
  await h.create({ body: { ...MULTI_BODY, approverUserIds: 'U2' } }, notArray);
  expect(store.get(notArray.body.id).approverUserIds).toEqual(['U1']);
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /approvals/optout/:agentId. NEW COVERAGE with the archie port — upstream has
// none, and the route is also absent from the dispatcher README's endpoint table.
// This is the endpoint the plugin polls every 60s to decide whether the comms gate
// runs at all, so an unnoticed shape change here silently ungates the fleet.
// ─────────────────────────────────────────────────────────────────────────────

test('getOptOut reports false for an agent that has never opted out', async () => {
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const res = mockRes();
  await h.getOptOut({ params: { agentId: 'dm-ux0mz5ckp2r' } }, res);
  expect(res.statusCode).toBe(200);
  expect(res.body).toEqual({ optedOut: false });
});

test('getOptOut reports true with provenance once opted out', async () => {
  store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' });
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const res = mockRes();
  await h.getOptOut({ params: { agentId: 'dm-ux0mz5ckp2r' } }, res);
  expect(res.statusCode).toBe(200);
  expect(res.body.optedOut).toBe(true);
  expect(res.body.by).toBe('UX0MZ5CKP2R');
  expect(typeof res.body.at).toBe('number');
});

test('getOptOut is per-agent — one agent opting out does not ungate another', async () => {
  store.setOptOut('dm-ux0mz5ckp2r', { optedOut: true, by: 'UX0MZ5CKP2R' });
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const res = mockRes();
  await h.getOptOut({ params: { agentId: 'dm-ulrxohm8vot' } }, res);
  expect(res.body).toEqual({ optedOut: false });
});

test('getOptOut 400s on a missing agentId rather than answering for "undefined"', async () => {
  // Fail loudly: silently returning {optedOut:false} for a malformed request is
  // indistinguishable from a real answer, and the caller fail-safes to "gated" on a
  // non-200 — so a 400 is the safe outcome, not the unhelpful one.
  const h = makeApprovalHandlers({ store, notifyApprover: async () => {} });
  const res = mockRes();
  await h.getOptOut({ params: {} }, res);
  expect(res.statusCode).toBe(400);
  expect(res.body).toEqual({ error: 'missing agentId' });
});

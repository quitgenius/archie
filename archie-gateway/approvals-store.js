'use strict';
// Approval-request store for outbound-comms approvals. EFS-backed JSON,
// same persistence pattern as conversations.js. Pending records never
// expire; approved records must be redeemed within REDEEM_WINDOW_MS.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REDEEM_WINDOW_MS = 15 * 60 * 1000;
const REDEEM_WINDOW_OVERRIDES_MS = {
  // sensitive-action approvals get a longer window: the owner may need time to
  // approve and the agent then re-invokes to redeem. Comms keep the tight
  // default (an approved-but-unsent message should not linger redeemable).
  SENSITIVE_ACTION: 2 * 60 * 60 * 1000,
};
const DECIDED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_DEBOUNCE_MS = 500;

function windowForSlug(toolSlug) {
  return REDEEM_WINDOW_OVERRIDES_MS[toolSlug] ?? REDEEM_WINDOW_MS;
}

const DATA_DIR = process.env.APPROVALS_DIR || '/efs';
const DATA_FILE = path.join(DATA_DIR, 'approvals.json');

let data = { version: 1, approvals: [], optOut: {} };
let saveTimer = null;
let dirty = false;
let sequenceCounter = 0;

// ---------- Persistence ----------

function load() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      data = JSON.parse(raw);
      if (!data.approvals) data.approvals = [];
      if (!data.optOut) data.optOut = {};
      // Ensure all records have _seq; track max to continue sequencing
      data.approvals.forEach((r) => {
        if (typeof r._seq !== 'number') r._seq = 0;
        sequenceCounter = Math.max(sequenceCounter, r._seq || 0);
      });
    }
  } catch {
    // Missing file or corrupt JSON — start fresh.
    //
    // `optOut` MUST be present. It was omitted here upstream, so a corrupt or partial
    // file left `data.optOut` undefined and the next setOptOut() threw inside a Slack
    // action handler — the opt-out button silently dying at exactly the moment the
    // store was already unhealthy. Nothing caught it because the store's opt-out path
    // has no upstream test (see approvals-store.test.js in this directory, which adds one).
    data = { version: 1, approvals: [], optOut: {} };
  }
}

function save() {
  if (!dirty) return;
  dirty = false;
  try {
    // Ensure directory exists (first write after fresh EFS mount)
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

    // Prune decided records older than DECIDED_RETENTION_MS
    data.approvals = data.approvals.filter((r) =>
      r.state === 'pending' || r.state === 'approved' ||
      (r.decidedAt && Date.now() - r.decidedAt < DECIDED_RETENTION_MS)
    );

    // Atomic write: temp file + rename to avoid partial reads on crash
    const tmp = DATA_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  } catch {
    // Will retry on next debounce
    dirty = true;
  }
}

/**
 * Flush synchronously, for shutdown.
 *
 * `save()` is debounce-only (SAVE_DEBOUNCE_MS), and upstream nothing calls it on
 * SIGTERM — conversations.saveSync() is flushed there but approvals never were. So up
 * to one debounce window of decisions, and of opt-out toggles, was lost on every
 * deploy. Cancels the pending timer first so the timer cannot fire mid-shutdown and
 * re-dirty the state.
 */
function saveSync() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  save();
}

function scheduleSave() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, SAVE_DEBOUNCE_MS);
}

// ---------- API ----------

/**
 * Membership check for approval authorization.
 * Works for both multi-approver records (approverUserIds array) and legacy
 * single-approver records (approverUserId only, no array). Back-compat: a
 * stored record with only approverUserId (no approverUserIds) still authorizes
 * correctly via the singular half of the check.
 */
function isApprover(record, userId) {
  return (
    record.approverUserId === userId ||
    (Array.isArray(record.approverUserIds) && record.approverUserIds.includes(userId))
  );
}

function createRequest(fields) {
  const dupe = data.approvals.find(
    (r) => r.state === 'pending' &&
      r.agentId === fields.agentId && r.toolSlug === fields.toolSlug &&
      r.destinationHash === fields.destinationHash && r.contentHash === fields.contentHash,
  );
  if (dupe) return { record: dupe, deduped: true };

  // Persist approverUserIds: use the provided array (deduped) if non-empty;
  // otherwise default to a one-element array containing the singular approverUserId.
  // The singular approverUserId is always kept unchanged for backward compatibility.
  let approverUserIds;
  if (Array.isArray(fields.approverUserIds) && fields.approverUserIds.length > 0) {
    // Deduplicate preserving order
    approverUserIds = [...new Set(fields.approverUserIds)];
  } else {
    approverUserIds = [fields.approverUserId];
  }

  const record = {
    id: crypto.randomUUID(),
    ...fields,
    approverUserIds,
    state: 'pending',
    createdAt: Date.now(),
    decidedAt: null,
    redeemBy: null,
    _seq: ++sequenceCounter,
  };
  data.approvals.push(record);
  scheduleSave();
  return { record, deduped: false };
}

function approve(id, userId) {
  const r = data.approvals.find((x) => x.id === id);
  if (!r || r.state !== 'pending') return { ok: false, error: 'not_pending' };
  if (!isApprover(r, userId)) return { ok: false, error: 'not_approver' };
  r.state = 'approved';
  r.decidedAt = Date.now();
  r.decidedBy = userId;
  r.redeemBy = r.decidedAt + windowForSlug(r.toolSlug);
  scheduleSave();
  return { ok: true, record: r };
}

function deny(id, userId) {
  const r = data.approvals.find((x) => x.id === id);
  if (!r || r.state !== 'pending') return { ok: false, error: 'not_pending' };
  if (!isApprover(r, userId)) return { ok: false, error: 'not_approver' };
  r.state = 'denied';
  r.decidedAt = Date.now();
  r.decidedBy = userId;
  scheduleSave();
  return { ok: true, record: r };
}

function redeem(fields) {
  const { agentId, toolSlug, destinationHash, contentHash } = fields;
  const r = data.approvals.find((x) =>
    x.state === 'approved' &&
    x.agentId === agentId &&
    x.toolSlug === toolSlug &&
    x.destinationHash === destinationHash &&
    x.contentHash === contentHash
  );
  if (!r) return { ok: false, error: 'no_matching_approval' };
  if (Date.now() > r.redeemBy) {
    r.state = 'lapsed';
    scheduleSave();
    return { ok: false, error: 'redeem_window_lapsed' };
  }
  r.state = 'redeemed';
  scheduleSave();
  return { ok: true, record: r };
}

function listPending(userId) {
  return data.approvals
    .filter((r) => r.state === 'pending' && isApprover(r, userId))
    .sort((a, b) => b.createdAt - a.createdAt || b._seq - a._seq);
}

function listRecentDecisions(userId, limit = 10) {
  return data.approvals
    .filter((r) => isApprover(r, userId) && r.decidedAt !== null)
    .sort((a, b) => b.decidedAt - a.decidedAt || b._seq - a._seq)
    .slice(0, limit);
}

function get(id) {
  return data.approvals.find((r) => r.id === id) || null;
}

function _resetForTests() {
  data = { version: 1, approvals: [], optOut: {} };
  sequenceCounter = 0;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirty = false;
}

// Load from disk on module load
load();


// ---------- Comms-approval opt-out (per agent, owner-controlled) ----------

function setOptOut(agentId, { optedOut, by }) {
  if (optedOut) {
    data.optOut[agentId] = { by, at: Date.now() };
  } else {
    delete data.optOut[agentId];
  }
  scheduleSave();
  return { optedOut: Boolean(data.optOut[agentId]), by, at: data.optOut[agentId]?.at ?? null };
}

function getOptOut(agentId) {
  const entry = data.optOut[agentId];
  return entry ? { optedOut: true, by: entry.by, at: entry.at } : { optedOut: false };
}

module.exports = {
  createRequest, approve, deny, redeem, listPending, listRecentDecisions, get,
  saveSync,
  isApprover,
  setOptOut, getOptOut,
  REDEEM_WINDOW_MS, REDEEM_WINDOW_OVERRIDES_MS, windowForSlug, _resetForTests,
};

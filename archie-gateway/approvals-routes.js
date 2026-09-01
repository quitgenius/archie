'use strict';
// HTTP handlers for outbound-comms approvals. Auth (x-dispatcher-secret) is
// applied by the caller when registering routes; handlers assume authed reqs.

const REQUIRED = [
  'agentId', 'approverUserId', 'requesterUserId', 'sessionKey',
  'toolSlug', 'destination', 'destinationHash', 'contentHash', 'summary',
];

function makeApprovalHandlers({ store, notifyApprover, log }) {
  const _log = log || { info: () => {} };
  return {
    async create(req, res) {
      const body = req.body || {};
      const missing = REQUIRED.filter((k) => typeof body[k] !== 'string' || !body[k]);
      if (missing.length) return res.status(400).json({ error: `missing: ${missing.join(', ')}` });
      const fields = Object.fromEntries(REQUIRED.map((k) => [k, body[k]]));
      // Optional multi-approver set (owners-policy requests, e.g. SENSITIVE_ACTION).
      // Without this passthrough the store falls back to [approverUserId] and every
      // co-approver is silently dropped — no DM, nothing in their Approvals tab.
      if (Array.isArray(body.approverUserIds)) {
        const ids = body.approverUserIds.filter((x) => typeof x === 'string' && x);
        if (ids.length > 0) fields.approverUserIds = ids;
      }
      // Optional full message body for the approval card; capped server-side.
      if (typeof body.body === 'string' && body.body.length > 0) {
        fields.body = body.body.slice(0, 8000);
      }
      const { record, deduped } = store.createRequest(fields);
      // Silence is correct here, and the failure is NOT unobserved: _notifyApprover
      // already logs every rejected DM individually (Promise.allSettled + log.error per
      // approver). This outer catch guards only against the notifier itself throwing, and
      // must not turn a successfully PERSISTED approval into a 500 — the record exists and
      // is visible in the Approvals tab whether or not the courtesy DM landed. Failing the
      // request would instead make the plugin fail closed and tell the user the approvals
      // service is down, which would be false.
      // eslint-disable-next-line local/no-statementless-catch
      if (!deduped) await notifyApprover(record).catch(() => {});
      _log.info({ agentId: record.agentId, approver: record.approverUserId, toolSlug: record.toolSlug, destination: record.destination, deduped }, 'approval create');
      return res.status(201).json({ id: record.id, state: record.state, deduped });
    },
    async getOptOut(req, res) {
      const agentId = req.params?.agentId;
      if (!agentId) return res.status(400).json({ error: 'missing agentId' });
      return res.status(200).json(store.getOptOut(agentId));
    },
    async redeem(req, res) {
      const { agentId, toolSlug, destinationHash, contentHash } = req.body || {};
      if (!agentId || !toolSlug || !destinationHash || !contentHash) {
        return res.status(400).json({ ok: false, error: 'missing fields' });
      }
      const r = store.redeem({ agentId, toolSlug, destinationHash, contentHash });
      if (r.ok) {
        _log.info({ agentId, toolSlug, destination: r.record.destination, approver: r.record.approverUserId }, 'approval redeem ok');
      } else {
        _log.info({ agentId, toolSlug, error: r.error }, 'approval redeem rejected');
      }
      if (!r.ok) return res.status(409).json(r);
      return res.status(200).json({ ok: true, id: r.record.id });
    },
  };
}

function registerApprovalRoutes({ web, verifySecret, handlers }) {
  const authed = (fn) => (req, res) => {
    if (!verifySecret(req.headers['x-dispatcher-secret'])) return res.status(401).json({ error: 'unauthorized' });
    return fn(req, res);
  };
  web.post('/approvals', authed(handlers.create));
  web.post('/approvals/redeem', authed(handlers.redeem));
  web.get('/approvals/optout/:agentId', authed(handlers.getOptOut));
}

module.exports = { makeApprovalHandlers, registerApprovalRoutes };

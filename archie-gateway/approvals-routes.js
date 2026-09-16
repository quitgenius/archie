'use strict';
// HTTP handlers for outbound-comms approvals. Auth is applied by the dispatcher's global gate
// (dispatcher-auth.js) before these routes are reached; handlers assume authed reqs.

const REQUIRED = [
  'agentId', 'approverUserId', 'requesterUserId', 'sessionKey',
  'toolSlug', 'destination', 'destinationHash', 'contentHash', 'summary',
];

function makeApprovalHandlers({ store, notifyApprover, log }) {
  // All three levels. The upstream stub had only `info`, so the first warn/error added to this
  // module would throw TypeError inside a request handler — which is exactly what happened when
  // the rejection log below was added. A partial stub is worse than none: it type-checks by
  // duck-typing and fails only on the path you are adding.
  const _log = log || { info: () => {}, warn: () => {}, error: () => {} };
  return {
    async create(req, res) {
      const body = req.body || {};
      const missing = REQUIRED.filter((k) => typeof body[k] !== 'string' || !body[k]);
      if (missing.length) {
        // LOG THE REJECTION. Upstream returns this 400 before reaching the `approval create`
        // log below, so a malformed payload leaves NOTHING in the dispatcher's logs — and the
        // caller (approvals-client) collapses every failure into the same opaque
        // "approvals_unavailable", which the model then reports as "the approvals service is
        // unavailable". A field-name typo and a dead dispatcher are indistinguishable from
        // both ends. Cost us a bisect on 2026-09-01; this line is what would have avoided it.
        // agentId/toolSlug are logged when present so the line is attributable even though the
        // payload is by definition incomplete. No destination or content — those may be PHI.
        _log.warn({
          missing,
          agentId: typeof body.agentId === 'string' ? body.agentId : null,
          toolSlug: typeof body.toolSlug === 'string' ? body.toolSlug : null,
        }, 'approval create rejected — malformed payload');
        return res.status(400).json({ error: `missing: ${missing.join(', ')}` });
      }
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

/**
 * `authed` asserts that the global gate ALREADY authenticated this request, rather than
 * re-implementing it.
 *
 * It used to re-check the shared secret from the header itself. That became wrong the moment the
 * gate started accepting a per-turn token in the same header (dispatcher-auth.js): the token is not
 * the secret, so a correctly-authenticated agent would have been 401'd here — by a second check
 * whose only purpose was to repeat the first. Asserting the gate's OUTPUT keeps the belt-and-braces
 * against a future re-mount outside it, without knowing what a valid credential looks like.
 */
function registerApprovalRoutes({ web, handlers }) {
  const authed = (fn) => (req, res) => {
    if (!req.dispatcherAuth) return res.status(401).json({ error: 'unauthorized' });
    return fn(req, res);
  };
  web.post('/approvals', authed(handlers.create));
  web.post('/approvals/redeem', authed(handlers.redeem));
  web.get('/approvals/optout/:agentId', authed(handlers.getOptOut));
}

module.exports = { makeApprovalHandlers, registerApprovalRoutes };

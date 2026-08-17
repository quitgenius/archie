'use strict';

// Cron delivery (pi-cron-migration-plan.md §7). A cron turn is not streamed into a
// Slack thread the user is watching, so instead of the streaming bridge the fire
// handler collects the FINAL turn output and this routes it per job.delivery:
//   { mode: 'none' }                       -> side effect only, announce nothing
//   { mode: 'announce', channel?, to?, threadId? }
//        -> chat.postMessage. `channel`/`to` are resolved to a target by
//           cron-inventory-metrics.resolveDeliveryTarget (§12c): upstream `channel` selects a
//           TRANSPORT and `to` is the DESTINATION, so a user id in `to` means "DM that user".
//           `threadId` (NOT `to`) is the thread.
//
// REMOVED: { mode: 'webhook' }. It POSTed turn output to an arbitrary URL with NO validation —
// an unrestricted egress path for agent output in a PHI-adjacent system. Zero prod jobs used it
// (0 of 356, enabled or disabled), so removing it costs nothing and closes the hole. A webhook
// job is now rejected at add time as an unknown mode rather than silently degraded.
//
// Delivery is BEST-EFFORT and NEVER throws: the agent turn already ran, so a failed
// a failed announce must not be reported back as a turn failure (which would bump
// consecutiveErrors) nor poison later fires. Failures are logged and returned as
// { delivered: false, error }.

const { resolveDeliveryTarget } = require('./cron-inventory-metrics');

function extractText(final) {
  if (!final) return '';
  if (typeof final === 'string') return final;
  if (typeof final.text === 'string') return final.text;
  // buffered-invoke shape: { output: { response } }
  if (final.output && typeof final.output.response === 'string') return final.output.response;
  return '';
}

// The agent signals "nothing to say" with NO_REPLY (same sentinel the Slack path uses).
function isNoReply(text) {
  return !text || text.trim() === '' || text.trim() === 'NO_REPLY';
}

/**
 * @param deps.slack      Slack WebClient ({ chat: { postMessage } }).
 * @param deps.log        optional pino-shaped logger.
 * @param deps.onFailure  optional (job, { mode, error }) => void, called on a swallowed
 *                        delivery failure (§9r: cron-metrics' onDeliveryFailure → the
 *                        CronDeliveryFailure metric the alarm keys on). Because the failure
 *                        is swallowed, this hook is the ONLY thing that makes it alarmable.
 */
function createDeliver(deps = {}) {
  const slack = deps.slack;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const onFailure = deps.onFailure || (() => {});
  // user id -> DM channel. conversations.open is the deterministic path (verified live: it
  // returns DL1HA3II6V6 for UX0MZ5CKP2R and sends nothing; a raw user id is NOT accepted as a
  // channel — conversations.info rejects it with channel_not_found). Cached: 17 enabled prod jobs
  // target a user, and their DM ids never change.
  const dmCache = deps.dmCache || new Map();
  async function resolveUserDm(userId) {
    if (dmCache.has(userId)) return dmCache.get(userId);
    if (!slack) return null;
    const res = await slack.conversations.open({ users: userId });
    const ch = (res && res.channel && res.channel.id) || null;
    if (ch) dmCache.set(userId, ch);
    return ch;
  }

  async function deliver(job, final) {
    const delivery = job.delivery || { mode: 'none' };
    const mode = delivery.mode || 'none';
    const text = extractText(final);

    if (mode === 'none') return { delivered: false, reason: 'none' };
    if (isNoReply(text)) {
      log.info({ jobId: job.jobId, mode }, 'cron delivery skipped — no reply from turn');
      return { delivered: false, reason: 'no-reply' };
    }

    try {
      if (mode === 'announce') {
        if (!slack) throw new Error('no slack client configured');
        // §12c CORRECTION. This used to be `channel: delivery.channel` + `thread_ts: delivery.to`,
        // which reinterpreted BOTH fields:
        //   `channel` is a TRANSPORT selector upstream ('slack'/'webchat'/'last'), not a channel id
        //   `to`      is the DESTINATION (user/channel), not a thread — OpenClaw's thread field is
        //             `threadId`
        // That double misreading is the actual root cause of the "broken" jobs in §12b: an agent
        // writing {mode:'announce', to:'U…'} authored a VALID job meaning "DM this user", and we
        // posted it with channel:undefined + thread_ts:'U…'.
        const target = resolveDeliveryTarget(job);
        const channel = target && target.channel
          ? target.channel
          : (target && target.user ? await resolveUserDm(target.user) : null);
        if (!channel) throw new Error('cron: no resolvable delivery target (channel/to/sessionKey)');
        await slack.chat.postMessage({
          channel,
          ...(delivery.threadId ? { thread_ts: String(delivery.threadId) } : {}),
          text,
        });
        return { delivered: true, mode };
      }
      throw new Error(`unknown delivery mode "${mode}"`);
    } catch (err) {
      // Swallow: the turn already ran; a delivery failure must not poison the fire.
      const error = String(err && err.message);
      log.error({ jobId: job.jobId, agent: job.agentId, mode, err: error }, 'cron delivery failed');
      // ...but swallowed is not the same as invisible (§9r). Emit the metric the alarm keys on.
      // Guarded: a metrics failure must not convert a swallowed delivery failure into a thrown one,
      // which is exactly the poisoning this catch exists to prevent.
      try {
        onFailure(job, { mode, error });
      } catch (hookErr) {
        log.warn({ jobId: job.jobId, agent: job.agentId, err: String(hookErr && hookErr.message) }, 'cron delivery onFailure hook threw');
      }
      return { delivered: false, error };
    }
  }

  return { deliver, _extractText: extractText };
}

module.exports = { createDeliver };

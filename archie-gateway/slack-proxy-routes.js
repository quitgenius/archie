'use strict';

// Outbound Slack proxy — agent → dispatcher → Slack Web API.
//
// RESTORED 2026-09-03, at parity with the OpenClaw dispatcher (slack-dispatcher/index.js:2718).
// It was removed on 2026-08-11 as dead code: the AgentCore image did not ship slack-reply-plugin,
// so nothing called it. That changed — the Pi image now bundles the plugin and its `slack_send`
// tool posts here, because this is the ONLY path that speaks as ARCHIE'S OWN Slack app. The
// alternative the model reaches for otherwise is Connector's slack toolkit, which posts as the
// CONNECTOR app and resolves a bare user id against that app, so "DM an operator" lands in Connector's DM
// with an operator rather than ours (live-caught 2026-09-03 on the email-check-crayon cron).
//
// WHAT THE REMOVAL NOTE WARNED ABOUT, AND WHERE IT STANDS. The note called this an ungated
// Slack-WRITE surface: the only auth was the FLEET-WIDE shared secret, which every runtime could
// resolve at boot, so an agent holding `bash` could curl this directly and post as the bot in any
// channel the bot can see — past the tool-permission PEP, which only gates the TOOL. It was accepted
// as a DELIBERATE, TIME-BOXED choice (2026-09-03) on the grounds that it was parity with the
// OpenClaw surface running in production.
//
// HALF OF THAT IS NOW FIXED, and it is worth being precise about which half. Since phase 4 of
// archie-dispatcher-token-plan.md this route is TOKEN-ONLY: the credential is per-turn, scope-bound
// and revoked when the turn ends, and the fleet-wide secret is refused here and alarmed. So the
// CROSS-AGENT and PERSISTENT parts are gone — a leaked credential is one scope's, for one turn.
//
// WHAT REMAINS is the destination: an agent's own token still lets `bash` post as the bot in any
// channel the bot can see, because the caller names the channel. That is unchanged, still deliberate,
// and now ATTRIBUTABLE — every call logs scope-with-destination, which is the evidence any future
// restriction would be argued from.
//
// The bounded version, if and when it is assessed: take the destination OUT of the caller's hands.
// A `POST /api/slack/send` that carries the agent's scope id and resolves the channel server-side
// via agent-scope.js `slackRefFromScopeId` would confine a compromised agent to its OWN
// conversation, and would also delete the "model picks the channel" failure mode that caused the
// incident above. `slack_send` already defaults to nothing and requires an explicit channel, so
// that change is dispatcher-side only.
//
// NOT PORTED from OpenClaw, deliberately — both are coupled to mechanics archie does not have:
//   - the 🤔 → ✅ reaction swap: turn-lifecycle reactions were removed on 2026-08-13.
//   - `streaming.clearAllRuns(session, 'slack_send')`: that treats slack_send as the turn's
//     authoritative final message, which is an OpenClaw streaming assumption. Under Pi the
//     adapter streams the reply back over the InvokeAgentRuntime SSE response and the DISPATCHER
//     posts it, so an in-turn slack_send is an EXTRA message, not the terminal one.

// Keep this whitelist narrow — it is the blast radius of a compromised agent.
const ALLOWED_METHODS = new Set([
  'chat.postMessage',
  'chat.update',
  'chat.postEphemeral',
  'reactions.add',
  'files.uploadV2',
  'conversations.replies',
  'users.info',
]);

// Numeric Slack roots only: synthetic cron-<jobId> sessions have no reply thread.
function slackThreadTargetFromSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string') return null;
  const match = sessionKey.match(/(?:^|:)slack:thread:(?:dm:)?([^:]+):([0-9]+\.[0-9]+)(?::|$)/i);
  if (!match) return null;
  return { channel: match[1], threadTs: match[2] };
}

// Default same-DM replies to the session's root; preserve explicit and cross-channel targets.
function anchorDmPostMessage(method, body, sessionKey) {
  if (method !== 'chat.postMessage' || !body || body.thread_ts) return body;
  const channel = body.channel;
  if (typeof channel !== 'string' || !/^D[A-Z0-9]+$/i.test(channel)) return body;
  const target = slackThreadTargetFromSessionKey(sessionKey);
  if (!target || target.channel.toUpperCase() !== channel.toUpperCase()) return body;
  return { ...body, thread_ts: target.threadTs };
}

/**
 * @param slack             the WebClient (or its simulate-aware proxy)
 * @param isSimulateChannel (channel) => bool — C_SIMULATE* short-circuit, see below
 * @param log               pino logger
 */
function makeSlackProxyHandler({ slack, isSimulateChannel = () => false, log }) {
  return async function slackProxy(req, res) {
    const method = req.params.method;
    // ATTRIBUTABLE, DELIBERATELY NOT RESTRICTED (the plan's slack_send decision). This proxy can post
    // as Archie anywhere the bot is, and a token-authenticated caller does not change that — what it
    // changes is that we now know WHICH scope asked. Every call therefore logs scope-with-destination,
    // which is both the audit trail and the data any future restriction would have to be argued from.
    // `null` means a secret-authenticated caller, i.e. one with no derivable scope at all.
    const scope = (req.dispatcherAuth && req.dispatcherAuth.scope) || null;
    const child = log.child ? log.child({ slack_method: method, scope }) : log;
    if (!ALLOWED_METHODS.has(method)) {
      child.warn('method not allowed');
      return res.status(403).json({ ok: false, error: 'method not allowed' });
    }
    // The simulate short-circuit has to live HERE as well as on the `slack` Proxy. That proxy only
    // wraps NAMESPACED access (slack.chat.postMessage); `apiCall` is a plain function on the client,
    // so it comes back unwrapped and a C_SIMULATE* channel would reach real Slack and fail with
    // invalid_channel — silently breaking `/simulate`, whose whole job is to report which Slack
    // methods a turn calls.
    const sessionKey = req.get ? req.get('x-archie-session-key') : req.headers?.['x-archie-session-key'];
    const body = anchorDmPostMessage(method, req.body, sessionKey);
    const channel = body && body.channel;
    if (isSimulateChannel(channel)) {
      child.info({ channel, text: String((body && body.text) || '').slice(0, 200) },
        '[simulate] slack proxy call intercepted');
      return res.json({ ok: true, ts: `sim-proxy-${Date.now()}` });
    }
    try {
      const started = Date.now();
      const result = await slack.apiCall(method, body);
      child.info({
        latency_ms: Date.now() - started,
        ok: result && result.ok,
        destination: (body && body.channel) || null,
        thread_ts: body && body.thread_ts,
        thread_anchor_applied: Boolean(body && body.thread_ts && !(req.body && req.body.thread_ts)),
      }, 'slack api call ok');
      return res.json(result);
    } catch (err) {
      child.error({ err: err.message }, 'slack api call failed');
      return res.status(502).json({ ok: false, error: err.message });
    }
  };
}

// Mounted AFTER the x-dispatcher-secret middleware, which is what authenticates it.
function registerSlackProxyRoute({ web, slack, isSimulateChannel, log }) {
  web.post('/api/:method', makeSlackProxyHandler({ slack, isSimulateChannel, log }));
}

module.exports = {
  ALLOWED_METHODS,
  slackThreadTargetFromSessionKey,
  anchorDmPostMessage,
  makeSlackProxyHandler,
  registerSlackProxyRoute,
};

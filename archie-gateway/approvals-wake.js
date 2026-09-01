'use strict';

// Wake an agent after a human decides one of its outbound-comms approvals.
//
// WHY THIS IS ITS OWN MODULE AND NOT `forwardToAgentCore`.
//
// OpenClaw sends the decision through `gatewayPool.send(agentId, sessionKey, wakeMessage,
// {userId})`, which puts the wake string in as the ENTIRE, BARE prompt. archie's Slack path
// runs everything through `buildAgentPayload`, which prepends "<@U…> says:" and appends a
// reply instruction. Reusing it would wrap the one prompt whose whole point is a literal
// string the plugin's own block message told the model to expect ("Retry the identical send
// now"), so the model would be reading chat framing where it expects a control signal.
//
// `cron-fire.js` is the precedent for a turn with no Slack event behind it, and this follows
// it — with one difference: cron delivers through its own announce path and passes NOOP_CHUNK,
// whereas a decision always has a live thread to stream back into, so the streaming bridge
// stays wired.
//
// THE WAKE STRINGS ARE A CONTRACT. `approvals-hook` tells the model, at block time, exactly
// what to expect on approval. Change the wording here and an approved send stops being
// retried. They are built by the caller (index.js) so this module stays transport-only.

/** Recover {channel, threadTs} from a Slack thread session key, or null if it is not one. */
function parseSlackThreadKey(sessionKey) {
  // Shape: slack:thread:<channel>:<threadTs>[:dm:<peer>]
  const m = /^slack:thread:([^:]+):([^:]+)/.exec(String(sessionKey || ''));
  if (!m) return null;
  return { channel: m[1], threadTs: m[2] };
}

/**
 * @param deps.agentCore            the AgentCore client (invokeStreaming, makeStreamBridge,
 *                                  runExclusiveForSession)
 * @param deps.ensureRuntime        (agent, {logger}) => arn — MUST be the image-pointer-aware
 *                                  resolver (index.js ensureCurrentRuntime), never
 *                                  agentCore.ensureRuntime. cron-fire.js:196-201 records why:
 *                                  the raw client resolves the name from the dispatcher's BAKED
 *                                  image and silently pins the agent to the build image while
 *                                  the Slack path rolls.
 * @param deps.streaming            StreamingManager
 * @param deps.sessionIdFor         (sessionKey) => runtimeSessionId (agentcoreSessionId)
 * @param deps.log                  pino-shaped logger
 */
function createApprovalWake(deps) {
  const { agentCore, ensureRuntime, streaming, sessionIdFor } = deps;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  /**
   * @param record  the approval record (agentId + sessionKey are what matter here)
   * @param text    the bare wake prompt — passed through verbatim
   * @param userId  the APPROVER. Right on both counts: their credentials are the ones the
   *                retried send will run under, and it matches OpenClaw's third argument.
   */
  return async function wake(record, { text, userId }) {
    const agent = record.agentId;
    const sessionKey = record.sessionKey;
    const target = parseSlackThreadKey(sessionKey);

    // No thread to stream into. Inventing one is worse than doing nothing — a cron-shaped or
    // foreign key means the originating conversation is not a Slack thread, so there is
    // nowhere for the reply to land. Say so and stop; the approval is still recorded and the
    // agent will pick it up on its next turn via redeemApproval.
    if (!target) {
      log.warn({ agent, sessionKey }, 'approval wake skipped — session key is not a slack thread');
      return { ok: false, reason: 'unroutable_session_key' };
    }

    const { channel, threadTs } = target;
    const sessionId = sessionIdFor(sessionKey);
    const child = log.child ? log.child({ agent, sessionKey, trigger: 'approval' }) : log;

    // MANDATORY, not defensive: the approver may click Approve while the requester is
    // mid-turn in that same thread, and two concurrent invokes on one session is exactly the
    // hazard this lock exists for.
    return agentCore.runExclusiveForSession(sessionId, async () => {
      streaming.registerSession(sessionKey, { channel, threadTs, userId, isDM: /^D/i.test(channel) });
      const session = streaming.findSession(sessionKey)?.session || null;
      if (session) streaming.startStream(session);

      // Same encoding as the Slack path (index.js) and as OpenClaw's idempotency key, because
      // pi-adapter parses "u:<userId>:" back out of it to resolve per-user Connector identity.
      // Without it the retried send would execute under no entity and fail auth.
      const runId = `u:${userId}:${require('node:crypto').randomUUID()}`;

      let runtimeArn;
      try {
        runtimeArn = await ensureRuntime(agent, { logger: child });
      } catch (err) {
        child.error({ err: err.message }, 'approval wake — ensureRuntime failed');
        if (session) { streaming.stopStream(session, null); await streaming.drain(session); }
        return { ok: false, reason: 'ensure_runtime_failed' };
      }

      const notifyFailure = () => {
        child.warn({}, 'approval wake — turn reported an error');
      };
      const bridge = agentCore.makeStreamBridge({ streaming, session, runId, channel, threadTs, notifyFailure, logger: child });

      try {
        const body = { input: { prompt: text, runId, sender: userId, trigger: 'approval', sessionKey } };
        await agentCore.invokeStreaming(runtimeArn, sessionId, body, bridge, { logger: child, agent, trigger: 'approval' });
        if (session && !session.stream?.stopped) streaming.stopStream(session, null);
        child.info({}, 'approval wake complete');
        return { ok: true };
      } catch (err) {
        child.error({ err: err.message }, 'approval wake — invoke failed');
        if (session) streaming.stopStream(session, null);
        return { ok: false, reason: 'invoke_failed' };
      } finally {
        if (session) await streaming.drain(session);
      }
    }, { agent, logger: child });
  };
}

module.exports = { createApprovalWake, parseSlackThreadKey };

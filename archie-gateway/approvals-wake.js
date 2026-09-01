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

/**
 * Recover {channel, threadTs} from a session key, or null if it names no Slack thread.
 *
 * MIRRORS extractSlackThreadTarget (connector-session-plugin/src/config.ts), and must stay in
 * lockstep with it — the plugin uses that function to decide the reply-in-place exemption, this
 * one to decide where an approved send's turn streams back to. They read the same key.
 * Duplicated rather than imported because nothing in archie-gateway may import from the plugin
 * tree (separate build contexts), the same reason scopeIdFor/scopeIdForRouting exist twice.
 *
 * TWO THINGS AN EARLIER VERSION OF THIS GOT WRONG, both caught live on 2026-09-01 when an
 * APPROVED send was never retried:
 *
 * 1. IT IS NOT ANCHORED. The real key is
 *    `agent:agent-xx9aff:slack:thread:dl1ha3ii6v6:1788271402.303009:dm:ux0mz5ckp2r` —
 *    OpenClaw-style, with an `agent:<name>:` prefix the runtime inherits with its legacy EFS
 *    root. A `^slack:thread:` regex rejects it, so the wake was skipped and the approval became
 *    a dead end. Find the marker anywhere.
 *
 * 2. THE CHANNEL MUST BE UPPERCASED. Session keys lowercase conversation ids; Slack's API
 *    rejects the lowercase form with invalid_arguments. Streaming into `dl1ha3ii6v6` would have
 *    failed even once the key parsed.
 */
function parseSlackThreadKey(sessionKey) {
  if (!sessionKey) return null;
  const marker = 'slack:thread:';
  const idx = String(sessionKey).indexOf(marker);
  if (idx < 0) return null;
  const parts = String(sessionKey).slice(idx + marker.length).split(':');
  // dm-first shape: slack:thread:dm:<channel>:<sender>
  if (parts[0] === 'dm') {
    return parts[1] ? { channel: parts[1].toUpperCase() } : null;
  }
  // channel-thread shape: slack:thread:<channel>:<threadTs>[:dm:<sender>]
  const channel = parts[0];
  if (!channel) return null;
  const threadTs = parts[1] && /^\d+\.\d+$/.test(parts[1]) ? parts[1] : undefined;
  return threadTs
    ? { channel: channel.toUpperCase(), threadTs }
    : { channel: channel.toUpperCase() };
}

/**
 * Resolve the channel this wake should stream into.
 *
 * A DM CHANNEL ID IS PER-APP, and the session key cannot be trusted for one. Sessions migrated
 * from OpenClaw carry ITS DM channel (the runtime adopts the legacy EFS root, and pi-adapter
 * reuses the matched OpenClaw index key), so the id names a conversation between the human and
 * the *OpenClaw* app. archie is a different Slack app with a different bot user, so posting
 * there fails `channel_not_found` — observed live 2026-09-01 as 14 `stream append failed` per
 * wake, with the send itself still succeeding because a dead stream does not block the invoke.
 *
 * So: for a `D…` id, re-open the DM against THIS app's token and use whatever channel it
 * returns. For `C…`/`G…` the id is workspace-wide and means the same thing to both apps, so it
 * is used as-is (archie still needs to be in the channel, but that is a membership question
 * with a sensible failure, not an identity mismatch).
 *
 * Falls back to the key's channel if the lookup fails: no worse than before, and the invoke
 * still runs.
 */
async function resolveStreamChannel({ slack, channel, userId, log }) {
  if (!/^D/i.test(channel)) return channel;
  if (!slack || !userId) return channel;
  try {
    const r = await slack.conversations.open({ users: userId });
    const resolved = r && r.channel && r.channel.id;
    if (resolved && resolved !== channel) {
      log.info({ from: channel, to: resolved, userId }, 'approval wake — re-resolved DM channel for this app');
    }
    return resolved || channel;
  } catch (err) {
    log.warn({ err: err.message, channel, userId }, 'approval wake — DM re-open failed, using the key channel');
    return channel;
  }
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
  const { agentCore, ensureRuntime, streaming, sessionIdFor, slack } = deps;
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

    const { threadTs } = target;
    const sessionId = sessionIdFor(sessionKey);
    const child = log.child ? log.child({ agent, sessionKey, trigger: 'approval' }) : log;

    // Never trust a DM id inherited from the session key — see resolveStreamChannel.
    const channel = await resolveStreamChannel({ slack, channel: target.channel, userId, log: child });

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

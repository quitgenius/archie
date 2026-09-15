'use strict';

// Streaming state machine for the Slack dispatcher.
//
// Owns all Slack Streaming API interactions (startStream / appendStream /
// stopStream) and the per-session / per-run lifecycle. index.js calls into
// this module via the StreamingManager class — it never touches Slack
// streaming APIs or activeSessions directly.

const crypto = require('node:crypto');

// Leave room below Slack's message limit; final overflow is delivered in thread replies.
const RECOVERY_TEXT_LIMIT = 36000;
const slackError = (err) => err?.data?.error || err?.error;
const streamExpired = (err) => slackError(err) === 'message_not_in_streaming_state';

function splitText(text, limit) {
  const parts = [];
  while (text.length > limit) {
    let end = limit;
    if (/[\uD800-\uDBFF]/.test(text[end - 1])) end -= 1;
    parts.push(text.slice(0, end));
    text = text.slice(end);
  }
  if (text) parts.push(text);
  return parts;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const STATUS_ROTATE_MS = 3000; // rotate thinking status every 3s
const THINKING_STATUSES = [
  'Securing the mast',
  'Battening down the hatches',
  'Charting a course',
  'Trimming the sails',
  'Weighing anchor',
];

// ---------------------------------------------------------------------------
// StreamingManager
// ---------------------------------------------------------------------------

class StreamingManager {
  /**
   * @param {object} opts
   * @param {object} opts.slack - Slack WebClient (or simulate-aware proxy)
   * @param {object} opts.log - pino logger
   * @param {number} [opts.updateIntervalMs=1500] - min ms between stream appends
   */
  constructor({ slack, log, updateIntervalMs = 1500 }) {
    this._slack = slack;
    this._log = log;
    this._updateIntervalMs = updateIntervalMs;
    /** @type {Map<string, Session>} */
    this._sessions = new Map();
    this._teamId = null;

    this._cleanupInterval = setInterval(() => this._expireStaleSessions(), 60_000);
  }

  set teamId(id) { this._teamId = id; }

  // -------------------------------------------------------------------------
  // Session lifecycle
  // -------------------------------------------------------------------------

  /**
   * Register (or refresh) a streaming session before forwarding a message.
   * Returns a traceId that should be logged alongside all subsequent events.
   */
  registerSession(sessionKey, { channel, threadTs, userId, isDM = false }) {
    const traceId = crypto.randomUUID().slice(0, 8);
    const existing = this._sessions.get(sessionKey);
    if (existing) {
      existing.staleAt = Date.now() + SESSION_TTL_MS;
      existing.isDM = isDM;
      if (!existing.stream) existing.stream = this._makeStream();
      existing.traceId = traceId;
      this._log.info({ sessionKey, traceId, activeRuns: existing.runs.size }, 'stream session refreshed');
      return traceId;
    }
    this._sessions.set(sessionKey, {
      channel,
      threadTs,
      isDM,
      userId: userId || null,
      runs: new Map(),
      staleAt: Date.now() + SESSION_TTL_MS,
      stream: this._makeStream(),
      traceId,
    });
    this._log.info({ sessionKey, traceId }, 'stream session registered');
    return traceId;
  }

  hasSession(sessionKey) {
    return this._sessions.has(sessionKey);
  }

  /**
   * Find a session by gateway session key (handles prefix stripping + threadId matching).
   * Returns { matchedKey, session } or null.
   */
  findSession(gatewaySessionKey) {
    const matchedKey = this._findSessionKey(gatewaySessionKey);
    if (!matchedKey) return null;
    return { matchedKey, session: this._sessions.get(matchedKey) };
  }

  // -------------------------------------------------------------------------
  // Run lifecycle
  // -------------------------------------------------------------------------

  getOrCreateRun(session, runId) {
    let run = session.runs.get(runId);
    if (!run) {
      run = { lastText: '', flushTimer: null };
      session.runs.set(runId, run);
      this._log.info({ runId, traceId: session.traceId, activeRuns: session.runs.size }, 'new streaming run started');
    }
    return run;
  }

  finalizeRun(session, runId) {
    const run = session.runs.get(runId);
    if (run?.flushTimer) clearTimeout(run.flushTimer);
    session.runs.delete(runId);
  }

  clearAllRuns(session, reason) {
    for (const [, run] of session.runs) {
      if (run.flushTimer) clearTimeout(run.flushTimer);
    }
    session.runs.clear();
    this._log.info({ traceId: session.traceId, reason }, 'all streaming runs cleared');
  }

  // -------------------------------------------------------------------------
  // Stream control (Slack Streaming API wrappers)
  // -------------------------------------------------------------------------

  /**
   * Start a new Slack stream. In channels, posts a "Thinking…" plan header
   * immediately. In DMs, uses assistant.threads.setStatus (the documented
   * agent pattern) and defers the actual stream until content arrives.
   */
  startStream(session) {
    this._stopStatusRotation(session);
    this._clearRecoveryTimer(session.stream);
    // Queued writes retain their own stream object, including its Slack timestamp.
    const previousChain = session.stream?.chain;
    session.stream = this._makeStream();
    session.stream.chain = previousChain || null;

    if (session.isDM) {
      // loading_messages controls the rotating text in the DM message body;
      // status controls the typing indicator at the bottom.
      this._slack.assistant.threads.setStatus({
        channel_id: session.channel,
        thread_ts: session.threadTs,
        status: THINKING_STATUSES[0],
        loading_messages: THINKING_STATUSES,
      }).catch((err) => {
        this._log.warn({ err: err.message, traceId: session.traceId }, 'setStatus failed');
      });
    } else {
      let idx = 0;
      const setNext = () => {
        const status = THINKING_STATUSES[idx % THINKING_STATUSES.length];
        idx++;
        this._streamAppend(session, [{ type: 'plan_update', title: status }]);
      };
      setNext();
      session.stream._statusTimer = setInterval(setNext, STATUS_ROTATE_MS);
    }
  }

  /**
   * Append a text delta to the stream.
   * Compares against run.lastText to compute the incremental delta.
   */
  handleDelta(run, session, text) {
    if (!text || text === run.lastText) return;
    const delta = text.slice(run.lastText.length);
    run.lastText = text;
    if (!delta) return;

    // Stop rotating status once real content arrives.
    this._stopStatusRotation(session);

    if (run.flushTimer) { clearTimeout(run.flushTimer); run.flushTimer = null; }
    run.flushTimer = setTimeout(() => { run.flushTimer = null; }, this._updateIntervalMs);

    this._streamText(session, delta);
  }

  /**
   * Append a task_update chunk (tool progress).
   * Deduplicates by itemId — only sends when status changes.
   */
  handleTask(session, itemId, title, status, details) {
    if (!session.stream) return;
    const prevStatus = session.stream._taskStatuses?.[itemId];
    if (prevStatus === status) return;
    if (!session.stream._taskStatuses) session.stream._taskStatuses = {};
    session.stream._taskStatuses[itemId] = status;

    const chunk = { type: 'task_update', id: itemId, title, status };
    if (details) chunk.details = details;
    this._streamAppend(session, [chunk]);
  }

  /**
   * Stop the stream. Flushes remainingDelta if provided, appends "Done",
   * and calls stopStream. Falls back to chat.postMessage if no active stream.
   */
  stopStream(session, finalText, { remainingDelta } = {}) {
    const s = session.stream;
    if (s?.finalizing) return s.chain || Promise.resolve();
    if (s) s.finalizing = true;
    this._clearRecoveryTimer(s);
    this._stopStatusRotation(session);

    // Clear assistant thread status for DMs (fire-and-forget).
    if (session.isDM) {
      this._slack.assistant.threads.setStatus({
        channel_id: session.channel,
        thread_ts: session.threadTs,
        status: '',
      }).catch(() => {});
    }

    // No stream object and no in-flight chain — nothing to stop.
    if (!s?.ts && !s?.chain) {
      if (finalText) {
        this._log.info({ traceId: session.traceId, channel: session.channel, threadTs: session.threadTs }, 'no active stream; falling back to chat.postMessage');
        const delivery = this._postRecoveryFallback(session, finalText, s);
        if (s) { s.chain = delivery; s.stopped = true; }
        return delivery;
      }
      return Promise.resolve();
    }

    const traceId = session.traceId;
    const work = async () => {
      // Read ts inside the chain — a preceding startStream may have set it.
      const ts = s.ts;
      if (s.userStopped || s.disposed) return;
      if (!ts) {
        if (finalText) {
          this._log.info({ traceId }, 'stream never started; falling back to chat.postMessage');
          await this._postRecoveryFallback(session, finalText, s);
        }
        return;
      }
      try {
        if (s.recovering) {
          if (!await this._updateRecovery(session, s, finalText, true)) {
            await this._postRecoveryFallback(session, finalText, s);
          }
          return;
        }
        if (remainingDelta) {
          await this._slack.chat.appendStream({
            channel: session.channel,
            ts,
            chunks: [{ type: 'markdown_text', text: remainingDelta }],
          });
        }
        await this._slack.chat.appendStream({
          channel: session.channel,
          ts,
          chunks: [{ type: 'plan_update', title: 'Anchors aweigh' }],
        });
        await this._slack.chat.stopStream({ channel: session.channel, ts });
        this._log.info({ streamTs: ts, traceId, hadRemainingDelta: !!remainingDelta }, 'stream stopped');
      } catch (err) {
        this._log.warn({ err: err.message, streamTs: ts, traceId }, 'stream stop failed');
        if (slackError(err) === 'stopped_by_user') { s.userStopped = true; return; }
        if (streamExpired(err)) {
          s.recovering = true;
          if (await this._updateRecovery(session, s, finalText, true)) return;
        }
        if (finalText) {
          await this._postRecoveryFallback(session, finalText, s);
        }
      } finally {
        s.ts = null;
      }
    };

    s.chain = (s.chain || Promise.resolve()).catch(() => {}).then(work);
    s.stopped = true;
    return s.chain;
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  /** Snapshot of all active sessions for /debug endpoint. */
  debugSnapshot() {
    const result = {};
    for (const [key, session] of this._sessions) {
      result[key] = {
        traceId: session.traceId,
        channel: session.channel,
        threadTs: session.threadTs,
        activeRuns: session.runs.size,
        hasStream: !!session.stream?.ts,
        streamStopped: !!session.stream?.stopped,
        staleAt: new Date(session.staleAt).toISOString(),
        runIds: [...session.runs.keys()],
      };
    }
    return result;
  }

  /** Total number of active sessions. */
  get sessionCount() { return this._sessions.size; }

  destroy() {
    clearInterval(this._cleanupInterval);
    for (const [, session] of this._sessions) {
      this._stopStatusRotation(session);
      this._clearRecoveryTimer(session.stream);
      if (session.stream) session.stream.disposed = true;
      for (const [, run] of session.runs) {
        if (run.flushTimer) clearTimeout(run.flushTimer);
      }
    }
    this._sessions.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  _stopStatusRotation(session) {
    if (session.stream?._statusTimer) {
      clearInterval(session.stream._statusTimer);
      session.stream._statusTimer = null;
    }
  }

  _makeStream() {
    return { ts: null, taskCounter: 0, chain: null, stopped: false, _taskStatuses: {}, _statusTimer: null,
      text: '', tasks: new Map(), recovering: false, recoveryTimer: null, lastRecoveryUpdate: null };
  }

  /**
   * Await every queued Slack write for this session's stream.
   *
   * Slack writes are serialised onto `s.chain` and the schedulers (_streamAppend, stopStream) return
   * that chain rather than awaiting it — they are called from a synchronous SSE callback, so they
   * cannot block. That is fine WITHIN a turn and wrong at its boundary: a turn that returns with its
   * stop still queued releases the session slot, and the next turn's startStream resets `s.ts` to null
   * and posts a fresh placeholder. The previous turn's queued stop then reads the NEW `s.ts` and
   * writes its remaining text into the next turn's bubble before closing it.
   *
   * Live symptom (2026-08-10): every reply arrived in two pieces — a tail fragment ("…vault now.") in
   * one message and the body in another, alternating with empty bubbles.
   *
   * The loop re-checks because draining can itself queue more work (a stop appends, then stops).
   */
  async drain(session) {
    const s = session?.stream;
    if (!s) return;
    for (let i = 0; i < 20; i += 1) {
      const chain = s.chain;
      if (!chain) return;
      await chain.catch(() => {});
      if (s.chain === chain) return;   // nothing new was queued while we waited
    }
    this._log.warn({ traceId: session.traceId }, 'stream drain did not settle');
  }

  _streamAppend(session, chunks) {
    const s = session.stream;
    if (!s || s.stopped) return;
    const work = async () => {
      if (s.userStopped || s.disposed) return;
      for (const chunk of chunks) {
        if (chunk.type === 'markdown_text') s.text += chunk.text || '';
        if (chunk.type === 'plan_update') s.plan = chunk.title;
        if (chunk.type === 'task_update') {
          s.tasks.set(chunk.id, chunk);
          // Keep progress bounded even for turns with hundreds of tools.
          if (s.tasks.size > 10) s.tasks.delete(s.tasks.keys().next().value);
        }
      }
      if (s.recovering) { await this._scheduleRecovery(session, s); return; }
      try {
        if (!s.ts) {
          // Set the initial plan title so Slack doesn't default to "Thinking".
          const hasPlanUpdate = chunks.some((c) => c.type === 'plan_update');
          const initChunks = hasPlanUpdate ? chunks : [{ type: 'plan_update', title: THINKING_STATUSES[0] }, ...chunks];
          const startArgs = {
            channel: session.channel,
            thread_ts: session.threadTs,
            task_display_mode: 'plan',
            chunks: initChunks,
          };
          if (this._teamId) startArgs.recipient_team_id = this._teamId;
          if (session.userId) startArgs.recipient_user_id = session.userId;
          const result = await this._slack.chat.startStream(startArgs);
          if (result.ok) {
            s.ts = result.ts;
            this._log.info({ streamTs: s.ts, traceId: session.traceId }, 'stream started');
          }
        } else {
          await this._slack.chat.appendStream({ channel: session.channel, ts: s.ts, chunks });
        }
      } catch (err) {
        this._log.warn({ err: err.message, streamTs: s.ts, traceId: session.traceId }, 'stream append failed');
        if (slackError(err) === 'stopped_by_user') { s.userStopped = true; return; }
        if (streamExpired(err) && s.ts) {
          s.recovering = true;
          this._log.info({ streamTs: s.ts, traceId: session.traceId }, 'expired stream switching to message updates');
          await this._scheduleRecovery(session, s);
        }
      }
    };
    s.chain = (s.chain || Promise.resolve()).catch(() => {}).then(work);
    return s.chain;
  }

  _clearRecoveryTimer(s) {
    if (s?.recoveryTimer) clearTimeout(s.recoveryTimer);
    if (s) s.recoveryTimer = null;
  }

  async _scheduleRecovery(session, s) {
    // Finalization is already queued behind these chunks and will flush the full answer.
    if (s.finalizing || s.updateRejected || s.disposed) return;
    const wait = s.lastRecoveryUpdate === null ? 0
      : Math.max(0, Math.max(1500, this._updateIntervalMs) - (Date.now() - s.lastRecoveryUpdate));
    if (!wait) {
      this._clearRecoveryTimer(s);
      await this._updateRecovery(session, s);
    } else if (!s.recoveryTimer) {
      s.recoveryTimer = setTimeout(() => {
        s.recoveryTimer = null;
        if (s.finalizing || s.userStopped || s.disposed) return;
        s.chain = (s.chain || Promise.resolve()).catch((err) => {
          this._log.warn({ err: err.message, traceId: session.traceId }, 'previous stream write failed before recovery');
        }).then(() => {
          if (!s.finalizing && !s.userStopped && !s.disposed) return this._updateRecovery(session, s);
        });
      }, wait);
    }
  }

  async _updateRecovery(session, s, finalText, final = false) {
    if (s.userStopped || s.updateRejected || s.disposed) return false;
    const text = final && finalText ? finalText : s.text;
    const parts = splitText(text, RECOVERY_TEXT_LIMIT);
    const first = parts[0] || '';
    // Use ordinary message text so long code fences and tables are not cut into
    // independent 3,000-character section blocks. Clear the frozen native blocks.
    const progress = [...s.tasks.values()].map((task) =>
      `${task.status}: ${task.title}${task.details ? ` — ${task.details}` : ''}`).join('\n');
    const escapedProgress = progress.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const status = splitText(escapedProgress || (final ? 'Complete' : 'Working…'), 3000)[0];
    const rendered = final ? first || status : [first, progress || !first ? status : ''].filter(Boolean).join('\n\n');
    s.lastRecoveryUpdate = Date.now();
    try {
      await this._slack.chat.update({ channel: session.channel, ts: s.ts, text: rendered, blocks: [] });
    } catch (err) {
      this._log.warn({ err: err.message, streamTs: s.ts, traceId: session.traceId }, 'stream recovery update failed');
      if (['cant_update_message', 'edit_window_closed', 'message_not_found'].includes(slackError(err))) {
        s.updateRejected = true;
      }
      if (slackError(err) === 'stopped_by_user') s.userStopped = true;
      return false;
    }
    this._log.info({ streamTs: s.ts, traceId: session.traceId, final, chars: first.length }, 'stream recovery update succeeded');
    if (final) {
      // The first part is acknowledged on the original message. Only post its overflow.
      await this._postRecoveryFallback(session, parts.slice(1).join(''), s);
    }
    return true;
  }

  async _postRecoveryFallback(session, text, s) {
    if (!text || s?.userStopped || s?.disposed) return;
    for (const part of splitText(text, RECOVERY_TEXT_LIMIT)) {
      try {
        await this._slack.chat.postMessage({ channel: session.channel, thread_ts: session.threadTs, text: part });
        this._log.info({ traceId: session.traceId, chars: part.length }, 'stream recovery fallback delivered');
      } catch (err) {
        this._log.error({ err: err.message, traceId: session.traceId }, 'stream recovery fallback failed');
        break;
      }
    }
  }

  _streamText(session, text) {
    return this._streamAppend(session, [{ type: 'markdown_text', text }]);
  }

  _findSessionKey(gatewaySessionKey) {
    if (this._sessions.has(gatewaySessionKey)) return gatewaySessionKey;

    const stripped = gatewaySessionKey.replace(/^agent:[^:]+:/, '');
    if (stripped !== gatewaySessionKey) {
      const lowerStripped = stripped.toLowerCase();
      for (const key of this._sessions.keys()) {
        if (key.toLowerCase() === lowerStripped) return key;
      }
    }

    const gwThread = this._extractThreadId(gatewaySessionKey);
    if (!gwThread) return null;
    for (const key of this._sessions.keys()) {
      if (this._extractThreadId(key) === gwThread) return key;
    }
    return null;
  }

  _extractThreadId(sessionKey) {
    const match = sessionKey.toLowerCase().match(/slack:thread:(?:dm:)?([^:]+):([0-9]+\.[0-9]+)/);
    return match ? `${match[1]}:${match[2]}` : null;
  }

  _expireStaleSessions() {
    const now = Date.now();
    for (const [key, session] of this._sessions) {
      if (session.staleAt < now) {
        this._stopStatusRotation(session);
        this._clearRecoveryTimer(session.stream);
        if (session.stream) session.stream.disposed = true;
        for (const [, run] of session.runs) {
          if (run.flushTimer) clearTimeout(run.flushTimer);
        }
        this._log.warn({ sessionKey: key, traceId: session.traceId, activeRuns: session.runs.size }, 'streaming session expired; cleaning up');
        this._sessions.delete(key);
      }
    }
  }
}

module.exports = { StreamingManager };

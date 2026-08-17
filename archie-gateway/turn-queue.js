'use strict';

// Durable turn queue — producer side (sqs-durable-queue-plan.md).
//
// WHY. Bolt acknowledges a Slack event BEFORE our listener runs, so Slack's redelivery covers a
// window of milliseconds and everything after it is ours to lose. A turn is p50 35s / p90 105s live,
// and messages queue behind it; a dispatcher restart drops all of that silently and Slack never
// resends. Enqueuing on receipt makes the queue the system of record from the moment the event lands.
//
// ISOLATION COMES FROM MessageGroupId, NOT FROM A QUEUE PER CHANNEL. One FIFO queue serves every
// thread: SQS delivers a group's messages in order and returns nothing more from that group while one
// is in flight. Message groups are not provisioned resources, so N threads cost nothing.
//
// SPIKE-VERIFIED, and the consumer must honour it: `MaxNumberOfMessages` MUST be 1. The guarantee is
// NOT "one message in flight per group" — a receive asking for 10 hands you ten messages from ONE
// group (measured: it returned all 5) and destroys per-thread isolation. Cross-thread throughput
// comes from concurrent pollers, never from batching.

const {
  propagation, context: otelContext, trace: otelTrace, SpanKind, SpanStatusCode,
} = require('@opentelemetry/api');
const { createSemaphore } = require('./semaphore');

const tracer = otelTrace.getTracer('slack-dispatcher');

const MAX_BODY_BYTES = 250 * 1024;   // SQS caps a message at 256 KB; leave headroom for attributes.

/**
 * SQS ids allow alphanumerics and punctuation, up to 128 chars. Slack ids are already well within
 * that, but a channel/ts fallback and any future id source should not be able to produce an invalid
 * value — a rejected SendMessage here means a dropped user message.
 */
function sanitizeId(raw, fallback) {
  const s = String(raw ?? '').replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 128);
  // An all-punctuation result ("!!!" -> "---") passes SQS validation but is not an identity: any two
  // junk inputs of the same length collapse to the same string. As a MessageGroupId that would merge
  // two threads' ordering; as a MessageDeduplicationId it would silently swallow a real message as a
  // duplicate. Require at least one alphanumeric before trusting it.
  return /[A-Za-z0-9]/.test(s) ? s : fallback;
}

/**
 * A STABLE identity for a Slack message, used as MessageDeduplicationId.
 *
 * `client_msg_id` is Slack's own per-message id and is what the in-process duplicate guard already
 * keys on. It is not present on every event shape, so `channel:ts` is the fallback — a Slack ts is
 * unique within a channel, so the pair identifies the message even when client_msg_id is absent.
 *
 * NOTE this is deliberately NOT content-based: two identical messages a user genuinely sends twice
 * are two turns and must both run. The thing that repeats is the EVENT, not the text.
 */
function turnDedupId(event) {
  return sanitizeId(event?.client_msg_id || `${event?.channel || 'nochan'}-${event?.ts || 'nots'}`, 'unknown');
}

/**
 * @param deps.queueUrl  SQS FIFO queue url. ABSENT = disabled; callers keep their inline path.
 *                       Presence is the switch on purpose — a flag that turns durability off is a
 *                       way to lose messages by accident.
 * @param deps.client    lazily-constructed SQSClient (injectable for tests).
 * @param deps.logger    pino-shaped.
 * @param deps.metrics   dispatcher metrics emitter.
 */
function createTurnQueue({ queueUrl, client, logger, metrics, region } = {}) {
  const enabled = !!queueUrl;
  let _client = client || null;

  // Per-group ENQUEUE ordering. SQS FIFO preserves the order sends REACH it, and SendMessage is
  // async — so two Bolt handlers running concurrently (Slack delivers events back-to-back and Bolt
  // does not await one handler before dispatching the next) can race, and the later message can land
  // first. The old in-process queue never had this problem because it built its chain SYNCHRONOUSLY
  // at call time, so arrival order was execution order.
  //
  // Caught live: a 25-message burst came back with every message present and none duplicated, but in
  // the order 6, 5, 1, 3, 14, 2 … Durability was right; ordering was not.
  //
  // This chain is built synchronously here, exactly like the old one, so sends for a group are ISSUED
  // in arrival order. It costs nothing — a send is ~20ms and the chain is per thread.
  const _sendChains = new Map();

  function sqs() {
    if (_client) return _client;
    const { SQSClient } = require('@aws-sdk/client-sqs');
    _client = new SQSClient({ region: region || process.env.AWS_REGION || 'us-east-1' });
    return _client;
  }

  /**
   * Put a turn on the queue. Resolves `{ queued: true, messageId }` or THROWS — callers must treat a
   * failure as user-visible, because Slack has already been acked and nothing else will retry.
   *
   * The body carries the RAW Slack event, not a built payload: `priorContext` and the user profile are
   * resolved by the consumer, so the message stays small and the context is fresh at execution time
   * rather than stale from whenever it was enqueued.
   */
  async function enqueueTurn({ event, agent, sessionId }) {
    if (!enabled) throw new Error('turn queue is not configured (TURN_QUEUE_URL unset)');
    if (!sessionId) throw new Error('enqueueTurn requires a sessionId — it is the MessageGroupId');

    const body = JSON.stringify({ v: 1, agent, event });
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      // Practically unreachable (a Slack event is a few KB), but a silent SendMessage rejection here
      // would be an invisibly dropped message, so it fails with something readable instead.
      throw new Error(`turn payload too large for SQS (${Buffer.byteLength(body, 'utf8')} bytes)`);
    }

    const groupId = sanitizeId(sessionId, 'unknown-session');
    // The PRODUCER span, and the parent the consumer continues from. It has to be an explicit span
    // of our own: the SDK's auto-span for SendMessage is created inside `sqs().send()`, so there is
    // no way to inject its context into the very message it is sending, and the enclosing Slack
    // listener has no span at all (measured: every `…fifo send` span in the window was its own
    // single-span root). Ending it here rather than at receive is deliberate — the span covers the
    // ENQUEUE, and the queue wait that follows is the child span's own start offset.
    const span = tracer.startSpan('dispatcher.enqueue', {
      kind: SpanKind.PRODUCER,
      attributes: { 'dispatcher.agent': agent, 'dispatcher.session_id': String(sessionId) },
    });
    // W3C trace context, carried as a MESSAGE ATTRIBUTE so the consumer can continue this trace.
    // Not in the body: the body is the producer/consumer contract and versioned (`v: 1`), while
    // trace context is transport metadata that a consumer must be free to ignore.
    //
    // This value is a FALLBACK. The aws-sdk instrumentation injects its own `traceparent` into
    // MessageAttributes at SendMessage and OVERWRITES whatever is here — measured, not assumed
    // (a probe against a real FIFO queue received a different traceparent than it sent). What
    // matters is therefore not which value wins but that both name the same trace, which is what
    // running the send inside this span's context below guarantees. Setting it anyway keeps the
    // join working if the instrumentation is ever disabled.
    const carrier = {};
    try { propagation.inject(otelTrace.setSpan(otelContext.active(), span), carrier); } catch { /* untraced env */ }

    const send = async () => {
      const { SendMessageCommand } = require('@aws-sdk/client-sqs');
      return sqs().send(new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        // Per-THREAD ordering and exclusivity. This is the whole isolation mechanism.
        MessageGroupId: groupId,
        // Slack redelivering the same event inside the dedup window collapses to one turn.
        MessageDeduplicationId: turnDedupId(event),
        ...(carrier.traceparent ? {
          MessageAttributes: {
            traceparent: { DataType: 'String', StringValue: carrier.traceparent },
            ...(carrier.tracestate ? { tracestate: { DataType: 'String', StringValue: carrier.tracestate } } : {}),
          },
        } : {}),
      }));
    };

    // The send runs INSIDE the enqueue span's context. Without this the SDK's SendMessage auto-span
    // has no active parent and starts a trace of its own — which is exactly what the live data
    // showed: 149 of 149 `…turns.fifo send` spans in the 2026-08-13 window were single-span root
    // traces, orphaned from both the enqueue and the turn. Since that auto-span's context is what
    // ends up on the message, an orphaned send also means the consumer joins the WRONG trace.
    const sendInSpanContext = () => otelContext.with(otelTrace.setSpan(otelContext.active(), span), send);

    // Chain SYNCHRONOUSLY on this group's previous send, so concurrent handlers cannot reorder.
    // Gate on the predecessor SETTLING: one failed send must not strand the whole thread.
    const prev = _sendChains.get(groupId) || Promise.resolve();
    const result = prev.then(sendInSpanContext, sendInSpanContext);
    const tail = result.then(() => {}, () => {});
    _sendChains.set(groupId, tail);
    tail.then(() => { if (_sendChains.get(groupId) === tail) _sendChains.delete(groupId); });

    let res;
    try {
      res = await result;
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
      span.end();
      throw err;
    }
    span.setAttribute('dispatcher.message_id', String(res.MessageId));
    span.end();
    metrics?.emitTurnEnqueued?.(agent, { sessionId });
    logger?.info?.({ agent, sessionId, messageId: res.MessageId }, 'turn queued');
    return { queued: true, messageId: res.MessageId };
  }

  // ── Consumer ────────────────────────────────────────────────────────────────

  /** Delete: the commit point. Once this returns, the turn will never be retried. */
  async function deleteMessage(receiptHandle) {
    const { DeleteMessageCommand } = require('@aws-sdk/client-sqs');
    await sqs().send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
  }

  /**
   * Return a message for retry NOW instead of stranding its thread for the full visibility timeout.
   *
   * Visibility is 10 minutes because it has to cover a cold boot; without this, a turn that failed in
   * one second would still block its thread for ten. A small escalating delay stops a permanently
   * broken message from hot-looping to the DLQ in milliseconds and burning API calls.
   */
  async function releaseMessage(receiptHandle, receiveCount = 1) {
    const { ChangeMessageVisibilityCommand } = require('@aws-sdk/client-sqs');
    const timeout = Math.min(30, Math.max(0, (Number(receiveCount) - 1) * 10));
    await sqs().send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: timeout,
    }));
    return timeout;
  }

  /**
   * Receive and run ONE turn. Returns true if a message was handled (so the poller loops eagerly),
   * false on an empty long-poll.
   *
   * `handler({ agent, event, meta }, { markStarted })` runs the turn. It MUST call `markStarted()`
   * once the runtime is demonstrably executing — that deletes the message.
   */
  /** Extend a message's visibility — used by the pre-start heartbeat. */
  async function extendVisibility(receiptHandle, seconds) {
    const { ChangeMessageVisibilityCommand } = require('@aws-sdk/client-sqs');
    await sqs().send(new ChangeMessageVisibilityCommand({
      QueueUrl: queueUrl, ReceiptHandle: receiptHandle, VisibilityTimeout: seconds,
    }));
  }

  // ── Occupancy ───────────────────────────────────────────────────────────────────────────────
  // `busy` counts messages BEING PROCESSED (never the 20s long-poll), and `total` is the ceiling on
  // that number. Both meanings are unchanged by the hand-off below — but the ceiling is no longer the
  // poller count: it is MAX_INFLIGHT_TURNS. Keeping the names and the semantics is deliberate so the
  // existing TurnPollersBusy alarm ("N concurrent turns") keeps meaning what it meant.
  //
  // Historically these were the same number, and that was the bug: a poller held its slot across a
  // 30-45s provision, so one number capped in-flight messages AND concurrent provisions AND concurrent
  // invokes. See provisioning-queue-plan.md.
  let _busy = 0;
  let _total = 0;
  let _pollers = 0;
  let _inflightSem = null;
  // Turns handed off by a poller. Tracked so stop() can DRAIN rather than abandon them — without this
  // the hand-off would make shutdown (and every test) nondeterministic, since the settle promises are
  // no longer inside the poller loops that stop() awaits.
  const _running = new Set();
  function pollerStats() {
    return {
      busy: _busy,
      total: _total,
      pollers: _pollers,
      // Pollers blocked waiting for an in-flight slot. Non-zero means the ceiling, not the queue, is
      // what is limiting throughput — the distinction the old single number could not express.
      waiting: _inflightSem ? _inflightSem.waiting : 0,
    };
  }

  /**
   * Receive and run ONE turn.
   *
   * `handoff` splits the two things a poller used to do at once. When absent (the inline/test path)
   * this AWAITS the turn, exactly as before. When supplied, the turn is started and its settle promise
   * is handed back so the caller can loop straight into the next receive — see startConsumer.
   *
   * SPIKE-VERIFIED (2026-08-13, real SQS, 6 groups × 5 messages, 8 pollers): hand-off does NOT break
   * per-group ordering, because per-group exclusivity is a QUEUE-side property keyed on the message
   * being in flight, not a consumer-side property keyed on the poller blocking. Zero ordering
   * violations, nothing lost, and 16 messages in flight from 8 pollers — the decoupling is real.
   */
  async function receiveOnce({ handler, waitTimeSeconds = 20, heartbeatMs = 20000, leaseSeconds = 60, handoff = null }) {
    const { ReceiveMessageCommand } = require('@aws-sdk/client-sqs');
    const res = await sqs().send(new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      // LOAD-BEARING, spike-verified. The per-group guarantee is NOT "one message in flight" — it is
      // that a SUBSEQUENT receive returns nothing more from a group while any are in flight. Asking
      // for 10 returns ten messages from ONE group (measured) and destroys per-thread isolation.
      // Parallelism across threads comes from concurrent pollers, never from raising this.
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: waitTimeSeconds,
      MessageAttributeNames: ['All'],
      // SentTimestamp is what makes the QUEUE WAIT measurable. Without it the turn clock can only
      // start at receive, so everything a message spent queued behind its own thread — the one
      // component of latency the user feels most directly and we control least — is not merely
      // unattributed but absent from the measurement entirely. TTFM was understated by exactly this.
      AttributeNames: ['MessageGroupId', 'ApproximateReceiveCount', 'SentTimestamp'],
    }));

    const m = res.Messages?.[0];
    if (!m) return false;

    // Occupancy counts only the PROCESSING window, never the 20s long-poll — otherwise every idle
    // poller reads as busy and the gauge is a constant equal to the pool size. The decrement is in a
    // `finally` so EVERY exit path releases the slot, including the unparseable-message early return
    // below: a leak here would inflate the gauge permanently and wedge the alarm in ALARM.
    _busy += 1;
    const settled = (async () => {
      try {
        return await handleMessage(m, { handler, heartbeatMs, leaseSeconds });
      } finally {
        _busy -= 1;
      }
    })();

    if (!handoff) return settled;

    // The poller's part is done. handleMessage owns every failure path already (it releases or logs),
    // so the only thing that could escape here is a bug in it — attach a catch so an unhandled
    // rejection can never take the process down and silently stop the whole consumer.
    settled.catch(() => {});
    handoff(settled);
    return true;
  }

  async function handleMessage(m, { handler, heartbeatMs = 20000, leaseSeconds = 60 }) {
    const receiveCount = Number(m.Attributes?.ApproximateReceiveCount || 1);
    const groupId = m.Attributes?.MessageGroupId;
    let committed = false;

    // PRE-START HEARTBEAT. The window from receive to first-SSE-event includes a 30-50s cold boot,
    // and SQS holds the whole MessageGroupId for the visibility timeout — so a task killed during
    // that window strands its ENTIRE THREAD until the lease lapses.
    //
    // Live-caught: with a fixed 600s visibility, killing the task mid-burst blocked the thread for
    // exactly 600 seconds (resumed at 03:26:27 after a 03:16:26 kill) while a healthy replacement
    // task sat idle. A short lease that a LIVE turn keeps renewing gets both properties: a cold boot
    // never expires early, and a DEAD task stops renewing so the thread recovers in ~one lease.
    //
    // It stops at the commit point — past that the message is deleted and there is nothing to renew.
    let beats = 0;
    let beat = setInterval(() => {
      beats += 1;
      // A SWALLOWED failure here is invisible and expensive: the lease lapses, SQS redelivers, and
      // the turn runs a SECOND time while the first is still going — which is exactly the duplicate
      // this design works to avoid. Live-caught: a redelivery with no kill involved. Log it.
      extendVisibility(m.ReceiptHandle, leaseSeconds).catch((err) => {
        logger?.warn?.({ err: err.message, sessionId: groupId, beats, leaseSeconds },
          'turn lease renewal FAILED — the turn may be redelivered and run twice');
      });
    }, heartbeatMs);
    const stopBeat = () => { if (beat) { clearInterval(beat); beat = null; } };
    if (beat.unref) beat.unref();

    const markStarted = async () => {
      if (committed) return;
      committed = true;
      stopBeat();
      await deleteMessage(m.ReceiptHandle);
      metrics?.emitTurnStarted?.(undefined, { sessionId: groupId, receiveCount });
    };

    let parsed;
    try {
      parsed = JSON.parse(m.Body);
    } catch (err) {
      // Unparseable: it will never succeed. Release so the redrive policy walks it to the DLQ rather
      // than deleting evidence of a bug we would then never see.
      stopBeat();
      logger?.error?.({ err: err.message, messageId: m.MessageId, receiveCount }, 'turn message unparseable — releasing toward the DLQ');
      await releaseMessage(m.ReceiptHandle, receiveCount).catch(() => {});
      return true;
    }

    try {
      await handler({
        agent: parsed.agent,
        event: parsed.event,
        meta: {
          groupId,
          receiveCount,
          messageId: m.MessageId,
          // Epoch ms the producer's SendMessage was accepted, and the W3C context of the span that
          // sent it. Together they let the consumer both MEASURE the queue wait and JOIN across it:
          // the send and the turn were previously two unrelated single-span traces, so a trace
          // could never show the gap it was sitting in.
          sentTimestampMs: Number(m.Attributes?.SentTimestamp) || null,
          traceparent: m.MessageAttributes?.traceparent?.StringValue || null,
          tracestate: m.MessageAttributes?.tracestate?.StringValue || null,
        },
      },
        { markStarted });
      // Safety net: the turn finished but never produced an SSE event (an empty or immediately-closed
      // stream). It RAN, so retrying would run it a second time — commit rather than redeliver.
      await markStarted();
    } catch (err) {
      stopBeat();
      if (committed) {
        // Failed AFTER the runtime started. Not retryable by design: the runtime keeps executing when
        // its consumer dies (spike-verified), so a retry would run a SECOND turn with a second set of
        // side effects rather than recovering the first.
        logger?.error?.({ err: err.message, sessionId: groupId }, 'turn failed after it started — not retried (a retry would duplicate side effects)');
      } else {
        const backoff = await releaseMessage(m.ReceiptHandle, receiveCount).catch(() => null);
        logger?.warn?.({ err: err.message, sessionId: groupId, receiveCount, backoff },
          'turn failed BEFORE the runtime started — released for retry');
        metrics?.emitTurnReleased?.(parsed.agent, { sessionId: groupId, receiveCount });
      }
    } finally {
      stopBeat();
    }
    return true;
  }

  /**
   * Run `pollers` concurrent receive loops, feeding up to `maxInflight` turns.
   *
   * These are now TWO different numbers, and that is the point. A poller is one 20s long-poll socket
   * and nothing more — it receives a message, hands it to a turn, and goes straight back to receiving.
   * `maxInflight` is the real ceiling on concurrent turns. Previously they were the same number, so
   * raising throughput meant raising the socket count too, which is how the pool ended up at 1000
   * pollers against a 50-socket SDK default (see var.turn_queue_pollers).
   *
   * The permit is acquired BEFORE receiving, never after: receiving a message we have no capacity to
   * process would start its visibility clock and hold its whole message group hostage while it sat in
   * a local queue.
   */
  function startConsumer({
    handler, pollers = 5, maxInflight = 0, waitTimeSeconds = 20, idleDelayMs = 100, sampleMs = 60000,
    // Called on every occupancy sample. The turn queue does not know about the provision/invoke bounds
    // (they live in agentcore-client), but they must be sampled on the SAME timeline to be comparable —
    // "invokes at their cap while turns were queueing" is only a readable statement if both numbers
    // come from the same instant. Hence a hook rather than a second timer in index.js.
    onSample = null,
  } = {}) {
    if (!enabled) return { stop: async () => {}, running: 0 };
    let stopping = false;
    const loops = [];
    // Default: preserve the old one-message-per-poller behaviour exactly, so a caller that has not
    // been taught about maxInflight is not silently given a different concurrency model.
    const inflightLimit = Number.isFinite(maxInflight) && maxInflight > 0 ? Math.floor(maxInflight) : pollers;
    const inflight = createSemaphore(inflightLimit, { name: 'turn-inflight' });
    _total = inflightLimit;
    _pollers = pollers;
    _inflightSem = inflight;

    // Sample occupancy on a timer rather than on every turn: it is a GAUGE, and emitting it per turn
    // would both cost an EMF line per turn and bias the statistic toward busy moments (an idle pool
    // emits nothing, so "average busy" would read high). unref so it never holds the process open.
    const sample = () => {
      try { metrics?.emitPollerSaturation?.(pollerStats()); } catch { /* telemetry must not kill the consumer */ }
      try { onSample?.(); } catch { /* ditto — a hook is not allowed to stop the consumer */ }
    };
    const sampler = setInterval(sample, sampleMs);
    if (sampler.unref) sampler.unref();
    // Emit once immediately so a task that starts and never saturates still publishes PollersTotal —
    // without it the alarm's companion series is missing until the first interval elapses.
    sample();

    for (let i = 0; i < pollers; i += 1) {
      loops.push((async () => {
        while (!stopping) {
          let got = false;
          let handedOff = false;
          let failed = false;
          // Blocks here when every in-flight slot is taken, which is the correct place to apply
          // backpressure: no long-poll is issued, so no message leaves the queue.
          await inflight.acquire();
          try {
            got = await receiveOnce({
              handler,
              waitTimeSeconds,
              handoff: (settled) => {
                handedOff = true;
                _running.add(settled);
                // The permit belongs to the TURN now, not the poller. Released when the turn settles,
                // whatever its outcome — `settled` already swallows rejections.
                const done = () => { _running.delete(settled); inflight.release(); };
                settled.then(done, done);
              },
            });
          } catch (err) {
            // A receive failure must not kill the poller — that would silently reduce capacity until
            // the last one died and the queue stopped draining with no error anywhere.
            failed = true;
            logger?.warn?.({ err: err.message, poller: i }, 'turn queue receive failed — retrying');
          } finally {
            // Only the poller's OWN permit. If the message was handed off, the turn holds it.
            if (!handedOff) inflight.release();
          }
          if (stopping) break;
          // Yield on an empty poll. With long-polling SQS already blocks for ~20s so this is
          // irrelevant — but if the receive returns IMMEDIATELY (waitTimeSeconds 0, a stubbed
          // client, or SQS answering fast) the loop never reaches the macrotask queue and spins the
          // CPU at 100%, starving timers in the same process. Caught by a test that hung forever.
          if (failed) await new Promise((r) => setTimeout(r, 2000));
          else if (!got) await new Promise((r) => setTimeout(r, idleDelayMs));
        }
      })());
    }
    logger?.info?.({ pollers, maxInflight: inflightLimit, queueUrl }, 'turn queue consumer started');

    return {
      pollers,
      maxInflight: inflightLimit,
      // Stops accepting NEW work, then waits for turns already handed off. In-flight turns are already
      // deleted from the queue, so a turn that outlives the wait simply dies with the process —
      // at-most-once, as scoped. Draining is best-effort tidiness, not a delivery guarantee.
      stop: async () => {
        stopping = true;
        clearInterval(sampler);
        await Promise.allSettled(loops);
        await Promise.allSettled([..._running]);
      },
    };
  }

  // pollerStats is exported so index.js can stamp occupancy onto the dispatcher.request span: a slow
  // turn plus a saturated pool in the SAME trace is the join that attributes TTFM's `dispatch` phase
  // to pool starvation rather than to the dispatcher's own work.
  return {
    enabled, enqueueTurn, turnDedupId, receiveOnce, startConsumer, deleteMessage, releaseMessage,
    pollerStats, _sqs: sqs,
  };
}

module.exports = { createTurnQueue, turnDedupId, sanitizeId };

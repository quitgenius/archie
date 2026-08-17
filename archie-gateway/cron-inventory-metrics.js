'use strict';

// Cron inventory gauge — the config-inventory counterpart to the per-fire CronFailureAlert
// (cron-metrics.js). Answers the observability gap "which crons are set up per channel /
// per agent" as a queryable CloudWatch gauge over time. The runner already traces every
// FIRE (cron-fire.js dispatcher.request span), but nothing surfaced the CONFIGURED set —
// that lived only in the EFS cron-store. This periodically snapshots store.list() into EMF.
//
// EMF (CloudWatch Embedded Metric Format): structured JSON to stdout, auto-extracted by
// CloudWatch Logs — NO PutMetricData, no IAM, no SDK (same mechanism as cron-metrics.js).
//
// Cardinality discipline (matches cron-metrics.js): dimensions are Agent and Channel only —
// both bounded aggregations. JobId is NEVER a dimension (per-job would be unbounded). The
// Agent lines also feed the fleet-wide `[]` aggregate (SUM = total configured jobs); the
// Channel lines do NOT (they'd double-count against the agent lines in that aggregate).

// Per-stack, same reasoning as cron-metrics.js and dispatcher-metrics.js: two gateways share this
// image and both emit fleet-wide dimensionless aggregates, so one namespace would sum two fleets into a
// single series. Default is the historical value so the OpenClaw stack does not move.
//
// This was the THIRD emitter, and the one that made the "namespace is now configurable" claim false:
// cron-metrics.js and dispatcher-metrics.js were converted while this file kept its own literal, so
// archie's `agent-gn0p84Cron` namespace stayed EMPTY while every cron inventory gauge kept landing in
// `ClawdbotCron` — and the cron alarms in modules/archie/alarms.tf therefore still matched nothing.
// Caught only by checking that the target namespace actually had metrics in it.
const NAMESPACE = process.env.CRON_METRIC_NAMESPACE || 'ClawdbotCron';
const METRIC_TOTAL = 'CronJobsConfigured';
const METRIC_ENABLED = 'CronJobsEnabled';
// M4.3: at-rest config validity. CronDeliveryFailure only fires when a job TRIES to deliver and
// fails; a job with no delivery block never tries, so it is invisible to that metric by
// construction (it fires, produces text, posts nothing, forever). This gauge is the counterpart
// that answers "which jobs are misconfigured" WITHOUT waiting for a fire.
const METRIC_MISCONFIGURED = 'CronJobsMisconfigured';
// M4.5: one line per job, value 1, with schedule/next-run/status as PROPERTIES — so a single Logs
// Insights query answers "what is configured, where, when does it next run, and is it valid"
// across every channel and DM. JobId is never a dimension (unbounded).
const METRIC_JOB = 'CronJobRecord';

// Mirrors the channel parse in streaming.js:385 — sessionKey is `slack:thread:[dm:]<ch>:<ts>`.
const SLACK_KEY = /slack:thread:(?:dm:)?([^:]+):/i;

/**
 * The channel a cron job belongs to, for inventory grouping. Precedence:
 *   1. delivery.channel — the explicit announce target (survives hydration; always a real
 *      channel id when present).
 *   2. the channel parsed from sessionKey (the conversation it was created in; note the
 *      hydrator drops sessionKey, so prod jobs often lack it — hence delivery.channel first).
 *   3. 'none' — system/webhook jobs with no channel.
 */
function channelOf(job) {
  const d = job && job.delivery;
  if (d && typeof d.channel === 'string' && d.channel) return d.channel;
  const sk = job && job.sessionKey;
  if (typeof sk === 'string') {
    const m = sk.toLowerCase().match(SLACK_KEY);
    if (m) return m[1];
  }
  return 'none';
}

// §12c — a POSTABLE Slack channel id. Case matters: verified live 2026-08-09 that
// `conversations.info` resolves `DL1HA3II6V6` and rejects `dl1ha3ii6v6` with channel_not_found.
// That is not pedantry — OpenClaw normalises session keys (and some stored delivery.channel
// values) to lowercase, so 8 enabled prod jobs carry a lowercased id that WILL fail to post.
// {8,} not {6,}: real Slack ids are 9-11 chars (C66PP782T9K, DL1HA3II6V6), and {6,} collided with
// ordinary words — 'current' uppercases to CURRENT = C + URRENT, which matched and classified a
// job with delivery.channel:'current' as OK. That is a false ACCEPT, the direction that fails
// silently at post time. Observed live on a real sandbox job.
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{8,}$/;
const isSlackChannelId = (c) => typeof c === 'string' && SLACK_CHANNEL_ID.test(c);

/**
 * Channel from a session key, PRESERVING CASE. Deliberately not `channelOf`, which lowercases
 * before matching (fine for inventory grouping, fatal for posting — see above).
 *
 * NB "preserving" is not "correct": OpenClaw writes session keys lowercased, so on a real hydrated
 * job the case preserved here is the WRONG case. Callers that intend to post must run the result
 * through `parseDestination` (which uppercases) — see resolveDeliveryTarget.
 */
function channelFromSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string') return null;
  const m = sessionKey.match(/slack:thread:(?:dm:)?([^:]+):/i);
  return m ? m[1] : null;
}

/**
 * The USER a DM-scoped session belongs to — `…:dm:<userId>`, as OpenClaw writes it (lowercased).
 *
 * This is the portable half of a DM's identity. See the DM rule in resolveDeliveryTarget.
 */
function userFromSessionKey(sessionKey) {
  if (typeof sessionKey !== 'string') return null;
  const m = sessionKey.match(/:dm:([a-z0-9]+)\s*$/i);
  return m ? m[1] : null;
}

/**
 * §8.10 — the USER a `dm-<userId>`-scoped agent belongs to.
 *
 * Under identity=scope the agent id IS the route (agent-scope.js: `dm-<userId>` / `ch-<channelId>`,
 * normalised to lowercase), so for a DM-scoped agent the owning human is derivable from the id
 * alone — no delivery config, no session key, nothing stored. That makes it the one rung that
 * cannot go stale, which is why it sits at the BOTTOM of the ladder: it is the answer when
 * everything the author wrote has stopped resolving.
 *
 * Case recovery is lossless for the same reason it is on the session-key rung: normaliseScopeId
 * lowercases, and Slack ids are an uppercase-only alphabet.
 *
 * Returns null for a `ch-` scope. A channel scope COULD derive a destination the same way, and
 * deliberately does not: for a DM the scope is the only conversation the agent has, whereas a
 * channel agent posting into its own channel by default is a real behaviour change for jobs that
 * currently announce nowhere. That decision is not made here.
 */
function userFromScopeId(agentId) {
  if (typeof agentId !== 'string') return null;
  const m = agentId.match(/^dm-([a-z0-9]+)$/i);
  if (!m) return null;
  const up = m[1].toUpperCase();
  return /^U[A-Z0-9]{6,}$/.test(up) ? up : null;
}

// §12c CORRECTION (2026-08-09, after reading OpenClaw's delivery resolution).
//
// `delivery.channel` is NOT a Slack channel — OpenClaw is multi-transport and the field selects a
// TRANSPORT (`slack`, `webchat`, `discord`, …) or the sentinel `last`. The destination lives in
// `to` (the CLI documents it as "E.164, Telegram chatId, or Discord channel/user"). Our
// cron-delivery passed `channel` straight into chat.postMessage, which reinterpreted the field —
// so a perfectly valid `{channel:'slack', to:'U…'}` job looked malformed to us.
//
// Measured over the live prod store (56 enabled announce jobs): to=user-id 17, to=channel-id 9,
// prefixed `user:`/`channel:` 8, lowercased id in `channel` 8, both absent 12, webchat 1.
const TRANSPORT_NAMES = new Set(['slack', 'webchat', 'discord', 'telegram', 'sms', 'whatsapp', 'last']);

/**
 * Parse an OpenClaw destination into a typed target.
 * Handles the `<kind>:<id>` prefix form seen in prod (`user:U…`, `channel:C…`) and recovers
 * lowercased ids (OpenClaw normalises some keys to lowercase; Slack ids are case-sensitive).
 * @returns {{channel:string}|{user:string}|null}
 */
function parseDestination(value) {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (!v) return null;
  let forced = null;
  const m = v.match(/^(user|channel):(.+)$/i);
  if (m) { forced = m[1].toLowerCase(); v = m[2].trim(); }
  if (TRANSPORT_NAMES.has(v.toLowerCase()) && !forced) return null; // a transport, not a destination
  const up = v.toUpperCase();
  if (forced === 'user' || /^U[A-Z0-9]{6,}$/.test(up)) return /^U[A-Z0-9]{6,}$/.test(up) ? { user: up } : null;
  if (isSlackChannelId(up)) return { channel: up };
  return null;
}

/**
 * §12c — where a job should deliver, as a TYPED TARGET (resolution of a user → DM needs
 * conversations.open, which is I/O this pure module must not do; the caller does that).
 *
 * Precedence: an EXPLICIT destination beats the ambient one — `to`/`channel` are only set when the
 * author chose a target, whereas the session key is merely where the job happened to be created.
 * A transport name in `channel` is skipped rather than rejected: it says HOW to deliver, not where.
 *
 * @returns {{channel:string}|{user:string}|null}
 */
function resolveDeliveryTarget(job) {
  const d = (job && job.delivery) || {};
  const target = parseDestination(d.to)
    || parseDestination(d.channel)
    // §12c/G4 — LIVE-CAUGHT (2026-08-10, prod EFS): the ambient rung must go through
    // parseDestination too, not a bare isSlackChannelId.
    //
    // OpenClaw LOWERCASES session keys by construction — the real prod shape is
    // `agent:<agentId>:slack:thread:dmw8mne5g42:<ts>` — and isSlackChannelId is uppercase-only
    // (deliberately: Slack rejects `dl1ha3ii6v6` with channel_not_found). So this rung could NEVER
    // fire on a hydrated job, which made the whole ladder one rung shorter than it reads. Every
    // symbolic-transport job classified announce-unusable-channel while carrying a perfectly good
    // channel in its own session key, and the hydrator would have seeded them all DISABLED.
    //
    // parseDestination already does the uppercase recovery for `to`/`channel`; Slack ids are an
    // uppercase-only alphabet ([CDG][A-Z0-9]+), so recovering case off a lowercased key is
    // lossless — not a guess. This is the `webchat` mapping decision (treat it as an ordinary
    // channel post using the job's own conversation) and it lands the `slack`/`last` transport
    // cohort with it, since all three fail for the identical reason.
    || parseDestination(channelFromSessionKey(job && job.sessionKey));

  // ── THE OWNING SCOPE IS A DESTINATION ───────────────────────────────────────────────────────────
  //
  // A cron owned by a DM-scoped agent has somewhere to post by definition: the DM it is scoped to.
  // `dm-<userId>` carries that user, so this rung needs nothing stored and cannot drift — where the
  // three rungs above all describe where the job was AUTHORED, which is exactly what goes stale.
  //
  // Used LAST, so an explicit destination still wins: a DM agent that announces into #eng keeps
  // announcing into #eng. It only decides the two cases where the ladder otherwise gives up:
  //   * nothing resolvable at all — previously announce-missing-channel, i.e. seeded disabled or
  //     failing `no resolvable delivery target` on every fire;
  //   * a `D…` DM id from another Slack app where the session key has no `:dm:<user>` to recover
  //     from (true for every job the archie cron tool creates: its key is `slack:thread:D…:<ts>`).
  const owner = userFromScopeId(job && job.agentId);

  // ── A DM CHANNEL ID IS NOT PORTABLE; THE USER IS ────────────────────────────────────────────────
  //
  // `conversations.open(user)` returns THE CALLING APP'S DM channel, so a `D…` id is only meaningful
  // to the app that minted it. A job authored under one Slack app and delivered by another fails with
  // `channel_not_found` — observed live 2026-08-16, every cron announce for a DM-scoped agent: the
  // turn ran, produced output, and the post was rejected because `DL1HA3II6V6` belongs to the OpenClaw
  // app and archie's app cannot see it. 24 prod jobs carry a `D…` target today.
  //
  // Every rung above yields a CHANNEL, and for a DM they all yield the SAME foreign one — `to`,
  // `channel`, and the session key alike — so the ladder cannot recover on its own. The user id can,
  // and the job already carries it in its session key. Resolving it costs one cached
  // conversations.open in the caller, which is machinery that already exists for `user:U…` targets.
  //
  // ONLY `D…` IS REWRITTEN. A `C…` (public) or `G…` (group) id means the same conversation in every
  // app that is a member, so those are left exactly as authored. This is not a fallback on failure —
  // it is a statement that for a DM the user is the more precise answer, and it must hold for the
  // pure consumers (the inventory gauge, the span attributes, the add-time validity check) as much as
  // for delivery, or they disagree about what a job targets.
  //
  // The scope is the SECOND source of the user, and the only one a natively-created job has.
  if (target && target.channel && /^D/.test(target.channel)) {
    const user = userFromSessionKey((job && job.sessionTarget) || (job && job.sessionKey));
    if (user) return { user: user.toUpperCase() };
    if (owner) return { user: owner };
  }
  if (!target && owner) return { user: owner };
  return target;
}

/**
 * The channel a job can post to WITHOUT further lookup, or null. A `{user}` target is resolvable
 * but not yet resolved, so it is deliberately NOT a channel here — callers that can do I/O use
 * resolveDeliveryTarget and open the DM.
 */
function resolveDeliveryChannel(job) {
  const t = resolveDeliveryTarget(job);
  return t && t.channel ? t.channel : null;
}

/**
 * M4.1 — the ONE delivery-validity predicate (pi-cron-migration-plan §9r follow-up / M4.2).
 *
 * Deliberately pure and I/O-free: this same function backs the inventory `Mode` dimension, the
 * CronJobsMisconfigured gauge, the span attributes on a fire, AND (next) the add-time rejection in
 * cron-api.js. One rule, four consumers — the alternative is four drifting copies, which is exactly
 * how the live bug survived (a job was accepted with {mode:'announce', to:'<userId>'} and no
 * channel, then failed invalid_arguments on every fire while every metric stayed green).
 *
 * Statuses:
 *   ok                        — will deliver
 *   no-delivery               — no delivery block: fires, produces text, posts NOTHING, silently,
 *                               forever. Legitimate for side-effect jobs; a trap for the rest.
 *   announce-missing-channel  — mode:'announce' with no resolvable channel -> chat.postMessage gets
 *                               channel:undefined -> invalid_arguments on EVERY fire.
 *   unknown-mode              — a mode cron-delivery.js will throw on.
 *
 * NB `to` is overloaded by the existing job contract: thread_ts for announce, the URL for webhook.
 * That overload is what the agent tripped on; we classify it, we do not silently reinterpret it.
 */
const DELIVERY_STATUS = {
  OK: 'ok',
  NO_DELIVERY: 'no-delivery',
  ANNOUNCE_MISSING_CHANNEL: 'announce-missing-channel',
  // §12c/G4: a channel is PRESENT but not postable — an OpenClaw symbolic value (`slack`,
  // `webchat`, `last`, `user:<id>`) or a lowercased id. Distinct from MISSING because the fix is
  // different: missing needs a source, unusable needs a MAPPING. Before this, classifyDelivery
  // checked presence only and reported all 26 such prod jobs as healthy.
  ANNOUNCE_UNUSABLE_CHANNEL: 'announce-unusable-channel',
  UNKNOWN_MODE: 'unknown-mode',
};

/** The channel a job would actually announce into, or null when none is resolvable. */
function resolveChannel(job) {
  const ch = channelOf(job);
  return ch === 'none' ? null : ch;
}

function classifyDelivery(job) {
  const delivery = (job && job.delivery) || null;
  const channel = resolveChannel(job);
  if (!delivery || !delivery.mode || delivery.mode === 'none') {
    // An explicit {mode:'none'} is a deliberate side-effect job; a MISSING block is very often an
    // oversight. Both are silent at runtime, so both are reported here and the caller decides —
    // we keep them distinguishable via `explicit`.
    return { mode: 'none', channel, status: DELIVERY_STATUS.NO_DELIVERY, explicit: !!(delivery && delivery.mode === 'none') };
  }
  if (delivery.mode === 'announce') {
    // §12c: validity is "is there a resolvable TARGET", not "is a string present". A {user}
    // target is valid — the caller opens the DM — so it counts as ok here.
    const target = resolveDeliveryTarget(job);
    let status = DELIVERY_STATUS.OK;
    if (!target) {
      // Something was specified but it resolves to nothing we can reach (e.g. `webchat`, which
      // has no Slack equivalent at all) vs nothing specified anywhere.
      const specified = ['to', 'channel'].some((k) => typeof delivery[k] === 'string' && delivery[k].trim() !== '');
      status = specified ? DELIVERY_STATUS.ANNOUNCE_UNUSABLE_CHANNEL : DELIVERY_STATUS.ANNOUNCE_MISSING_CHANNEL;
    }
    return {
      mode: 'announce',
      channel: (target && target.channel) || channel,
      ...(target && target.user ? { user: target.user } : {}),
      status,
      explicit: true,
    };
  }
  return { mode: String(delivery.mode), channel, status: DELIVERY_STATUS.UNKNOWN_MODE, explicit: true };
}

/**
 * §12c — the session key a cron fire runs in. ONE scoping rule for everything:
 * `<channelId|dmId>:<threadId>`, with the job owning a SYNTHETIC thread in its channel.
 *
 *   slack:thread:<channel>:<threadTs>     ← human conversation   (untouched)
 *   slack:thread:<channel>:cron-<jobId>   ← the job's own thread
 *
 * Why not the human's thread: a recurring job would append to a session a person is also using
 * (~480 turns/day at everyMs:180000) and race their turns, since Pi appends JSONL per session.
 * OpenClaw avoided exactly that by making `main` a QUEUE, not a turn in their session.
 *
 * Why per-JOB and not per-fire: OpenClaw's `isolated` is `cron:<jobId>` — stable across fires, so
 * a job resumes its own history. Our old `cron:iso:<agent>:<uuid>` was fresh every fire (no
 * continuity at all) and `cron:main:<agent>` was shared by ALL of an agent's jobs (cross-job
 * bleed). Neither reproduced upstream; this does.
 *
 * Channel ladder (§12c.2): ambient sessionKey → delivery.channel → the agent's routed channel
 * (injected, since routing lives in the dispatcher) → none. A job with NO resolvable channel still
 * gets a stable PER-JOB key, because continuity does not depend on having somewhere to post.
 *
 * @param opts.channelForAgent optional (agentId) => channelId — the routing rung.
 */
function buildCronSessionKey(job, opts = {}) {
  const jobId = (job && job.jobId) || (job && job.id) || 'unknown';
  const agentId = (job && job.agentId) || 'unknown';
  let channel = resolveDeliveryChannel(job);
  if (!channel && typeof opts.channelForAgent === 'function') {
    let routed = null;
    try { routed = opts.channelForAgent(agentId); } catch { routed = null; }
    if (isSlackChannelId(routed)) channel = routed;
  }
  return channel
    ? `slack:thread:${channel}:cron-${jobId}`
    // Channel-less but still per-job: preserves run-to-run continuity for side-effect jobs
    // (mode 'none'/webhook) that legitimately have nowhere to post.
    : `cron:${agentId}:${jobId}`;
}

/**
 * Compact schedule descriptor for the per-job record (a property, never a dimension).
 *
 * Every kind carries a human `expr`. It used to be set for `cron` ONLY, while cron-metrics.js's
 * CronJobRemoved projection synthesised one for all three kinds — so the same logical field had two
 * shapes, and the inventory widget (which selects `schedule.expr`) rendered BLANK for every
 * `every`/`at` job while the removals widget showed them fine. Live-caught on the dashboard.
 * One shape here kills the divergence at source, and also fills the `cron.schedule.*` span attrs.
 */
function scheduleOf(job) {
  const s = (job && job.schedule) || {};
  if (s.kind === 'cron') return { kind: 'cron', expr: s.expr, tz: s.tz || null };
  if (s.kind === 'every') return { kind: 'every', everyMs: s.everyMs, expr: `every ${s.everyMs}ms` };
  if (s.kind === 'at') return { kind: 'at', at: s.at, expr: `at ${s.at}` };
  return { kind: s.kind || 'unknown' };
}

// Tally jobs into per-agent and per-channel {total, enabled} buckets. `enabled` defaults to
// true when the field is absent (matches the runner: a job fires unless enabled === false).
// Written as an ESCAPE, not a raw NUL byte: a literal NUL makes this file `binary` to grep,
// which silently excluded it from a repo-wide audit and let its hardcoded metric namespace
// survive undetected. Same value, greppable file.
const SEP = '\u0000'; // composite map key separator — never appears in a channel/agent/mode id

function aggregate(jobs) {
  const byAgent = new Map();
  const byChannel = new Map();
  const byChannelMode = new Map(); // M4.2: (channel, mode) — 'none'+'announce' IS the misconfig query
  const byAgentReason = new Map(); // M4.3: (agent, reason) for non-ok jobs only
  const bump = (map, key) => map.get(key) || { total: 0, enabled: 0 };
  for (const job of jobs) {
    const agent = (job && job.agentId) || 'unknown';
    const channel = channelOf(job);
    const isEnabled = !(job && job.enabled === false);
    const { mode, status } = classifyDelivery(job);

    const a = bump(byAgent, agent); a.total += 1; if (isEnabled) a.enabled += 1; byAgent.set(agent, a);
    const c = bump(byChannel, channel); c.total += 1; if (isEnabled) c.enabled += 1; byChannel.set(channel, c);
    const cmKey = `${channel}${SEP}${mode}`;
    const cm = bump(byChannelMode, cmKey); cm.total += 1; if (isEnabled) cm.enabled += 1; byChannelMode.set(cmKey, cm);

    if (status !== DELIVERY_STATUS.OK) {
      const arKey = `${agent}${SEP}${status}`;
      const ar = byAgentReason.get(arKey) || { count: 0 };
      ar.count += 1;
      byAgentReason.set(arKey, ar);
    }
  }
  return { byAgent, byChannel, byChannelMode, byAgentReason };
}

/**
 * @param deps.emit       optional (line:string) => void sink (default: process.stdout).
 * @param deps.namespace  optional metric namespace (default ClawdbotCron).
 * @param deps.now        optional () => epoch ms (injectable for tests).
 * @param deps.log        optional pino-shaped logger.
 * @returns { snapshot(jobs), channelOf }
 */
function createCronInventoryEmitter(deps = {}) {
  const emit = deps.emit || ((line) => process.stdout.write(`${line}\n`));
  const namespace = deps.namespace || NAMESPACE;
  const now = deps.now || Date.now;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  const metricDefs = [
    { Name: METRIC_TOTAL, Unit: 'Count' },
    { Name: METRIC_ENABLED, Unit: 'Count' },
  ];

  /**
   * Emit one EMF line per agent (Agent dim + fleet-wide `[]` aggregate) and one per channel
   * (Channel dim). Never throws — a metrics failure must not take down the scheduler.
   * @param jobs the enriched job list (store.list()).
   * @returns { agents, channels, jobs } counts actually snapshotted.
   */
  function snapshot(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const { byAgent, byChannel, byChannelMode, byAgentReason } = aggregate(list);
    const ts = now();
    try {
      for (const [agent, v] of byAgent) {
        emit(JSON.stringify({
          _aws: {
            Timestamp: ts,
            CloudWatchMetrics: [{
              Namespace: namespace,
              Dimensions: [['Agent'], []], // per-agent AND a fleet-wide aggregate (SUM = fleet total)
              Metrics: metricDefs,
            }],
          },
          Agent: agent,
          [METRIC_TOTAL]: v.total,
          [METRIC_ENABLED]: v.enabled,
        }));
      }
      for (const [channel, v] of byChannel) {
        emit(JSON.stringify({
          _aws: {
            Timestamp: ts,
            CloudWatchMetrics: [{
              Namespace: namespace,
              Dimensions: [['Channel']], // per-channel only — the agent lines already carry the fleet total
              Metrics: metricDefs,
            }],
          },
          Channel: channel,
          [METRIC_TOTAL]: v.total,
          [METRIC_ENABLED]: v.enabled,
        }));
      }
      // M4.2: (Channel, Mode) as its OWN line carrying ONLY the two-dimension set — deliberately
      // NOT folded into the Channel line's dimension list. These are GAUGES: publishing the same
      // metric under Channel-alone from N per-mode lines would put N datapoints per tick on that
      // series, so Sum would multiply by tick-count over a window and Maximum would report one
      // mode's count as if it were the channel total. Separate lines keep the pre-M4 Channel
      // series at exactly one datapoint per tick (semantics unchanged) while making
      // `Channel=none AND Mode=announce` — the misconfiguration fingerprint — directly queryable.
      for (const [key, v] of byChannelMode) {
        const [channel, mode] = key.split(SEP);
        emit(JSON.stringify({
          _aws: {
            Timestamp: ts,
            CloudWatchMetrics: [{
              Namespace: namespace,
              Dimensions: [['Channel', 'Mode']],
              Metrics: metricDefs,
            }],
          },
          Channel: channel,
          Mode: mode,
          [METRIC_TOTAL]: v.total,
          [METRIC_ENABLED]: v.enabled,
        }));
      }
      // M4.3: at-rest misconfiguration, per (Agent, Reason) + a fleet-wide aggregate. Only non-ok
      // jobs emit, so silence == a clean fleet (alarm with treat_missing_data=notBreaching).
      for (const [key, v] of byAgentReason) {
        const [agent, reason] = key.split(SEP);
        emit(JSON.stringify({
          _aws: {
            Timestamp: ts,
            CloudWatchMetrics: [{
              Namespace: namespace,
              Dimensions: [['Agent', 'Reason'], ['Reason'], []],
              Metrics: [{ Name: METRIC_MISCONFIGURED, Unit: 'Count' }],
            }],
          },
          Agent: agent,
          Reason: reason,
          [METRIC_MISCONFIGURED]: v.count,
        }));
      }
    } catch (err) {
      log.warn({ err: String(err && err.message) }, 'cron inventory metric emit failed');
      return { agents: 0, channels: 0, jobs: list.length };
    }
    // Return shape deliberately unchanged by M4 — callers (and the existing contract test) treat
    // it as {agents, channels, jobs}. The misconfiguration count is on the wire, not in the return.
    return { agents: byAgent.size, channels: byChannel.size, jobs: list.length };
  }

  /**
   * M4.5 — one EMF line per job: metric value 1, dimensioned (Agent, Mode) only, with everything
   * a human needs riding as searchable PROPERTIES (jobId, name, schedule, nextRunAtMs, channel,
   * status). One Logs Insights query then answers "what is configured, where, when does it next
   * run, and is it valid" across every channel and DM — the question that previously required
   * exec'ing into the container to hit /cron/:agentId.
   *
   * Emitted on its OWN (slower) cadence, not the 60s aggregate one: at fleet scale this is
   * O(routes x jobs) lines per tick, which is fine at 15 min and wasteful at 60s.
   * Never throws — a metrics failure must not take down the scheduler.
   */
  function jobRecords(jobs) {
    const list = Array.isArray(jobs) ? jobs : [];
    const ts = now();
    let emitted = 0;
    try {
      for (const job of list) {
        const { mode, channel, status, user } = classifyDelivery(job);
        emit(JSON.stringify({
          _aws: {
            Timestamp: ts,
            CloudWatchMetrics: [{
              Namespace: namespace,
              Dimensions: [['Agent', 'Mode']], // JobId stays a PROPERTY — a per-job dimension would be unbounded
              Metrics: [{ Name: METRIC_JOB, Unit: 'Count' }],
            }],
          },
          Agent: (job && job.agentId) || 'unknown',
          Mode: mode,
          JobId: (job && job.jobId) || (job && job.id) || 'unknown',
          name: (job && job.name) || null,
          channel: channel || 'none',
          // A user target is a real destination (it DMs them) but has no channel until
          // conversations.open runs, so `channel` alone read as 'none' — i.e. "nowhere to go" —
          // for a job that delivers fine. `target` is the honest answer.
          target: channel || (user ? `user:${user}` : 'none'),
          ...(user ? { user } : {}),
          status,
          enabled: !(job && job.enabled === false),
          schedule: scheduleOf(job),
          nextRunAtMs: (job && job.state && job.state.nextRunAtMs) || null,
          // LAST-run state. The runner (cron-runner.js) and deliverAndRecord (cron-service.js)
          // already write all four into job.state; the record simply never projected them, so the
          // inventory could show when a job WILL run but never whether it ever DID — and "runs but
          // never delivers" (the §12c.6b failure mode, ~47 prod jobs) was invisible here.
          lastRunAtMs: (job && job.state && job.state.lastRunAtMs) || null,
          lastRunStatus: (job && job.state && job.state.lastRunStatus) || null,
          lastDeliveryAtMs: (job && job.state && job.state.lastDeliveryAtMs) || null,
          lastDeliveryStatus: (job && job.state && job.state.lastDeliveryStatus) || null,
          sessionTarget: (job && job.sessionTarget) || null,
          [METRIC_JOB]: 1,
        }));
        emitted += 1;
      }
    } catch (err) {
      log.warn({ err: String(err && err.message) }, 'cron job-record metric emit failed');
    }
    return { jobs: list.length, emitted };
  }

  return {
    snapshot,
    jobRecords,
    channelOf,
    classifyDelivery,
    _namespace: namespace,
    _metricTotal: METRIC_TOTAL,
    _metricEnabled: METRIC_ENABLED,
    _metricMisconfigured: METRIC_MISCONFIGURED,
    _metricJob: METRIC_JOB,
  };
}

// ── G7: payload.timeoutSeconds / payload.model (§12c.7) ───────────────────────
//
// Both fields were carried through the projection and never read. Ported here as ONE rule with
// three consumers (fire enforces, api validates, tests pin) rather than three readings of it.
//
// Mirrors OpenClaw v2026.4.24 `resolveCronJobTimeoutMs` EXACTLY, including two behaviours that
// look like bugs and are not ours to fix:
//   • timeoutSeconds is read ONLY for kind:'agentTurn'. A systemEvent job that sets it is
//     silently ignored and gets the 10-minute default.
//   • `<= 0` means NO TIMEOUT (documented in the cron tool's own doc string as "0 means no
//     timeout"), so it returns null here rather than a number.
const CRON_TIMEOUT = {
  // upstream AGENT_TURN_SAFETY_TIMEOUT_MS — "agent turns can legitimately run much longer"
  AGENT_TURN_DEFAULT_MS: 60 * 60_000,
  // upstream DEFAULT_JOB_TIMEOUT_MS
  DEFAULT_MS: 10 * 60_000,
};

/**
 * The wall-clock budget for one fire, in ms, or `null` for UNBOUNDED.
 *
 * NB the dispatcher previously had no cron timeout at all, i.e. it behaved as `null` for every
 * job — including the 306 prod jobs that asked for a bound and the 30 actively hitting one. An
 * unbounded turn is worse than a failing one: it burns until AgentCore's own session ceiling kills
 * it, records no cron-level error, and never bumps consecutiveErrors, so failureAlert cannot trip.
 */
function resolveCronTimeoutMs(job) {
  const p = (job && job.payload) || {};
  const isAgentTurn = p.kind === 'agentTurn';
  const raw = isAgentTurn && typeof p.timeoutSeconds === 'number' && Number.isFinite(p.timeoutSeconds)
    ? Math.floor(p.timeoutSeconds * 1000)
    : undefined;
  if (raw === undefined) return isAgentTurn ? CRON_TIMEOUT.AGENT_TURN_DEFAULT_MS : CRON_TIMEOUT.DEFAULT_MS;
  return raw <= 0 ? null : raw;
}

/** Upstream's error text, verbatim — see `normalizeCronRunErrorText`. Kept identical so the runner's
 *  consecutiveErrors/failureAlert path and cron-hydrator's `classifyUpstreamFailure` both behave the
 *  same on our timeouts as on a rolled-back OpenClaw one. */
const CRON_TIMEOUT_ERROR = 'cron: job execution timed out';

/**
 * The per-job model override, normalised to a bare Bedrock model id, or null.
 *
 * Prod carries BOTH forms (measured): `amazon-bedrock/global.anthropic.claude-sonnet-4-6` and the
 * bare `global.anthropic.claude-opus-4-8`. Strip the provider prefix the same way the Pi config
 * mapper does (`resolveModelSpec`), because the runtime's getModel wrapper is amazon-bedrock-scoped.
 *
 * Only read for kind:'agentTurn' — `model` is an agentTurn payload field upstream, and a
 * systemEvent nudge has no turn of its own to configure.
 */
function resolveCronModel(job) {
  const p = (job && job.payload) || {};
  if (p.kind !== 'agentTurn') return null;
  if (typeof p.model !== 'string') return null;
  const spec = p.model.trim();
  if (!spec) return null;
  const i = spec.indexOf('/');
  return i < 0 ? spec : spec.slice(i + 1);
}

module.exports = {
  createCronInventoryEmitter,
  resolveCronTimeoutMs,
  resolveCronModel,
  CRON_TIMEOUT,
  CRON_TIMEOUT_ERROR,
  channelOf,
  resolveChannel,
  resolveDeliveryChannel,
  resolveDeliveryTarget,
  parseDestination,
  isSlackChannelId,
  channelFromSessionKey,
  userFromScopeId,
  buildCronSessionKey,
  classifyDelivery,
  scheduleOf,
  DELIVERY_STATUS,
  CRON_INVENTORY_NAMESPACE: NAMESPACE,
  CRON_INVENTORY_METRIC_TOTAL: METRIC_TOTAL,
  CRON_INVENTORY_METRIC_ENABLED: METRIC_ENABLED,
  CRON_INVENTORY_METRIC_MISCONFIGURED: METRIC_MISCONFIGURED,
  CRON_INVENTORY_METRIC_JOB: METRIC_JOB,
};

// M2 (S6): the OTEL bootstrap MUST load before any @aws-sdk module — the aws-sdk
// auto-instrumentation patches clients at require time. Keep this the FIRST require.
// (The task-def also sets NODE_OPTIONS=--require /app/tracing.js; tracing.js is idempotent.)
require('./tracing');

// Slack dispatcher for clawdbot.
//
// Single holder of SLACK_BOT_TOKEN / SLACK_APP_TOKEN. Agent containers
// never get the Slack tokens — they talk to Slack only through this
// dispatcher's internal HTTP proxy.
//
// Two directions:
//
//   1. Inbound (Slack → agent)
//      Socket Mode receives events, the router picks an agent, and we
//      forward via a persistent WebSocket to the agent's OpenClaw gateway
//      using `sessions.send`. This gives full session continuity — the
//      LLM sees the entire conversation history for each Slack thread/DM.
//
//   2. Outbound (agent → Slack)
//      Express proxy on PORT. Agents POST /api/{slackMethod} with the
//      call body; we forward to the Slack Web API using the bot token.
//      Tokens never leave this process.
//
// Routes are loaded from the agent-config DynamoDB table (the routing GSI): each agent's
// slack config (DM users + channels it owns) is aggregated into the routes table on startup
// and on POST /reload.

const { App } = require('@slack/bolt');
const { WebClient } = require('@slack/web-api');
const express = require('express');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Mutex } = require('async-mutex');
const pino = require('pino');
const { BedrockClient } = require('@aws-sdk/client-bedrock');
const { BedrockRuntimeClient } = require('@aws-sdk/client-bedrock-runtime');
const marketplace = require('./marketplace');
const grants = require('./grants');
const conversations = require('./conversations');
const { recordMessage } = require('./metrics');
const { StreamingManager } = require('./streaming');
const { createAgentCoreClient } = require('./agentcore-client');
const agentCore = createAgentCoreClient();

const { createCronService } = require('./cron-service');
const { createCronApi } = require('./cron-api');
const { createDeliver } = require('./cron-delivery');
const { createCronAlertEmitter } = require('./cron-metrics');
const { createCronRunnerFlags } = require('./cron-runner-flag');
const { buildCronSessionKey } = require('./cron-inventory-metrics');
const { createBackpressureNotifier } = require('./backpressure');
const { createImageSource } = require('./image-source');
const { createTurnQueue } = require('./turn-queue');
const { createSessionTracker } = require('./session-tracker');
const { createCronHome } = require('./cron-home');
const { mintAgentName } = require('./agent-scope');
const { diffObserved, specDiff } = require('./spec-diff');
const { createDispatcherMetrics } = require('./dispatcher-metrics');
const { createRuntimeQuotaSampler } = require('./runtime-quota-metrics');
const routingBuild = require('./routing-build');
const { generateFileRef: _generateFileRef, parseFileRef } = require('./file-ref');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
// @opentelemetry/api only (no-op tracer until ./tracing registers a provider) — M2 phase spans.
const {
  trace: otelTrace, SpanKind, SpanStatusCode, propagation, context: otelContext,
} = require('@opentelemetry/api');
const tracer = otelTrace.getTracer('slack-dispatcher');

// ---------- Logging (fix 4) ----------
//
// Structured JSON logs with consistent field names. Children created
// per-event carry the correlation fields (event_id, agent, channel, …)
// so a single grep in Datadog follows one Slack event through inbound
// routing, outbound forwarding, and any error.

const log = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'slack-dispatcher' },
});

// Dispatcher EMF metrics (ClawdbotDispatcher namespace) — injected into the agentcore client for
// provision/invoke metrics, and used for the turn/routing counters emitted from this file.
const dispatcherMetrics = createDispatcherMetrics({ log });

// A3 (§9.5): let a GRANT#* mutation drive the derived-role lifecycle. No-op unless
// (always on — no flag); same-tier → live PutRolePolicy, a
// base↔dedicated crossing → runtime recreate.
marketplace.setDerivedRoleHook((gc) => agentCore.applyDerivedRoleGrantChange(gc.agentId, gc, { logger: log }));
// The same hook for the OTHER writer of GRANT#*: App Home's Tools tab. Both go through it because a
// capability is two facts — the DynamoDB row the in-container PEP reads, and the derived role's
// inline policy that grants the underlying AWS access. Writing one without the other produces a
// capability the agent is permitted to use and cannot actually exercise.
grants.setDerivedRoleHook((gc) => agentCore.applyDerivedRoleGrantChange(gc.agentId, gc, { logger: log }));

// ---------- Config ----------

const PORT = parseInt(process.env.PORT || '9090', 10);
const NO_SOCKET_MODE = process.env.NO_SOCKET_MODE === 'true';
const SLACK_BOT_TOKEN = requireEnv('SLACK_BOT_TOKEN');
const SLACK_APP_TOKEN = NO_SOCKET_MODE ? null : requireEnv('SLACK_APP_TOKEN');
const DISPATCHER_SECRET = requireEnv('DISPATCHER_SHARED_SECRET');
const CONNECTOR_API_KEY = process.env.CONNECTOR_API_KEY || '';

// STREAMING_AGENTS (optional): comma-separated agent names to force streaming
// on, merged on top of the repo-derived streaming flags. Useful for local
// testing when the config repo doesn't have streaming: true for your agent.
const extraStreamingAgents = (process.env.STREAMING_AGENTS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Dispatcher config — routing AND marketplace — is read entirely from the agent-config DynamoDB
// table (routing GSI + AGENT#*/MARKETPLACE + SKILL#_catalog). No git repo clone (Phase 4).
const AGENT_CONFIG_TABLE = process.env.AGENT_CONFIG_TABLE || '';

// Which container image the fleet runs, read from DynamoDB rather than this task definition — so
// publishing a build is a DDB write picked up by the NEXT message, with no dispatcher deploy. The
// dispatcher only passes through. Declared HERE, after
// AGENT_CONFIG_TABLE — a const is in its temporal dead zone before its declaration, so building this
// next to the agentCore client (where it belongs conceptually) would throw at module load.
// Durable turn queue. Its PRESENCE is the switch — no enable flag, because a flag that turns
// durability off is a way to lose messages by accident. Unset (today) = turns run inline exactly as
// before; set = every Slack turn is persisted before it runs. Producer and consumer ship together:
// a producer with no consumer strands messages.
// Session first-use / reuse, as telemetry on the turn's span. Reuse is the biggest swing in a warm
// turn (platform leg ~2,500ms new vs ~118ms reused), and until now the split could only be INFERRED
// from that leg's bimodal shape in an ad-hoc query. Constructed with the same lifecycle numbers the
// runtime spec uses, so `session.idle_expired` means what it says.
const sessionTracker = createSessionTracker({ idleTimeoutMs: 900_000, maxLifetimeMs: 28_800_000 });

const turnQueue = createTurnQueue({
  queueUrl: process.env.TURN_QUEUE_URL || '',
  logger: log,
  metrics: agentCore.metrics,
});

// Last generation we ran per agent, so the GC fires ONCE per roll rather than on every turn (a
// list-agent-runtimes sweep per message would be a lot of API calls for a no-op).
const lastGenerationSeen = new Map();
const lastSpecSeen = new Map();   // for attributing WHY a generation rolled

// THE single way to get a runtime ARN. Never call agentCore.ensureRuntime directly: it resolves the
// runtime name from the dispatcher's BAKED image, so a caller that skips this silently ignores the
// published pointer and keeps the fleet on the build image — which is exactly what happened to the
// cron path on the first live roll (a cron fire minted a generation off the floor and never reaped
// the old one, while the Slack path had already moved).
async function ensureCurrentRuntime(agent, { logger } = {}) {
  const image = await imageSource.resolveImage(agent);
  const arn = await agentCore.ensureRuntime(agent, { logger, image });
  // The compiled policy row, on the same cadence as the runtime itself. HERE rather than inside
  // ensureRuntime because it must run for EVERY turn, not only when a runtime is provisioned: this is
  // both the mint-time write (a scope no deploy can enumerate) and the staleness backstop (a policy edit
  // reaching a scope the deploy never saw). Steady state is zero DynamoDB calls — see ensurePolicyRow.
  //
  // NOT awaited before the invoke path?  It is — deliberately. The row must be in place before the turn
  // reads it, or a freshly-pinned capability is denied for one turn and the operator sees a flap. It is
  // contracted never to throw and is a no-op once cached, so the cost is a Map lookup.
  await agentCore.ensurePolicyRow(agent, { logger });
  const keepName = agentCore.generationRuntimeName(agent, image);
  if (keepName !== lastGenerationSeen.get(agent)) {
    const prevName = lastGenerationSeen.get(agent);
    const prevSpec = lastSpecSeen.get(agent);
    const spec = agentCore.runtimeSpecFor(agent, image);
    lastGenerationSeen.set(agent, keepName);
    lastSpecSeen.set(agent, spec);

    // ATTRIBUTION. A generation change is a ~30s provision for this agent, and one dispatcher env
    // change rolls the WHOLE fleet on their next turns. Without saying WHICH input changed, that is a
    // fleet-wide latency event with nothing in the logs explaining it.
    if (prevName) {
      const reason = specDiff(prevSpec, spec);
      logger?.info?.({ agent, from: prevName, to: keepName, reason }, 'runtime generation rolled');
      agentCore.metrics.emitRuntimeGenerationRoll(agent, { from: prevName, to: keepName, reason });
      // Span event on the active dispatcher.request span, so the roll is attributable inside the very
      // trace that triggered it (the metric answers the fleet-wide question, this the per-turn one).
      otelTrace.getActiveSpan()?.addEvent('agentcore.generation.change', {
        'agentcore.generation.from': prevName,
        'agentcore.generation.to': keepName,
        'agentcore.generation.reason': reason,
      });
    }
    // Fire-and-forget: reaping must never delay a reply, and anything missed retries on the next roll.
    //
    // The GC is ALSO the reliable attribution point, and that is not redundancy. The in-process diff
    // above only fires when this dispatcher already saw a previous generation — but the commonest cause
    // of a roll is a DEPLOY that changed config, and a deploy restarts the dispatcher, so `prevName` is
    // empty exactly when the signal matters most. Live-confirmed: the transition to spec hashing rolled
    // an agent and emitted no `runtime generation rolled` at all. What the GC reaps is OBSERVED from
    // AWS, so it survives a restart.
    agentCore.gcOldGenerations(agent, keepName, { logger })
      .then(({ reaped, specs } = {}) => {
        if (!reaped?.length || prevName) return;   // prevName means the diff above already reported it
        // PRECISE attribution without in-process memory: the GC read each superseded runtime's ACTUAL
        // spec back from AWS before deleting it, so we can diff real old config against real new config
        // even though this dispatcher only just booted. A name hash is one-way, so this read is the
        // only thing that can answer "which field changed" after a deploy.
        const oldSpec = specs?.[reaped[0]];
        // No readback at all -> 'observed' (we know it rolled, not why). A readback that yields no
        // field difference -> 'fingerprint-algorithm' from specDiff. The two are different facts.
        const reason = oldSpec ? diffObserved(oldSpec, spec) : ['observed'];
        logger?.info?.({ agent, from: reaped, to: keepName, reason },
          'runtime generation rolled (superseded spec read back from AWS — dispatcher had no prior state)');
        agentCore.metrics.emitRuntimeGenerationRoll(agent, { from: reaped.join(','), to: keepName, reason });
        otelTrace.getActiveSpan()?.addEvent('agentcore.generation.change', {
          'agentcore.generation.from': reaped.join(','),
          'agentcore.generation.to': keepName,
          'agentcore.generation.reason': reason,
        });
      })
      .catch(() => {});
  }
  return arn;
}

const imageSource = createImageSource({
  doc: configDoc,
  table: AGENT_CONFIG_TABLE,
  // The REPO only — a published bare tag resolves against it. There is NO fallback image: with no
  // pointer, provisioning fails and alarms rather than running whatever build this dispatcher
  // happened to ship with.
  repoUri: agentCore.config.imageRepoUri,
  logger: log,
  metrics: agentCore.metrics,
});

// Fleet size against the AgentCore account quota. Started in the boot sequence below.
const runtimeQuota = createRuntimeQuotaSampler({ log, region: agentCore.config.region });

let _configDoc = null;
function configDoc() {
  if (_configDoc) return _configDoc;
  const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  _configDoc = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return _configDoc;
}

// Bedrock — used to list available models for the marketplace model selector.
const bedrockClient = new BedrockClient({ region: process.env.AWS_REGION || 'us-east-1' });
// Bedrock Runtime — used for conversation title summarization via Claude Haiku.
const bedrockRuntimeClient = new BedrockRuntimeClient({ region: process.env.AWS_REGION || 'us-east-1' });

// How long we wait for an agent before giving up + retrying once.
const FORWARD_TIMEOUT_MS = parseInt(process.env.FORWARD_TIMEOUT_MS || '30000', 10);
// Hard deadline for in-flight forwards during shutdown.
const SHUTDOWN_DRAIN_MS = parseInt(process.env.SHUTDOWN_DRAIN_MS || '10000', 10);
// How long the Socket Mode connection can be down before /health fails.
const HEALTH_DISCONNECT_GRACE_MS = parseInt(process.env.HEALTH_DISCONNECT_GRACE_MS || '15000', 10);

// Retry delays (ms) between successive forwarding attempts when the agent is unreachable.
const RETRY_DELAYS_MS = [5000, 15000, 30000]; // 3 retries after initial attempt
// Minimum interval between streaming chat.update calls (Slack Tier 3: ~50 req/min).
const STREAM_UPDATE_INTERVAL_MS = 1500;

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    log.fatal({ env: name }, 'missing required env var');
    process.exit(1);
  }
  return v;
}

function verifySecret(header) {
  const a = Buffer.from(header || '');
  const b = Buffer.from(DISPATCHER_SECRET);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Bind file-ref functions to the dispatcher's secret.
function generateFileRef(fileId) {
  return _generateFileRef(fileId, DISPATCHER_SECRET);
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    log.fatal({ env: name, err: err.message }, 'env is not valid JSON');
    process.exit(1);
  }
}

// ---------- Config repo pull + route aggregation ----------
//
// Each agent lives at {repo}/{subdir}/agents/{agent}/ and may include a
// slack.json:
//
//   {
//     "dm_users":  ["UXXXX", ...],   // DMs from these users → this agent
//     "channels":  ["CXXXX", ...],   // messages in these channels → this agent
//     "require_mention": true,       // only forward @mentions + thread follow-ups (channels only)
//   }
//
// There is NO `is_default`. It is still a legal key upstream in the OpenClaw config repo, so it
// may appear in a migrated agent's config; buildRoutes warns and ignores it (§8.10 identity=scope
// — an unrouted user must never land in a shared persona's session/memory).
//
// We build two maps (dm_users → agent, channels → agent). DMs and channel
// messages use disjoint tables; within each, the
// only fallback is the default agent.
//
// When require_mention is true for a channel, the message handler drops
// top-level messages that aren't @mentions. Thread replies are allowed
// if the bot was @mentioned in the thread root (tracked in mentionedThreads).

let routes = {
  dmUsers: {},
  channels: {},
  requireMention: new Set(),  // channel IDs where only @mentions (+ thread follow-ups) are forwarded
  streamingAgents: new Set(), // agent names with streaming: true in slack.json
  default: null,
};

// The dispatcher-owned cron subsystem (Option B) — the sole scheduler for every agent.
// Forward-declared here; assigned once, below, where its collaborators exist.
let cronService = null;
// Same: cronHome wraps cronService for the App Home Jobs tab, so it cannot be built until the
// service exists. Null before boot completes, which fetchAgentCronJobs reports as "could not load"
// rather than pretending the agent has no jobs.
let cronHome = null;

// ---------- Cron jobs for the App Home ----------

// The Jobs tab reads through cronHome, which lists the dispatcher's OWN cron service in-process.
// This used to be `fetchAgentCronJobs` — an HTTP GET to `AGENT_URLS[agent]/admin/cron/list` on the
// per-agent OpenClaw gateway, plus a 30s cache. Under AgentCore AGENT_URLS is `{}`, so it returned
// null on every call and the tab rendered "Could not load scheduled jobs" permanently. No cache
// now: the store's in-memory map is already authoritative and the dispatcher is its sole writer.
function fetchAgentCronJobs(agentName) {
  return cronHome ? cronHome.list(agentName) : null;
}

// Jobs-tab mutations, in-process. `id` is the store's COMPOSITE id (`agent::job`) as rendered into
// the button, and cronHome scopes every lookup to the caller's agent before acting.
async function cronAction(agentName, action, body) {
  if (!cronHome) throw new Error('cron service not ready');
  const id = body && body.id;
  if (action === 'run') return cronHome.run(agentName, id);
  if (action === 'toggle') return cronHome.toggle(agentName, id, body.enabled);
  if (action === 'remove') return cronHome.remove(agentName, id);
  throw new Error(`unknown cron action: ${action}`);
}

// ---------- Mention-thread tracking ----------
//
// When a channel has require_mention=true, we only forward:
//   1. app_mention events (the @bot message itself)
//   2. thread replies to a thread whose root was an @mention
//
// mentionedThreads tracks channel:thread_ts keys for threads the bot was
// mentioned in. Entries expire after 7 days to prevent unbounded growth.

const mentionedThreads = new Map();  // key → timestamp
const MENTION_THREAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function mentionThreadKey(channel, threadTs) {
  return `${channel}:${threadTs}`;
}

function trackMentionThread(channel, threadTs) {
  mentionedThreads.set(mentionThreadKey(channel, threadTs), Date.now());
}

function isInMentionedThread(channel, event) {
  // Only relevant for thread replies (thread_ts !== ts means it's a reply, not the root)
  if (!event.thread_ts || event.thread_ts === event.ts) return false;
  return mentionedThreads.has(mentionThreadKey(channel, event.thread_ts));
}

// Stale entry cleanup for mentionedThreads
setInterval(() => {
  const cutoff = Date.now() - MENTION_THREAD_TTL_MS;
  for (const [key, ts] of mentionedThreads) {
    if (ts < cutoff) mentionedThreads.delete(key);
  }
}, 60 * 60 * 1000);  // hourly

// Reload mutex: serialises concurrent POST /reload so overlapping DDB re-reads don't race.
const reloadMutex = new Mutex();

async function loadRoutes() {
  // Collect per-agent routing from the DynamoDB routing GSI, then aggregate.
  const agentConfigs = await routingBuild.collectFromDdb(configDoc(), AGENT_CONFIG_TABLE, { log });
  log.info({ count: agentConfigs.length, table: AGENT_CONFIG_TABLE }, 'routing source: DynamoDB');
  routes = routingBuild.buildRoutes(agentConfigs, { extraStreamingAgents, log });

  log.info(
    {
      dm_users: Object.keys(routes.dmUsers).length,
      channels: Object.keys(routes.channels).length,
      require_mention_channels: routes.requireMention.size,
      streaming_agents: [...routes.streamingAgents],
    },
    'routes loaded',
  );

  // Load marketplace data (skill catalog + install state) from DynamoDB — same aggregate shape
  // the old git files produced, so App Home is unchanged.
  const mktResult = await marketplace.loadMarketplaceDataFromDdb(configDoc(), AGENT_CONFIG_TABLE, { log });
  if (mktResult.error) {
    log.error({ err: mktResult.error }, 'marketplace data load failed');
  } else {
    log.info(mktResult, 'marketplace data loaded (DDB)');
  }
}

async function reloadRoutes() {
  return reloadMutex.runExclusive(async () => {
    await loadRoutes();
  });
}

// ---------- Turn feedback ----------
//
// There are NO emoji reactions on a turn any more. The 👀→🤔→✅/❌/⛔ lifecycle was removed
// deliberately: the visible state of a turn is the Slack stream itself (placeholder → deltas →
// stopStream) plus a posted message on failure. Every path that used to depend on a reaction being
// the only signal now says it in text — see the backpressure notice and the stream bridge's
// failure notice.
const shouldAnnounceBackpressure = createBackpressureNotifier();

// ---------- User profile resolution ----------
//
// Resolve Slack user IDs to real names so agents (and their Connector
// session plugin) know *who* is talking, not just a bare UXXXXXX.
// Cached for 1 hour to avoid hammering users.info on every message.

const userProfileCache = new Map();
const USER_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function resolveUserProfile(userId) {
  const cached = userProfileCache.get(userId);
  if (cached && Date.now() - cached.fetchedAt < USER_CACHE_TTL_MS) {
    return cached.profile;
  }
  try {
    // `slack` (WebClient) is defined later but initialised before any event
    // handler runs, so it is safe to reference here.
    const result = await slack.users.info({ user: userId });
    if (result.ok && result.user) {
      const profile = {
        first_name: result.user.profile?.first_name || '',
        last_name: result.user.profile?.last_name || '',
        display_name: result.user.profile?.display_name || result.user.real_name || '',
      };
      userProfileCache.set(userId, { profile, fetchedAt: Date.now() });
      return profile;
    }
  } catch (err) {
    log.warn({ user: userId, err: err.message }, 'failed to resolve user profile');
  }
  return null;
}

// Stale entry cleanup — prevent unbounded growth if many unique users message.
setInterval(() => {
  const cutoff = Date.now() - USER_CACHE_TTL_MS;
  for (const [userId, entry] of userProfileCache) {
    if (entry.fetchedAt < cutoff) userProfileCache.delete(userId);
  }
}, USER_CACHE_TTL_MS);

// ---------- Routing ----------
//
// Rules:
//   - If event is a DM (channel_type === 'im'), look up event.user in dmUsers.
//   - Else look up event.channel in channels.
//   - Fallback to default agent if defined.
//
// This is what lets Peer's DM go to agent-k4wmx6 while Peer's post in #team
// goes to team-agent — same user, different channel_type.

// A source with no explicit route gets its OWN on-demand agent instead of a shared default:
// a deterministic per-DM (dm-<userId>) or per-channel (ch-<channelId>) name. Same source →
// same name every time → agentcore-client.ensureRuntime creates it on first hit and reuses it
// after (runtime is durable). The minted agent boots on the base/default config (resolve-boot
// fallback) + the baked new-agent-skeleton workspace. So routing needs no stored state — the
// name IS the route, recomputed each message.
// The rule itself now lives in agent-scope.js — cron hydration needs it too, and it was already
// duplicated in config-resolver/rekey-to-scope.mjs under a "keep in lockstep" comment. Three copies
// of an id derivation that MUST agree is three chances for the same human to become two agents.

function resolveAgent(event) {
  const isDM = event.channel_type === 'im';
  if (isDM) {
    if (event.user && routes.dmUsers[event.user]) return routes.dmUsers[event.user];
  } else {
    if (event.channel && routes.channels[event.channel]) return routes.channels[event.channel];
  }
  // No explicit route → spawn/route a dedicated agent for this channel/DM.
  return (isDM ? event.user : event.channel) ? mintAgentName(event) : null;
}

// App-home / tab surfaces resolve which agent's home to render for a user. §8.10 identity=scope:
// the viewer is a user → their OWN `dm-<user>` agent, exactly the id the message path mints. There
// is NO shared-default fallback anywhere in this dispatcher — rendering one would show one user's
// private agent (session/MEMORY.md/grants) to another, a cross-user context leak. A missing userId
// is impossible on this path (Slack always supplies the viewer); if it ever happens we fail LOUD
// rather than guess a persona.
function homeAgentFor(userId, surface) {
  const explicit = routes.dmUsers[userId];
  if (explicit) return explicit;
  if (userId) return mintAgentName({ channel_type: 'im', user: userId });
  // The tripwire is the log + throw. It used to also emit a `DefaultRouteHit` metric, which was
  // removed with the default-route concept: the metric reported `routes.default`, a field that no
  // longer exists, and nothing graphed or alarmed on it. The throw is the signal that matters.
  log.error({ surface, userId }, 'homeAgentFor: no userId — refusing to guess an agent (§8.10 fail-closed)');
  throw new Error(`homeAgentFor: no userId for surface=${surface} — refusing to fall back to a shared default agent (§8.10 fail-closed)`);
}

// ---------- Graceful shutdown (fix 5) ----------
//
// Every in-flight forward registers itself in `inflight`. On SIGTERM we
// stop accepting new Slack events (bolt.stop) and wait up to
// SHUTDOWN_DRAIN_MS for the set to empty before exiting, so we don't
// drop messages that are mid-delivery.

const inflight = new Set();
let shuttingDown = false;

function track(promise) {
  inflight.add(promise);
  promise.finally(() => inflight.delete(promise));
  return promise;
}

// ---------- Gateway WebSocket pool ----------
//
// Persistent WebSocket connections to each agent's gateway. Messages are
// sent via `sessions.send` which provides full session continuity — the
// LLM sees the entire conversation history, unlike the old HTTP
// /hooks/agent path which created isolated sessions every time.

function buildSessionKey(event) {
  const channel = event.channel || '';
  const threadTs = event.thread_ts || event.ts;
  return `slack:thread:${channel}:${threadTs}`;
}

// AgentCore requires a runtimeSessionId >= 33 chars. Derive it deterministically from the Slack
// thread session key so repeat messages in a thread reuse the same warm session microVM (idle
// timeout 900s) — do NOT use the per-message idempotencyKey (fresh uuid each message). Sanitize
// to the allowed charset and pad to the length floor.
function agentcoreSessionId(sessionKey) {
  const base = `ac-${sessionKey}`.replace(/[^A-Za-z0-9_-]/g, '-');
  return base.length >= 33 ? base : base + '0'.repeat(33 - base.length);
}

// `streaming` is GONE as a parameter (2026-08-11). It had one caller, which always passed true, and
// its `false` branch told the agent to "reply using the slack_send tool" — a tool that lived in
// slack-reply-plugin, which the AgentCore image does not ship. So the branch was unreachable, but the
// DEFAULT was `false`: any second caller that forgot the flag would have silently produced a turn
// instructing the agent to use a non-existent tool, and the user would have got nothing at all.
// A dead branch guarded by an opt-IN is a trap; every AgentCore turn streams, so the branch is gone.
// (`routes.streamingAgents` is still parsed from config but is only ever echoed in two debug
// responses — it has never gated a routing decision.)
function buildAgentPayload(event, userProfile, { priorContext = '' } = {}) {
  const type = event.type || 'unknown';
  const channel = event.channel || '';
  const channelType = event.channel_type || '';
  const user = event.user || 'unknown';
  const text = event.text || '';
  const threadTs = event.thread_ts || event.ts;
  const files = event.files || [];

  // Build file attachment descriptions with signed download refs.
  // Each ref is an HMAC-signed, time-limited token that authorises
  // downloading that specific file via the slack_download_file tool.
  let fileSection = '';
  if (files.length > 0) {
    const descriptions = files.map(f => {
      const sizeKB = f.size ? `${Math.round(f.size / 1024)}KB` : 'unknown size';
      const ftype = f.mimetype || 'unknown type';
      const ref = generateFileRef(f.id);
      return `- ${f.name || 'unnamed'} (${sizeKB}, ${ftype}) — ref: ${ref}`;
    });
    fileSection = `\n\nAttachments:\n${descriptions.join('\n')}` +
      `\n\n[To download these files, use the slack_download_file tool with the ref value shown above. ` +
      `Pass the ref exactly as written — do not modify it. ` +
      `For large or binary files, pass save_to_path to write to disk instead of returning inline.]`;
  }

  const replyInstruction = '\n\nIncoming Slack message — just reply with text. Your response is streamed to Slack automatically.';

  // Build a human-readable label: "Peer Hill (<@UMRSP7355U7>)" when we
  // have a profile, bare "<@UMRSP7355U7>" otherwise.
  const userName = userProfile
    ? `${userProfile.first_name} ${userProfile.last_name}`.trim() || userProfile.display_name
    : null;
  const userLabel = userName ? `${userName} (<@${user}>)` : `<@${user}>`;

  let message;
  if (type === 'app_mention') {
    message = `${priorContext}${userLabel} mentioned you in <#${channel}>:\n\n${text}${fileSection}${replyInstruction}`;
  } else if (channelType === 'im') {
    message = `${userLabel} says:\n\n${text}${fileSection}${replyInstruction}`;
  } else {
    message = `${userLabel} in <#${channel}>:\n\n${text}${fileSection}${replyInstruction}`;
  }

  return {
    message,
    name: `Slack:${type}`,
    sessionKey: buildSessionKey(event),
    userId: user,
  };
}

// ---------- Event deduplication ----------
//
// When a user @mentions the bot in a channel, Slack fires both an app_mention
// and a message event with the same client_msg_id. Without deduplication the
// dispatcher forwards both, doubling retries and status messages.

const processedEvents = new Map();
const EVENT_DEDUP_TTL_MS = 60_000;

function isDuplicateEvent(clientMsgId) {
  if (!clientMsgId) return false;
  if (processedEvents.has(clientMsgId)) return true;
  processedEvents.set(clientMsgId, Date.now());
  return false;
}

setInterval(() => {
  const cutoff = Date.now() - EVENT_DEDUP_TTL_MS;
  for (const [id, ts] of processedEvents) {
    if (ts < cutoff) processedEvents.delete(id);
  }
}, EVENT_DEDUP_TTL_MS);

// ---------- Retry state (P1 + P2) ----------
//
// forwardId → AbortController for active retry loops.
// Entries are created when a retry cycle starts and deleted when it ends
// (success, final failure, or cancellation). Max lifetime ≤ sum(RETRY_DELAYS_MS).

const activeRetries = new Map();

function buildRetryBlocks(text, forwardId) {
  return [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      block_id: 'retry_cancel',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: 'Cancel' },
        action_id: 'cancel_retry',
        value: forwardId,
      }],
    },
  ];
}

// ---------- Thread prior-context fetch ----------
//
// When the bot is @mentioned partway through an existing thread, it has no
// session continuity for the messages that came before. We pull the thread
// history via conversations.replies and prepend it to the agent's payload
// so the agent can answer in context.
//
// Only used for app_mention reply-mentions (i.e., the @mention is itself a
// reply, not a thread root). Thread-root mentions have nothing prior.

const PRIOR_CONTEXT_MAX_MESSAGES = 50;
const PRIOR_CONTEXT_MAX_CHARS = 8000;

async function fetchThreadPriorContext(channel, threadTs, beforeTs, log, { fullThread = false } = {}) {
  try {
    const res = await slack.conversations.replies({
      channel,
      ts: threadTs,
      limit: PRIOR_CONTEXT_MAX_MESSAGES,
    });
    if (!res.ok || !Array.isArray(res.messages)) {
      log.info({ channel, threadTs, ok: res.ok, error: res.error }, 'fetchThreadPriorContext: Slack API returned not-ok');
      return '';
    }

    let prior = res.messages.filter((m) => m.ts && m.ts < beforeTs);
    if (prior.length === 0) return '';

    if (!fullThread) {
      let lastBotIdx = -1;
      for (let i = prior.length - 1; i >= 0; i--) {
        if (prior[i].bot_id) { lastBotIdx = i; break; }
      }
      if (lastBotIdx >= 0) prior = prior.slice(lastBotIdx + 1);
      if (prior.length === 0) return '';
    }

    const lines = [];
    for (const m of prior) {
      const txt = (m.text || '').trim();
      if (!txt) continue;
      let who;
      if (m.bot_id) {
        who = 'Archie';
      } else if (m.user) {
        const profile = await resolveUserProfile(m.user);
        const name = profile
          ? `${profile.first_name} ${profile.last_name}`.trim() || profile.display_name
          : null;
        who = name ? `${name} (<@${m.user}>)` : `<@${m.user}>`;
      } else {
        who = 'unknown';
      }
      lines.push(`${who}: ${txt}`);
    }
    if (lines.length === 0) return '';

    let block = lines.join('\n');
    if (block.length > PRIOR_CONTEXT_MAX_CHARS) {
      block = '…(truncated)…\n' + block.slice(-PRIOR_CONTEXT_MAX_CHARS);
    }
    return `Prior thread context (oldest → newest):\n${block}\n\n---\n\n`;
  } catch (err) {
    log.warn({ err: err.message, channel, threadTs }, 'fetchThreadPriorContext failed');
    return '';
  }
}

// ---------- Streaming ----------
//
// All streaming state (sessions, runs, Slack stream API calls) lives in
// StreamingManager. Instantiated after the `slack` proxy is defined below.

// AgentCore path: ensure the agent's runtime exists (create on first hit, ~30s cold), then
// InvokeAgentRuntime with an SSE response and bridge delta/tool/final events into the SAME
// StreamingManager the ECS gateway uses — so Slack rendering and run bookkeeping
// are identical. Always streams. Mirrors the WS setEventHandler bridge below.
// `opts.onFirstEvent` fires ONCE, on the first SSE event of the invoke. That event is EVIDENCE the
// runtime holds the message and is working, which is the durable queue's commit point: the consumer
// deletes the message there and lets the turn run unwatched. Deleting on "invoke issued" instead
// would be optimistic — a crash between the delete and the call landing loses the message silently.
// Child spans across the DISPATCHER LEG — everything between dispatcher.request starting and the
// runtime's agent_i073q7.
//
// WHY. With provisioning off the warm path, that leg became the dominant term in TTFM and it was one
// opaque block. Measured 2026-08-13 over 38 warm turns: the dispatcher leg was p50 3,564ms / p99
// 21,665ms while the runtime leg held steady at p50 2,674ms / p99 3,587ms — so the entire p99 breach of
// the <10s SLO lived in here, and the only honest thing that could be said was where it ISN'T (not the
// concurrency bounds, all of which reported zero waiting; not per-session serialisation, depth 1 and
// wait <=1ms; not Slack rate limiting, no 429s). Attribution needs the leg broken up.
//
// Each phase is one await on the critical path to the first model call, so this is a complete partition
// of the leg rather than a sample. Errors are recorded on the child AND rethrown — the existing
// handlers still own the user-visible outcome.
const dispatcherPhase = (name, fn, attributes) => tracer.startActiveSpan(
  name, { attributes: attributes || {} },
  async (s) => {
    try {
      return await fn();
    } catch (err) {
      s.recordException(err);
      s.setStatus({ code: SpanStatusCode.ERROR, message: err?.message || String(err) });
      throw err;
    } finally {
      s.end();
    }
  },
);

async function forwardToAgentCore(agent, event, child, opts = {}) {
  // M2: dispatcher.request is the SERVER root span for a Slack-triggered turn — the provision
  // saga, invoke leg, and SDK auto-spans all nest under it via the active-context manager.
  // Attributes are PHI-free identifiers only (never message text).
  // Pool occupancy AT THE MOMENT THIS TURN STARTED. Stamped on the span, not just emitted as a
  // metric, because the metric alone cannot answer "was THIS slow turn slow because the pool was
  // full?" — that needs the two facts in one trace. With it, the TTFM `dispatch` phase can be
  // attributed to starvation (pool full) versus the dispatcher's own work (pool idle), which is
  // exactly the ambiguity that hid the 5-poller bottleneck for days. Zero-cost, PHI-free integers.
  const pool = turnQueue.pollerStats ? turnQueue.pollerStats() : null;
  // Phase 1 split the one pool into three bounds, so "the pool was full" is no longer a single fact —
  // a turn can be slow because in-flight turns, provisions, or invokes were at their cap, and each has
  // a different fix. Stamping all three means the TTFM `dispatch` phase can be attributed to the
  // SPECIFIC bound that was saturated instead of to "starvation" in general. PHI-free integers.
  const bounds = agentCore.concurrencyStats ? agentCore.concurrencyStats() : null;
  // QUEUE WAIT + CROSS-QUEUE JOIN. A queued turn's clock does not start here — it started when the
  // Slack event was enqueued, and the gap is time the user is already waiting. Two facts, both new:
  //   - `dispatcher.queue_wait_ms` makes the gap MEASURABLE from the span alone.
  //   - continuing the producer's trace makes it VISIBLE: before this, the `…turns.fifo send` span
  //     and the turn it produced were two separate single-span traces (149 of 149 sends in the
  //     2026-08-13 window had no request in the same trace), so no trace could show the wait at all.
  // Both degrade to nothing when the message predates this change or was never traced.
  const qm = opts.queueMeta || null;
  const queueWaitMs = qm?.sentTimestampMs ? Math.max(0, Date.now() - qm.sentTimestampMs) : null;
  const parentCtx = qm?.traceparent
    ? propagation.extract(otelContext.active(), { traceparent: qm.traceparent, ...(qm.tracestate ? { tracestate: qm.tracestate } : {}) })
    : otelContext.active();
  return tracer.startActiveSpan('dispatcher.request', {
    kind: SpanKind.SERVER,
    attributes: {
      'dispatcher.trigger': event.type || 'user',
      'dispatcher.agent': agent,
      'dispatcher.channel': event.channel,
      ...(queueWaitMs != null ? { 'dispatcher.queue_wait_ms': queueWaitMs } : {}),
      ...(qm?.receiveCount != null ? { 'dispatcher.queue_receive_count': qm.receiveCount } : {}),
      ...(pool ? {
        'dispatcher.pollers_busy': pool.busy,
        'dispatcher.pollers_total': pool.total,
        'dispatcher.pollers_waiting': pool.waiting,
      } : {}),
      ...(bounds ? {
        'dispatcher.provisions_busy': bounds.provision.held,
        'dispatcher.provisions_waiting': bounds.provision.waiting,
        'dispatcher.invokes_busy': bounds.invoke.held,
        'dispatcher.invokes_waiting': bounds.invoke.waiting,
      } : {}),
    },
  }, parentCtx, async (span) => {
    try {
      const channel = event.channel;
      const threadTs = event.thread_ts || event.ts;
      const isDM = event.channel_type === 'im';
      // Slack users.info, cached — but a cache MISS is a network round trip on the critical path.
      const userProfile = event.user
        ? await dispatcherPhase('dispatcher.user_profile', () => resolveUserProfile(event.user))
        : null;

      let priorContext = '';
      if (event.type === 'app_mention' && event.thread_ts && event.thread_ts !== event.ts) {
        // conversations.replies over the whole thread. Unbounded in thread length, so this is the phase
        // most likely to explain a slow turn in a long-running thread specifically.
        priorContext = await dispatcherPhase(
          'dispatcher.prior_context',
          () => fetchThreadPriorContext(event.channel, event.thread_ts, event.ts, child),
          { 'dispatcher.channel': event.channel },
        );
      }
      const payload = buildAgentPayload(event, userProfile, { priorContext });
      span.setAttribute('dispatcher.session_key', payload.sessionKey);
      const sessionId = agentcoreSessionId(payload.sessionKey);
      // Recorded on the ROOT span, not the invoke span: the question this answers is "why was THIS turn
      // slow", and the join that answers it is against TTFM, which is measured from the root.
      const sessionInfo = sessionTracker.touch(sessionId);
      span.setAttributes(sessionTracker.attributesFor(sessionInfo));
      agentCore.metrics.emitSessionUse(agent, sessionInfo);

      // PER-MESSAGE ISOLATION, whole-turn. Everything a user SEES — the Slack stream placeholder and
      // the thinking status — is set up when this message's turn BEGINS, not when it
      // arrives. Having only the invoke inside the slot is what produced the live mess: 11 messages
      // each called startStream on arrival, so Slack got 10 placeholder bubbles up front, and the
      // FIRST failure latched session.stream.stopped (startStream, which clears it, had already run
      // for all of them) so every later reply silently degraded to chat.postMessage and left its
      // placeholder empty forever. The slot must own the render lifecycle, not just the network call.
      // SLOT WAIT. Deliberately startSpan, not startActiveSpan: the thing being measured is the
      // ACQUISITION, which completes outside the callback, so the span has to be ended from inside it.
      // Its duration is therefore purely time queued behind other turns on this same thread — the one
      // component of this leg that is other turns' fault rather than this turn's own work, which is
      // exactly the distinction the opaque block could not make.
      const slotSpan = tracer.startSpan('dispatcher.session_slot', {
        attributes: { 'dispatcher.session_id': sessionId },
      });
      let slotSpanEnded = false;
      const endSlotSpan = (outcome) => {
        if (slotSpanEnded) return;
        slotSpanEnded = true;
        slotSpan.setAttribute('dispatcher.slot_outcome', outcome);
        slotSpan.end();
      };

      await agentCore.runExclusiveForSession(sessionId, async () => {
        endSlotSpan('acquired');
        const traceId = streaming.registerSession(payload.sessionKey, { channel, threadTs, userId: event.user || null, isDM });
        child = child.child({ traceId, runtime: 'agentcore' });

        // Posts the Slack placeholder message — a Slack write on the critical path to the first model
        // call, and the reason a turn can be slow before it has done anything of its own.
        const session = await dispatcherPhase('dispatcher.stream_start', async () => {
          const s = streaming.findSession(payload.sessionKey)?.session || null;
          if (s) streaming.startStream(s);
          return s;
        });

        // One run per invoke. runId carries the per-user sender ("u:<userId>:<uuid>") so the mcp-auth
        // plugin resolves per-user identity — same encoding as the ECS gateway idempotency key.
        const runId = event.user ? `u:${event.user}:${crypto.randomUUID()}` : crypto.randomUUID();

        let runtimeArn;
        try {
          // Resolve the desired image INSIDE the slot, per turn. This is the whole point of the DDB
          // pointer: publishing a build is picked up by the next message to enter a slot, with no
          // dispatcher deploy and no restart. Because the image is part of the runtime NAME, a change
          // simply misses the arn cache and provisions the new generation alongside the old one —
          // there is no delete-then-wait, so the roll costs a cold boot on ONE message rather than a
          // ~5 minute outage while AgentCore holds the deleted name.
          // WARM this is one DynamoDB GetItem against the runtime registry; COLD the whole provision
          // saga nests underneath (dispatcher.provision -> mount_targets / access_point /
          // runtime_ready), so one span name separates "looked it up" from "built it" without the
          // caller having to know which happened.
          runtimeArn = await dispatcherPhase(
            'dispatcher.ensure_runtime',
            () => ensureCurrentRuntime(agent, { logger: child }),
            { 'dispatcher.agent': agent },
          );
        } catch (err) {
          child.error({ err: err.message, agent }, 'agentcore ensureRuntime failed');
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `ensureRuntime: ${err.message}` });
          if (session) { streaming.stopStream(session, null); await streaming.drain(session); }
          await slack.chat.postMessage({ channel, thread_ts: threadTs, text: `Sorry — couldn't start the agent. Please try again shortly.` }).catch(() => {});
          return;
        }

        // A turn that ERRORS with nothing to say used to be reported by flipping the user's message to
        // ❌ — the only visible sign it had failed. With reactions gone the failure has to be SAID, or
        // we are back to the silent drop that lost 15 of 16 messages in one live burst. `error` +
        // empty `final` does NOT throw out of invokeStreaming (it returns `final.error`), so the catch
        // below never sees it and this is the only place that can speak. Same wording as that catch.
        const notifyFailure = () => {
          slack.chat.postMessage({ channel, thread_ts: threadTs, text: 'Sorry — the agent hit an error. Please try again.' })
            .catch((err) => child.warn({ err: err.message }, 'turn-failure notice post failed'));
        };
        const bridge = agentCore.makeStreamBridge({ streaming, session, runId, channel, threadTs, notifyFailure, logger: child });
        // Fire the commit hook before rendering, and never let a failing hook break the turn: the
        // message being deleted twice is harmless, a turn dying because a delete failed is not.
        let sawFirstEvent = false;
        const onChunk = (ev) => {
          if (!sawFirstEvent) {
            sawFirstEvent = true;
            try { opts.onFirstEvent?.(); } catch (e) { child.warn({ err: e.message }, 'onFirstEvent hook failed'); }
          }
          return bridge(ev);
        };

        try {
          const body = { input: { prompt: payload.message, runId, sender: event.user || null, trigger: event.type || 'user', sessionKey: payload.sessionKey } };
          // M1 D6: pass agent + trigger so invokeStreaming emits ClawdbotDispatcher InvokeLatencyMs /
          // InvokeColdRetries / InvokeErrorCount (all invoke emit lives inside the client — one helper).
          // Reentrant: we already hold this session's slot, so this does NOT queue again.
          const final = await agentCore.invokeStreaming(runtimeArn, sessionId, body, onChunk, { logger: child, agent, trigger: event.type || 'user' });
          // Safety net: stream ended with no terminal `final` (shouldn't happen) — close cleanly.
          if (!final && session && !session.stream?.stopped) {
            streaming.stopStream(session, null);
          }
          child.info({ sessionKey: payload.sessionKey }, 'agentcore invoke complete');
        } catch (err) {
          child.error({ err: err.message, agent }, 'agentcore invoke failed');
          span.recordException(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: `invoke: ${err.message}` });
          if (session) streaming.stopStream(session, null);
          await slack.chat.postMessage({ channel, thread_ts: threadTs, text: `Sorry — the agent hit an error. Please try again.` }).catch(() => {});
        } finally {
          // The slot must not be released while Slack writes are still queued. stopStream and the
          // delta appends schedule onto session.stream.chain and return WITHOUT awaiting (they run
          // from a synchronous SSE callback), so without this the next turn's startStream resets
          // s.ts and the previous turn's stop writes its tail into the next turn's bubble. See
          // StreamingManager#drain — this is the turn boundary that makes serialisation visible.
          if (session) await streaming.drain(session);
        }
      }, { agent, logger: child }).catch(async (err) => {
        // Backpressure, not an agent failure — and it must not read like one. Nothing was rendered for
        // this message (the slot was never entered), so there is no stream to stop. The throttled
        // notice below is now the ONLY signal: there is no per-message ⛔ any more, so it can no longer
        // point at WHICH messages were skipped — it says how many, once per thread per minute.
        // The callback never ran, so nothing ended the slot span from the inside. An unended span is
        // never exported, so the rejected turn would silently lose the very measurement that explains
        // why it was rejected.
        endSlotSpan('rejected');
        if (err?.name !== 'SessionQueueFull') throw err;
        child.warn({ err: err.message, agent }, 'agentcore turn rejected: session queue full');
        span.setStatus({ code: SpanStatusCode.ERROR, message: 'session queue full' });
        if (shouldAnnounceBackpressure(channel, threadTs)) {
          await slack.chat.postMessage({
            channel,
            thread_ts: threadTs,
            text: 'Too many messages queued in this thread at once — I couldn\'t hold all of them. Anything I didn\'t answer, send again once I\'ve caught up.',
          }).catch(() => {});
        }
      });
    } finally {
      span.end();
    }
  });
}

// Every agent is served by AgentCore.
//
// THE DURABILITY SEAM. With a turn queue configured this ENQUEUES and returns; the consumer runs the
// turn. Without one it runs the turn inline, exactly as before. Every caller (message, app_mention,
// /simulate) goes through here, so durability is one decision rather than three.
//
// Why enqueue at all: Bolt acknowledges a Slack event BEFORE our listener runs, so by the time we get
// here Slack already believes the message is delivered and will never resend it. Everything from this
// point — a p50 35s turn, plus anything queued behind it — is ours to lose on a restart. Handing the
// event to SQS makes the queue the system of record from the moment it lands.
async function forwardToAgent(agent, event, child) {
  if (!turnQueue.enabled) return forwardToAgentCore(agent, event, child);

  const sessionId = agentcoreSessionId(buildSessionKey(event));
  try {
    await turnQueue.enqueueTurn({ event, agent, sessionId });
  } catch (err) {
    // Slack has ALREADY been acked, so nothing retries this and no redelivery is coming. A swallowed
    // failure here is a message that vanishes without trace — the precise thing the queue exists to
    // prevent — so it is surfaced to the user the same way an invoke failure is.
    const channel = event.channel;
    const threadTs = event.thread_ts || event.ts;
    child.error({ err: err.message, agent, sessionId }, 'turn enqueue FAILED — message not durable and not running');
    agentCore.metrics.emitTurnEnqueueFailed(agent, { sessionId, errName: err.name });
    await slack.chat.postMessage({
      channel, thread_ts: threadTs,
      text: 'Sorry — I couldn\'t accept that message. Please send it again.',
    }).catch(() => {});
    throw err;
  }
}

// ---------- Inbound: Slack → agents ----------

let bolt = null;
let socketConnected = false;
let socketLastDisconnectedAt = null;
let lastSlackEventAt = null;

if (!NO_SOCKET_MODE) {
  bolt = new App({
    token: SLACK_BOT_TOKEN,
    appToken: SLACK_APP_TOKEN,
    socketMode: true,
  });

  // Fix 1: track Socket Mode connection state for /health.
  // Bolt's SocketModeReceiver emits these on its internal client.
  const socketClient = bolt.receiver && bolt.receiver.client;
  if (socketClient && typeof socketClient.on === 'function') {
    socketClient.on('connected', () => {
      socketConnected = true;
      socketLastDisconnectedAt = null;
      lastSlackEventAt = Date.now();
      log.info('socket mode connected');
    });
    socketClient.on('disconnected', () => {
      socketConnected = false;
      socketLastDisconnectedAt = Date.now();
      log.warn('socket mode disconnected');
    });
    socketClient.on('reconnecting', () => {
      socketConnected = false;
      if (!socketLastDisconnectedAt) socketLastDisconnectedAt = Date.now();
      log.warn('socket mode reconnecting');
    });
  } else {
    log.warn('could not hook socket mode events; /health will fall back to process liveness');
  }

  bolt.event('message', async ({ event }) => {
    lastSlackEventAt = Date.now();
    if (event.bot_id || (event.subtype && event.subtype !== 'file_share') || !event.user) {
      log.info({ bot_id: event.bot_id, subtype: event.subtype, user: event.user, channel: event.channel }, 'message dropped (pre-filter)');
      return;
    }
    if (shuttingDown) {
      log.info({ channel: event.channel, user: event.user }, 'message arrived during shutdown — adding warning reaction');
      slack.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'warning' }).catch(() => {});
      return;
    }

    // require_mention pre-filter: in channels with require_mention, only forward:
    //   1. Top-level @mentions (handled by app_mention handler — we drop here)
    //   2. Thread replies in threads where the bot was @mentioned, tracked
    //      via the in-memory mentionedThreads map populated by app_mention.
    //
    // Tradeoff: mentionedThreads is in-memory only, so a dispatcher restart
    // drops replies in pre-restart mention-rooted threads until someone
    // re-@mentions the bot. Accepted to keep the filter simple.
    //
    // This MUST run BEFORE isDuplicateEvent: Slack fires both a `message`
    // and an `app_mention` event for @mentions with the same client_msg_id.
    // If we mark it processed here and then drop it, the app_mention
    // handler's dedup check would also skip it — silently losing the @mention.
    const isThreadReply = event.thread_ts && event.thread_ts !== event.ts;
    if (event.channel_type !== 'im' && routes.requireMention.has(event.channel)) {
      if (!isThreadReply) {
        log.info({ channel: event.channel, user: event.user, ts: event.ts }, 'message skipped: channel requires mention (deferring to app_mention)');
        return;
      }
      if (!isInMentionedThread(event.channel, event)) {
        log.info({ channel: event.channel, user: event.user, thread_ts: event.thread_ts, ts: event.ts }, 'thread reply skipped: thread has no tracked bot @mention');
        return;
      }
    }

    if (isDuplicateEvent(event.client_msg_id)) {
      log.debug({ channel: event.channel, user: event.user, client_msg_id: event.client_msg_id }, 'message deduped (already processed)');
      return;
    }
    const child = log.child({
      event_type: 'message',
      event_id: event.client_msg_id,
      user: event.user,
      channel: event.channel,
      channel_type: event.channel_type,
    });
    const agent = resolveAgent(event);
    if (!agent) {
      child.warn('no route matched; dropping');
      return;
    }

    // Message volume, counted TWICE on purpose and in ONE place: the DDB counter carries the
    // user×agent×day detail, the EMF metric makes per-agent/fleet volume visible on the CloudWatch
    // dashboard (the DDB table's only reader is the ALB-fronted archie service). Emitting them
    // side by side is what stops the two from drifting into different definitions of "a message".
    recordMessage(event.user, agent, child);
    dispatcherMetrics.emitMessageReceived(agent, { userId: event.user, channel: event.channel, eventType: 'message' });

    const threadTs = event.thread_ts || event.ts;

    // Track conversation metadata for App Home Conversations tab (DMs only)
    if (event.channel_type === 'im') {
      const isNewConversation = !event.thread_ts || event.thread_ts === event.ts;
      if (isNewConversation) {
        conversations.recordConversation(agent, threadTs, {
          channel: event.channel,
          userId: event.user,
          text: event.text,
        }, bedrockRuntimeClient);
        // Push updated App Home so the Conversations tab reflects the new entry
        if (userActiveTab.get(event.user) === 'conversations' || !userActiveTab.has(event.user)) {
          const view = marketplace.buildHomeView(agent, 'conversations', { teamId: slackTeamId });
          slack.views.publish({ user_id: event.user, view })
            .catch(err => child.warn({ err: err.message }, 'failed to refresh app home after new conversation'));
        }
      } else {
        conversations.updateActivity(agent, threadTs, {
          channel: event.channel,
          userId: event.user,
          text: event.text,
        }, bedrockRuntimeClient);
      }
    }

    // Forward to agent — stream rendering and retry feedback are managed inside forwardToAgent.
    await track(forwardToAgent(agent, event, child.child({ agent })));
  });
} // end if (!NO_SOCKET_MODE)

// app_mention handler — also guarded by socket mode
if (bolt) bolt.event('app_mention', async ({ event }) => {
  lastSlackEventAt = Date.now();
  if (shuttingDown) {
    log.info({ channel: event.channel, user: event.user }, 'app_mention arrived during shutdown — adding warning reaction');
    slack.reactions.add({ channel: event.channel, timestamp: event.ts, name: 'warning' }).catch(() => {});
    return;
  }
  if (isDuplicateEvent(event.client_msg_id)) return;
  const child = log.child({
    event_type: 'app_mention',
    event_id: event.client_msg_id,
    user: event.user,
    channel: event.channel,
  });
  const agent = resolveAgent(event);
  if (!agent) {
    child.warn('no route matched; dropping');
    return;
  }

  recordMessage(event.user, agent, child);
  dispatcherMetrics.emitMessageReceived(agent, { userId: event.user, channel: event.channel, eventType: 'app_mention' });

  const threadTs = event.thread_ts || event.ts;

  // Only track threads that were *started* with an @mention. If the user
  // @mentions the bot inside an existing third-party thread, we don't
  // implicitly opt the whole thread in — they have to keep @mentioning.
  // A top-level @mention has no thread_ts (or thread_ts === ts).
  const isThreadRootMention = !event.thread_ts || event.thread_ts === event.ts;
  if (isThreadRootMention) {
    trackMentionThread(event.channel, threadTs);
  }

  // Forward to agent — stream rendering and retry feedback are managed inside forwardToAgent.
  await track(forwardToAgent(agent, event, child.child({ agent })));
});

if (bolt) {
  // P2: Cancel button handler — aborts the retry loop for a pending forward.
  bolt.action('cancel_retry', async ({ action, ack }) => {
    await ack();
    const forwardId = action.value;
    const controller = activeRetries.get(forwardId);
    if (controller) {
      controller.abort();
      log.info({ forwardId }, 'retry cancelled via Slack button');
    } else {
      log.debug({ forwardId }, 'cancel_retry: no active retry found (already finished?)');
    }
  });
}

// ---------- Skills Marketplace: App Home + actions ----------

// Track which tab each user is viewing (default: skills)
const userActiveTab = new Map();

if (bolt) bolt.event('app_home_opened', async ({ event, client }) => {
  const userId = event.user;
  const agentId = homeAgentFor(userId, 'app_home');
  const activeTab = userActiveTab.get(userId) || 'conversations';
  const child = log.child({ event_type: 'app_home_opened', user: userId, agent: agentId });
  try {
    const opts = { teamId: slackTeamId };
    if (activeTab === 'jobs' && agentId) {
      opts.jobs = await fetchAgentCronJobs(agentId);
      opts.cronRunner = await fetchCronRunner(agentId);
    }
    if (activeTab === 'tools' && agentId) {
      opts.tools = await fetchToolPermissions(agentId);
    }
    const view = marketplace.buildHomeView(agentId, activeTab, opts);
    await client.views.publish({ user_id: userId, view });
    child.info('app home published');
  } catch (err) {
    child.error({ err: err.message }, 'failed to publish app home');
  }
});

if (bolt) bolt.action('marketplace_detail', async ({ ack, body, client }) => {
  await ack();
  const skillId = body.actions[0].value;
  const modal = marketplace.buildDetailModal(skillId);
  if (!modal) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  } catch (err) {
    log.error({ err: err.message, skill: skillId }, 'failed to open detail modal');
  }
});

// Tab switching
if (bolt) bolt.action('marketplace_tab_skills', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  userActiveTab.set(userId, 'skills');
  try {
    const view = marketplace.buildHomeView(agentId, 'skills', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to switch to skills tab');
  }
});

if (bolt) bolt.action('marketplace_tab_connectors', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  userActiveTab.set(userId, 'connectors');
  // Refresh Connector cache if needed
  if (CONNECTOR_API_KEY) {
    await marketplace.fetchConnectorToolkits(CONNECTOR_API_KEY, { log });
  }
  try {
    const view = marketplace.buildHomeView(agentId, 'connectors', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to switch to connectors tab');
  }
});

// Model tab
if (bolt) bolt.action('marketplace_tab_models', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  userActiveTab.set(userId, 'models');
  // Refresh Bedrock cache if needed
  await marketplace.fetchBedrockModels(bedrockClient, { log });
  try {
    const view = marketplace.buildHomeView(agentId, 'models', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to switch to models tab');
  }
});

// Conversations tab
if (bolt) bolt.action('marketplace_tab_conversations', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  userActiveTab.set(userId, 'conversations');
  try {
    const view = marketplace.buildHomeView(agentId, 'conversations', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to switch to conversations tab');
  }
});

// Conversations pager — rebuilds the home view at the requested page.
// Slack caps views at 100 blocks, so the tab uses fixed-size pages; the
// requested page is clamped in buildConversationsTab, which also makes
// stale grow-style "Show More" buttons (legacy action below) land on the
// last page instead of failing.
const handleConversationsPage = async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const page = Math.max(0, parseInt(body.actions[0].value, 10) || 0);
  if (!agentId) return;
  try {
    const view = marketplace.buildHomeView(agentId, 'conversations', { teamId: slackTeamId, page });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to page conversations');
  }
};
if (bolt) bolt.action('conversations_page_prev', handleConversationsPage);
if (bolt) bolt.action('conversations_page_next', handleConversationsPage);
if (bolt) bolt.action('conversations_load_more', handleConversationsPage); // legacy buttons in already-rendered views

// No-op handler for the "Open" thread link button (Slack requires a handler for action_id)
if (bolt) bolt.action('conversations_open_thread', async ({ ack }) => { await ack(); });

// Pin / unpin a conversation and refresh the home view
if (bolt) bolt.action('conversations_toggle_pin', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const threadTs = body.actions[0].value;
  if (!agentId || !threadTs) return;
  conversations.togglePin(agentId, threadTs);
  try {
    const view = marketplace.buildHomeView(agentId, 'conversations', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to toggle pin on conversation');
  }
});

// Reorder a conversation (pinned or recent) and refresh the home view
const handleConversationsMove = (direction) => async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const threadTs = body.actions[0].value;
  if (!agentId || !threadTs) return;
  conversations.moveConversation(agentId, threadTs, direction);
  try {
    const view = marketplace.buildHomeView(agentId, 'conversations', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message, direction }, 'failed to reorder conversation');
  }
};
if (bolt) bolt.action('conversations_move_up', handleConversationsMove('up'));
if (bolt) bolt.action('conversations_move_down', handleConversationsMove('down'));

// Reset the recent list back to pure recency ordering
if (bolt) bolt.action('conversations_reset_order', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  conversations.resetRecentOrder(agentId);
  try {
    const view = marketplace.buildHomeView(agentId, 'conversations', { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to reset conversation order');
  }
});

// Conversation search modal
if (bolt) bolt.action('conversations_search_open', async ({ ack, body, client }) => {
  await ack();
  try {
    const modal = conversations.buildConversationSearchModal();
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  } catch (err) {
    log.error({ err: err.message }, 'failed to open conversation search modal');
  }
});

// Conversation search submit — replaces the modal with the results in-place
if (bolt) bolt.view('conversations_search_submit', async ({ ack, body, view }) => {
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const query = (view.state.values.search_block.search_query.value || '').trim();
  if (!query || !agentId) {
    await ack();
    return;
  }
  const resultsModal = conversations.buildConversationSearchResultsModal(query, agentId, slackTeamId);
  await ack({ response_action: 'update', view: resultsModal });
});

// Jobs tab
if (bolt) bolt.action('marketplace_tab_jobs', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  userActiveTab.set(userId, 'jobs');
  let jobs = null;
  let cronRunner = null;
  if (agentId) {
    jobs = await fetchAgentCronJobs(agentId);
    cronRunner = await fetchCronRunner(agentId);
  }
  try {
    const view = marketplace.buildHomeView(agentId, 'jobs', { teamId: slackTeamId, jobs, cronRunner });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to switch to jobs tab');
  }
});

// Which scheduler owns this scope's jobs (§3a'). Async because it reads DynamoDB — deliberately
// uncached (cron-runner-flag.js:75-84), so this IS a round trip per render.
function fetchCronRunner(agentName) {
  return cronHome ? cronHome.getRunner(agentName) : Promise.resolve(null);
}

// ---------- Tools & permissions tab ----------

// This agent's capability picture: the stored grant, plus the per-agent capabilities only its own
// config knows about (each connector.extraMcpServers[].toolPrefix IS a capability, so a `demo_query_app` agent
// has one no static catalogue can list).
//
// Returns null on ANY failure, which the builder renders as "could not read this agent's
// permissions". That distinction is the whole point: an empty capability list and an unreadable one
// look identical in the data and mean opposite things, and claiming an agent has no access when we
// simply could not read it is the one wrong answer a permissions screen must not give.
async function fetchToolPermissions(agentId) {
  if (!AGENT_CONFIG_TABLE || !agentId) return null;
  try {
    const doc = configDoc();
    const [{ grant }, extraCaps, pinned] = await Promise.all([
      grants.readGrant(doc, AGENT_CONFIG_TABLE, agentId),
      grants.extraCapsForAgent(doc, AGENT_CONFIG_TABLE, agentId, { log }),
      // R1: the capabilities the Cedar policy owns. Passed so the tab can render them as
      // policy-managed rather than as approvable — a working Approve button for one of these promises
      // access no approval can give.
      grants.loadPinnedCaps(doc, AGENT_CONFIG_TABLE),
    ]);
    return { ...(await grants.describeCapabilities(grant, extraCaps, pinned)), extraCaps };
  } catch (err) {
    log.error({ err: err.message, agent: agentId }, 'could not read tool permissions');
    return null;
  }
}

if (bolt) bolt.action('marketplace_tab_tools', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  userActiveTab.set(userId, 'tools');
  const tools = await fetchToolPermissions(agentId);
  try {
    const view = marketplace.buildHomeView(agentId, 'tools', { teamId: slackTeamId, tools });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    log.error({ err: err.message }, 'failed to switch to tools tab');
  }
});

async function refreshToolsTab(userId, client) {
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  const tools = await fetchToolPermissions(agentId);
  const view = marketplace.buildHomeView(agentId, 'tools', { teamId: slackTeamId, tools });
  await client.views.publish({ user_id: userId, view });
}

// Approve / revoke a capability for the VIEWER'S OWN agent.
//
// homeAgentFor is the whole authorisation model here: it derives the scope from the Slack user id, so
// there is no way to address anyone else's agent — which matters because IAM cannot express that
// bound (dynamodb:LeadingKeys takes literal keys, and the scope is per-request). The capability
// itself is untrusted input — Slack echoes the button value back — so grants.js validates it against
// the catalogue rather than writing whatever arrives.
//
// The re-render is what confirms it: provenance appears on the row ("approved by @you"), the button
// flips, and the tool moves from Available to Granted. No reaction, no separate confirmation message.
async function handleGrantChange(kind, { ack, body, client }) {
  await ack();
  const userId = body.user.id;
  const capability = body.actions[0].value;
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  const child = log.child({ action: `tools_${kind}`, user: userId, agent: agentId, capability });
  if (!AGENT_CONFIG_TABLE) { child.error('no AGENT_CONFIG_TABLE — cannot change grants'); return; }
  try {
    const fn = kind === 'approve' ? grants.grantCapability : grants.revokeCapability;
    const extraCaps = await grants.extraCapsForAgent(configDoc(), AGENT_CONFIG_TABLE, agentId, { log });
    const r = await fn(configDoc(), AGENT_CONFIG_TABLE, agentId, capability, userId, { extraCaps, log: child });
    child.info({ caps: r.caps, role: r.role }, `capability ${kind}d`);
    await refreshToolsTab(userId, client);
    // Say it in words when the outcome is not what the click implied: a revoke that leaves the
    // capability in force because a skill or the base config still grants it. The re-rendered row
    // shows the provenance, but it still reads as "granted" and the person just pressed Revoke.
    if (kind === 'revoke' && r.stillGranted) {
      await client.chat.postMessage({
        channel: userId,
        text: `Withdrew your approval of \`${capability}\`, but *${agentId}* still has it — it is also granted by ${r.heldBy.map((s) => `\`${s}\``).join(', ')}. Remove that source to take the capability away.`,
      });
    }
  } catch (err) {
    child.error({ err: err.message }, `capability ${kind} failed`);
    await client.chat.postMessage({
      channel: userId,
      text: `:x: Could not ${kind} \`${capability}\` for *${agentId}*: ${err.message}`,
    });
  }
}

if (bolt) bolt.action('tools_approve', (args) => handleGrantChange('approve', args));
if (bolt) bolt.action('tools_revoke', (args) => handleGrantChange('revoke', args));

// Helper to refresh the Jobs tab for a user
async function refreshJobsTab(userId, client) {
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  const jobs = await fetchAgentCronJobs(agentId);
  const cronRunner = await fetchCronRunner(agentId);
  const view = marketplace.buildHomeView(agentId, 'jobs', { teamId: slackTeamId, jobs, cronRunner });
  await client.views.publish({ user_id: userId, view });
}

// Jobs: Detail modal
if (bolt) bolt.action('jobs_detail', async ({ ack, body, client }) => {
  await ack();
  const jobId = body.actions[0].value;
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  // Straight from the service — this read the (never-populated) cronCache until 2026-08-11, so the
  // detail modal never opened under AgentCore either.
  const job = cronHome && cronHome.get(agentId, jobId);
  if (!job) return;
  const modal = marketplace.buildJobDetailModal(job);
  if (!modal) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  } catch (err) {
    log.error({ err: err.message, jobId }, 'failed to open job detail modal');
  }
});

// Jobs: Run Now
if (bolt) bolt.action('jobs_run', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const jobId = body.actions[0].value;
  if (!agentId) return;
  try {
    await cronAction(agentId, 'run', { id: jobId });
    await refreshJobsTab(userId, client);
  } catch (err) {
    log.error({ err: err.message, jobId }, 'jobs_run failed');
  }
});

// Jobs: Toggle (pause/resume)
if (bolt) bolt.action('jobs_toggle', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  let jobId, enabled;
  try {
    const parsed = JSON.parse(body.actions[0].value);
    jobId = parsed.id;
    enabled = parsed.enabled;
  } catch { return; }
  if (!agentId) return;
  try {
    await cronAction(agentId, 'toggle', { id: jobId, enabled });
    await refreshJobsTab(userId, client);
  } catch (err) {
    log.error({ err: err.message, jobId }, 'jobs_toggle failed');
  }
});

// Jobs: move this scope's schedule between the two stacks (§3a').
//
// The button carries the TARGET runner, so a double-click asks for the same move twice rather than
// flipping it back and forth — the same defence the per-job Pause/Resume uses. The value is
// validated in cron-runner-flag.set (Slack echoes back whatever we rendered, so it is input).
//
// Takes effect on the NEXT tick of each of the agent's jobs: the gate is read per fire, and the
// write drops the flag's cache entry, so there is no restart and no re-arm.
if (bolt) bolt.action('jobs_runner_set', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  const runner = body.actions[0].value;
  try {
    await cronHome.setRunner(agentId, runner, userId);
    log.info({ agent: agentId, runner, user: userId }, 'app home: CRON_RUNNER changed');
    await refreshJobsTab(userId, client);
  } catch (err) {
    log.error({ err: err.message, agent: agentId, runner }, 'jobs_runner_set failed');
  }
});

// Jobs: Delete — opens confirmation modal
if (bolt) bolt.action('jobs_delete', async ({ ack, body, client }) => {
  await ack();
  const jobId = body.actions[0].value;
  // Find job name from the current cached data
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  let jobName = jobId;
  if (agentId) {
    const job = cronHome && cronHome.get(agentId, jobId);
    if (job) jobName = job.name || jobId;
  }
  const modal = marketplace.buildJobDeleteConfirmModal(jobId, jobName);
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  } catch (err) {
    log.error({ err: err.message, jobId }, 'failed to open job delete confirm modal');
  }
});

// Jobs: Delete confirmed (modal submission)
if (bolt) bolt.view('jobs_delete_confirm', async ({ ack, body, client, view }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  if (!agentId) return;
  let jobId;
  try {
    const meta = JSON.parse(view.private_metadata);
    jobId = meta.jobId;
  } catch { return; }
  try {
    await cronAction(agentId, 'remove', { id: jobId });
    await refreshJobsTab(userId, client);
  } catch (err) {
    log.error({ err: err.message, jobId }, 'jobs_delete_confirm failed');
  }
});

// Model detail modal
if (bolt) bolt.action('model_detail', async ({ ack, body, client }) => {
  await ack();
  const modelId = body.actions[0].value;
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const modal = marketplace.buildModelDetailModal(modelId, agentId);
  if (!modal) return;
  try {
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  } catch (err) {
    log.error({ err: err.message, modelId }, 'failed to open model detail modal');
  }
});

// Connector detail modal
if (bolt) bolt.action('connector_detail', async ({ ack, body, client }) => {
  await ack();
  const slug = body.actions[0].value;
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const modal = marketplace.buildConnectorDetailModal(slug, agentId);
  if (!modal) {
    log.warn({ slug }, 'connector detail modal unavailable (app not in Connector cache)');
    return;
  }
  try {
    // views.push only works when a modal is already on the stack (e.g. the
    // search results modal). From App Home there is no stack — push fails
    // with no_view_to_push — so open a fresh modal instead.
    if (body.view && body.view.type === 'modal') {
      await client.views.push({ trigger_id: body.trigger_id, view: modal });
    } else {
      await client.views.open({ trigger_id: body.trigger_id, view: modal });
    }
  } catch (err) {
    log.error({ err: err.message, slug }, 'failed to open connector detail modal');
  }
});

// Connector search modal
if (bolt) bolt.action('connector_search_open', async ({ ack, body, client }) => {
  await ack();
  try {
    const modal = marketplace.buildConnectorSearchModal();
    await client.views.open({ trigger_id: body.trigger_id, view: modal });
  } catch (err) {
    log.error({ err: err.message }, 'failed to open connector search modal');
  }
});

// Connector search submit (view callback) — responds with update to replace modal in-place
if (bolt) bolt.view('connector_search_submit', async ({ ack, body, view }) => {
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  const query = (view.state.values.search_block.search_query.value || '').trim();
  if (!query) {
    await ack();
    return;
  }

  const resultsModal = marketplace.buildConnectorSearchResultsModal(query, agentId);
  await ack({ response_action: 'update', view: resultsModal });
});

// ---------- Skills Marketplace: install / uninstall (DDB writes — sandra-repo-removal Phase 2) ----------
//
// Direct DynamoDB writes replace the old GitHub repository_dispatch → PR → merge → re-clone → ECS
// restart flow. marketplace.{installSkill,…} mutate AGENT#<id>/MARKETPLACE and mirror the in-memory
// aggregate, so App Home updates immediately. Skill changes take effect on the agent's NEXT turn
// (Phase-3 fingerprint); connector/model changes on the next cold boot.

const NO_AGENT_MSG = 'You don\'t have a personal agent set up yet. Ask in *#sandra-management* to get started.';

async function refreshHome(userId, agentId, tab, client, child) {
  try {
    const view = marketplace.buildHomeView(agentId, tab, { teamId: slackTeamId });
    await client.views.publish({ user_id: userId, view });
  } catch (err) {
    child.warn({ err: err.message }, 'failed to refresh app home');
  }
}

bolt.action('marketplace_install', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const skillId = body.actions[0].value;
  const agentId = homeAgentFor(userId, 'app_home');
  const child = log.child({ action: 'marketplace_install', user: userId, agent: agentId, skill: skillId });
  if (!agentId) { await client.chat.postMessage({ channel: userId, text: NO_AGENT_MSG }); return; }

  // PINNED SKILLS come first, because a pin is stricter than a review flag and does not depend on the
  // catalog carrying one. `skill-builder` is precisely that case: sandra does NOT mark it
  // securityReviewRequired, so the check below would wave it through. See config-resolver/skill-pins.mjs.
  //
  // This is the WEAKER of the two enforcement points and is documented as such: 134 of the 135
  // demo-crm installs never came through this button — they arrived via hydration, which is
  // gated separately in extract.mjs. A pin here alone would stop nothing that has already happened.
  // MEMBERSHIP COMES FROM THE POLICY ROW now, not from skill-pins.mjs's inline lists (plan §8.2 D3). Those
  // arrays are gone: while they existed this gate read one list and the runtime's skill filter read another,
  // and they disagreed the moment the policy was seeded — this button refused every install of a pinned
  // skill while the filter correctly permitted 146 existing holders.
  const pins = await grants.loadSkillPins();
  const allowedSkills = await grants.loadAllowedSkills(configDoc(), AGENT_CONFIG_TABLE, agentId);
  if (pins.isPinned(skillId) && !pins.pinAllows(skillId, allowedSkills)) {
    child.warn({ skill: skillId }, 'install refused: pinned skill, scope not on the allow-list');
    await client.chat.postMessage({ channel: userId, text: `:pushpin: ${pins.pinRefusalText(skillId)}` });
    return;
  }

  // Skills flagged for security review were gated behind human PR approval in the old flow. There
  // is no DDB-native approval path yet, so don't silently auto-install — route to #sandra-management.
  const catalogSkill = marketplace.getCatalog().skills[skillId] || {};
  if (catalogSkill.securityReviewRequired) {
    await client.chat.postMessage({ channel: userId, text: `:lock: *${skillId}* needs a security review before it can be installed. Please request it in *#sandra-management*.` });
    return;
  }

  try {
    await marketplace.installSkill(configDoc(), AGENT_CONFIG_TABLE, agentId, skillId, userId);
    child.info('skill installed (DDB)');
    await client.chat.postMessage({ channel: userId, text: `:white_check_mark: *${skillId}* installed for *${agentId}* — it'll be available the next time you message your agent.` });
    await refreshHome(userId, agentId, 'skills', client, child);
  } catch (err) {
    child.error({ err: err.message }, 'skill install failed');
    await client.chat.postMessage({ channel: userId, text: `:x: Something went wrong installing *${skillId}*. Please try again or ask in *#sandra-management* for help.` });
  }
});

if (bolt) bolt.action('marketplace_uninstall', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const skillId = body.actions[0].value;
  const agentId = homeAgentFor(userId, 'app_home');
  const child = log.child({ action: 'marketplace_uninstall', user: userId, agent: agentId, skill: skillId });
  if (!agentId) { await client.chat.postMessage({ channel: userId, text: NO_AGENT_MSG }); return; }

  try {
    await marketplace.uninstallSkill(configDoc(), AGENT_CONFIG_TABLE, agentId, skillId);
    child.info('skill uninstalled (DDB)');
    await client.chat.postMessage({ channel: userId, text: `:white_check_mark: *${skillId}* removed from *${agentId}* — the change applies on your agent's next message.` });
    await refreshHome(userId, agentId, 'skills', client, child);
  } catch (err) {
    child.error({ err: err.message }, 'skill uninstall failed');
    await client.chat.postMessage({ channel: userId, text: `:x: Something went wrong removing *${skillId}*. Please try again or ask in *#sandra-management* for help.` });
  }
});

// ---------- Connected Apps: connect / disconnect (DDB writes) ----------

if (bolt) bolt.action('connector_install', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  let slug, name;
  try {
    const val = JSON.parse(body.actions[0].value);
    slug = val.slug;
    name = val.name;
  } catch {
    slug = body.actions[0].value;
    name = slug;
  }
  const child = log.child({ action: 'connector_install', user: userId, agent: agentId, slug });
  if (body.view?.id) {
    try { await client.views.update({ view_id: body.view.id, view: marketplace.buildConnectorInstallingModal(name, 'install') }); } catch { /* best-effort */ }
  }
  if (!agentId) { await client.chat.postMessage({ channel: userId, text: NO_AGENT_MSG }); return; }

  try {
    await marketplace.connectApp(configDoc(), AGENT_CONFIG_TABLE, agentId, slug, name, userId);
    child.info('connector connected (DDB)');
    await client.chat.postMessage({ channel: userId, text: `:white_check_mark: *${name}* connected to *${agentId}* — available after your agent next restarts.\n\n:key: To finish setup, message your agent: "Connect me to ${name}"` });
    await refreshHome(userId, agentId, 'connectors', client, child);
  } catch (err) {
    child.error({ err: err.message }, 'connector connect failed');
    await client.chat.postMessage({ channel: userId, text: `:x: Something went wrong connecting *${name}*. Please try again or ask in *#sandra-management* for help.` });
  }
});

if (bolt) bolt.action('connector_uninstall', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const slug = body.actions[0].value;
  const agentId = homeAgentFor(userId, 'app_home');
  const child = log.child({ action: 'connector_uninstall', user: userId, agent: agentId, slug });
  if (body.view?.id) {
    try { await client.views.update({ view_id: body.view.id, view: marketplace.buildConnectorInstallingModal(slug, 'uninstall') }); } catch { /* best-effort */ }
  }
  if (!agentId) { await client.chat.postMessage({ channel: userId, text: NO_AGENT_MSG }); return; }

  try {
    await marketplace.disconnectApp(configDoc(), AGENT_CONFIG_TABLE, agentId, slug);
    child.info('connector disconnected (DDB)');
    await client.chat.postMessage({ channel: userId, text: `:white_check_mark: *${slug}* disconnected from *${agentId}* — applies on your agent's next restart.` });
    await refreshHome(userId, agentId, 'connectors', client, child);
  } catch (err) {
    child.error({ err: err.message }, 'connector disconnect failed');
    await client.chat.postMessage({ channel: userId, text: `:x: Something went wrong disconnecting *${slug}*. Please try again or ask in *#sandra-management* for help.` });
  }
});

// ---------- Model selection ----------

if (bolt) bolt.action('model_select', async ({ ack, body, client }) => {
  await ack();
  const userId = body.user.id;
  const agentId = homeAgentFor(userId, 'app_home');
  let modelId, modelName;
  try {
    const val = JSON.parse(body.actions[0].value);
    modelId = val.modelId;
    modelName = val.modelName;
  } catch {
    modelId = body.actions[0].value;
    modelName = modelId;
  }
  const child = log.child({ action: 'model_select', user: userId, agent: agentId, modelId: modelId || '(default)' });
  if (!agentId) { await client.chat.postMessage({ channel: userId, text: NO_AGENT_MSG }); return; }

  try {
    await marketplace.setModel(configDoc(), AGENT_CONFIG_TABLE, agentId, modelId || '', modelName || '', userId);
    child.info('model set (DDB)');
    // No DM, and nothing about restarts. The write IS the change: the agent's config fingerprint
    // now covers the marketplace `models` slice, so the next message re-resolves onto it — the same
    // path a skill install or a config edit takes. App Home is the confirmation; refreshing it
    // re-renders the tab with the model marked selected. A DM here would be announcing an event
    // that no longer happens.
    await refreshHome(userId, agentId, 'models', client, child);
  } catch (err) {
    child.error({ err: err.message }, 'model select failed');
    await client.chat.postMessage({ channel: userId, text: `:x: Something went wrong changing the model. Please try again or ask in *#sandra-management* for help.` });
  }
});

// ---------- Outbound: agent → Slack proxy ----------

const _realSlack = new WebClient(SLACK_BOT_TOKEN);
let _simulateTsCounter = 0;

function isSimulateChannel(ch) {
  return typeof ch === 'string' && ch.startsWith('C_SIMULATE');
}

// Wrap the Slack WebClient so calls targeting simulate channels are logged
// instead of sent to Slack (which would fail with invalid_channel).
const slack = new Proxy(_realSlack, {
  get(target, namespace) {
    const real = target[namespace];
    if (typeof real !== 'object' || real === null) return real;
    return new Proxy(real, {
      get(nsTarget, method) {
        const fn = nsTarget[method];
        if (typeof fn !== 'function') return fn;
        return function simulateAwareCall(args) {
          const ch = args?.channel;
          if (isSimulateChannel(ch)) {
            const fakeTs = `sim-${++_simulateTsCounter}`;
            log.info({ slack_method: `${String(namespace)}.${String(method)}`, channel: ch, ts: args?.ts, thread_ts: args?.thread_ts, text: (args?.text || '').slice(0, 200) }, '[simulate] slack call intercepted');
            return Promise.resolve({ ok: true, ts: fakeTs });
          }
          return fn.call(nsTarget, args);
        };
      },
    });
  },
});

const streaming = new StreamingManager({
  slack,
  log,
  updateIntervalMs: STREAM_UPDATE_INTERVAL_MS,
});

// P3: Wire up streaming — receive gateway events and update Slack messages live.
//
// The gateway broadcasts two event types we care about:
//   - "agent" events: { runId, sessionKey, seq, ts, stream, data }
//       stream: "assistant" → text delta (data.text = accumulated, data.delta = incremental)
//       stream: "lifecycle" → phase start/end (data.phase = "start"|"end")
//   - "chat" events: { runId, sessionKey, seq, state, message }
//       state: "final" → complete response with message.content
//
// Session keys from the gateway are prefixed with "agent:{agentName}:" and
// lowercased, so we match by extracting the channel:threadTs portion.

function buildToolLabel(data) {
  const meta = data?.meta;
  if (meta) return String(meta).slice(0, 72);
  const title = data?.title;
  if (title) return String(title).slice(0, 72);
  const name = data?.name || data?.toolName || data?.tool || '';
  return name || 'Working…';
}

function resolvePhaseStatus(data) {
  const phase = data?.phase || '';
  const status = data?.status || '';
  if (phase === 'end' || status === 'completed' || status === 'complete' || status === 'done') return 'complete';
  if (status === 'error' || status === 'failed') return 'error';
  return 'in_progress';
}

// ---------- Cron subsystem (Option B: dispatcher-owned scheduler) ----------
// The always-on dispatcher runs the cron scheduler for AgentCore agents — the
// scale-to-zero runtimes can't hold an in-process timer. A due job runs a full agent
// turn via InvokeAgentRuntime, gated on the agent's runtime flag. See
// pi-cron-migration-plan.md. NOTE: this assumes a single dispatcher instance
// (desired_count=1) — the scheduler + its EFS store must not run in two tasks.
// §12c ladder rung 3: the channel an agent is routed to, when the job carries no session key and
// no usable delivery.channel (hydrated legacy jobs). UNIQUE match only — an agent that owns more
// than one channel is ambiguous, and guessing would silently bind a job to the wrong place. The
// `dm-<userId>` mint pattern is deliberately NOT reverse-mapped: a user id is not a DM channel id
// (resolving it needs conversations.open, which is I/O this must not do).
function routedChannelFor(agentId) {
  const owned = Object.entries(routes.channels || {})
    .filter(([, a]) => a === agentId)
    .map(([channel]) => channel);
  return owned.length === 1 ? owned[0] : null;
}

const cronAlerts = createCronAlertEmitter({ log });

// THE PER-SCOPE FLAG the comment below used to say was still missing (§3a', cron-runner-flag.js).
//
// Under OpenClaw cron is per-agent — a croner inside each agent's own gateway, reading that agent's
// jobs.json on EFS — and none of that stops because archie exists. So an armed archie scheduler
// holding hydrated copies of the same jobs fires them a SECOND time, and no amount of care in this
// process can see the other one. The flag is what decides, per scope, which of the two owns firing;
// archie's fire path exits early unless it reads `agentcore`, and absent means `openclaw`, so the
// whole un-migrated fleet is held back by default rather than by an operational rule.
const cronRunnerFlags = createCronRunnerFlags({
  // No table = no client: an unconfigured dispatcher resolves every scope to `openclaw` (it does
  // not fire) rather than constructing a DynamoDB client it can never use.
  doc: AGENT_CONFIG_TABLE ? configDoc() : null,
  table: AGENT_CONFIG_TABLE,
  log,
});

cronService = createCronService({
  // ARMED. The gateway-wide CRON_ENABLED env var is gone: a single boolean on the gateway cannot
  // express what prod cron testing needs, which is flipping INDIVIDUAL agents between OpenClaw's
  // croner and archie's scheduler while both exist. That is `cronRunnerFlags` above, per scope.
  //
  // The runner's `enabled` gate stays as the whole-dispatcher kill switch — it gates arm/runNow
  // rather than the boot path, so no route can schedule a job while it is off
  // (cron-runner.js:129,164,346). It is deliberately NOT the same axis: `enabled:false` stops this
  // dispatcher scheduling anything at all, while the per-scope flag decides ownership between two
  // schedulers that are both running.
  //
  // The residual risk the flag does NOT cover: a scheduled turn needs no Slack input, so an armed
  // scheduler makes a FLIPPED agent act on its own as soon as jobs exist in its store — including
  // part-way through a hydration, off a half-populated config table. Hydration seeds the flag as
  // `openclaw` before it seeds a single job, so a fresh hydration cannot fire here; the exposure is
  // to re-hydrating a scope that is ALREADY flipped, which is documented at cron-hydrator.js.
  enabled: true,
  dir: process.env.CRON_STORE_DIR || '/efs/cron',
  agentCore,
  // Cron turns resolve the published image exactly like Slack turns — see ensureCurrentRuntime.
  ensureRuntime: ensureCurrentRuntime,
  // §12c: ONE scoping rule — every session is `<channel>:<thread>`, and a cron job owns a
  // SYNTHETIC thread in its channel (`slack:thread:<channel>:cron-<jobId>`). Replaces
  // `cron:iso:<agent>:<uuid>` (fresh EVERY fire — no run-to-run continuity, where OpenClaw's
  // `isolated` is a stable `cron:<jobId>`) and `cron:main:<agent>` (shared by ALL of an agent's
  // jobs — cross-job context bleed). The channel comes from the ladder in buildCronSessionKey;
  // `channelForAgent` supplies the routing rung, which only the dispatcher can answer.
  sessionIdFor: (job) => agentcoreSessionId(buildCronSessionKey(job, { channelForAgent: routedChannelFor })),
  // One emitter feeds both cron alarms: onAlert = the failing TURN (§9d, CronFailureAlert),
  // onDeliveryFailure = the failing ANNOUNCE (§9r, CronDeliveryFailure). The second exists
  // because delivery errors are swallowed by design and were otherwise log-only.
  deliver: createDeliver({ slack, log, onFailure: cronAlerts.onDeliveryFailure }).deliver,
  onAlert: cronAlerts.onAlert,
  // A long run is not a failure, but it is the leading indicator for the biggest cron failure
  // class, and for a frequent job it also means ticks are being dropped. Both alarm in Terraform.
  onLongRun: cronAlerts.onLongRun,
  onOverlapSkip: cronAlerts.onOverlapSkip,
  // Deletion telemetry: a removal used to leave no trace at all (§M4 follow-up).
  onJobRemoved: cronAlerts.onJobRemoved,
  // §3a' — the per-scope CRON_RUNNER gate, plus the metric for what it declines. A gated tick
  // writes nothing to the store, so CronFireGated is the only place it is countable.
  runnerFlags: cronRunnerFlags,
  onRunnerGated: cronAlerts.onRunnerGated,
  log,
});

// The App Home Jobs tab reads and writes the SAME service the agents' cron tool reaches over
// /cron — one store, one writer, no HTTP hop (see cron-home.js).
cronHome = createCronHome({ service: cronService, logger: log });

const web = express();
web.use(express.json({ limit: '1mb' }));

// /health is unauthenticated (ECS healthcheck hits it).
// Fix 1: returns 503 when Socket Mode has been disconnected longer than
// HEALTH_DISCONNECT_GRACE_MS. Brief reconnects are tolerated so a blip
// doesn't cause ECS to churn the task.
web.get('/health', (_req, res) => {
  if (shuttingDown) {
    return res.status(503).json({ ok: false, reason: 'shutting_down' });
  }
  if (NO_SOCKET_MODE) {
    return res.json({ ok: true, socket_mode: 'disabled' });
  }
  if (!socketConnected) {
    const downMs = socketLastDisconnectedAt ? Date.now() - socketLastDisconnectedAt : Infinity;
    if (downMs > HEALTH_DISCONNECT_GRACE_MS) {
      return res.status(503).json({
        ok: false,
        reason: 'socket_mode_disconnected',
        disconnected_for_ms: downMs,
      });
    }
    return res.json({ ok: true, socket_connected: false, reconnecting: true });
  }
  const lastEventAgo = lastSlackEventAt ? Date.now() - lastSlackEventAt : null;
  return res.json({ ok: true, socket_connected: true, last_slack_event_ms_ago: lastEventAgo });
});

web.use((req, res, next) => {
  if (!verifySecret(req.headers['x-dispatcher-secret'])) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

// Cron manager API (behind the shared-secret gate above): agents, via the Pi cron
// tool, create/list/update/remove/run scheduled jobs here. The dispatcher is the sole
// writer of the cron store.
web.use('/cron', createCronApi({ service: cronService, log }));

// REMOVED 2026-08-11: `POST /api/:method`, the Slack proxy.
//
// It existed so an OpenClaw ECS agent could speak to Slack itself, via slack-reply-plugin's
// chat.postMessage. The AgentCore image does not ship that plugin (only connector-session,
// demo-cache and mcp-auth), and under Pi the adapter streams its reply back through the
// InvokeAgentRuntime SSE response for the DISPATCHER to post — so nothing called this any more.
//
// Worth removing rather than leaving inert: it was an ungated Slack-WRITE surface. Any holder of
// the shared secret could post as the bot in any channel the bot can see, and every runtime can
// resolve that secret (DISPATCHER_SHARED_SECRET_ID + its derived role's Secrets Manager read). So
// an agent holding `bash` could speak as the bot with no capability grant at all, straight past
// the tool-permission PEP. One `git revert` away if a Pi tool ever needs it — with a capability
// attached this time.

// Token-validated file download — agents pass a signed ref from the
// Attachments section. The ref encodes (fileId, expiry, hmac) so only
// files the dispatcher explicitly handed out can be downloaded.
web.get('/files/download/:ref', async (req, res) => {
  const ref = req.params.ref;
  const parsed = parseFileRef(ref, DISPATCHER_SECRET);
  const child = log.child({ file_ref: ref.slice(0, 16) + '…' });

  if (!parsed.valid) {
    const statusCode = parsed.error === 'malformed_ref' ? 400 : 403;
    child.warn({ reason: parsed.error }, 'file ref rejected');
    return res.status(statusCode).json({ ok: false, error: parsed.error });
  }

  const fileId = parsed.fileId;
  child.info({ file_id: fileId }, 'file ref validated');
  try {
    const info = await slack.files.info({ file: fileId });
    if (!info.ok || !info.file) {
      child.warn('file not found');
      return res.status(404).json({ ok: false, error: 'file_not_found' });
    }
    const downloadUrl = info.file.url_private_download || info.file.url_private;
    if (!downloadUrl) {
      child.warn('no download URL');
      return res.status(404).json({ ok: false, error: 'no_download_url' });
    }
    const response = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
    });
    if (!response.ok) {
      child.error({ status: response.status }, 'slack download failed');
      return res.status(502).json({ ok: false, error: 'download_failed' });
    }
    res.set('Content-Type', info.file.mimetype || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${info.file.name || fileId}"`);
    if (info.file.size) res.set('Content-Length', String(info.file.size));
    await pipeline(Readable.fromWeb(response.body), res);
  } catch (err) {
    child.error({ err: err.message }, 'file proxy error');
    if (!res.headersSent) res.status(500).json({ ok: false, error: err.message });
  }
});

// REMOVED 2026-08-11: `GET /files/:id`, the legacy raw-file-id download. Its own comment carried
// the reason — "any agent with the shared secret can download any file the bot can see" — and its
// replacement, the HMAC-signed `/files/download/:ref` above, has been in place for months. Its only
// caller was slack-reply-plugin, which the AgentCore image does not ship.

// Per-call sequence for the synthetic event ts below. Declared here because the 2026-08-11
// OpenClaw-path removal deleted the declaration and not the use, so EVERY /simulate call threw
// `ReferenceError: simulateSeq is not defined` from an express handler — which takes the whole
// dispatcher process down, not just the request. Found by calling /simulate to verify a deploy.
let simulateSeq = 0;

// POST /simulate { text, user?, channel?, channel_type?, client_msg_id? }
//
// curl -H 'x-dispatcher-secret: ...' \
//      -d '{"text":"hello"}' http://localhost:19090/simulate
web.post('/simulate', async (req, res) => {
  const child = log.child({ endpoint: 'simulate' });
  const text = req.body.text || '';
  if (!text) return res.status(400).json({ ok: false, error: 'text is required' });

  const event = {
    type: 'message',
    text,
    user: req.body.user || 'U_SIMULATE',
    channel: req.body.channel || 'C_SIMULATE',
    channel_type: req.body.channel_type || 'im',
    // Unique per call. `Date.now()/1000` alone collides when two requests land in the same
    // millisecond, and since the turn queue's MessageDeduplicationId falls back to channel+ts, a
    // collision makes SQS correctly swallow the second as a duplicate — losing a simulated message
    // for a reason that cannot happen with real Slack events. Cost a live burst 1 of 25 twice before
    // it was spotted, and it looked exactly like a durability bug.
    ts: `${Math.floor(Date.now() / 1000)}.${String(simulateSeq++).padStart(6, '0')}`,
  };
  if (req.body.thread_ts) event.thread_ts = req.body.thread_ts;
  // Pass the caller's message id through so /simulate exercises the SAME dedup path as production
  // (real Slack events carry client_msg_id; a harness that drops it tests a different code path).
  if (req.body.client_msg_id) event.client_msg_id = req.body.client_msg_id;

  const agent = resolveAgent(event);
  if (!agent) {
    child.warn('no route matched');
    return res.status(404).json({ ok: false, error: 'no route matched' });
  }

  const sessionKey = buildSessionKey(event);
  child.info({ agent, sessionKey, text: text.slice(0, 100) }, 'simulating message');

  try {
    await forwardToAgent(agent, event, child.child({ agent }));
    res.json({ ok: true, agent, sessionKey });
  } catch (err) {
    child.error({ err: err.message }, 'simulate forward failed');
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Hot reload: pull the config repo and rebuild routes without restarting
// the Slack connection. Serialised by the reload mutex (fix 3), so
// overlapping requests wait instead of racing on the clone dir.
web.post('/reload', async (_req, res) => {
  try {
    await reloadRoutes();
    res.json({ ok: true, routes: summariseRoutes() });
  } catch (err) {
    log.error({ err: err.message }, 'reload failed');
    res.status(500).json({ ok: false, error: err.message });
  }
});

web.get('/routes', (_req, res) => {
  res.json(summariseRoutes());
});

web.get('/debug/streaming', (_req, res) => {
  res.json({ ok: true, sessions: streaming.debugSnapshot(), sessionCount: streaming.sessionCount });
});

function summariseRoutes() {
  return {
    dm_users: routes.dmUsers,
    channels: routes.channels,
    require_mention: [...routes.requireMention],
    streaming_agents: [...routes.streamingAgents],
  };
}

// ---------- Startup ----------

let httpServer = null;
let turnConsumer = null;
let slackTeamId = null;
let slackBotUserId = null;

(async () => {
  try {
    await reloadRoutes();
  } catch (err) {
    log.fatal({ err: err.message }, 'initial config pull failed');
    process.exit(1);
  }

  // Load persisted conversation metadata from EFS (non-fatal on failure)
  try {
    conversations.load();
    log.info('conversation metadata loaded');
  } catch (err) {
    log.warn({ err: err.message }, 'failed to load conversation metadata — starting fresh');
  }

  try {
    const authResult = await _realSlack.auth.test();
    slackTeamId = authResult.team_id;
    slackBotUserId = authResult.user_id;
    streaming.teamId = slackTeamId;
    log.info({ teamId: slackTeamId, botUserId: slackBotUserId }, 'auth.test resolved');
  } catch (err) {
    log.warn({ err: err.message }, 'auth.test failed — streaming may not work in channels');
  }

  if (bolt) {
    await bolt.start();
    log.info('Slack Socket Mode start() returned');
    log.info({ mode: 'socket' }, 'event delivery: Socket Mode (WebSocket)');
  } else {
    log.info({ mode: 'http' }, 'event delivery: HTTP only (NO_SOCKET_MODE=true) — use POST /simulate');
  }

  // Pre-warm Connector toolkit cache (non-blocking)
  if (CONNECTOR_API_KEY) {
    marketplace.fetchConnectorToolkits(CONNECTOR_API_KEY, { log }).catch(() => {});
  }

  // Pre-warm Bedrock model cache (non-blocking)
  marketplace.fetchBedrockModels(bedrockClient, { log }).catch(() => {});

  // Load persisted jobs from EFS. Non-fatal — a cron failure must not take down Slack
  // ingress.
  //
  // Always load the store — jobs must be visible and seedable either way. Whether any of
  // them ARM is decided in the runner (enabled, above), which is the only place that closes
  // every path: boot recovery, a job POSTed by an agent, an update, a manual runNow.
  try {
    const n = await cronService.start();
    log.info({ jobs: n }, 'cron scheduler started');
  } catch (err) {
    log.error({ err: err.message }, 'cron scheduler failed to start — scheduled jobs will not fire');
  }

  // Keep the fleet image pointer warm so no turn pays the DynamoDB read. Best-effort by design: a
  // failed refresh keeps serving the last known image rather than stalling the fleet.
  imageSource.start();

  // Account-wide agent-runtime count vs the AgentCore `Total Agents per Account` quota. Nothing else
  // can see this: the quota publishes no AWS/Usage metric, so without this sample the first symptom of
  // the ceiling is CreateAgentRuntime refusing mid-roll. Off the turn path (own 5-minute timer) and
  // self-disabling if the role cannot list — see runtime-quota-metrics.js.
  runtimeQuota.start();

  // Durable turn consumer. A poller receives a message and HANDS IT OFF, then goes straight back to
  // receiving — so `pollers` is just how fast we drain (one long-poll socket each), and
  // MAX_INFLIGHT_TURNS is the real cap on concurrent turns. They used to be one number, which meant a
  // 30-45s provision occupied a slot that could have been serving; see provisioning-queue-plan.md.
  // Per-thread serialisation is unaffected — SQS never hands two pollers the same MessageGroupId, and
  // that holds regardless of whether the poller blocks (spike-verified against real SQS).
  if (turnQueue.enabled) {
    turnConsumer = turnQueue.startConsumer({
      pollers: Number(process.env.TURN_QUEUE_POLLERS || 5),
      maxInflight: Number(process.env.MAX_INFLIGHT_TURNS || 0),
      // Sampled on the queue's timer so poller occupancy and the provision/invoke bounds share one
      // timeline — see the onSample comment in turn-queue.js.
      onSample: () => {
        if (agentCore.concurrencyStats) agentCore.metrics.emitConcurrencyBounds(agentCore.concurrencyStats());
      },
      handler: async ({ agent, event, meta }, { markStarted }) => {
        const child = log.child({ agent, sessionId: meta.groupId, queued: true });
        if (meta.receiveCount > 1) {
          child.warn({ receiveCount: meta.receiveCount }, 'turn redelivered — a previous attempt never reached the runtime');
        }
        // forwardToAgentCore, NOT forwardToAgent: the latter is the producer and would re-enqueue
        // this same message forever. `onFirstEvent` is the commit point — the first SSE event is
        // evidence the runtime holds the message, after which the turn runs unwatched by the queue.
        await forwardToAgentCore(agent, event, child, {
          onFirstEvent: () => { markStarted().catch(() => {}); },
          queueMeta: meta,
        });
      },
    });
  }
  // A missing pointer is NOT fatal to the process — the dispatcher still serves /health, the cron
  // API and Slack plumbing, and recovers by itself the moment one is published (the background
  // refresher keeps looking). But it IS an outage for agent turns, so it is logged at ERROR and
  // alarmed, not warned about and forgotten.
  try {
    const bootImage = await imageSource.resolveImage('_fleet');
    log.info({ image: bootImage, table: AGENT_CONFIG_TABLE },
      'fleet image resolved from DynamoDB (publishing a new build needs no dispatcher deploy)');
  } catch (err) {
    log.error({ err: err.message, table: AGENT_CONFIG_TABLE },
      'NO FLEET IMAGE PUBLISHED — agent turns will fail until `archie image publish <tag>` runs. '
      + 'There is no baked fallback by design: the dispatcher will not guess which build to run.');
  }

  httpServer = web.listen(PORT, '0.0.0.0', () => {
    log.info({ port: PORT }, 'dispatcher manager API listening');
  });
})().catch((err) => {
  log.fatal({ err: err.message }, 'startup error');
  process.exit(1);
});

// ---------- Shutdown (fix 5) ----------

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ signal, inflight: inflight.size }, 'shutdown initiated');

  // Hard deadline: force exit if graceful shutdown gets stuck on WS teardown.
  setTimeout(() => {
    log.warn('hard shutdown deadline — forcing exit');
    process.exit(1);
  }, 8000);

  // 1. Disconnect Socket Mode FIRST so Slack stops delivering events to us.
  //    This is critical during rolling deployments — the new task's Socket Mode
  //    connection will pick up events once ours drops.
  if (bolt) bolt.stop().catch(() => {});

  // 1b. Stop CLAIMING new turns from the queue. Anything still queued is safe — it stays in SQS and
  //     the next task picks it up, which is the entire point of the queue. Turns already in flight
  //     have been deleted (committed at their first SSE event) and simply run out the clock or die
  //     with the process; at-most-once for the execution phase is the scoped behaviour, and the
  //     runtime finishes regardless — only the reply delivery is lost.
  if (turnConsumer) {
    log.info('turn queue: no longer claiming new turns (queued work stays durable for the next task)');
    turnConsumer.stop().catch(() => {});
  }

  // 2. Brief drain: let in-flight forwards finish (they've already been accepted).
  if (inflight.size > 0) {
    log.info({ inflight: inflight.size }, 'draining in-flight forwards');
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((r) => setTimeout(r, 3000)),
    ]);
  }

  // 3. Flush conversation metadata to disk before exiting.
  conversations.saveSync();

  // 4. Close streaming state and HTTP server.
  streaming.destroy();
  if (httpServer) {
    httpServer.close(() => {});
  }

  log.info('shutdown complete');
  process.exit(0);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdown(sig).catch((err) => {
      log.error({ err: err.message }, 'shutdown error');
      process.exit(1);
    });
  });
}

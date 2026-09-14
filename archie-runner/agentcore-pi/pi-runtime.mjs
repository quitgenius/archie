// Pi-only AgentCore runtime core (image build). Drives Pi's createAgentSession/
// prompt directly on Bedrock via the AWS credential chain (AgentCore MMDS exec
// role) — NO OpenClaw gateway. See pi-core-migration-plan.md §0.5 / §3.
//
// Imports the pinned @mariozechner/pi-*@0.61.1 (installed via package.json).
// PI_VENDOR_DIR overrides to the frozen vendored dist for local testing.

import { deltaEvent, toolEvent } from './sse-contract.mjs';
// Reused, NOT reimplemented: the PEP already unwraps a batched connector multi-execute into its
// inner action slugs, with the sanitiser that makes that PII-safe (permissions/third-party-slug.mjs).
// A second unwrapper here would be a second thing to keep in step with Connector's shapes.
import { toolSlugField } from './permissions/third-party-slug.mjs';
import { toolOutcome } from './tool-outcome.mjs';
import { resolveRegisteredModel } from './bedrock-model-registry.mjs';

const VENDOR = process.env.PI_VENDOR_DIR; // unset in image → bare package imports
const spec = (pkg, sub) => {
  if (VENDOR) return `${VENDOR}/${pkg}/dist/${sub}`;
  return sub === 'index.js' ? `@mariozechner/${pkg}` : `@mariozechner/${pkg}/${sub.replace(/\.js$/, '')}`;
};

const pca = await import(spec('pi-coding-agent', 'index.js'));
const piAi = await import(spec('pi-ai', 'index.js'));

let bedrockWired = false;
export async function registerBedrock() {
  if (bedrockWired) return;
  bedrockWired = true;
  // pi-ai auto-registers built-in providers on import; belt-and-suspenders wire
  // the explicit bedrock module so we don't depend on lazy-load timing.
  try {
    if (typeof piAi.setBedrockProviderModule === 'function') {
      const bp = await import(spec('pi-ai', 'bedrock-provider.js'));
      if (bp?.bedrockProviderModule) piAi.setBedrockProviderModule(bp.bedrockProviderModule);
    }
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-runtime', msg: 'bedrock wire warning', err: e.message }));
  }
}

/**
 * The pi-ai catalog trails Bedrock. Verified 2026-08-10: `global.anthropic.claude-opus-4-8` is a
 * LIVE Bedrock inference profile (`aws bedrock list-inference-profiles`) that neither our pinned
 * 0.61.1 nor the then-latest 0.73.1 carries — the newest global opus in either is 4-7. So a bump
 * would NOT have fixed it; the gap is upstream data, not our version.
 *
 * Rather than silently downgrade such a job to the agent's default model, synthesise the Model from
 * its nearest CATALOGUED sibling: same family and generation, one minor older. `Model` is a plain
 * data interface, so cloning the sibling keeps every field real (api, baseUrl, reasoning,
 * contextWindow, maxTokens) and changes only `id`/`name` — and `id` is what the Bedrock Converse
 * call uses, so the request goes to the model that was actually asked for.
 *
 * CAVEAT, stated rather than hidden: `cost` and `contextWindow` are INHERITED from the sibling, so
 * cost telemetry (TurnCostUsd) for a synthesised model is approximate until the catalog catches up.
 * That is a reporting inaccuracy on ~7 prod jobs, traded against running them on the wrong model
 * entirely. The synthesised model is logged every time so it is never a silent substitution.
 */
function synthesiseFromSibling(id) {
  const m = /^(?<prefix>[a-z]{2}\.|global\.)?(?<family>anthropic\.claude-[a-z]+)-(?<major>\d+)-(?<minor>\d+)/.exec(id);
  if (!m) return null;
  const { prefix = '', family, major, minor } = m.groups;
  // SEARCH the catalog rather than construct candidate ids: sibling ids carry version suffixes that
  // are not predictable (`…opus-4-6-v1`, `…opus-4-5-20251101-v1:0`, `…opus-4-7`), so exact-match
  // guessing finds nothing. Take the HIGHEST minor strictly below the requested one, same
  // prefix+family+major — i.e. the closest real relative, whatever it happens to be called.
  const stem = `${prefix}${family}-${major}-`;
  let best = null;
  let bestMinor = -1;
  for (const cand of piAi.getModels('amazon-bedrock')) {
    if (typeof cand?.id !== 'string' || !cand.id.startsWith(stem)) continue;
    const cm = /^(\d+)/.exec(cand.id.slice(stem.length));
    if (!cm) continue;
    const n = Number(cm[1]);
    if (n < Number(minor) && n > bestMinor) { bestMinor = n; best = cand; }
  }
  if (!best) return null;
  return { ...best, id, name: `${best.name} (as ${id}, metadata from ${best.id})`, _synthesisedFrom: best.id };
}


// ── Bedrock Claude model factory (the catalog's last resort) ────────────────────────────────────
//
// WHY THIS EXISTS. pi-ai's catalog is a compiled-in snapshot and Bedrock moves faster than it. As of
// 0.61.1 (and 0.70.2, the version OpenClaw itself bundles — so a bump does NOT fix this) the catalog
// carries no `claude-*-5` at all and no opus above 4-6, while this account can invoke sonnet-5,
// opus-5 and opus-4-8 today. `synthesiseFromSibling` covers ids of the form `<family>-<major>-<minor>`
// by cloning a catalogued relative; it cannot help `…-opus-5` (no minor to match) or `…-fable-5`
// (no `fable` family in the catalog at all).
//
// Before this, such an id threw. That mattered more than it sounds: pi-adapter's loadConfig is now
// fatal, so an unresolvable model is a crash-looping agent rather than a degraded one.
//
// WHAT IT CAN HONESTLY SYNTHESISE. Almost everything in a Model is constant or derivable for Bedrock
// Claude: `api`, `provider` and `input` are the same for every one, `baseUrl` follows the region.
// Only three values are genuinely per-model — contextWindow, maxTokens and cost — and those come
// from the table below.
//
// COST IS THE CAREFUL ONE. pi-ai computes each turn's USD from `model.cost`, and the adapter passes
// that through verbatim, deliberately emitting NOTHING when pi-ai reports no cost, because "a
// made-up cost that looks real is worse than a missing datapoint" (pi-adapter resolveTurnCostUsd).
// So a guessed price here would not be a small inaccuracy — it would defeat that rule fleet-wide.
// The table is therefore transcribed from AWS's OWN published prices, and a family that is not in it
// gets NO cost at all: pi-ai then reports none, the adapter emits none, and the datapoint is
// honestly missing rather than quietly wrong.
//
// SOURCE: AWS Price List, offer `AmazonBedrockFoundationModels`, us-east-1, published 2026-08-14.
// Figures are the GLOBAL tier; regional (`us.`/`eu.`/`ap.` prefixes) is a uniform +10%, verified
// across every Claude model in that feed on the same date. Refresh from:
//   https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonBedrockFoundationModels/current/index.json
const CLAUDE_MODELS = {
  'sonnet-5':  { contextWindow: 1000000, maxTokens: 64000,  cost: { input: 2,  output: 10, cacheRead: 0.2, cacheWrite: 2.5 } },
  'opus-5':    { contextWindow: 1000000, maxTokens: 128000, cost: { input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'opus-4-8':  { contextWindow: 1000000, maxTokens: 128000, cost: { input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'opus-4-7':  { contextWindow: 1000000, maxTokens: 128000, cost: { input: 5,  output: 25, cacheRead: 0.5, cacheWrite: 6.25 } },
  'fable-5':   { contextWindow: 1000000, maxTokens: 64000,  cost: { input: 10, output: 50, cacheRead: 1,   cacheWrite: 12.5 } },
};

// Conservative when the family is unknown. UNDER-stating is the safe direction: too small a context
// makes Pi compact earlier than it needs to, while too large lets it build a request Bedrock rejects
// — a degraded turn versus a failed one.
const UNKNOWN_CLAUDE = { contextWindow: 200000, maxTokens: 8192 };

const REGIONAL_PREMIUM = 1.1; // non-global inference profiles, uniform across the feed

/**
 * Thinking is ON for every Claude here, including Claude 5 — but only because the image patches
 * pi-ai to make that true.
 *
 * FOUND LIVE, 2026-08-15, on the fleet's first Claude 5 turn: every turn failed in ~1s with
 *
 *   "thinking.type.enabled" is not supported for this model.
 *   Use "thinking.type.adaptive" and "output_config.effort" to control thinking behavior.
 *
 * pi-ai 0.61.1 implements adaptive thinking correctly, but decides WHEN to use it from a hard-coded
 * substring list (`supportsAdaptiveThinking`, providers/amazon-bedrock.js) holding only opus-4-6 and
 * sonnet-4-6. Everything else got the legacy `thinking.type: "enabled"` block, which Claude 4 accepts
 * and Claude 5 rejects outright.
 *
 * THE FIRST FIX WAS TO DECLARE CLAUDE 5 NON-REASONING, which worked and cost extended thinking
 * fleet-wide. agentcore-pi/patch-pi-ai-adaptive-thinking.mjs replaces that: it widens the predicate
 * at image build time so Claude 5 takes the adaptive branch and thinking stays ON.
 *
 * SO `reasoning: true` HERE DEPENDS ON THAT PATCH. They cannot drift — the patch runs in the same
 * Dockerfile that builds this file into the image and FAILS THE BUILD if it cannot apply, so an
 * image containing this line always contains a pi-ai that honours it.
 */

/** `global.anthropic.claude-sonnet-5` -> `sonnet-5`; returns null if this is not a Bedrock Claude id. */
function claudeFamily(id) {
  const m = /^(?:[a-z]{2}\.|global\.)?anthropic\.claude-([a-z]+(?:-\d+)*)/.exec(String(id));
  return m ? m[1] : null;
}

/**
 * Build a Model for a Bedrock Claude id the catalog does not carry. Returns null for anything that
 * is not recognisably one, so a genuine typo still fails loudly rather than resolving to something.
 */
function bedrockClaudeModel(id) {
  const family = claudeFamily(id);
  if (!family) return null;
  const known = CLAUDE_MODELS[family];
  const regional = !String(id).startsWith('global.');
  const scale = (c) => (regional
    ? Object.fromEntries(Object.entries(c).map(([k, v]) => [k, Number((v * REGIONAL_PREMIUM).toFixed(4))]))
    : { ...c });
  return {
    id,
    name: `Claude ${family} (synthesised)`,
    provider: 'amazon-bedrock',
    api: 'bedrock-converse-stream',
    baseUrl: `https://bedrock-runtime.${process.env.AWS_REGION || process.env.REGION || 'us-east-1'}.amazonaws.com`,
    // True for every Claude, Claude 5 included — see the note above: the image patches pi-ai so the
    // adaptive branch is taken, and the build fails if that patch cannot apply.
    reasoning: true,
    input: ['text', 'image'],
    contextWindow: (known || UNKNOWN_CLAUDE).contextWindow,
    maxTokens: (known || UNKNOWN_CLAUDE).maxTokens,
    // Omitted entirely when the family is unknown — see the note above on why a guess is worse.
    ...(known?.cost ? { cost: scale(known.cost) } : {}),
    _synthesisedBy: known ? 'factory' : 'factory:unpriced',
  };
}

export function getModel(id) {
  const m = piAi.getModel('amazon-bedrock', id);
  if (m) return m;
  const registered = resolveRegisteredModel(id, (baseId) => piAi.getModel('amazon-bedrock', baseId));
  if (registered) {
    console.log(JSON.stringify({ component: 'pi-runtime', msg: 'Bedrock model registered', id, source: registered._registeredFrom }));
    return registered;
  }
  const synth = synthesiseFromSibling(id);
  if (synth) {
    console.error(JSON.stringify({
      level: 'warn', component: 'pi-runtime', msg: 'model not in Pi catalog — synthesised from nearest sibling (cost/context metadata inherited)',
      id, from: synth._synthesisedFrom,
    }));
    return synth;
  }
  // Last resort: build one. Only for recognisable Bedrock Claude ids, so a typo still throws.
  const built = bedrockClaudeModel(id);
  if (built) {
    console.error(JSON.stringify({
      level: 'warn', component: 'pi-runtime',
      msg: built.cost
        ? 'model not in Pi catalog and no sibling — synthesised from the Bedrock Claude factory'
        : 'model not in Pi catalog, no sibling, and no published price for its family — synthesised WITHOUT cost (TurnCostUsd will not be emitted for it)',
      id, contextWindow: built.contextWindow, maxTokens: built.maxTokens, priced: !!built.cost,
    }));
    return built;
  }
  throw new Error(`model not in Pi catalog: amazon-bedrock/${id}`);
}

/**
 * G7 (§12c.7) — run one turn under a PER-TURN model override, then restore.
 *
 * The session's model normally binds once at createAgentSession from the agent's config. Cron jobs
 * may carry `payload.model` (9 prod jobs across 4 agents; every one an UPGRADE on its agent's
 * default, e.g. archie-data-analyst-* asking for sonnet-4-6 and agent-k4wmx6 for opus-4-8), so
 * dropping it would silently downgrade the fleet's heaviest analytical jobs — no error, just worse
 * output. This applies it for the duration of the turn only.
 *
 * FAIL-SOFT by design. An unresolvable id logs and runs on the agent's configured model rather than
 * failing the turn, because "not in the catalog" mostly means "newer than the pinned pi-ai
 * version" — `global.anthropic.claude-opus-4-8` is a real model that this catalog predates (its
 * newest global opus is 4-6-v1). Refusing would break 4 currently-working jobs in order to honour a
 * preference, which is the wrong trade: the job's WORK matters more than its model choice.
 *
 * Restores in a finally so a reused session object is never left mutated — cron sessions are
 * per-job today, but that is a property of the key scheme, not something this function should rely on.
 */
export async function withModel(session, modelId, fn) {
  if (!modelId || !session || typeof session.setModel !== 'function') return fn();
  const previous = session.model || null;
  if (previous && previous.id === modelId) return fn(); // already there — no churn
  let next = null;
  try {
    next = getModel(modelId);
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-runtime', msg: 'model override unresolved — using the agent default', requested: modelId, using: previous?.id ?? null, err: e.message }));
    return fn();
  }
  try {
    await session.setModel(next); // throws when no credential resolves for the model
  } catch (e) {
    console.error(JSON.stringify({ level: 'warn', component: 'pi-runtime', msg: 'model override rejected — using the agent default', requested: modelId, using: previous?.id ?? null, err: e.message }));
    return fn();
  }
  try {
    return await fn();
  } finally {
    if (previous) {
      try { await session.setModel(previous); } catch (e) {
        console.error(JSON.stringify({ level: 'warn', component: 'pi-runtime', msg: 'model restore failed', want: previous.id, err: e.message }));
      }
    }
  }
}

// Subscribe, dispatch, collect the assistant reply + usage/model/stopReason off the
// AgentSession event stream, unsubscribe. Returns the aggregate {text,usage,model,stopReason}.
//
// Optional `onEvent(sseEvent)` streams turn progress AS IT HAPPENS (Phase 1): fine-grained
// `text_delta`s are forwarded as `delta` events carrying the FULL ACCUMULATED text so far
// (per sse-contract), and tool start/end as `tool` events. onEvent does NOT receive the
// terminal `final` event — the caller (adapter) emits that from the returned aggregate, so it
// can also close the OTEL span with the same numbers. When `onEvent` is omitted, behaviour is
// byte-identical to before: the returned aggregate is driven solely by `message_end`, so the
// buffered-JSON path is unaffected.
export async function runTurn(session, prompt, onEvent) {
  // Old saved configurations and cron overrides can bypass the picker. Refuse a Global
  // profile before Pi can send a prompt, including automatic compaction/model requests.
  if (String(session?.model?.id || '').startsWith('global.')) {
    throw new Error('Global Bedrock profiles are disabled. Select a US model before running this agent or job.');
  }
  let text = '';
  let stopReason = null;
  let usage = null;
  let model = null;
  let errorMessage = null; // Pi's in-band error text (if any) — lets the adapter tell a genuine
  //                          model/tool failure from a benign empty/no-op turn (P4 classification).
  const emit = typeof onEvent === 'function' ? onEvent : null;
  let lastEmitted = ''; // longest accumulated assistant text already emitted as a delta
  const toolCalls = [];         // completed tool calls this turn (P1 per-tool spans) — always captured
  const toolStart = new Map();  // toolCallId -> start epoch ms, to time each call
  const toolSlugs = new Map();  // toolCallId -> connector action slug(s); only `start` carries args
  // Per-model-request capture (the Bedrock-call child spans): each assistant message is one
  // model request (a tool-loop turn = several). Boundaries: assistant `message_start` opens a
  // request (fallback: the turn's own start, for providers that skip message_start), the first
  // `message_update` after it is first-token (per-request TTFT), assistant `message_end` closes
  // it carrying that REQUEST's usage/model/stopReason.
  const modelCalls = [];
  // Exclusive end offsets into modelCalls, one per COMPLETED reply. A run answers more than one user
  // reply. With per-message isolation (the dispatcher serialises invokes per session) a run answers
  // ONE user message, so this is normally a single group — it exists because it is what makes usage
  // summation correct across a multi-CALL tool loop. See the turn_end handler below and reply-usage.mjs.
  const replyBoundaries = [];
  const turnStartMs = Date.now();
  let reqStartMs = null;
  let reqFirstTokenMs = null;
  const unsub = session.subscribe((ev) => {
    const t = ev?.type;
    if (t === 'message_start' && ev.message?.role === 'assistant') {
      reqStartMs = Date.now();
      reqFirstTokenMs = null;
      return;
    }
    if (t === 'message_update' && reqFirstTokenMs === null && ev.message?.role === 'assistant') {
      reqFirstTokenMs = Date.now();
      // fall through — the emit block below still forwards the delta
    }
    if (emit && t === 'message_update') {
      // The AgentSession emits `message_update` (the accumulated partial message) on every
      // streaming delta — it does NOT surface a raw `text_delta` to subscribers (see
      // pi-agent-core agent-loop.js). Derive the accumulated assistant text and forward it
      // (contract: delta.text is the full text so far). `text` holds the already-completed
      // assistant messages this turn, so `text + partial` stays monotonic across a
      // multi-message (tool-loop) turn.
      let partial = '';
      for (const b of ev.message?.content || []) if (b?.type === 'text') partial += b.text;
      const acc = text + partial;
      if (acc.length > lastEmitted.length) { lastEmitted = acc; emit(deltaEvent(acc)); }
      return;
    }
    // Tool start/end are ALWAYS captured (for P1 per-tool spans), and additionally forwarded to
    // the stream when `emit` is set. Timing is wall-clock per toolCallId.
    if (t === 'tool_execution_start') {
      toolStart.set(ev.toolCallId, Date.now());
      // THE SLUGS ARE DERIVED HERE, not at the end event, because only `tool_execution_start` carries
      // `args` (pi-agent-core types.d.ts:269-284) and the inner connector action travels as an
      // argument. Derived immediately and the args dropped: what is retained is the sanitised action
      // identifier and nothing beside it. Without this, a batched multi-execute records as one
      // anonymous `CONNECTOR_MULTI_EXECUTE_TOOL` and the trace cannot say WHICH tools ran.
      toolSlugs.set(ev.toolCallId, toolSlugField(ev.toolName, ev.args));
      if (emit) emit(toolEvent(ev.toolCallId, ev.toolName, 'running'));
      return;
    }
    if (t === 'tool_execution_end') {
      const startMs = toolStart.get(ev.toolCallId) ?? Date.now();
      toolStart.delete(ev.toolCallId);
      const slugs = toolSlugs.get(ev.toolCallId) ?? null;
      toolSlugs.delete(ev.toolCallId);
      toolCalls.push({
        id: ev.toolCallId,
        name: ev.toolName,
        startMs,
        endMs: Date.now(),
        isError: !!ev.isError,
        slugs,
        // Outcome ONLY — see tool-outcome.mjs for why the payload never travels with it. A connector
        // failure returns HTTP 200 with `{successful:false}`, so `isError` alone leaves a failed call
        // indistinguishable from a working one.
        outcome: toolOutcome(ev.result, !!ev.isError),
      });
      if (emit) emit(toolEvent(ev.toolCallId, ev.toolName, ev.isError ? 'error' : 'done'));
      return;
    }
    // Authoritative aggregate — unchanged; drives the return value, OTEL, and the buffered path.
    if (t === 'message_end' && ev.message?.role === 'assistant') {
      for (const b of ev.message.content || []) if (b?.type === 'text') text += b.text;
      stopReason = ev.message.stopReason ?? stopReason;
      usage = ev.message.usage ?? usage;
      model = ev.message.model ?? model;
      // Close this model request (one Bedrock call). Usage here is per-REQUEST (each
      // assistant message carries its own), unlike the turn-level aggregate above.
      const u = ev.message.usage || null;
      modelCalls.push({
        startMs: reqStartMs ?? turnStartMs,
        firstTokenMs: reqFirstTokenMs,
        endMs: Date.now(),
        model: ev.message.model ?? null,
        stopReason: ev.message.stopReason ?? null,
        usage: u,
        isError: ev.message.stopReason === 'error' || !!ev.message.errorMessage,
      });
      reqStartMs = null;
      reqFirstTokenMs = null;
      if (ev.message.stopReason === 'error' || ev.message.errorMessage) {
        errorMessage = ev.message.errorMessage ?? errorMessage;
        console.error(JSON.stringify({ component: 'pi-runtime', msg: 'turn error', stopReason: ev.message.stopReason, errorMessage: ev.message.errorMessage }));
      }
    }
    // REPLY BOUNDARY (per-reply metrics). One reply = one complete answer to one user message, which
    // may span several model calls (a tool loop). Pi emits `turn_end` once per assistant message —
    // i.e. once per tool-loop ITERATION, not per user message (pi-agent-core agent-loop.js emits it
    // inside the inner `while`), so `turn_end` alone is NOT a reply boundary. The reply ends on the
    // iteration that makes the inner loop exit: the assistant message carrying NO toolCall blocks.
    // That is exactly how the loop derives its own `hasMoreToolCalls`, so we compute the same thing.
    //
    // We record an offset into modelCalls rather than grouping here, so the aggregate stays a flat
    // array (unchanged for every existing consumer) and reply-usage.mjs does the grouping.
    //
    // ⚠ STEER/FOLLOWUP: this rule is exact only while BOTH queues are always empty, which they are
    // because we pass no streamingBehavior at all and the dispatcher never issues a concurrent prompt.
    // agent-loop polls steering AFTER emitting turn_end, so with `steer` enabled a no-toolCall
    // turn_end may still be followed by more work in the same reply and this would mis-group usage.
    // Re-enabling either means revisiting this boundary — see pi-turn-transport-plan.md.
    // Reply boundary — retained ONLY to group per-reply usage for metrics (reply-usage.mjs). Pi emits
    // turn_end once per assistant message, i.e. per tool-loop iteration, so the boundary is the
    // message carrying no toolCall blocks — exactly how the loop derives its own hasMoreToolCalls.
    // With per-message isolation a run answers ONE user message, so this normally yields a single
    // group; it stays because it is what makes the summation correct for a multi-call tool loop, and
    // it is the one piece that would still be right if multi-turn were ever re-enabled.
    if (t === 'turn_end') {
      const hasToolCalls = (ev.message?.content || []).some((b) => b?.type === 'toolCall');
      if (!hasToolCalls) replyBoundaries.push(modelCalls.length);
    }
  });
  // NO streamingBehavior. Multi-turn-per-session is deliberately OFF: the dispatcher serialises
  // invokes per runtimeSessionId (agentcore-client enqueueForSession), so a concurrent prompt must
  // never reach here. If one somehow does — a rolling deploy running two dispatcher tasks — Pi THROWS
  // ("Agent is already processing…"), which becomes a turn error and is surfaced, not swallowed.
  // That is the intended behaviour: a visible failure beats a message queued into a session whose
  // shared, per-turn-mutated turnCtx assumes one turn at a time. Re-enabling followUp/steer means
  // revisiting turnCtx and the getSession cache first — see pi-turn-transport-plan.md.
  try {
    await session.prompt(prompt);
  } finally {
    if (typeof unsub === 'function') unsub();
  }
  // `usage` stays the LAST model call's (unchanged, so every existing consumer is byte-identical).
  // `replyBoundaries` is additive: it lets the adapter emit per-reply metrics with usage SUMMED
  // across each reply's model calls, which is what `usage` alone could never express.
  return { text: text.trim(), stopReason, usage, model, errorMessage, toolCalls, modelCalls, replyBoundaries };
}

export { pca, piAi };

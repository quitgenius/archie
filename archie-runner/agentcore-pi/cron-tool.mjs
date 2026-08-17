// Pi `cron` tool (pi-cron-migration-plan.md §4) — presents the OpenClaw cron contract
// to the agent, backed by cron-tool-core.mjs (dispatcher-only since 2026-08-16; the
// agent-local OpenClaw mirror is gone). Thin wrapper: the
// only reason this file imports pi-ai is to build the TypeBox parameter schema, mirroring
// memory-tool.mjs. All logic + tests live in cron-tool-core.mjs (pi-free, hermetic).

import { piAi } from './pi-runtime.mjs';
import { createDispatcherClient } from './dispatcher-client.mjs';
import { makeCronExecute } from './cron-tool-core.mjs';

const T = piAi.Type;
const AnyObj = T.Any ? T.Any() : (T.Unknown ? T.Unknown() : T.Object({}, { additionalProperties: true }));

export function createCronTool(deps) {
  const execute = makeCronExecute({
    agentId: deps.agentId,
    // §12c: the AMBIENT session key of the conversation this tool call happens in. The agent has
    // no way to know its own channel (the DM branch of the dispatcher's buildAgentPayload never
    // includes it — the root cause in §12b), so it must not have to: the dispatcher already sends
    // input.sessionKey on every invoke, the adapter builds the session from it, and we stamp it
    // onto the job. This is exactly how OpenClaw resolves `current`
    // (options.sessionContext.sessionKey) — a reimplementation, not an invention.
    sessionKey: deps.sessionKey || null,
    // §7: the ambient Connector identity of this turn, stamped onto jobs this agent creates so they
    // never need `connector_bind_cron_entity` after the fact. Same threading as sessionKey above.
    entityId: deps.entityId || null,
    dispatcher: deps.dispatcher || createDispatcherClient(),
    now: deps.now,
    newId: deps.newId,
    log: deps.log,
  });
  return {
    name: 'cron',
    label: 'cron',
    capability: 'cron',
    // §12c: rewritten. The previous text was inherited from OpenClaw and described a system with
    // different semantics — it advertised sessionTarget "current" (never implemented here), named
    // `channel`/`to` without saying what they mean, and said nothing about where output goes. Two
    // live-broken jobs came from an agent following it. (The original diagnosis — "the agent put a
    // recipient in `to`" — was WRONG: upstream `to` IS the destination. The bug was ours, in
    // cron-delivery, which read `to` as thread_ts and `channel` as a channel id. Both corrected.)
    description:
      'Schedule agent turns. actions: "add" (create a job), "list", "update" (partial patch), '
      + '"remove", "run" (fire once now).\n'
      + 'A job = { name, schedule, payload, delivery?, failureAlert? }.\n'
      + '  schedule: {kind:"cron",expr,tz} | {kind:"every",everyMs,anchorMs} | {kind:"at",at}\n'
      + '            at: a ONE-SHOT absolute time. Do NOT compute or guess an epoch — pass a\n'
      + '            RELATIVE offset and it is resolved for you: "+3600" (bare = seconds), "+90m",\n'
      + '            "+2h", "+1d", "in 30 minutes". Absolute forms also accepted: epoch\n'
      + '            milliseconds, unix seconds, or an ISO-8601 string. The result echoes\n'
      + '            scheduledFor {unixMs, iso, inSeconds} — CHECK it says what you meant.\n'
      + '            A past `at` fires once immediately and then deletes itself.\n'
      + '            everyMs: milliseconds as a number; a string may carry a unit ("30m","1h").\n'
      + '  payload:  {kind:"agentTurn",message} — message is the prompt the turn runs\n'
      + '            payload.timeoutSeconds caps one run (default 60 min). Raise it for long jobs;\n'
      + '            0 means NO limit, so use that only deliberately. Negatives are rejected.\n'
      + '            payload.model overrides the model for this job only (a Bedrock model id).\n'
      + '            An id this runtime does not know falls back to your normal model.\n'
      + '  delivery: WHERE THE RESULT GOES. Omit it and the job runs but posts NOTHING (valid for\n'
      + '            side-effect work; a common mistake otherwise).\n'
      + '            {mode:"announce"} posts the result — it inherits the channel of the\n'
      + '            conversation you create it in, so you normally do NOT set a channel.\n'
      + '            {mode:"none"} is explicit silence — a background job whose output goes nowhere.\n'
      + '            To target somewhere else set delivery.to: a channel id (C…/D…/G…) or a user id\n'
      + '            (U…, which DMs them). delivery.threadId — not delivery.to — is the thread.\n'
      + 'Each job runs in its OWN conversation, continuous across runs — it sees what it did last\n'
      + 'time, and never writes into the conversation you are talking in now.\n'
      + 'Always confirm the schedule + what it will do with the user before adding.',
    parameters: T.Object({
      action: T.String(),
      job: T.Optional(AnyObj),
      jobId: T.Optional(T.String()),
      patch: T.Optional(AnyObj),
    }),
    async execute(_toolCallId, params) {
      const result = await execute(params);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  };
}

// Gate on the resolved allow-set (mirrors buildMemoryTools). agentId defaults to
// AGENT_NAME; the dispatcher client reads DISPATCHER_BASE_URL + DISPATCHER_SHARED_SECRET
// from env (resolved at boot by pi-entrypoint).
// (No `cwd` — unlike buildMemoryTools, cron has no agent-local file to touch since the
// OpenClaw rollback mirror was removed; everything lives behind the dispatcher.)
export function buildCronTools(allow, ctx = {}) {
  if (!allow.has('cron')) return [];
  return [createCronTool({
    agentId: process.env.AGENT_NAME,
    sessionKey: ctx.sessionKey || null,
    entityId: ctx.requesterSenderId || null,
  })];
}

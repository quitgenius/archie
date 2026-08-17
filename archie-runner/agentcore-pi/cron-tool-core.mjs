// Cron tool core logic (pi-cron-migration-plan.md §4/§2b) — the orchestration behind the
// Pi `cron` tool, kept free of any pi-ai import so it's hermetically testable (the thin
// ToolDefinition wrapper lives in cron-tool.mjs).
//
// A `cron` action maps to ONE write: the dispatcher manager API, which is authoritative for
// whether the job actually fires (the dispatcher owns the scheduler under Option B).
//
// This used to be a DUAL-write: it also mirrored each job into the agent's own EFS
// <cwd>/cron/jobs.json in OpenClaw's native CronJob shape, so a rollback to ECS resumed with
// no re-registration (§4b). Removed 2026-08-16 — the migration runs the other way now
// (`config hydrate` seeds OpenClaw's jobs INTO the dispatcher), and a second writer of the
// file OpenClaw's own scheduler owns can only diverge from it.

import { randomUUID } from 'node:crypto';

// ── Relative-time normalisation for `at` ─────────────────────────────────────
//
// The dispatcher's validator accepts exactly ONE form for a one-shot: `at` = an absolute,
// finite epoch-MILLISECOND number (cron-runner.validateSchedule). Every form a model
// naturally reaches for was broken, and one of them broke SILENTLY:
//   - "+3600" / "+1h" / "in 2 hours" / an ISO-8601 string → Number.isFinite(string) is
//     false → the op is rejected ({ok:false}), so the agent falls back to guessing an
//     epoch, which is exactly the hallucination we see.
//   - unix SECONDS (1786311294) → passes Number.isFinite, and the runner reads it as
//     epoch-ms = 1970-01-21 → an ELAPSED one-shot → "fire once immediately, then
//     self-delete" (cron-runner.add past-`at` policy). "In an hour" became "right now,
//     once", with ok:true and no warning anywhere.
// So we normalise HERE — before the dual-write — and the DISPATCHER record carries absolute
// epoch-ms, while the AGENT gets the forgiving surface.
//
// CORRECTED 2026-08-12: this used to say both projections carry epoch-ms and that doing so kept
// the mirror "OpenClaw-schema-exact — the gateway understands no other form". The second half was
// wrong, and it was the reason no one-shot an agent created under Pi could ever be loaded back by
// OpenClaw. epoch-ms is exact for OUR runner (cron-runner.validateSchedule requires a finite
// number); OpenClaw serialises `at` as an ISO-8601 STRING and silently drops a numeric one.
// Measured directly: two otherwise identical jobs planted in a running agent's jobs.json, same
// instant, differing only in the type of `at` — the ISO one armed, the numeric one did not.
// The mirror converted to ISO on write, so the two projections legitimately differed; with the
// mirror gone only the epoch-ms form remains. Pairs with the per-turn clock injection
// (clock-extension.mjs), which gives the model a real epoch to work from when it does want an
// absolute time.

const UNIT_MS = {
  ms: 1, msec: 1, millisecond: 1, milliseconds: 1,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
};

// A plausible epoch-MS is >= 1e12 (2001-09-09). A value in [1e9, 1e12) can only be unix
// SECONDS — read as ms it lands in 1970-01-12..2001, i.e. always long past, so upscaling
// is never worse than the alternative (an instant fire-and-delete).
const MIN_EPOCH_MS = 1e12;
const MIN_EPOCH_S = 1e9;

const DURATION_RE = /^([0-9]+(?:\.[0-9]+)?)\s*([a-z]*)$/i;

const AT_FORMS = 'epoch-ms (1786311294770), a relative offset ("+3600" = seconds, "+90m", "+2h", "+1d"), or an ISO-8601 timestamp';

/**
 * Parse a duration ("90m", "1.5h", "3600"). A BARE number means SECONDS — that is the
 * documented `+3600` convention. Returns ms, or null if unparseable.
 */
export function parseDurationMs(text) {
  const m = DURATION_RE.exec(String(text).trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ? m[2].toLowerCase() : 's';
  const mult = UNIT_MS[unit];
  return mult === undefined ? null : Math.round(n * mult);
}

function epochFromNumber(n, field) {
  if (!Number.isFinite(n)) throw new Error(`cron: ${field} must be ${AT_FORMS}`);
  if (n >= MIN_EPOCH_MS) return Math.round(n);          // already epoch-ms
  if (n >= MIN_EPOCH_S) return Math.round(n * 1000);    // unix SECONDS → ms
  // Too small to be any timestamp. Do NOT guess "offset" — a wrong-by-an-hour schedule is
  // worse than a loud error that names the correct forms.
  throw new Error(`cron: ${field}=${n} is too small to be a timestamp — for a relative time pass "+${Math.round(n) || 3600}" (seconds) or "+1h"; ${field} otherwise takes ${AT_FORMS}`);
}

/**
 * Normalise an absolute-time field (`at`, `anchorMs`) to epoch-ms. Accepts epoch-ms, unix
 * seconds, "now", "+<duration>" / "in <duration>", and ISO-8601. Throws with the accepted
 * forms named, so a retrying agent is told what to send rather than left to guess.
 */
export function normalizeAt(value, nowMs, field = 'schedule.at') {
  if (typeof value === 'number') return epochFromNumber(value, field);
  if (typeof value === 'string') {
    const s = value.trim();
    if (!s) throw new Error(`cron: ${field} required — ${AT_FORMS}`);
    if (/^now$/i.test(s)) return nowMs;
    // Relative: "+3600", "+90m", "in 2 hours". (A leading '-' is NOT an offset — a past
    // one-shot fires immediately, so it is always a mistake; fall through and reject.)
    const rel = /^\+\s*(.+)$/.exec(s) || /^in\s+(.+)$/i.exec(s);
    if (rel) {
      const ms = parseDurationMs(rel[1]);
      if (ms === null) throw new Error(`cron: cannot parse relative ${field} "${value}" — use "+3600" (seconds), "+90m", "+2h", "+1d"`);
      return nowMs + ms;
    }
    if (/^-?[0-9]+(?:\.[0-9]+)?$/.test(s)) return epochFromNumber(Number(s), field);
    const parsed = Date.parse(s);                        // ISO-8601 (and what Date accepts)
    if (Number.isFinite(parsed)) return parsed;
    throw new Error(`cron: cannot parse ${field} "${value}" — ${AT_FORMS}`);
  }
  throw new Error(`cron: ${field} must be ${AT_FORMS}`);
}

/**
 * Normalise a whole schedule to the dispatcher/OpenClaw wire form. Pure; throws on an
 * unparseable time so nothing partial is written.
 *
 * `everyMs` is deliberately asymmetric with `at`: a NUMBER is left alone (the field names
 * its unit, and sub-minute intervals are legal — rescaling 3600 to an hour would silently
 * break a real 3.6s job), and a BARE numeric STRING is read as ms for the same reason.
 * Only a unit-bearing string ("30m", "1h") is treated as a duration.
 */
export function normalizeSchedule(schedule, nowMs) {
  if (!schedule || typeof schedule !== 'object') throw new Error('cron: job.schedule required');
  if (schedule.kind === 'at') {
    return { ...schedule, at: normalizeAt(schedule.at, nowMs) };
  }
  if (schedule.kind === 'every') {
    const out = { ...schedule };
    if (typeof schedule.everyMs === 'string') {
      const s = schedule.everyMs.trim().replace(/^\+\s*/, '');
      const ms = /^[0-9]+(?:\.[0-9]+)?$/.test(s) ? Number(s) : parseDurationMs(s);
      if (ms === null || !Number.isFinite(ms)) throw new Error(`cron: cannot parse everyMs "${schedule.everyMs}" — pass milliseconds as a number, or a duration string like "30m"/"1h"`);
      out.everyMs = Math.round(ms);
    }
    if (schedule.anchorMs !== undefined && schedule.anchorMs !== null) {
      out.anchorMs = normalizeAt(schedule.anchorMs, nowMs, 'schedule.anchorMs');
    }
    return out;
  }
  return schedule; // {kind:"cron"} — croner validates the expr downstream
}

/**
 * What the tool ECHOES back for a one-shot: the resolved wall-clock, so the agent (and the
 * human reading the tool result) can see what "+1h" actually became instead of trusting it.
 * A past `at` carries the warning explicitly — the runner's policy is to fire it at once and
 * delete it, which is a legitimate operation but never what "schedule this" meant.
 */
export function describeSchedule(schedule, nowMs) {
  if (!schedule || schedule.kind !== 'at') return null;
  const at = schedule.at;
  const inSeconds = Math.round((at - nowMs) / 1000);
  const out = { unixMs: at, unixSeconds: Math.floor(at / 1000), iso: new Date(at).toISOString(), inSeconds };
  if (at <= nowMs) out.warning = 'at is in the past — this job fires ONCE immediately and then deletes itself; pass a relative offset like "+1h" to schedule it ahead';
  return out;
}

/**
 * OpenClaw/tool job spec → the dispatcher runner's job shape (manager API body).
 *
 * §12c: `sessionKey` is the AMBIENT key of the conversation the tool call happened in, threaded
 * from the adapter. The dispatcher derives the job's channel from it (so delivery has a target)
 * and builds the job's synthetic thread from it. Without this the agent would have to know its own
 * channel, which it cannot — the root cause behind the two live-broken jobs in §12b.
 *
 * `sessionTarget` no longer defaults to 'main'. That default was wrong twice over: OpenClaw
 * defaults by payload kind (`agentTurn` → isolated, `systemEvent` → main), and `main` + a
 * non-`systemEvent` payload is a combination OpenClaw's own validator THROWS on — so our default
 * was authoring jobs that the gateway would reject on rollback (the mirror exists for rollback).
 * Absent now means absent; the dispatcher applies the §12c scoping.
 */
/**
 * Cron turns get a 60-MINUTE budget, whatever the agent asked for.
 *
 * An agent sizes `timeoutSeconds` against what it observes under Pi, and that measurement does not
 * transfer. The same payload costs more under OpenClaw, where the agent performs the Slack send
 * itself instead of replying with text for the gateway to announce. Live 2026-08-12: `orange-code`
 * carried the agent's 30s, completed comfortably under archie, and timed out on EVERY OpenClaw run
 * at ~34s — killed about four seconds short, indefinitely.
 *
 * `run: timeout` is already the largest prod failure class (30 of 79 failing jobs, §12c.6b), so a
 * too-tight budget is the single most common way a cron job dies. A cron turn is unattended: there
 * is no user waiting on it, and a slow one is far better than one that can never finish. The
 * dispatcher's own default for an agentTurn is the same 60 minutes
 * (CRON_TIMEOUT.AGENT_TURN_DEFAULT_MS) — this stops an agent talking us BELOW it.
 *
 * A floor, not an override: a job that genuinely wants longer keeps it. Overruns are separately
 * visible via the long-run metric and the overlap-skip metric.
 */
const CRON_MIN_TIMEOUT_SECONDS = 3600;

export function floorCronTimeout(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const t = payload.timeoutSeconds;
  if (typeof t !== 'number' || !Number.isFinite(t) || t >= CRON_MIN_TIMEOUT_SECONDS) return payload;
  return { ...payload, timeoutSeconds: CRON_MIN_TIMEOUT_SECONDS };
}

export function toDispatcherJob(agentId, jobId, spec, createdAtMs, sessionKey, entityId) {
  const dj = {
    agentId,
    jobId,
    name: spec.name || jobId,
    enabled: spec.enabled !== false,
    schedule: spec.schedule,
    payload: spec.payload,
    createdAtMs,
  };
  // Explicit target still wins (an agent may deliberately ask for isolated); we simply stop
  // inventing 'main' when nothing was asked for.
  if (spec.sessionTarget !== undefined) dj.sessionTarget = spec.sessionTarget;
  const key = spec.sessionKey !== undefined ? spec.sessionKey : sessionKey;
  if (key) dj.sessionKey = key;
  if (spec.delivery !== undefined) dj.delivery = spec.delivery;
  if (spec.deleteAfterRun !== undefined) dj.deleteAfterRun = spec.deleteAfterRun;
  // §7: the job's Connector identity, defaulted to the AMBIENT identity of the turn that created it —
  // the same threading `sessionKey` gets two lines above, and for the same reason: the agent has no
  // way to know its own Connector entity and must not have to.
  //
  // Without this default a natively-created job carries NO entity, and `connectorEntity` was written
  // in exactly one place — cron-hydrator.js, for jobs migrated from OpenClaw. So every job an agent
  // scheduled for itself resolved to no identity and its Connector tools were rejected at fire time
  // (observed 2026-08-15 on `check-sandbox-email`). An explicit spec value still wins.
  const entity = spec.connectorEntity !== undefined ? spec.connectorEntity : entityId;
  if (entity) dj.connectorEntity = entity;
  // OpenClaw failureAlert {after,…} → the runner's {afterConsecutiveErrors}. The MIRROR
  // keeps the native {after,…} shape; only this dispatcher projection is remapped.
  if (spec.failureAlert && typeof spec.failureAlert === 'object' && spec.failureAlert.after !== undefined) {
    dj.failureAlert = { afterConsecutiveErrors: spec.failureAlert.after };
  }
  return dj;
}

/**
 * Build the action dispatcher. deps: { agentId, dispatcher, sessionKey?, entityId?, now?, newId? }.
 * Returns async (params) => resultObject (never throws — errors surface as {ok:false}).
 */
export function makeCronExecute(deps) {
  const { agentId, dispatcher } = deps;
  // §12c: ambient session key of the conversation this tool runs in (null for a
  // cron-created-by-cron turn, where the dispatcher falls to the next rung).
  const sessionKey = deps.sessionKey || null;
  const entityId = deps.entityId || null;
  const now = deps.now || Date.now;
  const newId = deps.newId || randomUUID;

  return async function execute(params) {
    const action = String(params?.action || '');
    try {
      switch (action) {
        case 'add': {
          const raw = params.job || {};
          if (!raw.schedule) throw new Error('cron: job.schedule required');
          const jobId = newId();
          const createdAtMs = now();
          // Resolve relative/loose times to absolute epoch-ms before the write, so the
          // dispatcher record carries the one wire form its validator accepts.
          const spec = { ...raw, schedule: normalizeSchedule(raw.schedule, createdAtMs), ...(raw.payload ? { payload: floorCronTimeout(raw.payload) } : {}) };
          const scheduledFor = describeSchedule(spec.schedule, createdAtMs);
          const res = await dispatcher.add(toDispatcherJob(agentId, jobId, spec, createdAtMs, sessionKey, entityId));
          return { ok: true, jobId, job: res.job || null, ...(scheduledFor ? { scheduledFor } : {}) };
        }
        case 'list': {
          const r = await dispatcher.list(agentId);
          return { ok: true, jobs: r.jobs || [] };
        }
        case 'update': {
          const jobId = params.jobId;
          const rawPatch = params.patch || {};
          if (!jobId) throw new Error('cron: jobId required for update');
          // Same normalisation on a reschedule (patch.schedule is the whole schedule object).
          const nowMs = now();
          let patch = rawPatch.schedule ? { ...rawPatch, schedule: normalizeSchedule(rawPatch.schedule, nowMs) } : rawPatch;
          // Same floor on a patched payload, or an update quietly reintroduces a tight budget.
          if (patch.payload) patch = { ...patch, payload: floorCronTimeout(patch.payload) };
          const scheduledFor = patch.schedule ? describeSchedule(patch.schedule, nowMs) : null;
          const res = await dispatcher.update(agentId, jobId, patch);
          return { ok: true, job: res.job || null, ...(scheduledFor ? { scheduledFor } : {}) };
        }
        case 'remove': {
          const jobId = params.jobId;
          if (!jobId) throw new Error('cron: jobId required for remove');
          await dispatcher.remove(agentId, jobId);
          return { ok: true, removed: jobId };
        }
        case 'run': {
          const jobId = params.jobId;
          if (!jobId) throw new Error('cron: jobId required for run');
          const res = await dispatcher.run(agentId, jobId);
          return { ok: true, final: res.final || null };
        }
        default:
          throw new Error(`cron: unknown action "${action}" (use add|list|update|remove|run)`);
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  };
}

'use strict';

// Cron manager API (pi-cron-migration-plan.md §3c/§4). An express router the AgentCore
// agents call (via the Pi cron tool) so the dispatcher is the SOLE WRITER of the cron
// store — every add/update/remove funnels through here, keeping schedule naming +
// validation centralised and the store single-writer.
//
// Auth: mounted BEHIND the dispatcher's global x-dispatcher-secret middleware (same as
// /api/:method), so this router does not re-check. It is the same trust boundary the
// agents already use to proxy Slack calls.
//
// Routes (all under the mount path, e.g. /cron):
//   POST   /                        add a job         (body = job)
//   GET    /:agentId                list an agent's jobs
//   PUT    /:agentId/:jobId         update a job      (body = job fields)
//   DELETE /:agentId/:jobId         remove a job
//   POST   /:agentId/:jobId/run     fire once, out of band

const express = require('express');
const { keyOf } = require('./cron-store');
const { classifyDelivery, DELIVERY_STATUS } = require('./cron-inventory-metrics');

// Delivery states that are BROKEN AT REST — accepting them means every fire is guaranteed to
// fail (or silently do nothing), hours later, in a log line nobody reads. Rejecting here gives
// the agent the error inside the same turn, while it still has the context to fix it.
//
// `no-delivery` is deliberately NOT rejected: a job with no delivery block is legitimate for
// side-effect work, and most legacy OpenClaw jobs have none. It stays visible via the
// CronJobsMisconfigured gauge instead.
const REJECTABLE = {
  [DELIVERY_STATUS.ANNOUNCE_MISSING_CHANNEL]:
    "delivery.mode 'announce' has nowhere to post. Usually you should set NOTHING — the job "
    + 'inherits the channel of the conversation it was created in. To target somewhere else, set '
    + 'delivery.to to a Slack channel id (C…/D…/G…) or a user id (U…, which DMs them). '
    + 'delivery.threadId — not delivery.to — is the thread.',
  [DELIVERY_STATUS.ANNOUNCE_UNUSABLE_CHANNEL]:
    'the delivery target does not resolve to anywhere postable. Slack ids are CASE-SENSITIVE '
    + '(DL1HA3II6V6 resolves, dl1ha3ii6v6 does not). A bare transport name like "slack" or '
    + '"webchat" is not a destination. Usually you should set nothing at all — the job inherits '
    + 'the channel of the conversation it was created in.',
  [DELIVERY_STATUS.UNKNOWN_MODE]:
    "delivery.mode must be 'none' or 'announce'. ('webhook' was removed — it POSTed output to "
    + 'an unvalidated URL and no job used it.)',
};

// Escape hatch for the CRON HYDRATOR (§9b) only. Hydration replays jobs authored under OpenClaw;
// if one of them is already broken, rejecting it would fail the seed, which leaves the agent
// un-hydrated and retrying forever — a cutover blocker. The hydrator sets this header, logs what
// it forced through, and the job still shows up in CronJobsMisconfigured. Agents never set it.
const BYPASS_HEADER = 'x-cron-allow-invalid-delivery';

// jobIds that would collide with a sibling route under `/:agentId/`. A job called `runner` could be
// created but never updated — `PUT /:agentId/runner` is the CRON_RUNNER route, which is declared
// first and wins. Refusing the name is the honest half of that trade; the ordering is the other
// half, and neither works alone.
const RESERVED_JOB_IDS = new Set(['runner']);

function deliveryRejection(job) {
  const { status, mode } = classifyDelivery(job);
  const detail = REJECTABLE[status];
  return detail ? `cron: invalid delivery (${status}) — ${detail}` : null;
}

/**
 * §12c.7 (G7) — reject a NEGATIVE payload.timeoutSeconds.
 *
 * Upstream silently clamps it (`TimeoutSecondsFieldSchema` is `Math.max(0, v)`) and 0 means NO
 * TIMEOUT — so under OpenClaw a typo'd `-1` quietly means "run forever", the exact opposite of what
 * the author intended, and the `< 0 → use the default` branch in resolveAgentTimeoutMs is therefore
 * unreachable from the tool path. We refuse instead: 0 stays a legitimate explicit opt-out of the
 * bound, but you cannot arrive at it by accident.
 *
 * Deliberately NOT rejected: an unknown `model`. The runtime falls back to the agent's configured
 * model, and rejecting here would mean a model id that merely postdates the pinned pi-ai catalog
 * (as agent-k4wmx6's `claude-opus-4-8` does) could not be authored at all.
 */
function payloadRejection(job) {
  const p = (job && job.payload) || {};
  const t = p.timeoutSeconds;
  if (t === undefined || t === null) return null;
  if (typeof t !== 'number' || !Number.isFinite(t)) {
    return 'cron: payload.timeoutSeconds must be a finite number of seconds (omit it for the default, or 0 for no timeout).';
  }
  if (t < 0) {
    return 'cron: payload.timeoutSeconds cannot be negative. Omit it for the default (60 min for '
      + 'an agentTurn, 10 min otherwise), or set exactly 0 to mean NO timeout.';
  }
  return null;
}

/** Both add/update gates in one call, so the two routes cannot drift. */
function requestRejection(job) {
  return deliveryRejection(job) || payloadRejection(job);
}

function createCronApi(deps) {
  const { service } = deps;
  const log = deps.log || { info() {}, warn() {}, error() {} };
  const router = express.Router();

  // A validation error from the service (bad schedule / missing ids) is a 400;
  // anything else is a 500.
  function fail(res, err, child) {
    const msg = String(err && err.message);
    const client = /cron:|requires agentId|schedule/i.test(msg);
    child.warn({ err: msg, client }, 'cron api error');
    res.status(client ? 400 : 500).json({ ok: false, error: msg });
  }

  router.post('/', (req, res) => {
    const child = log.child ? log.child({ op: 'cron.add' }) : log;
    const job = req.body || {};
    if (!job.agentId || !job.jobId) {
      return res.status(400).json({ ok: false, error: 'cron: agentId and jobId required' });
    }
    if (RESERVED_JOB_IDS.has(String(job.jobId))) {
      return res.status(400).json({ ok: false, error: `cron: "${job.jobId}" is a reserved jobId — it would collide with the /${job.jobId} route and the job could never be updated` });
    }
    const bypass = req.get(BYPASS_HEADER) === '1';
    const rejection = requestRejection(job);
    if (rejection && !bypass) {
      child.warn({ agentId: job.agentId, jobId: job.jobId, rejection }, 'cron api rejected an invalid delivery at add time');
      return res.status(400).json({ ok: false, error: rejection });
    }
    if (rejection && bypass) {
      child.warn({ agentId: job.agentId, jobId: job.jobId, rejection }, 'cron api FORCED an invalid delivery through (hydrator bypass)');
    }
    try {
      const saved = service.add(job);
      return res.json({ ok: true, job: saved });
    } catch (err) {
      return fail(res, err, child);
    }
  });

  router.get('/:agentId', (req, res) => {
    const { agentId } = req.params;
    const jobs = service.list().filter((j) => j.agentId === agentId);
    res.json({ ok: true, jobs });
  });

  // Wipe one agent's store: every job disarmed and deleted, and the file behind them removed.
  //
  // DELIBERATELY NOT `DELETE /:agentId/:jobId` WITH A WILDCARD. This is a different operation with a
  // different blast radius, and it should be impossible to reach by fat-fingering a jobId.
  //
  // It exists for hydration (§E1): while OpenClaw remains authoritative, archie's store is a derived
  // REPLICA, so the useful operation is converge-on-EFS — purge, then re-seed. Without the purge a
  // re-run is a merge, and a job deleted from EFS since the last run would survive in archie forever.
  //
  // Sole-writer holds: this runs INSIDE the dispatcher, like every other write. A task deleting the
  // files directly could not work — the in-memory cache is authoritative and write-through, so the
  // next persist would put them straight back.
  router.delete('/:agentId', (req, res) => {
    const child = log.child ? log.child({ op: 'cron.purge' }) : log;
    const { agentId } = req.params;
    try {
      const result = service.purgeAgent(agentId);
      child.warn({ ...result }, 'cron: agent store purged');
      return res.json({ ok: true, ...result });
    } catch (err) {
      return fail(res, err, child);
    }
  });

  // ── CRON_RUNNER (§3a') ──────────────────────────────────────────────────────────────────────
  //
  // REGISTERED BEFORE `/:agentId/:jobId`, and that ordering is load-bearing: express matches in
  // declaration order, so with these below, `PUT /dm-u123/runner` would bind `jobId = 'runner'` and
  // quietly update a job by that name instead. `RESERVED_JOB_IDS` closes the other half — a job
  // actually called `runner` would be unreachable through the per-job routes.
  //
  // GET reports the resolved value INCLUDING where it came from ('store' = somebody decided,
  // anything else = the openclaw fallback), because "nobody has flipped this scope yet" and "this
  // scope is pinned to openclaw" are operationally different and look identical in the value alone.
  router.get('/:agentId/runner', async (req, res) => {
    const child = log.child ? log.child({ op: 'cron.runner.get' }) : log;
    try {
      const rec = await service.getRunner(req.params.agentId);
      return res.json({ ok: true, ...rec });
    } catch (err) {
      return fail(res, err, child);
    }
  });

  // PUT moves a scope's schedule between the two stacks, so it is deliberately explicit about who
  // asked (`by`) and about which of the two writes it is doing:
  //   {runner}                  set it — a cutover decision, overwrites whatever is there.
  //   {runner, ifAbsent: true}  seed the default — used by hydration, never overwrites a decision.
  router.put('/:agentId/runner', async (req, res) => {
    const child = log.child ? log.child({ op: 'cron.runner.set' }) : log;
    const { agentId } = req.params;
    const body = req.body || {};
    try {
      const result = body.ifAbsent
        ? await service.setDefaultRunner(agentId, { runner: body.runner, by: body.by })
        : await service.setRunner(agentId, body.runner, { by: body.by });
      return res.json({ ok: true, ...result });
    } catch (err) {
      return fail(res, err, child);
    }
  });

  router.put('/:agentId/:jobId', (req, res) => {
    const child = log.child ? log.child({ op: 'cron.update' }) : log;
    const { agentId, jobId } = req.params;
    const job = { ...(req.body || {}), agentId, jobId };
    const rejection = requestRejection(job);
    if (rejection && req.get(BYPASS_HEADER) !== '1') {
      child.warn({ agentId, jobId, rejection }, 'cron api rejected an invalid job on update');
      return res.status(400).json({ ok: false, error: rejection });
    }
    try {
      const saved = service.update(job);
      return res.json({ ok: true, job: saved });
    } catch (err) {
      return fail(res, err, child);
    }
  });

  router.delete('/:agentId/:jobId', (req, res) => {
    const { agentId, jobId } = req.params;
    service.remove(keyOf(agentId, jobId));
    res.json({ ok: true });
  });

  router.post('/:agentId/:jobId/run', async (req, res) => {
    const child = log.child ? log.child({ op: 'cron.run' }) : log;
    const { agentId, jobId } = req.params;
    try {
      const final = await service.runNow(keyOf(agentId, jobId));
      return res.json({ ok: true, final });
    } catch (err) {
      return fail(res, err, child);
    }
  });

  return router;
}

module.exports = { createCronApi, deliveryRejection, payloadRejection, requestRejection };

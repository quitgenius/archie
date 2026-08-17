'use strict';

// The App Home "Jobs" tab, backed by the dispatcher's OWN cron service.
//
// WHY THIS EXISTS. The Jobs tab used to reach the per-agent OpenClaw gateway over HTTP:
// `AGENT_URLS[agent]` + `/admin/cron/{list,run,toggle,remove}`. Under AgentCore there are no agent
// gateways — `AGENT_URLS` is `{}` — so the tab was WHOLLY DEAD: `fetchAgentCronJobs` returned null and
// the tab rendered ":warning: Could not load scheduled jobs. Your agent may be restarting." forever,
// while Run/Pause/Delete each threw `no agent URL` and silently did nothing.
//
// The fix removes a network hop rather than adding one. The dispatcher already OWNS the cron store
// (cron-store.js, EFS-backed, sole writer, authoritative in-memory cache) and already drives it through
// cronService — the same object cron-api.js exposes to the agents' cron tool. So the tab reads and writes
// in-process, exactly as the Skills and Model tabs write DynamoDB in-process. No HTTP, no cache to go
// stale, and nothing left that can fail with a transport error.
//
// TWO THINGS THAT CHANGE MEANING, both easy to get wrong:
//
//  1. `job.id` IS NOW COMPOSITE. OpenClaw jobIds are only per-agent unique, so the store keys on
//     `${agentId}::${jobId}` (cron-store keyOf) and `list()` returns that as `id`. The Slack buttons
//     carry `job.id`, so the handlers now receive a composite id and must pass it straight to
//     service.runNow/remove — NOT wrap it in keyOf() again, which is what the HTTP API does with its
//     bare-jobId route params.
//
//  2. THE OWNERSHIP CHECK USED TO BE STRUCTURAL. Addressing the agent's own gateway meant a job id
//     could only ever resolve within that agent. Reading from one shared store removes that, so every
//     lookup here re-establishes it explicitly: a job whose `agentId` is not the caller's resolved
//     home agent is treated as absent. Same reasoning as the Conversations tab's thread-ownership
//     guard. Slack echoes action values we rendered, so this is defence in depth rather than a live
//     hole — which is exactly why it must not be dropped silently.

/**
 * @param {object} opts
 * @param {object} opts.service   the cronService (list/runNow/update/remove)
 * @param {object} [opts.logger]  pino-style logger
 */
function createCronHome({ service, logger } = {}) {
  const log = logger || { warn() {}, error() {}, info() {} };

  /**
   * Every job belonging to `agentId`.
   *
   * Returns `[]` for "this agent has no jobs" and `null` ONLY for "we could not find out" — the view
   * renders those differently (empty state vs. a "could not load" warning), and conflating them is how
   * the dead HTTP path ended up telling every user their agent was restarting.
   */
  function list(agentId) {
    if (!agentId) return null;
    if (!service || typeof service.list !== 'function') return null;
    try {
      return service.list().filter((j) => j && j.agentId === agentId);
    } catch (err) {
      log.warn({ agent: agentId, err: err.message }, 'cron home: list failed');
      return null;
    }
  }

  /**
   * One job by its composite id, scoped to the caller's agent. Null if it does not exist OR belongs to
   * another agent — the caller cannot tell those apart, which is the point.
   */
  function get(agentId, id) {
    const jobs = list(agentId);
    if (!jobs) return null;
    return jobs.find((j) => j.id === id) || null;
  }

  /** Fire a job now. Resolves to the run's final event; rejects if the job is not the caller's. */
  async function run(agentId, id) {
    const job = get(agentId, id);
    if (!job) throw new Error(`cron job not found for ${agentId}: ${id}`);
    return service.runNow(job.id);
  }

  /**
   * Pause/resume. `enabled` is the DESIRED state, passed through from the button that rendered it,
   * so a double-click cannot flip it twice — the second press asks for the same state it already saw.
   */
  function toggle(agentId, id, enabled) {
    const job = get(agentId, id);
    if (!job) throw new Error(`cron job not found for ${agentId}: ${id}`);
    // update() shallow-merges onto the stored record, so this touches `enabled` and nothing else.
    return service.update({ id: job.id, agentId: job.agentId, jobId: job.jobId, enabled: !!enabled });
  }

  /**
   * The scope's CRON_RUNNER — which scheduler fires its jobs (§3a', cron-runner-flag.js).
   *
   * Never throws: the Jobs tab has to render for a dispatcher with no config table, and a banner
   * that cannot be drawn must not take the whole tab with it. Unreadable resolves to the same
   * `openclaw` every other reader falls back to, so the banner can only ever UNDER-state archie's
   * ownership — it will never tell someone their jobs are firing here when they are not.
   */
  async function getRunner(agentId) {
    if (!agentId || !service || typeof service.getRunner !== 'function') return null;
    try {
      return await service.getRunner(agentId);
    } catch (err) {
      log.warn({ agent: agentId, err: err.message }, 'cron home: runner read failed');
      return null;
    }
  }

  /**
   * Move this scope's schedule between the two stacks. `userId` is recorded as `setBy` — this is a
   * cutover action, and "who moved this agent" is the first question anyone asks afterwards.
   *
   * Deliberately NOT scoped to a job: the flag is per scope, and the caller's own home agent is the
   * only scope App Home can address (homeAgentFor), so the ownership check the job helpers make by
   * hand is structural here.
   */
  function setRunner(agentId, runner, userId) {
    if (!agentId) throw new Error('cron home: no agent for this user');
    return service.setRunner(agentId, runner, { by: userId || 'app-home' });
  }

  /** Delete a job. */
  function remove(agentId, id) {
    const job = get(agentId, id);
    if (!job) throw new Error(`cron job not found for ${agentId}: ${id}`);
    return service.remove(job.id);
  }

  return { list, get, run, toggle, remove, getRunner, setRunner };
}

module.exports = { createCronHome };

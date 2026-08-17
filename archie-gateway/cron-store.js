'use strict';

// EFS-backed cron store (pi-cron-migration-plan.md §3b/§3c). Persists the dispatcher's
// job set on its OWN EFS mount (/efs/cron/<agentId>.json), NOT DynamoDB — consistent
// with all other clawdbot state being EFS JSON, zero new infra.
//
// Implements the SYNCHRONOUS store interface the runner expects
// (list/get/put/delete/patchState). Sync fs is deliberate and SAFE here:
//   * it matches the established pattern (token-store.ts / cron-entity-store.ts),
//   * a read-modify-write with no await gap can't interleave on JS's single thread,
//   * atomic tmp+rename prevents torn files,
//   * SOLE-WRITER + single dispatcher instance (§3d) rules out multi-process races,
// so no mutex is needed for in-process consistency.
//
// Reads are served from an in-memory cache that `load()` populates at boot; because
// the dispatcher is the sole writer, the cache is authoritative and writes are
// write-through. `load()` is also what feeds the runner's boot-recovery.
//
// Job identity: the runner keys on a GLOBALLY-unique `id`. OpenClaw jobIds are only
// per-agent unique, so the store composes id = `${agentId}::${jobId}` and keeps the
// original `jobId` + `agentId` as fields (the agent-local EFS mirror and delivery use
// those). On-disk each agent file is keyed by the bare jobId.

const nodeFs = require('node:fs');
const path = require('node:path');

const VERSION = 1;
const SEP = '::';

// `load()` derives an agentId from a FILENAME, so anything ending `.json` in this directory becomes
// an agent. That is why `_`-prefixed names are skipped: `_hydration.json` used to live here (the
// flip-time marker, removed 2026-08-16) and would otherwise have loaded as an agent called
// `_hydration`.
//
// Nothing writes such a file today, and no deployment holds one — archie's state directory moved to
// /archie/gateway in the rename and was created empty, and there is one archie per account. The skip
// is kept anyway because the hazard is not really the old marker: it is that this directory lives on
// SHARED EFS and the mapping from filename to agentId is unconditional. A `_` prefix is the one
// namespace an agentId can never occupy, so it stays reserved for anything that is not an agent.

function keyOf(agentId, jobId) {
  return `${agentId}${SEP}${jobId}`;
}

/**
 * @param opts.dir  directory for per-agent files (default /efs/cron).
 * @param opts.fs   fs module (injectable; defaults to node:fs).
 * @param opts.log  optional pino-shaped logger.
 */
function createCronStore(opts = {}) {
  const dir = opts.dir || '/efs/cron';
  const fs = opts.fs || nodeFs;
  const log = opts.log || { info() {}, warn() {}, error() {} };

  const cache = new Map(); // id -> job (enriched: id, agentId, jobId, state, …)
  let writeSeq = 0; // per-write nonce → unique tmp names (see atomicWrite)

  function agentFile(agentId) {
    return path.join(dir, `${agentId}.json`);
  }


  function ensureDir() {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Atomic write via a PER-WRITE-UNIQUE tmp + rename. The tmp name MUST be unique per
  // writer — a fixed `<target>.tmp` crashes when two writers race it: writer A renames
  // its tmp onto the target (tmp now gone), writer B's renameSync then hits ENOENT and,
  // running in a setTimeout callback, takes the whole process down. Two writers is not
  // hypothetical even at desired_count=1: an ECS restart briefly overlaps the draining
  // old task and the new task, and both run the cron scheduler (§3d). A unique tmp lets
  // each writer's rename stand on its own (last-writer-wins on the target — fine for the
  // near-identical run-state both are writing). Live-surfaced by the P3 restart test.
  function atomicWrite(target, text) {
    ensureDir();
    writeSeq += 1;
    const tmp = `${target}.${process.pid}.${writeSeq}.tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, target);
    } catch (err) {
      // best-effort cleanup of our own tmp if the rename failed for any reason
      try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
      throw err;
    }
  }

  function readAgentFile(agentId) {
    try {
      const raw = fs.readFileSync(agentFile(agentId), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.jobs && typeof parsed.jobs === 'object') {
        return parsed;
      }
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        log.error({ agentId, err: String(err && err.message) }, 'cron-store: unreadable agent file — starting empty');
      }
    }
    return { version: VERSION, agentId, jobs: {} };
  }

  function writeAgentFile(agentId, file) {
    atomicWrite(agentFile(agentId), JSON.stringify(file, null, 2));
  }

  // Rebuild a whole agent file from the cache (only that agent's jobs).
  function persistAgent(agentId) {
    const jobs = {};
    for (const job of cache.values()) {
      if (job.agentId === agentId) jobs[job.jobId] = strip(job);
    }
    if (Object.keys(jobs).length === 0) {
      // no jobs left for this agent — remove the file rather than leave an empty shell
      try { fs.unlinkSync(agentFile(agentId)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      return;
    }
    writeAgentFile(agentId, { version: VERSION, agentId, jobs });
  }

  // On-disk form: bare jobId key, no derived fields.
  function strip(job) {
    const { id, agentId, jobId, ...rest } = job;
    return rest;
  }

  function enrich(agentId, jobId, stored) {
    return { ...stored, id: keyOf(agentId, jobId), agentId, jobId, state: stored.state || {} };
  }

  // ── Public interface ──────────────────────────────────────────────────────

  /** Populate the cache from disk. Returns the number of jobs loaded. */
  function load() {
    cache.clear();
    let files = [];
    try { files = fs.readdirSync(dir); } catch (err) {
      if (err.code === 'ENOENT') return 0; // no dir yet
      throw err;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (f.startsWith('_')) continue; // reserved: not an agent file — see the note above
      const agentId = f.slice(0, -'.json'.length);
      const file = readAgentFile(agentId);
      for (const [jobId, stored] of Object.entries(file.jobs)) {
        const job = enrich(agentId, jobId, stored);
        cache.set(job.id, job);
      }
    }
    log.info({ count: cache.size }, 'cron-store: loaded');
    return cache.size;
  }
  function list() {
    return [...cache.values()];
  }

  function get(id) {
    return cache.get(id);
  }

  function put(job) {
    if (!job || !job.agentId || !job.jobId) {
      throw new Error('cron-store.put: job requires agentId and jobId');
    }
    const enriched = enrich(job.agentId, job.jobId, { ...job, state: job.state || (cache.get(keyOf(job.agentId, job.jobId)) || {}).state || {} });
    cache.set(enriched.id, enriched);
    persistAgent(job.agentId);
    return enriched;
  }

  function del(id) {
    const job = cache.get(id);
    if (!job) return;
    cache.delete(id);
    persistAgent(job.agentId);
  }

  /**
   * Unlink an agent's file, whatever the cache thinks.
   *
   * `persistAgent` already removes the file when an agent's last job is deleted, so after a full
   * per-job purge this is normally a no-op. It exists for the leftover case — a file on disk with no
   * corresponding cache entries — because a purge that leaves one behind is not a purge: `load()` on
   * the next restart would read it straight back in.
   *
   * @returns true if a file was actually removed.
   */
  function purgeFile(agentId) {
    try {
      fs.unlinkSync(agentFile(agentId));
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw err;
    }
  }

  function patchState(id, patch) {
    const job = cache.get(id);
    if (!job) return;
    job.state = { ...job.state, ...patch };
    // prune undefined so the file stays clean
    for (const k of Object.keys(job.state)) if (job.state[k] === undefined) delete job.state[k];
    // patchState runs from timer callbacks (arm / post-fire run-state). A persist failure
    // here must NOT crash the always-on dispatcher — the in-memory cache stays authoritative
    // and the next successful write catches up. (put/delete, driven by the manager API, keep
    // propagating so the API caller learns a durable write failed.)
    try {
      persistAgent(job.agentId);
    } catch (err) {
      log.error({ id, err: String(err && err.message) }, 'cron-store: patchState persist failed (non-fatal, cache kept)');
    }
  }

  return { load, list, get, put, delete: del, patchState, purgeFile, _dir: dir, keyOf };
}

module.exports = { createCronStore, keyOf };

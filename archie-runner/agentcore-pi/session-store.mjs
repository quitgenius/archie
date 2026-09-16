// Session key -> transcript resolver for cross-boot restore.
//
// WHY THIS IS ONE FILE PER KEY, and not the single `sessions.json` index it used to be.
//
// The old design mirrored OpenClaw's index: one JSON object holding every session, updated by
// read-modify-write (read 700KB, mutate one key, write a temp, rename over). The rename is atomic;
// the read-modify-write around it is not. Every writer that started from a stale read silently threw
// away every entry written since — and the writers are numerous and genuinely concurrent: parallel
// Slack threads, spawned suagent-zh8hwws, cron fires, and (while both stacks run) the OpenClaw gateway
// writing the same file from a different container.
//
// MEASURED, not theorised (2026-09-16, agent-xx9aff): 741 Pi transcripts on disk and ZERO of
// this runtime's keys surviving in the shared index. Restore had never once succeeded for that agent
// across ~75 runtime generations. The transcripts were always fine — only the index was lost.
//
// WHY NOT AN APPEND-ONLY LOG, which is the usual fix for a contended index: O_APPEND atomicity is a
// LOCAL filesystem guarantee. These writers are in separate microVMs, i.e. separate NFS clients, and
// an NFSv4.1 client computes the append offset itself from a cached size — so concurrent appends from
// different clients can interleave or overwrite. It would also mean scanning a growing log on every
// cold boot to find one key, on EFS, and compacting it forever.
//
// ONE FILE PER KEY has no shared mutable state at all: a session only ever writes its OWN pointer, so
// two threads touch two different files and cannot interact. Isolation by construction, not by
// locking. Resolution is a single small read rather than a scan.
//
// NO OPENCLAW INTEROP (2026-09-16). That decision is what makes this possible — the shared file existed ONLY for rollback
// symmetry with the ECS gateway. We no longer read or write OpenClaw's `sessions.json`, which also
// means we stop corrupting it while both stacks run.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const norm = (k) => String(k).toLowerCase();

/** Where a key's pointer lives. Hashed so any key shape is a safe, fixed-length filename. */
export function indexPathFor(sessionsDir, key) {
  const h = createHash('sha256').update(norm(key)).digest('hex').slice(0, 32);
  return path.join(sessionsDir, 'index', `${h}.json`);
}

/**
 * Resolve a logical key to its transcript.
 *
 * `found` is true only when the pointer AND the transcript both exist — a pointer to a file that is
 * gone is not a restorable session, and reporting it as one would make the adapter open nothing.
 */
export function resolveSessionPath({ sessionsDir, key }) {
  const pointerPath = indexPathFor(sessionsDir, key);
  let entry = null;
  try { entry = JSON.parse(fs.readFileSync(pointerPath, 'utf8')); } catch { /* no pointer yet */ }
  if (!entry || !entry.sessionId) return { found: false, matchedKey: null, pointerPath, entry: null };
  // Stored as a BASENAME and resolved against the live sessions dir: the mount path differs between
  // the ECS and AgentCore layouts, so an absolute path recorded by one is wrong for the other.
  const file = entry.sessionFile
    ? path.join(sessionsDir, path.basename(entry.sessionFile))
    : path.join(sessionsDir, `${entry.sessionId}.jsonl`);
  return { found: fs.existsSync(file), path: file, sessionId: entry.sessionId, matchedKey: key, pointerPath, entry };
}

/**
 * Point a key at its transcript. Writes ONLY this key's file.
 *
 * Still temp-and-rename, for a different reason than before: not to win a race — there is no longer
 * a race — but so a crash mid-write cannot leave a truncated pointer that would read as "no session"
 * and silently start the conversation over.
 *
 * THROWS on failure rather than returning. The caller decides, and it must not be able to treat a
 * lost pointer as normal: a swallowed failure here is exactly how this went unnoticed for months.
 */
export function writeIndexEntry({ sessionsDir, key, sessionId, sessionFile, updatedAt }) {
  const pointerPath = indexPathFor(sessionsDir, key);
  fs.mkdirSync(path.dirname(pointerPath), { recursive: true });
  const body = {
    key: norm(key),
    sessionId,
    // Basename only — see resolveSessionPath.
    sessionFile: sessionFile ? path.basename(sessionFile) : undefined,
    updatedAt: updatedAt || new Date().toISOString(),
  };
  const tmp = `${pointerPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2));
  fs.renameSync(tmp, pointerPath);
  return pointerPath;
}

// Session key->file resolver for cross-boot restore (task #4), OpenClaw-compatible.
//
// OpenClaw keys a session (e.g. slack:thread:<ch>:<ts>, normalized lowercase) via an
// INDEX at <sessionsDir>/sessions.json, transcript in a separate <uuid>.jsonl. Pi has no
// key/index — it opens by path. This reproduces the mapping so the Pi adapter can (a)
// continue an existing session on a fresh microVM and (b) MAINTAIN the index so a
// rollback to the ECS gateway still finds Pi-created sessions. See pi-core-migration-plan §5.
//
// Cross-runtime index bridge (verified 2026-07-21 by diffing live OpenClaw vs Pi
// sessions): the TRANSCRIPT format is identical (both v3 event-log JSONL), so the only
// gap is two sessions.json shape differences:
//   1. KEY: OpenClaw wraps the logical key as `agent:<agentName>:<key>`; Pi writes it raw.
//   2. sessionFile: OpenClaw stores an ABSOLUTE in-container path
//      (/app/.openclaw/.openclaw/agents/<agent>/sessions/<uuid>.jsonl); Pi stores a basename.
// resolveSessionPath bridges both so a Pi lookup finds an OpenClaw-written entry (and vice
// versa). Extra OpenClaw fields (skillsSnapshot/origin/deliveryContext/...) are preserved
// on write so a rollback to ECS still finds a well-formed entry.

import fs from 'node:fs';
import path from 'node:path';

const norm = (k) => String(k).toLowerCase();
// OpenClaw wraps the conversation key as `agent:<agentName>:<logicalKey>`. Strip an
// optional leading `agent:<name>:` to recover the logical key for matching.
const stripAgentWrap = (k) => String(k).replace(/^agent:[^:]+:/i, '');

export function resolveSessionPath({ sessionsDir, key }) {
  const storePath = path.join(sessionsDir, 'sessions.json');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { /* no store yet */ }
  const want = norm(key);
  // Match order: (1) exact raw (Pi's own entry), (2) normalized, (3) OpenClaw-wrapped
  // entry whose logical key (after stripping `agent:<name>:`) equals the lookup key.
  let matchedKey = null;
  if (store[key]) matchedKey = key;
  else if (store[want]) matchedKey = want;
  else matchedKey = Object.keys(store).find((k) => norm(stripAgentWrap(k)) === want) ?? null;
  if (!matchedKey) return { found: false, matchedKey: null, storePath, store };
  const entry = store[matchedKey];
  // sessionFile may be absolute (OpenClaw) or a basename (Pi) — resolve the BASENAME
  // against the local sessions dir so it points at the mounted transcript either way.
  const file = entry.sessionFile
    ? path.join(sessionsDir, path.basename(entry.sessionFile))
    : path.join(sessionsDir, `${entry.sessionId}.jsonl`);
  return { found: fs.existsSync(file), path: file, sessionId: entry.sessionId, matchedKey, storePath, store };
}

// Write/update the index entry. When `indexKey` is given (the key resolveSessionPath
// matched — e.g. an OpenClaw-wrapped key), update THAT entry in place so we don't orphan
// it (bidirectional maintenance); otherwise write under the normalized logical key.
// Preserves any pre-existing fields on the entry (OpenClaw's extra metadata).
export function writeIndexEntry({ sessionsDir, key, sessionId, sessionFile, updatedAt, indexKey }) {
  const storePath = path.join(sessionsDir, 'sessions.json');
  let store = {};
  try { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); } catch { /* new store */ }
  const target = indexKey || norm(key);
  const prev = store[target] || {};
  store[target] = { ...prev, sessionId, sessionFile, updatedAt: updatedAt || new Date().toISOString() };
  const tmp = `${storePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, storePath); // atomic-ish; avoids a torn index if we crash mid-write
  return storePath;
}

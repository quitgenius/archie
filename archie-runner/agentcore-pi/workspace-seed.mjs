// Phase 3 — guarded EFS workspace seed for AgentCore/Pi boots.
// The authored baseline comes from the
// DDB AGENT#<id>/SEED item (existing agent) or the baked generic skeleton (brand-new agent);
// EFS remains the LIVE source of truth (plan §9).
//
// The mount tiers (deliberate, see plan §9):
//   - CHEAP FLOOR (always, done by the caller's waitForEfsMount): statfs == 0x6969 real NFS.
//     This disambiguates "workspace empty" from "wrong/overlay filesystem" — the silent
//     data-loss trap. seedWorkspace runs only AFTER that floor passes.
//   - EXPENSIVE VERIFY (once, seed path only): verifyMount() — right fs/AP. Skipped entirely
//     when the workspace already exists, because existence is itself proof of a prior verified
//     mount (files were either created on, or just read from, a real mount).
//
// Pure logic with injected side-effects (readSeedManifest / persistSeed / verifyMount) so it
// unit-tests without DDB or EFS. The adapter wires the real DDB client + SDK mount check.

import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

const INIT_MARKER = 'AGENTS.md'; // every agent has one (verified: 207/207) → the "initialised" flag
// The EFS access point's PosixUser — files must be owned OWNER_UID:OWNER_GID. 1000:1000 in the
// image (USER openclaw + the AP's PosixUser); overridable for local tests running as another uid.
const OWNER_UID = Number(process.env.SEED_OWNER_UID ?? 1000);
const OWNER_GID = Number(process.env.SEED_OWNER_GID ?? 1000);

const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const full = join(dir, e.name);
  return e.isDirectory() ? walk(full, base) : [relative(base, full)];
});

// Read the baked generic skeleton, substituting the agent name into the placeholder token.
export function readSkeleton(skeletonDir, agentName) {
  const files = {};
  for (const rel of walk(skeletonDir)) {
    files[rel] = readFileSync(join(skeletonDir, rel), 'utf-8').split('__AGENT_NAME__').join(agentName);
  }
  return files;
}

function assertPerms(efsDir, rel) {
  const st = statSync(join(efsDir, rel));
  if (st.uid !== OWNER_UID || st.gid !== OWNER_GID) {
    throw new Error(`seed guard FATAL: ${rel} owned ${st.uid}:${st.gid}, expected ${OWNER_UID}:${OWNER_GID}`);
  }
}

function writeFiles(efsDir, files, log) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(efsDir, rel);
    mkdirSync(dirname(dest), { recursive: true });
    if (existsSync(dest)) continue; // no-clobber: never overwrite live EFS state
    writeFileSync(dest, content);
  }
  log({ level: 'info', component: 'workspace-seed', msg: 'seed files written', n: Object.keys(files).length, dir: efsDir });
}

export async function seedWorkspace({
  efsDir, agentName, skeletonDir,
  readSeedManifest,          // async (agentName) => { files } | null   (DDB SEED item)
  persistSeed,               // async (agentName, files) => void        (write DDB for a brand-new agent)
  verifyMount,               // async () => void  — the expensive once; throws (FATAL) if wrong
  log = () => {},
}) {
  const initialised = existsSync(join(efsDir, INIT_MARKER));

  if (initialised) {
    // Workspace already seeded on a (necessarily) real mount → assert completeness + perms of
    // the expected set, then load. Content may have diverged (persona edits, MEMORY growth) and
    // extra files (memory/, sessions/) are fine — check the seed set only. No expensive verify.
    const manifest = await readSeedManifest(agentName);
    if (!manifest || !manifest.files) {
      log({ level: 'warn', component: 'workspace-seed', msg: 'initialised workspace but no DDB SEED manifest to verify against — loading as-is', agent: agentName });
      return { action: 'loaded', verified: false };
    }
    for (const rel of Object.keys(manifest.files)) {
      if (!existsSync(join(efsDir, rel))) throw new Error(`seed guard FATAL: expected seed file missing from EFS: ${rel}`);
      assertPerms(efsDir, rel);
    }
    log({ level: 'info', component: 'workspace-seed', msg: 'workspace verified complete', agent: agentName, files: Object.keys(manifest.files).length });
    return { action: 'loaded', verified: true };
  }

  // Fresh workspace → the expensive mount verification runs exactly here, once.
  await verifyMount();

  const manifest = await readSeedManifest(agentName);
  if (manifest && manifest.files) {
    writeFiles(efsDir, manifest.files, log);
    return { action: 'seeded-from-ddb', files: Object.keys(manifest.files).length };
  }

  // Brand-new agent: seed from the baked skeleton, then persist to DDB so it becomes the
  // reproducible source of truth (internal decision).
  const files = readSkeleton(skeletonDir, agentName);
  writeFiles(efsDir, files, log);
  if (persistSeed) await persistSeed(agentName, files);
  return { action: 'seeded-from-skeleton', files: Object.keys(files).length };
}

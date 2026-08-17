// Phase 4 — versioned, write-once skill sync from DynamoDB onto the agent's EFS skills dir.
//
// Skills are a FLEET-WIDE library (every agent loads all of them). They live in DDB as
// SKILL#<name> items with a content hash `version`, indexed by a small SKILL#_manifest
// (name → version). This materializes them onto EFS (persistent across the microVM's cold
// boots) so:
//   - the FIRST cold boot of an agent pays one DDB read + writes the library to EFS;
//   - every later cold boot reads only the manifest (small) + an on-disk marker, sees nothing
//     changed, and skips — no per-boot re-copy, no throwaway temp dir;
//   - a `hydrate` that changes a skill bumps its version → the next boot re-materializes JUST
//     that skill (and prunes skills dropped from DDB), so updates propagate.
//
// Pure logic with injected side-effects (readManifest / readSkill) so it unit-tests without
// DDB or EFS. The adapter wires the real DDB client.

import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';

const MARKER = '.skill-versions.json'; // {name: version} last materialized onto this EFS dir

function readMarker(skillsDir) {
  try { return JSON.parse(readFileSync(join(skillsDir, MARKER), 'utf8')); } catch { return {}; }
}

export async function syncSkills({
  skillsDir,
  readManifest,   // async () => { skills: {name: version}, catalogVersion } | null
  readSkill,      // async (name) => { files: {relpath: content}, version } | null
  log = () => {},
}) {
  const manifest = await readManifest();
  if (!manifest || !manifest.skills) {
    log({ level: 'warn', component: 'skill-sync', msg: 'no DDB skill manifest — leaving EFS skills as-is', skillsDir });
    return { action: 'no-manifest', total: 0, written: 0, pruned: 0 };
  }
  mkdirSync(skillsDir, { recursive: true });
  const have = readMarker(skillsDir);   // {name: version} on EFS now
  const want = manifest.skills;         // {name: version} desired

  // (Re)write a skill when its version changed OR its dir is missing (marker/disk drift).
  const toWrite = Object.keys(want).filter((n) => have[n] !== want[n] || !existsSync(join(skillsDir, n)));
  const toPrune = Object.keys(have).filter((n) => !(n in want));

  for (const name of toWrite) {
    const skill = await readSkill(name);
    if (!skill || !skill.files) { log({ level: 'warn', component: 'skill-sync', msg: 'skill in manifest but absent in DDB', name }); continue; }
    rmSync(join(skillsDir, name), { recursive: true, force: true }); // drop stale files removed from the skill
    for (const [rel, content] of Object.entries(skill.files)) {
      const dest = join(skillsDir, name, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
  }
  for (const name of toPrune) rmSync(join(skillsDir, name), { recursive: true, force: true });

  writeFileSync(join(skillsDir, MARKER), JSON.stringify(want));
  const summary = { action: 'synced', total: Object.keys(want).length, written: toWrite.length, pruned: toPrune.length };
  log({ level: 'info', component: 'skill-sync', msg: 'skills synced from DDB', ...summary, skillsDir });
  return summary;
}

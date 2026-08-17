// Unit test for the versioned, write-once skill sync (Phase 4). Pure logic — tmp dirs + injected
// DDB reads, no real DDB/EFS. Run: node skill-sync-test.mjs

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

const { syncSkills } = await import('./skill-sync.mjs');

const mkTmp = () => mkdtempSync(join(tmpdir(), 'skillsync-'));
const noop = () => {};
let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass += 1; };

// A tiny fleet: two skills, each a dir with SKILL.md + a reference file.
const fleet = {
  alpha: { files: { 'SKILL.md': '# alpha', 'reference/a.md': 'A' }, version: 'v-alpha-1' },
  beta: { files: { 'SKILL.md': '# beta', 'scripts/b.sh': 'echo b' }, version: 'v-beta-1' },
};
const manifestFrom = (f) => ({ skills: Object.fromEntries(Object.entries(f).map(([n, s]) => [n, s.version])), catalogVersion: 'cat-1' });
const io = (f) => ({ readManifest: async () => manifestFrom(f), readSkill: async (n) => f[n] || null });

// 1. First boot (empty EFS) → materialize all skills + write the marker.
{
  const dir = mkTmp();
  const r = await syncSkills({ skillsDir: dir, ...io(fleet), log: noop });
  assert.equal(r.action, 'synced');
  assert.equal(r.total, 2);
  assert.equal(r.written, 2, 'both skills written on a cold EFS');
  assert.equal(r.pruned, 0);
  assert.equal(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8'), '# alpha');
  assert.equal(readFileSync(join(dir, 'beta', 'scripts', 'b.sh'), 'utf8'), 'echo b');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, '.skill-versions.json'), 'utf8')), manifestFrom(fleet).skills);
  ok('first boot materializes all skills + marker');

  // 2. Second boot, nothing changed → write-once reuse (no re-writes).
  const r2 = await syncSkills({ skillsDir: dir, ...io(fleet), log: noop });
  assert.equal(r2.written, 0, 'unchanged fleet re-writes nothing (write-once)');
  assert.equal(r2.pruned, 0);
  ok('unchanged fleet is a no-op (write-once reuse)');

  // 3. A skill version bumps (hydrate edited it) → only that skill re-materializes, and stale
  //    files inside it are dropped.
  const edited = { ...fleet, alpha: { files: { 'SKILL.md': '# alpha v2' }, version: 'v-alpha-2' } };
  const r3 = await syncSkills({ skillsDir: dir, ...io(edited), log: noop });
  assert.equal(r3.written, 1, 'only the changed skill re-materializes');
  assert.equal(readFileSync(join(dir, 'alpha', 'SKILL.md'), 'utf8'), '# alpha v2');
  assert.ok(!existsSync(join(dir, 'alpha', 'reference', 'a.md')), 'removed file inside the skill is pruned');
  assert.equal(readFileSync(join(dir, 'beta', 'SKILL.md'), 'utf8'), '# beta', 'untouched skill left alone');
  ok('version bump re-materializes only the changed skill + prunes its stale files');

  // 4. A skill dropped from DDB → pruned from EFS.
  const dropped = { alpha: edited.alpha };
  const r4 = await syncSkills({ skillsDir: dir, ...io(dropped), log: noop });
  assert.equal(r4.pruned, 1, 'skill removed from the manifest is pruned');
  assert.ok(!existsSync(join(dir, 'beta')), 'beta pruned from EFS');
  ok('skill removed from DDB is pruned from EFS');

  // 5. Marker/disk drift: marker says up-to-date but the dir was wiped → re-materialize.
  rmSync(join(dir, 'alpha'), { recursive: true, force: true });
  const r5 = await syncSkills({ skillsDir: dir, ...io(dropped), log: noop });
  assert.equal(r5.written, 1, 're-writes when the dir is missing despite a matching marker');
  assert.ok(existsSync(join(dir, 'alpha', 'SKILL.md')));
  ok('recovers from marker/disk drift');
}

// 6. No manifest (skills not hydrated) → leave EFS as-is, do not throw.
{
  const dir = mkTmp();
  const r = await syncSkills({ skillsDir: dir, readManifest: async () => null, readSkill: async () => null, log: noop });
  assert.equal(r.action, 'no-manifest');
  ok('missing manifest is a safe no-op');
}

console.log(`\nskill-sync: ${pass}/6 passing`);

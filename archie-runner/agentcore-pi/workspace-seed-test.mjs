// Unit test for the guarded EFS workspace seed (Phase 3). Pure logic — tmp dirs + injected
// side-effects, no DDB/EFS. Run: SEED_OWNER_UID=<your uid> node workspace-seed-test.mjs
// (the harness sets it automatically below).

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert';

process.env.SEED_OWNER_UID = String(process.getuid()); // files we write are owned by us
process.env.SEED_OWNER_GID = String(process.getgid()); // (macOS default group != uid)
const { seedWorkspace, readSkeleton } = await import('./workspace-seed.mjs');

const mkTmp = () => mkdtempSync(join(tmpdir(), 'seedtest-'));
const skeletonDir = mkTmp();
writeFileSync(join(skeletonDir, 'AGENTS.md'), '# AGENTS.md — __AGENT_NAME__\nhi __AGENT_NAME__');
writeFileSync(join(skeletonDir, 'IDENTITY.md'), 'agent: __AGENT_NAME__');

const noop = () => {};
let pass = 0;
const ok = (name) => { console.log(`  ✓ ${name}`); pass += 1; };

// 1. Brand-new agent (fresh workspace, no DDB manifest) → seed from skeleton + persist to DDB,
//    with __AGENT_NAME__ substituted.
{
  const efs = mkTmp();
  let persisted = null;
  let verified = false;
  const r = await seedWorkspace({
    efsDir: efs, agentName: 'agent-yaoi5e', skeletonDir,
    readSeedManifest: async () => null,
    persistSeed: async (id, files) => { persisted = { id, files }; },
    verifyMount: async () => { verified = true; },
  });
  assert.equal(r.action, 'seeded-from-skeleton');
  assert.equal(verified, true, 'expensive verify runs on the fresh path');
  assert.ok(readFileSync(join(efs, 'AGENTS.md'), 'utf-8').includes('agent-yaoi5e'), 'placeholder substituted');
  assert.ok(!readFileSync(join(efs, 'AGENTS.md'), 'utf-8').includes('__AGENT_NAME__'));
  assert.equal(persisted.id, 'agent-yaoi5e');
  assert.ok(persisted.files['AGENTS.md'].includes('agent-yaoi5e'), 'DDB gets the substituted content');
  ok('brand-new agent seeds from skeleton, substitutes name, persists to DDB, verifies mount');
}

// 2. Existing agent (fresh EFS, DDB manifest present) → seed from DDB verbatim.
{
  const efs = mkTmp();
  const manifest = { files: { 'AGENTS.md': 'authored prose', 'SOUL.md': 'archie', 'memory/core/x.md': 'nested' } };
  const r = await seedWorkspace({
    efsDir: efs, agentName: 'agent-75lieo', skeletonDir,
    readSeedManifest: async () => manifest,
    persistSeed: async () => { throw new Error('must NOT persist when seeding from DDB'); },
    verifyMount: noop,
  });
  assert.equal(r.action, 'seeded-from-ddb');
  assert.equal(readFileSync(join(efs, 'AGENTS.md'), 'utf-8'), 'authored prose');
  assert.equal(readFileSync(join(efs, 'memory/core/x.md'), 'utf-8'), 'nested', 'nested paths seeded');
  ok('existing agent seeds from DDB manifest (incl nested paths), no re-persist');
}

// 3. Initialised workspace, complete + correct perms → load, NO verify, NO write.
{
  const efs = mkTmp();
  writeFileSync(join(efs, 'AGENTS.md'), 'edited by the agent at runtime'); // content diverged — fine
  writeFileSync(join(efs, 'SOUL.md'), 'x');
  let verified = false;
  const r = await seedWorkspace({
    efsDir: efs, agentName: 'agent-75lieo', skeletonDir,
    readSeedManifest: async () => ({ files: { 'AGENTS.md': 'orig', 'SOUL.md': 'orig' } }),
    persistSeed: async () => { throw new Error('must NOT persist on load'); },
    verifyMount: async () => { verified = true; },
  });
  assert.equal(r.action, 'loaded');
  assert.equal(r.verified, true);
  assert.equal(verified, false, 'expensive verify SKIPPED when workspace already exists');
  assert.equal(readFileSync(join(efs, 'AGENTS.md'), 'utf-8'), 'edited by the agent at runtime', 'live content untouched');
  ok('initialised + complete → loads, skips expensive verify, never clobbers live content');
}

// 4. Initialised but INCOMPLETE (missing an expected file) → FATAL.
{
  const efs = mkTmp();
  writeFileSync(join(efs, 'AGENTS.md'), 'x'); // SOUL.md missing
  await assert.rejects(
    seedWorkspace({
      efsDir: efs, agentName: 'agent-75lieo', skeletonDir,
      readSeedManifest: async () => ({ files: { 'AGENTS.md': 'o', 'SOUL.md': 'o' } }),
      verifyMount: noop,
    }),
    /seed guard FATAL: expected seed file missing/,
  );
  ok('initialised but incomplete → FATAL (fail loud, no silent degrade)');
}

// 5. Initialised, no DDB manifest → load as-is with a warning (transition tolerance).
{
  const efs = mkTmp();
  writeFileSync(join(efs, 'AGENTS.md'), 'x');
  const r = await seedWorkspace({
    efsDir: efs, agentName: 'agent-3t86ii', skeletonDir,
    readSeedManifest: async () => null,
    verifyMount: noop,
  });
  assert.equal(r.action, 'loaded');
  assert.equal(r.verified, false);
  ok('initialised without a DDB manifest → loads as-is (verified:false)');
}

// readSkeleton direct
{
  const files = readSkeleton(skeletonDir, 'zeta');
  assert.ok(files['AGENTS.md'].includes('zeta') && !files['AGENTS.md'].includes('__AGENT_NAME__'));
  ok('readSkeleton substitutes the placeholder');
}

console.log(`\nworkspace-seed: ${pass}/6 tests green ✓`);
[skeletonDir].forEach((d) => rmSync(d, { recursive: true, force: true }));

// Hermetic unit test for the fleet-wide always-on skill logic (skill-scope.mjs). Pure — no DDB/fs.
// Run: node skill-alwayson-test.mjs

import assert from 'node:assert';
import { alwaysOnSkills, withAlwaysOn, skillFingerprint } from './skill-scope.mjs';

let pass = 0;
const ok = (n) => { console.log(`  ✓ ${n}`); pass += 1; };

const manifest = { skills: { 'otel-debug': 'v1', 'daily-briefing': 'v9' }, catalogVersion: 'c1' };

// 1. default list is otel-debug; env overrides / disables it.
{
  delete process.env.AGENTCORE_ALWAYS_ON_SKILLS;
  assert.deepEqual(alwaysOnSkills(), ['otel-debug']);
  process.env.AGENTCORE_ALWAYS_ON_SKILLS = 'otel-debug,foo';
  assert.deepEqual(alwaysOnSkills(), ['otel-debug', 'foo']);
  process.env.AGENTCORE_ALWAYS_ON_SKILLS = '';
  assert.deepEqual(alwaysOnSkills(), []);
  delete process.env.AGENTCORE_ALWAYS_ON_SKILLS;
  ok('alwaysOnSkills defaults to [otel-debug], env overrides + empty disables');
}

// 2. an agent with NO installs still gets otel-debug (fleet-wide + default).
{
  const eff = withAlwaysOn({}, manifest);
  assert.deepEqual(Object.keys(eff), ['otel-debug']);
  const { names } = skillFingerprint(eff, manifest);
  assert.ok(names.includes('otel-debug'));
  ok('agent with zero installs materializes otel-debug');
}

// 3. does not duplicate or clobber an explicit install; adds alongside others.
{
  const eff = withAlwaysOn({ 'daily-briefing': { installedBy: 'system' } }, manifest);
  assert.deepEqual(Object.keys(eff).sort(), ['daily-briefing', 'otel-debug']);
  assert.deepEqual(eff['daily-briefing'], { installedBy: 'system' }, 'existing install untouched');
  ok('always-on unions alongside real installs without clobbering');
}

// 4. a skill NOT in the manifest is skipped (no phantom load, no error).
{
  const eff = withAlwaysOn({}, { skills: { 'daily-briefing': 'v9' } });
  assert.deepEqual(Object.keys(eff), [], 'otel-debug absent from manifest → not added');
  ok('always-on skill missing from manifest is skipped');
}

// 5. fingerprint is stable when the always-on skill is already an install (no double count).
{
  const a = skillFingerprint(withAlwaysOn({ 'otel-debug': { installedBy: 'x' } }, manifest), manifest);
  const b = skillFingerprint(withAlwaysOn({}, manifest), manifest);
  assert.equal(a.fp, b.fp, 'same effective set → same fingerprint whether explicit or always-on');
  ok('fingerprint identical whether otel-debug is explicit or always-on');
}

console.log(`\n${pass} assertions passed`);

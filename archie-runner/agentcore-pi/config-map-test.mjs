// Local (manual, AWS-touching) harness: map a REAL resolved config → Pi session and prove
//   (A) bootstrap MEMORY.md auto-injects into context (the @parity behaviour), and
//   (B) the resolved 'read' tool works (the @toolexec behaviour),
// using ONLY the config-derived model + tools (no hardcoding).
//   AGENT=bdd-tests AGENT_CONFIG_TABLE=agent-config PI_VENDOR_DIR=... AWS_PROFILE=sandbox node config-map-test.mjs
//
// It used to read a config out of a FILE (OC_JSON, a dumped openclaw.json), which stopped being a
// thing the boot path produces. It now resolves from DynamoDB through the same function the runtime
// boots on, so what it exercises is the live path rather than a hand-made snapshot of a dead shape.
// `cwd` comes from env because the resolved config no longer carries `workspace` — that was one of
// the keys the old envelope rendered and nothing read.

import fs from 'node:fs';
import path from 'node:path';
import { registerBedrock, getModel, runTurn, pca } from './pi-runtime.mjs';
import { resolveModelSpec, resolveAllowedTools, buildBuiltinTools, readBootstrapContext, makeResourceLoader } from './config-map.mjs';
import { loadAgentConfig } from './agent-config.mjs';

const AGENT = process.env.AGENT || 'bdd-tests';
const CODENAME = 'MERIDIAN-7';
const FIXCODE = 'CFGMAP-4417';

try {
  const { agent, cfg } = await loadAgentConfig({ agentName: AGENT });
  const { provider, id } = resolveModelSpec(agent, cfg);
  const allow = resolveAllowedTools(agent);
  const cwd = process.env.CFGMAP_CWD || path.join('/tmp', `cfgmap-${AGENT}`);
  console.log('[cfgmap] agent=%s model=%s/%s cwd=%s allow=%j', agent.id, provider, id, cwd, [...allow]);

  // seed the workspace (direct on disk = EFS-equivalent): MEMORY.md + a read-tool fixture
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'MEMORY.md'), `# Memory\n\n## Project\n- Codename: **${CODENAME}** (noted for config-map test)\n`);
  fs.writeFileSync(path.join(cwd, 'tool-fixture.txt'), `config-map read fixture. code is ${FIXCODE}.\n`);

  await registerBedrock();
  const model = getModel(id);
  const bootstrap = readBootstrapContext(cwd);
  const tools = buildBuiltinTools(allow, cwd);
  console.log('[cfgmap] builtin tools=%j bootstrapChars=%d', tools.map((t) => t.name), bootstrap.length);

  const resourceLoader = makeResourceLoader({ cwd, bootstrap });
  if (typeof resourceLoader.reload === 'function') await resourceLoader.reload();
  const { session } = await pca.createAgentSession({
    model,
    tools,
    cwd,
    sessionManager: pca.SessionManager.inMemory(cwd),
    resourceLoader,
  });

  // A) auto-context: the model should know the codename from injected MEMORY.md, no tool call
  const a = await runTurn(session, 'What is the project codename? Reply with ONLY the codename.');
  const okA = a.text.includes(CODENAME);
  console.log('[cfgmap] A auto-context(MEMORY.md) reply=%j -> %s', a.text, okA ? 'PASS' : 'FAIL');

  // B) resolved read tool works over the workspace
  const b = await runTurn(session, 'Use your read tool to read ./tool-fixture.txt and reply with ONLY the code it contains.');
  const okB = b.text.includes(FIXCODE);
  console.log('[cfgmap] B read-tool reply=%j -> %s', b.text, okB ? 'PASS' : 'FAIL');

  // C) tool restriction: a messaging agent must NOT have gained write/bash from Pi defaults
  const hasWrite = tools.some((t) => t.name === 'write' || t.name === 'bash');
  console.log('[cfgmap] C tool-restriction: write/bash present=%s -> %s', hasWrite, hasWrite ? 'FAIL' : 'PASS');

  const ok = okA && okB && !hasWrite;
  console.log(ok ? '[cfgmap] RESULT: PASS ✅' : '[cfgmap] RESULT: FAIL ❌');
  try { session.dispose?.(); } catch {}
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error('[cfgmap] FAILED:', e?.stack || e?.message || String(e));
  process.exit(1);
}

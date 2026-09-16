// The Pi WRAPPER around spawn-tool-core — the half spawn-tool-core-test.mjs does not cover.
//
// Exists because of a live failure (2026-09-16): the tool returned its text as a bare string, which
// is not Pi's tool-result shape. Pi's agent loop then threw `Cannot read properties of undefined
// (reading 'map')`, the turn ended with stopReason=error and no reply, and the agent looked frozen —
// while every spawned child had succeeded. The core was tested; the shape was not.
//
//   node agentcore-pi/spawn-tool-test.mjs
//
import { createSpawnTool } from './spawn-tool.mjs';

let ok = true;
const check = (name, cond, extra) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${extra}`}`); ok = ok && cond; };

const tool = (spawnImpl) => createSpawnTool({ dispatcher: { spawn: spawnImpl }, log: { info() {}, warn() {}, error() {} } });

{
  const t = tool(async () => ({ ok: true, text: 'the child answered' }));
  check('declares its own capability, not runtime', t.capability === 'spawn', t.capability);

  const r = await t.execute('call-1', { prompt: 'go' });
  check('returns Pi\'s tool-result shape, not a bare value', !!r && Array.isArray(r.content), JSON.stringify(r));
  check('content[0] is a text block', r.content[0]?.type === 'text', JSON.stringify(r.content?.[0]));
  check('carries the child\'s answer', r.content[0]?.text === 'the child answered', JSON.stringify(r.content?.[0]));
  check('carries details alongside content', !!r.details, JSON.stringify(r.details));
}

// The failure paths must ALSO be well-shaped — an error returned as a bare string breaks the turn
// exactly as a success would, and those are the paths that run when something is already wrong.
for (const [name, impl] of [
  ['a refusal from the dispatcher', async () => ({ ok: false, error: 'depth cap' })],
  ['an unreachable dispatcher', async () => { throw new Error('ECONNREFUSED'); }],
  ['an empty child answer', async () => ({ ok: true, text: '' })],
]) {
  const r = await tool(impl).execute('c', { prompt: 'go' });
  check(`${name} is still Pi-shaped`, Array.isArray(r?.content) && typeof r.content[0]?.text === 'string', JSON.stringify(r));
}

{
  const r = await tool(async () => ({ ok: true, text: 'x' })).execute('c', {});
  check('a missing prompt is a shaped result, not a throw', Array.isArray(r?.content), JSON.stringify(r));
}

console.log(ok ? 'ALL PASS' : 'FAILURES');
process.exit(ok ? 0 : 1);

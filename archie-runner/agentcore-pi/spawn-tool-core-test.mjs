// sessions_spawn's pi-free half. Hermetic. Run:
//
//   node agentcore-pi/spawn-tool-core-test.mjs
//
import { makeSpawnExecute } from './spawn-tool-core.mjs';

let ok = true;
const check = (name, cond, extra) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  <- ${extra}`}`); ok = ok && cond; };
const exec = (spawnImpl) => makeSpawnExecute({ dispatcher: { spawn: spawnImpl }, log: { info() {}, warn() {}, error() {} } });

// EVERY outcome is a string the model can read. A tool that throws gets retried; one that explains
// gets handled — which matters most for the outcomes that are not bugs (depth cap, budget, timeout).
{
  const r = await exec(async () => ({ ok: true, text: 'the child answered' }))('t', { prompt: 'go' });
  check('returns the child\'s text on success', r === 'the child answered', r);
}
{
  const r = await exec(async () => ({ ok: false, error: 'spawned sessions cannot spawn again (depth 1/1).' }))('t', { prompt: 'go' });
  check('passes the dispatcher\'s refusal through VERBATIM', /cannot spawn again/.test(r), r);
}
{
  const r = await exec(async () => { throw new Error('ECONNREFUSED'); })('t', { prompt: 'go' });
  check('a transport failure is reported, not thrown', /could not reach the dispatcher/.test(r), r);
}
{
  let threw = false;
  try { await exec(async () => { throw new Error('boom'); })('t', { prompt: 'go' }); } catch { threw = true; }
  check('never throws at the tool boundary', threw === false);
}

// An empty answer is a real outcome — a child that did work and said nothing. Returning '' would
// read to the model as a broken tool.
{
  const r = await exec(async () => ({ ok: true, text: '   ' }))('t', { prompt: 'go' });
  check('names an empty answer instead of returning nothing', /returned no text/.test(r), r);
}

{
  const r = await exec(async () => ({ ok: true, text: 'x' }))('t', { prompt: '  ' });
  check('refuses an empty prompt without calling the dispatcher', /prompt is required/.test(r), r);
}

// The caller may ask for less time; the dispatcher caps it against the parent turn regardless.
{
  let seen;
  await exec(async (p, o) => { seen = { p, o }; return { ok: true, text: 'x' }; })('t', { prompt: 'go', timeoutSeconds: 45 });
  check('forwards a requested timeout', seen.o.timeoutSeconds === 45, JSON.stringify(seen));
}
{
  let seen;
  await exec(async (p, o) => { seen = o; return { ok: true, text: 'x' }; })('t', { prompt: 'go', timeoutSeconds: -5 });
  check('drops a nonsensical timeout rather than sending it', seen.timeoutSeconds === undefined, JSON.stringify(seen));
}

// There is no parameter through which another scope could be named — the point of the whole design.
{
  let seen;
  await exec(async (p, o) => { seen = { p, o }; return { ok: true, text: 'x' }; })('t', { prompt: 'go', agent: 'dm-victim', agentId: 'dm-victim' });
  check('sends ONLY the prompt — no scope can be smuggled in', JSON.stringify(seen.o) === '{}' && seen.p === 'go', JSON.stringify(seen));
}

console.log(ok ? 'ALL PASS' : 'FAILURES');
process.exit(ok ? 0 : 1);

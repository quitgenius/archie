// Hermetic test for clock-extension.mjs — no pi-ai, no network. node clock-extension-test.mjs

import assert from 'node:assert';
import { formatClock, createClockExtension } from './clock-extension.mjs';

const NOW = 1_786_311_294_770; // 2026-08-…T…Z

const checks = [];
const check = (n, fn) => checks.push({ n, fn });

// Minimal Pi stub: capture the 'context' handler and drive it directly.
function mount(ext) {
  const handlers = {};
  ext({ on: (evt, fn) => { handlers[evt] = fn; } });
  return (messages) => handlers.context({ type: 'context', messages });
}

check('formatClock: emits BOTH unix forms + ISO + weekday (unit confusion is the bug)', () => {
  const s = formatClock(NOW);
  assert.match(s, /^<current_time>/);
  assert.match(s, /unix_seconds: 1786311294\b/);
  assert.match(s, /unix_ms: 1786311294770\b/);
  assert.match(s, new RegExp(`iso_utc: ${new Date(NOW).toISOString()}`));
  assert.match(s, /weekday_utc: (Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day/);
  assert.match(s, /never invent one/);
});

check('context: appends the clock to the last USER message (string content)', async () => {
  const run = mount(createClockExtension({ getNow: () => NOW }));
  const out = await run([
    { role: 'user', content: 'old turn' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'what time is it' },
  ]);
  assert.match(out.messages[2].content, /^what time is it\n\n<current_time>/);
  assert.equal(out.messages[0].content, 'old turn'); // earlier turns untouched
  assert.equal(out.messages[1].content, 'ok');
});

check('context: block-array content gets an extra text block, not a mangled string', async () => {
  const run = mount(createClockExtension({ getNow: () => NOW }));
  const out = await run([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  const blocks = out.messages[0].content;
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].text, 'hi');
  assert.match(blocks[1].text, /<current_time>/);
});

// A tool loop calls transformContext once per provider request. The injected text must be
// byte-identical across those steps or the cached prompt tail is invalidated every step.
check('context: turn-stable — identical output across the steps of one turn', async () => {
  let clock = NOW;
  const run = mount(createClockExtension({ getNow: () => clock })); // adapter passes turnCtx.turnStartedAtMs
  const msgs = [{ role: 'user', content: 'go' }];
  const a = await run(msgs);
  const b = await run(msgs);
  assert.equal(a.messages[0].content, b.messages[0].content);
  clock = NOW + 60_000; // next TURN → fresh time
  const c = await run(msgs);
  assert.notEqual(c.messages[0].content, a.messages[0].content);
});

check('context: no user message → messages returned unchanged', async () => {
  const run = mount(createClockExtension({ getNow: () => NOW }));
  const out = await run([{ role: 'assistant', content: 'solo' }]);
  assert.deepEqual(out.messages, [{ role: 'assistant', content: 'solo' }]);
});

check('context: a broken clock never breaks the turn', async () => {
  const run = mount(createClockExtension({ getNow: () => NaN }));
  assert.equal(await run([{ role: 'user', content: 'go' }]), undefined); // no transform applied
});

let pass = 0;
for (const { n, fn } of checks) {
  try { await fn(); console.log(`  ✅ ${n}`); pass += 1; }
  catch (e) { console.log(`  ❌ ${n}\n     ${e.message}`); }
}
const ok = pass === checks.length;
console.log(`[clock-extension] ${pass}/${checks.length} ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);

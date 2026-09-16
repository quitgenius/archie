// Hermetic test for cron-tool-core.mjs — mock dispatcher only.
// No pi-ai, no network, no filesystem.  node cron-tool-core-test.mjs

import assert from 'node:assert';
import { toDispatcherJob, makeCronExecute, normalizeAt, normalizeSchedule, parseDurationMs, describeSchedule } from './cron-tool-core.mjs';

function mockDispatcher(over = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); return (over[name] ? over[name](...args) : { ok: true }); };
  return {
    calls,
    add: rec('add'),
    list: over.list || (async () => ({ ok: true, jobs: [{ id: 'x' }] })),
    update: rec('update'),
    remove: rec('remove'),
    run: over.run || (async () => ({ ok: true, final: { text: 'ran' } })),
  };
}

const checks = [];
const check = (n, fn) => checks.push({ n, fn });

const SPEC = {
  name: 'Daily Briefing',
  schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' },
  payload: { kind: 'agentTurn', message: 'briefing' },
  sessionTarget: 'main',
  delivery: { mode: 'announce', channel: 'slack', to: 'D1' },
  failureAlert: { after: 1, channel: 'slack', to: 'D1' },
};

check('toDispatcherJob: remaps failureAlert.after → afterConsecutiveErrors', () => {
  const dj = toDispatcherJob('a', 'j', SPEC, 100);
  assert.equal(dj.failureAlert.afterConsecutiveErrors, 1);
  assert.equal('after' in dj.failureAlert, false);
  assert.deepEqual(dj.schedule, SPEC.schedule);
  assert.equal(dj.createdAtMs, 100);
});

// §12c — the ambient session key. The agent cannot know its own channel (the dispatcher's DM
// payload never includes it), so the tool stamps the session key it was invoked with and the
// dispatcher derives the channel from that. Same mechanism OpenClaw uses to resolve `current`.
check('toDispatcherJob: stamps the AMBIENT sessionKey onto the job', () => {
  const dj = toDispatcherJob('a', 'j', SPEC, 100, 'slack:thread:CZ3E1122Y3K:1712.5');
  assert.equal(dj.sessionKey, 'slack:thread:CZ3E1122Y3K:1712.5');
});

check('toDispatcherJob: an EXPLICIT spec.sessionKey wins over the ambient one', () => {
  const dj = toDispatcherJob('a', 'j', { ...SPEC, sessionKey: 'slack:thread:DL1HA3II6V6:1.2' }, 100, 'slack:thread:CZ3E1122Y3K:1712.5');
  assert.equal(dj.sessionKey, 'slack:thread:DL1HA3II6V6:1.2');
});

check('toDispatcherJob: no ambient key and none in the spec → no sessionKey field at all', () => {
  const dj = toDispatcherJob('a', 'j', SPEC, 100, null);
  assert.equal('sessionKey' in dj, false);
});

// §12c: was `spec.sessionTarget || 'main'`. OpenClaw defaults by PAYLOAD KIND and its validator
// throws on main + non-systemEvent, so the old default authored jobs a gateway would reject;
// absent-unless-explicit is the only safe default.
check('toDispatcherJob: does NOT invent sessionTarget when the spec omits it', () => {
  const { sessionTarget, ...noTarget } = SPEC;
  const dj = toDispatcherJob('a', 'j', noTarget, 100);
  assert.equal('sessionTarget' in dj, false);
  // an explicit target is still honoured
  assert.equal(toDispatcherJob('a', 'j', { ...noTarget, sessionTarget: 'isolated' }, 100).sessionTarget, 'isolated');
});

check('add: the ambient key reaches the dispatcher body', async () => {
  const d = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: d, now: () => 1, newId: () => 'jid-1',
    sessionKey: 'slack:thread:CZ3E1122Y3K:1712.5' });
  await exec({ action: 'add', job: SPEC });
  assert.equal(d.calls[0].args[0].sessionKey, 'slack:thread:CZ3E1122Y3K:1712.5');
});

check('add: writes the runner-shaped job to the dispatcher (authoritative, and only)', async () => {
  const disp = mockDispatcher({ add: async (j) => ({ ok: true, job: { id: `${j.agentId}::${j.jobId}` } }) });
  const exec = makeCronExecute({ agentId: 'agent-k4wmx6', dispatcher: disp, now: () => 555, newId: () => 'JID1' });
  const r = await exec({ action: 'add', job: { ...SPEC, connectorEntity: 'U036' } });
  assert.equal(r.ok, true);
  assert.equal(r.jobId, 'JID1');
  const sent = disp.calls.find((c) => c.name === 'add').args[0];
  assert.equal(sent.jobId, 'JID1');
  assert.equal(sent.connectorEntity, 'U036');
  assert.equal(sent.failureAlert.afterConsecutiveErrors, 1);
});

check('add: missing schedule → {ok:false}, no dispatcher call', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp });
  const r = await exec({ action: 'add', job: { name: 'x' } });
  assert.equal(r.ok, false);
  assert.match(r.error, /schedule required/);
  assert.equal(disp.calls.length, 0);
});

check('add: dispatcher failure fails the op', async () => {
  const disp = mockDispatcher({ add: async () => { throw new Error('HTTP 400'); } });
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, newId: () => 'J' });
  const r = await exec({ action: 'add', job: SPEC });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 400/);
});

check('update: forwards the patch to the dispatcher', async () => {
  const disp = mockDispatcher({ update: async () => ({ ok: true, job: { id: 'J', enabled: false } }) });
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp });
  const r = await exec({ action: 'update', jobId: 'J', patch: { enabled: false } });
  assert.equal(r.ok, true);
  const call = disp.calls.find((c) => c.name === 'update');
  assert.equal(call.args[1], 'J');
  assert.equal(call.args[2].enabled, false);
});

check('update/remove/run require jobId', async () => {
  const exec = makeCronExecute({ agentId: 'a', dispatcher: mockDispatcher() });
  assert.match((await exec({ action: 'update' })).error, /jobId required/);
  assert.match((await exec({ action: 'remove' })).error, /jobId required/);
  assert.match((await exec({ action: 'run' })).error, /jobId required/);
});

check('remove: forwards the delete to the dispatcher', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp });
  const r = await exec({ action: 'remove', jobId: 'J' });
  assert.equal(r.ok, true);
  assert.equal(r.removed, 'J');
  assert.equal(disp.calls.find((c) => c.name === 'remove').args[1], 'J');
});

check('list: returns dispatcher jobs (authoritative)', async () => {
  const exec = makeCronExecute({ agentId: 'a', dispatcher: mockDispatcher() });
  const r = await exec({ action: 'list' });
  assert.deepEqual(r.jobs, [{ id: 'x' }]);
});

check('run: returns the final from the dispatcher', async () => {
  const exec = makeCronExecute({ agentId: 'a', dispatcher: mockDispatcher() });
  const r = await exec({ action: 'run', jobId: 'J' });
  assert.equal(r.final.text, 'ran');
});

// ── Relative-time (`at`) normalisation ──────────────────────────────────────
// The dispatcher takes ONE form (absolute epoch-ms). These cover the forms a model actually
// emits, including the silent killer: unix SECONDS, which passed the finite-number check and
// landed in 1970 → elapsed one-shot → fire-once-immediately-then-delete.
const NOW = 1_786_311_294_770; // 2026-08-…

check('parseDurationMs: bare number = seconds; units s/m/h/d/w; unknown unit → null', () => {
  assert.equal(parseDurationMs('3600'), 3_600_000);
  assert.equal(parseDurationMs('30s'), 30_000);
  assert.equal(parseDurationMs('90m'), 5_400_000);
  assert.equal(parseDurationMs('1.5h'), 5_400_000);
  assert.equal(parseDurationMs('2 hours'), 7_200_000);
  assert.equal(parseDurationMs('1d'), 86_400_000);
  assert.equal(parseDurationMs('1w'), 604_800_000);
  assert.equal(parseDurationMs('7 fortnights'), null);
});

check('normalizeAt: relative "+3600" / "+1h" / "in 30 minutes" resolve off now', () => {
  assert.equal(normalizeAt('+3600', NOW), NOW + 3_600_000);
  assert.equal(normalizeAt('+1h', NOW), NOW + 3_600_000);
  assert.equal(normalizeAt('+ 90m', NOW), NOW + 5_400_000);
  assert.equal(normalizeAt('in 30 minutes', NOW), NOW + 1_800_000);
  assert.equal(normalizeAt('now', NOW), NOW);
});

check('normalizeAt: unix SECONDS are upscaled to ms (the silent 1970 fire-and-delete bug)', () => {
  assert.equal(normalizeAt(1_786_311_294, NOW), 1_786_311_294_000);
  assert.equal(normalizeAt('1786311294', NOW), 1_786_311_294_000);
});

check('normalizeAt: epoch-ms and ISO-8601 pass through as the same instant', () => {
  assert.equal(normalizeAt(NOW, NOW), NOW);
  assert.equal(normalizeAt('2026-08-10T12:00:00Z', NOW), Date.parse('2026-08-10T12:00:00Z'));
});

check('normalizeAt: unparseable / too-small values throw naming the accepted forms', () => {
  assert.throws(() => normalizeAt(3600, NOW), /too small to be a timestamp.*\+3600/s);
  assert.throws(() => normalizeAt('tomorrow-ish', NOW), /cannot parse/);
  assert.throws(() => normalizeAt('+7 fortnights', NOW), /cannot parse relative/);
  assert.throws(() => normalizeAt(undefined, NOW), /must be epoch-ms/);
});

// everyMs is deliberately NOT rescaled like `at`: sub-minute intervals are legal, so
// reinterpreting the number 3600 as an hour would silently break a real 3.6s job.
check('normalizeSchedule: every — numbers untouched, unit strings parsed, anchorMs normalised', () => {
  assert.deepEqual(normalizeSchedule({ kind: 'every', everyMs: 3600 }, NOW), { kind: 'every', everyMs: 3600 });
  assert.equal(normalizeSchedule({ kind: 'every', everyMs: '30m' }, NOW).everyMs, 1_800_000);
  assert.equal(normalizeSchedule({ kind: 'every', everyMs: '600000' }, NOW).everyMs, 600_000); // bare string = ms (field name)
  assert.equal(normalizeSchedule({ kind: 'every', everyMs: 60_000, anchorMs: '+1h' }, NOW).anchorMs, NOW + 3_600_000);
});

check('normalizeSchedule: cron exprs pass through untouched', () => {
  const s = { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' };
  assert.deepEqual(normalizeSchedule(s, NOW), s);
});

check('describeSchedule: echoes the resolved instant; flags a past at', () => {
  const d = describeSchedule({ kind: 'at', at: NOW + 3_600_000 }, NOW);
  assert.equal(d.unixMs, NOW + 3_600_000);
  assert.equal(d.unixSeconds, Math.floor((NOW + 3_600_000) / 1000));
  assert.equal(d.inSeconds, 3600);
  assert.equal('warning' in d, false);
  assert.match(describeSchedule({ kind: 'at', at: NOW - 1 }, NOW).warning, /fires ONCE immediately/);
  assert.equal(describeSchedule({ kind: 'every', everyMs: 1000 }, NOW), null);
});

check('add: "+1h" reaches the dispatcher as absolute epoch-ms + is echoed as scheduledFor', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, now: () => NOW, newId: () => 'J' });
  const r = await exec({ action: 'add', job: { ...SPEC, schedule: { kind: 'at', at: '+1h' } } });
  assert.equal(r.ok, true);
  assert.equal(r.scheduledFor.unixMs, NOW + 3_600_000);
  assert.equal(r.scheduledFor.inSeconds, 3600);
  // The dispatcher's validator requires a finite number (cron-runner.validateSchedule).
  assert.deepEqual(disp.calls.find((c) => c.name === 'add').args[0].schedule, { kind: 'at', at: NOW + 3_600_000 });
});

check('add: an unparseable at fails the op — no dispatcher call', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, now: () => NOW, newId: () => 'J' });
  const r = await exec({ action: 'add', job: { ...SPEC, schedule: { kind: 'at', at: 'sometime soon' } } });
  assert.equal(r.ok, false);
  assert.match(r.error, /cannot parse/);
  assert.equal(disp.calls.length, 0);
});

check('update: a rescheduling patch is normalised before the dispatcher call', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, now: () => NOW });
  const r = await exec({ action: 'update', jobId: 'J', patch: { schedule: { kind: 'at', at: '+30m' } } });
  assert.equal(r.scheduledFor.unixMs, NOW + 1_800_000);
  assert.deepEqual(disp.calls.find((c) => c.name === 'update').args[2].schedule, { kind: 'at', at: NOW + 1_800_000 });
});

// A cron turn is unattended: a slow one beats one that can never finish. An agent sizes
// timeoutSeconds against what it sees under Pi, and that does not transfer — live 2026-08-12,
// orange-code carried the agent's 30s, passed under archie, and timed out on EVERY OpenClaw run at
// ~34s. `run: timeout` is already the largest prod failure class (30 of 79 failing jobs).
check('add: timeoutSeconds passes through untouched, whatever it says', async () => {
  for (const timeoutSeconds of [45, 7200, 0]) {
    const disp = mockDispatcher();
    const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, now: () => NOW, newId: () => 'J' });
    await exec({ action: 'add', job: { ...SPEC, payload: { kind: 'agentTurn', message: 'x', timeoutSeconds } } });
    assert.equal(disp.calls.find((c) => c.name === 'add').args[0].payload.timeoutSeconds, timeoutSeconds);
  }
});

check('add: no timeout stays absent — the tool does not invent one', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, now: () => NOW, newId: () => 'J' });
  await exec({ action: 'add', job: { ...SPEC, payload: { kind: 'agentTurn', message: 'x' } } });
  assert.equal('timeoutSeconds' in disp.calls.find((c) => c.name === 'add').args[0].payload, false);
});

check('update: a patched payload passes through untouched too', async () => {
  const disp = mockDispatcher();
  const exec = makeCronExecute({ agentId: 'a', dispatcher: disp, now: () => NOW });
  await exec({ action: 'update', jobId: 'J', patch: { payload: { kind: 'agentTurn', message: 'x', timeoutSeconds: 45 } } });
  assert.equal(disp.calls.find((c) => c.name === 'update').args[2].payload.timeoutSeconds, 45);
});

check('unknown action → {ok:false}', async () => {
  const exec = makeCronExecute({ agentId: 'a', dispatcher: mockDispatcher() });
  assert.match((await exec({ action: 'frobnicate' })).error, /unknown action/);
});

let pass = 0;
// ── §7: the ambient Connector identity is stamped at creation ─────────────────────────────────────
//
// The failure this fixes: connectorEntity was written in exactly ONE place — cron-hydrator.js, for
// jobs migrated from OpenClaw. A job an agent scheduled for itself therefore carried no entity, its
// Connector tools were rejected at fire time, and binding after the fact could not help because the
// binding store is only consulted for session keys the plugin recognises as cron.
check('toDispatcherJob: stamps the ambient Connector entity onto a new job', () => {
  const dj = toDispatcherJob('a', 'j1', SPEC, 100, 'slack:thread:D1:cron-j1', 'UJCBAR1FB');
  assert.equal(dj.connectorEntity, 'UJCBAR1FB');
});

check('toDispatcherJob: no ambient identity leaves the field ABSENT, not null', () => {
  const dj = toDispatcherJob('a', 'j2', SPEC, 100, null, null);
  assert.equal('connectorEntity' in dj, false);
});

check('toDispatcherJob: an explicit spec entity beats the ambient default', () => {
  const dj = toDispatcherJob('a', 'j3', { ...SPEC, connectorEntity: 'U-EXPLICIT' }, 100, null, 'U-AMBIENT');
  assert.equal(dj.connectorEntity, 'U-EXPLICIT');
});

for (const { n, fn } of checks) {
  try { await fn(); console.log(`  ✅ ${n}`); pass += 1; }
  catch (e) { console.log(`  ❌ ${n}\n     ${e.message}`); }
}
const ok = pass === checks.length;
console.log(`[cron-tool-core] ${pass}/${checks.length} ${ok ? 'PASS ✅' : 'FAIL ❌'}`);
process.exit(ok ? 0 : 1);

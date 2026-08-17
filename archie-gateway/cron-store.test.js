'use strict';

// vitest globals enabled via vitest.config.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCronStore, keyOf } = require('./cron-store');

// Uses a REAL temp dir so the atomic tmp+rename + per-agent-file persistence path is
// actually exercised (higher value than mocking fs). afterEach cleans up.
let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cron-store-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const store = () => createCronStore({ dir });
const job = (over = {}) => ({
  agentId: 'agentA',
  jobId: 'daily',
  name: 'daily',
  enabled: true,
  schedule: { kind: 'every', everyMs: 10_000 },
  ...over,
});

describe('put/get/list/delete', () => {
  it('put enriches with a composite id and round-trips via get', () => {
    const s = store();
    const saved = s.put(job());
    expect(saved.id).toBe(keyOf('agentA', 'daily'));
    expect(s.get(saved.id)).toMatchObject({ agentId: 'agentA', jobId: 'daily', name: 'daily' });
  });

  it('rejects a job missing agentId/jobId', () => {
    expect(() => store().put({ name: 'x' })).toThrow(/agentId and jobId/);
  });

  it('list returns all jobs across agents', () => {
    const s = store();
    s.put(job({ agentId: 'agentA', jobId: 'a' }));
    s.put(job({ agentId: 'agentB', jobId: 'b' }));
    expect(s.list().map((j) => j.id).sort()).toEqual([keyOf('agentA', 'a'), keyOf('agentB', 'b')]);
  });

  it('same jobId under different agents does NOT collide', () => {
    const s = store();
    s.put(job({ agentId: 'agentA', jobId: 'daily', name: 'A-daily' }));
    s.put(job({ agentId: 'agentB', jobId: 'daily', name: 'B-daily' }));
    expect(s.get(keyOf('agentA', 'daily')).name).toBe('A-daily');
    expect(s.get(keyOf('agentB', 'daily')).name).toBe('B-daily');
  });

  it('delete removes the job', () => {
    const s = store();
    const j = s.put(job());
    s.delete(j.id);
    expect(s.get(j.id)).toBeUndefined();
    expect(s.list().length).toBe(0);
  });
});

describe('patchState', () => {
  it('merges run-state and prunes undefined', () => {
    const s = store();
    const j = s.put(job());
    s.patchState(j.id, { lastRunAtMs: 1000, consecutiveErrors: 2, lastError: 'boom' });
    s.patchState(j.id, { consecutiveErrors: 0, lastError: undefined });
    const st = s.get(j.id).state;
    expect(st).toMatchObject({ lastRunAtMs: 1000, consecutiveErrors: 0 });
    expect('lastError' in st).toBe(false); // pruned
  });
  it('patchState on a missing id is a no-op', () => {
    expect(() => store().patchState('nope::x', { a: 1 })).not.toThrow();
  });
});

describe('persistence + boot-recovery (load over the same dir = restart)', () => {
  it('a fresh store load() sees jobs written by a previous instance', () => {
    const s1 = store();
    s1.put(job({ agentId: 'agentA', jobId: 'a', name: 'A' }));
    s1.put(job({ agentId: 'agentB', jobId: 'b', name: 'B' }));
    s1.patchState(keyOf('agentA', 'a'), { lastRunStatus: 'ok' });

    const s2 = store(); // "dispatcher restart"
    const n = s2.load();
    expect(n).toBe(2);
    expect(s2.get(keyOf('agentA', 'a'))).toMatchObject({ name: 'A', state: { lastRunStatus: 'ok' } });
    expect(s2.get(keyOf('agentB', 'b')).name).toBe('B');
  });

  it('load() on an absent dir returns 0 (cold start)', () => {
    const s = createCronStore({ dir: path.join(dir, 'does-not-exist') });
    expect(s.load()).toBe(0);
  });

  it('on-disk file is keyed by bare jobId and drops derived fields', () => {
    const s = store();
    s.put(job({ agentId: 'agentA', jobId: 'daily' }));
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'agentA.json'), 'utf8'));
    expect(raw.version).toBe(1);
    expect(Object.keys(raw.jobs)).toEqual(['daily']); // bare jobId key
    expect(raw.jobs.daily.id).toBeUndefined(); // derived id not persisted
    expect(raw.jobs.daily.agentId).toBeUndefined();
  });

  it('deleting the last job for an agent removes its file (no empty shell)', () => {
    const s = store();
    const j = s.put(job({ agentId: 'agentA', jobId: 'only' }));
    expect(fs.existsSync(path.join(dir, 'agentA.json'))).toBe(true);
    s.delete(j.id);
    expect(fs.existsSync(path.join(dir, 'agentA.json'))).toBe(false);
  });

  it('one agent\'s jobs persist independently of another\'s', () => {
    const s = store();
    s.put(job({ agentId: 'agentA', jobId: 'a1' }));
    s.put(job({ agentId: 'agentA', jobId: 'a2' }));
    s.put(job({ agentId: 'agentB', jobId: 'b1' }));
    s.delete(keyOf('agentA', 'a1'));
    const s2 = store();
    s2.load();
    expect(s2.list().map((j) => j.id).sort()).toEqual([keyOf('agentA', 'a2'), keyOf('agentB', 'b1')]);
  });
});

// Injectable in-memory fs so we can force a rename failure / capture tmp names — the
// concurrent-writer race that crashed the dispatcher on restart can't be reproduced with
// real sync fs in one process, so we simulate its symptom (rename ENOENT) directly.
function memFs() {
  const files = new Map();
  return {
    _files: files,
    failRename: false,
    mkdirSync() {},
    writeFileSync(p, data) { files.set(p, data); },
    renameSync(a, b) {
      if (this.failRename) { const e = new Error('ENOENT: forced'); e.code = 'ENOENT'; throw e; }
      if (!files.has(a)) { const e = new Error('ENOENT: no tmp'); e.code = 'ENOENT'; throw e; }
      files.set(b, files.get(a)); files.delete(a);
    },
    readFileSync(p) { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    readdirSync() { return [...files.keys()].map((p) => p.split('/').pop()); },
    unlinkSync(p) { files.delete(p); },
  };
}

describe('atomic write — concurrent-writer safety (P3 restart crash RCA)', () => {
  it('uses a PER-WRITE-UNIQUE tmp name (never a fixed <target>.tmp)', () => {
    const mock = memFs();
    const tmps = [];
    const origWrite = mock.writeFileSync.bind(mock);
    mock.writeFileSync = (p, d) => { if (p.endsWith('.tmp')) tmps.push(p); origWrite(p, d); };
    const s = createCronStore({ dir: '/x', fs: mock });
    s.put(job({ agentId: 'a', jobId: '1' }));
    s.put(job({ agentId: 'a', jobId: '2' }));
    expect(tmps.length).toBeGreaterThanOrEqual(2);
    expect(new Set(tmps).size).toBe(tmps.length); // all unique
    expect(tmps.some((p) => /\/a\.json\.tmp$/.test(p))).toBe(false); // NOT the fixed name that raced
  });

  it('patchState is NON-FATAL when the persist rename fails (timer-callback safe)', () => {
    const mock = memFs();
    const s = createCronStore({ dir: '/x', fs: mock });
    const j = s.put(job()); // succeeds
    mock.failRename = true; // now every rename ENOENTs (as in the two-writer race)
    expect(() => s.patchState(j.id, { lastRunAtMs: 123, lastRunStatus: 'ok' })).not.toThrow();
    expect(s.get(j.id).state).toMatchObject({ lastRunAtMs: 123, lastRunStatus: 'ok' }); // cache kept
  });

  it('put/delete (API path) STILL propagate a persist failure', () => {
    const mock = memFs();
    const s = createCronStore({ dir: '/x', fs: mock });
    mock.failRename = true;
    expect(() => s.put(job())).toThrow(/ENOENT/); // API caller must learn the durable write failed
  });

  it('cleans up its own tmp when the rename fails (no orphan tmp)', () => {
    const mock = memFs();
    const s = createCronStore({ dir: '/x', fs: mock });
    mock.failRename = true;
    try { s.put(job()); } catch (_) { /* expected */ }
    const orphans = [...mock._files.keys()].filter((p) => p.endsWith('.tmp'));
    expect(orphans).toEqual([]);
  });
});


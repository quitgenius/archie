// Session pointer store. Hermetic — no EFS, no Pi. Run:
//
//   node agentcore-pi/session-store-test.mjs
//
// Exists because cross-boot restore had NEVER succeeded in production (measured: 741 transcripts on
// disk, zero surviving index entries, ~75 runtime generations) and no test covered the one property
// that was broken — that concurrent writers do not destroy each other's entries.
import { resolveSessionPath, writeIndexEntry, indexPathFor } from './session-store.mjs';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

let ok = true;
const check = (n, c, extra) => { console.log(`  ${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : `  <- ${extra}`}`); ok = ok && c; };
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
const transcript = (dir, name) => { fs.writeFileSync(path.join(dir, name), '{}\n'); return name; };

{
  const d = tmpdir();
  const r0 = resolveSessionPath({ sessionsDir: d, key: 'ac-thread-1' });
  check('an unknown key resolves to not-found, without throwing', r0.found === false, JSON.stringify(r0));
}

{
  const d = tmpdir();
  const f = transcript(d, '2026-09-16T10-00-00-000Z_uuid-1.jsonl');
  writeIndexEntry({ sessionsDir: d, key: 'ac-thread-1', sessionId: 'uuid-1', sessionFile: `/some/other/mount/${f}` });
  const r = resolveSessionPath({ sessionsDir: d, key: 'ac-thread-1' });
  check('resolves a written pointer to its transcript', r.found === true, JSON.stringify(r));
  // The absolute path recorded by one runtime is wrong on another mount; only the basename travels.
  check('resolves against the LIVE dir, not the recorded path', r.path === path.join(d, f), r.path);
}

{
  const d = tmpdir();
  writeIndexEntry({ sessionsDir: d, key: 'ac-thread-1', sessionId: 'uuid-1', sessionFile: 'gone.jsonl' });
  const r = resolveSessionPath({ sessionsDir: d, key: 'ac-thread-1' });
  check('a pointer to a MISSING transcript is not "found"', r.found === false, JSON.stringify(r));
}

// THE PROPERTY THE OLD DESIGN LACKED. With a single shared index, each of these writers read the
// whole file and wrote it back, so the last one to rename erased the rest.
{
  const d = tmpdir();
  const keys = Array.from({ length: 50 }, (_, i) => `ac-thread-${i}`);
  for (const k of keys) {
    const f = transcript(d, `2026-09-16T10-00-00-000Z_${k}.jsonl`);
    writeIndexEntry({ sessionsDir: d, key: k, sessionId: k, sessionFile: f });
  }
  const lost = keys.filter((k) => !resolveSessionPath({ sessionsDir: d, key: k }).found);
  check('50 concurrent threads all survive — no writer clobbers another', lost.length === 0, `lost ${lost.length}`);
}

// Interleaved writes to two keys: the shape a parent turn and its spawned child produce.
{
  const d = tmpdir();
  const a = transcript(d, 'A.jsonl'); const b = transcript(d, 'B.jsonl');
  writeIndexEntry({ sessionsDir: d, key: 'parent', sessionId: 'A', sessionFile: a });
  writeIndexEntry({ sessionsDir: d, key: 'child', sessionId: 'B', sessionFile: b });
  writeIndexEntry({ sessionsDir: d, key: 'parent', sessionId: 'A', sessionFile: a }); // parent writes again
  check('a suagent-zh8hww spawn does not evict its parent', resolveSessionPath({ sessionsDir: d, key: 'parent' }).found
    && resolveSessionPath({ sessionsDir: d, key: 'child' }).found);
}

{
  const d = tmpdir();
  writeIndexEntry({ sessionsDir: d, key: 'MiXeD-Case', sessionId: 'u', sessionFile: transcript(d, 'u.jsonl') });
  check('lookup is case-insensitive, as the key normaliser promises',
    resolveSessionPath({ sessionsDir: d, key: 'mixed-case' }).found === true);
}

{
  const d = tmpdir();
  const p = indexPathFor(d, 'slack:thread:C123:1789.0001');
  writeIndexEntry({ sessionsDir: d, key: 'slack:thread:C123:1789.0001', sessionId: 'u', sessionFile: transcript(d, 'u.jsonl') });
  check('a key with path-hostile characters is a safe filename', fs.existsSync(p) && !path.basename(p).includes(':'), p);
}

{
  const d = tmpdir();
  let threw = false;
  try { writeIndexEntry({ sessionsDir: '/proc/nope/nowhere', key: 'k', sessionId: 'u', sessionFile: 'u.jsonl' }); } catch { threw = true; }
  check('an unwritable store THROWS rather than silently losing the pointer', threw === true);
}

console.log(ok ? 'ALL PASS' : 'FAILURES');
process.exit(ok ? 0 : 1);

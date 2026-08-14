'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { main, helpText } = require('./archie');
const { EXIT } = require('../lib/exit');
const { resolve, load } = require('../lib/registry');

function capture() {
  const out = []; const err = [];
  return {
    streams: { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) } },
    stdout: () => out.join(''),
    stderr: () => err.join(''),
  };
}

// A fake command module, injected via the require hook the registry accepts, so dispatch can be
// tested before any cmd/* file exists.
function fakeRequire(exports) {
  return () => exports;
}

test('bare invocation and --help print help and exit 0', async () => {
  for (const argv of [[], ['--help'], ['-h'], ['gateway', 'deploy', '--help']]) {
    const c = capture();
    assert.equal(await main(argv, { streams: c.streams, env: {} }), EXIT.OK);
    assert.match(c.stdout(), /USAGE/);
  }
});

test('help asking never becomes an argument error', async () => {
  // Someone asking for help should not be told their arguments are wrong.
  const c = capture();
  assert.equal(await main(['--help', '--not-a-flag'], { streams: c.streams, env: {} }), EXIT.OK);
});

test('unknown command exits 2 and says so', async () => {
  const c = capture();
  assert.equal(await main(['wibble', 'flurb'], { streams: c.streams, env: {} }), EXIT.USAGE);
  assert.match(c.stderr(), /unknown command: wibble flurb/);
});

test('an unknown OPTION is a usage error, not silently ignored', async () => {
  // A silently-ignored --no-dry-run would be a dry run the operator believed was real.
  const c = capture();
  assert.equal(await main(['status', '--region', 'us-east-1', '--nodryrun'], { streams: c.streams, env: {} }), EXIT.USAGE);
});

test('version needs no region and no credentials', async () => {
  const c = capture();
  assert.equal(await main(['version'], { streams: c.streams, env: {} }), EXIT.OK);
  assert.match(c.stdout(), /^\d+\.\d+\.\d+$/m);
});

test('a missing --region on an AWS command exits 2 before anything is contacted', async () => {
  const c = capture();
  assert.equal(await main(['status'], { streams: c.streams, env: {} }), EXIT.USAGE);
  assert.match(c.stderr(), /--region is required/);
});

test('an unbuilt command names the task that owns it, rather than "unknown"', async () => {
  // "unknown command" would be a lie: it is known, it is just not written yet. The distinction is
  // "I typed it wrong" vs "this is not built".
  const c = capture();
  const code = await main(['generation', 'stage', '--region', 'us-east-1'], {
    streams: c.streams,
    env: {},
    require: () => { const e = new Error("Cannot find module '../cmd/stage'"); e.code = 'MODULE_NOT_FOUND'; throw e; },
  });
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stderr(), /not implemented yet/);
  assert.match(c.stderr(), /W1-D/);
});

test('phase-2 commands say they are deferred, not missing', async () => {
  const c = capture();
  const code = await main(['fleet', 'reconcile', '--region', 'us-east-1'], { streams: c.streams, env: {} });
  assert.equal(code, EXIT.USAGE);
  assert.match(c.stderr(), /deferred to phase 2/);
});

test('a handler result becomes the answer on stdout', async () => {
  const c = capture();
  const code = await main(['status', '--region', 'us-east-1'], {
    streams: c.streams, env: {}, require: fakeRequire({ status: async () => 'all good' }),
  });
  assert.equal(code, EXIT.OK);
  assert.equal(c.stdout(), 'all good\n');
});

test('--json emits exactly one document on stdout and keeps progress on stderr', async () => {
  const c = capture();
  const code = await main(['status', '--region', 'us-east-1', '--json', '--name', 'agent-tmv5ts'], {
    streams: c.streams,
    env: {},
    now: () => 1000,
    require: fakeRequire({
      status: async (ctx, args, out) => { out.progress('working'); return { coverage: '206/208' }; },
    }),
  });
  assert.equal(code, EXIT.OK);
  const doc = JSON.parse(c.stdout());          // must parse — one document, nothing else
  assert.equal(doc.command, 'status');
  assert.equal(doc.ok, true);
  assert.equal(doc.exit, 0);
  assert.equal(doc.name, 'agent-tmv5ts');
  assert.deepEqual(doc.result, { coverage: '206/208' });
  assert.deepEqual(doc.failures, []);
  assert.match(c.stderr(), /working/);          // progress is never suppressed by --json
});

test('recorded per-unit failures exit 6 (PARTIAL) even when the handler returns cleanly', async () => {
  // Stragglers are the designed re-run case; exiting 0 would hide them.
  const c = capture();
  const code = await main(['status', '--region', 'us-east-1', '--json'], {
    streams: c.streams,
    env: {},
    require: fakeRequire({
      status: async (ctx, args, out) => {
        out.failure({ agent: 'ch_growth_ops', step: 'ensure-access-point', error: new Error('Rate exceeded') });
        return { staged: 206 };
      },
    }),
  });
  assert.equal(code, EXIT.PARTIAL);
  const doc = JSON.parse(c.stdout());
  assert.equal(doc.exit, EXIT.PARTIAL);
  assert.equal(doc.failures[0].agent, 'ch_growth_ops');   // names WHICH agent, not just that it failed
});

test('a thrown CliError carries its own exit code; anything else is 1', async () => {
  const { refused } = require('../lib/exit');
  const c1 = capture();
  assert.equal(await main(['status', '--region', 'r'], {
    streams: c1.streams, env: {}, require: fakeRequire({ status: async () => { throw refused('tainted generation'); } }),
  }), EXIT.REFUSED);
  assert.match(c1.stderr(), /ERROR: tainted generation/);

  const c2 = capture();
  assert.equal(await main(['status', '--region', 'r'], {
    streams: c2.streams, env: {}, require: fakeRequire({ status: async () => { throw new Error('boom'); } }),
  }), EXIT.FAILED);
});

test('positionals after the verb reach the handler', async () => {
  const c = capture();
  let seen = null;
  await main(['release', 'set', 'rel-2026-08-14-01', '--region', 'r'], {
    streams: c.streams, env: {}, require: fakeRequire({ set: async (ctx, args) => { seen = args.positionals; } }),
  });
  assert.deepEqual(seen, ['rel-2026-08-14-01']);
});

test('plan-era aliases still resolve, and report the canonical name', async () => {
  assert.equal(resolve(['set-active-runtime', 'rel-1']).key, 'release set');
  assert.equal(resolve(['deploy-agents']).key, 'fleet deploy');
  assert.deepEqual(resolve(['set-active-runtime', 'rel-1']).args, ['rel-1']);

  const c = capture();
  await main(['set-active-runtime', 'rel-1', '--region', 'r', '--json'], {
    streams: c.streams, env: {}, now: () => 0, require: fakeRequire({ set: async () => ({}) }),
  });
  assert.equal(JSON.parse(c.stdout()).command, 'release set');
});

test('two-word commands win over one-word prefixes', () => {
  assert.equal(resolve(['generation', 'list']).key, 'generation list');
  assert.equal(resolve(['generation']), null);       // `generation` alone is not a command
  assert.equal(resolve(['status']).key, 'status');
});

test('a declared command whose module lacks the verb fails clearly', () => {
  assert.throws(
    () => load('gateway build', { module: 'gateway', task: 'W1-B' }, { require: () => ({ deploy: () => {} }) }),
    /exports no "build"/,
  );
});

test('help lists every declared command and marks deferred ones', () => {
  const h = helpText();
  assert.match(h, /generation stage/);
  assert.match(h, /fleet reconcile.*\[phase 2\]/);
  assert.match(h, /4 TAINTED \(stop\)/);
});

test('command-specific options are accepted; unknown ones still are not', async () => {
  // Registry-declared options must parse, or every wave-1 command would be unusable. And a flag that
  // belongs to ANOTHER command must still be rejected — `--keep` on `status` is a typo, not a feature.
  const c1 = capture();
  let seen = null;
  assert.equal(await main(['runtime', 'gc', '--region', 'r', '--keep', '3', '--reconcile-aws'], {
    streams: c1.streams, env: {}, require: fakeRequire({ gc: async (ctx, args) => { seen = args.values; } }),
  }), EXIT.OK);
  assert.equal(seen.keep, '3');
  assert.equal(seen['reconcile-aws'], true);

  const c2 = capture();
  assert.equal(await main(['status', '--region', 'r', '--keep', '3'], { streams: c2.streams, env: {} }), EXIT.USAGE);
});

test('--set is repeatable on generation create', async () => {
  const c = capture();
  let seen = null;
  await main(['generation', 'create', '--region', 'r', '--image', 't', '--set', 'a=1', '--set', 'b=2'], {
    streams: c.streams, env: {}, require: fakeRequire({ create: async (ctx, args) => { seen = args.values.set; } }),
  });
  assert.deepEqual(seen, ['a=1', 'b=2']);
});

test('every declared command has an options object, so none can be unusable', () => {
  const { COMMANDS } = require('../lib/registry');
  for (const [key, meta] of Object.entries(COMMANDS)) {
    if (key === 'version') continue;
    assert.ok(meta.options && typeof meta.options === 'object', `${key} declares no options`);
  }
});

test('a command-specific flag VALUE never arrives as a positional', async () => {
  // Pass 1 knows only the global options, so `--concurrency 9` parses as a boolean flag plus a
  // positional `9` there. Resolving args from that pass handed `9` to the command as its id —
  // for `release set` or `generation taint` that is a flag value masquerading as a generation.
  const { parse } = require('./archie');
  assert.deepEqual(parse(['generation', 'stage', '--concurrency', '9']).found.args, []);
  assert.deepEqual(parse(['generation', 'taint', 'rel-1', '--reason', 'bad image']).found.args, ['rel-1']);
  assert.deepEqual(parse(['release', 'set', '--hotfix', 'rel-1']).found.args, ['rel-1']);
  assert.deepEqual(parse(['runtime', 'gc', '--keep', '3']).found.args, []);
});

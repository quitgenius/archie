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
  const code = await main(['fleet', 'stage', '--region', 'us-east-1'], {
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
    streams: c1.streams, env: {}, require: fakeRequire({ status: async () => { throw refused('tainted tag'); } }),
  }), EXIT.REFUSED);
  assert.match(c1.stderr(), /ERROR: tainted tag/);

  const c2 = capture();
  assert.equal(await main(['status', '--region', 'r'], {
    streams: c2.streams, env: {}, require: fakeRequire({ status: async () => { throw new Error('boom'); } }),
  }), EXIT.FAILED);
});

test('positionals after the verb reach the handler', async () => {
  const c = capture();
  let seen = null;
  await main(['image', 'publish', 'content-2026abcd', '--region', 'r'], {
    streams: c.streams, env: {}, require: fakeRequire({ publish: async (ctx, args) => { seen = args.positionals; } }),
  });
  assert.deepEqual(seen, ['content-2026abcd']);
});

test('plan-era aliases still resolve, and report the canonical name', async () => {
  assert.equal(resolve(['set-active-runtime', 'content-1']).key, 'image publish');
  assert.equal(resolve(['deploy-agents']).key, 'fleet deploy');
  assert.deepEqual(resolve(['set-active-runtime', 'rel-1']).args, ['rel-1']);

  const c = capture();
  await main(['set-active-runtime', 'rel-1', '--region', 'r', '--json'], {
    streams: c.streams, env: {}, now: () => 0, require: fakeRequire({ set: async () => ({}) }),
  });
  assert.equal(JSON.parse(c.stdout()).command, 'image publish');
});

test('two-word commands win over one-word prefixes', () => {
  assert.equal(resolve(['image', 'list']).key, 'image list');
  assert.equal(resolve(['image']), null);            // `image` alone is not a command
  // The removed nouns still resolve, to their replacements, and report the CANONICAL name.
  assert.equal(resolve(['generation', 'stage']).key, 'fleet stage');
  assert.equal(resolve(['generation', 'stage']).viaAlias, 'generation stage');
  assert.equal(resolve(['release', 'set']).key, 'image publish');
  assert.equal(resolve(['generation', 'taint']).key, 'image taint');
  // `generation create` is gone rather than aliased: there is nothing for it to do.
  assert.equal(resolve(['generation', 'create']), null);
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
  assert.match(h, /fleet stage/);
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

test('a repeatable option collects every occurrence', async () => {
  const c = capture();
  let seen = null;
  await main(['agent', 'migrate', '--region', 'r', '--agents', 'a,b'], {
    streams: c.streams,
    env: {},
    // `agent migrate` provisions, so it is dispatched with the deployed fleet config applied.
    // Stubbed because this test is about PARSING; the assertion below is unchanged.
    dispatcherEnv: async () => ({ env: {}, revision: 'stub' }),
    require: fakeRequire({ migrate: async (ctx, args) => { seen = args.values.agents; } }),
  });
  assert.equal(seen, 'a,b');
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
  // for `image publish` or `image taint` that is a flag value masquerading as a tag.
  const { parse } = require('./archie');
  assert.deepEqual(parse(['fleet', 'stage', '--concurrency', '9']).found.args, []);
  assert.deepEqual(parse(['image', 'taint', 'content-1', '--reason', 'bad image']).found.args, ['content-1']);
  assert.deepEqual(parse(['image', 'publish', 'content-1']).found.args, ['content-1']);
  assert.deepEqual(parse(['runtime', 'gc', '--keep', '3']).found.args, []);
});

// ── the fleet's configuration, not the laptop's ──────────────────────────────────────────────────
//
// REGRESSION (first sandbox rehearsal). `createAgentCoreClient` resolves what it is not given as
// `process.env.X || <pre-archie constant>`. Running on a laptop, where none of those variables are
// set, staging recorded the OpenClaw stack's security group, dispatcher URL and secret names into
// the derived spec and REPORTED SUCCESS, then failed closed on a filesystem that had been deleted.
// The silent one was the dangerous one — and it matters MORE now that the runtime name is derived on
// both sides rather than stored on one: a wrong environment here does not write a wrong record, it
// produces a different NAME from the one the dispatcher derives, and the two halves stop meeting.

test('commands that provision are dispatched with the DEPLOYED dispatcher config applied', async () => {
  const seen = {};
  const env = { AGENTCORE_EFS_FS_ID: 'fs-fromLaptop', ARCHIE_NAME: 'agent-gn0p84' };
  const c = capture();
  const code = await main(['fleet', 'stage', '--tag', 'content-x', '--region', 'us-east-1'], {
    streams: c.streams,
    env,
    // Stands in for the ECS read. The point of the assertion is the ORDER: the handler must see the
    // applied value, so this cannot be lazily resolved after dispatch.
    dispatcherEnv: async () => ({
      revision: 'agent-gn0p84-dispatcher:39',
      env: { AGENTCORE_EFS_FS_ID: 'fs-fromFleet', AGENTCORE_SECURITY_GROUP_ID: 'sg-fromFleet' },
    }),
    require: fakeRequire({
      'fleet stage': async () => {
        seen.fs = env.AGENTCORE_EFS_FS_ID;
        seen.sg = env.AGENTCORE_SECURITY_GROUP_ID;
        return { ok: true };
      },
    }),
  });
  assert.equal(code, EXIT.OK, c.stderr());
  // The FLEET's value wins over the ambient one: an AGENTCORE_* left exported in a shell is exactly
  // how one laptop's environment decides what the whole fleet provisions.
  assert.equal(seen.fs, 'fs-fromFleet', 'an ambient env var overrode the deployed fleet config');
  assert.equal(seen.sg, 'sg-fromFleet', 'a field the CLI never overrides did not reach the handler');
});

test('read-only commands do not require a deployed dispatcher', async () => {
  let called = false;
  const c = capture();
  const code = await main(['image', 'list', '--region', 'us-east-1'], {
    streams: c.streams,
    env: { ARCHIE_NAME: 'agent-gn0p84' },
    dispatcherEnv: async () => { called = true; return { env: {}, revision: 'x' }; },
    require: fakeRequire({ 'image list': async () => ({ ok: true }) }),
  });
  assert.equal(code, EXIT.OK, c.stderr());
  // `image list` reads DynamoDB. Making it depend on an ECS service it never talks to would be a
  // dependency invented by the fix rather than required by the command.
  assert.equal(called, false, 'a read-only command paid for an ECS round trip');
});

test('every command that builds a provisioning client declares needsFleetEnv', () => {
  const { COMMANDS, FLEET_ENV_COMMANDS } = require('../lib/registry');
  const fs = require('node:fs');
  const path = require('node:path');
  // Modules that construct the dispatcher's client, found in the source rather than restated — a
  // hand-maintained list would drift in exactly the direction that reintroduces the bug.
  const constructs = new Set();
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'cmd'))) {
    if (!f.endsWith('.js') || f.endsWith('.test.js')) continue;
    const src = fs.readFileSync(path.join(__dirname, '..', 'cmd', f), 'utf8');
    if (/createAgentCoreClient\(/.test(src)) constructs.add(f.replace(/\.js$/, ''));
  }
  const declared = new Set(FLEET_ENV_COMMANDS.map((k) => COMMANDS[k].module));
  for (const mod of constructs) {
    // healthcheck is the documented exception: its client only invokes an ARN it is handed.
    if (mod === 'healthcheck') continue;
    assert.ok(declared.has(mod), `cmd/${mod}.js builds a provisioning client but no command in `
      + 'FLEET_ENV_COMMANDS routes to it — it will run against pre-archie constants');
  }
});

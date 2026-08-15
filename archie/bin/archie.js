#!/usr/bin/env node
'use strict';

// `archie` — the fleet CLI. Entry point and dispatch.
//
// See clawdbot/ARCHIE.md for the front door, RUNTIME-CLI-REFERENCE.md for the full surface, and
// PHASE-1-TASKS.md for who owns what. This file owns argument parsing, dispatch and the exit code;
// it deliberately knows nothing about AWS.

const { parseArgs } = require('node:util');
const { EXIT, CliError, usage } = require('../lib/exit');
const { createOutput } = require('../lib/output');
const { createContext } = require('../lib/context');
const { COMMANDS, resolve, load } = require('../lib/registry');

const VERSION = require('../package.json').version;

// Global options, valid on every command. Parsed identically before or after the noun.
const GLOBAL_OPTIONS = {
  region: { type: 'string' },
  name: { type: 'string' },
  stack: { type: 'string' },                       // deprecated alias for --name
  profile: { type: 'string' },
  account: { type: 'string' },
  'dry-run': { type: 'boolean' },
  'no-dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  verbose: { type: 'boolean', short: 'v', multiple: true },
  json: { type: 'boolean' },
  timeout: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

function helpText() {
  const lines = [
    'archie — fleet CLI for the AgentCore agent fleet',
    '',
    'USAGE',
    '  archie [global options] <noun> <verb> [arguments] [options]',
    '  archie [global options] <deploy|preflight|status|version> [options]',
    '',
    'GLOBAL OPTIONS',
    '  --region <r>        REQUIRED for anything touching AWS. Never defaulted.',
    '  --name <n>          which archie deployment (default agent-gn0p84; env ARCHIE_NAME)',
    '  --profile <p>       AWS profile',
    '  --account <id>      assert the caller is in this account, or exit 3',
    '  --dry-run           print the plan; --no-dry-run to write',
    '  --yes               skip confirmation (does NOT imply --no-dry-run)',
    '  -v, --verbose       more detail; -vv includes bodies',
    '  --json              one JSON document on stdout, nothing else',
    '  --timeout <s>       raise a wait budget',
    '',
    'COMMANDS',
  ];
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [key, meta] of Object.entries(COMMANDS)) {
    const tag = meta.phase === 2 ? ' [phase 2]' : '';
    lines.push(`  ${key.padEnd(width)}  ${meta.summary}${tag}`);
  }
  lines.push('', 'Exit codes: 0 ok · 2 usage · 3 preflight · 4 TAINTED (stop) · 5 refused',
    '            6 PARTIAL (re-run) · 7 drift · 8 headroom · 124 timeout', '');
  return lines.join('\n');
}

/**
 * Parse in two passes.
 *
 * Pass 1 is permissive and only extracts positionals, because command-specific options are not known
 * until the command is. Pass 2 is STRICT over globals plus that command's own options, so a typo'd
 * flag is a usage error rather than being silently ignored — a silently-ignored --no-dry-run would
 * be a dry run the operator believed was real.
 */
function parse(argv, { commandOptions = {} } = {}) {
  const loose = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true, strict: false });
  const found = resolve(loose.positionals);
  // Command-specific options come from the REGISTRY, not from the command module. A command cannot
  // declare its own flags at load time, because parsing has to succeed before we know which module to
  // load — and a module that could add flags after parsing would make `--typo` silently valid for
  // some commands and not others. `commandOptions` stays injectable purely for tests.
  const declared = found ? (commandOptions[found.key] || (found.command && found.command.options) || {}) : {};
  const strict = parseArgs({
    args: argv,
    options: { ...GLOBAL_OPTIONS, ...declared },
    allowPositionals: true,
    strict: true,
  });
  // RE-RESOLVE from the STRICT positionals. Pass 1 knows only the global options, so a
  // command-specific flag's VALUE is parsed as a positional there — `generation stage --concurrency 9`
  // yields loose positionals ['generation','stage','9']. Handing that to the command means `9`
  // arrives as its id argument, which for `release set` or `generation taint` is a flag value
  // masquerading as a generation. Only the strict pass, which knows the command's own options, has
  // the real positionals; pass 1 exists solely to discover WHICH command that is.
  const resolved = resolve(strict.positionals) || found;
  return { found: resolved, values: strict.values, positionals: strict.positionals };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const streams = deps.streams || process;
  const env = deps.env || process.env;

  // --help and bare invocation short-circuit before any option validation: someone asking for help
  // should never be told their arguments are wrong.
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    streams.stdout.write(`${helpText()}\n`);
    return EXIT.OK;
  }

  let parsed;
  try {
    parsed = parse(argv, deps);
  } catch (e) {
    streams.stderr.write(`ERROR: ${e.message}\n`);
    return EXIT.USAGE;
  }

  const { found, values } = parsed;
  if (!found) {
    const attempted = parsed.positionals.slice(0, 2).join(' ') || '(none)';
    streams.stderr.write(`ERROR: unknown command: ${attempted}\n`
      + '       run `archie --help` for the command list\n');
    return EXIT.USAGE;
  }

  if (found.key === 'version') {
    streams.stdout.write(`${VERSION}\n`);
    return EXIT.OK;
  }

  let ctx;
  try {
    ctx = createContext(values, found.command, env);
  } catch (e) {
    streams.stderr.write(`ERROR: ${e.message}\n`);
    return e.exitCode || EXIT.USAGE;
  }

  const out = createOutput({
    json: ctx.json, verbosity: ctx.verbosity, dryRun: ctx.dryRun, streams, now: deps.now,
  });

  // Deprecation is a nudge, not an error: ARCHIE_STACK is baked into the deployed runtime image and
  // the BDD suite, so people will keep arriving with it set for a long time.
  if (ctx.usedDeprecatedStackFlag) {
    out.verbose(`note: --stack/ARCHIE_STACK is a deprecated alias for --name (using "${ctx.name}")`);
  }

  let code = EXIT.OK;
  try {
    // THE FLEET'S OWN CONFIGURATION, before any handler builds a provisioning client.
    //
    // `createAgentCoreClient` resolves what it is not given as `process.env.X || <constant>`, and on
    // a laptop none of those variables are set — so before this, every field archie did not override
    // resolved to a PRE-ARCHIE constant. `generation create` recorded the OpenClaw stack's security
    // group, dispatcher URL and secret names into a generation and reported success; `generation
    // stage` failed closed on a deleted filesystem. Applied here, once, rather than in each of the
    // nine client constructions, because the failure mode of one call site forgetting is a silently
    // wrong generation rather than an error.
    // AFTER `load`, deliberately: an unbuilt or phase-2 command must report that it does not exist
    // before the CLI spends an ECS round trip on configuration it will never use.
    const handler = load(found.key, found.command, deps);
    if (found.command.needsFleetEnv) {
      const { readDispatcherEnv, applyDispatcherEnv } = require('../lib/dispatcher-env');
      const fleet = await (deps.dispatcherEnv || readDispatcherEnv)(ctx, deps);
      applyDispatcherEnv(fleet.env, env);
      out.verbose(`fleet config from ${ctx.resources.dispatcherService} (${fleet.revision})`);
    }
    const result = await handler(ctx, { positionals: found.args, values }, out);
    if (result !== undefined) out.answer(result);
    // A command that recorded per-unit failures without throwing is PARTIAL, not OK — stragglers are
    // the designed re-run case and must not exit 0 (reference §1.5).
    if (out.failureCount() > 0) code = EXIT.PARTIAL;
  } catch (e) {
    code = e instanceof CliError ? e.exitCode : EXIT.FAILED;
    out.error(e);
  }
  return out.finish({ command: found.key, code, context: ctx });
}

/* istanbul ignore next — process wiring, exercised by the binary not by tests */
if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`ERROR: ${(e && e.message) || e}\n`);
    process.exitCode = EXIT.FAILED;
  });
}

module.exports = { main, parse, helpText, GLOBAL_OPTIONS, usage };

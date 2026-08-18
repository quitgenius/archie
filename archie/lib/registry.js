'use strict';

// THE COMMAND CONTRACT.
//
// Every command in RUNTIME-CLI-REFERENCE.md Appendix A is declared here, with the metadata the
// skeleton needs to route, validate and document it — before any of them are implemented. Two
// reasons it works this way:
//
//   1. `archie --help` is complete on day one. A command that is declared but unbuilt reports which
//      task owns it, rather than "unknown command", which is a much worse thing to hit at 2am.
//   2. The wave-1 tasks (PHASE-1-TASKS.md) each own ONE module file and implement against a fixed
//      shape. Nothing here changes as they land — a command lights up the moment its file exists.
//
// A command module exports { <verb>: async (ctx, args, out) => result }. Returning a value sets the
// envelope's `result`; throwing a CliError sets the exit code; per-unit failures go to out.failure()
// so `failures[]` names which agents failed rather than collapsing to one exit code.

const { CliError, EXIT } = require('./exit');

// `dryRunDefault: true` — destructive. Reference §1.3 and §5.5: writing requires --no-dry-run.
// `needsAws: false` — does not require --region.
// `phase: 2` — deliberately deferred (plan phase-1 scope block), declared so help can say so.
const COMMANDS = {
  // ── top level ────────────────────────────────────────────────────────────
  // WHAT THE GATEWAY HALF COSTS DEPENDS ON `SERVICE.deploymentConfiguration` (lib/task-definition.js),
  // so the summary names the shape rather than quoting a number. It said "~94s gateway outage", which
  // is stop-then-start's MEASURED gap (§6.1) and has not been the default since verification moved to
  // archie's own Slack app: live rolls measure ~118s of two overlapping Socket Mode connections and
  // zero downtime. A help line promising an outage that does not happen is how an operator learns to
  // discount the ones that do.
  // `skip-gc` was NESTED INSIDE hotfix's descriptor here (and in `fleet deploy` below), so it was not a
  // registered option at all — parseArgs runs strict, and cmd/fleet.js:233 reads a flag the parser would
  // have rejected. Fixed 2026-08-18 in both places; a misplaced brace, not a decision.
  deploy: { options: { hotfix:{type:'boolean'}, 'skip-gc':{type:'boolean'}, keep:{type:'string'}, 'skip-preflight':{type:'boolean'}, 'skip-policy':{type:'boolean'}, 'accept-policy-change':{type:'boolean'}, pure:{type:'boolean'}, 'agent-tag':{type:'string'}, 'gateway-tag':{type:'string'} }, top: true, module: 'deploy', task: 'W2-C', needsAws: true,
    summary: 'preflight, the agent half, then the gateway (rolling: an overlap, no outage; stop-then-start: a real gap)' },
  preflight: { options: { checks:{type:'string'}, skip:{type:'string'} }, top: true, module: 'preflight', task: 'W1-A', needsAws: true,
    summary: 'verify the target account has the infrastructure; never creates anything' },
  status: { options: { agents:{type:'string'}, brief:{type:'boolean'} }, top: true, module: 'status', task: 'W1-F', needsAws: true,
    summary: 'live tag, staged coverage, healthcheck failures, taint, drift' },
  version: { top: true, module: null, needsAws: false, summary: 'print the CLI version' },

  // ── gateway (ECS) ────────────────────────────────────────────────────────
  'gateway build': { options: { tag:{type:'string'}, push:{type:'boolean'}, platform:{type:'string'}, pure:{type:'boolean'} }, module: 'gateway', task: 'W1-B', needsAws: true, summary: 'build/push the amd64 dispatcher image' },
  'gateway deploy': { options: { tag:{type:'string'}, 'wait-timeout':{type:'string'}, 'no-wait':{type:'boolean'} }, module: 'gateway', task: 'W1-B', needsAws: true, summary: 'build+push this tree if needed, then roll the dispatcher and monitor to healthy' },
  'gateway status': { options: { check:{type:'boolean'} }, module: 'gateway', task: 'W1-B', needsAws: true, summary: 'which task definition and image is actually running' },
  'gateway compose': { options: {}, module: 'gateway', task: 'W3-D', needsAws: true, summary: 'compose the task definition from SSM + discovery and diff it against the running one' },

  // ── image (THE pointer) ──────────────────────────────────────────────────
  // The image tag is the release identity. There is no generation id and no second pointer: one
  // item, `CONFIG#image / FLEET`, decides what the fleet runs, and the dispatcher reads that item on
  // the next turn. See lib/image-pointer.js for why the generation model was removed.
  'image publish': { options: {}, module: 'image', task: 'W2-B', needsAws: true, positional: 'tag', summary: 'move the fleet to a tag (THE only command that moves traffic)' },
  // The policy layer. `publish` is the ONLY write; it takes no tag and no --env, because the pins file is
  // selected by the caller's ACCOUNT — publishing one environment's pins into another silently revokes
  // every capability the target's real scopes hold, and a flag would make that typeable (cmd/policy.js).
  'policy publish': { options: { 'accept-policy-change': { type: 'boolean' } }, module: 'policy', task: 'W6-B', needsAws: true, summary: 'compile the Cedar sources and write the fleet artifact + per-scope verdict rows' },
  'policy show': { options: {}, module: 'policy', task: 'W6-B', needsAws: true, summary: 'which policy digest the fleet is running, and whether it matches the sources on disk' },
  'image taint': { options: { reason:{type:'string'} }, module: 'image', task: 'W2-B', needsAws: true, positional: 'tag', summary: 'mark a tag permanently unpublishable; no untaint, no force' },
  'image show': { options: {}, module: 'image', task: 'W2-B', needsAws: true, positional: 'tag', summary: 'one tag: state, health, and every agent bound to it (defaults to live)' },
  'image list': { options: { limit:{type:'string'} }, module: 'image', task: 'W2-B', needsAws: true, summary: 'tags with bindings: coverage, health, which is live, which are rollback targets' },

  // ── runtimes and access points ───────────────────────────────────────────
  'runtime list': { options: { agent:{type:'string'}, tag:{type:'string'}, missing:{type:'boolean'}, failed:{type:'boolean'} }, module: 'runtime', task: 'W1-E', needsAws: true, summary: 'per-agent bindings for a tag' },
  'runtime delete': { options: { agent:{type:'string'}, tag:{type:'string'}, 'wait-timeout':{type:'string'}, 'no-wait':{type:'boolean'}, 'force-active':{type:'boolean'} }, module: 'runtime', task: 'W1-E', needsAws: true, dryRunDefault: true, summary: 'delete one runtime and wait for the name to release' },
  'runtime gc': { options: { keep:{type:'string'}, 'reconcile-aws':{type:'boolean'}, agents:{type:'string'} }, module: 'runtime', task: 'W1-E', needsAws: true, dryRunDefault: true, summary: 'retention-based reaping; --keep N means N rollback targets' },
  'access-point gc': { options: { tag:{type:'string'} }, module: 'runtime', task: 'W1-E', needsAws: true, dryRunDefault: true, summary: 'reap tagged EFS access points with no live runtime' },

  // ── fleet (the agent half) ───────────────────────────────────────────────
  'fleet build': { options: { tag:{type:'string'}, push:{type:'boolean'}, platform:{type:'string'}, pure:{type:'boolean'} }, module: 'fleet', task: 'W1-C', needsAws: true, summary: 'build/push the arm64 Pi runtime image (no deployment effect)' },
  'fleet stage': { options: { tag:{type:'string'}, agents:{type:'string'}, concurrency:{type:'string'}, 'healthcheck-budget':{type:'string'} }, module: 'stage', task: 'W1-D', needsAws: true, summary: 'provision + healthcheck + bind every agent onto a tag' },
  'fleet healthcheck': { options: { tag:{type:'string'}, agent:{type:'string'}, budget:{type:'string'}, prompt:{type:'string'}, 'taint-on-failure':{type:'boolean'}, 'no-taint-on-failure':{type:'boolean'} }, module: 'healthcheck', task: 'W2-A', needsAws: true, summary: 'one real invoke against one agent; taints the TAG on failure' },
  'fleet verify': { options: { tag:{type:'string'}, agent:{type:'string'} }, module: 'fleet', task: 'W1-C', needsAws: true, summary: 'assert observed runtime config matches the spec this deployment derives' },
  'fleet deploy': { options: { tag:{type:'string'}, 'skip-gc':{type:'boolean'}, hotfix:{type:'boolean'}, canary:{type:'string'}, concurrency:{type:'string'}, keep:{type:'string'}, 'skip-build':{type:'boolean'}, pure:{type:'boolean'} }, module: 'fleet', task: 'W2-C', needsAws: true, summary: 'the agent half of a release, end to end (zero downtime)' },
  'fleet drift': { options: { fix:{type:'boolean'}, compare:{type:'string'} }, module: 'fleet', task: 'W2-C', needsAws: true, summary: 'derived spec vs what is running; an efsRoot change BLOCKS' },
  'fleet reconcile': { options: { daemon:{type:'boolean'}, concurrency:{type:'string'}, interval:{type:'string'} }, module: 'fleet', task: null, phase: 2, needsAws: true, summary: 'drain the provisioning queue and sweep for missing bindings' },

  // ── per-agent primitives ─────────────────────────────────────────────────
  'agent ensure-role': { options: { tag:{type:'string'} }, module: 'agent', task: 'W1-H', needsAws: true, positional: 'agent', summary: 'get-or-create the derived per-agent exec role' },
  'agent ensure-access-point': { options: { 'efs-root':{type:'string'} }, module: 'agent', task: 'W1-H', needsAws: true, positional: 'agent', summary: 'get-or-create the agent EFS access point' },
  'agent ensure-connector': { options: {}, module: 'agent', task: 'W1-H', needsAws: true, positional: 'agent', summary: 'give the agent its own Connector project and key' },
  'agent seed-workspace': { options: {}, module: 'agent', task: 'W1-H', needsAws: true, positional: 'agent', summary: 'pre-write the agent workspace SEED' },
  'agent ensure-runtime': { options: { tag:{type:'string'} }, module: 'agent', task: 'W1-H', needsAws: true, positional: 'agent', summary: 'the full provisioning saga for one agent' },
  'agent migrate': { options: { agents:{type:'string'}, tag:{type:'string'}, 'skip-config':{type:'boolean'}, 'skip-runtimes':{type:'boolean'}, 'skip-cron':{type:'boolean'} }, module: 'agent', task: 'W1-H', needsAws: true, summary: 'config hydrate, ensure runtimes, fold in per-agent cron' },
  'agent rekey': { options: { 'to-scope':{type:'boolean'} }, module: 'agent', task: 'W1-H', needsAws: true, dryRunDefault: true, positional: 'agent', summary: 'move an agent identity to a scope key, carrying GRANT#' },
  'agent teardown': { options: { 'name-re':{type:'string'}, 'skip-re':{type:'string'} }, module: 'agent', task: 'W1-H', needsAws: true, dryRunDefault: true, summary: 'delete runtimes, access points and table items (guarded)' },
  'agent create': { options: {}, module: 'agent', task: null, phase: 2, needsAws: true, positional: 'agent', summary: 'mint an agent identity and enqueue provisioning' },

  // ── config, grants, cron, observability ──────────────────────────────────
  'config hydrate': { options: { ref:{type:'string'}, 'sandra-dir':{type:'string'}, agents:{type:'string'} }, module: 'wrappers', task: 'W1-G', needsAws: true, dryRunDefault: true, summary: 'git config repo -> DynamoDB (--agents to scope it)' },
  'config hydrate-conversations': { options: { file:{type:'string'}, s3:{type:'string'} }, module: 'wrappers', task: 'W1-G', needsAws: true, dryRunDefault: true, summary: 'conversations snapshot -> DynamoDB' },
  'config validate': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: false, summary: 'requires-closure, routing single-source, round-trip gates' },
  'config parity': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'config vs deployed parity checks' },
  'grants reconcile': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'recompute GRANT#*, write it, then rewrite the role policy' },
  'grants apply': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'rewrite the role policy only, from GRANT#* as stored' },
  'cron hydrate': { options: { as:{type:'string'} }, module: 'wrappers', task: 'W1-G', needsAws: true, dryRunDefault: true, positional: 'agent', summary: 'fold an agent EFS cron store into the dispatcher store' },
  'cron list': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'list scheduled jobs via the manager API' },
  'cron arm': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'arm the cron scheduler' },
  'cron disarm': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'disarm the cron scheduler' },
  'dashboard deploy': { options: { dashboard:{type:'string'} }, module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'PutDashboard for the fleet board' },
  'dashboard deploy-latency': { options: {}, module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'PutDashboard for the turn-latency SLO board' },
  'metrics query': { options: { agent:{type:'string'} }, module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'query', summary: 'run a curated Insights/metric query' },
};

// ── commands that must run with the FLEET's configuration, not the laptop's ───────────────────────
//
// Every command here builds `createAgentCoreClient`, which resolves what it is not given as
// `process.env.X || <constant>`. The deployed dispatcher sets those variables from its task
// definition; a laptop sets none of them, so before this list existed each of these commands
// silently fell back to the PRE-ARCHIE OpenClaw constants — staging recorded that stack's security
// group, dispatcher URL and secret names into the derived spec and reported success. It matters more
// now than it did then: the name is DERIVED on both sides rather than stored on one, so a wrong
// environment here does not write a wrong record, it produces a different name from the one the
// dispatcher will derive and the two halves stop meeting.
// `bin/archie.js` reads the deployed task definition and applies it before dispatch.
//
// Declared as a SET here rather than a field on each entry so the list is readable as a list — the
// question "which commands provision?" is one an operator asks, and fifteen scattered booleans do
// not answer it. `registry.test.js` holds it to the modules that actually construct a client.
//
// Deliberately absent: `fleet healthcheck`. Its client only ever calls `invokeStreaming` against
// an ARN it is given — no EFS, no security group, no secret names — so requiring a deployed
// dispatcher to run one would be a dependency it does not have.
const FLEET_ENV_COMMANDS = [
  'deploy',
  'fleet verify', 'fleet stage',
  'fleet deploy', 'fleet drift', 'fleet reconcile',
  'agent ensure-role', 'agent ensure-access-point', 'agent ensure-connector',
  'agent seed-workspace', 'agent ensure-runtime', 'agent migrate', 'agent rekey',
  'agent teardown', 'agent create',
];
for (const key of FLEET_ENV_COMMANDS) {
  if (!COMMANDS[key]) throw new Error(`FLEET_ENV_COMMANDS names an unknown command: ${key}`);
  COMMANDS[key].needsFleetEnv = true;
}

// The plan §5 spellings, kept so runbooks written against the plan do not break. Undocumented in
// help; --json always reports the canonical name.
const ALIASES = {
  'create-gateway-image': 'gateway build',
  'deploy-gateway': 'gateway deploy',
  'create-agent-image': 'fleet build',
  'deploy-agents': 'fleet deploy',
  'set-active-runtime': 'image publish',
  'set-new-runtime': 'image publish',
  'get-available-runtimes': 'image list',
  taint: 'image taint',
};

// TWO-WORD ALIASES — the `generation`/`release` nouns, removed when the image tag became the release
// identity. Kept because a runbook that fails at 2am with "unknown command" is the worst possible
// moment to discover a rename, and because the arguments still line up: every one of these took a
// generation id where its replacement takes a tag, and `--generation` is accepted as `--tag`.
//
// `generation create` is deliberately ABSENT rather than aliased. There is nothing for it to do — a
// build produces a tag and there is no record to cut — so mapping it to something that silently
// succeeded would be worse than saying it is gone.
const NOUN_ALIASES = {
  'generation build': 'fleet build',
  'generation stage': 'fleet stage',
  'generation healthcheck': 'fleet healthcheck',
  'generation verify': 'fleet verify',
  'generation list': 'image list',
  'generation show': 'image show',
  'generation taint': 'image taint',
  'release set': 'image publish',
  'release publish-image': 'image publish',
  'release show': 'image show',
  'release history': 'image list',
};

/**
 * Resolve positionals to a command.
 *
 * Tries the two-word form first so `generation list` wins over a hypothetical `generation`; falls
 * back to the one-word top-level form. Returns the canonical key, the metadata, and whatever
 * positionals remain as arguments.
 */
function resolve(positionals) {
  const [first, second] = positionals;
  if (!first) return null;

  const aliased = ALIASES[first];
  if (aliased) {
    return { key: aliased, command: COMMANDS[aliased], args: positionals.slice(1), viaAlias: first };
  }

  const two = second ? `${first} ${second}` : null;
  if (two && COMMANDS[two]) return { key: two, command: COMMANDS[two], args: positionals.slice(2) };
  if (two && NOUN_ALIASES[two]) {
    const key = NOUN_ALIASES[two];
    return { key, command: COMMANDS[key], args: positionals.slice(2), viaAlias: two };
  }
  if (COMMANDS[first] && COMMANDS[first].top) return { key: first, command: COMMANDS[first], args: positionals.slice(1) };
  return null;
}

/**
 * Load a command's implementation.
 *
 * An unbuilt command names the task that owns it. "unknown command" would be a lie — it is known,
 * it just is not written yet — and the distinction is the difference between "I typed it wrong" and
 * "this is not built".
 */
function load(key, command, { require: req = require } = {}) {
  if (command.phase === 2) {
    throw new CliError(`\`archie ${key}\` is deferred to phase 2 and is not built`, {
      code: EXIT.USAGE,
      detail: 'Phase 1 is the CLI only — see archie-runner/RUNTIME-RELEASE-PLAN.md, phase-1 scope block.',
    });
  }
  if (!command.module) return null;
  let mod;
  try {
    mod = req(`../cmd/${command.module}`);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(command.module)) {
      // No `cause`: the message already says exactly what is wrong, and a MODULE_NOT_FOUND require
      // stack underneath it reads like a broken install rather than an unwritten command.
      throw new CliError(`\`archie ${key}\` is not implemented yet`, {
        code: EXIT.USAGE,
        detail: `Owned by task ${command.task} (cmd/${command.module}.js) — see archie-runner/PHASE-1-TASKS.md.`,
      });
    }
    throw e;
  }
  const verb = key.includes(' ') ? key.split(' ').slice(1).join(' ') : key;
  // FULL KEY FIRST, verb second — and the order is a safety property, not a preference.
  //
  // Verbs are NOT unique across nouns: `runtime gc` and `access-point gc` share `gc`, as do
  // `config hydrate` and `cron hydrate`. With verb-first precedence, a module that exported a bare
  // `gc` would answer for BOTH commands — so `archie access-point gc --no-dry-run` would run the
  // runtime reaper and delete 208 runtimes. That is not hypothetical: two modules independently
  // avoided it by exporting only full keys, which made correctness depend on every future author
  // noticing the collision.
  //
  // Key-first makes it safe by construction: an unambiguous full key always wins, and the verb
  // fallback still serves the majority of commands whose verb is unique to their noun.
  const handler = mod[key] || mod[verb];
  if (typeof handler !== 'function') {
    throw new CliError(`\`archie ${key}\` is declared but cmd/${command.module}.js exports no "${verb}"`, {
      code: EXIT.USAGE,
      detail: `Owned by task ${command.task} — see archie-runner/PHASE-1-TASKS.md.`,
    });
  }
  return handler;
}

module.exports = {
  COMMANDS, ALIASES, NOUN_ALIASES, FLEET_ENV_COMMANDS, resolve, load,
};

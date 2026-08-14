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
  deploy: { top: true, module: 'deploy', task: 'W2-C', needsAws: true,
    summary: 'preflight, then the agent half, then the gateway (ends with ~94s gateway outage)' },
  preflight: { top: true, module: 'preflight', task: 'W1-A', needsAws: true,
    summary: 'verify the target account has the infrastructure; never creates anything' },
  status: { top: true, module: 'status', task: 'W1-F', needsAws: true,
    summary: 'active generation, staged coverage, healthcheck failures, taint, drift' },
  version: { top: true, module: null, needsAws: false, summary: 'print the CLI version' },

  // ── gateway (ECS) ────────────────────────────────────────────────────────
  'gateway build': { module: 'gateway', task: 'W1-B', needsAws: true, summary: 'build/push the amd64 dispatcher image' },
  'gateway deploy': { module: 'gateway', task: 'W1-B', needsAws: true, summary: 'roll the dispatcher service and monitor to healthy' },
  'gateway status': { module: 'gateway', task: 'W1-B', needsAws: true, summary: 'which task definition and image is actually running' },

  // ── generation ───────────────────────────────────────────────────────────
  'generation build': { module: 'generation', task: 'W1-C', needsAws: true, summary: 'build/push the arm64 Pi runtime image' },
  'generation create': { module: 'generation', task: 'W1-C', needsAws: true, summary: 'write CONFIG#generation; nothing goes live' },
  'generation list': { module: 'generation', task: 'W1-C', needsAws: true, summary: 'generations, coverage, health, which is live, which are rollback targets' },
  'generation show': { module: 'generation', task: 'W1-C', needsAws: true, positional: 'generationId', summary: 'one generation: declared spec and per-agent bindings' },
  'generation stage': { module: 'stage', task: 'W1-D', needsAws: true, summary: 'provision + healthcheck + bind every agent onto a generation' },
  'generation healthcheck': { module: 'healthcheck', task: 'W2-A', needsAws: true, summary: 'one real invoke against one agent; taints the generation on failure' },
  'generation verify': { module: 'generation', task: 'W1-C', needsAws: true, summary: 'assert observed runtime config matches the declared spec' },
  'generation taint': { module: 'release', task: 'W2-B', needsAws: true, positional: 'generationId', summary: 'mark a generation permanently unpointable' },

  // ── release pointer ──────────────────────────────────────────────────────
  'release set': { module: 'release', task: 'W2-B', needsAws: true, positional: 'generationId', summary: 'move the live pointer (the only command that moves traffic)' },
  'release show': { module: 'release', task: 'W2-B', needsAws: true, summary: 'the active generation and how it was published' },
  'release history': { module: 'release', task: 'W2-B', needsAws: true, summary: 'previous pointer values' },

  // ── runtimes and access points ───────────────────────────────────────────
  'runtime list': { module: 'runtime', task: 'W1-E', needsAws: true, summary: 'per-agent bindings for a generation' },
  'runtime delete': { module: 'runtime', task: 'W1-E', needsAws: true, dryRunDefault: true, summary: 'delete one runtime and wait for the name to release' },
  'runtime gc': { module: 'runtime', task: 'W1-E', needsAws: true, dryRunDefault: true, summary: 'retention-based reaping; --keep N means N rollback targets' },
  'access-point gc': { module: 'runtime', task: 'W1-E', needsAws: true, dryRunDefault: true, summary: 'reap tagged EFS access points with no live runtime' },

  // ── fleet ────────────────────────────────────────────────────────────────
  'fleet deploy': { module: 'fleet', task: 'W2-C', needsAws: true, summary: 'the agent half of a release, end to end (zero downtime)' },
  'fleet drift': { module: 'fleet', task: 'W2-C', needsAws: true, summary: 'derived spec vs what is running; an efsRoot change BLOCKS' },
  'fleet reconcile': { module: 'fleet', task: null, phase: 2, needsAws: true, summary: 'drain the provisioning queue and sweep for missing bindings' },

  // ── per-agent primitives ─────────────────────────────────────────────────
  'agent ensure-role': { module: 'agent', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'get-or-create the derived per-agent exec role' },
  'agent ensure-access-point': { module: 'agent', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'get-or-create the agent EFS access point' },
  'agent ensure-connector': { module: 'agent', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'give the agent its own Connector project and key' },
  'agent seed-workspace': { module: 'agent', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'pre-write the agent workspace SEED' },
  'agent ensure-runtime': { module: 'agent', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'the full provisioning saga for one agent' },
  'agent migrate': { module: 'agent', task: 'W1-G', needsAws: true, summary: 'config hydrate, ensure runtimes, fold in per-agent cron' },
  'agent rekey': { module: 'agent', task: 'W1-G', needsAws: true, dryRunDefault: true, positional: 'agent', summary: 'move an agent identity to a scope key, carrying GRANT#' },
  'agent teardown': { module: 'agent', task: 'W1-G', needsAws: true, dryRunDefault: true, summary: 'delete runtimes, access points and table items (guarded)' },
  'agent create': { module: 'agent', task: null, phase: 2, needsAws: true, positional: 'agent', summary: 'mint an agent identity and enqueue provisioning' },

  // ── config, grants, cron, observability ──────────────────────────────────
  'config hydrate': { module: 'wrappers', task: 'W1-G', needsAws: true, dryRunDefault: true, summary: 'git config repo -> DynamoDB' },
  'config hydrate-conversations': { module: 'wrappers', task: 'W1-G', needsAws: true, dryRunDefault: true, summary: 'conversations snapshot -> DynamoDB' },
  'config validate': { module: 'wrappers', task: 'W1-G', needsAws: false, summary: 'requires-closure, routing single-source, round-trip gates' },
  'config parity': { module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'config vs deployed parity checks' },
  'grants reconcile': { module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'recompute GRANT#*, write it, then rewrite the role policy' },
  'grants apply': { module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'rewrite the role policy only, from GRANT#* as stored' },
  'cron hydrate': { module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'agent', summary: 'fold an agent EFS cron store into the dispatcher store' },
  'cron list': { module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'list scheduled jobs via the manager API' },
  'cron arm': { module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'arm the cron scheduler' },
  'cron disarm': { module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'disarm the cron scheduler' },
  'dashboard deploy': { module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'PutDashboard for the fleet board' },
  'dashboard deploy-latency': { module: 'wrappers', task: 'W1-G', needsAws: true, summary: 'PutDashboard for the turn-latency SLO board' },
  'metrics query': { module: 'wrappers', task: 'W1-G', needsAws: true, positional: 'query', summary: 'run a curated Insights/metric query' },
};

// The plan §5 spellings, kept so runbooks written against the plan do not break. Undocumented in
// help; --json always reports the canonical name.
const ALIASES = {
  'create-gateway-image': 'gateway build',
  'deploy-gateway': 'gateway deploy',
  'create-agent-image': 'generation build',
  'deploy-agents': 'fleet deploy',
  'set-active-runtime': 'release set',
  'set-new-runtime': 'release set',
  'get-available-runtimes': 'generation list',
  taint: 'generation taint',
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
      detail: 'Phase 1 is the CLI only — see clawdbot/RUNTIME-RELEASE-PLAN.md, phase-1 scope block.',
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
        detail: `Owned by task ${command.task} (cmd/${command.module}.js) — see clawdbot/PHASE-1-TASKS.md.`,
      });
    }
    throw e;
  }
  const verb = key.includes(' ') ? key.split(' ').slice(1).join(' ') : key;
  const handler = mod[verb] || mod[key];
  if (typeof handler !== 'function') {
    throw new CliError(`\`archie ${key}\` is declared but cmd/${command.module}.js exports no "${verb}"`, {
      code: EXIT.USAGE,
      detail: `Owned by task ${command.task} — see clawdbot/PHASE-1-TASKS.md.`,
    });
  }
  return handler;
}

module.exports = { COMMANDS, ALIASES, resolve, load };

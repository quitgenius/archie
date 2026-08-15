'use strict';

// "What configuration does the fleet ACTUALLY run with?" — read from the deployed dispatcher's task
// definition, not guessed from the laptop the CLI happens to be running on.
//
// ── THE BUG THIS EXISTS TO KILL ──────────────────────────────────────────────────────────────────
// `createAgentCoreClient` resolves every field it is not given as `process.env.X || <constant>`
// (agentcore-client.js:45-143). In the deployed dispatcher those variables are all set by the task
// definition, so the constants never fire. The CLI runs on a laptop where NONE of them are set, so
// every field archie did not explicitly override fell through to the constant — and the constants
// are the PRE-ARCHIE OpenClaw stack:
//
//   securityGroupId  sg-REDACTED                      (real: sg-REDACTED)
//   efsFsId          fs-REDACTED                      (deleted; real: fs-REDACTED)
//   credentialSecret   agent-4ggvzl-connector-api-key     (real: agent-gn0p84-…)
//   dispatcherBaseUrl https://dispatcher.sandra-test.…         (the OpenClaw dispatcher)
//
// The first sandbox rehearsal caught it, and the failure that surfaced — `FileSystemNotFound` — was
// the LEAST bad symptom, because it failed closed. The dangerous one was silent: `generation create`
// recorded all of the above into the generation's `runtimeEnv`, computed `specDigest` over it, and
// stored it. Every runtime staged from that generation would have read ANOTHER STACK'S SECRETS and
// called the wrong dispatcher, with nothing in the output to say so.
//
// So the comment this replaces — "a generation records what the dispatcher WOULD have used" — was
// false in the way that matters. It recorded what a dispatcher with an EMPTY ENVIRONMENT would have
// used. This module makes the sentence true.
//
// ── PRECEDENCE, AND WHY THE TASK DEFINITION WINS ─────────────────────────────────────────────────
// A value here beats an ambient local environment variable. That is deliberate and is the whole
// point: an `AGENTCORE_*` left exported in a shell is exactly how one operator's laptop bakes itself
// into a fleet-wide generation, which is the class of bug above. Deliberate overrides belong on the
// command line (`--set`), where they are recorded, not in ambient state.
//
// The CLI's own `--name`-derived names still win over both — `--name` is the operator's declared
// target, and a task definition that disagrees with it is a fault `archie preflight` check 16
// reports rather than something to silently follow.

const { makeClient } = require('./aws');
const { preflight } = require('./exit');

/** ECS/AWS_ variables are the RUNNER's business, not the fleet's — never let a task def rewrite them. */
const isRunnerVar = (k) => /^(AWS_|ECS_|NODE_OPTIONS$)/.test(k);

/**
 * The deployed dispatcher's service, task definition and container environment.
 *
 * Same derivation `cmd/preflight.js:380-394` performs for check 15/16, hoisted so the gate and the
 * commands that provision read one implementation. A dispatcher that is not deployed is a hard
 * error rather than a fallback: provisioning against baked constants is precisely what this module
 * exists to prevent, so there is nothing safe to degrade to.
 */
async function readDispatcherEnv(ctx, deps = {}) {
  const { cluster, dispatcherService } = ctx.resources;
  const { DescribeServicesCommand, DescribeTaskDefinitionCommand } = require('@aws-sdk/client-ecs');
  const ecs = deps.ecs || makeClient(ctx, '@aws-sdk/client-ecs', 'ECSClient');

  const { services = [], failures = [] } = await ecs.send(new DescribeServicesCommand({
    cluster, services: [dispatcherService],
  }));
  const svc = services.find((s) => s.status !== 'INACTIVE') || services[0];
  if (!svc) {
    const why = failures.length
      ? failures.map((f) => `${f.arn || dispatcherService}: ${f.reason}`).join(', ')
      : 'no such service';
    throw preflight(`cannot read the deployed dispatcher's configuration `
      + `(ecs:DescribeServices ${cluster}/${dispatcherService}: ${why})`, {
      detail: 'This command provisions, and provisioning needs the fleet\'s real EFS filesystem, '
        + 'security group and secret names — which live in the dispatcher\'s task definition. There is '
        + 'deliberately no fallback: the client\'s own defaults are the pre-archie OpenClaw stack, and '
        + 'using them silently records another deployment\'s configuration into a generation. '
        + `Check --name (${ctx.resources.name}) names a deployed stack, or run \`archie preflight\`.`,
    });
  }

  const { taskDefinition: td } = await ecs.send(new DescribeTaskDefinitionCommand({
    taskDefinition: svc.taskDefinition,
  }));
  const containers = (td && td.containerDefinitions) || [];
  const container = containers.find((c) => /dispatcher|archie/i.test(c.name)) || containers[0] || {};
  const env = {};
  for (const e of container.environment || []) if (!isRunnerVar(e.name)) env[e.name] = e.value;
  return {
    env, service: svc, taskDefinition: td, revision: (td && td.taskDefinitionArn || '').split('/').pop(),
  };
}

/**
 * Apply the fleet's environment to this process, so `createAgentCoreClient`'s own `process.env`
 * lookups resolve to what the dispatcher runs.
 *
 * Applied to `process.env` rather than mapped field-by-field ONTO the overrides object on purpose:
 * the mapping would have to be maintained against every field agentcore-client.js reads, and the
 * failure mode of forgetting one is a value that silently reverts to a pre-archie constant — the
 * exact bug. Setting the environment covers fields nobody has thought about yet, including ones
 * added after this was written.
 *
 * Safe to leave applied: `createAgentCoreClient` captures its config at construction
 * (agentcore-client.js:45-143) and `runtimeEnv` reads that captured config (:319-326), so nothing
 * re-reads the environment later. The returned function restores it anyway, for tests.
 */
function applyDispatcherEnv(env, target = process.env) {
  const previous = new Map();
  for (const [k, v] of Object.entries(env || {})) {
    if (isRunnerVar(k)) continue;
    previous.set(k, target[k]);
    target[k] = v;
  }
  return function restore() {
    for (const [k, v] of previous) {
      if (v === undefined) delete target[k];
      else target[k] = v;
    }
  };
}

module.exports = { readDispatcherEnv, applyDispatcherEnv, isRunnerVar };

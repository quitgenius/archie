'use strict';

// Global options and the resource names they derive — RUNTIME-CLI-REFERENCE.md §1.2.
//
// TWO RULES THIS FILE EXISTS TO ENFORCE:
//
// 1. `--region` is NEVER defaulted. A profile's configured region is routinely not the deployment's:
//    `[profile sandbox]` is us-east-2 while archie runs in us-east-1 (agentcore-fixture.js:304-309),
//    and "the two halves of this file were therefore talking to different regions" is a bug that has
//    already happened here. Silence is not a safe default when the wrong answer is plausible.
//
// 2. ONE knob derives every resource name. Deriving some names from `--name` and leaving others on a
//    literal produced "a board whose METRIC widgets read archie and whose LOG widgets read the
//    OpenClaw stack" (insight-queries.js:29-48). Worse, a wrong value does not error: the OpenClaw
//    namespaces and log group are real and populated, so it renders another system's fleet as if it
//    were yours (deploy-dashboard.cjs:160-181). Everything below comes from one string.

const { usage } = require('./exit');

const DEFAULT_NAME = 'agent-gn0p84';

/**
 * Every resource name the CLI touches, from one deployment name.
 *
 * `name` maps 1:1 to Terraform's `var.name` on modules/archie — described there as "Resource name
 * prefix, e.g. agent-gn0p84" and supplied as `archie_name` in tfvars. Keeping the same word on both
 * sides is the point: an operator correlating the CLI against Terraform reads one identifier.
 *
 * NOTE: these are DERIVED, not verified. `archie preflight` is what proves they exist (checks 2, 5,
 * 15) — deriving a name that is absent must fail as "this resource is missing", never as a bare
 * ResourceNotFoundException with no table name and no operation (agentcore-fixture.js:384-386).
 */
function resourcesFor(name) {
  return {
    name,
    configTable: `${name}-agent-config`,
    gatewayRepo: `${name}-gateway`,
    agentRepo: `${name}-agentcore`,
    cluster: name,
    dispatcherService: `${name}-dispatcher`,
    dispatcherLogGroup: `/ecs/${name}-dispatcher`,
    dispatcherNamespace: `${name}Dispatcher`,
    cronNamespace: `${name}Cron`,
  };
}

/**
 * Resolve the deployment name.
 *
 * ARCHIE_STACK is still read, and not on a deprecation timer: it is baked into the deployed runtime
 * image's otel_* tools, the BDD support code and the dashboard deployers (insight-queries.js:48).
 * Renaming it everywhere is a separate change with its own blast radius, and the CLI should not
 * force it. ARCHIE_NAME wins when both are set.
 */
function resolveName(values, env) {
  return values.name
    || values.stack            // deprecated flag alias
    || env.ARCHIE_NAME
    || env.ARCHIE_STACK
    || DEFAULT_NAME;
}

/**
 * Build the run context from parsed globals.
 *
 * @param values   parsed option values
 * @param command  the resolved command's metadata (needsAws, dryRunDefault)
 * @param env      process.env, injectable
 */
function createContext(values, command, env = process.env) {
  if (values['dry-run'] && values['no-dry-run']) {
    throw usage('--dry-run and --no-dry-run are mutually exclusive');
  }

  // Dry-run default is PER COMMAND: destructive commands default ON (reference §1.3). Resolving it
  // here rather than in each command is what keeps that promise uniform — a command that forgot to
  // check would otherwise silently delete.
  const dryRunDefault = Boolean(command && command.dryRunDefault);
  const dryRun = values['no-dry-run'] ? false : (values['dry-run'] ? true : dryRunDefault);

  const name = resolveName(values, env);
  const region = values.region || null;

  // Only AWS-touching commands require a region. `archie version` should not need credentials or a
  // region to tell you what it is.
  if (command && command.needsAws && !region) {
    throw usage('--region is required (it is deliberately not defaulted — a profile\'s region is '
      + 'routinely not the deployment\'s)');
  }

  const timeout = values.timeout === undefined ? null : Number(values.timeout);
  if (timeout !== null && (!Number.isFinite(timeout) || timeout <= 0)) {
    throw usage(`--timeout must be a positive number of seconds, got "${values.timeout}"`);
  }

  return {
    name,
    region,
    profile: values.profile || env.AWS_PROFILE || null,
    account: values.account || null,
    dryRun,
    dryRunWasExplicit: Boolean(values['dry-run'] || values['no-dry-run']),
    assumeYes: Boolean(values.yes),
    json: Boolean(values.json),
    // -v is `multiple`, so repetition counts: -v => 1, -vv => 2.
    verbosity: Array.isArray(values.verbose) ? values.verbose.length : (values.verbose ? 1 : 0),
    timeoutSeconds: timeout,
    resources: resourcesFor(name),
    usedDeprecatedStackFlag: Boolean(values.stack) || (!values.name && !env.ARCHIE_NAME && Boolean(env.ARCHIE_STACK)),
  };
}

module.exports = { createContext, resourcesFor, resolveName, DEFAULT_NAME };

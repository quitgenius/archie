'use strict';

// AWS client construction, in one place.
//
// WHY THIS EXISTS. The obvious spelling is wrong: `@aws-sdk/credential-provider-node` exports
// `defaultProvider`, NOT `fromNodeProviderChain`. Reaching for the latter throws a bare TypeError,
// and it throws only when a real profile is used — every unit test injects its client, so the whole
// suite stays green while `--profile` fails on the first live run. That is the failure shape this
// repo keeps re-learning: green tests, broken binary, discovered against real AWS.
//
// It is centralised rather than repeated per command so there is exactly one place to be wrong.

const { EXIT, CliError } = require('./exit');

/**
 * Credentials for a run. Returns undefined when no profile is set, which lets the SDK use its own
 * default chain (env vars, ECS task role, EC2 IMDS) — the CLI must work unattended in CI, not only
 * from a developer's configured profile.
 */
function credentialsFor(profile) {
  if (!profile) return undefined;
  const mod = require('@aws-sdk/credential-provider-node');
  // Accept either spelling: the export was `fromNodeProviderChain` in some SDK versions and
  // `defaultProvider` in the one pinned here. Tolerating both costs nothing and removes a whole
  // class of "works on my SDK" breakage.
  const make = mod.defaultProvider || mod.fromNodeProviderChain;
  if (typeof make !== 'function') {
    throw new CliError('cannot construct AWS credentials: @aws-sdk/credential-provider-node exports '
      + `neither defaultProvider nor fromNodeProviderChain (got: ${Object.keys(mod).join(', ')})`,
      { code: EXIT.FAILED });
  }
  return make({ profile });
}

/**
 * Standard client config. Every client in the CLI is built from this, so region and credential
 * handling cannot drift between commands.
 */
function clientConfig(ctx, extra = {}) {
  return {
    region: ctx.region,
    ...(ctx.profile ? { credentials: credentialsFor(ctx.profile) } : {}),
    ...extra,
  };
}

/**
 * Construct a client, reporting a missing package by NAME rather than crashing.
 *
 * The CLI's dependency list is long and a missing one otherwise surfaces as MODULE_NOT_FOUND with a
 * require stack — which reads like a broken install rather than "this package is not declared".
 */
function makeClient(ctx, pkg, exportName, extra = {}) {
  let mod;
  try {
    mod = require(pkg);
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') {
      throw new CliError(`${pkg} is not installed`, {
        code: EXIT.FAILED,
        detail: `Add it to archie/package.json and run npm install in archie/.`,
        cause: e,
      });
    }
    throw e;
  }
  const Ctor = mod[exportName];
  if (typeof Ctor !== 'function') {
    throw new CliError(`${pkg} exports no ${exportName}`, { code: EXIT.FAILED });
  }
  return new Ctor(clientConfig(ctx, extra));
}

module.exports = { credentialsFor, clientConfig, makeClient };

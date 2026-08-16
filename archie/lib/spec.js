'use strict';

// THE SPEC ENGINE — how archie and the dispatcher agree on what a runtime is called.
//
// This is the load-bearing idea of the whole CLI and it survives the removal of generations intact:
// the runtime name is a fingerprint of the WHOLE immutable spec, and BOTH writers compute it from
// the dispatcher's own `runtimeSpecFor`, required rather than reimplemented. That is why archie can
// stage `oc_dm_ux0mz5ckp2r_18c7166b` and the dispatcher, independently, on another machine, minutes
// later, derive the identical string and hit the row archie wrote. A locally re-implemented
// `canonicalize` or `runtimeEnv` is the single failure this design exists to prevent.
//
// ── WHY THERE IS NO LONGER A FLEET TEMPLATE ──────────────────────────────────────────────────────
//
// There used to be ~200 lines here: `fleetSpecFrom` produced a fleet-level template by calling
// `runtimeSpecFor` for a sentinel agent and stripping the two per-agent terms (`efsRoot`,
// `envs.AGENT_NAME`), `derivedSpecFor` expanded it back per agent, and a drift guard failed the
// command if any OTHER per-agent field ever leaked into the template.
//
// All of that existed to STORE the template in `CONFIG#generation/<id>` and re-expand it later. With
// the generation item gone the split has nothing to serve: `runtimeSpecFor(agent, image)` already
// returns the per-agent spec directly, which is the shape everything downstream wants — it is what
// `generationRuntimeName` fingerprints and what `specFromGet`'s read-back is diffed against.
//
// The objection this answers, because the old code stated it as a rule: "built from the STORED
// template, never from the current environment — re-deriving from process.env would compare the
// fleet against today's task definition". True, and no longer a loss, because the comparison moved
// somewhere better. Verification now diffs DERIVED (what today's deployment says this agent should
// run) against OBSERVED (`GetAgentRuntime`, what it is actually running). Observed state cannot
// drift from reality the way a stored declaration can, and the stored declaration could never prove
// anything about the runtime anyway — only about what someone once intended.
//
// What is genuinely gone is "what did we DECLARE last Tuesday". That is history, and history comes
// from CloudTrail and OTEL rather than a table we maintain and must keep honest.

const { CliError, EXIT, preflight } = require('./exit');
const { makeClient } = require('./aws');

/**
 * AWS clients, constructed lazily so a command that never touches ECR never builds an ECR client.
 *
 * `--profile` also has to reach the clients the DISPATCHER'S client constructs for itself
 * (agentcore-client.js builds its own control/EFS clients from `config.region` and the default
 * credential chain — there is no credentials seam to inject). AWS_PROFILE is the only channel that
 * reaches those, and it costs nothing for lib/aws.js's own clients, which take an explicit provider.
 */
function clientsFor(ctx, deps = {}) {
  if (ctx.profile && process.env.AWS_PROFILE !== ctx.profile) process.env.AWS_PROFILE = ctx.profile;

  let doc = deps.doc || null;
  let ecr = deps.ecr || null;
  let sts = deps.sts || null;

  return {
    doc() {
      if (!doc) {
        const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
        doc = DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient'));
      }
      return doc;
    },
    get docCmds() { return require('@aws-sdk/lib-dynamodb'); },
    ecr() {
      if (!ecr) ecr = makeClient(ctx, '@aws-sdk/client-ecr', 'ECRClient');
      return ecr;
    },
    sts() {
      if (!sts) sts = makeClient(ctx, '@aws-sdk/client-sts', 'STSClient');
      return sts;
    },
  };
}

/**
 * The dispatcher's AgentCore client, configured for THIS deployment.
 *
 * `createAgentCoreClient` resolves its own defaults from `process.env`, which is exactly the state
 * this CLI replaces — so region, account and the config table come from the CLI context. Everything
 * else comes from the DEPLOYED DISPATCHER'S TASK DEFINITION, applied by the caller before this runs
 * (`lib/dispatcher-env.js`).
 *
 * That is not a nicety. It used to "fall back to the dispatcher's own defaults", which was described
 * as honest and was not: on a laptop none of those variables are set, so the fallbacks fired and the
 * PRE-ARCHIE stack was recorded — sg-REDACTED, the OpenClaw dispatcher URL, and
 * `agent-4ggvzl-*` for every secret. Caught by the first sandbox rehearsal, and it failed
 * silently: the command reported success.
 *
 * It matters MORE now than it did under generations. The name is derived on both sides rather than
 * stored on one, so a wrong environment here does not produce a wrong record — it produces a
 * DIFFERENT NAME from the one the dispatcher will derive, and the two halves stop meeting.
 */
function dispatcherClientFor(ctx, account, deps = {}) {
  const overrides = { region: ctx.region, account, agentConfigTable: ctx.resources.configTable };
  if (deps.agentcore) return deps.agentcore(overrides);
  let mod;
  try {
    mod = require('../../slack-dispatcher/agentcore-client');
  } catch (e) {
    throw preflight('cannot load the dispatcher\'s spec computation (slack-dispatcher/agentcore-client)',
      { cause: e, detail: 'run `npm ci` in docker/slack-dispatcher — the CLI reuses it rather than reimplementing it' });
  }
  return mod.createAgentCoreClient(overrides);
}

/** The account the caller is actually in, refusing when `--account` disagrees. */
async function resolveAccount(ctx, aws) {
  const { GetCallerIdentityCommand } = require('@aws-sdk/client-sts');
  const id = await aws.sts().send(new GetCallerIdentityCommand({}));
  const actual = id && id.Account;
  if (ctx.account && actual && ctx.account !== actual) {
    throw preflight(`--account ${ctx.account} but the caller is in ${actual}`,
      { detail: 'wrong profile, or the right profile against the wrong deployment' });
  }
  if (!actual) throw preflight('GetCallerIdentity returned no account');
  return actual;
}

const registryHostFor = (account, region) => `${account}.dkr.ecr.${region}.amazonaws.com`;
const imageUriFor = (ctx, account, tag) => `${registryHostFor(account, ctx.region)}/${ctx.resources.agentRepo}:${tag}`;

/**
 * The spec this agent runs on this image — the dispatcher's own computation, unmodified.
 *
 * Deliberately a one-line pass-through rather than an abstraction over it. Every field
 * `runtimeSpecFor` returns is carried, including fields added after this was written, because
 * nothing here enumerates them. That property is the whole contract.
 */
function derivedSpecFor(client, agent, imageUri) {
  const spec = client.runtimeSpecFor(agent, imageUri);
  if (!spec || !spec.image) throw new CliError('runtimeSpecFor returned no image', { code: EXIT.FAILED });
  return spec;
}

/**
 * The runtime name for this agent on this image. THE shared identity.
 *
 * Every caller that needs to talk about "the runtime for agent A on tag T" — staging, verify, the
 * reap rails, status coverage — goes through here, so there is exactly one expression of it in the
 * CLI and it is the dispatcher's.
 */
function runtimeNameFor(client, agent, imageUri) {
  const { generationRuntimeName } = require('../../slack-dispatcher/agentcore-client');
  return generationRuntimeName(agent, derivedSpecFor(client, agent, imageUri));
}

/**
 * A stable digest of a per-agent spec, recorded on the binding as `agentSpecDigest`.
 *
 * Wider than the 8-hex runtime fingerprint on purpose: that one only has to distinguish the handful
 * of specs ONE agent runs, this one is written down and compared across a fleet. Same canonical JSON
 * on both sides, so the digest can be recomputed from a spec rather than trusted.
 */
function specDigestFor(spec, deps = {}) {
  const { createHash } = require('node:crypto');
  const canonicalize = deps.canonicalize || require('../../slack-dispatcher/agentcore-client').canonicalize;
  const json = JSON.stringify(canonicalize(spec));
  return { json, specDigest: createHash('sha1').update(json).digest('hex').slice(0, 16) };
}

module.exports = {
  clientsFor, dispatcherClientFor, resolveAccount,
  registryHostFor, imageUriFor,
  derivedSpecFor, runtimeNameFor, specDigestFor,
};

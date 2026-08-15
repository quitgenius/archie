'use strict';

// `archie deploy` — the whole thing. RUNTIME-CLI-REFERENCE.md §2.27; the flows are §3.1 and §3.4.
//
//   preflight  →  fleet deploy (the agent half)  →  gateway deploy (the ECS half)
//
// THE ORDER IS A CONSTRAINT, NOT A PREFERENCE. Agents first, then the gateway: a new gateway may
// reference a generation that must already be stageable, whereas agents never depend on a new
// gateway (plan §5, §2.27 "Refuses to: reorder the halves"). Reversing it would put a dispatcher in
// front of a fleet that cannot serve what it asks for, during the one window where nothing can reach
// Slack anyway.
//
// THIS COMMAND ENDS WITH ~94 SECONDS OF TOTAL OUTAGE IF THE GATEWAY CHANGED. Not degraded service —
// total: the dispatcher is the sole path from Slack to every agent, it runs at `desired_count = 1`
// with `deployment_minimum_healthy_percent = 0` because two tasks would open two Socket Mode
// connections and Slack would load-balance events across them (dispatcher.tf:216-233), so a roll is
// stop-then-start with a measured 94s gap (§6.1). Nothing here hides that, and the agent half's
// "zero downtime" is never claimed for the composed command.
//
// AND THAT IS WHY THE GATEWAY HALF IS SKIPPED WHEN ITS CONTENT DIGEST IS UNCHANGED. The two images'
// declared input sets DIFFER, so their derived tags move independently (lib/digest.js): a dispatcher
// change does not roll every agent in the fleet, an agent-only change does not cost the outage, and running this
// twice with no edits does nothing at all — no build, no push, no rollout, no gap. That property is
// the entire reason the tags are derived from content rather than typed, and it is asserted in the
// tests rather than left to the sub-command to notice.

const { EXIT } = require('../lib/exit');
const { digestFor, assertPure } = require('../lib/digest');
const fleetCmd = require('./fleet');
const gatewayCmd = require('./gateway');
const preflightCmd = require('./preflight');

const { runStep } = fleetCmd;

/** Every composed step, replaceable for the tests. The sub-commands' own rails are not. */
function stepsFor(deps = {}) {
  const s = deps.steps || {};
  return {
    assertBaseline: s.assertBaseline || preflightCmd.assertBaseline,
    fleetDeploy: s.fleetDeploy || fleetCmd['fleet deploy'],
    gatewayBuild: s.gatewayBuild || gatewayCmd.build,
    gatewayDeploy: s.gatewayDeploy || gatewayCmd.deploy,
    gatewayStatus: s.gatewayStatus || gatewayCmd.status,
  };
}

function publish(ctx, out, result, render) {
  out.answer(ctx.json ? result : render(result));
}

/**
 * `archie deploy [--hotfix] [--keep n] [--skip-preflight] [--pure] [--agent-tag t] [--gateway-tag t]`
 *
 * EXIT: the failing sub-step's code, unchanged (§2.27). A `4` from the agent half means the
 * generation is tainted, the pointer never moved AND THE GATEWAY WAS NEVER TOUCHED — no rollout, no
 * outage, nothing to undo.
 */
async function deploy(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const steps = stepsFor(deps);
  const digest = deps.digestFor || digestFor;

  const result = {
    preflight: null,
    fleet: null,
    gatewayBuild: null,
    gateway: null,
    gatewayTag: null,
    gatewayRolled: false,
    gatewaySkipped: false,
    outageSeconds: null,
    dryRun: Boolean(ctx.dryRun),
  };

  // ── --pure, for BOTH images, before anything is built ──────────────────────────────────────────
  //
  // §2.27 states `--pure` as "a refusal, exit 5, BEFORE anything is built, listing the modified
  // files". Each half honours it on its own (cmd/generation.js:679-684, cmd/gateway.js:252-256), but
  // composed that is not good enough: the gateway's check would run AFTER every agent in the fleet had already
  // rolled, and a release that refuses halfway is not the reproducible release `--pure` promises.
  // Both are asserted here, up front, even for a half that may later be skipped — the skip DECISION
  // is itself derived from the working tree, so a dirty tree makes it unreproducible too.
  if (values.pure) {
    const pure = deps.assertPure || assertPure;
    pure('agent');
    pure('gateway');
    out.verbose('pure        both images\' declared inputs match HEAD');
  }

  // ── 1. preflight (checks 1-3) ──────────────────────────────────────────────────────────────────
  //
  // Called as a LIBRARY, not by shelling out to our own CLI — a `deploy` that spawned `archie
  // preflight` could pass it a flag that skipped the checks (`cmd/preflight.js:1179-1191`). Checks
  // 1-3 are the account identity, the config table + routing GSI, and `CONFIG#base / BASE`, whose
  // absence makes every runtime exit 1 at boot (§3.4 step 4).
  if (values['skip-preflight']) {
    out.warn('--skip-preflight: the account identity, the config table and CONFIG#base/BASE are NOT '
      + 'verified. Each absence otherwise surfaces downstream as an error that does not name itself (§4).');
  } else {
    const baseline = await steps.assertBaseline(ctx, { ...deps, out });
    result.preflight = { account: baseline.account, checks: (baseline.results || []).map((r) => ({ n: r.n, status: r.status })) };
    out.progress(`preflight   checks 1-3 pass (account ${baseline.account})`);
  }

  // ── 2. the agent half ──────────────────────────────────────────────────────────────────────────
  out.progress('agents      starting the agent half — build, generation, stage, healthcheck gate, release, gc');
  try {
    const fleet = await runStep(steps.fleetDeploy, ctx, {
      positionals: [],
      values: {
        tag: values['agent-tag'],
        hotfix: values.hotfix,
        keep: values.keep,
        pure: values.pure,
      },
    }, out, deps);
    result.fleet = fleet.result || null;
  } catch (e) {
    // THE ONE THING WORTH SAYING ON THE WAY OUT. Exit 4 is the loudest failure this CLI has, and an
    // operator reading it needs to know the blast radius is zero on the gateway side: no task
    // definition was registered, no service was updated, no 94-second gap was spent. The code is
    // RETHROWN UNCHANGED (§2.27: "the failing sub-step's code, unchanged").
    out.progress(`gateway     NOT TOUCHED — the agent half exited ${(e && e.exitCode) || EXIT.FAILED}. No task `
      + 'definition was registered, no rollout started, and no downtime was spent.');
    publish(ctx, out, result, render);
    throw e;
  }
  out.progress('agents      released — zero downtime so far; the new runtimes were built alongside the live ones');

  // ── 3. the gateway half, and the skip that makes a repeat deploy free ──────────────────────────
  // `digestFor` already carries the tag its digest names (lib/digest.js:398-427); re-deriving it here
  // would be a second place for the `content-` naming rule to live.
  const targetTag = values['gateway-tag'] || digest('gateway').tag;
  result.gatewayTag = targetTag;

  const running = await runningGatewayTag(steps, ctx, args, out, deps);
  if (running.tag && running.tag === targetTag) {
    // Skipped ENTIRELY: no docker build, no ECR call, no RegisterTaskDefinition, no gap. This is the
    // property the derived-tag design exists for (§2.27: "running it twice with no edits does nothing
    // at all, including no gateway outage").
    result.gatewaySkipped = true;
    out.progress(`gateway     unchanged   ${running.image || targetTag} is already running — no build, no `
      + 'rollout, NO OUTAGE');
    return emit(ctx, out, result, render);
  }

  if (running.unknown) {
    // Never skip on ignorance. If the service could not be read, the gateway half runs and its own
    // commands produce the authoritative error — a build that is already in ECR costs nothing, and
    // silently declaring "unchanged" here would leave a stale dispatcher in front of a new fleet.
    out.warn(`could not read the running dispatcher image (${running.error}) — deploying the gateway `
      + 'rather than assuming it is unchanged. On a bootstrap this is expected until Terraform has '
      + 'created the cluster and service (§3.4 step 1).');
  }

  out.progress(`gateway     ${running.tag ? `${running.tag} -> ${targetTag}` : targetTag}`);
  const built = await runStep(steps.gatewayBuild, ctx, {
    positionals: [],
    values: { tag: values['gateway-tag'], push: true, pure: values.pure },
  }, out, deps);
  result.gatewayBuild = built.result || null;

  // SAID BEFORE IT HAPPENS, not after. §2.27: "Refuses to hide the gap."
  out.warn('the dispatcher is about to roll: ~94 SECONDS OF TOTAL OUTAGE, however healthy the fleet '
    + 'is, because the gateway is the sole path from Slack to every agent (§6.1). Slack messages sent '
    + 'during the gap are not queued by this system.');

  const rolled = await runStep(steps.gatewayDeploy, ctx, {
    positionals: [],
    values: { tag: values['gateway-tag'] || targetTag },
  }, out, deps);
  result.gateway = rolled.result || null;
  result.gatewayRolled = Boolean(result.gateway && result.gateway.rolled);
  // The MEASURED gap, from `gateway deploy`'s own observations (cmd/gateway.js:770-783) — never the
  // 94 from the document. `--no-wait` leaves it null, and a null here means "nothing observed the
  // gap", not "there was none".
  const timeline = result.gateway && result.gateway.timeline;
  result.outageSeconds = timeline ? timeline.gapSeconds : null;

  return emit(ctx, out, result, render);
}

/**
 * Which image tag the dispatcher is ACTUALLY running.
 *
 * From the deployed task definition, never from the local shell or from tfvars (§2.5,
 * spec-baseline.mjs:16-17,32-44) — what a terminal exports is irrelevant to what is serving, and the
 * skip decision is only safe if it is made against reality. An unreadable service is reported as
 * UNKNOWN rather than as "not this tag": the difference decides whether the gateway half runs.
 */
async function runningGatewayTag(steps, ctx, args, out, deps) {
  try {
    const status = await runStep(steps.gatewayStatus, ctx, { positionals: [], values: {} }, out, deps);
    const r = status.result || {};
    return { tag: r.tag || null, image: r.image || null, unknown: false, error: null };
  } catch (e) {
    return { tag: null, image: null, unknown: true, error: String((e && e.message) || e) };
  }
}

function emit(ctx, out, result, renderer) {
  if (ctx.json) return result;
  out.answer(renderer(result));
  return undefined;
}

function render(r) {
  const lines = [];
  if (r.preflight) lines.push(`preflight   checks 1-3 pass (account ${r.preflight.account})`);
  else lines.push('preflight   SKIPPED');
  if (r.fleet) {
    lines.push(`agents      ${r.fleet.generationId || '—'} (${r.fleet.mode})`
      + `${r.fleet.stage && r.fleet.stage.coverage !== undefined ? `  staged ${r.fleet.stage.coverage}/${r.fleet.stage.agents}` : ''}`);
  }
  if (r.gatewaySkipped) {
    lines.push(`gateway     unchanged (${r.gatewayTag}) — skipped entirely, NO OUTAGE`);
  } else if (r.gatewayRolled) {
    lines.push(`gateway     rolled to ${r.gatewayTag}${r.outageSeconds ? ` — ${r.outageSeconds}s of dispatcher downtime` : ''}`);
  } else {
    lines.push(`gateway     ${r.dryRun ? 'not rolled (dry run)' : 'not rolled'} — target ${r.gatewayTag}`);
  }
  return lines.join('\n');
}

module.exports = {
  // `deploy` IS the full command key — it is top-level, so key and verb are the same string and
  // `registry.load()`'s `mod[key] || mod[verb]` resolves either way (`lib/registry.js:156-166`).
  deploy,
  stepsFor,
  runningGatewayTag,
  render,
};

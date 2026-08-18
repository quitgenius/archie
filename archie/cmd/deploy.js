'use strict';

// `archie deploy` — the whole thing. RUNTIME-CLI-REFERENCE.md §2.27; the flows are §3.1 and §3.4.
//
//   preflight  →  fleet deploy (the agent half)  →  gateway deploy (the ECS half)
//
// THE ORDER IS A CONSTRAINT, NOT A PREFERENCE. Agents first, then the gateway: a new gateway may
// reference a tag that must already be stageable, whereas agents never depend on a new
// gateway (plan §5, §2.27 "Refuses to: reorder the halves"). Reversing it would put a dispatcher in
// front of a fleet that cannot serve what it asks for, during the one window where nothing can reach
// Slack anyway.
//
// WHAT THIS COMMAND COSTS WHEN THE GATEWAY CHANGED depends on the rollout shape configured in
// `SERVICE.deploymentConfiguration` (lib/task-definition.js), and it is one or the other — never
// neither. The dispatcher is the sole path from Slack to every agent at `desiredCount = 1`, so:
//
//   rolling (current, preprod)  no outage, but an OVERLAP: two tasks, two Socket Mode connections,
//                               events load-balanced across them, two writers on the cron store.
//   stop-then-start (prod)      ~94 SECONDS OF TOTAL OUTAGE — not degraded service, total. Events in
//                               the gap are dropped, not queued (§6.1).
//
// Nothing here hides either one, and the agent half's "zero downtime" is never claimed for the
// composed command.
//
// AND THAT IS WHY THE GATEWAY HALF IS SKIPPED WHEN ITS CONTENT DIGEST IS UNCHANGED. The two images'
// declared input sets DIFFER, so their derived tags move independently (lib/digest.js): a dispatcher
// change does not roll every agent in the fleet, an agent-only change does not cost the outage, and running this
// twice with no edits does nothing at all — no build, no push, no rollout, no gap. That property is
// the entire reason the tags are derived from content rather than typed, and it is asserted in the
// tests rather than left to the sub-command to notice.

const { EXIT } = require('../lib/exit');
const { digestFor, assertPure } = require('../lib/digest');
const { ROLLING } = require('../lib/task-definition');
const fleetCmd = require('./fleet');
const gatewayCmd = require('./gateway');
const preflightCmd = require('./preflight');
const policyCmd = require('./policy');

const { runStep } = fleetCmd;

/** Every composed step, replaceable for the tests. The sub-commands' own rails are not. */
function stepsFor(deps = {}) {
  const s = deps.steps || {};
  return {
    assertBaseline: s.assertBaseline || preflightCmd.assertBaseline,
    policyPublish: s.policyPublish || policyCmd['policy publish'],
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
 * tag is tainted, the pointer never moved AND THE GATEWAY WAS NEVER TOUCHED — no rollout, no
 * outage, nothing to undo.
 */
async function deploy(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const steps = stepsFor(deps);
  const digest = deps.digestFor || digestFor;

  // THE GENERATED BASELINE, BEFORE ANYTHING READS A DIGEST. baseline.generated.mjs is gitignored, so a
  // fresh clone does not have it — and the GATEWAY declares it as an explicit file input, so digestFor()
  // fails with `declared input missing` rather than anything that names the real problem. That happens in
  // the --pure gate and the gateway skip decision, both of which run before the build hook that would
  // otherwise generate it. Idempotent, so this costs nothing on a warm tree.
  require('../lib/policy-codegen').ensure();

  const result = {
    preflight: null,
    // The policy step's outcome. NOT just for --json: a release summary that omits policy cannot answer
    // "what did this deploy change about what agents may do", which is the one question the layer exists
    // to make answerable. `null` = not run; see render().
    policy: null,
    fleet: null,
    gatewayBuild: null,
    gateway: null,
    gatewayTag: null,
    gatewayRolled: false,
    gatewaySkipped: false,
    outageSeconds: null,
    overlapSeconds: null,
    dryRun: Boolean(ctx.dryRun),
  };

  // ── --pure, for BOTH images, before anything is built ──────────────────────────────────────────
  //
  // §2.27 states `--pure` as "a refusal, exit 5, BEFORE anything is built, listing the modified
  // files". Each half honours it on its own (cmd/tag.js:679-684, cmd/gateway.js:252-256), but
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
  // 1-2 are the account identity and the config table + routing GSI. (Check 3 was `CONFIG#base /
  // BASE present`; the fleet base config is now a constant, so there is no item to verify.)
  if (values['skip-preflight']) {
    out.warn('--skip-preflight: the account identity and the config table are NOT verified. Each '
      + 'absence otherwise surfaces downstream as an error that does not name itself (§4).');
  } else {
    const baseline = await steps.assertBaseline(ctx, { ...deps, out });
    result.preflight = { account: baseline.account, checks: (baseline.results || []).map((r) => ({ n: r.n, status: r.status })) };
    out.progress(`preflight   checks 1-2 pass (account ${baseline.account})`);
  }

  // ── 1.5 policy (plan §3, "step 0.5") ───────────────────────────────────────────────────────────
  //
  // BEFORE THE AGENT HALF, because the compiled verdict rows are PROVISION INPUTS: staging an agent onto a
  // tag and then changing what it may do is two releases pretending to be one, and the window between them
  // is a runtime serving turns under the old policy.
  //
  // Costs nothing when policy is unchanged — `policy publish` returns without writing when the stored rows
  // already match the sources' digest, so this adds one GetItem per scope to a release that does not touch
  // policy.
  //
  // Also called as a LIBRARY rather than by shelling out, for the same reason as preflight above: a deploy
  // that spawned `archie policy publish` could pass it a flag that skipped the checks.
  if (values['skip-policy']) {
    out.warn('--skip-policy: the Cedar sources are NOT compiled, checked or published. Agents will be '
      + 'staged against whatever verdict rows are already stored, which may predate this release.');
    result.policy = { skipped: 'flag' };
  } else {
    try {
      const policy = await runStep(steps.policyPublish, ctx, {
        positionals: [],
        // Threaded through: a release that CHANGES a decision must be declared, exactly as a standalone
        // publish must. Silently accepting on a deploy would make `archie deploy` the way to bypass check 7.
        values: { 'accept-policy-change': values['accept-policy-change'] },
      }, out, deps);
      result.policy = policy.result || null;
    } catch (e) {
      // NO POLICY FOR THIS ACCOUNT IS NOT A FAILURE. A fresh sandbox has no pins.<env>.json declaring it,
      // and the layer is additive — no artifact means every scope keeps pre-policy behaviour. Blocking a
      // deploy on it would make policy a prerequisite for standing up an environment. Anything else
      // (failed checks, an undeclared decision change) is rethrown and stops the release.
      if (e && e.exitCode === EXIT.REFUSED && /no policy pins declare account/.test(e.message || '')) {
        out.warn(`policy      skipped — ${e.message}. No verdict rows are managed in this account.`);
        result.policy = { skipped: 'no-pins', account: (e.message.match(/account (\d+)/) || [])[1] || null };
      } else {
        out.progress('agents      NOT TOUCHED — the policy step refused. Nothing was built, staged or rolled.');
        publish(ctx, out, result, render);
        throw e;
      }
    }
  }

  // ── 2. the agent half ──────────────────────────────────────────────────────────────────────────
  out.progress('agents      starting the agent half — build, stage, healthcheck gate, publish, gc');
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

  // SAID BEFORE IT HAPPENS, not after. §2.27: "Refuses to hide the gap." The rolling case gets the same
  // treatment for the same reason — the cost changed shape, it did not disappear, and the shape is what
  // decides whether an operator should be watching the workspace for duplicates or for silence.
  out.warn(ROLLING
    ? 'the dispatcher is about to roll: NO OUTAGE, but for the length of the overlap TWO tasks hold a '
      + 'Socket Mode connection and Slack load-balances events across them — an event in that window may '
      + 'be handled twice or by the outgoing task, and the cron store has two writers (§6.1).'
    : 'the dispatcher is about to roll: ~94 SECONDS OF TOTAL OUTAGE, however healthy the fleet '
      + 'is, because the gateway is the sole path from Slack to every agent (§6.1). Slack messages sent '
      + 'during the gap are not queued by this system.');

  const rolled = await runStep(steps.gatewayDeploy, ctx, {
    positionals: [],
    values: { tag: values['gateway-tag'] || targetTag },
  }, out, deps);
  result.gateway = rolled.result || null;
  result.gatewayRolled = Boolean(result.gateway && result.gateway.rolled);
  // The MEASURED numbers, from `gateway deploy`'s own observations — never the 94 from the document.
  // `--no-wait` leaves both null, and a null here means "nothing observed this", not "there was none".
  // Under a rolling deploy `outageSeconds` is a truthful 0 and `overlapSeconds` carries the cost.
  const timeline = result.gateway && result.gateway.timeline;
  result.outageSeconds = timeline ? timeline.gapSeconds : null;
  result.overlapSeconds = timeline ? (timeline.overlapSeconds ?? null) : null;

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

/**
 * The policy line of a release summary.
 *
 * WHY IT IS ITS OWN FUNCTION AND WHY EVERY STATE IS NAMED. A release report that omits policy cannot answer
 * "did this deploy change what agents may do", which is the single question the layer exists to make
 * answerable — and the states are NOT interchangeable. "unchanged" means the fleet is at the sources'
 * digest; "SKIPPED" means nobody checked and the rows may predate this release. Collapsing them into a
 * blank line, or into one word, loses exactly the distinction an operator needs after the fact.
 */
function renderPolicy(p) {
  if (!p) return 'policy      not run';
  if (p.skipped === 'flag') return 'policy      SKIPPED (--skip-policy) — verdict rows may predate this release';
  if (p.skipped === 'no-pins') {
    return `policy      none for this account${p.account ? ` (${p.account})` : ''} — no verdict rows are managed here`;
  }
  const digest = p.digest || (p.artifact && p.artifact.policyDigest) || '—';
  const changed = Array.isArray(p.changes) ? p.changes.length : 0;
  if (p.unchanged) return `policy      unchanged (${digest})`;
  return `policy      ${digest}  ${p.rows || 0} row(s)`
    + (changed ? `  ${changed} decision(s) CHANGED` : '  no decisions changed');
}

function render(r) {
  const lines = [];
  if (r.preflight) lines.push(`preflight   checks 1-3 pass (account ${r.preflight.account})`);
  else lines.push('preflight   SKIPPED');
  lines.push(renderPolicy(r.policy));
  if (r.fleet) {
    lines.push(`agents      ${r.fleet.imageTag || '—'} (${r.fleet.mode})`
      + `${r.fleet.stage && r.fleet.stage.coverage !== undefined ? `  staged ${r.fleet.stage.coverage}/${r.fleet.stage.agents}` : ''}`);
  }
  if (r.gatewaySkipped) {
    lines.push(`gateway     unchanged (${r.gatewayTag}) — skipped entirely, NO OUTAGE`);
  } else if (r.gatewayRolled) {
    const cost = r.outageSeconds ? ` — ${r.outageSeconds}s of dispatcher downtime`
      : (r.overlapSeconds !== null ? ` — no downtime, ${r.overlapSeconds}s of two Socket Mode connections` : '');
    lines.push(`gateway     rolled to ${r.gatewayTag}${cost}`);
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

'use strict';

// `archie policy publish | show` — compile the Cedar sources and put the result where the fleet reads it
// (archie-policy-implementation-plan.md §2, §3).
//
// TWO WRITES, and both matter:
//   CONFIG#policy / FLEET      the pin MEMBERSHIPS + the source digest. This is what lets the dispatcher
//                              answer for a scope MINTED at turn time, which no deploy can enumerate.
//   AGENT#<scope> / POLICY     the compiled verdict row, for every scope we CAN enumerate, written
//                              eagerly so a staged agent is correct before its first turn.
//
// The dispatcher is the second writer and the backstop: ensurePolicyRow re-derives any scope whose row
// is missing or whose digest has moved (agentcore-client.js). So this command being incomplete is
// self-healing, while this command being WRONG is not — hence the refusals below.

const os = require('node:os');

const { CliError, EXIT, usage, refused, preflight } = require('../lib/exit');
const { clientsFor, resolveAccount } = require('../lib/spec');
const { loadPolicySources, availableEnvs } = require('../lib/policy-sources');
const { plan } = require('../lib/policy-publish');
const { runSourceChecks, capabilityUniverse, diffDecisions, checkSkillHolders } = require('../lib/policy-checks');
const codegen = require('../lib/policy-codegen');
const seed = require('../lib/policy-seed');
const { scanBindings } = require('../lib/bindings');
const { listAgents } = require('../lib/agents');

const POLICY_PK = 'CONFIG#policy';
const FLEET_SK = 'FLEET';

const answer = (out, ctx, obj, text) => out.answer(ctx.json ? obj : text);
const nowIso = (deps) => new Date(deps.now ? deps.now() : Date.now()).toISOString();
const whoami = (deps) => deps.whoami || process.env.USER || os.userInfo?.().username || 'unknown';

/**
 * Pick the pins file for THIS account — never from a flag, and this is a deliberate safety property.
 *
 * The realistic catastrophic mistake here is publishing one environment's pins into another: it silently
 * revokes every capability the target's real scopes hold, because their ids are simply not in the wrong
 * file's groups. That already happened once in the sources themselves — pins.prod.json carried two
 * SANDBOX scope ids until 2026-08-18, which no scope-id SHAPE check could catch.
 *
 * So the account is the selector. Each pins file declares the account it is for, we resolve the caller's
 * account from STS, and exactly one must match. An `--env` flag would make the dangerous case typeable.
 */
function sourcesForAccount(account, deps = {}) {
  const dir = deps.policyDir;
  const envs = availableEnvs(dir);
  const loaded = envs.map((env) => {
    try { return loadPolicySources({ env, ...(dir ? { dir } : {}) }); } catch (e) {
      throw new CliError(`policy sources for env '${env}' are unreadable: ${e.message}`, { code: EXIT.FAILED });
    }
  });
  const matches = loaded.filter((s) => String(s.pins.account) === String(account));
  if (matches.length === 1) return matches[0];
  if (!matches.length) {
    throw refused(`no policy pins declare account ${account}`, {
      detail: `found ${envs.length} pins file(s) for account(s) ${[...new Set(loaded.map((s) => s.pins.account))].join(', ')}. `
        + 'Add a pins.<env>.json whose "account" is this one rather than publishing another environment\'s pins here.',
    });
  }
  throw refused(`${matches.length} pins files declare account ${account} (${matches.map((s) => s.env).join(', ')})`, {
    detail: 'the account selects the pins file, so it must be unambiguous — give the environments distinct accounts.',
  });
}

/**
 * Every agent, plus any orphaned runtime bindings.
 *
 * `agents` is `AGENT#` partition keys — the complete list, see lib/agents.js. This used to be the
 * routing GSI merged with the `RUNTIME#` partitions, on the reasoning that "neither is a superset:
 * routing held 2 and runtimes held 4". That was evidence BOTH were wrong, not that both were needed:
 * the GSI cannot see a minted agent at all, and `RUNTIME#` is image-binding state that says nothing
 * about which agents exist. `AGENT#` answers it outright and the merge is gone.
 *
 * `orphans` is kept as a DIAGNOSTIC, not as part of the roster: a `RUNTIME#` partition with no `AGENT#`
 * sibling is residue (a torn-down agent, an interrupted provision), and it should be visible rather
 * than averaged into a count. It is expected to be empty.
 */
async function enumerateScopes(aws, ctx) {
  const [rows, bindings] = await Promise.all([
    listAgents(aws.doc(), ctx.resources.configTable),
    scanBindings(aws, ctx),
  ]);
  const agents = [...new Set(rows.map((r) => r.agent).filter(Boolean))].sort();
  const served = [...new Set(bindings.map((b) => b.agent).filter(Boolean))].sort();
  const orphans = served.filter((s) => !agents.includes(s));
  return { routing: agents, minted: orphans, all: agents };
}

/**
 * The verdict rows currently stored, keyed by scope. A scope with no row maps to null — which
 * diffDecisions reads as "pre-policy behaviour", so the first publish correctly reports every pinned
 * decision as a change rather than as nothing.
 */
async function readLiveRows(aws, ctx, scopes) {
  const schema = await import(`file://${require.resolve('../../archie-runner/config-resolver/schema.mjs')}`);
  const doc = aws.doc();
  const { GetCommand } = aws.docCmds;
  const out = {};
  // Serial GetItems rather than BatchGet: the scope count is in the low hundreds, this is off the turn
  // path, and BatchGet's partial-response handling is a source of silently-missing keys — which here
  // would read as "no row" and manufacture a spurious change.
  for (const scope of scopes) {
    const r = await doc.send(new GetCommand({ TableName: ctx.resources.configTable, Key: schema.agentPolicyKey(scope) }));
    out[scope] = r?.Item?.data ? JSON.parse(r.Item.data) : null;
  }
  return out;
}

/**
 * Live holders of PINNED skills, keyed by skill, scope-keyed on the values.
 *
 * Reads `AGENT#<scope>/MARKETPLACE` items — the same items the runtime reads — so this compares the policy
 * against what the fleet ACTUALLY has rather than against items/, which is an extract of sandra and can
 * describe a different fleet entirely (measured: items/marketplace held 153 production agents while
 * items/routing held 3 sandbox ones).
 *
 * Both install shapes are handled for the same reason skill-pins.pinnedHoldings does: sandra nests an object
 * per skill, our items key by id, and a reader that handled one would silently report no holders.
 */
async function liveSkillHolders(aws, ctx, governed) {
  const schema = await import(`file://${require.resolve('../../archie-runner/config-resolver/schema.mjs')}`);
  const doc = aws.doc();
  const { ScanCommand } = aws.docCmds;
  const governedSet = new Set(governed);
  const holders = {};
  let key;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await doc.send(new ScanCommand({
      TableName: ctx.resources.configTable,
      FilterExpression: 'sk = :sk',
      ExpressionAttributeValues: { ':sk': 'MARKETPLACE' },
      ExclusiveStartKey: key,
    }));
    for (const item of r.Items || []) {
      const scope = String(item.pk || '').replace(/^AGENT#/, '');
      let installs = {};
      try { installs = (JSON.parse(item.data || '{}') || {}).installs || {}; } catch { continue; }
      const ids = Array.isArray(installs) ? installs : Object.keys(installs);
      for (const id of ids) if (governedSet.has(id)) (holders[id] = holders[id] || []).push(scope);
    }
    key = r.LastEvaluatedKey;
  } while (key);
  return holders;
}

async function publish(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);
  const table = ctx.resources.configTable;
  const account = await resolveAccount(ctx, aws);
  const sources = deps.sources || sourcesForAccount(account, deps);

  const { routing, minted, all } = await enumerateScopes(aws, ctx);
  if (!all.length) {
    throw preflight(`no scopes found in ${table}`, {
      detail: 'no AGENT# items — either --name points at the wrong deployment or the config has never '
        + 'been hydrated (`archie config hydrate`).',
    });
  }

  // CHECKS 1–4 on the sources, before anything is computed or written. Every one of these guards a
  // SILENT failure — Cedar fails closed, so a typo here is a policy that quietly denies rather than one
  // that errors. Check 4 validates group members against `all`, which is what catches an id from another
  // environment (the pins.prod.json failure): shape alone passes those.
  const caps = await capabilityUniverse(sources);
  const findings = runSourceChecks(sources, { caps, knownScopes: all });
  for (const f of findings) out.progress(`check ${f.check}  ${f.fatal ? 'FAIL' : 'warn'}  ${f.message}${f.detail ? `\n            ${f.detail}` : ''}`);
  const fatal = findings.filter((f) => f.fatal);
  if (fatal.length) {
    throw refused(`${fatal.length} policy check(s) failed`, {
      detail: 'nothing was written. Fix the sources — these are the checks that turn a silently-denying '
        + 'policy into a stopped deploy.',
    });
  }

  // CHECK 9 — the policy against the LIVE fleet, not against the sources. `pins.<env>.json` is
  // hand-authored and nothing refreshes it, so a skill installed in sandra since it was written reaches the
  // fleet through hydration and the policy never learns about it. Once the filter is live that holder loses
  // the skill on its next turn, silently. This is the only check that can see that, because it is the only
  // one that reads what the fleet actually has.
  const governedSkills = Object.keys(sources.pins.groups || {})
    .filter((g) => g.startsWith('skill.')).map((g) => g.slice('skill.'.length));
  let skillFindings = [];
  if (governedSkills.length) {
    const holders = deps.skillHolders || await liveSkillHolders(aws, ctx, governedSkills);
    skillFindings = checkSkillHolders(sources, holders, governedSkills);
    for (const f of skillFindings) out.progress(`check ${f.check}  ${f.fatal ? 'STRIP' : 'warn'}  ${f.message}${f.detail ? `\n            ${f.detail}` : ''}`);
  }

  // THE GATE (check 6). plan() runs assertDerivationMatchesCedar over every scope, so a policy the
  // dispatcher cannot derive by membership alone fails HERE rather than shipping and being silently
  // mis-derived for every minted scope. Do not catch this to make a deploy pass — see policy-publish.js.
  const { artifact, rows, checked } = plan(all, sources);

  // CHECK 7 — does this change any DECISION? A policy diff is not a text diff: reordering statements or
  // renaming a group can be a large textual change with zero decision changes, while a one-character edit
  // to a group id can revoke a capability from every holder. Only a materialised comparison tells them
  // apart, and it is the actual reason to want an engine here.
  const live = await readLiveRows(aws, ctx, all);
  const { changes } = diffDecisions(rows, live);
  const decisionLines = changes.length
    ? [`decisions changed: ${new Set(changes.map((c) => c.scope)).size} scope(s), ${changes.length} (scope, capability) pair(s)`,
      ...changes.slice(0, 12).map((c) => `            ${c.scope}  ${c.capability}  ${c.from ?? '(no row)'} → ${c.to}`),
      ...(changes.length > 12 ? [`            … ${changes.length - 12} more`] : [])]
    : ['decisions changed: none — this publish is a no-op for every scope'];

  const allowsFor = (row) => Object.entries(row.verdicts).filter(([, v]) => v === 'allow').map(([c]) => c);
  const withPins = rows.filter((r) => allowsFor(r).length);

  const head = [
    `env       ${sources.env}  account ${account}  digest ${artifact.policyDigest}`,
    `scopes    ${all.length} agent(s)`
    + (minted.length ? `  · WARNING ${minted.length} orphaned runtime binding(s) with no AGENT# row: ${minted.join(', ')}` : ''),
    `verified  ${checked} scope(s) — membership derivation matches Cedar`,
    `pinned    ${withPins.length} scope(s) hold at least one pinned capability:`,
    ...withPins.map((r) => `            ${r.scope}  ${allowsFor(r).join(', ')}`),
    ...decisionLines,
  ];

  // NOTHING TO DO. The plan requires this step to cost nothing when policy is unchanged, because it runs on
  // EVERY `archie deploy` — at prod scale "write every row anyway" is ~220 PutItems per release to store
  // bytes that already match. Both conditions are needed: the digest proves the sources have not moved, and
  // zero changes proves no scope's decisions differ from what is stored. Digest alone would skip a deploy
  // that must repair a row somebody edited by hand.
  //
  // COMPUTED BEFORE THE DRY-RUN BRANCH so `--dry-run` can say it truthfully. Reporting "would write 3 rows"
  // when a real run writes nothing is exactly the kind of overstatement that makes people stop reading dry
  // runs.
  const liveDigest = Object.values(live).find(Boolean)?.policyDigest ?? null;
  const unchanged = !changes.length && liveDigest === artifact.policyDigest && rows.every((r) => live[r.scope]);

  if (ctx.dryRun) {
    out.progress(unchanged
      ? `nothing to write — every row already matches ${artifact.policyDigest}`
      : `would write ${POLICY_PK} / ${FLEET_SK} + ${rows.length} AGENT#<scope>/POLICY row(s)`);
    answer(out, ctx, { env: sources.env, account, artifact, rows, changes, written: false, unchanged, dryRun: true },
      [...head, unchanged
        ? `written   nothing (dry run) — and nothing WOULD be written; already at ${artifact.policyDigest}`
        : `written   nothing (dry run) — ${rows.length} row(s) + the fleet artifact would be written`].join('\n'));
    return undefined;
  }

  // CHECK 7's REFUSAL. Computing the diff is only worth it if someone READS it: a policy edit that
  // revokes a capability from eight scopes must not be indistinguishable, at the moment of publishing,
  // from a comment-only edit. Placed after the dry-run branch on purpose — `--dry-run` is how you look
  // before deciding, so it must never refuse.
  // FOLDED INTO CHECK 7'S ACCEPTANCE rather than given its own flag: a silent skill strip IS a decision
  // change, and one flag that means "I have read what this release changes about what agents may do" is
  // better than two an operator has to learn the difference between.
  const strips = skillFindings.filter((f) => f.fatal);
  if ((changes.length || strips.length) && !values['accept-policy-change']) {
    answer(out, ctx, { env: sources.env, account, changes, written: false, refused: true }, head.join('\n'));
    throw refused(`${changes.length} decision(s) would change for ${new Set(changes.map((c) => c.scope)).size} scope(s)`
      + (strips.length ? `, and ${strips.length} pinned skill(s) would be STRIPPED from live holders` : ''), {
      detail: 're-run with --accept-policy-change to publish, having read the list above. A changed decision '
        + 'grants or revokes a CAPABILITY for a real scope on its next turn; a STRIP removes a pinned SKILL '
        + 'from a live holder, which has no failure surface at all — the prose simply stops being in the '
        + 'prompt and the agent quietly stops doing something it used to do.',
    });
  }

  if (unchanged) {
    answer(out, ctx, { env: sources.env, account, digest: artifact.policyDigest, rows: 0, written: false, unchanged: true },
      [...head, `written   nothing — every row already matches ${artifact.policyDigest}`].join('\n'));
    return undefined;
  }

  const at = nowIso(deps);
  const by = whoami(deps);
  const doc = aws.doc();
  const { PutCommand } = aws.docCmds;
  const schema = await deps.schema?.() ?? await import(`file://${require.resolve('../../archie-runner/config-resolver/schema.mjs')}`);

  // ARTIFACT FIRST, then the rows. Ordering matters for the failure case: with the artifact written and
  // rows missing, the dispatcher's backstop derives them on each scope's next turn, so a crash here
  // self-heals. Rows-first would leave the artifact stale and the backstop unable to tell.
  await doc.send(new PutCommand({
    TableName: table,
    Item: { ...schema.fleetPolicyKey(), data: JSON.stringify({ ...artifact, publishedAt: at, publishedBy: by }) },
  }));
  out.progress(`wrote ${POLICY_PK} / ${FLEET_SK}  digest=${artifact.policyDigest}`);

  let written = 0;
  for (const row of rows) {
    await doc.send(new PutCommand({
      TableName: table,
      Item: { ...schema.agentPolicyKey(row.scope), data: JSON.stringify(row) },
    }));
    written++;
  }
  out.progress(`wrote ${written} AGENT#<scope>/POLICY row(s)`);

  answer(out, ctx, { env: sources.env, account, digest: artifact.policyDigest, scopes: all, rows: written, written: true },
    [...head,
      `written   ${POLICY_PK}/${FLEET_SK} + ${written} row(s)`,
      'effective on each scope\'s next turn; the dispatcher re-derives anything this missed',
    ].join('\n'));
  return undefined;
}

/** What the fleet is currently running, and whether it matches the sources on disk. */
async function show(ctx, args, out, deps = {}) {
  const aws = clientsFor(ctx, deps);
  const account = await resolveAccount(ctx, aws);
  const schema = await import(`file://${require.resolve('../../archie-runner/config-resolver/schema.mjs')}`);
  const r = await aws.doc().send(new aws.docCmds.GetCommand({
    TableName: ctx.resources.configTable, Key: schema.fleetPolicyKey(),
  }));
  const live = r?.Item?.data ? JSON.parse(r.Item.data) : null;
  let sources = null;
  try { sources = deps.sources || sourcesForAccount(account, deps); } catch { /* reported as unknown below */ }

  const lines = live
    ? [`live      ${live.policyDigest}  published ${live.publishedAt || 'unknown'} by ${live.publishedBy || 'unknown'}`,
      `groups    ${Object.keys(live.groups || {}).length} pinned capability group(s)`]
    : ['live      none — no policy has been published, so every scope keeps pre-policy behaviour'];
  if (sources) {
    lines.push(`sources   ${sources.digest} (env ${sources.env})`);
    lines.push(live && live.policyDigest === sources.digest
      ? 'state     IN SYNC'
      : 'state     DRIFTED — `archie policy publish` to apply the sources on disk');
  }
  answer(out, ctx, { live, sourcesDigest: sources?.digest ?? null, inSync: !!live && live.policyDigest === sources?.digest }, lines.join('\n'));
  return undefined;
}

/**
 * `archie policy codegen` — re-render the generated baseline module from the policy.
 *
 * Needs no AWS: the baseline set lives in the SHARED semantics, not the per-environment pins, so any env
 * renders the same members. `--env` selects which pins file supplies the digest line only.
 */
async function codegenCmd(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const env = values.env || 'sandbox';
  const sources = deps.sources || loadPolicySources({ env });
  if (ctx.dryRun) {
    const same = (() => { try { codegen.assertGenerated({ env }); return true; } catch { return false; } })();
    answer(out, ctx, { env, path: codegen.GENERATED, changed: !same, written: false, dryRun: true },
      same ? `${codegen.GENERATED} is up to date` : `${codegen.GENERATED} WOULD change — run --no-dry-run`);
    return undefined;
  }
  const r = codegen.write(sources);
  answer(out, ctx, { env, path: codegen.GENERATED, changed: r.changed, written: r.changed },
    r.changed ? `wrote ${codegen.GENERATED} (commit it)` : `${codegen.GENERATED} already matches the policy`);
  return undefined;
}

/**
 * `archie policy seed --env <env> --sandra <path>` — derive a pins file's SKILL allow-lists from sandra.
 *
 * THE EXPLICIT RE-BASELINE, alongside the automatic one. `config hydrate` runs the same derivation on every
 * run (seed-policy-pins.mjs) and selects the pins file BY ACCOUNT via STS, which is the right selector there
 * and the wrong one here: seeding PROD's pins from a laptop holding sandbox credentials is a legitimate
 * thing to want, and `--env` is how you say it. Same library either way, so the two cannot disagree.
 *
 * Skill groups REPLACE, capability groups UNION — see lib/policy-seed.js for why the asymmetry, in short:
 * a manual UI grant has no config signal by construction, so a replacing derivation would revoke it.
 */
async function seedCmd(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const env = values.env;
  const sandra = values.sandra;
  if (!env) throw usage('--env <env> is required (which pins file to seed)');
  if (!sandra) {
    throw usage('--sandra <path> is required — the config repo checkout to derive from', {
      detail: 'point it at the sandra directory INSIDE the repo, e.g. ~/example/sandra-openclaw-config/sandra. '
        + 'The branch you have checked out there decides the fleet: main for prod.',
    });
  }
  const sources = loadPolicySources({ env });
  const declared = seed.realKeys(sources.pins.groups);
  const pinnedSkills = declared.filter((g) => g.startsWith('skill.')).map((g) => g.slice('skill.'.length));
  const pinnedCaps = declared.filter((g) => g.startsWith('pin.')).map((g) => g.slice('pin.'.length));
  if (!pinnedSkills.length && !pinnedCaps.length) {
    throw refused(`pins.${env}.json declares no skill.* or pin.* groups, so there is nothing to seed`, {
      detail: 'the pinned SET is code (config-resolver/skill-pins.mjs and the Cedar policy), and this command '
        + 'only fills in membership for groups that already exist — it will not invent a group and thereby a new pin.',
    });
  }

  // The two derived artifacts extract.mjs leaves behind, which carry the surfaces sandra's files do not:
  // items/agents/<id>.json has each agent's code-declared `skills` and its resolved tool config, and
  // ground-truth/<id>.json has the per-agent PLUGIN config (hindsight's enableKnowledgeTools). Both are
  // gitignored build output, so a stale or missing one narrows coverage — reported, never silently empty.
  const CR = require('node:path').dirname(require.resolve('../../archie-runner/config-resolver/rekey-to-scope.mjs'));
  // `--agent <scope>` derives ONE scope's membership and leaves every other member of every group exactly
  // as it was. Not a display filter: the derivation itself is restricted, and the merge is per-scope
  // (mergeGroupsForAgent) — running the fleet-wide merge over a one-agent derivation would rewrite
  // skill.demo-crm from 135 members to none and call it a clean diff.
  const only = values.agent || null;
  const derived = await seed.deriveSkillGroups(sandra, pinnedSkills, {
    pinnedCaps,
    only,
    itemsDir: require('node:path').join(CR, 'items'),
    groundTruthDir: require('node:path').join(CR, 'ground-truth'),
  });
  const { merged, withheld } = only
    ? { merged: seed.mergeGroupsForAgent(sources.pins.groups, derived.groups, only), withheld: [] }
    : seed.mergeGroups(sources.pins.groups, derived.groups);
  const changes = seed.diffGroups(sources.pins.groups, merged);
  const cov = derived.coverage;

  const lines = [
    `env       ${env}  (pins.${env}.json)`,
    `sandra    ${sandra}`,
    ...(only ? [`scope     ${only}  — ONLY this scope is derived; every other member of every group is left`
      + ' untouched. pin.* still never loses a member (a manual grant has no config signal); skill.* can,'
      + ' for this scope only.'] : []),
    `fleet     ${derived.routed} routed agent(s); ${cov.installs} in marketplace-installs, `
      + `${cov.codeSkills} with code-declared skills, ${cov.config} with config, ${cov.pluginSignals} with plugin signals`,
  ];
  // A capability group derived from an unreadable surface is indistinguishable from an unheld one, and the
  // union merge means silence here would read as "confirmed empty". Say which surface was missing instead.
  if (pinnedCaps.length && !cov.config) {
    lines.push('WARNING   items/agents is absent — NO capability pin was derived from agent config. '
      + 'Run `archie config hydrate` (or extract.mjs) against this sandra tree first.');
  }
  if (pinnedCaps.length && !cov.pluginSignals) {
    lines.push(`WARNING   ground-truth/ is absent — plugin-config capabilities (${seed.PLUGIN_CAP_SIGNALS.map((s) => s.cap).join(', ')}) `
      + 'were NOT derived. capture-ground-truth.mjs produces it (once per agent, plugins on).');
  }
  // FLAG-vs-TOOL DISAGREEMENTS, printed whether or not anything changed. Each one is a capability that
  // LOOKS configured and cannot be exercised (or a tool that is offered and fails), and it derives no
  // membership either way — so without this line the only symptom is a pin group quietly missing a holder.
  for (const c of derived.signalConflicts || []) {
    lines.push(`CONFLICT  ${c.agent} / ${c.cap}: plugin flag=${c.flag}, tool admitted=${c.admitted} — ${c.detail}`);
  }
  if (derived.unmappable.length) {
    // LOUD, because it means the two halves of this sandra tree describe different fleets, and a silent drop
    // seeds an allow-list missing real holders.
    lines.push(`UNMAPPABLE ${derived.unmappable.length} agent(s) hold a pinned authority but have NO routing surface,`
      + ' so no scope id:');
    for (const u of derived.unmappable.slice(0, 6)) lines.push(`            ${u.agent}  (${u.groups.join(', ')})`);
    if (derived.unmappable.length > 6) lines.push(`            … +${derived.unmappable.length - 6} more`);
  }
  for (const w of withheld) {
    lines.push(`REMOVED   ${w.group}: ${w.members.length} member(s) no config surface explains — `
      + `${w.members.join(', ')}. This file is DERIVED; declare it in config to keep it.`);
  }
  if (!changes.length) lines.push('membership already matches this sandra tree — nothing to write');
  for (const c of changes) {
    lines.push(`${c.group}`);
    if (c.added.length) lines.push(`            + ${c.added.length}: ${c.added.slice(0, 8).join(', ')}${c.added.length > 8 ? ', …' : ''}`);
    // REMOVALS ARE THE DANGEROUS HALF and are listed in full: each is a holder that loses access. Only
    // `skill.*` can produce one, since `pin.*` is unioned.
    if (c.removed.length) lines.push(`            - ${c.removed.length} (LOSES ACCESS): ${c.removed.join(', ')}`);
  }

  if (ctx.dryRun || !changes.length) {
    answer(out, ctx, { env, sandra, changes, withheld, unmappable: derived.unmappable, signalConflicts: derived.signalConflicts, coverage: cov, written: false, dryRun: Boolean(ctx.dryRun) },
      [...lines, changes.length ? 'written   nothing (dry run) — re-run with --no-dry-run' : ''].filter(Boolean).join('\n'));
    return undefined;
  }

  const target = values.file || require('node:path').join(require('../lib/policy-sources').POLICY_DIR, `pins.${env}.json`);
  const next = seed.applySkillGroups(sources.pins, merged);
  require('node:fs').writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
  answer(out, ctx, { env, sandra, changes, withheld, unmappable: derived.unmappable, signalConflicts: derived.signalConflicts, coverage: cov, written: true, file: target },
    [...lines, `written   ${target} — review the diff and commit it`].filter(Boolean).join('\n'));
  return undefined;
}

module.exports = {
  publish, show, sourcesForAccount, enumerateScopes, codegen: codegenCmd, seed: seedCmd,
  'policy seed': seedCmd,
  'policy publish': publish, 'policy show': show, 'policy codegen': codegenCmd,
};

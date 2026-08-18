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
const { runSourceChecks, capabilityUniverse, diffDecisions } = require('../lib/policy-checks');
const { scanBindings } = require('../lib/bindings');
const { collectFromDdb } = require('../../archie-gateway/routing-build');

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
 * Every scope we can enumerate, as two columns rather than one merged number.
 *
 * ROUTING is what `archie deploy` stages. RUNTIME# partitions are the scopes that have actually SERVED,
 * which includes minted ones the roster has never contained. Neither is a superset: measured in the
 * sandbox 2026-08-18, routing held 2 and runtimes held 4 — and the two it lacked included
 * ch-cr89fluhion, the scope every sandbox pin is attached to.
 *
 * Reporting them separately is the point: a scope in `minted` and not in `routing` is invisible to every
 * other fleet command, and an operator should see that rather than have it averaged away.
 */
async function enumerateScopes(aws, ctx) {
  const [routingRows, bindings] = await Promise.all([
    collectFromDdb(aws.doc(), ctx.resources.configTable),
    scanBindings(aws, ctx),
  ]);
  const routing = [...new Set(routingRows.map((r) => r.agent).filter(Boolean))].sort();
  const served = [...new Set(bindings.map((b) => b.agent).filter(Boolean))].sort();
  const minted = served.filter((s) => !routing.includes(s));
  return { routing, minted, all: [...new Set([...routing, ...served])].sort() };
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

async function publish(ctx, args, out, deps = {}) {
  const values = (args && args.values) || {};
  const aws = clientsFor(ctx, deps);
  const table = ctx.resources.configTable;
  const account = await resolveAccount(ctx, aws);
  const sources = deps.sources || sourcesForAccount(account, deps);

  const { routing, minted, all } = await enumerateScopes(aws, ctx);
  if (!all.length) {
    throw preflight(`no scopes found in ${table}`, {
      detail: 'nothing in the routing GSI and no RUNTIME# bindings — either --name points at the wrong '
        + 'deployment or the config has never been hydrated (`archie config hydrate`).',
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
    `scopes    ${routing.length} routed + ${minted.length} minted-only = ${all.length}`
    + (minted.length ? `  (minted-only: ${minted.join(', ')})` : ''),
    `verified  ${checked} scope(s) — membership derivation matches Cedar`,
    `pinned    ${withPins.length} scope(s) hold at least one pinned capability:`,
    ...withPins.map((r) => `            ${r.scope}  ${allowsFor(r).join(', ')}`),
    ...decisionLines,
  ];

  if (ctx.dryRun) {
    out.progress(`would write ${POLICY_PK} / ${FLEET_SK} + ${rows.length} AGENT#<scope>/POLICY row(s)`);
    answer(out, ctx, { env: sources.env, account, artifact, rows, changes, written: false, dryRun: true },
      [...head, `written   nothing (dry run) — ${rows.length} row(s) + the fleet artifact would be written`].join('\n'));
    return undefined;
  }

  // CHECK 7's REFUSAL. Computing the diff is only worth it if someone READS it: a policy edit that
  // revokes a capability from eight scopes must not be indistinguishable, at the moment of publishing,
  // from a comment-only edit. Placed after the dry-run branch on purpose — `--dry-run` is how you look
  // before deciding, so it must never refuse.
  if (changes.length && !values['accept-policy-change']) {
    answer(out, ctx, { env: sources.env, account, changes, written: false, refused: true }, head.join('\n'));
    throw refused(`${changes.length} decision(s) would change for ${new Set(changes.map((c) => c.scope)).size} scope(s)`, {
      detail: 're-run with --accept-policy-change to publish. Read the list above first: each changed '
        + 'decision grants or revokes a capability for a real scope on its next turn.',
    });
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

module.exports = {
  publish, show, sourcesForAccount, enumerateScopes,
  'policy publish': publish, 'policy show': show,
};

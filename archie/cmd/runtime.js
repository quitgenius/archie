'use strict';

// `archie runtime list|delete|gc` and `archie access-point gc` — RUNTIME-CLI-REFERENCE.md §2.15-§2.18.
//
// THE ONE RULE THAT SHAPES THIS WHOLE FILE: the registry is how we enumerate, never
// `ListAgentRuntimes`. List is 25/s ACCOUNT-WIDE, non-adjustable, has no name filter and there is no
// get-by-name (`runtime-registry.js:5-10`) — a fleet-wide roll that rediscovered ARNs that way scaled
// as agents x pages against a hard ceiling, which is the entire reason the registry exists. Two
// commands here are allowed to call List, and both are opt-in and expensive by design:
// `runtime gc --reconcile-aws` (finding rows AWS has and we do not IS the point, §6.5) and
// `access-point gc` (an access point's mount is only visible from GetAgentRuntime, so "no live
// runtime" is not answerable any other way).
//
// SECOND RULE: rows are never deleted. The reaper REMOVEs the arn and stamps `reapedAt` so the row
// survives as history — without that "a rollback to a reaped generation would invoke a corpse"
// (`runtime-registry.js:30-37`). Everything destructive here goes through markReaped, never a
// DeleteItem, and `markReaped` stays UNCONDITIONAL while `clearArn` stays conditional
// (`runtime-registry.js:152-214`).
//
// THIRD RULE: reuse, do not reimplement. The reap semantics below are `gcOldGenerations`
// (`agentcore-client.js:520`) with one difference that could not be expressed by calling it: it keeps
// exactly ONE name per agent, and `--keep N` keeps a SET (the live generation plus N rollback
// targets). Everything else is the cited primitive — `listGenerations`/`markReaped`/`runtimeIdOf`
// from the registry, `isGenerationOf` for ownership, `waitForRuntimeDeleted` for the name release.

const {
  createRuntimeRegistry, runtimeIdOf, nameFromSk, PK_PREFIX,
} = require('../../slack-dispatcher/runtime-registry');
const { isGenerationOf } = require('../../slack-dispatcher/agentcore-client');
const { waitForRuntimeDeleted } = require('../../slack-dispatcher/agentcore-provisioning');
const { CliError, EXIT, usage, refused } = require('../lib/exit');
const { makeClient } = require('../lib/aws');

// ── constants, each with the measurement or incident behind it ───────────────

// Account limit on AgentCore runtimes. Quoted in reference §5.4's arithmetic and in preflight check
// 12; reported here so a reap says what it bought.
const RUNTIME_QUOTA = 1000;

// "N ROLLBACK TARGETS", not N runtimes and not N days. Keeping N therefore keeps N+1 generations:
// the live one plus N to roll back to.
//
// DEFAULT 1, not 2, because `fleet deploy` now reaps BEFORE it builds (see cmd/fleet.js step 0). The
// new generation arrives AFTER the reap, so a deploy leaves N+1 rollback targets rather than N:
//
//   --keep 1  ->  gc leaves 2 generations (416), staging peaks at 3 (624), rests at 3 (624)
//   --keep 2  ->  gc leaves 3 generations (624), staging peaks at 4 (832), rests at 4 (832)
//   --keep 3  ->  gc leaves 4 generations (832), staging peaks at 5 (1,040) — OVER the 1,000 cap
//
// So `--keep 1` under reap-first yields exactly what `--keep 2` yielded under reap-last — the live
// generation plus two to roll back to — at a lower peak (624 vs 832) and with the resting headroom
// restored to 376 rather than 168. A standalone `archie runtime gc` keeps the same meaning; it
// simply is not followed by a generation being added.
const DEFAULT_KEEP = 1;
const MAX_SAFE_KEEP = 2;

// Only a SETTLED runtime may be deleted. A CREATING generation may be another writer's in-flight
// provision and deleting it races that writer into a failed turn (`agentcore-client.js:568-570`).
const SETTLED = ['READY', 'CREATE_FAILED'];

// The name release budget: 400 x 3s = 20 minutes (`agentcore-provisioning.js:410-421`). NOT a
// mistake and NOT padding — live deletes on 2026-08-01 ran 3.5-10+ minutes and one that had served
// turns held its name past 10, which lost the original 5-minute budget's race twice. A delete that
// looks hung for five minutes is normal (§6.3).
const DEFAULT_DELETE_WAIT_SECONDS = 1200;
const DELETE_POLL_INTERVAL_MS = 3000;

// Access points are deletable only by this tag: IAM permits DeleteAccessPoint solely on
// `managed-by=agentcore` (`iam.tf:240-252`), which is why the create-time tag condition is
// load-bearing (`iam.tf:223-239`). ECS, agent-xx9aff and filebrowser access points are NOT tagged
// this way (`agent-teardown.js:33,77`), and that is the only thing keeping this command off them.
const AP_TAG_KEY = 'managed-by';
const AP_TAG_VALUE = 'agentcore';

// Settling pause between deleting a runtime and deleting the access point it mounted
// (`phase3-e2e.mjs:183`). The natural operator sequence is `runtime gc` then `access-point gc`, and
// this covers the window where AWS still has the runtime attached to the AP it is tearing down.
const AP_SETTLE_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── AWS clients ──────────────────────────────────────────────────────────────

/**
 * The client bundle. Injectable in full (`deps.clients`) so tests need neither credentials nor
 * network — nothing below constructs an SDK client when one is supplied.
 *
 * Shape is `{ control, controlCmds, efs, efsCmds, doc, docCmds }`, matching
 * `makeProvisioningClients` (`agentcore-client.js:273`) because `waitForRuntimeDeleted` is handed
 * this bundle directly and reads `clients.controlCmds.GetAgentRuntimeCommand`.
 *
 * Region and credentials go through `lib/aws.js` rather than being spelled out here: the credential
 * export name differs between SDK versions and getting it wrong throws ONLY when a real `--profile`
 * is passed — which every injected-client test misses, so it surfaces on the first live run. One
 * place to be wrong is the whole point of that module.
 *
 * The packages are still require()d directly for their COMMAND CLASSES, which are plain constructors
 * and need no config.
 */
function awsClients(ctx, injected) {
  if (injected) return injected;
  const controlCmds = require('@aws-sdk/client-bedrock-agentcore-control');
  const efsCmds = require('@aws-sdk/client-efs');
  const docCmds = require('@aws-sdk/lib-dynamodb');

  return {
    control: makeClient(ctx, '@aws-sdk/client-bedrock-agentcore-control', 'BedrockAgentCoreControlClient'),
    controlCmds,
    efs: makeClient(ctx, '@aws-sdk/client-efs', 'EFSClient'),
    efsCmds,
    doc: docCmds.DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient')),
    docCmds,
  };
}

/**
 * The registry, pointed at the derived table name.
 *
 * `doc` is a GETTER by contract (`runtime-registry.js:68-72`) — it stays lazy so a caller can build
 * the registry without constructing a client. The table comes from `ctx.resources`, never a literal:
 * one knob derives every name, and a mixed setting renders another system's fleet as if it were
 * yours (`lib/context.js`).
 */
function registryFor(ctx, clients) {
  return createRuntimeRegistry({ tableName: ctx.resources.configTable, doc: () => clients.doc });
}

// ── table reads ──────────────────────────────────────────────────────────────

// EVERY attribute name is aliased, without exception. `agent` and `data` are both DynamoDB RESERVED
// KEYWORDS; an unaliased `agent` threw on every provision — it broke every turn for every agent,
// live, on 2026-08-13 (`runtime-registry.js:134-138`). Unit tests cannot catch this class of bug:
// they assert command shape against a fake client and accept a broken expression string happily
// (`registry-e2e.js:5-15`). The reserved list is ~570 words, so "alias only what looks risky" is not
// a strategy — alias everything and the question never has to be asked.
const SCAN_ATTRS = {
  '#pk': 'pk',
  '#sk': 'sk',
  '#arn': 'arn',
  '#runtimeId': 'runtimeId',
  '#runtimeName': 'runtimeName',
  '#agent': 'agent',
  '#generationId': 'generationId',
  '#createdAt': 'createdAt',
  '#updatedAt': 'updatedAt',
  '#stagedAt': 'stagedAt',
  '#reapedAt': 'reapedAt',
  '#clearedAt': 'clearedAt',
  '#healthcheck': 'healthcheck',
};

/**
 * One Scan for the whole picture: every `RUNTIME#<agent>/GEN#<…>` binding row AND the agent roster.
 *
 * A roster is `AGENT#<id>/CONFIG` — the same rule `connector-adopt-run.mjs:34-52` uses, and for the
 * same stated reason: "scan rather than a name list so the run reflects what is actually deployed,
 * not what someone remembered to list". One Scan beats 208 Queries and, unlike `ListAgentRuntimes`,
 * a table Scan is ours and is not rate-capped account-wide.
 */
async function scanConfigTable(clients, table) {
  const { ScanCommand } = clients.docCmds;
  const bindings = [];
  const agents = new Set();
  let ExclusiveStartKey;
  do {
    const r = await clients.doc.send(new ScanCommand({
      TableName: table,
      ProjectionExpression: Object.keys(SCAN_ATTRS).join(', '),
      ExpressionAttributeNames: SCAN_ATTRS,
      ExclusiveStartKey,
    }));
    for (const item of r.Items || []) {
      if (typeof item.pk !== 'string') continue;
      if (item.pk.startsWith('AGENT#') && item.sk === 'CONFIG') { agents.add(item.pk.slice('AGENT#'.length)); continue; }
      if (item.pk.startsWith(PK_PREFIX) && nameFromSk(item.sk)) bindings.push(item);
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return { bindings, agents: [...agents].sort() };
}

/**
 * The live generation, or null.
 *
 * ConsistentRead for the same reason `image-source.js:60-67` reads the image pointer consistently: a
 * release followed immediately by a gc must not read the old pointer from a stale replica and reap
 * what just went live.
 *
 * Phase 1 runs against TODAY's structures (plan §12 step 1) and `CONFIG#release` does not exist yet,
 * so absence is normal and is handled by every caller rather than thrown.
 */
async function activeGeneration(clients, table) {
  const { GetCommand } = clients.docCmds;
  const r = await clients.doc.send(new GetCommand({
    TableName: table,
    Key: { pk: 'CONFIG#release', sk: 'ACTIVE' },
    ConsistentRead: true,
  }));
  const id = r && r.Item && r.Item.generationId;
  return typeof id === 'string' && id ? id : null;
}

/** Binding rows for a named set of agents — the registry's own Query, one agent at a time. */
async function rowsForAgents(registry, agents) {
  const out = [];
  for (const agent of agents) {
    for (const row of await registry.listGenerations(agent)) out.push({ ...row, agent: row.agent || agent });
  }
  return out;
}

// ── pure shaping and planning ────────────────────────────────────────────────

/**
 * One registry row as the CLI reports it.
 *
 * `generation` is the sort-key suffix: TODAY that is the runtime name (fingerprint-keyed), after
 * plan §3's rekey it is the `generationId`, and an explicit `generationId` attribute wins over
 * either. Reading it from one place is what lets every command here survive that rekey unchanged.
 *
 * `runtimeId` goes through `runtimeIdOf`, which DERIVES the id from the arn when the field is
 * absent. Requiring the field outright once made the reaper a silent no-op: "superseded generations
 * stacked 2-3 deep per agent against the 1000-runtime quota, and nothing logged because 'no id'
 * looked exactly like 'already reaped'" (`agentcore-client.js:540-543`).
 */
function bindingOf(row) {
  const runtimeName = row.runtimeName || nameFromSk(row.sk);
  const state = row.arn ? 'live' : (row.reapedAt ? 'reaped' : (row.clearedAt ? 'cleared' : 'unbound'));
  return {
    agent: row.agent || (typeof row.pk === 'string' ? row.pk.slice(PK_PREFIX.length) : null),
    generation: row.generationId || runtimeName,
    runtimeName,
    runtimeId: runtimeIdOf(row),
    arn: row.arn || null,
    state,
    healthcheck: row.healthcheck || null,
    // `stagedAt` is plan §3's field on a binding written by `generation stage`; `createdAt` is what
    // today's registry writes (`runtime-registry.js:125-133`). Both are carried so retention orders
    // correctly on either side of that rename.
    stagedAt: row.stagedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    reapedAt: row.reapedAt || null,
  };
}

/** ISO timestamps sort lexicographically, so recency needs no Date parsing. */
const recencyOf = (b) => b.stagedAt || b.createdAt || b.updatedAt || '';

/**
 * Which bindings to keep and which to reap — PURE, so the retention arithmetic is testable without
 * AWS, which is the half of this command that must not be wrong.
 *
 * Per agent, over LIVE rows only (a reaped row holds no runtime, so it is neither a rollback target
 * nor quota): keep the newest `keep + 1` — the live generation plus `keep` rollback targets — and
 * reap the rest.
 *
 * The active generation is kept UNCONDITIONALLY on top of that window. It is normally the newest, but
 * after a rollback it is not, and "newest is live" would then reap the generation currently serving
 * every turn. When there is no pointer to read, that assumption is all there is; the caller warns.
 */
function planReap(bindings, { keep = DEFAULT_KEEP, active = null } = {}) {
  const byAgent = new Map();
  for (const b of bindings) {
    if (b.state !== 'live') continue;
    if (!byAgent.has(b.agent)) byAgent.set(b.agent, []);
    byAgent.get(b.agent).push(b);
  }
  const kept = [];
  const reap = [];
  for (const agent of [...byAgent.keys()].sort()) {
    const rows = byAgent.get(agent).sort((a, b) => (recencyOf(b) || '').localeCompare(recencyOf(a) || ''));
    rows.forEach((b, i) => {
      if (i <= keep || (active && b.generation === active)) kept.push(b);
      else reap.push(b);
    });
  }
  return { kept, reap };
}

const splitList = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

function parseCount(value, fallback, flag) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw usage(`${flag} must be a non-negative integer, got "${value}"`);
  return n;
}

/** Fixed-width rows for the human (non-`--json`) answer. stdout carries the answer only (§1.4). */
function renderTable(headers, rows) {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length), 0));
  const line = (cells) => cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ').trimEnd();
  return [line(headers), ...rows.map(line)].join('\n');
}

// ── §2.15 `archie runtime list` ──────────────────────────────────────────────

/**
 * Per-agent bindings — the ~208-row companion to `generation list`'s dozen. Read-only, and
 * `--missing` returning rows is still exit 0: it is a report, and the re-run list for
 * `generation stage`.
 */
async function list(ctx, args, out, deps = {}) {
  const clients = awsClients(ctx, deps.clients);
  const configTable = ctx.resources.configTable;
  const { agent, generation, missing, failed } = args.values;

  // One agent is a registry Query; the fleet (and anything needing the roster) is one Scan. Neither
  // is `ListAgentRuntimes` — see the header.
  let bindings;
  let roster = [];
  if (agent) {
    bindings = (await rowsForAgents(registryFor(ctx, clients), [agent])).map(bindingOf);
    roster = [agent];
  } else {
    const scan = await scanConfigTable(clients, configTable);
    bindings = scan.bindings.map(bindingOf);
    roster = scan.agents;
  }

  const target = generation || (missing ? await activeGeneration(clients, configTable) : null);
  if (missing && !target) {
    throw usage('--missing needs a generation to be missing FROM: pass --generation <id>, or publish '
      + 'a release pointer first', { detail: 'CONFIG#release/ACTIVE is absent (reference §2.14).' });
  }
  if (generation) bindings = bindings.filter((b) => b.generation === generation);
  if (failed) bindings = bindings.filter((b) => b.healthcheck === 'failed');

  let missingAgents = [];
  if (missing) {
    const bound = new Set(bindings.filter((b) => b.generation === target && b.state === 'live').map((b) => b.agent));
    missingAgents = roster.filter((a) => !bound.has(a));
  }

  const result = {
    generation: target,
    counts: {
      bindings: bindings.length,
      live: bindings.filter((b) => b.state === 'live').length,
      reaped: bindings.filter((b) => b.state === 'reaped').length,
      failed: bindings.filter((b) => b.healthcheck === 'failed').length,
      missing: missingAgents.length,
    },
    bindings,
    missing: missingAgents,
  };

  // THE HONEST CONSEQUENCE of refusing to call List, stated where it bites (§2.15). A runtime that
  // exists at AWS but whose registry write was lost is invisible to every read in this file, and
  // "missing" is exactly what it looks like.
  if (missingAgents.length) {
    out.warn(`${missingAgents.length} agent(s) have no live binding for ${target}. Re-run `
      + '`archie generation stage` to provision them. If one of them DOES have a runtime at AWS, its '
      + 'registry write was lost and only `archie runtime gc --reconcile-aws` can see it (§6.5).');
  }

  if (ctx.json) return result;
  out.answer(renderTable(
    ['AGENT', 'GENERATION', 'STATE', 'HEALTH', 'RUNTIME ID'],
    bindings.map((b) => [b.agent, b.generation, b.state, b.healthcheck || '-', b.runtimeId || '-']),
  ) + `\n\n${result.counts.bindings} binding(s) · ${result.counts.live} live · ${result.counts.reaped} reaped`
    + (missing ? ` · ${missingAgents.length} agent(s) missing ${target}` : ''));
  return undefined;
}

// ── §2.16 `archie runtime delete` ────────────────────────────────────────────

/**
 * Delete ONE runtime and wait for AgentCore to release its name.
 *
 * Deletes the runtime only: DynamoDB config and EFS data are untouched (unlike `agent-teardown.js`),
 * and the registry row survives as history.
 *
 * Named `deleteRuntime` because `delete` is a reserved word; exported as `delete`.
 */
async function deleteRuntime(ctx, args, out, deps = {}) {
  const clients = awsClients(ctx, deps.clients);
  const configTable = ctx.resources.configTable;
  const { agent, generation } = args.values;
  if (!agent || !generation) throw usage('runtime delete requires --agent <a> and --generation <id>');

  const registry = registryFor(ctx, clients);
  const row = await registry.get(agent, generation);
  if (!row) {
    // Idempotent, like `deleteRuntime` (`agentcore-client.js:450`): not-found is a no-op, not an
    // error. We do NOT fall back to findRuntimeByName — that paginates the whole account
    // (`agentcore-provisioning.js:376-408`) to answer a question the registry already answered.
    out.progress(`no registry row for ${agent}/${generation} — nothing to delete`);
    return ctx.json ? { agent, generation, deleted: false, reason: 'no-registry-row' } : undefined;
  }
  const binding = bindingOf({ ...row, agent });
  if (!binding.arn) {
    out.progress(`${agent}/${generation} was already reaped at ${binding.reapedAt || 'an unknown time'} — nothing to delete`);
    return ctx.json ? { agent, generation, deleted: false, reason: 'already-reaped' } : undefined;
  }
  if (!binding.runtimeId) {
    throw new CliError(`${agent}/${generation} has an arn but no derivable runtime id`, {
      code: EXIT.FAILED,
      detail: `arn=${binding.arn} — GetAgentRuntime and DeleteAgentRuntime both take an id. `
        + 'This is the shape that once made the reaper a silent no-op (agentcore-client.js:540-543).',
    });
  }

  // FAIL CLOSED ON THE LIVE GENERATION. Not knowing whether this is the generation serving every
  // turn is not a reason to proceed — `--force-active` is the declared way to say "I am certain",
  // and it is a flag the operator has to type.
  const active = await activeGeneration(clients, configTable);
  if (!args.values['force-active']) {
    if (active === generation) {
      throw refused(`${generation} is the ACTIVE generation — deleting ${agent}'s runtime would stop it serving`,
        { detail: 'Roll the pointer first (`archie release set`), or pass --force-active.' });
    }
    if (!active) {
      throw refused('cannot prove this is not the live generation: CONFIG#release/ACTIVE is absent',
        { detail: 'Publish a release pointer, or pass --force-active if you are certain.' });
    }
  }

  // ONE GetAgentRuntime, TWO ANSWERS: the status check and the spec read-back. Reading the spec
  // before deleting is "the only moment the old configuration is still observable"
  // (`agentcore-client.js:551-559`) — after the delete, what the runtime was running is unknowable.
  const { GetAgentRuntimeCommand, DeleteAgentRuntimeCommand } = clients.controlCmds;
  let status = null;
  let observed = null;
  try {
    const g = await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: binding.runtimeId }));
    status = g.status || null;
    observed = {
      image: g.agentRuntimeArtifact && g.agentRuntimeArtifact.containerConfiguration
        ? g.agentRuntimeArtifact.containerConfiguration.containerUri : undefined,
      accessPoint: accessPointArnOf(g),
      status,
    };
  } catch (err) {
    if (/ResourceNotFound/i.test((err && err.name) || '')) {
      // Gone at AWS already. The row must stop claiming it, or a rollback here invokes a corpse.
      if (!ctx.dryRun) await registry.markReaped(agent, binding.runtimeName);
      out.progress(`${binding.runtimeName} is already gone at AWS — marked reaped, row kept as history`);
      return ctx.json ? { agent, generation, deleted: false, reason: 'gone-at-aws', reaped: !ctx.dryRun } : undefined;
    }
    throw new CliError(`could not read ${binding.runtimeName} before deleting it`, { code: EXIT.FAILED, cause: err });
  }
  if (status && !SETTLED.includes(status)) {
    // Not a refusal here (§2.16 does not list one) but it IS the gc's hard rail, and for the same
    // reason: a CREATING generation may be another writer's in-flight provision.
    out.warn(`${binding.runtimeName} is ${status}, not settled — if another writer is mid-provision, `
      + 'deleting it races them into a failed turn (agentcore-client.js:568-570)');
  }

  const waitSeconds = resolveDeleteBudget(ctx, args, out);
  if (ctx.dryRun) {
    out.progress(`delete runtime ${binding.runtimeName} (${binding.runtimeId}) for ${agent}`);
    out.progress('then REMOVE its arn and stamp reapedAt (the row is kept as history)');
    const plan = {
      agent, generation, runtimeName: binding.runtimeName, runtimeId: binding.runtimeId,
      observed, deleted: false, dryRun: true,
    };
    if (ctx.json) return plan;
    out.answer(`would delete ${binding.runtimeName} (${binding.runtimeId}) for ${agent}`);
    return undefined;
  }

  await clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: binding.runtimeId }));
  await registry.markReaped(agent, binding.runtimeName);
  out.progress(`deleted ${binding.runtimeName} (${binding.runtimeId}); row kept, arn removed`);

  let released = null;
  if (!args.values['no-wait']) {
    out.progress(`waiting up to ${waitSeconds}s for AgentCore to release the name — 3.5-10+ minutes is `
      + 'NORMAL (§6.3), not a hung command');
    try {
      await waitForRuntimeDeleted(binding.runtimeName, binding.runtimeId, {
        clients,
        sleep: deps.sleep || sleep,
        maxAttempts: Math.ceil((waitSeconds * 1000) / DELETE_POLL_INTERVAL_MS),
        intervalMs: DELETE_POLL_INTERVAL_MS,
      });
      released = true;
    } catch (err) {
      throw new CliError(`the ${waitSeconds}s name-release budget expired for ${binding.runtimeName}`, {
        code: EXIT.TIMEOUT,
        cause: err,
        detail: 'The delete may still complete at AWS. The runtime is deleted and the row is already '
          + 'reaped; only the NAME is still held, which blocks re-creating that exact generation.',
      });
    }
  }

  const result = {
    agent, generation, runtimeName: binding.runtimeName, runtimeId: binding.runtimeId,
    deleted: true, nameReleased: released, observed,
  };
  if (ctx.json) return result;
  out.answer(`deleted ${binding.runtimeName} (${binding.runtimeId})`
    + (released === null ? ' — name release not waited for (--no-wait)' : ' — name released'));
  return undefined;
}

/** The AP arn a runtime mounts, across both spellings AgentCore has returned (`:490-491`). */
function accessPointArnOf(g) {
  const fs0 = (g && g.filesystemConfigurations && g.filesystemConfigurations[0]) || null;
  const ap = fs0 && fs0.efsAccessPoint;
  return (ap && (ap.accessPointArn || ap.efsAccessPointArn)) || null;
}

/**
 * The name-release budget.
 *
 * `--timeout` may only RAISE it: reference §1.2 says the global flag "does not shorten budgets that
 * are correctness mechanisms", and name release is the canonical one. `--wait-timeout` is this
 * command's own flag and is honoured as typed, but a value under the default gets the §6.3 warning
 * because that is precisely the race the 5-minute budget lost twice.
 */
function resolveDeleteBudget(ctx, args, out) {
  const explicit = args.values['wait-timeout'];
  let seconds = DEFAULT_DELETE_WAIT_SECONDS;
  if (explicit !== undefined) {
    seconds = Number(explicit);
    if (!Number.isFinite(seconds) || seconds <= 0) throw usage(`--wait-timeout must be a positive number of seconds, got "${explicit}"`);
    if (seconds < DEFAULT_DELETE_WAIT_SECONDS) {
      out.warn(`--wait-timeout ${seconds}s is below the ${DEFAULT_DELETE_WAIT_SECONDS}s default; live deletes `
        + 'have run 3.5-10+ minutes and one held its name past 10 (§6.3)');
    }
  }
  if (ctx.timeoutSeconds && ctx.timeoutSeconds > seconds) seconds = ctx.timeoutSeconds;
  return seconds;
}

// ── §2.17 `archie runtime gc` ────────────────────────────────────────────────

/** Retention-based reaping. `--keep N` = N ROLLBACK TARGETS (so N+1 generations survive). */
async function gcRuntimes(ctx, args, out, deps = {}) {
  const clients = awsClients(ctx, deps.clients);
  const configTable = ctx.resources.configTable;
  const keep = parseCount(args.values.keep, DEFAULT_KEEP, '--keep');
  if (keep > MAX_SAFE_KEEP) {
    out.warn(`--keep ${keep} keeps ${keep + 1} generations. At every agent in the fleet that is ${(keep + 1) * 208} runtimes, `
      + `and ${(keep + 2) * 208} during a staging pass — over the ${RUNTIME_QUOTA}-runtime cap, where staging `
      + 'fails at exit 8 (§5.4).');
  }

  const only = splitList(args.values.agents);
  const registry = registryFor(ctx, clients);
  let bindings;
  let roster;
  if (only.length) {
    bindings = (await rowsForAgents(registry, only)).map(bindingOf);
    roster = only;
  } else {
    const scan = await scanConfigTable(clients, configTable);
    bindings = scan.bindings.map(bindingOf);
    roster = scan.agents;
  }

  const active = await activeGeneration(clients, configTable);
  if (!active) {
    out.warn('no CONFIG#release/ACTIVE pointer — retention falls back to "the newest binding per agent '
      + 'is the live one". That holds unless you have rolled BACK, where the live generation is older '
      + `than ${keep} newer ones and would be reaped. Check the plan below before --no-dry-run.`);
  }

  const { kept, reap } = planReap(bindings, { keep, active });
  const liveBefore = bindings.filter((b) => b.state === 'live').length;

  for (const b of reap) out.verbose(`reap ${b.agent} ${b.generation} (${b.runtimeId})`);
  out.progress(`keep ${kept.length} binding(s) · reap ${reap.length} · ${roster.length} agent(s) in scope`);

  const reaped = [];
  const skipped = [];
  if (!ctx.dryRun) {
    for (const b of reap) {
      try {
        const outcome = await reapOne(clients, registry, b);
        if (outcome.reaped) reaped.push({ ...b, observed: outcome.observed });
        else skipped.push({ agent: b.agent, generation: b.generation, reason: outcome.reason });
      } catch (err) {
        // Per-unit, so `failures[]` names WHICH agent failed and the run exits 6 PARTIAL rather than
        // collapsing 208 units into one code (§1.4).
        out.failure({ agent: b.agent, step: 'runtime delete', error: err });
      }
    }
  }

  let reconcile = null;
  if (args.values['reconcile-aws']) reconcile = await reconcileAgainstAws(ctx, clients, out, { bindings, roster, keep: kept });

  const result = {
    keep,
    active,
    kept: kept.map((b) => ({ agent: b.agent, generation: b.generation })),
    planned: reap.map((b) => ({ agent: b.agent, generation: b.generation, runtimeId: b.runtimeId })),
    reaped: reaped.map((b) => ({ agent: b.agent, generation: b.generation, runtimeId: b.runtimeId })),
    skipped,
    reconcile,
    quota: {
      cap: RUNTIME_QUOTA,
      registryLiveBefore: liveBefore,
      registryLiveAfter: liveBefore - reaped.length,
      // Say what the number IS. The registry sees only what it recorded; a runtime whose write was
      // lost is invisible here and leaks against the same cap (§6.5).
      source: reconcile ? 'ListAgentRuntimes' : 'registry (registry-visible runtimes only)',
    },
    // §6.4: never claim a clean teardown. Workload identities and agentic_ai ENIs survive runtime
    // deletion, cannot be removed by the caller, and pin the runtime security group indefinitely.
    residue: 'workload identities and agentic_ai ENIs survive runtime deletion and are NOT cleaned (§6.4)',
  };

  if (ctx.json) return result;
  out.answer([
    `keep      ${kept.length} binding(s)${active ? ` (active ${active})` : ''}`,
    `reap      ${reap.length} binding(s)`,
    `${ctx.dryRun ? 'would reap' : 'reaped'} ${ctx.dryRun ? reap.length : reaped.length} · skipped ${skipped.length} · errors ${out.failureCount()}`,
    `quota     ${result.quota.registryLiveAfter}/${RUNTIME_QUOTA} runtimes after reap (${result.quota.source})`,
    `residue   ${result.residue}`,
  ].join('\n'));
  return undefined;
}

/**
 * Reap one binding: read back, settled-check, delete, mark reaped. This is `gcOldGenerations`'s inner
 * loop (`agentcore-client.js:550-576`) — every step is load-bearing and none may be reordered.
 */
async function reapOne(clients, registry, b) {
  const { GetAgentRuntimeCommand, DeleteAgentRuntimeCommand } = clients.controlCmds;
  if (!b.runtimeId) return { reaped: false, reason: 'no-derivable-runtime-id' };

  let status = null;
  let observed = null;
  try {
    const g = await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: b.runtimeId }));
    status = g.status || null;
    observed = {
      image: g.agentRuntimeArtifact && g.agentRuntimeArtifact.containerConfiguration
        ? g.agentRuntimeArtifact.containerConfiguration.containerUri : undefined,
      accessPoint: accessPointArnOf(g),
      configTable: (g.environmentVariables || {}).AGENT_CONFIG_TABLE,
    };
  } catch (err) {
    if (/ResourceNotFound/i.test((err && err.name) || '')) {
      await registry.markReaped(b.agent, b.runtimeName);
      return { reaped: false, reason: 'already-gone-at-aws' };
    }
    throw err;
  }
  // ONLY SETTLED. A CREATING generation may be another writer's in-flight provision.
  if (status && !SETTLED.includes(status)) return { reaped: false, reason: `unsettled (${status})` };

  await clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: b.runtimeId }));
  // Unconditional by design (`runtime-registry.js:199-204`): we just deleted THAT id, so the row must
  // stop advertising it even if the arn changed underneath — which would itself be a bug worth seeing
  // as a missing arn rather than a working one.
  await registry.markReaped(b.agent, b.runtimeName);
  return { reaped: true, observed };
}

/**
 * `--reconcile-aws`: the full `ListAgentRuntimes` pass deferred at `agentcore-client.js:528-533`.
 *
 * Expensive and unscopable — 25/s account-wide, and IAM cannot scope List at all
 * (`iam.tf:199-212`) — which is why it is a flag and not the default. Run weekly, and before any
 * release where preflight check 12 warns (§6.5).
 *
 * OWNERSHIP IS PROVED, NEVER ASSUMED. Runtime names are `oc_<agent>_<fingerprint>` and carry no
 * deployment prefix, so a second archie in the same account (the sandbox runs exactly that: the
 * OpenClaw baseline alongside agent-gn0p84) has runtimes whose NAMES are indistinguishable from ours.
 * An orphan is therefore only deleted when its own `AGENT_CONFIG_TABLE` env var equals the table
 * `--name` derived — the same one knob, read back off the resource itself. Anything else is reported
 * as foreign and never touched.
 */
async function reconcileAgainstAws(ctx, clients, out, { bindings, roster, keep }) {
  const { ListAgentRuntimesCommand, GetAgentRuntimeCommand, DeleteAgentRuntimeCommand } = clients.controlCmds;
  const known = new Set(bindings.filter((b) => b.state === 'live').map((b) => b.runtimeName));
  const keepNames = new Set(keep.map((b) => b.runtimeName));

  out.progress('scanning ListAgentRuntimes (25/s account-wide, unscopable in IAM) for runtimes with no registry row');
  const all = [];
  let token;
  do {
    const r = await clients.control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
    for (const rt of r.agentRuntimes || []) all.push({ id: rt.agentRuntimeId, name: rt.agentRuntimeName || '' });
    token = r.nextToken;
  } while (token);

  const orphans = [];
  const foreign = [];
  const reaped = [];
  for (const rt of all) {
    if (known.has(rt.name) || keepNames.has(rt.name)) continue;
    const agent = roster.find((a) => isGenerationOf(rt.name, a)) || null;
    let status = null;
    let configTable = null;
    try {
      const g = await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: rt.id }));
      status = g.status || null;
      configTable = (g.environmentVariables || {}).AGENT_CONFIG_TABLE || null;
    } catch (err) {
      if (!/ResourceNotFound/i.test((err && err.name) || '')) throw err;
      continue;
    }
    const mine = configTable === ctx.resources.configTable;
    const record = { runtimeId: rt.id, runtimeName: rt.name, agent, status, configTable };
    if (!mine || !agent) { foreign.push(record); continue; }
    if (status && !SETTLED.includes(status)) { orphans.push({ ...record, action: `skipped (${status})` }); continue; }
    orphans.push({ ...record, action: ctx.dryRun ? 'would delete' : 'deleted' });
    if (!ctx.dryRun) {
      try {
        await clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: rt.id }));
        reaped.push(record);
      } catch (err) {
        out.failure({ agent, step: 'orphan runtime delete', error: err });
      }
    }
  }
  if (foreign.length) {
    out.warn(`${foreign.length} runtime(s) at AWS are not this deployment's (their AGENT_CONFIG_TABLE is not `
      + `${ctx.resources.configTable}) — reported, never touched`);
  }
  return { scanned: all.length, orphans, foreign: foreign.length, reaped: reaped.length };
}

// ── §2.18 `archie access-point gc` ───────────────────────────────────────────

/**
 * Reap EFS access points tagged `managed-by=agentcore` that no runtime mounts.
 *
 * CREATE-RATE HYGIENE, NOT HEADROOM (§6.6). The "120 APs per filesystem" cap in an older comment is
 * WRONG — verified live, the quota is 10,000 per filesystem. Leaked access points matter because
 * every killed run leaks ~18 of them and that is evidence of leaked CREATES, whose concurrency rate
 * IS limited; they are not pressure on a count ceiling.
 *
 * "No live runtime" is only answerable from GetAgentRuntime — an access point does not know what
 * mounts it — so this command sweeps the account's runtimes. That is the one place a full List is
 * unavoidable rather than merely convenient.
 */
async function accessPointGc(ctx, args, out, deps = {}) {
  const clients = awsClients(ctx, deps.clients);
  const extra = parseTagFilter(args.values.tag);

  // The in-use set covers runtimes in EVERY state, DELETING included. That is the ordering rail from
  // §2.18 — runtime first, THEN the access point — expressed as a guard: while AWS still has the
  // runtime, its access point is still attached and is not a candidate.
  const { ListAgentRuntimesCommand, GetAgentRuntimeCommand } = clients.controlCmds;
  const inUse = new Set();     // both spellings of the identity: the arn AND the bare id
  const inUseCount = new Set();
  let scanned = 0;
  let token;
  do {
    const r = await clients.control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
    for (const rt of r.agentRuntimes || []) {
      scanned += 1;
      try {
        const g = await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: rt.agentRuntimeId }));
        const arn = accessPointArnOf(g);
        if (arn) { inUse.add(arn); inUse.add(String(arn).split('/').pop()); inUseCount.add(arn); }
      } catch (err) {
        // A runtime we cannot read is a runtime whose mount we do not know. FAIL CLOSED on the whole
        // command rather than deleting an access point that might be attached to it.
        if (!/ResourceNotFound/i.test((err && err.name) || '')) {
          throw new CliError(`could not read runtime ${rt.agentRuntimeName || rt.agentRuntimeId}; refusing to `
            + 'guess which access points are unmounted', { code: EXIT.FAILED, cause: err });
        }
      }
    }
    token = r.nextToken;
  } while (token);
  out.progress(`${scanned} runtime(s) scanned · ${inUseCount.size} access point(s) mounted by a runtime`);

  const { DescribeAccessPointsCommand, DeleteAccessPointCommand } = clients.efsCmds;
  const candidates = [];
  const protectedAps = [];
  let apToken;
  do {
    const r = await clients.efs.send(new DescribeAccessPointsCommand({ MaxResults: 100, NextToken: apToken }));
    for (const ap of r.AccessPoints || []) {
      const tags = ap.Tags || [];
      // THE scope. IAM permits DeleteAccessPoint only by this tag, and ECS / agent-xx9aff /
      // filebrowser access points do not carry it (`agent-teardown.js:33,77`).
      if (!tags.some((t) => t.Key === AP_TAG_KEY && t.Value === AP_TAG_VALUE)) continue;
      if (extra && !tags.some((t) => t.Key === extra.key && t.Value === extra.value)) continue;
      const record = {
        accessPointId: ap.AccessPointId,
        accessPointArn: ap.AccessPointArn,
        fileSystemId: ap.FileSystemId,
        path: (ap.RootDirectory || {}).Path || null,
        state: ap.LifeCycleState || null,
      };
      if (inUse.has(ap.AccessPointArn) || inUse.has(ap.AccessPointId)) { protectedAps.push(record); continue; }
      if (record.state && record.state !== 'available') { protectedAps.push({ ...record, reason: `state ${record.state}` }); continue; }
      candidates.push(record);
    }
    apToken = r.NextToken;
  } while (apToken);

  for (const ap of candidates) out.verbose(`reap ${ap.accessPointId} ${ap.path || ''}`);
  out.progress(`${candidates.length} tagged access point(s) with no live runtime · ${protectedAps.length} in use or unsettled`);

  const deleted = [];
  if (!ctx.dryRun && candidates.length) {
    // The settling pause from `phase3-e2e.mjs:183`. The natural sequence is `runtime gc` then this
    // command, and a runtime deleted seconds ago may not have released its access point yet.
    await (deps.sleep || sleep)(AP_SETTLE_MS);
    for (const ap of candidates) {
      try {
        await clients.efs.send(new DeleteAccessPointCommand({ AccessPointId: ap.accessPointId }));
        deleted.push(ap);
      } catch (err) {
        out.failure({ agent: ap.path, step: 'access point delete', error: err });
      }
    }
  }

  const result = {
    tag: `${AP_TAG_KEY}=${AP_TAG_VALUE}${extra ? ` + ${extra.key}=${extra.value}` : ''}`,
    runtimesScanned: scanned,
    candidates,
    protected: protectedAps.length,
    deleted: deleted.map((ap) => ap.accessPointId),
    note: 'hygiene, not headroom: the cap is 10,000 access points per filesystem — the real limit is '
      + 'the CreateAccessPoint concurrency rate (§6.6)',
  };
  if (ctx.json) return result;
  out.answer(renderTable(
    ['ACCESS POINT', 'FILESYSTEM', 'PATH', 'ACTION'],
    candidates.map((ap) => [ap.accessPointId, ap.fileSystemId, ap.path || '-', ctx.dryRun ? 'would delete' : 'deleted']),
  ) + `\n\n${candidates.length} candidate(s) · ${protectedAps.length} in use · ${deleted.length} deleted`);
  return undefined;
}

/**
 * `--tag k=v` NARROWS the sweep; it never widens it.
 *
 * `managed-by=agentcore` is not a default that can be overridden, because it is not a preference: it
 * is the only tag IAM will let us delete by (`iam.tf:240-252`). A `--tag managed-by=<other>` is
 * therefore a request for something that cannot work, and saying so is better than issuing deletes
 * that AccessDenied one at a time.
 */
function parseTagFilter(tag) {
  if (tag === undefined) return null;
  const idx = String(tag).indexOf('=');
  if (idx <= 0) throw usage(`--tag must be <key>=<value>, got "${tag}"`);
  const key = String(tag).slice(0, idx);
  const value = String(tag).slice(idx + 1);
  if (key === AP_TAG_KEY && value !== AP_TAG_VALUE) {
    throw refused(`--tag ${key}=${value} contradicts the only tag IAM permits deletion by`, {
      detail: `Access points are deletable only where ${AP_TAG_KEY}=${AP_TAG_VALUE} (iam.tf:240-252).`,
    });
  }
  return { key, value };
}

// ── dispatch ─────────────────────────────────────────────────────────────────

// EXPORT KEYS ARE THE FULL COMMAND KEYS, NEVER THE VERBS — the same rule `cmd/wrappers.js` follows,
// and for a sharper reason here. `registry.load()` resolves `mod[verb] || mod[key]`, and the verb of
// BOTH `runtime gc` and `access-point gc` is `gc`: a `gc` export would win the verb lookup for both,
// so `archie access-point gc --no-dry-run` would run the RUNTIME reaper and delete 208 runtimes when
// someone asked to tidy up access points. With no verb-keyed export in this file, `mod[verb]` is
// undefined for every command and the full-key fallback resolves — the collision cannot happen, and
// it stays impossible without needing registry.js to change.
//
// The helpers below the keys are for tests; none of them is named after a verb.
module.exports = {
  'runtime list': list,
  'runtime delete': deleteRuntime,
  'runtime gc': gcRuntimes,
  'access-point gc': accessPointGc,

  runtimeList: list,
  runtimeDelete: deleteRuntime,
  gcRuntimes,
  accessPointGc,
  planReap,
  // Exported so the default can be ASSERTED: changing it changes fleet-wide quota headroom.
  DEFAULT_KEEP,
  MAX_SAFE_KEEP,
  bindingOf,
  parseTagFilter,
};

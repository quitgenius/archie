'use strict';

// `archie status` — RUNTIME-CLI-REFERENCE.md §2.2, primitives §6.
//
// THE OUTPUT IS THE PRODUCT. This is the command an operator runs first, usually because something
// is wrong and they do not yet know what. So every line below is chosen to be readable in one pass
// and to be TRUE — including the parts that are unknowable, which are printed as unknown rather than
// rounded down to a comfortable zero. Three places that matters concretely:
//
//   1. `healthcheck=ok` is only claimed for bindings that actually carry the field. Today's rows do
//      not have one (plan §12 step 1 — phase 1 writes today's `GEN#<runtimeName>` shape), so they
//      count as `unrecorded`. Reporting them as ok would invent a release gate that never ran.
//   2. A metric with no series is `no data`, never `0`. "NO SERIES != ZERO MESSAGES"
//      (otel-tool.mjs:289) — a quiet fleet and an unresolvable expression look identical otherwise.
//   3. An agent whose binding read FAILED is `unknown`, never `missing`. Missing means "the
//      reconciler has work to do"; unknown means "this command could not tell you".
//
// WHAT IT REFUSES TO DO
//
// `ListAgentRuntimes` — never, in any mode. List is capped at 25/s ACCOUNT-WIDE, non-adjustable,
// with no name filter and no get-by-name (`runtime-registry.js:5-10`); a status command that
// paginated the account would be the single most expensive read in the CLI and would rate-limit the
// live dispatcher while it ran. Coverage therefore comes from the registry, and the honest
// consequence is printed in the output: a runtime created at AWS whose registry write was lost is
// INVISIBLE here (`agentcore-client.js:528-533`). `archie runtime gc --reconcile-aws` is the only
// thing that closes that gap. That note is not decoration — it is the difference between "we have no
// runtime" and "we cannot see the runtime we have".
//
// Treat `missing` as a failure — it is not (reference §2.2). Missing bindings are `fleet reconcile`'s
// job and exit 0 on their own.
//
// WHY METRICS AND NOT LOGS INSIGHTS. Everything here is one `GetMetricData` and a handful of
// DynamoDB reads: no query is started that must then be POLLED. CloudWatch Logs ingestion lags ~18s
// and a COMPLETE result with 0 rows is a valid answer, not a reason to retry to a deadline
// (`agentcore-tests/features/support/world.js:277-281`) — which makes an Insights query a poor fit
// for a command whose contract is "tell me now". If one is ever added here, aggregate on the RAW
// dotted path: `stats earliest(alias)` returns an empty column with no error
// (`insight-queries.js:121-127`).

const { CliError, EXIT, drift } = require('../lib/exit');
const { makeClient } = require('../lib/aws');
const { collectFromDdb } = require('../../slack-dispatcher/routing-build');
const { createRuntimeRegistry } = require('../../slack-dispatcher/runtime-registry');
const { readImageItem } = require('../../slack-dispatcher/image-source');
const { listTaints } = require('../lib/image-pointer');
const corpus = require('../../clawdbot/agentcore-observability/insight-queries');

// Item keys. ONE pointer: `CONFIG#image / FLEET`, which is what the dispatcher reads on every turn.
// There is no separate image pointer to reconcile against it any more — status used to read both
// and describe one as "the intent" and the other as "the reality", which is an accurate description
// of a bug (see lib/image-pointer.js) rather than a design.
const IMAGE_PK = 'CONFIG#image';
const IMAGE_FLEET_SK = 'FLEET';
const IMAGE_AGENT_PREFIX = 'AGENT#';

// One Query per agent (`runtime-registry.js:96`). Bounded because 208 of them arrive at once and an
// unbounded fan-out would throttle the table the live dispatcher is reading from on every turn. Read
// path only, so this can sit well above the ≲5 that EFS forces on the staging path (reference §5.3).
const AGENT_QUERY_CONCURRENCY = 6;

// The self-health window. Fixed rather than a flag: status answers "how is it right now", and an
// operator who wants a different window has `archie metrics query`.
const METRIC_WINDOW_MS = 60 * 60 * 1000;

// Long name lists are unreadable and the full set is in --json anyway.
const NAME_LIST_CAP = 12;

/** `a,b , c` -> ['a','b','c']; absent -> null (meaning "every agent"). */
function parseAgentFilter(values) {
  if (!values || !values.agents) return null;
  const names = String(values.agents).split(',').map((s) => s.trim()).filter(Boolean);
  return names.length ? names : null;
}

/**
 * AWS clients, constructed once.
 *
 * Region and credentials come from `lib/aws.js` — deliberately NOT built here. The obvious spelling
 * is wrong (`@aws-sdk/credential-provider-node` exports `defaultProvider`, not
 * `fromNodeProviderChain`) and it only fails when a real `--profile` is passed, so a suite that
 * injects its clients — this one — stays green while the binary breaks on its first live run. One
 * place to be wrong is the whole point of that module.
 *
 * The document client is the exception to `makeClient` because it takes no config of its own: it
 * WRAPS a DynamoDBClient (`DynamoDBDocumentClient.from`), so the config still arrives via lib/aws.
 */
function createClients(ctx) {
  const { DynamoDBDocumentClient } = require('@aws-sdk/lib-dynamodb');
  return {
    doc: DynamoDBDocumentClient.from(makeClient(ctx, '@aws-sdk/client-dynamodb', 'DynamoDBClient')),
    cw: makeClient(ctx, '@aws-sdk/client-cloudwatch', 'CloudWatchClient'),
  };
}

/**
 * Run a backing read, recording rather than throwing on failure.
 *
 * status is a REPORT: one read failing must not cost the operator the other five. The recorded
 * failures set exit 1 at the end (reference §2.2, "1 a backing read failed") after the report has
 * already been written to stdout.
 */
async function attempt(errors, what, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    errors.push({ what, error });
    return fallback;
  }
}

/** Bounded-concurrency map, preserving input order. Precedent: the promise pool at agent-migrate.js:42. */
async function mapWithConcurrency(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Every item under one partition key.
 *
 * EVERY NAME IS ALIASED, without exception. `agent` and `data` are both DynamoDB reserved words, and
 * leaving `agent` bare threw "Attribute name is a reserved keyword" on every provision for every
 * agent, live, on 2026-08-13 (`runtime-registry.js:136-141`). The reserved list is ~570 words and
 * includes plenty of innocuous-looking ones, so "alias only what looks risky" is not a strategy — and
 * a unit test against a fake client happily accepts the broken expression string, so the habit is the
 * only defence. status.test.js asserts every expression this file builds is fully aliased.
 */
async function queryPartition(doc, tableName, pk) {
  const { QueryCommand } = require('@aws-sdk/lib-dynamodb');
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: tableName,
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': pk },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) items.push(it);
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * The image pointer, or null.
 *
 * ConsistentRead for the same reason the image pointer is read consistently (`image-source.js:64-67`):
 * an operator running `image publish` and then `status` must not be shown the pre-write value from a
 * stale replica and conclude the write was lost.
 */
async function readReleasePointer(doc, tableName) {
  const { readFleetPointer } = require('../lib/image-pointer');
  return readFleetPointer(doc, require('@aws-sdk/lib-dynamodb'), tableName);
}

/**
 * Image pointers: the fleet one plus every per-agent override.
 *
 * `readImageItem` is the dispatcher's own acceptance rule, imported rather than reimplemented — it is
 * what decides that a wrong-typed or empty pointer is ABSENT rather than usable, and status must
 * agree with the turn path about that or it will report a healthy pointer the fleet cannot use.
 * (`createImageSource` itself is not usable here: it starts a background refresher.)
 *
 * Overrides are reported, not treated as drift. `spec-baseline.mjs:86-92` prints them the same way,
 * and a per-agent override is the normal shape of a deliberate canary — exiting 7 on one would train
 * operators to ignore exit 7.
 */
function summariseImagePointers(items) {
  let fleet = null;
  const overrides = [];
  for (const it of items) {
    const value = normaliseImage(readImageItem(it));
    if (it.sk === IMAGE_FLEET_SK) fleet = value;
    else if (typeof it.sk === 'string' && it.sk.startsWith(IMAGE_AGENT_PREFIX)) {
      overrides.push({ agent: it.sk.slice(IMAGE_AGENT_PREFIX.length), image: value });
    }
  }
  return { fleet, overrides };
}

/**
 * A pointer is EITHER a full URI or a bare tag resolved against the repo at provision time
 * (`image-source.js:39-41`). The two are kept apart in the report rather than concatenated into one
 * string: a bare tag has not been resolved yet, and printing `:archie-0.2.6` as if it were a URI
 * invites the reader to believe an image reference that does not exist until provisioning runs.
 */
function normaliseImage(value) {
  if (!value) return null;
  if (typeof value === 'string') return { uri: value, tag: null };
  return value.tag ? { uri: null, tag: value.tag } : null;
}

const fmtImage = (v) => (v ? (v.uri || `tag ${v.tag}`) : 'unusable');

/**
 * Taint, read tolerantly.
 *
 * `image taint` is W2-B's and the plan does not fix the attribute names, so this accepts the
 * plausible spellings rather than silently reporting a tainted tag as shippable. Taint is
 * permanent and unconditional (§5.2) — a false negative here would offer a rollback target that
 * `image publish` will then refuse, which is a worse experience than being told up front.
 */
function taintOf(gen) {
  const at = gen.taintedAt || gen.tainted_at || (gen.tainted === true ? gen.updatedAt || gen.createdAt || true : null);
  if (!at) return null;
  return {
    at: typeof at === 'string' ? at : null,
    reason: gen.taintReason || gen.taintedReason || gen.reason || null,
    by: gen.taintedBy || null,
  };
}

/**
 * Which release a binding row belongs to — the tag its image names.
 *
 * The sort key is a runtime NAME and the release is the TAG, so this reads the image rather than
 * the key. Reading a release out of a sort key is what conflated the two identities.
 */
const tagOfRow = (row) => require('../lib/bindings').tagOf(row);

/** A row claims a LIVE runtime only while it still holds an arn — the reaper REMOVEs it and keeps the row as history. */
const isLive = (row) => Boolean(row && row.arn);

/**
 * Everything derived from the registry, in one pass.
 *
 * Returns per-generation rollups and the per-agent view of the live tag.
 */
function summariseBindings(agents, bindingsByAgent, liveTag) {
  const tags = new Map();
  const staged = [];
  const missing = [];
  const reaped = [];
  const cleared = [];
  const unknown = [];
  const healthcheckFailures = [];
  let ok = 0;
  let failed = 0;
  let pending = 0;
  let unrecorded = 0;

  for (const agent of agents) {
    const rows = bindingsByAgent.get(agent);
    if (rows === undefined) { unknown.push(agent); continue; }

    for (const row of rows) {
      const gen = tagOfRow(row);
      if (!gen) continue;
      const g = tags.get(gen) || { tag: gen, bindings: 0, live: 0, ok: 0, failed: 0, stagedAt: null };
      g.bindings += 1;
      const at = row.stagedAt || row.createdAt || null;
      if (at && (!g.stagedAt || at > g.stagedAt)) g.stagedAt = at;
      if (isLive(row)) g.live += 1;
      if (row.healthcheck === 'ok') g.ok += 1;
      if (row.healthcheck === 'failed') g.failed += 1;
      tags.set(gen, g);
    }

    if (!liveTag) continue;
    const row = rows.find((r) => tagOfRow(r) === liveTag);
    if (!row) { missing.push(agent); continue; }
    if (!isLive(row)) {
      // A row with no arn is history, not coverage. `clearedAt` means an invoke found the runtime
      // dead (`runtime-registry.js:clearArn`) — that is a live fault; `reapedAt` is the reaper doing
      // its job. Same shape, very different meanings, so they are counted apart.
      (row.clearedAt ? cleared : reaped).push(agent);
      continue;
    }
    staged.push(agent);
    if (row.healthcheck === 'ok') ok += 1;
    else if (row.healthcheck === 'failed') {
      failed += 1;
      healthcheckFailures.push({ agent, tag: liveTag, at: row.verifiedAt || row.stagedAt || null });
    } else if (row.healthcheck === 'pending') pending += 1;
    else unrecorded += 1;
  }

  return {
    tags,
    coverage: {
      agents: agents.length,
      staged: staged.length,
      healthcheckOk: ok,
      healthcheckFailed: failed,
      healthcheckPending: pending,
      healthcheckUnrecorded: unrecorded,
      missing,
      reaped,
      cleared,
      unknown,
    },
    healthcheckFailures,
  };
}

/**
 * Rollback targets, newest first.
 *
 * A tag qualifies only while it still has LIVE bindings. A reaped tag's rows survive as
 * history with its arn removed, and pointing at one "would invoke a corpse"
 * (`runtime-registry.js:30-37`) — so a reaped tag is never offered, per reference §2.12.
 * Tainted tags are excluded for the same reason `image publish` would refuse them (§5.2).
 */
function rollbackTargets(tags, taints, liveTag) {
  const out = [];
  for (const g of tags.values()) {
    if (g.tag === liveTag) continue;
    if (!g.live) continue;
    if (taints.has(g.tag)) continue;
    out.push({
      tag: g.tag,
      bindings: g.bindings,
      live: g.live,
      healthcheckOk: g.ok,
      stagedAt: g.stagedAt || null,
    });
  }
  // Newest staged first: the question is almost always "what can I roll back to", and a content
  // digest does not sort chronologically — which is exactly why staging time is the primary key and
  // the tag is only the tie-break.
  out.sort((a, b) => String(b.stagedAt || '').localeCompare(String(a.stagedAt || ''))
    || String(b.tag).localeCompare(String(a.tag)));
  return out;
}

/**
 * Fleet-level self-health, from `SELF_HEALTH_METRICS` — a curated 12-metric set retrievable in ONE
 * `GetMetricData` (`insight-queries.js:1139`).
 *
 * TWO ADAPTATIONS, both deliberate:
 *
 * 1. NAMESPACE RETARGETING. The corpus derives its namespaces from `ARCHIE_STACK` at require time
 *    (`insight-queries.js:48,61-62`), and the CLI's one knob is `--name`. Left alone, `archie status
 *    --name X` would read stack Y's metrics and render another deployment's fleet as if it were
 *    yours — the exact failure that file's header documents. So the corpus's resolved namespaces are
 *    substituted for the ctx-derived ones. NOTE the limit of this: `AgentCore/Pi`,
 *    `AWS/Bedrock-AgentCore` and `ApplicationSignals` are account-global with no stack dimension, so
 *    cold-boot and turn metrics BLEND across two archie deployments in one account. Printed in the
 *    output rather than quietly ignored.
 *
 * 2. FLEET AGGREGATION. The corpus is written for one agent (`otel_my_runtime`), so each expression
 *    is a per-Agent SEARCH returning ~208 series. Wrapping each in metric math collapses it to one
 *    series and keeps this a single call. SUM for counters, MAX for everything else (= worst agent).
 *    NEVER AVG: it divides by the count of ALL agent series, most of which are null in any given
 *    minute, and understates by ~10x (`insight-queries.js`, coldBoot note).
 */
function fleetMetricSpecs(resources) {
  const { METRICS, SELF_HEALTH_METRICS, DISPATCHER_NS, CRON_NS } = corpus;
  const retarget = (expr) => expr
    .split(DISPATCHER_NS).join(resources.dispatcherNamespace)
    .split(CRON_NS).join(resources.cronNamespace);

  return SELF_HEALTH_METRICS.map((name, i) => {
    const spec = METRICS[name];
    if (!spec) return null;
    const expr = retarget(spec.expr);
    // Already wrapped in metric math by the corpus (invokeColdRetries, runtimeGenerationRolls) — the
    // aggregation choice was made there, do not second-guess it. Matched against the metric-math
    // function names ONLY: a bare `SEARCH(` is also uppercase, and treating it as pre-aggregated
    // would leave 208 per-agent series in the response labelled as if they were one fleet number.
    const wrapped = /^(SUM|MAX|MIN|AVG)\(/.test(expr);
    // The statistic lives inside the SEARCH string, not always on `spec.stat` (messagesReceived has
    // no `stat` field at all), so read it from the expression and fall back to the field.
    const inner = /,\s*'([A-Za-z0-9]+)'\s*,\s*\d+\s*\)/.exec(expr);
    const stat = (inner && inner[1]) || spec.stat || null;
    const agg = wrapped ? expr.slice(0, expr.indexOf('(')) : (stat === 'Sum' ? 'SUM' : 'MAX');
    return {
      id: `q${i}`,
      name,
      agg,
      expr: wrapped ? expr : `${agg}(${expr})`,
      // Corpus labels are written for a per-agent board; a MAX over agents is the worst agent, and
      // saying "(per agent)" next to a single fleet number would be a lie about what it counts.
      label: String(spec.label || name)
        .replace(/\(per agent\)/g, agg === 'MAX' ? '(worst agent)' : '(fleet)')
        .replace(/, per agent\)/g, agg === 'MAX' ? ', worst agent)' : ', fleet)'),
    };
  }).filter(Boolean);
}

/** One GetMetricData over the whole set. `ScanBy: TimestampDescending` puts the newest point first. */
async function readSelfHealth(cw, resources, now) {
  const { GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
  const specs = fleetMetricSpecs(resources);
  const res = await cw.send(new GetMetricDataCommand({
    MetricDataQueries: specs.map((s) => ({ Id: s.id, Expression: s.expr, Label: s.label, ReturnData: true })),
    StartTime: new Date(now - METRIC_WINDOW_MS),
    EndTime: new Date(now),
    ScanBy: 'TimestampDescending',
  }));
  const byId = new Map();
  for (const r of res.MetricDataResults || []) byId.set(r.Id, r);

  const metrics = specs.map((s) => {
    const values = ((byId.get(s.id) || {}).Values || []).map(Number).filter(Number.isFinite);
    return {
      name: s.name,
      agg: s.agg,
      label: s.label,
      // null, NOT 0. An empty series is a quiet fleet OR an expression that resolved to nothing, and
      // printing 0 for either invents a measurement (otel-tool.mjs:289).
      latest: values.length ? values[0] : null,
      max: values.length ? Math.max(...values) : null,
      points: values.length,
    };
  });
  return {
    windowMinutes: Math.round(METRIC_WINDOW_MS / 60000),
    namespaces: { dispatcher: resources.dispatcherNamespace, cron: resources.cronNamespace },
    messages: (res.Messages || []).map((m) => m.Value),
    metrics,
  };
}

/** `12`, `1.5`, `1234` — enough precision to compare, not enough to line-wrap. */
function fmtNumber(n) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  if (abs >= 100) return String(Math.round(n));
  if (abs >= 1) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 1000) / 1000);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `a, b, c, and 14 more` — the full list is always in --json. */
function fmtNames(names) {
  if (!names.length) return 'none';
  if (names.length <= NAME_LIST_CAP) return names.join(', ');
  return `${names.slice(0, NAME_LIST_CAP).join(', ')}, and ${names.length - NAME_LIST_CAP} more`;
}

const LABEL_WIDTH = 10;
const label = (s) => s.padEnd(LABEL_WIDTH);
const indent = ' '.repeat(LABEL_WIDTH);

/**
 * The human report. Column-aligned labels, one fact per line, worst news never below the fold.
 * Shape follows reference §2.2's worked example so a runbook written against the doc still reads.
 */
function render(report) {
  const lines = [];
  const { release, image, coverage, selfHealth } = report;

  // ONE LINE, because there is one pointer. It used to be two — a release line and an image line —
  // and the day they disagreed nothing said so.
  if (image.fleet) {
    const pub = release && release.publishedAt
      ? `published ${release.publishedAt}${release.publishedBy ? ` by ${release.publishedBy}` : ''}`
      : 'published (unrecorded)';
    lines.push(`${label('live')}${fmtImage(image.fleet)}   ${pub}`
      + (release && release.tainted ? '   *** TAINTED ***' : ''));
  } else {
    lines.push(`${label('live')}NOTHING PUBLISHED — CONFIG#image/FLEET is absent or unusable; there is NO`);
    lines.push(`${indent}baked fallback, so every turn fails closed with ImagePointerMissing`);
  }
  if (image.overrides.length) {
    lines.push(`${label('override')}${image.overrides.length} per-agent image override(s): `
      + fmtNames(image.overrides.map((o) => `${o.agent}=${fmtImage(o.image)}`)));
  }

  if (report.scope.filtered) {
    lines.push(`${label('scope')}${coverage.agents} agent(s) from --agents (of ${report.scope.fleetAgents} in the routing GSI)`);
  }

  if (release.tag) {
    const bits = [
      `${coverage.staged}/${coverage.agents} staged`,
      `${coverage.healthcheckOk} healthcheck=ok`,
      `${coverage.healthcheckFailed} failed`,
    ];
    if (coverage.healthcheckPending) bits.push(`${coverage.healthcheckPending} pending`);
    // Never folded into `ok`: a binding with no healthcheck field was never gated.
    if (coverage.healthcheckUnrecorded) bits.push(`${coverage.healthcheckUnrecorded} unrecorded`);
    bits.push(`${coverage.missing.length} missing`);
    if (coverage.reaped.length) bits.push(`${coverage.reaped.length} reaped`);
    if (coverage.cleared.length) bits.push(`${coverage.cleared.length} arn-cleared`);
    if (coverage.unknown.length) bits.push(`${coverage.unknown.length} unknown`);
    lines.push(`${label('coverage')}${bits.join(', ')}`);
  } else {
    lines.push(`${label('coverage')}${report.liveBindingAgents}/${coverage.agents} agents hold at least one LIVE binding`);
    lines.push(`${indent}(nothing published to measure against — this is a registry census, not coverage)`);
  }

  // Deliberately NOT a failure (reference §2.2): missing bindings are `fleet reconcile`'s job.
  if (coverage.missing.length) lines.push(`${label('missing')}${fmtNames(coverage.missing)}   (not a failure — fleet reconcile's job)`);
  if (coverage.cleared.length) lines.push(`${label('cleared')}${fmtNames(coverage.cleared)}   (an invoke found the runtime dead)`);
  if (coverage.unknown.length) lines.push(`${label('unknown')}${fmtNames(coverage.unknown)}   (the registry read FAILED — not the same as missing)`);
  if (report.healthcheckFailures.length) {
    lines.push(`${label('failed')}${fmtNames(report.healthcheckFailures.map((f) => f.agent))}`);
  }

  if (report.tainted.length) {
    for (const t of report.tainted) {
      lines.push(`${label('tainted')}${t.generationId} (${t.reason || 'no reason recorded'}`
        + `${t.at ? `, ${t.at}` : ''}${t.failedAgents ? `, ${t.failedAgents} agent(s) failed` : ''})`);
    }
  }

  if (report.rollbackTargets.length) {
    const t = report.rollbackTargets[0];
    const health = t.healthcheckOk === t.bindings ? 'all healthcheck=ok' : `${t.healthcheckOk} healthcheck=ok`;
    lines.push(`${label('rollback')}${t.generationId} (${plural(t.live, 'live binding')}, ${health})`
      + (report.rollbackTargets.length > 1 ? `, +${report.rollbackTargets.length - 1} older` : ''));
  } else {
    lines.push(`${label('rollback')}NONE — no other tag still holds a live binding`);
  }

  if (!report.drift.length) lines.push(`${label('drift')}none`);
  else {
    lines.push(`${label('drift')}${plural(report.drift.length, 'finding')}`);
    for (const d of report.drift) lines.push(`${indent}${d.kind}: ${d.detail}`);
  }

  lines.push(`${label('note')}registry-only: a runtime created at AWS whose registry write was lost is invisible`);
  lines.push(`${indent}here (agentcore-client.js:528-533). \`archie runtime gc --reconcile-aws\` closes that gap.`);

  if (selfHealth && selfHealth.metrics) {
    const withData = selfHealth.metrics.filter((m) => m.points > 0);
    const without = selfHealth.metrics.filter((m) => m.points === 0);
    lines.push('');
    lines.push(`${label('health')}last ${selfHealth.windowMinutes}m · SUM = fleet total · MAX = worst agent (never AVG — it`);
    lines.push(`${indent}divides by every null agent series and understates ~10x)`);
    if (withData.length) {
      const w = Math.max(...withData.map((m) => m.name.length));
      lines.push(`${indent}${'METRIC'.padEnd(w)}  AGG  ${'LATEST'.padStart(9)}  ${'MAX'.padStart(9)}`);
      for (const m of withData) {
        lines.push(`${indent}${m.name.padEnd(w)}  ${m.agg.padEnd(3)}  ${fmtNumber(m.latest).padStart(9)}  ${fmtNumber(m.max).padStart(9)}`);
      }
    }
    // "no data" is never printed as 0 — see the header.
    if (without.length) lines.push(`${indent}no data (a quiet fleet, not an error): ${fmtNames(without.map((m) => m.name))}`);
    for (const msg of selfHealth.messages) lines.push(`${indent}cloudwatch: ${msg}`);
    lines.push(`${indent}AgentCore/Pi + AWS/Bedrock-AgentCore metrics are ACCOUNT-WIDE (no stack dimension):`);
    lines.push(`${indent}a second archie deployment in this account blends into them.`);
  } else if (selfHealth && selfHealth.skipped) {
    lines.push(`${label('health')}skipped (--brief)`);
  } else if (selfHealth && selfHealth.error) {
    lines.push(`${label('health')}UNAVAILABLE: ${selfHealth.error}`);
  }

  if (report.readFailures.length) {
    for (const f of report.readFailures) lines.push(`${label('READ')}FAILED ${f.what}: ${f.error}`);
  }

  return lines.join('\n');
}

/**
 * `archie status` — reference §2.2. Read-only in every mode.
 *
 * Exit: 0 healthy · 7 drift or a tainted active generation · 1 a backing read failed.
 *
 * @param deps.clients {doc, cw}, injected by tests so the suite needs neither credentials nor network.
 */
async function status(ctx, args, out, deps = {}) {
  const { resources } = ctx;
  const table = resources.configTable;
  const brief = Boolean(args && args.values && args.values.brief);
  const filter = parseAgentFilter(args && args.values);
  const now = deps.now ? deps.now() : Date.now();
  const clients = deps.clients || createClients(ctx);
  const errors = [];

  out.verbose(`reading ${table} in ${ctx.region} (name=${ctx.name})`);

  const [releaseItem, taintRecords, imageItems, routingRows] = await Promise.all([
    attempt(errors, `GetItem CONFIG#image/FLEET on ${table}`, () => readReleasePointer(clients.doc, table), null),
    attempt(errors, `Query CONFIG#image taints on ${table}`, () => listTaints(clients.doc, require('@aws-sdk/lib-dynamodb'), table), []),
    attempt(errors, `Query CONFIG#image on ${table}`, () => queryPartition(clients.doc, table, IMAGE_PK), []),
    // The agent enumeration is the routing GSI (`routing-build.js:68`) — reused, not reimplemented.
    attempt(errors, `Query routing GSI on ${table}`, () => collectFromDdb(clients.doc, table), []),
  ]);

  const fleetAgents = routingRows.map((r) => r.agent);
  // With --agents the FILTER is the enumeration, not an intersection: an agent can hold runtime
  // bindings without a routing META item, and refusing to report on it because it is not in the GSI
  // would hide exactly the orphan an operator is chasing. Names absent from routing are still warned
  // about, because a typo'd agent otherwise reads as "no bindings".
  const agents = filter || fleetAgents;
  if (filter) {
    const known = new Set(fleetAgents);
    const unrouted = filter.filter((a) => !known.has(a));
    if (unrouted.length) out.warn(`not present in the routing GSI: ${unrouted.join(', ')} (typo, or an agent with no routing config)`);
  }

  const registry = createRuntimeRegistry({ tableName: table, doc: () => clients.doc });
  const bindingsByAgent = new Map();
  await mapWithConcurrency(agents, AGENT_QUERY_CONCURRENCY, async (agent) => {
    // A per-agent failure is recorded and the agent lands in `unknown`. Reporting it as `missing`
    // would tell the operator to run the reconciler over an agent that may be perfectly healthy.
    const rows = await attempt(errors, `Query RUNTIME#${agent} on ${table}`, () => registry.listGenerations(agent), null);
    if (rows) bindingsByAgent.set(agent, rows);
  });

  const taintByTag = new Map(taintRecords.map((t) => [t.tag, t]));

  const liveTag = (releaseItem && releaseItem.tag) || null;
  const activeTaint = liveTag ? taintByTag.get(liveTag) : null;

  const { tags, coverage, healthcheckFailures } = summariseBindings(agents, bindingsByAgent, liveTag);
  const image = summariseImagePointers(imageItems);
  const targets = rollbackTargets(tags, taintByTag, liveTag);

  const tainted = [];
  for (const [tag, t] of taintByTag) {
    const g = tags.get(tag);
    tainted.push({ tag, reason: t.reason, at: t.taintedAt, by: t.taintedBy, failedAgents: g ? g.failed : 0 });
  }

  // ── drift ────────────────────────────────────────────────────────────────
  // Registry-side only, and it says so. status cannot compare against AWS without ListAgentRuntimes;
  // `archie fleet drift` (spec-baseline's derived-vs-running comparison) is the command that can.
  // What IS knowable here is whether the pointers, the tag catalogue and the bindings agree
  // with each other — which is where the migration's real faults live.
  const driftFindings = [];
  if (!releaseItem) {
    driftFindings.push({
      kind: 'image-pointer-absent',
      detail: 'CONFIG#image/FLEET does not exist, so nothing is published. There is no baked fallback: '
        + 'every turn fails closed rather than guessing an image.',
    });
  }
  if (activeTaint) {
    driftFindings.push({
      kind: 'live-tag-tainted',
      detail: `${liveTag} is TAINTED (${activeTaint.reason || 'no reason recorded'}) and is live. `
        + 'Taint is permanent (§5.2): fix the image and build again, do not retry this one.',
    });
  }
  if (!image.fleet) {
    driftFindings.push({
      kind: 'image-pointer-absent',
      detail: 'CONFIG#image/FLEET is absent or unusable. The dispatcher fails closed with '
        + 'ImagePointerMissing (agentcore-client.js:171-176) — every turn that needs to provision fails.',
    });
  }
  if (coverage.cleared.length) {
    driftFindings.push({
      kind: 'binding-arn-cleared',
      detail: `${plural(coverage.cleared.length, 'binding')} on the live tag had their arn cleared `
        + `by a failed invoke: ${fmtNames(coverage.cleared)}`,
    });
  }
  if (coverage.healthcheckFailed && !activeTaint) {
    // An invariant violation, not a statistic. A failed healthcheck TAINTS the tag (plan §7,
    // §5.2) and a tainted tag may never be pointed at — so a live generation carrying failed
    // bindings and no taint means either the taint write was lost or the pointer was moved onto it
    // anyway. Both are worth exit 7; neither is visible from the coverage line alone.
    driftFindings.push({
      kind: 'active-healthcheck-failed-untainted',
      detail: `${plural(coverage.healthcheckFailed, 'agent')} failed healthcheck on the LIVE generation `
        + `${liveTag}, which is not tainted: ${fmtNames(healthcheckFailures.map((f) => f.agent))}`,
    });
  }

  let selfHealth = { skipped: 'brief' };
  if (!brief) {
    selfHealth = await attempt(errors, 'GetMetricData (self-health)', () => readSelfHealth(clients.cw, resources, now), null);
    if (!selfHealth) {
      const last = errors[errors.length - 1];
      selfHealth = { error: String((last && last.error && last.error.message) || 'read failed') };
    }
  }

  let liveBindingAgents = 0;
  for (const rows of bindingsByAgent.values()) if (rows.some(isLive)) liveBindingAgents += 1;

  const report = {
    name: ctx.name,
    release: {
      present: Boolean(releaseItem),
      tag: liveTag,
      publishedAt: (releaseItem && releaseItem.publishedAt) || null,
      publishedBy: (releaseItem && releaseItem.publishedBy) || null,
      imageDigest: (releaseItem && releaseItem.imageDigest) || null,
      tainted: Boolean(activeTaint),
    },
    image,
    scope: { filtered: Boolean(filter), fleetAgents: fleetAgents.length },
    coverage,
    liveBindingAgents,
    healthcheckFailures,
    tainted,
    rollbackTargets: targets,
    drift: driftFindings,
    selfHealth,
    readFailures: errors.map((e) => ({ what: e.what, error: String((e.error && e.error.message) || e.error) })),
    note: 'status reports what the REGISTRY knows. A runtime created at AWS whose write was lost is '
      + 'invisible here (agentcore-client.js:528-533); `archie runtime gc --reconcile-aws` closes that gap.',
  };

  // Answer FIRST, then set the exit code. A drifted or partially-read fleet is exactly when the
  // operator most needs the report, and throwing before printing would hand them an exit code and
  // nothing to act on. In --json the envelope carries both (output.js buffers `result` until finish).
  out.answer(ctx.json ? report : render(report));

  if (errors.length) {
    throw new CliError(`status: ${plural(errors.length, 'backing read')} failed — the report above is incomplete`, {
      code: EXIT.FAILED,
      cause: errors[0].error,
      // --brief is the documented way past a CloudWatch permissions gap: it skips GetMetricData
      // entirely, so the DynamoDB half of the report still exits 0.
      detail: errors.map((e) => e.what).join('; '),
    });
  }
  if (driftFindings.length) {
    throw drift(`status: ${plural(driftFindings.length, 'drift finding')}: ${driftFindings.map((d) => d.kind).join(', ')}`, {
      detail: 'exit 7 is a REPORT, not a failure — nothing was mutated and re-running is free.',
    });
  }
  // `missing` bindings alone are exit 0, on purpose (reference §2.2).
  return undefined;
}

module.exports = {
  status,
  // Exported for status.test.js: the pure halves are tested directly, with no client at all.
  parseAgentFilter,
  summariseBindings,
  summariseImagePointers,
  rollbackTargets,
  fleetMetricSpecs,
  taintOf,
  render,
};

'use strict';

// THE BINDINGS — `RUNTIME#<agent> / GEN#<runtimeName>`, one row per agent per spec.
//
// This is the table the turn path reads. The dispatcher derives the runtime name from (agent, image,
// its own env) and does ONE GetItem; archie stages under the same derived name, so a staged row is a
// hit rather than a create-and-adopt. That agreement is the whole point — see lib/spec.js.
//
// A row's `image` says which image that runtime runs, so "which bindings belong to tag T" is a field
// comparison and not a join through a second identity. That is the property the generation id used
// to provide and the reason it is no longer needed.

const {
  runtimeIdOf, PK_PREFIX, SK_PREFIX, nameFromSk,
} = require('../../slack-dispatcher/runtime-registry');

/** `…/repo:content-abc` → `content-abc`; null when the row records no image. */
function tagOf(row) {
  const uri = row && row.image;
  if (typeof uri !== 'string') return null;
  const at = uri.lastIndexOf(':');
  return at > 0 && at < uri.length - 1 ? uri.slice(at + 1) : null;
}

/**
 * Every binding row in the table, in one Scan.
 *
 * ONE SCAN, not a Query per agent. The alternative — read the agent roster from the routing GSI then
 * Query each one — is ~208 round trips against a table the live dispatcher reads on every turn. This
 * is a single pass on an operator-run command.
 *
 * NO ProjectionExpression, deliberately: staging owns the binding's fields, and a projection written
 * here would silently hide any field it adds.
 */
async function scanBindings(aws, ctx) {
  const { ScanCommand } = require('@aws-sdk/lib-dynamodb');
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await aws.doc().send(new ScanCommand({
      TableName: ctx.resources.configTable,
      FilterExpression: 'begins_with(#pk, :p)',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':p': PK_PREFIX },
      ExclusiveStartKey,
    }));
    for (const item of r.Items || []) {
      const sk = String(item.sk || '');
      if (!sk.startsWith(SK_PREFIX)) continue;
      out.push({
        ...item,
        agent: item.agent || String(item.pk).slice(PK_PREFIX.length),
        // The key IS the runtime name. `runtimeName` is also written as an attribute, and it wins:
        // rows written by the generation-keyed shape (2026-08-15/16, now migrated) carry a key that
        // is not a name, and reading the attribute first is what makes them legible rather than
        // mistaking a `gen-…` id for a runtime.
        runtimeName: item.runtimeName || nameFromSk(sk),
        tag: tagOf(item),
        runtimeId: runtimeIdOf(item),
      });
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/** Coverage/health/liveness counts for one tag's bindings. */
function bindingStats(rows) {
  const stats = { bound: rows.length, live: 0, reaped: 0, ok: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    if (r.arn) stats.live += 1; else stats.reaped += 1;
    const h = r.healthcheck || 'pending';
    if (h === 'ok') stats.ok += 1;
    else if (h === 'failed') stats.failed += 1;
    else stats.pending += 1;
  }
  return stats;
}

/** rows grouped by the tag their image names. Rows with no image land under `null`. */
function byTag(rows) {
  const map = new Map();
  for (const r of rows) {
    const key = r.tag || null;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/**
 * The STATE column.
 *
 * The rule that has to hold: a reaped tag is NEVER shown as a rollback target. Its rows survive as
 * history but the reaper REMOVEs the arn, so publishing one "would invoke a corpse". Taint and
 * liveness are shown ALONGSIDE each other rather than instead: a tag tainted after it went live is
 * the situation you most need to see, and a state machine that picked one label would hide exactly
 * that.
 */
function stateOf({ tag, stats, publishedTag, taint }) {
  const parts = [];
  const live = Boolean(publishedTag && publishedTag === tag);
  if (live) parts.push('LIVE');
  if (taint) parts.push(`TAINTED — ${taint.reason || 'no reason recorded'}`);
  if (stats.bound === 0) parts.push('not staged');
  else if (stats.live === 0) parts.push('reaped — NOT a rollback target');
  else if (!live) parts.push('rollback target');
  // `is*` prefixes, deliberately: a row spreads these flags alongside bindingStats(), where `live`
  // and `reaped` are COUNTS. Sharing the names silently overwrote the counts with booleans and
  // printed `BOUND true` — a collision a JSON consumer would inherit without noticing.
  return {
    state: parts.join(' · '),
    isLive: live,
    isTainted: Boolean(taint),
    isRollbackTarget: Boolean(!live && !taint && stats.live > 0),
    isReaped: stats.bound > 0 && stats.live === 0,
  };
}

module.exports = { scanBindings, bindingStats, byTag, stateOf, tagOf };

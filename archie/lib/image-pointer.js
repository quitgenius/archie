'use strict';

// THE POINTER. One item decides what the whole fleet runs, and this module is the only thing that
// reads or writes it.
//
// ── WHY THERE IS ONLY ONE ────────────────────────────────────────────────────────────────────────
//
// There used to be two. `archie release set` wrote `CONFIG#release / ACTIVE` (a generation id); the
// dispatcher read `CONFIG#image / FLEET` (an image tag). Nothing reconciled them, and on 2026-08-16
// they disagreed for an hour: the release said `content-fe8cc807194278a2`, healthchecked, coverage
// 1/1/1/1, published 02:44:35 — FLEET still said `content-5ecd65323eb4bd13` from 01:43. Every turn
// ran the old image. Nothing errored, `archie status` reported a healthy fleet, and a fix that had
// been built, staged, healthchecked and published was simply unreachable.
//
// The second pointer was not a mistake of implementation, it was a mistake of modelling: it named a
// GENERATION, an opaque id minted per staging run, for something that already had a canonical name.
//
// ── THE IMAGE TAG IS THE RELEASE ID ──────────────────────────────────────────────────────────────
//
// A tag is a content digest of that image's own declared inputs (ARCHIE.md, "you do not set tags").
// `content-fe8cc807194278a2` identifies a build at least as precisely as `gen-60425ef16488e0d8` did,
// and unlike a generation id it is DERIVABLE from the tree and reproducible from a commit. So a
// generation id was a second, opaque name for a thing that already had one — and every property the
// generation model provided is recoverable from the tag:
//
//   which runtime is an agent's live one?   `oc_<agent>_<fingerprint(spec(agent, tag))>`
//   is this generation staged?              does that name have a binding row?
//   did it pass its healthcheck?            `healthcheck` on that row
//   what are the rollback targets?          bindings whose image is not the published tag
//   when did we cut over, and who?          CloudTrail + OTEL, not a table we maintain
//
// The last line is the deliberate one. `CONFIG#release-history` existed to answer it and could only
// ever be a partial, self-reported log; CloudTrail records the actual write with the actual caller.
//
// ── TAINT ────────────────────────────────────────────────────────────────────────────────────────
//
// Taint moves with the identity: it is a property of a TAG now, which is strictly stronger than
// tainting a generation. A generation id was minted per staging run, so the same broken image could
// be re-staged under a fresh id and released. A tag cannot: the digest is the build, so "this build
// may never ship" is a statement the identity itself enforces. Fixing the image changes the tag by
// construction, which is exactly the documented recovery ("fix the image and cut a new one").
//
// There is no untaint, no --force, no --clear (§5.2). The write is one-way on purpose: its whole
// purpose is surviving an operator who retries in a different shell.

const IMAGE_PK = 'CONFIG#image';
const FLEET_SK = 'FLEET';
const TAINT_PREFIX = 'TAINT#';

/** Sort key for a tag's taint record. */
const taintSk = (tag) => `${TAINT_PREFIX}${tag}`;
/** Inverse of taintSk; null for a sort key that is not a taint record. */
const tagFromTaintSk = (sk) => (typeof sk === 'string' && sk.startsWith(TAINT_PREFIX) ? sk.slice(TAINT_PREFIX.length) : null);

/**
 * A published pointer is only usable if it names a real image. Anything else — missing item, wrong
 * type, empty string — is ABSENT, which fails closed everywhere rather than provisioning an
 * unpullable runtime. Same rule the dispatcher applies (`image-source.js:readImageItem`), and
 * deliberately not shared with it: this module is the CLI's, and a shared parser would make the two
 * halves of the system share a failure.
 */
function readPointerItem(item) {
  if (!item || typeof item !== 'object') return null;
  const tag = typeof item.tag === 'string' && item.tag.trim() ? item.tag.trim() : null;
  const uri = typeof item.imageUri === 'string' && item.imageUri.trim() ? item.imageUri.trim() : null;
  if (!tag && !uri) return null;
  return {
    tag,
    imageUri: uri,
    imageDigest: typeof item.imageDigest === 'string' ? item.imageDigest : null,
    publishedAt: typeof item.publishedAt === 'string' ? item.publishedAt : null,
    publishedBy: typeof item.publishedBy === 'string' ? item.publishedBy : null,
  };
}

/**
 * What the fleet runs right now, or null if nothing has ever been published.
 *
 * ConsistentRead, always: a publish followed immediately by a gc must not read the OLD pointer from
 * a stale replica and reap what just went live. This is one small item on a control-plane path — the
 * cost is irrelevant next to that failure.
 */
async function readFleetPointer(doc, docCmds, table) {
  const { GetCommand } = docCmds;
  const r = await doc.send(new GetCommand({
    TableName: table, Key: { pk: IMAGE_PK, sk: FLEET_SK }, ConsistentRead: true,
  }));
  return readPointerItem(r && r.Item);
}

/** The taint record for a tag, or null. ConsistentRead for the same reason as the pointer. */
async function readTaint(doc, docCmds, table, tag) {
  const { GetCommand } = docCmds;
  const r = await doc.send(new GetCommand({
    TableName: table, Key: { pk: IMAGE_PK, sk: taintSk(tag) }, ConsistentRead: true,
  }));
  const it = r && r.Item;
  if (!it) return null;
  return { tag, reason: it.reason || null, taintedBy: it.taintedBy || null, taintedAt: it.taintedAt || null };
}

/** Every tainted tag. A handful of items; the caller renders them. */
async function listTaints(doc, docCmds, table) {
  const { QueryCommand } = docCmds;
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new QueryCommand({
      TableName: table,
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': IMAGE_PK, ':sk': TAINT_PREFIX },
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) {
      const tag = tagFromTaintSk(it.sk);
      if (tag) out.push({ tag, reason: it.reason || null, taintedBy: it.taintedBy || null, taintedAt: it.taintedAt || null });
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

/**
 * Mark a tag permanently unpublishable.
 *
 * `if_not_exists` on every field: a second taint of the same tag keeps the FIRST reason and the
 * first operator. The earliest recorded reason is the one closest to the failure, and an accidental
 * re-taint must not overwrite the diagnosis with "re-tainting to be safe".
 */
async function taintTag(doc, docCmds, table, tag, { reason, by, at }) {
  const { UpdateCommand } = docCmds;
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { pk: IMAGE_PK, sk: taintSk(tag) },
    UpdateExpression: 'SET #reason = if_not_exists(#reason, :reason), #by = if_not_exists(#by, :by), '
      + '#at = if_not_exists(#at, :at)',
    // Every name aliased without exception — the reserved-word list is ~570 long and `by` is on it.
    ExpressionAttributeNames: { '#reason': 'reason', '#by': 'taintedBy', '#at': 'taintedAt' },
    ExpressionAttributeValues: { ':reason': reason || null, ':by': by || null, ':at': at },
  }));
}

/**
 * Move the fleet. THE ONLY WRITE THAT MOVES TRAFFIC.
 *
 * Conditional on the tag not being tainted is NOT expressible here — taint is a different item — so
 * the caller checks it and refuses. That split is deliberate: a condition expression would fail with
 * ConditionalCheckFailedException and no reason, and the whole point of taint is that the operator
 * is told WHY, by whom, and when.
 */
async function publishFleetPointer(doc, docCmds, table, { tag, imageUri, imageDigest, by, at }) {
  const { UpdateCommand } = docCmds;
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: { pk: IMAGE_PK, sk: FLEET_SK },
    UpdateExpression: 'SET #tag = :tag, #uri = :uri, #digest = :digest, #by = :by, #at = :at',
    ExpressionAttributeNames: {
      '#tag': 'tag', '#uri': 'imageUri', '#digest': 'imageDigest', '#by': 'publishedBy', '#at': 'publishedAt',
    },
    ExpressionAttributeValues: {
      ':tag': tag, ':uri': imageUri || null, ':digest': imageDigest || null, ':by': by || null, ':at': at,
    },
  }));
}

module.exports = {
  IMAGE_PK, FLEET_SK, TAINT_PREFIX,
  taintSk, tagFromTaintSk, readPointerItem,
  readFleetPointer, readTaint, listTaints, taintTag, publishFleetPointer,
};

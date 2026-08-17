'use strict';

// Conversation metadata in DynamoDB — the durable replacement for /efs/conversations.json.
//
// WHY THIS EXISTS. The EFS file is ONE file holding EVERY agent's conversations, read whole at
// boot and written whole on a debounce and on SIGTERM. That shape has three failure modes we have
// now seen or proven:
//   * `load()` cannot distinguish "absent" from "unreadable" from "filesystem not mounted", and a
//     failed load resets to {} — which a later write persists over the real data, fleet-wide.
//   * the shutdown flush sets dirty unconditionally, so an ordinary clean shutdown is enough.
//   * a failed WRITE is swallowed entirely (conversations.js:53), so the sandbox file went a whole
//     day and six deploys without its mtime moving and nothing said so.
// Per-item writes remove the class rather than guarding it: one agent's failure cannot erase
// another's, and there is no whole-file rewrite to get wrong.
//
// ── KEY SHAPE ───────────────────────────────────────────────────────────────────────────────────
//   pk = CONV#<agentId>          sk = THREAD#<threadTs>
//
// NOT `AGENT#<id>` with a CONV# sort key, and this is load-bearing. Every AgentCore runtime role
// holds dynamodb:PutItem/UpdateItem on this table so it can persist its own AGENT#<id>/SEED, and
// IAM has NO sort-key condition key — so a write scope of LeadingKeys AGENT#* cannot exclude a sort
// key. Under AGENT#<id> an agent could rewrite or delete its own conversation history. This is
// exactly why GRANT#<id> is its own partition rather than AGENT#<id>/GRANT#*; the same reasoning
// applies here and the same mistake is available.
//
// threadTs is a fixed-width epoch string ("1780993922.012579"), so lexicographic order IS
// chronological order for the next few centuries. A Query with ScanIndexForward=false therefore
// returns most-recent-first with no in-memory sort. Pinning still needs client-side ordering, but
// the app caps an agent at 100 conversations so that is bounded and cheap.
//
// ── WHY `conv` IS A MAP AND NOT A JSON STRING ───────────────────────────────────────────────────
//
// Every other item in this table (CONFIG, GRANT, MARKETPLACE, SEED, CONNECTOR, RUNTIME) stores its
// payload as a JSON string in `data`, and this one deliberately does not. The reason is that a
// conversation has TWO independent writers touching disjoint fields:
//
//   message activity  ->  title, lastActivity, messageCount, recentMessages
//   the human's UI    ->  pinned, pinOrder, recentOrder      (togglePin / moveInList / reset)
//
// DynamoDB cannot address inside a JSON string, so with `data` the only available write is a
// whole-item replace — and a whole-item replace from either writer silently discards the other's
// work. Live proof this is not hypothetical: prod holds 38 pins and 298 frozen order rows, and the
// UI writers never touch `lastActivity`, so no timestamp condition can even order the two against
// each other. A Map lets each writer SET exactly the fields it owns.
//
// `lastActivity` is ALSO promoted to a top-level attribute, because the idempotency condition below
// compares it server-side and a condition cannot reach into a nested map element that may not exist.

const TABLE_DEFAULT = process.env.AGENT_CONFIG_TABLE || 'archie-agent-config';

const convPk = (agentId) => `CONV#${agentId}`;
const convSk = (threadTs) => `THREAD#${threadTs}`;

/**
 * The write condition that makes hydration idempotent AND safe to run while the app is live.
 *
 * Three requirements pull in different directions:
 *   1. Re-running hydration must converge, not duplicate           -> not a blind append
 *   2. Re-running must not undo work already done                  -> not attribute_not_exists alone
 *   3. Hydration must NEVER overwrite a NEWER *or equal* live write -> not an unconditional Put
 *
 * (3) is why this is `<` and not `<=`. The UI writers — togglePin, moveInList, resetRecentOrder —
 * do not change `lastActivity`, so a live pin toggle leaves the timestamp EQUAL to the snapshot's.
 * Under `<=` the equal case passed the condition and a hydration re-run silently reverted the pin.
 * `<` costs nothing in convergence: a first write still lands via attribute_not_exists, and
 * re-writing an identical snapshot is a no-op either way.
 *
 * A ConditionalCheckFailedException here is a SUCCESS — it means something newer was already there.
 */
const IDEMPOTENT_CONDITION = 'attribute_not_exists(pk) OR lastActivity < :incoming';

/** Build the item we store for one conversation. */
function toItem(agentId, threadTs, conv) {
  if (!agentId || !threadTs) throw new Error('toItem: agentId and threadTs required');
  const lastActivity = conv && conv.lastActivity;
  if (!lastActivity) {
    // Every one of the 3,987 conversations in the live prod file has this field. Its absence means
    // the input is not what we think it is, and guessing a value would make the idempotency
    // condition meaningless — so refuse rather than invent one.
    throw new Error(`toItem: ${agentId}/${threadTs} has no lastActivity — cannot order this write`);
  }
  return {
    pk: convPk(agentId),
    sk: convSk(threadTs),
    agentId,
    threadTs,
    lastActivity,              // promoted: the idempotency condition compares this server-side
    conv: { ...conv },
  };
}

/**
 * Write one WHOLE conversation, newest-wins. Returns 'written' or 'skipped-older'.
 *
 * This is HYDRATION's primitive, not the app's: it restores a complete snapshot into a slot that is
 * absent or strictly older. Live edits must use updateConversation, which touches only the fields
 * their writer owns. Never throws on the conditional failure — that outcome is the point.
 */
async function putConversation(doc, cmds, { table = TABLE_DEFAULT, agentId, threadTs, conv }) {
  const item = toItem(agentId, threadTs, conv);
  try {
    await doc.send(new cmds.PutCommand({
      TableName: table,
      Item: item,
      ConditionExpression: IDEMPOTENT_CONDITION,
      ExpressionAttributeValues: { ':incoming': item.lastActivity },
    }));
    return 'written';
  } catch (err) {
    if (isConditionalFailure(err)) return 'skipped-older';
    throw err;                 // anything else is a real failure and must not be swallowed
  }
}

function isConditionalFailure(err) {
  return !!err && (err.name === 'ConditionalCheckFailedException' || err.code === 'ConditionalCheckFailedException');
}

/**
 * Update ONLY the fields a writer owns. Returns 'updated' or 'created'.
 *
 * `set` is a plain object of conversation fields to write; `remove` is a list of field names to
 * delete (togglePin drops recentOrder; resetRecentOrder drops it across an agent). Fields not named
 * are not touched, which is the entire point — a title re-summarisation must not disturb a pin, and
 * a pin must not roll back a message count.
 *
 * ONLY the named fields are written. This matters for the 18 prod pins that pre-date the reorder
 * feature and carry NO pinOrder: the sort places unordered pins after ordered ones, so quietly
 * materialising a pinOrder here would silently move 18 real conversations in 12 people's sidebars.
 *
 * `conv` (the full in-memory object) is required as the fallback: an update for a conversation not
 * yet in DynamoDB would otherwise create a FRAGMENT — an item holding a title and nothing else,
 * which reads back as a conversation with no channel and no timestamps. Conditioned on
 * attribute_exists, and on failure we write the whole object we already have in memory.
 */
async function updateConversation(doc, cmds, {
  table = TABLE_DEFAULT, agentId, threadTs, set = {}, remove = [], conv,
}) {
  if (!agentId || !threadTs) throw new Error('updateConversation: agentId and threadTs required');
  const setKeys = Object.keys(set);
  if (!setKeys.length && !remove.length) return 'updated';   // nothing to do

  const names = { '#c': 'conv' };
  const values = {};
  const sets = [];
  const removes = [];

  setKeys.forEach((field, i) => {
    names[`#s${i}`] = field;
    values[`:s${i}`] = set[field];
    sets.push(`#c.#s${i} = :s${i}`);
  });
  remove.forEach((field, i) => {
    names[`#r${i}`] = field;
    removes.push(`#c.#r${i}`);
  });

  // Keep the promoted copy in step. It is the only attribute a condition can compare, so letting it
  // drift from conv.lastActivity would quietly break every newest-wins decision made against it.
  if (Object.prototype.hasOwnProperty.call(set, 'lastActivity')) {
    names['#la'] = 'lastActivity';
    values[':la'] = set.lastActivity;
    sets.push('#la = :la');
  }

  const expr = [sets.length ? `SET ${sets.join(', ')}` : '', removes.length ? `REMOVE ${removes.join(', ')}` : '']
    .filter(Boolean).join(' ');

  try {
    await doc.send(new cmds.UpdateCommand({
      TableName: table,
      Key: { pk: convPk(agentId), sk: convSk(threadTs) },
      UpdateExpression: expr,
      ConditionExpression: 'attribute_exists(pk)',
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    }));
    return 'updated';
  } catch (err) {
    if (!isConditionalFailure(err)) throw err;
    if (!conv) {
      throw new Error(
        `updateConversation: ${agentId}/${threadTs} is not in DynamoDB and no full conversation was `
        + 'passed to create it — refusing to write a fragment',
      );
    }
    await doc.send(new cmds.PutCommand({ TableName: table, Item: toItem(agentId, threadTs, conv) }));
    return 'created';
  }
}

/**
 * Delete one conversation. Unconditional and therefore idempotent.
 *
 * prune() drops the oldest unpinned conversations once an agent passes 100, and that is LIVE: 12
 * prod agents sit at the cap and one of them turns over 46 conversations a week. Without this the
 * table only ever grows, and after cutover people would see threads reappear that the cap retired.
 */
async function deleteConversation(doc, cmds, { table = TABLE_DEFAULT, agentId, threadTs }) {
  if (!agentId || !threadTs) throw new Error('deleteConversation: agentId and threadTs required');
  await doc.send(new cmds.DeleteCommand({
    TableName: table,
    Key: { pk: convPk(agentId), sk: convSk(threadTs) },
  }));
  return 'deleted';
}

/**
 * Read one agent's conversations, most-recent-first.
 *
 * Deliberately a Query on ONE partition rather than a table read: an agent's conversations cannot
 * be affected by, or expose, another agent's. `limit` defaults to the app's own cap.
 */
async function listConversations(doc, cmds, { table = TABLE_DEFAULT, agentId, limit = 100 }) {
  const out = [];
  let ExclusiveStartKey;
  do {
    const r = await doc.send(new cmds.QueryCommand({
      TableName: table,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
      ExpressionAttributeValues: { ':pk': convPk(agentId), ':p': 'THREAD#' },
      ScanIndexForward: false,       // threadTs is fixed-width epoch, so this is newest-first
      Limit: Math.min(limit, 100),
      ExclusiveStartKey,
    }));
    for (const it of r.Items || []) {
      out.push({ threadTs: it.threadTs, ...(it.conv || {}) });
      if (out.length >= limit) return out;
    }
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return out;
}

module.exports = {
  TABLE_DEFAULT, convPk, convSk, toItem,
  putConversation, updateConversation, deleteConversation, listConversations,
  IDEMPOTENT_CONDITION,
};

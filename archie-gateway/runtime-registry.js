'use strict';

// The runtime registry — DynamoDB replacement for the in-process `_arnCache`.
//
// WHY IT MOVED OUT OF PROCESS. The old cache was a `Map`, so every dispatcher restart forgot the whole
// fleet's ARNs and the next turn per agent had to rediscover them. Rediscovery means
// `findRuntimeByName`, which paginates `ListAgentRuntimes` — and List is capped at 25/s,
// NON-ADJUSTABLE, with no name filter and no get-by-name API (GetAgentRuntime takes an id only). On the
// create path the runtime does not exist yet, so the scan cannot early-exit and reads EVERY page. A
// fleet-wide roll therefore scaled as agents x pages against a hard 25/s ceiling.
//
// WHAT IS AUTHORITATIVE, AND WHAT IS NOT. This table is authoritative for `name -> id/arn`. It is NOT
// authoritative for LIVENESS. A row asserts "a runtime with this exact spec fingerprint was created and
// verified"; the invoke is what proves it still exists, and an invoke failure is the invalidation. That
// boundary matters because a durable cache removes the accidental self-healing the in-process Map had
// for free — if this table could brick an agent by remembering a deleted runtime, it would be a
// downgrade.
//
// NO STATUS, NO LEASE, DELIBERATELY. An earlier draft had status=CREATING with a lease so concurrent
// provisions could not duplicate. It is unnecessary: AgentCore's runtime-name uniqueness IS the mutex.
// Two dispatchers racing both call CreateAgentRuntime; one wins and the other gets ConflictException,
// which agentcore-provisioning already classifies as 'adopt'. Deferring to the resource namespace
// instead of our own lease removes the entire lease-expiry problem (no takeover rule, no heartbeat, and
// no 10-minute block on a generation when a task dies mid-create). It also handles the worst case
// BETTER: a create that succeeds at AWS and then crashes before the write leaves an orphan runtime that
// the next request for that generation adopts, rather than a stale CREATING row that blocks it.
//
// WRITES ARE UpdateItem, NEVER PutItem. Not a style choice — the dispatcher's IAM policy grants
// UpdateItem only, on purpose ("granting PutItem would allow wholesale replacement of an item rather
// than field updates"), scoped by LeadingKeys. Every write here is therefore a field-level SET/REMOVE.
//
// ROWS ARE NEVER DELETED. Superseded generations stay as history, which is what makes an image
// ROLLBACK cheap: the older generation's row still holds its ARN, so a rollback is a GetItem hit and
// zero provisioning where it used to be a full cold boot. When the reaper deletes a runtime it REMOVEs
// the arn and stamps reapedAt, so the row survives as history but no longer claims a live runtime —
// without that, a rollback to a reaped generation would invoke a corpse, burn a failed turn, and only
// then reprovision.

const PK_PREFIX = 'RUNTIME#';
const SK_PREFIX = 'GEN#';

const pkFor = (agent) => `${PK_PREFIX}${agent}`;
const skFor = (runtimeName) => `${SK_PREFIX}${runtimeName}`;

/**
 * The runtime id for a row, deriving it from the ARN when the field is absent.
 *
 * An AgentCore runtime ARN ends `:runtime/<agentRuntimeName>-<suffix>`, and that last path segment IS
 * the agentRuntimeId — agentcore-provisioning already reconstructs ARNs from ids that way.
 *
 * WHY THE FALLBACK EXISTS: ensureAgentEnvironment did not return runtimeId at first, so early rows
 * recorded null. Everything that acts on a runtime (GetAgentRuntime, DeleteAgentRuntime) needs an id,
 * so the reaper silently skipped every one of those rows and superseded generations piled up against
 * the account's 1000-runtime quota. Deriving keeps those rows actionable with no backfill, and keeps
 * the reaper working if any future writer forgets the field again.
 */
const runtimeIdOf = (row) => {
  if (!row) return null;
  if (row.runtimeId) return row.runtimeId;
  const arn = row.arn;
  if (typeof arn !== 'string' || !arn.includes('/')) return null;
  return arn.split('/').pop() || null;
};
/** Inverse of skFor. Returns null for a sort key that is not a generation row. */
const nameFromSk = (sk) => (typeof sk === 'string' && sk.startsWith(SK_PREFIX) ? sk.slice(SK_PREFIX.length) : null);

/**
 * @param deps.tableName  the single config table (AGENT_CONFIG_TABLE).
 * @param deps.doc        () => DynamoDBDocumentClient — a GETTER so the client stays lazy and is
 *                        injectable in tests without constructing an SDK client.
 * @param deps.now        () => Date, for deterministic timestamps in tests.
 * @param deps.logger     pino-shaped.
 */
function createRuntimeRegistry({ tableName, doc, now = () => new Date(), logger } = {}) {
  function cmds() {
    return require('@aws-sdk/lib-dynamodb');
  }

  /**
   * The generation row for this agent+name, or null.
   *
   * ConsistentRead: a turn that has just provisioned must not read its own write as absent and
   * provision a second time. The extra cost is one request unit on a ~200-byte item.
   */
  async function get(agent, runtimeName) {
    const { GetCommand } = cmds();
    const r = await doc().send(new GetCommand({
      TableName: tableName,
      Key: { pk: pkFor(agent), sk: skFor(runtimeName) },
      ConsistentRead: true,
    }));
    return r.Item || null;
  }

  /** Every generation row this agent has ever had. Used by the reaper instead of a fleet-wide List. */
  async function listGenerations(agent) {
    const { QueryCommand } = cmds();
    const out = [];
    let ExclusiveStartKey;
    do {
      const r = await doc().send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :sk)',
        ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
        ExpressionAttributeValues: { ':pk': pkFor(agent), ':sk': SK_PREFIX },
        ExclusiveStartKey,
      }));
      for (const item of r.Items || []) {
        const runtimeName = nameFromSk(item.sk);
        if (runtimeName) out.push({ ...item, runtimeName });
      }
      ExclusiveStartKey = r.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  /**
   * Record a live runtime. Called ONLY after the runtime is verified READY — the row's existence is
   * the assertion, so writing it earlier would make the table claim something unproven.
   *
   * `createdAt` uses if_not_exists so a reprovision of the same generation (same spec, so same name,
   * so same row) keeps the ORIGINAL creation time and the row reads as history rather than as new.
   * reapedAt is REMOVEd because a previously-reaped generation that is provisioned again is live.
   */
  async function record(agent, runtimeName, { arn, runtimeId } = {}) {
    if (!arn) throw new Error('runtime-registry.record requires an arn');
    const { UpdateCommand } = cmds();
    const ts = now().toISOString();
    await doc().send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: pkFor(agent), sk: skFor(runtimeName) },
      UpdateExpression: 'SET #arn = :arn, #runtimeId = :id, #agent = :agent, #updatedAt = :ts, '
        + '#createdAt = if_not_exists(#createdAt, :ts) REMOVE #reapedAt',
      // EVERY attribute name is aliased, without exception. `agent` is a DynamoDB RESERVED KEYWORD, and
      // leaving it bare threw "Invalid UpdateExpression: Attribute name is a reserved keyword" on every
      // single provision — i.e. it broke every turn for every agent (live, 2026-08-13). The reserved list
      // is ~570 words long and includes plenty of innocuous-looking ones, so "alias only what looks
      // risky" is not a strategy. Alias everything and the question never has to be asked.
      ExpressionAttributeNames: {
        '#arn': 'arn',
        '#runtimeId': 'runtimeId',
        '#agent': 'agent',
        '#updatedAt': 'updatedAt',
        '#createdAt': 'createdAt',
        '#reapedAt': 'reapedAt',
      },
      ExpressionAttributeValues: { ':arn': arn, ':id': runtimeId ?? null, ':agent': agent, ':ts': ts },
    }));
    logger?.info?.({ agent, runtime: runtimeName, runtimeId }, 'runtime registry: recorded');
  }

  /**
   * Drop the liveness claim for a generation whose runtime is gone, but ONLY if the row still points at
   * the ARN the caller found dead.
   *
   * The condition is the whole point: between the failed invoke and this write, another turn may have
   * reprovisioned the same generation and written a NEW arn. An unconditional remove would silently
   * discard that fresh, working runtime and force yet another cold provision.
   *
   * Returns true if the row was cleared, false if it had already moved on.
   */
  async function clearArn(agent, runtimeName, arn) {
    const { UpdateCommand } = cmds();
    try {
      await doc().send(new UpdateCommand({
        TableName: tableName,
        Key: { pk: pkFor(agent), sk: skFor(runtimeName) },
        UpdateExpression: 'REMOVE #arn, #runtimeId SET #clearedAt = :ts',
        ConditionExpression: '#arn = :arn',
        ExpressionAttributeNames: { '#arn': 'arn', '#runtimeId': 'runtimeId', '#clearedAt': 'clearedAt' },
        ExpressionAttributeValues: { ':arn': arn, ':ts': now().toISOString() },
      }));
      logger?.warn?.({ agent, runtime: runtimeName, arn }, 'runtime registry: cleared a dead runtime');
      return true;
    } catch (err) {
      if (err?.name === 'ConditionalCheckFailedException') {
        logger?.info?.({ agent, runtime: runtimeName, arn }, 'runtime registry: arn already superseded — nothing cleared');
        return false;
      }
      throw err;
    }
  }

  /**
   * Find the generation row holding `arn` and clear it.
   *
   * Evict by ARN, not by agent: the row key encodes the image generation, so an agent has one row per
   * generation and clearing "the agent's" row would be ambiguous. The invoke path knows the ARN it
   * failed on but not the runtime name, and this Query (a handful of rows for one agent, on an error
   * path only) is cheaper than threading the name through every caller.
   */
  async function clearByArn(agent, arn) {
    const rows = await listGenerations(agent);
    const hit = rows.find((r) => r.arn === arn);
    if (!hit) return false;
    return clearArn(agent, hit.runtimeName, arn);
  }

  /**
   * The reaper deleted this generation's runtime. Keep the row as history; drop the liveness claim.
   * Unconditional, unlike clearArn: the reaper has just deleted that specific runtime id, so the row
   * must not keep advertising it even if the arn changed underneath (which would itself be a bug worth
   * seeing as a missing arn rather than a working one).
   */
  async function markReaped(agent, runtimeName) {
    const { UpdateCommand } = cmds();
    await doc().send(new UpdateCommand({
      TableName: tableName,
      Key: { pk: pkFor(agent), sk: skFor(runtimeName) },
      UpdateExpression: 'REMOVE #arn, #runtimeId SET #reapedAt = :ts',
      ExpressionAttributeNames: { '#arn': 'arn', '#runtimeId': 'runtimeId', '#reapedAt': 'reapedAt' },
      ExpressionAttributeValues: { ':ts': now().toISOString() },
    }));
  }

  return { get, listGenerations, record, clearArn, clearByArn, markReaped };
}

/**
 * In-memory registry with the SAME SEMANTICS, for tests of code that merely depends on the registry
 * (agentcore-client) rather than on its DynamoDB encoding.
 *
 * Deliberately a semantic double rather than a fake DynamoDB client: a fake `doc` would have to
 * interpret UpdateExpression strings, so it would test a hand-written expression interpreter instead of
 * the registry. The real commands are covered directly in runtime-registry.test.js — that split is what
 * keeps this double honest, and the conditional behaviour of clearArn is reproduced here precisely
 * because callers depend on it (an unconditional clear would discard a freshly provisioned runtime).
 */
function createMemoryRuntimeRegistry({ now = () => new Date() } = {}) {
  // Composite key `<agent>SEP<generation>`. NUL rather than a space, so the two halves cannot be
  // confused: with a space, agent "a b" + generation "c" and agent "a" + generation "b c" collide.
  //
  // Written as an ESCAPE, never as a raw NUL byte. A literal NUL makes the whole file `binary` to
  // grep, which silently excluded a sibling file from a repo-wide audit and let a hardcoded metric
  // namespace survive it — see metric-namespace.test.js.
  const rows = new Map();
  const SEP = '\u0000';
  const key = (agent, name) => `${agent}${SEP}${name}`;

  return {
    rows,
    async get(agent, name) { return rows.get(key(agent, name)) || null; },
    async listGenerations(agent) {
      return [...rows.entries()]
        .filter(([k]) => k.startsWith(`${agent}${SEP}`))
        .map(([, v]) => v);
    },
    async record(agent, name, { arn, runtimeId } = {}) {
      if (!arn) throw new Error('runtime-registry.record requires an arn');
      const prev = rows.get(key(agent, name));
      const ts = now().toISOString();
      rows.set(key(agent, name), {
        pk: pkFor(agent), sk: skFor(name), agent, runtimeName: name,
        arn, runtimeId: runtimeId ?? null, updatedAt: ts, createdAt: prev?.createdAt || ts,
      });
    },
    async clearArn(agent, name, arn) {
      const row = rows.get(key(agent, name));
      if (!row || row.arn !== arn) return false;   // the conditional write, reproduced
      delete row.arn; delete row.runtimeId;
      row.clearedAt = now().toISOString();
      return true;
    },
    async clearByArn(agent, arn) {
      for (const [, row] of rows) {
        if (row.agent === agent && row.arn === arn) return this.clearArn(agent, row.runtimeName, arn);
      }
      return false;
    },
    async markReaped(agent, name) {
      const row = rows.get(key(agent, name));
      if (!row) return;
      delete row.arn; delete row.runtimeId;
      row.reapedAt = now().toISOString();
    },
  };
}

module.exports = {
  createRuntimeRegistry, createMemoryRuntimeRegistry, pkFor, skFor, nameFromSk, runtimeIdOf,
  PK_PREFIX, SK_PREFIX,
};

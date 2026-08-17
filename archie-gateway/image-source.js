'use strict';

// Which container image the fleet runs, resolved from DynamoDB instead of the dispatcher's task
// definition.
//
// WHY: AGENTCORE_IMAGE_TAG was a task-def env var, so shipping a new agent image meant registering a
// new dispatcher revision and rolling the ECS service — a dispatcher deploy to change something the
// dispatcher only passes through. Reading it from the config table makes publishing an image a
// single DynamoDB write, picked up by the next message with no deploy at all.
//
// FAIL CLOSED. There is deliberately NO baked fallback image (the AGENTCORE_IMAGE_TAG floor was
// removed 2026-08-11). A floor sounds like resilience and behaves like a silent downgrade: a table
// outage, a missing item or a typo'd publish would quietly run whatever build the dispatcher was
// compiled with, and the only symptom is agents acting like an old release. Provisioning without a
// pointer therefore throws and alarms — the fleet waits for the table rather than guessing.
//
// The repo URI stays, because it is infrastructure (where images live) rather than a version: a
// published bare `tag` needs somewhere to resolve against.
//
// CACHING. Resolution sits on the turn path, so it must never cost a DynamoDB round trip in the
// common case. A short TTL plus a background refresher means reads are served from memory and the
// staleness window is bounded by the TTL, not by how often traffic happens to arrive. The refresher
// is deliberately best-effort: a failed refresh keeps serving the last good value (and logs once),
// because a transient DynamoDB error must not stop the fleet answering messages.
//
// SECURITY. The pointer lives in the CONFIG#image partition, never AGENT#<id> — see the note on
// fleetImageKey in config-resolver/schema.mjs. Whoever writes it chooses the code that runs holding
// each agent's IAM role, so it is deliberately outside the AGENT#* write scope every runtime carries.

const DEFAULT_TTL_MS = 5000;
const DEFAULT_REFRESH_MS = 5000;

// A pointer is only usable if it names a real image. Anything else (missing item, wrong type, empty
// string) is treated as ABSENT, which now fails closed rather than provisioning an unpullable runtime.
function readImageItem(item) {
  if (!item || typeof item !== 'object') return null;
  const uri = item.imageUri || item.uri;
  if (typeof uri === 'string' && uri.trim()) return uri.trim();
  // `tag` alone is resolved against the configured repo, so publishing is "set tag = pi-obs-41"
  // without repeating account/region/repo on every write.
  if (typeof item.tag === 'string' && item.tag.trim()) return { tag: item.tag.trim() };
  return null;
}

/**
 * @param deps.doc        DynamoDBDocumentClient-shaped { send } (lazily supplied).
 * @param deps.table      config table name.
 * @param deps.repoUri    ECR repo a published bare `tag` resolves against (NOT a fallback image).
 * @param deps.ttlMs      how stale a cached answer may be (default 5s).
 * @param deps.logger     pino-shaped.
 */
function createImageSource({ doc, table, repoUri, ttlMs = DEFAULT_TTL_MS, refreshMs = DEFAULT_REFRESH_MS, logger, metrics, now = Date.now } = {}) {
  // key -> { uri, at }. 'FLEET' plus one entry per agent that has an override.
  const cache = new Map();
  let timer = null;
  let warned = false;

  async function readFromTable(sk) {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const res = await doc().send(new GetCommand({
      TableName: table,
      Key: { pk: 'CONFIG#image', sk },
      // Strongly consistent: a publish followed immediately by a message must not serve the old
      // image from a stale replica. This is one small item on a cold path guarded by a cache, so the
      // extra cost is irrelevant next to rolling out the wrong build.
      ConsistentRead: true,
    }));
    return readImageItem(res?.Item);
  }

  function resolveAgainstRepo(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;      // a full URI was published
    if (value.tag) return `${repoUri}:${value.tag}`;  // a bare tag resolves against the repo
    return null;
  }

  async function refresh(sk) {
    try {
      const value = await readFromTable(sk);
      cache.set(sk, { uri: resolveAgainstRepo(value), at: now() });
      warned = false;
      return true;
    } catch (err) {
      // Keep serving the last good value. Warn ONCE per outage, not once per refresh tick.
      if (!warned) {
        warned = true;
        logger?.warn?.({ err: err.message, table, sk }, 'image pointer refresh failed — serving last known image');
      }
      return false;
    }
  }

  /**
   * The image this agent should run. Served from memory when warm; a cold or expired entry is
   * refreshed inline (once).
   *
   * THROWS `ImagePointerMissing` when there is no pointer to serve — no silent fallback. A stale
   * cached value is still preferred over throwing, because "keep running what was last published"
   * is correct during a transient read failure; "run whatever this build shipped with" never is.
   */
  async function resolveImage(agent) {
    const agentSk = `AGENT#${agent}`;
    const fresh = (sk) => {
      const hit = cache.get(sk);
      return hit && (now() - hit.at) < ttlMs ? hit : null;
    };

    // A per-agent override wins, so one agent can be canaried onto a build without moving the fleet.
    if (!fresh(agentSk)) await refresh(agentSk);
    const agentHit = cache.get(agentSk);
    if (agentHit?.uri) return agentHit.uri;

    if (!fresh('FLEET')) await refresh('FLEET');
    const fleet = cache.get('FLEET')?.uri;
    if (fleet) return fleet;

    metrics?.emitImagePointerMissing?.({ agent, table });
    logger?.error?.({ agent, table },
      'no fleet image pointer (DynamoDB CONFIG#image / FLEET) — refusing to provision on a guessed image');
    const err = new Error(`no fleet image published (DynamoDB ${table} CONFIG#image / FLEET). `
      + `Publish one with \`archie image publish <tag>\`.`);
    err.name = 'ImagePointerMissing';
    throw err;
  }

  /**
   * Keep the FLEET entry warm in the background so no turn pays the read. Per-agent overrides stay
   * lazy: refreshing every agent on a timer would be a table scan's worth of reads for a feature
   * almost nobody uses.
   */
  function start() {
    if (timer) return;
    timer = setInterval(() => { refresh('FLEET').catch(() => {}); }, refreshMs);
    if (timer.unref) timer.unref();   // never hold the process open
    refresh('FLEET').catch(() => {});
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { resolveImage, start, stop, _cache: cache, _refresh: refresh };
}

module.exports = { createImageSource, readImageItem };

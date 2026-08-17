// Pi-only AgentCore entrypoint: resolve openclaw.json from DynamoDB (config-resolver
// resolve-boot) -> fetch runtime secrets -> hand off to the adapter. No OpenClaw runtime, no
// gateway. The EFS mount-wait + workspace seed + skill-library sync are DEFERRED to the adapter
// (ensureEfsReady, lazy/post-listen) so a slow (~90s) BYO-EFS mount can't block boot into an
// AgentCore health-check restart loop.

import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { collectInsecureHosts, installScopedTlsBypass } from './tls-scoped.mjs';

const BOOT_EPOCH_MS = Number(process.env.BOOT_EPOCH_MS) || Date.now();
process.env.BOOT_EPOCH_MS = String(BOOT_EPOCH_MS); // share the epoch with the adapter
const phase = (n) => console.log(`BOOT_PHASE name=${n} elapsed_ms=${Date.now() - BOOT_EPOCH_MS}`);
const log = (o) => console.log(JSON.stringify({ component: 'pi-entrypoint', ...o }));

const AGENT_NAME = process.env.AGENT_NAME || 'pi-agent';
const REGION = process.env.AWS_REGION || process.env.REGION || 'us-east-1';
process.env.AWS_REGION = REGION;
const EFS_DIR = process.env.EFS_DIR;
// Workspace layout == OpenClaw's: the agent workspace IS the EFS mount root (flat), so
// MEMORY.md/memory/ + SOUL/AGENTS/IDENTITY live where OpenClaw already wrote them. This
// makes the ECS->AgentCore cutover require NO file movement — Pi reads the existing
// OpenClaw EFS state in place. Sessions stay at EFS_DIR/sessions (matches OpenClaw too).
const WORKSPACE = process.env.PI_WORKSPACE || EFS_DIR || '/tmp/pi-ws';
process.env.PI_WORKSPACE = WORKSPACE; // ensure the adapter uses the same cwd we seed
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/tmp/oc';
const CONFIG_JSON = join(OPENCLAW_HOME, '.openclaw', 'openclaw.json');

async function fetchSecret(secretId, region) {
  const { SecretsManagerClient, GetSecretValueCommand } = await import('@aws-sdk/client-secrets-manager');
  const sm = new SecretsManagerClient({ region: region || REGION });
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  return r.SecretString;
}

/**
 * The agent's Connector pointer: AGENT#<id>/CONNECTOR -> { secretArn, projectId, … }.
 *
 * WHY A POINTER AND NOT JUST THE NAME. Resolution below derives `<base>-<agent>` from AGENT_NAME,
 * which keys a credential on a MUTABLE name. The migration rekeys agents toward channel/DM scope
 * ids, and a rename makes that lookup miss — and a miss is silent: the agent falls back to the
 * shared key and looks fine. The pointer is the durable binding, so it is consulted FIRST and the
 * name becomes the recovery path rather than the identity.
 *
 * It also carries ARNs the name could never produce: an ADOPTED agent points at its legacy secret
 * (`archie-oss-connector-api-key-<agent>`), which `<base>-<agent>` will never spell.
 *
 * Reads through the config-resolver's own aws-sdk (it ships one, and `schema.mjs` already owns the
 * key shape) rather than adding a second copy of the DynamoDB client to this image.
 *
 * NEVER THROWS: a pointer that cannot be read must degrade to name-based resolution, not fail boot.
 */
async function readCredentialPointer() {
  const table = process.env.AGENT_CONFIG_TABLE;
  if (!table || !AGENT_NAME || AGENT_NAME === 'main') return null;
  try {
    const dir = process.env.CONFIG_RESOLVER_DIR || '/app/config-resolver';
    const { createRequire } = await import('node:module');
    const req = createRequire(join(dir, 'entrypoint-resolution.mjs'));
    const { DynamoDBClient } = req('@aws-sdk/client-dynamodb');
    const { DynamoDBDocumentClient, GetCommand } = req('@aws-sdk/lib-dynamodb');
    const { agentCredentialKey } = await import(`file://${join(dir, 'schema.mjs')}`);
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
    const r = await doc.send(new GetCommand({ TableName: table, Key: agentCredentialKey(AGENT_NAME) }));
    if (!r.Item || !r.Item.data) return null;
    const body = JSON.parse(r.Item.data);
    return body && body.secretArn ? body : null;
  } catch (e) {
    log({ level: 'warn', msg: 'connector pointer read failed — falling back to name-based resolution', err: e.message });
    return null;
  }
}

// Fingerprint (not the value) so logs prove a key loaded without leaking it.
const fingerprint = async (s) => {
  const { createHash } = await import('node:crypto');
  return `sha256:${createHash('sha256').update(s).digest('hex').slice(0, 8)} len=${s.length}`;
};

// NB: the BYO-EFS mount-wait + workspace seed moved to the adapter (pi-adapter
// ensureEfsReady), run LAZILY post-listen — a slow (~90s) mount must not block the
// entrypoint/boot, or AgentCore's health check fails the container into a restart loop.

// Resolve openclaw.json from DynamoDB via the config-resolver shipped in the image. The skill
// catalog is sourced from DDB inside resolve-boot; the skill library itself + the per-agent
// workspace seed are deferred to the adapter (ensureEfsReady → EFS, from DDB), since they need
// the (async, ~90s) EFS mount which must not block boot.
async function bootConfig() {
  const RESOLVER = process.env.CONFIG_RESOLVER_DIR || '/usr/local/share/clawdbot/config-resolver';
  mkdirSync(join(OPENCLAW_HOME, '.openclaw'), { recursive: true });
  execFileSync('node', [join(RESOLVER, 'resolve-boot.mjs')], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: {
      ...process.env,
      AGENT_NAME,
      OPENCLAW_CONFIG_FILE: CONFIG_JSON,
      OPENCLAW_HOME,
      AWS_BEDROCK_ENABLED: 'true',
      REGION,
      OPENCLAW_GATEWAY_TOKEN: process.env.OPENCLAW_GATEWAY_TOKEN || 'pi-adapter-unused-token',
      // RESOLVER_SKILLCATALOG_FILE intentionally unset: resolve-boot fetches SKILL#_catalog from DDB.
    },
  });
  process.env.OPENCLAW_JSON = CONFIG_JSON;
  log({ level: 'info', msg: 'openclaw.json resolved from DDB', path: CONFIG_JSON, table: process.env.AGENT_CONFIG_TABLE });
  phase('config_generated');
  // Skills + workspace seed happen in the adapter (ensureEfsReady) once EFS is mounted (§9).
}


// EMF metric from the entrypoint. Same mechanism and namespace as pi-adapter's cold_boot/turn
// metrics: a JSON line on stdout that CloudWatch Logs extracts — no PutMetricData, no IAM, no SDK.
// Dimensions are Agent plus the fleet-wide aggregate, so an alarm can key on either.
function emitConnectorMetric(name, props = {}) {
  try {
    console.log(JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [{ Namespace: 'AgentCore/Pi', Dimensions: [['Agent'], []], Metrics: [{ Name: name, Unit: 'Count' }] }],
      },
      Agent: AGENT_NAME,
      ...props,
      [name]: 1,
      component: 'pi-entrypoint',
      msg: 'connector_state',
    }));
  } catch { /* telemetry must never break boot */ }
}

async function main() {
  phase('entrypoint_start');

  // Scope down TLS-verification-disabling (observability plan §6). The fleet was launched with a
  // process-wide NODE_TLS_REJECT_UNAUTHORIZED=0, which disables cert verification for EVERY
  // outbound TLS connection (Bedrock, Secrets Manager, DynamoDB, Connector, tool fetches …). It's
  // only needed for two known self-signed sandbox endpoints — the dispatcher ALB (cron callback)
  // and the Hindsight API (memory recall). Here we relax cert checking for ONLY those hostnames
  // and then RESTORE global verification, so a self-signed cert on those two hosts no longer
  // blinds the whole runtime. Prod points at real ACM certs, so the allow-list is simply empty
  // there and full verification applies everywhere. Safe to run before any HTTPS call is made.
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    const insecureHosts = collectInsecureHosts(process.env);
    const { hosts } = installScopedTlsBypass(insecureHosts, { logger: console });
    // Restore process-wide verification — from here on only the allow-listed hosts are relaxed.
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    log({ level: 'info', msg: 'restored global TLS verification; relaxed only for allow-listed hosts', hosts });
  }

  // Config comes from DynamoDB; the workspace seed is deferred to the adapter.
  await bootConfig();

  // Connector API key (eager discovery) — fetch from Secrets Manager if configured. The
  // @connector leg sets CONNECTOR_API_KEY_SECRET; without it discovery degrades gracefully.
  //
  // Mirror PROD's per-agent connector model: most prod agents have their OWN connector key
  // (`<base>-<agent>`) = their own project, holding that agent's users' connected (OAuth) accounts.
  // The rest fall back to the shared base key and use the shared project — which in PROD is
  // populated and works. We resolve the agent's own secret FIRST, then fall back. The dispatcher
  // passes only the base; the per-agent suffix lives here because this is the one place that knows
  // AGENT_NAME.
  //
  // The fallback is retained deliberately (2026-08-13): removing it would break every agent
  // that has no key of its own, so it stays until those agents are migrated one at a time. See
  // connector-provisioning-plan.md "Migration pathway".
  const credentialSecretBaseName = process.env.CONNECTOR_API_KEY_SECRET;
  if (credentialSecretBaseName && !process.env.CONNECTOR_API_KEY) {
    const region = process.env.CONNECTOR_API_KEY_SECRET_REGION;
    const perAgent = AGENT_NAME && AGENT_NAME !== 'main' ? `${credentialSecretBaseName}-${AGENT_NAME}` : null;
    // POINTER FIRST, name second, shared last. The pointer is the durable binding; the derived name
    // is the recovery path for an agent that has never been adopted or provisioned. `via` records
    // which one won, so a rename that starts silently costing pointer hits is visible in the logs.
    const pointer = await readCredentialPointer();
    const candidates = [
      ...(pointer ? [{ id: pointer.secretArn, scope: 'per-agent', via: 'pointer' }] : []),
      ...(perAgent ? [{ id: perAgent, scope: 'per-agent', via: 'name' }] : []),
      { id: credentialSecretBaseName, scope: 'shared', via: 'name' },
    ];
    let resolvedScope = null;
    for (const { id: secretId, scope, via } of candidates) {
      try {
        const key = await fetchSecret(secretId, region);
        if (key) {
          process.env.CONNECTOR_API_KEY = key;
          resolvedScope = scope;
          // Parity phrase asserted by the @connector leg (same event as OpenClaw's entrypoint).
          log({ level: 'info', msg: 'CONNECTOR_API_KEY resolved from Secrets Manager', scope: resolvedScope, via, secretId, projectId: (via === 'pointer' && pointer.projectId) || undefined, fp: await fingerprint(key) });
          break;
        }
      } catch (e) {
        // A per-agent secret that does NOT EXIST is expected pre-migration — fall through quietly.
        // Anything else is not: AccessDenied means the secret is there and the derived role cannot
        // read it, which is a provisioning fault that used to look identical to "not migrated yet".
        //
        // Live 2026-08-13: a cold provision rewrote the derived role's `grants` policy WITHOUT the
        // ConnectorOwnKey statement, silently revoking a just-granted read. The agent logged nothing
        // and fell back to the shared key, and diagnosing it needed simulate-principal-policy. The
        // difference between "absent" and "forbidden" is the whole diagnosis, so it gets logged.
        const absent = e.name === 'ResourceNotFoundException' || /can't find the specified secret/i.test(String(e.message));
        if (secretId === credentialSecretBaseName) log({ level: 'warn', msg: 'connector key fetch failed', secretId, err: e.message });
        else if (!absent) {
          log({
            level: 'warn',
            msg: 'per-agent connector key EXISTS but could not be read — falling back to the shared key',
            secretId,
            via,
            err: e.name || e.message,
            // A POINTER miss is the more interesting of the two: the derived role grants the
            // name-derived ARN plus whatever the pointer names, so a forbidden pointer usually means
            // the role was built before the pointer was written (or from a stale read of it).
            hint: via === 'pointer'
              ? 'the derived role does not grant this ARN — it is built from the pointer at provision time, so a pointer written afterwards needs a re-provision or a grant rewrite'
              : 'the derived role is missing ConnectorOwnKey; a provision that rewrote the grants policy without it will do this silently',
          });
        }
      }
    }
    // Two DIFFERENT states, deliberately given two different metrics — an earlier version of this
    // block conflated them and produced an alarm that would have fired for a fleet that works.
    //
    //   shared  — the agent authenticates into the SHARED project. This is a live, working
    //             configuration: prod's shared project holds real connected accounts, which is why
    //             prod OpenClaw Connector works for agents that never had a key of their own
    //             (verified by sandbox, 2026-08-13). What it lacks is ISOLATION — every agent on the
    //             shared key can reach every connection in that one project. So: a posture counter
    //             that should trend to zero as agents are migrated, NOT an alarm.
    //             (The sandbox shared key points at the *test* project, which is sparse and toolkit-
    //             restricted. That is a sandbox data problem and says nothing about prod.)
    //
    //   no-key  — nothing resolved at all. Connector genuinely cannot work. This one alarms.
    if (resolvedScope === 'shared') {
      emitConnectorMetric('ConnectorSharedKey', { expected: perAgent || null });
      log({
        level: 'warn',
        msg: 'connector on the SHARED key — functional, but this agent has no project isolation',
        expectedSecret: perAgent || null,
        hint: 'connections live in the shared project and are visible to every agent using it; migrate to a per-agent project to isolate',
      });
    } else if (resolvedScope !== 'per-agent') {
      emitConnectorMetric('ConnectorUnprovisioned', { reason: 'no-key', expected: perAgent || null });
      log({
        level: 'error',
        msg: 'CONNECTOR UNPROVISIONED — no key resolved at all, Connector cannot work',
        expectedSecret: perAgent || null,
        sharedSecret: credentialSecretBaseName,
        hint: 'neither the per-agent secret nor the shared base resolved; check the secret exists and the runtime role can read it',
      });
    }
  }

  // Datadog REST creds for the `datadog` tool (ported from the shell datadog-logs skill). Shared
  // org-wide demo-service creds (NOT per-agent, unlike connector). Resolve from Secrets Manager; without
  // them the tool degrades gracefully (returns a "not configured" result rather than failing).
  const ddRegion = process.env.DATADOG_KEY_SECRET_REGION;
  for (const [secretEnv, keyEnv, label] of [
    ['DATADOG_API_KEY_SECRET', 'DATADOG_API_KEY', 'DATADOG_API_KEY'],
    ['DATADOG_APP_KEY_SECRET', 'DATADOG_APP_KEY', 'DATADOG_APP_KEY'],
  ]) {
    const secretId = process.env[secretEnv];
    if (secretId && !process.env[keyEnv]) {
      try {
        const v = await fetchSecret(secretId, ddRegion);
        if (v) { process.env[keyEnv] = v; log({ level: 'info', msg: `${label} resolved from Secrets Manager`, fp: await fingerprint(v) }); }
      } catch (e) { log({ level: 'warn', msg: `${label} fetch failed`, err: e.message }); }
    }
  }

  // Dispatcher shared secret — resolve from Secrets Manager so the cron tool can
  // authenticate to the dispatcher's manager API via the x-dispatcher-secret header
  // (Option B cron; see pi-cron-migration-plan.md §2b). Mirrors the CONNECTOR_API_KEY
  // pattern: DISPATCHER_SHARED_SECRET_ID names the secret; the resolved value lands in
  // DISPATCHER_SHARED_SECRET (the same env name the ECS agents use, so tool code is
  // stack-agnostic). A pre-set plain DISPATCHER_SHARED_SECRET skips the fetch (local/test).
  const dispatcherSecretId = process.env.DISPATCHER_SHARED_SECRET_ID;
  if (dispatcherSecretId && !process.env.DISPATCHER_SHARED_SECRET) {
    try {
      const secret = await fetchSecret(dispatcherSecretId, process.env.DISPATCHER_SHARED_SECRET_REGION);
      if (secret) {
        process.env.DISPATCHER_SHARED_SECRET = secret;
        log({ level: 'info', msg: 'DISPATCHER_SHARED_SECRET resolved from Secrets Manager', fp: await fingerprint(secret) });
      }
    } catch (e) { log({ level: 'warn', msg: 'dispatcher secret fetch failed', err: e.message }); }
  }

  // Hand off — the adapter self-boots on import (reads OPENCLAW_JSON + PI_WORKSPACE).
  await import('./pi-adapter.mjs');
}

main().catch((e) => { console.error(JSON.stringify({ component: 'pi-entrypoint', level: 'error', msg: 'entrypoint failed', err: e?.stack || e?.message || String(e) })); process.exit(1); });

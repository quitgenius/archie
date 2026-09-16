// Pi-only AgentCore entrypoint: resolve this agent's config from DynamoDB (config-resolver) ->
// fetch runtime secrets -> hand off to the adapter. No OpenClaw runtime, no gateway. The EFS
// mount-wait + workspace seed + skill-library sync are DEFERRED to the adapter (ensureEfsReady,
// lazy/post-listen) so a slow (~90s) BYO-EFS mount can't block boot into an AgentCore health-check
// restart loop.

import { join } from 'node:path';
import { collectInsecureHosts, installScopedTlsBypass } from './tls-scoped.mjs';
import { loadAgentConfig, agentConfig } from './agent-config.mjs';

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
// Written BACK to the environment, like PI_WORKSPACE and AWS_REGION above, because the config
// resolver reads it: BASE_PLUGINS templates the demo-cache plugin's `dataRoot` from
// process.env.OPENCLAW_HOME and falls back to /app/.openclaw when it is unset. Resolution used to run
// in a child process that was handed this defaulted value explicitly; in-process the default has to
// be published or a container that sets no OPENCLAW_HOME would silently get a different dataRoot
// than it does today.
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || '/tmp/oc';
process.env.OPENCLAW_HOME = OPENCLAW_HOME;

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

// Resolve this agent's config from DynamoDB, in-process, via the config-resolver shipped in the
// image (agent-config.mjs memoizes it, so the adapter's boot reuses this one read). The skill catalog
// is sourced from DDB inside the resolver; the skill library itself + the per-agent workspace seed are
// deferred to the adapter (ensureEfsReady → EFS, from DDB), since they need the (async, ~90s) EFS
// mount which must not block boot.
//
// This used to spawn `node resolve-boot.mjs` to render an `openclaw.json` the adapter read back. The
// file and the subprocess are both gone: the resolver returns `{ agent, cfg }` and that object IS the
// config from here on. What that removes from every cold boot is an entire Node interpreter start
// before any of our code runs, and from every mid-session re-resolve a second one.
async function bootConfig() {
  const { agent } = await loadAgentConfig({ agentName: AGENT_NAME, logger: console });
  log({ level: 'info', msg: 'config resolved from DDB', agent: agent.id, table: process.env.AGENT_CONFIG_TABLE });
  phase('config_generated');
  // Skills + workspace seed happen in the adapter (ensureEfsReady) once EFS is mounted (§9).
}

/**
 * Is `tool` in this agent's resolved allow-set?
 *
 * MUST be called after bootConfig(). agentConfig() THROWS before then rather than answering, because
 * its one caller reads a false as "not allowed" and skips a secret fetch — an answer that must never
 * be produced by "not resolved yet". The throw is reachable only if the boot order changes, and the
 * entrypoint's top-level handler reports it.
 *
 * The resolver returns THIS agent's entry directly, so there is no agent selection to get wrong (the
 * old file carried a single-element `agents.list` purely to satisfy the adapter's multi-agent
 * `selectAgent`, which is why both are gone).
 *
 * Deliberately NOT importing config-map's resolveAllowedTools: that module pulls in the Pi runtime
 * (`pca`), which would move a multi-megabyte import onto the pre-adapter boot path to answer a
 * one-token question. Group expansion is not needed either — GROUPS holds only `group:*` keys
 * (config-map.mjs:41-45), and every capability-bearing token like `datadog` is a leaf. A `group:`
 * argument would therefore be wrong here, so it is rejected loudly rather than quietly missing.
 */
function agentAllowsTool(tool) {
  if (String(tool).startsWith('group:')) throw new Error(`agentAllowsTool: expects a leaf tool token, got ${tool}`);
  return (agentConfig().agent?.tools?.alsoAllow || []).includes(tool);
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
  // INSTALLED UNCONDITIONALLY, and that is the fix for a live outage rather than a tidy-up.
  //
  // This used to run only `if (NODE_TLS_REJECT_UNAUTHORIZED === '0')`, i.e. only when the fleet was still
  // asking for the process-wide bypass. But modules/archie/ssm.tf:126-131 documents the opposite contract
  // and is right to: "the sandbox endpoint serves a self-signed cert, but tls-scoped.mjs already derives
  // its insecure-host list from HINDSIGHT_API_URL itself, and pi-entrypoint installs the scoped
  // tls.connect shim at boot. So setting this URL relaxes verification for THAT HOST ONLY and
  // AGENTCORE_RUNTIME_TLS_REJECT stays '1'. … do not flip runtime_tls_reject to '0'."
  //
  // The shim was gated on the very flag that config correctly sets to '1'. So with
  // runtime_tls_reject='1' — the documented, tightened, intended posture — NO shim was installed, full
  // verification applied to a self-signed host, and every Hindsight call failed. Found 2026-08-18 on
  // dm-ux0mz5ckp2r: `hindsight org recall error (bank default-org): recall failed: "fetch failed"` on every
  // turn, so the agent had been running with no memory recall at all, silently, plus all four
  // agent_knowledge_* read tools broken. The absence of the log line below was the only clue.
  //
  // Scoping does not depend on the flag: `collectInsecureHosts` derives the hosts from the URLs the
  // runtime was given, and installScopedTlsBypass([]) is a no-op — so prod, with real ACM certs and no
  // self-signed URLs, still installs nothing and verifies everywhere.
  const insecureHosts = collectInsecureHosts(process.env);
  const { hosts } = installScopedTlsBypass(insecureHosts, { logger: console });
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    // The legacy posture: the fleet asked for a process-wide bypass. Now that the scoped shim is in,
    // remove it so everything except `hosts` is verified again.
    delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    log({ level: 'info', msg: 'restored global TLS verification; relaxed only for allow-listed hosts', hosts });
  } else {
    // LOGGED EITHER WAY, including the empty case. Silence here is what made the outage invisible: with no
    // line at all, "no self-signed hosts to scope" and "the shim never ran" look identical.
    log({
      level: 'info',
      msg: hosts.length
        ? 'scoped TLS relaxation installed for known self-signed hosts; everything else is verified'
        : 'no scoped TLS relaxation needed — full certificate verification everywhere',
      hosts,
    });
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
  //
  // ONLY IF THIS AGENT IS ALLOWED THE TOOL. `DATADOG_*_KEY_SECRET` is set on every runtime because
  // runtimeEnv is fleet-uniform, but the SECRET is readable only by a role whose agent holds the
  // `datadog` capability — the derived role grants secretsmanager:GetSecretValue per capability. So on
  // every other agent this fetch was a guaranteed AccessDenied, twice, on every cold boot: two
  // warn-level lines describing a permission the agent is correctly not supposed to have. Verified on
  // ch-cr89fluhion 2026-08-18.
  //
  // That is worse than noise. It trains a reader to skim boot warnings, and it hides the case that
  // MATTERS — a granted agent that cannot read the secret, which is a real misconfiguration and which
  // still logs here.
  //
  // WHY THE ALLOW-SET AND NOT THE GRANT ROW: gating on env (i.e. having the dispatcher omit the
  // secret id for ungranted agents) would put a grant in `runtimeEnv`, which is fingerprinted into the
  // runtime NAME — so adding a datadog grant would force a runtime roll, destroying the property that
  // grants apply live on the next turn with no restart. The resolved allow-set is the same information
  // one layer down, and it costs nothing: bootConfig has already resolved it.
  const ddRegion = process.env.DATADOG_KEY_SECRET_REGION;
  if (agentAllowsTool('datadog')) {
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
  }

  // NO DISPATCHER SECRET AT BOOT — DELIBERATELY REMOVED (phase 3 of
  // archie-docs/archie-dispatcher-token-plan.md). This used to resolve DISPATCHER_SHARED_SECRET_ID
  // from Secrets Manager into DISPATCHER_SHARED_SECRET, mirroring the CONNECTOR_API_KEY pattern above.
  //
  // `DISPATCHER_SHARED_SECRET` is now written by pi-adapter at the START OF EVERY TURN, from the
  // per-turn token on the invoke payload. Its value is a credential for one turn of one scope
  // instead of the fleet-wide secret that let any agent act as any other.
  //
  // THE FETCH IS GONE RATHER THAN KEPT AS A FALLBACK, and that is the decision (D3, sandbox): a
  // boot-resolved value would silently become the fallback for exactly the cases the token exists to
  // close — a turn with no token would quietly reach the dispatcher with fleet-wide authority
  // instead of failing. There is nothing to fall back to, on purpose.
  //
  // WHAT BREAKS IF THE ORDER IS WRONG: an image carrying this change, running against a dispatcher
  // that does not yet MINT (phase 1), leaves every agent with no credential at all. Gateway first,
  // always. DISPATCHER_SHARED_SECRET_ID stays on the runtime spec until phase 4 — harmless now that
  // nothing reads it, and removing it is a spec change with its own rollout.

  // Hand off — the adapter self-boots on import. It takes the config from agent-config.mjs's memo
  // (the resolve bootConfig already paid for, same module instance in this process) + PI_WORKSPACE.
  await import('./pi-adapter.mjs');
}

main().catch((e) => { console.error(JSON.stringify({ component: 'pi-entrypoint', level: 'error', msg: 'entrypoint failed', err: e?.stack || e?.message || String(e) })); process.exit(1); });

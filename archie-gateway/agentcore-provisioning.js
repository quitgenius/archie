'use strict';

// AgentCore provisioning orchestrator — the single idempotent saga that provisions an agent's
// AgentCore environment (exec role? → EFS mount targets → EFS access point → runtime → optional
// reused by prod (agentcore-client.js) and the BDD/benchmark test paths.
//
// Design (see agentcore-provisioning-orchestrator-plan.md §3):
//   - Each step is idempotent (name/ClientToken/get-first keyed) and safe to re-run against
//     existing resources — a re-invoke after a partial failure converges to desired state.
//   - A cleanup LEDGER records every SELF-created resource; on a hard failure (with
//     cleanupOnFailure) we run compensating deletes in reverse order, deleting ONLY the
//     resources this saga created — NEVER a passed-in shared role. This kills the AP-leak class.
//   - Retries are TYPED (keyed on error.name / HTTP status / SDK metadata), not message-regex —
//     an AWS message reword can no longer silently turn a transient into a hard failure.
//   - Fully dependency-injected (aws clients + logger + config + clock) so it unit-tests with
//     mocked clients and no AWS creds / no top-level side effects.

const { NOOP_METRICS } = require('./dispatcher-metrics');

// M2 phase spans: @opentelemetry/api ONLY — a no-op tracer until the entrypoint's
// `require('./tracing')` registers a provider. This library module must never require
// ./tracing itself (unit tests + standalone use stay side-effect free).
const { trace: otelTrace, SpanStatusCode } = require('@opentelemetry/api');
const tracer = otelTrace.getTracer('slack-dispatcher');

// Run `fn(span)` inside an active span so nested SDK auto-spans parent correctly. Errors are
// recorded on the span and rethrown; the span always ends. With no provider registered this
// degrades to calling fn with a non-recording span (zero overhead, zero behavior change).
async function withSpan(name, options, fn) {
  return tracer.startActiveSpan(name, options, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      span.recordException(e);
      span.setStatus({ code: SpanStatusCode.ERROR, message: (e && e.message) || String(e) });
      throw e;
    } finally {
      span.end();
    }
  });
}

// ── Typed retry ────────────────────────────────────────────────────────────────
//
// Classify an error by its structural fields (never its message text). Returns one of:
//   'retry'  — a known transient/propagation error, back off and retry
//   'adopt'  — a resource-already-exists conflict (caller should adopt the existing resource)
//   'fatal'  — a non-transient error (e.g. invalid image / bad request); give up immediately

const RETRYABLE_NAMES = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'RequestLimitExceeded',
  'ProvisionedThroughputExceededException',
  'ServiceUnavailable',
  'ServiceUnavailableException',
  'InternalServerException',
  'InternalFailure',
  'InternalError',
  // IAM role / assume-role propagation lag after CreateRole/PutRolePolicy — AgentCore &
  // Lambda surface these as ValidationException / AccessDenied *during the create window*.
  'ValidationException',
]);

// Names that are retryable ONLY while a create/propagation window is open (role assume, ENI,
// EFS mount-policy propagation). Outside a window an AccessDenied is a real permissions bug.
const WINDOW_RETRYABLE_NAMES = new Set([
  'AccessDeniedException',
  'AccessDenied',
  'UnauthorizedOperation',
]);

const CONFLICT_NAMES = new Set([
  'ResourceConflictException',
  'ConflictException',
  'AccessPointAlreadyExists',
  'FileSystemAlreadyExists',
  'EntityAlreadyExists',
  'EntityAlreadyExistsException',
]);

// Fatal even inside a window — the request itself is malformed / the referenced resource is bad.
// (e.g. an invalid/nonexistent container image, a missing role ARN.) These must NOT be retried.
const FATAL_NAMES = new Set([
  'ResourceNotFoundException',
  'InvalidParameterException',
  'InvalidParameterValueException',
  'InvalidRequestException',
  'MalformedPolicyDocumentException',
]);

function httpStatusOf(err) {
  return (
    err?.$metadata?.httpStatusCode
    || err?.$response?.statusCode
    || err?.statusCode
    || null
  );
}

// Classify by structural fields only. `window` true when we're inside a known
// create/propagation window (so window-only-retryable codes become retryable).
function classifyError(err, { window = false } = {}) {
  const name = err?.name || err?.Code || err?.code || '';
  if (CONFLICT_NAMES.has(name)) return 'adopt';
  if (FATAL_NAMES.has(name)) return 'fatal';
  if (RETRYABLE_NAMES.has(name)) return 'retry';
  if (window && WINDOW_RETRYABLE_NAMES.has(name)) return 'retry';
  const status = httpStatusOf(err);
  if (status === 429 || status === 503 || status === 500) return 'retry';
  // Inside a create/propagation window, an unknown control-plane error is treated as a
  // still-propagating transient (the plan's default policy) rather than enumerating strings.
  if (window && (status === 400 || status === 403)) return 'retry';
  return 'fatal';
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll cadence for the "wait until AWS reports ready" loops.
//
// A FIXED interval pays its whole granularity as dead time on every provision, because the resource
// becomes ready at an arbitrary point between two ticks. Measured 2026-08-14: a real
// CreateAgentRuntime reaches READY in ~11.9s (3 runs, 1.5s-granularity harness, sandbox), while the
// 3s-poll production loop records `runtime_ready` at a p50 of 13.5s over 85 provisions — the ~1.6s
// difference IS the tick. The access-point loop shows it even more plainly: p50 81ms but p90 2.23s,
// i.e. one 2s sleep firing.
//
// So: check tightly while the answer is plausibly imminent, then widen so a genuinely slow resource
// does not become an API-call storm. Total budgets are preserved by raising the attempt caps —
// see each call site.
//
// NOT a fix for the tail (`runtime_ready` p90 28.8s, max 258s). That is create retries, conflict
// reconciliation and the platform itself; tick granularity is a constant, not a multiplier.
const POLL_SCHEDULE = { fastMs: 500, fastFor: 6, midMs: 1500, midFor: 24, slowMs: 3000 };

/** Interval before attempt `i` (0-based). Fast → mid → slow. */
function pollIntervalMs(i, s = POLL_SCHEDULE) {
  if (i < s.fastFor) return s.fastMs;
  if (i < s.fastFor + s.midFor) return s.midMs;
  return s.slowMs;
}

// Retry `fn` with jittered exponential backoff, keyed on the TYPED classification above.
// `window` names the propagation window ('create'|'mount'|'assume') — informational + enables
// the window-only retryable codes. `cap` bounds attempts; `baseMs` seeds the backoff.
async function withProvisioningRetry(fn, { window, cap = 6, baseMs = 6000, jitter = true, sleep = defaultSleep, logger } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= cap; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const cls = classifyError(e, { window: !!window });
      if (cls === 'adopt') throw e; // caller decides how to adopt; not our job to swallow
      if (cls === 'fatal' || attempt >= cap) throw e;
      const backoff = baseMs * 2 ** (attempt - 1);
      const delay = jitter ? Math.round(backoff * (0.5 + Math.random() * 0.5)) : backoff;
      // Log the MESSAGE, not just the name. `ValidationException` is AgentCore's generic
      // malformed-input error AND its symptom for a not-yet-assumable role, so the bare name is
      // ambiguous — and since ValidationException is classified retryable-in-window, a genuinely
      // malformed request retries `cap` times while the log says nothing about why. Live-caught
      // 2026-08-10: a retry was attributed to IAM propagation for want of this one field.
      if (logger?.warn) {
        logger.warn({
          window, attempt, cap, delayMs: delay,
          err: e?.name || String(e),
          errMessage: e?.message,
        }, 'provisioning retry');
      }
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ── Cleanup ledger ─────────────────────────────────────────────────────────────
//
// Each step appends { type, id, selfCreated } AFTER a successful create. On a hard failure with
// cleanupOnFailure, compensate() deletes SELF-created resources in reverse dependency order,
// skipping anything not self-created (a passed-in shared role is recorded selfCreated:false and
// is NEVER deleted).

function makeLedger() {
  const entries = [];
  return {
    entries,
    record(type, id, { selfCreated } = {}) {
      entries.push({ type, id, selfCreated: selfCreated === true });
    },
    async compensate({ clients, config, logger, sleep = defaultSleep }) {
      // reverse dependency order: runtime → accessPoint → role
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const e = entries[i];
        if (!e.selfCreated) {
          if (logger?.info) logger.info({ type: e.type, id: e.id }, 'compensation skip (not self-created)');
          continue;
        }
        try {
          await deleteResource(e, { clients, config, logger, sleep });
          if (logger?.info) logger.info({ type: e.type, id: e.id }, 'compensation deleted resource');
        } catch (err) {
          // best-effort: a failed compensation must not mask the original error.
          if (logger?.warn) logger.warn({ type: e.type, id: e.id, err: err?.name || String(err) }, 'compensation delete failed');
        }
      }
    },
  };
}

async function deleteResource(entry, { clients, config }) {
  if (entry.type === 'runtime') {
    const { DeleteAgentRuntimeCommand } = clients.controlCmds;
    await clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: entry.id }));
    return;
  }
  if (entry.type === 'accessPoint') {
    const { DeleteAccessPointCommand } = clients.efsCmds;
    await clients.efs.send(new DeleteAccessPointCommand({ AccessPointId: entry.id }));
    return;
  }
  if (entry.type === 'role') {
    // Only reached for self-created (test) roles. Detach inline policies then delete.
    const { DeleteRoleCommand } = clients.iamCmds || {};
    if (DeleteRoleCommand && clients.iam) {
      await clients.iam.send(new DeleteRoleCommand({ RoleName: entry.id }));
    }
    return;
  }
  throw new Error(`unknown ledger resource type: ${entry.type}`);
}

// ── Steps ────────────────────────────────────────────────────────────────────

// Step 1: ensure the exec role. A role SPEC (the normal path — a derived per-agent role) is
// get-or-created and recorded as self-created. An explicit ARN (the BDD harness's per-leg role,
// scoped to a specific EFS access point) is used as-is and never deleted.
//
// FAIL-CLOSED (§9.9b): there is no longer a shared-role fallback. It used to read `config.roleArn`
// when nothing was passed, which meant any path that failed to produce a derived role silently
// provisioned the agent onto a role with unconditioned, table-wide DynamoDB reads — the own-scope
// guarantee quietly downgraded with nothing in any log. A missing role is now a hard error.
async function ensureExecRole(agentName, { role, clients, config, logger, ledger }) {
  if (!role) {
    throw new Error(
      `ensureExecRole: no role for "${agentName}" — every agent needs its own derived role. `
      + 'Refusing to fall back to a shared role (that would grant table-wide config reads). '
      + 'Check that the agentcore-base policy + the dispatcher\'s iam:CreateRole/PassRole grant on '
      + 'role/agentcore/* exist (Terraform must be applied before this image is deployed).',
    );
  }
  if (typeof role === 'string') {
    // Explicit caller-supplied ARN (BDD per-leg role). Used as-is, never created or deleted.
    return { roleArn: role, selfCreated: false };
  }
  if (role.arn && !role.spec) {
    return { roleArn: role.arn, selfCreated: false };
  }
  // A spec was provided → the caller owns creating the role. The orchestrator does not own IAM
  // creation semantics (Terraform/tests do); the spec must carry an `ensure` async that returns
  // { roleArn, roleName } and does the get-or-create. We record it as self-created so compensation
  // can delete it (test-only artifact).
  if (typeof role.ensure !== 'function') {
    throw new Error('ensureExecRole: role spec must provide an ensure() function returning { roleArn, roleName }');
  }
  const { roleArn, roleName, created } = await role.ensure({ agentName, clients, config, logger });
  if (roleName) ledger.record('role', roleName, { selfCreated: true });
  // `roleCreatedAtMs` is set ONLY when the role was genuinely minted just now (spec.ensure reports
  // `created`). It starts the IAM propagation deadline consumed before CreateAgentRuntime — see
  // awaitIamPropagation. An ADOPTED role (created === false) propagated long ago and waits nothing.
  return { roleArn, selfCreated: true, roleCreatedAtMs: created ? Date.now() : undefined };
}

// IAM propagation deadline (§9.9 follow-up).
//
// A freshly-created role is not immediately assumable by bedrock-agentcore, and CreateAgentRuntime
// reports that as a ValidationException. That IS already handled by withProvisioningRetry (which
// classifies ValidationException as retryable inside the create window), but a retry costs a failed
// API call plus 3-6s of jittered backoff, so it is worth avoiding when we know the role is new.
//
// DEADLINE, NOT SLEEP — this is the important part. The steps between role creation and
// CreateAgentRuntime (mount targets, access point) usually take seconds, during which propagation
// happens for free; a fixed sleep would waste that. So we only sleep the REMAINDER of the minimum
// window, which is normally zero. It also composes correctly with those steps running concurrently:
// parallelising them shrinks the natural window, and this transparently makes up the difference
// instead of silently making the race more likely.
//
// The retry remains the correctness mechanism: IAM propagation has no guaranteed bound and no
// queryable "is it assumable yet" signal (GetRole returns immediately; SimulatePrincipalPolicy tests
// policy evaluation, not trust propagation). This only shaves the common case.
const IAM_PROPAGATION_MIN_MS = 2000;

async function awaitIamPropagation(roleCreatedAtMs, { config, logger, sleep = defaultSleep } = {}) {
  if (!roleCreatedAtMs) return 0; // adopted / pre-existing / shared role → nothing to wait for
  const minMs = Number.isFinite(config?.iamPropagationMinMs) ? config.iamPropagationMinMs : IAM_PROPAGATION_MIN_MS;
  const remaining = minMs - (Date.now() - roleCreatedAtMs);
  if (remaining <= 0) return 0; // the intervening steps already covered it — the common case
  if (logger?.debug) logger.debug({ remainingMs: remaining, minMs }, 'awaiting IAM propagation for a newly-created role');
  await sleep(remaining);
  return remaining;
}

// Step 2: mount targets for the EFS filesystem must be `available` before a VPC mount can bind.
// Returns the supported subnets (in-VPC + AgentCore-supported AZs) for CreateAgentRuntime.
async function ensureMountTargetsAvailable(_agentName, { clients, config, logger, sleep = defaultSleep }) {
  const { DescribeMountTargetsCommand } = clients.efsCmds;
  const supportedAzIds = config.supportedAzIds instanceof Set
    ? config.supportedAzIds
    : new Set(config.supportedAzIds || []);
  // A mount target is usable when its lifecycle is `available`. Real EFS always reports the field;
  // treat an ABSENT field as available (only a minimal test fake omits it) — an explicit non-
  // `available` state (e.g. `creating`) still loops until it propagates.
  const isReady = (m) => m.LifeCycleState === undefined || m.LifeCycleState === 'available';
  let mts = [];
  // 40 attempts on the fast→slow schedule ≈ 69s, vs the previous 30×2s = 60s. Budget preserved.
  for (let i = 0; i < 40; i += 1) {
    const r = await clients.efs.send(new DescribeMountTargetsCommand({ FileSystemId: config.efsFsId }));
    mts = (r.MountTargets || []).filter((m) => m.VpcId === config.vpcId && supportedAzIds.has(m.AvailabilityZoneId));
    if (mts.length && mts.every(isReady)) break;
    await sleep(pollIntervalMs(i));
  }
  const subnets = mts.filter(isReady).map((m) => m.SubnetId);
  if (!subnets.length) {
    throw new Error(`no available EFS mount targets for ${config.efsFsId} in VPC ${config.vpcId} in supported AZs`);
  }
  if (logger?.debug) logger.debug({ subnets }, 'mount targets available');
  return { subnets };
}

// Step 3: idempotent get-or-create of the agent's EFS access point by a DETERMINISTIC ClientToken.
// On AccessPointAlreadyExists the existing id is on the error → adopt (never delete). Polls the AP
// to `available` on a fresh create. Records a fresh create as self-created (compensation target).
async function ensureAccessPoint(agentName, { efsRootFor, accessPointArn: injectedArn, clients, config, logger, ledger, sleep = defaultSleep }) {
  const { CreateAccessPointCommand, DescribeAccessPointsCommand } = clients.efsCmds;
  const arnOf = (id) => `arn:aws:elasticfilesystem:${config.region}:${config.account}:access-point/${id}`;
  // Caller pre-created the AP and wants it used verbatim (e.g. the BDD fixture scopes a per-leg
  // exec role to a SPECIFIC access point). Adopt as-is: skip create — a create with our own
  // ClientToken would mint a SECOND AP at the same root path (EFS allows it; the token only dedupes
  // retries), which the caller's role isn't scoped to → runtime mount AccessDenied. Not self-created,
  // so compensation never deletes a caller-owned AP.
  if (injectedArn) {
    return { accessPointArn: injectedArn, accessPointId: injectedArn.split('/').pop(), selfCreated: false };
  }
  const root = efsRootFor(agentName);
  const clientToken = `oc-ap-${root.replace(/[^a-zA-Z0-9]/g, '-')}`.slice(0, 64);
  try {
    const ap = await withProvisioningRetry(
      () => clients.efs.send(new CreateAccessPointCommand({
        ClientToken: clientToken,
        FileSystemId: config.efsFsId,
        RootDirectory: { Path: root, CreationInfo: { OwnerUid: 1000, OwnerGid: 1000, Permissions: '755' } },
        PosixUser: { Uid: 1000, Gid: 1000 },
        Tags: [{ Key: 'Name', Value: agentName }, { Key: 'managed-by', Value: 'agentcore' }],
      })),
      { window: 'create', cap: 6, baseMs: 2000, logger, sleep },
    );
    const apId = ap.AccessPointId;
    ledger.record('accessPoint', apId, { selfCreated: true });
    // 40 attempts ≈ 69s, vs the previous 30×2s = 60s. This loop is the clearest win of the three:
    // p50 81ms means it is usually available on the first check, and the p90 of 2.23s was one tick.
    for (let i = 0; i < 40; i += 1) {
      const d = await clients.efs.send(new DescribeAccessPointsCommand({ AccessPointId: apId }));
      if (d.AccessPoints?.[0]?.LifeCycleState === 'available') break;
      await sleep(pollIntervalMs(i));
    }
    return { accessPointArn: arnOf(apId), accessPointId: apId, selfCreated: true };
  } catch (e) {
    if (classifyError(e) !== 'adopt') throw e;
    // Existing AP (created by a prior run / another dispatcher). Adopt — do NOT record as
    // self-created, so compensation never deletes it.
    if (!e.AccessPointId) throw new Error(`AccessPointAlreadyExists for ${root} but no AccessPointId on the error`);
    return { accessPointArn: arnOf(e.AccessPointId), accessPointId: e.AccessPointId, selfCreated: false };
  }
}

// Find an existing runtime by its deterministic name. Returns { arn, status, id } or null.
// By default a DELETING/DELETE_FAILED runtime is treated as absent (invoking it fails); pass
// includeDeleting:true to surface it — the create path needs it to reconcile the name AWS still
// holds during the delete (P3-B) instead of blindly issuing a doomed CreateAgentRuntime.
async function findRuntimeByName(name, { clients, config, includeDeleting = false }) {
  const { ListAgentRuntimesCommand, GetAgentRuntimeCommand } = clients.controlCmds;
  let token;
  do {
    const r = await clients.control.send(new ListAgentRuntimesCommand({ maxResults: 100, nextToken: token }));
    const hit = (r.agentRuntimes || []).find((x) => x.agentRuntimeName === name);
    if (hit) {
      let g;
      try {
        g = await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: hit.agentRuntimeId }));
      } catch (e) {
        // vanished between List and Get (delete completed) — treat as absent.
        if ((e?.name || e?.Code || e?.code) === 'ResourceNotFoundException') return null;
        throw e;
      }
      const status = g.status || hit.status;
      if (!includeDeleting && DELETING_STATUSES.has(status)) return null;
      const arn = g.agentRuntimeArn || hit.agentRuntimeArn
        || `arn:aws:bedrock-agentcore:${config.region}:${config.account}:runtime/${hit.agentRuntimeId}`;
      // The image this runtime ACTUALLY runs. The Get above already fetched it, so returning it is
      // free — and it is the only way to tell a correctly-named runtime from a mislabelled one (see
      // the adopt check in agentcore-client ensureRuntime).
      const image = g.agentRuntimeArtifact?.containerConfiguration?.containerUri || null;
      return { arn, status, id: hit.agentRuntimeId, image };
    }
    token = r.nextToken;
  } while (token);
  return null;
}

const DELETING_STATUSES = new Set(['DELETING', 'DELETE_FAILED']);

// P3-B: after DeleteAgentRuntime the runtime lingers in DELETING (or DELETE_FAILED) and AWS still
// HOLDS THE NAME — CreateAgentRuntime with the same name throws ConflictException until the delete
// finishes. Poll GetAgentRuntime to ResourceNotFoundException (bounded) so "teardown then
// re-provision the same agent name" converges instead of hard-failing.
// Budget: live deletes observed 2026-08-01 ran 3.5–10+ min (VPC-mode ENI teardown variance; one
// runtime that had served turns held its name past 10 min). The original 100×3s=5min budget lost
// that race twice — 400×3s=20min gives real headroom while still failing loudly on a stuck delete.
async function waitForRuntimeDeleted(name, runtimeId, {
  clients, logger, sleep = defaultSleep, maxAttempts = 400, intervalMs = 3000,
} = {}) {
  // M2: this wait is a real latency source (a DELETING carcass can hold the name for minutes) —
  // surface it as its own phase span so the delay reads as one block, not GetAgentRuntime noise.
  return withSpan('dispatcher.provision.name_release_wait', {
    attributes: { 'dispatcher.runtime_name': name, 'dispatcher.runtime_id': runtimeId },
  }, async () => {
    const { GetAgentRuntimeCommand } = clients.controlCmds;
    for (let i = 1; i <= maxAttempts; i += 1) {
      let status;
      try {
        status = (await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: runtimeId }))).status;
      } catch (e) {
        if ((e?.name || e?.Code || e?.code) === 'ResourceNotFoundException') {
          if (logger?.info) logger.info({ name, runtimeId, attempts: i }, 'deleting runtime is gone — name released');
          return;
        }
        throw e;
      }
      if (logger?.debug) logger.debug({ name, runtimeId, status, attempt: i }, 'waiting for runtime delete');
      await sleep(intervalMs);
    }
    throw new Error(`runtime ${name} (${runtimeId}) still deleting after ${maxAttempts} polls — name not released`);
  });
}

// Step 4: get-or-create the runtime by name. Existing & healthy → adopt (never record self-created,
// never compensate). Missing → create (typed retry through the role/ENI propagation window), poll
// GetAgentRuntime to READY (`*_FAILED` → throw). A fresh create is recorded self-created.
//
// P3-B reconcile: a runtime deleted by name lingers in DELETING while AWS tears it down, and AWS
// still holds the NAME — a create issued during that window throws ConflictException. Two repairs:
//   pre-create — a DELETING/DELETE_FAILED hit waits (poll Get → ResourceNotFoundException) BEFORE
//                the create, so the common teardown-then-reprovision flow never even conflicts;
//   on-conflict — a ConflictException from CreateAgentRuntime re-enters findRuntimeByName: a live
//                runtime (scale-out race: another instance won the create) is ADOPTED; a deleting
//                one is waited out then the create is retried. Converges, never hard-throws here.
async function ensureRuntime(agentName, {
  name, image, envs, roleArn, subnets, accessPointArn,
  clients, config, logger, ledger, sleep = defaultSleep,
}) {
  const { CreateAgentRuntimeCommand, GetAgentRuntimeCommand } = clients.controlCmds;

  // Adopt an existing (non-deleting) runtime: READY → use it; still coming up (another dispatcher
  // created it) → wait for READY. Never recorded self-created, never compensated.
  async function adoptExisting(existing) {
    let { status } = existing;
    if (status === 'CREATE_FAILED') {
      throw new Error(`existing runtime ${name} is CREATE_FAILED`);
    }
    // VERIFY THE IMAGE BEFORE ADOPTING. The name is supposed to fingerprint the spec, so adopting by
    // name assumes nothing can mint a runtime whose name and content disagree. A bug did exactly that
    // (the image was dropped on the way to CreateAgentRuntime), producing a runtime named for pi-obs-39
    // that ran pi-obs-40 — and because it was then adopted by name, the roll was a silent no-op that no
    // log, metric or list-agent-runtimes call could reveal.
    //
    // This check used to live in agentcore-client's ensureRuntime, which pre-scanned for the runtime
    // before deciding to create. That scan is gone (the registry answers name→arn), so adoption now
    // happens HERE, on the conflict path — and the check has to come with it or a mismatched runtime
    // would be adopted silently again. Delete it so the next turn converges once the name is released.
    if (existing.image && existing.image !== image) {
      if (logger?.error) {
        logger.error({ agent: agentName, runtime: name, expected: image, actual: existing.image },
          'agentcore: runtime name/image MISMATCH — refusing to adopt; deleting so the next turn re-provisions');
      }
      try {
        const { DeleteAgentRuntimeCommand } = clients.controlCmds;
        await clients.control.send(new DeleteAgentRuntimeCommand({ agentRuntimeId: existing.id }));
      } catch (delErr) {
        if (logger?.warn) logger.warn({ err: delErr.message, runtime: name }, 'agentcore: mismatch delete failed');
      }
      throw new Error(`runtime ${name} runs ${existing.image}, expected ${image} — deleted; retry shortly`);
    }
    // 140 attempts on the schedule ≈ 369s, vs the previous 120×3s = 360s. Budget preserved.
    for (let i = 0; i < 140 && status !== 'READY'; i += 1) {
      if (['CREATE_FAILED', 'DELETING', 'DELETE_FAILED'].includes(status)) break;
      await sleep(pollIntervalMs(i));
      status = (await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: existing.id }))).status;
    }
    if (status !== 'READY') throw new Error(`existing runtime ${name} not READY (status=${status})`);
    return { runtimeArn: existing.arn, runtimeId: existing.id, selfCreated: false };
  }

  // NO PRE-FLIGHT ListAgentRuntimes.
  //
  // This used to scan for the runtime before creating, which cost a full pagination of every runtime in
  // the account on the one path where the scan can never early-exit: the name is absent precisely
  // because we are about to create it. List is 25/s, non-adjustable, with no name filter — so that scan
  // was the ceiling on any fleet-wide roll.
  //
  // Instead: create, and let a name CONFLICT be the signal that something already holds it. The
  // conflict loop below already reconciles (adopt the winner, or wait out a deleting carcass and
  // retry), so the expensive scan now happens only in that genuinely ambiguous case. This is also what
  // recovers a runtime that was created just before a crash lost the registry write — "exists at AWS
  // but absent from the table" resolves to adopt, not to a duplicate.
  const spec = {
    agentRuntimeName: name,
    agentRuntimeArtifact: { containerConfiguration: { containerUri: image } },
    roleArn,
    networkConfiguration: { networkMode: 'VPC', networkModeConfig: { securityGroups: [config.securityGroupId], subnets } },
    protocolConfiguration: { serverProtocol: 'HTTP' },
    lifecycleConfiguration: { idleRuntimeSessionTimeout: 900, maxLifetime: 28800 },
    environmentVariables: envs,
    filesystemConfigurations: [{ efsAccessPoint: { accessPointArn, mountPath: config.efsMountPath } }],
  };

  // A fresh shared/created role can 500/ValidationException/AccessDenied for a few seconds after
  // creation while it propagates — retry through the create window (typed, not regex).
  // A ConflictException (classified 'adopt') means the name is held: reconcile (adopt-or-wait)
  // and retry the create — bounded so a pathological control plane can't loop us forever.
  const maxConflictRounds = 3;
  let created;
  for (let round = 1; ; round += 1) {
    try {
      created = await withProvisioningRetry(
        () => clients.control.send(new CreateAgentRuntimeCommand(spec)),
        { window: 'create', cap: 6, baseMs: 6000, logger, sleep },
      );
      break;
    } catch (e) {
      if (classifyError(e) !== 'adopt' || round >= maxConflictRounds) throw e;
      if (logger?.warn) logger.warn({ agent: agentName, name, round, err: e?.name || String(e) }, 'CreateAgentRuntime name conflict — reconciling');
      const holder = await findRuntimeByName(name, { clients, config, includeDeleting: true });
      if (holder && !DELETING_STATUSES.has(holder.status)) return adoptExisting(holder); // race: adopt the winner
      if (holder) await waitForRuntimeDeleted(name, holder.id, { clients, logger, sleep });
      // no holder listed → the delete completed between the throw and the list; just re-create.
    }
  }
  const id = created.agentRuntimeId;
  ledger.record('runtime', id, { selfCreated: true });

  let status = created.status;
  // 140 attempts on the schedule ≈ 369s, vs the previous 120×3s = 360s. Budget preserved.
  for (let i = 0; i < 140 && !['READY', 'CREATE_FAILED'].includes(status); i += 1) {
    await sleep(pollIntervalMs(i));
    status = (await clients.control.send(new GetAgentRuntimeCommand({ agentRuntimeId: id }))).status;
  }
  if (status !== 'READY') throw new Error(`runtime ${name} did not reach READY (status=${status})`);
  if (logger?.info) logger.info({ agent: agentName, name, runtimeId: id }, 'agentcore runtime created');
  const runtimeArn = created.agentRuntimeArn || `arn:aws:bedrock-agentcore:${config.region}:${config.account}:runtime/${id}`;
  return { runtimeArn, runtimeId: id, selfCreated: true };
}

// ── The saga ────────────────────────────────────────────────────────────────

// ensureAgentEnvironment — the single ordered idempotent pipeline. See the plan §3 table.
// Returns { runtimeArn, accessPointArn, roleArn }.
async function ensureAgentEnvironment(agentName, opts = {}) {
  const {
    role,
    image,
    envs,
    efsRootFor,
    accessPointArn: injectedAccessPointArn,
    cleanupOnFailure = true,
    clients,
    logger,
    config,
    sleep = defaultSleep,
    runtimeName,
    // §9.9a: injected by the client (which owns the DDB doc client) — pre-writes a brand-new
    // agent's workspace SEED so the runtime never needs a DynamoDB write. Optional: absent in unit
    // tests and in any caller that does not manage the config table.
    seedNewWorkspace,
    // §9.9a sibling: the agent's default skills + Connector toolkits. Same gate (a self-created
    // access point) and same optionality — absent in unit tests and in callers with no config table.
    seedNewMarketplace,
    // Phase 3: gives a NEW agent its own Connector project + key before its container boots.
    // Injected for the same reason as seedNewWorkspace — it needs Secrets Manager, the config table
    // and the org key, none of which this saga should know about. Contract: it NEVER throws and
    // returns {outcome, ms}; see connector-credential.js.
    ensureConnectorCredential,
  } = opts;

  // M1 (dispatcher-observability D6): optional EMF metrics sink. Defaults to a no-op so unit
  // tests (which inject nothing) produce zero stdout side effects; the prod client wires in the
  // real ClawdbotDispatcher stdout emitter. Phase timing is plain Date.now() — the interim M1
  // mechanism (M2 replaces it with spans). `now` injectable for deterministic tests.
  const metrics = opts.metrics || NOOP_METRICS;
  const now = opts.now || Date.now;

  if (!agentName) throw new Error('ensureAgentEnvironment: agentName required');
  if (!clients) throw new Error('ensureAgentEnvironment: clients must be injected');
  if (!config) throw new Error('ensureAgentEnvironment: config must be injected');
  if (typeof efsRootFor !== 'function') throw new Error('ensureAgentEnvironment: efsRootFor(agentName) must be a function');

  const name = runtimeName || opts.name;
  if (!name) throw new Error('ensureAgentEnvironment: runtimeName required');

  const ledger = makeLedger();
  const ctx = { clients, config, logger, ledger, sleep };
  const t0 = now();

  // M2: dispatcher.provision is the parent phase span for the whole saga; each poll loop below
  // gets a child span so the ~30s cold provision reads as named phases (mount_targets /
  // access_point / runtime_ready [/ name_release_wait]) with SDK auto-spans nested inside.
  // The M1 EMF metrics alongside measure the SAME phases independently (cross-check by design).
  return withSpan('dispatcher.provision', {
    attributes: { 'dispatcher.agent': agentName, 'dispatcher.runtime_name': name },
  }, async (provisionSpan) => {
    try {
      // 1. role (only creates if a spec is passed; a passed-in ARN is used & never deleted)
      const { roleArn, roleCreatedAtMs } = await ensureExecRole(agentName, { role, ...ctx });

      // 2 + 3 CONCURRENTLY. `ensureAccessPoint` needs only the filesystem + root path, and `subnets`
      // is consumed by step 4 alone, so these two poll loops have no data dependency on each other.
      //
      // allSettled, NOT all: both legs touch resources and ensureAccessPoint CREATES one. With
      // fail-fast, a rejection from one leg would return while CreateAccessPoint was still in flight,
      // and the AP could land AFTER the rejection — outside the ledger, i.e. a leaked access point
      // (this codebase has already been bitten by EFS access-point churn). Letting both settle means
      // the ledger is complete before we decide, so compensation can roll back deterministically.
      const tPar = now();
      const [mtRes, apRes, connectorRes] = await Promise.allSettled([
        (async () => {
          const t = now();
          const r = await withSpan('dispatcher.provision.mount_targets', {}, () => (
            ensureMountTargetsAvailable(agentName, { ...ctx })
          ));
          return { r, ms: now() - t };
        })(),
        (async () => {
          const t = now();
          const r = await withSpan('dispatcher.provision.access_point', {}, () => (
            ensureAccessPoint(agentName, { efsRootFor, accessPointArn: injectedAccessPointArn, ...ctx })
          ));
          // §9.9a: pre-write the workspace SEED for a genuinely NEW agent, so the runtime needs no
          // DynamoDB write. Chained onto THIS leg rather than added as a third parallel task because
          // it depends on `selfCreated` — a fresh access point is what proves the workspace is empty
          // and therefore that a skeleton manifest will match it (see seedNewWorkspace). Chaining it
          // here still overlaps the mount-target leg, so it costs no extra wall clock.
          let seed;
          let marketplaceSeed;
          const canSeed = typeof seedNewWorkspace === 'function';
          if (r.selfCreated === true && canSeed) {
            // Sequential, not parallel: both are single conditional writes on the same partition and
            // the second is not worth a second round trip's worth of concurrency machinery. Neither
            // can fail the provision, so a rejection here would be a bug, not a risk — hence no
            // allSettled. The marketplace seed is optional so older callers keep working.
            seed = await seedNewWorkspace(agentName, { logger });
            if (typeof seedNewMarketplace === 'function') {
              marketplaceSeed = await seedNewMarketplace(agentName, { logger });
            }
          } else if (logger?.info) {
            // Log the DECISION, not just the action. A silently-skipped pre-write leaves the agent
            // with no recorded baseline and nothing in any log to say why (live-caught 2026-08-10).
            logger.info({ agent: agentName, apSelfCreated: r.selfCreated === true, seederWired: canSeed },
              'workspace SEED pre-write skipped');
          }
          return { r, ms: now() - t, seed, marketplaceSeed };
        })(),
        // 2c. Connector project + key. A THIRD concurrent leg rather than a step, because it is a
        // third-party HTTP round trip with no data dependency on either of the others — joining it
        // here hides its latency inside a wait we already pay, which is the whole reason phase 3
        // lives in the saga instead of being a separate pass.
        //
        // The secret must exist before the CONTAINER boots, not before CreateAgentRuntime returns
        // (the runtime resolves it by name at boot), and step 4 is still ahead of us — so finishing
        // here is comfortably early enough.
        //
        // It cannot fail the saga: ensureConnectorCredential never throws by contract, and the rejection check
        // below deliberately ignores this leg. An agent with no Connector still serves Slack.
        (async () => {
          if (typeof ensureConnectorCredential !== 'function') return null;
          return withSpan('dispatcher.provision.connector', {}, async (span) => {
            const out = await ensureConnectorCredential(agentName, { logger });
            // Attributes on the span, not just a duration: a trace that says only "this leg took
            // 400ms" cannot distinguish a project being minted from a 409 nobody can act on.
            if (out && span?.setAttributes) {
              span.setAttributes({
                'connector.outcome': String(out.outcome || 'unknown'),
                ...(out.reason ? { 'connector.reason': String(out.reason) } : {}),
                ...(out.projectId ? { 'connector.project_id': String(out.projectId) } : {}),
                ...(Number.isFinite(out.ms) ? { 'connector.latency_ms': out.ms } : {}),
              });
            }
            return out;
          });
        })(),
      ]);
      // The Connector leg is INTENTIONALLY absent from this check. It is the one leg whose failure
      // must not abort provisioning — losing Connector costs an agent some tools, aborting costs the
      // user their answer. Reported below instead.
      const connector = connectorRes.status === 'fulfilled' ? connectorRes.value : null;
      if (connector) {
        metrics.emitConnectorProvision(agentName, connector);
        const connectorLog = connector.outcome === 'created' ? logger?.info : logger?.warn;
        // BLOCKED and FAILED both leave the agent on the shared key, but only one of them is
        // actionable by a human, so they must not read the same in the logs.
        if (connector.outcome !== 'already-pointed') {
          // `event` is the machine key; the message is for humans. Filtering on message TEXT is what
          // made three unrelated lines collide with a `"connector provisioning"` grep — including the
          // role-refresh line, which made one provision look like two. Structured field, stable name.
          connectorLog?.call(logger, { event: 'connector_provision_outcome', agent: agentName, ...connector },
            `connector provision outcome: ${connector.outcome}`);
        }
      } else if (connectorRes.status === 'rejected') {
        // Contract violation (it is documented never to throw), not an expected path — say so
        // plainly rather than letting it look like a normal miss.
        logger?.warn?.({ agent: agentName, err: String(connectorRes.reason) }, 'ensureConnectorCredential THREW — it is contracted not to; agent falls back to the shared key');
      }

      // Surface the FIRST failure, but only after both settled (see above). Both being rejected is
      // reported as the mount-target error with the AP error attached, so neither is lost.
      if (mtRes.status === 'rejected' || apRes.status === 'rejected') {
        const primary = mtRes.status === 'rejected' ? mtRes.reason : apRes.reason;
        if (mtRes.status === 'rejected' && apRes.status === 'rejected') primary.alsoFailed = apRes.reason;
        throw primary;
      }
      // NOTE these two are CONCURRENT, so mountTargetsMs + accessPointMs is NOT the elapsed wall
      // clock for this phase — parallelPhaseMs is. Kept separate so each phase stays comparable to
      // its historical (serial) values.
      const mountTargetsMs = mtRes.value.ms;
      const accessPointMs = apRes.value.ms;
      const parallelPhaseMs = now() - tPar;
      const { subnets } = mtRes.value.r;
      const ap = apRes.value.r;
      const { accessPointArn } = ap;

      // A newly-minted role may not be assumable yet. Steps 2+3 above usually cover the propagation
      // window for free (so this is normally a no-op); running them concurrently shrinks that window,
      // and this makes up only the remainder. Adopted roles wait nothing.
      const iamPropagationWaitMs = await awaitIamPropagation(roleCreatedAtMs, { config, logger, sleep });

      // 4. runtime (get-or-create by name; polls READY) — the ~30s phase
      const tRt = now();
      const rt = await withSpan('dispatcher.provision.runtime_ready', {}, (span) => {
        span.setAttribute('dispatcher.runtime_name', name);
        return ensureRuntime(agentName, {
          name, image, envs, roleArn, subnets, accessPointArn, ...ctx,
        });
      });
      const runtimeReadyMs = now() - tRt;
      const { runtimeArn } = rt;

      provisionSpan.setAttribute('dispatcher.runtime_created', rt.selfCreated === true);
      provisionSpan.setAttribute('dispatcher.access_point_created', ap.selfCreated === true);
      // The concurrency + propagation-wait decisions are only defensible if they are visible: without
      // these, "did parallelising 2+3 actually help, and did it cost us a propagation retry?" is
      // unanswerable from telemetry. parallel_phase_ms is the wall clock for the concurrent phase
      // (mount_targets_ms + access_point_ms overlap and must NOT be summed).
      provisionSpan.setAttribute('dispatcher.parallel_phase_ms', parallelPhaseMs);
      provisionSpan.setAttribute('dispatcher.mount_targets_ms', mountTargetsMs);
      provisionSpan.setAttribute('dispatcher.access_point_ms', accessPointMs);
      provisionSpan.setAttribute('dispatcher.role_created', roleCreatedAtMs !== undefined);
      provisionSpan.setAttribute('dispatcher.iam_propagation_wait_ms', iamPropagationWaitMs);
      if (apRes.value.seed) provisionSpan.setAttribute('dispatcher.seed_prewritten', apRes.value.seed.seeded === true);

      // M1 D6: emit phase durations + total + created-vs-reused counts. `selfCreated` from the AP /
      // runtime steps distinguishes a fresh mint from an adopt/reuse (so RuntimeCreatedCount /
      // AccessPointCreatedCount only tick on a real provision). Total should land ~30s cold.
      metrics.emitProvision(agentName, {
        mountTargetsMs,
        accessPointMs,
        runtimeReadyMs,
        totalMs: now() - t0,
        runtimeCreated: rt.selfCreated === true,
        accessPointCreated: ap.selfCreated === true,
        props: { runtimeName: name, runtimeId: rt.runtimeId },
      });

      // runtimeId is RETURNED, not just logged as a metric prop. The runtime registry stores it because
      // GetAgentRuntime and DeleteAgentRuntime both take an id and never a name — so without it the
      // reaper cannot act on a row at all, and it silently stopped reaping (superseded generations
      // accumulated 2-3 deep per agent against the account's 1000-runtime quota, live 2026-08-13).
      return { runtimeArn, runtimeId: rt.runtimeId, accessPointArn, roleArn };
    } catch (err) {
      metrics.emitProvisionError(agentName, { runtimeName: name, errName: err?.name || 'Error' });
      if (cleanupOnFailure) {
        if (logger?.warn) logger.warn({ agent: agentName, err: err?.message || String(err) }, 'provisioning failed — compensating');
        await ledger.compensate({ clients, config, logger, sleep });
      }
      throw err;
    }
  });
}

module.exports = {
  ensureAgentEnvironment,
  withProvisioningRetry,
  classifyError,
  // internals exported for unit tests / the client layer
  makeLedger,
  ensureExecRole,
  awaitIamPropagation,
  IAM_PROPAGATION_MIN_MS,
  ensureMountTargetsAvailable,
  ensureAccessPoint,
  pollIntervalMs,
  POLL_SCHEDULE,
  ensureRuntime,
  findRuntimeByName,
  waitForRuntimeDeleted,
};

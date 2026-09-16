// Agent → dispatcher connectivity (pi-cron-migration-plan.md §2b, Blocker A).
//
// Thin HTTP client the Pi cron tool (+ flip-time hydrator) uses to reach the
// dispatcher's cron manager API. Under AgentCore the agent has no gateway to RPC and
// no in-agent Slack surface, so cron CRUD is routed to the always-on dispatcher, which
// owns the scheduler. Auth mirrors the ECS path: the x-dispatcher-secret header.
//
// Config comes from env, resolved at boot by pi-entrypoint.mjs:
//   DISPATCHER_BASE_URL      — the dispatcher FQDN (same one ECS agents use; reachable
//                              from the in-VPC Pi runtime via the shared internal ALB)
//   DISPATCHER_SHARED_SECRET — resolved from Secrets Manager at boot (== the ECS value)
//
// Routes mirror slack-dispatcher/cron-api.js exactly:
//   POST   /cron                        add
//   GET    /cron/:agentId               list
//   PUT    /cron/:agentId/:jobId        update
//   DELETE /cron/:agentId/:jobId        remove
//   POST   /cron/:agentId/:jobId/run    run-now
//
// `fetch` and env are injectable for tests.

const DEFAULT_TIMEOUT_MS = 10_000;

// `spawn` blocks on a child TURN, not a store write. This ceiling only has to outlast the server's
// own budget — which the dispatcher derives from the parent turn's token expiry and enforces with
// its own abort — so it is a backstop against a hung connection, never the real limit.
const SPAWN_TIMEOUT_MS = 10 * 60_000;

export function createDispatcherClient(opts = {}) {
  const base = String(opts.baseUrl ?? process.env.DISPATCHER_BASE_URL ?? '').replace(/\/+$/, '');
  // READ PER CALL, NOT CAPTURED HERE.
  //
  // This client is built once per SESSION (buildCustomTools → buildCronTools, pi-adapter), and a
  // session serves many turns. While DISPATCHER_SHARED_SECRET held a static boot-resolved secret
  // that was fine. It stops being fine the moment the value is a PER-TURN token
  // (archie-dispatcher-token-plan.md phase 3): the client would pin turn 1's token for the life of
  // the session, and the dispatcher deletes that token when turn 1 ends — so every cron call from
  // turn 2 onward would 401 with `revoked`, indistinguishable at the alarm from a replay.
  //
  // `base` stays captured: it is per-deployment and cannot change under a running session.
  const secretNow = () => opts.secret ?? process.env.DISPATCHER_SHARED_SECRET ?? '';
  const doFetch = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  function assertConfigured() {
    if (!base) throw new Error('dispatcher-client: DISPATCHER_BASE_URL not set');
    if (!secretNow()) throw new Error('dispatcher-client: DISPATCHER_SHARED_SECRET not set');
  }

  async function call(method, path, body, opts = {}) {
    assertConfigured();
    const ac = new AbortController();
    // Per-call override. The 10s default is right for cron CRUD, which is a store write; it is
    // hopeless for `spawn`, which blocks on a whole child turn. A client-side abort shorter than the
    // server-side budget would look to the model like a broken tool rather than a slow child.
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || timeoutMs);
    try {
      const res = await doFetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-dispatcher-secret': secretNow() },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ac.signal,
      });
      const text = res.text ? await res.text().catch(() => '') : '';
      let json;
      try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
      if (res.ok === false || (typeof res.status === 'number' && res.status >= 400)) {
        const err = new Error(`dispatcher ${method} ${path} -> HTTP ${res.status}: ${(json && json.error) || text}`);
        err.status = res.status;
        err.body = json;
        throw err;
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  const enc = encodeURIComponent;
  return {
    isConfigured: () => Boolean(base && secretNow()),
    add: (job) => call('POST', '/cron', job),
    list: (agentId) => call('GET', `/cron/${enc(agentId)}`),
    update: (agentId, jobId, patch) => call('PUT', `/cron/${enc(agentId)}/${enc(jobId)}`, patch),
    remove: (agentId, jobId) => call('DELETE', `/cron/${enc(agentId)}/${enc(jobId)}`),
    run: (agentId, jobId) => call('POST', `/cron/${enc(agentId)}/${enc(jobId)}/run`),
    /**
     * `sessions_spawn`'s server half (archie-sessions-spawn-plan.md).
     *
     * NO agentId ARGUMENT, and that is the design rather than an omission: the scope comes from the
     * per-turn token this client already sends, so there is no parameter through which a caller
     * could name another agent. Every other method here takes an agentId because it predates the
     * token; this one never will.
     */
    spawn: (prompt, { timeoutSeconds, timeoutMs } = {}) => call('POST', '/spawn',
      { prompt, ...(timeoutSeconds ? { timeoutSeconds } : {}) },
      { timeoutMs: timeoutMs || SPAWN_TIMEOUT_MS }),
    _base: base,
  };
}

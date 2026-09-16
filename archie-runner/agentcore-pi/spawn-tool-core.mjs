// `sessions_spawn` — the pi-free half (archie-docs/archie-sessions-spawn-plan.md).
//
// Run a prompt in a FRESH session as yourself, and get the final text back. The whole feature is one
// HTTP call; what lives here is the part worth testing without Pi: turning the dispatcher's answer
// into something a model can act on.
//
// WHY THERE IS NO `agent` PARAMETER. The scope is taken from the per-turn token the dispatcher
// issued for this turn, so a spawn is always under the caller's own identity — not by validation,
// but because there is nowhere to put another one. That is the single requirement the whole design
// was built around.
//
// EVERY OUTCOME IS A STRING, never a throw. A refused depth, a child that errored, a child that ran
// out of budget — all of them are things the model should read and decide about. A tool that throws
// gets retried; a tool that explains gets handled.

export const SPAWN_ERROR_PREFIX = 'sessions_spawn: ';

/**
 * @param deps.dispatcher  a dispatcher client exposing `spawn(prompt, {timeoutSeconds})`
 * @param deps.log         optional pino-shaped logger
 */
export function makeSpawnExecute(deps = {}) {
  const dispatcher = deps.dispatcher;
  const log = deps.log || { info() {}, warn() {}, error() {} };

  return async function execute(_toolCallId, params = {}) {
    const prompt = typeof params.prompt === 'string' ? params.prompt.trim() : '';
    if (!prompt) return `${SPAWN_ERROR_PREFIX}prompt is required`;

    const timeoutSeconds = Number.isFinite(params.timeoutSeconds) && params.timeoutSeconds > 0
      ? Math.floor(params.timeoutSeconds)
      : undefined;

    let res;
    try {
      res = await dispatcher.spawn(prompt, { timeoutSeconds });
    } catch (err) {
      // Transport-level: the dispatcher was unreachable, or the connection died. Distinguished from
      // `ok:false` below because the fix is different — this one is infrastructure, not the request.
      const msg = String((err && err.message) || err);
      log.warn({ err: msg }, 'sessions_spawn: dispatcher call failed');
      return `${SPAWN_ERROR_PREFIX}could not reach the dispatcher (${msg})`;
    }

    if (!res || res.ok !== true) {
      // The dispatcher's own words, verbatim. It knows why — depth cap, no budget left, the child
      // errored — and paraphrasing here would lose the distinction the model needs.
      return `${SPAWN_ERROR_PREFIX}${(res && res.error) || 'the spawned session did not complete'}`;
    }

    const text = typeof res.text === 'string' ? res.text : '';
    // An empty answer is a REAL outcome (a child that did work and said nothing), and returning ''
    // would read to the model as a broken tool. Name it instead.
    if (!text.trim()) return `${SPAWN_ERROR_PREFIX}the spawned session finished but returned no text`;
    return text;
  };
}

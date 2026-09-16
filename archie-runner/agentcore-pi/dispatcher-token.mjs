// The per-turn dispatcher credential, runtime side (archie-docs/archie-dispatcher-token-plan.md §8.9).
//
// The dispatcher mints a signed, scope-bound, expiring token for each turn and sends it on the
// invoke payload. This module is the one place that decides what the process's
// DISPATCHER_SHARED_SECRET holds for the duration of that turn.
//
// WHY AN ENV VAR AND NOT AN ARGUMENT. Three plugins, the cron tool and an unauditable population of
// ~230 workspace scripts all read `DISPATCHER_SHARED_SECRET` by name (D3). Rewriting the variable is
// what makes every one of them scope-bound without a single one of them changing. The cost is that
// any caller CAPTURING the value instead of reading it per call silently pins turn 1's token — which
// is why dispatcher-client.mjs and slack-reply-plugin now read it at call time.
//
// IN-PROCESS, NOT THE RUNTIME SPEC. A plain assignment to this Node process's environment: no
// UpdateAgentRuntime, no control-plane call, and so no warm-pool reset. Child processes inherit
// whatever is set when they are spawned (Pi's shell tool spreads `process.env` into every command),
// which is the intent — a shell command in this turn can reach the dispatcher as this scope, and
// only for this turn.
//
// Kept out of pi-adapter.mjs so it is unit-testable without booting the adapter, exactly as
// trace-context.mjs is.

/**
 * Point `DISPATCHER_SHARED_SECRET` at this turn's token.
 *
 * SET OR DELETE — never "leave whatever was there". A turn that arrives without a token must not
 * inherit the previous turn's: the dispatcher deleted that one when its turn ended, so the call
 * would fail as `revoked` — an ALARM reason meaning "a post-turn caller or a replay" — instead of
 * the honest "not configured". Absent must look absent.
 *
 * @param {object|null} input  the invoke payload's `input` (or the body itself, for the flat shape)
 * @param {object} env         the environment to mutate (process.env in production)
 * @returns {boolean}          whether a token was present
 */
export function applyDispatcherToken(input, env) {
  const token = (input && typeof input.dispatcherToken === 'string' && input.dispatcherToken) || null;
  if (token) env.DISPATCHER_SHARED_SECRET = token;
  else delete env.DISPATCHER_SHARED_SECRET;
  return Boolean(token);
}

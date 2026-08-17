// Turn outcome classification. Extracted from pi-adapter so it can be unit-tested — importing
// pi-adapter.mjs starts the HTTP server, so anything left inside it is untestable by construction.
//
// Multi-turn-per-session is OFF (the dispatcher serialises invokes per runtimeSessionId), so there is
// no `queued` outcome: a concurrent prompt never reaches Pi, and if one ever did — a rolling deploy
// running two dispatcher tasks — Pi throws and it lands here as a genuine `error`, which is what we
// want. A visible failure beats a silently swallowed message, which is what the previous behaviour
// produced (the rejection was logged at level 50 and then reported as `invoke complete`).
export function classifyTurn(out) {
  const o = out || {};
  if (o.errorMessage) return { outcome: 'error', finishReasons: 'error', isError: true };
  if (!o.text || o.text.trim() === '') return { outcome: 'empty', finishReasons: 'stop', isError: false };
  return { outcome: 'reply', finishReasons: o.stopReason || 'stop', isError: false };
}

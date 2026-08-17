// Shrink the model's tool surface to only grant-allowed tools — applied by the ADAPTER right
// before each session.prompt() (see runTurn), NOT via a Pi extension hook.
//
// Why the adapter and not an extension: in pi @0.61.1 the LLM request's tools come from
// context.tools, which prompt() snapshots from agent._state.tools at turn start (agent.js);
// before_provider_request/onPayload is a DEAD hook (agent-loop.js never calls config.onPayload),
// and a turn_start setActiveTools gets clobbered by Pi's active-tools recompute when connector/MCP
// register lazily. Calling session.setActiveToolsByName(...) immediately before prompt() is the
// one point that deterministically controls the snapshot. Dynamically-discovered tools register
// DURING a turn, so they're filtered from the NEXT turn onward; the tool_call PEP hook is the hard
// backstop for the in-turn gap. Uses the SILENT allow-check (no ToolCall telemetry).

/**
 * @param session AgentSession — must expose getAllTools() + setActiveToolsByName(names)
 * @param capabilityOf (toolName) => capability
 * @param allows       (capability) => bool   (makeAllowCheck — silent)
 * @param turnCtx      per-turn ctx (channel/agent, for the log)
 * @param log          optional logger
 */
export function applyToolFilter(session, { capabilityOf, allows, turnCtx, log = console }) {
  try {
    const all = (session.getAllTools?.() || []).map((t) => t.name);
    const active = all.filter((n) => allows(capabilityOf(n)));
    session.setActiveToolsByName(active);
    const hidden = all.filter((n) => !active.includes(n));
    if (hidden.length) {
      log.info(JSON.stringify({
        level: 'info', component: 'tool-filter', msg: 'tools filtered by grant',
        agent: turnCtx?.agent, channel: turnCtx?.channel, total: all.length, active: active.length, hidden,
      }));
    }
    return { total: all.length, active: active.length, hidden };
  } catch (e) {
    // Never fail a turn on the filter — the tool_call PEP hook is the guarantee.
    log.warn?.(JSON.stringify({ level: 'warn', component: 'tool-filter', msg: 'filter failed (block-on-call still enforces)', err: e?.message }));
    return { total: 0, active: 0, hidden: [] };
  }
}

// Runtime capability model for tool-permission enforcement (the PEP decision core).
//
// Two halves:
//   capabilityOf(toolName) → the logical capability a tool belongs to
//   decide(capability)     → allow/deny, given the channel's effective grants + the default policy
//
// Default policy is ALLOW-LIST + default-deny: baseline capabilities are on for everyone; every
// other capability (incl. anything unrecognised) falls through '*' to DENY and must be granted.
// Enforcement is ON from day one — the migration seeds grants from config (see config-resolver/
// caps-from-config.mjs), so legitimate usage is pre-granted; a deny at runtime is a real block.

export const CAPABILITY_DEFAULTS = {
  'fs.read': 'allow',
  memory: 'allow',
  cron: 'allow',
  otel: 'allow',
  connector: 'allow',
  health: 'allow', // benign plugin/MCP-server health & introspection tools (not data/action)
  'hindsight.read': 'allow',
  '*': 'deny',
};

export const policyFor = (cap) => CAPABILITY_DEFAULTS[cap] ?? CAPABILITY_DEFAULTS['*'];
export const isBaseline = (cap) => policyFor(cap) === 'allow';

// Build a resolver bound to THIS agent's configured MCP server prefixes (connector.extraMcpServers
// [].toolPrefix, e.g. ['demo_query_app','demo_warehouse']) and its registered tools' DECLARED capabilities.
//
// §8.6 capability-on-tool: `toolCaps` is a {toolName → capability} map derived from the registered
// custom/plugin tools (each tool declares `capability`; the adapter builds this from the built tool
// set — see pi-adapter). It is the SINGLE SOURCE for our own tools, so this resolver no longer keeps
// a hand-written per-tool switch (kills the ALSO_ALLOW_CAP/capabilityOf duplication + the alias bug).
// What remains here is only the residual we can't decorate: Pi-owned built-ins (their objects aren't
// ours), and dynamic/plugin surfaces with no static object (health, connector, demo_cache, MCP
// prefixes). An MCP tool whose prefix isn't configured → 'unknown' → deny.
export function makeCapabilityResolver({ mcpPrefixes = [], toolCaps = {} } = {}) {
  const prefixCaps = mcpPrefixes.map((p) => ({ p, cap: p === 'demo_warehouse' ? 'demo_warehouse' : p }));
  return function capabilityOf(toolName) {
    const n = String(toolName ?? '');
    // 1) Our tools DECLARE their capability (the single source; resolver built from the registry).
    if (Object.prototype.hasOwnProperty.call(toolCaps, n)) return toolCaps[n];
    // 2) Pi-owned built-ins we can't decorate — createAgentSession injects read/grep/find/ls/glob/
    //    tree/list (non-mutating → baseline fs.read), write/edit/apply_patch, and bash/exec/process/
    //    sessions_spawn (→ runtime).
    if (n === 'read' || n === 'grep' || n === 'find' || n === 'ls' || n === 'glob' || n === 'tree' || n === 'list') return 'fs.read';
    if (n === 'write' || n === 'edit' || n === 'apply_patch') return 'fs.write';
    if (n === 'bash' || n === 'exec' || n === 'process' || n === 'sessions_spawn') return 'runtime';
    // 3) Dynamic/plugin surfaces with no static object to decorate. Health must come BEFORE the
    //    server-prefix rules so e.g. demo_cache__health / demo_query_app__health aren't gated as data caps.
    if (n.endsWith('_plugin_health') || n.endsWith('__health')) return 'health';
    // NO RCE CARVE-OUT. There WAS a `connector.exec` capability here holding CONNECTOR_REMOTE_BASH_TOOL
    // and CONNECTOR_REMOTE_WORKBENCH — remote code execution outside our sandbox — behind a default-deny
    // grant. It was removed deliberately: it had no OpenClaw counterpart, so it was a restriction this
    // migration INVENTED rather than carried, and the migration's contract is parity first. Both tools
    // now resolve to baseline `connector` on the next line, which means any agent with the connector
    // plugin can reach them — exactly as it can today under OpenClaw.
    //
    // That is a real widening against the pre-deletion state of this file, and it is the accepted
    // trade. If it is ever re-restricted, do it as an ordinary forbidden slug group in the pin layer
    // (where the deny is declared per-environment and analysable) rather than as a bespoke branch here.
    // Everything connector → baseline: core CONNECTOR_* meta-tools, mcp_connector__* toolkit/status
    // tools, and connector_* plugin helpers.
    if (n.startsWith('CONNECTOR_') || n.startsWith('mcp_connector') || n.startsWith('connector_')) return 'connector';
    if (n.startsWith('demo_cache')) return 'demo_cache';
    for (const { p, cap } of prefixCaps) if (n.startsWith(p)) return cap; // demo_query_app__…, demo_warehouse__…, demo_diagram_app__…
    return 'unknown'; // → policyFor('unknown') → '*' → deny (fail-closed)
  };
}

// Silent allow-check (no telemetry) for the tool-list FILTER — restricting which tools the model
// sees must not emit per-tool ToolCall signals every turn (those count real calls). Same policy as
// decide(): baseline-allow OR granted.
export function makeAllowCheck({ grants }) {
  return (capability) => policyFor(capability) === 'allow' || grants.has(capability);
}

/**
 * The shared PEP decision, used by the tool_call hook AND the hindsight hooks.
 * @param grants   Set<string> — the channel's EFFECTIVE grants (baseline is applied here too)
 * @param onSignal (record) => void — telemetry sink (OTEL); never throws
 * @returns decide(capability, ctx) → boolean (allowed)
 */
export function makeDecider({ grants, onSignal = () => {} }) {
  return function decide(capability, ctx = {}) {
    const allowed = policyFor(capability) === 'allow' || grants.has(capability);
    try { onSignal({ ...ctx, capability, decision: allowed ? 'allow' : 'deny', baseline: isBaseline(capability) }); } catch { /* telemetry never fails a turn */ }
    return allowed;
  };
}

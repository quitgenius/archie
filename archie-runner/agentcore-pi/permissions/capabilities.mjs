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

// The only import here, and it is safe for the reason provider-registry.mjs relies on: tool-declarations
// is itself import-free, so pulling it in does not drag the Pi harness into a module the DISPATCHER also
// loads (grants.js:150). Derived rather than re-listed — a second hand-written list of write tool names is
// exactly the mirror that drifts, and drifting here means a write tool silently classified as a baseline
// read.
import { CUSTOM_TOOLS } from '../tool-declarations.mjs';

const HINDSIGHT_WRITE_TOOLS = new Set(
  Object.entries(CUSTOM_TOOLS).filter(([, cap]) => cap === 'hindsight.write').map(([name]) => name),
);

// THE CEDAR POLICY IS THE SINGLE DECLARATION of this set. `capGroups.baseline` in
// docker/policy/semantics.json is the source; `baseline.generated.mjs` is rendered from it by
// `archie policy codegen`, and `npm run check` fails the moment the two stop matching. There is no longer a
// hand-written mirror to keep in step — the previous version of this comment defended one, and the trade it
// described (codegen would add a build artifact whose staleness is a new silent failure mode) was resolved
// by R8: docker/policy/ is now a declared input of both images, so a policy edit moves both tags and a
// stale generated file cannot ship under a tag claiming to contain the new policy.
//
// WHY A GENERATED CONSTANT AND NOT THE COMPILED ROW. The row (AGENT#<scope>/POLICY) would be the purer
// source, but the baseline set must be answerable for a scope with NO row — every scope before its first
// policy deploy, and any scope the writer missed. Sourcing it from the row would make an absent row mean
// "deny everything", including `fs.read`: a normal rollout state would become a dead agent, and the
// layer's additive property would be gone.
//
// `'*': 'deny'` is NOT in the generated file, deliberately. It is not a capability — it is this module's
// fallthrough, read by policyFor below — and putting it in the policy's baseline group would demand a
// Capability entity named `*` and make check 2 permanently red.
import { BASELINE, IMMUTABLE } from './baseline.generated.mjs';

export const CAPABILITY_DEFAULTS = { ...BASELINE, '*': 'deny' };

// Re-exported so the runtime can name them (the boot log does) without a second list. `otel` and
// `hindsight.read` today — sandbox, 2026-08-18: "baseline allow across all agents with no way to get rid of
// it". The property is enforced at DEPLOY (check 8 rejects any forbid that reaches them), because `forbid`
// beats every `permit` and so it cannot be written as a Cedar statement.
export const IMMUTABLE_CAPABILITIES = IMMUTABLE;

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
// The namespace openclaw-mcp-auth-plugin registers its proxied MCP tools under
// (openclaw-mcp-auth-plugin/src/tool-cache.ts TOOL_PREFIX). Duplicated as a constant rather than
// imported: this module is on the boot path and the plugin ships as a bundled .cjs at a different
// in-image depth, so a cross-tree import here is the boot-crash class the deploy playbook warns
// about. capabilities.test.mjs pins the two together.
const MCP_AUTH_PREFIX = 'mcp_auth__';

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
    // HINDSIGHT KNOWLEDGE TOOLS. The prefix is SPLIT ACROSS TWO CAPABILITIES and the write side must be
    // listed FIRST, because a single `agent_knowledge_*` → hindsight.read rule would classify
    // agent_x0y8qlge, delete_page and ingest as BASELINE — ambient for every agent in the fleet, with the policy pin
    // bypassed entirely. That is the most dangerous possible failure of this function, so the write names
    // are enumerated explicitly rather than pattern-matched: a new write tool that someone forgets to add
    // here falls through to `hindsight.read` and is silently ambient, whereas a new READ tool that is
    // missed merely lands on hindsight.read, which is where it belongs anyway. The asymmetry decides the
    // order.
    //
    // The four read tools (recall + the three document tools) ARE built under Pi now
    // (knowledge-tools.mjs) and ride baseline hindsight.read per sandbox, 2026-08-18: "I want all agents to
    // have the hindsight read tools available". The seven write-side tools (knowledge-write-tools.mjs)
    // carry hindsight.write, which is policy-pinned — including list_pages/get_page/reflect, which are
    // reads but which OpenClaw bundles with the writes; see that module's header for why the bundle is
    // kept whole.
    if (HINDSIGHT_WRITE_TOOLS.has(n)) return 'hindsight.write';
    if (n.startsWith('agent_knowledge_')) return 'hindsight.read';
    // Configured MCP servers, matched by their `toolPrefix`. TWO NAMINGS, and both are load-bearing:
    //
    //   `demo_warehouse__execute_query`            — OpenClaw's naming, which this rule was written for
    //   `mcp_auth__demo_warehouse__execute_query`  — what openclaw-mcp-auth-plugin ACTUALLY registers under
    //                                          Pi (tool-cache.ts: `mcp_auth__<toolPrefix>__<name>`)
    //
    // Only the first was matched, so every mcp-auth tool resolved 'unknown' → deny, and the closure
    // invariant logged a hole per tool. That was invisible in prod until 2026-09-04 because a
    // separate bug meant these tools never registered at all (see prewarmCompatPlugins) — the
    // capability gap was sitting behind it, and fixing the race alone just moved the agents from
    // "tool not found" to "tool hidden by the grant filter". Same outcome for the member, different
    // log line, so match both spellings.
    for (const { p, cap } of prefixCaps) {
      if (n.startsWith(p) || n.startsWith(`${MCP_AUTH_PREFIX}${p}`)) return cap;
    }
    return 'unknown'; // → policyFor('unknown') → '*' → deny (fail-closed)
  };
}

// THE ONE RESOLUTION RULE, shared by the filter and the decider so they cannot drift apart.
//
// `table` is the compiled Cedar verdict row (permissions/policy-table.mjs) or null when this scope has
// none yet. With null this is byte-for-byte the pre-policy rule, which is what makes the layer additive
// and the Phase 0 baseline meaningful.
//
// Order matters: the TABLE is consulted first and wins outright. A `deny` there beats a grant row — that
// is what "policy-pinned" means, and it is the whole reason the row carries explicit denies instead of
// leaving non-members absent (see policy-table.mjs).
//
// `reason` exists because "deny" alone is unactionable. A capability denied by a PIN and one merely
// not granted are the same word in the log but opposite fixes — grant the second, edit the policy for
// the first — and without this field the only way to tell them apart is to go and read the policy.
/** @returns {{allowed: boolean, reason: string}} */
function resolve(capability, grants, table) {
  const v = table ? table.verdictFor(capability) : undefined;
  if (v === 'allow') return { allowed: true, reason: 'pinned' };
  if (v === 'deny') return { allowed: false, reason: table.denyAll ? 'policy-unusable' : 'policy-denied' };
  if (v === 'grant') {
    return grants.has(capability) ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'ungranted' };
  }
  // No verdict for this capability: today's rule. Either it is baseline (ambient for everyone) or it
  // needs a grant row.
  if (policyFor(capability) === 'allow') return { allowed: true, reason: 'ambient' };
  return grants.has(capability) ? { allowed: true, reason: 'granted' } : { allowed: false, reason: 'ungranted' };
}

// A MUTABLE HOLDER for the verdict table, for the same reason `grants` is a live mutable Set: the
// decider and the tool-filter both close over one reference at session build, and the handler refreshes
// it per turn so a policy change takes effect on the NEXT turn with no session rebuild or restart —
// including on a warm session, which reuses the same closure. Capturing the table BY VALUE here would
// pin every warm session to whatever the policy said when it was created, and a revoked pin would keep
// working for as long as the session stayed cached. Callers that never refresh (tests, one-shot checks)
// can just pass `{ table }`.
export const policyRef = (table = null) => ({ table });

// Silent allow-check (no telemetry) for the tool-list FILTER — restricting which tools the model
// sees must not emit per-tool ToolCall signals every turn (those count real calls). Same rule as
// decide() via `resolve`, so a pinned-away capability disappears from the tool surface rather than
// being offered and then refused mid-turn.
export function makeAllowCheck({ grants, policy = policyRef() }) {
  return (capability) => resolve(capability, grants, policy.table).allowed;
}

/**
 * The shared PEP decision, used by the tool_call hook AND the hindsight hooks.
 * @param grants   Set<string> — the channel's EFFECTIVE grants (baseline is applied here too)
 * @param policy   {table} holder — the compiled verdict table, or {table:null} when this scope has none
 * @param onSignal (record) => void — telemetry sink (OTEL); never throws
 * @returns decide(capability, ctx) → boolean (allowed)
 */
export function makeDecider({ grants, policy = policyRef(), onSignal = () => {} }) {
  return function decide(capability, ctx = {}) {
    const { allowed, reason } = resolve(capability, grants, policy.table);
    // `baseline` used to be computed here and was never emitted — onPermissionSignal dropped it, so it
    // has been dead since it was written. `reason` replaces it and IS emitted; it strictly subsumes it
    // (baseline ⟺ reason === 'ambient').
    try { onSignal({ ...ctx, capability, decision: allowed ? 'allow' : 'deny', reason }); } catch { /* telemetry never fails a turn */ }
    return allowed;
  };
}

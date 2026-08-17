// §8.1/8.2/8.5 — the declaration-only PROVIDER REGISTRY. Every tool that can reach the model surface
// belongs to exactly one PROVIDER: `core` (the Pi built-ins), a synthetic adapter-native provider
// (one per capability — memory/cron/otel/datadog/…), or a real plugin (connector/demo-cache/
// mcp-auth/hindsight). This is a MANIFEST, not a router (§8.2 "declaration wrapper, not a rewrite"):
// providers already return their own ToolDefinition[]; the registry only NAMES them, declares their
// capability surface + `mandatory` flag, and makes the CLOSURE INVARIANT checkable.
//
// It is DERIVED from the tools themselves (§8.6 single source): the synthetic providers come
// straight from each custom tool's declared `capability` (tool-registry.toolCapabilities). Only the
// Pi built-ins need a static list (Pi owns those objects — we can't decorate them), and the plugins
// are declared by capability surface because their tools are dynamic (prefix/toolkit-resolved).

import { toolCapabilities } from '../tool-registry.mjs';
import { isBaseline } from './capabilities.mjs';

// The canonical provider-name set. Kept in lockstep with config-resolver/providers.mjs's
// PROVIDER_NAMES by provider-registry.test.mjs (which imports BOTH) — NOT imported from there,
// because this module loads at agent BOOT and the config-resolver tree sits at a different relative
// depth in the built image than in the repo (permissions/ is flattened to /app/permissions/); a
// cross-tree import here would resolve in tests but module-not-found in the container → boot crash.
// NB `otel.fleet` is a synthetic provider like any other: this registry derives ONE provider per
// capability from the tools' declarations, and the otel_fleet_* tools declare `otel.fleet` (the
// fleet-wide + ad-hoc tier, grant-gated) while the otel_my_* tools declare baseline `otel`. Hence a
// dotted provider name — the first one; it is the capability, not a new plugin.
export const PROVIDER_NAMES = new Set([
  'core',
  'memory', 'cron', 'otel', 'otel.fleet', 'datadog', 'cloudwatch-logs', 'aws-person79b333-secrets', 'airflow', 'aws-readonly', 'sandbox-probe',
  'connector', 'demo-cache', 'mcp-auth', 'hindsight',
]);

// Pi owns the built-in tool objects, so a static tool→capability list is unavoidable here — the ONE
// place §8.6's "declare on the tool" can't reach. These are the `core` provider's tools (the same
// set the runtime resolver hard-codes in capabilities.mjs; kept in lockstep by the closure test).
export const CORE_TOOLS = {
  read: 'fs.read', grep: 'fs.read', find: 'fs.read', ls: 'fs.read', glob: 'fs.read', tree: 'fs.read', list: 'fs.read',
  write: 'fs.write', edit: 'fs.write', apply_patch: 'fs.write',
  bash: 'runtime', exec: 'runtime', process: 'runtime', sessions_spawn: 'runtime',
};

// Plugin providers — declared by capability SURFACE (their tools are dynamic, so there's no static
// name list). `mcp-auth` also owns the per-agent MCP server prefixes (demo_warehouse/demo_query_app/…) resolved at
// runtime. `hindsight` is a HOOKS plugin (§8.7) — no tool object at all — carried here purely for
// provenance + closure completeness.
const PLUGIN_PROVIDERS = {
  connector: { capabilities: ['connector', 'connector.exec', 'health'], kind: 'plugin' },
  'demo-cache': { capabilities: ['demo_cache'], kind: 'plugin' },
  'mcp-auth': { capabilities: ['demo_warehouse'], kind: 'plugin' }, // + per-agent extraMcpServers prefixes at runtime
  hindsight: { capabilities: ['hindsight.read', 'hindsight.write'], kind: 'plugin-hooks' },
};

/**
 * Build the provider manifest. Providers: { name → { name, kind, capabilities:Set, tools:Set,
 * mandatory:boolean } }. `mandatory` = un-uninstallable infra (§8.5): the `core` provider and the
 * baseline synthetic providers (memory/cron/otel) — they exist for auditability/closure, not
 * lifecycle. Everything else is optional (grant-gated, install/uninstall via a skill/plugin).
 */
export function buildProviderRegistry(cwd = '/tmp') {
  const providers = {};
  const ensure = (name, kind, mandatory) =>
    (providers[name] ||= { name, kind, capabilities: new Set(), tools: new Set(), mandatory });

  // core (mandatory) — the Pi built-ins.
  const core = ensure('core', 'core', true);
  for (const [tool, cap] of Object.entries(CORE_TOOLS)) { core.tools.add(tool); core.capabilities.add(cap); }

  // synthetic adapter-native — ONE provider per capability, DERIVED from the tools' own declarations
  // (§8.6). Baseline caps (memory/cron/otel) are mandatory infra; the rest are optional grant-gated.
  for (const [tool, cap] of Object.entries(toolCapabilities(cwd))) {
    const p = ensure(cap, 'synthetic', isBaseline(cap));
    p.tools.add(tool); p.capabilities.add(cap);
  }

  // plugin providers — declared by capability surface (dynamic tools). Always optional.
  for (const [name, def] of Object.entries(PLUGIN_PROVIDERS)) {
    const p = ensure(name, def.kind, false);
    for (const c of def.capabilities) p.capabilities.add(c);
  }

  return providers;
}

/**
 * The provider that brings a capability (the identity the grant `sources` reference). A capability
 * that resolved (≠ 'unknown') but that no declared provider claims can only have come from a
 * per-agent MCP server prefix (demo_query_app/demo_warehouse→demo_warehouse/…) → `mcp-auth`.
 */
export function providerForCapability(registry, cap) {
  if (!cap || cap === 'unknown') return null;
  for (const p of Object.values(registry)) if (p.capabilities.has(cap)) return p.name;
  return 'mcp-auth';
}

/**
 * THE CLOSURE CHECK (§8.0). Given the tool NAMES an agent surfaces and its capability resolver,
 * every tool must resolve to a concrete capability — a tool whose cap is 'unknown' matched no
 * provider rule, i.e. it reached the surface with NO provider, which the invariant forbids. Returns
 * { ok, holes:[{tool, cap}], byProvider }.
 */
export function checkClosure(toolNames, { capabilityOf, registry }) {
  const holes = [];
  const byProvider = {};
  for (const n of toolNames) {
    const cap = capabilityOf(n);
    if (!cap || cap === 'unknown') { holes.push({ tool: n, cap: cap || null }); continue; }
    const prov = providerForCapability(registry, cap);
    (byProvider[prov] ||= []).push(n);
  }
  return { ok: holes.length === 0, holes, byProvider };
}

/** Throwing form for tests/BDD — a hole is a hard failure. Boot uses checkClosure + a loud log. */
export function assertClosure(toolNames, ctx) {
  const { ok, holes } = checkClosure(toolNames, ctx);
  if (!ok) {
    throw new Error(`closure invariant violated — tool(s) with no provider: ${holes.map((h) => `${h.tool}(${h.cap})`).join(', ')}`);
  }
  return true;
}

/** Sanity: the tool-derived registry's provider names are all known to the shippable data list. */
export function unknownProviders(registry) {
  return Object.keys(registry).filter((n) => !PROVIDER_NAMES.has(n));
}

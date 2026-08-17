// §8.1/8.2/8.5 — the declaration-only PROVIDER REGISTRY. Every tool that can reach the model surface
// belongs to exactly one PROVIDER: `core` (the Pi built-ins), a synthetic adapter-native provider
// (one per capability — memory/cron/otel/datadog/…), or a real plugin (connector/demo-cache/
// mcp-auth/hindsight). This is a MANIFEST, not a router (§8.2 "declaration wrapper, not a rewrite"):
// providers already return their own ToolDefinition[]; the registry only NAMES them, declares their
// capability surface + `mandatory` flag, and makes the CLOSURE INVARIANT checkable.
//
// It is DERIVED from the tool DECLARATIONS (§8.6 single source): the synthetic providers come
// straight from each custom tool's declared `capability`. Only the Pi built-ins need a static list
// (Pi owns those objects — we can't decorate them), and the plugins are declared by capability
// surface because their tools are dynamic (prefix/toolkit-resolved).
//
// IT READS tool-declarations.mjs, NOT tool-registry.mjs, AND THAT IS LOAD-BEARING. tool-registry
// imports every build*Tools factory, each of which does `const T = piAi.Type` at module scope, and
// pi-runtime.mjs top-level-awaits the Pi packages — so importing it dragged the entire Pi harness in
// behind a manifest. With declarations as data this module has no heavy dependency at all, which is
// what lets the dispatcher use it instead of mirroring these facts by hand.
import { CORE_TOOLS, CUSTOM_TOOLS, PLUGIN_PROVIDERS, PROVIDER_NAMES } from '../tool-declarations.mjs';
import { isBaseline } from './capabilities.mjs';

// Re-exported from the declarations, where it now lives as the SINGLE copy — see the note there for
// why there used to be two and a lockstep test holding them together.
export { PROVIDER_NAMES };

/**
 * Build the provider manifest. Providers: { name → { name, kind, capabilities:Set, tools:Set,
 * mandatory:boolean } }. `mandatory` = un-uninstallable infra (§8.5): the `core` provider and the
 * baseline synthetic providers (memory/cron/otel) — they exist for auditability/closure, not
 * lifecycle. Everything else is optional (grant-gated, install/uninstall via a skill/plugin).
 */
export function buildProviderRegistry() {
  const providers = {};
  const ensure = (name, kind, mandatory) =>
    (providers[name] ||= { name, kind, capabilities: new Set(), tools: new Set(), mandatory });

  // core (mandatory) — the Pi built-ins.
  const core = ensure('core', 'core', true);
  for (const [tool, cap] of Object.entries(CORE_TOOLS)) { core.tools.add(tool); core.capabilities.add(cap); }

  // synthetic adapter-native — ONE provider per capability, DERIVED from the tools' own declarations
  // (§8.6). Baseline caps (memory/cron/otel) are mandatory infra; the rest are optional grant-gated.
  for (const [tool, cap] of Object.entries(CUSTOM_TOOLS)) {
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

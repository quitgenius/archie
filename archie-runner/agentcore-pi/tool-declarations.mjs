// THE STATIC TOOL SURFACE, as data. Zero imports, and that is the whole point of the file.
//
// WHY IT EXISTS. §8.6 puts a tool's `capability` on the tool object, which reads well but means the
// only way to learn "what capability does `airflow` need" was to CONSTRUCT the tool — every
// build*Tools factory, with a permissive allow-set, against a throwaway cwd. Two consequences fell
// out of that:
//
//   1. Every tool module does `const T = piAi.Type` at module scope to build its parameter schema, so
//      importing one loads the Pi harness (pi-runtime.mjs does a TOP-LEVEL await import of
//      @mariozechner/pi-ai). Anything wanting the map paid for the whole agent runtime.
//   2. The dispatcher cannot pay that, so the same facts got mirrored by hand elsewhere —
//      config-resolver/providers.mjs — with a lockstep test to stop the copies drifting.
//
// Declarations are data, so they live in data. The tool modules keep the behaviour (description,
// parameters, execute); this file owns the two fields everything else actually asks about. Now
// tool-registry, provider-registry and the dispatcher all read the same list, none of them constructs
// anything, and none of them imports Pi.
//
// KEEP IN SYNC WITH THE FACTORIES. Nothing here is enforced by the type system, so
// tool-registry.test.mjs builds every tool for real and asserts the built {name, capability} matches
// this file exactly, in both directions — a tool built but not declared, or declared but not built,
// fails. That test is the reason this file can be trusted.

// ── Pi's built-ins ───────────────────────────────────────────────────────────────────────────────
// Pi owns these tool objects, so there is nothing to decorate and never was: a static list is the
// only option. `capabilities.mjs`'s resolver hard-codes the same names (it must — it answers per
// tool NAME at call time, with no registry); provider-registry.test.mjs holds the two together.
//
// Non-mutating reads are baseline `fs.read`; the mutating trio is `fs.write`; the shell/process
// group is `runtime`, the broadest grant in the model.
export const CORE_TOOLS = {
  read: 'fs.read',
  grep: 'fs.read',
  find: 'fs.read',
  ls: 'fs.read',
  glob: 'fs.read',
  tree: 'fs.read',
  list: 'fs.read',
  write: 'fs.write',
  edit: 'fs.write',
  apply_patch: 'fs.write',
  bash: 'runtime',
  exec: 'runtime',
  process: 'runtime',
  sessions_spawn: 'runtime',
};

// ── Our adapter-native tools ─────────────────────────────────────────────────────────────────────
// Grouped by the module that builds them, in allCustomTools() order, so this reads as a table of
// contents for the tool tree. The capability is what the PEP gates on: `memory`/`cron`/`otel` are
// baseline (ambient, no grant), everything else is default-deny and needs an explicit grant.
export const CUSTOM_TOOLS = {
  // memory-tool.mjs — baseline
  memory_search: 'memory',
  memory_get: 'memory',

  // knowledge-tools.mjs — the READ-ONLY Hindsight surface, ported from the Pelago hindsight fork's
  // OpenClaw plugin (READ_ONLY_TOOL_NAMES). All four are reads and all ride baseline `hindsight.read`,
  // so every agent has them with no grant.
  agent_knowledge_recall: 'hindsight.read',
  agent_knowledge_list_documents: 'hindsight.read',
  agent_knowledge_get_document: 'hindsight.read',
  agent_knowledge_search_documents: 'hindsight.read',

  // knowledge-write-tools.mjs — the rest of the SDK's set (TOOL_NAMES minus recall), all on
  // `hindsight.write`, which is POLICY-PINNED: no grant row can confer it, only membership of
  // pin.hindsight.write.
  //
  // THREE OF THESE ARE READS (list_pages, get_page, reflect) and still carry the write capability,
  // because OpenClaw registers the whole set behind one flag and the read-only bundle deliberately omits
  // the page surface. Splitting them would widen every agent in the fleet' access to consolidated pages, which is a
  // bigger change than porting the writes — see knowledge-write-tools.mjs's header.
  agent_knowledge_list_pages: 'hindsight.write',
  agent_knowledge_get_page: 'hindsight.write',
  agent_knowledge_agent_x0y8qlge: 'hindsight.write',
  agent_knowledge_update_page: 'hindsight.write',
  agent_knowledge_delete_page: 'hindsight.write',
  agent_knowledge_reflect: 'hindsight.write',
  agent_knowledge_ingest: 'hindsight.write',

  // cron-tool.mjs — baseline
  cron: 'cron',

  // otel-tool.mjs — TWO TIERS, and the split is deliberate: otel_my_* is scope-pinned to the agent's
  // own telemetry (baseline), otel_fleet_* reads EVERY agent's and can run an arbitrary Logs Insights
  // query, so it is its own grant-gated capability.
  otel_my_turns: 'otel',
  otel_my_tools: 'otel',
  otel_my_trace: 'otel',
  otel_my_crons: 'otel',
  otel_my_runtime: 'otel',
  otel_fleet_query: 'otel.fleet',
  otel_fleet_metric: 'otel.fleet',
  otel_fleet_trace: 'otel.fleet',

  // datadog-tool.mjs
  datadog: 'datadog',

  // cloudwatch-logs-tool.mjs / aws-person79b333-secrets-tool.mjs / airflow-tool.mjs / aws-readonly-tool.mjs
  // — each assumes a cross-account reader in-process, hence one grant-gated capability each.
  cloudwatch_logs: 'cloudwatch-logs',
  aws_person79b333_secrets: 'aws-person79b333-secrets',
  airflow: 'airflow',
  aws_readonly: 'aws-readonly',

  // sandbox-probe-tool.mjs — TEST-ONLY, for the derived-role IAM harness.
  sandbox_probe: 'sandbox-probe',
};

// ── Plugin providers ─────────────────────────────────────────────────────────────────────────────
// Declared by capability SURFACE rather than tool list, because their tools are resolved per agent at
// runtime: connector's from its connected toolkits, mcp-auth's from its configured MCP servers. An
// empty tool list here is therefore correct and NOT a gap — consumers flag these as dynamic rather
// than reporting "0 tools".
//
// connector surfaces ONE capability, not two. A `connector.exec` carve-out for
// CONNECTOR_REMOTE_BASH_TOOL / CONNECTOR_REMOTE_WORKBENCH was removed for OpenClaw parity — see the
// note in permissions/capabilities.mjs for why, and for where to put the deny if it comes back.
// `demo_warehouse` is the internal DemoWarehouse MCP server; other per-agent prefixes (demo_query_app, demo_diagram_app, …) are
// NOT here, because they come from each agent's own connector.extraMcpServers and no static list can
// know them.
export const PLUGIN_PROVIDERS = {
  connector: { capabilities: ['connector', 'health'], kind: 'plugin' },
  'demo-cache': { capabilities: ['demo_cache'], kind: 'plugin' },
  'mcp-auth': { capabilities: ['demo_warehouse'], kind: 'plugin' },
  hindsight: { capabilities: ['hindsight.read', 'hindsight.write'], kind: 'plugin-hooks' },
};

// ── Provider names ───────────────────────────────────────────────────────────────────────────────
// The canonical provider-name set — the identity a grant's `sources` reference.
//
// This used to exist TWICE: here (as provider-registry's own copy, loaded at agent boot) and in
// config-resolver/providers.mjs (the shippable copy the dispatcher used), with a lockstep test whose
// only job was to stop them drifting. The duplication was forced by the old dependency shape —
// provider-registry could not be imported outside the agent image because it pulled in Pi. It can
// now, so there is one copy, and the test that guarded the copies is gone with them.
//
// NB `otel.fleet` is a synthetic provider like any other: the registry derives ONE provider per
// capability, and the otel_fleet_* tools declare `otel.fleet` (the fleet-wide + ad-hoc tier,
// grant-gated) while otel_my_* declare baseline `otel`. Hence a dotted provider name — it is the
// capability, not a new plugin.
export const PROVIDER_NAMES = new Set([
  'core',
  'memory', 'cron', 'otel', 'otel.fleet', 'datadog', 'cloudwatch-logs', 'aws-person79b333-secrets', 'airflow', 'aws-readonly', 'sandbox-probe',
  // `hindsight.read` is a SYNTHETIC provider (the four agent_knowledge_* tools) and sits alongside the
  // `hindsight` PLUGIN provider, which covers the same capability from the hook side (recall injection).
  // Two providers for one capability is not a conflict here: they are different tool surfaces, and the
  // registry's job is closure — every capability having a provider — not exclusivity.
  'hindsight.read',
  // `hindsight.write` is the SDK's page/ingest/reflect surface (knowledge-write-tools.mjs). A synthetic
  // provider like hindsight.read, and it needs to be here for the same reason: provider-registry's closure
  // check requires every capability that has tools to have a provider, and a capability with tools and no
  // provider is a tool the dispatcher cannot describe or grant against.
  'hindsight.write',
  'connector', 'demo-cache', 'mcp-auth', 'hindsight',
]);

// The plugin-enable tokens that appear as `requires.plugins` keys (and the equivalent alsoAllow
// plugin-enable tokens) → the provider they enable. Only two plugins EVER appear in the fleet
// (demo-cache, mcp-auth, §8.3); the others are listed for completeness so a stray token still
// resolves rather than throwing spuriously.
export const PLUGIN_TOKEN_PROVIDER = {
  'demo-cache-plugin': 'demo-cache',
  'openclaw-mcp-auth-plugin': 'mcp-auth',
  'mcp-auth-plugin': 'mcp-auth', // bare-id alias (the G7 mcp-auth alias)
  'connector-session-plugin': 'connector',
  'hindsight-openclaw': 'hindsight',
};

/**
 * Resolve a skill's `requires.plugins` to the set of PROVIDER names the install depends on (§8.3).
 * An unknown plugin token → throw: a skill that needs a provider we don't recognise must fail the
 * install loudly, not silently install a skill whose tools can never appear (the exact drift §8.3
 * closes). `requires.alsoAllow`/`requires.connectorToolkits` are NOT resolved here — those map to
 * caps via caps-from-config's ALSO_ALLOW_CAP; this function is only about the `plugins` edge.
 * @param {object} requires  a skill's `requires` block ({ plugins?: {name: config} })
 * @returns {string[]} sorted provider names the install transitively pulls in
 * @throws if a required plugin token maps to no known provider
 */
export function resolveRequiredProviders(requires) {
  const out = new Set();
  const unknown = [];
  for (const key of Object.keys(requires?.plugins ?? {})) {
    const prov = PLUGIN_TOKEN_PROVIDER[key];
    if (!prov || !PROVIDER_NAMES.has(prov)) { unknown.push(key); continue; }
    out.add(prov);
  }
  if (unknown.length) {
    throw new Error(
      `transitive install: skill requires unknown provider(s) [${unknown.join(', ')}] — `
        + 'classify the plugin token in tool-declarations.PLUGIN_TOKEN_PROVIDER before installing',
    );
  }
  return [...out].sort();
}

/** Every statically-known tool → its capability (built-ins ∪ ours). */
export const ALL_TOOLS = { ...CORE_TOOLS, ...CUSTOM_TOOLS };

/**
 * The permissive allow-set that makes every build*Tools factory yield its tools, for the tests that
 * construct them. DERIVED, where it used to be a hand-maintained literal (`ALL_CAPS`) that had to
 * list both flavours by hand: the factories gate on raw allow-set TOKENS — `memory_search`,
 * `memory_get` — which are not always the capability the tool declares (`memory`). Taking the union
 * of both means adding a tool cannot leave this list behind.
 */
export const permissiveAllowSet = () => new Set([
  ...Object.keys(CUSTOM_TOOLS),
  ...Object.values(CUSTOM_TOOLS),
]);

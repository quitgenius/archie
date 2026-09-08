// Map a resolved agent entry (config-resolver/resolve-config.mjs) -> Pi createAgentSession inputs.
// Direct-EFS: cwd/sessions ARE the EFS mount (no copy-sync). Covers model, cwd, tool allow-list ->
// Pi built-in tools, bootstrap context-file auto-injection (the primary memory path), and the
// plugin manifest.
//
// `cfg`/`agent` here are the two halves of what the resolver returns. They used to arrive as a parsed
// `openclaw.json` — the OpenClaw-shaped envelope the boot path rendered to a file and read back — so
// the field paths below (`cfg.plugins.entries`, `agent.tools.alsoAllow`) are that shape's, minus the
// keys nothing read. The file and the shape's generator are both gone; the field names stayed.

import fs from 'node:fs';
import path from 'node:path';
import { pca } from './pi-runtime.mjs';
import { buildMemoryTools } from './memory-tool.mjs';
import { buildKnowledgeTools } from './knowledge-tools.mjs';
import { buildKnowledgeWriteTools } from './knowledge-write-tools.mjs';
import { buildCronTools } from './cron-tool.mjs';
import { buildOtelTools } from './otel-tool.mjs';
import { buildSandboxProbeTools } from './sandbox-probe-tool.mjs';

// ── Plugin manifest (§2.5) ──────────────────────────────────────────────────
// The compat host is OPTIONAL: only plugins we ship a Pi bundle for are routed through
// it; hindsight is Pi-NATIVE (own extension); everything else is logged as unsupported
// (no silent gaps).
const COMPAT_PLUGINS = new Set(['connector-session-plugin', 'demo-cache-plugin', 'openclaw-mcp-auth-plugin', 'slack-reply-plugin']); // have an esbuild bundle
const DROPPED_PLUGINS = new Set([]); // empty today; the mechanism stays so a future drop is REPORTED, never silent

// Attached to EVERY agent, whatever its per-agent plugin config says. `slack_send` is the only
// way a Pi agent can post to Slack out-of-band (cron jobs, cross-posting) as ARCHIE'S OWN app.
// Without it the model reaches for Connector's slack toolkit, which posts as the *Connector* app —
// and Slack resolves a bare user id against the POSTING app, so "DM an operator" landed in Connector's DM
// with an operator rather than ours. Live-caught 2026-09-03; see also the 2026-08-12 bash+curl incident
// below, which was the same missing tool failing a different way.
const ALWAYS_ATTACH_PLUGINS = ['slack-reply-plugin'];
const MEMORY_SLOT_NATIVE = 'hindsight-openclaw'; // handled by hindsight-extension.mjs

// What a plugin PROVIDES, so the boot warning can name the missing tool rather than the plugin
// nobody remembers the contents of. Only needs entries for plugins we drop or cannot load.
const PLUGIN_TOOLS = {
  'slack-reply-plugin': ['slack_send'],
};

// Auto-injected bootstrap context files (verified in OpenClaw source). MEMORY.md/
// memory.md are alternates. Subagent/cron sessions get only the MINIMAL set.
const BOOTSTRAP_ORDER = ['SOUL.md', 'IDENTITY.md', 'USER.md', 'AGENTS.md', 'TOOLS.md', 'HEARTBEAT.md', 'BOOTSTRAP.md', 'MEMORY.md', 'memory.md'];
const MINIMAL = new Set(['AGENTS.md', 'TOOLS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md']);

const GROUPS = {
  'group:memory': ['memory_search', 'memory_get'],
  'group:fs': ['read', 'write', 'edit', 'apply_patch'],
  'group:runtime': ['exec', 'process'],
};

// NO selectAgent. It picked this agent out of `cfg.agents.list`, and that list only ever existed
// because the boot path serialised the config to a file: the resolver builds ONE agent, and the writer
// wrapped it as `list: [agent]` purely so this function had the multi-agent shape it expected on the
// way back in. With the file gone the resolver returns `{ agent, cfg }` and there is nothing to select
// — a lookup that can only return its single input is a place for it to return the wrong thing.

export function resolveModelSpec(agent, cfg) {
  const spec = String(agent?.model || cfg?.agents?.defaults?.model?.primary || '');
  const i = spec.indexOf('/');
  return i < 0 ? { provider: 'amazon-bedrock', id: spec } : { provider: spec.slice(0, i), id: spec.slice(i + 1) };
}

// The resolved tool allow-set: alsoAllow with group:* expanded. `tools.profile` is an
// OpenClaw-era field that Pi ignores — its 'messaging' base (sessions_*/message) maps to
// gateway tools that don't exist under single-session Pi, and 'coding' is unused (every
// agent is 'messaging'). The field is left in the config/DDB data (inert; stripping it
// would break the migration byte-parity gate) but is no longer read here.
export function resolveAllowedTools(agent) {
  const also = agent?.tools?.alsoAllow || [];
  return new Set(also.flatMap((t) => GROUPS[t] || [t]));
}

// Pi BUILT-IN tools for the allow-set (phase 1). memory_search/memory_get (FTS),
// agent_knowledge_* (hindsight) and connector/slack-reply are provided
// by the plugin shim / FTS tool in later phases — NOT here. Crucially: we pass ONLY
// the resolved set, overriding Pi's default codingTools (a messaging agent must not
// silently gain bash/write).
export function buildBuiltinTools(allow, cwd) {
  const t = [];
  if (allow.has('read')) t.push(pca.createReadTool(cwd));
  if (allow.has('write')) t.push(pca.createWriteTool(cwd));
  if (allow.has('edit')) t.push(pca.createEditTool(cwd));
  if ((allow.has('exec') || allow.has('bash')) && pca.createBashTool) t.push(pca.createBashTool(cwd));
  return t.filter(Boolean);
}

// Custom (non-built-in) tools for the allow-set: memory_search/memory_get FTS now;
// plugin tools (connector/hindsight/slack-reply/pdf/agent_knowledge_*) are added by the
// plugin shim in a later phase. Returned as Pi ToolDefinition[] (createAgentSession customTools).
// `ctx` carries per-session context the tools need — today just { sessionKey }, which the cron
// tool stamps onto jobs so the dispatcher can derive the job's channel (§12c). Optional so every
// other tool builder is unaffected and existing callers keep working.
export function buildCustomTools(allow, cwd, ctx = {}) {
  // buildOtelTools takes no allow-set: the OTEL self-observability tools are fleet-wide +
  // always-on (every agent can introspect its own telemetry), gated only by OTEL_TOOLS_DISABLED.
  //
  // buildKnowledgeTools likewise takes no allow-set — sandbox, 2026-08-18: "I want all agents to have the
  // hindsight read tools available". It is gated on CONFIG instead (`ctx.hindsight`): with no apiUrl or
  // bankId it returns [], because four tools that can only throw are worse than none. pi-adapter passes
  // the org-bank config it already resolves in initHindsight.
  return [
    ...buildMemoryTools(allow, cwd), ...buildKnowledgeTools(ctx.hindsight || {}),
    // The write-side knowledge tools. Config-gated like the reads (no apiUrl/bankId → []), but NOT
    // baseline: every one declares `capability: 'hindsight.write'`, which is policy-pinned, so
    // applyToolFilter drops them from the model's surface for any scope whose verdict is not `allow` and
    // the tool_call PEP denies a call that arrives anyway.
    ...buildKnowledgeWriteTools(ctx.hindsight || {}),
    ...buildCronTools(allow, ctx), ...buildOtelTools(),
    // §7.3/7.4 ported AWS skills (grant-gated; each assumes a cross-account reader in-process).
    ...buildSandboxProbeTools(allow),
  ];
}

// Read + concatenate the bootstrap context files from the agent workspace (direct off
// EFS). This is how memory PRIMARILY reaches the model (MEMORY.md etc. in the prompt),
// independent of the memory_search tool. minimal=true for subagent/cron sessions.
export function readBootstrapContext(workspaceDir, { minimal = false } = {}) {
  const names = minimal ? BOOTSTRAP_ORDER.filter((n) => MINIMAL.has(n)) : BOOTSTRAP_ORDER;
  const parts = [];
  let memoryTaken = false;
  for (const n of names) {
    if ((n === 'MEMORY.md' || n === 'memory.md') && memoryTaken) continue;
    try {
      const txt = fs.readFileSync(path.join(workspaceDir, n), 'utf8');
      if (txt.trim()) {
        parts.push(`<context-file name="${n}">\n${txt.trim()}\n</context-file>`);
        if (n === 'MEMORY.md' || n === 'memory.md') memoryTaken = true;
      }
    } catch { /* file absent — normal */ }
  }
  return parts.join('\n\n');
}

// Build the resource loader: injects bootstrap context into the system prompt, wires the
// compat + hindsight extension factories, and loads skills from the resolved skill dirs
// (Pi-native skills, #14c). Disk auto-discovery of extensions/prompts/themes stays off —
// only our explicit factories run.
export function makeResourceLoader({ cwd, bootstrap, extensionFactories = [], skillPaths = [] }) {
  return new pca.DefaultResourceLoader({
    cwd,
    appendSystemPrompt: bootstrap || undefined,
    extensionFactories,
    additionalSkillPaths: skillPaths,
    noSkills: skillPaths.length === 0,
    noPromptTemplates: true,
    noThemes: true,
  });
}

// Resolve the plugin manifest from the resolved config's `cfg.plugins` (BASE_PLUGINS + this agent's
// slice — see config-resolver/boot-config.mjs and plugin-slice.mjs). Returns the
// intent; the adapter maps compat ids -> bundle paths (existence-checked there).
//   { hindsight: {id, config}|null, compat: [{id, pluginConfig}], skipped: [{id, reason}] }
export function resolvePluginManifest(cfg) {
  const entries = cfg?.plugins?.entries || {};
  const allow = new Set(cfg?.plugins?.allow || []);
  const memorySlot = cfg?.plugins?.slots?.memory;
  const hindsight = memorySlot === MEMORY_SLOT_NATIVE && entries[MEMORY_SLOT_NATIVE]
    ? { id: MEMORY_SLOT_NATIVE, config: entries[MEMORY_SLOT_NATIVE].config || {} }
    : null;
  const compat = [];
  const skipped = [];
  for (const id of Object.keys(entries)) {
    if (id === MEMORY_SLOT_NATIVE) continue; // native, handled above
    if (DROPPED_PLUGINS.has(id)) { skipped.push({ id, reason: 'dropped-under-pi' }); continue; }
    if (!allow.has(id)) { skipped.push({ id, reason: 'not-allowed' }); continue; }
    if (COMPAT_PLUGINS.has(id)) compat.push({ id, pluginConfig: entries[id].config || {} });
    else skipped.push({ id, reason: 'no-pi-support-yet' });
  }
  // Fleet-wide attachments land regardless of per-agent config (and regardless of `allow`, which
  // is why this runs AFTER the loop rather than seeding `entries`). Deduped: an agent that does
  // name the plugin has already pushed it above.
  for (const id of ALWAYS_ATTACH_PLUGINS) {
    if (!compat.some((c) => c.id === id)) compat.push({ id, pluginConfig: entries[id]?.config || {} });
  }
  return { hindsight, compat, skipped };
}

/**
 * Plugins the AGENT is allowed to use that Pi will not load — the gap `skipped` cannot see.
 *
 * Found the hard way, 2026-08-12. agent-xx9aff's allow-list names `slack-reply-plugin`
 * (which registers `slack_send`), Pi drops it by design, and boot logged `skipped: []` — a clean
 * board. `skipped` is built by walking `cfg.plugins.entries`, and this agent carries the plugin
 * only in `tools.alsoAllow`, so the drop was never evaluated and never reported.
 *
 * The cost of that silence: a hydrated cron job asked the agent to post to Slack, the tool was
 * absent, and the agent improvised with `bash` + `curl` (not in the image either — exit 127),
 * looping for minutes per turn while the scheduler skipped overlapping ticks. Nothing anywhere
 * said "the tool you need does not exist".
 *
 * Reports the TOOLS as well as the plugin id, because "slack-reply-plugin is dropped" only means
 * something to someone who already knows it provides `slack_send`.
 */
/**
 * The MCP server tool-prefixes this agent's proxied MCP tools will be named with — the input the
 * capability resolver keys on (`mcp_auth__<prefix>__<tool>` → that server's capability).
 *
 * READ FROM THE SAME SLICE THE PLUGIN READS. openclaw-mcp-auth-plugin names its tools from
 * `plugins.entries['openclaw-mcp-auth-plugin'].config.agents[<id>].mcpServers[].toolPrefix`, so
 * anything else deriving the prefixes from a different field can silently disagree with the names
 * that actually get registered — and did:
 *
 *   pi-adapter read `agent.connector.extraMcpServers`, but boot-config.mjs sets `agent.connector` to
 *   the CONNECTOR-SESSION-PLUGIN slice (`{cronEntityId, toolkits}`), which has no extraMcpServers.
 *   So MCP_PREFIXES was ALWAYS `[]`, every `mcp_auth__*` tool resolved 'unknown' → deny, and the
 *   closure invariant logged a hole per tool. Verified against the live prod config for
 *   dm-urbnxvak3l5 on 2026-09-04: `agent.connector` keys were exactly [cronEntityId, toolkits],
 *   while the mcp-auth slice carried toolPrefix demo_warehouse + demo_query_app.
 *
 * `caps-from-config.mjs` reads the RAW agent config (which does carry `connector.extraMcpServers`)
 * and derived the `demo_warehouse`/`demo_query_app` GRANTS correctly from it — which is why the grants were right and
 * only the runtime resolution was wrong. Two readers of one fact, two different inputs.
 *
 * The `agent.connector.extraMcpServers` read is kept as a fallback: harmless where the field is
 * absent, and it keeps working for any caller that passes the raw config shape.
 */
export function resolveMcpPrefixes(agent, cfg) {
  const fromPlugin = cfg?.plugins?.entries?.['openclaw-mcp-auth-plugin']?.config?.agents?.[agent?.id]?.mcpServers ?? [];
  const fromAgent = agent?.connector?.extraMcpServers ?? [];
  const prefixes = [...fromPlugin, ...fromAgent].map((s) => s?.toolPrefix).filter(Boolean);
  return [...new Set(prefixes)];
}

export function findUnavailablePlugins(allow, manifest) {
  const loaded = new Set([
    ...(manifest?.compat || []).map((c) => c.id),
    ...(manifest?.hindsight ? [manifest.hindsight.id] : []),
  ]);
  const out = [];
  for (const id of allow || []) {
    if (loaded.has(id)) continue;
    // Only plugin ids are interesting here; the allow-set is mostly builtin tool names, which are
    // resolved elsewhere and are not expected to appear in the plugin manifest at all.
    const isPlugin = DROPPED_PLUGINS.has(id) || COMPAT_PLUGINS.has(id) || id.endsWith('-plugin');
    if (!isPlugin) continue;
    out.push({
      id,
      reason: DROPPED_PLUGINS.has(id) ? 'dropped-under-pi' : 'not-loaded',
      ...(PLUGIN_TOOLS[id] ? { missingTools: PLUGIN_TOOLS[id] } : {}),
    });
  }
  return out;
}

// List the individual skill dirs directly under `dir` (a skill = a dir containing SKILL.md).
// The adapter calls this on the EFS skills dir it materialized from DDB — pointing Pi at the
// live EFS copy, independent of the config's (now vestigial) skills.load.extraDirs.
export function skillDirsUnder(dir) {
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
  return names.map((n) => path.join(dir, n)).filter((d) => fs.existsSync(path.join(d, 'SKILL.md')));
}

// Resolve Pi skill paths from cfg.skills.load.extraDirs: each extraDir may hold multiple
// skill subdirs. Return the individual skill dirs. (Kept for parity/tests; the AgentCore boot
// now sources skills from EFS via skillDirsUnder — see pi-adapter ensureEfsReady.)
export function resolveSkillPaths(cfg) {
  return (cfg?.skills?.load?.extraDirs || []).flatMap((dir) => skillDirsUnder(dir));
}

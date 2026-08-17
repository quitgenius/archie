// Map a generated openclaw.json agent entry -> Pi createAgentSession inputs.
// Ship-fast approach (pi-core-migration-plan §3.7): keep boot-time pull-config +
// openclaw.json; map the resolved config to Pi in-process. Direct-EFS: cwd/sessions
// ARE the EFS mount (no copy-sync). Phase 1 covers model, cwd, tool allow-list ->
// Pi built-in tools, and bootstrap context-file auto-injection (the primary memory
// path). Plugin/memory-FTS/hindsight tools come from later phases.

import fs from 'node:fs';
import path from 'node:path';
import { pca } from './pi-runtime.mjs';
import { buildMemoryTools } from './memory-tool.mjs';
import { buildCronTools } from './cron-tool.mjs';
import { buildOtelTools } from './otel-tool.mjs';
import { buildDatadogTools } from './datadog-tool.mjs';
import { buildCloudwatchLogsTools } from './cloudwatch-logs-tool.mjs';
import { buildPerson79b333SecretsTools } from './aws-person79b333-secrets-tool.mjs';
import { buildAirflowTools } from './airflow-tool.mjs';
import { buildAwsReadonlyTools } from './aws-readonly-tool.mjs';
import { buildSandboxProbeTools } from './sandbox-probe-tool.mjs';

// ── Plugin manifest (§2.5) ──────────────────────────────────────────────────
// The compat host is OPTIONAL: only plugins we ship a Pi bundle for are routed through
// it; hindsight is Pi-NATIVE (own extension); slack-reply is dropped under Pi; everything
// else is logged as unsupported (no silent gaps).
const COMPAT_PLUGINS = new Set(['connector-session-plugin', 'demo-cache-plugin', 'openclaw-mcp-auth-plugin']); // have an esbuild bundle
const DROPPED_PLUGINS = new Set(['slack-reply-plugin']); // not implemented under Pi (§5.3)
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

export function selectAgent(cfg, agentName) {
  const list = cfg?.agents?.list || [];
  return list.find((a) => a.id === agentName) || list.find((a) => a.default) || list[0] || null;
}

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
// agent_knowledge_* (hindsight), connector/slack-reply/file-publish, pdf are provided
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
  return [
    ...buildMemoryTools(allow, cwd), ...buildCronTools(allow, ctx), ...buildOtelTools(),
    ...buildDatadogTools(allow),
    // §7.3/7.4 ported AWS skills (grant-gated; each assumes a cross-account reader in-process).
    ...buildCloudwatchLogsTools(allow), ...buildPerson79b333SecretsTools(allow), ...buildAirflowTools(allow), ...buildAwsReadonlyTools(allow),
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

// Resolve the plugin manifest from the generated openclaw.json (cfg.plugins). Returns the
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

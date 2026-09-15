import { definePluginEntry, type PluginApi } from "../plugin-sdk/plugin-entry.mjs";
import { parsePluginConfig } from "./src/config.js";
import { SENDER_PARAM, bindToolForTurn, buildAuthTools, discoverAndCache, extractSenderFromRunId, getCachedTemplates, getPluginHealth, isMcpAuthTool, registerAgentCfg } from "./src/tool-cache.js";
import { collectBrokeredCallbacks, isBrokeredMode } from "./src/brokered.js";
import { makeCallbackQuery } from "./src/ddb.js";

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-2)}` : "***";
}

// Non-interactive mode (AgentCore / Pi): ephemeral per-session microVMs cannot bind an
// inbound OAuth2 callback listener and have no co-located browser, so the interactive
// authorization flow is disabled. OAuth2 servers run REFRESH-ONLY off a pre-seeded token
// file on EFS (<agentDir>/mcp-auth-oauth2-tokens.json). Unset under ECS/OpenClaw, so this
// is fully backward-compatible.
//
// Eager discovery USED to be skipped here as well, because the OpenClaw-era eager path
// derived agentDir from OPENCLAW_HOME — wrong under Pi's flat EFS layout — and lazy
// factory-time discovery had the correct ctx.agentDir. That reasoning was right about the
// DIRECTORY and wrong about the TIMING, and it cost the fleet its extra MCP servers:
//
//   Pi resolves a session's tool list ONCE, synchronously, at session build. So the lazy
//   path can only ever be late — the factory returns just the health tool, kicks discovery
//   off in the background, and nothing ever re-resolves. Under OpenClaw that was harmless
//   (one long-lived gateway, tools re-resolved per message, so only the first message
//   lost); under Pi every session is a fresh microVM, so the per-process cache is always
//   empty and the race loses IDENTICALLY EVERY TIME. Measured in prod 2026-09-04 on
//   dm-urbnxvak3l5: discovery landed ~0.6-1.2s after `compat plugins loaded` reported
//   `openclaw-mcp-auth-plugin tools:1`, on all 19 cron fires, so every DemoWarehouse call in
//   every cron turn came back `Tool mcp_auth__demo_warehouse__list_clusters not found` in 0ms
//   and the data-heavy jobs announced nothing. This is the SAME race that
//   prewarmCompatPlugins already exists to close for connector-session-plugin.
//
// So we now discover EAGERLY under Pi too, using the compat host's agentDir (api.resolvePath
// resolves against sessionCtx.agentDir, which the adapter sets to the EFS root for both
// prewarm and session build — the same dir the lazy path would have used). The interactive
// refusal is unaffected: it is enforced at the per-user connect chokepoint in tool-cache.ts,
// not by withholding discovery.
const NON_INTERACTIVE = process.env.MCP_AUTH_NONINTERACTIVE === "1";

/**
 * The directory OAuth2 token/client state lives in, for a discovery kicked off at
 * register() time (before any tool-factory ctx exists).
 *
 * Under Pi the compat host's `api.resolvePath` resolves against `sessionCtx.agentDir`, so
 * resolving "." yields exactly the agentDir the lazy path receives as `ctx.agentDir`.
 * Under OpenClaw there is no such surface, so fall back to the OPENCLAW_HOME layout.
 * `undefined` is a valid answer — discovery is schema-only and only OAuth2 servers need a
 * dir at all.
 */
/**
 * Finish any brokered OAuth2 flow whose code has landed. Never throws and never blocks discovery
 * for long: a connection that cannot be completed must degrade to "not authorized yet", not stop
 * the agent serving a turn.
 */
async function collectLanded(
  api: PluginApi,
  agentId: string,
  agentDir: string | undefined,
): Promise<void> {
  if (!isBrokeredMode() || !agentDir) return;
  const query = makeCallbackQuery();
  if (!query) return; // no config table: OpenClaw forwards to a live container instead
  const outcomes = await collectBrokeredCallbacks({ agentDir, agentId, query, logger: api.logger });
  for (const o of outcomes) {
    // Logged individually: "completed" is the only one a user can act on, and a silent decline is
    // indistinguishable from a flow that was never started.
    if (o.kind === "completed") api.logger.info(`mcp-auth-plugin: OAuth2 authorization completed for ${o.serverKey}`);
    else if (o.kind === "declined") api.logger.warn(`mcp-auth-plugin: OAuth2 declined for ${o.serverKey}: ${o.error}`);
    else if (o.kind === "failed") api.logger.warn(`mcp-auth-plugin: OAuth2 exchange failed for ${o.serverKey}: ${o.error}`);
  }
}

function eagerAgentDirFor(api: PluginApi, agentId: string): string | undefined {
  if (typeof api.resolvePath === "function") {
    try {
      return api.resolvePath(".");
    } catch (err) {
      // Not silent: falling through means OAuth2 servers look for their token in the
      // OPENCLAW_HOME layout, which does not exist under Pi — so a refresh-only server would
      // fail to authorize for a reason invisible at the call site.
      api.logger.warn(
        `mcp-auth-plugin: api.resolvePath failed for agent="${agentId}" (${String(err)}) — falling back to the OPENCLAW_HOME agentDir layout`,
      );
    }
  }
  const openclawHome = process.env.OPENCLAW_HOME || "";
  return openclawHome ? `${openclawHome}/.openclaw/agents/${agentId}/agent` : undefined;
}

// ── Process-level singletons ──────────────────────────────────────────────────
// openclaw loads external plugins fresh on every tool resolution call, so
// module-level state resets each time. globalThis survives all jiti reloads.

declare global {
  // eslint-disable-next-line no-var
  var __mcpAuthPluginInited: boolean | undefined;
  // eslint-disable-next-line no-var
  var __mcpAuthPluginWarnedAgents: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __mcpAuthPluginDiscovering: Map<string, Promise<void>> | undefined;
}

function getWarnedAgents(): Set<string> {
  globalThis.__mcpAuthPluginWarnedAgents ??= new Set();
  return globalThis.__mcpAuthPluginWarnedAgents;
}

function getDiscovering(): Map<string, Promise<void>> {
  globalThis.__mcpAuthPluginDiscovering ??= new Map();
  return globalThis.__mcpAuthPluginDiscovering;
}

export default definePluginEntry({
  id: "openclaw-mcp-auth-plugin",
  name: "MCP Auth Plugin",
  description: "Injects per-agent MCP tools with API key auth and per-sender user_id on every call.",

  register(api) {
    const parsed = parsePluginConfig(api.pluginConfig);
    if (!parsed) {
      api.logger.warn("mcp-auth-plugin: invalid or missing config — plugin disabled");
      return;
    }
    const { config: cfg, warnings } = parsed;
    for (const w of warnings) {
      api.logger.warn(`mcp-auth-plugin: ${w}`);
    }

    // Init once per process: log summary and eagerly start discovery for all
    // configured agents so tools are cached before the first request arrives.
    // Without eager discovery, hot-reloads (clawdbot-pull) start OpenClaw with
    // an empty cache and the first request only gets the health tool — and if
    // OpenClaw caches that result, tools are never available until a full restart.
    if (!globalThis.__mcpAuthPluginInited) {
      globalThis.__mcpAuthPluginInited = true;
      const agentIds = Object.keys(cfg.agents ?? {});
      api.logger.info(
        `mcp-auth-plugin: loaded — upstream=${cfg.upstreamUrl} agents=[${agentIds.join(", ")}]`,
      );
      const discovering = getDiscovering();
      for (const [agentId, agentCfg] of Object.entries(cfg.agents ?? {})) {
        const serverCount = agentCfg.mcpServers.length;
        const firstKey = agentCfg.mcpServers[0]?.apiKey ?? "";
        api.logger.info(
          `mcp-auth-plugin:   agent=${agentId} servers=${serverCount} firstKey=${maskKey(firstKey)}`,
        );
        if (!getCachedTemplates(agentId) && !discovering.has(agentId)) {
          // Resolved from the plugin API under Pi (the EFS agentDir) and from OPENCLAW_HOME
          // under OpenClaw, so OAuth2 servers can read/persist tokens during eager discovery
          // — before any tool-factory ctx.agentDir exists.
          const eagerAgentDir = eagerAgentDirFor(api, agentId);
          api.logger.info(
            `mcp-auth-plugin: eager discovery started for agent="${agentId}"`
            + `${NON_INTERACTIVE ? " (non-interactive)" : ""} agentDir=${eagerAgentDir ?? "none"}`,
          );
          // Collect any OAuth2 callback the forwarder Lambda landed for this agent BEFORE
          // discovery runs. Discovery is what builds the tool list, and Pi freezes a session's
          // tools once — a token that arrives after it has run is a turn too late, which is the
          // same lateness that made lazy discovery the prod bug described above.
          const p = collectLanded(api, agentId, eagerAgentDir)
            .then(() => discoverAndCache({ agentId, pluginCfg: cfg, agentCfg, agentDir: eagerAgentDir }))
            .then(() => {
              const t = getCachedTemplates(agentId) ?? [];
              api.logger.info(
                `mcp-auth-plugin: agent="${agentId}" ready — ${t.length} tools: [${t.map((t) => t.mcpName).join(", ")}]`,
              );
            })
            .catch((err) => {
              api.logger.warn(
                `mcp-auth-plugin: eager discovery failed for agent="${agentId}": ${String(err)}`,
              );
            })
            .finally(() => discovering.delete(agentId));
          discovering.set(agentId, p);
        }
      }
    }

    // IMPORTANT: The factory MUST be synchronous. OpenClaw's resolvePluginTools()
    // calls entry.factory(ctx) without awaiting — an async factory returns a
    // Promise object that gets treated as a bogus tool with name=undefined.
    //
    // When the cache isn't populated yet (discovery still in flight), return just
    // the health tool. OpenClaw re-loads plugins on every tool resolution call,
    // so the full tool set will appear on the next turn once discovery finishes.
    // Inject the true per-message sender into every mcp_auth__* tool call.
    // The slack-dispatcher encodes the Slack user ID in the idempotency key
    // ("u:<userId>:<uuid>"), which becomes the run ID. ctx.requesterSenderId
    // cannot be used for per-user auth in dispatcher mode: it is resolved from
    // the SESSION context, whose SenderId is the dispatcher's gateway client
    // id — one constant shared by every human. This hook is what keeps OAuth2
    // token slots (and api-key user_id mapping) genuinely per-user.
    api.on("before_tool_call", (event, ctx) => {
      if (!isMcpAuthTool(event.toolName)) return;
      const userId = extractSenderFromRunId(ctx.runId);
      if (userId) {
        return { params: { ...event.params, [SENDER_PARAM]: userId } };
      }
    });

    api.registerTool((ctx) => {
      const agentId = ctx.agentId ?? "default";
      const agentCfg = cfg.agents?.[agentId];
      const isConfiguredAgent = agentCfg !== undefined;
      const allConfiguredIds = Object.keys(cfg.agents ?? {});

      const healthTool = {
        name: "mcp_auth_plugin_health",
        label: "MCP Auth Plugin Health",
        description:
          "Returns the health status of the MCP auth plugin. " +
          "Call this if MCP tools seem unavailable or before attempting MCP tool calls " +
          "to verify they are loaded. Status: ready (tools available), pending (discovery not yet " +
          "triggered), error (discovery failed — check the error field).",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          // Configured agents see only their own status; others (e.g. main) see all.
          const scopedIds = isConfiguredAgent ? [agentId] : allConfiguredIds;
          const statuses = getPluginHealth(scopedIds);
          const payload = { agents: statuses };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        },
      };

      if (!agentCfg) {
        const warnedAgents = getWarnedAgents();
        if (!warnedAgents.has(agentId)) {
          api.logger.warn(
            `mcp-auth-plugin: agent="${agentId}" has no MCP servers configured — no MCP tools available`,
          );
          warnedAgents.add(agentId);
        }
        // Return just the health tool so unconfigured agents can still diagnose.
        return healthTool;
      }

      // Register server metadata immediately so health shows all servers even before discovery.
      registerAgentCfg(agentId, cfg, agentCfg);

      const agentDir = ctx.agentDir ?? undefined;
      const templates = getCachedTemplates(agentId);
      if (!templates) {
        // Eager discovery (kicked off above) should populate the cache before
        // the first user message arrives. If it hasn't completed yet, trigger
        // lazy discovery as a fallback and return just the health tool — the
        // full set will be available on the next tool resolution call.
        const discovering = getDiscovering();
        if (!discovering.has(agentId)) {
          api.logger.info(`mcp-auth-plugin: lazy discovery triggered for agent="${agentId}"`);
          const p = discoverAndCache({ agentId, pluginCfg: cfg, agentCfg, agentDir, logger: api.logger })
            .then(() => {
              const t = getCachedTemplates(agentId) ?? [];
              api.logger.info(
                `mcp-auth-plugin: agent="${agentId}" ready — ${t.length} tools: [${t.map((t) => t.mcpName).join(", ")}]`,
              );
            })
            .catch((err) => {
              api.logger.warn(
                `mcp-auth-plugin: discovery failed for agent="${agentId}": ${String(err)}`,
              );
            })
            .finally(() => discovering.delete(agentId));
          discovering.set(agentId, p);
        }
        return healthTool;
      }

      const senderId = ctx.requesterSenderId ?? undefined;

      // buildAuthTools is config-driven: it surfaces connect/submit_code for
      // every OAuth2 server the current sender hasn't authorized (flows kick
      // off lazily inside connect), and schedules a background schema fetch
      // when the sender is authorized but the server's tools aren't cached
      // yet. No separate priming pass is needed.
      const authTools = buildAuthTools({ agentId, agentDir, senderId, logger: api.logger });
      return [
        healthTool,
        ...authTools,
        ...templates.map((t) =>
          bindToolForTurn(t, senderId, agentDir, agentId),
        ),
      ];
    });
  },
});

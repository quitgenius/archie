import { definePluginEntry } from "../plugin-sdk/plugin-entry.mjs";
import { parsePluginConfig } from "./src/config.js";
import { SENDER_PARAM, bindToolForTurn, buildAuthTools, discoverAndCache, extractSenderFromRunId, getCachedTemplates, getPluginHealth, isMcpAuthTool, registerAgentCfg } from "./src/tool-cache.js";

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 6)}...${key.slice(-2)}` : "***";
}

// Non-interactive mode (AgentCore / Pi): ephemeral per-session microVMs cannot bind an
// inbound OAuth2 callback listener and have no co-located browser, so the interactive
// authorization flow is disabled. OAuth2 servers run REFRESH-ONLY off a pre-seeded token
// file on EFS (<agentDir>/mcp-auth-oauth2-tokens.json). Eager discovery is also skipped —
// it derived agentDir from OPENCLAW_HOME, which is wrong under Pi's flat EFS layout; lazy
// factory-time discovery uses the correct ctx.agentDir instead. Unset under ECS/OpenClaw,
// so this is fully backward-compatible.
const NON_INTERACTIVE = process.env.MCP_AUTH_NONINTERACTIVE === "1";

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
        if (NON_INTERACTIVE) {
          api.logger.info(
            `mcp-auth-plugin: non-interactive mode — skipping eager discovery for agent="${agentId}" (lazy discovery uses ctx.agentDir off EFS)`,
          );
        } else if (!getCachedTemplates(agentId) && !discovering.has(agentId)) {
          api.logger.info(`mcp-auth-plugin: eager discovery started for agent="${agentId}"`);
          // Derive agentDir from OPENCLAW_HOME so OAuth2 servers can persist
          // tokens during eager discovery (before any ctx.agentDir is available).
          const openclawHome = process.env.OPENCLAW_HOME || "";
          const eagerAgentDir = openclawHome ? `${openclawHome}/.openclaw/agents/${agentId}/agent` : undefined;
          const p = discoverAndCache({ agentId, pluginCfg: cfg, agentCfg, agentDir: eagerAgentDir })
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

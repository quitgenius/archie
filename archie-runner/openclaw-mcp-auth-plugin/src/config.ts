/**
 * Per-server OAuth2 (Authorization Code + PKCE) configuration. When set, the
 * plugin uses Bearer auth with the stored access token and ignores apiKey /
 * authHeader. Tokens are persisted by the plugin under <agentDir>; this struct
 * is the *static* config supplied by the user.
 */
export type OAuth2ServerConfig = {
  /**
   * Redirect URI the authorization server sends the user back to. Must match a
   * URI registered with the IdP. For local dev, point this at the plugin's
   * own callback listener (e.g. "http://localhost:9876/callback").
   */
  redirectUri: string;
  /**
   * Pre-registered client_id. When set, dynamic client registration is skipped.
   * Use this for servers that ship a fixed client_id (e.g. DemoQueryApp Cloud's "demo_query_app-mcp-client").
   */
  clientId?: string;
  /**
   * Port for the plugin's built-in callback listener. When set, the plugin
   * binds an HTTP server on this port and completes the code exchange
   * automatically when the redirect arrives. Leave unset to require manual
   * code submission via the submit_code tool.
   */
  callbackPort?: number;
  /**
   * Override for the browser-facing authorization endpoint. When set, auth
   * URLs are built against this instead of the metadata-discovered
   * authorization_endpoint. Use when the MCP host's own /oauth/authorize is
   * network-gated (e.g. VPN/IP-allowlisted) but merely 302s to a public IdP
   * page with identical params — pointing users straight at the public
   * endpoint (e.g. DemoQueryApp Cloud's "https://demoquerycloud.dev/auth/oauth2/authorize")
   * lets them authorize off-network. Token exchange is unaffected: it runs
   * from the agent container against the metadata token_endpoint.
   */
  authorizationEndpoint?: string;
  /** OAuth2 scopes to request. */
  scopes?: string[];
  /** client_name sent during dynamic registration. */
  clientName?: string;
};

export type McpServerConfig = {
  /**
   * API key value sent in the auth header. Required unless `oauth2` is set.
   */
  apiKey?: string;
  /**
   * OAuth2 PKCE configuration. When set, the plugin negotiates a Bearer token
   * with the MCP server's authorization server and ignores apiKey/authHeader.
   */
  oauth2?: OAuth2ServerConfig;
  /**
   * Auth header name (API-key mode only). Defaults to plugin-level
   * defaultAuthHeader or "x-api-key". Use "Authorization" with
   * apiKey "Bearer sk-xxx" for Bearer auth.
   */
  authHeader?: string;
  /**
   * Base URL for this MCP server (without user_id query param).
   * Overrides the plugin-level upstreamUrl when set.
   * e.g. "https://backend.connector.dev/v3/mcp/9ddc83bf-.../mcp"
   */
  upstreamUrl?: string;
  /**
   * Maps Slack sender IDs to MCP server user IDs.
   * When a tool is called, the sender's entry here is appended as ?user_id=...
   * e.g. { "UEO9FMNBI": "pg-alice-connector-id", "U999XYZ": "pg-bob-connector-id" }
   */
  senderUserMap?: Record<string, string>;
  /**
   * Fallback user_id when the sender is not in senderUserMap.
   * Also used at gateway_start for tool discovery (tools/list).
   */
  defaultUserId?: string;
  /**
   * Optional prefix added to tool names from this server to avoid collisions
   * when multiple servers expose tools with the same name.
   * e.g. "connector" → tool "search" becomes "mcp_auth__connector__search"
   */
  toolPrefix?: string;
};

export function isOAuth2Server(s: McpServerConfig): s is McpServerConfig & { oauth2: OAuth2ServerConfig } {
  return s.oauth2 !== undefined;
}

export type AgentConfig = {
  /**
   * One or more MCP servers available to this agent.
   * Tools from all servers are merged and exposed together.
   */
  mcpServers: McpServerConfig[];
};

export type PluginConfig = {
  /**
   * Default base URL used when not overridden per server.
   */
  upstreamUrl?: string;
  /**
   * Default auth header name. Defaults to "x-api-key".
   */
  defaultAuthHeader?: string;
  agents?: Record<string, AgentConfig>;
};

export type ParseResult = { config: PluginConfig; warnings: string[] };

export function parsePluginConfig(raw: unknown): ParseResult | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;

  const upstreamUrl = typeof obj["upstreamUrl"] === "string" ? obj["upstreamUrl"] : undefined;
  const defaultAuthHeader =
    typeof obj["defaultAuthHeader"] === "string" ? obj["defaultAuthHeader"] : undefined;

  const warnings: string[] = [];
  const agents: Record<string, AgentConfig> = {};
  const rawAgents = obj["agents"];
  if (rawAgents && typeof rawAgents === "object" && !Array.isArray(rawAgents)) {
    for (const [agentId, agentRaw] of Object.entries(rawAgents)) {
      if (!agentRaw || typeof agentRaw !== "object" || Array.isArray(agentRaw)) {
        warnings.push(`agent "${agentId}": config is not an object — skipped`);
        continue;
      }
      const a = agentRaw as Record<string, unknown>;

      // Backward compat: old format had apiKey at agent level (single server).
      // Also accept oauth2 at the agent level for symmetry.
      const rawServers =
        typeof a["apiKey"] === "string" || a["oauth2"] ? [a] : a["mcpServers"];
      const mcpServers = parseMcpServers(rawServers, agentId, warnings);
      if (mcpServers === null) {
        warnings.push(`agent "${agentId}": no valid mcpServers after parsing — skipped`);
        continue;
      }

      agents[agentId] = { mcpServers };
    }
  }

  return { config: { upstreamUrl, defaultAuthHeader, agents }, warnings };
}

function parseOAuth2(raw: unknown): OAuth2ServerConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o["redirectUri"] !== "string" || o["redirectUri"].length === 0) return undefined;

  let scopes: string[] | undefined;
  if (Array.isArray(o["scopes"])) {
    scopes = (o["scopes"] as unknown[]).filter((x): x is string => typeof x === "string");
    if (scopes.length === 0) scopes = undefined;
  }

  return {
    redirectUri: o["redirectUri"],
    clientId: typeof o["clientId"] === "string" ? o["clientId"] : undefined,
    callbackPort:
      typeof o["callbackPort"] === "number" && Number.isInteger(o["callbackPort"])
        ? o["callbackPort"]
        : undefined,
    scopes,
    clientName: typeof o["clientName"] === "string" ? o["clientName"] : undefined,
    authorizationEndpoint:
      typeof o["authorizationEndpoint"] === "string" && o["authorizationEndpoint"].length > 0
        ? o["authorizationEndpoint"]
        : undefined,
  };
}

function parseMcpServers(raw: unknown, agentId: string, warnings: string[]): McpServerConfig[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const servers: McpServerConfig[] = [];
  for (let idx = 0; idx < raw.length; idx++) {
    const item = raw[idx];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      warnings.push(`agent "${agentId}" server[${idx}]: entry is not an object — skipped`);
      continue;
    }
    const s = item as Record<string, unknown>;

    const apiKey = typeof s["apiKey"] === "string" ? s["apiKey"] : undefined;
    const oauth2 = parseOAuth2(s["oauth2"]);
    // Must have at least one auth method. An empty apiKey is valid (e.g.
    // internal servers with no auth) — only skip when both are undefined.
    if (apiKey === undefined && !oauth2) {
      const hint = s["upstreamUrl"] ?? s["toolPrefix"] ?? `index ${idx}`;
      warnings.push(`agent "${agentId}" server[${idx}] (${hint}): no apiKey or oauth2 — skipped`);
      continue;
    }

    const senderUserMap: Record<string, string> = {};
    if (s["senderUserMap"] && typeof s["senderUserMap"] === "object" && !Array.isArray(s["senderUserMap"])) {
      for (const [senderId, userId] of Object.entries(s["senderUserMap"] as Record<string, unknown>)) {
        if (typeof userId === "string") senderUserMap[senderId] = userId;
      }
    }

    servers.push({
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(oauth2 ? { oauth2 } : {}),
      authHeader: typeof s["authHeader"] === "string" ? s["authHeader"] : undefined,
      upstreamUrl: typeof s["upstreamUrl"] === "string" ? s["upstreamUrl"] : undefined,
      senderUserMap,
      defaultUserId: typeof s["defaultUserId"] === "string" ? s["defaultUserId"] : undefined,
      toolPrefix: typeof s["toolPrefix"] === "string" ? s["toolPrefix"] : undefined,
    });
  }

  return servers.length > 0 ? servers : null;
}

export function resolveAuthHeader(cfg: PluginConfig, serverCfg: McpServerConfig): string {
  return serverCfg.authHeader ?? cfg.defaultAuthHeader ?? "x-api-key";
}

/**
 * Build the full upstream URL for a specific sender.
 * Appends ?user_id=<connectorUserId> when a mapping exists.
 */
export function resolveUpstreamUrl(
  cfg: PluginConfig,
  serverCfg: McpServerConfig,
  senderId: string | undefined,
): string | null {
  const base = serverCfg.upstreamUrl ?? cfg.upstreamUrl;
  if (!base) return null;

  const userId =
    (senderId ? serverCfg.senderUserMap?.[senderId] : undefined) ?? serverCfg.defaultUserId;

  if (!userId) return base;

  const url = new URL(base);
  url.searchParams.set("user_id", userId);
  return url.toString();
}

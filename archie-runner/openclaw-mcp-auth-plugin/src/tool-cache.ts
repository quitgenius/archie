import type { AgentTool } from "@mariozechner/pi-agent-core";
// Loose tool descriptor the compat host adapts into a strict Pi tool at runtime. Mirrors
// exactly what OpenClaw's plugin SDK exported (`AgentTool<any, unknown>` + optional owner
// fields) so plugin tool objects with plain-JSON `parameters` typecheck unchanged.
type AnyAgentTool = AgentTool<any, unknown> & { ownerOnly?: boolean; displaySummary?: string };
import type { AgentConfig, McpServerConfig, OAuth2ServerConfig, PluginConfig } from "./config.js";
import { isOAuth2Server, resolveAuthHeader, resolveUpstreamUrl } from "./config.js";
import type { McpToolSchema } from "./mcp-client.js";
import { McpUnauthorizedError, callTool, fetchToolList } from "./mcp-client.js";
import {
  buildAuthUrl,
  discoverOAuth2Metadata,
  exchangeCode,
  generatePkce,
  generateState,
  refreshAccessToken,
  registerClient,
  type OAuth2Metadata,
  type Pkce,
} from "./oauth2.js";
import { registerPendingFlow } from "./callback-server.js";
import {
  clearTokens,
  getClientId,
  getTokens,
  isAccessTokenFresh,
  saveClientId,
  saveTokens,
  serverKeyFor,
  type StoredTokens,
} from "./token-store.js";

const TOOL_PREFIX = "mcp_auth__";

/**
 * Hidden per-call parameter carrying the true message sender, injected by the
 * before_tool_call hook in index.ts and stripped before the upstream call.
 *
 * Why it exists: ctx.requesterSenderId is resolved from the SESSION context.
 * In dispatcher mode every Slack message reaches the gateway over the
 * dispatcher's single client connection, so the session's SenderId is the
 * dispatcher's client id — the same constant for every human. Keying per-user
 * state on it collapses all users into one slot. The actual sender travels in
 * the run ID ("u:<slackUserId>:<uuid>", from the dispatcher's idempotency
 * key), which is only visible to hooks — hence the injection.
 */
export const SENDER_PARAM = "__mcpAuthSenderId";

/**
 * Extract the Slack user ID from a run ID of the form "u:<userId>:<uuid>".
 * Returns undefined for any other shape (cron runs, plain uuids, absent).
 */
export function extractSenderFromRunId(runId: string | undefined): string | undefined {
  if (!runId || !runId.startsWith("u:")) return undefined;
  const rest = runId.slice(2);
  const colon = rest.indexOf(":");
  const userId = colon < 0 ? rest : rest.slice(0, colon);
  return userId || undefined;
}

/** Per-call sender: prefer the hook-injected param, fall back to factory sender. */
function resolveEffectiveSender(
  params: Record<string, unknown>,
  factorySenderId: string | undefined,
): string | undefined {
  const injected = params[SENDER_PARAM];
  if (typeof injected === "string" && injected) return injected;
  return factorySenderId;
}

export function toolNameFor(mcpName: string, toolPrefix?: string): string {
  return toolPrefix ? `${TOOL_PREFIX}${toolPrefix}__${mcpName}` : `${TOOL_PREFIX}${mcpName}`;
}

export function isMcpAuthTool(toolName: string): boolean {
  return toolName.startsWith(TOOL_PREFIX);
}

export type ToolTemplate = {
  name: string;
  mcpName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  pluginCfg: PluginConfig;
  serverCfg: McpServerConfig;
};

export function buildToolTemplate(
  pluginCfg: PluginConfig,
  serverCfg: McpServerConfig,
  schema: McpToolSchema,
): ToolTemplate {
  return {
    name: toolNameFor(schema.name, serverCfg.toolPrefix),
    mcpName: schema.name,
    description: schema.description ?? schema.name,
    inputSchema: schema.inputSchema ?? { type: "object", properties: {} },
    pluginCfg,
    serverCfg,
  };
}

// ── Auth resolution ───────────────────────────────────────────────────────────

type ResolvedAuth = {
  header: string;
  value: string;
  /** Called on 401 by mcp-client to refresh credentials. */
  onUnauthorized?: () => Promise<{ header: string; value: string }>;
};

function staticApiKeyAuth(pluginCfg: PluginConfig, serverCfg: McpServerConfig): ResolvedAuth {
  return {
    header: resolveAuthHeader(pluginCfg, serverCfg),
    value: serverCfg.apiKey ?? "",
  };
}

/**
 * Build OAuth2 auth using whatever tokens are currently in the store. Throws if
 * no usable tokens exist — caller is responsible for kicking off the auth flow
 * when this happens.
 */
function oauth2AuthFromStore(params: {
  agentId: string | undefined;
  agentDir: string;
  serverKey: string;
  /** Stable (query-stripped) upstream URL — used for refresh-time metadata discovery. */
  upstreamUrl: string;
  oauth2: OAuth2ServerConfig;
  metadata?: OAuth2Metadata;
  clientId?: string;
}): ResolvedAuth {
  const tokens = getTokens(params.agentDir, params.serverKey);
  if (!tokens?.accessToken) {
    throw new Error("oauth2: no access token in store");
  }
  return {
    header: "Authorization",
    value: `Bearer ${tokens.accessToken}`,
    onUnauthorized: async () => {
      // 401 mid-session → try a refresh. If the refresh fails, drop this
      // user's access token; their connect/submit_code tools are surfaced by
      // buildAuthTools on the next turn (config-driven, keyed on the absence
      // of fresh tokens), so re-auth needs no cache invalidation and other
      // users' cached tools are untouched.
      const refreshed = await refreshIfPossible({
        agentDir: params.agentDir,
        serverKey: params.serverKey,
        upstreamUrl: params.upstreamUrl,
        oauth2: params.oauth2,
        metadata: params.metadata,
        clientId: params.clientId,
      });
      if (!refreshed) {
        clearTokens(params.agentDir, params.serverKey);
        throw new Error("oauth2: refresh unavailable; auth flow must be re-initiated");
      }
      return { header: "Authorization", value: `Bearer ${refreshed.accessToken}` };
    },
  };
}

async function refreshIfPossible(params: {
  agentDir: string;
  serverKey: string;
  /** Stable upstream URL for this server — metadata discovery target. */
  upstreamUrl: string;
  oauth2: OAuth2ServerConfig;
  metadata?: OAuth2Metadata;
  clientId?: string;
}): Promise<StoredTokens | null> {
  const tokens = getTokens(params.agentDir, params.serverKey);
  if (!tokens?.refreshToken) return null;

  const clientId = params.clientId ?? params.oauth2.clientId ?? getClientId(params.agentDir, params.serverKey);
  if (!clientId) return null;

  try {
    // Metadata discovery inside the try: a transient IdP/metadata failure must
    // degrade to "refresh unavailable" (→ re-auth path) rather than throwing
    // out of the 401 recovery and wedging the caller.
    const metadata = params.metadata ?? (await discoverOAuth2Metadata(params.upstreamUrl));
    const refreshed = await refreshAccessToken({
      metadata,
      clientId,
      refreshToken: tokens.refreshToken,
      redirectUri: params.oauth2.redirectUri,
    });
    const stored: StoredTokens = {
      accessToken: refreshed.accessToken,
      // Some IdPs rotate refresh tokens; if a new one is returned, store it.
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      ...(refreshed.expiresAt !== undefined ? { expiresAt: refreshed.expiresAt } : {}),
      ...(refreshed.scope !== undefined ? { scope: refreshed.scope } : {}),
    };
    saveTokens(params.agentDir, params.serverKey, stored);
    return stored;
  } catch {
    return null;
  }
}

/**
 * Resolved, query-stripped upstream URL — the canonical server identity that
 * token-store keys are derived from. Every serverKeyFor call site MUST derive
 * its URL through this helper (or strip identically) or per-user keys written
 * at flow time won't match keys computed at read time.
 */
function stableServerUrl(pluginCfg: PluginConfig, serverCfg: McpServerConfig): string | null {
  const url = resolveUpstreamUrl(pluginCfg, serverCfg, undefined);
  if (!url) return null;
  return url.split("?")[0] ?? url;
}

export function bindToolForTurn(
  template: ToolTemplate,
  senderId: string | undefined,
  agentDir?: string | undefined,
  agentId?: string | undefined,
): AnyAgentTool {
  return {
    name: template.name,
    label: template.name,
    description: template.description,
    parameters: template.inputSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      // The hook-injected per-call sender is authoritative; the factory-time
      // senderId is a per-session value that in dispatcher mode is the SAME
      // for every user (see SENDER_PARAM) and must never key per-user state
      // on its own when a per-call value is available.
      const effectiveSenderId = resolveEffectiveSender(params, senderId);
      const url = resolveUpstreamUrl(template.pluginCfg, template.serverCfg, effectiveSenderId);
      if (!url) {
        throw new Error(`mcp-auth-plugin: no upstream URL resolved for tool "${template.mcpName}"`);
      }

      let auth: ResolvedAuth;
      if (isOAuth2Server(template.serverCfg)) {
        if (!agentDir) {
          throw new Error(
            `mcp-auth-plugin: agentDir unavailable; cannot use OAuth2 tool "${template.mcpName}"`,
          );
        }
        // Per-user auth: OAuth2 tokens are keyed by the requesting sender so a
        // shared agent never serves one user's DemoQueryApp session to another. If we
        // have no identity for this turn (e.g. cron/eager/no-sender contexts),
        // refuse rather than falling back to an anonymous/shared token slot —
        // that shared slot is exactly the leak we are closing.
        if (!effectiveSenderId) {
          throw new Error(
            `mcp-auth-plugin: OAuth2 tool "${template.mcpName}" requires per-user authentication, ` +
              `but no sender identity is available in this context. Connect from a DM or channel ` +
              `where your identity is known so you can authorize your own connection.`,
          );
        }
        const stableUrl = url.split("?")[0] ?? url;
        const serverKey = serverKeyFor(stableUrl, effectiveSenderId);

        // No usable token for THIS user → try a silent refresh; if that fails,
        // return an auth-required result (not a throw) pointing at their own
        // connect tool, which buildAuthTools surfaces whenever the sender is
        // unauthorized. First-time users get actionable guidance on the very
        // first call instead of a raw internal error.
        if (!isAccessTokenFresh(getTokens(agentDir, serverKey))) {
          const refreshed = await refreshIfPossible({
            agentDir,
            serverKey,
            upstreamUrl: stableUrl,
            oauth2: template.serverCfg.oauth2,
          });
          if (!refreshed) {
            const prefix = sanitizeToolPrefix(template.serverCfg.toolPrefix ?? "oauth2");
            const payload = {
              ok: false,
              authRequired: true,
              error:
                `You are not connected to ${prefix} yet. Call ${TOOL_PREFIX}${prefix}__connect ` +
                `to get your personal authorization link, sign in, and then retry this tool. ` +
                `Connections are per-user: another user's authorization does not apply to you.`,
            };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(payload) }],
              details: payload,
            };
          }
        }

        auth = oauth2AuthFromStore({
          agentId,
          agentDir,
          serverKey,
          upstreamUrl: stableUrl,
          oauth2: template.serverCfg.oauth2,
        });
      } else {
        auth = staticApiKeyAuth(template.pluginCfg, template.serverCfg);
      }

      const clientCfg = {
        upstreamUrl: url,
        authHeader: auth.header,
        authValue: auth.value,
        ...(auth.onUnauthorized ? { onUnauthorized: auth.onUnauthorized } : {}),
      };
      const input: Record<string, unknown> = { ...params };
      delete input[SENDER_PARAM]; // internal routing param — never forward upstream
      if (effectiveSenderId) input["caller_id"] = effectiveSenderId;
      const result = await callTool(clientCfg, template.mcpName, input);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  };
}

// ── Shared cache via globalThis ───────────────────────────────────────────────
// The plugin is loaded multiple times by openclaw (once per agent context).
// Each jiti load gets a fresh module instance, so a plain Map would be empty
// in every instance except the one that ran discovery. globalThis survives
// across all jiti loads within the same process.

type AgentServerMeta = { pluginCfg: PluginConfig; servers: McpServerConfig[] };

export type PendingAuth = {
  /** Server index within the agent's mcpServers array — for display only. */
  serverIndex: number;
  serverKey: string;
  /** Server's toolPrefix if configured — used to name the connect/submit_code tools. */
  toolPrefix?: string;
  /** Stable upstream URL (no query string) for restarting the flow. */
  upstreamUrl: string;
  authUrl: string;
  state: string;
  pkce: Pkce;
  clientId: string;
  redirectUri: string;
  metadata: OAuth2Metadata;
  oauth2: OAuth2ServerConfig;
  /** Unix ms when this flow should be considered stale and regenerated. */
  expiresAt: number;
};

/** PKCE auth flows are abandoned after this window — connect/discovery regenerate. */
const PENDING_AUTH_TTL_MS = 10 * 60_000;

function isPendingExpired(p: PendingAuth, now = Date.now()): boolean {
  return p.expiresAt <= now;
}

declare global {
  // eslint-disable-next-line no-var
  var __mcpAuthPluginCache: Map<string, ToolTemplate[]> | undefined;
  // eslint-disable-next-line no-var
  var __mcpAuthPluginErrors: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __mcpAuthPluginServerMeta: Map<string, AgentServerMeta> | undefined;
  // eslint-disable-next-line no-var
  var __mcpAuthPluginServerErrors: Map<string, (string | null)[]> | undefined;
  // eslint-disable-next-line no-var
  var __mcpAuthPluginPendingAuth: Map<string, Map<string, PendingAuth>> | undefined;
}

function getCache(): Map<string, ToolTemplate[]> {
  globalThis.__mcpAuthPluginCache ??= new Map();
  return globalThis.__mcpAuthPluginCache;
}

function getErrors(): Map<string, string> {
  globalThis.__mcpAuthPluginErrors ??= new Map();
  return globalThis.__mcpAuthPluginErrors;
}

function getServerMeta(): Map<string, AgentServerMeta> {
  globalThis.__mcpAuthPluginServerMeta ??= new Map();
  return globalThis.__mcpAuthPluginServerMeta;
}

function getServerErrors(): Map<string, (string | null)[]> {
  globalThis.__mcpAuthPluginServerErrors ??= new Map();
  return globalThis.__mcpAuthPluginServerErrors;
}

function getPendingAuthMap(): Map<string, Map<string, PendingAuth>> {
  globalThis.__mcpAuthPluginPendingAuth ??= new Map();
  return globalThis.__mcpAuthPluginPendingAuth;
}

function getPendingForAgent(agentId: string): Map<string, PendingAuth> {
  const map = getPendingAuthMap();
  let inner = map.get(agentId);
  if (!inner) {
    inner = new Map();
    map.set(agentId, inner);
  }
  return inner;
}

export function getCachedTemplates(agentId: string): ToolTemplate[] | undefined {
  return getCache().get(agentId);
}

export function getPendingAuthForAgent(agentId: string): PendingAuth[] {
  const inner = getPendingAuthMap().get(agentId);
  return inner ? Array.from(inner.values()) : [];
}

/**
 * Store server metadata for an agent so health can show all configured servers
 * even before discovery completes. Safe to call on every turn — idempotent.
 */
export function registerAgentCfg(agentId: string, pluginCfg: PluginConfig, agentCfg: AgentConfig): void {
  if (!getServerMeta().has(agentId)) {
    getServerMeta().set(agentId, { pluginCfg, servers: agentCfg.mcpServers });
  }
}

export type McpServerHealth = {
  upstreamUrl: string | null;
  toolPrefix?: string;
  status: "ready" | "error" | "pending" | "auth-pending";
  toolCount?: number;
  tools?: string[];
  error?: string;
  // NOTE: no authUrl here. Auth flows are per-user; the agent-wide health tool
  // must never hand one user's live authorization URL (with its PKCE state) to
  // another user. Each user gets their URL from their own connect tool.
};

export type AgentHealthStatus = {
  agentId: string;
  status: "ready" | "partial" | "discovering" | "error" | "pending" | "auth-pending";
  toolCount?: number;
  servers: McpServerHealth[];
  error?: string;
};

function buildServerHealth(agentId: string, meta: AgentServerMeta): McpServerHealth[] {
  const templates = getCache().get(agentId) ?? [];
  const serverErrors = getServerErrors().get(agentId); // undefined = discovery not done yet
  const pending = getPendingAuthMap().get(agentId);

  // Group cached templates by server reference
  const byServer = new Map<McpServerConfig, ToolTemplate[]>();
  for (const t of templates) {
    const group = byServer.get(t.serverCfg);
    if (group) group.push(t);
    else byServer.set(t.serverCfg, [t]);
  }

  return meta.servers.map((serverCfg, i) => {
    const upstreamUrl = serverCfg.upstreamUrl ?? meta.pluginCfg.upstreamUrl ?? null;
    // serverErrors undefined → discovery not started; null → success; string → error
    const serverError = serverErrors ? serverErrors[i] : undefined;
    const group = byServer.get(serverCfg) ?? [];
    const stableUrl = upstreamUrl ? (upstreamUrl.split("?")[0] ?? upstreamUrl) : null;
    const anyPendingFlow = stableUrl
      ? [...(pending?.values() ?? [])].some((p) => p.upstreamUrl === stableUrl)
      : false;

    // An OAuth2 server with no cached tool schemas and no hard error is
    // awaiting per-user authorization: either a user has an in-flight flow,
    // or nobody has authorized yet (discovery is anonymous and never kicks
    // off flows). Report the status WITHOUT any auth URL — flows are
    // per-user and each user gets their link from their own connect tool.
    if (isOAuth2Server(serverCfg) && group.length === 0 && (serverError === null || anyPendingFlow)) {
      return {
        upstreamUrl,
        ...(serverCfg.toolPrefix ? { toolPrefix: serverCfg.toolPrefix } : {}),
        status: "auth-pending" as const,
        ...(serverError ? { error: serverError } : {}),
      };
    }

    const status: McpServerHealth["status"] =
      serverError === undefined ? "pending" :
      serverError !== null ? "error" :
      "ready";

    return {
      upstreamUrl,
      ...(serverCfg.toolPrefix ? { toolPrefix: serverCfg.toolPrefix } : {}),
      status,
      ...(status === "ready" ? { toolCount: group.length, tools: group.map((t) => t.mcpName) } : {}),
      ...(serverError ? { error: serverError } : {}),
    };
  });
}

export function getPluginHealth(configuredAgentIds: string[]): AgentHealthStatus[] {
  const cache = getCache();
  const errors = getErrors();
  const serverErrorMap = getServerErrors();

  return configuredAgentIds.map((agentId) => {
    const meta = getServerMeta().get(agentId);
    const servers = meta ? buildServerHealth(agentId, meta) : [];

    if (errors.has(agentId)) {
      return { agentId, status: "error", error: errors.get(agentId), servers };
    }
    const templates = cache.get(agentId);
    const anyPendingAuth = servers.some((s) => s.status === "auth-pending");
    if (templates !== undefined) {
      const hasServerError = serverErrorMap.get(agentId)?.some((e) => e !== null) ?? false;
      let status: AgentHealthStatus["status"] = "ready";
      if (anyPendingAuth && templates.length === 0) status = "auth-pending";
      else if (anyPendingAuth || hasServerError) status = "partial";
      return { agentId, status, toolCount: templates.length, servers };
    }
    if (anyPendingAuth) return { agentId, status: "auth-pending", servers };
    return { agentId, status: "pending", servers };
  });
}

// ── OAuth2 flow kickoff and token exchange ────────────────────────────────────

async function kickoffOAuth2Flow(params: {
  agentId: string;
  agentDir: string;
  serverIndex: number;
  serverCfg: McpServerConfig & { oauth2: OAuth2ServerConfig };
  upstreamUrl: string;
  /**
   * Requesting sender — folded into the storage key for per-user auth. Every
   * flow belongs to a user; anonymous flows are never kicked off (discovery is
   * schema-only, and the runtime guard refuses senderless OAuth2 calls).
   */
  senderId: string;
  logger?: { warn: (msg: string) => void };
}): Promise<PendingAuth> {
  const { oauth2 } = params.serverCfg;

  // Under AgentCore/Pi the interactive flow can't run — an ephemeral per-session microVM
  // can't host the inbound OAuth2 callback listener and has no co-located browser. Refuse
  // BEFORE any dynamic-client registration or callback-server start (this is the single
  // chokepoint for every per-user connect/getOrRestart path). OAuth2 servers are
  // refresh-only off a pre-seeded EFS token. The connect tool's catch surfaces this to
  // the user as a tool result. Unset under ECS/OpenClaw — fully backward-compatible.
  if (process.env.MCP_AUTH_NONINTERACTIVE === "1") {
    throw new Error(
      `Interactive OAuth2 authorization is disabled under AgentCore (MCP_AUTH_NONINTERACTIVE). `
      + `Pre-seed a valid refresh token at ${params.agentDir}/mcp-auth-oauth2-tokens.json — `
      + `the browser/callback connect flow cannot run on an ephemeral runtime.`,
    );
  }

  const serverKey = serverKeyFor(params.upstreamUrl, params.senderId);

  const metadata = await discoverOAuth2Metadata(params.upstreamUrl);

  // Resolve client_id: prefer config, then store, else dynamic registration.
  let clientId = oauth2.clientId ?? getClientId(params.agentDir, serverKey);
  if (!clientId) {
    if (!metadata.registration_endpoint) {
      throw new Error(
        `oauth2: no clientId configured and authorization server at ${params.upstreamUrl} does not advertise a registration_endpoint`,
      );
    }
    const registered = await registerClient({
      registrationEndpoint: metadata.registration_endpoint,
      redirectUri: oauth2.redirectUri,
      clientName: oauth2.clientName,
      scopes: oauth2.scopes,
    });
    clientId = registered.clientId;
    saveClientId(params.agentDir, serverKey, clientId, params.serverCfg.toolPrefix);
  }

  const pkce = generatePkce();
  const state = generateState();
  // Browser-facing endpoint may be overridden (e.g. the MCP host's own
  // /oauth/authorize is VPN-gated but 302s to a public IdP page — send the
  // user straight there). Token exchange still uses the discovered metadata.
  const authUrl = buildAuthUrl({
    metadata: oauth2.authorizationEndpoint
      ? { ...metadata, authorization_endpoint: oauth2.authorizationEndpoint }
      : metadata,
    clientId,
    redirectUri: oauth2.redirectUri,
    pkce,
    state,
    scopes: oauth2.scopes,
  });

  const pending: PendingAuth = {
    serverIndex: params.serverIndex,
    serverKey,
    ...(params.serverCfg.toolPrefix ? { toolPrefix: params.serverCfg.toolPrefix } : {}),
    upstreamUrl: params.upstreamUrl,
    authUrl,
    state,
    pkce,
    clientId,
    redirectUri: oauth2.redirectUri,
    metadata,
    oauth2,
    expiresAt: Date.now() + PENDING_AUTH_TTL_MS,
  };
  getPendingForAgent(params.agentId).set(serverKey, pending);

  // If a callback port is configured, register a handler that completes the
  // exchange automatically when the browser is redirected back.
  if (oauth2.callbackPort !== undefined) {
    try {
      const { ready } = registerPendingFlow({
        port: oauth2.callbackPort,
        state,
        flow: {
          expiresAt: Date.now() + 10 * 60_000,
          onCode: async (code) => {
            await completePendingFlow({
              agentId: params.agentId,
              agentDir: params.agentDir,
              serverKey,
              senderId: params.senderId,
              code,
            });
          },
          onAbort: (reason) => {
            // IdP returned an error (e.g. user-cancelled, invalid_grant) or the
            // token exchange threw. Drop this flow's tool-cache entry so the
            // next connect() regenerates a fresh URL — otherwise the old entry
            // sticks around for 10 min and the agent keeps handing back the
            // same dead authUrl whose `state` is no longer registered.
            //
            // Only delete if the live entry matches this `state`: a fresh
            // connect() between the abort and now could have already replaced
            // it, and we don't want to clobber the new flow.
            const live = getPendingForAgent(params.agentId).get(serverKey);
            if (live?.state === state) {
              getPendingForAgent(params.agentId).delete(serverKey);
            }
            params.logger?.warn(
              `mcp-auth-plugin: OAuth2 flow aborted for ${serverKey}: ${reason}`,
            );
          },
        },
        ...(params.logger ? { logger: params.logger } : {}),
      });
      // Surface bind failures (e.g. port in use) as warnings — manual
      // submit_code still works.
      ready.catch((err) =>
        params.logger?.warn(
          `mcp-auth-plugin: callback listener on port ${oauth2.callbackPort} failed to start: ${String(err)} — use submit_code to authorize manually`,
        ),
      );
    } catch (err) {
      params.logger?.warn(
        `mcp-auth-plugin: callback listener on port ${oauth2.callbackPort} could not start: ${String(err)} — manual code submission still works`,
      );
    }
  }

  return pending;
}

/**
 * Run the token exchange for a pending flow and persist the resulting tokens
 * under the flow's (per-user) serverKey. Clears the pending state, then
 * fetches this server's tool schemas with the fresh token and merges them
 * into the agent's template cache — WITHOUT touching other servers' cached
 * templates or other users' state. (The old behaviour of nuking the whole
 * agent cache forced an anonymous rediscovery that could never fetch OAuth2
 * schemas, and blanked every user's tools for a turn.)
 */
export async function completePendingFlow(params: {
  agentId: string;
  agentDir: string;
  serverKey: string;
  /** The user this flow belongs to — used for the post-auth schema fetch. */
  senderId?: string;
  code: string;
}): Promise<void> {
  const pending = getPendingForAgent(params.agentId).get(params.serverKey);
  if (!pending) {
    throw new Error(`oauth2: no pending flow for server ${params.serverKey}`);
  }
  const tokens = await exchangeCode({
    metadata: pending.metadata,
    clientId: pending.clientId,
    code: params.code,
    redirectUri: pending.redirectUri,
    verifier: pending.pkce.verifier,
  });
  saveTokens(params.agentDir, params.serverKey, {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken !== undefined ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
  });
  getPendingForAgent(params.agentId).delete(params.serverKey);
  getErrors().delete(params.agentId);

  // Populate the template cache using the tokens we just acquired. Best-effort:
  // if the fetch fails (transient upstream issue), tokens are already saved and
  // buildAuthTools' background schema fetch retries on the next turn.
  const meta = getServerMeta().get(params.agentId);
  const serverCfg = meta?.servers[pending.serverIndex];
  if (meta && serverCfg && isOAuth2Server(serverCfg)) {
    try {
      await fetchAndMergeServerTemplates({
        agentId: params.agentId,
        agentDir: params.agentDir,
        pluginCfg: meta.pluginCfg,
        serverCfg,
        serverIndex: pending.serverIndex,
        ...(params.senderId ? { senderId: params.senderId } : {}),
      });
    } catch {
      // Tokens saved; schemas arrive via the next turn's background fetch.
    }
  }
}

// ── Per-user schema fetch ─────────────────────────────────────────────────────

/**
 * Fetch an OAuth2 server's tool schemas using the given sender's tokens and
 * merge them into the agent's template cache, replacing only that server's
 * entries. Tool schemas are identity-independent; whose tokens fetched them
 * doesn't matter — but SOME user's tokens are required, and the anonymous
 * slot is reserved for pre-existing/legacy tokens only.
 *
 * Returns true when templates were merged.
 */
export async function fetchAndMergeServerTemplates(params: {
  agentId: string;
  agentDir: string;
  pluginCfg: PluginConfig;
  serverCfg: McpServerConfig & { oauth2: OAuth2ServerConfig };
  serverIndex: number;
  senderId?: string;
}): Promise<boolean> {
  const stableUrl = stableServerUrl(params.pluginCfg, params.serverCfg);
  if (!stableUrl) return false;
  const serverKey = serverKeyFor(stableUrl, params.senderId);

  let tokens = getTokens(params.agentDir, serverKey);
  if (!isAccessTokenFresh(tokens)) {
    tokens =
      (await refreshIfPossible({
        agentDir: params.agentDir,
        serverKey,
        upstreamUrl: stableUrl,
        oauth2: params.serverCfg.oauth2,
      })) ?? undefined;
  }
  if (!tokens?.accessToken) return false;

  const callUrl = resolveUpstreamUrl(params.pluginCfg, params.serverCfg, params.senderId) ?? stableUrl;
  const schemas = await fetchToolList({
    upstreamUrl: callUrl,
    authHeader: "Authorization",
    authValue: `Bearer ${tokens.accessToken}`,
  });
  const newTemplates = schemas.map((s) => buildToolTemplate(params.pluginCfg, params.serverCfg, s));

  // Replace only this server's templates. Match by stable URL, not by object
  // identity — config objects are re-created on every jiti reload.
  const existing = getCachedTemplates(params.agentId) ?? [];
  const kept = existing.filter((t) => stableServerUrl(t.pluginCfg, t.serverCfg) !== stableUrl);
  getCache().set(params.agentId, [...kept, ...newTemplates]);

  // Mark this server healthy in the per-server error ledger, if one exists.
  const serverErrors = getServerErrors().get(params.agentId);
  if (serverErrors && params.serverIndex < serverErrors.length) {
    serverErrors[params.serverIndex] = null;
  }
  return true;
}



// ── Discovery ─────────────────────────────────────────────────────────────────

/**
 * Anonymous discovery: fetches identity-independent tool schemas for every
 * configured server. For OAuth2 servers it may use tokens from the legacy
 * anonymous slot when present, but it NEVER kicks off an auth flow — flows
 * are strictly per-user and start from a user's connect tool (buildAuthTools)
 * or a user's own tool call.
 */
export async function discoverAndCache(params: {
  agentId: string;
  pluginCfg: PluginConfig;
  agentCfg: AgentConfig;
  agentDir?: string;
  logger?: { warn: (msg: string) => void };
}): Promise<void> {
  // Store server metadata immediately so health can report pending servers.
  getServerMeta().set(params.agentId, {
    pluginCfg: params.pluginCfg,
    servers: params.agentCfg.mcpServers,
  });

  const allTemplates: ToolTemplate[] = [];
  const serverErrors: (string | null)[] = [];

  for (let i = 0; i < params.agentCfg.mcpServers.length; i++) {
    const serverCfg = params.agentCfg.mcpServers[i]!;
    const url = resolveUpstreamUrl(params.pluginCfg, serverCfg, undefined);
    if (!url) {
      serverErrors.push(`mcp-auth-plugin: no upstream URL for a server in agent "${params.agentId}"`);
      continue;
    }

    if (isOAuth2Server(serverCfg)) {
      if (!params.agentDir) {
        serverErrors.push(
          `mcp-auth-plugin: agentDir required for OAuth2 server in agent "${params.agentId}"`,
        );
        continue;
      }
      const result = await discoverOAuth2Server({
        agentId: params.agentId,
        agentDir: params.agentDir,
        serverIndex: i,
        pluginCfg: params.pluginCfg,
        serverCfg,
        upstreamUrl: url.split("?")[0] ?? url, // OAuth2 server identity is the URL without query
        callUrl: url,
        ...(params.logger ? { logger: params.logger } : {}),
      });
      if (result.kind === "ok") {
        allTemplates.push(...result.templates);
        serverErrors.push(null);
      } else if (result.kind === "auth-pending") {
        serverErrors.push(null); // not an error — just awaiting user auth
      } else {
        serverErrors.push(result.error);
      }
      continue;
    }

    // API-key path (unchanged behaviour)
    const clientCfg = {
      upstreamUrl: url,
      authHeader: resolveAuthHeader(params.pluginCfg, serverCfg),
      authValue: serverCfg.apiKey ?? "",
    };
    try {
      const schemas = await fetchToolList(clientCfg);
      allTemplates.push(...schemas.map((schema) => buildToolTemplate(params.pluginCfg, serverCfg, schema)));
      serverErrors.push(null);
    } catch (err) {
      serverErrors.push(String(err));
    }
  }

  // Persist per-server outcomes regardless of overall result.
  getServerErrors().set(params.agentId, serverErrors);

  const allFailed =
    serverErrors.length > 0 &&
    serverErrors.every((e) => e !== null) &&
    getPendingForAgent(params.agentId).size === 0;
  if (allFailed) {
    const combined = serverErrors.filter(Boolean).join("; ");
    getErrors().set(params.agentId, combined);
    throw new Error(combined);
  }

  // Cache templates (could be empty if every server is auth-pending — that's fine,
  // we still want to skip re-discovery on the next turn).
  getCache().set(params.agentId, allTemplates);
  getErrors().delete(params.agentId);

  // Schedule a background retry for any servers that failed during this round.
  // The tool factory in index.ts is synchronous (OpenClaw requires it), so it
  // reads getCachedTemplates() on each turn. When the retry succeeds and merges
  // new tools into the cache, they appear on the next tool resolution call.
  const failedIndices = serverErrors
    .map((e, i) => (e !== null ? i : -1))
    .filter((i) => i >= 0);

  if (failedIndices.length > 0) {
    const RETRY_INTERVAL_MS = 5_000;
    const MAX_RETRIES = 12; // up to 60s of retries

    const retryLoop = async () => {
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const stillFailing = failedIndices.filter((i) => serverErrors[i] !== null);
        if (stillFailing.length === 0) break;

        await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));

        for (const i of stillFailing) {
          const serverCfg = params.agentCfg.mcpServers[i];
          const url = resolveUpstreamUrl(params.pluginCfg, serverCfg, undefined);
          if (!url) continue;
          const clientCfg = {
            upstreamUrl: url,
            authHeader: resolveAuthHeader(params.pluginCfg, serverCfg),
            authValue: serverCfg.apiKey,
          };
          try {
            const schemas = await fetchToolList(clientCfg);
            allTemplates.push(...schemas.map((s) => buildToolTemplate(params.pluginCfg, serverCfg, s)));
            serverErrors[i] = null;
          } catch {
            // Still failing — will retry next attempt
          }
        }
      }

      // Merge retry results into cache so the next sync factory call picks them up.
      getCache().set(params.agentId, allTemplates);
      getServerErrors().set(params.agentId, serverErrors);
    };

    // Fire-and-forget — the sync factory will read the updated cache on the next turn.
    retryLoop().catch(() => {});
  }
}

type OAuth2DiscoverResult =
  | { kind: "ok"; templates: ToolTemplate[] }
  | { kind: "auth-pending" }
  | { kind: "error"; error: string };

/**
 * Anonymous, schema-only OAuth2 discovery. Uses whatever tokens exist in the
 * legacy anonymous slot (pre-per-user deployments) to fetch tool schemas.
 * NEVER kicks off an auth flow and never performs dynamic client registration
 * — those happen strictly per-user via the connect tool. With no usable
 * anonymous tokens this simply reports auth-pending; the cache gets populated
 * later by fetchAndMergeServerTemplates once a user authorizes.
 */
async function discoverOAuth2Server(params: {
  agentId: string;
  agentDir: string;
  serverIndex: number;
  pluginCfg: PluginConfig;
  serverCfg: McpServerConfig & { oauth2: OAuth2ServerConfig };
  /** Stable URL used to key tokens (no query string). */
  upstreamUrl: string;
  /** URL used for the actual tools/list call (may include ?user_id). */
  callUrl: string;
  logger?: { warn: (msg: string) => void };
}): Promise<OAuth2DiscoverResult> {
  const serverKey = serverKeyFor(params.upstreamUrl);

  // 1. Try existing tokens (with refresh fallback).
  let tokens = getTokens(params.agentDir, serverKey);
  if (!isAccessTokenFresh(tokens)) {
    const refreshed = await refreshIfPossible({
      agentDir: params.agentDir,
      serverKey,
      upstreamUrl: params.upstreamUrl,
      oauth2: params.serverCfg.oauth2,
    });
    if (refreshed) tokens = refreshed;
  }

  if (isAccessTokenFresh(tokens) && tokens) {
    try {
      const schemas = await fetchToolList({
        upstreamUrl: params.callUrl,
        authHeader: "Authorization",
        authValue: `Bearer ${tokens.accessToken}`,
      });
      // Clear any stale pending flow for this server now that we're authenticated.
      getPendingForAgent(params.agentId).delete(serverKey);
      return {
        kind: "ok",
        templates: schemas.map((s) => buildToolTemplate(params.pluginCfg, params.serverCfg, s)),
      };
    } catch (err) {
      if (!(err instanceof McpUnauthorizedError)) {
        return { kind: "error", error: String(err) };
      }
      // 401 from the upstream: the access token was revoked/invalidated
      // server-side. Try the refresh_token once before forcing the user
      // through a full re-auth — clearTokens would wipe the refresh_token too.
      const refreshed = await refreshIfPossible({
        agentDir: params.agentDir,
        serverKey,
        upstreamUrl: params.upstreamUrl,
        oauth2: params.serverCfg.oauth2,
      });
      if (refreshed) {
        try {
          const schemas = await fetchToolList({
            upstreamUrl: params.callUrl,
            authHeader: "Authorization",
            authValue: `Bearer ${refreshed.accessToken}`,
          });
          getPendingForAgent(params.agentId).delete(serverKey);
          return {
            kind: "ok",
            templates: schemas.map((s) =>
              buildToolTemplate(params.pluginCfg, params.serverCfg, s),
            ),
          };
        } catch (retryErr) {
          if (!(retryErr instanceof McpUnauthorizedError)) {
            return { kind: "error", error: String(retryErr) };
          }
          // refresh succeeded but the new token also got 401 — give up and
          // kick off a fresh flow.
        }
      }
      clearTokens(params.agentDir, serverKey);
    }
  }

  // 2. No usable anonymous tokens. Under AgentCore/Pi the interactive flow can't run
  // (no inbound callback listener / co-located browser); OAuth2 servers are refresh-only
  // off a pre-seeded EFS token file. Surface a clear, actionable error rather than parking
  // a pending flow that can never complete.
  if (process.env.MCP_AUTH_NONINTERACTIVE === "1") {
    return {
      kind: "error",
      error:
        `OAuth2 token not seeded (or refresh failed) for ${params.upstreamUrl}. ` +
        `Interactive auth is disabled under AgentCore (MCP_AUTH_NONINTERACTIVE); ` +
        `pre-seed ${params.agentDir}/mcp-auth-oauth2-tokens.json with a valid refresh token.`,
    };
  }
  // Otherwise (ECS/OpenClaw): awaiting per-user authorization. Do NOT kick off a flow
  // here — flows are per-user and start from a user's connect tool. Kicking one off
  // anonymously would register junk DCR clients and plant a pending flow no user can
  // see or complete.
  return { kind: "auth-pending" };
}

/**
 * Returns the current PendingAuth for a user's server flow, regenerating it
 * via `kickoffOAuth2Flow` if the existing one is missing or expired. Used by
 * the connect tool so the agent can always recover a fresh URL after an
 * abandoned browser flow without the operator restarting the process.
 *
 * The caller supplies the server config directly (buildAuthTools iterates
 * config), so there is no fragile serverKey→config reverse lookup — the key
 * is derived here from the same stable URL used everywhere else.
 */
async function getOrRestartPendingFlow(params: {
  agentId: string;
  agentDir: string;
  senderId: string;
  serverIndex: number;
  serverCfg: McpServerConfig & { oauth2: OAuth2ServerConfig };
  /** Stable (query-stripped) upstream URL for this server. */
  upstreamUrl: string;
  logger?: { warn: (msg: string) => void };
}): Promise<PendingAuth> {
  const serverKey = serverKeyFor(params.upstreamUrl, params.senderId);
  const pending = getPendingForAgent(params.agentId).get(serverKey);
  if (pending && !isPendingExpired(pending)) return pending;

  // Drop the expired entry so kickoff installs a brand-new one with fresh
  // PKCE + state.
  if (pending) getPendingForAgent(params.agentId).delete(serverKey);

  return kickoffOAuth2Flow({
    agentId: params.agentId,
    agentDir: params.agentDir,
    serverIndex: params.serverIndex,
    serverCfg: params.serverCfg,
    upstreamUrl: params.upstreamUrl,
    senderId: params.senderId,
    ...(params.logger ? { logger: params.logger } : {}),
  });
}

// ── Per-turn synthetic tools for the OAuth2 flow ──────────────────────────────

/**
 * Build the synthetic `connect` and `submit_code` tools for every OAuth2
 * server. Config-driven and identity-agnostic at FACTORY time: in dispatcher
 * mode the factory-time sender is a per-session constant shared by all users
 * (see SENDER_PARAM), so tool VISIBILITY cannot depend on who is asking --
 * the tools are always surfaced and each call resolves the true sender from
 * the hook-injected per-call param (falling back to the factory sender for
 * channels that carry a real per-session identity, e.g. native DMs).
 *
 * connect for an already-authorized caller reports so -- and heals the
 * template cache using their tokens when schemas are missing (fresh install /
 * process restart), which is also the recovery path that makes the upstream
 * tools appear.
 */
export function buildAuthTools(params: {
  agentId: string;
  agentDir: string | undefined;
  /**
   * Factory-time sender -- a FALLBACK identity only, used when no per-call
   * sender was injected. Auth actions always act on the resolved caller's own
   * token slot and flow; one user never sees or completes another's.
   */
  senderId?: string;
  logger?: { warn: (msg: string) => void };
}): AnyAgentTool[] {
  const { agentId, agentDir, senderId } = params;
  if (!agentDir) return []; // can't act on auth without somewhere to persist
  const meta = getServerMeta().get(agentId);
  if (!meta) return [];

  const tools: AnyAgentTool[] = [];

  for (let i = 0; i < meta.servers.length; i++) {
    const serverCfg = meta.servers[i]!;
    if (!isOAuth2Server(serverCfg)) continue;
    const stableUrl = stableServerUrl(meta.pluginCfg, serverCfg);
    if (!stableUrl) continue;
    const serverIndex = i;
    const namePrefix = sanitizeToolPrefix(serverCfg.toolPrefix ?? `server${i}`);

    const noIdentityResult = () => {
      const err = {
        ok: false,
        error:
          `Cannot manage ${namePrefix} authorization: no sender identity is available in this ` +
          `context. Connections are per-user -- ask the user to interact from a DM or channel ` +
          `where their identity is known.`,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(err) }], details: err };
    };

    tools.push({
      name: `${TOOL_PREFIX}${namePrefix}__connect`,
      label: `${TOOL_PREFIX}${namePrefix}__connect`,
      description:
        `Get YOUR personal OAuth2 authorization URL for ${namePrefix}. Connections are per-user — ` +
        `each person authorizes their own account; another user's connection does not apply to you. ` +
        `Call this and present the URL to the user — they must visit it in a browser, sign in, and grant access. ` +
        (serverCfg.oauth2.callbackPort !== undefined
          ? `Once they complete the flow, the plugin's callback listener will exchange the code automatically and tools will appear on the next turn.`
          : `After they sign in, copy the 'code' query parameter from the redirect URL and pass it to the matching submit_code tool.`) +
        ` If the user abandons the previous flow or it expires, calling this again returns a fresh URL.`,
      parameters: { type: "object", properties: {} },
      execute: async (_callId: string, args: Record<string, unknown>) => {
        const caller = resolveEffectiveSender(args ?? {}, senderId);
        if (!caller) return noIdentityResult();
        try {
          // Already authorized? Report it -- and heal the template cache with
          // this caller's tokens if the server's schemas aren't cached yet
          // (fresh install / process restart recovery path).
          const callerKey = serverKeyFor(stableUrl, caller);
          if (isAccessTokenFresh(getTokens(agentDir, callerKey))) {
            const hasTemplates = (getCachedTemplates(agentId) ?? []).some(
              (t) => stableServerUrl(t.pluginCfg, t.serverCfg) === stableUrl,
            );
            if (!hasTemplates) {
              await fetchAndMergeServerTemplates({
                agentId,
                agentDir,
                pluginCfg: meta.pluginCfg,
                serverCfg,
                serverIndex,
                senderId: caller,
              });
            }
            const ok = {
              ok: true,
              alreadyConnected: true,
              message: hasTemplates
                ? `You are already connected to ${namePrefix}.`
                : `You are already connected to ${namePrefix}. Tools were just loaded and will be available on the next turn.`,
            };
            return { content: [{ type: "text" as const, text: JSON.stringify(ok) }], details: ok };
          }

          const current = await getOrRestartPendingFlow({
            agentId,
            agentDir,
            senderId: caller,
            serverIndex,
            serverCfg,
            upstreamUrl: stableUrl,
            ...(params.logger ? { logger: params.logger } : {}),
          });
          const payload = {
            authUrl: current.authUrl,
            serverIndex: current.serverIndex,
            callbackPort: current.oauth2.callbackPort ?? null,
            expiresAt: current.expiresAt,
            instructions:
              current.oauth2.callbackPort !== undefined
                ? "Open the authUrl in a browser. The plugin will automatically capture the code and acquire tokens."
                : `Open the authUrl in a browser, complete the sign-in, and then call ${TOOL_PREFIX}${namePrefix}__submit_code with the 'code' query parameter from the redirect URL.`,
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
            details: payload,
          };
        } catch (e) {
          // Surface IdP / network failures (metadata discovery, registration)
          // as a tool result so the agent can relay them to the user instead
          // of crashing out of the tool call.
          const err = { ok: false, error: `Could not initiate OAuth2 flow: ${String(e)}` };
          return { content: [{ type: "text" as const, text: JSON.stringify(err) }], details: err };
        }
      },
    });

    tools.push({
      name: `${TOOL_PREFIX}${namePrefix}__submit_code`,
      label: `${TOOL_PREFIX}${namePrefix}__submit_code`,
      description: `Submit an OAuth2 authorization code for ${namePrefix}. Use this only when the plugin's callback listener isn't reachable (e.g. no callback port configured, or the user is in a different browser).`,
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The 'code' value from the redirect URL." },
        },
        required: ["code"],
      },
      execute: async (_callId: string, args: Record<string, unknown>) => {
        const caller = resolveEffectiveSender(args ?? {}, senderId);
        if (!caller) return noIdentityResult();
        const serverKey = serverKeyFor(stableUrl, caller);
        const code = typeof args["code"] === "string" ? args["code"] : "";
        if (!code) {
          const err = { ok: false, error: "code is required" };
          return { content: [{ type: "text" as const, text: JSON.stringify(err) }], details: err };
        }
        // Look up the caller's live pending entry. If it expired, the verifier
        // no longer matches whatever the user is submitting, so refuse and
        // prompt for an explicit restart -- nothing regenerates flows silently.
        const live = getPendingForAgent(agentId).get(serverKey);
        if (!live) {
          const err = {
            ok: false,
            error: `No pending OAuth2 flow for ${namePrefix}. Call ${TOOL_PREFIX}${namePrefix}__connect first to get your authorization URL.`,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(err) }], details: err };
        }
        if (isPendingExpired(live)) {
          getPendingForAgent(agentId).delete(serverKey);
          const err = {
            ok: false,
            error: `Pending OAuth2 flow for ${namePrefix} expired. Call ${TOOL_PREFIX}${namePrefix}__connect to get a fresh authorization URL.`,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(err) }], details: err };
        }
        try {
          await completePendingFlow({
            agentId,
            agentDir,
            serverKey,
            senderId: caller,
            code,
          });
          const ok = {
            ok: true,
            message: `OAuth2 authorization complete for ${namePrefix}. Tools will be available on the next turn.`,
          };
          return { content: [{ type: "text" as const, text: JSON.stringify(ok) }], details: ok };
        } catch (e) {
          const err = { ok: false, error: String(e) };
          return { content: [{ type: "text" as const, text: JSON.stringify(err) }], details: err };
        }
      },
    });
  }
  return tools;
}

function sanitizeToolPrefix(raw: string): string {
  // Tool names must be a stable identifier-like string; strip anything that
  // could collide with the mcp_auth__ separator or break tool dispatch.
  return raw.replace(/[^A-Za-z0-9_]/g, "_");
}

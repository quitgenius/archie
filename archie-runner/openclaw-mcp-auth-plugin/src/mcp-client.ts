// MCP Streamable HTTP client (https://spec.modelcontextprotocol.io/specification/basic/transports/).
//
// Connector (and other servers) use this transport: each POST must include
// Accept: application/json, text/event-stream
// The response is either plain JSON or an SSE envelope (event: message\ndata: {...}).
//
// Servers that implement session management (e.g. DemoQueryApp Cloud) return an
// Mcp-Session-Id header on the initialize response. This client captures it
// and includes it on all subsequent requests to the same server endpoint.

import { Agent } from "undici";

export type McpToolSchema = {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
};

export type McpClientConfig = {
  upstreamUrl: string;
  /** Header name for auth, e.g. "x-api-key" or "Authorization". */
  authHeader: string;
  /** Header value, e.g. "ak_xxx" or "Bearer sk-xxx". */
  authValue: string;
  /**
   * Optional callback invoked when the upstream returns HTTP 401. Should refresh
   * credentials (e.g. via OAuth2 refresh_token) and resolve to the new
   * {header, value} pair, which is then used for a single retry. Throwing
   * propagates the original 401 to the caller after marking auth as failed.
   */
  onUnauthorized?: () => Promise<{ header: string; value: string }>;
};

type JsonRpcResponse<T> = {
  result?: T;
  error?: { code: number; message: string };
};

// ── Session management ──────────────────────────────────────────────────────
// MCP Streamable HTTP servers may require session tracking. The server returns
// an Mcp-Session-Id header in the initialize response; the client must echo it
// on every subsequent request.
//
// Sessions are established lazily: if the server returns HTTP 400/404 with a
// body mentioning "session"/"not initialized", the client sends `initialize`,
// captures the session ID, and retries. This avoids an extra roundtrip for
// servers that don't need it.
//
// CONNECTION AFFINITY: MCP session state is held per server *instance*. When the
// upstream is horizontally scaled behind a load balancer with no session
// affinity (e.g. demo_warehouse / DemoQueryApp Cloud), a session created on one backend returns
// 404 "Session not found or expired" if the next request is routed elsewhere.
// So each rpc() pins a single-connection undici dispatcher for the whole
// initialize→call sequence, keeping every request on one socket → one backend
// for the session's lifetime. The session store below is retained only for the
// exported clearSession() API and health/debug; it is NOT used to reuse a
// session across rpc() calls (that would cross connections/backends).

declare global {
  // eslint-disable-next-line no-var
  var __mcpSessionStore: Map<string, string> | undefined;
}

function getSessionStore(): Map<string, string> {
  globalThis.__mcpSessionStore ??= new Map();
  return globalThis.__mcpSessionStore;
}

/** Stable key from a URL — origin + pathname, ignoring query params. */
function sessionKeyFor(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Drop a cached session so the next request re-initializes. */
export function clearSession(url: string): void {
  getSessionStore().delete(sessionKeyFor(url));
}

/** Parse a response body that may be plain JSON or SSE-wrapped JSON (event: message\ndata: {...}). */
function parseResponseBody<T>(text: string): JsonRpcResponse<T> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as JsonRpcResponse<T>;
  }
  // SSE envelope: extract the first `data:` line
  for (const line of trimmed.split("\n")) {
    const stripped = line.trim();
    if (stripped.startsWith("data:")) {
      const json = stripped.slice("data:".length).trim();
      return JSON.parse(json) as JsonRpcResponse<T>;
    }
  }
  throw new Error(`Unexpected MCP response format: ${trimmed.slice(0, 200)}`);
}

type PostOpts = { sessionId?: string; isNotification?: boolean; dispatcher?: Agent };

// Node's fetch accepts an undici `dispatcher`, but the DOM RequestInit type omits it.
type FetchInit = RequestInit & { dispatcher?: Agent };

async function postJsonRpc(
  url: string,
  header: string,
  value: string,
  method: string,
  params: unknown,
  opts?: PostOpts,
): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    [header]: value,
  };
  if (opts?.sessionId) {
    headers["Mcp-Session-Id"] = opts.sessionId;
  }

  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (!opts?.isNotification) {
    body.id = 1;
  }
  if (params !== undefined) {
    body.params = params;
  }

  const init: FetchInit = {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    ...(opts?.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  };
  return fetch(url, init as RequestInit);
}

/**
 * Send `initialize` + `notifications/initialized` to establish an MCP session.
 * Returns the Mcp-Session-Id if the server provides one, undefined otherwise.
 */
async function initializeSession(
  url: string,
  header: string,
  value: string,
  dispatcher?: Agent,
): Promise<string | undefined> {
  const response = await postJsonRpc(url, header, value, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "openclaw-mcp-auth-plugin", version: "1.0.0" },
  }, { dispatcher });

  // Consume body so the connection can be reused.
  await response.text();

  if (!response.ok) {
    // Server may not support initialize — proceed without session.
    return undefined;
  }

  const sessionId = response.headers.get("mcp-session-id");
  if (!sessionId) return undefined;

  getSessionStore().set(sessionKeyFor(url), sessionId);

  // Complete the handshake with notifications/initialized — on the SAME
  // connection so it reaches the backend that just created the session.
  await postJsonRpc(url, header, value, "notifications/initialized", undefined, {
    sessionId,
    isNotification: true,
    dispatcher,
  })
    .then((r) => r.text())
    .catch(() => {});

  return sessionId;
}

/** Thrown when the upstream returns HTTP 401 and no refresh was possible. */
export class McpUnauthorizedError extends Error {
  constructor(public readonly body: string) {
    super(`MCP HTTP 401: ${body}`);
    this.name = "McpUnauthorizedError";
  }
}

async function rpc<T>(cfg: McpClientConfig, method: string, params?: unknown): Promise<T> {
  // Pin a single upstream connection for the whole initialize→call sequence.
  // MCP session ids are stored per server instance; behind a load balancer with
  // no session affinity, a session created on one backend 404s if a later
  // request lands on another. A single-connection dispatcher keeps every request
  // in this call on one socket → one backend for the session's lifetime.
  const dispatcher = new Agent({ connections: 1 });
  try {
    return await rpcOnConnection<T>(cfg, method, params, dispatcher);
  } finally {
    await dispatcher.close().catch(() => dispatcher.destroy());
  }
}

async function rpcOnConnection<T>(
  cfg: McpClientConfig,
  method: string,
  params: unknown,
  dispatcher: Agent,
): Promise<T> {
  let header = cfg.authHeader;
  let value = cfg.authValue;

  // Fresh connection → no session yet. Establish lazily: many servers don't need
  // one, so try the call first and only initialize on a session error.
  let sessionId: string | undefined;
  let response = await postJsonRpc(cfg.upstreamUrl, header, value, method, params, { sessionId, dispatcher });

  // 401 → try refreshing credentials, then retry on the same connection.
  if (response.status === 401 && cfg.onUnauthorized) {
    const refreshed = await cfg.onUnauthorized();
    header = refreshed.header;
    value = refreshed.value;
    response = await postJsonRpc(cfg.upstreamUrl, header, value, method, params, { sessionId, dispatcher });
  }

  if (response.status === 401) {
    throw new McpUnauthorizedError(await response.text());
  }

  // 400/404 indicating the server needs an MCP session established. Different
  // servers word this differently: DemoQueryApp Cloud returns 400/404 mentioning
  // "session"; DemoWarehouse returns 400 "Server not initialized". In all cases the fix is
  // the same: initialize (capturing the Mcp-Session-Id) on THIS connection and
  // retry the original request on it.
  if (response.status === 400 || response.status === 404) {
    const body = await response.text();
    const lower = body.toLowerCase();
    const needsSession =
      lower.includes("session") || lower.includes("not initialized") || lower.includes("initialize");
    if (needsSession) {
      sessionId = await initializeSession(cfg.upstreamUrl, header, value, dispatcher);
      response = await postJsonRpc(cfg.upstreamUrl, header, value, method, params, { sessionId, dispatcher });
      if (!response.ok) {
        throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
      }
    } else {
      throw new Error(`MCP HTTP ${response.status}: ${body}`);
    }
  }

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  }

  // Capture session ID from any response (retained for clearSession/health only).
  const respSessionId = response.headers.get("mcp-session-id");
  if (respSessionId) {
    getSessionStore().set(sessionKeyFor(cfg.upstreamUrl), respSessionId);
  }

  const parsed = parseResponseBody<T>(await response.text());
  if (parsed.error) {
    throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
  }
  if (parsed.result === undefined) {
    throw new Error(`MCP response missing result for method "${method}"`);
  }
  return parsed.result;
}

export async function fetchToolList(cfg: McpClientConfig): Promise<McpToolSchema[]> {
  const result = await rpc<{ tools: McpToolSchema[] }>(cfg, "tools/list");
  return result.tools ?? [];
}

export async function callTool(
  cfg: McpClientConfig,
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  return rpc(cfg, "tools/call", { name: toolName, arguments: input });
}

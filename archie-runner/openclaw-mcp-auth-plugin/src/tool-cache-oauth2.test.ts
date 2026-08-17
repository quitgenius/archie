// Integration tests for the OAuth2 path in tool-cache. Mocks oauth2.js and
// mcp-client.js so the flow is deterministic, and writes to a real tmp dir so
// the token-store paths exercise real fs I/O.
//
// Contract under test:
//   - discovery is anonymous and schema-only: it NEVER kicks off auth flows or
//     dynamic client registration
//   - connect/submit_code tools are config-driven per sender (buildAuthTools);
//     the flow is kicked off lazily inside connect
//   - completing a flow populates the template cache for that server instead
//     of invalidating the agent-wide cache

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauth2 from "./oauth2.js";
import * as mcpClient from "./mcp-client.js";
import { getClientId, getTokens, saveTokens, serverKeyFor } from "./token-store.js";
import {
  buildAuthTools,
  buildToolTemplate,
  completePendingFlow,
  discoverAndCache,
  getCachedTemplates,
  getPendingAuthForAgent,
  getPluginHealth,
  registerAgentCfg,
} from "./tool-cache.js";
import { shutdownAll } from "./callback-server.js";

vi.mock("./oauth2.js");
vi.mock("./mcp-client.js");

const mockedOauth2 = vi.mocked(oauth2);
const mockedMcpClient = vi.mocked(mcpClient);

const metadata: oauth2.OAuth2Metadata = {
  authorization_endpoint: "https://idp.example/auth",
  token_endpoint: "https://idp.example/token",
  registration_endpoint: "https://idp.example/register",
};

let dir: string;

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__mcpAuthPluginCache = undefined;
  globalThis.__mcpAuthPluginErrors = undefined;
  globalThis.__mcpAuthPluginServerMeta = undefined;
  globalThis.__mcpAuthPluginServerErrors = undefined;
  globalThis.__mcpAuthPluginPendingAuth = undefined;
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-tc-oauth2-"));

  // Default mock behaviours — individual tests override as needed.
  mockedOauth2.generatePkce.mockReturnValue({ verifier: "v", challenge: "c", method: "S256" });
  mockedOauth2.generateState.mockReturnValue("state-1");
  mockedOauth2.buildAuthUrl.mockReturnValue("https://idp.example/auth?state=state-1");
  mockedOauth2.discoverOAuth2Metadata.mockResolvedValue(metadata);
  mockedOauth2.registerClient.mockResolvedValue({ clientId: "dynamic-client-id" });
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await shutdownAll();
});

const oauth2Agent = () => ({
  mcpServers: [
    {
      upstreamUrl: "https://mcp.example/server-a",
      toolPrefix: "demo_query_app",
      oauth2: {
        redirectUri: "http://localhost:0/callback",
        clientId: "fixed-client-id", // skip dynamic registration in default tests
      },
    },
  ],
});

const SENDER = "U-alice";
const URL_A = "https://mcp.example/server-a";

async function connectAs(senderId: string, agentId = "main") {
  const tools = buildAuthTools({ agentId, agentDir: dir, senderId });
  const connect = tools.find((t) => t.name.endsWith("__connect"));
  expect(connect).toBeDefined();
  return connect!.execute("call-connect", {}, new AbortController().signal, () => {});
}

describe("OAuth2 discovery — no tokens yet", () => {
  it("reports auth-pending without kicking off any flow or registration", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });

    // No pending flow, no PKCE, no dynamic client registration — flows are
    // strictly per-user and start from a user's connect tool.
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
    expect(mockedOauth2.generatePkce).not.toHaveBeenCalled();
    expect(mockedOauth2.registerClient).not.toHaveBeenCalled();

    // No upstream tools yet — but discovery is considered "done" so we don't loop.
    expect(getCachedTemplates("main")).toEqual([]);
    expect(mockedMcpClient.fetchToolList).not.toHaveBeenCalled();
  });

  it("agent health reports auth-pending WITHOUT exposing any auth URL", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });
    // Even with one user's flow in flight, health must not leak their URL.
    await connectAs(SENDER);

    const [status] = getPluginHealth(["main"]);
    expect(status?.status).toBe("auth-pending");
    expect(status?.servers[0]?.status).toBe("auth-pending");
    expect(status?.servers[0]).not.toHaveProperty("authUrl");
  });

  it("buildAuthTools surfaces connect + submit_code for an unauthorized sender (config-driven, no pending flow required)", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });

    // No pending flows exist — the tools must come from config + token state.
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
    const tools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: SENDER });
    expect(tools.map((t) => t.name)).toEqual([
      "mcp_auth__demo_query_app__connect",
      "mcp_auth__demo_query_app__submit_code",
    ]);
  });

  it("connect kicks off the flow and returns the sender's auth URL", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });

    const result = await connectAs(SENDER);
    const details = result.details as { authUrl: string };
    expect(details.authUrl).toBe("https://idp.example/auth?state=state-1");

    const pending = getPendingAuthForAgent("main");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.serverKey).toBe(serverKeyFor(URL_A, SENDER));
    expect(pending[0]?.clientId).toBe("fixed-client-id");
  });

  it("dynamic registration happens at connect time and persists the client_id under the sender's key", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: {
        mcpServers: [
          {
            upstreamUrl: "https://mcp.example/server-a",
            toolPrefix: "demo_query_app",
            oauth2: { redirectUri: "http://localhost:0/callback" },
          },
        ],
      },
      agentDir: dir,
    });
    expect(mockedOauth2.registerClient).not.toHaveBeenCalled();

    await connectAs(SENDER);
    expect(mockedOauth2.registerClient).toHaveBeenCalledWith(
      expect.objectContaining({ registrationEndpoint: "https://idp.example/register" }),
    );
    const serverKey = serverKeyFor(URL_A, SENDER);
    expect(getClientId(dir, serverKey)).toBe("dynamic-client-id");
  });

  it("connect reports a clean error when no clientId is configured AND no registration endpoint exists", async () => {
    mockedOauth2.discoverOAuth2Metadata.mockResolvedValue({
      authorization_endpoint: metadata.authorization_endpoint,
      token_endpoint: metadata.token_endpoint,
    });

    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: {
        mcpServers: [
          {
            upstreamUrl: "https://mcp.example/server-a",
            toolPrefix: "demo_query_app",
            oauth2: { redirectUri: "http://localhost:0/callback" },
          },
        ],
      },
      agentDir: dir,
    });

    const result = await connectAs(SENDER);
    const details = result.details as { ok: boolean; error: string };
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/registration_endpoint/);
  });
});

describe("authorizationEndpoint override", () => {
  it("builds the auth URL against the configured public endpoint, not the discovered one", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: {
        mcpServers: [
          {
            upstreamUrl: "https://mcp.example/server-a",
            toolPrefix: "demo_query_app",
            oauth2: {
              redirectUri: "http://localhost:0/callback",
              clientId: "fixed-client-id",
              // The host's own authorize endpoint is VPN-gated; this public
              // page receives identical params via a 302 anyway.
              authorizationEndpoint: "https://public.example/auth/oauth2/authorize",
            },
          },
        ],
      },
      agentDir: dir,
    });

    await connectAs(SENDER);
    expect(mockedOauth2.buildAuthUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          authorization_endpoint: "https://public.example/auth/oauth2/authorize",
          token_endpoint: metadata.token_endpoint, // exchange still uses discovery
        }),
      }),
    );
  });
});

describe("OAuth2 discovery — with stored anonymous (legacy) tokens", () => {
  it("uses Bearer auth and caches tools when tokens are fresh", async () => {
    // Legacy/pre-per-user deployments hold tokens under the anonymous key —
    // discovery may keep using them for the identity-independent schema fetch.
    const serverKey = serverKeyFor(URL_A);
    saveTokens(dir, serverKey, {
      accessToken: "at-1",
      expiresAt: Date.now() + 60_000,
    });
    mockedMcpClient.fetchToolList.mockResolvedValue([
      { name: "search", description: "Search DemoQueryApp" },
    ]);

    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });

    expect(mockedMcpClient.fetchToolList).toHaveBeenCalledWith(
      expect.objectContaining({
        authHeader: "Authorization",
        authValue: "Bearer at-1",
      }),
    );
    const cached = getCachedTemplates("main");
    expect(cached?.map((t) => t.name)).toEqual(["mcp_auth__demo_query_app__search"]);
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
  });

  it("refreshes when the anonymous access token is stale but a refresh token is present", async () => {
    const serverKey = serverKeyFor(URL_A);
    saveTokens(dir, serverKey, {
      accessToken: "at-old",
      refreshToken: "rt-1",
      expiresAt: Date.now() - 5_000, // expired
    });
    mockedOauth2.refreshAccessToken.mockResolvedValue({
      accessToken: "at-new",
      tokenType: "Bearer",
      expiresAt: Date.now() + 60_000,
    });
    mockedMcpClient.fetchToolList.mockResolvedValue([{ name: "list" }]);

    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });

    expect(mockedOauth2.refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rt-1", clientId: "fixed-client-id" }),
    );
    expect(mockedMcpClient.fetchToolList).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "Bearer at-new" }),
    );
    expect(getTokens(dir, serverKey)?.accessToken).toBe("at-new");
  });
});

describe("completePendingFlow", () => {
  it("exchanges the code, persists tokens, and merges this server's templates into the cache", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });
    await connectAs(SENDER);

    mockedOauth2.exchangeCode.mockResolvedValue({
      accessToken: "at-new",
      refreshToken: "rt-new",
      expiresAt: Date.now() + 3600_000,
      tokenType: "Bearer",
    });
    mockedMcpClient.fetchToolList.mockResolvedValue([
      { name: "search", description: "Search DemoQueryApp" },
    ]);

    const serverKey = serverKeyFor(URL_A, SENDER);
    await completePendingFlow({ agentId: "main", agentDir: dir, serverKey, senderId: SENDER, code: "auth-code" });

    expect(mockedOauth2.exchangeCode).toHaveBeenCalledWith(
      expect.objectContaining({ code: "auth-code", verifier: "v" }),
    );
    expect(getTokens(dir, serverKey)?.accessToken).toBe("at-new");
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
    // The cache is POPULATED with this server's tools using the fresh token —
    // never invalidated (an anonymous rediscovery could not fetch them).
    expect(getCachedTemplates("main")?.map((t) => t.name)).toEqual(["mcp_auth__demo_query_app__search"]);
  });

  it("keeps other servers' cached templates intact when one server's flow completes", async () => {
    const apiKeyServer = { upstreamUrl: "https://mcp.example/demo_warehouse", toolPrefix: "rs", apiKey: "k" };
    const agentCfg = { mcpServers: [apiKeyServer, ...oauth2Agent().mcpServers] };
    // Seed cache as though discovery cached the API-key server's tools.
    const rsTemplate = buildToolTemplate({}, apiKeyServer, { name: "query" });
    globalThis.__mcpAuthPluginCache = new Map([["main", [rsTemplate]]]);
    registerAgentCfg("main", {}, agentCfg);

    await connectAs(SENDER);
    mockedOauth2.exchangeCode.mockResolvedValue({ accessToken: "at", tokenType: "Bearer" });
    mockedMcpClient.fetchToolList.mockResolvedValue([{ name: "search" }]);

    await completePendingFlow({
      agentId: "main",
      agentDir: dir,
      serverKey: serverKeyFor(URL_A, SENDER),
      senderId: SENDER,
      code: "c",
    });

    const names = getCachedTemplates("main")?.map((t) => t.name).sort();
    expect(names).toEqual(["mcp_auth__demo_query_app__search", "mcp_auth__rs__query"]);
  });

  it("still saves tokens when the post-auth schema fetch fails", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });
    await connectAs(SENDER);

    mockedOauth2.exchangeCode.mockResolvedValue({ accessToken: "at-new", tokenType: "Bearer" });
    mockedMcpClient.fetchToolList.mockRejectedValue(new Error("upstream down"));

    const serverKey = serverKeyFor(URL_A, SENDER);
    await completePendingFlow({ agentId: "main", agentDir: dir, serverKey, senderId: SENDER, code: "auth-code" });

    expect(getTokens(dir, serverKey)?.accessToken).toBe("at-new");
  });

  it("throws when called for a server with no pending flow", async () => {
    await expect(
      completePendingFlow({ agentId: "main", agentDir: dir, serverKey: "nope", code: "x" }),
    ).rejects.toThrow(/no pending flow/);
  });
});

describe("expired pending flows", () => {
  it("connect regenerates the URL when the sender's pending entry is expired", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });
    await connectAs(SENDER);
    const originalUrl = getPendingAuthForAgent("main")[0]!.authUrl;

    // Expire the pending entry.
    const inner = globalThis.__mcpAuthPluginPendingAuth!.get("main")!;
    for (const p of inner.values()) p.expiresAt = Date.now() - 1;
    mockedOauth2.generateState.mockReturnValue("state-restart");
    mockedOauth2.buildAuthUrl.mockReturnValue("https://idp.example/auth?state=state-restart");

    const result = await connectAs(SENDER);
    const details = result.details as { authUrl: string };
    expect(details.authUrl).toBe("https://idp.example/auth?state=state-restart");
    expect(details.authUrl).not.toBe(originalUrl);
    expect(getPendingAuthForAgent("main")[0]?.state).toBe("state-restart");
  });

  it("submit_code refuses an expired pending and points the user at connect — nothing regenerates it silently", async () => {
    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: oauth2Agent(),
      agentDir: dir,
    });
    await connectAs(SENDER);
    const tools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: SENDER });
    const submit = tools.find((t) => t.name.endsWith("__submit_code"))!;

    // Expire pending.
    const inner = globalThis.__mcpAuthPluginPendingAuth!.get("main")!;
    for (const p of inner.values()) p.expiresAt = Date.now() - 1;

    const result = await submit.execute(
      "call-1",
      { code: "any" },
      new AbortController().signal,
      () => {},
    );
    const details = result.details as { ok: boolean; error: string };
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/expired/);
    // Stale entry should be cleared by the refusal so connect can regenerate.
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
    // exchangeCode must never be called against an expired flow.
    expect(mockedOauth2.exchangeCode).not.toHaveBeenCalled();
  });
});

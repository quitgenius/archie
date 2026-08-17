import { describe, expect, it } from "vitest";
import { parsePluginConfig, resolveAuthHeader, resolveUpstreamUrl } from "./config.js";

describe("parsePluginConfig", () => {
  it("returns null for invalid input", () => {
    expect(parsePluginConfig(null)).toBeNull();
  });

  it("returns empty agents for empty config object", () => {
    expect(parsePluginConfig({})).toEqual({ upstreamUrl: undefined, defaultAuthHeader: undefined, agents: {} });
  });

  it("parses minimal valid config", () => {
    const result = parsePluginConfig({ upstreamUrl: "https://mcp.test" });
    expect(result?.upstreamUrl).toBe("https://mcp.test");
    expect(result?.agents).toEqual({});
  });

  it("parses per-agent mcpServers with api keys", () => {
    const result = parsePluginConfig({
      upstreamUrl: "https://mcp.test",
      agents: {
        dev: { mcpServers: [{ apiKey: "sk-dev" }] },
        ops: { mcpServers: [{ apiKey: "sk-ops" }] },
      },
    });
    expect(result?.agents?.["dev"]?.mcpServers[0]?.apiKey).toBe("sk-dev");
    expect(result?.agents?.["ops"]?.mcpServers[0]?.apiKey).toBe("sk-ops");
  });

  it("parses multiple mcpServers per agent", () => {
    const result = parsePluginConfig({
      agents: {
        main: {
          mcpServers: [
            { apiKey: "sk-connector", upstreamUrl: "https://connector.dev/mcp" },
            { apiKey: "sk-internal", upstreamUrl: "https://internal.mcp/tools" },
          ],
        },
      },
    });
    const servers = result?.agents?.["main"]?.mcpServers;
    expect(servers).toHaveLength(2);
    expect(servers?.[0]?.apiKey).toBe("sk-connector");
    expect(servers?.[1]?.apiKey).toBe("sk-internal");
  });

  it("parses senderUserMap and defaultUserId", () => {
    const result = parsePluginConfig({
      upstreamUrl: "https://mcp.test",
      agents: {
        main: {
          mcpServers: [
            {
              apiKey: "ak_xxx",
              senderUserMap: { U012AB: "pg-alice-id", U999XYZ: "pg-bob-id" },
              defaultUserId: "pg-fallback-id",
            },
          ],
        },
      },
    });
    const server = result?.agents?.["main"]?.mcpServers[0];
    expect(server?.senderUserMap).toEqual({
      U012AB: "pg-alice-id",
      U999XYZ: "pg-bob-id",
    });
    expect(server?.defaultUserId).toBe("pg-fallback-id");
  });

  it("parses toolPrefix per server", () => {
    const result = parsePluginConfig({
      agents: {
        main: {
          mcpServers: [
            { apiKey: "sk-a", upstreamUrl: "https://a.mcp", toolPrefix: "connector" },
            { apiKey: "sk-b", upstreamUrl: "https://b.mcp" },
          ],
        },
      },
    });
    const servers = result?.agents?.["main"]?.mcpServers;
    expect(servers?.[0]?.toolPrefix).toBe("connector");
    expect(servers?.[1]?.toolPrefix).toBeUndefined();
  });

  it("accepts legacy flat agent format (apiKey at agent level) as single-server", () => {
    const result = parsePluginConfig({
      upstreamUrl: "https://mcp.test",
      agents: {
        main: {
          apiKey: "ak_xxx",
          senderUserMap: { U012AB: "pg-alice-id" },
          defaultUserId: "pg-fallback-id",
        },
      },
    });
    const servers = result?.agents?.["main"]?.mcpServers;
    expect(servers).toHaveLength(1);
    expect(servers?.[0]?.apiKey).toBe("ak_xxx");
    expect(servers?.[0]?.senderUserMap).toEqual({ U012AB: "pg-alice-id" });
    expect(servers?.[0]?.defaultUserId).toBe("pg-fallback-id");
  });

  it("skips agent entries without mcpServers", () => {
    const result = parsePluginConfig({
      upstreamUrl: "https://mcp.test",
      agents: {
        dev: { mcpServers: [{ apiKey: "sk-dev" }] },
        bad: { notAKey: "oops" },
      },
    });
    expect(Object.keys(result?.agents ?? {})).toEqual(["dev"]);
  });

  it("skips agent entries with empty mcpServers array", () => {
    const result = parsePluginConfig({
      agents: {
        dev: { mcpServers: [{ apiKey: "sk-dev" }] },
        empty: { mcpServers: [] },
      },
    });
    expect(Object.keys(result?.agents ?? {})).toEqual(["dev"]);
  });

  it("skips server entries without apiKey or oauth2", () => {
    const result = parsePluginConfig({
      agents: {
        dev: {
          mcpServers: [
            { apiKey: "sk-dev" },
            { notAKey: "oops" },
          ],
        },
      },
    });
    expect(result?.agents?.["dev"]?.mcpServers).toHaveLength(1);
  });

  it("accepts a server with oauth2 instead of apiKey", () => {
    const result = parsePluginConfig({
      agents: {
        demo_query_app: {
          mcpServers: [
            {
              upstreamUrl: "https://ai.gcp-us-central1.demoquerycloud.dev/mcp/foo/bar",
              toolPrefix: "demo_query_app",
              oauth2: {
                redirectUri: "http://localhost:9876/callback",
                clientId: "demo_query_app-mcp-client",
                callbackPort: 9876,
                scopes: ["agent-fe3i69-access"],
                clientName: "openclaw",
              },
            },
          ],
        },
      },
    });
    const server = result?.agents?.["demo_query_app"]?.mcpServers[0];
    expect(server?.apiKey).toBeUndefined();
    expect(server?.oauth2?.redirectUri).toBe("http://localhost:9876/callback");
    expect(server?.oauth2?.clientId).toBe("demo_query_app-mcp-client");
    expect(server?.oauth2?.callbackPort).toBe(9876);
    expect(server?.oauth2?.scopes).toEqual(["agent-fe3i69-access"]);
    expect(server?.oauth2?.clientName).toBe("openclaw");
  });

  it("accepts oauth2 at the agent root (legacy flat format)", () => {
    const result = parsePluginConfig({
      agents: {
        demo_query_app: {
          upstreamUrl: "https://demo_query_app.example/mcp",
          oauth2: { redirectUri: "http://localhost:9876/callback" },
        },
      },
    });
    expect(result?.agents?.["demo_query_app"]?.mcpServers).toHaveLength(1);
    expect(result?.agents?.["demo_query_app"]?.mcpServers[0]?.oauth2?.redirectUri).toBe(
      "http://localhost:9876/callback",
    );
  });

  it("ignores oauth2 without redirectUri", () => {
    const result = parsePluginConfig({
      agents: {
        dev: {
          mcpServers: [
            { oauth2: { clientId: "no-redirect" } },
            { apiKey: "sk-dev" },
          ],
        },
      },
    });
    expect(result?.agents?.["dev"]?.mcpServers).toHaveLength(1);
    expect(result?.agents?.["dev"]?.mcpServers[0]?.apiKey).toBe("sk-dev");
  });

  it("allows both apiKey and oauth2 on the same server (oauth2 takes precedence at runtime)", () => {
    const result = parsePluginConfig({
      agents: {
        mixed: {
          mcpServers: [
            {
              apiKey: "sk-fallback",
              oauth2: { redirectUri: "http://localhost:9876/callback" },
            },
          ],
        },
      },
    });
    const server = result?.agents?.["mixed"]?.mcpServers[0];
    expect(server?.apiKey).toBe("sk-fallback");
    expect(server?.oauth2?.redirectUri).toBe("http://localhost:9876/callback");
  });
});

describe("resolveAuthHeader", () => {
  it("uses server-level authHeader when set", () => {
    const cfg = parsePluginConfig({ upstreamUrl: "u", defaultAuthHeader: "x-api-key" })!;
    expect(resolveAuthHeader(cfg, { apiKey: "k", authHeader: "Authorization" })).toBe("Authorization");
  });

  it("falls back to defaultAuthHeader", () => {
    const cfg = parsePluginConfig({ upstreamUrl: "u", defaultAuthHeader: "x-custom-key" })!;
    expect(resolveAuthHeader(cfg, { apiKey: "k" })).toBe("x-custom-key");
  });

  it("falls back to x-api-key when nothing set", () => {
    const cfg = parsePluginConfig({ upstreamUrl: "u" })!;
    expect(resolveAuthHeader(cfg, { apiKey: "k" })).toBe("x-api-key");
  });
});

describe("resolveUpstreamUrl", () => {
  const baseCfg = parsePluginConfig({ upstreamUrl: "https://backend.connector.dev/v3/mcp/server-id/mcp" })!;

  it("appends user_id for known sender", () => {
    const serverCfg = {
      apiKey: "k",
      senderUserMap: { U012AB: "pg-alice" },
      defaultUserId: "pg-default",
    };
    const url = resolveUpstreamUrl(baseCfg, serverCfg, "U012AB");
    expect(url).toBe("https://backend.connector.dev/v3/mcp/server-id/mcp?user_id=pg-alice");
  });

  it("uses defaultUserId when sender not in map", () => {
    const serverCfg = {
      apiKey: "k",
      senderUserMap: {},
      defaultUserId: "pg-default",
    };
    const url = resolveUpstreamUrl(baseCfg, serverCfg, "U_UNKNOWN");
    expect(url).toBe("https://backend.connector.dev/v3/mcp/server-id/mcp?user_id=pg-default");
  });

  it("uses defaultUserId when sender is undefined (discovery call)", () => {
    const serverCfg = { apiKey: "k", defaultUserId: "pg-default" };
    const url = resolveUpstreamUrl(baseCfg, serverCfg, undefined);
    expect(url).toBe("https://backend.connector.dev/v3/mcp/server-id/mcp?user_id=pg-default");
  });

  it("returns base URL without user_id when no mapping and no default", () => {
    const serverCfg = { apiKey: "k" };
    const url = resolveUpstreamUrl(baseCfg, serverCfg, undefined);
    expect(url).toBe("https://backend.connector.dev/v3/mcp/server-id/mcp");
  });

  it("prefers server-level upstreamUrl over plugin-level", () => {
    const serverCfg = { apiKey: "k", upstreamUrl: "https://other.mcp/server" };
    const url = resolveUpstreamUrl(baseCfg, serverCfg, undefined);
    expect(url).toBe("https://other.mcp/server");
  });
});

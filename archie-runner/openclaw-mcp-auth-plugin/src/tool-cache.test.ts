import { describe, expect, it, vi, beforeEach } from "vitest";
import * as mcpClient from "./mcp-client.js";
import { bindToolForTurn, buildToolTemplate, discoverAndCache, getCachedTemplates, getPluginHealth, registerAgentCfg } from "./tool-cache.js";
import type { PluginConfig, McpServerConfig } from "./config.js";

vi.mock("./mcp-client.js");

const mockFetchToolList = vi.mocked(mcpClient.fetchToolList);
const mockCallTool = vi.mocked(mcpClient.callTool);

const pluginCfg: PluginConfig = {
  upstreamUrl: "https://mcp.test/mcp",
  defaultAuthHeader: "x-api-key",
};

const serverCfg: McpServerConfig = {
  apiKey: "sk-test",
  defaultUserId: "pg-default",
};

const agentCfgWith = (servers: McpServerConfig[]) => ({ mcpServers: servers });

beforeEach(() => {
  vi.resetAllMocks();
  // Reset globalThis caches between tests so state doesn't leak.
  globalThis.__mcpAuthPluginCache = undefined;
  globalThis.__mcpAuthPluginErrors = undefined;
  globalThis.__mcpAuthPluginServerMeta = undefined;
  globalThis.__mcpAuthPluginServerErrors = undefined;
  globalThis.__mcpAuthPluginPendingAuth = undefined;
});

describe("buildToolTemplate", () => {
  it("prefixes tool name with mcp_auth__", () => {
    const t = buildToolTemplate(pluginCfg, serverCfg, { name: "search", description: "Search" });
    expect(t.name).toBe("mcp_auth__search");
    expect(t.mcpName).toBe("search");
  });

  it("adds toolPrefix to tool name when set", () => {
    const t = buildToolTemplate(pluginCfg, { ...serverCfg, toolPrefix: "connector" }, { name: "search" });
    expect(t.name).toBe("mcp_auth__connector__search");
    expect(t.mcpName).toBe("search");
  });

  it("captures serverCfg (including API key) in template", () => {
    const cfg: McpServerConfig = { apiKey: "sk-secret", defaultUserId: "pg-x" };
    const t = buildToolTemplate(pluginCfg, cfg, { name: "tool" });
    expect(t.serverCfg.apiKey).toBe("sk-secret");
  });
});

describe("discoverAndCache", () => {
  it("caches templates per agentId for a single server", async () => {
    mockFetchToolList.mockResolvedValue([
      { name: "search", description: "Search docs" },
      { name: "create_ticket" },
    ]);

    await discoverAndCache({
      agentId: "ops",
      pluginCfg,
      agentCfg: agentCfgWith([{ ...serverCfg, apiKey: "sk-ops" }]),
    });

    const cached = getCachedTemplates("ops");
    expect(cached).toHaveLength(2);
    expect(cached?.[0]?.name).toBe("mcp_auth__search");
    expect(cached?.[1]?.name).toBe("mcp_auth__create_ticket");
    expect(mockFetchToolList).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "sk-ops" }),
    );
  });

  it("merges tools from multiple servers for one agent", async () => {
    mockFetchToolList
      .mockResolvedValueOnce([{ name: "search" }, { name: "read" }])
      .mockResolvedValueOnce([{ name: "create_ticket" }]);

    await discoverAndCache({
      agentId: "ops",
      pluginCfg,
      agentCfg: agentCfgWith([
        { apiKey: "sk-connector", upstreamUrl: "https://connector.mcp", defaultUserId: "u1" },
        { apiKey: "sk-internal", upstreamUrl: "https://internal.mcp", defaultUserId: "u2" },
      ]),
    });

    const cached = getCachedTemplates("ops");
    expect(cached).toHaveLength(3);
    expect(cached?.map((t) => t.mcpName)).toEqual(["search", "read", "create_ticket"]);
    expect(mockFetchToolList).toHaveBeenCalledTimes(2);
    expect(mockFetchToolList).toHaveBeenNthCalledWith(1, expect.objectContaining({ authValue: "sk-connector" }));
    expect(mockFetchToolList).toHaveBeenNthCalledWith(2, expect.objectContaining({ authValue: "sk-internal" }));
  });

  it("applies toolPrefix per server when merging tools", async () => {
    mockFetchToolList
      .mockResolvedValueOnce([{ name: "search" }])
      .mockResolvedValueOnce([{ name: "search" }]);

    await discoverAndCache({
      agentId: "main",
      pluginCfg,
      agentCfg: agentCfgWith([
        { apiKey: "sk-a", upstreamUrl: "https://a.mcp", defaultUserId: "u1", toolPrefix: "alpha" },
        { apiKey: "sk-b", upstreamUrl: "https://b.mcp", defaultUserId: "u2", toolPrefix: "beta" },
      ]),
    });

    const cached = getCachedTemplates("main");
    expect(cached?.map((t) => t.name)).toEqual(["mcp_auth__alpha__search", "mcp_auth__beta__search"]);
  });

  it("different agents get different cached tool sets", async () => {
    mockFetchToolList
      .mockResolvedValueOnce([{ name: "read" }])
      .mockResolvedValueOnce([{ name: "read" }, { name: "write" }]);

    await discoverAndCache({ agentId: "dev", pluginCfg, agentCfg: agentCfgWith([{ ...serverCfg, apiKey: "sk-dev" }]) });
    await discoverAndCache({ agentId: "ops-2", pluginCfg, agentCfg: agentCfgWith([{ ...serverCfg, apiKey: "sk-ops" }]) });

    expect(getCachedTemplates("dev")).toHaveLength(1);
    expect(getCachedTemplates("ops-2")).toHaveLength(2);
  });

  it("partial success: caches tools from the working server and continues past the failing one", async () => {
    mockFetchToolList
      .mockRejectedValueOnce(new Error("HTTP 401: unauthorized"))
      .mockResolvedValueOnce([{ name: "query" }, { name: "list_tables" }]);

    await discoverAndCache({
      agentId: "agent-elt0m7",
      pluginCfg,
      agentCfg: agentCfgWith([
        { apiKey: "sk-bad", upstreamUrl: "https://bad.mcp", defaultUserId: "u1" },
        { apiKey: "sk-good", upstreamUrl: "https://good.mcp", defaultUserId: "u2", toolPrefix: "demo_warehouse" },
      ]),
    });

    const cached = getCachedTemplates("agent-elt0m7");
    expect(cached).toHaveLength(2);
    expect(cached?.map((t) => t.name)).toEqual(["mcp_auth__demo_warehouse__query", "mcp_auth__demo_warehouse__list_tables"]);
  });

  it("partial success: health shows per-server error and ready status", async () => {
    mockFetchToolList
      .mockRejectedValueOnce(new Error("HTTP 401: unauthorized"))
      .mockResolvedValueOnce([{ name: "query" }]);

    await discoverAndCache({
      agentId: "agent-elt0m7-2",
      pluginCfg,
      agentCfg: agentCfgWith([
        { apiKey: "sk-bad", upstreamUrl: "https://bad.mcp", defaultUserId: "u1" },
        { apiKey: "sk-good", upstreamUrl: "https://good.mcp", defaultUserId: "u2" },
      ]),
    });

    const [status] = getPluginHealth(["agent-elt0m7-2"]);
    expect(status?.status).toBe("partial");
    expect(status?.servers?.[0]?.status).toBe("error");
    expect(status?.servers?.[0]?.error).toMatch("401");
    expect(status?.servers?.[1]?.status).toBe("ready");
    expect(status?.servers?.[1]?.tools).toEqual(["query"]);
  });

  it("throws and records error when ALL servers fail", async () => {
    mockFetchToolList.mockRejectedValue(new Error("HTTP 401"));

    await expect(
      discoverAndCache({
        agentId: "agent-28qcnb",
        pluginCfg,
        agentCfg: agentCfgWith([
          { apiKey: "sk-x", upstreamUrl: "https://x.mcp", defaultUserId: "u1" },
          { apiKey: "sk-y", upstreamUrl: "https://y.mcp", defaultUserId: "u2" },
        ]),
      }),
    ).rejects.toThrow();

    expect(getCachedTemplates("agent-28qcnb")).toBeUndefined();
    const [status] = getPluginHealth(["agent-28qcnb"]);
    expect(status?.status).toBe("error");
    expect(status?.servers?.[0]?.status).toBe("error");
    expect(status?.servers?.[1]?.status).toBe("error");
  });

  it("throws when a server has no upstream URL and it is the only server", async () => {
    await expect(
      discoverAndCache({
        agentId: "agent-4j255v",
        pluginCfg: { defaultAuthHeader: "x-api-key" },
        agentCfg: agentCfgWith([{ apiKey: "sk-x" }]),
      }),
    ).rejects.toThrow("no upstream URL");
  });

  it("health shows per-server pending status before discovery", () => {
    registerAgentCfg("agent-akpbjp", pluginCfg, agentCfgWith([
      { apiKey: "sk-a", upstreamUrl: "https://a.mcp", defaultUserId: "u1" },
      { apiKey: "sk-b", upstreamUrl: "https://b.mcp", defaultUserId: "u2", toolPrefix: "demo_warehouse" },
    ]));

    const [status] = getPluginHealth(["agent-akpbjp"]);
    expect(status?.status).toBe("pending");
    expect(status?.servers).toHaveLength(2);
    expect(status?.servers?.[0]?.status).toBe("pending");
    expect(status?.servers?.[0]?.upstreamUrl).toBe("https://a.mcp");
    expect(status?.servers?.[1]?.status).toBe("pending");
    expect(status?.servers?.[1]?.toolPrefix).toBe("demo_warehouse");
  });

  it("health shows per-server breakdown after discovery", async () => {
    mockFetchToolList
      .mockResolvedValueOnce([{ name: "search" }, { name: "read" }])
      .mockResolvedValueOnce([{ name: "create_ticket" }]);

    await discoverAndCache({
      agentId: "ops-health",
      pluginCfg,
      agentCfg: agentCfgWith([
        { apiKey: "sk-a", upstreamUrl: "https://a.mcp", defaultUserId: "u1", toolPrefix: "alpha" },
        { apiKey: "sk-b", upstreamUrl: "https://b.mcp", defaultUserId: "u2" },
      ]),
    });

    const [status] = getPluginHealth(["ops-health"]);
    expect(status?.status).toBe("ready");
    expect(status?.toolCount).toBe(3);
    expect(status?.servers).toHaveLength(2);
    expect(status?.servers?.[0]).toMatchObject({
      upstreamUrl: "https://a.mcp",
      toolPrefix: "alpha",
      status: "ready",
      toolCount: 2,
      tools: ["search", "read"],
    });
    expect(status?.servers?.[1]).toMatchObject({
      upstreamUrl: "https://b.mcp",
      status: "ready",
      toolCount: 1,
      tools: ["create_ticket"],
    });
    expect(status?.servers?.[1]?.toolPrefix).toBeUndefined();
  });

  it("health falls back to plugin-level upstreamUrl when server has none", async () => {
    mockFetchToolList.mockResolvedValue([{ name: "tool" }]);

    await discoverAndCache({
      agentId: "agent-i1g9j0",
      pluginCfg,
      agentCfg: agentCfgWith([{ apiKey: "sk-x", defaultUserId: "u1" }]),
    });

    const [status] = getPluginHealth(["agent-i1g9j0"]);
    expect(status?.servers?.[0]?.upstreamUrl).toBe("https://mcp.test/mcp");
  });
});

describe("bindToolForTurn", () => {
  it("injects caller_id into tool call input", async () => {
    mockCallTool.mockResolvedValue({ items: [] });

    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });
    const tool = bindToolForTurn(template, "UEO9FMNBI");

    await tool.execute("call-1", { query: "hello" }, new AbortController().signal, () => {});

    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "sk-test" }),
      "search",
      { query: "hello", caller_id: "UEO9FMNBI" },
    );
  });

  it("omits caller_id when sender is undefined", async () => {
    mockCallTool.mockResolvedValue({});

    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });
    const tool = bindToolForTurn(template, undefined);

    await tool.execute("call-1", { query: "hello" }, new AbortController().signal, () => {});

    expect(mockCallTool).toHaveBeenCalledWith(
      expect.anything(),
      "search",
      { query: "hello" },
    );
  });

  it("uses the correct API key from serverCfg", async () => {
    mockCallTool.mockResolvedValue({});

    const opsCfg: McpServerConfig = { apiKey: "sk-ops-secret", defaultUserId: "pg-ops" };
    const template = buildToolTemplate(pluginCfg, opsCfg, { name: "create_ticket" });
    const tool = bindToolForTurn(template, "U999");

    await tool.execute("call-2", {}, new AbortController().signal, () => {});

    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "sk-ops-secret" }),
      "create_ticket",
      expect.objectContaining({ caller_id: "U999" }),
    );
  });

  it("resolves sender-specific user_id in the URL", async () => {
    mockCallTool.mockResolvedValue({});

    const serverWithMap: McpServerConfig = {
      apiKey: "sk-test",
      senderUserMap: { U012AB: "pg-alice" },
      defaultUserId: "pg-default",
    };
    const template = buildToolTemplate(pluginCfg, serverWithMap, { name: "search" });
    const tool = bindToolForTurn(template, "U012AB");

    await tool.execute("call-3", {}, new AbortController().signal, () => {});

    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamUrl: "https://mcp.test/mcp?user_id=pg-alice" }),
      "search",
      expect.anything(),
    );
  });

  it("falls back to defaultUserId when sender not in map", async () => {
    mockCallTool.mockResolvedValue({});

    const serverWithMap: McpServerConfig = {
      apiKey: "sk-test",
      senderUserMap: { U012AB: "pg-alice" },
      defaultUserId: "pg-default",
    };
    const template = buildToolTemplate(pluginCfg, serverWithMap, { name: "search" });
    const tool = bindToolForTurn(template, "U_UNKNOWN");

    await tool.execute("call-4", {}, new AbortController().signal, () => {});

    expect(mockCallTool).toHaveBeenCalledWith(
      expect.objectContaining({ upstreamUrl: "https://mcp.test/mcp?user_id=pg-default" }),
      "search",
      expect.anything(),
    );
  });
});

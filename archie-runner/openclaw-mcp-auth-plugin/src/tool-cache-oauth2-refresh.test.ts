// Verifies the 401 recovery paths: when an OAuth2 tool call gets a 401 from
// the upstream and no refresh is possible, the USER'S tokens are cleared —
// buildAuthTools then surfaces their connect/submit_code tools on the next
// turn (config-driven, keyed on the absence of fresh tokens). The shared
// template cache stays intact: other users' tools must not vanish because one
// user's session died.
//
// Unlike tool-cache-oauth2.test.ts, this file does NOT mock mcp-client — it
// mocks global fetch instead so the real `rpc()` 401-retry logic runs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauth2 from "./oauth2.js";
import { getTokens, saveTokens, serverKeyFor } from "./token-store.js";
import {
  bindToolForTurn,
  buildToolTemplate,
  discoverAndCache,
  getCachedTemplates,
  getPendingAuthForAgent,
} from "./tool-cache.js";
import type { McpServerConfig, PluginConfig } from "./config.js";

vi.mock("./oauth2.js");
const mockedOauth2 = vi.mocked(oauth2);

// Runtime OAuth2 tool calls are per-user: bindToolForTurn now requires a sender
// identity and keys tokens by it. These two tests exercise the runtime 401
// path as a concrete sender.
const SENDER = "U-alice";

let dir: string;

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__mcpAuthPluginCache = undefined;
  globalThis.__mcpAuthPluginErrors = undefined;
  globalThis.__mcpAuthPluginServerMeta = undefined;
  globalThis.__mcpAuthPluginServerErrors = undefined;
  globalThis.__mcpAuthPluginPendingAuth = undefined;
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-refresh-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("OAuth2 401 with no refresh path", () => {
  it("clears the user's tokens but leaves the shared template cache intact", async () => {
    const pluginCfg: PluginConfig = {};
    const upstreamUrl = "https://mcp.example/server-a";
    const serverCfg: McpServerConfig = {
      upstreamUrl,
      toolPrefix: "demo_query_app",
      oauth2: {
        redirectUri: "http://localhost:0/callback",
        clientId: "fixed-client-id",
      },
    };

    // Tokens exist but with NO refresh_token — refresh is impossible.
    const serverKey = serverKeyFor(upstreamUrl, SENDER);
    saveTokens(dir, serverKey, {
      accessToken: "at-stale",
      expiresAt: Date.now() + 60_000, // fresh-looking, but server says 401
    });

    // Seed the cache as though discovery had succeeded earlier.
    const template = buildToolTemplate(pluginCfg, serverCfg, {
      name: "search",
      description: "Search DemoQueryApp",
    });
    globalThis.__mcpAuthPluginCache = new Map([["main", [template]]]);
    expect(getCachedTemplates("main")).toHaveLength(1);

    // mcp-client.rpc retries once on 401, so we need two responses.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("unauthorized", { status: 401 });
    });

    const tool = bindToolForTurn(template, SENDER, dir, "main");

    await expect(
      tool.execute("call-1", {}, new AbortController().signal, () => {}),
    ).rejects.toThrow(/refresh unavailable/);

    // The user's tokens are cleared, so buildAuthTools surfaces THEIR
    // connect/submit_code tools on the next turn. The shared template cache
    // stays intact — other users' tools must not vanish.
    expect(getTokens(dir, serverKey)).toBeUndefined();
    expect(getCachedTemplates("main")).toHaveLength(1);

    // No refresh attempt should have been made (no refresh_token in store).
    expect(mockedOauth2.refreshAccessToken).not.toHaveBeenCalled();
    // The 401 retry from mcp-client means fetch is hit twice — once with the
    // original Bearer, once with whatever onUnauthorized returns (we throw
    // before returning a new header, so the retry never happens here).
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("retries with a refreshed token when refresh succeeds, leaving cache intact", async () => {
    const pluginCfg: PluginConfig = {};
    const upstreamUrl = "https://mcp.example/server-a";
    const serverCfg: McpServerConfig = {
      upstreamUrl,
      toolPrefix: "demo_query_app",
      oauth2: {
        redirectUri: "http://localhost:0/callback",
        clientId: "fixed-client-id",
      },
    };

    const serverKey = serverKeyFor(upstreamUrl, SENDER);
    saveTokens(dir, serverKey, {
      accessToken: "at-stale",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 60_000,
    });

    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });
    globalThis.__mcpAuthPluginCache = new Map([["main", [template]]]);
    globalThis.__mcpAuthPluginServerMeta = new Map([
      ["main", { pluginCfg, servers: [serverCfg] }],
    ]);

    mockedOauth2.refreshAccessToken.mockResolvedValue({
      accessToken: "at-new",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
    });
    mockedOauth2.discoverOAuth2Metadata.mockResolvedValue({
      authorization_endpoint: "https://idp.example/auth",
      token_endpoint: "https://idp.example/token",
    });

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      call++;
      const header = (init?.headers as Record<string, string>)["Authorization"];
      if (call === 1) {
        expect(header).toBe("Bearer at-stale");
        return new Response("unauthorized", { status: 401 });
      }
      // Retry should use the refreshed Bearer.
      expect(header).toBe("Bearer at-new");
      return new Response(JSON.stringify({ result: { items: [] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });

    const tool = bindToolForTurn(template, SENDER, dir, "main");
    await tool.execute("call-1", {}, new AbortController().signal, () => {});

    // Cache untouched — refresh succeeded, no need to re-discover.
    expect(getCachedTemplates("main")).toHaveLength(1);
    expect(mockedOauth2.refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "rt-1" }),
    );
  });
});

describe("OAuth2 discovery — 401 from tools/list with refresh available", () => {
  it("tries refresh once before clearing tokens and retries tools/list with the new Bearer", async () => {
    const upstreamUrl = "https://mcp.example/server-a";
    const serverCfg: McpServerConfig = {
      upstreamUrl,
      toolPrefix: "demo_query_app",
      oauth2: {
        redirectUri: "http://localhost:0/callback",
        clientId: "fixed-client-id",
      },
    };
    const serverKey = serverKeyFor(upstreamUrl);
    saveTokens(dir, serverKey, {
      accessToken: "at-stale-but-fresh-looking",
      refreshToken: "rt-1",
      expiresAt: Date.now() + 60_000,
    });

    mockedOauth2.discoverOAuth2Metadata.mockResolvedValue({
      authorization_endpoint: "https://idp.example/auth",
      token_endpoint: "https://idp.example/token",
    });
    mockedOauth2.refreshAccessToken.mockResolvedValue({
      accessToken: "at-refreshed",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
    });

    let call = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      call++;
      const auth = (init?.headers as Record<string, string>)["Authorization"];
      if (call === 1) {
        expect(auth).toBe("Bearer at-stale-but-fresh-looking");
        return new Response("revoked", { status: 401 });
      }
      // Retry must use the refreshed token.
      expect(auth).toBe("Bearer at-refreshed");
      return new Response(
        JSON.stringify({ result: { tools: [{ name: "search", description: "Search DemoQueryApp" }] } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: { mcpServers: [serverCfg] },
      agentDir: dir,
    });

    expect(mockedOauth2.refreshAccessToken).toHaveBeenCalledTimes(1);
    expect(getCachedTemplates("main")?.map((t) => t.name)).toEqual(["mcp_auth__demo_query_app__search"]);
    // refresh_token must survive — only a failing refresh wipes tokens.
    expect(getTokens(dir, serverKey)?.refreshToken).toBe("rt-1");
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
  });

  it("clears dead anonymous tokens WITHOUT kicking off any flow (flows are per-user only)", async () => {
    const upstreamUrl = "https://mcp.example/server-a";
    const serverCfg: McpServerConfig = {
      upstreamUrl,
      toolPrefix: "demo_query_app",
      oauth2: {
        redirectUri: "http://localhost:0/callback",
        clientId: "fixed-client-id",
      },
    };
    const serverKey = serverKeyFor(upstreamUrl);
    saveTokens(dir, serverKey, {
      accessToken: "at-stale",
      refreshToken: "rt-broken",
      expiresAt: Date.now() + 60_000,
    });

    mockedOauth2.discoverOAuth2Metadata.mockResolvedValue({
      authorization_endpoint: "https://idp.example/auth",
      token_endpoint: "https://idp.example/token",
    });
    mockedOauth2.refreshAccessToken.mockRejectedValue(new Error("invalid_grant"));

    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      return new Response("revoked", { status: 401 });
    });

    await discoverAndCache({
      agentId: "main",
      pluginCfg: {},
      agentCfg: { mcpServers: [serverCfg] },
      agentDir: dir,
    });

    expect(mockedOauth2.refreshAccessToken).toHaveBeenCalled();
    expect(getTokens(dir, serverKey)).toBeUndefined(); // cleared after both paths failed
    // No anonymous flow kicked off — no PKCE generated, no pending entry.
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
    expect(mockedOauth2.generatePkce).not.toHaveBeenCalled();
  });
});

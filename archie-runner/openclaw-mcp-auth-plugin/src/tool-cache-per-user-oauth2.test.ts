// Per-user OAuth2 isolation tests. The whole point of the user-scoped serverKey
// change: in a shared agent, one user authorizing DemoQueryApp must NOT grant another
// user access, and each user gets their own independent auth flow. These tests
// exercise the production paths: config-driven buildAuthTools, lazy in-tool
// flow kickoff, per-user token slots, and the post-auth schema fetch.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oauth2 from "./oauth2.js";
import * as mcpClient from "./mcp-client.js";
import { getTokens, saveTokens, serverKeyFor } from "./token-store.js";
import {
  bindToolForTurn,
  buildAuthTools,
  buildToolTemplate,
  fetchAndMergeServerTemplates,
  getCachedTemplates,
  getPendingAuthForAgent,
  registerAgentCfg,
} from "./tool-cache.js";
import { shutdownAll } from "./callback-server.js";
import type { McpServerConfig, PluginConfig } from "./config.js";

vi.mock("./oauth2.js");
vi.mock("./mcp-client.js");
const mockedOauth2 = vi.mocked(oauth2);
const mockedMcpClient = vi.mocked(mcpClient);

const URL_A = "https://mcp.example/server-a";
const ALICE = "U-alice";
const BOB = "U-bob";

const metadata: oauth2.OAuth2Metadata = {
  authorization_endpoint: "https://idp.example/auth",
  token_endpoint: "https://idp.example/token",
  registration_endpoint: "https://idp.example/register",
};

const pluginCfg: PluginConfig = {};
const serverCfg: McpServerConfig & { oauth2: NonNullable<McpServerConfig["oauth2"]> } = {
  upstreamUrl: URL_A,
  toolPrefix: "demo_query_app",
  oauth2: { redirectUri: "http://localhost:0/callback", clientId: "fixed-client-id" },
};
const agentCfg = () => ({ mcpServers: [serverCfg] });

let dir: string;

beforeEach(() => {
  vi.resetAllMocks();
  globalThis.__mcpAuthPluginCache = undefined;
  globalThis.__mcpAuthPluginErrors = undefined;
  globalThis.__mcpAuthPluginServerMeta = undefined;
  globalThis.__mcpAuthPluginServerErrors = undefined;
  globalThis.__mcpAuthPluginPendingAuth = undefined;
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-peruser-"));
  mockedOauth2.generatePkce.mockReturnValue({ verifier: "v", challenge: "c", method: "S256" });
  mockedOauth2.generateState.mockReturnValue("state-1");
  mockedOauth2.buildAuthUrl.mockReturnValue("https://idp.example/auth?state=state-1");
  mockedOauth2.discoverOAuth2Metadata.mockResolvedValue(metadata);
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await shutdownAll();
});

async function connectAs(senderId: string, agentId = "main") {
  const tools = buildAuthTools({ agentId, agentDir: dir, senderId });
  const connect = tools.find((t) => t.name.endsWith("__connect"));
  expect(connect).toBeDefined();
  return connect!.execute("call-connect", {}, new AbortController().signal, () => {});
}

describe("serverKeyFor — user-scoped keys", () => {
  it("with no sender equals the legacy URL-only hash (backward compatible)", () => {
    const legacy = createHash("sha1").update(URL_A).digest("hex").slice(0, 16);
    expect(serverKeyFor(URL_A)).toBe(legacy);
  });

  it("different senders produce different keys, and both differ from anonymous", () => {
    const anon = serverKeyFor(URL_A);
    const a = serverKeyFor(URL_A, ALICE);
    const b = serverKeyFor(URL_A, BOB);
    expect(a).not.toBe(b);
    expect(a).not.toBe(anon);
    expect(b).not.toBe(anon);
  });

  it("is stable for the same (url, sender) pair", () => {
    expect(serverKeyFor(URL_A, ALICE)).toBe(serverKeyFor(URL_A, ALICE));
  });
});

describe("token isolation between users", () => {
  it("Bob does not inherit Alice's token; Alice's own token is used for Alice", async () => {
    // Alice authorized earlier — her token is in the store under her key.
    saveTokens(dir, serverKeyFor(URL_A, ALICE), {
      accessToken: "alice-token",
      expiresAt: Date.now() + 60_000,
    });

    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });

    // Alice's tool call uses Alice's Bearer.
    mockedMcpClient.callTool.mockResolvedValue({ ok: true });
    const aliceTool = bindToolForTurn(template, ALICE, dir, "main");
    await aliceTool.execute("c1", {}, new AbortController().signal, () => {});
    expect(mockedMcpClient.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "Bearer alice-token" }),
      "search",
      expect.anything(),
    );

    // Bob has no token of his own → his call gets an auth-required result
    // directing him to HIS OWN connect tool — never Alice's session.
    mockedMcpClient.callTool.mockClear();
    const bobTool = bindToolForTurn(template, BOB, dir, "main");
    const result = await bobTool.execute("c2", {}, new AbortController().signal, () => {});
    const details = result.details as { ok: boolean; authRequired: boolean; error: string };
    expect(details.ok).toBe(false);
    expect(details.authRequired).toBe(true);
    expect(details.error).toContain("mcp_auth__demo_query_app__connect");
    expect(mockedMcpClient.callTool).not.toHaveBeenCalled();
    expect(getTokens(dir, serverKeyFor(URL_A, BOB))).toBeUndefined();
  });

  it("a user's unauthorized call never falls back to the anonymous token slot", async () => {
    // Legacy anonymous token exists (pre-per-user deployment) — Bob must NOT use it.
    saveTokens(dir, serverKeyFor(URL_A), {
      accessToken: "legacy-shared-token",
      expiresAt: Date.now() + 60_000,
    });
    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });
    const bobTool = bindToolForTurn(template, BOB, dir, "main");
    const result = await bobTool.execute("c1", {}, new AbortController().signal, () => {});
    const details = result.details as { ok: boolean; authRequired: boolean };
    expect(details.authRequired).toBe(true);
    expect(mockedMcpClient.callTool).not.toHaveBeenCalled();
  });
});

describe("no-identity guard", () => {
  it("refuses an OAuth2 tool call with no sender rather than using a shared slot", async () => {
    // Even if an anonymous-keyed token somehow exists, a no-sender call is refused.
    saveTokens(dir, serverKeyFor(URL_A), {
      accessToken: "anon-token",
      expiresAt: Date.now() + 60_000,
    });
    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });
    const tool = bindToolForTurn(template, undefined, dir, "main");
    await expect(
      tool.execute("c1", {}, new AbortController().signal, () => {}),
    ).rejects.toThrow(/per-user authentication/);
    expect(mockedMcpClient.callTool).not.toHaveBeenCalled();
  });
});

describe("independent auth flows per user", () => {
  it("each connect creates a flow under that sender's key; flows don't collide", async () => {
    registerAgentCfg("main", pluginCfg, agentCfg());

    mockedOauth2.buildAuthUrl.mockReturnValueOnce("https://idp.example/auth?flow=alice");
    await connectAs(ALICE);
    mockedOauth2.buildAuthUrl.mockReturnValueOnce("https://idp.example/auth?flow=bob");
    await connectAs(BOB);

    const pendingMap = globalThis.__mcpAuthPluginPendingAuth!.get("main")!;
    expect(pendingMap.has(serverKeyFor(URL_A, ALICE))).toBe(true);
    expect(pendingMap.has(serverKeyFor(URL_A, BOB))).toBe(true);
    expect(pendingMap.get(serverKeyFor(URL_A, ALICE))?.authUrl).toBe("https://idp.example/auth?flow=alice");
    expect(pendingMap.get(serverKeyFor(URL_A, BOB))?.authUrl).toBe("https://idp.example/auth?flow=bob");
  });

  it("connect/submit_code surface regardless of factory sender; execute refuses without any identity", async () => {
    registerAgentCfg("main", pluginCfg, agentCfg());

    // Every sender (even brand-new) has an entry point.
    const carolTools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: "U-carol" });
    expect(carolTools.map((t) => t.name)).toEqual([
      "mcp_auth__demo_query_app__connect",
      "mcp_auth__demo_query_app__submit_code",
    ]);
    // Tools surface even with no factory sender (dispatcher mode can still
    // inject a per-call sender) — but a call with NO identity at all refuses.
    const noSenderTools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: undefined });
    expect(noSenderTools.map((t) => t.name)).toEqual([
      "mcp_auth__demo_query_app__connect",
      "mcp_auth__demo_query_app__submit_code",
    ]);
    const connect = noSenderTools.find((t) => t.name.endsWith("__connect"))!;
    const result = await connect.execute("c1", {}, new AbortController().signal, () => {});
    const details = result.details as { ok: boolean; error: string };
    expect(details.ok).toBe(false);
    expect(details.error).toMatch(/no sender identity/);
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
  });

  it("DISPATCHER SCENARIO: same factory sender, per-call senders keep users isolated", async () => {
    // In dispatcher mode ctx.requesterSenderId is the dispatcher's gateway
    // client id — identical for every human. The before_tool_call hook injects
    // the true sender per call; keys must follow the per-call identity.
    const DISPATCHER = "gateway-client-1";
    registerAgentCfg("main", pluginCfg, agentCfg());

    const tools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: DISPATCHER });
    const connect = tools.find((t) => t.name.endsWith("__connect"))!;
    const submit = tools.find((t) => t.name.endsWith("__submit_code"))!;

    // Alice connects (per-call param carries her identity).
    mockedOauth2.buildAuthUrl.mockReturnValueOnce("https://idp.example/auth?flow=alice");
    await connect.execute("c1", { __mcpAuthSenderId: ALICE }, new AbortController().signal, () => {});
    expect(globalThis.__mcpAuthPluginPendingAuth!.get("main")!.has(serverKeyFor(URL_A, ALICE))).toBe(true);

    mockedOauth2.exchangeCode.mockResolvedValue({ accessToken: "alice-token", tokenType: "Bearer", expiresAt: Date.now() + 3600_000 });
    mockedMcpClient.fetchToolList.mockResolvedValue([{ name: "search" }]);
    await submit.execute("c2", { code: "alice-code", __mcpAuthSenderId: ALICE }, new AbortController().signal, () => {});

    // Alice's tokens landed under HER key — not the dispatcher's, not anonymous.
    expect(getTokens(dir, serverKeyFor(URL_A, ALICE))?.accessToken).toBe("alice-token");
    expect(getTokens(dir, serverKeyFor(URL_A, DISPATCHER))).toBeUndefined();
    expect(getTokens(dir, serverKeyFor(URL_A))).toBeUndefined();

    // Bob's demo_query_app call through the SAME factory binding gets auth-required.
    const template = getCachedTemplates("main")![0]!;
    const queryTool = bindToolForTurn(template, DISPATCHER, dir, "main");
    const bobResult = await queryTool.execute("c3", { __mcpAuthSenderId: BOB }, new AbortController().signal, () => {});
    expect((bobResult.details as { authRequired?: boolean }).authRequired).toBe(true);
    expect(mockedMcpClient.callTool).not.toHaveBeenCalled();

    // Alice's demo_query_app call through the same binding uses HER token, and the
    // routing param never reaches the upstream server.
    mockedMcpClient.callTool.mockResolvedValue({ ok: true });
    await queryTool.execute("c4", { q: "revenue", __mcpAuthSenderId: ALICE }, new AbortController().signal, () => {});
    expect(mockedMcpClient.callTool).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "Bearer alice-token" }),
      "search",
      { q: "revenue", caller_id: ALICE },
    );
  });

  it("Alice completing her flow does not authorize Bob, and populates the shared schema cache", async () => {
    registerAgentCfg("main", pluginCfg, agentCfg());
    await connectAs(ALICE);
    await connectAs(BOB);

    mockedOauth2.exchangeCode.mockResolvedValue({
      accessToken: "alice-token",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
    });
    mockedMcpClient.fetchToolList.mockResolvedValue([{ name: "search" }]);

    const aliceTools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: ALICE });
    const submit = aliceTools.find((t) => t.name.endsWith("__submit_code"))!;
    await submit.execute("c1", { code: "alice-code" }, new AbortController().signal, () => {});

    // Alice now has a token; Bob still has none, and his flow is untouched.
    expect(getTokens(dir, serverKeyFor(URL_A, ALICE))?.accessToken).toBe("alice-token");
    expect(getTokens(dir, serverKeyFor(URL_A, BOB))).toBeUndefined();
    expect(getPendingAuthForAgent("main").map((p) => p.serverKey)).toEqual([
      serverKeyFor(URL_A, BOB),
    ]);

    // Tool schemas (identity-independent) were fetched with Alice's token and
    // cached for the agent — so tools exist even on a fresh install where no
    // anonymous/legacy token ever could have fetched them.
    expect(getCachedTemplates("main")?.map((t) => t.name)).toEqual(["mcp_auth__demo_query_app__search"]);

    // And Bob's subsequent call still requires HIS auth.
    const template = getCachedTemplates("main")![0]!;
    const bobTool = bindToolForTurn(template, BOB, dir, "main");
    const result = await bobTool.execute("c2", {}, new AbortController().signal, () => {});
    expect((result.details as { authRequired?: boolean }).authRequired).toBe(true);
  });
});

describe("post-restart schema recovery (authorized user, empty cache)", () => {
  it("fetchAndMergeServerTemplates populates the cache using the sender's tokens", async () => {
    // Simulates a process restart: Alice's tokens are on disk, cache is empty,
    // anonymous discovery could not fetch schemas.
    saveTokens(dir, serverKeyFor(URL_A, ALICE), {
      accessToken: "alice-token",
      expiresAt: Date.now() + 60_000,
    });
    registerAgentCfg("main", pluginCfg, agentCfg());
    mockedMcpClient.fetchToolList.mockResolvedValue([{ name: "search" }]);

    const merged = await fetchAndMergeServerTemplates({
      agentId: "main",
      agentDir: dir,
      pluginCfg,
      serverCfg,
      serverIndex: 0,
      senderId: ALICE,
    });

    expect(merged).toBe(true);
    expect(mockedMcpClient.fetchToolList).toHaveBeenCalledWith(
      expect.objectContaining({ authValue: "Bearer alice-token" }),
    );
    expect(getCachedTemplates("main")?.map((t) => t.name)).toEqual(["mcp_auth__demo_query_app__search"]);
  });

  it("connect for an authorized caller reports already-connected and heals the template cache", async () => {
    saveTokens(dir, serverKeyFor(URL_A, ALICE), {
      accessToken: "alice-token",
      expiresAt: Date.now() + 60_000,
    });
    registerAgentCfg("main", pluginCfg, agentCfg());
    globalThis.__mcpAuthPluginCache = new Map([["main", []]]);
    mockedMcpClient.fetchToolList.mockResolvedValue([{ name: "search" }]);

    const tools = buildAuthTools({ agentId: "main", agentDir: dir, senderId: ALICE });
    const connect = tools.find((t) => t.name.endsWith("__connect"))!;
    const result = await connect.execute("c1", {}, new AbortController().signal, () => {});
    const details = result.details as { ok: boolean; alreadyConnected: boolean };
    expect(details.alreadyConnected).toBe(true);
    // No new flow kicked off for an authorized caller.
    expect(getPendingAuthForAgent("main")).toHaveLength(0);
    expect(getCachedTemplates("main")?.map((t) => t.name)).toEqual(["mcp_auth__demo_query_app__search"]);
  })
});

describe("per-user refresh isolation", () => {
  it("a refresh triggered by Alice's call updates only Alice's slot", async () => {
    saveTokens(dir, serverKeyFor(URL_A, ALICE), {
      accessToken: "alice-stale",
      refreshToken: "alice-rt",
      expiresAt: Date.now() - 1_000, // expired → refresh on call
    });
    saveTokens(dir, serverKeyFor(URL_A, BOB), {
      accessToken: "bob-token",
      refreshToken: "bob-rt",
      expiresAt: Date.now() + 60_000,
    });
    mockedOauth2.refreshAccessToken.mockResolvedValue({
      accessToken: "alice-refreshed",
      tokenType: "Bearer",
      expiresAt: Date.now() + 3600_000,
    });
    mockedMcpClient.callTool.mockResolvedValue({ ok: true });

    const template = buildToolTemplate(pluginCfg, serverCfg, { name: "search" });
    const aliceTool = bindToolForTurn(template, ALICE, dir, "main");
    await aliceTool.execute("c1", {}, new AbortController().signal, () => {});

    expect(mockedOauth2.refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "alice-rt" }),
    );
    expect(getTokens(dir, serverKeyFor(URL_A, ALICE))?.accessToken).toBe("alice-refreshed");
    // Bob's slot untouched.
    expect(getTokens(dir, serverKeyFor(URL_A, BOB))?.accessToken).toBe("bob-token");
  });
});

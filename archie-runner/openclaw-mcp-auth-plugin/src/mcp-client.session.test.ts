/**
 * Unit tests for the MCP Streamable HTTP session handshake recovery.
 *
 * Reproduces the DemoWarehouse failure mode: a server that requires an MCP session but
 * signals the missing session with `400 "Server not initialized"` (the body
 * does NOT contain the literal word "session"). The client must still
 * initialize-and-retry rather than throwing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearSession, fetchToolList } from "./mcp-client.js";
import type { McpClientConfig } from "./mcp-client.js";

const URL_UNDER_TEST = "https://demo_warehouse.example.test/mcp";

function cfg(): McpClientConfig {
  return {
    upstreamUrl: URL_UNDER_TEST,
    authHeader: "Authorization",
    authValue: "Bearer test-token",
  };
}

function jsonResponse(obj: unknown, init?: { status?: number; sessionId?: string }): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (init?.sessionId) headers.set("mcp-session-id", init.sessionId);
  return new Response(JSON.stringify(obj), { status: init?.status ?? 200, headers });
}

describe("mcp-client session recovery", () => {
  beforeEach(() => {
    clearSession(URL_UNDER_TEST);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    clearSession(URL_UNDER_TEST);
  });

  it("recovers from '400 Server not initialized' by initializing then retrying", async () => {
    const SID = "sid-123";
    const calls: Array<{ method: string; sessionId: string | null }> = [];

    const fetchMock = vi.fn(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(String(opts.body));
      const headers = new Headers(opts.headers);
      const sessionId = headers.get("Mcp-Session-Id");
      calls.push({ method: body.method, sessionId });

      // First tools/list with no session → 400 "Server not initialized"
      // (note: body intentionally does NOT contain the word "session").
      if (body.method === "tools/list" && !sessionId) {
        return jsonResponse(
          { jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: Server not initialized" }, id: null },
          { status: 400 },
        );
      }
      // initialize → 200 + session id header
      if (body.method === "initialize") {
        return jsonResponse(
          { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "demo_warehouse" } } },
          { sessionId: SID },
        );
      }
      // notifications/initialized → 202/200 empty
      if (body.method === "notifications/initialized") {
        return new Response("", { status: 202 });
      }
      // tools/list WITH session → success
      if (body.method === "tools/list" && sessionId === SID) {
        return jsonResponse({ jsonrpc: "2.0", id: 1, result: { tools: [{ name: "ask_demo_warehouse", description: "x" }] } });
      }
      return jsonResponse({ jsonrpc: "2.0", error: { code: -1, message: "unexpected" }, id: null }, { status: 500 });
    });

    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const tools = await fetchToolList(cfg());

    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe("ask_demo_warehouse");

    // Verify the handshake order: tools/list(no sid) → initialize → initialized → tools/list(sid)
    const methods = calls.map((c) => c.method);
    expect(methods).toContain("initialize");
    expect(methods).toContain("notifications/initialized");
    // The retried tools/list must carry the captured session id.
    const retried = calls.filter((c) => c.method === "tools/list").pop();
    expect(retried?.sessionId).toBe(SID);
  });

  it("does not loop/initialize on a generic 400 unrelated to sessions", async () => {
    const fetchMock = vi.fn(async (_url: string, opts: RequestInit) => {
      const body = JSON.parse(String(opts.body));
      if (body.method === "tools/list") {
        return jsonResponse(
          { jsonrpc: "2.0", error: { code: -32602, message: "Invalid params: bad cursor" }, id: null },
          { status: 400 },
        );
      }
      return new Response("", { status: 500 });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await expect(fetchToolList(cfg())).rejects.toThrow(/MCP HTTP 400/);
    // Should NOT have attempted an initialize for a non-session 400.
    const methods = fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)).method);
    expect(methods).not.toContain("initialize");
  });
});

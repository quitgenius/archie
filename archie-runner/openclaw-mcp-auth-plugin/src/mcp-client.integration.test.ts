/**
 * Integration tests against the real Connector MCP endpoint.
 * Run with: CONNECTOR_API_KEY=ak_xxx CONNECTOR_MCP_URL=https://... CONNECTOR_USER_ID=pg-xxx pnpm test -- integration
 *
 * Skipped automatically when env vars are absent so CI stays green.
 */
import { describe, expect, it } from "vitest";
import { callTool, fetchToolList } from "./mcp-client.js";
import type { McpClientConfig } from "./mcp-client.js";

const apiKey = process.env["CONNECTOR_API_KEY"];
const baseUrl = process.env["CONNECTOR_MCP_URL"];
const userId = process.env["CONNECTOR_USER_ID"];

const skip = !apiKey || !baseUrl || !userId;

function makeCfg(): McpClientConfig {
  const url = new URL(baseUrl!);
  url.searchParams.set("user_id", userId!);
  return {
    upstreamUrl: url.toString(),
    authHeader: "x-api-key",
    authValue: apiKey!,
  };
}

describe.skipIf(skip)("mcp-client integration (Connector)", () => {
  it("fetches tool list", async () => {
    const tools = await fetchToolList(makeCfg());
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThan(0);
    expect(tools[0]).toHaveProperty("name");
    expect(tools[0]).toHaveProperty("description");
    console.log(`Fetched ${tools.length} tools. First: ${tools[0]?.name}`);
  });

  it("calls a read-only tool (JIRA_FETCH_BULK_ISSUES with empty list)", async () => {
    // Provide an empty issueIdsOrKeys — should return without mutating anything.
    const result = await callTool(makeCfg(), "JIRA_FETCH_BULK_ISSUES", {
      issueIdsOrKeys: [],
    });
    expect(result).toBeDefined();
    console.log("Tool result:", JSON.stringify(result, null, 2).slice(0, 500));
  });
});

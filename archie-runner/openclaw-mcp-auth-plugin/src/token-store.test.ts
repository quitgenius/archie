import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearTokens,
  getClientId,
  getServerEntry,
  getTokens,
  isAccessTokenFresh,
  saveClientId,
  saveTokens,
  serverKeyFor,
} from "./token-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-token-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("serverKeyFor", () => {
  it("is deterministic for a given URL", () => {
    expect(serverKeyFor("https://example.com/mcp")).toBe(serverKeyFor("https://example.com/mcp"));
  });
  it("differs for different URLs", () => {
    expect(serverKeyFor("https://a.example/mcp")).not.toBe(serverKeyFor("https://b.example/mcp"));
  });
  it("is 16 hex chars", () => {
    expect(serverKeyFor("https://example.com/mcp")).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("token store reads and writes", () => {
  it("returns undefined for missing entries", () => {
    expect(getTokens(dir, "k")).toBeUndefined();
    expect(getClientId(dir, "k")).toBeUndefined();
    expect(getServerEntry(dir, "k")).toBeUndefined();
  });

  it("persists clientId and tokens separately", () => {
    saveClientId(dir, "k1", "client-abc", "demo_query_app");
    saveTokens(dir, "k1", { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 12345 });

    expect(getClientId(dir, "k1")).toBe("client-abc");
    const tokens = getTokens(dir, "k1");
    expect(tokens?.accessToken).toBe("at-1");
    expect(tokens?.refreshToken).toBe("rt-1");
    expect(tokens?.expiresAt).toBe(12345);

    const entry = getServerEntry(dir, "k1");
    expect(entry?.label).toBe("demo_query_app");
  });

  it("keeps clientId when saving new tokens", () => {
    saveClientId(dir, "k1", "client-abc");
    saveTokens(dir, "k1", { accessToken: "at-1" });
    saveTokens(dir, "k1", { accessToken: "at-2" });

    expect(getClientId(dir, "k1")).toBe("client-abc");
    expect(getTokens(dir, "k1")?.accessToken).toBe("at-2");
  });

  it("clearTokens removes only tokens", () => {
    saveClientId(dir, "k1", "client-abc");
    saveTokens(dir, "k1", { accessToken: "at-1" });
    clearTokens(dir, "k1");

    expect(getTokens(dir, "k1")).toBeUndefined();
    expect(getClientId(dir, "k1")).toBe("client-abc");
  });

  it("isolates servers within the same agent file", () => {
    saveTokens(dir, "k1", { accessToken: "at-1" });
    saveTokens(dir, "k2", { accessToken: "at-2" });
    expect(getTokens(dir, "k1")?.accessToken).toBe("at-1");
    expect(getTokens(dir, "k2")?.accessToken).toBe("at-2");
  });

  it("survives a fresh read of the file", () => {
    saveTokens(dir, "k1", { accessToken: "at-1" });
    // Simulate re-read by calling the read path again.
    expect(getTokens(dir, "k1")?.accessToken).toBe("at-1");
  });
});

describe("isAccessTokenFresh", () => {
  it("returns false for undefined or empty tokens", () => {
    expect(isAccessTokenFresh(undefined)).toBe(false);
    expect(isAccessTokenFresh({ accessToken: "" })).toBe(false);
  });

  it("returns true when expiry is in the future beyond skew", () => {
    expect(
      isAccessTokenFresh({ accessToken: "at", expiresAt: Date.now() + 60_000 }, 1000),
    ).toBe(true);
  });

  it("returns false when expiry is within the skew window", () => {
    expect(isAccessTokenFresh({ accessToken: "at", expiresAt: Date.now() + 100 }, 1000)).toBe(false);
  });

  it("returns true when no expiry is stored (long-lived token)", () => {
    expect(isAccessTokenFresh({ accessToken: "at" })).toBe(true);
  });
});

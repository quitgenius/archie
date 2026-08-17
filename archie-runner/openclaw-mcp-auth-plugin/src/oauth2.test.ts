import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  discoverOAuth2Metadata,
  exchangeCode,
  generatePkce,
  generateState,
  metadataUrlFor,
  refreshAccessToken,
  registerClient,
} from "./oauth2.js";

function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    return impl(url, init);
  });
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("metadataUrlFor", () => {
  it("strips path and appends the well-known suffix", () => {
    expect(metadataUrlFor("https://ai.gcp-us-central1.demoquerycloud.dev/mcp/foo/bar")).toBe(
      "https://ai.gcp-us-central1.demoquerycloud.dev/.well-known/oauth-authorization-server",
    );
  });
});

describe("discoverOAuth2Metadata", () => {
  it("returns parsed metadata on 200", async () => {
    mockFetch(async () =>
      jsonResponse({
        issuer: "https://example.com",
        authorization_endpoint: "https://example.com/auth",
        token_endpoint: "https://example.com/token",
        registration_endpoint: "https://example.com/register",
        scopes_supported: ["mcp"],
        code_challenge_methods_supported: ["S256"],
      }),
    );

    const meta = await discoverOAuth2Metadata("https://example.com/mcp");
    expect(meta.authorization_endpoint).toBe("https://example.com/auth");
    expect(meta.token_endpoint).toBe("https://example.com/token");
    expect(meta.registration_endpoint).toBe("https://example.com/register");
    expect(meta.scopes_supported).toEqual(["mcp"]);
  });

  it("throws when required endpoints are missing", async () => {
    mockFetch(async () => jsonResponse({ token_endpoint: "https://example.com/token" }));
    await expect(discoverOAuth2Metadata("https://example.com/mcp")).rejects.toThrow(
      /authorization_endpoint or token_endpoint/,
    );
  });

  it("throws on non-2xx", async () => {
    mockFetch(async () => new Response("nope", { status: 404 }));
    await expect(discoverOAuth2Metadata("https://example.com/mcp")).rejects.toThrow(/HTTP 404/);
  });
});

describe("registerClient", () => {
  it("POSTs registration payload and returns client_id", async () => {
    const spy = mockFetch(async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        client_name: "test-plugin",
        redirect_uris: ["https://cb.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
      });
      return jsonResponse({ client_id: "client-123" });
    });

    const result = await registerClient({
      registrationEndpoint: "https://example.com/register",
      redirectUri: "https://cb.example/callback",
      clientName: "test-plugin",
    });
    expect(result.clientId).toBe("client-123");
    expect(spy).toHaveBeenCalledWith("https://example.com/register", expect.any(Object));
  });

  it("throws if response lacks client_id", async () => {
    mockFetch(async () => jsonResponse({}));
    await expect(
      registerClient({ registrationEndpoint: "https://e/r", redirectUri: "https://cb" }),
    ).rejects.toThrow(/missing client_id/);
  });
});

describe("generatePkce", () => {
  it("produces verifier and S256 challenge", () => {
    const pkce = generatePkce();
    expect(pkce.method).toBe("S256");
    // base64url: 32 random bytes → 43 chars
    expect(pkce.verifier.length).toBe(43);
    expect(pkce.verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pkce.challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    // SHA-256 → 32 bytes → 43 chars base64url
    expect(pkce.challenge.length).toBe(43);
  });

  it("produces a unique verifier on each call", () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe("generateState", () => {
  it("produces 22-char base64url state", () => {
    const s = generateState();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(s.length).toBe(22); // 16 random bytes
  });
});

describe("buildAuthUrl", () => {
  const meta = {
    authorization_endpoint: "https://example.com/auth",
    token_endpoint: "https://example.com/token",
  };

  it("constructs URL with all required params", () => {
    const pkce = { verifier: "v", challenge: "c", method: "S256" as const };
    const url = new URL(
      buildAuthUrl({
        metadata: meta,
        clientId: "client-1",
        redirectUri: "https://cb/cb",
        pkce,
        state: "s",
      }),
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client-1");
    expect(url.searchParams.get("redirect_uri")).toBe("https://cb/cb");
    expect(url.searchParams.get("code_challenge")).toBe("c");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("s");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("adds scope when provided", () => {
    const url = new URL(
      buildAuthUrl({
        metadata: meta,
        clientId: "c",
        redirectUri: "https://cb",
        pkce: { verifier: "v", challenge: "ch", method: "S256" },
        state: "st",
        scopes: ["agent-fe3i69-access", "read"],
      }),
    );
    expect(url.searchParams.get("scope")).toBe("agent-fe3i69-access read");
  });
});

describe("exchangeCode", () => {
  const meta = {
    authorization_endpoint: "https://example.com/auth",
    token_endpoint: "https://example.com/token",
  };

  it("POSTs form body and returns parsed tokens with expiresAt", async () => {
    mockFetch(async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("authorization_code");
      expect(form.get("code")).toBe("auth-code");
      expect(form.get("code_verifier")).toBe("the-verifier");
      expect(form.get("client_id")).toBe("client-1");
      expect(form.get("redirect_uri")).toBe("https://cb");
      return jsonResponse({
        access_token: "at-1",
        refresh_token: "rt-1",
        expires_in: 3600,
        token_type: "Bearer",
      });
    });

    const result = await exchangeCode({
      metadata: meta,
      clientId: "client-1",
      code: "auth-code",
      redirectUri: "https://cb",
      verifier: "the-verifier",
      now: 1000,
    });
    expect(result.accessToken).toBe("at-1");
    expect(result.refreshToken).toBe("rt-1");
    expect(result.expiresAt).toBe(1000 + 3600 * 1000);
    expect(result.tokenType).toBe("Bearer");
  });

  it("throws when access_token is missing", async () => {
    mockFetch(async () => jsonResponse({ token_type: "Bearer" }));
    await expect(
      exchangeCode({
        metadata: meta,
        clientId: "c",
        code: "x",
        redirectUri: "https://cb",
        verifier: "v",
      }),
    ).rejects.toThrow(/missing access_token/);
  });

  it("propagates non-2xx with body", async () => {
    mockFetch(async () => new Response("invalid_grant", { status: 400 }));
    await expect(
      exchangeCode({
        metadata: meta,
        clientId: "c",
        code: "x",
        redirectUri: "https://cb",
        verifier: "v",
      }),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("refreshAccessToken", () => {
  const meta = {
    authorization_endpoint: "https://example.com/auth",
    token_endpoint: "https://example.com/token",
  };

  it("uses refresh_token grant and returns new tokens", async () => {
    mockFetch(async (_url, init) => {
      const form = new URLSearchParams(String(init?.body));
      expect(form.get("grant_type")).toBe("refresh_token");
      expect(form.get("refresh_token")).toBe("rt-old");
      expect(form.get("client_id")).toBe("client-1");
      return jsonResponse({
        access_token: "at-new",
        expires_in: 60,
      });
    });

    const result = await refreshAccessToken({
      metadata: meta,
      clientId: "client-1",
      refreshToken: "rt-old",
      now: 2000,
    });
    expect(result.accessToken).toBe("at-new");
    expect(result.expiresAt).toBe(2000 + 60_000);
    expect(result.refreshToken).toBeUndefined();
  });
});

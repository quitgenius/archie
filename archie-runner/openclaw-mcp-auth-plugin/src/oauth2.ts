// OAuth2 Authorization Code + PKCE flow for MCP servers (MCP spec 2025-03).
//
// Pure functions — no I/O beyond `fetch`, no persistence. The caller is
// responsible for storing tokens and managing pending-flow state.

import { createHash, randomBytes } from "node:crypto";

export type OAuth2Metadata = {
  /** Origin or issuer the metadata was discovered from. */
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  /** Optional — present when the server supports Dynamic Client Registration (RFC 7591). */
  registration_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
};

export type Pkce = {
  /** 43–128 char base64url-encoded high-entropy string. */
  verifier: string;
  /** base64url(SHA-256(verifier)). */
  challenge: string;
  method: "S256";
};

export type TokenResponse = {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms when the access token expires. Computed at fetch time. */
  expiresAt?: number;
  /** Echoed back so callers can record the granted scope. */
  scope?: string;
  /** Raw token type (almost always "Bearer"). */
  tokenType: string;
};

/**
 * Derive the OAuth2 metadata URL from an MCP server URL.
 * Per RFC 8414, the well-known suffix is appended to the issuer origin.
 */
export function metadataUrlFor(serverUrl: string): string {
  return new URL("/.well-known/oauth-authorization-server", serverUrl).toString();
}

export async function discoverOAuth2Metadata(serverUrl: string): Promise<OAuth2Metadata> {
  const url = metadataUrlFor(serverUrl);
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`OAuth2 metadata HTTP ${res.status} for ${url}: ${await res.text()}`);
  }
  const raw = (await res.json()) as Partial<OAuth2Metadata>;
  if (!raw.authorization_endpoint || !raw.token_endpoint) {
    throw new Error(
      `OAuth2 metadata at ${url} missing authorization_endpoint or token_endpoint`,
    );
  }
  return {
    issuer: raw.issuer,
    authorization_endpoint: raw.authorization_endpoint,
    token_endpoint: raw.token_endpoint,
    registration_endpoint: raw.registration_endpoint,
    scopes_supported: raw.scopes_supported,
    code_challenge_methods_supported: raw.code_challenge_methods_supported,
  };
}

/**
 * Dynamic client registration (RFC 7591). Returns the client_id assigned by the
 * authorization server. The server may return additional fields (client_secret,
 * client_id_issued_at, …) — only client_id is required for PKCE-only public
 * clients (token_endpoint_auth_method: "none").
 */
export async function registerClient(params: {
  registrationEndpoint: string;
  redirectUri: string;
  clientName?: string;
  scopes?: string[];
}): Promise<{ clientId: string }> {
  const body = {
    client_name: params.clientName ?? "openclaw-mcp-auth-plugin",
    redirect_uris: [params.redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...(params.scopes && params.scopes.length > 0 ? { scope: params.scopes.join(" ") } : {}),
  };
  const res = await fetch(params.registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `OAuth2 registration HTTP ${res.status} at ${params.registrationEndpoint}: ${await res.text()}`,
    );
  }
  const raw = (await res.json()) as { client_id?: unknown };
  if (typeof raw.client_id !== "string" || raw.client_id.length === 0) {
    throw new Error(`OAuth2 registration response missing client_id: ${JSON.stringify(raw)}`);
  }
  return { clientId: raw.client_id };
}

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): Pkce {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge, method: "S256" };
}

export function generateState(): string {
  return base64url(randomBytes(16));
}

export function buildAuthUrl(params: {
  metadata: OAuth2Metadata;
  clientId: string;
  redirectUri: string;
  pkce: Pkce;
  state: string;
  scopes?: string[];
}): string {
  const url = new URL(params.metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("code_challenge", params.pkce.challenge);
  url.searchParams.set("code_challenge_method", params.pkce.method);
  url.searchParams.set("state", params.state);
  if (params.scopes && params.scopes.length > 0) {
    url.searchParams.set("scope", params.scopes.join(" "));
  }
  return url.toString();
}

type RawTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
};

function parseTokenResponse(raw: RawTokenResponse, now: number): TokenResponse {
  if (typeof raw.access_token !== "string" || raw.access_token.length === 0) {
    throw new Error(`OAuth2 token response missing access_token: ${JSON.stringify(raw)}`);
  }
  return {
    accessToken: raw.access_token,
    refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
    expiresAt:
      typeof raw.expires_in === "number" && Number.isFinite(raw.expires_in)
        ? now + raw.expires_in * 1000
        : undefined,
    scope: typeof raw.scope === "string" ? raw.scope : undefined,
    tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
  };
}

async function postForm(
  endpoint: string,
  form: Record<string, string>,
): Promise<RawTokenResponse> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(form).toString(),
  });
  if (!res.ok) {
    throw new Error(`OAuth2 token endpoint HTTP ${res.status} at ${endpoint}: ${await res.text()}`);
  }
  return (await res.json()) as RawTokenResponse;
}

export async function exchangeCode(params: {
  metadata: OAuth2Metadata;
  clientId: string;
  code: string;
  redirectUri: string;
  verifier: string;
  /** Override "now" for tests; defaults to Date.now(). */
  now?: number;
}): Promise<TokenResponse> {
  const raw = await postForm(params.metadata.token_endpoint, {
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.verifier,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
  });
  return parseTokenResponse(raw, params.now ?? Date.now());
}

export async function refreshAccessToken(params: {
  metadata: OAuth2Metadata;
  clientId: string;
  refreshToken: string;
  /** Some servers require redirect_uri on refresh; harmless to include. */
  redirectUri?: string;
  now?: number;
}): Promise<TokenResponse> {
  const form: Record<string, string> = {
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  };
  if (params.redirectUri) form["redirect_uri"] = params.redirectUri;
  const raw = await postForm(params.metadata.token_endpoint, form);
  return parseTokenResponse(raw, params.now ?? Date.now());
}

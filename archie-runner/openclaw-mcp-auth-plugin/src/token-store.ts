// File-backed persistence for OAuth2 tokens and dynamically-registered client IDs.
//
// One JSON file per agent at <agentDir>/mcp-auth-oauth2-tokens.json. Entries are
// keyed by a stable hash of the server's upstream URL so a config reshuffle that
// reorders mcpServers entries doesn't lose tokens.
//
// All operations are synchronous because openclaw calls the plugin factory
// synchronously per turn and we need stored credentials available immediately.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STORE_FILENAME = "mcp-auth-oauth2-tokens.json";

export type StoredTokens = {
  accessToken: string;
  refreshToken?: string;
  /** Unix ms when the access token expires. Absent when the IdP didn't return expires_in. */
  expiresAt?: number;
  scope?: string;
};

export type StoredServerEntry = {
  /** Human-readable identifier (toolPrefix or upstreamUrl) for log debugging only. */
  label?: string;
  /** Dynamic-registration client_id; absent when a fixed clientId is configured. */
  clientId?: string;
  tokens?: StoredTokens;
};

type StoreFile = {
  /** Versioned to allow future migrations. */
  version: 1;
  servers: Record<string, StoredServerEntry>;
};

/**
 * Stable per-server, per-user key.
 *
 * The key is derived from the upstream URL (server identity) and, when
 * provided, the requesting user's sender ID. This is what keeps OAuth2
 * credentials PER-USER in shared agents: each sender gets their own token slot
 * and their own in-flight auth flow, so authorizing as one user never grants
 * another user access.
 *
 * Backward compatibility: when `senderId` is omitted the hash is byte-for-byte
 * identical to the previous URL-only scheme. That keeps single-user/DM agents
 * and anonymous schema discovery working without any token migration — only
 * agent-jw3ylv turns that carry a real sender get a distinct slot.
 *
 * A NUL byte separates the two components so no `senderId`/`url` pair can
 * collide with a different pair by concatenation.
 */
export function serverKeyFor(upstreamUrl: string, senderId?: string): string {
  const identity = senderId ? `${senderId}\u0000${upstreamUrl}` : upstreamUrl;
  return createHash("sha1").update(identity).digest("hex").slice(0, 16);
}

function pathFor(agentDir: string): string {
  return join(agentDir, STORE_FILENAME);
}

function readStore(agentDir: string): StoreFile {
  try {
    const raw = readFileSync(pathFor(agentDir), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    if (parsed && typeof parsed === "object" && parsed.servers && typeof parsed.servers === "object") {
      return { version: 1, servers: parsed.servers as Record<string, StoredServerEntry> };
    }
  } catch {
    // File missing, unreadable, or malformed — start fresh.
  }
  return { version: 1, servers: {} };
}

function writeStore(agentDir: string, store: StoreFile): void {
  const target = pathFor(agentDir);
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf-8");
  renameSync(tmp, target);
}

export function getServerEntry(
  agentDir: string,
  serverKey: string,
): StoredServerEntry | undefined {
  return readStore(agentDir).servers[serverKey];
}

export function getTokens(agentDir: string, serverKey: string): StoredTokens | undefined {
  return readStore(agentDir).servers[serverKey]?.tokens;
}

export function getClientId(agentDir: string, serverKey: string): string | undefined {
  return readStore(agentDir).servers[serverKey]?.clientId;
}

function updateEntry(
  agentDir: string,
  serverKey: string,
  patch: (entry: StoredServerEntry) => StoredServerEntry,
): void {
  const store = readStore(agentDir);
  const current = store.servers[serverKey] ?? {};
  store.servers[serverKey] = patch(current);
  writeStore(agentDir, store);
}

export function saveClientId(
  agentDir: string,
  serverKey: string,
  clientId: string,
  label?: string,
): void {
  updateEntry(agentDir, serverKey, (entry) => ({
    ...entry,
    ...(label ? { label } : {}),
    clientId,
  }));
}

export function saveTokens(
  agentDir: string,
  serverKey: string,
  tokens: StoredTokens,
  label?: string,
): void {
  updateEntry(agentDir, serverKey, (entry) => ({
    ...entry,
    ...(label ? { label } : {}),
    tokens,
  }));
}

export function clearTokens(agentDir: string, serverKey: string): void {
  updateEntry(agentDir, serverKey, (entry) => {
    const { tokens: _tokens, ...rest } = entry;
    return rest;
  });
}

/** True if the access token exists and is not within `skewMs` of expiry. */
export function isAccessTokenFresh(tokens: StoredTokens | undefined, skewMs = 30_000): boolean {
  if (!tokens?.accessToken) return false;
  if (tokens.expiresAt === undefined) return true; // no expiry → assume usable
  return tokens.expiresAt - skewMs > Date.now();
}

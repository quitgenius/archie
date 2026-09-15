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

/**
 * An authorization the user has started but not yet completed, persisted so it can survive the
 * process.
 *
 * Under OpenClaw the in-flight flow lives in memory (`getPendingForAgent`) because the container
 * outlives the browser round-trip. Under AgentCore it does not: the microVM is torn down at the
 * end of the turn, long before the user finishes authorizing. The verifier therefore has to be on
 * disk, or the code that comes back can never be exchanged.
 *
 * It stays in the AGENT'S OWN directory and is never sent anywhere. That is the whole reason the
 * forwarder Lambda can be trusted with an unauthenticated callback: it holds the code, this holds
 * the verifier, and neither is sufficient alone.
 */
export type PersistedPendingFlow = {
  state: string;
  verifier: string;
  clientId: string;
  redirectUri: string;
  tokenEndpoint: string;
  /** Unix ms. A flow older than this is abandoned, not completed. */
  expiresAt: number;
};

export type StoredServerEntry = {
  /** Human-readable identifier (toolPrefix or upstreamUrl) for log debugging only. */
  label?: string;
  /** Dynamic-registration client_id; absent when a fixed clientId is configured. */
  clientId?: string;
  tokens?: StoredTokens;
  /** Brokered (AgentCore) flows only; cleared as soon as the exchange succeeds or is abandoned. */
  pendingFlow?: PersistedPendingFlow;
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

/**
 * Persist an in-flight brokered authorization. See PersistedPendingFlow.
 *
 * One slot per serverKey, so a user restarting a flow replaces their own previous attempt rather
 * than accumulating verifiers. serverKey already folds in the sender, so this cannot clobber a
 * different user's flow in a shared agent.
 */
export function savePendingFlow(
  agentDir: string,
  serverKey: string,
  pendingFlow: PersistedPendingFlow,
  label?: string,
): void {
  updateEntry(agentDir, serverKey, (entry) => ({
    ...entry,
    ...(label ? { label } : {}),
    pendingFlow,
  }));
}

/** The in-flight flow, if one is still within its TTL. Expired flows read as absent. */
export function getPendingFlow(
  agentDir: string,
  serverKey: string,
  now = Date.now(),
): PersistedPendingFlow | undefined {
  const flow = getServerEntry(agentDir, serverKey)?.pendingFlow;
  if (!flow) return undefined;
  return flow.expiresAt > now ? flow : undefined;
}

export function clearPendingFlow(agentDir: string, serverKey: string): void {
  updateEntry(agentDir, serverKey, ({ pendingFlow: _dropped, ...rest }) => rest);
}

/**
 * Every server slot that currently has an in-flight brokered flow, newest TTL first.
 *
 * The landed callback identifies itself by `state`, not by serverKey — the forwarder Lambda knows
 * only what the IdP put in the redirect. So collection has to search the store for the slot whose
 * flow claims that state. Expired flows are omitted: a code arriving against one is too late.
 */
export function listPendingFlows(
  agentDir: string,
  now = Date.now(),
): Array<{ serverKey: string; flow: PersistedPendingFlow }> {
  const store = readStore(agentDir);
  return Object.entries(store.servers)
    .flatMap(([serverKey, entry]) =>
      entry.pendingFlow && entry.pendingFlow.expiresAt > now
        ? [{ serverKey, flow: entry.pendingFlow }]
        : [],
    );
}

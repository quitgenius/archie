import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectBrokeredCallbacks, completeBrokeredFlow, isBrokeredMode } from "./brokered.js";
import { getPendingFlow, getTokens, savePendingFlow } from "./token-store.js";
import * as oauth2 from "./oauth2.js";

let dir: string;
const KEY = "server-key-1";

const METADATA = {
  issuer: "https://idp.example",
  authorization_endpoint: "https://idp.example/authorize",
  token_endpoint: "https://idp.example/token",
};

const seedFlow = (overrides: Partial<Parameters<typeof savePendingFlow>[2]> = {}) =>
  savePendingFlow(dir, KEY, {
    state: "STATE-1",
    verifier: "VERIFIER-1",
    clientId: "client-1",
    redirectUri: "https://oauth.example/callback/dm-u1",
    tokenEndpoint: METADATA.token_endpoint,
    expiresAt: Date.now() + 60_000,
    ...overrides,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-auth-brokered-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("isBrokeredMode", () => {
  it("is off unless explicitly enabled", () => {
    expect(isBrokeredMode({})).toBe(false);
    expect(isBrokeredMode({ MCP_AUTH_BROKERED: "0" })).toBe(false);
    expect(isBrokeredMode({ MCP_AUTH_BROKERED: "1" })).toBe(true);
  });
});

describe("completeBrokeredFlow", () => {
  it("exchanges a landed code and stores the tokens", async () => {
    seedFlow();
    const spy = vi.spyOn(oauth2, "exchangeCode").mockResolvedValue({
      accessToken: "AT", refreshToken: "RT", expiresAt: 123, scope: "mcp",
    });

    const outcome = await completeBrokeredFlow({
      agentDir: dir, serverKey: KEY, metadata: METADATA,
      landed: { state: "STATE-1", code: "CODE-1" },
    });

    expect(outcome).toEqual({ kind: "completed", serverKey: KEY });
    // The verifier held on disk is what proves this exchange was ours.
    expect(spy.mock.calls[0]![0]).toMatchObject({ code: "CODE-1", verifier: "VERIFIER-1" });
    expect(getTokens(dir, KEY)).toMatchObject({ accessToken: "AT", refreshToken: "RT" });
    expect(getPendingFlow(dir, KEY)).toBeUndefined();
  });

  it("refuses a callback whose state does not match, and keeps the flow alive", async () => {
    // The login-CSRF case: somebody else's code, posted against our slot.
    seedFlow();
    const spy = vi.spyOn(oauth2, "exchangeCode");

    const outcome = await completeBrokeredFlow({
      agentDir: dir, serverKey: KEY, metadata: METADATA,
      landed: { state: "NOT-OURS", code: "ATTACKER-CODE" },
    });

    expect(outcome.kind).toBe("state-mismatch");
    expect(spy).not.toHaveBeenCalled();
    expect(getPendingFlow(dir, KEY), "the user may still finish their own flow").toBeDefined();
  });

  it("reports an IdP decline instead of waiting for a code that will never come", async () => {
    seedFlow();
    const outcome = await completeBrokeredFlow({
      agentDir: dir, serverKey: KEY, metadata: METADATA,
      landed: { state: "STATE-1", error: "access_denied", errorDescription: "User cancelled" },
    });
    expect(outcome).toMatchObject({ kind: "declined", error: "access_denied: User cancelled" });
    expect(getPendingFlow(dir, KEY)).toBeUndefined();
  });

  it("treats an expired flow as absent", async () => {
    seedFlow({ expiresAt: Date.now() - 1 });
    const outcome = await completeBrokeredFlow({
      agentDir: dir, serverKey: KEY, metadata: METADATA,
      landed: { state: "STATE-1", code: "CODE-1" },
    });
    expect(outcome.kind).toBe("no-pending");
  });

  it("does nothing when no flow was ever started", async () => {
    const outcome = await completeBrokeredFlow({
      agentDir: dir, serverKey: KEY, metadata: METADATA,
      landed: { state: "STATE-1", code: "CODE-1" },
    });
    expect(outcome.kind).toBe("no-pending");
  });

  it("clears the flow when the exchange fails — the code is spent either way", async () => {
    seedFlow();
    vi.spyOn(oauth2, "exchangeCode").mockRejectedValue(new Error("invalid_grant"));

    const outcome = await completeBrokeredFlow({
      agentDir: dir, serverKey: KEY, metadata: METADATA,
      landed: { state: "STATE-1", code: "CODE-1" },
    });

    expect(outcome.kind).toBe("failed");
    expect(getPendingFlow(dir, KEY), "retrying a spent code cannot succeed").toBeUndefined();
    expect(getTokens(dir, KEY)).toBeUndefined();
  });
});

describe("collectBrokeredCallbacks", () => {
  const queryReturning = (rows: Array<Record<string, unknown>>) => {
    const seen: string[] = [];
    return { seen, query: async (pk: string) => { seen.push(pk); return rows; } };
  };

  it("reads this agent's own drop-box partition, not AGENT#", async () => {
    const { seen, query } = queryReturning([]);
    await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query });
    expect(seen).toEqual(["OAUTH#dm-u1"]);
  });

  it("matches a landed row to the flow holding its state, and completes it", async () => {
    seedFlow();
    vi.spyOn(oauth2, "exchangeCode").mockResolvedValue({ accessToken: "AT" });
    const { query } = queryReturning([{ sk: "STATE#STATE-1", code: "CODE-1" }]);

    const outcomes = await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query });

    expect(outcomes).toEqual([{ kind: "completed", serverKey: KEY }]);
    expect(getTokens(dir, KEY)?.accessToken).toBe("AT");
  });

  it("derives state from the sort key when no attribute is present", async () => {
    seedFlow();
    const spy = vi.spyOn(oauth2, "exchangeCode").mockResolvedValue({ accessToken: "AT" });
    const { query } = queryReturning([{ sk: "STATE#STATE-1", code: "C" }]);
    await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query });
    expect(spy).toHaveBeenCalled();
  });

  it("ignores a row whose state matches no pending flow", async () => {
    seedFlow();
    const spy = vi.spyOn(oauth2, "exchangeCode");
    const { query } = queryReturning([{ sk: "STATE#SOMEONE-ELSE", code: "C" }]);

    const outcomes = await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query });

    expect(outcomes).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(getPendingFlow(dir, KEY)).toBeDefined();
  });

  it("a re-read of an already-collected row is a harmless no-op", async () => {
    // Rows are never deleted — the runtime is read-only on that table — so this happens on
    // every turn until the TTL sweeps them.
    seedFlow();
    vi.spyOn(oauth2, "exchangeCode").mockResolvedValue({ accessToken: "AT" });
    const { query } = queryReturning([{ sk: "STATE#STATE-1", code: "CODE-1" }]);

    await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query });
    const second = await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query });

    expect(second).toEqual([]);
    expect(getTokens(dir, KEY)?.accessToken, "the first result survives").toBe("AT");
  });

  it("a DynamoDB failure degrades to no completions, never a throw", async () => {
    seedFlow();
    const warn = vi.fn();
    const outcomes = await collectBrokeredCallbacks({
      agentDir: dir, agentId: "dm-u1",
      query: async () => { throw new Error("AccessDenied"); },
      logger: { warn },
    });
    expect(outcomes).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it("does nothing when the agent has no pending flows at all", async () => {
    const { query } = queryReturning([{ sk: "STATE#X", code: "C" }]);
    expect(await collectBrokeredCallbacks({ agentDir: dir, agentId: "dm-u1", query })).toEqual([]);
  });
});

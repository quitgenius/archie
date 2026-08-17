import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPending, registerPendingFlow, shutdownAll } from "./callback-server.js";

// Use an unlikely-to-be-in-use port. Each test gets its own pending state key.
const PORT = 49321;

afterEach(async () => {
  await shutdownAll();
});

async function callbackGet(port: number, query: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/callback?${query}`);
  return { status: res.status, body: await res.text() };
}

describe("callback server", () => {
  it("runs the onCode handler when a matching state arrives", async () => {
    let receivedCode: string | undefined;
    const { ready } = registerPendingFlow({
      port: PORT,
      state: "state-1",
      flow: {
        onCode: async (code) => {
          receivedCode = code;
        },
        expiresAt: Date.now() + 60_000,
      },
    });
    await ready;

    const { status } = await callbackGet(PORT, "code=auth-code-1&state=state-1");
    expect(status).toBe(200);
    expect(receivedCode).toBe("auth-code-1");
    expect(isPending(PORT, "state-1")).toBe(false);
  });

  it("returns 404 when no pending flow matches the state", async () => {
    const { ready } = registerPendingFlow({
      port: PORT,
      state: "real-state",
      flow: { onCode: async () => {}, expiresAt: Date.now() + 60_000 },
    });
    await ready;

    const { status, body } = await callbackGet(PORT, "code=x&state=unknown");
    expect(status).toBe(404);
    expect(body).toMatch(/No pending authorization/);
  });

  it("returns 400 when code or state is missing", async () => {
    const { ready } = registerPendingFlow({
      port: PORT,
      state: "s",
      flow: { onCode: async () => {}, expiresAt: Date.now() + 60_000 },
    });
    await ready;

    const { status, body } = await callbackGet(PORT, "code=only-code");
    expect(status).toBe(400);
    expect(body).toMatch(/Missing code or state/);
  });

  it("returns 400 when the IdP reports an error param", async () => {
    const aborts: string[] = [];
    const { ready } = registerPendingFlow({
      port: PORT,
      state: "s",
      flow: {
        onCode: async () => {},
        onAbort: (reason) => aborts.push(reason),
        expiresAt: Date.now() + 60_000,
      },
    });
    await ready;

    const { status, body } = await callbackGet(
      PORT,
      "error=access_denied&error_description=user+declined&state=s",
    );
    expect(status).toBe(400);
    expect(body).toMatch(/access_denied/);
    // Pending should be cleared even on error.
    expect(isPending(PORT, "s")).toBe(false);
    // onAbort fires with the IdP error so callers can clear companion state.
    expect(aborts).toEqual(["access_denied — user declined"]);
  });

  it("returns 500 when onCode throws and clears the pending flow", async () => {
    const aborts: string[] = [];
    const { ready } = registerPendingFlow({
      port: PORT,
      state: "s",
      flow: {
        onCode: async () => {
          throw new Error("exchange blew up");
        },
        onAbort: (reason) => aborts.push(reason),
        expiresAt: Date.now() + 60_000,
      },
    });
    await ready;

    const { status, body } = await callbackGet(PORT, "code=x&state=s");
    expect(status).toBe(500);
    expect(body).toMatch(/exchange blew up/);
    expect(isPending(PORT, "s")).toBe(false);
    // Exchange failure also fires onAbort so callers can regenerate the flow.
    expect(aborts).toHaveLength(1);
    expect(aborts[0]).toMatch(/exchange blew up/);
  });

  it("supports concurrent flows on the same port via state demux", async () => {
    const received: string[] = [];
    const r1 = registerPendingFlow({
      port: PORT,
      state: "alpha",
      flow: {
        onCode: async (code) => {
          received.push(`alpha:${code}`);
        },
        expiresAt: Date.now() + 60_000,
      },
    });
    const r2 = registerPendingFlow({
      port: PORT,
      state: "beta",
      flow: {
        onCode: async (code) => {
          received.push(`beta:${code}`);
        },
        expiresAt: Date.now() + 60_000,
      },
    });
    await Promise.all([r1.ready, r2.ready]);

    await callbackGet(PORT, "code=a&state=alpha");
    await callbackGet(PORT, "code=b&state=beta");
    expect(received.sort()).toEqual(["alpha:a", "beta:b"]);
  });

  it("cancel() removes a pending flow", async () => {
    const { cancel, ready } = registerPendingFlow({
      port: PORT,
      state: "to-cancel",
      flow: { onCode: async () => {}, expiresAt: Date.now() + 60_000 },
    });
    await ready;
    expect(isPending(PORT, "to-cancel")).toBe(true);
    cancel();
    expect(isPending(PORT, "to-cancel")).toBe(false);
  });
});

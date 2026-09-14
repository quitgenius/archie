import assert from "node:assert/strict";
import test from "node:test";

import plugin from "./index.ts";

test("slack_send carries the Pi logical session key to the dispatcher", async () => {
  const oldProxyUrl = process.env.SLACK_PROXY_URL;
  const oldSecret = process.env.DISPATCHER_SHARED_SECRET;
  const oldFetch = globalThis.fetch;
  process.env.SLACK_PROXY_URL = "https://dispatcher.example";
  process.env.DISPATCHER_SHARED_SECRET = "test-secret";

  const factories: Array<(context: Record<string, unknown>) => unknown> = [];
  plugin.register({
    logger: { info() {}, warn() {}, error() {} },
    registerTool(factory: (context: Record<string, unknown>) => unknown) {
      factories.push(factory);
    },
  } as never);

  const tools = factories.flatMap((factory) => {
    const value = factory({ sessionKey: "slack:thread:D0ABC:1789039774.094039" });
    return Array.isArray(value) ? value : [value];
  }) as Array<{
    name: string;
    execute(toolCallId: string, args: Record<string, unknown>): Promise<unknown>;
  }>;
  const slackSend = tools.find((tool) => tool.name === "slack_send");
  assert.ok(slackSend);

  let request: RequestInit | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response(JSON.stringify({ ok: true, ts: "1.2" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await slackSend.execute("tool-1", { channel: "D0ABC", text: "hello" });
    assert.equal(
      (request?.headers as Record<string, string>)["x-archie-session-key"],
      "slack:thread:D0ABC:1789039774.094039",
    );
    assert.deepEqual(JSON.parse(String(request?.body)), { channel: "D0ABC", text: "hello" });
  } finally {
    globalThis.fetch = oldFetch;
    if (oldProxyUrl === undefined) delete process.env.SLACK_PROXY_URL;
    else process.env.SLACK_PROXY_URL = oldProxyUrl;
    if (oldSecret === undefined) delete process.env.DISPATCHER_SHARED_SECRET;
    else process.env.DISPATCHER_SHARED_SECRET = oldSecret;
  }
});

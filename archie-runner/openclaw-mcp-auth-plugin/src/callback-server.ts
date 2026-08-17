// Lightweight HTTP listener for the OAuth2 redirect_uri.
//
// One server per port is started lazily and shared across all pending flows in
// the process. Each pending flow is keyed by its OAuth2 `state` param so the
// listener can demux concurrent flows. Servers + pending-flow maps live on
// globalThis so the plugin survives openclaw's per-turn module reloads.

import { createServer, type Server } from "node:http";

export type PendingFlow = {
  /** Caller-supplied callback that runs the token exchange. Resolves on success. */
  onCode: (code: string) => Promise<void>;
  /** Called when the flow times out without a matching callback. */
  onTimeout?: () => void;
  /**
   * Called when the IdP redirect carries an error param, or when the token
   * exchange (onCode) rejects. Lets the caller clear any companion state it
   * keeps outside this server (e.g. an entry in tool-cache.getPendingForAgent)
   * so the next `connect` regenerates a fresh URL instead of handing back the
   * dead one.
   */
  onAbort?: (reason: string) => void;
  /** When the flow expires and should be removed. */
  expiresAt: number;
};

type PortState = {
  server: Server;
  /** state → flow */
  pending: Map<string, PendingFlow>;
  /** Set by listen(), cleared on close. */
  ready: Promise<void>;
};

declare global {
  // eslint-disable-next-line no-var
  var __mcpAuthCallbackServers: Map<number, PortState> | undefined;
}

function getServers(): Map<number, PortState> {
  globalThis.__mcpAuthCallbackServers ??= new Map();
  return globalThis.__mcpAuthCallbackServers;
}

const SUCCESS_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization complete</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#222}
h1{font-size:20px}p{color:#555;line-height:1.5}</style></head>
<body><h1>Authorization complete</h1>
<p>You can close this tab and return to the chat.</p></body></html>`;

function errorHtml(message: string): string {
  const safe = message.replace(/[<>&"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c),
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Authorization failed</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;padding:0 24px;color:#222}
h1{font-size:20px;color:#b00}pre{background:#f5f5f5;padding:12px;border-radius:6px;white-space:pre-wrap}</style></head>
<body><h1>Authorization failed</h1><pre>${safe}</pre></body></html>`;
}

function ensureServer(port: number, logger?: { warn: (msg: string) => void }): PortState {
  const servers = getServers();
  const existing = servers.get(port);
  if (existing) return existing;

  const pending = new Map<string, PendingFlow>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    if (error) {
      const desc = url.searchParams.get("error_description") ?? "";
      const reason = `${error}${desc ? ` — ${desc}` : ""}`;
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorHtml(`Authorization server returned error: ${reason}`));
      if (state) {
        const flow = pending.get(state);
        pending.delete(state);
        flow?.onAbort?.(reason);
      }
      return;
    }

    if (!code || !state) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorHtml("Missing code or state in callback."));
      return;
    }

    const flow = pending.get(state);
    if (!flow) {
      res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
      res.end(errorHtml("No pending authorization for this state. The flow may have expired."));
      return;
    }

    flow.onCode(code)
      .then(() => {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(SUCCESS_HTML);
      })
      .catch((err) => {
        res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
        res.end(errorHtml(`Token exchange failed: ${String(err)}`));
        flow.onAbort?.(String(err));
      })
      .finally(() => {
        pending.delete(state);
      });
  });

  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      logger?.warn(`mcp-auth-plugin: callback server on port ${port} failed: ${String(err)}`);
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const state: PortState = { server, pending, ready };
  servers.set(port, state);
  return state;
}

/**
 * Register a pending OAuth2 flow on the given port. Starts the listener if
 * needed (idempotent — concurrent flows on the same port share one server).
 * Returns a `cancel()` to remove the flow without waiting for callback.
 */
export function registerPendingFlow(params: {
  port: number;
  state: string;
  flow: PendingFlow;
  logger?: { warn: (msg: string) => void };
}): { cancel: () => void; ready: Promise<void> } {
  const portState = ensureServer(params.port, params.logger);
  portState.pending.set(params.state, params.flow);
  return {
    cancel: () => portState.pending.delete(params.state),
    ready: portState.ready,
  };
}

/** Returns true if a flow with the given state is still pending. Useful in tests. */
export function isPending(port: number, state: string): boolean {
  return getServers().get(port)?.pending.has(state) ?? false;
}

/** Test/teardown helper — close all listeners and clear all pending flows. */
export function shutdownAll(): Promise<void> {
  const servers = getServers();
  const closes: Promise<void>[] = [];
  for (const [, ps] of servers) {
    ps.pending.clear();
    closes.push(new Promise((resolve) => ps.server.close(() => resolve())));
  }
  servers.clear();
  return Promise.all(closes).then(() => undefined);
}

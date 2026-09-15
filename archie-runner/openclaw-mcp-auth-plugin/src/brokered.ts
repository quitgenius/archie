// Brokered OAuth2 — completing a flow the agent could not stay alive to receive.
//
// ── THE THREE MODES ──────────────────────────────────────────────────────────────────────────────
//
//   interactive     (OpenClaw/ECS)  the container hosts a callback listener on 127.0.0.1 and the
//                                   exchange happens inside the same process that started the flow.
//   non-interactive (the AgentCore  no flow at all; OAuth2 servers are refresh-only off a token
//                    stopgap)       pre-seeded onto EFS by an operator.
//   brokered        (this)          the flow starts here, the browser is redirected to the public
//                                   ingress, and the code is LANDED in DynamoDB by the forwarder
//                                   Lambda. A later turn collects it and exchanges it here.
//
// Brokered is not "interactive again". No inbound listener is started — a per-session microVM
// cannot host one, which is what MCP_AUTH_NONINTERACTIVE correctly prevents. What changes is that
// the flow is allowed to BEGIN, with its verifier persisted to the agent's own directory, so the
// exchange can happen on a turn that starts minutes later in a different microVM.
//
// The security property that makes the unauthenticated callback safe is preserved and, if
// anything, sharpened: the Lambda holds the code, this holds the verifier, and neither is
// sufficient alone. A forged code posted against an observed state fails PKCE here, because the
// attacker's authorization was bound to a different code_challenge.

import { exchangeCode, type OAuth2Metadata } from "./oauth2.js";
import {
  clearPendingFlow,
  getPendingFlow,
  listPendingFlows,
  saveTokens,
  type PersistedPendingFlow,
} from "./token-store.js";

/** True when this runtime completes OAuth2 through the public ingress rather than a local port. */
export function isBrokeredMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MCP_AUTH_BROKERED === "1";
}

/**
 * A callback the forwarder Lambda landed for this agent.
 *
 * Supplied by the runtime, which already reads the agent-config table at boot — rather than having
 * this plugin open its own DynamoDB client. Keeping AWS access on the runtime side means the
 * plugin bundle stays dependency-free and the IAM surface stays where it is already reasoned about.
 */
export type LandedCallback = {
  state: string;
  code?: string;
  error?: string;
  errorDescription?: string;
};

export type CompletionOutcome =
  | { kind: "completed"; serverKey: string }
  | { kind: "declined"; serverKey: string; error: string }
  | { kind: "no-pending"; serverKey: string }
  | { kind: "state-mismatch"; serverKey: string }
  | { kind: "failed"; serverKey: string; error: string };

/**
 * Finish one brokered flow against a landed callback.
 *
 * The pending flow is cleared on every terminal outcome, including failure. A code is single-use:
 * once it has been presented to the token endpoint it is spent whether or not we liked the answer,
 * so leaving the verifier on disk would only invite a retry that cannot succeed.
 */
export async function completeBrokeredFlow(params: {
  agentDir: string;
  serverKey: string;
  landed: LandedCallback;
  metadata: OAuth2Metadata;
  label?: string;
  now?: number;
}): Promise<CompletionOutcome> {
  const { agentDir, serverKey, landed } = params;
  const flow: PersistedPendingFlow | undefined = getPendingFlow(agentDir, serverKey, params.now);
  if (!flow) return { kind: "no-pending", serverKey };

  // The state binds the callback to THIS flow. A mismatch means the row belongs to a different
  // authorization — never exchange against it, and never clear the flow the user may still finish.
  if (flow.state !== landed.state) return { kind: "state-mismatch", serverKey };

  if (landed.error) {
    clearPendingFlow(agentDir, serverKey);
    return {
      kind: "declined",
      serverKey,
      error: landed.errorDescription ? `${landed.error}: ${landed.errorDescription}` : landed.error,
    };
  }

  if (!landed.code) {
    clearPendingFlow(agentDir, serverKey);
    return { kind: "failed", serverKey, error: "callback carried neither a code nor an error" };
  }

  try {
    const tokens = await exchangeCode({
      metadata: params.metadata,
      clientId: flow.clientId,
      code: landed.code,
      redirectUri: flow.redirectUri,
      verifier: flow.verifier,
      ...(params.now !== undefined ? { now: params.now } : {}),
    });
    saveTokens(
      agentDir,
      serverKey,
      {
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
        ...(tokens.scope ? { scope: tokens.scope } : {}),
      },
      params.label,
    );
    return { kind: "completed", serverKey };
  } catch (err) {
    return { kind: "failed", serverKey, error: String(err) };
  } finally {
    clearPendingFlow(agentDir, serverKey);
  }
}

/** One row of the forwarder Lambda's drop-box: OAUTH#<scope> / STATE#<state>. */
type CallbackRow = { sk?: string; state?: string; code?: string; error?: string; errorDescription?: string };

/**
 * Read this agent's landed callbacks straight from DynamoDB.
 *
 * The runtime is READ-ONLY on that table by design (agentcore-base-policy.cjs), and this honours
 * it: rows are read and never deleted. They expire by TTL instead, and re-reading a collected one
 * is harmless because its pending flow is already gone — completeBrokeredFlow answers "no-pending".
 *
 * `query` is injected rather than constructed here so the plugin bundle carries no AWS SDK; the
 * caller resolves the image's copy, the same way pi-entrypoint does rather than shipping a second.
 */
export async function readLandedCallbacks(params: {
  agentId: string;
  query: (partitionKey: string) => Promise<CallbackRow[]>;
}): Promise<LandedCallback[]> {
  const rows = await params.query(`OAUTH#${params.agentId}`);
  return rows.flatMap((row) => {
    // `state` is carried by the sort key; the attribute is a convenience, not the source of truth.
    const state = row.state ?? (row.sk?.startsWith("STATE#") ? row.sk.slice("STATE#".length) : undefined);
    if (!state) return [];
    return [{
      state,
      ...(row.code ? { code: row.code } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.errorDescription ? { errorDescription: row.errorDescription } : {}),
    }];
  });
}

/**
 * Complete every brokered flow this agent has a landed callback for.
 *
 * Matches by `state`: the drop-box row knows only what the IdP echoed back, while the verifier is
 * filed under a serverKey. A landed callback with no matching pending flow is ignored — it is
 * either already collected, expired, or was never ours.
 *
 * Never throws. A failure here must degrade to "this connection isn't authorized yet", not prevent
 * the agent from serving a turn.
 */
export async function collectBrokeredCallbacks(params: {
  agentDir: string;
  agentId: string;
  query: (partitionKey: string) => Promise<CallbackRow[]>;
  metadataFor?: (flow: PersistedPendingFlow) => OAuth2Metadata;
  logger?: { warn: (msg: string) => void; info?: (msg: string) => void };
  now?: number;
}): Promise<CompletionOutcome[]> {
  let landed: LandedCallback[];
  try {
    landed = await readLandedCallbacks({ agentId: params.agentId, query: params.query });
  } catch (err) {
    params.logger?.warn(`mcp-auth-plugin: could not read landed OAuth2 callbacks: ${String(err)}`);
    return [];
  }
  if (!landed.length) return [];

  const pending = listPendingFlows(params.agentDir, params.now);
  if (!pending.length) return [];

  const outcomes: CompletionOutcome[] = [];
  for (const { serverKey, flow } of pending) {
    const match = landed.find((l) => l.state === flow.state);
    if (!match) continue;
    try {
      outcomes.push(await completeBrokeredFlow({
        agentDir: params.agentDir,
        serverKey,
        landed: match,
        // The token endpoint was recorded when the flow started, so completion needs no second
        // discovery round-trip against the IdP.
        metadata: params.metadataFor?.(flow) ?? metadataFromFlow(flow),
        ...(params.now !== undefined ? { now: params.now } : {}),
      }));
    } catch (err) {
      params.logger?.warn(`mcp-auth-plugin: completing ${serverKey} failed: ${String(err)}`);
    }
  }
  return outcomes;
}

/**
 * Minimal metadata for the exchange leg. Only `token_endpoint` is read by exchangeCode; the
 * authorization endpoint is already spent by the time a code exists.
 */
function metadataFromFlow(flow: PersistedPendingFlow): OAuth2Metadata {
  return { authorization_endpoint: "", token_endpoint: flow.tokenEndpoint };
}

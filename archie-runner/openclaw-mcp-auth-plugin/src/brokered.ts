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

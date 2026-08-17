// TEST-ONLY probe tool for the derived-role IAM harness (§9 / iam-derived-roles.feature).
//
// It performs a harmless, read-only, IN-ACCOUNT action the `agentcore-base` role CANNOT do —
// iam:ListAccountAliases (base grants zero iam:*). So the call succeeds ONLY when the agent's
// `sandbox-probe` grant caused a dedicated role carrying the extra statement (base ∪ grants). That
// makes the derived-role mechanism observable end-to-end in one account, no cross-account trust.
//
// Double-gated so it never reaches a real agent: the `sandbox-probe` capability AND the
// SANDBOX_PROBE_ENABLED=1 env flag (set only on the BDD leg's runtime).

import { piAi } from './pi-runtime.mjs';
// @aws-sdk/client-iam is lazy-imported inside execute() (not at module load): this is a
// test-only, double-gated tool, so its SDK must never be able to crash-loop a real agent's
// boot if the dependency is ever absent from the image.

const T = piAi.Type;
const asText = (payload) => ({ content: [{ type: 'text', text: JSON.stringify(payload) }], details: payload });

export function createSandboxProbeTool() {
  return {
    name: 'sandbox_probe',
    label: 'sandbox_probe',
    capability: 'sandbox-probe',
    description:
      'TEST-ONLY. Probe whether the runtime role can perform a base-denied, read-only action '
      + '(iam:ListAccountAliases). Returns {ok:true, aliases} on success, or {ok:false, error} on '
      + 'AccessDenied — i.e. ok iff the sandbox-probe grant produced a dedicated role with the extra IAM.',
    parameters: T.Object({}),
    async execute() {
      try {
        const { IAMClient, ListAccountAliasesCommand } = await import('@aws-sdk/client-iam');
        const iam = new IAMClient({ region: process.env.AWS_REGION || 'us-east-1' });
        const r = await iam.send(new ListAccountAliasesCommand({}));
        return asText({ ok: true, aliases: r.AccountAliases || [] });
      } catch (e) {
        return asText({ ok: false, error: e?.name || String(e), message: e?.message });
      }
    },
  };
}

// Gated on the `sandbox-probe` capability AND the SANDBOX_PROBE_ENABLED flag.
export function buildSandboxProbeTools(allow) {
  if (process.env.SANDBOX_PROBE_ENABLED !== '1') return [];
  return allow && allow.has('sandbox-probe') ? [createSandboxProbeTool()] : [];
}

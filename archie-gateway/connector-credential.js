// Per-agent connector credentials — provisioning half.
//
// THE PROBLEM THIS SOLVES, which is the interesting part and is not vendor-specific.
//
// Agents run in their own hardware-isolated sandboxes and reach third-party services on their own
// behalf. Give every agent the same shared API key and you have destroyed the isolation at the one
// point it matters: agent A's key can read agent B's connected mailbox, and a compromised agent
// leaks a credential the whole fleet depends on. So each agent gets its OWN credential, and the
// gateway arranges that without ever handing a key to the agent:
//
//   1. PROVISION at agent-create. Mint (or adopt) a per-agent credential with the platform's org
//      key, write it to the secret store, and record a POINTER row — `{ secretArn, id }` under the
//      agent's key. Runs beside the other create-time provisioning steps, so one failure does not
//      strand the others, and inside a span so the latency is attributable.
//   2. SCOPE THE IAM. The pointer's ARN goes into the agent's DERIVED role, which can read that one
//      secret and no other. This is why the pointer is a row and not a naming convention: an adopted
//      credential's secret name cannot always be spelled from the agent id.
//   3. RESOLVE AT BOOT. The runtime reads the pointer, falls back to the per-agent name, then to a
//      shared base, and the first hit wins — see the runtime half in agentcore-pi/.
//
// The gateway never puts a key in the agent's environment directly; it puts a NAME there, and the
// agent's own role decides whether it may read it. That is the property worth copying.
//
// OPEN-SOURCE BUILD: the platform calls are not included — creating a project, adopting an existing
// one, and the org-key handling are specific to a connector platform and to the deployment that
// wired it. The CONTRACT is real and is what the gateway codes against. Implement `ensureAgentCredential`
// against your own platform and the three steps above work unchanged.

const NOT_AVAILABLE = 'not-available-in-open-source-build';

/**
 * Outcomes, which the caller records as a metric and a span attribute:
 *   created         a new credential was minted and the pointer written
 *   already-pointed the agent already had a pointer; nothing to do (the common case)
 *   adopted         an existing credential was claimed and pointed at
 *   skipped         no org key configured, so provisioning is not attempted
 *   blocked         the platform refused (quota, duplicate, policy)
 *   failed          an error the caller should surface but not retry inline
 *
 * `blocked` and `failed` are deliberately distinct: one is the platform saying no, the other is us
 * being broken, and they want different alarms.
 */
const OUTCOMES = ['created', 'already-pointed', 'adopted', 'skipped', 'blocked', 'failed'];

/**
 * Ensure `agentId` has its own connector credential, and that a pointer row records where it lives.
 *
 * @param {object}  args
 * @param {string}  args.agentId        the scope id this credential belongs to
 * @param {string}  args.secretBase     deployment-wide secret name prefix; the per-agent secret is
 *                                      `${secretBase}-${agentId}`
 * @param {?string} args.legacyAgentId  a prior id for this agent, when one exists. Its PRESENCE is
 *                                      what says "not a new agent", which decides mint vs adopt.
 * @param {string}  args.orgApiKey      the platform org key used to mint. Never reaches the agent.
 * @param {object}  args.secrets        injected secret-store operations (describeSecret, createSecret)
 * @returns {Promise<{outcome:string, reason?:string, agentId:string, ms:number, id?:string}>}
 */
async function ensureAgentCredential({ agentId, secretBase, legacyAgentId, orgApiKey, secrets } = {}) {
  void secretBase; void legacyAgentId; void orgApiKey; void secrets;
  // Returning `skipped` rather than throwing is deliberate: provisioning runs in a Promise.allSettled
  // beside the other create-time steps, and a build with no connector platform configured should
  // create agents normally rather than fail every creation.
  return { outcome: 'skipped', reason: NOT_AVAILABLE, agentId, ms: 0 };
}

/**
 * Read an agent's credential pointer. Returns null for a genuine ABSENCE; THROWS on a read fault.
 *
 * That distinction is the whole point of this function and was learned the hard way. The caller
 * rewrites the agent's derived-role policy from the result, so a swallowed throttle or AccessDenied
 * would be indistinguishable from "this agent has no credential" — and would silently rewrite the
 * role WITHOUT the secret ARN, revoking a working key. A genuine miss returns null, which is how an
 * un-provisioned agent correctly gets no grant; anything else propagates, so the caller abandons the
 * rewrite rather than writing one from a bad read.
 */
async function readCredentialPointer(doc, tableName, agentId) {
  if (!doc || !tableName) return null;
  void agentId;
  return null;
}

/** The deployment-wide secret name prefix. A constant, identical for every agent. */
function credentialSecretBase() {
  return process.env.CONNECTOR_API_KEY_SECRET || '';
}

/**
 * Pull the platform ORG key out of whatever shape the secret was stored in.
 *
 * Exists because the shape is not ours to dictate: an org key may be stored as a plain string, or as
 * JSON under any of several field names depending on who created the secret and when. Callers must
 * not guess — they ask here, and get null if nothing usable is present, so a malformed secret
 * degrades to "no provisioning" rather than to a confident wrong key.
 */
function extractOrgKey(secretString) {
  if (typeof secretString !== 'string' || !secretString.trim()) return null;
  const raw = secretString.trim();
  if (!raw.startsWith('{')) return raw;
  try {
    const o = JSON.parse(raw);
    for (const k of ['apiKey', 'api_key', 'key', 'token', 'value']) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k].trim();
    }
  } catch { /* a malformed secret is "no key", not a crash */ }
  return null;
}

module.exports = {
  OUTCOMES,
  extractOrgKey,
  ensureAgentCredential,
  readCredentialPointer,
  credentialSecretBase,
};

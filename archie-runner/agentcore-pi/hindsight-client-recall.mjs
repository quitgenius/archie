// Builds the `recall(query)` fn the Pi-native hindsight extension consumes, backed by the
// REAL @vectorize-io/hindsight-client (the exact client the OpenClaw plugin uses:
// new HindsightClient({baseUrl, apiKey}).recall(bankId, query, {maxTokens, budget, types})).
// Lazy dynamic import so the extension (and its unit test with a stub) load without the
// dep present; the client is pinned in the Pi image package.json (^0.6.2, matching the
// plugin) and validated at image-build/deploy time.

const DEFAULTS = { maxTokens: 1024, budget: 'mid', types: ['world'], timeoutMs: 10_000 };

function withTimeout(promise, ms, label) {
  if (!ms) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} recall timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * @param cfg { apiUrl, apiToken, orgApiUrl?, orgApiToken?, orgBankId?, agentBankId?, orgOnly?,
 *              maxTokens?, budget?, types?, orgMaxTokens?, orgBudget?, orgTypes?, timeoutMs?, logger? }
 * @returns async (query) => { results, orgResults }
 */
export async function buildClientRecall(cfg = {}) {
  const { HindsightClient } = await import('@vectorize-io/hindsight-client');
  const o = { ...DEFAULTS, ...cfg };
  const logger = cfg.logger || console;

  const agentClient = !o.orgOnly && o.agentBankId ? new HindsightClient({ baseUrl: o.apiUrl, apiKey: o.apiToken || undefined }) : null;
  const orgClient = o.orgBankId
    ? new HindsightClient({ baseUrl: o.orgApiUrl || o.apiUrl, apiKey: (o.orgApiToken ?? o.apiToken) || undefined })
    : null;

  return async (query) => {
    const [resp, orgResp] = await Promise.all([
      agentClient
        ? withTimeout(agentClient.recall(o.agentBankId, query, { maxTokens: o.maxTokens, budget: o.budget, types: o.types }), o.timeoutMs, 'agent')
            .catch((e) => { logger.warn(`hindsight agent recall error (bank ${o.agentBankId}): ${e?.message || e}`); return null; })
        : Promise.resolve(null),
      orgClient
        ? withTimeout(orgClient.recall(o.orgBankId, query, { maxTokens: o.orgMaxTokens ?? o.maxTokens, budget: o.orgBudget ?? o.budget, types: o.orgTypes ?? o.types }), o.timeoutMs, 'org')
            .catch((e) => { logger.warn(`hindsight org recall error (bank ${o.orgBankId}): ${e?.message || e}`); return null; })
        : Promise.resolve(null),
    ]);
    return { results: resp?.results ?? [], orgResults: orgResp?.results ?? [] };
  };
}

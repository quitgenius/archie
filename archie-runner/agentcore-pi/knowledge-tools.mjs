// agent_knowledge_* tools — the READ-ONLY Hindsight knowledge surface, ported from the Pelago
// hindsight fork's OpenClaw plugin so Pi agents get the same four tools OpenClaw agents have.
//
// SOURCE OF TRUTH, and this is a PORT not a design: example/hindsight @ task/org-knowledge-v2,
// `hindsight-integrations/openclaw/src/document-tools.ts` — `createRecallTool` +
// `createDocumentTools`. That file is what the clawdbot image builds (clawdbot/Dockerfile:171-195
// clones it into /usr/local/share/hindsight-openclaw), so behaviour here is matched against the code
// that actually runs, not inferred from the tool names.
//
// WHY THESE FOUR AND NOT THE SDK SET. The plugin has two registration paths: one exposes
// `createKnowledgeTools` from @vectorize-io/agent-8z9egq-sdk plus the document tools (the full set,
// which includes writes), and one exposes `[createRecallTool, ...createDocumentTools]` under
// `READ_ONLY_TOOL_NAMES` (index.ts:2961-2974). We port the READ-ONLY path. It is self-contained raw
// HTTP with no SDK dependency, and read-only is the posture archie already has: retain is off under
// AgentCore for PII reasons, and `hindsight.write` is policy-pinned.
//
// RAW HTTP, DELIBERATELY. The obvious instinct is to reuse @vectorize-io/hindsight-client (already a
// dependency, used by hindsight-client-recall.mjs for the recall HOOK). Do not: the client has no
// document-search method at all — `listDocuments(bankId, {limit, offset})` cannot take a query, and
// `recall`'s `types` are FACT types (world|experience|observation), not document types. The plugin
// bypasses the SDK for exactly this reason and calls `GET /documents?q=…` where the SERVER filters.
// Reimplementing on the client would silently turn "search documents" into "list documents".
//
// All four are reads. Retain/delete/update are NOT here and must not be added without
// `hindsight.write`, which is policy-pinned (see archie-cedar-spike/policy/semantics.cedar B1).

import { piAi } from './pi-runtime.mjs';
import { describeFetchError } from './fetch-error.mjs';

const T = piAi.Type;

// Verbatim from document-tools.ts:47-48. NOTE the recall TOOL defaults to world+experience, while the
// recall HOOK (hindsight-client-recall.mjs) defaults to ['world'] alone — a real difference between the
// two surfaces, preserved rather than harmonised.
const VALID_FACT_TYPES = ['world', 'experience', 'observation'];
const DEFAULT_RECALL_TYPES = ['world', 'experience'];

/**
 * Port of document-tools.ts:50-62. Accepts an array OR a comma/space-separated string, keeps only
 * valid fact types, de-dupes, and falls back to the defaults when nothing valid survives — so a
 * model passing "world, nonsense" gets world rather than an error.
 */
export function normalizeFactTypes(input) {
  if (input === undefined || input === null) return [...DEFAULT_RECALL_TYPES];
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[\s,]+/).filter(Boolean)
      : [];
  const valid = raw.filter((t) => typeof t === 'string' && VALID_FACT_TYPES.includes(t));
  return valid.length > 0 ? [...new Set(valid)] : [...DEFAULT_RECALL_TYPES];
}

const ok = (data) => {
  const text = JSON.stringify(data, null, 2);
  // Pi wants `details` alongside content; the plugin's own adapter added `details: {}` at
  // index.ts:2916 for the same reason. Carrying the parsed payload is strictly more useful.
  return { content: [{ type: 'text', text }], details: data };
};

async function apiGet(baseUrl, path, token, fetchImpl = fetch) {
  // The fetch itself is wrapped, not just the response: a TLS or DNS failure rejects here with the useless
  // `fetch failed`, and that string is what the MODEL sees as the tool result. Unwrapped, it reads the
  // failure as "the knowledge base is empty" and carries on; named, it can say what is broken.
  let resp;
  try {
    resp = await fetchImpl(`${baseUrl}${path}`, {
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch (e) {
    throw new Error(`hindsight GET ${path} failed: ${describeFetchError(e, baseUrl)}`);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${body}`);
  }
  return resp.json();
}

async function apiPost(baseUrl, path, body, token, fetchImpl = fetch) {
  let resp;
  try {
    resp = await fetchImpl(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`hindsight POST ${path} failed: ${describeFetchError(e, baseUrl)}`);
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${resp.status}: ${text}`);
  }
  return resp.json();
}

/**
 * The four read-only knowledge tools, scoped to ONE bank.
 *
 * BANK SCOPING mirrors the plugin (index.ts:2887-2898): under `orgOnly` the bank is `orgBankId` and
 * the API url/token switch to the org ones. That is archie's posture — the BDD feature records it as
 * "matching prod's PII posture (retain stays off; orgOnly recall from the shared default-org bank)" —
 * so these tools read the ORG bank, unlike the recall HOOK which merges org + agent results.
 *
 * @param {{apiUrl: string, apiToken?: string, bankId: string, fetchImpl?: Function}} opts
 * @returns tools keyed by name, each declaring `capability: 'hindsight.read'`
 */
export function createKnowledgeTools({ apiUrl, apiToken, bankId, fetchImpl = fetch }) {
  const base = `/v1/default/banks/${encodeURIComponent(bankId)}`;
  const cap = 'hindsight.read';

  const agent_knowledge_list_documents = {
    name: 'agent_knowledge_list_documents',
    label: 'List documents',
    capability: cap,
    description:
      'List all ingested documents in the memory bank. Returns document IDs, creation dates, memory unit counts, and tags.',
    parameters: T.Object({ limit: T.Optional(T.Number()), offset: T.Optional(T.Number()) }),
    async execute(_toolCallId, params) {
      const limit = params?.limit ?? 100;
      const offset = params?.offset ?? 0;
      return ok(await apiGet(apiUrl, `${base}/documents?limit=${limit}&offset=${offset}`, apiToken, fetchImpl));
    },
  };

  const agent_knowledge_get_document = {
    name: 'agent_knowledge_get_document',
    label: 'Read a document',
    capability: cap,
    description: 'Read a specific document by its ID. Returns the original text and metadata.',
    parameters: T.Object({ document_id: T.String() }),
    async execute(_toolCallId, params) {
      const docId = String(params?.document_id ?? '');
      return ok(await apiGet(apiUrl, `${base}/documents/${encodeURIComponent(docId)}`, apiToken, fetchImpl));
    },
  };

  const agent_knowledge_search_documents = {
    name: 'agent_knowledge_search_documents',
    label: 'Search documents',
    capability: cap,
    // Verbatim from the plugin, including the pointer to recall — the distinction matters and the
    // model needs it: this filters document IDs and tags, it does NOT search document CONTENT.
    description:
      'Search documents by name/ID substring or tags. Use for finding specific documents when you know part of the name or a tag. '
      + 'For semantic search across memory contents, use agent_knowledge_recall instead.',
    parameters: T.Object({
      query: T.Optional(T.String()),
      tags: T.Optional(T.Array(T.String())),
      limit: T.Optional(T.Number()),
    }),
    async execute(_toolCallId, params) {
      const qs = new URLSearchParams();
      if (params?.query) qs.set('q', String(params.query));
      if (Array.isArray(params?.tags)) for (const t of params.tags) qs.append('tags', String(t));
      qs.set('limit', String(params?.limit ?? 100));
      return ok(await apiGet(apiUrl, `${base}/documents?${qs.toString()}`, apiToken, fetchImpl));
    },
  };

  const agent_knowledge_recall = {
    name: 'agent_knowledge_recall',
    label: 'Search memories',
    capability: cap,
    description:
      'Search across all retained conversations and documents for specific facts, numbers, or details.',
    parameters: T.Object({
      query: T.String(),
      max_tokens: T.Optional(T.Number()),
      fact_types: T.Optional(T.Array(T.String())),
    }),
    async execute(_toolCallId, params) {
      const body = {
        query: String(params?.query ?? ''),
        types: normalizeFactTypes(params?.fact_types),
        max_tokens: params?.max_tokens ?? 1024,
        budget: 'mid', // hardcoded in the plugin; not model-controllable
      };
      return ok(await apiPost(apiUrl, `${base}/memories/recall`, body, apiToken, fetchImpl));
    },
  };

  return {
    agent_knowledge_recall,
    agent_knowledge_list_documents,
    agent_knowledge_get_document,
    agent_knowledge_search_documents,
  };
}

// The plugin's own READ_ONLY_TOOL_NAMES (document-tools.ts:196), in its order.
export const KNOWLEDGE_TOOL_NAMES = [
  'agent_knowledge_recall',
  'agent_knowledge_list_documents',
  'agent_knowledge_get_document',
  'agent_knowledge_search_documents',
];

/**
 * Build the knowledge tools for an agent's allow-set.
 *
 * UNLIKE buildMemoryTools THIS IS NOT GATED ON THE ALLOW-SET, and that is deliberate: sandbox,
 * 2026-08-18 — "I want all agents to have the hindsight read tools available". The three names in
 * ALWAYS_ALLOW (config-resolver/boot-config.mjs) put them in every allow-set anyway; taking `allow`
 * would add a way to lose them, which is the opposite of the requirement.
 *
 * It IS gated on configuration, because it has to be: with no apiUrl or no bankId these tools can
 * only throw. BASE_PLUGINS already gates hindsight on a non-empty HINDSIGHT_API_URL for the same
 * reason (boot-config.mjs:37-47 records that emitting it unconditionally logged
 * "hindsight not configured" on every boot). So an unconfigured agent gets NO knowledge tools rather
 * than four that fail — handing a model a tool that cannot work is what makes it improvise.
 */
export function buildKnowledgeTools({ apiUrl, apiToken, bankId, fetchImpl } = {}) {
  if (!apiUrl || !bankId) return [];
  const t = createKnowledgeTools({ apiUrl, apiToken, bankId, fetchImpl });
  return KNOWLEDGE_TOOL_NAMES.map((n) => t[n]);
}

// agent_knowledge_* WRITE tools — the half of the Hindsight knowledge surface that mutates the bank.
//
// SOURCE OF TRUTH, and this is a PORT not a design: @vectorize-io/agent-8z9egq-sdk 0.1.1,
// `createKnowledgeTools`. The clawdbot image registers that SDK set plus the document tools behind
// `enableKnowledgeTools` (hindsight-integrations/openclaw/src/index.ts:2899-2923); the read-only path
// registers `createRecallTool` + `createDocumentTools` behind `enableKnowledgeToolsReadOnly`
// (:2941-2977). knowledge-tools.mjs is the read-only path. This module is the DIFFERENCE between the two.
//
// THE SEVEN TOOLS HERE, and they are not all writes:
//   agent_x0y8qlge / update_page / delete_page   mutate the knowledge-page (mental model) surface
//   ingest                                    writes a document into the bank
//   list_pages / get_page                     READ the page surface
//   reflect                                   READS, then synthesises with an LLM call
//
// ALL SEVEN CARRY `hindsight.write`, INCLUDING THE THREE READS, and that needs justifying rather than
// glossing:
//   * OpenClaw gates them as ONE bundle. There is no configuration in which an agent has list_pages and
//     not agent_x0y8qlge. Splitting them here would be a new design, not a port, and the two would then
//     disagree about what "the knowledge tools" means.
//   * The read-only bundle deliberately omits the page surface, offering documents + recall instead.
//     Pages are the CONSOLIDATED layer — an agent's synthesised conclusions about people and processes —
//     so promoting list_pages/get_page to baseline `hindsight.read` would give every agent in the fleet read
//     access to a surface no agent has today. That is a widening, and a much larger change than porting
//     the writes.
//   * `reflect` is a read, but an expensive one: it is an LLM call over the bank, and it is in the full
//     bundle rather than the read-only one for that reason as much as any.
// So the conservative mapping is the faithful one. If the page reads should be separately grantable that
// is a capability split worth doing deliberately, with its own pin group.
//
// BUILT UNCONDITIONALLY WHEN CONFIGURED, gated by the PEP rather than at construction — same as the read
// tools and for a better reason: `hindsight.write` has no `alsoAllow` token (it is named directly by the
// hindsight gate and appears in no token map), so there is nothing at boot to key construction off. The
// gating is real and two-layered: applyToolFilter drops them from the model's surface for any scope whose
// verdict is not `allow`, and the tool_call PEP denies a call that somehow arrives anyway. Verified live
// 2026-08-18 — dm-ux0mz5ckp2r logged `hindsight.write decision=deny reason=policy-denied` while
// ch-cr89fluhion logged `decision=allow reason=pinned`, with no grant row on either.
//
// WHY THE CLIENT AND NOT RAW HTTP, the opposite choice to knowledge-tools.mjs. That module uses raw fetch
// because the client has no document-SEARCH method at all, so using it would have silently turned "search
// documents" into "list documents". Here the client has every method these need, and the SDK itself uses
// it — so raw HTTP would mean hand-maintaining request shapes the dependency already owns.
//
// AND WHY TWO CLIENTS. `createMentalModel` and `reflect` go through the LOW-LEVEL generated client, as the
// SDK does, because the high-level wrapper cannot express what they need: high-level createMentalModel
// exposes only `trigger.refreshAfterConsolidation` (measured against 0.6.2) while the page defaults also
// set `mode`, `exclude_mental_models` and `fact_types`, and high-level `reflect` has no `max_tokens` and no
// `include.facts`. Using the high-level wrapper for those two would have quietly dropped fields.

import { HindsightClient, sdk, createClient, createConfig } from '@vectorize-io/hindsight-client';
import { piAi } from './pi-runtime.mjs';

const T = piAi.Type;

const FACT_TYPES = ['world', 'experience', 'observation'];
const DEFAULT_REFLECT_FACT_TYPES = FACT_TYPES;

// Verbatim from the SDK (index.js:12-17). These are the trigger defaults that make a page REBUILD itself
// from conversation observations after each consolidation — the property that distinguishes a page from a
// document. `exclude_mental_models` stops a page being synthesised from other pages.
const PAGE_DEFAULTS = {
  mode: 'delta',
  refresh_after_consolidation: true,
  exclude_mental_models: true,
  fact_types: ['observation'],
};

const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], details: data });

/**
 * Port of the SDK's normalizeFactTypes (index.js:32-45).
 *
 * NOTE THE DIFFERENT CONTRACT from knowledge-tools.mjs's version: the SDK THROWS on an invalid type,
 * whereas the document-tools version falls back to defaults. Both are preserved as-is rather than
 * harmonised — the reflect surface treats a bad fact type as a caller error, and a port that "fixed" that
 * would change what the model sees on a malformed call.
 */
export function normalizeFactTypesStrict(input, defaultTypes = DEFAULT_REFLECT_FACT_TYPES) {
  if (input === undefined || input === null) return [...defaultTypes];
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string' ? input.split(/[\s,]+/).filter(Boolean) : [];
  const normalized = raw.filter((t) => typeof t === 'string' && FACT_TYPES.includes(t));
  if (normalized.length !== raw.length || normalized.length === 0) {
    throw new Error(`Invalid fact_types/types. Expected one or more of: ${FACT_TYPES.join(', ')}`);
  }
  return [...new Set(normalized)];
}

/**
 * @param opts.clientImpl   optional HindsightClient stand-in — INJECTED FOR TESTS, mirroring the read
 *                          module's `fetchImpl`. Without a seam the request bodies are unassertable, and a
 *                          test that checks a description substring instead of the body is theatre: it
 *                          passes while agent_x0y8qlge silently sends the wrong trigger.
 * @param opts.lowLevelImpl optional {createMentalModel, reflect} stand-in for the generated-client calls.
 */
export function createKnowledgeWriteTools({ apiUrl, apiToken, bankId, clientImpl, lowLevelImpl }) {
  const client = clientImpl || new HindsightClient({ baseUrl: apiUrl, apiKey: apiToken, userAgent: 'archie-pi/1' });
  const lowLevelClient = lowLevelImpl ? null : createClient(createConfig({
    baseUrl: apiUrl,
    headers: {
      ...(apiToken ? { Authorization: `Bearer ${apiToken}` } : {}),
      'User-Agent': 'archie-pi/1',
    },
  }));
  // `sdk.createMentalModel`/`sdk.reflect` take the generated client as an ARGUMENT, so the seam replaces
  // the two calls rather than the client — that is the boundary a test needs in order to see the body.
  const lowLevel = lowLevelImpl || {
    createMentalModel: (args) => sdk.createMentalModel({ ...args, client: lowLevelClient }),
    reflect: (args) => sdk.reflect({ ...args, client: lowLevelClient }),
  };
  const cap = 'hindsight.write';

  const agent_knowledge_list_pages = {
    name: 'agent_knowledge_list_pages',
    label: 'List knowledge pages',
    capability: cap,
    description:
      'List all your knowledge pages (IDs and names only). Use agent_knowledge_get_page to read the full content of a specific page.',
    parameters: T.Object({}),
    async execute() {
      return ok(await client.listMentalModels(bankId));
    },
  };

  const agent_knowledge_get_page = {
    name: 'agent_knowledge_get_page',
    label: 'Read a knowledge page',
    capability: cap,
    description: 'Read the full content of one knowledge page.',
    parameters: T.Object({ page_id: T.String() }),
    async execute(_id, params) {
      return ok(await client.getMentalModel(bankId, String(params?.page_id ?? '')));
    },
  };

  const agent_knowledge_agent_x0y8qlge = {
    name: 'agent_knowledge_agent_x0y8qlge',
    label: 'Create a knowledge page',
    capability: cap,
    description:
      'Create a new knowledge page. The source_query is a question the system re-asks after each '
      + 'consolidation to rebuild the page from conversation observations. Pages auto-update as you have '
      + 'more conversations. Use for: user preferences, procedures, performance data, best practices.',
    parameters: T.Object({ page_id: T.String(), name: T.String(), source_query: T.String() }),
    async execute(_id, params) {
      // LOW-LEVEL, so the full trigger survives — see the header note on the two clients.
      const resp = await lowLevel.createMentalModel({
        path: { bank_id: bankId },
        body: {
          id: String(params?.page_id ?? ''),
          name: String(params?.name ?? ''),
          source_query: String(params?.source_query ?? ''),
          max_tokens: 4096,
          trigger: PAGE_DEFAULTS,
        },
      });
      if (resp.error) throw new Error(`agent_knowledge_agent_x0y8qlge failed: ${JSON.stringify(resp.error)}`);
      return ok(resp.data);
    },
  };

  const agent_knowledge_update_page = {
    name: 'agent_knowledge_update_page',
    label: 'Update a knowledge page',
    capability: cap,
    description: "Update a page's name or source query. The content will re-synthesize on next consolidation.",
    parameters: T.Object({ page_id: T.String(), name: T.Optional(T.String()), source_query: T.Optional(T.String()) }),
    async execute(_id, params) {
      return ok(await client.updateMentalModel(bankId, String(params?.page_id ?? ''), {
        name: params?.name, sourceQuery: params?.source_query,
      }));
    },
  };

  const agent_knowledge_delete_page = {
    name: 'agent_knowledge_delete_page',
    label: 'Delete a knowledge page',
    capability: cap,
    description: 'Permanently delete a knowledge page.',
    parameters: T.Object({ page_id: T.String() }),
    async execute(_id, params) {
      await client.deleteMentalModel(bankId, String(params?.page_id ?? ''));
      // The SDK returns a synthetic success here — deleteMentalModel resolves to void, so there is no
      // payload to echo and an empty result would read to the model as a failure.
      return ok({ success: true });
    },
  };

  const agent_knowledge_reflect = {
    name: 'agent_knowledge_reflect',
    label: 'Reflect on memories',
    capability: cap,
    description:
      'Generate a concise answer using the memory bank. Use for deliberate synthesis, retrospectives, or '
      + 'long-term preference/pattern questions; use agent_knowledge_recall for ordinary lookup.',
    parameters: T.Object({
      query: T.String(),
      budget: T.Optional(T.String()),
      max_tokens: T.Optional(T.Number()),
      fact_types: T.Optional(T.Array(T.String())),
      include_facts: T.Optional(T.Boolean()),
      exclude_mental_models: T.Optional(T.Boolean()),
    }),
    async execute(_id, params) {
      const factTypes = normalizeFactTypesStrict(params?.fact_types);
      const maxTokens = Math.max(1, Math.floor(Number(params?.max_tokens ?? 1024)));
      const budget = ['low', 'mid', 'high'].includes(params?.budget) ? params.budget : 'low';
      const resp = await lowLevel.reflect({
        path: { bank_id: bankId },
        body: {
          query: String(params?.query ?? ''),
          budget,
          max_tokens: maxTokens,
          fact_types: [...factTypes],
          include: params?.include_facts === true ? { facts: {} } : undefined,
          exclude_mental_models: typeof params?.exclude_mental_models === 'boolean'
            ? params.exclude_mental_models : undefined,
        },
      });
      if (resp.error) throw new Error(`agent_knowledge_reflect failed: ${JSON.stringify(resp.error)}`);
      return ok(resp.data);
    },
  };

  const agent_knowledge_ingest = {
    name: 'agent_knowledge_ingest',
    label: 'Ingest a document',
    capability: cap,
    description:
      'Upload a document into your memory bank. Pass the full raw content — never summarize before '
      + 'ingesting. The system handles chunking and fact extraction. The title becomes the document ID '
      + '(re-ingesting replaces it).',
    parameters: T.Object({ title: T.String(), content: T.String() }),
    async execute(_id, params) {
      // TITLE → DOCUMENT ID, lowercased with spaces to hyphens, exactly as the SDK derives it. That makes
      // re-ingesting the same title a REPLACE rather than a duplicate, which the description promises.
      const docId = String(params?.title ?? '').toLowerCase().replace(/ /g, '-');
      return ok(await client.retainBatch(
        bankId, [{ content: String(params?.content ?? ''), document_id: docId }], { async: true },
      ));
    },
  };

  // `agent_knowledge_recall` is deliberately NOT here: it is in the SDK's set but also in the read-only
  // bundle, and knowledge-tools.mjs owns it at baseline `hindsight.read`. Defining it in both places would
  // give one tool name two capabilities, and whichever module built last would silently decide which.
  return {
    agent_knowledge_list_pages,
    agent_knowledge_get_page,
    agent_knowledge_agent_x0y8qlge,
    agent_knowledge_update_page,
    agent_knowledge_delete_page,
    agent_knowledge_reflect,
    agent_knowledge_ingest,
  };
}

// The SDK's TOOL_NAMES minus `agent_knowledge_recall`, which the READ module owns. Order follows the SDK.
export const KNOWLEDGE_WRITE_TOOL_NAMES = [
  'agent_knowledge_list_pages',
  'agent_knowledge_get_page',
  'agent_knowledge_agent_x0y8qlge',
  'agent_knowledge_update_page',
  'agent_knowledge_delete_page',
  'agent_knowledge_reflect',
  'agent_knowledge_ingest',
];

/**
 * Build the write-side knowledge tools.
 *
 * CONFIG-GATED, NOT ALLOW-GATED, for the reason in the header: there is no boot token for
 * `hindsight.write`, and the PEP + tool filter do the gating per turn off the policy verdict. With no
 * apiUrl or bankId this returns [] — four tools that can only throw are worse than none, and handing a
 * model a tool that cannot work is what makes it improvise.
 */
export function buildKnowledgeWriteTools({ apiUrl, apiToken, bankId, clientImpl, lowLevelImpl } = {}) {
  if (!apiUrl || !bankId) return [];
  const t = createKnowledgeWriteTools({ apiUrl, apiToken, bankId, clientImpl, lowLevelImpl });
  return KNOWLEDGE_WRITE_TOOL_NAMES.map((n) => t[n]);
}

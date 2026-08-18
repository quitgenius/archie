// agent_knowledge_* — asserts the PORT matches the plugin it came from, request-shape by
// request-shape. The reference is example/hindsight @ task/org-knowledge-v2,
// hindsight-integrations/openclaw/src/document-tools.ts, which clawdbot builds into its image
// (clawdbot/Dockerfile:171-195). These are the assertions that would catch a drift from it.
//
// Written as a plain script with a fetch stub rather than node:test so the request URLs and bodies are
// visible in the output — the whole point is that they match another codebase's, and a green tick that
// hides the URL proves less.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKnowledgeTools, normalizeFactTypes, KNOWLEDGE_TOOL_NAMES, buildKnowledgeTools } from './knowledge-tools.mjs';
await test('agent_knowledge_* port matches the OpenClaw plugin', async () => {
let fail = 0;
const ok = (c, l) => { console.log(`  ${c ? 'ok  ' : 'FAIL'}  ${l}`); if (!c) fail++; };

// capture the requests the tools make
const calls = [];
const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ echoed: url }) }; };
const t = createKnowledgeTools({ apiUrl: 'https://h.example', apiToken: 'tok', bankId: 'default-org', fetchImpl });

console.log('  request shapes match the plugin:');
await t.agent_knowledge_list_documents.execute('1', {});
ok(calls.at(-1).url === 'https://h.example/v1/default/banks/default-org/documents?limit=100&offset=0', 'list_documents defaults 100/0');
await t.agent_knowledge_get_document.execute('1', { document_id: 'a b/c' });
ok(calls.at(-1).url.endsWith('/documents/a%20b%2Fc'), 'get_document url-encodes the id');
await t.agent_knowledge_search_documents.execute('1', { query: 'notes', tags: ['x','y'] });
ok(calls.at(-1).url.includes('q=notes') && (calls.at(-1).url.match(/tags=/g)||[]).length === 2, 'search sends q= and repeated tags=');
await t.agent_knowledge_recall.execute('1', { query: 'when did we ship' });
const body = JSON.parse(calls.at(-1).init.body);
ok(calls.at(-1).url.endsWith('/memories/recall') && calls.at(-1).init.method === 'POST', 'recall POSTs to /memories/recall');
ok(body.budget === 'mid' && body.max_tokens === 1024, "recall hardcodes budget 'mid', defaults 1024 tokens");
ok(JSON.stringify(body.types) === JSON.stringify(['world','experience']), 'recall TOOL defaults world+experience');
ok(calls.at(-1).init.headers.Authorization === 'Bearer tok', 'bearer token sent');

console.log('\n  normalizeFactTypes (ported verbatim):');
ok(JSON.stringify(normalizeFactTypes(undefined)) === JSON.stringify(['world','experience']), 'undefined -> defaults');
ok(JSON.stringify(normalizeFactTypes('world, observation')) === JSON.stringify(['world','observation']), 'comma string parsed');
ok(JSON.stringify(normalizeFactTypes(['nonsense'])) === JSON.stringify(['world','experience']), 'all-invalid -> defaults');
ok(JSON.stringify(normalizeFactTypes(['world','world'])) === JSON.stringify(['world']), 'de-duped');

console.log('\n  read-only surface + capability:');
ok(KNOWLEDGE_TOOL_NAMES.length === 4, 'four tools');
ok(Object.values(t).every((x) => x.capability === 'hindsight.read'), 'every tool declares hindsight.read');
ok(!Object.keys(t).some((n) => /retain|delete|update/i.test(n)), 'no write tool present');

console.log('\n  config gating:');
ok(buildKnowledgeTools({ apiUrl: '', bankId: 'b' }).length === 0, 'no apiUrl -> no tools');
ok(buildKnowledgeTools({ apiUrl: 'u', bankId: '' }).length === 0, 'no bankId -> no tools');
ok(buildKnowledgeTools({ apiUrl: 'u', bankId: 'b', fetchImpl }).length === 4, 'configured -> four tools');

  assert.equal(fail, 0, `${fail} assertion(s) diverged from the plugin`);
});

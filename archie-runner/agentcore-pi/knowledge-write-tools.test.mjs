// The write-side knowledge tools, and above all their CAPABILITY.
//
// The dangerous regression here is not a wrong request body — it is `agent_knowledge_agent_x0y8qlge`
// resolving to `hindsight.read`, which is BASELINE. That would make page creation, deletion and document
// ingest ambient for every agent in the fleet with the policy pin bypassed entirely, and nothing would fail: the
// tools would work, for everyone. So the classification tests come first and are the point.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildKnowledgeWriteTools, createKnowledgeWriteTools, KNOWLEDGE_WRITE_TOOL_NAMES, normalizeFactTypesStrict } from './knowledge-write-tools.mjs';
import { KNOWLEDGE_TOOL_NAMES } from './knowledge-tools.mjs';
import { CUSTOM_TOOLS } from './tool-declarations.mjs';
import { makeCapabilityResolver, isBaseline } from './permissions/capabilities.mjs';

const CFG = { apiUrl: 'https://hindsight.invalid', apiToken: 't', bankId: 'default-org' };

test('every write tool carries hindsight.write, and hindsight.write is NOT baseline', () => {
  for (const t of buildKnowledgeWriteTools(CFG)) {
    assert.equal(t.capability, 'hindsight.write', t.name);
  }
  assert.equal(isBaseline('hindsight.write'), false, 'if this ever becomes baseline the pin is bypassed');
  assert.equal(isBaseline('hindsight.read'), true, 'the read four stay ambient, per sandbox 2026-08-18');
});

test('the capability RESOLVER classifies writes as write and reads as read', () => {
  // The resolver is what the PEP actually calls. A single `agent_knowledge_*` → hindsight.read rule would
  // pass every other test in this file and still make agent_x0y8qlge ambient.
  const capOf = makeCapabilityResolver({ toolCaps: CUSTOM_TOOLS });
  for (const n of KNOWLEDGE_WRITE_TOOL_NAMES) assert.equal(capOf(n), 'hindsight.write', n);
  for (const n of KNOWLEDGE_TOOL_NAMES) assert.equal(capOf(n), 'hindsight.read', n);
});

test('an UNDECLARED agent_knowledge_* name still resolves — and to the read side', () => {
  // The residual branch, with nothing in toolCaps. A future write tool that someone forgets to declare
  // lands on hindsight.read and is silently ambient, which is exactly why the write names are enumerated
  // explicitly in capabilities.mjs rather than pattern-matched. This test records the hazard rather than
  // pretending it is closed: it is closed by the enumeration ABOVE this branch, not by the branch.
  const capOf = makeCapabilityResolver({ toolCaps: {} });
  assert.equal(capOf('agent_knowledge_something_new'), 'hindsight.read');
  // But a KNOWN write name resolves correctly even with an empty toolCaps, because capabilities.mjs
  // derives the write set from the declarations rather than relying on the caller to pass them.
  assert.equal(capOf('agent_knowledge_agent_x0y8qlge'), 'hindsight.write');
  assert.equal(capOf('agent_knowledge_ingest'), 'hindsight.write');
});

test('recall is NOT redefined here — one tool name, one capability', () => {
  // Defining recall in both modules would give one name two capabilities, and whichever factory ran last
  // would decide. It is the read module's.
  assert.ok(!KNOWLEDGE_WRITE_TOOL_NAMES.includes('agent_knowledge_recall'));
  assert.ok(KNOWLEDGE_TOOL_NAMES.includes('agent_knowledge_recall'));
  const overlap = KNOWLEDGE_WRITE_TOOL_NAMES.filter((n) => KNOWLEDGE_TOOL_NAMES.includes(n));
  assert.deepEqual(overlap, [], 'the two bundles must be disjoint');
});

test('the ported set is the SDK\'s TOOL_NAMES minus recall — 7 tools, in the SDK\'s order', () => {
  assert.deepEqual(KNOWLEDGE_WRITE_TOOL_NAMES, [
    'agent_knowledge_list_pages', 'agent_knowledge_get_page', 'agent_knowledge_agent_x0y8qlge',
    'agent_knowledge_update_page', 'agent_knowledge_delete_page', 'agent_knowledge_reflect',
    'agent_knowledge_ingest',
  ]);
  assert.equal(buildKnowledgeWriteTools(CFG).length, 7);
});

test('config-gated: no apiUrl or no bankId builds NOTHING', () => {
  // Handing a model a tool that can only throw is what makes it improvise. Same contract as the read side.
  assert.deepEqual(buildKnowledgeWriteTools({}), []);
  assert.deepEqual(buildKnowledgeWriteTools({ apiUrl: 'https://x.invalid' }), []);
  assert.deepEqual(buildKnowledgeWriteTools({ bankId: 'b' }), []);
});

test('every tool is well-formed for Pi: name, capability, description, parameters, execute', () => {
  for (const t of buildKnowledgeWriteTools(CFG)) {
    assert.equal(typeof t.name, 'string', 'name');
    assert.equal(typeof t.description, 'string', `${t.name} description`);
    assert.ok(t.description.length > 20, `${t.name} description is substantive`);
    assert.equal(typeof t.execute, 'function', `${t.name} execute`);
    assert.ok(t.parameters, `${t.name} parameters`);
    assert.equal(typeof t.label, 'string', `${t.name} label`);
  }
});

test('normalizeFactTypesStrict THROWS on an invalid type — unlike the read side, deliberately', () => {
  // The SDK throws here while document-tools.ts falls back to defaults. Both behaviours are ported as-is:
  // "fixing" the difference would change what the model sees on a malformed call.
  assert.deepEqual(normalizeFactTypesStrict(undefined), ['world', 'experience', 'observation']);
  assert.deepEqual(normalizeFactTypesStrict(['world']), ['world']);
  assert.deepEqual(normalizeFactTypesStrict('world, observation'), ['world', 'observation']);
  assert.deepEqual(normalizeFactTypesStrict(['world', 'world']), ['world'], 'de-duped');
  assert.throws(() => normalizeFactTypesStrict(['nonsense']), /Expected one or more of/);
  assert.throws(() => normalizeFactTypesStrict(['world', 'nonsense']), /Expected one or more of/, 'partial invalid throws too');
  assert.throws(() => normalizeFactTypesStrict([]), /Expected one or more of/, 'empty after filtering throws');
});

// ── request shapes, against the SDK's own ────────────────────────────────────────────────────────────

/** Records every call, so the assertions are about the REQUEST rather than about the description text. */
function spy() {
  const calls = [];
  const rec = (name) => (...args) => { calls.push({ name, args }); return { data: { ok: true } }; };
  return {
    calls,
    client: {
      listMentalModels: rec('listMentalModels'),
      getMentalModel: rec('getMentalModel'),
      updateMentalModel: rec('updateMentalModel'),
      deleteMentalModel: rec('deleteMentalModel'),
      retainBatch: rec('retainBatch'),
    },
    lowLevel: { createMentalModel: rec('createMentalModel'), reflect: rec('reflect') },
  };
}
const withSpy = (s) => createKnowledgeWriteTools({ ...CFG, clientImpl: s.client, lowLevelImpl: s.lowLevel });

test('agent_x0y8qlge sends the FULL page trigger, not the high-level subset', async () => {
  // The reason this goes through the low-level client at all. High-level createMentalModel exposes only
  // trigger.refreshAfterConsolidation (measured against hindsight-client 0.6.2), so using it would silently
  // drop mode, exclude_mental_models and fact_types — and a page synthesised from other pages, or from
  // world facts instead of observations, is a different thing from what OpenClaw creates.
  const s = spy();
  await withSpy(s).agent_knowledge_agent_x0y8qlge.execute('id', {
    page_id: 'editorial-preferences', name: 'Editorial preferences', source_query: 'What are the preferences?',
  });
  const { body, path } = s.calls[0].args[0];
  assert.equal(path.bank_id, 'default-org');
  assert.equal(body.id, 'editorial-preferences');
  assert.equal(body.max_tokens, 4096);
  assert.deepEqual(body.trigger, {
    mode: 'delta', refresh_after_consolidation: true, exclude_mental_models: true, fact_types: ['observation'],
  }, 'the whole trigger, verbatim from the SDK');
});

test('ingest derives the document id from the title, so re-ingesting REPLACES', async () => {
  // The description promises "re-ingesting replaces it", and that promise is carried entirely by deriving
  // the id from the title. If the derivation changes, re-ingest starts duplicating and the description lies.
  const s = spy();
  await withSpy(s).agent_knowledge_ingest.execute('id', { title: 'Meeting Notes 2026', content: 'raw text' });
  const [bank, items, opts] = s.calls[0].args;
  assert.equal(bank, 'default-org');
  assert.deepEqual(items, [{ content: 'raw text', document_id: 'meeting-notes-2026' }]);
  assert.deepEqual(opts, { async: true }, 'async, as the SDK does — ingest is a long job');
});

test('reflect passes max_tokens and include.facts, which the high-level client cannot express', async () => {
  const s = spy();
  const t = withSpy(s);
  await t.agent_knowledge_reflect.execute('id', { query: 'what happened?', max_tokens: 2048, include_facts: true, budget: 'high' });
  let { body } = s.calls[0].args[0];
  assert.equal(body.max_tokens, 2048);
  assert.deepEqual(body.include, { facts: {} });
  assert.equal(body.budget, 'high');
  assert.deepEqual(body.fact_types, ['world', 'experience', 'observation'], 'reflect defaults to ALL three');

  // Defaults, and the budget guard: anything not low/mid/high becomes 'low' rather than reaching the API.
  s.calls.length = 0;
  await t.agent_knowledge_reflect.execute('id', { query: 'q', budget: 'enormous' });
  ({ body } = s.calls[0].args[0]);
  assert.equal(body.budget, 'low');
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.include, undefined, 'omitted, not false — the SDK sends undefined');
});

test('update_page maps snake_case params to the client\'s camelCase options', async () => {
  // A silent mismatch here would send `source_query: undefined` and the page would keep its old query while
  // the tool reported success.
  const s = spy();
  await withSpy(s).agent_knowledge_update_page.execute('id', { page_id: 'p1', name: 'New', source_query: 'Why?' });
  const [bank, pageId, opts] = s.calls[0].args;
  assert.equal(bank, 'default-org');
  assert.equal(pageId, 'p1');
  assert.deepEqual(opts, { name: 'New', sourceQuery: 'Why?' });
});

test('delete_page returns a synthetic success, because the client resolves to void', async () => {
  // An empty result reads to the model as a failure, so it would retry a destructive call.
  const s = spy();
  const r = await withSpy(s).agent_knowledge_delete_page.execute('id', { page_id: 'p1' });
  assert.deepEqual(s.calls[0].args.slice(0, 2), ['default-org', 'p1']);
  assert.deepEqual(r.details, { success: true });
});

test('a low-level error is THROWN, not returned as content', async () => {
  // resp.error is the generated client's error channel and does not reject. Returning it as tool content
  // would show the model a "successful" call whose body happens to describe a failure.
  const t = createKnowledgeWriteTools({
    ...CFG, clientImpl: {}, lowLevelImpl: { createMentalModel: async () => ({ error: { detail: 'nope' } }), reflect: async () => ({ error: 'bad' }) },
  });
  await assert.rejects(() => t.agent_knowledge_agent_x0y8qlge.execute('i', { page_id: 'p', name: 'n', source_query: 'q' }), /agent_x0y8qlge failed/);
  await assert.rejects(() => t.agent_knowledge_reflect.execute('i', { query: 'q' }), /reflect failed/);
});

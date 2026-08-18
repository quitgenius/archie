// The LLM-facing skill filter (plan §7.2 / D3).
//
// Tools have `applyToolFilter`; skills had no equivalent, so a denied skill's PROSE stayed in the prompt and
// the model kept being instructed to do something it could not do. This filter removes it from what the
// model is given at all.
//
// NAMED `.test.mjs`, unlike the sibling `skill-scope-test.mjs`, and the distinction is load-bearing in this
// directory: `-test.mjs` files are standalone scripts that drive live AWS (that one wants
// `AWS_PROFILE=sandbox node …`), while `.test.mjs` files are the offline node:test suites `npm run check` runs.
// Appending these cases to the live script is exactly the mistake this note exists to prevent — it has no
// node:test import, so every case fails to load.
//
// THE FIRST TEST IS THE ONE THAT MATTERS. With no policy row the filter must be a NO-OP, because every
// scope is in that state until a policy deploy reaches it, and filtering on absent data would strip 146
// holders on their next turn — the unrecoverable strip D3 orders the whole task around.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filterPinnedSkills } from './skill-scope.mjs';

const MAN = { skills: { 'otel-debug': 'v1', 'skill-builder': 'v1', 'demo-crm': 'v1', understand: 'v1' } };
const INSTALLS = { 'otel-debug': {}, 'skill-builder': {}, 'demo-crm': {}, understand: {} };
const GOVERNED = ['demo-crm', 'skill-builder', 'comms-approval'];
const keys = (r) => Object.keys(r).sort();

test('no policy row is a NO-OP, whichever argument is missing', () => {
  assert.deepEqual(keys(filterPinnedSkills(INSTALLS, null, null, MAN)), keys(INSTALLS), 'both absent');
  assert.deepEqual(keys(filterPinnedSkills(INSTALLS, ['skill-builder'], null, MAN)), keys(INSTALLS), 'governed absent');
  assert.deepEqual(keys(filterPinnedSkills(INSTALLS, null, GOVERNED, MAN)), keys(INSTALLS), 'allow-list absent');
});

test('ALWAYS-ON skills are unfilterable, even when governed and not allowed', () => {
  // A hard condition from the plan: otel-debug is how an operator sees the fleet, so one bad allow-list must
  // not be able to blind it. They are fleet-wide pseudo-installs, not per-agent installs, so an allow-list
  // has no business deciding them.
  const out = filterPinnedSkills({ 'otel-debug': {} }, [], ['otel-debug'], { skills: { 'otel-debug': 'v1' } });
  assert.deepEqual(Object.keys(out), ['otel-debug']);
});

test('UNPINNED skills pass untouched — this is not a second install gate', () => {
  const out = filterPinnedSkills({ understand: {} }, [], ['demo-crm'], MAN);
  assert.deepEqual(Object.keys(out), ['understand'], 'a skill the policy says nothing about is not governed');
});

test('a governed, unallowed skill is removed AND reported', () => {
  // The deny has to be legible: a silent strip is indistinguishable from an agent that never had the skill,
  // which makes "why did it stop doing X" unanswerable.
  const denied = [];
  const out = filterPinnedSkills(INSTALLS, ['skill-builder'], GOVERNED, MAN, (id) => denied.push(id));
  assert.deepEqual(keys(out), ['otel-debug', 'skill-builder', 'understand']);
  assert.deepEqual(denied, ['demo-crm'], 'named, once');
});

test('an allow-list that grants nothing still keeps always-on and unpinned skills', () => {
  assert.deepEqual(keys(filterPinnedSkills(INSTALLS, [], GOVERNED, MAN)), ['otel-debug', 'understand']);
});

test('a throwing onDeny never changes the decision', () => {
  const out = filterPinnedSkills({ 'demo-crm': {} }, [], GOVERNED, MAN, () => { throw new Error('otel down'); });
  assert.deepEqual(Object.keys(out), [], 'still filtered — a telemetry failure must not un-deny a skill');
});

test('the seeded sandbox holder keeps its skill — the one scope this filter would strip today', () => {
  // ch-c66pp782t9k (sandbox-person79b333-test) holds skill-builder and is the sandbox's ONLY pinned-skill holder, so
  // it is the whole live blast radius of shipping this. It is in pins.sandbox.json's skill.skill-builder, which
  // is what makes the strip a no-op for it.
  const out = filterPinnedSkills({ 'skill-builder': {} }, ['skill-builder'], GOVERNED, MAN);
  assert.deepEqual(Object.keys(out), ['skill-builder']);
});

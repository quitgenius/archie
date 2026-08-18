'use strict';

// CEDAR IS A DEPLOY-TIME DEPENDENCY AND MUST NEVER REACH AN IMAGE.
//
// The policy layer compiles Cedar to a per-scope verdict row at deploy time and ships only that row
// (archie-policy-implementation-plan.md §1.1). The engine itself — @cedar-policy/cedar-wasm, a 4.1 MB
// wasm binary, ~12 MB unpacked — stays in the CLI. Nothing in either image evaluates Cedar.
//
// That is a decision, not an accident (plan §7): a general PDP in the hot path would add a wasm load to
// every cold boot and a per-tool-call evaluation, and the whole point of materialising is that
// `decide()` stays a set lookup. `archie/` is not COPYed into either Dockerfile, so the CLI's own
// dependency cannot leak — the live risk is somebody later adding cedar-wasm to an IMAGE's package.json
// because they want to evaluate policy at runtime. This test is what makes that a failing build rather
// than a 4.1 MB surprise in the agent image.
//
// It also pins the MAJOR version, because the policy semantics were verified against 4.12.0 — the
// permit/forbid pair, the fail-closed ScopeGroup behaviour, `like` being case-sensitive, and enumerated
// entity types all measured against that engine (archie-cedar-spike/README.md). A major bump could
// change evaluation, so it should be a deliberate act with the spike re-run, not a lockfile drift.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PKG = '@cedar-policy/cedar-wasm';
const DOCKER = path.resolve(__dirname, '..', '..');          // …/docker
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf-8'));

// Every package.json whose dependencies END UP IN A SHIPPED IMAGE. Both Dockerfiles npm-install from
// these, so a dependency here is a dependency in the image.
const IMAGE_PACKAGES = [
  'archie-runner/agentcore-pi/package.json',
  'archie-gateway/package.json',
];

test('cedar-wasm is a dependency of the CLI, so the deploy can compile policy', () => {
  const pkg = readJson(path.join(__dirname, '..', 'package.json'));
  const range = (pkg.dependencies || {})[PKG];
  assert.ok(range, `${PKG} must be an archie-cli dependency — the deploy-time materialiser needs it`);
  assert.match(range, /^\^?4\./, `${PKG} is pinned to major 4 (verified at 4.12.0); a major bump changes `
    + 'evaluation semantics and must be a deliberate act with archie-cedar-spike re-run');
});

test('cedar-wasm is NOT a dependency of any shipped image', () => {
  const offenders = [];
  for (const rel of IMAGE_PACKAGES) {
    const p = path.join(DOCKER, rel);
    if (!fs.existsSync(p)) continue;   // tolerate a moved/renamed package rather than passing silently
    const pkg = readJson(p);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      if ((pkg[field] || {})[PKG]) offenders.push(`${rel} (${field})`);
    }
  }
  assert.deepEqual(offenders, [], `${PKG} must not ship in an image — Cedar is a BUILD-TIME authority `
    + '(plan §7). If runtime evaluation is genuinely wanted, that is a design change: it reverses the '
    + 'materialisation decision and costs a wasm load on every cold boot.');
});

test('every image package.json this test guards actually exists', () => {
  // Guards the guard. The check above `continue`s past a missing path so a rename does not fail
  // spuriously — which would also let it pass vacuously if BOTH were renamed. This asserts the list is
  // still real, so the two failure modes cannot coincide.
  const missing = IMAGE_PACKAGES.filter((rel) => !fs.existsSync(path.join(DOCKER, rel)));
  assert.deepEqual(missing, [], 'IMAGE_PACKAGES is stale — update it, or the guard above passes vacuously');
});

test('neither Dockerfile COPYs the CLI or references cedar', () => {
  // The second half of the containment argument: even with the dependency declared in archie/, it can
  // only reach an image if the image copies archie/ or installs cedar directly.
  const dockerfiles = ['archie-runner/agentcore-pi/Dockerfile', 'archie-gateway/Dockerfile'];
  const offenders = [];
  for (const rel of dockerfiles) {
    const p = path.join(DOCKER, rel);
    if (!fs.existsSync(p)) { offenders.push(`${rel} MISSING`); continue; }
    const text = fs.readFileSync(p, 'utf-8');
    if (/cedar/i.test(text)) offenders.push(`${rel} mentions cedar`);
    for (const line of text.split('\n')) {
      if (/^\s*COPY\b/.test(line) && /(^|\s)archie\//.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], 'an image would pull in the CLI or Cedar');
});

test('the engine actually loads and evaluates from the CLI', async () => {
  // Declaring the dependency is not the same as it working: cedar-wasm ships a wasm binary and loads it
  // through an experimental Node path, so this proves the deploy-time compile can really run here.
  const cedar = await import(PKG);
  assert.equal(typeof cedar.isAuthorized, 'function');
  assert.match(String(cedar.getCedarSDKVersion()), /^4\./);
  const r = cedar.isAuthorized({
    principal: { type: 'Archie::Scope', id: 's' },
    action: { type: 'Archie::Action', id: 'use' },
    resource: { type: 'Archie::Capability', id: 'c' },
    context: {},
    policies: { staticPolicies: { p: 'permit (principal, action, resource);' } },
    entities: [],
  });
  assert.equal(r.type, 'success');
  assert.equal(r.response.decision, 'allow');
});

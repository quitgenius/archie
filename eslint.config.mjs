// ESLint 9 flat config for the archie/AgentCore docker tree.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO RUN (from docker/ — `npm install` here once first)
// ─────────────────────────────────────────────────────────────────────────────
//   npx eslint .                      whole tree, ~2s
//   npx eslint slack-dispatcher       one package
//   npm run lint                      inside any covered package
//
// The `files` patterns below are resolved relative to the WORKING DIRECTORY, not
// to this file, so eslint must be run from docker/. That is why each package's
// `lint` script cd's up here first. Run it before any build/deploy, and as the
// first step when debugging a container that crash-loops or 500s.
// Longer field guide: .claude/skills/lint-archie-docker/SKILL.md
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS
// ─────────────────────────────────────────────────────────────────────────────
// On 2026-08-13 three bugs shipped to a live sandbox that 786 unit tests and
// `node --check` all passed. Each one only surfaced with the real image running
// against real AWS, so each one cost a full build → push → roll cycle to find:
//
//   1. `@aws-sdk/client-secrets-manager` was require()d by slack-dispatcher but
//      was not in its package.json, so `npm ci` never installed it in the image.
//      → caught by n/no-extraneous-require (declared nowhere) and, when the
//        module is absent from node_modules too, n/no-missing-require.
//
//   2. `log is not defined` — a file used a module-scope logger it did not have.
//      → caught by no-undef.
//
//   3. `docClient` out of scope in makeProvisioningClients — a module-level
//      function reaching into a variable that only exists inside a closure.
//      → caught by no-undef.
//
// All three are caught in about a second by the rules below. There was no ESLint
// config anywhere under docker/ before this file, while the wider repo has ~113
// at depth <= 3 (legacy .eslintrc.js + @internal/eslint-config) — the
// conventions existed, this tree just never adopted them. We use flat config
// here rather than extending @internal/eslint-config because that config is
// ESLint 8 + prettier + TypeScript oriented, and this tree is mostly plain
// .js/.mjs/.cjs with no build step.
//
// ─────────────────────────────────────────────────────────────────────────────
// SCOPE OF RULES — read before adding any
// ─────────────────────────────────────────────────────────────────────────────
// This config exists to catch bugs that reach production. It is NOT a style
// tool. No formatting, no naming, no import ordering, no opinionated
// `js.configs.recommended` blanket. Every rule below names the class of bug it
// prevents. If you add a rule and cannot name a bug it would have caught in this
// tree, do not add it.
//
// ─────────────────────────────────────────────────────────────────────────────
// PACKAGES AND THEIR MODULE SYSTEMS (they differ — hence the blocks below)
// ─────────────────────────────────────────────────────────────────────────────
//   slack-dispatcher/                  CommonJS .js  (+ 1 .mjs), vitest globals
//   clawdbot/agentcore-pi/             ESM .mjs      (+ .cjs)
//   clawdbot/config-resolver/          ESM .mjs      (+ .cjs)
//   clawdbot/agentcore-tests/          CommonJS .js  (+ .mjs), cucumber
//   clawdbot/agentcore-observability/  CommonJS .cjs/.js
//   clawdbot/agentcore-provision/      ESM .mjs      (+ provision.ts, see below)
//   clawdbot/connector-session-plugin/  TypeScript    (NOT LINTED, see below)
//
// TypeScript is deliberately out of scope. The two TS entry points in this tree
// (connector-session-plugin/*.ts and agentcore-provision/provision.ts) already
// get the same class of protection from `tsc --noEmit` / tsx, which reports
// undefined identifiers and unresolved imports directly. Wiring typescript-eslint
// in for ~12 files would add a parser, a project service and a second source of
// truth for no new coverage. Run `npm run typecheck` in connector-session-plugin
// instead. Revisit if this tree grows real TypeScript.

import n from 'eslint-plugin-n';
import globals from 'globals';

// Vitest injects these because slack-dispatcher/vitest.config.js sets
// `test.globals: true`. Without them every *.test.js is a wall of no-undef.
const vitestGlobals = {
  describe: 'readonly',
  it: 'readonly',
  test: 'readonly',
  expect: 'readonly',
  vi: 'readonly',
  suite: 'readonly',
  beforeAll: 'readonly',
  afterAll: 'readonly',
  beforeEach: 'readonly',
  afterEach: 'readonly',
  assert: 'readonly',
  onTestFinished: 'readonly',
  onTestFailed: 'readonly',
};

// The rules. Identical for every package; only globals/sourceType differ.
const bugRules = {
  // BUG CLASS: a reference to something that does not exist in scope.
  //   - `log is not defined` (a file that never imported/created its logger)
  //   - `docClient` reached for from a module-level function when it only
  //     exists inside another function's closure
  // Both crash at the moment the code path is first hit — i.e. in production,
  // after a deploy, not in unit tests that never reach that branch.
  'no-undef': 'error',

  // BUG CLASS: requiring/importing a module the image will not contain.
  // no-missing-*    → the module does not resolve at all (bad relative path,
  //                   renamed file, package absent from node_modules).
  // no-extraneous-* → the module resolves locally (hoisted or transitive) but
  //                   is declared in NO package.json section, so `npm ci` in the
  //                   Dockerfile will not install it and the container dies on
  //                   first require. This is exactly the
  //                   @aws-sdk/client-secrets-manager bug.
  'n/no-missing-require': 'error',
  'n/no-missing-import': 'error',
  'n/no-extraneous-require': 'error',
  'n/no-extraneous-import': 'error',

  // BUG CLASS: silently swallowed errors — `catch {}` with an empty body turns a
  // real failure into a wrong-but-quiet result.
  //
  // WARN, NOT ERROR, ON PURPOSE, and the intent is to RATCHET IT TO 'error' as
  // the docker/SWALLOWED-ERRORS-PLAN.md batches land. Landing it at error now
  // would invite a bulk sweep of `eslint-disable` comments with placeholder
  // reasons — the same silence with extra steps. Every disable that survives the
  // ratchet must be written by whoever understands that specific call site and
  // must say why swallowing is correct there.
  //
  // MEASURED CAVEAT — READ THIS BEFORE TREATING THE WARN COUNT AS THE BACKLOG.
  // SWALLOWED-ERRORS-PLAN.md counts ~111 sites whose catch body is "empty OR
  // COMMENT-ONLY". `no-empty` does not report a block containing a comment, and
  // has no option to. Measured on this tree it reports exactly ONE site. So this
  // rule is NOT a meter for that backlog and must not be quoted as one — the
  // plan's own regex sweep is. What this rule does buy is that the count cannot
  // grow silently from zero-comment `catch {}`, which is the cheapest shape to
  // add and the hardest to spot in review.
  'no-empty': ['warn', { allowEmptyCatch: false }],
};

export default [
  {
    // This tree already carries `eslint-disable` comments for rules from the wider repo's config
    // (no-console, no-await-in-loop, no-var, …) that this config deliberately does not enable. With
    // the default setting every one of them reports as an "unused disable directive", which buries
    // the real findings under noise that is not a defect. Off until the rule sets converge.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    // Not source. node_modules is ignored by default; the rest is generated,
    // vendored or data.
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.vite/**',
      '**/coverage/**',
      // Everything outside the packages this config claims. Other dirs under
      // docker/ (management-console, agent-tuqikh-worker, example-backup,
      // archie-metrics, …) are not archie/AgentCore code and are not in scope;
      // adopting them is a separate, deliberate change.
      'archie-metrics/**',
      'example-backup/**',
      'agent-tuqikh-worker/**',
      'github-private-runner/**',
      'load-test-runner/**',
      'management-console/**',
      'demo_warehouse-mcp-server/**',
      'example-iac-runner/**',
      'clawdbot/agentcore-skills/**',
      'clawdbot/config-seed/**',
      'clawdbot/hindsight-ingest/**',
      'clawdbot/openclaw-mcp-auth-plugin/**',
      'clawdbot/demo-cache-plugin/**',
      'clawdbot/plugin-sdk/**',
      'clawdbot/slack-reply-plugin/**',
      // TypeScript — covered by tsc, see header.
      '**/*.ts',
      '**/*.tsx',
    ],
  },

  // ── slack-dispatcher: CommonJS ────────────────────────────────────────────
  {
    files: ['slack-dispatcher/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },
  {
    // vitest.config.js is ESM (`import { defineConfig } …`) despite the .js
    // extension and the package having no "type": "module".
    files: ['slack-dispatcher/vitest.config.js', 'slack-dispatcher/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },
  {
    files: ['slack-dispatcher/**/*.test.js'],
    languageOptions: { globals: { ...globals.node, ...vitestGlobals } },
  },
  {
    // DUAL-PATH ESM BRIDGES. These three files dynamic-import the agent's ESM modules
    // (config-resolver/*.mjs, agentcore-pi/workspace-seed.mjs) as the single source of truth for
    // the cap→IAM map and the workspace seed. They try the IN-IMAGE path first
    // (`./config-resolver/schema.mjs` — the Dockerfile COPYs those files to /app/config-resolver/)
    // and fall back to the SOURCE-TREE path (`../clawdbot/config-resolver/schema.mjs`) for local
    // runs and tests. The first path cannot resolve from the source tree by construction, so
    // n/no-missing-import cannot judge it here.
    //
    // That is not a coverage hole: the in-image paths are checked at BUILD time by the extended
    // COPY-ALLOWLIST PREFLIGHT in slack-dispatcher/Dockerfile, which resolves both require('./…')
    // AND import('./…') specifiers against the assembled image. Add a new bridge and forget the
    // COPY and the build fails there. Do not widen this block to the whole package.
    files: [
      'slack-dispatcher/derived-role.js',
      'slack-dispatcher/agentcore-client.js',
      'slack-dispatcher/marketplace.js',
    ],
    rules: { 'n/no-missing-import': 'off' },
  },

  // ── clawdbot/agentcore-pi, config-resolver, agentcore-provision: ESM ──────
  {
    files: [
      'clawdbot/agentcore-pi/**/*.mjs',
      'clawdbot/config-resolver/**/*.mjs',
      'clawdbot/agentcore-provision/**/*.mjs',
    ],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },
  {
    files: ['clawdbot/agentcore-pi/**/*.cjs', 'clawdbot/config-resolver/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },

  // ── clawdbot/agentcore-tests: CommonJS cucumber suite ─────────────────────
  // Step definitions `require('@cucumber/cucumber')` rather than relying on
  // injected globals, so no cucumber globals block is needed. If a step file is
  // ever written against globals (Given/When/Then free), add them here rather
  // than disabling no-undef for the file.
  {
    files: ['clawdbot/agentcore-tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },
  {
    files: ['clawdbot/agentcore-tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },

  // ── clawdbot/agentcore-observability: CommonJS ────────────────────────────
  {
    files: ['clawdbot/agentcore-observability/**/*.{js,cjs}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n },
    rules: bugRules,
  },
];

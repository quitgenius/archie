// ESLint 9 flat config for the archie/AgentCore docker tree.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO RUN (from docker/ — `npm install` here once first)
// ─────────────────────────────────────────────────────────────────────────────
//   npx eslint .                      whole tree, ~2s
//   npx eslint slack-dispatcher       one package
//   npm run lint                      inside any covered package
//   npm run swallowed-errors          the §8(d) backlog count, per package
//   npm test                          unit-tests the one LOCAL rule below
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

// ─────────────────────────────────────────────────────────────────────────────
// LOCAL RULE: local/no-statementless-catch
// ─────────────────────────────────────────────────────────────────────────────
// SWALLOWED-ERRORS-PLAN.md §8(d), Option B. Kept INLINE rather than in its own
// file on purpose: both Dockerfiles' lint stages COPY exactly one config file
// (`COPY eslint.config.mjs ./` / `COPY --from=lintroot eslint.config.mjs ./`),
// so a second file means two more COPY lines to keep in sync forever, for ~30
// lines of rule. It is exported by name below so the unit test can import it
// (`eslint.config.test.mjs`, `npm test` from docker/) without an eslint run.
//
// WHY IT EXISTS. `no-empty` was meant to be the ratchet's instrument and CANNOT
// BE: it does not report a block that contains a comment, and has no option to.
// Measured on this tree it reports exactly ONE site — a comment-free `catch {}`
// in a test helper — i.e. zero of the backlog, nearly all of which carries an
// explanatory comment. A comment is precisely what the plan's standard (§2)
// calls insufficient: the failure must LOG, COUNT or be CLASSIFIED.
//
// THE PREDICATE is "a rejection path that runs zero STATEMENTS". Comments are
// not statements — they live on the AST's comment list, not in BlockStatement
// .body — so every form below reports except the last:
//
//   catch {}                                 -> reported (CatchClause, 0 stmts)
//   catch (e) { /* absent */ }               -> reported
//   catch (e) { // peer gone                 -> reported
//   }
//   p.catch(() => {})                        -> reported (handler, 0 stmts)
//   p.catch(function () { /* best effort */ })-> reported
//   p.then(ok, () => {})                     -> reported
//   catch (e) { log.warn(e) }                -> NOT reported (1 statement)
//
// WHY THE HANDLER FORMS ARE IN SCOPE — MEASURED, not assumed. A pure CatchClause
// predicate finds 82 sites here. `.catch(() => {})` adds 53 more and `.then(_, ()
// => {})` 2, for 137. The 55 are not a fringe: they are the whole of the plan's
// §8(b) "best-effort teardown" family (ranked #10 in §4, remediated by the
// `bestEffort(label, promise)` helper), plus most of `agentcore-fixture.js`. A
// CatchClause-only rule would let that entire batch land without the number
// moving — the exact failure the meter exists to prevent. Same class, same
// standard, same fix; one rule, two messages so the output stays legible.
//
// It is deliberately NOT a detector of every swallowed error — `catch { return
// null }` has a statement and passes. It measures the specific §8 population.
export const noStatementlessCatch = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a rejection path that runs no statements — a catch clause or a .catch()/.then() handler whose body is empty or comment-only.',
      url: 'https://github.com/example/repo',
    },
    schema: [],
    messages: {
      emptyCatchClause:
        'Swallowed error: this catch body runs no statements, so the failure produces no signal at all. Make it LOG, COUNT, or CLASSIFY (rethrow anything but the expected class) — SWALLOWED-ERRORS-PLAN.md §2. If silence is genuinely correct here, disable this rule on the line and write the reason.',
      emptyRejectionHandler:
        'Swallowed error: this rejection handler runs no statements, so the failure produces no signal at all. Use the bestEffort(label, promise) helper (SWALLOWED-ERRORS-PLAN.md §8b) or log it. If silence is genuinely correct here, disable this rule on the line and write the reason.',
    },
  },
  create(context) {
    // A function expression whose block body holds no statements. An expression-bodied
    // arrow (`() => undefined`) is excluded on purpose: it is a written-down value, not
    // an absence, and it is not part of the measured population.
    const isEmptyHandler = (node) =>
      !!node &&
      (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') &&
      node.body.type === 'BlockStatement' &&
      node.body.body.length === 0;

    return {
      CatchClause(node) {
        // node.body is always a BlockStatement; .body is its statement list.
        if (node.body.body.length === 0) {
          context.report({ node, messageId: 'emptyCatchClause' });
        }
      },
      CallExpression(node) {
        const { callee } = node;
        if (callee.type !== 'MemberExpression' || callee.computed) return;
        const method = callee.property.name;
        // .catch(fn) → arg 0 is the rejection handler. .then(onOk, fn) → arg 1 is.
        const handler =
          method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : null;
        if (isEmptyHandler(handler)) {
          context.report({ node: handler, messageId: 'emptyRejectionHandler' });
        }
      },
    };
  },
};

const local = { rules: { 'no-statementless-catch': noStatementlessCatch } };

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

  // BUG CLASS: silently swallowed errors — a catch body that does nothing turns
  // a real failure into a wrong-but-quiet result. Definition and rationale at
  // the rule itself, above; SWALLOWED-ERRORS-PLAN.md §8(d) is the decision.
  //
  // WARN, NOT ERROR, ON PURPOSE, and the intent is to RATCHET IT TO 'error' as
  // the plan's batches land. Landing it at error now would fail both image builds
  // outright, and would invite a bulk sweep of `eslint-disable` comments with
  // placeholder reasons — the same silence with extra steps. Every disable that
  // survives the ratchet must be written by whoever understands that specific
  // call site and must say why swallowing is correct there.
  //
  // BASELINE at 2026-08-14 — 137 sites, and this count IS the backlog (unlike
  // `no-empty`'s, below). `npm run swallowed-errors` from docker/ reprints it:
  //
  //    52  slack-dispatcher                      30  clawdbot/agentcore-pi
  //    47  clawdbot/agentcore-tests               1  clawdbot/config-resolver
  //     7  clawdbot/agentcore-provision           0  clawdbot/agentcore-observability
  //
  // Treat that as a reading, not a constant: it moved 137 -> 139 -> 137 in one
  // afternoon (two new silences added by concurrent work, then agentcore-
  // observability cleared to zero). That rate was previously invisible, which is
  // the whole argument for the rule.
  //
  // Of the 137, 11 are sites SWALLOWED-ERRORS-PLAN.md §8 explicitly leaves alone
  // as already correct — 4 SSE "client gone" writes, 3 mount probes and 2
  // session.dispose in pi-adapter.mjs, plus 2 session.dispose in test helpers.
  // They stay at warn: a disable comment there must be written by hand with the
  // reason, and that is the last step of the ratchet, not the first.
  //
  // HOW TO RATCHET, per directory. The blocks below are already one per package,
  // so tightening a cleared package is a `rules` override inside its existing
  // block — no new structure. Append to the block, after `rules: bugRules`:
  //
  //   {
  //     files: ['clawdbot/agentcore-observability/**/*.{js,cjs}'],
  //     ...
  //     rules: { ...bugRules, 'local/no-statementless-catch': 'error' },
  //   }
  //
  // or, for a subtree finer than a package, add a new block after it:
  //
  //   { files: ['slack-dispatcher/cron-*.js'],
  //     rules: { 'local/no-statementless-catch': 'error' } }
  //
  // Later blocks win, so a narrow error block always beats the package's warn.
  // Move the numbers above down as you go — they are the backlog.
  'local/no-statementless-catch': 'warn',

  // KEPT ALONGSIDE, not superseded. The local rule looks only at catch clauses
  // and rejection handlers; `no-empty` still covers empty `if` / `for` / `while`
  // / bare blocks, and is the only rule here that sees them. Its catch coverage
  // is now redundant (and was never sufficient — see above), so expect the two to
  // double-report a comment-free `catch {}` — currently exactly one site,
  // agentcore-pi/config-map-test.mjs:62. That overlap is cheap and deliberate:
  // setting allowEmptyCatch back to true would silence the local rule's only
  // duplicate at the price of making `no-empty` the rule people read for catch
  // blocks, and its message says nothing about logging or classifying.
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
    plugins: { n, local },
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
    plugins: { n, local },
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
    plugins: { n, local },
    rules: bugRules,
  },
  {
    files: ['clawdbot/agentcore-pi/**/*.cjs', 'clawdbot/config-resolver/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    plugins: { n, local },
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
    plugins: { n, local },
    rules: bugRules,
  },
  {
    files: ['clawdbot/agentcore-tests/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    plugins: { n, local },
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
    plugins: { n, local },
    rules: bugRules,
  },

  // ── RATCHET ──────────────────────────────────────────────────────────────
  // Packages already at zero silent catches are pinned there at `error`. The rule stays `warn`
  // tree-wide so the 126-item backlog stays visible without blocking; these two are the part that
  // can no longer regress.
  //
  // config-resolver is the one that carries weight: it is IN the agent image's lint stage
  // (`npx eslint clawdbot/agentcore-pi clawdbot/config-resolver`), so a new silent catch there now
  // fails the BUILD, not just a report someone has to read. agentcore-observability is hand-run
  // tooling outside both Dockerfile lint stages, so pinning it is a report-time guard only.
  //
  // Move a package here the moment it reaches zero — that is the whole ratchet. Do NOT add one that
  // still has sites "to fix later"; a failing gate gets disabled, and then it protects nothing.
  {
    files: ['clawdbot/config-resolver/**/*.{mjs,cjs}', 'clawdbot/agentcore-observability/**/*.{js,cjs}'],
    rules: { 'local/no-statementless-catch': 'error' },
  },
];

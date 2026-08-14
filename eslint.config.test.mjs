// Unit test for the one LOCAL rule in eslint.config.mjs (local/no-statementless-catch).
//
//   node --test eslint.config.test.mjs        # or: npm test, from docker/
//
// Everything else in that config is upstream rules with their own test suites; this
// covers only the code we wrote. The rule is the instrument behind the
// SWALLOWED-ERRORS-PLAN.md §8(d) ratchet, so its predicate needs to be pinned: the
// whole point is that it reports where `no-empty` does not — comment-only bodies —
// and the day it silently stops doing that, the backlog count goes green for the
// wrong reason. The `valid` cases below are the boundary that keeps it honest.

import { describe, it } from 'node:test';
import { RuleTester } from 'eslint';
import { noStatementlessCatch } from './eslint.config.mjs';

// RuleTester falls back to an inline runner when these are unset; wiring node:test in
// gives per-case names in the output instead of one opaque pass/fail.
RuleTester.describe = describe;
RuleTester.it = it;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
});

ruleTester.run('no-statementless-catch', noStatementlessCatch, {
  valid: [
    // The remediation shape the plan asks for (§2a: LOGS). One statement is enough —
    // this rule measures presence, not quality.
    'try { risky(); } catch (e) { log.warn({ err: e.message }, "read failed"); }',
    // §2b: CLASSIFIES — rethrow anything but the expected class.
    'try { risky(); } catch (e) { if (e.code !== "ENOENT") throw e; }',
    // A comment ALONGSIDE a statement is fine; it is a statement-count rule, not a
    // comment rule.
    'function f() { try { risky(); } catch (e) { /* absent is normal */ return null; } }',
    // catch { return null } passes deliberately — a written-down fallback value is
    // out of the §8 population, and pretending otherwise would make the meter lie.
    'function f() { try { risky(); } catch { return null; } }',
    // Non-catch empty blocks belong to `no-empty`, which stays enabled. This rule
    // must not double-report them.
    'if (x) {}',
    'for (;;) {}',
    'function noop() {}',
    'const f = () => {};',
    // An empty function that is not a rejection handler.
    'p.then(() => {});',
    'arr.forEach(() => {});',
    'emitter.on("close", () => {});',
    // .catch with a handler that does something.
    'p.catch((e) => log.warn(e));',
    'p.catch(function (e) { report(e); });',
    // Expression-bodied arrow: a value, not an absence. Excluded on purpose.
    'p.catch(() => null);',
    // A member named `catch` that is not a promise method still needs an empty
    // function to report; a non-function argument must not.
    'p.catch(handleIt);',
    // .then's FIRST argument being empty is not a swallowed error.
    'p.then(() => {}, (e) => log.warn(e));',
  ],
  invalid: [
    // The shape `no-empty` also catches. Cheapest to write, hardest to spot.
    {
      code: 'try { risky(); } catch {}',
      errors: [{ messageId: 'emptyCatchClause' }],
    },
    {
      code: 'try { risky(); } catch (e) {}',
      errors: [{ messageId: 'emptyCatchClause' }],
    },
    // THE CASE THAT JUSTIFIES THE RULE. `no-empty` reports NEITHER of these two,
    // and this is the shape ~all of the backlog is written in.
    {
      code: 'try { risky(); } catch (e) { /* x */ }',
      errors: [{ messageId: 'emptyCatchClause' }],
    },
    {
      code: 'try { risky(); } catch (e) {\n  // telemetry must never break a turn\n}',
      errors: [{ messageId: 'emptyCatchClause' }],
    },
    // Nested: the inner catch is reported independently of the outer.
    {
      code: 'try { a(); } catch (e) { try { b(); } catch {} }',
      errors: [{ messageId: 'emptyCatchClause' }],
    },
    // The §8(b) teardown family — invisible to a CatchClause-only predicate, and 55
    // of the 137 measured sites.
    {
      code: 'deleteThing().catch(() => {});',
      errors: [{ messageId: 'emptyRejectionHandler' }],
    },
    {
      code: 'deleteThing().catch(function () { /* best effort */ });',
      errors: [{ messageId: 'emptyRejectionHandler' }],
    },
    {
      code: 'deleteThing().catch(async () => {});',
      errors: [{ messageId: 'emptyRejectionHandler' }],
    },
    {
      code: 'deleteThing().catch((err) => {\n  // peer gone\n});',
      errors: [{ messageId: 'emptyRejectionHandler' }],
    },
    {
      code: 'p.then(ok, () => {});',
      errors: [{ messageId: 'emptyRejectionHandler' }],
    },
    // Both forms in one file report separately.
    {
      code: 'try { a(); } catch {}\nb().catch(() => {});',
      errors: [{ messageId: 'emptyCatchClause' }, { messageId: 'emptyRejectionHandler' }],
    },
  ],
});

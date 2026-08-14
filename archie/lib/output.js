'use strict';

// Output conventions — RUNTIME-CLI-REFERENCE.md §1.4.
//
// THE RULE: stdout carries the answer and only the answer. Everything else — progress, per-agent
// lines, warnings, the dry-run banner, error detail — goes to stderr, and is NEVER suppressed by
// --json. That split is what makes `archie <anything> --json | jq` work from any command without
// the caller knowing which command they ran.
//
// Precedent in this repo: spec-baseline.mjs writes its report to stdout and every diagnostic line to
// stderr (spec-baseline.mjs:118-145), which is why it can be piped and read at the same time.

const { EXIT, exitName } = require('./exit');

/**
 * @param opts.json       one JSON document on stdout, nothing else
 * @param opts.verbosity  0 = summary + failures · 1 = -v · 2 = -vv (bodies, redacted)
 * @param opts.dryRun     prefixes every would-be write with `[dry-run] `
 * @param opts.streams    injectable for tests
 * @param opts.now        injectable clock — the envelope carries timings
 */
function createOutput({ json = false, verbosity = 0, dryRun = false, streams = process, now = Date.now } = {}) {
  const startedAt = now();
  const failures = [];
  let result = null;

  const err = (s) => streams.stderr.write(`${s}\n`);

  return {
    startedAt,

    /**
     * The answer. In --json mode this is BUFFERED, not printed: the envelope is emitted once at
     * finish(), because a command that streamed partial JSON and then failed would produce a
     * document no parser can read.
     */
    answer(value) {
      if (json) { result = value; return; }
      if (typeof value === 'string') streams.stdout.write(`${value}\n`);
      else streams.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },

    /** Progress. Always stderr, always shown. */
    progress(line) { err(dryRun ? `[dry-run] ${line}` : line); },

    /** Shown only at -v or higher. Per-agent step timings, AWS call latencies, remote stdout. */
    verbose(line, level = 1) { if (verbosity >= level) err(line); },

    warn(line) { err(`WARNING: ${line}`); },

    /**
     * Record a per-unit failure WITHOUT aborting. `failures[]` always names which agents failed —
     * "a single bad agent and a bad image look identical from an exit code alone" (plan §7).
     */
    failure({ agent = null, step = null, error = null } = {}) {
      failures.push({ agent, step, error: error ? String(error.message || error) : null });
    },

    failureCount() { return failures.length; },

    /**
     * Terminal error report. Preserves the cause chain: an AWS exception name and request id, or a
     * subprocess's captured stderr, are the only things that distinguish "wrong region" from
     * "unpublished image" (agent-image.js:52-56).
     */
    error(e) {
      err(`ERROR: ${e.message}`);
      if (e.detail) err(`       ${e.detail}`);
      const cause = e.cause;
      if (cause) {
        const name = cause.name || cause.Code || cause.code;
        const reqId = cause.$metadata && cause.$metadata.requestId;
        if (name) err(`       cause: ${name}${reqId ? ` (request ${reqId})` : ''}`);
        if (cause.message && cause.message !== e.message) err(`       ${cause.message}`);
        if (verbosity >= 1 && cause.stderr) err(String(cause.stderr).trimEnd());
      }
    },

    /**
     * Emit the envelope (json mode) and return the final exit code. Shape is identical across every
     * command so a caller can branch on `.ok`/`.exit` without special-casing.
     */
    finish({ command, code = EXIT.OK, context = {} } = {}) {
      if (!json) return code;
      streams.stdout.write(`${JSON.stringify({
        command,
        ok: code === EXIT.OK,
        exit: code,
        exitName: exitName(code),
        name: context.name || null,
        region: context.region || null,
        account: context.account || null,
        dryRun,
        startedAt: new Date(startedAt).toISOString(),
        durationMs: now() - startedAt,
        result,
        failures,
      }, null, 2)}\n`);
      return code;
    },
  };
}

module.exports = { createOutput };

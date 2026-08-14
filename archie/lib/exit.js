'use strict';

// Exit codes — the CLI's most-read output.
//
// These are a contract, not an implementation detail. An operator reading a failed CI job or a
// terminal at 2am gets the exit code before they get anything else, so each one has to mean exactly
// one thing and mean it everywhere. RUNTIME-CLI-REFERENCE.md §1.5 is the published table; this file
// is its single source.
//
// THE PAIR THAT MATTERS: 4 means stop, 6 means go again.
//   4 (TAINTED) — a healthcheck failed, the generation can never ship, re-running is wasted time.
//   6 (PARTIAL) — stragglers, nothing tainted, re-running is the DESIGNED response.
// Conflating those two is the difference between fixing an image and burning an hour re-running a
// generation that is already dead.

const EXIT = {
  OK: 0,
  FAILED: 1,
  USAGE: 2,
  PREFLIGHT: 3,
  TAINTED: 4,
  REFUSED: 5,
  PARTIAL: 6,
  DRIFT: 7,
  HEADROOM: 8,
  TIMEOUT: 124,
};

const NAMES = Object.fromEntries(Object.entries(EXIT).map(([k, v]) => [v, k]));

/** Human name for a code, for the JSON envelope and the summary line. */
function exitName(code) {
  return NAMES[code] || 'UNKNOWN';
}

/**
 * An error that carries its own exit code.
 *
 * `cause` is preserved deliberately. `execFileSync`'s `e.message` line 1 is always the useless one,
 * and discarding a subprocess's stderr "is what made a region mismatch look identical to an
 * unpublished image" (agent-image.js:52-56) — so the underlying AWS exception name, request id and
 * captured stderr ride along and are surfaced by output.error().
 */
class CliError extends Error {
  constructor(message, { code = EXIT.FAILED, cause = null, detail = null } = {}) {
    super(message);
    this.name = 'CliError';
    this.exitCode = code;
    if (cause) this.cause = cause;
    this.detail = detail;
  }
}

/** Convenience constructors, so call sites read as the rail they are enforcing. */
const usage = (m, o) => new CliError(m, { ...o, code: EXIT.USAGE });
const preflight = (m, o) => new CliError(m, { ...o, code: EXIT.PREFLIGHT });
const tainted = (m, o) => new CliError(m, { ...o, code: EXIT.TAINTED });
const refused = (m, o) => new CliError(m, { ...o, code: EXIT.REFUSED });
const partial = (m, o) => new CliError(m, { ...o, code: EXIT.PARTIAL });
const drift = (m, o) => new CliError(m, { ...o, code: EXIT.DRIFT });
const headroom = (m, o) => new CliError(m, { ...o, code: EXIT.HEADROOM });
const timeout = (m, o) => new CliError(m, { ...o, code: EXIT.TIMEOUT });

module.exports = {
  EXIT, exitName, CliError,
  usage, preflight, tainted, refused, partial, drift, headroom, timeout,
};

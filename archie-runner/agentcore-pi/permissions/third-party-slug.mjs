// What a third-party app tool call is ACTUALLY doing — the inner action slug, for telemetry.
//
// WHY THIS EXISTS. A connector platform typically surfaces a handful of GENERIC tools covering all
// of an agent's connected apps (search-tools, multi-execute, …), so the real action travels as an
// ARGUMENT rather than as the tool name. Without this, every action an agent takes through such a
// platform — read a calendar, send an email, write a document — is indistinguishable in telemetry:
// you can see that the agent called the connector, not what it did.
//
// PII BOUNDARY, and it is the whole design constraint. The slug is an ACTION IDENTIFIER; the
// arguments beside it hold recipients, subjects and bodies. This module therefore reads the slug
// field and NOTHING else — it never returns, logs or copies `arguments`. The sanitiser below is what
// makes that a guarantee rather than an intention: the slug is written by the MODEL, so it is
// untrusted input that could carry anything. Only `[A-Z0-9_]{1,64}` tokens survive; anything else is
// dropped silently. A dropped slug costs a line of telemetry detail, a leaked one costs PII in your
// log aggregator.
//
// CANONICAL CASE IS UPPERCASE. Connector APIs and their wire formats often disagree on case, so
// rather than trust either boundary `clean()` normalises — note it uppercases BEFORE testing
// SLUG_RE, so `[A-Z0-9_]` is a post-normalisation assertion and not a filter that would silently
// drop every lower-case slug. Any slug allow/deny list must be written uppercase and compared
// after `clean()`.
//
// OPEN-SOURCE BUILD: the vendor-specific half — the exact generic tool names, the argument shapes
// each version nests the slug under, and the per-version quirks — is not included. The sanitiser,
// the bounds and the PII guarantee are real. Add your own platform's shapes to `extract()`.

const CONNECTOR = 'demo_connector';
const MULTI_TOOL_NAME = `${CONNECTOR.toUpperCase()}__MULTI_EXECUTE_TOOL`;
const TOOL_PREFIX = `${CONNECTOR}__`;

// Bounds. A batched multi-execute is legitimately several calls; hundreds means something is wrong
// and the log line should not carry it either way.
const MAX_SLUGS = 8;
const SLUG_RE = /^[A-Z0-9_]{1,64}$/;

/** The sanitiser IS the PII guarantee — see the note above. */
function clean(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase();
  return SLUG_RE.test(s) ? s : null;
}

/**
 * Pull action slugs out of a tool call's arguments.
 *
 * Only the shapes below are recognised. A real connector platform nests the slug differently per
 * version and per tool; those shapes are deployment-specific and are not part of this build, so
 * extend here rather than reaching into `args` anywhere else — that is what keeps the PII boundary
 * in one reviewable place.
 */
function extract(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  const push = (v) => { const c = clean(v); if (c && !out.includes(c)) out.push(c); };

  push(args.tool_slug);
  push(args.toolSlug);
  push(args.action);

  // Batched form: a list of calls, each naming its own action.
  const batch = args.tool_calls || args.toolCalls || args.items;
  if (Array.isArray(batch)) {
    for (const item of batch.slice(0, MAX_SLUGS * 2)) {
      if (item && typeof item === 'object') { push(item.tool_slug); push(item.toolSlug); push(item.action); }
    }
  }
  return out.slice(0, MAX_SLUGS);
}

/**
 * The telemetry field: the action slugs a tool call performs, or `[]` when the call is not a
 * third-party app call at all. Never returns anything derived from the arguments themselves.
 */
export function toolSlugField(toolName, args) {
  const n = String(toolName ?? '');
  const isThirdParty = n.toUpperCase() === MULTI_TOOL_NAME || n.toLowerCase().startsWith(TOOL_PREFIX);
  return isThirdParty ? extract(args) : [];
}

export { clean, extract, MAX_SLUGS, SLUG_RE, MULTI_TOOL_NAME, CONNECTOR };

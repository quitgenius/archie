'use strict';

// The deploy-time gates on the policy sources (archie-policy-implementation-plan.md §3).
//
// EVERY ONE OF THESE GUARDS A SILENT FAILURE, which is what makes them worth the code. Cedar is
// default-deny and fails closed, so almost every mistake in these sources produces a policy that denies
// quietly rather than one that errors: a typo'd capability is a condition that never matches, a typo'd
// group is a group nobody is in, a dangling `ScopeGroup` reference still ALLOWS (spike README §5). None
// of that is visible from reading the file, and none of it fails a deploy on its own.
//
// The checks are numbered as the plan numbers them so the two stay legible together. 5 (account) lives in
// cmd/policy.js, because it selects the sources rather than validating them; 6 (materialise) is
// policy-publish.plan().

const { policySetFor, verdictsFor } = require('./policy-row');
const { capabilityDomain, capGroupNames, scopeGroupNames } = require('./policy-entities');
const { realKeys } = require('./policy-sources');

/** A finding. `fatal` decides whether the deploy stops; the message must say what to DO. */
const finding = (check, message, { fatal = true, detail = null } = {}) => ({ check, message, fatal, detail });

/**
 * CHECK 1 — the policy parses and validates against the schema, with zero errors.
 *
 * THE ONLY CHECK THAT TURNS A TYPO INTO A BUILD ERROR. Measured in the spike (README §5): with a `String`
 * context attribute a misspelled capability yields 0 validation errors and simply never matches — a
 * statement that looks right, reads right, and does nothing. Enumerated entity types are what make the
 * same typo a validation error, and this is what reads that error.
 *
 * `validate` warnings are NOT fatal: cedar emits them for things like an impossible policy, which is
 * worth surfacing but is not always wrong (a group that is legitimately empty today).
 */
function checkValidates(sources, cedar = require('@cedar-policy/cedar-wasm/nodejs')) {
  const out = [];
  const parsed = cedar.checkParsePolicySet(policySetFor(sources));
  if (parsed.type !== 'success') {
    return [finding(1, 'the policy does not parse', { detail: JSON.stringify(parsed.errors || parsed) })];
  }
  // The schema is passed as a BARE STRING. cedar-wasm types it `Schema = string | SchemaJson`, so the
  // string branch IS the human (.cedarschema) format — wrapping it as `{human: …}` makes it take the
  // JSON branch and fail with "failed to parse schema from JSON: invalid type: string", which reads like
  // a broken schema rather than a wrong call. Measured against 4.12.0: bare string → 0 errors, 0 warnings
  // for this file.
  const res = cedar.validate({
    validationSettings: { mode: 'strict' },
    schema: sources.schema,
    policies: policySetFor(sources),
  });
  if (res.type !== 'success') {
    return [finding(1, 'the schema itself does not parse', { detail: JSON.stringify(res.errors || res) })];
  }
  for (const e of res.validationErrors || []) {
    out.push(finding(1, `validation error: ${e.error?.message || JSON.stringify(e.error)}`, {
      detail: `policy ${e.policyId || '?'} — an unrecognised capability or entity type here is a statement `
        + 'that can never match, not a runtime error.',
    }));
  }
  for (const w of res.validationWarnings || []) {
    out.push(finding(1, `validation warning: ${w.warning?.message || JSON.stringify(w.warning)}`, {
      fatal: false, detail: `policy ${w.policyId || '?'}`,
    }));
  }
  return out;
}

/**
 * CHECK 2 — every capability the runtime can name has an entity in the policy.
 *
 * A capability with NO entity is the asymmetric failure: it denies silently through the grant-row permit
 * (closed, safe) but a `forbid` written for it would never fire (OPEN). So the direction that looks safe
 * hides the direction that is not, and only an explicit set comparison sees it.
 *
 * The runtime's universe is three sources unioned: CAPABILITY_DEFAULTS (baseline), every value in
 * ALSO_ALLOW_CAP (the config→capability projection), and the declared comms slugs. `caps` is injected so
 * this stays testable without loading the ESM runtime modules.
 */
function checkCompleteness(sources, caps) {
  const declared = new Set(capabilityDomain(sources));
  const runtime = new Set([
    // '*' is CAPABILITY_DEFAULTS' fallthrough entry, not a capability — including it would demand an
    // entity for it and make this check permanently red.
    ...Object.keys(caps.CAPABILITY_DEFAULTS).filter((c) => c !== '*'),
    // '' means "this token maps to no capability" (e.g. slack-reply-plugin) — not a capability either.
    ...Object.values(caps.ALSO_ALLOW_CAP).filter(Boolean),
    ...(caps.mcpCapabilities || []),
    ...(caps.hookOnly || []),
    ...(caps.slugs || []),
  ]);
  const out = [];
  for (const cap of [...runtime].sort()) {
    if (!declared.has(cap)) {
      out.push(finding(2, `capability '${cap}' has no entity in the policy`, {
        detail: 'it denies silently today, and a forbid written for it would never fire. Add it to '
          + 'semantics.json capabilities.',
      }));
    }
  }
  // The reverse is a WARNING, not an error: a capability declared ahead of the code that names it is a
  // legitimate way to stage a change, and the closure invariant does not forbid it.
  if (caps.mcpPartial) {
    // Do not conclude "dead" from evidence known to be incomplete: without items/ the MCP-prefix
    // capabilities are invisible and every one of them would be reported.
    out.push(finding(2, 'declared-but-unnamed not checked — items/ absent, so MCP-prefix capabilities cannot be seen', {
      fatal: false, detail: 'run `archie config hydrate` then extract.mjs to populate items/.',
    }));
    return out;
  }
  for (const cap of [...declared].sort()) {
    if (!runtime.has(cap)) {
      out.push(finding(2, `capability '${cap}' is declared in the policy but nothing in the runtime names it`, {
        fatal: false, detail: 'dead declaration, or a capability staged ahead of its code.',
      }));
    }
  }
  return out;
}

/**
 * CHECK 3 — the bindings and the semantics agree, in BOTH directions.
 *
 * Fail-closed is safe but silent, and this is the case where that bites hardest: a typo in EITHER copy
 * produces a group nobody is in, which denies the capability to everyone — including the holder it was
 * written for — while both files still read correctly. One direction catches the typo in the pins, the
 * other catches it in the semantics and flags groups nothing references.
 */
function checkBindings(sources, cedar = require('@cedar-policy/cedar-wasm/nodejs')) {
  const out = [];
  const inPins = new Set(scopeGroupNames(sources));

  // SCANNED FROM THE PARSED STATEMENTS, NOT THE SOURCE TEXT — and that distinction is not pedantry, it
  // was a false positive on the first run. semantics.cedar's prose documents a `policy-managed` mirror
  // that was deliberately NOT written ("Available but with no members, so omitted rather than written as
  // a no-op"), so a regex over the raw file reported a dangling group for a statement that does not
  // exist. Comments in this file describe rejected designs on purpose; a check that cannot tell prose
  // from policy would punish that.
  //
  // policySetTextToParts returns the statements comment-free (26 for this file), which is exactly the
  // question being asked: does any STATEMENT name a group the pins do not define?
  const parsed = cedar.policySetTextToParts(String(sources.semantics));
  if (parsed.type !== 'success') {
    // Check 1 reports the parse failure with detail; do not duplicate it, but do not scan text as a
    // fallback either — that reintroduces the comment bug precisely when the file is malformed.
    return [finding(3, 'bindings not checked — the policy does not parse (see check 1)', { fatal: false })];
  }
  const statements = Array.isArray(parsed.policies) ? parsed.policies : Object.values(parsed.policies || {});
  const referenced = new Set();
  for (const st of statements) {
    const text = typeof st === 'string' ? st : JSON.stringify(st);
    for (const m of text.matchAll(/ScopeGroup::\\?"([^"\\]+)/g)) referenced.add(m[1]);
  }

  for (const g of [...referenced].sort()) {
    if (!inPins.has(g)) {
      out.push(finding(3, `semantics.cedar references ScopeGroup "${g}" which pins.${sources.env}.json does not define`, {
        detail: 'a dangling group reference still ALLOWS for a scope whose parents name it (spike §5) and '
          + 'denies everyone else — it does not fail loudly. Define the group or fix the reference.',
      }));
    }
  }
  for (const g of [...inPins].sort()) {
    if (!referenced.has(g)) {
      out.push(finding(3, `pins.${sources.env}.json defines "${g}" but no statement references it`, {
        detail: 'a dead group: its members hold nothing. Either a typo in the semantics, or a pin that was '
          + 'removed from the policy without removing its bindings.',
      }));
    }
  }
  return out;
}

/**
 * CHECK 4 — every group member is a scope this environment actually has.
 *
 * UPGRADED FROM SHAPE TO MEMBERSHIP (§2.1), because shape cannot catch the bug that was live in
 * pins.prod.json until 2026-08-18: two well-formed SANDBOX scope ids (`ch-c66pp782t9k`,
 * `dm-ux0mz5ckp2r`) that do not exist on prod, where sandbox's scope is `dm-uj4igi7xe`. Both pass any
 * regex for a scope id. Publishing them would have silently revoked his cloudwatch-logs.
 *
 * Shape is still checked, because it catches a different and easier mistake — an AGENT NAME instead of a
 * scope id, which is valid JSON, plausible, and denies every intended holder.
 *
 * `knownScopes` null means "cannot enumerate": the shape half still runs and the membership half reports
 * a non-fatal note. Skipping silently would let the check pass vacuously, which is how it would come to
 * be trusted while doing nothing.
 */
const SCOPE_ID = /^(dm|ch)-[a-z0-9-]+$/;

function checkMembership(sources, knownScopes) {
  const out = [];
  const known = knownScopes ? new Set(knownScopes) : null;
  for (const g of scopeGroupNames(sources)) {
    for (const member of sources.pins.groups[g] || []) {
      if (!SCOPE_ID.test(member)) {
        out.push(finding(4, `${g} member '${member}' is not a scope id`, {
          detail: 'expected dm-<slackUserId> or ch-<slackChannelId>, lowercased — an agent NAME here is '
            + 'valid JSON and denies every intended holder.',
        }));
        continue;
      }
      if (known && !known.has(member)) {
        out.push(finding(4, `${g} member '${member}' is not a scope in this environment`, {
          detail: `well-formed but unknown — the pins.prod.json failure mode. This environment has `
            + `${known.size} scope(s); publishing an id from another one silently revokes nothing and `
            + 'grants nothing, while reading correctly.',
        }));
      }
    }
  }
  if (!known) {
    out.push(finding(4, 'membership not validated — no scope list available', { fatal: false }));
  }
  return out;
}

// The capabilities that are not merely baseline but UNREMOVABLE — sandbox, 2026-08-18: "make that baseline
// allow across all agents with no way to get rid of it". Recorded in semantics.json's
// capGroups.baseline.$immutable, and read from there rather than duplicated, so the policy file stays the
// declaration.
const immutableCaps = (sources) => {
  const g = requireCapGroups(sources).baseline || {};
  // The list lives in `$immutable` as PROSE (it explains the rule at length), so the capability names are
  // extracted from the members it names rather than parsed out of the sentences: a capability is immutable
  // iff the prose names it AND it is a baseline member. That keeps the machine-readable half honest without
  // asking a comment to be structured data.
  const prose = (g.$immutable || []).join(' ');
  return (g.members || []).filter((c) => prose.includes(c));
};

const requireCapGroups = (sources) => {
  const data = sources && sources.data;
  if (!data || !data.capGroups) throw new Error('policy checks: semantics.json capGroups missing');
  return data.capGroups;
};

/**
 * CHECK 8 — Cedar OWNS the "generally available" set, and the JS map may not disagree with it.
 *
 * `CAPABILITY_DEFAULTS` (agentcore-pi/permissions/capabilities.mjs) and `capGroups.baseline` are the same
 * fact written twice, and semantics.json says which one is meant to be authoritative: "Cedar is intended
 * to become the single declaration of this set, with the JS map derived from it."
 *
 * NOT BY CODEGEN, deliberately. Generating the JS from the JSON would make the policy file the literal
 * source, but it would also put a generated module inside the image — and capabilities.mjs must stay
 * import-free because the DISPATCHER loads it (grants.js:150), so a generated file adds a build step whose
 * staleness is a new silent failure mode. Ownership is enforced by REFUSAL instead: the map stays
 * hand-written, and a deploy where the two disagree does not happen. That gives the same guarantee — the
 * two cannot drift — without a build artifact to go stale.
 *
 * Three rules, and the third is the one that matters most because Cedar cannot express it:
 *   a. the sets are equal, both directions
 *   b. every immutable capability is a baseline member
 *   c. NO `forbid` names an immutable capability, directly or through a CapGroup it belongs to
 *
 * (c) exists because `forbid` beats every `permit`. So a future forbid naming `hindsight.read` would
 * override even an unconditional permit for it, and "unremovable" would quietly stop being true — with no
 * validation error, because the policy would be perfectly well-formed. semantics.json states this
 * plainly: "That property cannot be written as a Cedar statement… Immutability is therefore a BUILD-TIME
 * RULE the deploy must enforce." This is that enforcement.
 */
function checkBaseline(sources, caps, cedar = require('@cedar-policy/cedar-wasm/nodejs')) {
  const out = [];
  const groups = requireCapGroups(sources);
  const declared = new Set((groups.baseline && groups.baseline.members) || []);
  const inCode = new Set(
    Object.entries(caps.CAPABILITY_DEFAULTS).filter(([k, v]) => k !== '*' && v === 'allow').map(([k]) => k),
  );

  // THE STALENESS CHECK, which is what makes the set comparison below almost — but not entirely —
  // tautological now that CAPABILITY_DEFAULTS is GENERATED from `declared`. It is not fully redundant: the
  // generated file is committed, so a stale copy on disk would satisfy the comparison while disagreeing
  // with the policy this deploy is about to publish. Run FIRST so the message names the actual fix.
  try {
    require('./policy-codegen').assertGenerated({ env: sources.env, dir: sources.dir });
  } catch (e) {
    out.push(finding(8, e.message, {
      detail: 'the runtime\'s baseline set is generated from this policy; a stale copy means the fleet '
        + 'enforces a different set from the one this release publishes.',
    }));
  }

  for (const cap of [...declared].sort()) {
    if (!inCode.has(cap)) {
      out.push(finding(8, `'${cap}' is baseline in the policy but NOT allow in CAPABILITY_DEFAULTS`, {
        detail: 'the policy is the declaration — either add it to CAPABILITY_DEFAULTS or remove it from '
          + 'capGroups.baseline. Left alone, the runtime denies a capability the policy calls generally '
          + 'available.',
      }));
    }
  }
  for (const cap of [...inCode].sort()) {
    if (!declared.has(cap)) {
      out.push(finding(8, `'${cap}' is allow in CAPABILITY_DEFAULTS but NOT baseline in the policy`, {
        detail: 'the more dangerous direction: every agent has it ambiently while the policy does not say '
          + 'so, and no pin or forbid written against it would describe the real behaviour.',
      }));
    }
  }

  const immutable = immutableCaps(sources);
  for (const cap of immutable) {
    if (!declared.has(cap) || !inCode.has(cap)) {
      out.push(finding(8, `'${cap}' is declared UNREMOVABLE but is not baseline on both sides`, {}));
    }
  }

  // (c) — walk the parsed statements for a forbid that reaches an immutable capability. Parsed, not raw
  // text, for the reason check 3 learned: prose in this file discusses statements that do not exist.
  const parsed = cedar.policySetTextToParts(String(sources.semantics));
  if (parsed.type !== 'success') {
    out.push(finding(8, 'immutability not checked — the policy does not parse (see check 1)', { fatal: false }));
    return out;
  }
  const statements = Array.isArray(parsed.policies) ? parsed.policies : Object.values(parsed.policies || {});
  // A capability is reachable from a forbid either by name or via any CapGroup that contains it.
  const groupsContaining = (cap) => Object.keys(groups)
    .filter((g) => !g.startsWith('$') && ((groups[g] && groups[g].members) || []).includes(cap));
  for (const st of statements) {
    const text = typeof st === 'string' ? st : JSON.stringify(st);
    if (!/^\s*forbid/.test(text.replace(/^["']|\\n/g, ''))) continue;
    for (const cap of immutable) {
      const named = text.includes(`Capability::"${cap}"`) || text.includes(`Capability::\\"${cap}\\"`);
      const viaGroup = groupsContaining(cap).some((g) => text.includes(`CapGroup::"${g}"`) || text.includes(`CapGroup::\\"${g}\\"`));
      if (named || viaGroup) {
        out.push(finding(8, `a forbid statement reaches '${cap}', which is declared UNREMOVABLE`, {
          detail: `${named ? 'named directly' : 'via a CapGroup it belongs to'}. forbid beats every permit, `
            + 'so this silently makes an unremovable capability removable — and the policy stays valid, so '
            + 'nothing else catches it.',
        }));
      }
    }
  }
  return out;
}

/**
 * CHECK 7 — does this policy change any DECISION, for any scope?
 *
 * The check that earns the engine. A policy diff is not a text diff: reordering statements, renaming a
 * group, or adding a `forbid` whose group already contains everyone are all textual changes with ZERO
 * decision changes, while a one-character edit to a group id can revoke a capability from every holder.
 * Only a materialised comparison tells those apart, and nothing but enumeration can produce it.
 *
 * @param rows      the rows about to be written
 * @param liveRows  {scope: row} as currently stored (missing scopes count as "no row")
 * @returns {{changes: Array, scopes: number}} — changes are (scope, capability, from, to)
 */
function diffDecisions(rows, liveRows) {
  const changes = [];
  for (const row of rows) {
    const live = liveRows[row.scope] || null;
    const caps = new Set([...Object.keys(row.verdicts), ...Object.keys(live?.verdicts || {})]);
    for (const cap of [...caps].sort()) {
      const from = live?.verdicts?.[cap] ?? null;   // null = no row / not overridden = pre-policy behaviour
      const to = row.verdicts[cap] ?? null;
      if (from !== to) changes.push({ scope: row.scope, capability: cap, from, to });
    }
  }
  return { changes, scopes: new Set(changes.map((c) => c.scope)).size };
}

/** Run 1–4 and return every finding, fatal first. 5 is in cmd/policy.js, 6 is policy-publish.plan(). */
function runSourceChecks(sources, { caps, knownScopes = null, cedar } = {}) {
  const out = [
    ...checkValidates(sources, cedar),
    ...(caps ? checkCompleteness(sources, caps) : [finding(2, 'completeness not checked — no capability universe supplied', { fatal: false })]),
    ...checkBindings(sources),
    ...checkMembership(sources, knownScopes),
    ...(caps ? checkBaseline(sources, caps, cedar) : [finding(8, 'baseline ownership not checked — no capability universe supplied', { fatal: false })]),
  ];
  return out.sort((a, b) => Number(b.fatal) - Number(a.fatal) || a.check - b.check);
}

/**
 * The runtime's capability universe, from the modules that define it. ESM, hence async.
 *
 * FOUR SOURCES, NOT TWO, and the first run of check 2 proved why: with only CAPABILITY_DEFAULTS and
 * ALSO_ALLOW_CAP, eleven capabilities the policy legitimately declares looked like dead declarations —
 * because they do not come from a token map at all.
 *
 *   CAPABILITY_DEFAULTS       the 7 baseline capabilities ('*' is the fallthrough, not a capability)
 *   ALSO_ALLOW_CAP            the alsoAllow token -> capability projection ('' means "no capability")
 *   MCP PREFIXES              demo_query_app, demo_warehouse, demo_notes_app, demo_mail_app, demo_diagram_app — these arrive as an
 *                             agent's connector.extraMcpServers[].toolPrefix through prefixToCapability
 *                             at RUNTIME, so no static map contains them. Read from semantics.json's own
 *                             declaration rather than re-derived from 218 agent files: the check asks
 *                             "does the policy declare everything the runtime can name", and a prefix
 *                             only exists because some agent config named it.
 *   hindsight.write           hook-only. It has no tool, no token and no prefix — the hindsight retain
 *                             gate names it directly (hindsight-extension.mjs) — so it appears in no
 *                             projection and must be added explicitly or it reads as dead.
 *
 * The comms `slugs` are passed separately (semantics.json declares them) because they are connector
 * ACTION ids, not capabilities in the runtime's sense; check 2 treats them as part of the declared
 * universe so a typo'd slug is still caught.
 */
async function capabilityUniverse(sources = null, { itemsDir = ITEMS_AGENTS } = {}) {
  const [{ CAPABILITY_DEFAULTS }, { ALSO_ALLOW_CAP, prefixToCapability }] = await Promise.all([
    import(`file://${require.resolve('../../archie-runner/agentcore-pi/permissions/capabilities.mjs')}`),
    import(`file://${require.resolve('../../archie-runner/config-resolver/caps-from-config.mjs')}`),
  ]);
  const data = sources?.data || {};
  // MCP prefixes are DERIVED from the agent configs, through the same prefixToCapability the runtime
  // uses — `demo_warehouse` maps to `demo_warehouse`, so the raw prefixes and the capabilities are not the same set (6
  // vs 5). Re-deriving rather than listing them keeps this true when an agent adds a server.
  const { prefixes, partial } = readMcpPrefixes(itemsDir);
  return {
    CAPABILITY_DEFAULTS,
    ALSO_ALLOW_CAP,
    mcpCapabilities: [...new Set(prefixes.map((p) => prefixToCapability(p)))].sort(),
    // Hook-only: named directly by the hindsight retain gate, so it is in no token map and has no tool.
    hookOnly: ['hindsight.write'],
    slugs: Array.isArray(data.slugs) ? data.slugs : realKeys(data.slugs || {}),
    // TRUE when items/ was unavailable, so the reverse half of check 2 must report itself as partial
    // rather than claiming a capability is dead on incomplete evidence.
    mcpPartial: partial,
  };
}

const ITEMS_AGENTS = require('node:path').join(__dirname, '..', '..', 'archie-runner', 'config-resolver', 'items', 'agents');

/**
 * Every `connector.extraMcpServers[].toolPrefix` across the fleet's agent configs.
 *
 * items/ is GITIGNORED (it is an extract of the live config), so a fresh checkout has none. That is not
 * an error — it means the reverse direction of check 2 cannot be complete, and it says so instead of
 * concluding that capabilities it cannot see are dead.
 */
function readMcpPrefixes(dir) {
  const fs = require('node:fs');
  if (!fs.existsSync(dir)) return { prefixes: [], partial: true };
  const prefixes = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const j = JSON.parse(fs.readFileSync(require('node:path').join(dir, f), 'utf8'));
      for (const m of j?.connector?.extraMcpServers || []) if (m.toolPrefix) prefixes.add(m.toolPrefix);
    } catch { /* a malformed agent file is the extractor's problem, not this check's */ }
  }
  return { prefixes: [...prefixes], partial: false };
}

module.exports = {
  checkValidates, checkCompleteness, checkBindings, checkMembership, checkBaseline, immutableCaps, diffDecisions,
  runSourceChecks, capabilityUniverse, verdictsFor, realKeys, capGroupNames,
};

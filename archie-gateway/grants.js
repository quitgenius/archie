// Capability grants: the read/write half of App Home's Tools tab.
//
// WHAT A GRANT IS. Enforcement is capability-level, not tool-level: each tool declares one
// `capability` (§8.6), the PEP allows a tool iff its capability is baseline-allow or present in this
// agent's grant (pi-adapter's per-turn readGrants), and the mapping is many-to-one — so granting
// `runtime` unlocks bash AND exec AND process AND sessions_spawn. The tab browses by tool because
// that is how people think, but every write here is a capability, and callers are responsible for
// showing the blast radius (toolCatalog()'s capabilities[cap].tools) before asking.
//
// WHERE IT LIVES. GRANT#<scopeId>/SCOPE#* — its own partition, keyed only ever through the schema's
// agentGrantKey. `SCOPE#*` is agent-wide; the runtime also unions SCOPE#<channel> if present, which
// nothing writes yet. Body is the §8.4 provenance map { <cap>: { sources: [...] } } serialised into a
// `data` attribute (DDB reserved word → always aliased #d).
//
// PROVENANCE IS THE POINT. A UI grant records `manual:<slackUserId>`, which does three jobs: it is
// the audit trail (IAM cannot scope this write per-viewer — see the WriteAgentGrants statement in
// modules/archie/iam.tf — so the row is where "who approved this" lives); it makes revocation
// precise (drop one author's source, keep a skill's); and caps-from-config's recompute preserves it,
// so a later skill install cannot silently undo it.
//
// UpdateItem only, never Put/Delete: the dispatcher task role holds UpdateItem and nothing else, and
// a field-level SET cannot lose an attribute a future writer adds to the same item.

// Dual-layout dynamic imports, exactly as marketplace.js/derived-role.js do it: the image flattens
// config-resolver/ to /app/config-resolver/, the repo has it as a sibling tree.
let _caps = null;
async function loadCaps() {
  if (_caps) return _caps;
  try {
    _caps = await import('./config-resolver/caps-from-config.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    _caps = await import('../archie-runner/config-resolver/caps-from-config.mjs');
  }
  return _caps;
}

// Skill pins (see config-resolver/skill-pins.mjs). Exported as `loadSkillPins` because the App Home
// install action in index.js needs it too, and the pin must read from ONE declaration — a pin enforced
// at the button but not at hydration is theatre, and vice versa.
let _pins = null;
async function loadSkillPins() {
  if (_pins) return _pins;
  try {
    _pins = await import('./config-resolver/skill-pins.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    _pins = await import('../archie-runner/config-resolver/skill-pins.mjs');
  }
  return _pins;
}

// R1: the capabilities the POLICY owns, so no writer here can hand out one a grant row cannot affect.
//
// Short TTL rather than a permanent cache, because a `policy publish` can make a capability
// policy-managed at any time and the UI must stop offering it without a dispatcher restart. 30s matches
// the artifact cache in agentcore-client for the same reason.
//
// FAIL-OPEN ON A READ ERROR, unlike almost everything else in this layer, and deliberately: an empty set
// means "nothing is policy-managed", which restores exactly today's behaviour. Failing closed here would
// mean a DynamoDB blip makes every capability un-grantable — an outage in the grant UI — while the actual
// enforcement (the PEP's forbid) is unaffected either way. The row would confer nothing regardless; this
// check exists to stop the UI LYING about it, not to enforce.
let _pinned = { set: new Set(), atMs: 0 };
const PINNED_TTL_MS = 30_000;
async function loadPinnedCaps(doc, table) {
  if (!doc || !table) return new Set();
  const now = Date.now();
  if (now - _pinned.atMs < PINNED_TTL_MS) return _pinned.set;
  try {
    const schema = await loadSchema();
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const r = await doc.send(new GetCommand({ TableName: table, Key: schema.fleetPolicyKey() }));
    const artifact = r?.Item?.data ? JSON.parse(r.Item.data) : null;
    const { pinnedCapabilities } = require('./policy-derive');
    _pinned = { set: pinnedCapabilities(artifact), atMs: now };
  } catch {
    _pinned = { set: new Set(), atMs: now };
  }
  return _pinned.set;
}

/**
 * The pinned skills this scope's POLICY row allows.
 *
 * NOT CACHED, unlike loadPinnedCaps: that reads one fleet-wide artifact, this reads a PER-SCOPE row, so a
 * cache would either be keyed per agent (unbounded) or wrong. It is one GetItem on a button press, not on
 * a turn.
 *
 * NULL when there is no row or the read fails, and pinAllows DENIES on null — the safe direction for a gate
 * that decides whether to create a NEW install. That is deliberately the opposite of the runtime filter,
 * which no-ops on a missing row because it decides what an existing holder KEEPS (plan D3).
 */
async function loadAllowedSkills(doc, table, agentId) {
  if (!doc || !table || !agentId) return null;
  try {
    const schema = await loadSchema();
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const r = await doc.send(new GetCommand({ TableName: table, Key: schema.agentPolicyKey(agentId) }));
    const row = r?.Item?.data ? JSON.parse(r.Item.data) : null;
    return Array.isArray(row?.skills) ? row.skills : null;
  } catch {
    return null;
  }
}

let _schema = null;
async function loadSchema() {
  if (_schema) return _schema;
  try {
    _schema = await import('./config-resolver/schema.mjs');
  } catch (e) {
    if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    _schema = await import('../archie-runner/config-resolver/schema.mjs');
  }
  return _schema;
}

// UI COPY for the capability rows — the sentence a human reads next to an Approve button. It lives
// HERE, in the dispatcher, because it is presentation: the agent tree owns what a capability IS,
// this owns how it is explained. `capabilityCatalogue()` throws if a capability arrives without one,
// so a new capability cannot reach the tab as a bare slug.
//
// Write these for the person clicking Approve, not for the model: the blast radius and the trust
// boundary, not the tool's mechanics.
const CAPABILITY_SUMMARY = {
  // baseline (default-allow — shown as already-granted, no approval to give)
  'fs.read': 'Read files in its own workspace.',
  memory: 'Search and read its own long-term memory notes.',
  cron: 'Schedule, list and cancel its own recurring turns.',
  otel: 'Read its OWN telemetry — turns, tool calls, traces, cron history, runtime health.',
  connector: 'Use the third-party apps connected on the Connected Apps tab (Gmail, Drive, Notion, …).',
  health: 'Report whether its own plugins loaded.',
  'hindsight.read': 'Recall facts from the read-only organisation knowledge bank.',
  'slack.send': 'Post Slack messages as Archie — used for cron jobs and cross-posting. Goes out under Archie\u2019s own bot identity, so it can only reach channels Archie is in, plus DMs with people who can DM Archie.',
  // grant-required (default-deny)
  'fs.write': 'WRITE and edit files in its own workspace. Irreversible within the workspace; cannot reach anything outside it.',
  runtime: 'Run arbitrary shell commands in its sandbox \u2014 the broadest grant here. Anything the sandbox can reach, it can do, including network calls with its own credentials.',
  spawn: 'Run work in a separate sub-session and use the answer. A sub-session is the same agent with the same files and permissions, so it reaches nothing new; it does more at once, and spends more tokens.',
  'otel.fleet': "Read EVERY agent's telemetry, and run arbitrary log queries. Crosses the boundary from self-observation to observing other people's agents.",
  'hindsight.write': 'WRITE durable facts into the knowledge bank, where other agents recall them.',
  'connector': 'Use the third-party apps connected on the Connected Apps tab.',
  // Deployment-specific capabilities are declared by the operator, not shipped here. Each one needs a
  // summary written for the person clicking Approve \u2014 the blast radius and the trust boundary,
  // not the tool's mechanics \u2014 because capabilityCatalogue() refuses a capability without one.
  'demo_query_app': 'EXAMPLE. Run read-only queries against a connected data source. Scope this to whatever it can actually reach before granting it.',
  'demo_warehouse': 'EXAMPLE. Run SQL against a connected data warehouse. May reach production data.',
  'sandbox-probe': 'TEST-ONLY probe used by the IAM harness. Never grant in prod.',
};

// The capability/tool view, built from the agent tree's own DECLARATIONS — no generated file, and no
// hand-written mirror of the same facts.
//
// This is only importable because the declarations are data: tool-declarations.mjs has zero imports,
// and provider-registry.mjs now reads it rather than tool-registry.mjs, so neither drags in the Pi
// harness (every tool module does `const T = piAi.Type` at module scope, and pi-runtime.mjs
// top-level-awaits the Pi packages). Async because they are ESM and this is CommonJS; cached, so the
// import happens once per process.
let _catalog = null;
async function toolCatalog() {
  if (_catalog) return _catalog;
  const load = async (inImage, inRepo) => {
    try {
      return await import(inImage);
    } catch (e) {
      if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e;
      return import(inRepo);
    }
  };
  // The in-image paths KEEP the agentcore-pi/ + permissions/ structure rather than flattening it,
  // because provider-registry.mjs imports `../tool-declarations.mjs` and `./capabilities.mjs`
  // relatively — flatten them into one directory and those specifiers resolve to nothing. (The agent
  // image can flatten permissions/ because it copies the whole tree; this one copies three files.)
  const decl = await load('./agentcore-pi/tool-declarations.mjs', '../archie-runner/agentcore-pi/tool-declarations.mjs');
  const caps = await load('./agentcore-pi/permissions/capabilities.mjs', '../archie-runner/agentcore-pi/permissions/capabilities.mjs');
  const reg = await load('./agentcore-pi/permissions/provider-registry.mjs', '../archie-runner/agentcore-pi/permissions/provider-registry.mjs');

  const registry = reg.buildProviderRegistry();
  const tools = {};
  for (const [name, capability] of Object.entries(decl.CORE_TOOLS)) {
    tools[name] = { capability, provider: 'core', kind: 'core' };
  }
  for (const [name, capability] of Object.entries(decl.CUSTOM_TOOLS)) {
    tools[name] = { capability, provider: reg.providerForCapability(registry, capability), kind: 'adapter' };
  }

  // Every capability with a static policy, plus any a static tool or a plugin declares. Per-agent MCP
  // prefixes (demo_query_app/demo_diagram_app/…) are absent by nature — they come from each agent's own
  // connector.extraMcpServers, so describeCapabilities() overlays them at render time.
  const capNames = new Set([
    ...Object.keys(caps.CAPABILITY_DEFAULTS).filter((c) => c !== '*'),
    ...Object.values(tools).map((t) => t.capability),
    ...Object.values(decl.PLUGIN_PROVIDERS).flatMap((p) => p.capabilities),
    // Capabilities that exist WITHOUT a tool — the reverted shell skills (see TOOLLESS_CAPABILITIES).
    // Without this the three sources above miss them entirely, because each one is keyed off a tool
    // or a plugin, and these are neither: the agent reaches AWS through bash and the skill's script.
    // They are also the most privileged capabilities in the fleet, so omitting them made the Tools
    // tab quietly silent about exactly what a reader most needs to see.
    ...(decl.TOOLLESS_CAPABILITIES || []),
  ]);
  const missing = [...capNames].filter((c) => !CAPABILITY_SUMMARY[c]).sort();
  if (missing.length) {
    throw new Error(`grants: capability with no human summary: ${missing.join(', ')} — add it to CAPABILITY_SUMMARY`);
  }

  const capabilities = {};
  for (const cap of [...capNames].sort()) {
    capabilities[cap] = {
      policy: caps.policyFor(cap),
      provider: reg.providerForCapability(registry, cap),
      summary: CAPABILITY_SUMMARY[cap],
      // The blast radius the tab must show: a grant is capability-level and the mapping is
      // many-to-one, so approving `bash` also brings exec/process/sessions_spawn.
      tools: Object.keys(tools).filter((t) => tools[t].capability === cap).sort(),
    };
  }
  _catalog = { capabilities, tools };
  return _catalog;
}

// The source token this module writes. One author namespace, and caps-from-config preserves anything
// that is not its own ('agent-base' / 'skill:*'), so this stays honest without a shared constant.
const manualSource = (userId) => `manual:${userId || 'unknown'}`;
const isManual = (src) => String(src).startsWith('manual:');

// A3: the derived-role reconciler, injected by index.js (agentCore.applyDerivedRoleGrantChange).
// Same injection shape marketplace.js uses, for the same reason — no import of agentcore-client.
let _derivedRoleHook = null;
function setDerivedRoleHook(fn) { _derivedRoleHook = fn; }

/**
 * Every capability this agent could be granted, with its provenance and current state — the whole
 * data model the Tools tab renders.
 *
 * `extraCaps` are the agent's PER-AGENT capabilities, which no repo file can know: each
 * connector.extraMcpServers[].toolPrefix IS a capability (demo_warehouse aliases to demo_warehouse), so they come from
 * AGENT#<id>/CONFIG at render time. Passing them in keeps this module free of a config read and lets
 * the caller reuse the CONFIG item it already fetched.
 *
 * @returns {{grantable: object, baseline: object}} keyed by capability:
 *   { policy, provider, summary, tools[], granted, sources[], manualSources[], derivedSources[] }
 */
async function describeCapabilities(grant, extraCaps = [], pinned = new Set()) {
  const catalog = await toolCatalog();
  const stored = (grant && typeof grant === 'object' && !Array.isArray(grant.capabilities)) ? grant : {};

  const describe = (cap, meta) => {
    const sources = (stored[cap] && Array.isArray(stored[cap].sources)) ? [...stored[cap].sources].sort() : [];
    return {
      capability: cap,
      policy: meta.policy,
      provider: meta.provider,
      summary: meta.summary,
      tools: meta.tools || [],
      // Baseline caps are ambient — allowed without ever being stored — so `granted` is not simply
      // "is it in the row".
      granted: meta.policy === 'allow' || sources.length > 0,
      sources,
      manualSources: sources.filter(isManual),
      derivedSources: sources.filter((s) => !isManual(s)),
    };
  };

  // THREE BUCKETS, NOT TWO (R1). `policyManaged` is the capabilities the Cedar policy owns: membership
  // allows, non-membership denies, and the forbid beats the grant-row permit — so a row confers NOTHING.
  //
  // With two buckets they landed in `grantable`, which rendered a working Approve button for a capability
  // no approval can confer. Pressing it wrote a row, logged success, fired the derived-role hook adding
  // real sts:AssumeRole IAM, and the PEP denied. The UI asserted access that did not exist while the IAM
  // exposure was real — so this split is what makes the tab honest, and assertGrantable below is what
  // makes the button refuse.
  const grantable = {};
  const baseline = {};
  const policyManaged = {};
  for (const [cap, meta] of Object.entries(catalog.capabilities)) {
    if (pinned.has(cap)) { policyManaged[cap] = describe(cap, meta); continue; }
    (meta.policy === 'allow' ? baseline : grantable)[cap] = describe(cap, meta);
  }

  // Per-agent MCP server capabilities. Default-deny like any unlisted capability ('*' → deny), and
  // their tools are resolved at runtime from the server, so there is no static tool list to show.
  for (const cap of extraCaps) {
    if (!cap || grantable[cap] || baseline[cap]) continue;
    grantable[cap] = describe(cap, {
      policy: 'deny',
      provider: 'mcp-auth',
      summary: `Query the "${cap}" MCP data server configured for this agent.`,
      tools: [],
    });
  }

  // Anything stored that neither the catalog nor the config explains. Surfaced rather than hidden: a
  // grant the UI cannot describe is still in force at the PEP, and silently omitting it would make
  // the tab claim an agent has less access than it does.
  for (const cap of Object.keys(stored)) {
    if (!grantable[cap] && !baseline[cap]) {
      grantable[cap] = describe(cap, {
        policy: 'deny',
        provider: null,
        summary: 'Granted, but not described by this build\'s tool catalogue — it may come from an older or newer image.',
        tools: [],
      });
    }
  }

  return { grantable, baseline, policyManaged };
}

async function _readGrantItem(doc, table, agentId) {
  const { GetCommand } = require('@aws-sdk/lib-dynamodb');
  const { agentGrantKey } = await loadSchema();
  const key = agentGrantKey(agentId, '*');
  const r = await doc.send(new GetCommand({ TableName: table, Key: key }));
  if (!r.Item || r.Item.data == null) return { key, present: false, grant: {} };
  // An unparseable grant is a FAILURE, not an empty grant: writing a recomputed row over it would
  // discard whatever it held. Throw and let the handler surface it.
  let grant;
  try {
    grant = JSON.parse(r.Item.data);
  } catch (e) {
    throw new Error(`GRANT#${agentId}/SCOPE#* is present but unparseable — refusing to overwrite it: ${e.message}`);
  }
  return { key, present: true, grant };
}

/** The stored grant plus its flat cap list. */
async function readGrant(doc, table, agentId) {
  const { grant, present } = await _readGrantItem(doc, table, agentId);
  const { grantedCaps } = await loadCaps();
  return { present, grant, caps: grantedCaps(grant) };
}

// Canonical serialisation — capabilities sorted, sources sorted — matching capsWithSources's
// "deterministic order (stable writes + tests)". Two writers share this row, and if they disagreed
// on key order every install/uninstall would rewrite it into a different byte string, making a real
// diff indistinguishable from a reordering when reading the item by hand.
const canonical = (grant) => {
  const out = {};
  for (const cap of Object.keys(grant).sort()) {
    const sources = (grant[cap] && Array.isArray(grant[cap].sources)) ? [...grant[cap].sources].sort() : [];
    out[cap] = { sources };
  }
  return out;
};

// Returns what was actually stored, so callers report the row's own state rather than their
// pre-canonical draft of it.
async function _writeGrant(doc, table, key, grant) {
  const { UpdateCommand } = require('@aws-sdk/lib-dynamodb');
  const written = canonical(grant);
  await doc.send(new UpdateCommand({
    TableName: table,
    Key: key,
    UpdateExpression: 'SET #d = :d',
    ExpressionAttributeNames: { '#d': 'data' },
    ExpressionAttributeValues: { ':d': JSON.stringify(written) },
  }));
  return written;
}

// The IAM half. Non-fatal by design, matching marketplace.js: the DynamoDB row is what the PEP reads
// and it is already committed, so a role-policy failure must not present as "the grant failed" —
// `archie grants apply` repairs exactly this drift.
async function _notifyDerivedRole(agentId, oldCaps, newCaps, log) {
  if (!_derivedRoleHook) return { applied: false, reason: 'unwired' };
  try {
    return (await _derivedRoleHook({ agentId, oldCaps, newCaps })) || { applied: true };
  } catch (e) {
    if (log && log.warn) log.warn({ err: e.message, agent: agentId }, 'derived-role hook failed after grant change (non-fatal)');
    return { applied: false, reason: e.message };
  }
}

/**
 * Validate a capability a viewer asked to change. Slack echoes button values straight back, so this
 * is untrusted input — the same reason cron-runner-flag parses its runner rather than trusting it.
 * Only grant-required capabilities are accepted: a baseline cap is already allowed everywhere, so
 * "granting" it would write a row that changes nothing and then read back as revocable.
 */
async function assertGrantable(cap, extraCaps = [], pinned = new Set()) {
  if (!cap || typeof cap !== 'string') throw new Error('grants: capability required');
  const { grantable, baseline, policyManaged } = await describeCapabilities({}, extraCaps, pinned);
  if (baseline[cap]) throw new Error(`grants: "${cap}" is allowed by default — there is nothing to grant`);
  // R1. THE CHEAPEST PLACE TO PUT THIS, because this throw already surfaces to the user: every write path
  // that matters funnels through here, and the message becomes the Slack error rather than a silent no-op.
  //
  // Refusing is not cosmetic. Without it the row is written, success is logged, the derived-role hook adds
  // real sts:AssumeRole IAM — and the PEP still denies, because the policy's forbid beats the grant-row
  // permit. So the alternative to this throw is not "the grant works", it is "the grant appears to work,
  // grants no access, and leaves IAM behind".
  if (policyManaged[cap]) {
    throw new Error(`grants: "${cap}" is managed by the Cedar policy, not by grants — approving it here `
      + 'would confer nothing. Add the scope to its pin group in pins.<env>.json and run `archie policy '
      + 'publish`.');
  }
  if (!grantable[cap]) throw new Error(`grants: "${cap}" is not a known capability for this agent`);
  return grantable[cap];
}

/**
 * Approve a capability for an agent, agent-wide (SCOPE#*).
 *
 * Live on the agent's NEXT TURN with no restart: pi-adapter re-reads grants per turn and mutates the
 * live grant Set in place, and the derived role's inline policy is rewritten in place (IAM evaluates
 * at request time). There is no runtime recreate and no warm-pool reset.
 *
 * @returns {{capability, caps, sources, alreadyGranted, role}}
 */
async function grantCapability(doc, table, agentId, cap, userId, { extraCaps = [], log } = {}) {
  const meta = await assertGrantable(cap, extraCaps, await loadPinnedCaps(doc, table));
  const { key, grant } = await _readGrantItem(doc, table, agentId);
  const { grantedCaps } = await loadCaps();
  const oldCaps = grantedCaps(grant);

  const next = { ...grant };
  const existingSources = (next[cap] && Array.isArray(next[cap].sources)) ? next[cap].sources : [];
  const src = manualSource(userId);
  const alreadyGranted = existingSources.length > 0;
  if (existingSources.includes(src)) {
    // Idempotent: the same person approving twice is not an error and must not duplicate a source.
    return { capability: cap, caps: oldCaps, sources: [...existingSources].sort(), alreadyGranted: true, role: null, tools: meta.tools };
  }
  next[cap] = { sources: [...existingSources, src] };

  const written = await _writeGrant(doc, table, key, next);
  const caps = grantedCaps(written);
  if (log && log.info) log.info({ agent: agentId, capability: cap, by: userId, caps }, 'capability granted');
  const role = await _notifyDerivedRole(agentId, oldCaps, caps, log);
  return { capability: cap, caps, sources: written[cap].sources, alreadyGranted, role, tools: meta.tools };
}

/**
 * Withdraw this UI's approval of a capability: removes EVERY manual: source, not only the caller's.
 *
 * Deliberately not a refusal when a skill or the agent's base config also contributes the cap. The
 * alternative — refuse and leave the manual source in place — sets a trap: uninstalling that skill
 * later would silently restore access through an approval the user believes they already withdrew.
 * So the source always goes, and `stillGranted`/`heldBy` tell the caller to say so plainly.
 *
 * @returns {{capability, caps, removed, stillGranted, heldBy, role}}
 */
async function revokeCapability(doc, table, agentId, cap, userId, { extraCaps = [], log } = {}) {
  // NO PINNED SET HERE, and the asymmetry with grantCapability is deliberate (R1). Granting a
  // policy-managed capability must refuse, because it promises access it cannot give. REVOKING one must
  // still work: a row written before the capability was pinned confers nothing but is still sitting in the
  // table, and refusing here would make those rows permanently un-deletable through the UI — visible,
  // inert, and unremovable. Revoke is cleanup, and cleanup of an inert row is always safe.
  await assertGrantable(cap, extraCaps);
  const { key, grant } = await _readGrantItem(doc, table, agentId);
  const { grantedCaps } = await loadCaps();
  const oldCaps = grantedCaps(grant);

  const sources = (grant[cap] && Array.isArray(grant[cap].sources)) ? grant[cap].sources : [];
  const removed = sources.filter(isManual);
  const kept = sources.filter((s) => !isManual(s));

  if (!removed.length) {
    // Nothing of ours to remove. Either it was never granted, or it is held entirely by derived
    // sources — which is not something this tab can revoke (uninstall the skill, or change the
    // agent's base config).
    return { capability: cap, caps: oldCaps, removed: [], stillGranted: kept.length > 0, heldBy: kept, role: null };
  }

  const next = { ...grant };
  // Drop the key entirely when no source remains — grantedCaps keys off presence, and an empty
  // sources array would read as "granted by nobody" to anything that only checks the key.
  if (kept.length) next[cap] = { sources: kept };
  else delete next[cap];

  const written = await _writeGrant(doc, table, key, next);
  const caps = grantedCaps(written);
  if (log && log.info) log.info({ agent: agentId, capability: cap, by: userId, removed, heldBy: kept, caps }, 'capability revoked');
  const role = await _notifyDerivedRole(agentId, oldCaps, caps, log);
  return { capability: cap, caps, removed, stillGranted: kept.length > 0, heldBy: kept, role };
}

/**
 * The agent's per-agent capabilities, from its own config: each connector.extraMcpServers[].toolPrefix
 * IS a capability, aliased through the same prefixToCapability the runtime resolver uses (demo_warehouse →
 * demo_warehouse). Reads AGENT#<id>/CONFIG. Never throws — a config that cannot be read means the tab renders
 * without the MCP rows, which is strictly better than the tab failing to render at all.
 */
async function extraCapsForAgent(doc, table, agentId, { log } = {}) {
  try {
    const { GetCommand } = require('@aws-sdk/lib-dynamodb');
    const { agentConfigKey } = await loadSchema();
    const r = await doc.send(new GetCommand({ TableName: table, Key: agentConfigKey(agentId) }));
    if (!r.Item || !r.Item.data) return [];
    const cfg = JSON.parse(r.Item.data);
    const { prefixToCapability } = await loadCaps();
    return [...new Set(
      ((cfg.connector && cfg.connector.extraMcpServers) || [])
        .map((s) => s && s.toolPrefix)
        .filter(Boolean)
        .map(prefixToCapability),
    )].sort();
  } catch (e) {
    if (log && log.warn) log.warn({ err: e.message, agent: agentId }, 'extraCapsForAgent failed — MCP capabilities omitted from the Tools tab');
    return [];
  }
}

module.exports = {
  readGrant,
  describeCapabilities,
  grantCapability,
  revokeCapability,
  extraCapsForAgent,
  assertGrantable,
  loadPinnedCaps,
  loadAllowedSkills,
  setDerivedRoleHook,
  toolCatalog,
  loadSkillPins,
};

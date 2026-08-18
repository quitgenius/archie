'use strict';

// The policy document, read and fingerprinted — the input side of the policy layer (plan §1.1, §2).
//
// FOUR FILES, AND THE SPLIT IS LOAD-BEARING (archie-cedar-spike/policy/README.md, the table at the
// top). Three are SHARED and always included — `archie.cedarschema`, `semantics.cedar`,
// `semantics.json` — and exactly one, `pins.<env>.json`, is selected per environment. The operator
// edits the selected file and nothing else. semantics.cedar:8-13 records why: semantics duplicated
// per environment cannot be guarded, because divergence is then legitimate by construction and no
// lockstep test is possible — the shape that let build-vendored.cjs drift 1,138 lines behind its
// source. So the shared half is not selectable, and forgetting it is not a thing this loader can do.
//
// WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not validate the policy against the schema, it
// does not check completeness, and it does not check the account against the caller. Those are the
// seven deploy-time checks of plan §3, which are a different task and belong in the deploy step —
// wiring them here would put a policy gate in a loader, where nothing would think to look for it.
// What it does check is only what a *reader* of these files must not get wrong: that a group's
// members are a list of strings, and that `account` is a 12-digit id. Both are shape errors in the
// one file an operator hand-edits, and both would otherwise surface much later as a wrong decision.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { usage, preflight } = require('./exit');

// docker/ — the same root every other lib module resolves against (digest.js:39).
const DOCKER = path.resolve(__dirname, '..', '..');

/**
 * WHERE THE POLICY SOURCES LIVE TODAY, and this is NOT settled — one constant, so moving them is one
 * edit.
 *
 * They sit beside the spike (`archie-cedar-spike/policy/`) because that is where they were authored
 * and where they still are: the spike README's "Status" says adoption means moving them under
 * `agentcore-pi/permissions/`, but that instruction predates plan §2's revision. §2 moved the
 * COMPILED ROW out of the image entirely (to `AGENT#<scope>/POLICY` in DynamoDB) and states the
 * sources "stay in git and never enter the image" — so the argument for putting them inside an
 * image's COPY set has gone, and choosing their final home is a decision for whoever wires
 * `archie deploy --capabilities`, not for this loader to make by defaulting.
 *
 * Every function here takes `dir`, so nothing depends on this default being the final answer.
 */
const POLICY_DIR = path.resolve(DOCKER, '..', '..', '..', 'archie-cedar-spike', 'policy');

const SCHEMA_FILE = 'archie.cedarschema';
const SEMANTICS_FILE = 'semantics.cedar';
const SEMANTICS_DATA_FILE = 'semantics.json';

/** `pins.sandbox.json`, `pins.prod.json`. The env name is the middle segment, and nothing else. */
const pinsFileFor = (env) => `pins.${env}.json`;

/**
 * `$`-prefixed keys are ANNOTATION, never data.
 *
 * Every JSON file in the policy document carries prose in-band — `$comment`, `$immutable`,
 * `$zeroHolderPins`, `$accountComment`, and the per-group review aids `$pin.aws-readonly` — because a
 * reviewer of 21 holder pairs needs the reason next to the data (pins.prod.json:171-187). That is a
 * deliberate authoring choice, so every consumer needs the same one-line rule for reading past it.
 *
 * FILTER ON THE PREFIX, NEVER ON THE TYPE. `$pin.aws-readonly` is a bare string in pins.prod.json:87
 * and an array of strings in pins.sandbox.json:77 — an "ignore anything that is not an array of strings"
 * rule would read sandbox's review note as nine extra scope memberships.
 */
const realKeys = (obj) => Object.keys(obj || {}).filter((k) => !k.startsWith('$')).sort();

/**
 * `sha256:<hex>` over the four sources, in the order plan §1.1 lists them.
 *
 * This is the `policyDigest` the row carries and the `policySetDigest` §2 stamps on the binding row so
 * the step-4 gate can assert every staged agent is running the same policy. It is therefore a
 * FLEET-WIDE value: it must change when any of the four files changes, and must not change for
 * anything else.
 *
 * Records are length-framed, exactly as digest.js:429 frames its files and for the same reason — a
 * bare concatenation lets a byte moved from the end of one source to the start of the next produce an
 * identical hash. Raw text is hashed rather than re-serialised JSON, so a formatting-only edit does
 * move the digest; that is the safe direction (a spurious "policy changed" is noise, a missed one is
 * an agent enforcing a policy nobody reviewed).
 */
function digestOf(raw) {
  const hash = createHash('sha256');
  for (const key of ['schema', 'semantics', 'data', 'pins']) {
    const text = raw[key];
    if (typeof text !== 'string') throw usage(`digestOf: raw.${key} must be the file's text`);
    const body = Buffer.from(text, 'utf8');
    hash.update(`${key}\0${body.length}\0`);
    hash.update(body);
  }
  return `sha256:${hash.digest('hex')}`;
}

function readText(dir, file) {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    throw preflight(`policy source missing: ${file}`, { detail: `looked in ${dir}` });
  }
}

function parseJson(file, text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // The message alone ("Unexpected token } in JSON at position 4231") does not say WHICH file, and
    // three of the four sources are JSON.
    throw preflight(`policy source ${file} is not valid JSON`, { cause: e, detail: e.message });
  }
}

/**
 * The shape checks worth doing at read time, and only those.
 *
 * A group whose value is not a list of strings is the one authoring slip that this file's annotation
 * convention invites: the `$pin.*` review notes sit immediately beside the real groups, so a dropped
 * `$` turns a prose note into a group and a typo'd group name into a silently-empty pin. Both fail
 * CLOSED and therefore SILENTLY (spike README §4) — the property that makes a loud shape check worth
 * having here rather than leaving it to the deploy's bidirectional bindings check (plan §3 check 3),
 * which asks a different question: whether the group NAMES on both sides agree.
 */
function checkPins(file, pins) {
  if (!pins || typeof pins !== 'object') throw preflight(`${file}: expected a JSON object`);
  if (!/^[0-9]{12}$/.test(String(pins.account || ''))) {
    throw preflight(`${file}: "account" must be a 12-digit AWS account id`,
      { detail: `got ${JSON.stringify(pins.account)} — the deploy compares it against the caller (plan §3 check 5)` });
  }
  if (!pins.groups || typeof pins.groups !== 'object') {
    throw preflight(`${file}: expected a "groups" object mapping ScopeGroup name → scope ids`);
  }
  for (const group of realKeys(pins.groups)) {
    const members = pins.groups[group];
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string' || m === '')) {
      throw preflight(`${file}: groups["${group}"] must be an array of scope-id strings`,
        { detail: 'prose belongs on a $-prefixed sibling key; a bare key is data' });
    }
  }
}

function checkSemanticsData(file, data) {
  if (!data || typeof data !== 'object') throw preflight(`${file}: expected a JSON object`);
  for (const field of ['capGroups', 'capabilities', 'slugs']) {
    if (!data[field] || typeof data[field] !== 'object') {
      throw preflight(`${file}: expected a "${field}" object`);
    }
  }
  for (const group of realKeys(data.capGroups)) {
    const members = data.capGroups[group]?.members;
    if (!Array.isArray(members) || members.some((m) => typeof m !== 'string' || m === '')) {
      throw preflight(`${file}: capGroups["${group}"].members must be an array of capability names`);
    }
  }
}

/**
 * Read the whole policy document for one environment.
 *
 * Returns the object every other module in this layer takes as `sources`:
 *
 *   { env, dir, schema, semantics, data, pins, digest, raw }
 *
 *   schema     archie.cedarschema, verbatim. Cedar's `validate`/`checkParseSchema` want the HUMAN
 *              SYNTAX STRING and nothing wrapped around it — `{human: …}` makes cedar-wasm try to
 *              parse it as a JSON schema and fail with `invalid type: string` (spike README §6).
 *   semantics  semantics.cedar, verbatim, and passed to the engine as one whole-text `staticPolicies`
 *              (see policy-row.js for the measurement).
 *   data       parsed semantics.json — capability → capGroup membership.
 *   pins       parsed pins.<env>.json — ScopeGroup membership + the account.
 *   digest     `sha256:…` over all four, the row's `policyDigest`.
 *   raw        the four texts, so a caller can re-derive the digest rather than trust this one.
 */
function loadPolicySources({ env, dir = POLICY_DIR } = {}) {
  if (!env || typeof env !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(env)) {
    throw usage('loadPolicySources needs an env name (the middle segment of pins.<env>.json)',
      { detail: `available: ${availableEnvs(dir).join(', ') || '(none found)'}` });
  }
  const pinsFile = pinsFileFor(env);
  const raw = {
    schema: readText(dir, SCHEMA_FILE),
    semantics: readText(dir, SEMANTICS_FILE),
    data: readText(dir, SEMANTICS_DATA_FILE),
    pins: readText(dir, pinsFile),
  };
  const data = parseJson(SEMANTICS_DATA_FILE, raw.data);
  const pins = parseJson(pinsFile, raw.pins);
  checkSemanticsData(SEMANTICS_DATA_FILE, data);
  checkPins(pinsFile, pins);
  return {
    env,
    dir,
    schema: raw.schema,
    semantics: raw.semantics,
    data,
    pins,
    digest: digestOf(raw),
    raw,
  };
}

/** Which `pins.<env>.json` files exist — for the error message above, and for a caller's --help. */
function availableEnvs(dir = POLICY_DIR) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return [];   // an absent policy dir is the caller's problem to report, not this helper's
  }
  return names
    .map((n) => /^pins\.([a-z0-9][a-z0-9-]*)\.json$/.exec(n))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

module.exports = {
  POLICY_DIR, SCHEMA_FILE, SEMANTICS_FILE, SEMANTICS_DATA_FILE,
  pinsFileFor, availableEnvs, realKeys, digestOf, loadPolicySources,
};

'use strict';

// Content digest of an image's DECLARED COPY inputs — plan §5 "Tags are derived, not typed",
// reference §2.27.
//
// WHY THIS EXISTS. A release USED TO mean bumping `ARCHIE_GATEWAY_TAG` in the Makefile — that
// variable and its build/push targets were deleted on 2026-09-10 once this CLI owned the gateway
// build; `archie gateway build` runs docker itself. The toil it describes is what the digest replaces
// and `archie_dispatcher_image_tag` in sandbox.tfvars in lockstep, and forgetting one is a silent
// no-op. `archie deploy` takes no tags: each image's tag is derived from its own inputs, so the
// repos being IMMUTABLE stops being an obstacle and becomes the mechanism — same content, same tag,
// tag already in ECR, skip the build and the push.
//
// THREE THINGS THIS DELIBERATELY IS NOT:
//
// 1. NOT the git SHA. A SHA lies about a dirty tree — the exact "same tag, different images, from
//    trees several commits apart" failure recorded at agent-image.js:68-72. Hashing working-tree
//    content handles tracked, untracked and modified files uniformly and needs no git plumbing, so
//    digestFor() never shells out to git. (modifiedInputs() does, for a different question.)
//
// 2. NOT the build context. The gateway's context is all of docker/ (Makefile:297-300) and the
//    agent's is docker/archie-runner/ (Makefile:272-276) — both far wider than what each Dockerfile
//    COPYs, and they overlap heavily. Hashing the context would give the two images near-identical
//    change sets and destroy the property the whole feature exists for: THE TWO HALVES ROLL
//    INDEPENDENTLY. A dispatcher-only change must not roll every agent in the fleet; an agent-only change must not
//    cost the ~94s gateway outage.
//
// 3. NOT the whole repository. This is a large monorepo. A modified file that cannot reach the image
//    has not changed the build, and warning about it would train people to ignore the message
//    (plan §5, "Scope note, deliberate").

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { usage, preflight, refused } = require('./exit');

// docker/ — the root every declared path below is relative to. archie/lib/digest.js → ../../ .
// Both images' contexts live under it, so one relative vocabulary covers both, and the paths printed
// in the dirty warning read exactly as the reference's example does (`archie-gateway/index.js`).
const ROOT = path.resolve(__dirname, '..', '..');

// Never walked, whatever .dockerignore says. node_modules is reinstalled by every build stage and is
// never COPYed (that is what docker/.dockerignore:8 exists to say); .git is not build input at all.
// Hard-coding both means a context that forgets to ignore them — archie-runner/.dockerignore's bare
// `node_modules/` misses agentcore-pi/node_modules, since .dockerignore patterns are not recursive —
// cannot poison a digest with a few hundred MB of reinstallable files.
const HARD_EXCLUDES = new Set(['node_modules', '.git']);

// The lint stage of BOTH Dockerfiles COPYs these from docker/ — the agent's via the
// `--build-context lintroot=.` the Makefile is required to pass (Makefile:267-274,
// agentcore-pi/Dockerfile:27,29; archie-gateway/Dockerfile:16,22).
//
// JUDGEMENT CALL, stated so it can be reversed in one place: these files do not appear in the
// shipped filesystem, only in a gate. They are still inputs. The lint gate is a build-time GATE
// (archie-gateway/Dockerfile:110-116, agentcore-pi/Dockerfile:120-126) — a rule added to
// eslint.config.mjs that the current source violates must fail the next build, and if the config
// were not part of the digest the tag would be unchanged, the build skipped as "already in ECR", and
// the new rule would never run against anything. Plan §5 lists them for the gateway; the agent row
// elides them, but the line range it cites (Dockerfile:27-117) contains them, so this treats the two
// images the same. Cost of being wrong: both halves roll when eslint.config.mjs changes — noisy, not
// unsafe.
const LINT_ROOT_INPUTS = [
  { path: 'package.json', context: '.' },
  { path: 'package-lock.json', context: '.' },
  { path: 'eslint.config.mjs', context: '.' },
];

// THE CEDAR POLICY SOURCES (R8). Declared inputs of BOTH images, and neither COPYs them — which is not a
// contradiction: a declared input is "content that decides what this image IS", and these decide the
// baseline capability set that `permissions/baseline.generated.mjs` carries into both.
//
// WHY THEY MUST BE HERE, and it is a correctness argument rather than tidiness. Generating code from a
// source that is NOT a declared input is unsafe: an edit to semantics.json would change no tag, the build
// would be skipped as "already in ECR", and the stale generated file would ship under a tag that claims to
// contain the new policy. Declaring the source is what makes that impossible — an edit moves the tag, the
// build runs, and codegen re-runs with it.
//
// Two smaller things it also fixes: `--pure` now refuses on an uncommitted policy edit (it did not, so a
// release could claim reproducibility while the policy on disk differed from HEAD), and the dirty-tree
// warning can name a modified policy file.
//
// `context: '.'` because the AGENT's build context is docker/archie-runner/ and this sits above it. Same
// mechanism LINT_ROOT_INPUTS uses for the repo-root lint config, and for the same reason: hashed as input,
// never resolved against the narrower context.
//
// Cost of being wrong here: a policy edit rolls both halves. Noisy, not unsafe — and a policy edit SHOULD
// roll the agent, because the generated baseline it carries has changed.
const POLICY_INPUTS = [
  { path: 'policy', dir: true, context: '.' },
];

/**
 * The declared input sets, as data — one per image, because they DIFFER and the difference is the
 * feature (plan §5). Every path is relative to docker/; `dir: true` means "walk it".
 *
 * `context` is the docker build context, and it selects which .dockerignore applies. It is not
 * cosmetic: docker/.dockerignore and archie-runner/.dockerignore have different contents and the wrong
 * one gives the wrong file set.
 */
const IMAGES = {
  // archie-gateway/Dockerfile. Context is docker/, NOT docker/archie-gateway/ (Dockerfile:53-56,
  // Makefile:297-300), so every dispatcher path here carries the `archie-gateway/` prefix.
  gateway: {
    name: 'gateway',
    dockerfile: 'archie-gateway/Dockerfile',
    context: '.',
    inputs: [
      ...LINT_ROOT_INPUTS,
      ...POLICY_INPUTS,

      // Dockerfile:18,57. `package-lock.json*` is written with a trailing `*` so the build survives
      // its absence; it is present today, hence optional rather than missing-is-an-error.
      { path: 'archie-gateway/package.json' },
      { path: 'archie-gateway/package-lock.json', optional: true },

      // Dockerfile:60-61 — the explicit COPY allowlist, verbatim and in order. This allowlist is
      // itself load-bearing: a local module added to index.js and not listed here is a
      // MODULE_NOT_FOUND crash-loop after a green build (Dockerfile:78-81, "this has happened
      // twice"). session-tracker.js appears TWICE on line 60 in the Dockerfile; it is listed once
      // here, and resolveInputs() dedupes anyway.
      { path: 'archie-gateway/index.js' },
      { path: 'archie-gateway/marketplace.js' },
      { path: 'archie-gateway/derived-role.js' },
      { path: 'archie-gateway/streaming.js' },
      { path: 'archie-gateway/conversations.js' },
      { path: 'archie-gateway/metrics.js' },
      { path: 'archie-gateway/file-ref.js' },
      { path: 'archie-gateway/agentcore-client.js' },
      { path: 'archie-gateway/agentcore-provisioning.js' },
      { path: 'archie-gateway/dispatcher-metrics.js' },
      { path: 'archie-gateway/tracing.js' },
      { path: 'archie-gateway/backpressure.js' },
      { path: 'archie-gateway/connector-credential.js' },
      { path: 'archie-gateway/session-tracker.js' },
      { path: 'archie-gateway/image-source.js' },
      { path: 'archie-gateway/turn-queue.js' },
      { path: 'archie-gateway/spec-diff.js' },
      { path: 'archie-gateway/cron-home.js' },
      { path: 'archie-gateway/grants.js' },
      // agent-scope.js is the scope-id rule (and its inverse, slackRefFromScopeId); agent-directory.js
      // is the App Home agent selector's list. Both are on the Dockerfile's COPY line. They were
      // missing here, which is worse than it sounds: the tag is a content digest of THIS list, so a
      // change confined to a file the list omits produces an unchanged tag, `deploy` reports "inputs
      // unchanged", skips the build and rolls onto the OLD image — a silent stale deploy, which is the
      // exact failure the Dockerfile's own allowlist comment warns about from the other direction.
      { path: 'archie-gateway/agent-scope.js' },
      { path: 'archie-gateway/agent-directory.js' },
      { path: 'archie-gateway/agent-labels.js' },

      // Outbound-comms approvals (P1/P2 of the comms-approval port). Added here the moment the
      // omission bit: a change confined to approvals-routes.js produced an UNCHANGED tag, so
      // `gateway deploy` reported "inputs unchanged" and skipped the build entirely — precisely
      // the silent stale deploy the note above describes, recurring for the same reason. Three
      // lists must agree for a new gateway module: the Dockerfile COPY allowlist, the Dockerfile
      // preflight `entry` array when the module is a require-root, and THIS.
      { path: 'archie-gateway/approvals-store.js' },
      { path: 'archie-gateway/approvals-routes.js' },
      { path: 'archie-gateway/approvals-wake.js' },
      { path: 'archie-gateway/owners.js' },

      // Found by the bidirectional test below, not by inspection: all three are on the Dockerfile's
      // COPY line and were never declared here, so an edit to any of them produced an unchanged tag
      // and a deploy that shipped nothing. Pre-existing — they predate the approvals work — and
      // exactly why the assertion is worth more than the comment it replaces.
      { path: 'archie-gateway/cron-runner-flag.js' },
      { path: 'archie-gateway/policy-derive.js' },
      { path: 'archie-gateway/runtime-quota-metrics.js' },
      { path: 'archie-gateway/semaphore.js' },
      { path: 'archie-gateway/sdk-http.js' },
      { path: 'archie-gateway/slack-proxy-routes.js' },
      { path: 'archie-gateway/runtime-registry.js' },
      { path: 'archie-gateway/cron-service.js' },
      { path: 'archie-gateway/cron-runner.js' },
      { path: 'archie-gateway/cron-store.js' },
      { path: 'archie-gateway/cron-fire.js' },
      { path: 'archie-gateway/cron-delivery.js' },
      { path: 'archie-gateway/cron-api.js' },
      { path: 'archie-gateway/cron-hydrator.js' },
      { path: 'archie-gateway/cron-metrics.js' },
      { path: 'archie-gateway/cron-inventory-metrics.js' },
      { path: 'archie-gateway/peer-synth-fixture.js' },
      { path: 'archie-gateway/hydrate-e2e.js' },
      { path: 'archie-gateway/delivery-e2e.js' },
      { path: 'archie-gateway/registry-e2e.js' },

      // Dockerfile:63-74. THE OVERLAP WITH THE AGENT IS INTENTIONAL AND MUST STAY: both images build
      // from the same source for the workspace seed and the cap→IAM map (§9.8/§9.9a) so there is no
      // mirrored implementation to drift. Editing one of these files therefore rolls BOTH halves —
      // correct, and the digest is what makes it visible.
      { path: 'archie-runner/config-seed/new-agent-skeleton', dir: true },
      { path: 'archie-runner/agentcore-pi/workspace-seed.mjs' },
      { path: 'archie-runner/config-resolver/skill-iam-requirements.mjs' },
      { path: 'archie-runner/config-resolver/derive-exec-role.mjs' },
      { path: 'archie-runner/config-resolver/caps-from-config.mjs' },
      { path: 'archie-runner/config-resolver/schema.mjs' },
      // The skill-pin allow-lists. Declared for a sharper reason than the rest: this file decides which
      // scopes may hold a gated skill, so an edit that did NOT move the tag would leave the dispatcher
      // enforcing the OLD allow-list while the repo showed the new one — a permissions change that
      // silently did not ship. Populating an allow-list must roll the gateway.
      { path: 'archie-runner/config-resolver/skill-pins.mjs' },

      // Dockerfile:76-84. The tool/capability declarations the Tools tab renders, imported from the
      // agent tree rather than mirrored. Declared here for the same reason as every file above: the
      // digest is what turns "I edited it" into a new tag. Without them, adding a tool — which
      // changes what the tab shows — would leave the tag identical and `gateway deploy` would report
      // "unchanged" while the running image kept the old surface. ANOTHER overlap with the agent
      // image, deliberately, exactly like the workspace-seed/cap→IAM files above: editing a tool
      // declaration rolls both halves, which is correct, and the digest makes it visible.
      { path: 'archie-runner/agentcore-pi/tool-declarations.mjs' },
      { path: 'archie-runner/agentcore-pi/permissions/capabilities.mjs' },
      // Generated from docker/policy/semantics.json (policy-codegen.js) and imported by
      // capabilities.mjs. An input in its own right, not only via the policy sources: the two move
      // together, but a hand-edit of the generated file must also move the tag.
      { path: 'archie-runner/agentcore-pi/permissions/baseline.generated.mjs' },
      { path: 'archie-runner/agentcore-pi/permissions/provider-registry.mjs' },
    ],
  },

  // archie-runner/agentcore-pi/Dockerfile. Context is docker/archie-runner/ (Dockerfile:5-6, Makefile:272-276)
  // — documented there as load-bearing "because it has bitten people" — plus the lintroot context.
  //
  // WHOLE DIRECTORIES, not per-file allowlists, and deliberately: this Dockerfile COPYs
  // `agentcore-pi/*.mjs agentcore-pi/*.cjs` in the lint stage (Dockerfile:34-38) and a long explicit
  // list in the runtime stage (Dockerfile:87-100), and the two do not agree. A directory is a
  // SUPERSET of both, and the superset is the safe direction of error: an extra roll costs a
  // provisioning pass, a missed roll ships stale code under a tag that claims it is current. Plan §5
  // states the agent's inputs at directory granularity for the same reason.
  agent: {
    name: 'agent',
    dockerfile: 'archie-runner/agentcore-pi/Dockerfile',
    context: 'archie-runner',
    inputs: [
      ...LINT_ROOT_INPUTS,
      ...POLICY_INPUTS,

      // Dockerfile:30,34-37,84-100,107-108 — sources, package.json, openclaw-compat/, permissions/,
      // and spike/ (lint stage only, but a lint failure there fails this build).
      { path: 'archie-runner/agentcore-pi', dir: true },

      // Dockerfile:32-33,38,115-116. All of it: the lint stage lints the whole package and the
      // runtime stage COPYs the whole directory. Most of what is on disk here — ground-truth/,
      // resolved/, resolved-ddb/, items/, ~1400 of its ~1480 files — is regenerated local output and
      // is excluded by archie-runner/.dockerignore, which is precisely why that file is honoured below.
      // Without it the agent digest would churn on every hydrate run and roll every agent in the fleet for nothing.
      { path: 'archie-runner/config-resolver', dir: true },

      // Dockerfile:46-71 — stage 1 bundles the three compat plugins against the local plugin-sdk
      // shim. Their sources are inputs even though only the bundled .cjs ships.
      { path: 'archie-runner/plugin-sdk', dir: true },
      { path: 'archie-runner/connector-session-plugin', dir: true },
      { path: 'archie-runner/demo-cache-plugin', dir: true },
      { path: 'archie-runner/openclaw-mcp-auth-plugin', dir: true },

      // Dockerfile:101-106 — the single source of truth for the OTEL query corpus, shared with the
      // dashboard builder and the BDD suite so the tools and the dashboard cannot drift.
      { path: 'archie-runner/agentcore-observability/insight-queries.js' },

      // Dockerfile:117 — the hand-authored new-agent skeleton (the skill library lives in DynamoDB).
      { path: 'archie-runner/config-seed', dir: true },
    ],
  },
};

// ── .dockerignore ────────────────────────────────────────────────────────────────────────────────
//
// Honoured because the digest must cover what Docker actually SENDS, not what a glob naively
// matches. See the config-resolver note above for the case that makes this non-optional.
//
// A deliberate subset of Docker's fileutils semantics: patterns are context-relative, `*` and `?` do
// not cross `/`, `**` spans any number of segments, `!` negates, and the LAST matching pattern wins.
// The one that catches people out — and is called out in docker/.dockerignore:5-7 — is that patterns
// are NOT recursive by default: `node_modules/` matches only the context root, which is why
// `**/node_modules` is written there and why HARD_EXCLUDES exists here.

function segmentToRegExp(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i += 1) {
    const c = seg[i];
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return out;
}

function patternToRegExp(pattern) {
  const segs = pattern.split('/');
  let re = '^';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') re += last ? '.*' : '(?:[^/]+/)*';
    else re += segmentToRegExp(seg) + (last ? '' : '/');
  });
  return new RegExp(`${re}$`);
}

function parseDockerignore(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negated = line.startsWith('!');
    // filepath.Clean equivalent for the shapes that occur here: strip `!`, a leading `./`, and any
    // trailing `/`. `node_modules/` and `node_modules` are the same pattern to Docker.
    const body = (negated ? line.slice(1) : line).replace(/^\.\//, '').replace(/\/+$/, '');
    if (!body) continue;
    rules.push({ re: patternToRegExp(body), negated });
  }
  return rules;
}

const ignoreCache = new Map();

function ignoreRulesFor(root, context) {
  const key = `${root}\0${context}`;
  if (!ignoreCache.has(key)) {
    const file = path.join(root, context, '.dockerignore');
    let rules = [];
    try {
      rules = parseDockerignore(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;   // a .dockerignore we cannot read must not be assumed empty
    }
    ignoreCache.set(key, rules);
  }
  return ignoreCache.get(key);
}

/** Would Docker skip this context-relative path? Ancestors count: an ignored dir takes its tree. */
function isIgnored(rules, relToContext) {
  if (rules.length === 0) return false;
  const segs = relToContext.split('/');
  let ignored = false;
  for (let i = 0; i < segs.length; i += 1) {
    const prefix = segs.slice(0, i + 1).join('/');
    for (const rule of rules) {
      if (rule.re.test(prefix)) ignored = !rule.negated;   // last match wins
    }
  }
  return ignored;
}

// ── input resolution ─────────────────────────────────────────────────────────────────────────────

function specFor(image) {
  if (typeof image === 'string') {
    const spec = IMAGES[image];
    if (!spec) throw usage(`unknown image "${image}" (expected one of: ${Object.keys(IMAGES).join(', ')})`);
    return spec;
  }
  if (image && Array.isArray(image.inputs)) return image;
  throw usage('image must be a known image name or a spec object with inputs[]');
}

/** posix-joined relative path, so a digest computed on Windows matches one computed on macOS. */
const rel = (...parts) => parts.filter(Boolean).join('/');

/**
 * The entry that declares `relPath`, or null. A file entry declares itself; a dir entry declares
 * everything beneath it. Used both by the walk and by modifiedInputs(), so "declared" means exactly
 * one thing — a git status line and a walked file are filtered by the same predicate.
 */
function declaringEntry(spec, relPath) {
  for (const entry of spec.inputs) {
    if (entry.dir) {
      if (relPath === entry.path || relPath.startsWith(`${entry.path}/`)) return entry;
    } else if (relPath === entry.path) return entry;
  }
  return null;
}

function excludedByName(relPath) {
  return relPath.split('/').some((seg) => HARD_EXCLUDES.has(seg));
}

/** Is this docker-relative path a real, sent-to-the-daemon input of this image? */
function isDeclaredInput(spec, relPath) {
  const entry = declaringEntry(spec, relPath);
  if (!entry) return false;
  if (excludedByName(relPath)) return false;
  const context = entry.context || spec.context || '.';
  const contextRel = context === '.' ? relPath : path.posix.relative(context, relPath);
  return !isIgnored(ignoreRulesFor(spec.root || ROOT, context), contextRel);
}

function walk(root, spec, dirRel, out) {
  for (const dirent of fs.readdirSync(path.join(root, dirRel), { withFileTypes: true })) {
    const childRel = rel(dirRel, dirent.name);
    if (HARD_EXCLUDES.has(dirent.name)) continue;
    if (dirent.isDirectory()) {
      // Prune ignored directories rather than filtering their files one by one: config-resolver's
      // four generated directories are 1427 files we must not even stat.
      if (isDeclaredInput(spec, childRel)) walk(root, spec, childRel, out);
      continue;
    }
    if (isDeclaredInput(spec, childRel)) out.push(childRel);
  }
}

/**
 * Every file this image declares, in the working tree, sorted.
 *
 * A missing non-optional declared input is exit 3, not a smaller digest: silently digesting an
 * absent file yields a stable-but-wrong tag, and the "tag already exists" skip would then skip a
 * build that was going to fail anyway. Naming the path is the whole value (context.js:29-31).
 */
function resolveInputs(image, { root = ROOT } = {}) {
  const base = specFor(image);
  const spec = { ...base, root };
  const found = [];
  for (const entry of spec.inputs) {
    let stat = null;
    try {
      stat = fs.lstatSync(path.join(root, entry.path));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (entry.optional) continue;
      throw preflight(`declared input missing: ${entry.path}`,
        { detail: `${spec.name || 'image'} declares it (${spec.dockerfile || 'spec'}); the build would fail` });
    }
    if (stat.isDirectory()) {
      if (!entry.dir) {
        throw preflight(`declared input ${entry.path} is a directory but is declared as a file`);
      }
      if (isDeclaredInput(spec, entry.path)) walk(root, spec, entry.path, found);
    } else if (isDeclaredInput(spec, entry.path)) {
      found.push(entry.path);
    }
  }
  // Sort by code unit, NOT localeCompare: a locale-sensitive sort is a machine-dependent digest.
  // Dedupe because the Dockerfile's own allowlist repeats session-tracker.js.
  return [...new Set(found)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

// ── digest ───────────────────────────────────────────────────────────────────────────────────────

const TAG_PREFIX = 'content-';
const SHORT_LENGTH = 16;
// ECR tag grammar: [a-zA-Z0-9._-], ≤128 chars.
const ECR_TAG = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * The image tag for a digest.
 *
 * `content-` is a prefix nobody will mistake for the hand-authored tags in use today
 * (`archie-0.2.22`, `archie-0.2.6` — Makefile:57,73): those are versions someone chose, this is a
 * fact about the tree. It also cannot be confused with a git SHA, which is the other thing a bare
 * hex tag would read as, and which this deliberately is not.
 */
function tagFor(digest) {
  const short = String(digest).slice(0, SHORT_LENGTH);
  const tag = `${TAG_PREFIX}${short}`;
  if (!/^[0-9a-f]+$/.test(short) || short.length !== SHORT_LENGTH || !ECR_TAG.test(tag)) {
    throw usage(`refusing to build an invalid ECR tag from digest "${digest}"`);
  }
  return tag;
}

/**
 * Hash this image's declared inputs from the working tree.
 *
 * DETERMINISM RULES, each one a way this could have been silently machine-dependent:
 *   · paths are hashed, not just contents — moving a file changes the image;
 *   · the file list is sorted by code unit, so readdir order cannot leak in;
 *   · nothing derived from the filesystem's own bookkeeping — no mtime, no inode, no size-on-disk;
 *   · the executable bit IS included (git normalises it to 644/755, so it is stable, and COPY
 *     preserves it — a script that ships non-executable is a different image);
 *   · symlinks hash their target string and are not followed: a cycle would hang, and Docker sends
 *     the link, not the resolution;
 *   · every record is length-framed, so `a/b` + "xy" cannot collide with `a/bx` + "y".
 * Each file is read exactly once.
 */
function digestFor(image, { root = ROOT } = {}) {
  const spec = specFor(image);
  const files = resolveInputs(image, { root });
  if (files.length === 0) {
    throw preflight(`${spec.name || 'image'} declares no inputs that exist — refusing to tag an empty digest`);
  }

  const hash = createHash('sha256');
  for (const file of files) {
    const abs = path.join(root, file);
    const stat = fs.lstatSync(abs);
    const body = stat.isSymbolicLink()
      ? Buffer.from(fs.readlinkSync(abs), 'utf8')
      : fs.readFileSync(abs);
    const kind = stat.isSymbolicLink() ? 'l' : (stat.mode & 0o111 ? 'x' : '-');
    hash.update(`${file}\0${kind}\0${body.length}\0`);
    hash.update(body);
  }

  const digest = hash.digest('hex');
  return {
    image: spec.name || null,
    digest,
    short: digest.slice(0, SHORT_LENGTH),
    tag: tagFor(digest),
    fileCount: files.length,
    files,
  };
}

// ── modified-relative-to-HEAD ────────────────────────────────────────────────────────────────────

function git(args, { root, env }) {
  return execFileSync('git', args, {
    cwd: root,
    env: env || process.env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Which of this image's declared inputs differ from HEAD.
 *
 * This is the ONE place git is used, and it answers a different question from the digest: the digest
 * asks "what is in the tree", this asks "is the tree the commit". It feeds the `--pure` refusal
 * (exit 5) and the default dirty warning, and nothing else — a dirty tree is allowed by default and
 * the digest already makes it honest (plan §5).
 *
 * Untracked files inside a declared path COUNT. `-uall` is required for that: the default collapses
 * them to the containing directory, and "archie-runner/agentcore-pi/" is not a filename anyone can act on.
 *
 * `gitEnv` is injectable so the tests can run against a hermetic repo — a developer's global
 * core.excludesfile would otherwise decide whether an untracked fixture file is reported.
 */
function modifiedInputs(image, { root = ROOT, gitEnv = null } = {}) {
  const spec = { ...specFor(image), root };

  // Only pass pathspecs that exist: an optional input that is absent is not an error here.
  const pathspecs = spec.inputs
    .map((e) => e.path)
    .filter((p) => fs.existsSync(path.join(root, p)));

  let head = null;
  let porcelain;
  let prefix;
  try {
    // `--porcelain` prints paths relative to the REPOSITORY ROOT, not to cwd — while pathspecs are
    // read relative to cwd. docker/ is several levels below the repo root, so without this the two
    // vocabularies never meet and every modified file is silently discarded as "not declared". That
    // failed silently in exactly the way that matters: `--pure` would have passed on a dirty tree.
    prefix = git(['rev-parse', '--show-prefix'], { root, env: gitEnv }).trim();
    porcelain = git(['status', '--porcelain', '-uall', '-z', '--', ...pathspecs], { root, env: gitEnv });
  } catch {
    // Not a work tree, or no git at all. Not an error: the digest does not need git. The CALLER
    // decides what that means — assertPure() refuses, the dirty warning stays silent.
    return { image: spec.name || null, git: false, head: null, modified: [] };
  }
  try {
    head = git(['rev-parse', '--short', 'HEAD'], { root, env: gitEnv }).trim();
  } catch {
    head = null;                                   // a repo with no commits yet
  }

  // Repo-root-relative → docker-relative. A path outside our root cannot be an input of ours.
  const toRootRel = (p) => {
    if (!prefix) return p;
    return p.startsWith(prefix) ? p.slice(prefix.length) : null;
  };
  const add = (set, p) => {
    const r = p && toRootRel(p);
    if (r && isDeclaredInput(spec, r)) set.add(r);
  };

  const tokens = porcelain.split('\0');
  const modified = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.length < 4) continue;                // trailing empty token
    const code = token.slice(0, 2);
    // Rename/copy entries carry the ORIGINAL path as the next NUL-separated token; both sides moved.
    if (code[0] === 'R' || code[0] === 'C') {
      i += 1;
      add(modified, tokens[i]);
    }
    add(modified, token.slice(3));
  }

  return {
    image: spec.name || null,
    git: true,
    head,
    modified: [...modified].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/**
 * `--pure`: refuse, exit 5, BEFORE anything is built (reference §2.27).
 *
 * Also refuses when git cannot answer. `--pure` is the CI setting and the setting for a release meant
 * to be reproducible from a commit; "I could not check" is not "it is clean", and the failure mode of
 * guessing here is a release that claims reproducibility it never verified.
 */
function assertPure(image, opts = {}) {
  const state = modifiedInputs(image, opts);
  const name = state.image || 'image';
  if (!state.git) {
    throw refused('--pure requires a git working tree to compare against HEAD, and this is not one',
      { detail: String(opts.root || ROOT) });
  }
  if (state.modified.length > 0) {
    throw refused(`--pure: ${name} inputs are modified relative to HEAD (${state.head || 'no commit'})`,
      { detail: state.modified.join(', ') });
  }
  return state;
}

/**
 * The default (non-`--pure`) warning, or null when there is nothing to say.
 *
 * Returns one string for output.warn(), which prefixes "WARNING: " — continuation lines are indented
 * to align under it, reproducing the block in reference §2.27 exactly. Built here rather than at the
 * call sites so the gateway and the agent cannot word it differently.
 */
function dirtyWarning(image, opts = {}) {
  const state = modifiedInputs(image, opts);
  if (!state.git || state.modified.length === 0) return null;
  const pad = ' '.repeat(9);
  return [
    'skipped --pure mode and working tree is dirty',
    `${pad}${state.image || 'image'} inputs modified: ${state.modified.join(', ')}`,
    `${pad}image tag reflects the working tree, not HEAD (${state.head || 'no commit'})`,
  ].join('\n');
}

module.exports = {
  IMAGES, ROOT, TAG_PREFIX, SHORT_LENGTH,
  resolveInputs, digestFor, tagFor, modifiedInputs, assertPure, dirtyWarning,
  // exported for tests — the .dockerignore subset is the piece most likely to be subtly wrong
  parseDockerignore, isIgnored,
};

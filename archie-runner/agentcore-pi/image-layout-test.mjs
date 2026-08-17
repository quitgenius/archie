// Guard against the "image layout != repo layout" boot-crash class.
//
// Three live outages so far, all the same shape: a module that resolves perfectly in the repo is
// module-not-found in the BUILT image, so the runtime crash-loops on first invoke
// (`RuntimeClientError: error when starting the runtime`), goes DELETING, and the BDD suite retries
// 15x over ~17 minutes before anyone sees why. Unit tests cannot catch it — they import from the repo
// tree, where everything is present and the relative depths are right.
//
//   1. tool-registry.mjs was test-only, then a later slice imported it at boot — not in the COPY
//      allowlist (the agent Dockerfile lists files EXPLICITLY, it does not COPY the dir).
//   2. permissions/X.mjs importing '../../config-resolver/Y.mjs' is repo-correct but wrong in-image:
//      the Dockerfile FLATTENS agentcore-pi/permissions/ to /app/permissions/ and config-resolver/ to
//      /app/config-resolver/, so in-image the correct depth is one '../', not two.
//   3. reply-usage.mjs + turn-outcome.mjs (this commit) — same as (1).
//
// So this test does not check the repo. It reconstructs the image's /app layout from the Dockerfile's
// own COPY statements, then resolves the boot import graph INSIDE that virtual filesystem — which is
// what `node pi-entrypoint.mjs` actually does in the microVM. It therefore catches both a missing file
// and a wrong relative depth, the two ways this class shows up.
//
// It is deliberately static (no docker build, no AWS): the in-image `docker run --entrypoint node`
// preflight in the deploy playbook stays the belt to this braces, but a preflight only runs if someone
// remembers, and the whole point is that nobody remembers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONTEXT = path.resolve(HERE, '..');            // build context is docker/clawdbot/
const DOCKERFILE = path.join(HERE, 'Dockerfile');
const WORKDIR = '/app';

// The boot entrypoint, plus the two modules the CMD reaches through it. Anything transitively
// imported from here must exist in the image; anything else (tools loaded lazily, test-only helpers)
// is out of scope by construction.
const BOOT_ENTRYPOINTS = ['/app/pi-entrypoint.mjs'];

/** Physical COPY lines of the final stage, with continuations joined and flags stripped. */
function copyStatements(dockerfile) {
  const text = fs.readFileSync(dockerfile, 'utf8');
  // Only the runtime stage matters — earlier stages build the plugin bundles.
  const lastFrom = text.lastIndexOf('\nFROM ');
  const stage = lastFrom === -1 ? text : text.slice(lastFrom);
  const joined = stage.replace(/\\\r?\n/g, ' ');     // join continuations
  const out = [];
  for (const raw of joined.split('\n')) {
    const line = raw.trim();
    if (!line.toUpperCase().startsWith('COPY ')) continue;
    const tokens = line.slice(5).trim().split(/\s+/);
    const flags = tokens.filter((t) => t.startsWith('--'));
    const args = tokens.filter((t) => !t.startsWith('--'));
    if (args.length < 2) continue;
    out.push({
      fromStage: flags.some((f) => f.startsWith('--from=')),
      sources: args.slice(0, -1),
      dest: args[args.length - 1],
    });
  }
  return out;
}

function walkFiles(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkFiles(full));
    else found.push(full);
  }
  return found;
}

/**
 * Virtual /app filesystem: in-image absolute path -> source file on disk (or null when the content
 * comes from an earlier build stage, e.g. the esbuild'd plugin bundles).
 */
function buildImageLayout() {
  const layout = new Map();
  const opaqueDirs = [];   // dirs whose contents come from another stage — presence, not content

  for (const { fromStage, sources, dest } of copyStatements(DOCKERFILE)) {
    const destAbs = path.posix.resolve(WORKDIR, dest);
    const destIsDir = dest.endsWith('/') || dest === '.' || dest === './';

    if (fromStage) {
      opaqueDirs.push(destIsDir ? destAbs : path.posix.dirname(destAbs));
      continue;
    }

    for (const src of sources) {
      const srcAbs = path.resolve(CONTEXT, src);
      // A glob (package-lock.json*) that matches nothing is not an error in Docker; skip quietly.
      if (!fs.existsSync(srcAbs)) {
        if (src.includes('*')) continue;
        const globbed = src.replace(/\*$/, '');
        if (fs.existsSync(path.resolve(CONTEXT, globbed))) continue;
        continue;
      }
      const stat = fs.statSync(srcAbs);
      if (stat.isDirectory()) {
        // `COPY dir/ ./dest/` copies the CONTENTS of dir into dest.
        for (const file of walkFiles(srcAbs)) {
          const rel = path.relative(srcAbs, file).split(path.sep).join('/');
          layout.set(path.posix.join(destAbs, rel), file);
        }
      } else if (destIsDir) {
        layout.set(path.posix.join(destAbs, path.basename(srcAbs)), srcAbs);
      } else {
        layout.set(destAbs, srcAbs);              // single-file COPY, possibly renamed (.js -> .cjs)
      }
    }
  }
  return { layout, opaqueDirs };
}

/** Relative specifiers only — bare ones come from npm install, which the Dockerfile runs. */
function localSpecifiers(source) {
  const specs = new Set();
  const patterns = [
    /(?:^|\s)import\s+[^;'"]*?from\s*['"](\.[^'"]+)['"]/g,   // import x from './y'
    /(?:^|\s)import\s*['"](\.[^'"]+)['"]/g,                   // import './y'
    /(?:^|\s)export\s+[^;'"]*?from\s*['"](\.[^'"]+)['"]/g,    // export … from './y'
    /\bimport\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,               // await import('./y')
    /\brequire\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g,              // require('./y')
  ];
  // Strip comments first so the documented-but-wrong paths in prose can't fail the build.
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  for (const re of patterns) {
    for (const m of code.matchAll(re)) specs.add(m[1]);
  }
  return [...specs];
}

function resolveInImage(spec, fromPath, layout, opaqueDirs) {
  const base = path.posix.resolve(path.posix.dirname(fromPath), spec);
  const candidates = [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`,
    path.posix.join(base, 'index.mjs'), path.posix.join(base, 'index.js')];
  for (const c of candidates) if (layout.has(c)) return { resolved: c, opaque: false };
  for (const dir of opaqueDirs) if (base.startsWith(`${dir}/`)) return { resolved: base, opaque: true };
  return { resolved: null, candidates };
}

test('every module on the boot import graph exists in the built image layout', () => {
  const { layout, opaqueDirs } = buildImageLayout();

  // Sanity: if the Dockerfile parse silently produced nothing, the test would vacuously pass.
  assert.ok(layout.size > 20, `Dockerfile parse produced only ${layout.size} in-image files`);
  for (const entry of BOOT_ENTRYPOINTS) {
    assert.ok(layout.has(entry), `${entry} is not COPYed into the image at all`);
  }

  const missing = [];
  const seen = new Set();
  const queue = [...BOOT_ENTRYPOINTS];

  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);

    const sourceFile = layout.get(current);
    if (!sourceFile) continue;                       // opaque (built in an earlier stage)
    if (!/\.(mjs|cjs|js)$/.test(sourceFile)) continue;

    for (const spec of localSpecifiers(fs.readFileSync(sourceFile, 'utf8'))) {
      const { resolved, opaque, candidates } = resolveInImage(spec, current, layout, opaqueDirs);
      if (!resolved) {
        missing.push(`${current}\n      imports '${spec}'`
          + `\n      -> tried ${candidates.join(', ')}`
          + `\n      (source: ${path.relative(CONTEXT, sourceFile)})`);
        continue;
      }
      if (!opaque) queue.push(resolved);
    }
  }

  assert.deepEqual(missing, [], missing.length
    ? `\n\n${missing.length} boot import(s) would be MODULE_NOT_FOUND in the image — the runtime would`
      + ` crash-loop on first invoke. Either add the file to the agentcore-pi Dockerfile COPY allowlist,`
      + ` or fix the relative depth for the FLATTENED in-image layout (agentcore-pi/* -> /app/*,`
      + ` agentcore-pi/permissions/ -> /app/permissions/, config-resolver/ -> /app/config-resolver/):`
      + `\n\n  - ${missing.join('\n\n  - ')}\n`
      : '');
});

test('the guard actually discriminates — a file dropped from the COPY allowlist is caught', () => {
  // Proves the test above is not vacuous: resolve a module that IS on the boot graph against a
  // layout with that entry removed, and assert it comes back unresolvable.
  const { layout, opaqueDirs } = buildImageLayout();
  const victim = '/app/reply-usage.mjs';
  assert.ok(layout.has(victim), `${victim} should be in the layout to begin with`);

  layout.delete(victim);
  const { resolved } = resolveInImage('./reply-usage.mjs', '/app/pi-adapter.mjs', layout, opaqueDirs);
  assert.equal(resolved, null, 'a missing COPY must be unresolvable, or this guard proves nothing');
});

test('flattening is modelled: permissions/ keeps its dir, agentcore-pi/ does not', () => {
  const { layout } = buildImageLayout();
  // agentcore-pi/*.mjs is flattened to /app/*.mjs …
  assert.ok(layout.has('/app/pi-adapter.mjs'));
  assert.ok(!layout.has('/app/agentcore-pi/pi-adapter.mjs'));
  // … while agentcore-pi/permissions/ becomes /app/permissions/ (one level, not two).
  assert.ok([...layout.keys()].some((k) => k.startsWith('/app/permissions/')));
  assert.ok(![...layout.keys()].some((k) => k.startsWith('/app/agentcore-pi/permissions/')));
  // And the .js -> .cjs rename is a real entry, not the source name.
  assert.ok(layout.has('/app/insight-queries.cjs'));
});

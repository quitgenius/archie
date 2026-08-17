'use strict';

// Every tree these tests digest is built in a temp dir. NOTHING here may depend on this repo's own
// git state — a test that passes only on a clean checkout is a test that fails on the machine of
// whoever is actually working, which is every machine that will ever run it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  IMAGES, TAG_PREFIX, SHORT_LENGTH,
  resolveInputs, digestFor, tagFor, modifiedInputs, assertPure, dirtyWarning,
  parseDockerignore, isIgnored,
} = require('./digest');
const { EXIT } = require('./exit');

// realpath: on macOS mkdtemp hands back /var/... which is a symlink to /private/var, and git reports
// the resolved form. Comparing the two is a false failure that costs an hour to see.
const tmpRoot = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'archie-digest-')));

function write(root, relPath, content) {
  const abs = path.join(root, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

// Two images that OVERLAP on one file and differ elsewhere — the shape of the real gateway/agent
// pair (both COPY archie-runner/agentcore-pi/workspace-seed.mjs; everything else is their own).
const ALPHA = {
  name: 'alpha',
  context: '.',
  inputs: [{ path: 'shared/seed.mjs' }, { path: 'alpha', dir: true }],
};
const BETA = {
  name: 'beta',
  context: '.',
  inputs: [{ path: 'shared/seed.mjs' }, { path: 'beta', dir: true }],
};

// Written in this order in one tree and reversed in the other, so readdir order gets a chance to
// leak into the digest if the implementation ever lets it.
const BASE = [
  ['shared/seed.mjs', 'seed\n'],
  ['alpha/index.js', 'alpha entry\n'],
  ['alpha/nested/deep.js', 'deep\n'],
  ['beta/index.mjs', 'beta entry\n'],
  ['undeclared.txt', 'not an input\n'],
  ['shared/other.mjs', 'sibling of a declared FILE, itself undeclared\n'],
];

function buildTree(files = BASE) {
  const root = tmpRoot();
  for (const [rel, content] of files) write(root, rel, content);
  return root;
}

// ── determinism ──────────────────────────────────────────────────────────────────────────────────

test('identical trees produce identical digests, and a second run is byte-identical', () => {
  const a = buildTree();
  const b = buildTree([...BASE].reverse());   // same content, opposite creation order, other path

  const first = digestFor(ALPHA, { root: a });
  const again = digestFor(ALPHA, { root: a });
  assert.equal(first.digest, again.digest, 'running twice with no edits changed the answer');
  assert.equal(first.digest, digestFor(ALPHA, { root: b }).digest, 'digest depended on the directory or on readdir order');
  assert.equal(first.tag, `${TAG_PREFIX}${first.short}`);
  assert.equal(first.fileCount, 3);
});

test('touching a DECLARED input changes the digest', () => {
  const root = buildTree();
  const before = digestFor(ALPHA, { root }).digest;

  write(root, 'alpha/nested/deep.js', 'deep, edited\n');
  const afterEdit = digestFor(ALPHA, { root }).digest;
  assert.notEqual(afterEdit, before, 'an edit to a declared file did not move the tag');

  // A NEW file inside a declared directory is an input too — untracked code still ships.
  write(root, 'alpha/added.js', 'added\n');
  assert.notEqual(digestFor(ALPHA, { root }).digest, afterEdit);
});

test('touching an UNDECLARED file does not change the digest', () => {
  // THE property that lets the two halves roll independently. Getting this wrong — by hashing the
  // build context instead of the input set — makes every dispatcher edit roll every agent in the fleet and every
  // agent edit cost the ~94s gateway outage.
  const root = buildTree();
  const before = digestFor(ALPHA, { root }).digest;

  write(root, 'undeclared.txt', 'edited\n');
  write(root, 'shared/other.mjs', 'edited\n');    // same directory as a declared file
  write(root, 'beta/index.mjs', 'edited\n');      // declared by the OTHER image
  write(root, 'brand-new-service/index.js', 'a whole new thing\n');

  assert.equal(digestFor(ALPHA, { root }).digest, before);
});

test('the path is hashed, not only the content — moving a file is a new image', () => {
  const a = buildTree();
  const b = buildTree();
  fs.renameSync(path.join(b, 'alpha/nested/deep.js'), path.join(b, 'alpha/nested/renamed.js'));
  assert.notEqual(digestFor(ALPHA, { root: a }).digest, digestFor(ALPHA, { root: b }).digest);
});

test('framing prevents path/content collisions across file boundaries', () => {
  // Without length framing, ("alpha/ab", "c") and ("alpha/a", "bc") hash the same byte stream.
  const a = buildTree([['shared/seed.mjs', 's'], ['alpha/ab', 'c']]);
  const b = buildTree([['shared/seed.mjs', 's'], ['alpha/a', 'bc']]);
  assert.notEqual(digestFor(ALPHA, { root: a }).digest, digestFor(ALPHA, { root: b }).digest);
});

test('the executable bit is part of the digest', () => {
  // COPY preserves it, and git normalises it to 644/755, so it is both meaningful and stable.
  const root = buildTree();
  const before = digestFor(ALPHA, { root }).digest;
  fs.chmodSync(path.join(root, 'alpha/index.js'), 0o755);
  assert.notEqual(digestFor(ALPHA, { root }).digest, before);
});

test('symlinks hash their target and are not followed', () => {
  const root = buildTree();
  fs.symlinkSync('../shared/seed.mjs', path.join(root, 'alpha/link.mjs'));
  const before = digestFor(ALPHA, { root }).digest;
  fs.unlinkSync(path.join(root, 'alpha/link.mjs'));
  fs.symlinkSync('../shared/other.mjs', path.join(root, 'alpha/link.mjs'));
  assert.notEqual(digestFor(ALPHA, { root }).digest, before);
  // Following it would have hung here instead of hashing "self".
  fs.unlinkSync(path.join(root, 'alpha/link.mjs'));
  fs.symlinkSync('self', path.join(root, 'alpha/self'));
  assert.ok(digestFor(ALPHA, { root }).digest);
});

test('no timestamps: rewriting identical content leaves the digest alone', () => {
  const root = buildTree();
  const before = digestFor(ALPHA, { root }).digest;
  const abs = path.join(root, 'alpha/index.js');
  fs.writeFileSync(abs, fs.readFileSync(abs));
  fs.utimesSync(abs, new Date(0), new Date(0));
  assert.equal(digestFor(ALPHA, { root }).digest, before);
});

// ── exclusions ───────────────────────────────────────────────────────────────────────────────────

test('node_modules and .git are excluded even with no .dockerignore at all', () => {
  const root = buildTree();
  const before = digestFor(ALPHA, { root }).digest;
  write(root, 'alpha/node_modules/dep/index.js', 'vendored\n');
  write(root, 'alpha/nested/node_modules/dep/index.js', 'vendored deeper\n');
  write(root, 'alpha/.git/HEAD', 'ref: refs/heads/main\n');
  assert.equal(digestFor(ALPHA, { root }).digest, before);
  assert.ok(!resolveInputs(ALPHA, { root }).some((f) => f.includes('node_modules') || f.includes('.git')));
});

test('.dockerignore is honoured, and its patterns are NOT recursive by default', () => {
  // The non-recursive rule is the one that bites: docker/.dockerignore:5-7 writes `**/node_modules`
  // rather than `node_modules/` precisely because the bare form matches only the context root.
  const root = buildTree();
  write(root, '.dockerignore', ['# comment', '', '**/*.log', 'alpha/generated', 'nested'].join('\n'));
  const before = digestFor(ALPHA, { root }).digest;

  write(root, 'alpha/run.log', 'ignored\n');
  write(root, 'alpha/nested/run.log', 'ignored too — the pattern is recursive\n');
  write(root, 'alpha/generated/out.json', 'ignored: a whole pruned directory\n');
  assert.equal(digestFor(ALPHA, { root }).digest, before, '.dockerignore was not honoured');

  // `nested` matches only a top-level `nested`, so alpha/nested/deep.js is still an input.
  assert.ok(resolveInputs(ALPHA, { root }).includes('alpha/nested/deep.js'));
});

test('the .dockerignore of the image CONTEXT is the one that applies', () => {
  // The real pair differ here: the gateway builds from docker/ and the agent from docker/archie-runner/,
  // and those two .dockerignore files have different contents. Reading the wrong one silently
  // produces the wrong file set.
  const root = buildTree();
  write(root, '.dockerignore', 'alpha/nested\n');
  // Patterns in sub/.dockerignore are relative to sub/, so `alpha/index.js` excludes
  // sub/alpha/index.js, while the root-relative spelling of a path in the same file matches nothing.
  write(root, 'sub/.dockerignore', 'alpha/index.js\nsub/alpha/keep.js\n');
  const scoped = { name: 'scoped', context: 'sub', inputs: [{ path: 'sub/alpha', dir: true }] };
  write(root, 'sub/alpha/index.js', 'excluded by sub/.dockerignore\n');
  write(root, 'sub/alpha/keep.js', 'kept\n');
  assert.deepEqual(resolveInputs(scoped, { root }), ['sub/alpha/keep.js']);
  // …and the root .dockerignore still governs the root-context image.
  assert.ok(!resolveInputs(ALPHA, { root }).includes('alpha/nested/deep.js'));
});

test('dockerignore pattern semantics: negation, last match wins, ** spans segments', () => {
  const rules = parseDockerignore(['*.md', '!KEEP.md', '**/tmp', 'build/'].join('\n'));
  assert.equal(isIgnored(rules, 'README.md'), true);
  assert.equal(isIgnored(rules, 'KEEP.md'), false, 'later negation must win');
  assert.equal(isIgnored(rules, 'docs/README.md'), false, '* does not cross a slash');
  assert.equal(isIgnored(rules, 'tmp/x'), true, '**/ must also match at the root');
  assert.equal(isIgnored(rules, 'a/b/tmp/x'), true);
  assert.equal(isIgnored(rules, 'build'), true, 'a trailing slash is not part of the pattern');
  assert.equal(isIgnored(rules, 'build/out.js'), true, 'an ignored directory takes its whole tree');
  assert.equal(isIgnored(rules, 'src/index.js'), false);
});

// ── refusals ─────────────────────────────────────────────────────────────────────────────────────

test('a missing declared input is exit 3 and names the path', () => {
  const root = buildTree();
  fs.rmSync(path.join(root, 'shared/seed.mjs'));
  assert.throws(
    () => digestFor(ALPHA, { root }),
    (e) => e.exitCode === EXIT.PREFLIGHT && /shared\/seed\.mjs/.test(e.message),
  );
  // Optional inputs may be absent — the Dockerfile writes `package-lock.json*` for exactly this.
  const optional = { name: 'opt', context: '.', inputs: [{ path: 'alpha', dir: true }, { path: 'shared/seed.mjs', optional: true }] };
  assert.ok(digestFor(optional, { root }).digest);
});

test('an image whose inputs all resolve to nothing refuses rather than tagging an empty digest', () => {
  const root = buildTree();
  const empty = { name: 'empty', context: '.', inputs: [{ path: 'nowhere', dir: true, optional: true }] };
  assert.throws(() => digestFor(empty, { root }), (e) => e.exitCode === EXIT.PREFLIGHT);
});

test('an unknown image name is a usage error, not a silent empty digest', () => {
  assert.throws(() => digestFor('sidecar'), (e) => e.exitCode === EXIT.USAGE);
});

// ── the tag ──────────────────────────────────────────────────────────────────────────────────────

test('the tag is a valid ECR tag and cannot be mistaken for a hand-authored one', () => {
  const root = buildTree();
  const { tag, digest } = digestFor(ALPHA, { root });
  assert.match(tag, /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, 'ECR tags allow only [a-zA-Z0-9._-]');
  assert.ok(tag.length <= 128);
  assert.equal(tag, tagFor(digest));
  assert.equal(tag.length, TAG_PREFIX.length + SHORT_LENGTH);
  // Distinguishable from the tags in the Makefile today (archie-0.2.22, archie-0.2.6) and from a
  // git SHA, which is the other thing a bare hex tag would be read as.
  assert.ok(tag.startsWith(TAG_PREFIX));
  assert.ok(!/^archie-/.test(tag));
  assert.throws(() => tagFor('nothex'), (e) => e.exitCode === EXIT.USAGE);
});

// ── the real gateway/agent sets ──────────────────────────────────────────────────────────────────

test('the two declared sets overlap but differ — that difference is the feature', () => {
  const gateway = new Set(IMAGES.gateway.inputs.map((e) => e.path));
  const agent = new Set(IMAGES.agent.inputs.map((e) => e.path));

  assert.ok(gateway.has('archie-gateway/index.js') && !agent.has('archie-gateway/index.js'));
  assert.ok(agent.has('archie-runner/agentcore-pi') && !gateway.has('archie-runner/agentcore-pi'));
  // The intentional overlap: both images build the workspace seed and the cap→IAM map from the SAME
  // source so there is no mirrored implementation to drift (archie-gateway/Dockerfile:63-74).
  assert.ok(gateway.has('archie-runner/agentcore-pi/workspace-seed.mjs'));
  assert.ok(agent.has('archie-runner/agentcore-pi'), 'the agent declares that file via its directory');
  assert.notEqual(IMAGES.gateway.context, IMAGES.agent.context);
});

test('every declared input of both real images exists in this tree', () => {
  // This is a live check on the data, not on the algorithm: if someone deletes or renames a file the
  // Dockerfile still COPYs, the build breaks — and this fails first, with the path.
  for (const name of Object.keys(IMAGES)) {
    const files = resolveInputs(name);
    assert.ok(files.length > 0, `${name} resolved no inputs`);
    assert.ok(!files.some((f) => f.includes('/node_modules/')));
  }
  // …and the generated corpora under config-resolver are excluded by archie-runner/.dockerignore. They
  // are ~1400 of that package's ~1480 files and are rewritten by every hydrate run; digesting them
  // would roll every agent in the fleet for local output that never enters the image.
  const agentFiles = resolveInputs('agent');
  assert.ok(!agentFiles.some((f) => /config-resolver\/(ground-truth|resolved|resolved-ddb|items)\//.test(f)));
  assert.ok(agentFiles.includes('archie-runner/config-resolver/schema.mjs'));
});

test('the halves roll independently: a gateway-only edit leaves the agent digest alone', () => {
  // Cloned from the REAL declared sets (paths only, stub contents) so this exercises the actual
  // gateway/agent data, not a model of it — while staying independent of the repo's git state.
  const root = tmpRoot();
  for (const name of Object.keys(IMAGES)) {
    for (const file of resolveInputs(name)) write(root, file, `stub:${file}\n`);
  }

  const gw0 = digestFor('gateway', { root }).digest;
  const ag0 = digestFor('agent', { root }).digest;
  assert.notEqual(gw0, ag0);

  write(root, 'archie-gateway/turn-queue.js', 'edited\n');           // gateway-only
  assert.notEqual(digestFor('gateway', { root }).digest, gw0);
  assert.equal(digestFor('agent', { root }).digest, ag0, 'a dispatcher edit would have rolled every agent in the fleet');

  const gw1 = digestFor('gateway', { root }).digest;
  write(root, 'archie-runner/agentcore-pi/pi-adapter.mjs', 'edited\n');     // agent-only
  assert.notEqual(digestFor('agent', { root }).digest, ag0);
  assert.equal(digestFor('gateway', { root }).digest, gw1, 'an agent edit would have cost a ~94s gateway outage');

  const ag1 = digestFor('agent', { root }).digest;
  write(root, 'archie-runner/agentcore-pi/workspace-seed.mjs', 'edited\n'); // shared on purpose
  assert.notEqual(digestFor('gateway', { root }).digest, gw1);
  assert.notEqual(digestFor('agent', { root }).digest, ag1);
});

// ── modified-relative-to-HEAD ────────────────────────────────────────────────────────────────────

// Hermetic: no global or system git config, so a developer's core.excludesFile cannot decide whether
// an untracked fixture file is reported.
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};
const IDENTITY = ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false'];

/**
 * @param depth  how far BELOW the repository root the digest root sits. Default 2, because docker/
 *   is `infrastructure/infrastructure/docker` inside this repo and a depth of 0 hides a real bug:
 *   `git status --porcelain` prints paths relative to the REPOSITORY root while pathspecs are read
 *   relative to cwd, so at depth 0 the two happen to agree and every path lines up by accident.
 */
function gitTree(files = BASE, depth = 2) {
  const repo = tmpRoot();
  const root = depth === 0 ? repo : path.join(repo, ...Array.from({ length: depth }, (_, i) => `d${i}`));
  fs.mkdirSync(root, { recursive: true });
  for (const [rel, content] of files) write(root, rel, content);
  const run = (...args) => execFileSync('git', args, { cwd: repo, env: GIT_ENV, stdio: 'ignore' });
  run('init', '-q', '-b', 'main');
  run('add', '-A');
  run(...IDENTITY, 'commit', '-qm', 'fixture');
  return { root, repo, run: (...args) => execFileSync('git', args, { cwd: root, env: GIT_ENV, stdio: 'ignore' }) };
}

const opts = (root) => ({ root, gitEnv: GIT_ENV });

test('a committed tree reports no modified inputs', () => {
  const { root } = gitTree();
  const state = modifiedInputs(ALPHA, opts(root));
  assert.equal(state.git, true);
  assert.deepEqual(state.modified, []);
  assert.match(state.head, /^[0-9a-f]{7,}$/);
  assert.equal(dirtyWarning(ALPHA, opts(root)), null);
  assert.doesNotThrow(() => assertPure(ALPHA, opts(root)));
});

test('tracked, staged and untracked changes to declared inputs are all reported', () => {
  const { root, run } = gitTree();

  write(root, 'alpha/index.js', 'edited in the working tree\n');
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified, ['alpha/index.js']);

  // Staged is still "differs from HEAD" — `git add` does not make a tree reproducible from a commit.
  run('add', 'alpha/index.js');
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified, ['alpha/index.js']);

  // Untracked files inside a declared path count: they ship, and they are not in any commit.
  write(root, 'alpha/nested/brand-new.js', 'never committed\n');
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified,
    ['alpha/index.js', 'alpha/nested/brand-new.js']);

  const deep = write(root, 'shared/seed.mjs', 'edited\n');
  assert.ok(fs.existsSync(deep));
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified,
    ['alpha/index.js', 'alpha/nested/brand-new.js', 'shared/seed.mjs']);
});

test('git paths are repo-root-relative and must be translated, at any depth', () => {
  // The bug this pins: docker/ is `infrastructure/infrastructure/docker` inside this repo, so every
  // porcelain path arrives with that prefix while every declared input is docker-relative. Before
  // the translation, nothing ever matched — modified[] was always empty and `--pure` would have
  // passed happily on a dirty tree, which is the one thing it exists to refuse.
  for (const depth of [0, 1, 3]) {
    const { root } = gitTree(BASE, depth);
    write(root, 'alpha/index.js', 'edited\n');
    write(root, 'alpha/untracked.js', 'new\n');
    assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified,
      ['alpha/index.js', 'alpha/untracked.js'], `depth ${depth}`);
  }
});

test('modifications outside the image\'s declared inputs are NOT reported', () => {
  // Deliberate scope, plan §5: this is a large monorepo and a dirty file that cannot reach the image
  // has not changed the build. Warning on it would train people to ignore the message.
  const { root } = gitTree();
  write(root, 'undeclared.txt', 'edited\n');
  write(root, 'shared/other.mjs', 'edited\n');
  write(root, 'beta/index.mjs', 'edited — belongs to the other image\n');
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified, []);
  assert.deepEqual(modifiedInputs(BETA, opts(root)).modified, ['beta/index.mjs']);
});

test('a modified file that .dockerignore excludes is not a dirty input', () => {
  const { root } = gitTree([...BASE, ['.dockerignore', 'alpha/generated\n'], ['alpha/generated/out.json', '{}\n']]);
  write(root, 'alpha/generated/out.json', '{"regenerated":true}\n');
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified, []);
});

test('renames report both sides', () => {
  const { root, run } = gitTree();
  run('mv', 'alpha/index.js', 'alpha/entry.js');
  assert.deepEqual(modifiedInputs(ALPHA, opts(root)).modified, ['alpha/entry.js', 'alpha/index.js']);
});

test('--pure refuses with exit 5 and lists the files; the default path only warns', () => {
  const { root } = gitTree();
  write(root, 'alpha/index.js', 'edited\n');
  write(root, 'shared/seed.mjs', 'edited\n');

  assert.throws(() => assertPure(ALPHA, opts(root)), (e) => (
    e.exitCode === EXIT.REFUSED && /alpha\/index\.js/.test(e.detail) && /shared\/seed\.mjs/.test(e.detail)
  ));

  // The warning is one string for output.warn(), which prefixes "WARNING: " — reference §2.27.
  const warning = dirtyWarning(ALPHA, opts(root));
  const lines = warning.split('\n');
  assert.equal(lines[0], 'skipped --pure mode and working tree is dirty');
  assert.equal(lines[1], '         alpha inputs modified: alpha/index.js, shared/seed.mjs');
  assert.match(lines[2], /^ {9}image tag reflects the working tree, not HEAD \([0-9a-f]{7,}\)$/);
});

test('a dirty input changes the tag, so a dirty deploy cannot masquerade as the committed one', () => {
  const { root } = gitTree();
  const clean = digestFor(ALPHA, { root }).tag;
  write(root, 'alpha/index.js', 'uncommitted\n');
  assert.notEqual(digestFor(ALPHA, { root }).tag, clean);
});

test('without git the digest still works, and --pure refuses rather than guessing', () => {
  // "I could not check" is not "it is clean". --pure is the CI setting and the setting for a release
  // meant to be reproducible from a commit.
  const root = buildTree();
  assert.ok(digestFor(ALPHA, { root }).digest, 'the digest must never need git');
  const state = modifiedInputs(ALPHA, opts(root));
  assert.deepEqual(state, { image: 'alpha', git: false, head: null, modified: [] });
  assert.equal(dirtyWarning(ALPHA, opts(root)), null);
  assert.throws(() => assertPure(ALPHA, opts(root)), (e) => e.exitCode === EXIT.REFUSED);
});

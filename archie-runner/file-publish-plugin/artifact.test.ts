import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";

import {
  allowedSourceRoots,
  detectContentType,
  publishArtifact,
  sanitizeFilename,
  type ArtifactStore,
} from "./artifact.ts";

// No AWS SDK anywhere in this file — that is the point of the artifact.ts/index.ts split, and it is
// why this suite can run in `npm run check` with nothing installed.

type Put = { key: string; body: Buffer; contentType: string };

function fakeStore(overrides: Partial<ArtifactStore> = {}): ArtifactStore & { puts: Put[] } {
  const puts: Put[] = [];
  return {
    puts,
    async put(key, body, contentType) {
      puts.push({ key, body, contentType });
    },
    async presign(key) {
      return `https://s3.example/${key}?X-Amz-Signature=deadbeef`;
    },
    ...overrides,
  } as ArtifactStore & { puts: Put[] };
}

const deps = (store: ArtifactStore, extra: Record<string, unknown> = {}) => ({
  bucket: "archie-artifacts-000000000000",
  agentName: "dm-u0abc",
  store,
  backupDir: null as string | null,
  ...extra,
});

test("sanitizeFilename collapses traversal and unsafe characters", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("/absolute/report.html"), "report.html");
  assert.equal(sanitizeFilename("a b/c;d.csv"), "c_d.csv");
  assert.equal(sanitizeFilename("x".repeat(400)).length, 200);
  assert.equal(sanitizeFilename(undefined), "");
});

test("detectContentType maps known extensions and falls back to octet-stream", () => {
  assert.equal(detectContentType("report.html"), "text/html");
  assert.equal(detectContentType("EXPORT.CSV"), "text/csv");
  assert.equal(detectContentType("archive.tar"), "application/octet-stream");
});

test("allowedSourceRoots follows the Pi workspace, not OpenClaw's /efs", () => {
  assert.deepEqual(allowedSourceRoots({ EFS_DIR: "/mnt/efs" } as NodeJS.ProcessEnv), ["/mnt/efs", "/tmp"]);
  assert.deepEqual(
    allowedSourceRoots({ PI_WORKSPACE: "/ws", EFS_DIR: "/mnt/efs" } as NodeJS.ProcessEnv),
    ["/ws", "/tmp"],
  );
});

test("inline content is uploaded under the agent's own prefix and presigned", async () => {
  const store = fakeStore();
  const res = await publishArtifact({ filename: "report.html", content: "<h1>hi</h1>" }, deps(store));

  assert.equal(res.isError, undefined);
  assert.deepEqual(
    store.puts.map((p) => [p.key, p.contentType, p.body.toString()]),
    [["dm-u0abc/report.html", "text/html", "<h1>hi</h1>"]],
  );
  assert.match(res.content[0]!.text, /https:\/\/s3\.example\/dm-u0abc\/report\.html/);
  assert.match(res.content[0]!.text, /valid 24h/);
});

test("a crafted filename cannot address a key outside the prefix", async () => {
  const store = fakeStore();
  await publishArtifact({ filename: "../other-agent/steal.html", content: "x" }, deps(store));
  assert.equal(store.puts[0]!.key, "dm-u0abc/steal.html");
});

test("content_type overrides the extension mapping", async () => {
  const store = fakeStore();
  await publishArtifact(
    { filename: "data.txt", content: "a,b", content_type: "text/csv" },
    deps(store),
  );
  assert.equal(store.puts[0]!.contentType, "text/csv");
});

test("content and source_path are mutually exclusive, and one is required", async () => {
  const store = fakeStore();
  const both = await publishArtifact({ filename: "f.txt", content: "x", source_path: "/tmp/f" }, deps(store));
  assert.equal(both.isError, true);
  assert.match(both.content[0]!.text, /not both/);

  const neither = await publishArtifact({ filename: "f.txt" }, deps(store));
  assert.equal(neither.isError, true);
  assert.match(neither.content[0]!.text, /must be provided/);

  assert.equal(store.puts.length, 0);
});

test("an unconfigured bucket or agent name is an error result, not an upload", async () => {
  const store = fakeStore();
  const noBucket = await publishArtifact({ filename: "f.txt", content: "x" }, deps(store, { bucket: undefined }));
  assert.equal(noBucket.isError, true);
  assert.match(noBucket.content[0]!.text, /ARTIFACTS_S3_BUCKET/);

  const noAgent = await publishArtifact({ filename: "f.txt", content: "x" }, deps(store, { agentName: undefined }));
  assert.equal(noAgent.isError, true);
  assert.match(noAgent.content[0]!.text, /AGENT_NAME/);

  assert.equal(store.puts.length, 0);
});

test("a filename that sanitizes to nothing is rejected", async () => {
  const store = fakeStore();
  const res = await publishArtifact({ filename: "/", content: "x" }, deps(store));
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /Invalid filename/);
  assert.equal(store.puts.length, 0);
});

test("inline content over 50 MB is rejected before any upload", async () => {
  const store = fakeStore();
  const res = await publishArtifact({ filename: "big.txt", content: "x".repeat(50 * 1024 * 1024 + 1) }, deps(store));
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /exceeds the 50 MB limit/);
  assert.equal(store.puts.length, 0);
});

test("source_path is read when inside an allowed root", async () => {
  const ws = await mkdtemp(nodePath.join(tmpdir(), "fp-ws-"));
  await writeFile(nodePath.join(ws, "out.csv"), "a,b\n1,2\n");
  const store = fakeStore();

  const res = await publishArtifact(
    { filename: "out.csv", source_path: nodePath.join(ws, "out.csv") },
    deps(store, { roots: [ws] }),
  );

  assert.equal(res.isError, undefined);
  assert.equal(store.puts[0]!.body.toString(), "a,b\n1,2\n");
  assert.equal(store.puts[0]!.contentType, "text/csv");
});

test("source_path outside every allowed root is refused", async () => {
  const ws = await mkdtemp(nodePath.join(tmpdir(), "fp-ws-"));
  const outside = await mkdtemp(nodePath.join(tmpdir(), "fp-secret-"));
  await writeFile(nodePath.join(outside, "token.json"), "SECRET");
  const store = fakeStore();

  const res = await publishArtifact(
    { filename: "token.json", source_path: nodePath.join(outside, "token.json") },
    deps(store, { roots: [ws] }),
  );

  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /must be inside the agent workspace or \/tmp/);
  assert.equal(store.puts.length, 0);
});

test("a symlink out of the workspace is refused — realpath resolves before the check", async () => {
  const ws = await mkdtemp(nodePath.join(tmpdir(), "fp-ws-"));
  const outside = await mkdtemp(nodePath.join(tmpdir(), "fp-secret-"));
  await writeFile(nodePath.join(outside, "token.json"), "SECRET");
  await symlink(nodePath.join(outside, "token.json"), nodePath.join(ws, "innocent.json"));
  const store = fakeStore();

  const res = await publishArtifact(
    { filename: "innocent.json", source_path: nodePath.join(ws, "innocent.json") },
    deps(store, { roots: [ws] }),
  );

  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /must be inside the agent workspace/);
  assert.equal(store.puts.length, 0);
});

test("a DIRECTORY source_path is an error result, not a thrown turn", async () => {
  // realpath and stat both succeed on a directory, so this reached readFile and threw EISDIR —
  // outside the upload try, so it escaped as an exception and failed the whole turn instead of
  // telling the model to pick a file.
  const ws = await mkdtemp(nodePath.join(tmpdir(), "fp-ws-"));
  await mkdir(nodePath.join(ws, "reports"));
  const store = fakeStore();

  const res = await publishArtifact(
    { filename: "reports.zip", source_path: nodePath.join(ws, "reports") },
    deps(store, { roots: [ws] }),
  );

  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /must be a file.*is a directory/);
  assert.equal(store.puts.length, 0);
});

test("an unreadable source_path is an error result, not a thrown turn", async () => {
  // Same class as the directory above: anything stat or read can raise — EACCES, or a file removed
  // between the two — must come back as a result the model can act on.
  const ws = await mkdtemp(nodePath.join(tmpdir(), "fp-ws-"));
  const target = nodePath.join(ws, "locked.txt");
  await writeFile(target, "secret");
  await chmod(target, 0o000);
  const store = fakeStore();

  const res = await publishArtifact(
    { filename: "locked.txt", source_path: target },
    deps(store, { roots: [ws] }),
  );

  await chmod(target, 0o600); // so the tmpdir can be cleaned up
  // root ignores the mode bits, so in a container-as-root run this legitimately succeeds; the
  // assertion is only that it never THROWS, which is the property under test.
  if (res.isError) assert.match(res.content[0]!.text, /cannot read source_path/);
  else assert.equal(store.puts[0]!.body.toString(), "secret");
});

test("a prefix that merely starts with a root's name is not inside it", async () => {
  const store = fakeStore();
  const res = await publishArtifact({ filename: "f.txt", source_path: "/tmpfoo/f.txt" }, deps(store, { roots: ["/tmp"] }));
  assert.equal(res.isError, true);
  assert.equal(store.puts.length, 0);
});

test("a missing source_path says so rather than throwing", async () => {
  const store = fakeStore();
  const res = await publishArtifact({ filename: "gone.txt", source_path: "/tmp/definitely-not-here-9f2" }, deps(store));
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /not found/);
});

test("the workspace backup is written, and a failing backup does not fail the publish", async () => {
  const ws = await mkdtemp(nodePath.join(tmpdir(), "fp-ws-"));
  const backupDir = nodePath.join(ws, "files");
  const store = fakeStore();

  const ok = await publishArtifact({ filename: "r.md", content: "# hi" }, deps(store, { backupDir }));
  assert.equal(ok.isError, undefined);
  assert.equal(await readFile(nodePath.join(backupDir, "r.md"), "utf8"), "# hi");

  // A backup path that cannot be created (a FILE where the directory should be) must not stop the
  // upload — the OpenClaw plugin's "EFS backup is nice-to-have" property.
  const blocked = nodePath.join(ws, "blocked");
  await mkdir(nodePath.dirname(blocked), { recursive: true });
  await writeFile(blocked, "not a directory");
  const warnings: string[] = [];
  const res = await publishArtifact(
    { filename: "r2.md", content: "# hi" },
    deps(store, { backupDir: nodePath.join(blocked, "files"), logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} } }),
  );
  assert.equal(res.isError, undefined);
  assert.equal(store.puts.at(-1)!.key, "dm-u0abc/r2.md");
  assert.equal(warnings.length, 1);
});

test("an S3 failure names the error rather than reporting an opaque failure", async () => {
  const store = fakeStore({
    put: async () => {
      const err = new Error("User is not authorized to perform: s3:PutObject");
      err.name = "AccessDenied";
      throw err;
    },
  });
  const res = await publishArtifact({ filename: "f.txt", content: "x" }, deps(store));
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /AccessDenied: User is not authorized/);
});

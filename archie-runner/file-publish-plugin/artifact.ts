import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import nodePath from "node:path";

// The whole of `save_artifact`, with NO AWS import.
//
// The split from index.ts is the one cron-tool-core.mjs makes for the same reason: everything
// security-relevant here — the filename namespace, the source_path allow-list, the size caps — is
// pure, and a pure module is testable in `npm run check`, which is offline and installs nothing.
// index.ts is the shell: it reads env, builds the real S3-backed store, and calls publishArtifact.
//
// PORTED from the OpenClaw plugin of the same name (branch dispatcher-agent-owner-support), with
// every production fix it accumulated folded in. Two of its fixes are GONE rather than ported,
// because they were artefacts of shelling out to the `aws` CLI:
//
//   · scrubbing AWS_PROFILE/AWS_DEFAULT_PROFILE (the CLI honoured a profile the SDK ignores);
//   · parsing stderr/stdout off an execFile error to recover "Command failed".
//
// The image does ship `aws` (the shell skills need it), so using it here was possible — but the
// SDK is what demo-cache-plugin already does for S3, it needs no subprocess, and it removes both
// of those classes of bug rather than re-importing them.

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
export const PRESIGN_EXPIRY = 86400; // 24 hours

const CONTENT_TYPE_MAP: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".xml": "application/xml",
  ".zip": "application/zip",
};

/**
 * Collapse a caller-supplied name to a single basename in the flat [a-zA-Z0-9._-] namespace.
 *
 * This is the ONLY thing between a crafted filename and an object key outside the agent's prefix,
 * and the gateway's files-store.js applies the byte-identical rule to every name that comes back
 * out of a Slack payload. If one side changes, change both.
 */
export function sanitizeFilename(raw: unknown): string {
  const basename = nodePath.basename(String(raw ?? ""));
  return basename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200);
}

export function detectContentType(filename: string): string {
  const ext = nodePath.extname(filename).toLowerCase();
  return CONTENT_TYPE_MAP[ext] ?? "application/octet-stream";
}

/**
 * The roots a `source_path` may live under.
 *
 * Under Pi the agent workspace IS the EFS mount root (pi-entrypoint.mjs: "the agent workspace IS
 * the EFS mount root (flat)"), so the OpenClaw version's three roots — workspace, /tmp, /efs —
 * collapse to two. The EFS root is per-agent (the access point IS the isolation), so allowing all
 * of it exposes nothing but this agent's own files.
 */
export function allowedSourceRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const workspace = env.PI_WORKSPACE || env.EFS_DIR || "/tmp/pi-ws";
  return [workspace, "/tmp"];
}

/**
 * Resolve each root through realpath, keeping the literal value when it does not exist (a workspace
 * that is not mounted yet must narrow the allow-list, never widen it).
 */
async function realpathAll(roots: string[]): Promise<string[]> {
  return Promise.all(roots.map((root) => realpath(root).catch(() => root)));
}

/** Minimal seam over S3 so `publishArtifact` is testable without a network or a credential chain. */
export interface ArtifactStore {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  presign(key: string): Promise<string>;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const errorResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export type PublishArgs = {
  filename?: string;
  content?: string;
  source_path?: string;
  content_type?: string;
};

export type PublishDeps = {
  bucket?: string;
  agentName?: string;
  store: ArtifactStore;
  /** Defaults to allowedSourceRoots(); passed explicitly by tests. */
  roots?: string[];
  /** Defaults to <workspace>/files; `null` disables the backup. */
  backupDir?: string | null;
  logger?: { info(msg: string): void; warn(msg: string): void; error(msg: string): void };
};

/**
 * Publish one artifact: validate, back up, PUT, presign.
 *
 * Every failure is a tool RESULT rather than a throw: the model can read an `isError` result and
 * correct itself (wrong filename, file too big, path outside the workspace), whereas a throw is an
 * opaque turn failure it cannot act on.
 */
export async function publishArtifact(args: PublishArgs, deps: PublishDeps): Promise<ToolResult> {
  const { bucket, agentName, store, logger } = deps;
  const { filename: rawFilename, content, source_path: sourcePath, content_type: contentTypeOverride } = args;

  if (!bucket) {
    return errorResult("Error: ARTIFACTS_S3_BUCKET is not configured. File publishing is not available.");
  }
  if (!agentName) {
    return errorResult("Error: AGENT_NAME is not configured. Cannot determine upload prefix.");
  }
  if (!content && !sourcePath) {
    return errorResult("Error: Either 'content' or 'source_path' must be provided.");
  }
  if (content && sourcePath) {
    return errorResult("Error: Provide either 'content' or 'source_path', not both.");
  }

  const filename = sanitizeFilename(rawFilename);
  if (!filename) {
    return errorResult("Error: Invalid filename after sanitization.");
  }

  const contentType = contentTypeOverride || detectContentType(filename);
  // The prefix is AGENT_NAME — the agent's own scope id, from its runtime env. It is never
  // caller-supplied, which is what makes the IAM statement on the derived role (s3:PutObject on
  // <bucket>/<agentId>/*) an actual boundary rather than a formality.
  const key = `${agentName}/${filename}`;

  let body: Buffer;
  if (content !== undefined && content !== null && content !== "") {
    body = Buffer.from(content, "utf8");
    if (body.length > MAX_FILE_SIZE) {
      return errorResult(
        `Error: Content size (${(body.length / 1024 / 1024).toFixed(1)} MB) exceeds the 50 MB limit.`,
      );
    }
  } else {
    // Restrict source_path to the agent's own areas: its workspace (== the EFS mount root) and the
    // per-session /tmp. Without this, any absolute path in the container — another plugin's token
    // store, a secret a skill wrote down — could be copied out to a 24h public presigned URL.
    // realpath resolves symlinks and ".." BEFORE the check, so neither can walk out of a root.
    let resolved: string;
    try {
      resolved = await realpath(String(sourcePath));
    } catch {
      return errorResult(`Error: source_path not found: ${sourcePath}`);
    }
    // The ROOTS are realpath'd too, not just the source. A root reached through a symlink (macOS's
    // /tmp → /private/tmp is the everyday case; an EFS_DIR that is a link is the one that would bite
    // in production) otherwise never matches the resolved path, and every source_path under it is
    // refused with a message saying it is outside the workspace it is plainly inside.
    const roots = await realpathAll(deps.roots ?? allowedSourceRoots());
    const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + nodePath.sep));
    if (!allowed) {
      return errorResult(`Error: source_path must be inside the agent workspace or /tmp. Got: ${sourcePath}`);
    }
    // A DIRECTORY IS NOT A FILE, and saying so beats letting readFile throw.
    //
    // realpath and stat both succeed on a directory, so without this the read reached `readFile` and
    // threw EISDIR — outside the try below, so it escaped as an exception and failed the whole TURN
    // rather than returning a result the model can act on. `save_artifact("report", "/tmp/reports")`
    // is an ordinary mistake for a model to make, and the recoverable answer is "that is a
    // directory", not a dead turn. Sockets, FIFOs and devices take the same path for the same reason.
    let srcStat;
    try {
      srcStat = await stat(resolved);
    } catch (err) {
      return errorResult(`Error: cannot read source_path ${sourcePath}: ${(err as Error).message}`);
    }
    if (!srcStat.isFile()) {
      return errorResult(
        `Error: source_path must be a file. ${sourcePath} is a ${srcStat.isDirectory() ? 'directory' : 'special file'}.`,
      );
    }
    if (srcStat.size > MAX_FILE_SIZE) {
      return errorResult(
        `Error: File size (${(srcStat.size / 1024 / 1024).toFixed(1)} MB) exceeds the 50 MB limit.`,
      );
    }
    // Guarded for the same reason as the stat: an unreadable file (EACCES, or a file deleted between
    // the stat and the read) is a tool error the model can report, not a turn failure.
    try {
      body = await readFile(resolved);
    } catch (err) {
      return errorResult(`Error: cannot read source_path ${sourcePath}: ${(err as Error).message}`);
    }
  }

  // Keep a copy where the agent can find its own output again — the OpenClaw plugin's /efs/files
  // backup, at the Pi path. Best-effort: a full or not-yet-mounted EFS must not fail a publish that
  // S3 would have accepted.
  const backupDir =
    deps.backupDir === undefined ? nodePath.join(allowedSourceRoots()[0] as string, "files") : deps.backupDir;
  if (backupDir) {
    try {
      await mkdir(backupDir, { recursive: true });
      await writeFile(nodePath.join(backupDir, filename), body);
    } catch (err) {
      logger?.warn(`file-publish-plugin: workspace backup failed: ${(err as Error).message}`);
    }
  }

  try {
    await store.put(key, body, contentType);
    const url = await store.presign(key);
    logger?.info(`file-publish-plugin: published ${key} (${body.length} bytes, ${contentType})`);
    return {
      content: [
        {
          type: "text",
          text: [
            `File published successfully.`,
            ``,
            `**Filename:** ${filename}`,
            `**Content-Type:** ${contentType}`,
            `**Presigned URL (valid 24h):** ${url}`,
            ``,
            `Share this URL with the user — anyone with the link can access it for 24 hours.`,
            `After 24 hours, a fresh URL can be generated from the Files tab in the App Home.`,
          ].join("\n"),
        },
      ],
    };
  } catch (err) {
    // The SDK's errors carry a useful `name` (AccessDenied, NoSuchBucket, …), so say both rather
    // than the bare message — for a credential failure that is often just "Could not load
    // credentials from any providers", which names nothing. This is the SDK-shaped replacement for
    // the OpenClaw fix that parsed the CLI's stderr.
    const e = err as { name?: string; message?: string };
    const message = [e?.name, e?.message].filter(Boolean).join(": ") || String(err);
    logger?.error(`file-publish-plugin: save_artifact failed for ${key}: ${message}`);
    return errorResult(`Error publishing file: ${message}`);
  }
}

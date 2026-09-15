import { definePluginEntry } from "../plugin-sdk/plugin-entry.mjs";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { PRESIGN_EXPIRY, publishArtifact, type ArtifactStore, type PublishArgs } from "./artifact.ts";

// File-publish plugin — the shell around artifact.ts.
//
// Registers a single tool, `save_artifact`, that agents call to persist content (HTML reports, CSV
// exports, SVG diagrams, …) and get a shareable presigned URL (24h TTL):
//
//   1. Resolve the bytes (inline `content`, or an allow-listed `source_path` off disk)
//   2. Back them up to <workspace>/files/<filename>, so the agent can find its own output again
//   3. PUT to s3://<ARTIFACTS_S3_BUCKET>/<AGENT_NAME>/<filename>
//   4. Presign a GET (24h) and hand the URL back
//
// Steps 1-4 live in artifact.ts, which imports no AWS SDK and is therefore covered by the offline
// `npm run check`. This file holds only what needs the SDK and the environment.
//
// Config is entirely env, read PER CALL rather than at register time:
//   ARTIFACTS_S3_BUCKET  the bucket (Terraform → dispatcher env → runtimeEnv → here)
//   AGENT_NAME           the agent's SCOPE id; it is the S3 key prefix, and it is the same id the
//                        gateway's Files tab lists under
//   EFS_DIR/PI_WORKSPACE the agent workspace, which under Pi IS the EFS mount root
//   AWS_REGION           credentials and region come from the runtime's derived role

export function createS3ArtifactStore(bucket: string, region: string): ArtifactStore {
  // Credentials come from the default provider chain — the AgentCore runtime's derived role, whose
  // S3 statement is scoped to this agent's own prefix (derive-exec-role.mjs).
  const client = new S3Client({ region });
  return {
    async put(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
    },
    presign(key) {
      return getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: PRESIGN_EXPIRY });
    },
  };
}

export default definePluginEntry({
  id: "file-publish-plugin",
  name: "File Publish",
  description: "Uploads files to S3 and returns presigned URLs for sharing.",

  register(api) {
    if (!globalThis.__filePublishPluginInited) {
      globalThis.__filePublishPluginInited = true;
      const bucket = process.env.ARTIFACTS_S3_BUCKET;
      const agentName = process.env.AGENT_NAME;
      // Warn, but still register: refusing to register would hide a misconfiguration behind "tool
      // not found" instead of an error result that says which env var is missing.
      if (!bucket) {
        api.logger.warn("file-publish-plugin: ARTIFACTS_S3_BUCKET not set — save_artifact will error at call time");
      }
      if (!agentName) {
        api.logger.warn("file-publish-plugin: AGENT_NAME not set — save_artifact will error at call time");
      }
      if (bucket && agentName) {
        api.logger.info(`file-publish-plugin: ready (bucket=${bucket}, agent=${agentName})`);
      }
    }

    api.registerTool(() => ({
      name: "save_artifact",
      // Read by Pi's PEP (pi-adapter builds toolCaps from every tool declaring `capability`).
      // BASELINE — every agent has it, as every agent did under OpenClaw. What stops one agent
      // reaching another's files is the IAM prefix on its derived role, not withholding the tool.
      capability: "files.publish",
      description:
        "Save a file (HTML report, CSV export, diagram, etc.) and get a shareable URL. " +
        "The URL is valid for 24 hours and accessible to anyone with the link. " +
        "Provide either `content` (for text-based files) or `source_path` (for existing files on disk), not both.",
      parameters: {
        type: "object" as const,
        properties: {
          filename: {
            type: "string" as const,
            description:
              "Output filename, e.g. 'report.html', 'export.csv'. " +
              "Will be sanitized (unsafe characters replaced with underscores).",
          },
          content: {
            type: "string" as const,
            description:
              "File content as a string. Use for text-based files (HTML, JSON, CSV, SVG, Markdown). " +
              "Mutually exclusive with source_path.",
          },
          source_path: {
            type: "string" as const,
            description:
              "Absolute path to an existing file on disk to publish. Must be inside your workspace or /tmp. " +
              "Mutually exclusive with content.",
          },
          content_type: {
            type: "string" as const,
            description: "MIME type override (e.g. 'text/html'). Auto-detected from file extension if omitted.",
          },
        },
        required: ["filename"] as const,
      },
      annotations: {
        title: "Save Artifact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },

      // execute(toolCallId, args) — args is the SECOND parameter. The OpenClaw plugin shipped with
      // it first and every call failed; keep the signature as it is.
      execute: async (_toolCallId: string, args: Record<string, unknown>) => {
        const bucket = process.env.ARTIFACTS_S3_BUCKET;
        const region =
          process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? process.env.REGION ?? "us-east-1";
        return publishArtifact(args as PublishArgs, {
          bucket,
          agentName: process.env.AGENT_NAME,
          // Built per call, and only when there is a bucket: constructing an S3Client for a config
          // that cannot work would turn a clear "ARTIFACTS_S3_BUCKET is not configured" result into
          // an SDK error about an empty bucket name. publishArtifact rejects before touching it.
          store: bucket ? createS3ArtifactStore(bucket, region) : unconfiguredStore,
          logger: api.logger,
        });
      },
    }));
  },
});

// Never reached — publishArtifact returns the "not configured" result before any store call.
const unconfiguredStore: ArtifactStore = {
  put: async () => {
    throw new Error("file-publish-plugin: no artifacts bucket configured");
  },
  presign: async () => {
    throw new Error("file-publish-plugin: no artifacts bucket configured");
  },
};

declare global {
  // eslint-disable-next-line no-var
  var __filePublishPluginInited: boolean | undefined;
}

import { definePluginEntry } from "../plugin-sdk/plugin-entry.mjs";
import { mkdir, unlink } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import nodePath from "node:path";

// Slack-send plugin.
//
// Registers a single tool — `slack_send` — that agents call to post a
// message to Slack. The call goes to the clawdbot dispatcher's
// internal HTTP proxy, NOT directly to api.slack.com: per-agent
// containers never hold Slack tokens, so only the dispatcher can talk to
// the Slack Web API.
//
// Configured entirely from env vars so the plugin's config block in
// openclaw.config.js can be empty:
//
//   SLACK_PROXY_URL           https://dispatcher.{domain}
//   DISPATCHER_SHARED_SECRET  shared secret used as an auth header
//
// The matching /hooks/slack inbound path + transform (which puts channel
// and threadTs into meta.slack) live in this repo under ../; this plugin
// is the outbound counterpart. Together they form the full dispatcher
// transport layer for bot↔user conversation. Connector's `slack` toolkit
// stays for agent-initiated actions in other channels and is orthogonal
// to this.

type SlackApiResponse = {
  ok?: boolean;
  error?: string;
  ts?: string;
  channel?: string;
};

export default definePluginEntry({
  id: "slack-reply-plugin",
  name: "Slack Reply",
  description: "Posts Slack replies via the clawdbot dispatcher.",

  register(api) {
    // OpenClaw sets SLACK_PROXY_URL; under Pi/AgentCore pi-entrypoint resolves the same host as
    // DISPATCHER_BASE_URL at boot. Accept either so neither runtime needs a bespoke env var.
    const proxyUrl = process.env.SLACK_PROXY_URL || process.env.DISPATCHER_BASE_URL;
    const secret = process.env.DISPATCHER_SHARED_SECRET;

    // Warn once at init if either env var is missing. We don't refuse
    // to register the tool — that would hide the agent's failure mode
    // behind "tool not found" instead of a clear runtime error.
    if (!globalThis.__slackReplyPluginInited) {
      globalThis.__slackReplyPluginInited = true;
      if (!proxyUrl) {
        api.logger.warn(
          "slack-reply-plugin: SLACK_PROXY_URL not set — slack_send will error at call time",
        );
      }
      if (!secret) {
        api.logger.warn(
          "slack-reply-plugin: DISPATCHER_SHARED_SECRET not set — slack_send will error at call time",
        );
      }
      if (proxyUrl && secret) {
        api.logger.info(`slack-reply-plugin: ready — proxy=${proxyUrl}`);
      }
    }

    const MAX_INLINE_TEXT_BYTES = 100 * 1024; // 100KB — inline text truncation
    const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB — inline image cap
    const MAX_INLINE_FILE_BYTES = 10 * 1024 * 1024; // 10MB — inline download cap
    const MAX_DISK_FILE_BYTES = 100 * 1024 * 1024; // 100MB — save-to-disk cap


    function textResult(text: string) {
      return { content: [{ type: "text" as const, text }] };
    }

    api.registerTool(() => ({
      name: "slack_download_file",
      // Not baseline — default-deny under Pi until someone grants it deliberately.
      capability: "slack.files",
      description:
        "Download a file attachment shared in the current Slack conversation. " +
        "Use the ref value from the Attachments section of the incoming message — " +
        "pass it exactly as shown. Only files shared in this conversation can be downloaded. " +
        "By default, small text files and images are returned inline. " +
        "Pass save_to_path to save the file to disk instead (required for large or binary files).",
      parameters: {
        type: "object",
        required: ["ref"],
        additionalProperties: false,
        properties: {
          ref: {
            type: "string",
            description:
              "The opaque download reference from the Attachments section.",
          },
          save_to_path: {
            type: "string",
            description:
              "Save the file to this path instead of returning contents inline. " +
              "Use for large files, binary files, or when you need to process the file later. " +
              "Parent directories are created automatically. " +
              "If omitted, small text/image files are returned inline; other types require this parameter.",
          },
        },
      },
      execute: async (_toolCallId: string, args: Record<string, unknown>) => {
        const ref = args?.ref as string | undefined;
        const saveToPath = args?.save_to_path as string | undefined;

        if (!ref) {
          throw new Error("slack_download_file: 'ref' parameter is required");
        }
        if (!proxyUrl) {
          throw new Error(
            "slack_download_file: SLACK_PROXY_URL is not set in the container env",
          );
        }
        if (!secret) {
          throw new Error(
            "slack_download_file: DISPATCHER_SHARED_SECRET is not set in the container env",
          );
        }

        const url = `${proxyUrl}/files/download/${encodeURIComponent(ref)}`;
        api.logger.info(
          `slack_download_file: GET ${url.slice(0, 80)}…${saveToPath ? ` → ${saveToPath}` : " (inline)"}`,
        );

        let res: Response;
        try {
          res = await fetch(url, {
            headers: { "x-dispatcher-secret": secret },
          });
        } catch (err) {
          api.logger.error(`slack_download_file: fetch failed — ${err}`);
          throw err;
        }

        if (res.status === 400) {
          return textResult(
            "Invalid download reference — the ref may be corrupted. Check that you copied it exactly from the Attachments section.",
          );
        }
        if (res.status === 403) {
          return textResult(
            "Download reference has expired or is invalid. Files can only be downloaded within 1 hour of being shared.",
          );
        }
        if (res.status === 404) {
          return textResult(
            "File not found — it may have been deleted from Slack.",
          );
        }
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const msg = `slack_download_file: dispatcher returned ${res.status} — ${body.slice(0, 200)}`;
          api.logger.error(msg);
          throw new Error(msg);
        }

        const contentType =
          res.headers.get("content-type") || "application/octet-stream";
        const contentLength = parseInt(
          res.headers.get("content-length") || "0",
          10,
        );
        const disposition = res.headers.get("content-disposition") || "";
        const filenameMatch = disposition.match(/filename="([^"]+)"/);
        const filename = filenameMatch?.[1] || "attachment";

        // ── Save to disk (streaming) ──
        if (saveToPath) {
          if (contentLength > MAX_DISK_FILE_BYTES) {
            return textResult(
              `File "${filename}" is too large (${Math.round(contentLength / 1024 / 1024)}MB, limit 100MB).`,
            );
          }
          if (!res.body) {
            throw new Error("slack_download_file: response has no body to stream");
          }

          await mkdir(nodePath.dirname(saveToPath), { recursive: true });
          const nodeStream = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
          const fileStream = createWriteStream(saveToPath);
          let bytesWritten = 0;

          const counter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
              bytesWritten += chunk.length;
              if (bytesWritten > MAX_DISK_FILE_BYTES) {
                callback(new Error(`File exceeds 100MB limit (${Math.round(bytesWritten / 1024 / 1024)}MB)`));
                return;
              }
              callback(null, chunk);
            },
          });

          try {
            await pipeline(nodeStream, counter, fileStream);
          } catch (err) {
            await unlink(saveToPath).catch(() => {});
            if (err instanceof Error && err.message.includes("exceeds 100MB limit")) {
              return textResult(
                `File "${filename}" is too large (over 100MB limit).`,
              );
            }
            api.logger.error(`slack_download_file: stream failed — ${err}`);
            throw new Error(
              `slack_download_file: failed to save to ${saveToPath}: ${err}`,
            );
          }
          const sizeKB = Math.round(bytesWritten / 1024);
          api.logger.info(
            `slack_download_file: saved "${filename}" (${sizeKB}KB) → ${saveToPath}`,
          );
          return textResult(
            `Saved "${filename}" (${sizeKB}KB, ${contentType}) to ${saveToPath}`,
          );
        }

        // ── Inline: buffer into memory ──
        if (contentLength > MAX_INLINE_FILE_BYTES) {
          return textResult(
            `File "${filename}" is too large (${Math.round(contentLength / 1024 / 1024)}MB) for inline display. ` +
              "Try again with save_to_path to save to disk (up to 100MB).",
          );
        }

        const buf = Buffer.from(await res.arrayBuffer());
        const sizeKB = Math.round(buf.length / 1024);

        if (buf.length > MAX_INLINE_FILE_BYTES) {
          return textResult(
            `File "${filename}" is too large (${Math.round(buf.length / 1024 / 1024)}MB) for inline display. ` +
              "Try again with save_to_path to save to disk (up to 100MB).",
          );
        }

        // ── Inline: text files ──
        const isTextType =
          contentType.startsWith("text/") ||
          contentType === "application/json" ||
          contentType === "application/xml";

        if (isTextType) {
          let text = buf.toString("utf-8");
          let truncated = false;
          if (buf.length > MAX_INLINE_TEXT_BYTES) {
            text = text.slice(0, MAX_INLINE_TEXT_BYTES);
            truncated = true;
          }
          api.logger.info(
            `slack_download_file: text "${filename}" (${sizeKB}KB)${truncated ? " [truncated]" : ""}`,
          );
          return textResult(
            truncated
              ? `Contents of ${filename} (truncated to 100KB of ${sizeKB}KB — use save_to_path for the full file):\n\n${text}\n\n[…truncated]`
              : `Contents of ${filename}:\n\n${text}`,
          );
        }

        // ── Inline: images ──
        if (contentType.startsWith("image/") && buf.length <= MAX_INLINE_IMAGE_BYTES) {
          api.logger.info(
            `slack_download_file: image "${filename}" (${sizeKB}KB, ${contentType})`,
          );
          return {
            content: [
              {
                type: "image" as const,
                data: buf.toString("base64"),
                mimeType: contentType,
              } as { type: "image"; data: string; mimeType: string },
            ],
          };
        }

        // ── Everything else: tell the agent to use save_to_path ──
        api.logger.info(
          `slack_download_file: "${filename}" (${sizeKB}KB, ${contentType}) — needs save_to_path`,
        );
        return textResult(
          `"${filename}" (${sizeKB}KB, ${contentType}) cannot be displayed inline. ` +
            `Call again with save_to_path to save it to disk.`,
        );
      },
    }));

    api.registerTool((toolContext) => ({
      name: "slack_send",
      // Read by Pi's PEP (pi-adapter builds toolCaps from every tool declaring `capability`).
      // Inert under OpenClaw, which has no capability model.
      capability: "slack.send",
      description:
        "Send a Slack message to a specific channel/thread. " +
        "ONLY use for: (1) cron jobs or async background tasks, (2) cross-posting to a different channel. " +
        "NEVER use during normal conversation — your text output is already streamed to Slack automatically. " +
        "If you were woken by a Slack message, just respond normally; do NOT call this tool.",
      parameters: {
        type: "object",
        required: ["channel", "text"],
        additionalProperties: false,
        properties: {
          channel: {
            type: "string",
            description:
              "Where to post: a channel id (C…), a DM id (D…), or a USER id (U…) to DM that " +
              "person. A user id is resolved against Archie's own bot identity, so it opens " +
              "Archie's DM with them. Under Slack-triggered turns, prefer meta.slack.channel.",
          },
          text: {
            type: "string",
            description: "Message body. Plain text or Slack mrkdwn.",
          },
          thread_ts: {
            type: "string",
            description:
              "Thread timestamp from meta.slack.threadTs. Pass this so the reply stays in-thread.",
          },
        },
      },
      execute: async (_toolCallId: string, args: Record<string, unknown>) => {
        const channel = args?.channel as string | undefined;
        const text = args?.text as string | undefined;
        const thread_ts = args?.thread_ts as string | undefined;

        api.logger.info(
          `slack_send: execute — channel=${channel} thread_ts=${thread_ts ?? "(none)"} text=${(text ?? "").slice(0, 80)}`,
        );

        if (!text) {
          throw new Error("slack_send: 'text' parameter is required");
        }

        // Strip [[reply_to_current]] / [[reply_to:<id>]] tags that some
        // agent prompts still emit. These are not interpreted by the
        // dispatcher and would appear as literal text in Slack.
        const cleanText = text.replace(/\[\[reply_to_[^\]]*\]\]\s*/g, "").trim();

        if (!proxyUrl) {
          throw new Error("slack_send: SLACK_PROXY_URL is not set in the container env");
        }
        if (!secret) {
          throw new Error("slack_send: DISPATCHER_SHARED_SECRET is not set in the container env");
        }

        const url = `${proxyUrl}/api/chat.postMessage`;
        api.logger.info(`slack_send: POST ${url}`);

        let res: Response;
        try {
          res = await fetch(url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-dispatcher-secret": secret,
              // Pi's logical session key contains the immutable Slack reply target for
              // user-triggered turns. The dispatcher uses it to supply thread_ts when the
              // model omits that optional argument. Keep it out of the Slack request body:
              // it is transport context, not a Slack Web API field.
              ...(toolContext?.sessionKey
                ? { "x-archie-session-key": String(toolContext.sessionKey) }
                : {}),
            },
            body: JSON.stringify({
              channel,
              text: cleanText,
              ...(thread_ts ? { thread_ts } : {}),
            }),
          });
        } catch (err) {
          api.logger.error(`slack_send: fetch failed — ${err}`);
          throw err;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          const msg = `slack_send: dispatcher returned ${res.status} — ${body.slice(0, 200)}`;
          api.logger.error(msg);
          throw new Error(msg);
        }

        const json = (await res.json()) as SlackApiResponse;
        if (!json.ok) {
          const msg = `slack_send: Slack rejected — ${json.error ?? "unknown"}`;
          api.logger.error(msg);
          throw new Error(msg);
        }

        api.logger.info(
          `slack_send: ok — channel=${json.channel} ts=${json.ts}`,
        );

        return {
          content: [
            {
              type: "text",
              text: `Posted to ${channel}${thread_ts ? " (in thread)" : ""} — ts=${json.ts}`,
            },
          ],
        };
      },
    }));
  },
});

declare global {
  // eslint-disable-next-line no-var
  var __slackReplyPluginInited: boolean | undefined;
}

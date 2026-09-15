'use strict';

// The Files tab's data layer: list / presign / delete an agent's published artifacts.
//
// WHY THIS IS IN THE GATEWAY AND NOT IN THE AGENT. Under OpenClaw the dispatcher asked the agent:
// `GET {agentUrl}/admin/files/list` reached admin-server.js inside the ECS task, which shelled out
// to the aws CLI. An AgentCore runtime has no such door — it is reachable only through
// InvokeAgentRuntime, there is no AGENT_URLS and no admin server — so the read half moved here.
//
// That is not merely a forced move, it is the better one:
//   · no agent round-trip, so no 10-15s timeouts and no "your agent may be restarting" empty state
//     (the OpenClaw tab showed exactly that whenever the agent was mid-deploy);
//   · no 30s cache, so a delete is visible on the next render rather than up to 30s later;
//   · the prefix comes from the gateway's own scope resolution (homeTargetFor), not from trusting
//     whichever agent answered the HTTP call.
//
// The WRITE half stays with the agent: file-publish-plugin PUTs straight to S3 under the runtime's
// derived role, whose S3 statement is scoped to that agent's prefix. Nothing uploads through here —
// which is also why this module's IAM has no s3:PutObject (see modules/archie/iam.tf).

const path = require('node:path');

const PRESIGN_EXPIRY_SECONDS = 86400; // 24h — matches save_artifact's own presign

/**
 * Mirror of the plugin's sanitizeFilename (file-publish-plugin/artifact.ts): collapse to a single
 * basename in the flat [a-zA-Z0-9._-] namespace.
 *
 * Applied to EVERY filename arriving from a Slack payload. Block `value`s are round-tripped through
 * the client, so a crafted one is attacker-controlled input: without this, `../other-agent/x` in a
 * button value would presign or DELETE an object outside the viewer's own prefix. Keep byte-identical
 * to the plugin's version — if one changes, change both.
 */
function sanitizeFilename(raw) {
  return path.basename(String(raw ?? '')).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/**
 * Build the store. `client` and `presigner` are injectable so the tests need neither a network nor a
 * credential chain; in the dispatcher both come from the AWS SDK.
 *
 * @param {object}  opts
 * @param {string}  opts.bucket     ARTIFACTS_S3_BUCKET; empty = the feature is not configured
 * @param {string}  opts.region
 * @param {object} [opts.client]    an S3Client (built lazily from the SDK when omitted)
 * @param {Function} [opts.presigner] getSignedUrl(client, command, opts)
 */
function createFilesStore({ bucket, region, client, presigner, commands } = {}) {
  let _client = client;
  let _cmds = commands;
  let _presign = presigner;

  function sdk() {
    if (!_client || !_cmds || !_presign) {
      // Required lazily so a deployment without an artifacts bucket never loads the S3 SDK, and so
      // the unit tests can inject without it being present at all.
      const s3 = require('@aws-sdk/client-s3');
      const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
      _cmds = _cmds || s3;
      _client = _client || new s3.S3Client({ region });
      _presign = _presign || getSignedUrl;
    }
    return { client: _client, cmds: _cmds, presign: _presign };
  }

  function assertConfigured() {
    // An empty list would read as "this agent has published nothing", which is exactly how a
    // misconfiguration hides. The OpenClaw admin-server made the same call and left the same note.
    if (!bucket) throw new Error('artifacts not configured (ARTIFACTS_S3_BUCKET unset)');
  }

  function keyFor(agentId, filename) {
    if (!agentId) throw new Error('filesStore: agentId required');
    const safe = sanitizeFilename(filename);
    if (!safe) throw new Error('filesStore: missing or invalid filename');
    return `${agentId}/${safe}`;
  }

  return {
    isConfigured: () => Boolean(bucket),
    bucket,

    /**
     * Every object under `<agentId>/`, newest-first.
     *
     * PAGINATED. A single ListObjectsV2 returns at most 1000 keys, and the OpenClaw version read one
     * page and stopped — an agent past 1000 artifacts silently lost the rest. Follow the
     * continuation token to the end; the Files tab then caps what it RENDERS (Slack's 100-block
     * limit), which is a display decision and belongs there, not here.
     */
    async listFiles(agentId) {
      assertConfigured();
      if (!agentId) throw new Error('filesStore: agentId required');
      const { client: c, cmds } = sdk();
      const prefix = `${agentId}/`;
      const files = [];
      let token;
      do {
        const page = await c.send(new cmds.ListObjectsV2Command({
          Bucket: bucket, Prefix: prefix, ContinuationToken: token,
        }));
        for (const obj of page.Contents || []) {
          // S3 "directory" placeholder keys (a zero-byte object ending in /) are not files.
          if (!obj.Key || obj.Key.endsWith('/')) continue;
          files.push({
            key: obj.Key,
            filename: obj.Key.slice(prefix.length),
            size: obj.Size,
            lastModified: obj.LastModified instanceof Date ? obj.LastModified.toISOString() : obj.LastModified,
          });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return files;
    },

    /** A fresh 24h GET URL for one file. The agent's own link expires; this is how it is renewed. */
    async presignFile(agentId, filename) {
      assertConfigured();
      const key = keyFor(agentId, filename);
      const { client: c, cmds, presign } = sdk();
      return presign(c, new cmds.GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: PRESIGN_EXPIRY_SECONDS });
    },

    /** Hard delete. There is no versioning and no soft-delete; the tab's confirm dialog is the net. */
    async deleteFile(agentId, filename) {
      assertConfigured();
      const key = keyFor(agentId, filename);
      const { client: c, cmds } = sdk();
      await c.send(new cmds.DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { key };
    },
  };
}

module.exports = { createFilesStore, sanitizeFilename, PRESIGN_EXPIRY_SECONDS };

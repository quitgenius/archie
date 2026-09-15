'use strict';

// vitest globals enabled via vitest.config.js
const { createFilesStore, sanitizeFilename } = require('./files-store');

// Fake S3: records the commands it is sent and replays canned pages. The command classes are
// injected too, so nothing here needs @aws-sdk/client-s3 installed.
class ListObjectsV2Command { constructor(input) { this.input = input; this.name = 'list'; } }
class GetObjectCommand { constructor(input) { this.input = input; this.name = 'get'; } }
class DeleteObjectCommand { constructor(input) { this.input = input; this.name = 'delete'; } }
const commands = { ListObjectsV2Command, GetObjectCommand, DeleteObjectCommand };

function fakeClient(pages = [{ Contents: [] }]) {
  const sent = [];
  let i = 0;
  return {
    sent,
    async send(cmd) {
      sent.push(cmd);
      if (cmd.name !== 'list') return {};
      return pages[i++] ?? { Contents: [] };
    },
  };
}

const store = (client, pages, opts = {}) => createFilesStore({
  bucket: 'archie-artifacts-1',
  region: 'us-east-1',
  client: client || fakeClient(pages),
  commands,
  presigner: async (_c, cmd, o) => `https://s3.example/${cmd.input.Key}?expires=${o.expiresIn}`,
  ...opts,
});

describe('sanitizeFilename', () => {
  it('is the plugin rule, byte for byte', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('/abs/report.html')).toBe('report.html');
    expect(sanitizeFilename('a b;c.csv')).toBe('a_b_c.csv');
    expect(sanitizeFilename('x'.repeat(400))).toHaveLength(200);
    expect(sanitizeFilename(undefined)).toBe('');
  });
});

describe('listFiles', () => {
  it('lists only the agent prefix, and strips it from the displayed name', async () => {
    const client = fakeClient([{
      Contents: [
        { Key: 'dm-u1/report.html', Size: 120, LastModified: new Date('2026-09-01T10:00:00Z') },
        { Key: 'dm-u1/export.csv', Size: 4096, LastModified: new Date('2026-09-02T10:00:00Z') },
      ],
    }]);
    const files = await store(client).listFiles('dm-u1');
    expect(client.sent[0].input).toMatchObject({ Bucket: 'archie-artifacts-1', Prefix: 'dm-u1/' });
    expect(files.map((f) => f.filename)).toEqual(['report.html', 'export.csv']);
    expect(files[0].lastModified).toBe('2026-09-01T10:00:00.000Z');
    expect(files[1].size).toBe(4096);
  });

  it('follows the continuation token to the end — one page is not the answer', async () => {
    // The OpenClaw version read a single page, so an agent past 1000 objects silently lost the rest.
    const client = fakeClient([
      { Contents: [{ Key: 'dm-u1/a.txt', Size: 1 }], IsTruncated: true, NextContinuationToken: 'TOK' },
      { Contents: [{ Key: 'dm-u1/b.txt', Size: 2 }], IsTruncated: false },
    ]);
    const files = await store(client).listFiles('dm-u1');
    expect(files.map((f) => f.filename)).toEqual(['a.txt', 'b.txt']);
    expect(client.sent[1].input.ContinuationToken).toBe('TOK');
  });

  it('skips S3 directory placeholder keys', async () => {
    const client = fakeClient([{ Contents: [{ Key: 'dm-u1/', Size: 0 }, { Key: 'dm-u1/x.md', Size: 3 }] }]);
    expect((await store(client).listFiles('dm-u1')).map((f) => f.filename)).toEqual(['x.md']);
  });

  it('an unconfigured bucket THROWS rather than returning an empty list', async () => {
    // An empty list renders as "no published files yet", which is how a misconfiguration hides.
    const s = createFilesStore({ bucket: '', region: 'us-east-1', client: fakeClient(), commands });
    await expect(s.listFiles('dm-u1')).rejects.toThrow(/not configured/);
    expect(s.isConfigured()).toBe(false);
  });

  it('refuses to list without an agent id — there is no fleet-wide view', async () => {
    await expect(store().listFiles(undefined)).rejects.toThrow(/agentId required/);
  });
});

describe('presignFile / deleteFile', () => {
  it('presigns the agent-scoped key for 24h', async () => {
    const url = await store().presignFile('dm-u1', 'report.html');
    expect(url).toBe('https://s3.example/dm-u1/report.html?expires=86400');
  });

  it('a crafted filename cannot address another agent\'s object', async () => {
    // The value comes back from a Slack block, so it is attacker-controllable input.
    const client = fakeClient();
    await store(client).deleteFile('dm-u1', '../other-agent/secret.html');
    expect(client.sent[0].input.Key).toBe('dm-u1/secret.html');

    const url = await store().presignFile('dm-u1', '/etc/passwd');
    expect(url).toContain('/dm-u1/passwd?');
  });

  it('a filename that sanitizes to nothing is refused', async () => {
    await expect(store().deleteFile('dm-u1', '/')).rejects.toThrow(/invalid filename/);
    await expect(store().presignFile('dm-u1', '')).rejects.toThrow(/invalid filename/);
  });

  it('deletes exactly one key in the agent prefix', async () => {
    const client = fakeClient();
    await store(client).deleteFile('dm-u1', 'report.html');
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0].name).toBe('delete');
    expect(client.sent[0].input).toEqual({ Bucket: 'archie-artifacts-1', Key: 'dm-u1/report.html' });
  });
});

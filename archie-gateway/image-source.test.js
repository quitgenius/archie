'use strict';

const { createImageSource, readImageItem } = require('./image-source');

const REPO = '203366135563.dkr.ecr.us-east-1.amazonaws.com/clawdbot-agentcore';

function mkDoc(items = {}, { failWith } = {}) {
  const calls = [];
  return {
    calls,
    doc: () => ({
      send: async (cmd) => {
        calls.push(cmd.input.Key.sk);
        if (failWith) throw failWith;
        return { Item: items[cmd.input.Key.sk] };
      },
    }),
  };
}

describe('readImageItem', () => {
  it('accepts a full uri', () => {
    expect(readImageItem({ imageUri: 'repo:tag' })).toBe('repo:tag');
  });

  it('accepts a bare tag as a deferred resolution', () => {
    expect(readImageItem({ tag: 'pi-obs-41' })).toEqual({ tag: 'pi-obs-41' });
  });

  it('rejects junk rather than provisioning an unpullable runtime', () => {
    for (const bad of [null, undefined, {}, { imageUri: '' }, { imageUri: '   ' }, { imageUri: 42 }, { tag: '' }]) {
      expect(readImageItem(bad)).toBeNull();
    }
  });
});

describe('createImageSource', () => {
  it('THROWS when the table has no pointer — never guesses an image', async () => {
    // Fail closed. A baked fallback would quietly run whatever build this dispatcher shipped with,
    // and the only symptom would be agents behaving like an old release. An unpublished fleet is an
    // operator error and must look like one.
    const { doc } = mkDoc({});
    const src = createImageSource({ doc, table: 't', repoUri: REPO, logger: { error() {} } });
    await expect(src.resolveImage('agent-a')).rejects.toThrow(/no fleet image published/);
    await expect(src.resolveImage('agent-a')).rejects.toMatchObject({ name: 'ImagePointerMissing' });
  });

  it('emits the alarm metric when the pointer is missing', async () => {
    const { doc } = mkDoc({});
    const emitImagePointerMissing = vi.fn();
    const src = createImageSource({ doc, table: 't', repoUri: REPO, logger: { error() {} }, metrics: { emitImagePointerMissing } });
    await expect(src.resolveImage('agent-a')).rejects.toThrow();
    expect(emitImagePointerMissing).toHaveBeenCalledWith({ agent: 'agent-a', table: 't' });
  });

  it('a published bare tag resolves against the configured repo', async () => {
    const { doc } = mkDoc({ FLEET: { tag: 'pi-obs-99' } });
    const src = createImageSource({ doc, table: 't', repoUri: REPO });
    expect(await src.resolveImage('agent-a')).toBe(`${REPO}:pi-obs-99`);
  });

  it('a per-agent override beats the fleet pointer (canary one agent)', async () => {
    const { doc } = mkDoc({ FLEET: { tag: 'fleet' }, 'AGENT#agent-a': { tag: 'canary' } });
    const src = createImageSource({ doc, table: 't', repoUri: REPO });
    expect(await src.resolveImage('agent-a')).toContain(':canary');
    expect(await src.resolveImage('agent-b')).toContain(':fleet');
  });

  it('serves from cache inside the TTL — a turn must not pay a DynamoDB read', async () => {
    let t = 1000;
    const { doc, calls } = mkDoc({ FLEET: { tag: 'x' } });
    const src = createImageSource({ doc, table: 't', repoUri: REPO, ttlMs: 5000, now: () => t });
    await src.resolveImage('agent-a');
    const after = calls.length;
    await src.resolveImage('agent-a');
    await src.resolveImage('agent-a');
    expect(calls.length).toBe(after);       // no further reads
    t += 6000;                               // past the TTL
    await src.resolveImage('agent-a');
    expect(calls.length).toBeGreaterThan(after);
  });

  it('a DynamoDB failure keeps serving the LAST GOOD image, not the floor', async () => {
    // A transient read error must not silently roll the fleet back to the baked image.
    let t = 1000;
    const items = { FLEET: { tag: 'published' } };
    const calls = [];
    let fail = false;
    const doc = () => ({
      send: async (cmd) => {
        calls.push(cmd.input.Key.sk);
        if (fail) throw new Error('throttled');
        return { Item: items[cmd.input.Key.sk] };
      },
    });
    const warn = vi.fn();
    const src = createImageSource({ doc, table: 't', repoUri: REPO, ttlMs: 10, logger: { warn }, now: () => t });
    expect(await src.resolveImage('a')).toContain(':published');

    fail = true;
    t += 1000;                                // expire the cache so a refresh is attempted
    expect(await src.resolveImage('a')).toBe(`${REPO}:published`);   // NOT a throw, NOT a baked image
    expect(warn).toHaveBeenCalledTimes(1);

    t += 1000;
    await src.resolveImage('a');
    expect(warn).toHaveBeenCalledTimes(1);    // warned once per outage, not per tick
  });

  it('throws when DynamoDB is down and there is no last-good value to keep', async () => {
    // The distinction that matters: a stale published image is still something an operator CHOSE,
    // so serving it through a blip is right. A build-time constant was never chosen for this fleet.
    const { doc } = mkDoc({}, { failWith: new Error('down') });
    const src = createImageSource({ doc, table: 't', repoUri: REPO, logger: { warn() {}, error() {} } });
    await expect(src.resolveImage('a')).rejects.toMatchObject({ name: 'ImagePointerMissing' });
  });

  it('reads strongly consistent — a publish must be visible to the very next message', async () => {
    const seen = [];
    const doc = () => ({ send: async (cmd) => { seen.push(cmd.input.ConsistentRead); return { Item: undefined }; } });
    const src = createImageSource({ doc, table: 't', repoUri: REPO, logger: { error() {} } });
    await src.resolveImage('a').catch(() => {});
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((c) => c === true)).toBe(true);
  });

  it('the background refresher does not hold the process open', () => {
    const { doc } = mkDoc({ FLEET: { tag: 'x' } });
    const src = createImageSource({ doc, table: 't', repoUri: REPO, refreshMs: 10_000 });
    const timer = src.start();
    expect(timer).toBeTruthy();
    src.stop();
  });
});

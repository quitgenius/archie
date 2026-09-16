'use strict';

// vitest globals enabled via vitest.config.js
const {
  createCronInventoryEmitter,
  channelOf,
  resolveChannel,
  classifyDelivery,
  DELIVERY_STATUS,
  CRON_INVENTORY_NAMESPACE,
  CRON_INVENTORY_METRIC_TOTAL,
  CRON_INVENTORY_METRIC_ENABLED,
  CRON_INVENTORY_METRIC_MISCONFIGURED,
  CRON_INVENTORY_METRIC_JOB,
  resolveDeliveryChannel,
  resolveDeliveryTarget,
  isSlackChannelId,
  channelFromSessionKey,
  userFromScopeId,
  resolveCronTimeoutMs,
  resolveCronModel,
  CRON_TIMEOUT,
  buildCronSessionKey,
} = require('./cron-inventory-metrics');

function capture() {
  const lines = [];
  const emitter = createCronInventoryEmitter({ emit: (l) => lines.push(l), now: () => 1_800_000_000_000 });
  return { emitter, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
}

const job = (over = {}) => ({ agentId: 'agent-k4wmx6', jobId: 'daily', id: 'agent-k4wmx6::daily', ...over });

// Pull the single EMF line whose dimension set + key matches (agent or channel).
const agentLine = (parsed, agent) => parsed.find((e) => e.Agent === agent);
const channelLine = (parsed, channel) => parsed.find((e) => e.Channel === channel);

describe('channelOf', () => {
  it('prefers delivery.channel', () => {
    expect(channelOf(job({ delivery: { mode: 'announce', channel: 'C0TRIAGE' }, sessionKey: 'slack:thread:C0OTHER:1.2' }))).toBe('C0TRIAGE');
  });
  it('parses the channel out of a slack sessionKey when no delivery.channel', () => {
    expect(channelOf(job({ sessionKey: 'slack:thread:C0ABC123XYZ:1712345678.001' }))).toBe('c0abc123xyz');
  });
  it('handles a DM sessionKey (slack:thread:dm:<ch>:<ts>)', () => {
    expect(channelOf(job({ sessionKey: 'slack:thread:dm:D0ME456:1712345678.001' }))).toBe('d0me456');
  });
  it('falls back to "none" for webhook/system jobs with no channel', () => {
    expect(channelOf(job({ delivery: { mode: 'webhook', to: 'https://x.test/h' } }))).toBe('none');
    expect(channelOf(job())).toBe('none');
  });
});

describe('createCronInventoryEmitter.snapshot', () => {
  it('emits per-agent lines with the right namespace, gauge metrics and fleet aggregate', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot([
      job({ agentId: 'a1', delivery: { channel: 'C1' } }),
      job({ agentId: 'a1', delivery: { channel: 'C2' } }),
      job({ agentId: 'a2', delivery: { channel: 'C1' } }),
    ]);
    const a1 = agentLine(parsed(), 'a1');
    expect(a1._aws.CloudWatchMetrics[0].Namespace).toBe(CRON_INVENTORY_NAMESPACE);
    expect(a1._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]); // per-agent + fleet aggregate
    expect(a1._aws.CloudWatchMetrics[0].Metrics).toEqual([
      { Name: CRON_INVENTORY_METRIC_TOTAL, Unit: 'Count' },
      { Name: CRON_INVENTORY_METRIC_ENABLED, Unit: 'Count' },
    ]);
    expect(a1[CRON_INVENTORY_METRIC_TOTAL]).toBe(2);
    expect(a1._aws.Timestamp).toBe(1_800_000_000_000);
    expect(agentLine(parsed(), 'a2')[CRON_INVENTORY_METRIC_TOTAL]).toBe(1);
  });

  it('emits per-channel lines (Channel dimension only, no fleet aggregate)', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot([
      job({ agentId: 'a1', delivery: { channel: 'C1' } }),
      job({ agentId: 'a2', delivery: { channel: 'C1' } }),
      job({ agentId: 'a1', delivery: { channel: 'C2' } }),
    ]);
    const c1 = channelLine(parsed(), 'C1');
    expect(c1._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Channel']]); // NOT [] — avoids double count
    expect(c1[CRON_INVENTORY_METRIC_TOTAL]).toBe(2);
    expect(channelLine(parsed(), 'C2')[CRON_INVENTORY_METRIC_TOTAL]).toBe(1);
  });

  it('counts enabled separately (a disabled job is configured but not enabled)', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot([
      job({ agentId: 'a1', delivery: { channel: 'C1' } }),                    // enabled (default)
      job({ agentId: 'a1', delivery: { channel: 'C1' }, enabled: false }),    // disabled
    ]);
    const c1 = channelLine(parsed(), 'C1');
    expect(c1[CRON_INVENTORY_METRIC_TOTAL]).toBe(2);
    expect(c1[CRON_INVENTORY_METRIC_ENABLED]).toBe(1);
  });

  it('returns snapshot counts and is a no-op on an empty list', () => {
    const { emitter, lines } = capture();
    const r = emitter.snapshot([]);
    expect(lines).toHaveLength(0);
    expect(r).toEqual({ agents: 0, channels: 0, jobs: 0 });
  });

  it('is defensive about a sparse job (no agentId → "unknown", no channel → "none")', () => {
    const { emitter, parsed } = capture();
    expect(() => emitter.snapshot([{}])).not.toThrow();
    expect(agentLine(parsed(), 'unknown')[CRON_INVENTORY_METRIC_TOTAL]).toBe(1);
    expect(channelLine(parsed(), 'none')[CRON_INVENTORY_METRIC_TOTAL]).toBe(1);
  });
});

// ── M4.1: the shared delivery-validity predicate ────────────────────────────
// The two fixtures below are the REAL jobs that broke in the sandbox (2026-08-09) — an announce
// with no channel that failed invalid_arguments on every fire, and a delivery-less job that fires
// daily and silently posts nothing. They are the acceptance cases for this whole milestone.
describe('classifyDelivery (M4.1)', () => {
  const j = (over = {}) => ({ agentId: 'dm-ux0mz5ckp2r', jobId: 'x', ...over });

  // HISTORY: this was recorded as "LIVE BUG 1 — the agent put a recipient in `to`". That
  // diagnosis was WRONG. Upstream, `to` IS the destination, so {announce, to:'U…'} is a valid
  // job meaning "DM this user". The bug was ours: cron-delivery mapped `to` -> thread_ts and
  // `channel` -> a channel id, misreading both fields. Now classified correctly.
  it('announce with `to` = a user id is VALID — it means DM that user', () => {
    const c = classifyDelivery(j({ delivery: { mode: 'announce', to: 'UX0MZ5CKP2R' } }));
    expect(c.status).toBe(DELIVERY_STATUS.OK);
    expect(c.user).toBe('UX0MZ5CKP2R');
  });

  // NB the agentId here is NOT the block's `dm-…` default. "Nothing anywhere" has to mean nothing
  // anywhere, and under §8.10 a DM scope is itself a destination — see the scope-rung block below.
  it('announce with NOTHING anywhere is the real missing case', () => {
    const c = classifyDelivery(j({ agentId: 'agent-l60bo8', delivery: { mode: 'announce' } }));
    expect(c.status).toBe(DELIVERY_STATUS.ANNOUNCE_MISSING_CHANNEL);
  });

  it('LIVE BUG 2 — no delivery block at all => no-delivery (fires forever, posts nothing)', () => {
    const c = classifyDelivery(j({ schedule: { kind: 'cron', expr: '0 7 * * *' } }));
    expect(c.status).toBe(DELIVERY_STATUS.NO_DELIVERY);
    expect(c.explicit).toBe(false); // distinguishes oversight from a deliberate side-effect job
  });

  it('an EXPLICIT mode:none is still reported, but flagged explicit', () => {
    const c = classifyDelivery(j({ delivery: { mode: 'none' } }));
    expect(c.status).toBe(DELIVERY_STATUS.NO_DELIVERY);
    expect(c.explicit).toBe(true);
  });

  it('announce with a channel => ok', () => {
    expect(classifyDelivery(j({ delivery: { mode: 'announce', channel: 'C0ABC123XYZ' } })).status).toBe(DELIVERY_STATUS.OK);
  });

  it('announce resolves its channel from sessionKey when delivery.channel is absent', () => {
    const c = classifyDelivery(j({ delivery: { mode: 'announce' }, sessionKey: 'slack:thread:C0ABC123XYZ:1.2' }));
    expect(c.status).toBe(DELIVERY_STATUS.OK);
    expect(c.channel).toBe('C0ABC123XYZ'); // case PRESERVED — a lowercased id is not postable
  });

  it('webhook is no longer a supported mode (removed: unvalidated egress, 0 prod jobs)', () => {
    expect(classifyDelivery(j({ delivery: { mode: 'webhook', to: 'https://h' } })).status).toBe(DELIVERY_STATUS.UNKNOWN_MODE);
  });

  it('an unknown mode (cron-delivery would throw on it) is classified, not silently accepted', () => {
    expect(classifyDelivery(j({ delivery: { mode: 'telepathy' } })).status).toBe(DELIVERY_STATUS.UNKNOWN_MODE);
  });

  it('resolveChannel returns null (not the string "none") so callers can branch cleanly', () => {
    expect(resolveChannel(j())).toBeNull();
    expect(resolveChannel(j({ delivery: { mode: 'announce', channel: 'C0ABC123XYZ' } }))).toBe('C0ABC123XYZ');
  });

  it('is defensive about a null/garbage job', () => {
    expect(() => classifyDelivery(null)).not.toThrow();
    expect(classifyDelivery(null).status).toBe(DELIVERY_STATUS.NO_DELIVERY);
  });
});

// ── M4.2 / M4.3 / M4.5: what the emitter puts on the wire ───────────────────
describe('inventory emitter M4 additions', () => {
  const bad = [
    { agentId: 'a1', jobId: 'j1', delivery: { mode: 'announce' } },                  // nothing to post to
    { agentId: 'a1', jobId: 'j2' },                                                  // no delivery
    { agentId: 'a2', jobId: 'j3', delivery: { mode: 'announce', channel: 'C0DEF456XYZ' } },   // ok
  ];

  it('M4.2: (Channel, Mode) rides its OWN line; the pre-M4 Channel-only line is untouched', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot(bad);

    // the new two-dimension line — carries ONLY [Channel, Mode]
    const cm = parsed().find((e) => e.Channel === 'none' && e.Mode === 'announce');
    expect(cm._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Channel', 'Mode']]);
    expect(cm[CRON_INVENTORY_METRIC_TOTAL]).toBe(1); // the broken announce

    // the pre-M4 line still exists, still one datapoint per tick, still the CHANNEL total (2),
    // so Maximum/Sum keep their old gauge meaning — the reason the sets are not merged.
    const chOnly = parsed().find((e) => e.Channel === 'none' && e.Mode === undefined);
    expect(chOnly._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Channel']]);
    expect(chOnly[CRON_INVENTORY_METRIC_TOTAL]).toBe(2);
  });

  it('M4.2: Channel=none no longer conflates a broken announce with a side-effect job', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot(bad);
    const modes = parsed().filter((e) => e.Channel === 'none' && e.Mode !== undefined).map((e) => e.Mode).sort();
    expect(modes).toEqual(['announce', 'none']); // separable, where Channel alone showed a single "2"
  });

  it('M4.3: emits CronJobsMisconfigured per (Agent, Reason), only for non-ok jobs', () => {
    const { emitter, parsed } = capture();
    const r = emitter.snapshot(bad);
    const mis = parsed().filter((e) => e[CRON_INVENTORY_METRIC_MISCONFIGURED] != null);
    expect(mis.map((e) => e.Reason).sort()).toEqual(['announce-missing-channel', 'no-delivery']);
    expect(mis.every((e) => e.Agent === 'a1')).toBe(true); // a2's job is fine
    expect(mis[0]._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent', 'Reason'], ['Reason'], []]);
    expect(mis.reduce((n, e) => n + e[CRON_INVENTORY_METRIC_MISCONFIGURED], 0)).toBe(2);
    // snapshot()'s return shape is unchanged by M4 — the count lives on the wire, not in the return
    expect(r).toEqual({ agents: 2, channels: 2, jobs: 3 });
  });

  it('M4.3: a clean fleet emits NO misconfiguration lines (silence == healthy)', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot([bad[2]]);
    expect(parsed().some((e) => e[CRON_INVENTORY_METRIC_MISCONFIGURED] != null)).toBe(false);
  });

  it('M4.5: jobRecords emits one line per job with schedule/next-run/status as PROPERTIES', () => {
    const { emitter, parsed } = capture();
    const r = emitter.jobRecords([
      { agentId: 'a1', jobId: 'j1', name: 'daily', schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'Europe/London' },
        state: { nextRunAtMs: 1_800_000_100_000 }, delivery: { mode: 'announce' }, sessionTarget: 'isolated' },
    ]);
    expect(r.emitted).toBe(1);
    const e = parsed()[0];
    expect(e._aws.CloudWatchMetrics[0].Metrics[0]).toEqual({ Name: CRON_INVENTORY_METRIC_JOB, Unit: 'Count' });
    expect(e._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent', 'Mode']]); // JobId NOT a dimension
    expect(e.JobId).toBe('j1');
    expect(e.schedule).toEqual({ kind: 'cron', expr: '0 7 * * *', tz: 'Europe/London' });
    expect(e.nextRunAtMs).toBe(1_800_000_100_000);
    expect(e.status).toBe('announce-missing-channel');
    expect(e.channel).toBe('none');
    expect(e.sessionTarget).toBe('isolated');
  });

  // DASHBOARD-CAUGHT (2026-08-10): the inventory widget selects `schedule.expr`, which was set for
  // kind:'cron' ONLY — so every `every`/`at` job rendered with a BLANK schedule, while the removals
  // widget showed them fine because cron-metrics.js synthesised its own string. Two shapes for one
  // logical field. Pin all three kinds here so they cannot drift apart again.
  it('carries a human schedule `expr` for EVERY kind (not just cron)', () => {
    const { emitter, parsed } = capture();
    emitter.jobRecords([
      { agentId: 'a', jobId: 'c', schedule: { kind: 'cron', expr: '0 7 * * *', tz: 'UTC' } },
      { agentId: 'a', jobId: 'e', schedule: { kind: 'every', everyMs: 120000 } },
      { agentId: 'a', jobId: 't', schedule: { kind: 'at', at: 1_786_314_120_000 } },
    ]);
    const byJob = Object.fromEntries(parsed().map((e) => [e.JobId, e.schedule]));
    expect(byJob.c).toEqual({ kind: 'cron', expr: '0 7 * * *', tz: 'UTC' });
    expect(byJob.e).toEqual({ kind: 'every', everyMs: 120000, expr: 'every 120000ms' });
    expect(byJob.t).toEqual({ kind: 'at', at: 1_786_314_120_000, expr: 'at 1786314120000' });
    // and the string matches cron-metrics.js's CronJobRemoved projection, which is the shape the
    // removals widget already renders — that equality IS the fix.
    expect(byJob.e.expr).toBe(`every ${120000}ms`);
  });

  // The inventory could show when a job WILL run but never whether it ever DID — so "runs fine,
  // delivers nothing" (the §12c.6b failure mode) was invisible on the dashboard.
  it('projects LAST-run and LAST-delivery state onto the record', () => {
    const { emitter, parsed } = capture();
    emitter.jobRecords([{
      agentId: 'a', jobId: 'j', schedule: { kind: 'cron', expr: '0 7 * * *' },
      delivery: { mode: 'announce', to: 'CZ3E1122Y3K' },
      state: {
        nextRunAtMs: 1_800_000_100_000,
        lastRunAtMs: 1_800_000_000_000, lastRunStatus: 'ok',
        lastDeliveryAtMs: 1_800_000_000_500, lastDeliveryStatus: 'failed',
      },
    }]);
    const e = parsed()[0];
    expect(e.lastRunAtMs).toBe(1_800_000_000_000);
    expect(e.lastRunStatus).toBe('ok');
    expect(e.lastDeliveryAtMs).toBe(1_800_000_000_500);
    expect(e.lastDeliveryStatus).toBe('failed'); // ran ok, delivered nothing — precisely representable
  });

  it('emits null (not undefined) for last-run state on a job that has never run', () => {
    const { emitter, parsed } = capture();
    emitter.jobRecords([{ agentId: 'a', jobId: 'j', schedule: { kind: 'cron', expr: '0 7 * * *' } }]);
    const e = parsed()[0];
    // null keeps the key present so the dashboard column exists and reads blank, rather than the
    // field vanishing from the EMF line entirely (JSON.stringify drops undefined).
    for (const k of ['lastRunAtMs', 'lastRunStatus', 'lastDeliveryAtMs', 'lastDeliveryStatus']) {
      expect(k in e).toBe(true);
      expect(e[k]).toBeNull();
    }
  });

  it('M4.5: never throws on a garbage job list', () => {
    const { emitter } = capture();
    expect(() => emitter.jobRecords(null)).not.toThrow();
    expect(emitter.jobRecords(null)).toEqual({ jobs: 0, emitted: 0 });
  });

  it('agent lines and the fleet aggregate are unchanged by M4 (no regression)', () => {
    const { emitter, parsed } = capture();
    emitter.snapshot(bad);
    const a1 = parsed().find((e) => e.Agent === 'a1' && e[CRON_INVENTORY_METRIC_TOTAL] != null);
    expect(a1._aws.CloudWatchMetrics[0].Dimensions).toEqual([['Agent'], []]);
    expect(a1[CRON_INVENTORY_METRIC_TOTAL]).toBe(2);
    expect(a1[CRON_INVENTORY_METRIC_ENABLED]).toBe(2);
  });
});

// ── §12c: a channel must be POSTABLE, not merely present ───────────────────
// Verified live 2026-08-09: conversations.info resolves DL1HA3II6V6 and rejects dl1ha3ii6v6 with
// channel_not_found — Slack ids are case-sensitive. Every shape below is one that actually occurs
// in the prod cron store; before this rule, classifyDelivery reported all of them as "ok".
describe('resolveDeliveryChannel + announce-unusable-channel (§12c/G4)', () => {
  const j = (over = {}) => ({ agentId: 'a', jobId: 'j', ...over });
  const ann = (channel, extra = {}) => j({ delivery: { mode: 'announce', ...(channel === undefined ? {} : { channel }) }, ...extra });

  // §12c CORRECTION: `slack`/`last` are TRANSPORT selectors, not destinations — with no `to`
  // and no session key there is simply nothing to post to, so they are UNUSABLE only in the
  // sense that nothing resolves. `webchat` is the one with no Slack equivalent at all.
  it.each([
    ['transport name "slack"', 'slack'],
    ['transport name "webchat"', 'webchat'],
    ['OpenClaw "last"', 'last'],
  ])('%s alone resolves to nothing', (_label, channel) => {
    expect(classifyDelivery(ann(channel)).status).toBe(DELIVERY_STATUS.ANNOUNCE_UNUSABLE_CHANNEL);
  });

  it('a user REFERENCE and a LOWERCASED id now RESOLVE (they are destinations, not junk)', () => {
    expect(classifyDelivery(ann('user:uacz7ltoyan')).status).toBe(DELIVERY_STATUS.OK);
    expect(classifyDelivery(ann('user:uacz7ltoyan')).user).toBe('UACZ7LTOYAN');
    expect(classifyDelivery(ann('d2l9ch07unu')).status).toBe(DELIVERY_STATUS.OK);
    expect(classifyDelivery(ann('d2l9ch07unu')).channel).toBe('D2L9CH07UNU'); // case recovered
  });

  it('distinguishes UNUSABLE from MISSING (different fixes: a mapping vs a source)', () => {
    expect(classifyDelivery(ann('slack')).status).toBe(DELIVERY_STATUS.ANNOUNCE_UNUSABLE_CHANNEL);
    expect(classifyDelivery(ann(undefined)).status).toBe(DELIVERY_STATUS.ANNOUNCE_MISSING_CHANNEL);
    // and `slack` WITH a destination is simply fine
    expect(classifyDelivery(j({ delivery: { mode: 'announce', channel: 'slack', to: 'CZ3E1122Y3K' } })).status)
      .toBe(DELIVERY_STATUS.OK);
  });

  it('accepts real ids in every Slack namespace (channel / DM / group)', () => {
    for (const id of ['CZ3E1122Y3K', 'DL1HA3II6V6', 'GQGZ9TTIB2Y']) {
      expect(classifyDelivery(ann(id)).status).toBe(DELIVERY_STATUS.OK);
    }
  });

  it('the ambient session key WINS over a stored channel (§12c ladder)', () => {
    const c = classifyDelivery(ann('slack', { sessionKey: 'slack:thread:DL1HA3II6V6:1712.5' }));
    expect(c.status).toBe(DELIVERY_STATUS.OK);
    expect(c.channel).toBe('DL1HA3II6V6'); // transport name is skipped; ambient key supplies the target
  });

  it('preserves CASE from the session key — channelOf lowercases, which is fatal for posting', () => {
    expect(channelFromSessionKey('slack:thread:DL1HA3II6V6:1.2')).toBe('DL1HA3II6V6');
    expect(channelOf({ sessionKey: 'slack:thread:DL1HA3II6V6:1.2' })).toBe('dl1ha3ii6v6'); // grouping only
  });

  // LIVE-CAUGHT (2026-08-10, prod EFS). Every session-key fixture above is UPPERCASE, which is why
  // this hole survived: OpenClaw writes them LOWERCASE, and the ambient rung was gated on the
  // uppercase-only isSlackChannelId — so on real data the rung could never fire. The two prod
  // `webchat` jobs are verbatim below; the enabled one had consecutiveErrors:7 with
  // "Delivering to Slack requires target <channelId|user:ID|channel:ID>".
  describe('the ambient rung on REAL (lowercased, agent-prefixed) prod session keys', () => {
    const PROD_KEY = 'agent:agent-8qsvni:slack:thread:dmw8mne5g42:1785779572.895079';

    it('recovers the channel case off a lowercased prod session key', () => {
      expect(channelFromSessionKey(PROD_KEY)).toBe('dmw8mne5g42'); // as stored — wrong case
      expect(resolveDeliveryChannel({ sessionKey: PROD_KEY })).toBe('DMW8MNE5G42'); // postable
    });

    // The webchat decision: an unreachable TRANSPORT is not an unreachable JOB — it delivers to the
    // conversation it was created in, exactly like any other channel-posting cron.
    it('classifies the prod webchat job OK, targeting its own conversation', () => {
      const c = classifyDelivery(j({
        delivery: { mode: 'announce', channel: 'webchat' },
        sessionKey: PROD_KEY,
      }));
      expect(c.status).toBe(DELIVERY_STATUS.OK);
      expect(c.channel).toBe('DMW8MNE5G42');
    });

    it('lands the `slack` and `last` transport cohorts too (same root cause)', () => {
      for (const transport of ['slack', 'last', 'discord']) {
        const c = classifyDelivery(j({ delivery: { mode: 'announce', channel: transport }, sessionKey: PROD_KEY }));
        expect(c.status).toBe(DELIVERY_STATUS.OK);
        expect(c.channel).toBe('DMW8MNE5G42');
      }
    });

    // The guard that keeps this from becoming a false ACCEPT: no session key, no rescue.
    it('still reports UNUSABLE when there is no ambient key to fall back to', () => {
      expect(classifyDelivery(ann('webchat')).status).toBe(DELIVERY_STATUS.ANNOUNCE_UNUSABLE_CHANNEL);
    });

    // An EXPLICIT destination still outranks the ambient one (ladder order unchanged).
    it('does not let the ambient key override an explicit `to`', () => {
      const c = classifyDelivery(j({
        delivery: { mode: 'announce', channel: 'webchat', to: 'CZ3E1122Y3K' },
        sessionKey: PROD_KEY,
      }));
      expect(c.channel).toBe('CZ3E1122Y3K');
    });

    // A session key whose channel segment is NOT an id must not be laundered into one.
    it('rejects a non-id channel segment in the session key', () => {
      expect(resolveDeliveryChannel({ sessionKey: 'slack:thread:current:1.2' })).toBeNull();
      expect(resolveDeliveryChannel({ sessionKey: 'agent:a:slack:thread:webchat:1.2' })).toBeNull();
    });
  });

  it('handles the DM session-key form', () => {
    expect(resolveDeliveryChannel({ sessionKey: 'slack:thread:dm:DL1HA3II6V6:1.2' })).toBe('DL1HA3II6V6');
  });

  // LIVE-CAUGHT: the id rule was /^[CDG][A-Z0-9]{6,}$/, so 'current' uppercased to CURRENT =
  // C + URRENT and MATCHED — a job with delivery.channel:'current' classified OK and would have
  // failed channel_not_found at post time. Real ids are 9-11 chars.
  it.each(['current', 'channel', 'contact', 'default'])('rejects the English word %s as an id', (w) => {
    expect(isSlackChannelId(w.toUpperCase())).toBe(false);
    expect(classifyDelivery({ agentId: 'a', jobId: 'j', delivery: { mode: 'announce', channel: w } }).status)
      .toBe(DELIVERY_STATUS.ANNOUNCE_UNUSABLE_CHANNEL);
  });

  it('still accepts every real id shape (9-11 chars, C/D/G)', () => {
    for (const id of ['CZ3E1122Y3K', 'DL1HA3II6V6', 'GQGZ9TTIB2Y', 'CHSYL3RZI']) {
      expect(isSlackChannelId(id)).toBe(true);
    }
  });

  it('is defensive about junk', () => {
    expect(resolveDeliveryChannel(null)).toBeNull();
    expect(resolveDeliveryChannel({ sessionKey: 42, delivery: { channel: {} } })).toBeNull();
    expect(isSlackChannelId('')).toBe(false);
  });
});

// ── §12c: one scoping rule, cron owns a synthetic thread ───────────────────
describe('buildCronSessionKey (§12c)', () => {
  const j = (over = {}) => ({ agentId: 'agent-xx9aff', jobId: 'abc-123', ...over });

  it('builds a SYNTHETIC thread in the channel of the ambient session key', () => {
    expect(buildCronSessionKey(j({ sessionKey: 'slack:thread:CZ3E1122Y3K:1712.5' })))
      .toBe('slack:thread:CZ3E1122Y3K:cron-abc-123');
  });

  it('does NOT reuse the human thread — same channel, different thread', () => {
    const human = 'slack:thread:CZ3E1122Y3K:1712.5';
    const key = buildCronSessionKey(j({ sessionKey: human }));
    expect(key).not.toBe(human);                    // the job never writes into their conversation
    expect(key.startsWith('slack:thread:CZ3E1122Y3K:')).toBe(true); // but stays in their channel
  });

  it('handles the DM form (dm: prefix stripped, DM id kept)', () => {
    expect(buildCronSessionKey(j({ sessionKey: 'slack:thread:dm:DL1HA3II6V6:1712.5' })))
      .toBe('slack:thread:DL1HA3II6V6:cron-abc-123');
  });

  it('falls back to delivery.channel, then to the routed channel', () => {
    expect(buildCronSessionKey(j({ delivery: { mode: 'announce', channel: 'CZ3E1122Y3K' } })))
      .toBe('slack:thread:CZ3E1122Y3K:cron-abc-123');
    expect(buildCronSessionKey(j({}), { channelForAgent: () => 'CZ3E1122Y3K' }))
      .toBe('slack:thread:CZ3E1122Y3K:cron-abc-123');
  });

  it('skips a TRANSPORT name, but a lowercased id is a real destination (case recovered)', () => {
    expect(buildCronSessionKey(j({ delivery: { mode: 'announce', channel: 'slack' } })))
      .toBe('cron:agent-xx9aff:abc-123');
    expect(buildCronSessionKey(j({ delivery: { mode: 'announce', channel: 'd2l9ch07unu' } })))
      .toBe('slack:thread:D2L9CH07UNU:cron-abc-123');
  });

  it('a channel-less job STILL gets a stable per-job key (continuity ≠ having somewhere to post)', () => {
    const a = buildCronSessionKey(j({}));
    const b = buildCronSessionKey(j({}));
    expect(a).toBe(b);
    expect(a).toBe('cron:agent-xx9aff:abc-123');
  });

  // The two properties this whole change exists to restore.
  it('PROPERTY: stable across fires (G10 — OpenClaw isolated is cron:<jobId>, ours was per-fire)', () => {
    const job = j({ sessionKey: 'slack:thread:CZ3E1122Y3K:1712.5' });
    expect(buildCronSessionKey(job)).toBe(buildCronSessionKey(job));
  });

  it('PROPERTY: distinct per job (no cross-job bleed — cron:main:<agent> was shared)', () => {
    const one = buildCronSessionKey(j({ jobId: 'job-one', sessionKey: 'slack:thread:CZ3E1122Y3K:1.2' }));
    const two = buildCronSessionKey(j({ jobId: 'job-two', sessionKey: 'slack:thread:CZ3E1122Y3K:1.2' }));
    expect(one).not.toBe(two);
  });

  it('is defensive about junk and a throwing routing lookup', () => {
    expect(buildCronSessionKey(null)).toBe('cron:unknown:unknown');
    expect(buildCronSessionKey(j({}), { channelForAgent: () => { throw new Error('routes not loaded'); } }))
      .toBe('cron:agent-xx9aff:abc-123');
  });
});

// ── G7 (§12c.7): timeoutSeconds / model, mirrored from OpenClaw v2026.4.24 ────────
// ONE CEILING, NO PER-JOB BUDGET (2026-09-16 — archie-docs/archie-cron-budget-plan.md).
//
// Every assertion below used to be about `payload.timeoutSeconds`: defaults by kind, seconds→ms,
// 0/negative meaning unbounded, junk falling back. The field is no longer read, so those tests
// described behaviour that no longer exists. These replace them, and the property they hold is
// stronger than the old ones: NOTHING an author writes changes an agentTurn's budget.
describe('resolveCronTimeoutMs — one ceiling for every agent turn', () => {
  const j = (payload) => ({ agentId: 'a', jobId: 'j', payload });

  it('gives every agentTurn the ceiling, whatever timeoutSeconds says', () => {
    for (const timeoutSeconds of [undefined, 0, -1, 30, 300, 1.5, 99_999, 'nope', NaN, Infinity]) {
      const payload = { kind: 'agentTurn', message: 'x', ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) };
      expect(resolveCronTimeoutMs(j(payload))).toBe(CRON_TIMEOUT.AGENT_TURN_CEILING_MS);
    }
  });

  // 7h50m, and the ten-minute gap is the whole point: the runtime's session maxLifetime is 28800s
  // (agentcore-provisioning.js), so at an equal budget the two race and AgentCore's kill produces an
  // opaque platform error instead of CRON_TIMEOUT_ERROR — no CronTimeoutKill, no alarm, and
  // cron-hydrator files it as `failing-upstream` rather than `run-timeout`. Ours must fire first.
  it('sits BELOW the session maxLifetime so our timeout is the one that fires', () => {
    expect(CRON_TIMEOUT.AGENT_TURN_CEILING_MS).toBe(28_200_000);
    expect(CRON_TIMEOUT.AGENT_TURN_CEILING_MS).toBeLessThan(28_800_000);
  });

  // A systemEvent is a dispatcher-side operation, not an agent turn: one still running after ten
  // minutes is hung, not busy, so the reasoning that justifies 7h50m for a turn does not transfer.
  it('leaves systemEvent on the 10-minute default', () => {
    expect(resolveCronTimeoutMs(j({ kind: 'systemEvent', text: 'x' }))).toBe(CRON_TIMEOUT.DEFAULT_MS);
    expect(resolveCronTimeoutMs(j({ kind: 'systemEvent', text: 'x', timeoutSeconds: 5 }))).toBe(600_000);
  });

  it('is defensive about junk (a bad payload must not make a job unfireable)', () => {
    expect(resolveCronTimeoutMs({})).toBe(600_000);
    expect(resolveCronTimeoutMs(null)).toBe(600_000);
  });

  // No job can be unbounded any more. It never really could: "unbounded" only ever meant "killed by
  // the session lifetime instead of by us", i.e. killed with a worse error.
  it('never returns null', () => {
    for (const payload of [{ kind: 'agentTurn', timeoutSeconds: 0 }, { kind: 'agentTurn', timeoutSeconds: -1 }]) {
      expect(resolveCronTimeoutMs(j(payload))).not.toBeNull();
    }
  });
});

describe('resolveCronModel (G7)', () => {
  const j = (payload) => ({ agentId: 'a', jobId: 'j', payload });

  // Both forms exist in prod, measured 2026-08-10.
  it('strips a provider prefix and passes a bare id through', () => {
    expect(resolveCronModel(j({ kind: 'agentTurn', model: 'amazon-bedrock/global.anthropic.claude-sonnet-4-6' })))
      .toBe('global.anthropic.claude-sonnet-4-6');
    expect(resolveCronModel(j({ kind: 'agentTurn', model: 'global.anthropic.claude-opus-4-8' })))
      .toBe('global.anthropic.claude-opus-4-8');
  });

  it('is null when unset, blank, non-string, or on a systemEvent', () => {
    expect(resolveCronModel(j({ kind: 'agentTurn' }))).toBeNull();
    expect(resolveCronModel(j({ kind: 'agentTurn', model: '   ' }))).toBeNull();
    expect(resolveCronModel(j({ kind: 'agentTurn', model: 42 }))).toBeNull();
    expect(resolveCronModel(j({ kind: 'systemEvent', text: 'x', model: 'global.anthropic.claude-sonnet-4-6' }))).toBeNull();
    expect(resolveCronModel(null)).toBeNull();
  });

  it('trims and keeps only the first path segment as the provider', () => {
    expect(resolveCronModel(j({ kind: 'agentTurn', model: '  amazon-bedrock/eu.anthropic.claude-opus-4-6-v1  ' })))
      .toBe('eu.anthropic.claude-opus-4-6-v1');
  });
});

describe('DM channel ids are not portable — resolve to the user instead (§12c, 2026-08-16)', () => {
  const dmSession = 'session:agent:agent-xx9aff:slack:thread:dl1ha3ii6v6:1786814597.917519:dm:ux0mz5ckp2r';

  it('a D… target becomes the USER when the session names one', () => {
    // conversations.open(user) returns THE CALLING APP'S DM channel, so a D… id only means anything
    // to the app that minted it. Found live: every cron announce for a DM-scoped agent failed with
    // channel_not_found because the target belonged to the OpenClaw app and archie's could not see it.
    // The turn ran and produced output; only the post was rejected.
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce', to: 'DL1HA3II6V6' }, sessionTarget: dmSession }))
      .toEqual({ user: 'UX0MZ5CKP2R' });
  });

  it('every rung yields the SAME foreign DM, so the ladder alone cannot recover', () => {
    // to, channel and the session key all point at the same D… id for a DM-scoped job — which is why
    // this is a rewrite rather than another rung.
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce', channel: 'DL1HA3II6V6' }, sessionTarget: dmSession }))
      .toEqual({ user: 'UX0MZ5CKP2R' });
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce' }, sessionKey: dmSession }))
      .toEqual({ user: 'UX0MZ5CKP2R' });
  });

  it('C… and G… ids are LEFT ALONE — they mean the same conversation in every app', () => {
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce', to: 'C01MG6IP6C8' }, sessionTarget: dmSession }))
      .toEqual({ channel: 'C01MG6IP6C8' });
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce', to: 'GE7VZLNWGES' }, sessionTarget: dmSession }))
      .toEqual({ channel: 'GE7VZLNWGES' });
  });

  it('a D… target with no derivable user is left as authored, not dropped', () => {
    // Losing the target would turn a job that works under one app into one that targets nothing.
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce', to: 'DL1HA3II6V6' } }))
      .toEqual({ channel: 'DL1HA3II6V6' });
  });

  it('an explicit user target is unaffected', () => {
    expect(resolveDeliveryTarget({ delivery: { mode: 'announce', to: 'user:UX0MZ5CKP2R' } }))
      .toEqual({ user: 'UX0MZ5CKP2R' });
  });
});

// ── §8.10: the owning scope is a destination ────────────────────────────────
// A cron owned by a DM-scoped agent needs NO delivery config: `dm-<userId>` names the human, and
// that is the one source that cannot go stale (the other three rungs all record where the job was
// authored). Last rung, so an explicit destination still wins.
describe('a DM scope is its own delivery target (§8.10)', () => {
  const dm = { agentId: 'dm-ux0mz5ckp2r', jobId: 'j' };

  it('announce with NOTHING configured resolves to the scope owner', () => {
    expect(resolveDeliveryTarget({ ...dm, delivery: { mode: 'announce' } }))
      .toEqual({ user: 'UX0MZ5CKP2R' });
    // and therefore classifies as valid rather than parking the job at hydration
    expect(classifyDelivery({ ...dm, delivery: { mode: 'announce' } }).status).toBe(DELIVERY_STATUS.OK);
  });

  it('recovers a foreign D… id that the session key cannot — the archie cron tool writes exactly this', () => {
    // `slack:thread:D…:<ts>` has no `:dm:<user>` suffix, so before this the ladder returned the
    // OpenClaw app's DM channel and chat.postMessage answered channel_not_found.
    expect(resolveDeliveryTarget({
      ...dm,
      delivery: { mode: 'announce', channel: 'D0RTQN213NN' },
      sessionKey: 'slack:thread:D0RTQN213NN:1786881678.352119',
    })).toEqual({ user: 'UX0MZ5CKP2R' });
  });

  it('an OpenClaw transport selector alone now resolves instead of being unusable', () => {
    expect(resolveDeliveryTarget({ ...dm, delivery: { mode: 'announce', channel: 'slack' } }))
      .toEqual({ user: 'UX0MZ5CKP2R' });
  });

  it('LAST rung — an explicit channel still wins, so a DM agent can post to #eng', () => {
    expect(resolveDeliveryTarget({ ...dm, delivery: { mode: 'announce', to: 'C01MG6IP6C8' } }))
      .toEqual({ channel: 'C01MG6IP6C8' });
    expect(resolveDeliveryTarget({ ...dm, delivery: { mode: 'announce' }, sessionKey: 'slack:thread:C01MG6IP6C8:1.2' }))
      .toEqual({ channel: 'C01MG6IP6C8' });
  });

  it('a ch- scope derives NOTHING — that would be a behaviour change, not a recovery', () => {
    expect(resolveDeliveryTarget({ agentId: 'ch-c66pp782t9k', jobId: 'j', delivery: { mode: 'announce' } }))
      .toBeNull();
  });

  it('userFromScopeId: lossless case recovery, and null for anything that is not a DM scope', () => {
    expect(userFromScopeId('dm-ux0mz5ckp2r')).toBe('UX0MZ5CKP2R');
    expect(userFromScopeId('DM-UX0MZ5CKP2R')).toBe('UX0MZ5CKP2R');
    expect(userFromScopeId('ch-c66pp782t9k')).toBeNull();
    expect(userFromScopeId('agent-xx9aff')).toBeNull();
    expect(userFromScopeId('dm-notauserid')).toBeNull(); // must start U
    expect(userFromScopeId(null)).toBeNull();
  });
});

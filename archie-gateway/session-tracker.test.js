'use strict';

const { createSessionTracker } = require('./session-tracker');

// A controllable clock: these semantics are entirely about elapsed time, so real timers would make the
// suite slow AND flaky at the boundaries that matter most.
function mk(overrides = {}) {
  let t = 1_800_000_000_000;
  const tracker = createSessionTracker({ now: () => t, ...overrides });
  return { tracker, advance: (ms) => { t += ms; }, at: () => t };
}

describe('createSessionTracker', () => {
  it('reports the first invoke of a session as first_use, with no age', () => {
    const { tracker } = mk();
    const info = tracker.touch('ac-slack-thread-C1-1');
    expect(info.firstUse).toBe(true);
    expect(info.ageMs).toBeNull();
    expect(info.idleExpired).toBe(false);
  });

  it('reports a repeat inside the idle window as NOT first_use and NOT expired', () => {
    const { tracker, advance } = mk();
    tracker.touch('s1');
    advance(101_000);                    // ~the measured p50 follow-up gap
    const info = tracker.touch('s1');
    expect(info.firstUse).toBe(false);
    expect(info.ageMs).toBe(101_000);
    expect(info.idleExpired).toBe(false);
  });

  it('flags idle_expired when the gap exceeds the runtime idle timeout', () => {
    // The actionable case: we HAD a session and lost it to the timeout, so we pay full new-session
    // cost on something that could have been warm.
    const { tracker, advance } = mk();
    tracker.touch('s1');
    advance(900_001);
    const info = tracker.touch('s1');
    expect(info.firstUse).toBe(false);
    expect(info.idleExpired).toBe(true);
  });

  it('treats EXACTLY the idle timeout as expired', () => {
    // At the boundary the session is already gone; reporting it reusable would understate the metric.
    const { tracker, advance } = mk();
    tracker.touch('s1');
    advance(900_000);
    expect(tracker.touch('s1').idleExpired).toBe(true);
  });

  it('tracks sessions independently', () => {
    const { tracker, advance } = mk();
    tracker.touch('a');
    advance(60_000);
    tracker.touch('b');
    expect(tracker.touch('a').ageMs).toBe(60_000);
    expect(tracker.touch('b').ageMs).toBe(0);
  });

  it('PRUNES entries past maxLifetime — the map must not grow per-thread forever', () => {
    // One entry per Slack thread ever seen is the unbounded-Map failure mode the in-process runtime
    // cache already taught us. A session cannot outlive maxLifetime, so the entry can never be a reuse.
    const { tracker, advance } = mk({ maxLifetimeMs: 10_000 });
    tracker.touch('old1');
    tracker.touch('old2');
    expect(tracker._size()).toBe(2);
    advance(10_001);
    tracker.touch('fresh');              // prune runs on the way through
    expect(tracker._size()).toBe(1);
    // And the pruned session reads as first_use again, which is correct: it genuinely cannot be warm.
    expect(tracker.touch('old1').firstUse).toBe(true);
  });

  it('does not prune inside the lifetime window', () => {
    const { tracker, advance } = mk({ maxLifetimeMs: 60_000 });
    tracker.touch('s1');
    advance(30_000);
    tracker.touch('s2');
    expect(tracker._size()).toBe(2);
  });

  it('stamps tracker uptime so a reader can discount post-restart samples', () => {
    // This state is per-process: after a restart a genuinely warm session reads as first_use. Rather
    // than hide that, the sample carries how long the tracker has known anything.
    const { tracker, advance } = mk();
    advance(5_000);
    expect(tracker.touch('s1').trackerUptimeMs).toBe(5_000);
  });

  it('builds span attributes named for what is actually known', () => {
    const { tracker, advance } = mk();
    const first = tracker.attributesFor(tracker.touch('s1'));
    // NOT `session.reused` — AgentCore owns that decision and never tells us.
    expect(first['session.first_use']).toBe(1);
    expect(first).not.toHaveProperty('session.last_use_age_ms');   // no age on a first use
    advance(1_000);
    const second = tracker.attributesFor(tracker.touch('s1'));
    expect(second['session.first_use']).toBe(0);
    expect(second['session.last_use_age_ms']).toBe(1_000);
  });

  it('emits flags as 1/0 NUMBERS — booleans are invisible to Logs Insights', () => {
    // Live-verified: on the same span, ispresent() on a boolean attribute matched zero rows while a
    // numeric attribute matched. The query returns EMPTY rather than failing, so a dashboard would have
    // read "every session is new" indefinitely.
    const { tracker, advance } = mk();
    const a = tracker.attributesFor(tracker.touch('s1'));
    expect(typeof a['session.first_use']).toBe('number');
    expect(typeof a['session.idle_expired']).toBe('number');
    advance(900_001);
    const b = tracker.attributesFor(tracker.touch('s1'));
    expect(b['session.idle_expired']).toBe(1);
    expect(typeof b['session.idle_expired']).toBe('number');
  });

  it('survives a missing sessionId without recording a bogus entry', () => {
    const { tracker } = mk();
    expect(tracker.touch(undefined).firstUse).toBe(true);
    expect(tracker._size()).toBe(0);
    expect(tracker.attributesFor(null)).toEqual({});
  });

  it('counts first-use / repeat / expired for the metric emitter', () => {
    const { tracker, advance } = mk();
    tracker.touch('a');                  // first
    tracker.touch('b');                  // first
    advance(1_000);
    tracker.touch('a');                  // repeat
    advance(900_001);
    tracker.touch('b');                  // repeat + expired
    const s = tracker.stats();
    expect(s).toMatchObject({ firstUse: 2, repeat: 2, idleExpired: 1, tracked: 2 });
  });
});

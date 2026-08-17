'use strict';

// Shared virtual clock for the cron test suites (not a *.test.js — a helper module).
// It drives the runner's injectable-clock seam so scheduling/recovery are fully
// deterministic with no wall-clock sleeps.
//
// advance(ms) fires due timers in due order, moving `now` to each timer's scheduled
// instant, and launches each callback fire-and-forget (a long fire that awaits a
// FUTURE virtual timer must NOT block advance — that would deadlock). Between timers
// it drains the ENTIRE microtask queue via a setImmediate boundary, so an async fire
// chain built only from resolved promises (mocked invoke/ecs/deliver — no real timers)
// settles completely before virtual time moves on, while a fire that is genuinely
// still waiting on a future virtual timer stays pending (correct overlap semantics).

class FakeClock {
  constructor(startMs = 0) {
    this.nowMs = startMs;
    this.timers = [];
    this.seq = 0;
    this._err = null;
  }

  now() { return this.nowMs; }

  setTimeout(fn, ms) {
    const id = (this.seq += 1);
    this.timers.push({ id, dueAt: this.nowMs + Math.max(0, ms), fn });
    return id;
  }

  clearTimeout(id) { this.timers = this.timers.filter((t) => t.id !== id); }

  // A setImmediate boundary drains all queued microtasks (including chained
  // continuations); two boundaries is cheap insurance against a continuation that
  // queues another microtask after the first drain.
  async flush() {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }

  async advance(ms) {
    const target = this.nowMs + ms;
    await this.flush();
    for (;;) {
      const due = this.timers
        .filter((t) => t.dueAt <= target)
        .sort((a, b) => a.dueAt - b.dueAt || a.id - b.id);
      if (due.length === 0) break;
      const t = due[0];
      this.timers = this.timers.filter((x) => x.id !== t.id);
      this.nowMs = t.dueAt;
      Promise.resolve(t.fn()).catch((e) => { this._err = e; }); // launch, don't block
      await this.flush();
    }
    this.nowMs = target;
    await this.flush();
    if (this._err) { const e = this._err; this._err = null; throw e; }
  }
}

module.exports = { FakeClock };

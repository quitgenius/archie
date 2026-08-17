'use strict';

// One backpressure notice per thread per window. A burst that overflows the queue overflows it once
// per excess message, so N identical "too many messages" posts would be its own kind of spam. This
// notice is the ONLY signal a skipped message gets — the per-message ⛔ reaction that used to pair
// with it is gone (reactions were removed entirely), so the text has to carry the whole explanation.
function createBackpressureNotifier({ windowMs = 60 * 1000 } = {}) {
  const announcedAt = new Map();
  return function shouldAnnounce(channel, threadTs) {
    const key = `${channel}:${threadTs || channel}`;
    const now = Date.now();
    if (now - (announcedAt.get(key) || 0) < windowMs) return false;
    announcedAt.set(key, now);
    for (const [k, t] of announcedAt) if (now - t > windowMs) announcedAt.delete(k); // bound the map
    return true;
  };
}

module.exports = { createBackpressureNotifier };

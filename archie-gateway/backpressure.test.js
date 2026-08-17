'use strict';

const { createBackpressureNotifier } = require('./backpressure');

describe('backpressure notifier', () => {
  it('announces once per thread per window — N rejections do not post N notices', () => {
    const should = createBackpressureNotifier({ windowMs: 60_000 });
    expect(should('C', 'th')).toBe(true);
    expect(should('C', 'th')).toBe(false);
    expect(should('C', 'th')).toBe(false);
  });

  it('different threads each get their own notice', () => {
    const should = createBackpressureNotifier({ windowMs: 60_000 });
    expect(should('C', 'th1')).toBe(true);
    expect(should('C', 'th2')).toBe(true);
  });

  it('announces again after the window passes', async () => {
    const should = createBackpressureNotifier({ windowMs: 5 });
    expect(should('C', 'th')).toBe(true);
    await new Promise((r) => setTimeout(r, 12));
    expect(should('C', 'th')).toBe(true);
  });
});

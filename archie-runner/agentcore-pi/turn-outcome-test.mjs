import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn } from './turn-outcome.mjs';


// Ordering matters: a queued invoke has no text, so it would match the `empty` branch first. Empty is
// a REAL turn (the model ran and said nothing) and gets metered; queued never ran and must not be.

test('a genuine error wins over empty — including Pi\'s "already processing" if isolation ever leaks', () => {
  const cls = classifyTurn({ errorMessage: 'Agent is already processing. Specify streamingBehavior…', text: '' });
  assert.equal(cls.outcome, 'error');
  assert.equal(cls.isError, true);   // NOT swallowed as a success, which is what dropped 15 messages
});

test('a normal reply carries its stopReason', () => {
  assert.deepEqual(classifyTurn({ text: 'hi', stopReason: 'stop' }),
    { outcome: 'reply', finishReasons: 'stop', isError: false });
  assert.equal(classifyTurn({ text: 'hi' }).finishReasons, 'stop'); // default
});

test('junk input never throws (classification must not break a turn)', () => {
  for (const bad of [undefined, null, {}]) {
    assert.equal(classifyTurn(bad).outcome, 'empty');
  }
});


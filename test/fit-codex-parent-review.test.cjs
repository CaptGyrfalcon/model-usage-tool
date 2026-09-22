const test = require('node:test');
const assert = require('node:assert/strict');
const { reviewParentModel, pointsByParent } = require('../scripts/fit-codex-parent-review.cjs');

test('review inherits the immediate parent model active at the event time', () => {
  const child = '11111111-1111-1111-1111-111111111111';
  const parent = '22222222-2222-2222-2222-222222222222';
  const sessions = new Map([
    [child, { parent, models: [] }],
    [parent, { parent: null, models: [
      { timestamp: 100, model: 'gpt-6-astra' },
      { timestamp: 300, model: 'gpt-5.6-luna' },
    ] }],
  ]);
  const event = timestamp => ({ event_key: `codex:v2:${child}:1:2:3:4`, timestamp });
  assert.equal(reviewParentModel(event(200), sessions), 'gpt-6-astra');
  assert.equal(reviewParentModel(event(400), sessions), 'gpt-5.6-luna');
  assert.equal(reviewParentModel(event(50), sessions), null);
  const data = { models: ['gpt-6-astra', 'gpt-5.6-luna'],
    events: [{ ...event(200), model: 'codex-auto-review', input_tokens: 1_000_000,
      cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 }],
    samples: [{ timestamp: 200, percent: 1 }] };
  const result = pointsByParent(data, sessions);
  assert.equal(result.parentCounts['gpt-6-astra'], 1);
  assert.equal(result.points[0].dollars[0], 10);
});

const test = require('node:test');
const assert = require('node:assert/strict');
const { rateCost, continuousFit, rankedGrid } = require('../scripts/fit-codex-quota-prices.cjs');

test('review price excludes cached input from uncached input', () => {
  const row = { input_tokens: 1_000_000, cache_read_tokens: 500_000,
    cache_write_tokens: 0, output_tokens: 100_000 };
  assert.ok(Math.abs(rateCost(row, 'gpt-5.6-sol') - 4.2) < 1e-10);
});

test('continuous fit recovers independent nonnegative model weights', () => {
  const points = [
    { percent: 3, dollars: [1, 0] },
    { percent: 8, dollars: [1, 1] },
    { percent: 14, dollars: [3, 1] },
    { percent: 24, dollars: [3, 3] },
  ];
  const fit = continuousFit(points);
  assert.ok(Math.abs(fit.coefficients[0] - 3) < 1e-7);
  assert.ok(Math.abs(fit.coefficients[1] - 5) < 1e-7);
  assert.ok(fit.rmse < 1e-7);
  const fixed = continuousFit(points, { index: 0, capacity: 100 / 3 });
  assert.ok(Math.abs(fixed.coefficients[0] - 3) < 1e-7);
  assert.ok(Math.abs(fixed.coefficients[1] - 5) < 1e-7);
});

test('grid evaluates free and priced review cases without mutating events', () => {
  const events = [
    { timestamp: 1, model: 'gpt-5.6-sol', quota_equivalent_cost_cents: 100,
      input_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
    { timestamp: 2, model: 'codex-auto-review', input_tokens: 1_000_000,
      cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 0 },
  ];
  const data = { models: ['gpt-5.6-sol'], events,
    samples: [{ timestamp: 1, percent: 1 }, { timestamp: 2, percent: 5 }] };
  const result = rankedGrid(data, 'gpt-5.6-sol', 10);
  assert.equal(result.tried, 7);
  assert.equal(result.top[0].review, 'gpt-5.6-sol');
  assert.equal(events[1].quota_equivalent_cost_cents, undefined);
});

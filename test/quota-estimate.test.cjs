const test = require('node:test');
const assert = require('node:assert/strict');
const { estimateQuota } = require('../src/quota-estimate.cjs');
const window = { resetsAt: 60000, windowMinutes: 1 };
const sample = (timestamp, usedPercent, extra = {}) => ({ source: 'codex', ...window, timestamp, usedPercent, planType: 'plus', ...extra });
const event = (timestamp, cost, extra = {}) => ({ source: 'codex', timestamp, quotaEquivalentCostCents: cost, ...extra });
const estimate = (samples, events, extra = {}) => estimateQuota({ window, sampledAt: 10000, planType: 'plus', samples, events, rounding: 'floor', ...extra });

test('every point participates, including unchanged percentages; midpoint is displayed', () => {
  const events = [event(1, 10.1), event(2, 9.7), event(3, 0.4)];
  const first = estimate([sample(1, 1), sample(3, 2)], events);
  const all = estimate([sample(1, 1), sample(2, 1), sample(3, 2)], events);
  assert.ok(all.inferredTotalLowCents > first.inferredTotalLowCents);
  assert.ok(Math.abs(all.inferredTotalLowCents - 990) < 1e-8);
  assert.ok(Math.abs(all.inferredTotalHighCents - 1010) < 1e-8);
  assert.ok(Math.abs(all.inferredTotalCents - 1000) < 1e-8);
  assert.equal(all.sampleCount, 3);
});
test('other resets, plans, windows and future samples cannot constrain current cycle', () => {
  const valid = sample(1, 2);
  const rows = [valid, sample(2, 90, { resetsAt: 180000 }), sample(2, 90, { planType: 'pro' }),
    sample(2, 90, { windowMinutes: 2 }), sample(20000, 90)];
  assert.deepEqual(estimate(rows, [event(1, 20)]), estimate([valid], [event(1, 20)]));
});
test('zero, missing price, expired and conflicting samples never fabricate midpoint', () => {
  assert.equal(estimate([sample(1, 0)], [event(1, 1)]).estimateStatus, 'unbounded');
  assert.equal(estimate([sample(1, 2)], [event(1, null)]).estimateStatus, 'unpriced-events');
  const conflict = estimate([sample(1, 2), sample(2, 90)], [event(1, 20)]);
  assert.equal(conflict.estimateStatus, 'inconsistent');
  assert.equal(conflict.inferredTotalCents, null);
  assert.equal(estimate([sample(1, 2)], [event(1, 20)], { window: { ...window, expired: true } }).inferredTotalCents, null);
});
test('cost bounds and unknown rounding remain conservative; Spark is excluded', () => {
  const r = estimate([sample(1, 5)], [event(1, 50, { quotaEquivalentCostLowCents: 45, quotaEquivalentCostHighCents: 55 }), event(1, 1000, { model: 'spark' })], { rounding: 'unknown' });
  assert.equal(r.inferredTotalLowCents, 750);
  assert.equal(r.inferredTotalHighCents, 1375);
  assert.equal(r.inferredTotalCents, 1062.5);
});
test('100 percent saturation supplies only an upper capacity bound', () => {
  const r = estimate([sample(1, 100)], [event(1, 1100)]);
  assert.equal(r.inferredTotalLowCents, 0);
  assert.equal(r.inferredTotalHighCents, 1100);
});

test('unreliable raw observations cannot affect the estimate', () => {
  const events = [event(1, 20)];
  assert.deepEqual(estimate([sample(1, 2), sample(2, 99, { quality: 'conflicting-timestamp' })], events),
    estimate([sample(1, 2)], events));
});

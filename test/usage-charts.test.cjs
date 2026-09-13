const test = require("node:test");
const assert = require("node:assert/strict");
const { modelSlices, uniformRemaining, uniformSegment } = require("../src/renderer/usage-charts.js");
const { buildModelUsage } = require("../src/lib.cjs");
const { buildQuotaTimeline } = require("../src/quota-timeline.cjs");

test("uniform usage is anchored to the cycle and clipped without extending the data domain", () => {
  const cycle = { reference: { startAt: 0, endAt: 1000 } };
  assert.equal(uniformRemaining(cycle, 0), 100);
  assert.equal(uniformRemaining(cycle, 1000), 0);
  assert.deepEqual(uniformSegment(cycle, 200, 400), [{ at: 200, remainingPercent: 80 }, { at: 400, remainingPercent: 60 }]);
  assert.deepEqual(uniformSegment(cycle, -100, 1200), [{ at: 0, remainingPercent: 100 }, { at: 1000, remainingPercent: 0 }]);
  assert.deepEqual(uniformSegment(cycle, 1100, 1200), []);
  assert.deepEqual(uniformSegment({ reference: { startAt: 1, endAt: 1 } }, 1, 1), []);
  assert.equal(uniformRemaining({}, 20), null);
});

test("current Cursor reference uses its actual 31-day billing period, not first sample", () => {
  const start = Date.UTC(2026, 7, 1), end = Date.UTC(2026, 8, 1), now = start + 10 * 86400000;
  const sample = { source: "cursor", pool: "cursor-models", timestamp: now, usedPercent: 40, resetsAt: end, startsAt: start };
  const timeline = buildQuotaTimeline([], { now, live: [sample] });
  assert.deepEqual(timeline.cycle.reference, { startAt: start, endAt: end, estimated: false });
  assert.equal(timeline.series.length, 1);
  assert.equal(timeline.series[0].at, now);
  assert.ok(Math.abs(uniformRemaining(timeline.cycle, now) - 100 * 21 / 31) < 1e-10);
});

test("Codex reference recovers the full window even when collection starts mid-cycle", () => {
  const end = 10 * 3600000, now = end - 3600000;
  const timeline = buildQuotaTimeline([], { pool: "codex-300", now, live: [{ source: "codex", pool: "primary-300", timestamp: now, usedPercent: 70, windowMinutes: 300, resetsAt: end }] });
  assert.equal(timeline.cycle.reference.startAt, end - 5 * 3600000);
  assert.equal(uniformRemaining(timeline.cycle, now), 20);
  assert.equal(timeline.series.at(-1).at, now);
});

test("unknown cycle ends omit the line and guessed Cursor starts are marked", () => {
  const base = { source: "cursor", pool: "cursor-models", timestamp: 1000, usedPercent: 25 };
  assert.equal(buildQuotaTimeline([base], { now: 1200 }).cycle.reference, null);
  assert.equal(buildQuotaTimeline([{ ...base, resetsAt: 2000 }], { now: 1200 }).cycle.reference.estimated, true);
});

function usage() {
  const at = Date.UTC(2026, 8, 7);
  return buildModelUsage([
    { source: "codex", model: "gpt-5.6-sol", timestamp: at + 0, effort: "high", fast: false, fastKnown: true, input: 20, output: 10, equivalentCostCents: 2 },
    { source: "codex", model: "gpt-5.6-sol", timestamp: at + 1, effort: "high", fast: true, fastKnown: false, input: 30, output: 10, cacheRead: 10, equivalentCostCents: 3 },
    { source: "codex", model: "gpt-5.6-sol", timestamp: at + 2, effort: "low", fast: true, fastKnown: true, input: 10, output: 10, equivalentCostCents: 5 },
    { source: "cursor", model: "gpt-5.6-sol", timestamp: at + 3, effort: "high", fast: false, fastKnown: true, input: 40, output: 10, equivalentCostCents: 4 },
  ], "all", at + 2000);
}

test("donut folds unknown Codex speed into non-Fast, preserving list data and every amount", () => {
  const data = usage();
  const before = JSON.stringify(data);
  const slices = modelSlices(data.sources, { source: "codex", precision: "speed" });
  assert.equal(slices.rows.length, 2);
  const normal = slices.rows.find((row) => row.label === "GPT 5.6 Sol");
  assert.equal(normal.total, 80);
  assert.equal(normal.count, 2);
  assert.equal(normal.costCents, 5);
  assert.equal(slices.total, 100);
  assert.equal(JSON.stringify(data), before);
  assert.ok(data.sources.codex.modelBreakdowns.speed.some((row) => !row.fastKnown));
});

test("donut shares source and precision filters and keeps metric sums intact", () => {
  const sources = usage().sources;
  assert.equal(modelSlices(sources, { source: "all", precision: "coarse" }).rows.length, 1);
  assert.equal(modelSlices(sources, { source: "all", precision: "speed" }).total, 150);
  assert.equal(modelSlices(sources, { source: "cursor", precision: "speed" }).total, 50);
  assert.equal(modelSlices(sources, { source: "codex", precision: "exact", metric: "effective" }).total, 90);
  const cost = modelSlices(sources, { source: "all", precision: "exact", metric: "costCents" });
  assert.equal(cost.total, 14);
  assert.equal(cost.rows.length, 2);
  assert.ok(Math.abs(cost.rows.reduce((sum, row) => sum + row.percent, 0) - 100) < 1e-10);
});

test("donut retains tiny and zero groups without NaN or arbitrary truncation", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ name: `model-${i}`, total: i, costCents: 0 }));
  const sources = { codex: { modelBreakdowns: { coarse: rows } } };
  assert.equal(modelSlices(sources).rows.length, 50);
  const emptyCost = modelSlices(sources, { metric: "costCents" });
  assert.equal(emptyCost.total, 0);
  assert.ok(emptyCost.rows.every((row) => row.percent === 0));
});

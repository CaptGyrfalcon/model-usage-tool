const test = require("node:test");
const assert = require("node:assert/strict");
const { ImmutableAggregateCache } = require("../src/immutable-aggregate-cache.cjs");
const { buildModelBreakdowns, buildModelUsage } = require("../src/lib.cjs");

test("aggregate cache observes row corrections, rolling selection, options, and protects returned values", () => {
  const cache = new ImmutableAggregateCache(2);
  const a = Object.freeze({ input: 10 }), b = Object.freeze({ input: 20 });
  let builds = 0;
  const get = (rows, key = "default") => cache.get(key, rows, () => {
    builds++; return { total: rows.reduce((sum, row) => sum + row.input, 0) };
  });
  get([a,b]).total = 999;
  assert.equal(get([a,b]).total, 30);
  assert.equal(builds, 1);
  assert.equal(get([a,Object.freeze({ input: 30 })]).total, 40);
  assert.equal(get([b]).total, 20);
  get([b], "other");
  const previous = builds;
  get([a,b]);
  assert.equal(builds, previous + 1, "evicted rows are rebuilt");
});

test("mutable input and nested token usage cannot be cached as immutable history", () => {
  const cache = new ImmutableAggregateCache();
  const row = { input: 10 };
  const get = () => cache.get("x", [row], () => row.input);
  assert.equal(get(), 10); row.input = 20; assert.equal(get(), 20);
  const nested = Object.freeze({ tokenUsage: { inputTokens: 10 } });
  const nestedGet = () => cache.get("nested", [nested], () => nested.tokenUsage.inputTokens);
  assert.equal(nestedGet(), 10); nested.tokenUsage.inputTokens=30; assert.equal(nestedGet(), 30);
});

test("model cache preserves precision, Auto pool options and rolling-window boundaries", () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const a = Object.freeze({ source: "cursor", model: "test-high-fast", timestamp: now - 86400000 + 1,
    fast: true, fastKnown: false, effort: "low", input: 10, equivalentCostCents: 3 });
  const b = Object.freeze({ source: "codex", model: "test", timestamp: now, input: 20 });
  const first = buildModelBreakdowns([a,b]);
  assert.equal(first.coarse[0].total, 30);
  assert.equal(first.exact.find(row => row.fastKnown === false).effort, "low");
  first.coarse[0].total=999;
  assert.equal(buildModelBreakdowns([a,b]).coarse[0].total, 30);
  assert.equal(buildModelBreakdowns([a], [a.model]).coarse[0].cursor, true);
  assert.equal(buildModelBreakdowns([a]).coarse[0].cursor, false);
  assert.equal(buildModelUsage([a,b], "day1", now).sources.all.eventCount, 2);
  assert.equal(buildModelUsage([a,b], "day1", now + 2).sources.all.eventCount, 1);
  const corrected = Object.freeze({ ...b, input: 50 });
  assert.equal(buildModelBreakdowns([a,corrected]).coarse[0].total, 60);
});

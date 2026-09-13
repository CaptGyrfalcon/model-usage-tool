const test = require("node:test");
const assert = require("node:assert/strict");
const { spec, normalize } = require("../src/renderer/trend-range.js");
const { buildTrendSeries, getTrendUsage } = require("../src/lib.cjs");

test("rolling ranges use the next smaller unit and retain partial calendar buckets", () => {
  const now = new Date(2026, 8, 12, 12, 30, 15).getTime();
  for (const [unit, bucket] of [["hour", "minute"], ["day", "hour"], ["week", "day"], ["month", "week"], ["year", "month"]]) {
    const range = spec({ count: 2, unit }, now);
    assert.equal(range.bucket, bucket);
    assert.equal(range.boundaries[0], range.start);
    assert.equal(range.boundaries.at(-1), now + 1);
    assert.ok(range.boundaries.every((value, index, all) => !index || value > all[index - 1]));
    const date = new Date(range.boundaries[1]);
    assert.equal(date.getSeconds(), 0);
    if (bucket !== "minute") assert.equal(date.getMinutes(), 0);
    if (["day", "week", "month"].includes(bucket)) assert.equal(date.getHours(), 0);
    if (bucket === "week") assert.equal(date.getDay(), 1);
    if (bucket === "month") assert.equal(date.getDate(), 1);
  }
  assert.equal(spec({ count: 2, unit: "hour" }, now).boundaries.length - 1, 121);
  assert.equal(spec({ count: 2, unit: "day" }, now).boundaries.length - 1, 49);
});

test("calendar month and year subtraction clamps month ends and leap days", () => {
  const march = new Date(2024, 2, 31, 12).getTime();
  assert.equal(spec({ count: 1, unit: "month" }, march).start, new Date(2024, 1, 29, 12).getTime());
  const leap = new Date(2024, 1, 29, 12).getTime();
  assert.equal(spec({ count: 1, unit: "year" }, leap).start, new Date(2023, 1, 28, 12).getTime());
});

test("custom trends include boundaries once, omit out-of-range data and preserve model totals", () => {
  const now = new Date(2026, 8, 12, 12, 30, 15).getTime();
  for (const unit of ["hour", "day", "week", "month", "year"]) {
    const payload = { count: 1, unit };
    const range = spec(payload, now);
    const events = [range.start - 1, range.start, range.boundaries[1], now, now + 1].map((timestamp, i) => ({
      timestamp, model: i % 2 ? "gpt-5.6-sol-high-fast" : "gpt-5.6-sol-low",
      input: 10, output: 2, cacheRead: 8, equivalentCostCents: 3,
    }));
    const series = buildTrendSeries(events, payload, now);
    assert.equal(series.reduce((sum, row) => sum + row.count, 0), 3);
    assert.equal(series.reduce((sum, row) => sum + row.total, 0), 60);
    assert.equal(series.reduce((sum, row) => sum + (row.models["gpt-5.6-sol"]?.equivalentCostCents || 0), 0), 9);
    assert.equal(series[0].count, 1);
    assert.equal(series[1].count, 1);
    assert.equal(series.at(-1).count, 1);
  }
});

test("custom history queries cover years and separate sources", () => {
  const now = new Date(2026, 8, 12, 12).getTime();
  const payload = { count: 2, unit: "year" };
  let query;
  const history = { getEvents(options) {
    query = options;
    return ["cursor", "codex"].map((source) => ({ source, timestamp: new Date(2025, 0, 1).getTime(), model: "gpt-5.6-sol", input: 20, equivalentCostCents: 5 }));
  } };
  const data = getTrendUsage(payload, now, history);
  assert.equal(query.start, new Date(2024, 8, 12, 12).getTime());
  assert.equal(query.end, now + 1);
  const total = (source) => data.sources[source].trends.custom.reduce((sum, row) => sum + row.total, 0);
  assert.equal(total("all"), 40);
  assert.equal(total("cursor"), 20);
  assert.equal(total("codex"), 20);
});

test("invalid custom ranges are rejected before generating buckets", () => {
  for (const count of [0, -1, 1.5, "", NaN, Infinity, 101]) {
    assert.throws(() => normalize({ count, unit: "hour" }), /1–100/);
  }
  assert.throws(() => normalize({ count: 1, unit: "decade" }), /请选择/);
  assert.deepEqual(normalize({ count: "3", unit: "week" }), { count: 3, unit: "week" });
});

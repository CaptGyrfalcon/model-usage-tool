const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeModelDescriptor, buildModelBreakdowns, buildTrendSeries, collapseCursorSnapshots, costSummary, currentCodexRateWindow, inferPoolQuota, isCursorModel, pickUsagePercent, speedUsageSummary, buildModelUsage } = require("../src/lib.cjs");

function event(timestamp, model, input = 0, output = 0, cacheRead = 0, chargedCents = 0) {
  return {
    timestamp: String(timestamp),
    model,
    chargedCents,
    tokenUsage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead },
  };
}

test("trend model groups merge effort and speed across sources without losing usage", () => {
  const now = new Date(2026, 8, 12, 12, 30).getTime();
  const events = [
    { model: "cursor-gpt-5.6-sol-high-fast", source: "cursor", fast: true, fastKnown: true },
    { model: "gpt-5.6-sol", source: "codex", effort: "low", fast: false, fastKnown: true },
    { model: "gpt-5.6-sol-xhigh", source: "codex", fastKnown: false },
    { model: "grok-4.6", source: "cursor" },
  ].map((row) => ({ ...row, timestamp: now, input: 10, output: 2, cacheRead: 8,
    equivalentCostCents: 3, inputCostCents: 1, outputCostCents: 2 }));
  for (const range of ["day", "week", "month"]) {
    const bucket = buildTrendSeries(events, range, now).find((row) => row.count);
    assert.deepEqual(Object.keys(bucket.models).sort(), ["gpt-5.6-sol", "grok-4.6"]);
    assert.equal(bucket.models["gpt-5.6-sol"].total, 60);
    for (const metric of ["total", "effective", "equivalentCostCents", "inputCostCents", "outputCostCents"]) {
      assert.equal(Object.values(bucket.models).reduce((sum, row) => sum + row[metric], 0), bucket[metric]);
    }
  }
});

test("normalizes Fast and thinking effort independently", () => {
  assert.deepEqual(normalizeModelDescriptor("cursor-grok-4.6-xhigh-fast"), {
    original: "cursor-grok-4.6-xhigh-fast",
    clean: "grok-4.6-xhigh-fast",
    base: "grok-4.6",
    fast: true,
    effort: "xhigh",
  });
  assert.equal(normalizeModelDescriptor("gpt-5.6-sol").base, "gpt-5.6-sol");
  assert.equal(normalizeModelDescriptor("claude-fable-5-thinking-high").base, "claude-fable-5-thinking");
});

test("classifies Grok and Composer in Cursor Models and infers pools independently", () => {
  assert.equal(isCursorModel("cursor-grok-4.6-xhigh-fast"), true);
  assert.equal(isCursorModel("composer-2.5-fast"), true);
  assert.equal(isCursorModel("gpt-5.6-sol"), false);
  const estimate = inferPoolQuota({ equivalentCostCents: 6_100 }, 61);
  assert.equal(estimate.inferredTotalCents, 10_000);
  assert.equal(estimate.packageTotalSource, "usage-percent");
});

test("uses the higher-precision Cursor usage percent to infer pool capacity", () => {
  assert.equal(pickUsagePercent(98.1, 98.109), 98.109);
  assert.equal(pickUsagePercent(3.64, 3.64123), 3.64123);
  assert.equal(pickUsagePercent(1.47, 1.4666666666666666), 1.4666666666666666);
  assert.equal(pickUsagePercent(null, 61.37), 61.37);
  const coarse = inferPoolQuota({ equivalentCostCents: 4_367.78 }, 3.64);
  const fine = inferPoolQuota({ equivalentCostCents: 4_367.78 }, 3.64123);
  assert.notEqual(coarse.inferredTotalCents, fine.inferredTotalCents);
  assert.ok(Math.abs(fine.inferredTotalCents - 4_367.78 / 0.0364123) < 1e-6);
});

test("builds the three requested model precision levels", () => {
  const events = [
    event(1, "cursor-grok-4.6-high", 100, 20),
    event(2, "cursor-grok-4.6-xhigh", 200, 20),
    event(3, "cursor-grok-4.6-xhigh-fast", 300, 20),
  ];
  const result = buildModelBreakdowns(events);
  assert.equal(result.coarse.length, 1);
  assert.equal(result.coarse[0].count, 3);
  assert.equal(result.speed.length, 2);
  assert.equal(result.exact.length, 3);
  assert.equal(result.speed.find((row) => row.fast).count, 1);
});

test("ranks model summaries by total tokens including cache hits", () => {
  const result = buildModelBreakdowns([
    event(1, "cache-heavy", 100, 0, 10_000),
    event(2, "effective-heavy", 2_000, 0, 0),
  ]).coarse;
  assert.equal(result[0].name, "cache-heavy");
  assert.equal(result[0].total, 10_100);
  assert.equal(result[0].effective, 100);
});

test("uses hourly buckets for day and daily buckets for week/month", () => {
  const now = new Date(2026, 7, 24, 12, 30).getTime();
  const currentHour = new Date(2026, 7, 24, 12, 5).getTime();
  const events = [event(currentHour, "gpt-5.6-sol", 400, 100, 1000, 25)];
  const day = buildTrendSeries(events, "day", now);
  assert.equal(day.length, 24);
  assert.equal(day[12].effective, 500);
  assert.equal(day[12].total, 1500);
  assert.equal(day[12].costCents, 25);
  assert.equal(buildTrendSeries(events, "week", now).length, 7);
  assert.equal(buildTrendSeries(events, "month", now).length, 30);
});

test("splits trend buckets into Fast and non-Fast, folding unknown speed into non-Fast", () => {
  const now = new Date(2026, 7, 24, 12, 30).getTime();
  const hour = new Date(2026, 7, 24, 12, 5).getTime();
  const trend = buildTrendSeries([
    { timestamp: hour, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: true, equivalentCostCents: 4 },
    { timestamp: hour, input: 50, output: 10, cacheRead: 0, cacheWrite: 0, fast: true, fastKnown: true, equivalentCostCents: 8 },
    { timestamp: hour, input: 25, output: 5, cacheRead: 0, cacheWrite: 0, fast: false, fastKnown: false, equivalentCostCents: 1 },
  ], "day", now)[12];
  assert.equal(trend.input, 175);
  assert.equal(trend.speed.normal.input, 125);
  assert.equal(trend.speed.fast.input, 50);
  assert.equal(trend.speed.unknown, undefined);
  assert.equal(trend.speed.fast.equivalentCostCents, 8);
  assert.equal(trend.speed.normal.effective, 150);
});

test("keeps cache-read and cache-write tokens and costs separate in every aggregation", () => {
  const now = new Date(2026, 7, 24, 12, 30).getTime();
  const row = {
    timestamp: new Date(2026, 7, 24, 12, 5).getTime(),
    source: "codex",
    model: "gpt-5.6-sol",
    input: 100,
    cacheWrite: 300,
    cacheRead: 700,
    output: 50,
    inputCostCents: 1,
    cacheWriteCostCents: 3,
    cacheReadCostCents: 2,
    cacheCostCents: 5,
    outputCostCents: 4,
    equivalentCostCents: 10,
  };
  const trend = buildTrendSeries([row], "day", now)[12];
  assert.equal(trend.cacheWrite, 300);
  assert.equal(trend.cacheRead, 700);
  assert.equal(trend.cacheWriteCostCents, 3);
  assert.equal(trend.cacheReadCostCents, 2);
  const model = buildModelBreakdowns([row]).coarse[0];
  assert.equal(model.cacheWriteCostCents, 3);
  assert.equal(model.cacheReadCostCents, 2);
  const costs = costSummary([row]);
  assert.equal(costs.cacheWriteCostCents, 3);
  assert.equal(costs.cacheReadCostCents, 2);
});

test("splits quota consumption into standard, Fast, and unknown speed evidence", () => {
  const rows = [
    { ...event(1, "gpt-5.6-sol", 100), fast: false, fastKnown: true, quotaEquivalentCostCents: 2 },
    { ...event(2, "gpt-5.6-sol-fast", 100), fast: true, fastKnown: true, quotaEquivalentCostCents: 5 },
    { ...event(3, "legacy", 100), fast: false, fastKnown: false, quotaEquivalentCostCents: 1 },
  ];
  assert.deepEqual(speedUsageSummary(rows, { quota: true }), {
    normal: 2, fast: 5, unknown: 1, total: 8, basis: "equivalent-cost",
  });
});

test("uses one rolling range for all, Cursor, and Codex model totals", () => {
  const now = new Date(2026, 7, 25, 12, 0).getTime();
  const rows = [
    { ...event(now - 30 * 60_000, "cursor-model", 100, 20, 30), source: "cursor" },
    { ...event(now - 45 * 60_000, "codex-model", 200, 40, 60), source: "codex" },
    { ...event(now - 2 * 60 * 60_000, "old-model", 10_000), source: "cursor" },
  ];
  const usage = buildModelUsage(rows, "hour1", now);
  assert.equal(usage.sources.all.eventCount, 2);
  assert.equal(usage.sources.cursor.eventCount, 1);
  assert.equal(usage.sources.codex.eventCount, 1);
  const total = (source) => usage.sources[source].modelBreakdowns.coarse.reduce((sum, row) => sum + row.total, 0);
  assert.equal(total("all"), total("cursor") + total("codex"));
});

test("collapses cumulative Cursor snapshots to the most complete request state", () => {
  const base = {
    timestamp: "2026-08-25T00:00:00.000Z",
    model: "cursor-grok-4.6-high",
    conversationId: "conversation-1",
  };
  const partial = { ...base, tokenUsage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }, chargedCents: 2 };
  const final = { ...base, tokenUsage: { inputTokens: 180, outputTokens: 40, cacheReadTokens: 500 }, chargedCents: 8 };
  const result = collapseCursorSnapshots([final, partial]);
  assert.equal(result.length, 1);
  assert.equal(result[0].chargedCents, 8);
  assert.equal(result[0].tokenUsage.cacheReadTokens, 500);
});

test("expires stale Codex quota windows at the server reset time", () => {
  const active = currentCodexRateWindow({ usedPercent: 43, percentRemaining: 57, resetsAt: 2_000 }, 1_999);
  assert.equal(active.expired, false);
  assert.equal(active.usedPercent, 43);
  assert.equal(active.resetsAt, 2_000);

  const expired = currentCodexRateWindow({ usedPercent: 43, percentRemaining: 57, resetsAt: 2_000 }, 2_000);
  assert.equal(expired.expired, true);
  assert.equal(expired.sampledUsedPercent, 43);
  assert.equal(expired.usedPercent, 0);
  assert.equal(expired.percentRemaining, 100);
  assert.equal(expired.expiredAt, 2_000);
  assert.equal(expired.resetsAt, null);
});

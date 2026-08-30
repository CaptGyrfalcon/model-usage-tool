const test = require("node:test");
const assert = require("node:assert/strict");
const { alertLevel, buildQuotaInsights, forecastQuota } = require("../src/quota-insights.cjs");

test("predicts whether quota will run out before its reset", () => {
  const now = 10 * 60 * 60_000;
  assert.equal(forecastQuota({ usedPercent: 80, startAt: now - 4 * 60 * 60_000, resetsAt: now + 2 * 60 * 60_000 }, now).status, "exhaust");
  assert.equal(forecastQuota({ usedPercent: 20, startAt: now - 60 * 60_000, resetsAt: now + 4 * 60 * 60_000 }, now).status, "safe");
});

test("builds Cursor, Codex five-hour, and Codex weekly insights together", () => {
  const now = Date.UTC(2026, 7, 27, 8);
  const data = {
    billingCycleStart: now - 10 * 86_400_000,
    billingCycleEnd: now + 20 * 86_400_000,
    cursorModels: { percentUsed: 35, percentRemaining: 65 },
    otherModels: { percentUsed: 70, percentRemaining: 30 },
    codex: { quota: { windows: [
      { windowMinutes: 10_080, usedPercent: 40, percentRemaining: 60, resetsAt: now + 3 * 86_400_000 },
      { windowMinutes: 300, usedPercent: 55, percentRemaining: 45, resetsAt: now + 2 * 60 * 60_000 },
    ] } },
  };
  const insights = buildQuotaInsights(data, now);
  assert.deepEqual(insights.map((item) => item.label), ["Cursor 模型池", "Cursor API 池", "Codex 5 小时", "Codex 每周"]);
  assert.equal(insights[0].remainingPercent, 65);
  assert.equal(insights[1].remainingPercent, 30);
  assert.equal(insights[2].resetsAt, now + 2 * 60 * 60_000);
});

test("keeps Cursor model and API pool forecasts independent", () => {
  const now = Date.UTC(2026, 7, 29, 2);
  const data = {
    billingCycleStart: now - 10 * 86_400_000,
    billingCycleEnd: now + 20 * 86_400_000,
    cursorModels: { percentUsed: 25, percentRemaining: 75 },
    otherModels: { percentUsed: 100, percentRemaining: 0 },
  };
  const insights = buildQuotaInsights(data, now);
  assert.equal(insights[0].id, "cursor-models");
  assert.equal(insights[0].forecast.status, "safe");
  assert.equal(insights[1].id, "cursor-api");
  assert.equal(insights[1].forecast.status, "exhaust");
});

test("uses warning and critical alert levels", () => {
  assert.equal(alertLevel(21, 20), null);
  assert.equal(alertLevel(20, 20), "warning");
  assert.equal(alertLevel(10, 20), "critical");
});

test("keeps a pending weekly row when Codex temporarily omits that window", () => {
  const insights = buildQuotaInsights({
    codex: { quota: { windows: [{ windowMinutes: 300, usedPercent: 12, percentRemaining: 88, resetsAt: Date.now() + 60_000 }] } },
  });
  assert.deepEqual(insights.map((item) => item.id), ["codex-300", "codex-10080"]);
  assert.equal(insights[1].pending, true);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildQuotaTimeline, groupCycles, livePointsFromSnapshot, remainingOf } = require("../src/quota-timeline.cjs");

test("remaining percent is the water level", () => {
  assert.equal(remainingOf(61.37), 38.63);
  assert.equal(remainingOf(0), 100);
  assert.equal(remainingOf(null), null);
});

test("groups cursor samples into billing cycles by reset time", () => {
  const now = Date.UTC(2026, 7, 31, 5);
  const previousEnd = Date.UTC(2026, 7, 12);
  const currentEnd = Date.UTC(2026, 8, 11);
  const samples = [
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd - 10 * 86_400_000, usedPercent: 20, resetsAt: previousEnd },
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd - 86_400_000, usedPercent: 88, resetsAt: previousEnd },
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd + 86_400_000, usedPercent: 12, resetsAt: currentEnd },
    { source: "cursor", pool: "cursor-models", timestamp: now, usedPercent: 40, resetsAt: currentEnd },
  ];
  const cycles = groupCycles(samples, "cursor-models", now);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].current, true);
  assert.equal(cycles[0].endRemaining, 60);
  assert.equal(cycles[1].endRemaining, 12);
});

test("starts a new cycle when used percent drops and reset time is missing", () => {
  const now = 20 * 86_400_000;
  const samples = [
    { source: "cursor", pool: "other-models", timestamp: 1 * 86_400_000, usedPercent: 10 },
    { source: "cursor", pool: "other-models", timestamp: 10 * 86_400_000, usedPercent: 90 },
    { source: "cursor", pool: "other-models", timestamp: 11 * 86_400_000, usedPercent: 8 },
    { source: "cursor", pool: "other-models", timestamp: 15 * 86_400_000, usedPercent: 30 },
  ];
  const cycles = groupCycles(samples, "other-models", now);
  assert.equal(cycles.length, 2);
  assert.equal(cycles[0].points[0].usedPercent, 8);
});

test("lets the user inspect a past cycle series and overlays the live point", () => {
  const now = Date.UTC(2026, 7, 31, 8);
  const currentEnd = now + 10 * 86_400_000;
  const previousEnd = now - 20 * 86_400_000;
  const samples = [
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd - 5 * 86_400_000, usedPercent: 55, resetsAt: previousEnd },
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd - 86_400_000, usedPercent: 92, resetsAt: previousEnd },
    { source: "cursor", pool: "cursor-models", timestamp: now - 2 * 86_400_000, usedPercent: 18, resetsAt: currentEnd },
  ];
  const past = buildQuotaTimeline(samples, { pool: "cursor-models", cycleKey: `reset:${previousEnd}`, now });
  assert.equal(past.cycle.key, `reset:${previousEnd}`);
  assert.equal(past.series.at(-1).remainingPercent, 8);
  assert.equal(past.cycle.current, false);

  const live = buildQuotaTimeline(samples, {
    pool: "cursor-models",
    now,
    live: [{ source: "cursor", pool: "cursor-models", timestamp: now, usedPercent: 27, resetsAt: currentEnd }],
  });
  assert.equal(live.cycle.current, true);
  assert.equal(live.series.at(-1).remainingPercent, 73);
});

test("reads live Codex windows from the current snapshot", () => {
  const now = Date.now();
  const points = livePointsFromSnapshot({
    fetchedAt: now,
    billingCycleEnd: now + 86_400_000,
    cursorModels: { percentUsed: 40 },
    otherModels: { percentUsed: 80 },
    codex: { quota: { windows: [{ slot: "primary", windowMinutes: 300, usedPercent: 64, resetsAt: now + 3_600_000 }] } },
  }, now);
  assert.equal(points.length, 3);
  assert.equal(points[2].windowMinutes, 300);
});

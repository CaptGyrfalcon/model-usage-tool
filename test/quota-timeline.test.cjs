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

test("keeps live points in the current cycle and extends a past cycle to its end", () => {
  const now = Date.UTC(2026, 7, 31, 8);
  const currentEnd = now + 10 * 86_400_000;
  const previousEnd = now - 20 * 86_400_000;
  const samples = [
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd - 5 * 86_400_000, usedPercent: 55, resetsAt: previousEnd },
    { source: "cursor", pool: "cursor-models", timestamp: previousEnd - 86_400_000, usedPercent: 92, resetsAt: previousEnd },
    { source: "cursor", pool: "cursor-models", timestamp: now - 2 * 86_400_000, usedPercent: 18, resetsAt: currentEnd },
  ];
  const livePoint = { source: "cursor", pool: "cursor-models", timestamp: now, usedPercent: 27, resetsAt: currentEnd };
  const past = buildQuotaTimeline(samples, {
    pool: "cursor-models",
    cycleKey: `reset:${previousEnd}`,
    now,
    live: [livePoint],
  });
  assert.equal(past.cycle.key, `reset:${previousEnd}`);
  assert.equal(past.series.at(-1).remainingPercent, 8);
  assert.equal(past.series.at(-1).at, previousEnd);
  assert.equal(past.series.at(-1).projected, true);
  assert.equal(past.series.some((point) => point.at === now), false);
  assert.equal(past.cycle.current, false);

  const live = buildQuotaTimeline(samples, {
    pool: "cursor-models",
    now,
    live: [livePoint],
  });
  assert.equal(live.cycle.current, true);
  assert.equal(live.series.at(-1).remainingPercent, 73);
  assert.equal(live.series.at(-1).at, now);
  assert.equal(live.series.at(-1).projected, undefined);
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

const DAY_MS = 86_400_000;
const weeklySample = (timestamp, resetsAt, usedPercent = 10) => ({
  source: "codex", pool: "secondary-10080", windowMinutes: 10080,
  timestamp, resetsAt, usedPercent,
});

test("Codex reset jitter merges across minute boundaries without losing observations", () => {
  const reset = Date.UTC(2026, 8, 15, 15, 15, 55);
  const now = reset - DAY_MS;
  const samples = [
    weeklySample(now - 3000, reset, 0),
    weeklySample(now - 2000, reset + 8000, 35),
    weeklySample(now - 1000, reset + 15000, 40),
  ];
  const before = JSON.stringify(samples);
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now,
    cycleKey: `reset:${reset + 8000}`,
    live: [weeklySample(now, reset + 9000, 45)] });
  assert.equal(timeline.cycles.length, 1);
  assert.equal(timeline.cycles[0].sampleCount, 4);
  assert.deepEqual(timeline.series.map((p) => p.usedPercent), [0, 35, 40, 45]);
  assert.equal(timeline.cycle.key, `reset:${reset}`);
  assert.equal(timeline.cycle.endAt, reset + 9000);
  assert.equal(timeline.cycle.reference.startAt, reset + 9000 - 7 * DAY_MS);
  assert.equal(JSON.stringify(samples), before);
});

test("only the latest observed cycle is current after early resets", () => {
  const now = Date.UTC(2026, 8, 12, 12);
  const resets = [Date.UTC(2026, 8, 14), Date.UTC(2026, 8, 15), Date.UTC(2026, 8, 19)];
  const samples = resets.map((reset) => weeklySample(reset - 7 * DAY_MS + 1000, reset));
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now });
  assert.equal(timeline.cycles.length, 3);
  assert.equal(timeline.cycles.filter((cycle) => cycle.current).length, 1);
  assert.equal(timeline.cycle.endAt, resets[2]);
  assert.equal(timeline.cycles.filter((cycle) => cycle.label.startsWith("当前")).length, 1);
});

test("a live early reset creates a cycle even while the old deadline is still in the future", () => {
  const now = Date.UTC(2026, 8, 12, 12);
  const oldReset = now + DAY_MS;
  const newReset = now + 7 * DAY_MS;
  const samples = [weeklySample(now - DAY_MS, oldReset, 83)];
  const live = [weeklySample(now, newReset, 0)];
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now, live });
  assert.equal(timeline.cycles.length, 2);
  assert.equal(timeline.cycle.endAt, newReset);
  assert.equal(timeline.cycle.endRemaining, 100);
  assert.equal(timeline.cycles.filter((cycle) => cycle.current).length, 1);
  const past = buildQuotaTimeline(samples, { pool: "codex-10080", now, live, cycleKey: `reset:${oldReset}` });
  assert.equal(past.cycle.current, false);
  assert.equal(past.cycle.endRemaining, 17);
  assert.equal(past.series.some((point) => point.at === now && !point.projected), false);
  assert.equal(past.series.some((point) => point.at > now), false);
});

test("current follows observation order even if the new deadline is earlier", () => {
  const now = Date.UTC(2026, 8, 12, 12);
  const samples = [weeklySample(now - 1000, now + 7 * DAY_MS), weeklySample(now, now + DAY_MS)];
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now });
  assert.equal(timeline.cycle.endAt, now + DAY_MS);
  assert.equal(timeline.cycles.filter((cycle) => cycle.current).length, 1);
});

test("same-day early resets show times and selecting a cycle preserves the labels", () => {
  const first = Date.UTC(2026, 8, 15, 4);
  const second = first + 3_600_000;
  const now = second - DAY_MS;
  const samples = [weeklySample(first - 7 * DAY_MS + 1000, first), weeklySample(second - 7 * DAY_MS + 1000, second)];
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now });
  assert.equal(timeline.cycles.length, 2);
  assert.ok(/\d{2}:\d{2}/.test(timeline.cycles[1].label));
  assert.equal(timeline.cycles[1].endAt, second - 7 * DAY_MS);
  assert.equal(timeline.cycles[1].interrupted, true);
  const selected = buildQuotaTimeline(samples, { pool: "codex-10080", now, cycleKey: `reset:${first}` });
  assert.deepEqual(selected.cycles, timeline.cycles);
});

test("reset tolerance does not chain indefinitely or apply to Cursor billing dates", () => {
  const now = Date.UTC(2026, 8, 12, 12);
  const reset = now + DAY_MS;
  const samples = [0, 40_000, 80_000].map((offset, index) => weeklySample(now - 2000 + index, reset + offset));
  assert.equal(groupCycles(samples, "codex-10080", now).length, 2);
  const cursor = samples.map((sample) => ({ ...sample, source: "cursor", pool: "cursor-models" }));
  assert.equal(groupCycles(cursor, "cursor-models", now).length, 3);
});

test("expired live data is not marked current, and stale live data cannot overwrite newer history", () => {
  const now = Date.UTC(2026, 8, 12, 12);
  const reset = now + DAY_MS;
  const timeline = buildQuotaTimeline([weeklySample(now, reset, 40)], { pool: "codex-10080", now,
    live: [weeklySample(now - 1000, reset, 20)] });
  assert.equal(timeline.cycle.endRemaining, 60);
  assert.deepEqual(timeline.series.map((point) => point.usedPercent), [20, 40]);
  const expired = buildQuotaTimeline([], { pool: "codex-10080", now,
    live: [weeklySample(now - 2000, now - 1000)] });
  assert.equal(expired.cycle.current, false);
});

test("early grants shorten old cycles, their curves and references without shifting their starts", () => {
  const starts = [Date.UTC(2026, 8, 7, 2), Date.UTC(2026, 8, 8, 23), Date.UTC(2026, 8, 12, 16)];
  const resets = starts.map((start) => start + 7 * DAY_MS);
  const now = starts[2] + 3_600_000;
  const samples = starts.flatMap((start, index) => [
    weeklySample(start + 1000, resets[index], 0),
    weeklySample(start + 60_000, resets[index], 20 + index * 10),
  ]);
  // Old windows can still be reported after a grant, even after the latest
  // observation of the replacement window. They must not reopen the old one.
  samples.push(weeklySample(now, resets[0], 90));
  const before = JSON.stringify(samples);
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now });
  assert.equal(timeline.cycles.length, 3);
  assert.equal(timeline.cycles.filter((cycle) => cycle.current).length, 1);
  assert.equal(timeline.cycle.key, `reset:${resets[2]}`);
  for (let index = 0; index < 2; index += 1) {
    const past = buildQuotaTimeline(samples, { pool: "codex-10080", now, cycleKey: `reset:${resets[index]}` });
    assert.equal(past.cycle.startAt, starts[index]);
    assert.equal(past.cycle.endAt, starts[index + 1]);
    assert.equal(past.cycle.scheduledEndAt, resets[index]);
    assert.equal(past.cycle.interrupted, true);
    assert.match(past.cycle.label, /提前重置/);
    assert.deepEqual(past.cycle.reference, { startAt: starts[index], endAt: starts[index + 1], estimated: false });
    assert.equal(past.cycle.endRemaining, 80 - index * 10);
    assert.equal(past.series.at(-1).at, starts[index + 1]);
    assert.equal(past.series.at(-1).projected, true);
    assert.ok(past.series.every((point) => point.at >= starts[index] && point.at <= starts[index + 1]));
  }
  assert.equal(JSON.stringify(samples), before);
});

test("the next deadline identifies an early reset even if its first sample arrives late", () => {
  const start = Date.UTC(2026, 8, 7);
  const grant = start + 2 * DAY_MS;
  const now = grant + DAY_MS;
  const samples = [weeklySample(start + 1000, start + 7 * DAY_MS, 20),
    weeklySample(now, grant + 7 * DAY_MS, 10)];
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now });
  assert.equal(timeline.cycles[1].endAt, grant);
  assert.equal(timeline.cycles[0].startAt, grant);
  assert.notEqual(timeline.cycles[1].endAt, now);
});

test("natural resets and inactive gaps retain their original ends", () => {
  const start = Date.UTC(2026, 8, 1);
  const second = start + 7 * DAY_MS;
  const third = second + 10 * DAY_MS;
  const now = third + DAY_MS;
  const samples = [start, second, third].map((at) => weeklySample(at + 1000, at + 7 * DAY_MS));
  const timeline = buildQuotaTimeline(samples, { pool: "codex-10080", now });
  assert.ok(timeline.cycles.every((cycle) => !cycle.interrupted));
  assert.equal(timeline.cycles[2].endAt, second);
  assert.equal(timeline.cycles[1].endAt, second + 7 * DAY_MS);
  assert.equal(timeline.cycles[0].startAt, third);
});

test("5-hour allowances also close at early reset boundaries", () => {
  const start = Date.UTC(2026, 8, 12);
  const grant = start + 2 * 3_600_000;
  const now = grant + 60_000;
  const samples = [start, grant].map((at) => ({ source: "codex", pool: "primary-300",
    windowMinutes: 300, timestamp: at + 1000, resetsAt: at + 5 * 3_600_000, usedPercent: 10 }));
  const timeline = buildQuotaTimeline(samples, { pool: "codex-300", now });
  assert.equal(timeline.cycles[1].endAt, grant);
  assert.equal(timeline.cycles[1].interrupted, true);
  assert.equal(timeline.cycles[0].startAt, grant);
});

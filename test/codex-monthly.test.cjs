const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCodexMonthly, monthBounds, WEEK_MS } = require("../src/renderer/codex-monthly.js");
const { codexPool, combinedTank, refreshSpend } = require("../src/renderer/liquid-pool.js");
const at = (day) => new Date(2026, 8, day, 12).getTime();
const now = at(16);
const windows = [
  { windowMinutes: 300, usedPercent: 50, quotaEstimate: { inferredTotalCents: 2000 } },
  { windowMinutes: 10080, resetsAt: at(20), usedPercent: 40, quotaEstimate: { inferredTotalCents: 10000 } },
];
const sample = (end, used, timestamp = end - 60_000) => ({ source: "codex", windowMinutes: 10080, resetsAt: end, timestamp, usedPercent: used });
const event = (timestamp, cents) => ({ source: "codex", timestamp, quotaEquivalentCostCents: cents });
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} ≈ ${b}`);
const priorAt = new Date(2026, 7, 31, 20).getTime();
const monthStart = new Date(2026, 8, 1).getTime();
const conserved = (month) => close(month.usedCents + month.remainingCents + month.expiredUnusedCents + month.unknownCents, month.capacityCents);

test("plan changes close the actual old cycle and retain its own capacity and cumulative usage", () => {
  const oldStart = monthStart - 30 * 60_000;
  const oldReset = oldStart + WEEK_MS;
  const changedAt = at(7) - 9 * 3600_000;
  const oldSampleAt = changedAt - 3600_000;
  const live = { ...windows[1], planType: "prolite", resetsAt: changedAt + WEEK_MS,
    usedPercent: 20, quotaEstimate: { inferredTotalCents: 50000 } };
  const month = buildCodexMonthly({ windows: [live], now: changedAt + 3600_000, shortLimit: "absent",
    samples: [sample(oldReset, 10, monthStart - 1), sample(oldReset, 88, oldSampleAt)]
      .map((s) => ({ ...s, planType: "plus" })),
    events: [event(oldStart + 1, 1000), event(monthStart, 7800), event(monthStart + 1, null)] });
  const old = month.cycles[0];
  assert.equal(old.startAt, oldStart);
  assert.equal(old.endAt, changedAt);
  assert.equal(old.resetAt, oldReset);
  assert.equal(old.interrupted, true);
  assert.equal(old.grossCapacityCents, 10000);
  assert.equal(old.previousMonthUsedCents, 1000);
  assert.equal(old.usedCents, 7800);
  assert.equal(old.unusedCents, 1200);
  assert.equal(old.unknownCents, 0); // the cumulative snapshot covers unpriced events
  assert.equal(month.weeklyRemainingCents, 40000);
  conserved(month);
});

test("same-plan early resets remain separate and reuse that plan's estimate at zero percent", () => {
  const oldStart = monthStart;
  const change = monthStart + 2 * 86400_000;
  const live = { ...windows[1], planType: "prolite", resetsAt: change + WEEK_MS,
    usedPercent: 0, quotaEstimate: { inferredTotalCents: null } };
  const month = buildCodexMonthly({ windows: [live], shortLimit: "absent", now: change + 1000,
    samples: [{ ...sample(oldStart + WEEK_MS, 50, change - 1000), planType: "prolite" }],
    events: [event(oldStart + 1000, 5000)] });
  assert.equal(month.cycles[0].endAt, change);
  assert.equal(month.cycles[0].unusedCents, 5000);
  assert.equal(month.weeklyRemainingCents, 10000);
  assert.equal(month.currentStart, change);
  conserved(month);
});

test("small reset timestamp jitter does not create extra cycles or lose the final snapshot", () => {
  const month = buildCodexMonthly({ windows, now,
    samples: [sample(at(13) - 1000, 60, at(12)), sample(at(13), 70, at(12) + 1000)] });
  assert.equal(month.cycleCount, 5);
  const old = month.cycles.find((c) => c.endAt === at(13));
  assert.equal(old.usedCents, 7000);
  conserved(month);
});

test("subtracts pre-month consumption from both the first week's capacity and used amount", () => {
  const month = buildCodexMonthly({ windows, now, samples: [sample(at(6), 70), sample(at(13), 80)],
    events: [event(priorAt, 2000), event(monthStart, 500)] });
  assert.equal(month.previousMonthUsedCents, 2000);
  assert.equal(month.capacityCents, 48000);
  assert.equal(month.grossCapacityCents, 50000);
  assert.equal(month.cycles[0].capacityCents, 8000);
  assert.equal(month.cycles[0].usedCents, 5000);
  assert.equal(month.usedCents, 17000);
  assert.equal(month.expiredUnusedCents, 5000);
  assert.equal(month.remainingCents, 26000);
  conserved(month);
  const pool = codexPool(windows, null, month);
  assert.equal(pool.capacityCents, 48000);
  close(pool.monthlyRemaining, 26000 / 48000 * 100);
  const combined = combinedTank([pool]);
  assert.equal(combined.capacityCents, 48000);
  close(combined.remainingCents, 26000);
});

test("pre-month snapshot covers earlier costs without using a post-month snapshot", () => {
  const month = buildCodexMonthly({ windows, now,
    samples: [sample(at(6), 30, priorAt), sample(at(6), 70)],
    events: [event(priorAt - 1, 2000), event(priorAt, 1000), event(priorAt + 1, 500), event(monthStart, 1500)] });
  assert.equal(month.previousMonthUsedCents, 3500);
  assert.equal(month.previousMonthUsageKnown, true);
  assert.equal(month.capacityCents, 46500);
  assert.equal(month.cycles[0].usedCents, 3500);
  conserved(month);
});

test("an active month-crossing week keeps actual weekly and 5h availability unchanged", () => {
  const activeWindows = [windows[0], { ...windows[1], resetsAt: at(6) }];
  const month = buildCodexMonthly({ windows: activeWindows, now: at(2), events: [event(priorAt, 1000)] });
  assert.equal(month.completedCount, 0);
  assert.equal(month.previousMonthUsedCents, 1000);
  assert.equal(month.capacityCents, month.grossCapacityCents - 1000);
  assert.equal(month.usedCents, 3000);
  assert.equal(month.weeklyCapacityCents, 10000);
  assert.equal(month.weeklyRemainingCents, 6000);
  assert.equal(month.immediateCents, 1000);
  conserved(month);
});

test("incomplete pre-month prices deduct only known consumption and preserve unknown balances", () => {
  const month = buildCodexMonthly({ windows, now,
    events: [event(priorAt, 500), event(priorAt + 1, null), event(monthStart, 1000)] });
  assert.equal(month.previousMonthUsedCents, 500);
  assert.equal(month.previousMonthUsageKnown, false);
  assert.equal(month.cycles[0].knownUsedCents, 1000);
  assert.equal(month.cycles[0].unknownCents, 8500);
  assert.equal(month.cycles[0].unusedCents, null);
  conserved(month);
});

test("exhausted carry-in week contributes zero, and weeks starting at month start deduct nothing", () => {
  const exhausted = buildCodexMonthly({ windows, now, events: [event(priorAt, 10000)] });
  assert.equal(exhausted.cycles[0].capacityCents, 0);
  assert.equal(exhausted.cycles[0].usedCents, 0);
  assert.equal(exhausted.capacityCents, 40000);
  conserved(exhausted);
  const aligned = buildCodexMonthly({ windows: [{ ...windows[1], resetsAt: monthStart + WEEK_MS }], now: monthStart,
    events: [event(priorAt, 10000)] });
  assert.equal(aligned.previousMonthUsedCents, 0);
  assert.equal(aligned.previousMonthUsageKnown, true);
  assert.equal(aligned.capacityCents, aligned.grossCapacityCents);
  conserved(aligned);
});

test("month includes the complete weeks crossing both calendar boundaries", () => {
  const month = buildCodexMonthly({ windows, now, samples: [sample(at(6), 70), sample(at(13), 80)] });
  assert.equal(month.cycleCount, 5);
  assert.equal(month.futureResetCount, 2);
  assert.equal(month.completedCount, 2);
  assert.equal(month.cycles[0].startAt, at(6) - WEEK_MS);
  assert.equal(month.cycles.at(-1).endAt, at(34));
  assert.equal(month.capacityCents, 50000);
  assert.equal(month.immediateCents, 1000);
  assert.equal(month.weeklyRemainingCents, 6000);
  assert.equal(month.futureCents, 20000);
  assert.equal(month.lockedCents, 25000);
  assert.equal(month.expiredUnusedCents, 5000);
  assert.equal(month.usedCents, 19000);
  assert.equal(month.unknownCents, 0);
  close(month.usedCents + month.expiredUnusedCents + month.unknownCents + month.remainingCents, month.capacityCents);
});

test("uses the server's cumulative use and only adds events after the sample", () => {
  const cutoff = at(12);
  const month = buildCodexMonthly({ windows, now, samples: [sample(at(13), 60, cutoff)], events: [
    event(cutoff - 1, 6000), event(cutoff, 6000), event(cutoff + 1, 500),
    event(at(13), 1000), // belongs to the current week, never the completed week
  ] });
  const cycle = month.cycles.find((cycle) => cycle.endAt === at(13));
  assert.equal(cycle.usedCents, 6500);
  assert.equal(cycle.unusedCents, 3500);
  assert.equal(month.unknownCents, 10000);
});

test("uses recorded past consumption and never treats absent history as unused quota", () => {
  const month = buildCodexMonthly({ windows, now, events: [event(at(2), 2400), event(at(3), 800)] });
  assert.equal(month.expiredUnusedCents, 6800);
  assert.equal(month.unknownCents, 10000);
  assert.equal(month.cycles[0].evidence, "records");
  const missing = buildCodexMonthly({ windows, now });
  assert.equal(missing.expiredUnusedCents, 0);
  assert.equal(missing.unknownCents, 20000);
  const unpriced = buildCodexMonthly({ windows, now, events: [event(at(2), 2400), event(at(3), null)] });
  assert.equal(unpriced.unknownCents, 17600);
  assert.equal(unpriced.cycles[0].knownUsedCents, 2400);
  assert.equal(unpriced.cycles[0].unpricedCount, 1);
  assert.equal(unpriced.cycles[0].unknownReason, "unpriced-events");
  close(unpriced.usedCents + unpriced.unknownCents + unpriced.expiredUnusedCents + unpriced.remainingCents, unpriced.capacityCents);
});

test("monthly blue and cyan honor weekly exhaustion and missing short-window estimates", () => {
  const exhausted = buildCodexMonthly({ windows: [windows[0], { ...windows[1], usedPercent: 100 }], now });
  assert.equal(exhausted.immediateCents, 0);
  assert.equal(exhausted.lockedCents, exhausted.futureCents);
  const missing = buildCodexMonthly({ windows: [{ windowMinutes: 300, usedPercent: 0 }, windows[1]], now });
  assert.equal(missing.immediateCents, 0);
  assert.equal(missing.immediateKnown, false);
  assert.equal(missing.lockedCents, missing.remainingCents);
});

test("unsupported, expired and unknown weekly quotas do not invent monthly capacities", () => {
  assert.equal(buildCodexMonthly({ now }), null);
  assert.equal(buildCodexMonthly({ windows: [windows[0]], now }), null);
  assert.equal(buildCodexMonthly({ windows: [{ ...windows[1], resetsAt: now }], now }), null);
  assert.equal(buildCodexMonthly({ windows: [{ ...windows[1], quotaEstimate: {} }], now }), null);
  assert.equal(buildCodexMonthly({ windows: [{ ...windows[1], usedPercent: null }], now }), null);
});

test("a confirmed absent 5h limit makes the whole weekly remainder immediately available", () => {
  const month = buildCodexMonthly({ windows: [windows[1]], shortLimit: "absent", now });
  assert.equal(month.immediateCents, 6000);
  assert.equal(month.immediateKnown, true);
  assert.equal(month.lockedCents, month.futureCents);
  const unknown = buildCodexMonthly({ windows: [windows[1]], now });
  assert.equal(unknown.shortLimit, "unknown");
  assert.equal(unknown.immediateKnown, false);
  const exhausted = buildCodexMonthly({ windows: [{ ...windows[1], usedPercent: 100 }], shortLimit: "absent", now });
  assert.equal(exhausted.immediateCents, 0);
  const pool = codexPool([windows[1]], null, month, "absent");
  assert.equal(pool.layers.find((layer) => layer.tone === "codex-immediate").name, "本周当前可用");
  assert.ok(!pool.layers.some((layer) => layer.tone === "codex-weekly"));
});

test("calendar boundaries are half open, including February and year transitions", () => {
  for (const date of [new Date(2027, 1, 15), new Date(2028, 1, 15), new Date(2026, 11, 31)]) {
    const stamp = date.getTime();
    const bounds = monthBounds(stamp);
    const month = buildCodexMonthly({ windows: [{ ...windows[1], resetsAt: bounds.endAt }], now: bounds.endAt - 1 });
    assert.ok(month.cycles.every((cycle) => cycle.startAt < bounds.endAt && cycle.endAt > bounds.startAt));
    assert.equal(month.futureResetCount, 0);
    assert.equal(month.cycles.at(-1).endAt, bounds.endAt);
    const next = buildCodexMonthly({ windows: [{ ...windows[1], resetsAt: bounds.endAt + WEEK_MS }], now: bounds.endAt });
    assert.equal(next.cycles[0].startAt, bounds.endAt);
    assert.equal(next.completedCount, 0);
  }
  const feb = monthBounds(new Date(2027, 1, 15).getTime());
  const month = buildCodexMonthly({ windows: [{ ...windows[1], resetsAt: feb.startAt + 3 * WEEK_MS }], now: feb.startAt + 2 * WEEK_MS });
  assert.equal(month.cycleCount, 4);
});

test("Codex monthly liquid preserves all portions and excludes expired/unknown from availability", () => {
  const monthly = buildCodexMonthly({ windows, now, samples: [sample(at(6), 70)] });
  const pool = codexPool(windows, null, monthly);
  assert.equal(pool.capacityCents, monthly.capacityCents);
  assert.equal(pool.layers.length, 5);
  assert.equal(pool.layers[0].tone, "codex-immediate");
  assert.equal(pool.layers.at(-2).tone, "codex-expired");
  assert.equal(pool.layers.at(-1).tone, "codex-unknown");
  close(pool.layers.reduce((sum, layer) => sum + layer.remainingCents, 0) + monthly.usedCents, monthly.capacityCents);
  const combined = combinedTank([{ id: "cursor-models", remaining: 50, capacityCents: 10000 }, pool]);
  assert.equal(combined.layers[0].tone, "codex-immediate");
  close(combined.remainingCents, 5000 + monthly.remainingCents);
  assert.ok(combined.layers.at(-1).level > combined.remaining);
  assert.ok(combined.layers.at(-1).level <= 100);
  assert.equal(refreshSpend({ ...pool, monthly: { ...monthly, currentEnd: now - 1 } }, pool), null);
  const delta = refreshSpend({ ...pool, usedCents: null, weeklyRemaining: 80 }, { ...pool, usedCents: null, weeklyRemaining: 70 });
  close(delta.amountCents, 1000); // ten percent of one week, never ten percent of the whole month
});

test("unpriced events after a matching server sample retain all confirmed consumption", () => {
  const cutoff = at(12);
  const monthly = buildCodexMonthly({ windows, now, samples: [sample(at(13), 60, cutoff)],
    events: [event(cutoff - 1, 3000), event(cutoff + 1, 500), event(cutoff + 2, null)] });
  const cycle = monthly.cycles.find((cycle) => cycle.endAt === at(13));
  assert.equal(cycle.usedCents, null);
  assert.equal(cycle.knownUsedCents, 6500);
  assert.equal(cycle.unknownCents, 3500);
  assert.equal(cycle.unusedCents, null);
  close(monthly.usedCents + monthly.unknownCents + monthly.expiredUnusedCents + monthly.remainingCents, monthly.capacityCents);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { codexPool, damageParts, refreshEffectDuration, refreshSpend, sizeScales } = require("../src/renderer/liquid-pool.js");

test("combines Codex rolling windows into immediately usable and weekly-only water", () => {
  const pool = codexPool([
    { windowMinutes: 300, percentRemaining: 36, quotaEstimate: { inferredTotalCents: 5_000 } },
    { windowMinutes: 10_080, percentRemaining: 73, quotaEstimate: { inferredTotalCents: 12_000, usedCents: 3_240 } },
  ]);
  assert.equal(pool.remaining, 15);
  assert.equal(pool.shortRemaining, 36);
  assert.equal(pool.weeklyRemaining, 73);
  assert.equal(pool.weeklyOnlyRemaining, 58);
  assert.equal(pool.capacityCents, 12_000);
  assert.equal(pool.shortCapacityCents, 5_000);
  assert.equal(pool.usedCents, 3_240);
});

test("weekly exhaustion caps the five-hour layer by its actual capacity share", () => {
  const pool = codexPool([
    { windowMinutes: 300, percentRemaining: 80, quotaEstimate: { inferredTotalCents: 4_000 } },
    { windowMinutes: 10_080, percentRemaining: 10, quotaEstimate: { inferredTotalCents: 12_000 } },
  ]);
  assert.equal(pool.remaining, 10);
  assert.equal(pool.weeklyOnlyRemaining, 0);
});

test("does not invent a quarter-week five-hour tank when the short window has no estimate", () => {
  const pool = codexPool([
    { windowMinutes: 300, percentRemaining: 36 },
    { windowMinutes: 10_080, percentRemaining: 73, quotaEstimate: { inferredTotalCents: 12_000 } },
  ]);
  assert.equal(pool.shortCapacityCents, null);
  assert.equal(pool.remaining, 0);
  assert.equal(pool.weeklyOnlyRemaining, 73);
});

test("tank volume is proportional to comparable quota capacity", () => {
  const scales = sizeScales([{ capacityCents: 10_000 }, { capacityCents: 2_500 }]);
  assert.equal(scales[0], 1);
  assert.ok(Math.abs(scales[1] ** 3 - 0.25) < 1e-12);
  assert.deepEqual(sizeScales([{ capacityCents: null }, { capacityCents: null }]), [1, 1]);
});

test("preview-like pools keep three distinct cube-root diameters", () => {
  const scales = sizeScales([
    { capacityCents: 12_459 },
    { capacityCents: 5_692 },
    { capacityCents: 4_648 },
  ]);
  assert.equal(scales[0], 1);
  assert.ok(scales[1] < 0.8 && scales[1] > 0.7);
  assert.ok(scales[2] < scales[1]);
  assert.ok(Math.abs(scales[1] ** 3 - 5_692 / 12_459) < 1e-12);
  assert.ok(Math.abs(scales[2] ** 3 - 4_648 / 12_459) < 1e-12);
});

test("formats refresh damage with a large hundredth and small trailing decimals", () => {
  assert.deepEqual(damageParts(1234.56), { major: "-$12.34", minor: "56" });
  assert.deepEqual(damageParts(0.1), { major: "-$0.00", minor: "10" });
});

test("drain duration scales between the current floor and the refresh interval", () => {
  assert.equal(refreshEffectDuration(1, 30_000), 900);
  assert.equal(refreshEffectDuration(5, 15_000), 900);
  assert.equal(refreshEffectDuration(200, 30_000), 30_000);
  assert.equal(refreshEffectDuration(400, 15_000), 15_000);
  assert.equal(refreshEffectDuration(102.5, 30_000), Math.round(900 + 0.5 * (30_000 - 900)));
});

test("refresh effects only fire when a pool actually spent", () => {
  const idle = { remaining: 40, weeklyRemaining: 70, usedCents: 1_200, capacityCents: 10_000 };
  assert.equal(refreshSpend(idle, { ...idle }), null);
  assert.equal(refreshSpend(idle, { ...idle, remaining: 38 }), null);
  assert.deepEqual(
    refreshSpend(idle, { ...idle, remaining: 38, usedCents: 1_400 }),
    { amountCents: 200, levelDelta: 2 }
  );
  assert.deepEqual(
    refreshSpend({ remaining: 40, capacityCents: 10_000 }, { remaining: 38, capacityCents: 10_000 }),
    { amountCents: 200, levelDelta: 2 }
  );
});

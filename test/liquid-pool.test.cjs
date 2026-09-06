const test = require("node:test");
const assert = require("node:assert/strict");
const { codexPool, combinedTank, damageParts, refreshEffectDuration, refreshSpend, sizeScales } = require("../src/renderer/liquid-pool.js");

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

test("normalizes tank shapes and clips a closed path for each vessel", () => {
  const { TANK_SHAPES, clipTankShape, normalizeTankShape } = require("../src/renderer/liquid-pool.js");
  assert.equal(normalizeTankShape("sphere"), "sphere");
  assert.equal(normalizeTankShape("flask"), "flask");
  assert.equal(normalizeTankShape("unknown"), "sphere");
  assert.deepEqual(TANK_SHAPES.map((shape) => shape.id), ["sphere", "flask", "cube", "cylinder", "beaker", "bowl"]);
  const calls = [];
  const ctx = {
    beginPath() { calls.push("beginPath"); },
    moveTo() { calls.push("moveTo"); },
    lineTo() { calls.push("lineTo"); },
    quadraticCurveTo() { calls.push("quad"); },
    bezierCurveTo() { calls.push("bezier"); },
    ellipse() { calls.push("ellipse"); },
    arcTo() { calls.push("arcTo"); },
    closePath() { calls.push("close"); },
    clip() { calls.push("clip"); },
  };
  for (const { id } of TANK_SHAPES) {
    calls.length = 0;
    clipTankShape(ctx, 120, 120, id, 5);
    assert.ok(calls.includes("beginPath"), `${id} starts a path`);
    assert.ok(calls.includes("clip"), `${id} clips the path`);
  }
});

test("stacks remaining quota from every pool into one shared tank", () => {
  const tank = combinedTank([
    { id: "cursor-models", name: "Cursor 模型池", remaining: 50, capacityCents: 10_000 },
    { id: "cursor-api", name: "Cursor 三方模型池", remaining: 25, capacityCents: 4_000 },
    { id: "codex-combined", source: "codex", remaining: 10, weeklyOnlyRemaining: 40, capacityCents: 20_000 },
  ]);
  assert.equal(tank.id, "usage-combined");
  assert.equal(tank.capacityCents, 34_000);
  assert.equal(tank.layers.length, 4);
  assert.equal(tank.layers[0].tone, "codex-immediate");
  assert.equal(tank.layers[0].remainingCents, 2_000);
  assert.equal(tank.layers[1].tone, "cursor-models");
  assert.equal(tank.layers[1].remainingCents, 5_000);
  assert.equal(tank.layers[2].tone, "cursor-api");
  assert.equal(tank.layers[2].remainingCents, 1_000);
  assert.equal(tank.layers[3].tone, "codex-weekly");
  assert.equal(tank.layers[3].remainingCents, 8_000);
  assert.equal(tank.remainingCents, 16_000);
  assert.ok(Math.abs(tank.remaining - 16_000 / 34_000 * 100) < 1e-10);
  assert.ok(tank.layers[3].level > tank.layers[2].level);
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

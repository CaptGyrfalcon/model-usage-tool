const test = require("node:test");
const assert = require("node:assert/strict");
const motion = require("../src/renderer/motion.js");

test("liquid reaches the same level at 30, 60, 144 and 240 Hz", () => {
  const results = [30, 60, 144, 240].map((hz) => {
    let level = 100;
    for (let frame = 0; frame < hz; frame++) level = motion.approach(level, 20, 1 / hz);
    return level;
  });
  for (const value of results) assert.ok(Math.abs(value - results[0]) < 1e-10);
  assert.ok(results[0] >= 20 && results[0] < 21);
  assert.equal(motion.approach(10, 90, 0), 10);
});
test("an exhausted weekly pool stays zero rather than using the short pool level", () => {
  assert.equal(motion.weeklyLevel({ weeklyRemaining: 0, remaining: 60 }), 0);
  assert.equal(motion.weeklyLevel({ remaining: 60 }), 60);
});
test("hidden, inactive and reduced-motion views never run the liquid loop", () => {
  const active = { visible: true, orb: true, mode: "pool", reduced: false };
  assert.equal(motion.canAnimate(active), true);
  for (const change of [{ visible: false }, { orb: false }, { mode: "quota" }, { reduced: true }]) {
    assert.equal(motion.canAnimate({ ...active, ...change }), false);
  }
  assert.equal(motion.reduced("system", true), true);
  assert.equal(motion.reduced("reduce", false), true);
  assert.equal(motion.reduced("system", false), false);
});

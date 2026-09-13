const test = require("node:test");
const assert = require("node:assert/strict");
const { stageGeometry, clipGeometry, create } = require("../src/renderer/fullscreen-morph.js");

const plan = { fullscreen: true, stage: { x: -2560, y: -200, width: 2560, height: 1440 },
  widget: { x: -1900, y: 160, width: 548, height: 840 }, zoom: 1.2 };

test("morph preserves the widget's screen position and DPI scale on a secondary monitor", () => {
  const box = stageGeometry(plan, false);
  assert.equal(box.x, 660);
  assert.equal(box.y, 360);
  assert.equal(box.width * box.scale, plan.widget.width);
  assert.equal(box.height * box.scale, plan.widget.height);
  assert.deepEqual(stageGeometry(plan, true), { x: 0, y: 0, width: 2560, height: 1440, scale: 1 });
});

test("expansion and contraction use the same window outline and exact original bounds", () => {
  const reversed = { ...plan, fullscreen: false };
  assert.deepEqual(stageGeometry(plan, false), stageGeometry(reversed, false));
  assert.equal(clipGeometry(plan, false), "360px 1352px 240px 660px round 26.4px");
  assert.equal(clipGeometry(plan, true), "0px 0px 0px 0px round 0px");
});

function fixture() {
  const styles = () => ({ setProperty(key, value) { this[key] = value; }, removeProperty(key) { delete this[key]; } });
  const classes = new Set();
  const document = { body: { style: styles(), classList: { contains: () => false } },
    documentElement: { style: styles(), classList: { add: (key) => classes.add(key), remove: (key) => classes.delete(key) } },
    querySelector: () => null, querySelectorAll: () => [],
    startViewTransition(update) {
      const result = Promise.resolve().then(update);
      return { updateCallbackDone: result, ready: result, finished: result, skipTransition() {} };
    } };
  return { document, classes, morph: create(document) };
}

test("shared-element transition applies the target layout and removes staging styles on cleanup", async () => {
  const { document, classes, morph } = fixture();
  morph.stage(plan, false);
  assert.match(document.body.style.transform, /translate\(660px, 360px\) scale\(1.2\)/);
  let updates = 0;
  await morph.animate(plan, () => { updates++; });
  assert.equal(updates, 1);
  assert.equal(document.body.style.width, "2560px");
  morph.cleanup();
  assert.equal(classes.size, 0);
  assert.equal(document.body.style.width, undefined);
  assert.equal(document.documentElement.style["--morph-from"], undefined);
});

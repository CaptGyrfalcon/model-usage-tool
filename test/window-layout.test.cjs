const test = require("node:test");
const assert = require("node:assert/strict");
const { smartDockBounds, uiScaleForDisplay, windowMetrics, windowModeOptions } = require("../src/window-layout.cjs");

test("keeps the standard widget at its base size on a regular display", () => {
  const display = { size: { width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.equal(uiScaleForDisplay(display), 1);
  assert.deepEqual(windowMetrics({}, display), { width: 456, height: 700, zoomFactor: 1 });
});

test("scales the non-fullscreen widget and its typography on a 4K display", () => {
  const display = { size: { width: 1920, height: 1080 }, scaleFactor: 2 };
  assert.equal(uiScaleForDisplay(display), 1.2);
  assert.deepEqual(windowMetrics({}, display), { width: 547, height: 840, zoomFactor: 1.2 });
  assert.deepEqual(windowMetrics({ compact: true }, display), { width: 547, height: 468, zoomFactor: 1.2 });
});

test("keeps the quota orb compact while making it readable on 4K", () => {
  const display = { size: { width: 3840, height: 2160 }, scaleFactor: 1 };
  assert.deepEqual(windowMetrics({ orbMode: true }, display), { width: 518, height: 312, zoomFactor: 1.2 });
});

test("gives the multi-pool overview a wider dedicated canvas", () => {
  const display = { size: { width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.deepEqual(windowMetrics({ orbMode: true, orbDisplayMode: "pool" }, display), { width: 760, height: 400, zoomFactor: 1 });
});

test("makes the combined tank window taller so one vessel can fill the pane", () => {
  const display = { size: { width: 1920, height: 1080 }, scaleFactor: 1 };
  assert.deepEqual(
    windowMetrics({ orbMode: true, orbDisplayMode: "pool", orbPoolCombined: true }, display),
    { width: 448, height: 560, zoomFactor: 1 }
  );
});

test("does not grow a full widget beyond a heavily scaled display", () => {
  const display = { size: { width: 1280, height: 720 }, workArea: { width: 1280, height: 680 }, scaleFactor: 3 };
  assert.deepEqual(windowMetrics({}, display), { width: 456, height: 700, zoomFactor: 1 });
});

test("only the quota orb opts out of the taskbar while widget modes stay on top", () => {
  assert.deepEqual(windowModeOptions({}, false), { skipTaskbar: false, alwaysOnTop: true });
  assert.deepEqual(windowModeOptions({ compact: true }, false), { skipTaskbar: false, alwaysOnTop: true });
  assert.deepEqual(windowModeOptions({ orbMode: true }, false), { skipTaskbar: true, alwaysOnTop: true });
  assert.deepEqual(windowModeOptions({ orbMode: true }, true), { skipTaskbar: false, alwaysOnTop: false });
});

test("smart docking leaves a narrow reveal strip on the nearest edge", () => {
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  assert.deepEqual(smartDockBounds({ x: 100, y: 20, width: 456, height: 700 }, area), {
    edge: "left",
    restoreBounds: { x: 8, y: 20, width: 456, height: 700 },
    dockedBounds: { x: -444, y: 20, width: 456, height: 700 },
  });
  assert.equal(smartDockBounds({ x: 1400, y: 20, width: 456, height: 700 }, area).dockedBounds.x, 1908);
});

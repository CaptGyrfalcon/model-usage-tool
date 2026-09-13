const test = require("node:test");
const assert = require("node:assert/strict");
const { createWindowDrag } = require("../src/window-drag.cjs");

function setup() {
  const state = { cursor: { x: 100, y: 100 }, fullscreen: false, nativeFullscreen: false, positions: [], bounds: [] };
  const window = { isDestroyed: () => false, isFullScreen: () => state.nativeFullscreen,
    getBounds: () => ({ x: -500, y: 200, width: 456, height: 700 }),
    setBounds: (bounds) => { state.bounds.push(bounds); state.positions.push({ x: bounds.x, y: bounds.y }); } };
  return { state, drag: createWindowDrag({ getWindow: () => window, getCursor: () => state.cursor, isFullscreen: () => state.fullscreen }) };
}

test("titlebar drag ignores click jitter and moves relative to the original screen position", () => {
  const { state, drag } = setup();
  drag.start();
  state.cursor = { x: 102, y: 101 };
  drag.move();
  assert.deepEqual(state.positions, []);
  state.cursor = { x: 120, y: 130 };
  drag.move();
  state.cursor = { x: 130, y: 140 };
  drag.move();
  assert.deepEqual(state.positions, [{ x: -480, y: 230 }, { x: -470, y: 240 }]);
  drag.end();
  drag.move();
  assert.equal(state.positions.length, 2);
});

test("fullscreen rejects new drags and cancels an in-progress drag", () => {
  for (const flag of ["fullscreen", "nativeFullscreen"]) {
    const { state, drag } = setup();
    state[flag] = true;
    drag.start();
    state.cursor = { x: 200, y: 200 };
    drag.move();
    assert.deepEqual(state.positions, []);
    state[flag] = false;
    drag.start();
    state[flag] = true;
    state.cursor = { x: 300, y: 300 };
    drag.move();
    state[flag] = false;
    drag.move();
    assert.deepEqual(state.positions, []);
    drag.start();
    state.cursor = { x: 310, y: 320 };
    drag.move();
    assert.deepEqual(state.positions, [{ x: -490, y: 220 }]);
  }
});

test("stationary pointer feedback never repeats native moves or grows the window", () => {
  const { state, drag } = setup();
  drag.start();
  state.cursor = { x: 120, y: 130 };
  drag.move();
  for (let i = 0; i < 100; i++) drag.move();
  assert.deepEqual(state.bounds, [{ x: -480, y: 230, width: 456, height: 700 }]);
  state.cursor = { x: 125, y: 135 };
  drag.move();
  assert.deepEqual(state.bounds[1], { x: -475, y: 235, width: 456, height: 700 });
});

test("drag uses intended display dimensions despite native size drift and reentrant events", () => {
  let cursor = { x: 100, y: 100 };
  let size = { width: 547, height: 840 };
  const moves = [];
  const window = {
    isDestroyed: () => false, isFullScreen: () => false,
    getBounds: () => ({ x: 0, y: 0, width: 550, height: 844 }),
    setBounds(bounds) { moves.push(bounds); drag.move(); },
  };
  const drag = createWindowDrag({ getWindow: () => window, getCursor: () => cursor,
    isFullscreen: () => false, getSize: () => size });
  drag.start();
  cursor = { x: 120, y: 130 };
  drag.move();
  size = { width: 456, height: 700 };
  cursor = { x: 130, y: 140 };
  drag.move();
  assert.deepEqual(moves, [
    { x: 20, y: 30, width: 547, height: 840 },
    { x: 30, y: 40, width: 456, height: 700 },
  ]);
});

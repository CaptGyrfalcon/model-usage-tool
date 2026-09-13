const { test } = require('node:test');
const assert = require('node:assert/strict');
const { meterRows, taskbarBounds, presentTaskbarWindow } = require('../src/taskbar-meters.cjs');
test('three rows keep measured weekly and five-hour windows separate regardless of slot', () => {
  const result = meterRows({ data: { cursorModels: { percentRemaining: 82.5 }, otherModels: { percentRemaining: 12 }, codex: { quota: {
    windows: [{ windowMinutes: 10080, percentRemaining: 61 }, { windowMinutes: 300, percentRemaining: 8 }],
  } } } });
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[2].meters, [{ label: '周', value: 61 }, { label: '5h', value: 8 }]);
});
test('missing, expired and invalid values are unknown, not invented full quota', () => {
  assert.equal(meterRows({}).rows[0].meters[0].value, null);
  for (const pool of [{ percentRemaining: null }, { percentRemaining: NaN }, { percentRemaining: 100, expired: true }, { percentRemaining: 80, resetsAt: 99 }]) {
    assert.equal(meterRows({ data: { codex: { quota: { primary: { windowMinutes: 10080, ...pool } } } } }, 100).rows[2].meters[0].value, null);
  }
});
test('plan name does not manufacture a five-hour window, explicit absence hides old short window', () => {
  assert.equal(meterRows({ data: { codex: { planName: 'Pro' } } }).rows[2].meters.length, 1);
  assert.equal(meterRows({ data: { codex: { quota: { shortLimit: 'absent', primary: { windowMinutes: 300, percentRemaining: 40 } } } } }).rows[2].meters.length, 1);
});
test('position uses tray boundary, including negative monitor coordinates, rejects hidden and vertical bars', () => {
  assert.deepEqual(taskbarBounds({ x: -1920, y: 1032, width: 1920, height: 48 }, { x: -240 }), { x: -498, y: 1034, width: 252, height: 44 });
  assert.equal(taskbarBounds({ x: 0, y: 1078, width: 1920, height: 2 }, { x: 1600 }), null);
  assert.equal(taskbarBounds({ x: 0, y: 0, width: 48, height: 1080 }, { x: 0 }), null);
});

test('restores taskbar ordering after fullscreen even when Windows still reports the meter visible', () => {
  const bounds = { x: 1800, y: 1034, width: 252, height: 44 };
  let visible = true, raised = 0, shows = 0, paints = 0;
  const window = {
    isVisible: () => visible, getBounds: () => bounds,
    setBounds: () => assert.fail('unchanged geometry must not move'),
    setAlwaysOnTop: value => assert.equal(value, true),
    moveTop: () => { raised++; },
    showInactive: () => { visible = true; shows++; },
    hide: () => { visible = false; },
    webContents: { invalidate: () => { paints++; } },
  };
  presentTaskbarWindow(window, bounds, true);
  assert.equal(raised, 1); assert.equal(shows, 0);
  presentTaskbarWindow(window, null, true); // foreground fullscreen
  assert.equal(visible, false); assert.equal(raised, 1);
  presentTaskbarWindow(window, bounds, true); // desktop returns
  assert.equal(visible, true); assert.equal(shows, 1); assert.equal(paints, 1);
  presentTaskbarWindow(window, bounds, true); // Explorer raises taskbar again
  assert.equal(raised, 3); assert.equal(shows, 1);
  presentTaskbarWindow(window, bounds, false); // user disables meters
  assert.equal(visible, false); assert.equal(raised, 3);
});

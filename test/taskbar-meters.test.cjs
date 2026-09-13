const { test } = require('node:test');
const assert = require('node:assert/strict');
const { meterRows, secondaryTaskbars, menuPopupAnchor, createMeterPublisher, createRunningTaskbarMeters, createTaskbarMeters } = require('../src/taskbar-meters.cjs');
test('three rows keep measured weekly and five-hour windows separate regardless of slot', () => {
  const result = meterRows({ data: { cursorModels: { percentRemaining: 82.5 }, otherModels: { percentRemaining: 12 }, codex: { quota: {
    windows: [{ windowMinutes: 10080, percentRemaining: 61 }, { windowMinutes: 300, percentRemaining: 8 }],
  } } } });
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows[2].meters.map(meter => ({ label: meter.label, value: meter.value })), [{ label: '周', value: 61 }, { label: '5h', value: 8 }]);
});
test('remaining dollars use inferred leftover and never invent a pool size', () => {
  const now = 1_000_000;
  const rows = meterRows({ data: {
    cursorModels: { percentRemaining: 38.63, quotaEstimate: { inferredRemainingCents: 114514.4 } },
    otherModels: { percentRemaining: 8.76, quotaEstimate: { inferredTotalCents: 5692 } },
    codex: { quota: { windows: [{ windowMinutes: 10080, percentRemaining: 61, quotaEstimate: { usedCents: 8500, inferredTotalCents: 31481 } }] } },
  } }, now);
  assert.equal(rows.rows[0].meters[0].remainingCents, 114514.4);
  assert.equal(rows.rows[1].meters[0].remainingCents, 5692 * 8.76 / 100);
  assert.ok(Math.abs(rows.rows[2].meters[0].remainingCents - 31481 * 0.61) < 1e-6);
  assert.equal(meterRows({ data: { cursorModels: { percentRemaining: 80 } } }, now).rows[0].meters[0].remainingCents, null);
  assert.equal(meterRows({ data: { otherModels: { percentRemaining: 50, includedCents: { remaining: 180 } } } }, now).rows[1].meters[0].remainingCents, 180);
  assert.equal(meterRows({ data: { cursorModels: { percentRemaining: 20, expired: true, quotaEstimate: { inferredRemainingCents: 100 } } } }, now).rows[0].meters[0].remainingCents, null);
});
test('pace is leftover percent if the pool is spent evenly through the cycle', () => {
  const now = 10 * 86_400_000;
  const start = now - 3 * 86_400_000;
  const end = now + 7 * 86_400_000;
  const rows = meterRows({ data: {
    billingCycleStart: start,
    billingCycleEnd: end,
    cursorModels: { percentRemaining: 40 },
    otherModels: { percentRemaining: 90 },
    codex: { quota: { windows: [
      { windowMinutes: 10080, percentRemaining: 61, resetsAt: now + 3.5 * 86_400_000 },
      { windowMinutes: 300, percentRemaining: 40, resetsAt: now + 90 * 60_000 },
    ] } },
  } }, now);
  assert.equal(rows.rows[0].meters[0].pace, 70);
  assert.equal(rows.rows[1].meters[0].pace, 70);
  assert.equal(rows.rows[2].meters[0].pace, 50);
  assert.equal(rows.rows[2].meters[1].pace, 30);
  assert.equal(meterRows({ data: { cursorModels: { percentRemaining: 40 } } }, now).rows[0].meters[0].pace, null);
  assert.equal(meterRows({ data: { billingCycleEnd: now - 1, cursorModels: { percentRemaining: 10 } } }, now).rows[0].meters[0].pace, null);
  const estimated = meterRows({ data: { billingCycleEnd: now + 10 * 86_400_000, cursorModels: { percentRemaining: 40 } } }, now);
  assert.ok(Math.abs(estimated.rows[0].meters[0].pace - 10 / 30 * 100) < 1e-6);
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
test('secondary taskbars stay on unless explicitly disabled', () => {
  assert.equal(secondaryTaskbars(undefined), true);
  assert.equal(secondaryTaskbars({}), true);
  assert.equal(secondaryTaskbars({ taskbarMetersSecondary: true }), true);
  assert.equal(secondaryTaskbars({ taskbarMetersSecondary: false }), false);
  let settings = {}, sends = 0, last = null;
  const publish = createMeterPublisher(() => ({ data: { cursorModels: { percentRemaining: 40 } } }), () => settings);
  const send = (line) => { sends++; last = JSON.parse(line); };
  publish(send, true);
  assert.equal(last.secondary, true);
  settings = { taskbarMetersSecondary: false };
  publish(send, true);
  assert.equal(last.secondary, false);
  assert.equal(sends, 2);
  publish(send, true);
  assert.equal(sends, 2);
});
test('disconnected native meters send nothing and identical data is deduplicated', () => {
  let sends = 0, reads = 0, percentRemaining = 60;
  const publish = createMeterPublisher(() => { reads++; return { data: { cursorModels: { percentRemaining } } }; });
  const send = () => { sends++; };
  for (let i = 0; i < 100; i++) publish(send, false);
  assert.equal(reads, 0); assert.equal(sends, 0);
  publish(send, true);
  for (let i = 0; i < 100; i++) publish(send, true);
  assert.equal(sends, 1);
  percentRemaining = 50; publish(send, true); assert.equal(sends, 2);
  publish(send, false); percentRemaining = 40; publish(send, false);
  assert.equal(sends, 2);
  publish(send, true); assert.equal(sends, 3);
});

test('disabling meters destroys native process; reenable starts one fresh session', () => {
  let enabled = false, started = 0, stopped = 0, updated = 0;
  const controller = createTaskbarMeters({ getSettings: () => ({ taskbarMeters: enabled }) }, () => {
    started++;
    return { update: () => { updated++; }, dispose: () => { stopped++; } };
  });
  assert.equal(started, 0);
  enabled = true; controller.update(); controller.update();
  assert.equal(started, 1); assert.equal(updated, 1);
  enabled = false; controller.update(); controller.update();
  assert.equal(stopped, 1);
  enabled = true; controller.update(); assert.equal(started, 2);
  controller.dispose(); controller.dispose(); controller.update();
  assert.equal(stopped, 2); assert.equal(started, 2);
});

test('disable during compilation cannot launch an orphan native child', async () => {
  let resolveBuild;
  const session = createRunningTaskbarMeters({ getSnapshot: () => ({}), showWindow() {} }, {
    buildTaskbar: () => new Promise(resolve => { resolveBuild = resolve; }),
    spawn: () => assert.fail('disabled build must not launch'),
  });
  session.dispose();
  resolveBuild('native.exe');
  await new Promise(resolve => setImmediate(resolve));
});

test('native protocol delivers only quota data, opens details and closes stdin on disable', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const helper = new EventEmitter();
  helper.stdin = new PassThrough(); helper.stdout = new PassThrough(); helper.stderr = new PassThrough();
  helper.kill = () => { helper.killed = true; helper.emit('exit', 0); };
  let opened = 0, menus = 0, written = '', menuAt = null;
  helper.stdin.on('data', chunk => { written += chunk; });
  const session = createRunningTaskbarMeters({ getSnapshot: () => ({ secret: 'must-not-send', data: { cursorModels: { percentRemaining: 23 } } }), showWindow: () => { opened++; }, showMenu: (point) => { menus++; menuAt = point; } }, {
    buildTaskbar: async () => 'native.exe', spawn: () => helper,
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.parse(written).rows[0].meters[0].value, 23);
  assert.equal(JSON.parse(written).secondary, true);
  assert.ok(!written.includes('must-not-send'));
  session.update(); assert.equal(written.trim().split('\n').length, 1);
  helper.stdout.write('{"type":"open"}\n'); assert.equal(opened, 1);
  helper.stdout.write('{"type":"menu","x":1700,"y":1040}\n'); assert.equal(menus, 1); assert.equal(opened, 1);
  assert.deepEqual(menuAt, { type: 'menu', x: 1700, y: 1040 });
  session.dispose(); assert.equal(helper.stdin.writableEnded, true);
  helper.stdout.write('{"type":"open"}\n'); assert.equal(opened, 1);
  helper.stdout.write('{"type":"menu"}\n'); assert.equal(menus, 1);
  helper.emit('exit', 0);
});

test('menu popup is anchored to the click, not the owner window origin', () => {
  assert.deepEqual(menuPopupAnchor({ x: 1700, y: 1040 }, { x: 500, y: 200 }), { x: 1200, y: 840 });
  assert.deepEqual(menuPopupAnchor({ x: -240, y: 1032 }, { x: 100, y: 80 }), { x: -340, y: 952 });
  assert.deepEqual(menuPopupAnchor({ x: 12.6, y: 8.4 }, null), { x: 13, y: 8 });
  assert.equal(menuPopupAnchor({}, { x: 0, y: 0 }), null);
});

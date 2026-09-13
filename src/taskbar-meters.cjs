const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { buildTaskbar } = require('../scripts/build-taskbar.cjs');

function finite(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(pool, now) {
  if (!pool || pool.expired || (pool.resetsAt && pool.resetsAt <= now)) return null;
  const value = finite(pool.percentRemaining);
  return value == null ? null : Math.max(0, Math.min(100, value));
}

function remainingCents(pool) {
  if (!pool) return null;
  const estimate = pool.quotaEstimate || {};
  const leftover = finite(estimate.inferredRemainingCents);
  if (leftover != null) return Math.max(0, leftover);
  const remaining = finite(pool.percentRemaining);
  const total = finite(estimate.inferredTotalCents);
  if (total != null && remaining != null) return Math.max(0, total * Math.max(0, Math.min(100, remaining)) / 100);
  const used = finite(estimate.usedCents);
  const usedPct = finite(pool.percentUsed);
  if (used != null && usedPct > 0 && remaining != null) return Math.max(0, used / usedPct * remaining);
  const included = finite(pool.includedCents?.remaining);
  return included == null ? null : Math.max(0, included);
}

function cycleStart(pool, explicitStart, typicalMs, explicitEnd) {
  const start = finite(explicitStart);
  if (start != null) return start;
  const end = finite(explicitEnd ?? pool?.resetsAt);
  const duration = finite(pool?.windowMinutes) != null ? pool.windowMinutes * 60_000 : finite(typicalMs);
  return end != null && duration != null ? end - duration : null;
}

function paceRemaining(startAt, resetsAt, now) {
  const start = finite(startAt);
  const end = finite(resetsAt);
  if (start == null || end == null || end <= start) return null;
  if (now >= end) return null;
  if (now <= start) return 100;
  return Math.max(0, Math.min(100, 100 * (end - now) / (end - start)));
}

function meter(label, pool, now, cycle = {}) {
  const value = percent(pool, now);
  return {
    label,
    value,
    remainingCents: value == null ? null : remainingCents(pool),
    pace: value == null ? null : paceRemaining(cycleStart(pool, cycle.startAt, cycle.typicalMs, cycle.resetsAt), cycle.resetsAt ?? pool?.resetsAt, now),
  };
}

function meterRows(snapshot, now = Date.now()) {
  const data = snapshot?.data;
  const quota = data?.codex?.quota;
  const windows = quota?.windows?.length ? quota.windows : [quota?.primary, quota?.secondary].filter(Boolean);
  const week = windows.find(w => w.windowMinutes === 10080);
  const short = quota?.shortLimit === 'absent' ? null : windows.find(w => w.windowMinutes === 300);
  const cursorCycle = { startAt: data?.billingCycleStart, resetsAt: data?.billingCycleEnd, typicalMs: 30 * 86_400_000 };
  return {
    stale: Boolean(snapshot?.error || data?.sourceStatus?.cursor?.error || data?.sourceStatus?.codex?.error),
    sampledAt: quota?.sampledAt,
    rows: [
      { label: 'Cursor', meters: [meter('模型', data?.cursorModels, now, cursorCycle)] },
      { label: '三方', meters: [meter('三方', data?.otherModels, now, cursorCycle)] },
      { label: 'Codex', meters: [meter('周', week, now), ...(short ? [meter('5h', short, now)] : [])] },
    ],
  };
}


function secondaryTaskbars(settings) {
  return settings?.taskbarMetersSecondary !== false;
}

// Send only quota rows and the secondary-bar flag, never credentials or identity.
function createMeterPublisher(getSnapshot, getSettings) {
  let previous = null;
  return (send, connected) => {
    if (!connected) { previous = null; return; }
    const value = JSON.stringify({ ...meterRows(getSnapshot()), secondary: secondaryTaskbars(getSettings?.()) });
    if (value !== previous) { send(value + '\n'); previous = value; }
  };
}

function createRunningTaskbarMeters({ getSnapshot, getSettings, showWindow, showMenu = () => {}, nativeDirectory, onStatus = () => {} }, dependencies = {}) {
  const compile = dependencies.buildTaskbar || buildTaskbar;
  const launch = dependencies.spawn || spawn;
  let child, retry, expiry, stopped = false, failures = 0;
  const publish = createMeterPublisher(getSnapshot, getSettings);
  const update = () => publish(line => child.stdin.write(line), Boolean(child && !child.killed && child.stdin.writable));
  const start = async () => {
    try {
      const executable = await compile(nativeDirectory);
      if (stopped) return;
      const helper = launch(executable, [String(process.pid)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child = helper;
      let ended = false;
      const finish = () => {
        if (ended) return;
        ended = true;
        if (child === helper) child = null;
        publish(null, false);
        if (!stopped) retry = setTimeout(start, Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
      };
      helper.stdin.on('error', () => helper.kill());
      helper.stderr.on('data', chunk => console.warn('Native taskbar:', String(chunk).slice(0, 1000)));
      const lines = createInterface({ input: helper.stdout });
      lines.on('line', line => {
        try {
          const message = JSON.parse(line);
          if (message.type === 'open' && !stopped) showWindow();
          else if (message.type === 'menu' && !stopped) showMenu(message);
          else if (message.type === 'status') { failures = 0; onStatus(message); }
          else if (message.type === 'error') console.warn('Native taskbar:', message.message);
        } catch { /* Ignore unrelated compiler/runtime output. */ }
      });
      helper.once('error', error => { console.warn('Native taskbar:', error.message); finish(); });
      helper.once('exit', () => { lines.close(); finish(); });
      update();
    } catch (error) {
      console.warn(error.message);
      if (!stopped) retry = setTimeout(start, 30000);
    }
  };
  if (process.platform === 'win32' || dependencies.spawn) {
    start();
    // Re-evaluate expiration even if no new network snapshot arrives.
    expiry = setInterval(update, 5000);
    expiry.unref?.();
  }
  return { update, dispose() {
    if (stopped) return;
    stopped = true; clearTimeout(retry); clearInterval(expiry);
    const helper = child; child = null;
    if (helper && !helper.killed) {
      // EOF closes the native message loop and destroys the child control.
      helper.stdin.end();
      const kill = setTimeout(() => helper.kill(), 2000);
      kill.unref?.();
      helper.once('exit', () => clearTimeout(kill));
    }
  } };
}

// Disabling releases the native process, hooks and drawing surface.
function createTaskbarMeters(options, startSession = createRunningTaskbarMeters) {
  let session = null, disposed = false;
  const update = () => {
    if (disposed) return;
    if (options.getSettings().taskbarMeters === false) {
      session?.dispose(); session = null;
    } else if (!session) session = startSession(options);
    else session.update();
  };
  update();
  return { update, dispose() {
    disposed = true; session?.dispose(); session = null;
  } };
}
// Electron Menu.popup x/y are relative to the owner window, not the screen.
function menuPopupAnchor(screenPoint, windowBounds) {
  const x = Number(screenPoint?.x), y = Number(screenPoint?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const originX = Number(windowBounds?.x), originY = Number(windowBounds?.y);
  if (!Number.isFinite(originX) || !Number.isFinite(originY)) return { x: Math.round(x), y: Math.round(y) };
  return { x: Math.round(x - originX), y: Math.round(y - originY) };
}

module.exports = { meterRows, secondaryTaskbars, menuPopupAnchor, createMeterPublisher, createRunningTaskbarMeters, createTaskbarMeters };

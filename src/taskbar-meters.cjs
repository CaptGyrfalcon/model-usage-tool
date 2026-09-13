const path = require('node:path');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');

function percent(pool, now) {
  if (!pool || pool.expired || (pool.resetsAt && pool.resetsAt <= now)) return null;
  const value = pool.percentRemaining;
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function meterRows(snapshot, now = Date.now()) {
  const data = snapshot?.data;
  const quota = data?.codex?.quota;
  const windows = quota?.windows?.length ? quota.windows : [quota?.primary, quota?.secondary].filter(Boolean);
  const week = windows.find(w => w.windowMinutes === 10080);
  const short = quota?.shortLimit === 'absent' ? null : windows.find(w => w.windowMinutes === 300);
  const meter = (label, pool) => ({ label, value: percent(pool, now) });
  return {
    stale: Boolean(snapshot?.error || data?.sourceStatus?.cursor?.error || data?.sourceStatus?.codex?.error),
    sampledAt: quota?.sampledAt,
    rows: [
      { label: 'Cursor', meters: [meter('模型', data?.cursorModels)] },
      { label: '三方', meters: [meter('三方', data?.otherModels)] },
      { label: 'Codex', meters: [meter('周', week), ...(short ? [meter('5h', short)] : [])] },
    ],
  };
}

function taskbarBounds(taskbar, tray, width = 252) {
  if (!taskbar || !tray || taskbar.height > taskbar.width || taskbar.height < 24 || tray.x - taskbar.x < width + 8) return null;
  const height = Math.min(44, taskbar.height - 4);
  return { x: Math.round(tray.x - width - 6), y: Math.round(taskbar.y + (taskbar.height - height) / 2), width, height: Math.round(height) };
}

// WS_VISIBLE remains set when Explorer or a game changes the topmost ordering.
// Restore that ordering on every visible probe without activating the window.
function presentTaskbarWindow(window, geometry, enabled) {
  if (!geometry || !enabled) {
    if (window.isVisible()) window.hide();
    return;
  }
  const current = window.getBounds();
  if (['x', 'y', 'width', 'height'].some(key => current[key] !== geometry[key])) window.setBounds(geometry);
  window.setAlwaysOnTop(true, 'screen-saver');
  if (!window.isVisible()) {
    window.showInactive();
    window.webContents.invalidate();
  }
  window.moveTop();
}

function createTaskbarMeters({ BrowserWindow, screen, ipcMain, getSnapshot, getSettings, showWindow }) {
  let window, probe, retry, watchdog, geometry, stopped = false, ready = false, reportedError = false;
  const update = () => {
    if (!window || window.isDestroyed()) return;
    if (ready) window.webContents.send('taskbar-meters', meterRows(getSnapshot()));
    presentTaskbarWindow(window, geometry, ready && getSettings().taskbarMeters !== false);
  };
  window = new BrowserWindow({ width: 252, height: 44, frame: false, transparent: false, backgroundColor: '#171c25',
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, focusable: false, alwaysOnTop: true, hasShadow: false, show: false,
    webPreferences: { preload: path.join(__dirname, 'taskbar-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  window.setAlwaysOnTop(true, 'screen-saver');
  window.loadFile(path.join(__dirname, 'renderer', 'taskbar.html'));
  window.once('ready-to-show', () => { ready = true; update(); });
  window.webContents.once('did-finish-load', () => { ready = true; update(); });
  const open = (event) => { if (event.sender === window?.webContents) showWindow(); };
  ipcMain.on('taskbar-open', open);
  const startProbe = () => {
    if (stopped) return;
    probe = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'taskbar-probe.ps1'), '-OwnerPid', String(process.pid)], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    probe.stderr.resume();
    const lines = createInterface({ input: probe.stdout });
    lines.on('line', line => {
      try {
        const state = JSON.parse(line);
        clearTimeout(watchdog);
        // The native listener sends a 5-second heartbeat when the desktop is idle.
        // Restart a stalled helper instead of leaving the meters hidden forever.
        watchdog = setTimeout(() => { geometry = null; update(); probe?.kill(); }, 15000);
        geometry = state.visible ? taskbarBounds(screen.screenToDipRect(null, state.taskbar), screen.screenToDipRect(null, state.tray)) : null;
        update();
      } catch (error) {
        if (!reportedError) console.warn('Taskbar position unavailable:', error.message);
        reportedError = true; geometry = null; update();
      }
    });
    probe.on('error', () => { geometry = null; update(); });
    probe.on('exit', () => {
      clearTimeout(watchdog);
      lines.close(); geometry = null; update();
      if (!stopped) retry = setTimeout(startProbe, 5000);
    });
  };
  if (process.platform === 'win32') startProbe();
  return { update, dispose() {
    stopped = true; clearTimeout(retry); clearTimeout(watchdog); probe?.kill();
    ipcMain.removeListener('taskbar-open', open);
    if (!window.isDestroyed()) window.destroy();
    window = null;
  } };
}
module.exports = { meterRows, taskbarBounds, presentTaskbarWindow, createTaskbarMeters };

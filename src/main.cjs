const fs = require("node:fs");
const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { app, BrowserWindow, dialog, ipcMain, shell, Menu, screen, Tray, nativeImage, Notification, globalShortcut } = require("electron");
const { loadSettings, saveSettings } = require("./lib.cjs");
const { codexHomePath } = require("./codex.cjs");
const { smartDockBounds, windowMetrics, windowModeOptions } = require("./window-layout.cjs");
const { alertLevel } = require("./quota-insights.cjs");

const MIN_INTERVAL = 15_000;
const MAX_INTERVAL = 300_000;
const SMART_DOCK_REVEAL = 12;
const SMART_DOCK_DELAY = 280;
const SMART_DOCK_DURATION = 210;

let win;
let tray;
let pollTimer;
let codexWatcher;
let codexRefreshTimer;
let activePull;
let isQuitting = false;
let fullscreenRestore = null;
let fullscreenRestoreTimer = null;
let boundsSaveTimer = null;
let lastWindowMotionAt = 0;
let dashboardFullscreen = false;
let presentationDisplayId = null;
let smartDockTimer = null;
let dockAnimationTimer = null;
let smartDockState = null;
let dockTransition = false;
let shortcutStatus = {};
let latest = { ok: false, loading: true, data: null };
let dataWorker = null;
let dataTaskId = 0;
const dataTasks = new Map();
const quotaAlertState = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

function clampInterval(value) {
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number(value) || 30_000));
}

function resetDescription(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return "等待同步重置时间";
  return new Date(Number(timestamp)).toLocaleString("zh-CN", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function checkQuotaAlerts(data) {
  const settings = loadSettings();
  if (!settings.quotaAlerts || !Notification.isSupported()) return;
  const threshold = Number(settings.alertThreshold) || 20;
  const pending = [];
  for (const insight of data?.quotaInsights || []) {
    const level = alertLevel(insight.remainingPercent, threshold);
    const resetKey = Number(insight.resetsAt) || 0;
    const previous = quotaAlertState.get(insight.id);
    if (!level) {
      if (Number(insight.remainingPercent) > threshold + 2) quotaAlertState.delete(insight.id);
      continue;
    }
    const severity = level === "critical" ? 2 : 1;
    if (!previous || previous.resetKey !== resetKey || severity > previous.severity) {
      pending.push({ ...insight, level, severity });
      quotaAlertState.set(insight.id, { resetKey, severity });
    }
  }
  if (!pending.length) return;
  const critical = pending.some((item) => item.level === "critical");
  const body = pending
    .slice(0, 3)
    .map((item) => `${item.label} 剩余 ${Number(item.remainingPercent).toFixed(String(item.id).startsWith("cursor") ? 2 : 0)}% · ${resetDescription(item.resetsAt)}`)
    .join("\n");
  const notification = new Notification({
    title: critical ? "额度即将耗尽" : "额度余量提醒",
    body,
    icon: appImage(64),
    timeoutType: critical ? "never" : "default",
  });
  notification.on("click", () => showWindow());
  notification.show();
}

function registerGlobalShortcuts() {
  const shortcuts = {
    "CommandOrControl+Alt+U": () => toggleWindow(),
    "CommandOrControl+Alt+O": () => {
      const settings = loadSettings();
      applySettings({ orbMode: !settings.orbMode, compact: false });
      showWindow();
    },
    "CommandOrControl+Alt+M": () => {
      const settings = loadSettings();
      applySettings({ compact: !settings.compact, orbMode: false });
      showWindow();
    },
    "CommandOrControl+Alt+P": () => {
      const settings = loadSettings();
      applySettings({ privacyMode: !settings.privacyMode });
      showWindow();
    },
  };
  shortcutStatus = {};
  for (const [accelerator, action] of Object.entries(shortcuts)) {
    try {
      shortcutStatus[accelerator] = globalShortcut.register(accelerator, action);
    } catch {
      shortcutStatus[accelerator] = false;
    }
  }
  broadcastWindowState();
}

function rejectDataTasks(error, targetWorker = null) {
  for (const [id, pending] of dataTasks) {
    if (targetWorker && pending.worker !== targetWorker) continue;
    dataTasks.delete(id);
    pending.reject(error);
  }
}

function createDataWorker() {
  if (dataWorker) return dataWorker;
  const worker = new Worker(path.join(__dirname, "data-worker.cjs"));
  dataWorker = worker;
  worker.on("message", ({ id, ok, data, error, stack }) => {
    const pending = dataTasks.get(id);
    if (!pending) return;
    dataTasks.delete(id);
    if (ok) pending.resolve(data);
    else {
      const taskError = new Error(error || "后台数据任务失败");
      if (stack) taskError.stack = stack;
      pending.reject(taskError);
    }
  });
  worker.on("error", (error) => {
    if (dataWorker === worker) dataWorker = null;
    rejectDataTasks(error, worker);
  });
  worker.on("exit", (code) => {
    if (dataWorker === worker) dataWorker = null;
    rejectDataTasks(new Error(`后台数据线程已退出（${code}）`), worker);
  });
  return worker;
}

function runDataTask(task, payload = {}) {
  const worker = createDataWorker();
  const id = ++dataTaskId;
  return new Promise((resolve, reject) => {
    dataTasks.set(id, { resolve, reject, worker });
    try {
      worker.postMessage({ id, task, payload });
    } catch (error) {
      dataTasks.delete(id);
      reject(error);
    }
  });
}

function stopDataWorker() {
  const worker = dataWorker;
  dataWorker = null;
  rejectDataTasks(new Error("应用正在退出"));
  if (worker) worker.terminate();
}

function widgetSize(settings, display = screen.getPrimaryDisplay()) {
  const { width, height } = windowMetrics(settings, display);
  return { width, height };
}

function safeWindowPosition(settings) {
  const displays = screen.getAllDisplays();
  const targetDisplay = Number.isFinite(settings.x) && Number.isFinite(settings.y)
    ? screen.getDisplayNearestPoint({ x: settings.x, y: settings.y })
    : screen.getPrimaryDisplay();
  const size = widgetSize(settings, targetDisplay);
  const desired = { x: settings.x, y: settings.y, ...size };
  if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    const visible = displays.some((display) => {
      const area = display.workArea;
      return desired.x < area.x + area.width - 80 && desired.x + desired.width > area.x + 80 &&
        desired.y < area.y + area.height - 48 && desired.y + 48 > area.y;
    });
    if (visible) return { x: settings.x, y: settings.y };
  }
  const area = targetDisplay.workArea;
  return { x: area.x + area.width - size.width - 20, y: area.y + 20 };
}

function appImage(size = 20) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#9DF5D0"/><stop offset="1" stop-color="#7C8CFF"/></linearGradient></defs>
    <rect x="2" y="2" width="28" height="28" rx="8" fill="#171A23"/>
    <path d="M9 22V15h4v7H9zm5.5 0V9h4v13h-4zM20 22v-9h4v9h-4z" fill="url(#g)"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  return image.resize({ width: size, height: size });
}

function trayMenu() {
  const settings = loadSettings();
  return Menu.buildFromTemplate([
    { label: win?.isVisible() ? "隐藏额度挂件" : "显示额度挂件", click: () => toggleWindow() },
    { label: "立即刷新", click: () => pull(true) },
    {
      label: "全屏仪表盘",
      type: "checkbox",
      checked: dashboardFullscreen,
      click: () => toggleFullscreen(),
    },
    { type: "separator" },
    {
      label: "窗口始终置顶",
      type: "checkbox",
      checked: true,
      enabled: false,
    },
    {
      label: "迷你模式",
      type: "checkbox",
      checked: Boolean(settings.compact) && !settings.orbMode,
      click: (item) => applySettings({ compact: item.checked }),
    },
    {
      label: "极简额度球",
      type: "checkbox",
      checked: Boolean(settings.orbMode),
      click: (item) => applySettings({ orbMode: item.checked }),
    },
    {
      label: "智能贴边",
      type: "checkbox",
      checked: Boolean(settings.smartDock),
      click: (item) => applySettings({ smartDock: item.checked }),
    },
    {
      label: "隐私模式",
      type: "checkbox",
      checked: Boolean(settings.privacyMode),
      click: (item) => applySettings({ privacyMode: item.checked }),
    },
    {
      label: `额度提醒（${Number(settings.alertThreshold) || 20}%）`,
      type: "checkbox",
      checked: Boolean(settings.quotaAlerts),
      click: (item) => applySettings({ quotaAlerts: item.checked }),
    },
    {
      label: "开机启动",
      type: "checkbox",
      checked: Boolean(settings.openAtLogin),
      click: (item) => applySettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "打开 Cursor 账单", click: () => shell.openExternal("https://cursor.com/dashboard/spending") },
    { label: "完全退出", click: () => quitApp() },
  ]);
}

function createTray() {
  tray = new Tray(appImage());
  tray.setToolTip("AI 用量 · 正在同步");
  tray.setContextMenu(trayMenu());
  tray.on("click", () => toggleWindow());
}

function updateTray() {
  if (!tray) return;
  if (latest.data) {
    const d = latest.data;
    const parts = ["AI 用量"];
    if (d.cursorModels) parts.push(`Cursor ${Math.max(0, d.cursorModels.percentRemaining).toFixed(2)}%`);
    if (d.otherModels) parts.push(`其他模型 ${Math.max(0, d.otherModels.percentRemaining).toFixed(2)}%`);
    if (d.codex?.quota?.primary) parts.push(`Codex ${Math.max(0, d.codex.quota.primary.percentRemaining).toFixed(0)}%`);
    tray.setToolTip(parts.join(" · "));
  } else if (latest.error) {
    tray.setToolTip(`Cursor 额度 · ${latest.error}`);
  }
  tray.setContextMenu(trayMenu());
}

function createWindow() {
  const settings = loadSettings();
  const position = safeWindowPosition(settings);
  const initialDisplay = screen.getDisplayNearestPoint(position);
  const metrics = windowMetrics(settings, initialDisplay);
  const mode = windowModeOptions(settings);
  const size = { width: metrics.width, height: metrics.height };
  win = new BrowserWindow({
    ...size,
    ...position,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: true,
    skipTaskbar: mode.skipTaskbar,
    alwaysOnTop: mode.alwaysOnTop,
    hasShadow: true,
    show: false,
    backgroundColor: "#00000000",
    icon: appImage(64),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  presentationDisplayId = initialDisplay.id;
  win.webContents.setZoomFactor(metrics.zoomFactor);
  win.setAlwaysOnTop(mode.alwaysOnTop, "floating");
  win.setOpacity(Math.min(1, Math.max(0.65, settings.opacity ?? 0.96)));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => showWindow());
  win.on("move", () => broadcastWindowMotion(false));
  win.on("moved", () => {
    broadcastWindowMotion(true);
    persistBounds();
    const display = screen.getDisplayMatching(win.getBounds());
    if (display.id !== presentationDisplayId) applyWindowMode(loadSettings(), display);
  });
  win.on("enter-full-screen", () => {
    if (fullscreenRestoreTimer) clearTimeout(fullscreenRestoreTimer);
    fullscreenRestoreTimer = null;
    dashboardFullscreen = true;
    broadcastWindowState();
  });
  win.on("leave-full-screen", () => {
    dashboardFullscreen = false;
    broadcastWindowState();
    scheduleWidgetRestore();
  });
  win.on("close", (event) => {
    if (isQuitting) return;
    event.preventDefault();
    restoreSmartDock(false);
    win.hide();
    updateTray();
  });
  win.on("closed", () => {
    cancelDockAnimation();
    dockTransition = false;
    if (fullscreenRestoreTimer) clearTimeout(fullscreenRestoreTimer);
    fullscreenRestoreTimer = null;
    win = null;
  });
}

function broadcastWindowMotion(settled = false) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  const at = Date.now();
  if (!settled && at - lastWindowMotionAt < 16) return;
  lastWindowMotionAt = at;
  const [x, y] = win.getPosition();
  win.webContents.send("window-motion", { x, y, at, settled });
}

function persistBounds() {
  if (!win || win.isFullScreen() || smartDockState || dockTransition) return;
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    const [x, y] = win.getPosition();
    saveSettings({ x, y });
  }, 180);
}

function cancelSmartDockTimer() {
  if (smartDockTimer) clearTimeout(smartDockTimer);
  smartDockTimer = null;
}

function cancelDockAnimation() {
  if (dockAnimationTimer) clearInterval(dockAnimationTimer);
  dockAnimationTimer = null;
}

function animateWindowBounds(target, duration = SMART_DOCK_DURATION, easing = "smooth") {
  cancelDockAnimation();
  if (!win || win.isDestroyed()) return;
  if (!duration) {
    dockTransition = true;
    win.setBounds(target, false);
    dockTransition = false;
    return;
  }
  const start = win.getBounds();
  const startedAt = Date.now();
  const ease = easing === "out"
    ? (value) => 1 - Math.pow(1 - value, 3)
    : (value) => -(Math.cos(Math.PI * value) - 1) / 2;
  dockTransition = true;
  const tick = () => {
    if (!win || win.isDestroyed()) {
      cancelDockAnimation();
      dockTransition = false;
      return;
    }
    const progress = Math.min(1, (Date.now() - startedAt) / duration);
    const value = ease(progress);
    const bounds = {};
    for (const key of ["x", "y", "width", "height"]) {
      bounds[key] = Math.round(start[key] + (target[key] - start[key]) * value);
    }
    win.setBounds(bounds, false);
    if (progress >= 1) {
      cancelDockAnimation();
      dockTransition = false;
    }
  };
  tick();
  dockAnimationTimer = setInterval(tick, 16);
}

function restoreSmartDock(animate = true) {
  cancelSmartDockTimer();
  cancelDockAnimation();
  if (!win || !smartDockState) return false;
  const state = smartDockState;
  smartDockState = null;
  const display = screen.getAllDisplays().find((item) => item.id === state.displayId)
    || screen.getDisplayMatching(state.restoreBounds);
  const area = display.workArea;
  const target = {
    ...state.restoreBounds,
    x: state.edge === "left"
      ? area.x + 8
      : area.x + area.width - state.restoreBounds.width - 8,
    y: Math.min(area.y + area.height - state.restoreBounds.height, Math.max(area.y, state.restoreBounds.y)),
  };
  animateWindowBounds(target, animate ? 180 : 0, "out");
  broadcastWindowState();
  return true;
}

function dockSmartWindow() {
  smartDockTimer = null;
  const settings = loadSettings();
  if (!win || !win.isVisible() || smartDockState || dashboardFullscreen || win.isFullScreen() || settings.orbMode || !settings.smartDock) return;
  const bounds = win.getBounds();
  const display = screen.getDisplayMatching(bounds);
  const area = display.workArea;
  const { edge, restoreBounds, dockedBounds } = smartDockBounds(bounds, area, SMART_DOCK_REVEAL);
  smartDockState = { edge, displayId: display.id, restoreBounds };
  saveSettings({ x: restoreBounds.x, y: restoreBounds.y });
  animateWindowBounds(dockedBounds, SMART_DOCK_DURATION, "smooth");
  broadcastWindowState();
}

function handlePointerPresence(present) {
  if (present) {
    cancelSmartDockTimer();
    restoreSmartDock(true);
    return;
  }
  cancelSmartDockTimer();
  if (loadSettings().smartDock) smartDockTimer = setTimeout(dockSmartWindow, SMART_DOCK_DELAY);
}

function showWindow() {
  if (!win) return;
  restoreSmartDock(false);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  updateTray();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) {
    restoreSmartDock(false);
    win.hide();
  }
  else showWindow();
  updateTray();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function applyWindowMode(settings = loadSettings(), targetDisplay = null) {
  if (!win || dashboardFullscreen || win.isFullScreen()) return;
  restoreSmartDock(false);
  const display = targetDisplay || screen.getDisplayMatching(win.getBounds());
  const metrics = windowMetrics(settings, display);
  const mode = windowModeOptions(settings);
  const size = { width: metrics.width, height: metrics.height };
  const current = win.getBounds();
  const area = display.workArea;
  const maxX = area.x + Math.max(0, area.width - size.width);
  const maxY = area.y + Math.max(0, area.height - size.height);
  win.setBounds({
    x: Math.min(maxX, Math.max(area.x, current.x)),
    y: Math.min(maxY, Math.max(area.y, current.y)),
    ...size,
  }, true);
  presentationDisplayId = display.id;
  win.webContents.setZoomFactor(metrics.zoomFactor);
  win.setSkipTaskbar(mode.skipTaskbar);
  win.setAlwaysOnTop(mode.alwaysOnTop, "floating");
  broadcastWindowState();
}

function windowState() {
  const settings = loadSettings();
  const display = win ? screen.getDisplayMatching(win.getBounds()) : screen.getPrimaryDisplay();
  const mode = windowModeOptions(settings, dashboardFullscreen);
  return {
    fullscreen: dashboardFullscreen,
    uiScale: dashboardFullscreen ? 1 : windowMetrics(settings, display).zoomFactor,
    taskbarVisible: !mode.skipTaskbar,
    smartDocked: Boolean(smartDockState),
    dockEdge: smartDockState?.edge || null,
    shortcuts: shortcutStatus,
  };
}

function broadcastWindowState() {
  if (win && !win.webContents.isDestroyed()) win.webContents.send("window-state", windowState());
  updateTray();
}

function restoreWidgetWindow() {
  if (!win || !fullscreenRestore || win.isFullScreen()) return false;
  const settings = loadSettings();
  const display = screen.getDisplayMatching(fullscreenRestore.bounds);
  const metrics = windowMetrics(settings, display);
  const mode = windowModeOptions(settings);
  const size = { width: metrics.width, height: metrics.height };
  const targetBounds = {
    ...fullscreenRestore.bounds,
    ...size,
  };
  win.setOpacity(Math.min(1, Math.max(0.65, settings.opacity ?? 0.96)));
  win.webContents.setZoomFactor(metrics.zoomFactor);
  win.setSkipTaskbar(mode.skipTaskbar);
  win.setAlwaysOnTop(mode.alwaysOnTop, "floating");
  presentationDisplayId = display.id;
  win.setResizable(false);
  win.setMaximizable(false);
  win.setBounds(targetBounds, false);
  fullscreenRestore = null;
  showWindow();
  return true;
}

function scheduleWidgetRestore(attempt = 0) {
  if (fullscreenRestoreTimer) clearTimeout(fullscreenRestoreTimer);
  fullscreenRestoreTimer = setTimeout(() => {
    fullscreenRestoreTimer = null;
    if (!win || !fullscreenRestore) return;
    if (restoreWidgetWindow()) {
      broadcastWindowState();
      return;
    }
    if (attempt < 40) scheduleWidgetRestore(attempt + 1);
  }, 75);
}

function toggleFullscreen(force) {
  if (!win) return windowState();
  const currentlyFullscreen = dashboardFullscreen || win.isFullScreen();
  const next = typeof force === "boolean" ? force : !currentlyFullscreen;
  if (next === currentlyFullscreen) return windowState();
  if (next) {
    dashboardFullscreen = true;
    broadcastWindowState();
    fullscreenRestore = { bounds: win.getBounds() };
    const mode = windowModeOptions(loadSettings(), true);
    win.setSkipTaskbar(mode.skipTaskbar);
    win.setAlwaysOnTop(mode.alwaysOnTop);
    win.webContents.setZoomFactor(1);
    win.setOpacity(1);
    win.setResizable(true);
    win.setMaximizable(true);
    showWindow();
    win.setFullScreen(true);
  } else {
    if (win.isFullScreen()) {
      win.setFullScreen(false);
      scheduleWidgetRestore();
    } else {
      dashboardFullscreen = false;
      broadcastWindowState();
      scheduleWidgetRestore();
    }
  }
  return windowState();
}

function applySettings(partial) {
  const clean = { ...(partial || {}) };
  if ("intervalMs" in clean) clean.intervalMs = clampInterval(clean.intervalMs);
  if (clean.orbMode === true) clean.compact = false;
  if (clean.compact === true) clean.orbMode = false;
  if (clean.smartDock === false || "compact" in clean || "orbMode" in clean || "orbDisplayMode" in clean || "orbPoolCombined" in clean) restoreSmartDock(false);
  const next = saveSettings(clean);
  if ("compact" in clean || "orbMode" in clean || "orbDisplayMode" in clean || "orbPoolCombined" in clean) applyWindowMode(next);
  if ("openAtLogin" in clean) app.setLoginItemSettings({ openAtLogin: Boolean(next.openAtLogin) });
  if ("intervalMs" in clean) startPoll();
  if (win) win.webContents.send("settings", next);
  updateTray();
  return next;
}

async function pull(forcePricing = false) {
  if (activePull) return activePull;
  latest = { ...latest, loading: true };
  if (win) win.webContents.send("snapshot", latest);
  activePull = (async () => {
    try {
      const data = await runDataTask("fetch-snapshot", { forcePricing });
      latest = { ok: true, loading: false, data, error: null, fetchedAt: Date.now() };
    } catch (err) {
      latest = {
        ok: false,
        loading: false,
        data: latest.data || null,
        error: err.message || String(err),
        fetchedAt: Date.now(),
      };
    } finally {
      activePull = null;
    }
    if (win) win.webContents.send("snapshot", latest);
    if (latest.ok) checkQuotaAlerts(latest.data);
    updateTray();
    return latest;
  })();
  return activePull;
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => pull(), clampInterval(loadSettings().intervalMs));
}

function startCodexWatch() {
  try { codexWatcher?.close(); } catch {}
  codexWatcher = null;
  try {
    codexWatcher = fs.watch(codexHomePath(), { persistent: false }, (_event, filename) => {
      const changed = String(filename || "").replaceAll("\\", "/");
      if (!/(^|\/)logs_2\.sqlite(?:-(?:wal|shm))?$/.test(changed)) return;
      clearTimeout(codexRefreshTimer);
      codexRefreshTimer = setTimeout(() => pull(), 1200);
    });
  } catch {
    // The regular polling loop remains available when the Codex directory cannot be watched.
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.cursor.usage-widget");
  createTray();
  createWindow();
  registerGlobalShortcuts();
  createDataWorker();
  app.setLoginItemSettings({ openAtLogin: Boolean(loadSettings().openAtLogin) });
  startPoll();
  startCodexWatch();
  pull();
  screen.on("display-metrics-changed", () => applyWindowMode(loadSettings()));
});

app.on("activate", () => showWindow());
app.on("window-all-closed", () => {
  // The notification-area icon owns the app lifecycle on Windows.
});
app.on("before-quit", () => {
  isQuitting = true;
  clearInterval(pollTimer);
  clearTimeout(codexRefreshTimer);
  try { codexWatcher?.close(); } catch {}
  cancelSmartDockTimer();
  globalShortcut.unregisterAll();
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = null;
  stopDataWorker();
});

ipcMain.handle("get-snapshot", () => latest);
ipcMain.handle("refresh", () => pull());
ipcMain.handle("refresh-pricing", () => pull(true));
ipcMain.handle("get-settings", () => loadSettings());
ipcMain.handle("get-window-state", () => windowState());
ipcMain.handle("get-model-usage", (_event, range) => runDataTask("get-model-usage", { range }));
ipcMain.handle("get-quota-timeline", (_event, payload) => runDataTask("get-quota-timeline", payload || {}));
ipcMain.handle("query-usage-events", (_event, payload) => runDataTask("query-usage-events", payload || {}));
ipcMain.handle("get-pricing-catalog", (_event, payload) => runDataTask("get-pricing-catalog", payload || {}));
ipcMain.handle("save-text-file", async (_event, payload) => {
  if (!win) return { ok: false, error: "窗口未就绪" };
  const result = await dialog.showSaveDialog(win, {
    defaultPath: payload?.name || "export.txt",
    filters: [
      { name: "CSV", extensions: ["csv"] },
      { name: "JSON", extensions: ["json"] },
      { name: "文本", extensions: ["txt"] },
    ],
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(result.filePath, String(payload?.content ?? ""), "utf8");
  return { ok: true, path: result.filePath };
});
ipcMain.handle("toggle-fullscreen", (_event, force) => toggleFullscreen(force));
ipcMain.handle("save-settings", (_event, partial) => applySettings(partial));
ipcMain.handle("pointer-presence", (_event, present) => handlePointerPresence(Boolean(present)));
ipcMain.handle("set-opacity", (_event, value) => {
  const opacity = Math.min(1, Math.max(0.65, Number(value) || 0.96));
  if (win) win.setOpacity(opacity);
  return saveSettings({ opacity });
});
ipcMain.handle("hide-window", () => {
  if (win) {
    restoreSmartDock(false);
    win.hide();
  }
  updateTray();
});
ipcMain.handle("open-dashboard", () => shell.openExternal("https://cursor.com/dashboard/spending"));
ipcMain.handle("quit", () => quitApp());

app.on("web-contents-created", (_event, contents) => {
  contents.on("context-menu", () => trayMenu().popup({ window: win }));
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
});

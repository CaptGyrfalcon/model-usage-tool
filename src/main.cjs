const path = require("node:path");
const { Worker } = require("node:worker_threads");
const { app, BrowserWindow, ipcMain, shell, Menu, screen, Tray, nativeImage } = require("electron");
const { loadSettings, saveSettings } = require("./lib.cjs");

const WINDOW_WIDTH = 456;
const WINDOW_HEIGHT = 700;
const COMPACT_HEIGHT = 390;
const ORB_WIDTH = 218;
const ORB_HEIGHT = 252;
const MIN_INTERVAL = 15_000;
const MAX_INTERVAL = 300_000;

let win;
let tray;
let pollTimer;
let activePull;
let isQuitting = false;
let fullscreenRestore = null;
let fullscreenRestoreTimer = null;
let boundsSaveTimer = null;
let dashboardFullscreen = false;
let latest = { ok: false, loading: true, data: null };
let dataWorker = null;
let dataTaskId = 0;
const dataTasks = new Map();

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());
}

function clampInterval(value) {
  return Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, Number(value) || 30_000));
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

function widgetSize(settings) {
  if (settings.orbMode) return { width: ORB_WIDTH, height: ORB_HEIGHT };
  return { width: WINDOW_WIDTH, height: settings.compact ? COMPACT_HEIGHT : WINDOW_HEIGHT };
}

function safeWindowPosition(settings) {
  const displays = screen.getAllDisplays();
  const size = widgetSize(settings);
  const desired = { x: settings.x, y: settings.y, ...size };
  if (Number.isFinite(settings.x) && Number.isFinite(settings.y)) {
    const visible = displays.some((display) => {
      const area = display.workArea;
      return desired.x < area.x + area.width - 80 && desired.x + desired.width > area.x + 80 &&
        desired.y < area.y + area.height - 48 && desired.y + 48 > area.y;
    });
    if (visible) return { x: settings.x, y: settings.y };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - size.width - 20, y: area.y + 20 };
}

function trayImage() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#9DF5D0"/><stop offset="1" stop-color="#7C8CFF"/></linearGradient></defs>
    <rect x="2" y="2" width="28" height="28" rx="8" fill="#171A23"/>
    <path d="M9 22V15h4v7H9zm5.5 0V9h4v13h-4zM20 22v-9h4v9h-4z" fill="url(#g)"/>
  </svg>`;
  const image = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  return image.resize({ width: 20, height: 20 });
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
      label: "始终置顶",
      type: "checkbox",
      checked: settings.alwaysOnTop !== false,
      click: (item) => applySettings({ alwaysOnTop: item.checked }),
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
  tray = new Tray(trayImage());
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
  const size = widgetSize(settings);
  win = new BrowserWindow({
    ...size,
    ...position,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: true,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop !== false,
    hasShadow: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (settings.alwaysOnTop !== false) win.setAlwaysOnTop(true, "floating");
  win.setOpacity(Math.min(1, Math.max(0.65, settings.opacity ?? 0.96)));
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.once("ready-to-show", () => showWindow());
  win.on("moved", persistBounds);
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
    win.hide();
    updateTray();
  });
  win.on("closed", () => {
    if (fullscreenRestoreTimer) clearTimeout(fullscreenRestoreTimer);
    fullscreenRestoreTimer = null;
    win = null;
  });
}

function persistBounds() {
  if (!win || win.isFullScreen()) return;
  if (boundsSaveTimer) clearTimeout(boundsSaveTimer);
  boundsSaveTimer = setTimeout(() => {
    boundsSaveTimer = null;
    if (!win || win.isDestroyed() || win.isFullScreen()) return;
    const [x, y] = win.getPosition();
    saveSettings({ x, y });
  }, 180);
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  updateTray();
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
  updateTray();
}

function quitApp() {
  isQuitting = true;
  app.quit();
}

function applyWindowMode(settings = loadSettings()) {
  if (!win || dashboardFullscreen || win.isFullScreen()) return;
  const size = widgetSize(settings);
  const current = win.getBounds();
  const area = screen.getDisplayMatching(current).workArea;
  const maxX = area.x + Math.max(0, area.width - size.width);
  const maxY = area.y + Math.max(0, area.height - size.height);
  win.setBounds({
    x: Math.min(maxX, Math.max(area.x, current.x)),
    y: Math.min(maxY, Math.max(area.y, current.y)),
    ...size,
  }, true);
}

function windowState() {
  return { fullscreen: dashboardFullscreen };
}

function broadcastWindowState() {
  if (win && !win.webContents.isDestroyed()) win.webContents.send("window-state", windowState());
  updateTray();
}

function restoreWidgetWindow() {
  if (!win || !fullscreenRestore || win.isFullScreen()) return false;
  const settings = loadSettings();
  const size = widgetSize(settings);
  const targetBounds = {
    ...fullscreenRestore.bounds,
    ...size,
  };
  win.setOpacity(Math.min(1, Math.max(0.65, settings.opacity ?? 0.96)));
  if (settings.alwaysOnTop !== false) win.setAlwaysOnTop(true, "floating");
  else win.setAlwaysOnTop(false);
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
    win.setAlwaysOnTop(false);
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
  const next = saveSettings(clean);
  if (win && "alwaysOnTop" in clean && !dashboardFullscreen && !win.isFullScreen()) win.setAlwaysOnTop(Boolean(next.alwaysOnTop), "floating");
  if ("compact" in clean || "orbMode" in clean) applyWindowMode(next);
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
    updateTray();
    return latest;
  })();
  return activePull;
}

function startPoll() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => pull(), clampInterval(loadSettings().intervalMs));
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.cursor.usage-widget");
  createTray();
  createWindow();
  createDataWorker();
  app.setLoginItemSettings({ openAtLogin: Boolean(loadSettings().openAtLogin) });
  startPoll();
  pull();
});

app.on("activate", () => showWindow());
app.on("window-all-closed", () => {
  // The notification-area icon owns the app lifecycle on Windows.
});
app.on("before-quit", () => {
  isQuitting = true;
  clearInterval(pollTimer);
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
ipcMain.handle("toggle-fullscreen", (_event, force) => toggleFullscreen(force));
ipcMain.handle("save-settings", (_event, partial) => applySettings(partial));
ipcMain.handle("set-opacity", (_event, value) => {
  const opacity = Math.min(1, Math.max(0.65, Number(value) || 0.96));
  if (win) win.setOpacity(opacity);
  return saveSettings({ opacity });
});
ipcMain.handle("hide-window", () => {
  if (win) win.hide();
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

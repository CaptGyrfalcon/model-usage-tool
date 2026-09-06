const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("widget", {
  getSnapshot: () => ipcRenderer.invoke("get-snapshot"),
  refresh: () => ipcRenderer.invoke("refresh"),
  refreshPricing: () => ipcRenderer.invoke("refresh-pricing"),
  getSettings: () => ipcRenderer.invoke("get-settings"),
  getWindowState: () => ipcRenderer.invoke("get-window-state"),
  getModelUsage: (range) => ipcRenderer.invoke("get-model-usage", range),
  getQuotaTimeline: (payload) => ipcRenderer.invoke("get-quota-timeline", payload),
  queryUsageEvents: (payload) => ipcRenderer.invoke("query-usage-events", payload),
  getPricingCatalog: (payload) => ipcRenderer.invoke("get-pricing-catalog", payload),
  exportUsageEvents: (payload) => ipcRenderer.invoke("export-usage-events", payload),
  toggleFullscreen: (force) => ipcRenderer.invoke("toggle-fullscreen", force),
  saveSettings: (partial) => ipcRenderer.invoke("save-settings", partial),
  setPointerPresence: (present) => ipcRenderer.invoke("pointer-presence", present),
  setOpacity: (value) => ipcRenderer.invoke("set-opacity", value),
  hide: () => ipcRenderer.invoke("hide-window"),
  openDashboard: () => ipcRenderer.invoke("open-dashboard"),
  quit: () => ipcRenderer.invoke("quit"),
  onSnapshot: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("snapshot", listener);
    return () => ipcRenderer.removeListener("snapshot", listener);
  },
  onSettings: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("settings", listener);
    return () => ipcRenderer.removeListener("settings", listener);
  },
  onWindowState: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("window-state", listener);
    return () => ipcRenderer.removeListener("window-state", listener);
  },
  onWindowMotion: (cb) => {
    const listener = (_event, data) => cb(data);
    ipcRenderer.on("window-motion", listener);
    return () => ipcRenderer.removeListener("window-motion", listener);
  },
});

const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('taskbar', {
  onMeters: callback => ipcRenderer.on('taskbar-meters', (_event, data) => callback(data)),
  open: () => ipcRenderer.send('taskbar-open'),
});

'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pulse', {
  onSnapshot(cb) {
    const handler = (_e, snap) => cb(snap);
    ipcRenderer.on('pulse:snapshot', handler);
    return () => ipcRenderer.removeListener('pulse:snapshot', handler);
  },
  getStatic: () => ipcRenderer.invoke('pulse:getStatic'),
  getLatest: () => ipcRenderer.invoke('pulse:getLatest'),
  getSettings: () => ipcRenderer.invoke('pulse:getSettings'),
  setSettings: (patch) => ipcRenderer.invoke('pulse:setSettings', patch),
  listDays: () => ipcRenderer.invoke('pulse:listDays'),
  loadDay: (day, maxPoints) => ipcRenderer.invoke('pulse:loadDay', day, maxPoints),
  logDir: () => ipcRenderer.invoke('pulse:logDir'),
  win: {
    minimize: () => ipcRenderer.send('win:minimize'),
    maximize: () => ipcRenderer.send('win:maximize'),
    close: () => ipcRenderer.send('win:close'),
  },
});

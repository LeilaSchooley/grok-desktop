const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('grokDesktop', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  setAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-always-on-top', enabled),
  setHardwareAcceleration: (enabled) =>
    ipcRenderer.invoke('set-hardware-acceleration', enabled),
  setCloseToTray: (enabled) => ipcRenderer.invoke('set-close-to-tray', enabled),
  restartApp: () => ipcRenderer.invoke('restart-app'),
  openExternal: (url) => ipcRenderer.send('open-external', url),
  onFocusApp: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('focus-app', handler);
    return () => ipcRenderer.removeListener('focus-app', handler);
  },
  onSettingsUpdated: (callback) => {
    const handler = (_event, settings) => callback(settings);
    ipcRenderer.on('settings-updated', handler);
    return () => ipcRenderer.removeListener('settings-updated', handler);
  },
});

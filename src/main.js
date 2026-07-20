const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  session,
  Tray,
  Menu,
  nativeImage,
  Notification,
} = require('electron');
const path = require('path');
const { readSettings, writeSettings } = require('./settings');

const GROK_URL = process.env.GROK_URL || 'https://grok.com';
const PARTITION = 'persist:grok';
const ICON_PATH = path.join(__dirname, '../assets/icons/512x512.png');

let mainWindow = null;
let tray = null;
let isQuitting = false;
let settings = readSettings();

// Only disable GPU when the user explicitly turns HW accel off in settings
if (!settings.hardwareAcceleration) {
  app.disableHardwareAcceleration();
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    showMainWindow();
  });
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  mainWindow.webContents.send('focus-app');
}

function applyAlwaysOnTop(enabled) {
  settings = writeSettings({ alwaysOnTop: Boolean(enabled) });
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(settings.alwaysOnTop);
  }
  rebuildTrayMenu();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-updated', getPublicSettings());
  }
  return settings.alwaysOnTop;
}

function getPublicSettings() {
  return {
    alwaysOnTop: settings.alwaysOnTop,
    hardwareAcceleration: settings.hardwareAcceleration,
    closeToTray: settings.closeToTray,
    grokUrl: GROK_URL,
    partition: PARTITION,
    needsRestartForHw: false,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 560,
    backgroundColor: '#0a0a0a',
    title: 'Grok',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    alwaysOnTop: settings.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      partition: PARTITION,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting && settings.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function rebuildTrayMenu() {
  if (!tray) return;

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Grok',
      click: () => showMainWindow(),
    },
    { type: 'separator' },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: settings.alwaysOnTop,
      click: (item) => {
        applyAlwaysOnTop(item.checked);
      },
    },
    {
      label: 'Close to Tray',
      type: 'checkbox',
      checked: settings.closeToTray,
      click: (item) => {
        settings = writeSettings({ closeToTray: item.checked });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('settings-updated', getPublicSettings());
        }
      },
    },
    {
      label: 'Hardware Acceleration',
      type: 'checkbox',
      checked: settings.hardwareAcceleration,
      click: (item) => {
        setHardwareAcceleration(item.checked);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function createTray() {
  try {
    const icon = nativeImage.createFromPath(ICON_PATH);
    const trayIcon = icon.isEmpty() ? icon : icon.resize({ width: 32, height: 32 });
    tray = new Tray(trayIcon);
    tray.setToolTip('Grok');
    tray.on('click', () => showMainWindow());
    tray.on('double-click', () => showMainWindow());
    rebuildTrayMenu();
  } catch (error) {
    console.warn('Tray unavailable:', error.message);
    tray = null;
  }
}

function setHardwareAcceleration(enabled) {
  const next = Boolean(enabled);
  const changed = next !== settings.hardwareAcceleration;
  settings = writeSettings({ hardwareAcceleration: next });
  rebuildTrayMenu();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-updated', {
      ...getPublicSettings(),
      needsRestartForHw: changed,
    });
  }

  if (changed && Notification.isSupported()) {
    new Notification({
      title: 'Grok',
      body: 'Hardware acceleration setting saved. Restart the app to apply.',
      icon: ICON_PATH,
    }).show();
  }

  return { applied: settings.hardwareAcceleration, needsRestart: changed };
}

function restartApp() {
  isQuitting = true;
  app.relaunch();
  app.exit(0);
}

app.whenReady().then(() => {
  session.fromPartition(PARTITION);
  createWindow();
  createTray();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    isQuitting = true;
    app.quit();
  }
});

ipcMain.handle('get-config', () => getPublicSettings());

ipcMain.handle('set-always-on-top', (_event, enabled) => applyAlwaysOnTop(enabled));

ipcMain.handle('set-hardware-acceleration', (_event, enabled) =>
  setHardwareAcceleration(enabled)
);

ipcMain.handle('set-close-to-tray', (_event, enabled) => {
  settings = writeSettings({ closeToTray: Boolean(enabled) });
  rebuildTrayMenu();
  return settings.closeToTray;
});

ipcMain.handle('restart-app', () => {
  restartApp();
});

ipcMain.on('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    shell.openExternal(url);
  }
});

const {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  session,
  screen,
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
    guestPreload: path.join(__dirname, 'guest-preload.js'),
    session: settings.session,
    needsRestartForHw: false,
  };
}

function isGrokUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/i.test(parsed.protocol)) return false;
    const host = parsed.hostname.toLowerCase();
    return host === 'grok.com' || host.endsWith('.grok.com') || host === 'x.ai' || host.endsWith('.x.ai');
  } catch {
    return false;
  }
}

function sendShortcut(name) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('shortcut', name);
  }
}

function bindShortcuts(contents) {
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    if (!ctrl || input.alt) return;

    const { code } = input;
    const map = {
      KeyT: input.shift ? 'reopen-tab' : 'new-tab',
      KeyW: 'close-tab',
      KeyR: 'reload',
      KeyP: input.shift ? 'always-on-top' : null,
      Tab: input.shift ? 'prev-tab' : 'next-tab',
      Equal: 'zoom-in',
      NumpadAdd: 'zoom-in',
      Minus: 'zoom-out',
      NumpadSubtract: 'zoom-out',
      Digit0: 'zoom-reset',
      Numpad0: 'zoom-reset',
    };

    let name = map[code] || null;
    if (!name && /^Digit[1-9]$/.test(code)) name = `tab-${code.slice(-1)}`;
    if (!name) return;
    if (input.isAutoRepeat && (name === 'new-tab' || name === 'close-tab' || name === 'reopen-tab')) {
      return;
    }

    event.preventDefault();
    sendShortcut(name);
  });
}

function windowOptionsFromSettings() {
  const opts = {
    width: 1280,
    height: 860,
    minWidth: 800,
    minHeight: 560,
  };
  const saved = settings.windowBounds;
  if (!saved || !Number.isFinite(saved.width) || !Number.isFinite(saved.height)) return opts;

  const display = screen.getDisplayMatching({
    x: Number.isFinite(saved.x) ? saved.x : 0,
    y: Number.isFinite(saved.y) ? saved.y : 0,
    width: saved.width,
    height: saved.height,
  });
  const area = display.workArea;
  opts.width = Math.min(Math.max(saved.width, 800), area.width);
  opts.height = Math.min(Math.max(saved.height, 560), area.height);
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    opts.x = Math.min(Math.max(saved.x, area.x), area.x + area.width - 120);
    opts.y = Math.min(Math.max(saved.y, area.y), area.y + area.height - 80);
  }
  return opts;
}

let boundsTimer = null;
function persistWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const isMaximized = mainWindow.isMaximized();
  const bounds = isMaximized ? mainWindow.getNormalBounds() : mainWindow.getBounds();
  settings = writeSettings({
    windowBounds: { ...bounds, isMaximized },
  });
}

function schedulePersistBounds() {
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(persistWindowBounds, 400);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    ...windowOptionsFromSettings(),
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

  if (settings.windowBounds?.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer/index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\/([^/]*\.)?(grok\.com|x\.ai)(\/|$)/i.test(url)) {
      mainWindow.webContents.send('open-in-tab', url);
    } else {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  mainWindow.on('close', (event) => {
    persistWindowBounds();
    if (!isQuitting && settings.closeToTray && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('resize', schedulePersistBounds);
  mainWindow.on('move', schedulePersistBounds);

  mainWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-focused');
    }
  });

  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window-focused');
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

  // Force every Grok webview guest to open links/tabs inside our chrome
  app.on('web-contents-created', (_event, contents) => {
    bindShortcuts(contents);

    if (contents.getType() !== 'webview') return;

    contents.setWindowOpenHandler(({ url }) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('open-in-tab', url);
      }
      return { action: 'deny' };
    });
  });

  createWindow();
  createTray();

  app.on('activate', () => {
    showMainWindow();
  });
});

app.on('before-quit', () => {
  isQuitting = true;
  persistWindowBounds();
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

ipcMain.on('save-session', (_event, sessionState) => {
  const tabs = Array.isArray(sessionState?.tabs)
    ? sessionState.tabs
        .filter((tab) => tab && isGrokUrl(tab.url))
        .slice(0, 24)
        .map((tab) => ({
          url: tab.url,
          pinned: Boolean(tab.pinned),
          title: typeof tab.title === 'string' ? tab.title.slice(0, 80) : 'Grok',
        }))
    : [];
  const zoom = Number(sessionState?.zoom);
  settings = writeSettings({
    session: {
      tabs,
      activeIndex: Math.max(0, Number(sessionState?.activeIndex) || 0),
      zoom: Number.isFinite(zoom) ? Math.min(1.5, Math.max(0.8, zoom)) : 1,
    },
  });
});

ipcMain.handle('restart-app', () => {
  restartApp();
});

ipcMain.on('open-external', (_event, url) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    shell.openExternal(url);
  }
});

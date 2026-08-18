const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  alwaysOnTop: false,
  hardwareAcceleration: true,
  closeToTray: true,
  windowBounds: null,
  session: {
    tabs: [],
    activeIndex: 0,
    zoom: 1,
  },
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      ...DEFAULTS,
      ...parsed,
      session: { ...DEFAULTS.session, ...(parsed.session || {}) },
    };
  } catch {
    return {
      ...DEFAULTS,
      session: { ...DEFAULTS.session },
    };
  }
}

function writeSettings(partial) {
  const current = readSettings();
  const next = {
    ...current,
    ...partial,
    session: partial.session
      ? { ...DEFAULTS.session, ...current.session, ...partial.session }
      : current.session,
  };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULTS, readSettings, writeSettings, settingsPath };

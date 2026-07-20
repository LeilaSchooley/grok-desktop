const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  alwaysOnTop: false,
  hardwareAcceleration: true,
  closeToTray: true,
};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULTS };
  }
}

function writeSettings(partial) {
  const next = { ...readSettings(), ...partial };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

module.exports = { DEFAULTS, readSettings, writeSettings };

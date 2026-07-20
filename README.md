# Grok Desktop

Unofficial Electron wrapper for [Grok](https://grok.com) on **Linux** and **Windows**, with multi-tab support, shared login session, system tray, and native installers.

## Features

- Multiple tabs (each tab loads Grok)
- Shared session — sign in once, all tabs stay logged in
- System tray icon (show / quit / toggles)
- Always on top (toolbar pin, settings, tray, or `Ctrl+Shift+P`)
- Close to tray (optional)
- Hardware acceleration toggle (persisted; restart to apply — helps with freezing)
- Keyboard shortcuts:
  - `Ctrl+T` — new tab
  - `Ctrl+W` — close tab
  - `Ctrl+Tab` / `Ctrl+Shift+Tab` — cycle tabs
  - `Ctrl+1`…`Ctrl+9` — jump to tab
  - `Ctrl+R` — reload active tab
  - `Ctrl+Shift+P` — toggle always on top
- External links open in your system browser
- Single-instance (reopening focuses the existing window)

## Install

### Ubuntu / Debian

Download the latest `.deb` from [Releases](https://github.com/LeilaSchooley/grok-desktop/releases), then:

```bash
sudo dpkg -i Grok-*-linux-*.deb
sudo apt-get install -f   # only if dependencies are missing
```

Or use the AppImage (no install):

```bash
chmod +x Grok-*-linux-*.AppImage
./Grok-*-linux-*.AppImage
```

### Windows

Download the latest `.exe` from [Releases](https://github.com/LeilaSchooley/grok-desktop/releases):

- **NSIS installer** — full install with Start Menu / desktop shortcuts
- **Portable** — run without installing

## Develop locally

```bash
npm install
npm start
```

Optional host override:

```bash
GROK_URL=https://grok.x.ai npm start
```

Settings are stored in the Electron userData folder as `settings.json`.

## Build packages

```bash
npm run dist:linux   # .deb + AppImage
npm run dist:deb     # .deb only
npm run dist:win     # Windows NSIS + portable (best on Windows CI)
```

Pushing a `v*` tag (for example `v1.0.0`) runs GitHub Actions and publishes Linux + Windows assets to a GitHub Release.

## Project layout

```
src/
  main.js              # Electron main process (tray, window, IPC)
  preload.js           # Secure bridge
  settings.js          # Persisted app preferences
  renderer/
    index.html         # Chrome / tab bar / settings menu
    renderer.js        # Tab management + webviews
    styles.css
assets/icons/          # App icons
.github/workflows/     # Release builds
```

## License

MIT

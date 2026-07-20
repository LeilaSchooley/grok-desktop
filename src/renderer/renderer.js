(() => {
  const tabsEl = document.getElementById('tabs');
  const viewsEl = document.getElementById('views');
  const newTabBtn = document.getElementById('new-tab');
  const reloadBtn = document.getElementById('reload-tab');
  const pinBtn = document.getElementById('pin-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const settingsMenu = document.getElementById('settings-menu');
  const alwaysOnTopInput = document.getElementById('setting-always-on-top');
  const closeToTrayInput = document.getElementById('setting-close-to-tray');
  const hwAccelInput = document.getElementById('setting-hw-accel');
  const restartBtn = document.getElementById('restart-btn');
  const toastEl = document.getElementById('toast');
  const loadingOverlay = document.getElementById('loading-overlay');

  /** @type {{ id: number, title: string, url: string, webview: Electron.WebviewTag, button: HTMLButtonElement }[]} */
  const tabs = [];
  let activeId = null;
  let nextId = 1;
  let grokUrl = 'https://grok.com';
  let partition = 'persist:grok';
  let toastTimer = null;

  const uiState = {
    alwaysOnTop: false,
    hardwareAcceleration: true,
    closeToTray: true,
  };

  function setLoading(visible) {
    if (!loadingOverlay) return;
    loadingOverlay.hidden = !visible;
  }

  function showToast(message) {
    toastEl.textContent = message;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.hidden = true;
    }, 4200);
  }

  function syncSettingsUi(settings) {
    uiState.alwaysOnTop = Boolean(settings.alwaysOnTop);
    uiState.hardwareAcceleration = Boolean(settings.hardwareAcceleration);
    uiState.closeToTray = Boolean(settings.closeToTray);

    alwaysOnTopInput.checked = uiState.alwaysOnTop;
    closeToTrayInput.checked = uiState.closeToTray;
    hwAccelInput.checked = uiState.hardwareAcceleration;

    pinBtn.classList.toggle('active', uiState.alwaysOnTop);
    pinBtn.setAttribute('aria-pressed', String(uiState.alwaysOnTop));

    if (settings.needsRestartForHw) {
      restartBtn.hidden = false;
      showToast('Hardware acceleration changed — restart to apply.');
    }
  }

  function setSettingsOpen(open) {
    settingsMenu.hidden = !open;
    settingsBtn.setAttribute('aria-expanded', String(open));
    settingsBtn.classList.toggle('active', open);
  }

  function truncateTitle(title) {
    const clean = (title || 'Grok').replace(/\s+/g, ' ').trim();
    return clean.length > 40 ? `${clean.slice(0, 37)}…` : clean;
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeId) || null;
  }

  function setActive(id) {
    activeId = id;
    for (const tab of tabs) {
      const isActive = tab.id === id;
      tab.button.classList.toggle('active', isActive);
      tab.button.setAttribute('aria-selected', String(isActive));
      tab.webview.classList.toggle('active', isActive);
    }
    const active = getActiveTab();
    if (active) document.title = active.title || 'Grok';
  }

  function closeTab(id) {
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    const [tab] = tabs.splice(index, 1);
    tab.button.remove();
    tab.webview.remove();

    if (tabs.length === 0) {
      createTab();
      return;
    }

    if (activeId === id) {
      const next = tabs[Math.min(index, tabs.length - 1)];
      setActive(next.id);
    }
  }

  function cycleTab(direction) {
    if (tabs.length < 2) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    setActive(tabs[nextIndex].id);
  }

  function isGrokUrl(url) {
    return /^https?:\/\/([^/]*\.)?(grok\.com|x\.ai)(\/|$)/i.test(url) || url.startsWith(grokUrl);
  }

  function handleOpenUrl(url) {
    if (!url) return;
    if (isGrokUrl(url)) createTab(url);
    else window.grokDesktop.openExternal(url);
  }

  function attachWebviewEvents(tab) {
    const { webview, button } = tab;

    webview.addEventListener('page-title-updated', (event) => {
      tab.title = truncateTitle(event.title);
      button.querySelector('.tab-title').textContent = tab.title;
      if (tab.id === activeId) document.title = tab.title;
    });

    webview.addEventListener('did-navigate', (event) => {
      tab.url = event.url;
    });

    webview.addEventListener('did-navigate-in-page', (event) => {
      tab.url = event.url;
    });

    webview.addEventListener('did-stop-loading', () => {
      if (tab.id === activeId) setLoading(false);
    });

    webview.addEventListener('did-fail-load', () => {
      if (tab.id === activeId) setLoading(false);
    });

    webview.addEventListener('did-start-loading', () => {
      if (tab.id === activeId) setLoading(true);
    });

    webview.addEventListener('new-window', (event) => {
      event.preventDefault();
      handleOpenUrl(event.url);
    });

    webview.addEventListener('dom-ready', () => {
      try {
        webview.setWindowOpenHandler(({ url }) => {
          handleOpenUrl(url);
          return { action: 'deny' };
        });
      } catch {
        // Older Electron builds may not expose this on webview
      }
    });
  }

  function createTab(url = grokUrl, { activate = true } = {}) {
    const id = nextId++;
    const title = 'Grok';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tab';
    button.setAttribute('role', 'tab');
    button.dataset.tabId = String(id);
    button.innerHTML = `
      <span class="tab-title">${title}</span>
      <span class="tab-close" title="Close tab" aria-label="Close tab">×</span>
    `;

    button.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.classList.contains('tab-close')) {
        event.stopPropagation();
        closeTab(id);
        return;
      }
      setActive(id);
    });

    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        closeTab(id);
      }
    });

    const webview = document.createElement('webview');
    webview.src = url;
    webview.partition = partition;
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('webpreferences', 'contextIsolation=yes, nativeWindowOpen=yes');

    const tab = { id, title, url, webview, button };
    tabs.push(tab);
    tabsEl.appendChild(button);
    viewsEl.appendChild(webview);
    attachWebviewEvents(tab);

    if (activate) {
      setActive(id);
      setLoading(true);
    }
    button.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    return tab;
  }

  function reloadActive() {
    const active = getActiveTab();
    if (active) active.webview.reload();
  }

  async function toggleAlwaysOnTop() {
    const next = !uiState.alwaysOnTop;
    const enabled = await window.grokDesktop.setAlwaysOnTop(next);
    syncSettingsUi({ ...uiState, alwaysOnTop: enabled });
  }

  function onKeyDown(event) {
    const ctrl = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (ctrl && event.shiftKey && key === 'p') {
      event.preventDefault();
      toggleAlwaysOnTop();
      return;
    }

    if (!ctrl) return;

    if (key === 't') {
      event.preventDefault();
      createTab();
      return;
    }

    if (key === 'w') {
      event.preventDefault();
      if (activeId != null) closeTab(activeId);
      return;
    }

    if (key === 'r') {
      event.preventDefault();
      reloadActive();
      return;
    }

    if (key === 'tab') {
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
      return;
    }

    if (event.key >= '1' && event.key <= '9') {
      const index = Number(event.key) - 1;
      if (tabs[index]) {
        event.preventDefault();
        setActive(tabs[index].id);
      }
    }
  }

  async function init() {
    try {
      const config = await window.grokDesktop.getConfig();
      grokUrl = config.grokUrl || grokUrl;
      partition = config.partition || partition;
      syncSettingsUi(config);
    } catch {
      // Fall back to defaults
    }

    newTabBtn.addEventListener('click', () => createTab());
    reloadBtn.addEventListener('click', reloadActive);
    pinBtn.addEventListener('click', () => {
      toggleAlwaysOnTop();
    });

    settingsBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      setSettingsOpen(settingsMenu.hidden);
    });

    document.addEventListener('click', (event) => {
      if (!settingsMenu.hidden && !settingsMenu.contains(event.target) && event.target !== settingsBtn) {
        setSettingsOpen(false);
      }
    });

    alwaysOnTopInput.addEventListener('change', async () => {
      const enabled = await window.grokDesktop.setAlwaysOnTop(alwaysOnTopInput.checked);
      syncSettingsUi({ ...uiState, alwaysOnTop: enabled });
    });

    closeToTrayInput.addEventListener('change', async () => {
      const enabled = await window.grokDesktop.setCloseToTray(closeToTrayInput.checked);
      syncSettingsUi({ ...uiState, closeToTray: enabled });
    });

    hwAccelInput.addEventListener('change', async () => {
      const result = await window.grokDesktop.setHardwareAcceleration(hwAccelInput.checked);
      syncSettingsUi({
        ...uiState,
        hardwareAcceleration: result.applied,
        needsRestartForHw: result.needsRestart,
      });
    });

    restartBtn.addEventListener('click', () => {
      window.grokDesktop.restartApp();
    });

    window.addEventListener('keydown', onKeyDown);
    window.grokDesktop.onSettingsUpdated((settings) => syncSettingsUi(settings));
    window.grokDesktop.onFocusApp(() => {});

    createTab(grokUrl);
  }

  init();
})();

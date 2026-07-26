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
  const tabContextMenu = document.getElementById('tab-context-menu');

  /** @type {{ id: number, title: string, url: string, pinned: boolean, webview: Electron.WebviewTag, button: HTMLButtonElement }[]} */
  const tabs = [];
  let activeId = null;
  let nextId = 1;
  let grokUrl = 'https://grok.com';
  let partition = 'persist:grok';
  let toastTimer = null;
  let contextTabId = null;

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

  function hideTabContextMenu() {
    tabContextMenu.hidden = true;
    contextTabId = null;
  }

  function showTabContextMenu(tabId, clientX, clientY) {
    const tab = tabs.find((t) => t.id === tabId);
    if (!tab) return;

    contextTabId = tabId;
    const index = tabs.findIndex((t) => t.id === tabId);
    const hasLeftUnpinned = tabs.slice(0, index).some((t) => !t.pinned);
    const hasRight = tabs.slice(index + 1).some((t) => !t.pinned);
    const hasOthers = tabs.some((t) => t.id !== tabId && !t.pinned);
    const hasUnpinned = tabs.some((t) => !t.pinned);

    tabContextMenu.querySelector('[data-action="pin"]').textContent = tab.pinned
      ? 'Unpin tab'
      : 'Pin tab';
    tabContextMenu.querySelector('[data-action="close-others"]').disabled = !hasOthers;
    tabContextMenu.querySelector('[data-action="close-left"]').disabled = !hasLeftUnpinned;
    tabContextMenu.querySelector('[data-action="close-right"]').disabled = !hasRight;
    tabContextMenu.querySelector('[data-action="close-all"]').disabled = !hasUnpinned;

    tabContextMenu.hidden = false;
    const menuWidth = tabContextMenu.offsetWidth;
    const menuHeight = tabContextMenu.offsetHeight;
    const x = Math.min(clientX, window.innerWidth - menuWidth - 8);
    const y = Math.min(clientY, window.innerHeight - menuHeight - 8);
    tabContextMenu.style.left = `${Math.max(8, x)}px`;
    tabContextMenu.style.top = `${Math.max(8, y)}px`;
  }

  function truncateTitle(title) {
    const clean = (title || 'Grok').replace(/\s+/g, ' ').trim();
    return clean.length > 40 ? `${clean.slice(0, 37)}…` : clean;
  }

  function pinnedLabel(title) {
    const clean = (title || 'G').replace(/\s+/g, ' ').trim();
    const letter = clean.charAt(0).toUpperCase() || 'G';
    return letter;
  }

  function updateTabButton(tab) {
    const titleEl = tab.button.querySelector('.tab-title');
    tab.button.classList.toggle('pinned', tab.pinned);
    tab.button.title = tab.title || 'Grok';
    if (tab.pinned) {
      titleEl.textContent = pinnedLabel(tab.title);
      titleEl.classList.add('pinned-label');
    } else {
      titleEl.textContent = tab.title || 'Grok';
      titleEl.classList.remove('pinned-label');
    }
  }

  function reorderPinnedTabs() {
    const pinned = tabs.filter((t) => t.pinned);
    const unpinned = tabs.filter((t) => !t.pinned);
    tabs.length = 0;
    tabs.push(...pinned, ...unpinned);
    for (const tab of tabs) {
      tabsEl.appendChild(tab.button);
    }
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

  function closeTab(id, { force = false } = {}) {
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    const tab = tabs[index];
    if (tab.pinned && !force) {
      // Pinned tabs require unpin first (or force from explicit close in menu)
      return;
    }

    tabs.splice(index, 1);
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

  function togglePinTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    tab.pinned = !tab.pinned;
    updateTabButton(tab);
    reorderPinnedTabs();
  }

  function closeOtherTabs(id) {
    const toClose = tabs.filter((t) => t.id !== id && !t.pinned).map((t) => t.id);
    for (const closeId of toClose) closeTab(closeId, { force: true });
  }

  function closeTabsToLeft(id) {
    const index = tabs.findIndex((t) => t.id === id);
    if (index <= 0) return;
    const toClose = tabs.slice(0, index).filter((t) => !t.pinned).map((t) => t.id);
    for (const closeId of toClose) closeTab(closeId, { force: true });
  }

  function closeTabsToRight(id) {
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1 || index >= tabs.length - 1) return;
    const toClose = tabs.slice(index + 1).filter((t) => !t.pinned).map((t) => t.id);
    for (const closeId of toClose) closeTab(closeId, { force: true });
  }

  function closeAllTabs() {
    const toClose = tabs.filter((t) => !t.pinned).map((t) => t.id);
    for (const closeId of toClose) closeTab(closeId, { force: true });
    if (tabs.length === 0) createTab();
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
      updateTabButton(tab);
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

    button.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      setSettingsOpen(false);
      showTabContextMenu(tab.id, event.clientX, event.clientY);
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
    button.title = title;
    button.innerHTML = `
      <span class="tab-pin-icon" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="11" height="11">
          <path fill="currentColor" d="M9.7 1.8a1 1 0 0 0-1.4 0L6.2 3.9 4.3 3.2a.75.75 0 0 0-.9.3L2.3 5.4a.75.75 0 0 0 .2 1l2.1 1.5-.8 3.2a.75.75 0 0 0 1.1.8l2.8-1.7 2.1 1.5a.75.75 0 0 0 1-.2l1.1-1.8a.75.75 0 0 0-.3-.9l-1.9-.9 2.1-2.1a1 1 0 0 0 0-1.4L9.7 1.8z"/>
        </svg>
      </span>
      <span class="tab-title">${title}</span>
      <span class="tab-close" title="Close tab" aria-label="Close tab">×</span>
    `;

    button.addEventListener('click', (event) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest('.tab-close')) {
        event.stopPropagation();
        closeTab(id, { force: true });
        return;
      }
      setActive(id);
    });

    button.addEventListener('dblclick', (event) => {
      event.preventDefault();
      togglePinTab(id);
    });

    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) {
        event.preventDefault();
        const tab = tabs.find((t) => t.id === id);
        if (tab?.pinned) return;
        closeTab(id, { force: true });
      }
    });

    const webview = document.createElement('webview');
    webview.src = url;
    webview.partition = partition;
    webview.setAttribute('allowpopups', '');
    webview.setAttribute('webpreferences', 'contextIsolation=yes, nativeWindowOpen=yes');

    const tab = { id, title, url, pinned: false, webview, button };
    const insertAt = tabs.findIndex((t) => !t.pinned);
    if (insertAt === -1) {
      tabs.push(tab);
      tabsEl.appendChild(button);
    } else {
      const beforeBtn = tabs[insertAt].button;
      tabs.splice(insertAt, 0, tab);
      tabsEl.insertBefore(button, beforeBtn);
    }
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

    if (key === 'escape') {
      hideTabContextMenu();
      return;
    }

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
      if (activeId != null) {
        const active = getActiveTab();
        if (active?.pinned) return;
        closeTab(activeId, { force: true });
      }
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

  function onContextAction(action) {
    const id = contextTabId;
    hideTabContextMenu();
    if (id == null) return;

    switch (action) {
      case 'pin':
        togglePinTab(id);
        break;
      case 'close':
        closeTab(id, { force: true });
        break;
      case 'close-others':
        closeOtherTabs(id);
        break;
      case 'close-left':
        closeTabsToLeft(id);
        break;
      case 'close-right':
        closeTabsToRight(id);
        break;
      case 'close-all':
        closeAllTabs();
        break;
      default:
        break;
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
      hideTabContextMenu();
      setSettingsOpen(settingsMenu.hidden);
    });

    tabContextMenu.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-action]');
      if (!(btn instanceof HTMLElement)) return;
      if (btn.disabled) return;
      onContextAction(btn.dataset.action);
    });

    document.addEventListener('click', (event) => {
      if (!settingsMenu.hidden && !settingsMenu.contains(event.target) && event.target !== settingsBtn) {
        setSettingsOpen(false);
      }
      if (!tabContextMenu.hidden && !tabContextMenu.contains(event.target)) {
        hideTabContextMenu();
      }
    });

    window.addEventListener('blur', hideTabContextMenu);

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

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

  /** @type {{ id: number, title: string, url: string, pinned: boolean, loading: boolean, unread: boolean, webview: Electron.WebviewTag, button: HTMLButtonElement }[]} */
  const tabs = [];
  /** @type {{ url: string, pinned: boolean, title: string }[]} */
  const closedTabs = [];
  let activeId = null;
  let nextId = 1;
  let grokUrl = 'https://grok.com';
  let partition = 'persist:grok';
  let guestPreload = '';
  let toastTimer = null;
  let contextTabId = null;
  let zoomFactor = 1;
  let saveTimer = null;

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

  function syncTabOrder() {
    for (const tab of tabs) {
      tabsEl.appendChild(tab.button);
    }
    scheduleSaveSession();
  }

  function reorderPinnedTabs() {
    const pinned = tabs.filter((t) => t.pinned);
    const unpinned = tabs.filter((t) => !t.pinned);
    tabs.length = 0;
    tabs.push(...pinned, ...unpinned);
    syncTabOrder();
  }

  function moveTabToIndex(id, toIndex) {
    const from = tabs.findIndex((t) => t.id === id);
    if (from === -1 || toIndex === from || toIndex < 0 || toIndex >= tabs.length) return;
    const tab = tabs[from];
    const pinnedCount = tabs.filter((t) => t.pinned).length;
    const min = tab.pinned ? 0 : pinnedCount;
    const max = tab.pinned ? pinnedCount - 1 : tabs.length - 1;
    const clamped = Math.max(min, Math.min(max, toIndex));
    if (clamped === from) return;
    tabs.splice(from, 1);
    tabs.splice(clamped, 0, tab);
    syncTabOrder();
  }

  function dropIndexFromPoint(clientX, draggingId) {
    const dragging = tabs.find((t) => t.id === draggingId);
    if (!dragging) return -1;
    const group = tabs.filter((t) => t.pinned === dragging.pinned);
    let groupIndex = group.length - 1;
    for (let i = 0; i < group.length; i += 1) {
      const rect = group[i].button.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        groupIndex = i;
        break;
      }
    }
    return dragging.pinned ? groupIndex : tabs.filter((t) => t.pinned).length + groupIndex;
  }

  function attachTabDrag(button, id) {
    const THRESHOLD = 6;
    let pointerId = null;
    let startX = 0;
    let dragging = false;
    let didDrag = false;

    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target instanceof HTMLElement && event.target.closest('.tab-close')) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      dragging = false;
      didDrag = false;
      button.setPointerCapture(event.pointerId);
    });

    button.addEventListener('pointermove', (event) => {
      if (event.pointerId !== pointerId) return;
      if (!dragging && Math.abs(event.clientX - startX) < THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        didDrag = true;
        button.classList.add('dragging');
        hideTabContextMenu();
      }
      moveTabToIndex(id, dropIndexFromPoint(event.clientX, id));
    });

    const endDrag = (event) => {
      if (event.pointerId !== pointerId) return;
      if (dragging) button.classList.remove('dragging');
      dragging = false;
      pointerId = null;
      try {
        button.releasePointerCapture(event.pointerId);
      } catch {
        // already released
      }
    };

    button.addEventListener('pointerup', endDrag);
    button.addEventListener('pointercancel', endDrag);

    button.addEventListener(
      'click',
      (event) => {
        if (!didDrag) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        didDrag = false;
      },
      true
    );
  }

  function getActiveTab() {
    return tabs.find((t) => t.id === activeId) || null;
  }

  function snapshotSession() {
    return {
      tabs: tabs.map((t) => ({ url: t.url, pinned: t.pinned, title: t.title })),
      activeIndex: Math.max(0, tabs.findIndex((t) => t.id === activeId)),
      zoom: zoomFactor,
    };
  }

  function flushSession() {
    clearTimeout(saveTimer);
    window.grokDesktop.saveSession(snapshotSession());
  }

  function scheduleSaveSession() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSession, 280);
  }

  function conversationId(url) {
    try {
      const match = new URL(url, grokUrl).pathname.match(/\/c\/([0-9a-f-]{36})/i);
      return match ? match[1] : null;
    } catch {
      return null;
    }
  }

  function findExistingTab(url) {
    const id = conversationId(url);
    if (!id) return null;
    return tabs.find((t) => conversationId(t.url) === id) || null;
  }

  function bumpTab(tab) {
    tab.button.classList.remove('bump');
    void tab.button.offsetWidth;
    tab.button.classList.add('bump');
    tab.button.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }

  function applyZoom(tab) {
    try {
      tab.webview.setZoomFactor(zoomFactor);
    } catch {
      // webview may not be ready
    }
  }

  function setZoom(next) {
    zoomFactor = Math.round(Math.min(1.5, Math.max(0.8, next)) * 10) / 10;
    for (const tab of tabs) applyZoom(tab);
    showToast(`${Math.round(zoomFactor * 100)}%`);
    scheduleSaveSession();
  }

  function setTabLoading(tab, loading) {
    tab.loading = loading;
    tab.button.classList.toggle('loading', loading);
    if (tab.id === activeId) setLoading(loading);
  }

  function insertTab(tab, { insert = 'end', afterId = null } = {}) {
    if (insert === 'restore') {
      tabs.push(tab);
      tabsEl.appendChild(tab.button);
      return;
    }

    if (afterId != null) {
      const idx = tabs.findIndex((t) => t.id === afterId);
      const pinnedCount = tabs.filter((t) => t.pinned).length;
      let at = idx === -1 ? tabs.length : idx + 1;
      if (!tab.pinned && at < pinnedCount) at = pinnedCount;
      if (tab.pinned && at > pinnedCount) at = pinnedCount;
      tabs.splice(at, 0, tab);
    } else if (tab.pinned) {
      tabs.splice(tabs.filter((t) => t.pinned).length, 0, tab);
    } else {
      tabs.push(tab);
    }
    syncTabOrder();
  }

  function setActive(id) {
    activeId = id;
    for (const tab of tabs) {
      const isActive = tab.id === id;
      tab.button.classList.toggle('active', isActive);
      tab.button.setAttribute('aria-selected', String(isActive));
      tab.webview.classList.toggle('active', isActive);
      if (isActive) {
        tab.unread = false;
        tab.button.classList.remove('unread');
      }
    }
    const active = getActiveTab();
    if (active) {
      document.title = active.title || 'Grok';
      setLoading(Boolean(active.loading));
      active.button.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
    scheduleFocusComposer();
    scheduleSaveSession();
  }

  function closeTab(id, { force = false } = {}) {
    const index = tabs.findIndex((t) => t.id === id);
    if (index === -1) return;

    const tab = tabs[index];
    if (tab.pinned && !force) {
      // Pinned tabs require unpin first (or force from explicit close in menu)
      return;
    }

    closedTabs.push({ url: tab.url, pinned: false, title: tab.title });
    if (closedTabs.length > 20) closedTabs.shift();

    tabs.splice(index, 1);
    tab.button.remove();
    tab.webview.remove();
    scheduleSaveSession();

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

  function reopenClosedTab() {
    const item = closedTabs.pop();
    if (!item) return;
    const tab = createTab(item.url, { activate: true, insert: 'end' });
    if (item.title) {
      tab.title = item.title;
      updateTabButton(tab);
    }
  }

  function duplicateTab(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab) return;
    createTab(tab.url, { activate: true, afterId: id });
  }

  async function copyTabLink(id) {
    const tab = tabs.find((t) => t.id === id);
    if (!tab?.url) return;
    try {
      await navigator.clipboard.writeText(tab.url);
      showToast('Link copied');
    } catch {
      showToast('Could not copy link');
    }
  }
  function cycleTab(direction) {
    if (tabs.length < 2) return;
    const index = tabs.findIndex((t) => t.id === activeId);
    const nextIndex = (index + direction + tabs.length) % tabs.length;
    setActive(tabs[nextIndex].id);
  }

  function isGrokUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url, grokUrl);
      if (!/^https?:$/i.test(parsed.protocol)) return false;
      const host = parsed.hostname.toLowerCase();
      return (
        host === 'grok.com' ||
        host.endsWith('.grok.com') ||
        host === 'x.ai' ||
        host.endsWith('.x.ai') ||
        url.startsWith(grokUrl)
      );
    } catch {
      return false;
    }
  }

  function handleOpenUrl(url, { activate = true } = {}) {
    if (!url) return;
    let absolute = url;
    try {
      absolute = new URL(url, grokUrl).href;
    } catch {
      return;
    }

    if (!isGrokUrl(absolute)) {
      window.grokDesktop.openExternal(absolute);
      return;
    }

    const existing = findExistingTab(absolute);
    if (existing) {
      bumpTab(existing);
      if (activate) setActive(existing.id);
      return;
    }

    createTab(absolute, { activate, afterId: activeId });
  }

  function parseOpenInTabPayload(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') return { url: payload, activate: true };
    if (typeof payload === 'object' && payload.url) {
      return { url: payload.url, activate: payload.activate !== false };
    }
    return null;
  }

  function attachWebviewEvents(tab) {
    const { webview, button } = tab;

    webview.addEventListener('page-title-updated', (event) => {
      tab.title = truncateTitle(event.title);
      updateTabButton(tab);
      if (tab.id === activeId) document.title = tab.title;
      else {
        tab.unread = true;
        tab.button.classList.add('unread');
      }
      scheduleSaveSession();
    });

    webview.addEventListener('did-navigate', (event) => {
      tab.url = event.url;
      scheduleSaveSession();
    });

    webview.addEventListener('did-navigate-in-page', (event) => {
      tab.url = event.url;
      scheduleSaveSession();
    });

    webview.addEventListener('did-stop-loading', () => setTabLoading(tab, false));
    webview.addEventListener('did-fail-load', () => setTabLoading(tab, false));
    webview.addEventListener('did-start-loading', () => setTabLoading(tab, true));

    webview.addEventListener('new-window', (event) => {
      event.preventDefault();
      handleOpenUrl(event.url);
    });

    webview.addEventListener('ipc-message', (event) => {
      if (event.channel !== 'open-in-tab') return;
      const parsed = parseOpenInTabPayload(event.args?.[0]);
      if (parsed) handleOpenUrl(parsed.url, { activate: parsed.activate });
    });

    webview.addEventListener('dom-ready', () => {
      applyZoom(tab);
      try {
        webview.setWindowOpenHandler(({ url, disposition }) => {
          handleOpenUrl(url, { activate: disposition !== 'background-tab' });
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

  function createTab(url = grokUrl, { activate = true, pinned = false, title = 'Grok', insert = 'end', afterId = null } = {}) {
    const id = nextId++;

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
      <span class="tab-title">Grok</span>
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

    attachTabDrag(button, id);

    const webview = document.createElement('webview');
    webview.src = url;
    webview.partition = partition;
    webview.setAttribute('allowpopups', '');
    webview.setAttribute(
      'webpreferences',
      'contextIsolation=yes, nativeWindowOpen=yes, nodeIntegration=no, sandbox=no'
    );
    if (guestPreload) {
      webview.setAttribute('preload', guestPreload);
    }
    const tab = { id, title, url, pinned, loading: true, unread: false, webview, button };
    insertTab(tab, { insert, afterId });
    viewsEl.appendChild(webview);
    attachWebviewEvents(tab);
    updateTabButton(tab);
    setTabLoading(tab, true);

    if (activate) {
      setActive(id);
    }
    button.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    scheduleSaveSession();
    return tab;
  }

  function reloadActive() {
    const active = getActiveTab();
    if (active) active.webview.reload();
  }

  function focusChatComposer() {
    const active = getActiveTab();
    if (!active?.webview) return;

    // Skip if our chrome currently has focus (tab bar / settings)
    const ae = document.activeElement;
    if (ae && (ae === document.body ? false : chromeContains(ae))) return;

    const script = `(() => {
      const selectors = [
        '.tiptap.ProseMirror[contenteditable="true"]',
        '.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"][role="textbox"]',
        'div[role="textbox"][contenteditable="true"]',
        'textarea[aria-label*="Ask" i]',
        'textarea[placeholder*="Ask" i]',
        'textarea[placeholder*="Grok" i]',
        'textarea[data-testid*="input"]',
        '[contenteditable="true"]',
        'textarea',
      ];

      const isVisible = (el) => {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 20 && rect.height > 12;
      };

      let target = null;
      for (const sel of selectors) {
        const nodes = Array.from(document.querySelectorAll(sel)).filter(isVisible);
        if (!nodes.length) continue;
        // Prefer the bottom-most composer (chat box lives near bottom)
        target = nodes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
        break;
      }
      if (!target) return false;

      const active = document.activeElement;
      if (active === target || (active && target.contains(active))) return true;

      target.focus({ preventScroll: true });
      try {
        if (typeof target.click === 'function') target.click();
      } catch {}
      return true;
    })()`;

    try {
      active.webview.executeJavaScript(script, true).catch(() => {});
    } catch {
      // webview may not be ready yet
    }
  }

  function chromeContains(el) {
    const chrome = document.getElementById('chrome');
    const menu = document.getElementById('tab-context-menu');
    const settings = document.getElementById('settings-menu');
    return Boolean(
      (chrome && chrome.contains(el)) ||
        (menu && menu.contains(el)) ||
        (settings && settings.contains(el))
    );
  }

  function scheduleFocusComposer() {
    // Slight delay so window focus settles before we steal into the webview
    setTimeout(focusChatComposer, 60);
    setTimeout(focusChatComposer, 220);
  }

  async function toggleAlwaysOnTop() {
    const next = !uiState.alwaysOnTop;
    const enabled = await window.grokDesktop.setAlwaysOnTop(next);
    syncSettingsUi({ ...uiState, alwaysOnTop: enabled });
  }

  function onShortcut(name) {
    switch (name) {
      case 'new-tab':
        createTab();
        break;
      case 'reopen-tab':
        reopenClosedTab();
        break;
      case 'close-tab': {
        const active = getActiveTab();
        if (active && !active.pinned) closeTab(active.id, { force: true });
        break;
      }
      case 'reload':
        reloadActive();
        break;
      case 'next-tab':
        cycleTab(1);
        break;
      case 'prev-tab':
        cycleTab(-1);
        break;
      case 'always-on-top':
        toggleAlwaysOnTop();
        break;
      case 'zoom-in':
        setZoom(zoomFactor + 0.1);
        break;
      case 'zoom-out':
        setZoom(zoomFactor - 0.1);
        break;
      case 'zoom-reset':
        setZoom(1);
        break;
      default:
        if (name.startsWith('tab-')) {
          const index = Number(name.slice(4)) - 1;
          if (tabs[index]) setActive(tabs[index].id);
        }
        break;
    }
  }

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      hideTabContextMenu();
      setSettingsOpen(false);
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
      case 'duplicate':
        duplicateTab(id);
        break;
      case 'copy-link':
        copyTabLink(id);
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
    let savedSession = { tabs: [], activeIndex: 0, zoom: 1 };
    try {
      const config = await window.grokDesktop.getConfig();
      grokUrl = config.grokUrl || grokUrl;
      partition = config.partition || partition;
      guestPreload = config.guestPreload || '';
      savedSession = config.session || savedSession;
      const zoom = Number(savedSession.zoom);
      if (Number.isFinite(zoom)) zoomFactor = Math.min(1.5, Math.max(0.8, zoom));
      syncSettingsUi(config);
    } catch {
      // Fall back to defaults
    }

    newTabBtn.addEventListener('click', () => createTab());
    reloadBtn.addEventListener('click', reloadActive);
    pinBtn.addEventListener('click', () => {
      toggleAlwaysOnTop();
    });

    tabsEl.addEventListener(
      'wheel',
      (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        event.preventDefault();
        tabsEl.scrollLeft += event.deltaY;
      },
      { passive: false }
    );

    tabsEl.addEventListener('dblclick', (event) => {
      if (event.target === tabsEl) createTab();
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
    window.grokDesktop.onFocusApp(() => scheduleFocusComposer());
    window.grokDesktop.onWindowFocused(() => scheduleFocusComposer());
    window.grokDesktop.onOpenInTab((url) => handleOpenUrl(url));
    window.grokDesktop.onShortcut(onShortcut);

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') scheduleFocusComposer();
      else flushSession();
    });
    window.addEventListener('pagehide', flushSession);

    const restored = Array.isArray(savedSession.tabs)
      ? savedSession.tabs.filter((item) => item && isGrokUrl(item.url))
      : [];
    if (restored.length) {
      for (const item of restored) {
        const tab = createTab(item.url, {
          activate: false,
          pinned: Boolean(item.pinned),
          title: item.title || 'Grok',
          insert: 'restore',
        });
        if (item.title) {
          tab.title = truncateTitle(item.title);
          updateTabButton(tab);
        }
      }
      const idx = Math.min(Math.max(0, Number(savedSession.activeIndex) || 0), tabs.length - 1);
      setActive(tabs[idx].id);
    } else {
      createTab(grokUrl);
    }
  }

  init();
})();

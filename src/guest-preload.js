const { ipcRenderer } = require('electron');

function resolveHref(href) {
  if (!href || href.startsWith('javascript:') || href === '#') return null;
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return null;
  }
}

function openInTab(href, activate = true) {
  const url = resolveHref(href);
  if (!url) return;
  ipcRenderer.sendToHost('open-in-tab', { url, activate });
}

function linkFromEvent(event) {
  return event.target instanceof Element ? event.target.closest('a[href]') : null;
}

let ignoreNextAuxClick = false;

document.addEventListener(
  'click',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return;
    const anchor = linkFromEvent(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    openInTab(anchor.getAttribute('href'), true);
  },
  true
);

document.addEventListener(
  'auxclick',
  (event) => {
    if (event.button !== 1) return;
    const anchor = linkFromEvent(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    if (ignoreNextAuxClick) {
      ignoreNextAuxClick = false;
      return;
    }
    openInTab(anchor.getAttribute('href'), false);
  },
  true
);

document.addEventListener(
  'mousedown',
  (event) => {
    if (event.button !== 1) return;
    const anchor = linkFromEvent(event);
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    ignoreNextAuxClick = true;
    openInTab(anchor.getAttribute('href'), false);
  },
  true
);

// --- Sidebar ranges: finer buckets + collapse --------------------------------

const NATIVE_RANGE =
  /^(Pinned|Today|Yesterday|Earlier|Previous 7 Days|Previous 30 Days|(January|February|March|April|May|June|July|August|September|October|November|December)(\s+\d{4})?)$/i;

const STORAGE_KEY = 'grokDesktop.collapsedRanges';
const STYLE_ID = 'grok-desktop-range-collapse-style';
const HEADER_ATTR = 'data-grok-desktop-range';
const SYNTH_ATTR = 'data-grok-desktop-synth';
const COLLAPSED_CLASS = 'grok-desktop-range-collapsed';
const HEADER_CLASS =
  'flex items-center gap-2 pt-3 pb-1 px-3 opacity-80 mx-1 grok-desktop-range-header';

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function loadCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'));
  } catch {
    return new Set();
  }
}

function saveCollapsed(set) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...set]));
  } catch {
    // ignore
  }
}

let collapsedRanges = loadCollapsed();
let applying = false;
/** @type {Map<string, { date: Date, starred: boolean }>} */
let conversationMeta = new Map();
let timesLoadedAt = 0;
let timesPromise = null;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    [${HEADER_ATTR}] {
      cursor: pointer !important;
      user-select: none !important;
    }
    [${HEADER_ATTR}] .grok-desktop-range-chevron {
      display: inline-block;
      width: 0;
      height: 0;
      margin-right: 6px;
      border-top: 4px solid transparent;
      border-bottom: 4px solid transparent;
      border-left: 5px solid currentColor;
      opacity: 0.55;
      transform: rotate(90deg);
      transition: transform 0.12s ease;
      flex: 0 0 auto;
    }
    [${HEADER_ATTR}][aria-expanded="false"] .grok-desktop-range-chevron {
      transform: rotate(0deg);
    }
    .${COLLAPSED_CLASS} {
      display: none !important;
    }
    [${SYNTH_ATTR}] span.grok-desktop-range-label {
      font-size: 11px;
      opacity: 0.85;
    }
    [${SYNTH_ATTR}] .grok-desktop-range-line {
      height: 1px;
      flex: 1;
      background: currentColor;
      opacity: 0.15;
    }
  `;
  document.documentElement.appendChild(style);
}

function normalizeLabel(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

function isRangeLabel(text) {
  return NATIVE_RANGE.test(normalizeLabel(text));
}

function headerLabel(el) {
  if (!(el instanceof Element)) return '';
  if (el.querySelector('a[href^="/c/"]')) return '';
  const text = normalizeLabel(el.textContent);
  if (!text || text.length > 40) return '';
  if (!isRangeLabel(text)) return '';
  return text;
}

function findHistoryList() {
  const lists = [...document.querySelectorAll('ul')].filter((ul) =>
    ul.querySelector('a[href^="/c/"]')
  );
  lists.sort(
    (a, b) =>
      b.querySelectorAll('a[href^="/c/"]').length - a.querySelectorAll('a[href^="/c/"]').length
  );
  return lists[0] || null;
}

function conversationIdFromHref(href) {
  const m = String(href || '').match(/\/c\/([0-9a-f-]{36})/i);
  return m ? m[1] : null;
}

async function loadConversationMeta(force = false) {
  if (!force && conversationMeta.size && Date.now() - timesLoadedAt < 60_000) {
    return conversationMeta;
  }
  if (timesPromise) return timesPromise;

  timesPromise = (async () => {
    const map = new Map();
    let pageToken = null;
    for (let page = 0; page < 15; page += 1) {
      const url = pageToken
        ? `/rest/app-chat/conversations?pageToken=${encodeURIComponent(pageToken)}`
        : '/rest/app-chat/conversations';
      const res = await fetch(url, { credentials: 'include' });
      if (!res.ok) break;
      const data = await res.json();
      for (const c of data.conversations || []) {
        const id = c.conversationId || c.id;
        if (!id) continue;
        const raw = c.modifyTime || c.createTime || c.updatedAt || c.createdAt;
        const dt = raw ? new Date(raw) : null;
        map.set(id, {
          date: dt && !Number.isNaN(dt.getTime()) ? dt : null,
          starred: Boolean(c.starred),
        });
      }
      pageToken = data.nextPageToken || null;
      if (!pageToken) break;
    }
    conversationMeta = map;
    timesLoadedAt = Date.now();
    return map;
  })().finally(() => {
    timesPromise = null;
  });

  return timesPromise;
}

function metaDate(meta, id) {
  return id && meta.get(id) ? meta.get(id).date : null;
}

function metaStarred(meta, id) {
  return Boolean(id && meta.get(id)?.starred);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function bucketForDate(date, now = new Date()) {
  if (!date) return 'Earlier';
  const today = startOfDay(now);
  const that = startOfDay(date);
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((today - that) / dayMs);

  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return 'Previous 7 Days';
  if (diffDays < 30) return 'Previous 30 Days';
  return `${MONTHS[that.getMonth()]} ${that.getFullYear()}`;
}

function bucketSortKey(label) {
  if (label === 'Pinned') return -1;
  if (label === 'Today') return 0;
  if (label === 'Yesterday') return 1;
  if (label === 'Previous 7 Days') return 2;
  if (label === 'Previous 30 Days') return 3;
  const m = label.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$/
  );
  if (m) {
    const idx = MONTHS.indexOf(m[1]);
    const year = Number(m[2]);
    return 1000 - (year * 12 + idx);
  }
  return 9999;
}

function createRangeHeader(label) {
  const row = document.createElement('div');
  row.className = HEADER_CLASS;
  row.setAttribute(HEADER_ATTR, label);
  row.setAttribute(SYNTH_ATTR, '1');
  row.setAttribute('role', 'button');
  row.setAttribute('tabindex', '0');
  row.setAttribute('aria-expanded', 'true');

  const chevron = document.createElement('span');
  chevron.className = 'grok-desktop-range-chevron';
  chevron.setAttribute('aria-hidden', 'true');

  const text = document.createElement('span');
  text.className = 'grok-desktop-range-label text-[11px] text-tertiary select-none shrink-0';
  text.textContent = label;

  const line = document.createElement('div');
  line.className = 'grok-desktop-range-line h-px bg-border-l1 flex-1';

  row.append(chevron, text, line);
  return row;
}

function ensureChevron(headerEl) {
  if (headerEl.querySelector(':scope > .grok-desktop-range-chevron')) return;
  const chevron = document.createElement('span');
  chevron.className = 'grok-desktop-range-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  headerEl.insertBefore(chevron, headerEl.firstChild);
}

function itemsForHeader(headerEl, headerEls) {
  const headerSet = new Set(headerEls);
  const items = [];
  let sibling = headerEl.nextElementSibling;
  while (sibling) {
    if (headerSet.has(sibling) || headerLabel(sibling)) break;
    items.push(sibling);
    sibling = sibling.nextElementSibling;
  }
  return items;
}

function applyCollapsed(headerEl, label, items) {
  const collapsed = collapsedRanges.has(label);
  headerEl.setAttribute(HEADER_ATTR, label);
  headerEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  headerEl.setAttribute('role', 'button');
  headerEl.setAttribute('tabindex', '0');
  ensureChevron(headerEl);
  for (const item of items) item.classList.toggle(COLLAPSED_CLASS, collapsed);
}

function bindHeader(headerEl, label, list) {
  if (headerEl.dataset.grokDesktopBound === '1') return;
  headerEl.dataset.grokDesktopBound = '1';
  headerEl.addEventListener(
    'click',
    (event) => {
      if (event.target.closest('a, button, input')) return;
      event.preventDefault();
      event.stopPropagation();
      if (collapsedRanges.has(label)) collapsedRanges.delete(label);
      else collapsedRanges.add(label);
      saveCollapsed(collapsedRanges);
      const headers = [...list.querySelectorAll(`[${HEADER_ATTR}]`)];
      applyCollapsed(headerEl, label, itemsForHeader(headerEl, headers));
    },
    true
  );
  headerEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    headerEl.click();
  });
}

/**
 * Move starred/pinned chats into their own section above dated History.
 */
function separatePinnedSection(list, meta) {
  const chatItems = [...list.querySelectorAll(':scope > li')].filter((li) =>
    li.querySelector('a[href^="/c/"]')
  );

  const pinned = [];
  for (const li of chatItems) {
    const id = conversationIdFromHref(li.querySelector('a[href^="/c/"]')?.getAttribute('href'));
    if (metaStarred(meta, id)) pinned.push(li);
  }

  // Drop previous synthetic Pinned header (items are re-collected above)
  for (const old of list.querySelectorAll(`[${HEADER_ATTR}="Pinned"][${SYNTH_ATTR}]`)) {
    old.remove();
  }

  if (!pinned.length) return false;

  pinned.sort((a, b) => {
    const idA = conversationIdFromHref(a.querySelector('a[href^="/c/"]')?.getAttribute('href'));
    const idB = conversationIdFromHref(b.querySelector('a[href^="/c/"]')?.getAttribute('href'));
    const tA = metaDate(meta, idA)?.getTime() || 0;
    const tB = metaDate(meta, idB)?.getTime() || 0;
    return tB - tA;
  });

  const frag = document.createDocumentFragment();
  frag.appendChild(createRangeHeader('Pinned'));
  for (const li of pinned) frag.appendChild(li);
  list.insertBefore(frag, list.firstChild);
  return true;
}

/**
 * Split Grok's coarse "Earlier" bucket into week/month groups using API times.
 * Leave Today / Yesterday blocks in place. Skip pinned/starred chats.
 */
function refineEarlierSection(list, meta) {
  const children = [...list.children];
  let earlierHeader = null;
  let earlierIndex = -1;
  for (let i = 0; i < children.length; i += 1) {
    const label = headerLabel(children[i]) || children[i].getAttribute(HEADER_ATTR);
    if (label === 'Earlier') {
      earlierHeader = children[i];
      earlierIndex = i;
      break;
    }
  }
  if (!earlierHeader) return false;

  const sectionNodes = [];
  for (let i = earlierIndex + 1; i < children.length; i += 1) {
    const child = children[i];
    const label = headerLabel(child) || child.getAttribute(HEADER_ATTR);
    if (label && label !== 'Earlier') break;
    sectionNodes.push(child);
  }

  const chatItems = sectionNodes.filter((el) => {
    const a = el.querySelector?.('a[href^="/c/"]');
    if (!a) return false;
    const id = conversationIdFromHref(a.getAttribute('href'));
    return !metaStarred(meta, id);
  });
  const afterSection = children[earlierIndex + sectionNodes.length + 1] || null;

  earlierHeader.remove();
  for (const node of sectionNodes) {
    if (
      node.hasAttribute?.(SYNTH_ATTR) ||
      (headerLabel(node) || node.getAttribute(HEADER_ATTR)) === 'Earlier'
    ) {
      node.remove();
    }
  }

  if (!chatItems.length) return true;

  /** @type {Map<string, Element[]>} */
  const groups = new Map();
  for (const item of chatItems) {
    const href = item.querySelector('a[href^="/c/"]')?.getAttribute('href');
    const id = conversationIdFromHref(href);
    const when = metaDate(meta, id);
    let bucket = bucketForDate(when);
    if (bucket === 'Today' || bucket === 'Yesterday') bucket = 'Previous 7 Days';
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(item);
  }

  for (const [, items] of groups) {
    items.sort((a, b) => {
      const idA = conversationIdFromHref(a.querySelector('a[href^="/c/"]')?.getAttribute('href'));
      const idB = conversationIdFromHref(b.querySelector('a[href^="/c/"]')?.getAttribute('href'));
      const tA = metaDate(meta, idA)?.getTime() || 0;
      const tB = metaDate(meta, idB)?.getTime() || 0;
      return tB - tA;
    });
  }

  const ordered = [...groups.keys()].sort((a, b) => bucketSortKey(a) - bucketSortKey(b));
  const frag = document.createDocumentFragment();
  for (const label of ordered) {
    const items = groups.get(label) || [];
    if (!items.length) continue;
    frag.appendChild(createRangeHeader(label));
    for (const item of items) frag.appendChild(item);
  }

  if (afterSection && afterSection.isConnected && afterSection.parentNode === list) {
    list.insertBefore(frag, afterSection);
  } else {
    list.appendChild(frag);
  }
  return true;
}

function enhanceNativeHeaders(list) {
  const headers = [];
  for (const el of list.children) {
    let row = el;
    const label = headerLabel(el);
    if (!label) continue;
    // promote inner span → row
    if (el.tagName === 'SPAN' && el.parentElement && headerLabel(el.parentElement) === label) {
      row = el.parentElement;
    }
    if (row.querySelector('a[href^="/c/"]')) continue;
    headers.push({ el: row, label: normalizeLabel(label) });
  }

  // outermost only
  const filtered = headers.filter(
    ({ el }) => !headers.some((other) => other.el !== el && other.el.contains(el))
  );

  for (const { el, label } of filtered) {
    // Skip coarse Earlier once refined (it should already be gone)
    if (label === 'Earlier') continue;
    bindHeader(el, label, list);
    const headerEls = filtered.map((h) => h.el);
    applyCollapsed(el, label, itemsForHeader(el, headerEls));
  }

  // Also bind synthetic headers
  for (const el of list.querySelectorAll(`[${SYNTH_ATTR}]`)) {
    const label = el.getAttribute(HEADER_ATTR);
    if (!label) continue;
    bindHeader(el, label, list);
    const headerEls = [...list.querySelectorAll(`[${HEADER_ATTR}]`)];
    applyCollapsed(el, label, itemsForHeader(el, headerEls));
  }
}

function isGrokHost() {
  return (
    /(^|\.)grok\.com$/i.test(location.hostname) || /(^|\.)x\.ai$/i.test(location.hostname)
  );
}

async function enhanceRanges() {
  if (applying) return;
  if (!isGrokHost()) return;

  ensureStyles();
  const list = findHistoryList();
  if (!list) return;

  applying = true;
  try {
    const meta = await loadConversationMeta();
    separatePinnedSection(list, meta);
    refineEarlierSection(list, meta);
    enhanceNativeHeaders(list);
  } catch (err) {
    console.warn('[grok-desktop] range enhance failed', err);
    try {
      enhanceNativeHeaders(list);
    } catch {
      // ignore
    }
  } finally {
    applying = false;
  }
}

// --- Follow-up suggestions: "All n" in the current chat ----------------------

const USE_ALL_ATTR = 'data-grok-desktop-use-all';
const FOLLOWUP_STYLE_ID = 'grok-desktop-followup-style';
const FOLLOWUP_ICON_SEL =
  'svg.lucide-corner-down-right, svg[class*="corner-down-right"]';
const CHROME_LABEL =
  /^(think harder|think hard|think|deepsearch|deep search|quick response|quick answer|close|copy|share|retry|edit|regenerate|stop|send|voice|imagine|attach|search|new chat)$/i;
const SEND_PATH = /M6 11L12 5|M12 5V19|m5 12 7-7 7 7/i;

let applyingFollowups = false;
let sendingFollowups = false;

function ensureFollowupStyles() {
  if (document.getElementById(FOLLOWUP_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = FOLLOWUP_STYLE_ID;
  style.textContent = `
    [${USE_ALL_ATTR}] {
      appearance: none;
      background: transparent;
      border: 0;
      box-shadow: none;
      margin: 1px 0 2px;
      padding: 1px 0 1px 22px;
      font: inherit;
      font-size: 11px;
      line-height: 1.3;
      letter-spacing: 0.01em;
      color: currentColor;
      opacity: 0.42;
      cursor: pointer;
      user-select: none;
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      width: auto;
      max-width: 100%;
    }
    [${USE_ALL_ATTR}]:hover,
    [${USE_ALL_ATTR}]:focus-visible {
      opacity: 0.78;
      outline: none;
    }
  `;
  document.documentElement.appendChild(style);
}

function isVisibleEl(el) {
  if (!(el instanceof Element)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 8 && rect.height > 8;
}

function isIgnoredFollowupRegion(el) {
  if (el.closest(`.query-bar, nav, aside, [data-sidebar], [${USE_ALL_ATTR}]`)) return true;
  const typeahead = el.closest('ul');
  return Boolean(typeahead && typeahead.querySelector('.typeahead-mask'));
}

function isSuggestionButton(btn) {
  if (!(btn instanceof HTMLElement)) return false;
  if (btn.hasAttribute(USE_ALL_ATTR)) return false;
  const aria = (btn.getAttribute('aria-label') || '').trim();
  if (/^close$/i.test(aria)) return false;
  const text = normalizeLabel(btn.textContent);
  if (!text || text.length < 6 || text.length > 280) return false;
  if (CHROME_LABEL.test(text)) return false;
  return true;
}

function suggestionButtonsIn(container) {
  const direct = [...container.querySelectorAll(':scope > button, :scope > [role="button"]')].filter(
    isSuggestionButton
  );
  if (direct.length >= 2) return direct;
  return [...container.querySelectorAll('button, [role="button"]')].filter(
    (btn) => btn.querySelector(FOLLOWUP_ICON_SEL) && isSuggestionButton(btn)
  );
}

function isFollowupContainer(el) {
  if (!(el instanceof HTMLElement)) return false;
  const cls = typeof el.className === 'string' ? el.className : '';
  return (
    cls.includes('flex-col') &&
    cls.includes('gap-1') &&
    cls.includes('mt-2') &&
    cls.includes('items-start')
  );
}

function findFollowupClusters() {
  const seen = new Set();
  const clusters = [];

  const consider = (container) => {
    if (!container || seen.has(container)) return;
    if (isIgnoredFollowupRegion(container)) return;
    if (!isVisibleEl(container)) return;
    const buttons = suggestionButtonsIn(container);
    if (buttons.length < 2) return;
    seen.add(container);
    clusters.push({ container, buttons });
  };

  for (const icon of document.querySelectorAll(FOLLOWUP_ICON_SEL)) {
    const btn = icon.closest('button, [role="button"]');
    if (!btn) continue;
    consider(btn.closest('div.flex.flex-col.gap-1') || btn.parentElement);
  }

  for (const el of document.querySelectorAll('div.flex.flex-col.gap-1')) {
    if (isFollowupContainer(el)) consider(el);
  }

  return clusters;
}

function buildCombinedFollowup(texts) {
  const lines = texts.map((t, i) => `${i + 1}. ${t}`);
  return `Please do all of the following follow-ups:\n\n${lines.join('\n')}`;
}

function findComposer() {
  const selectors = [
    '.query-bar .tiptap.ProseMirror[contenteditable="true"]',
    '.query-bar .ProseMirror[contenteditable="true"]',
    '.query-bar [contenteditable="true"]',
    '.tiptap.ProseMirror[contenteditable="true"]',
    '.ProseMirror[contenteditable="true"]',
    '[contenteditable="true"][role="textbox"]',
    'div[role="textbox"][contenteditable="true"]',
    'textarea[aria-label*="Ask" i]',
    'textarea[placeholder*="Ask" i]',
    'textarea[placeholder*="Grok" i]',
  ];
  for (const sel of selectors) {
    const nodes = [...document.querySelectorAll(sel)].filter(isVisibleEl);
    if (!nodes.length) continue;
    return nodes.sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)[0];
  }
  return null;
}

function selectElementContents(el) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  sel.removeAllRanges();
  sel.addRange(range);
}

function fillComposer(el, text) {
  el.focus({ preventScroll: true });
  try {
    el.click();
  } catch {
    // ignore
  }

  if (el.isContentEditable) {
    selectElementContents(el);
    if (document.execCommand('insertText', false, text)) {
      const got = normalizeLabel(el.innerText || '');
      if (got.includes(normalizeLabel(text).slice(0, 24))) return true;
    }
    selectElementContents(el);
    document.execCommand('delete');
    if (document.execCommand('insertText', false, text)) return true;
    el.textContent = text;
    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: text,
      })
    );
    return true;
  }

  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function findSendButton(composer) {
  const roots = [
    composer.closest('.query-bar'),
    composer.closest('form'),
    composer.parentElement,
  ].filter(Boolean);

  const fromRoot = (root) => {
    const labeled = [...root.querySelectorAll('button')].find((btn) => {
      const label = (btn.getAttribute('aria-label') || btn.getAttribute('title') || '').toLowerCase();
      return label === 'send' || label === 'submit';
    });
    if (labeled) return labeled;
    const byTestId = root.querySelector('button[data-testid="send-button"]');
    if (byTestId) return byTestId;
    const byType = root.querySelector('button[type="submit"]');
    if (byType) return byType;
    return [...root.querySelectorAll('button')].find((btn) => {
      if (btn.disabled) return false;
      if (btn.querySelector('svg.lucide-arrow-up, svg[class*="arrow-up"]')) return true;
      return [...btn.querySelectorAll('svg path')].some((p) => SEND_PATH.test(p.getAttribute('d') || ''));
    });
  };

  for (const root of roots) {
    const btn = fromRoot(root);
    if (btn && isVisibleEl(btn)) return btn;
  }
  return (
    document.querySelector('button[aria-label="Send"]') ||
    document.querySelector('button[data-testid="send-button"]')
  );
}

function sendButtonReady(btn) {
  if (!btn) return false;
  if (btn.disabled) return false;
  if (btn.getAttribute('aria-disabled') === 'true') return false;
  if (btn.getAttribute('data-disabled') === 'true') return false;
  return true;
}

function clickSendSoon(composer) {
  let sent = false;
  const tryClick = () => {
    if (sent) return;
    const btn = findSendButton(composer);
    if (!sendButtonReady(btn)) return;
    sent = true;
    btn.click();
  };
  tryClick();
  if (!sent) {
    setTimeout(tryClick, 80);
    setTimeout(tryClick, 220);
  }
}

function sendAllSuggestions(container) {
  if (sendingFollowups) return;
  const texts = suggestionButtonsIn(container)
    .map((btn) => normalizeLabel(btn.textContent))
    .filter(Boolean);
  if (texts.length < 2) return;

  const composer = findComposer();
  if (!composer) {
    console.warn('[grok-desktop] composer not found for follow-ups');
    return;
  }

  sendingFollowups = true;
  fillComposer(composer, buildCombinedFollowup(texts));
  clickSendSoon(composer);
  setTimeout(() => {
    sendingFollowups = false;
  }, 1600);
}

function useAllLabel(count) {
  return `All ${count}`;
}

function bindUseAllButton(btn) {
  if (btn.dataset.grokDesktopBound === '1') return;
  btn.dataset.grokDesktopBound = '1';
  const run = (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    const container = btn.previousElementSibling;
    if (container) sendAllSuggestions(container);
  };
  btn.addEventListener('click', run, true);
  btn.addEventListener('auxclick', run, true);
  btn.addEventListener(
    'mousedown',
    (event) => {
      if (event.button === 1 || event.ctrlKey || event.metaKey) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true
  );
}

function createUseAllButton(count) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute(USE_ALL_ATTR, '1');
  btn.textContent = useAllLabel(count);
  btn.title = 'Send all suggestions in this chat';
  btn.setAttribute('aria-label', `Send all ${count} suggestions in this chat`);
  bindUseAllButton(btn);
  return btn;
}

function pruneOrphanUseAllButtons(liveContainers) {
  for (const btn of document.querySelectorAll(`[${USE_ALL_ATTR}]`)) {
    const prev = btn.previousElementSibling;
    if (!prev || !liveContainers.has(prev)) btn.remove();
  }
}

function enhanceFollowups() {
  if (applyingFollowups) return;
  if (!isGrokHost()) return;

  applyingFollowups = true;
  try {
    ensureFollowupStyles();
    const clusters = findFollowupClusters();
    const live = new Set(clusters.map((c) => c.container));
    pruneOrphanUseAllButtons(live);

    for (const { container, buttons } of clusters) {
      const count = buttons.length;
      const existing = container.nextElementSibling;
      if (existing && existing.hasAttribute?.(USE_ALL_ATTR)) {
        existing.textContent = useAllLabel(count);
        existing.setAttribute('aria-label', `Send all ${count} suggestions in this chat`);
        bindUseAllButton(existing);
        continue;
      }
      container.insertAdjacentElement('afterend', createUseAllButton(count));
    }
  } catch (err) {
    console.warn('[grok-desktop] follow-up enhance failed', err);
  } finally {
    applyingFollowups = false;
  }
}

let enhanceTimer = null;
function scheduleEnhance() {
  clearTimeout(enhanceTimer);
  enhanceTimer = setTimeout(() => {
    enhanceRanges();
    enhanceFollowups();
  }, 180);
}

function boot() {
  scheduleEnhance();
  const observer = new MutationObserver(scheduleEnhance);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  // Refresh times occasionally
  setInterval(() => {
    timesLoadedAt = 0;
    scheduleEnhance();
  }, 5 * 60 * 1000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

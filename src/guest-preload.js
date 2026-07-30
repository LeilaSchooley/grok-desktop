const { ipcRenderer } = require('electron');

function resolveHref(href) {
  if (!href || href.startsWith('javascript:') || href === '#') return null;
  try {
    return new URL(href, window.location.href).href;
  } catch {
    return null;
  }
}

function openInTab(href) {
  const url = resolveHref(href);
  if (!url) return;
  ipcRenderer.sendToHost('open-in-tab', url);
}

document.addEventListener(
  'click',
  (event) => {
    if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    openInTab(anchor.getAttribute('href'));
  },
  true
);

document.addEventListener(
  'auxclick',
  (event) => {
    if (event.button !== 1) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    openInTab(anchor.getAttribute('href'));
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

async function enhanceRanges() {
  if (applying) return;
  if (!/(^|\.)grok\.com$/i.test(location.hostname) && !/(^|\.)x\.ai$/i.test(location.hostname)) {
    return;
  }

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

let enhanceTimer = null;
function scheduleEnhance() {
  if (applying) return;
  clearTimeout(enhanceTimer);
  enhanceTimer = setTimeout(() => {
    enhanceRanges();
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

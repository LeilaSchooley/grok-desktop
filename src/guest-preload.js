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

// Middle-click / ctrl|cmd-click on links → top tab bar
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

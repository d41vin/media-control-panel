// Popup UI. Exists only while open — when it closes, every listener, timer and
// node here is destroyed by the browser. Detection needs no permissions:
// audible/mutedInfo come free with tabs.query, titles come from host
// permissions, and control is on-demand executeScript (lib/page.js).

import { pageProbe, pageToggle } from './lib/page.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const pauseAllBtn = document.getElementById('pause-all');
const muteAllBtn = document.getElementById('mute-all');
const targetEl = document.getElementById('target-readout');
const hintsEl = document.getElementById('hints');

// --- icons (our own static strings — safe for innerHTML) ---------------------

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 7.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  speakerX: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6m0-6l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name];
  return span.firstChild;
}

// --- state --------------------------------------------------------------------

/** tabId -> { tab, probe, expanded, playing, nodes } */
const rows = new Map();
let pinnedTabId = null;

// --- small helpers --------------------------------------------------------------

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(s) {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const t = Math.floor(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// --- record shape -----------------------------------------------------------------
//
// probe = { frames: [{ frameId, docTitle, pip, elements: [...] }],
//           primaryFrameId, elementCount }
// Primary element across the tab: first playing element in the primary frame;
// primary frame: first frame holding a playing element, else first with any.

function primaryOfProbe(probe) {
  for (const f of probe.frames) {
    const playing = f.elements.find((e) => e.playing);
    if (playing) return { frameId: f.frameId, element: playing };
  }
  const f = probe.frames[0];
  return f ? { frameId: f.frameId, element: f.elements[0] } : null;
}

// --- rows ----------------------------------------------------------------------------

function makeRow(tab) {
  const li = el('li', 'row');
  const main = el('div', 'row-main');
  const idx = el('span', 'idx');
  const fav = el('img', 'fav');
  fav.alt = '';
  fav.hidden = true;
  const stack = el('div', 't-stack');
  const title = el('div', 't-title');
  const site = el('div', 't-site');
  stack.append(title, site);
  const controls = el('div', 'row-controls');

  const eq = el('span', 'eq');
  eq.append(el('i'), el('i'), el('i'));
  eq.hidden = true;

  const playBtn = el('button', 'icon-btn play');
  playBtn.type = 'button';
  playBtn.title = 'Play / pause';

  const muteBtn = el('button', 'icon-btn secondary mute');
  muteBtn.type = 'button';
  muteBtn.title = 'Mute / unmute tab';

  controls.append(eq, playBtn, muteBtn);
  main.append(idx, fav, stack, controls);
  li.append(main);

  playBtn.addEventListener('click', () => void togglePlay(rows.get(tab.id)));
  muteBtn.addEventListener('click', () => void muteTab(rows.get(tab.id)));

  listEl.append(li);
  const rec = {
    tab,
    probe: null,
    expanded: false,
    playing: !!tab.audible,
    nodes: { li, idx, fav, title, site, eq, playBtn, muteBtn },
    ping: null,
    dragging: false,
  };
  rows.set(tab.id, rec);
  updateRow(rec);
  return rec;
}

function removeRow(tabId) {
  const rec = rows.get(tabId);
  if (!rec) return;
  stopPing(rec);
  rec.nodes.li.remove();
  rows.delete(tabId);
  if (pinnedTabId === tabId) {
    pinnedTabId = null;
    void chrome.storage.session.remove('target').catch(() => {});
    updateTargetReadout();
  }
  refreshChrome();
  void reorder();
}

function updateRow(rec) {
  const { tab, nodes } = rec;
  const host = hostOf(tab.url);
  const probe = rec.probe ? primaryOfProbe(rec.probe) : null;

  rec.playing = !!tab.audible || !!(probe && probe.element.playing);

  // title: the media title when it differs from the tab title (song names),
  // otherwise the tab title
  const mediaTitle = probe?.element.title;
  const titleText =
    (mediaTitle && mediaTitle !== tab.title ? mediaTitle : tab.title) || host || 'Untitled';
  nodes.title.textContent = titleText;

  const extra = rec.probe && rec.probe.elementCount > 1 ? ` · ×${rec.probe.elementCount}` : '';
  nodes.site.textContent = (host || 'system page') + extra;

  nodes.playBtn.replaceChildren(icon(rec.playing ? 'pause' : 'play'));
  nodes.playBtn.setAttribute('aria-label', rec.playing ? 'Pause' : 'Play');
  nodes.muteBtn.replaceChildren(icon(tab.mutedInfo?.muted ? 'speakerX' : 'speaker'));
  nodes.muteBtn.setAttribute('aria-label', tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab');
  nodes.eq.hidden = !rec.playing;

  nodes.li.classList.toggle('paused', !rec.playing);
  nodes.li.classList.toggle('target', tab.id === pinnedTabId);

  // favicon: real one when http(s), letter tile otherwise
  const favUrl = tab.favIconUrl;
  if (favUrl && /^https?:/.test(favUrl)) {
    if (nodes.fav.src !== favUrl) nodes.fav.src = favUrl;
    nodes.fav.hidden = false;
    nodes.fav.onerror = () => {
      nodes.fav.hidden = true;
    };
  } else {
    nodes.fav.hidden = true;
    nodes.fav.removeAttribute('src');
  }

  if (!nodes.li.parentNode) listEl.append(nodes.li);
}

/** Order: pinned target, playing, then the rest; stable within groups. */
async function reorder() {
  const order = [...rows.values()].sort((a, b) => {
    const rank = (r) => (r.tab.id === pinnedTabId ? 0 : r.playing ? 1 : 2);
    return rank(a) - rank(b) || a.tab.index - b.tab.index || a.tab.id - b.tab.id;
  });
  for (const rec of order) listEl.append(rec.nodes.li);
  let i = 1;
  for (const rec of order) rec.nodes.idx.textContent = String(i++).padStart(2, '0');
}

function refreshChrome() {
  const n = rows.size;
  countEl.hidden = n === 0;
  countEl.textContent = n ? ` · ${n}` : '';
  emptyEl.hidden = n !== 0;
  const anyPlaying = [...rows.values()].some((r) => r.playing);
  pauseAllBtn.disabled = !anyPlaying;
  const allMuted = n > 0 && [...rows.values()].every((r) => r.tab.mutedInfo?.muted);
  muteAllBtn.disabled = n === 0;
  muteAllBtn.textContent = allMuted ? 'Unmute all' : 'Mute all';
}

// --- tab-level actions -------------------------------------------------------------

async function togglePlay(rec) {
  if (!rec) return;
  rec.playing = !rec.playing;
  updateRow(rec);
  void reorder();
  try {
    const target = rec.probe
      ? { tabId: rec.tab.id, frameId: primaryOfProbe(rec.probe)?.frameId }
      : { tabId: rec.tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, func: pageToggle });
  } catch {
    // tab navigated away or closed; the audible event stream will correct us
  }
}

async function muteTab(rec) {
  if (!rec) return;
  const muted = !rec.tab.mutedInfo?.muted;
  try {
    await chrome.tabs.update(rec.tab.id, { muted });
  } catch {
    // tab may be gone
  }
  // state arrives via tabs.onUpdated (mutedInfo)
}

// --- probe ------------------------------------------------------------------------

async function probeTab(rec) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, allFrames: true },
      func: pageProbe,
    });
    const frames = results
      .filter((r) => r.result && r.result.elements && r.result.elements.length)
      .map((r) => ({ frameId: r.frameId, ...r.result }));
    if (!frames.length) return null;
    let elementCount = 0;
    for (const f of frames) elementCount += f.elements.length;
    const primary = primaryOfProbe({ frames });
    return { frames, primaryFrameId: primary?.frameId ?? frames[0].frameId, elementCount };
  } catch {
    return null; // discarded tab, chrome:// page, sandboxed frame
  }
}

// --- live updates while the popup is open ------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, info) => {
  let rec = rows.get(tabId);
  if (!rec) {
    if (info.audible === true) {
      // media started in a tab that was silent when the popup opened
      void chrome.tabs.get(tabId).then((tab) => {
        if (chrome.runtime.lastError || !tab || rows.has(tabId)) return;
        void adoptTab(tab);
      });
    }
    return;
  }
  if (info.title !== undefined) rec.tab.title = info.title;
  if (info.url !== undefined) rec.tab.url = info.url;
  if (info.favIconUrl !== undefined) rec.tab.favIconUrl = info.favIconUrl;
  if (info.audible !== undefined) rec.tab.audible = info.audible;
  if (info.mutedInfo !== undefined) rec.tab.mutedInfo = info.mutedInfo;
  updateRow(rec);
  refreshChrome();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeRow(tabId);
});

async function adoptTab(tab) {
  const rec = makeRow(tab);
  void reorder();
  const probe = await probeTab(rec);
  if (!rows.has(tab.id)) return; // tab closed while probing
  rec.probe = probe;
  updateRow(rec);
  refreshChrome();
}

// --- init ----------------------------------------------------------------------------

function buildHints() {
  if (/Mac/.test(navigator.userAgent)) {
    hintsEl.textContent = '⇧⌘P Pause all · ⇧⌘M Mute all';
    return;
  }
  hintsEl.replaceChildren(
    ...['Alt+Shift+P', ' pause all · ', 'Alt+Shift+M', ' mute all'].map((t, i) =>
      i % 2 === 0 ? Object.assign(document.createElement('kbd'), { textContent: t }) : document.createTextNode(t),
    ),
  );
}

async function init() {
  buildHints();
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get('target').catch(() => ({})),
  ]);
  pinnedTabId = typeof stored.target === 'number' ? stored.target : null;

  const candidates = tabs.filter(
    (t) => t.audible || (t.mutedInfo?.muted && /^https?:/.test(t.url ?? '')),
  );
  for (const tab of candidates) makeRow(tab);
  void reorder();
  refreshChrome();

  // Probe candidates in parallel; enrich rows as each lands. Muted tabs that
  // turn out to hold no media quietly leave the list.
  await Promise.all(
    [...rows.values()].map(async (rec) => {
      const probe = await probeTab(rec);
      if (!rows.has(rec.tab.id)) return;
      if (!probe && !rec.tab.audible) {
        removeRow(rec.tab.id);
        return;
      }
      rec.probe = probe;
      updateRow(rec);
      refreshChrome();
    }),
  );
  void reorder();
}

void init();

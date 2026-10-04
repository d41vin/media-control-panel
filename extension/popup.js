// Popup UI. Exists only while open — when it closes, every listener, timer and
// node here is destroyed by the browser. Detection needs no permissions:
// audible/mutedInfo come free with tabs.query, titles come from host
// permissions, and control is on-demand executeScript (lib/page.js).

import {
  pageProbe,
  pageToggle,
  pagePause,
  pagePing,
  pageSeekTo,
  pageSeekBy,
  pageSetVolume,
  pageSetRate,
  pagePiP,
} from './lib/page.js';

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
  chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
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
  const favLetter = el('span', 'fav-letter', '?');
  favLetter.hidden = true;
  const stack = el('div', 't-stack');
  const title = el('div', 't-title');
  const site = el('div', 't-site');
  stack.append(title, site);
  const controls = el('div', 'row-controls');

  const eq = el('span', 'eq');
  eq.append(el('i'), el('i'), el('i'));
  eq.hidden = true;

  const eqMuted = el('span', 'eq eq-muted');
  eqMuted.innerHTML = ICONS.speakerX;
  eqMuted.title = 'Tab muted';
  eqMuted.hidden = true;

  const playBtn = el('button', 'icon-btn play');
  playBtn.type = 'button';
  playBtn.title = 'Play / pause';

  const muteBtn = el('button', 'icon-btn secondary mute');
  muteBtn.type = 'button';
  muteBtn.title = 'Mute / unmute tab';

  const chevBtn = el('button', 'icon-btn secondary chev');
  chevBtn.type = 'button';
  chevBtn.title = 'Details';
  chevBtn.setAttribute('aria-expanded', 'false');

  controls.append(eqMuted, eq, playBtn, muteBtn, chevBtn);
  main.append(idx, fav, favLetter, stack, controls);

  stack.addEventListener('click', () => void activateTab(rows.get(tab.id)));
  stack.style.cursor = 'pointer';

  const panel = buildPanel();
  li.append(main, panel);

  playBtn.addEventListener('click', () => void togglePlay(rows.get(tab.id)));
  muteBtn.addEventListener('click', () => void muteTab(rows.get(tab.id)));
  chevBtn.addEventListener('click', () => void toggleExpand(rows.get(tab.id)));

  listEl.append(li);
  const rec = {
    tab,
    probe: null,
    expanded: false,
    playing: !!tab.audible,
    mediaPlaying: null,
    pip: false,
    nodes: {
      li,
      idx,
      fav,
      favLetter,
      title,
      site,
      eq,
      eqMuted,
      playBtn,
      muteBtn,
      chevBtn,
      panel,
      pos: panel.querySelector('.pos'),
      posReadout: panel.querySelector('.pos-readout'),
      vol: panel.querySelector('.vol'),
      volReadout: panel.querySelector('.vol-readout'),
      rate: panel.querySelector('.rate'),
      rateReadout: panel.querySelector('.rate-readout'),
      pipBtn: panel.querySelector('.pip'),
      back10: panel.querySelector('.back10'),
      fwd10: panel.querySelector('.fwd10'),
      tabBtn: panel.querySelector('.tab'),
      pinBtn: panel.querySelector('.pin'),
      closeBtn: panel.querySelector('.close'),
    },
    ping: null,
    dragging: false,
    volTimer: undefined,
    pendingVolume: null,
  };
  rows.set(tab.id, rec);
  wirePanel(rec);
  updateRow(rec);
  return rec;
}

/** Static panel skeleton; values are filled by syncPanel(). */
function buildPanel() {
  const panel = el('div', 'row-panel');

  const posRow = el('div', 'panel-row');
  posRow.append(el('span', 'panel-label', 'Position'));
  const pos = el('input', 'pos');
  pos.type = 'range';
  pos.min = '0';
  pos.max = '100';
  pos.step = '1';
  pos.setAttribute('aria-label', 'Seek');
  const liveTag = el('span', 'live-tag', 'Live');
  const posReadout = el('span', 'panel-readout pos-readout');
  posRow.append(pos, posReadout, liveTag);

  const volRow = el('div', 'panel-row');
  volRow.append(el('span', 'panel-label', 'Volume'));
  const vol = el('input', 'vol');
  vol.type = 'range';
  vol.min = '0';
  vol.max = '1';
  vol.step = '0.01';
  vol.setAttribute('aria-label', 'Volume');
  const volReadout = el('span', 'panel-readout vol-readout');
  volRow.append(vol, volReadout);

  const rateRow = el('div', 'panel-row');
  rateRow.append(el('span', 'panel-label', 'Speed'));
  const rate = el('input', 'rate');
  rate.type = 'range';
  rate.min = '0.25';
  rate.max = '4';
  rate.step = '0.05';
  rate.setAttribute('aria-label', 'Playback speed');
  const rateReadout = el('span', 'panel-readout rate-readout');
  rateRow.append(rate, rateReadout);

  const actions = el('div', 'panel-actions');
  const back10 = el('button', 'text-btn back10');
  back10.type = 'button';
  back10.textContent = '−10s';
  const fwd10 = el('button', 'text-btn fwd10');
  fwd10.type = 'button';
  fwd10.textContent = '+10s';
  const pip = el('button', 'text-btn pip');
  pip.type = 'button';
  pip.textContent = 'PiP';
  const tabBtn = el('button', 'text-btn tab');
  tabBtn.type = 'button';
  tabBtn.textContent = 'Tab';
  const pinBtn = el('button', 'text-btn pin');
  pinBtn.type = 'button';
  pinBtn.textContent = 'Pin';
  const closeBtn = el('button', 'text-btn danger close');
  closeBtn.type = 'button';
  closeBtn.textContent = 'Close';
  actions.append(back10, fwd10, pip, tabBtn, pinBtn, closeBtn);

  panel.append(posRow, volRow, rateRow, actions);
  return panel;
}

// --- expanded panel -----------------------------------------------------------------

function setFill(input) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max) || 1;
  const v = parseFloat(input.value) || 0;
  input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
}

function toggleExpand(rec) {
  if (!rec) return;
  rec.expanded = !rec.expanded;
  rec.nodes.li.classList.toggle('expanded', rec.expanded);
  rec.nodes.chevBtn.setAttribute('aria-expanded', String(rec.expanded));
  if (rec.expanded) {
    syncPanel(rec, true);
    if (rec.playing) startPing(rec);
  } else {
    stopPing(rec);
  }
}

/** Fill panel values from probe, or fresh from the page (pingNow). */
function syncPanel(rec, fresh) {
  const n = rec.nodes;
  if (rec.dragging) return; // never fight the user's hand
  const disabled = !rec.probe;
  n.pos.disabled = n.vol.disabled = n.rate.disabled = disabled;
  n.pipBtn.disabled = disabled;
  n.back10.disabled = n.fwd10.disabled = disabled;
  // pin / tab / close work regardless of media state

  if (!rec.probe) {
    n.posReadout.textContent = '—';
    n.volReadout.textContent = '—';
    n.rateReadout.textContent = '—';
    return;
  }
  if (fresh) {
    // panel just opened: take a real reading instead of the probe snapshot
    void pingNow(rec);
    return;
  }

  const element = primaryOfProbe(rec.probe)?.element;
  if (!element) return;
  const live = element.duration === -1;
  n.pos.closest('.panel-row').classList.toggle('live', live);
  if (!live) {
    n.pos.max = String(Math.floor(element.duration));
    n.pos.value = String(Math.floor(element.currentTime));
    setFill(n.pos);
    n.posReadout.textContent = `${fmtTime(element.currentTime)} / ${fmtTime(element.duration)}`;
  }
  n.vol.value = String(element.volume);
  setFill(n.vol);
  n.volReadout.textContent = `${Math.round(element.volume * 100)}%`;
  n.rate.value = String(element.rate);
  setFill(n.rate);
  n.rateReadout.textContent = `${element.rate.toFixed(2)}×`;
  n.pipBtn.classList.toggle('on', !!rec.pip);
}

/** One cheap pagePing on the primary frame; refreshes panel readouts. */
async function pingNow(rec) {
  if (!rec?.probe) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, frameId: rec.probe.primaryFrameId },
      func: pagePing,
    });
    const state = results[0]?.result;
    if (!state?.present) return null;
    // fold fresh state into the probe record so updateRow() — the single
    // render path — always writes the newest known values
    const p = primaryOfProbe(rec.probe);
    if (p?.element) {
      p.element.playing = state.playing;
      p.element.currentTime = state.currentTime;
      p.element.duration = state.duration;
      p.element.volume = state.volume;
      p.element.rate = state.rate;
    }
    rec.mediaPlaying = state.playing;
    rec.pip = !!state.pip;
    if (!rec.dragging) updateRow(rec);
    return state;
  } catch {
    return null;
  }
}

function startPing(rec) {
  if (rec.ping) return;
  rec.ping = setInterval(() => {
    void pingNow(rec);
  }, 1000);
}

function stopPing(rec) {
  if (rec.ping) {
    clearInterval(rec.ping);
    rec.ping = null;
  }
  if (rec.expanded && rec.probe) void pingNow(rec); // one last sync after pause
}

/** Wire panel events once, at row creation. */
function wirePanel(rec) {
  const n = rec.nodes;

  // While any slider is held, the ping loop must not fight the user's hand.
  const dragGuard = (input) => {
    input.addEventListener('input', () => {
      rec.dragging = true;
    });
    for (const ev of ['change', 'pointerup', 'pointercancel', 'blur']) {
      input.addEventListener(ev, () => {
        rec.dragging = false;
      });
    }
  };
  dragGuard(n.pos);
  dragGuard(n.vol);
  dragGuard(n.rate);

  n.pos.addEventListener('input', () => {
    setFill(n.pos);
    n.posReadout.textContent = `${fmtTime(parseFloat(n.pos.value))} / ${fmtTime(parseFloat(n.pos.max))}`;
  });
  n.pos.addEventListener('change', () => {
    void exec(rec, pageSeekTo, { time: parseFloat(n.pos.value) });
  });

  n.vol.addEventListener('input', () => {
    setFill(n.vol);
    n.volReadout.textContent = `${Math.round(parseFloat(n.vol.value) * 100)}%`;
    rec.pendingVolume = parseFloat(n.vol.value);
    if (rec.volTimer === undefined) {
      rec.volTimer = setTimeout(() => {
        rec.volTimer = undefined;
        if (rec.pendingVolume !== null) {
          void exec(rec, pageSetVolume, { volume: rec.pendingVolume });
          rec.pendingVolume = null;
        }
      }, 80);
    }
  });

  n.rate.addEventListener('input', () => {
    setFill(n.rate);
    n.rateReadout.textContent = `${parseFloat(n.rate.value).toFixed(2)}×`;
  });
  n.rate.addEventListener('change', () => {
    void exec(rec, pageSetRate, { rate: parseFloat(n.rate.value) });
  });

  n.back10.addEventListener('click', () => {
    void exec(rec, pageSeekBy, { seconds: -10 });
    setTimeout(() => void pingNow(rec), 120);
  });
  n.fwd10.addEventListener('click', () => {
    void exec(rec, pageSeekBy, { seconds: 10 });
    setTimeout(() => void pingNow(rec), 120);
  });
  n.pipBtn.addEventListener('click', () => {
    void exec(rec, pagePiP, {});
    setTimeout(() => void pingNow(rec), 250);
  });
  n.tabBtn.addEventListener('click', () => void activateTab(rec));
  n.pinBtn.addEventListener('click', () => void togglePin(rec));
  n.closeBtn.addEventListener('click', () => void chrome.tabs.remove(rec.tab.id).catch(() => {}));
}

// --- global actions and pinned target ------------------------------------------------

async function pauseAll() {
  const jobs = [...rows.values()].filter((r) => r.playing).map(async (rec) => {
    rec.mediaPlaying = false;
    updateRow(rec);
    try {
      const target = rec.probe
        ? { tabId: rec.tab.id, frameId: rec.probe.primaryFrameId }
        : { tabId: rec.tab.id, allFrames: true };
      await chrome.scripting.executeScript({ target, func: pagePause });
    } catch {
      // tab gone; onRemoved cleans up
    }
  });
  await Promise.allSettled(jobs);
  refreshChrome();
  void reorder();
}

async function muteAll() {
  const allMuted = rows.size > 0 && [...rows.values()].every((r) => r.tab.mutedInfo?.muted);
  const target = !allMuted;
  await Promise.allSettled(
    [...rows.values()]
      .filter((r) => !!r.tab.mutedInfo?.muted !== target)
      .map((r) => chrome.tabs.update(r.tab.id, { muted: target }).catch(() => {})),
  );
  // rows re-render from the mutedInfo events
}

async function togglePin(rec) {
  if (!rec) return;
  pinnedTabId = pinnedTabId === rec.tab.id ? null : rec.tab.id;
  try {
    if (pinnedTabId === null) await chrome.storage.session.remove('target');
    else await chrome.storage.session.set({ target: pinnedTabId });
  } catch {
    // storage unavailable; pin still works for this popup session
  }
  for (const r of rows.values()) updateRow(r);
  void reorder();
  updateTargetReadout();
}

function updateTargetReadout() {
  const rec = pinnedTabId !== null ? rows.get(pinnedTabId) : null;
  targetEl.textContent = rec ? `Target ${rec.nodes.idx.textContent} · ${hostOf(rec.tab.url) || 'system page'}` : 'Target none';
  targetEl.classList.toggle('set', !!rec);
}

/** executeScript helper targeting the primary frame. */
async function exec(rec, func, args) {
  if (!rec?.probe) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, frameId: rec.probe.primaryFrameId },
      func,
      args: [args],
    });
    return results[0]?.result ?? null;
  } catch {
    return null;
  }
}

async function activateTab(rec) {
  if (!rec) return;
  try {
    await chrome.tabs.update(rec.tab.id, { active: true });
    if (rec.tab.windowId !== undefined) {
      await chrome.windows.update(rec.tab.windowId, { focused: true });
    }
  } catch {
    // tab or window may be gone
  }
}

function removeRow(tabId) {
  const rec = rows.get(tabId);
  if (!rec) return;
  stopPing(rec);
  if (rec.volTimer !== undefined) {
    clearTimeout(rec.volTimer);
    rec.volTimer = undefined;
  }
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

  // Two truths, kept apart: tab.audible is tab-level and arrives via events;
  // rec.mediaPlaying is element-level (a muted video plays without being
  // audible) and comes from probes, pings and our own commands. The stale
  // probe snapshot must never override a newer command or ping.
  rec.playing = !!tab.audible || rec.mediaPlaying === true;
  const probe = rec.probe ? primaryOfProbe(rec.probe) : null;

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
  nodes.eqMuted.hidden = !tab.mutedInfo?.muted;
  nodes.eq.hidden = !rec.playing || !!tab.mutedInfo?.muted;

  nodes.li.classList.toggle('paused', !rec.playing);
  nodes.li.classList.toggle('target', tab.id === pinnedTabId);
  nodes.pinBtn.textContent = tab.id === pinnedTabId ? 'Unpin' : 'Pin';
  nodes.pinBtn.classList.toggle('on', tab.id === pinnedTabId);

  // favicon: real one when available, letter tile otherwise
  const favUrl = tab.favIconUrl;
  nodes.favLetter.textContent = (host || titleText || '?').charAt(0).toUpperCase();
  if (favUrl && /^(https?:|data:)/.test(favUrl)) {
    if (nodes.fav.src !== favUrl) nodes.fav.src = favUrl;
    nodes.fav.hidden = false;
    nodes.favLetter.hidden = true;
    nodes.fav.onerror = () => {
      nodes.fav.hidden = true;
      nodes.favLetter.hidden = false;
    };
  } else {
    nodes.fav.hidden = true;
    nodes.fav.removeAttribute('src');
    nodes.favLetter.hidden = false;
    nodes.favLetter.textContent = (host || titleText || '?').charAt(0).toUpperCase();
  }

  if (!nodes.li.parentNode) listEl.append(nodes.li);

  // ping loop follows expansion + playing state; stopPing syncs once on pause
  if (rec.expanded && rec.playing && !rec.ping) startPing(rec);
  if (rec.ping && (!rec.expanded || !rec.playing)) stopPing(rec);
  if (rec.expanded) syncPanel(rec, false);
}

/** Order: pinned target, playing, then the rest; stable within groups. */
function reorder() {
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
  rec.mediaPlaying = rec.playing ? false : true;
  updateRow(rec);
  void reorder();
  try {
    const target = rec.probe
      ? { tabId: rec.tab.id, frameId: primaryOfProbe(rec.probe)?.frameId }
      : { tabId: rec.tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, func: pageToggle });
  } catch {
    // uninjectable tab (chrome://, sandboxed frame): the command never landed,
    // so fall back to the truth we know instead of the optimistic guess
    rec.mediaPlaying = null;
    updateRow(rec);
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

/** Land a probe result on a record: primary truth + pip state, then render. */
function applyProbe(rec, probe) {
  rec.probe = probe;
  const primary = probe ? primaryOfProbe(probe) : null;
  rec.mediaPlaying = probe ? (primary?.element.playing ?? null) : null;
  rec.pip = probe
    ? !!probe.frames.find((f) => f.frameId === rec.probe.primaryFrameId)?.pip
    : false;
  updateRow(rec);
}

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
  applyProbe(rec, probe);
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
  pauseAllBtn.addEventListener('click', () => void pauseAll());
  muteAllBtn.addEventListener('click', () => void muteAll());
  const [tabs, stored] = await Promise.all([
    chrome.tabs.query({}),
    chrome.storage.session.get(['target', 'recent']).catch(() => ({})),
  ]);
  pinnedTabId = typeof stored.target === 'number' ? stored.target : null;
  const recentIds = Array.isArray(stored.recent)
    ? stored.recent.filter((n) => typeof n === 'number')
    : [];

  // keep the pin in sync if it is cleared elsewhere (e.g. tab closed by the
  // background while the popup is open)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'session' || !('target' in changes)) return;
    const v = changes.target.newValue;
    const next = typeof v === 'number' ? v : null;
    if (next !== pinnedTabId) {
      pinnedTabId = next;
      for (const r of rows.values()) updateRow(r);
      void reorder();
    }
    updateTargetReadout();
  });

  // candidates: sounding tabs, muted tabs, the pinned target, and tabs that
  // played recently this session (so paused media stays resumable, like
  // Chrome's own media panel). Probes settle which of these really hold media.
  const candidates = tabs.filter((t) => {
    if (t.id === undefined) return false;
    return (
      t.audible ||
      (t.mutedInfo?.muted && /^https?:/.test(t.url ?? '')) ||
      t.id === pinnedTabId ||
      recentIds.includes(t.id)
    );
  });
  for (const tab of candidates) makeRow(tab);
  void reorder();
  refreshChrome();
  updateTargetReadout();

  // Probe candidates in parallel; enrich rows as each lands. Tabs that turn
  // out to hold no media leave the list — and leave the recent list too, so
  // it only ever names real media tabs. Audible and pinned tabs stay even
  // without media (uninjectable pages, paused-live edge cases).
  await Promise.all(
    [...rows.values()].map(async (rec) => {
      const probe = await probeTab(rec);
      if (!rows.has(rec.tab.id)) return;
      const keepWithoutMedia = rec.tab.audible || rec.tab.id === pinnedTabId;
      if (!probe && !keepWithoutMedia) {
        removeRow(rec.tab.id);
        void pruneRecent(rec.tab.id);
        return;
      }
      applyProbe(rec, probe);
      refreshChrome();
    }),
  );
  void reorder();
}

async function pruneRecent(tabId) {
  try {
    const { recent } = await chrome.storage.session.get('recent');
    if (!Array.isArray(recent) || !recent.includes(tabId)) return;
    await chrome.storage.session.set({ recent: recent.filter((id) => id !== tabId) });
  } catch {
    // storage unavailable; the next open just probes a stale id once
  }
}

void init();

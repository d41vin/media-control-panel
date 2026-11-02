// Popup UI. Exists only while open — when it closes, every listener, timer and
// node here is destroyed by the browser. Detection needs no permissions:
// audible/mutedInfo come free with tabs.query, titles come from host
// permissions, and control is on-demand executeScript (lib/page.js).
//
// Speed policy display is derived from the real state owners: the global speed
// (storage.local 'speed') and per-page overrides (storage.session
// 'speedOverrides'), both observed via storage events — never optimistic
// guesses. Speed commands go to the background worker, which owns enforcement
// through the injected page managers (lib/manager.js).
//
// Boost is tab-level: the popup only requests the one-time capture stream id
// (its click is the required user gesture) and reports the user's gain
// choice; the background + offscreen document own the actual pipeline.

import {
  pageProbe,
  pageToggle,
  pagePause,
  pagePlay,
  pagePing,
  pageSeekTo,
  pageSeekBy,
  pageSetVolume,
  pagePiP,
} from './lib/page.js';
import { adapterFor } from './lib/adapters.js';
import { DEFAULT_SETTINGS, THEMES, loadSettings, saveSettings } from './lib/settings.js';
import {
  SPEED_MIN,
  SPEED_MAX,
  SPEED_DEFAULT,
  SPEED_STEP,
  clampSpeed,
  snapSpeed,
  fmtSpeed,
  loadGlobalSpeed,
  saveGlobalSpeed,
} from './lib/speed.js';

const listEl = document.getElementById('list');
const emptyEl = document.getElementById('empty');
const countEl = document.getElementById('count');
const pauseAllBtn = document.getElementById('pause-all');
const muteAllBtn = document.getElementById('mute-all');
const targetEl = document.getElementById('target-readout');
const hintsEl = document.getElementById('hints');
const settingsBtn = document.getElementById('settings-toggle');
const settingsEl = document.getElementById('settings');
const settingInputs = {
  autoPauseOnOpen: document.getElementById('set-autopause'),
  badge: document.getElementById('set-badge'),
  recentTabs: document.getElementById('set-recent'),
};
const themeButtons = [...document.querySelectorAll('[data-theme-value]')];
const gspeedValue = document.getElementById('gspeed-value');
const gspeedDec = document.getElementById('gspeed-dec');
const gspeedInc = document.getElementById('gspeed-inc');
const gspeedReset = document.getElementById('gspeed-reset');
const gspeedNote = document.getElementById('gspeed-note');

// --- icons (our own static strings — safe for innerHTML) ---------------------
//
// Semantics are one glyph per meaning (DESIGN.md): the quick-mute toggle
// speaks with the bare speaker / struck speaker pair; the volume control gets
// the waved speaker; boost is speaker+plus (never a download arrow); ±10 s
// are circular arrows carrying the 10; global speed is a gauge.

const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>',
  // quick mute: bare speaker (sound on) / struck speaker (muted)
  speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/></svg>',
  speakerX:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6m0-6l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  // normal volume control: waved speaker — visibly distinct from the mute pair
  vol: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M15.5 8.2a5.4 5.4 0 0 1 0 7.6M18.4 5.4a9.4 9.4 0 0 1 0 13.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  // boost: speaker with a plus — amplification, not a download
  boost:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M18 3.5v7M14.5 7h7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  gauge:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a9 9 0 0 0-9 9c0 2.2.8 4.2 2.1 5.8l1.5-1.3A6.9 6.9 0 0 1 5.1 13 6.9 6.9 0 1 1 17 18.4l1.4 1.5A9 9 0 0 0 12 4z"/><path d="m12.9 14.6-5.2-5.4 1.5-1.4 5 5.3a1.7 1.7 0 1 1-1.3 1.5z"/></svg>',
  // ±10 s: circular transport arrows that carry the 10 (never confusable
  // with prev/next track)
  rewind10:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 5V1.8L6 5.9l5 4.1V7a6 6 0 1 1-6 6H3a8 8 0 1 0 8-8z"/><text x="12" y="17.5" text-anchor="middle" font-size="7.5" font-weight="700" stroke="none">10</text></svg>',
  forward10:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M13 5V1.8l5 4.1-5 4.1V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z"/><text x="12" y="17.5" text-anchor="middle" font-size="7.5" font-weight="700" stroke="none">10</text></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l8 6-8 6V6zm10 0h2v12h-2z"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6l-8 6 8 6V6zM6 6h2v12H6z"/></svg>',
  pip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 11h-8v6h8v-6z"/><path fill-rule="evenodd" d="M21 3H3v18h18V3zm-1 1H4v16h16V4z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.2 2.6 21.4 9.8c-1.9.1-3.7.9-5.1 2.3l-.5.5.3 4.3-2.5 2.5-3-3-5.2 5.4-1.5-1.5L9.3 15l-3-3L8.8 9.5l4.3.3.5-.5c1.4-1.4 2.2-3.2 2.3-5.1z"/></svg>',
  window:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill-rule="evenodd" d="M3 4h18v16H3V4zm2 4.5h14V6H5v2.5zm0 2.5v7h14v-7H5z"/></svg>',
  close:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4z"/></svg>',
};

function icon(name) {
  const span = document.createElement('span');
  span.innerHTML = ICONS[name];
  return span.firstChild;
}

// --- state --------------------------------------------------------------------

/** tabId -> { tab, probe, playing, nodes, ... } */
const rows = new Map();
let pinnedTabId = null;
let settings = { ...DEFAULT_SETTINGS };
let settingsOpen = false;
let globalSpeed = SPEED_DEFAULT;
/** tabId -> { url, rate, at } — page speed overrides (session store mirror) */
let overrides = new Map();
/**
 * tabId -> rate | null (reset) — the user's latest optimistic page-speed
 * choice while the background's confirmation write is still in flight. A
 * late echo of an earlier command's write must not regress the card (or the
 * next stepper read) to the older value.
 */
const pendingPageSpeed = new Map();

function notePendingPageSpeed(tabId, pending) {
  pendingPageSpeed.set(tabId, pending);
  // a command that never confirms (dead tab, no receiver) falls back to the
  // stored truth instead of pinning the card to a ghost choice
  setTimeout(() => {
    if (pendingPageSpeed.get(tabId) === pending) {
      pendingPageSpeed.delete(tabId);
      const r = rows.get(tabId);
      if (r) updateRow(r);
    }
  }, 3000);
}
/** tabId -> { gain, state: 'pending'|'active'|'error', error? } — boost state */
let boostStates = new Map();
/**
 * The tab the user is viewing (the popup's window's active tab). tabCapture
 * targets must carry the activeTab grant — only the viewed tab has it — so
 * boost START is offered for this tab's card only. Controlling an existing
 * boost (reset, or reading its state) works from any card.
 */
let activeTabId = null;

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

function errText(e) {
  return String(e?.message ?? e ?? 'Unknown error');
}

// --- record shape -----------------------------------------------------------------
//
// probe = { frames: [{ frameId, docTitle, pip, elements: [...] }],
//           primaryFrameId, elementCount, artwork }
// Primary element across the tab: first playing element in the primary frame;
// primary frame: first frame holding a playing element, else first with any.

function primaryOfProbe(probe) {
  if (!probe) return null;
  for (const f of probe.frames) {
    const playing = f.elements.find((e) => e.playing);
    if (playing) return { frameId: f.frameId, element: playing };
  }
  const f = probe.frames[0];
  return f ? { frameId: f.frameId, element: f.elements[0] } : null;
}

// --- cards ----------------------------------------------------------------------------

function makeRow(tab) {
  // A tab can be adopted by an onUpdated event while init() is still walking
  // its query snapshot. Reuse the existing card instead of appending a second
  // one: a duplicate DOM row would keep stale control state (the mute icon in
  // particular), because rows.get(tabId) can only address one record.
  const existing = rows.get(tab.id);
  if (existing) {
    applyTabState(existing, tab);
    return existing;
  }
  const li = el('li', 'row');
  const card = el('div', 'card');

  // head: art + titles + mute + play
  const head = el('div', 'card-head');
  const art = el('div', 'art');
  const artwork = el('img', 'artwork');
  artwork.alt = '';
  artwork.hidden = true;
  const fav = el('img', 'fav');
  fav.alt = '';
  fav.hidden = true;
  const favLetter = el('span', 'fav-letter', '?');
  favLetter.hidden = true;
  const eq = el('span', 'eq');
  eq.append(el('i'), el('i'), el('i'));
  eq.hidden = true;
  const eqMuted = el('span', 'eq eq-muted');
  eqMuted.innerHTML = ICONS.speakerX;
  eqMuted.title = 'Tab muted';
  eqMuted.hidden = true;
  art.append(artwork, fav, favLetter, eq, eqMuted);

  const stack = el('div', 't-stack');
  const title = el('div', 't-title');
  const site = el('div', 't-site');
  stack.append(title, site);
  stack.addEventListener('click', () => void activateTab(rows.get(tab.id)));
  stack.style.cursor = 'pointer';

  const muteBtn = el('button', 'icon-btn quiet mute');
  muteBtn.type = 'button';
  muteBtn.title = 'Mute / unmute tab';

  const playBtn = el('button', 'icon-btn play');
  playBtn.type = 'button';
  playBtn.title = 'Play / pause · Alt+click: solo';

  head.append(art, stack, muteBtn, playBtn);

  // timeline: transport row around the seek slider (largest, center) —
  // previous track → back 10 s → progress/position → forward 10 s → next
  // track. The buttons keep their place on every card and speak through
  // real disabled states instead of vanishing.
  const progress = el('div', 'card-timeline');
  const prevBtn = el('button', 'icon-btn tl prev');
  prevBtn.type = 'button';
  prevBtn.title = 'Previous track';
  prevBtn.setAttribute('aria-label', 'Previous track');
  prevBtn.replaceChildren(icon('prev'));
  prevBtn.disabled = true; // enabled only where the site has an adapter

  const back10 = el('button', 'icon-btn tl back10');
  back10.type = 'button';
  back10.title = 'Back 10 seconds';
  back10.setAttribute('aria-label', 'Back 10 seconds');
  back10.replaceChildren(icon('rewind10'));

  const posStack = el('div', 'tl-center');
  const pos = el('input', 'pos');
  pos.type = 'range';
  pos.min = '0';
  pos.max = '100';
  pos.step = '1';
  pos.setAttribute('aria-label', 'Seek');
  const posReadout = el('span', 'pos-readout');
  const liveTag = el('span', 'live-tag', 'Live');
  posStack.append(pos, posReadout, liveTag);

  const fwd10 = el('button', 'icon-btn tl fwd10');
  fwd10.type = 'button';
  fwd10.title = 'Forward 10 seconds';
  fwd10.setAttribute('aria-label', 'Forward 10 seconds');
  fwd10.replaceChildren(icon('forward10'));

  const nextBtn = el('button', 'icon-btn tl next');
  nextBtn.type = 'button';
  nextBtn.title = 'Next track';
  nextBtn.setAttribute('aria-label', 'Next track');
  nextBtn.replaceChildren(icon('next'));
  nextBtn.disabled = true; // enabled only where the site has an adapter

  progress.append(prevBtn, back10, posStack, fwd10, nextBtn);

  // controls row
  const controls = el('div', 'card-controls');

  const pipBtn = el('button', 'icon-btn pip');
  pipBtn.type = 'button';
  pipBtn.title = 'Picture-in-Picture';
  pipBtn.setAttribute('aria-label', 'Picture-in-Picture');
  pipBtn.replaceChildren(icon('pip'));

  // per-page speed: the effective value is always visible; the reset button
  // appears only while the page has its own override
  const speedCluster = el('div', 'speed-cluster');
  const rateDec = el('button', 'step-btn rate-dec');
  rateDec.type = 'button';
  rateDec.textContent = '−';
  rateDec.title = 'Slower by 0.25×';
  rateDec.setAttribute('aria-label', 'Slower by 0.25×');
  const rateReadout = el('span', 'rate-readout');
  const rateInc = el('button', 'step-btn rate-inc');
  rateInc.type = 'button';
  rateInc.textContent = '+';
  rateInc.title = 'Faster by 0.25×';
  rateInc.setAttribute('aria-label', 'Faster by 0.25×');
  const rateReset = el('button', 'step-btn reset rate-reset');
  rateReset.type = 'button';
  rateReset.textContent = '↺';
  rateReset.title = 'Reset page speed to global';
  rateReset.setAttribute('aria-label', 'Reset page speed to global');
  rateReset.hidden = true;
  speedCluster.append(rateDec, rateReadout, rateInc, rateReset);

  const volBtn = el('button', 'icon-btn vol-btn pop-opener');
  volBtn.type = 'button';
  volBtn.title = 'Volume';
  volBtn.setAttribute('aria-label', 'Volume');
  volBtn.setAttribute('aria-expanded', 'false');
  volBtn.replaceChildren(icon('vol'));

  const boostBtn = el('button', 'boost-btn pop-opener');
  boostBtn.type = 'button';
  boostBtn.title = 'Tab volume boost';
  boostBtn.setAttribute('aria-expanded', 'false');
  boostBtn.append(icon('boost'), el('span', 'boost-readout', '100%'));

  const menuBtn = el('button', 'icon-btn menu-btn pop-opener');
  menuBtn.type = 'button';
  menuBtn.title = 'More actions';
  menuBtn.setAttribute('aria-label', 'More actions');
  menuBtn.setAttribute('aria-expanded', 'false');
  menuBtn.replaceChildren(icon('menu'));

  controls.append(pipBtn, speedCluster, volBtn, boostBtn, menuBtn);

  // popovers: inline collapsible sections under the controls row
  const volPop = el('div', 'popover vol-pop');
  const volPopHead = el('div', 'pop-head');
  volPopHead.append(el('span', 'pop-label', 'Volume'));
  const volReadout = el('span', 'pop-readout vol-readout');
  volPopHead.append(volReadout);
  const vol = el('input', 'vol');
  vol.type = 'range';
  vol.min = '0';
  vol.max = '1';
  // predictable increments: 5 % per pointer/keyboard step. Values written
  // back from the page are still displayed truthfully (see syncCard).
  vol.step = '0.05';
  vol.setAttribute('aria-label', 'Volume');
  volPop.append(volPopHead, vol);

  const boostPop = el('div', 'popover boost-pop');
  const boostPopHead = el('div', 'pop-head');
  boostPopHead.append(el('span', 'pop-label', 'Tab boost'));
  const boostPopReadout = el('span', 'pop-readout boost-readout');
  boostPopHead.append(boostPopReadout);
  const boost = el('input', 'boost');
  boost.type = 'range';
  boost.min = '100';
  boost.max = '600';
  boost.step = '10';
  boost.value = '100';
  boost.setAttribute('aria-label', 'Tab volume boost');
  const boostActions = el('div', 'boost-actions');
  const boostReset = el('button', 'text-btn boost-reset');
  boostReset.type = 'button';
  boostReset.textContent = 'Reset to 100%';
  const boostStatus = el('span', 'boost-status');
  boostActions.append(boostReset, boostStatus);
  const boostWarn = el('p', 'boost-warn', 'High boost levels may distort audio. Boost applies to this tab only.');
  boostPop.append(boostPopHead, boost, boostActions, boostWarn);

  const menuPop = el('div', 'popover menu-pop');
  const pinBtn = el('button', 'menu-item pin');
  pinBtn.type = 'button';
  const pinIcon = icon('pin');
  const pinLabel = el('span', 'menu-label', 'Pin as target');
  pinBtn.append(pinIcon, pinLabel);
  const tabBtn = el('button', 'menu-item tab');
  tabBtn.type = 'button';
  tabBtn.append(icon('window'), el('span', 'menu-label', 'Switch to tab'));
  const closeBtn = el('button', 'menu-item danger close');
  closeBtn.type = 'button';
  closeBtn.append(icon('close'), el('span', 'menu-label', 'Close tab'));
  menuPop.append(pinBtn, tabBtn, closeBtn);

  card.append(head, progress, controls, volPop, boostPop, menuPop);
  li.append(card);
  listEl.append(li);

  playBtn.addEventListener('click', (e) => void togglePlay(rows.get(tab.id), { exclusive: e.altKey }));
  prevBtn.addEventListener('click', () => void runAdapter(rows.get(tab.id), 'prev'));
  nextBtn.addEventListener('click', () => void runAdapter(rows.get(tab.id), 'next'));
  muteBtn.addEventListener('click', () => void muteTab(rows.get(tab.id)));
  back10.addEventListener('click', () => {
    void exec(rec(), pageSeekBy, { seconds: -10 });
    setTimeout(() => void pingNow(rows.get(tab.id)), 120);
  });
  fwd10.addEventListener('click', () => {
    void exec(rec(), pageSeekBy, { seconds: 10 });
    setTimeout(() => void pingNow(rows.get(tab.id)), 120);
  });
  pipBtn.addEventListener('click', () => {
    void exec(rows.get(tab.id), pagePiP, {});
    setTimeout(() => void pingNow(rows.get(tab.id)), 250);
  });
  rateDec.addEventListener('click', () => void stepPageSpeed(rows.get(tab.id), -SPEED_STEP));
  rateInc.addEventListener('click', () => void stepPageSpeed(rows.get(tab.id), +SPEED_STEP));
  rateReset.addEventListener('click', () => void resetPageSpeed(rows.get(tab.id)));
  volBtn.addEventListener('click', () => togglePopover(rows.get(tab.id), 'vol'));
  boostBtn.addEventListener('click', () => togglePopover(rows.get(tab.id), 'boost'));
  menuBtn.addEventListener('click', () => togglePopover(rows.get(tab.id), 'menu'));
  pinBtn.addEventListener('click', () => {
    closePopover(rows.get(tab.id));
    void togglePin(rows.get(tab.id));
  });
  tabBtn.addEventListener('click', () => {
    closePopover(rows.get(tab.id));
    void activateTab(rows.get(tab.id));
  });
  closeBtn.addEventListener('click', () => void chrome.tabs.remove(tab.id).catch(() => {}));

  function rec() {
    return rows.get(tab.id);
  }

  const self = {
    tab,
    probe: null,
    playing: !!tab.audible,
    mediaPlaying: null,
    pip: false,
    openPopover: null,
    adapter: null,
    /** site-button availability from the last probe/ping: {next, prev: {found, disabled}} */
    adapterState: null,
    nodes: {
      li,
      artwork,
      fav,
      favLetter,
      eq,
      eqMuted,
      title,
      site,
      playBtn,
      muteBtn,
      prevBtn,
      nextBtn,
      back10,
      fwd10,
      pipBtn,
      pos,
      posReadout,
      rateDec,
      rateInc,
      rateReset,
      rateReadout,
      speedCluster,
      volBtn,
      volPop,
      vol,
      volReadout,
      boostBtn,
      boostPop,
      boost,
      boostPopReadout,
      boostReset,
      boostStatus,
      menuBtn,
      menuPop,
      pinBtn,
      closeBtn,
    },
    ping: null,
    // play-state ordering: when a command (play/pause) last landed on this
    // tab. Probe and ping results captured before that instant are stale and
    // must never flip self.mediaPlaying back — the phantom-playback guard.
    commandAt: 0,
    commandPending: false,
    /** when this row's last explicit mute command was issued (stale reads lose) */
    muteCommandAt: 0,
    dragging: false,
    volTimer: undefined,
    pendingVolume: null,
    boostTimer: undefined,
    pendingBoost: null,
    boostStarting: false,
    errorTimer: undefined,
  };
  rows.set(tab.id, self);
  wireCard(self);
  updateRow(self);
  return self;
}

/** Wire slider events once, at card creation. */
function wireCard(rec) {
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
  dragGuard(n.boost);

  n.pos.addEventListener('input', () => {
    setFill(n.pos);
    n.posReadout.textContent = `${fmtTime(parseFloat(n.pos.value))} / ${fmtTime(parseFloat(n.pos.max))}`;
  });
  n.pos.addEventListener('change', () => {
    void exec(rec, pageSeekTo, { time: parseFloat(n.pos.value) });
  });

  n.vol.addEventListener('input', () => {
    setFill(n.vol);
    // the range's step is 0.05: the value is already on the 5 % grid, so the
    // readout and the page volume agree exactly
    const value = Number(parseFloat(n.vol.value).toFixed(2));
    n.volReadout.textContent = `${Math.round(value * 100)}%`;
    rec.pendingVolume = value;
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

  n.boost.addEventListener('input', () => {
    const pct = parseInt(n.boost.value, 10);
    n.boostPopReadout.textContent = `${pct}%`;
    const state = boostStates.get(rec.tab.id);
    if (pct <= 100) {
      // 100% means no boost pipeline is needed: stop whatever is running and
      // clear any pending adjustment — the slider and the reset button agree
      if (state || rec.boostStarting) void boostDisable(rec);
      return;
    }
    if (!state || state.state === 'error') {
      // first movement beyond 100% starts the capture pipeline — this input
      // event carries the user gesture that (via the worker) the capture
      // API requires
      void boostEnable(rec, pct);
      return;
    }
    // active: adjust the running pipeline's gain, never restart it
    rec.pendingBoost = pct;
    if (rec.boostTimer === undefined) {
      rec.boostTimer = setTimeout(() => {
        rec.boostTimer = undefined;
        if (rec.pendingBoost === null) return;
        const v = rec.pendingBoost;
        rec.pendingBoost = null;
        const cur = boostStates.get(rec.tab.id);
        if (!cur || cur.state === 'error') return; // stopped meanwhile
        setBoostLocal(rec.tab.id, { ...cur, gain: v });
        chrome.runtime
          .sendMessage({ type: 'mcp-boost-gain', tabId: rec.tab.id, gain: v })
          .catch(() => {});
      }, 80);
    }
  });

  n.boostReset.addEventListener('click', () => void boostDisable(rec));
}

function setFill(input) {
  const min = parseFloat(input.min) || 0;
  const max = parseFloat(input.max) || 1;
  const v = parseFloat(input.value) || 0;
  input.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
}

// --- popovers -----------------------------------------------------------------------

function togglePopover(rec, name) {
  if (!rec) return;
  const next = rec.openPopover === name ? null : name;
  for (const r of rows.values()) {
    if (r !== rec && r.openPopover) closePopover(r);
  }
  rec.openPopover = next;
  syncPopover(rec);
  if (next === 'vol') {
    const element = primaryOfProbe(rec.probe)?.element;
    if (element) {
      rec.nodes.vol.value = String(element.volume);
      setFill(rec.nodes.vol);
      rec.nodes.volReadout.textContent = `${Math.round(element.volume * 100)}%`;
    }
  }
  if (next) {
    const focusTarget = { vol: 'vol', boost: 'boost', menu: 'menuBtn' }[next];
    rec.nodes[focusTarget]?.focus?.();
  }
}

function closePopover(rec) {
  if (!rec?.openPopover) return;
  rec.openPopover = null;
  syncPopover(rec);
}

function syncPopover(rec) {
  const n = rec.nodes;
  n.volPop.classList.toggle('open', rec.openPopover === 'vol');
  n.boostPop.classList.toggle('open', rec.openPopover === 'boost');
  n.menuPop.classList.toggle('open', rec.openPopover === 'menu');
  n.volBtn.setAttribute('aria-expanded', String(rec.openPopover === 'vol'));
  n.boostBtn.setAttribute('aria-expanded', String(rec.openPopover === 'boost'));
  n.menuBtn.setAttribute('aria-expanded', String(rec.openPopover === 'menu'));
}

// click-away closes any open popover (openers and popover content excluded)
document.addEventListener('click', (e) => {
  if (e.target.closest?.('.popover') || e.target.closest?.('.pop-opener')) return;
  for (const r of rows.values()) if (r.openPopover) closePopover(r);
});

// --- speed: global bar + per-page cluster ----------------------------------------------

function renderGlobalSpeed() {
  gspeedValue.textContent = fmtSpeed(globalSpeed);
  gspeedDec.disabled = globalSpeed <= SPEED_MIN + 1e-9;
  gspeedInc.disabled = globalSpeed >= SPEED_MAX - 1e-9;
  gspeedReset.disabled = Math.abs(globalSpeed - SPEED_DEFAULT) < 1e-9;
  const n = overrides.size;
  gspeedNote.hidden = n === 0;
  gspeedNote.textContent = n === 1 ? '1 page override' : `${n} page overrides`;
}

// Global-speed saves are serialized: two rapid clicks must never store out
// of order — a slow earlier write completing late would regress the stored
// value (and every context's cache) to the older rate. While a save is
// pending, the storage-event reconcile stands down: an event carrying an
// older value of ours is not allowed to drag the optimistic display (or the
// queued writer's source value) back.
let gspeedSaveChain = Promise.resolve();
let gspeedWritesPending = 0;

async function changeGlobalSpeed(rate) {
  // optimistic: the storage event will confirm (and re-render) either way
  globalSpeed = clampSpeed(rate);
  renderGlobalSpeed();
  gspeedWritesPending++;
  gspeedSaveChain = gspeedSaveChain.then(async () => {
    await saveGlobalSpeed(globalSpeed);
    gspeedWritesPending--;
    renderGlobalSpeed(); // the final truth, after every queued write landed
  });
  await gspeedSaveChain;
}

function pageOverride(tabId) {
  if (pendingPageSpeed.has(tabId)) {
    const pending = pendingPageSpeed.get(tabId);
    if (pending === null) return null; // a reset is in flight
    return { url: '', rate: pending, at: 0 };
  }
  return overrides.get(tabId) ?? null;
}

async function stepPageSpeed(rec, delta) {
  if (!rec) return;
  // step FROM the observed/effective rate in exact 0.25 increments — a native
  // 1.10× becomes 1.35×, not the grid-snapped 1.25× (clampSpeed, not snapSpeed)
  const current = displayedSpeed(rec);
  await setPageSpeed(rec, clampSpeed(current + delta));
}

/**
 * The rate a card should display and step from. When a speed policy is being
 * enforced anywhere (global ≠ 1.00× or this page has an override), the policy
 * value is authoritative — the page manager enforces and reports it. At the
 * factory default (global 1.00×, no override) no manager exists, so the
 * website's ACTUAL observed rate is shown instead of assuming 1.00×.
 */
function displayedSpeed(rec) {
  const ov = pageOverride(rec.tab.id);
  if (ov) return ov.rate;
  if (Math.abs(globalSpeed - 1) > 1e-9) return globalSpeed;
  const element = primaryOfProbe(rec.probe)?.element;
  return element && Number.isFinite(element.rate) && element.rate > 0 ? element.rate : globalSpeed;
}

async function setPageSpeed(rec, rate) {
  if (!rec) return;
  // optimistic: the storage event reconciles; the background validates
  notePendingPageSpeed(rec.tab.id, rate);
  overrides.set(rec.tab.id, { url: rec.tab.url, rate, at: Date.now() });
  updateRow(rec);
  try {
    await chrome.runtime.sendMessage({ type: 'mcp-speed-page', tabId: rec.tab.id, rate });
  } catch {
    // no receiver (harness): the optimistic state still shows the choice
  }
}

async function resetPageSpeed(rec) {
  if (!rec) return;
  notePendingPageSpeed(rec.tab.id, null);
  overrides.delete(rec.tab.id);
  updateRow(rec);
  try {
    await chrome.runtime.sendMessage({ type: 'mcp-speed-reset', tabId: rec.tab.id });
  } catch {
    // no receiver (harness)
  }
}

// --- boost -------------------------------------------------------------------------------

function setBoostLocal(tabId, state) {
  if (state) boostStates.set(tabId, state);
  else boostStates.delete(tabId);
  const rec = rows.get(tabId);
  if (rec) updateRow(rec);
}

function scheduleBoostErrorClear(tabId) {
  const rec = rows.get(tabId);
  if (rec?.errorTimer !== undefined) clearTimeout(rec.errorTimer);
  const timer = setTimeout(() => {
    const cur = boostStates.get(tabId);
    if (cur?.state === 'error') setBoostLocal(tabId, undefined);
    const r = rows.get(tabId);
    if (r) r.errorTimer = undefined;
  }, 8000);
  if (rec) rec.errorTimer = timer;
}

/** A start that never reports back (hung capture) must not stay pending. */
function scheduleBoostResultTimeout(tabId) {
  setTimeout(() => {
    const cur = boostStates.get(tabId);
    if (cur?.state === 'pending') {
      setBoostLocal(tabId, { gain: cur.gain, state: 'error', error: 'Capture did not start' });
      scheduleBoostErrorClear(tabId);
    }
  }, 15000); // the worker converges its own state at 12 s; this is the belt
}

/**
 * Enable boost: the click lands here and the command goes to the worker,
 * which owns the whole capture flow (it calls tabCapture.getMediaStreamId in
 * the docs-blessed service-worker → offscreen consumer path; the user gesture
 * rides the extension message). Any failure lands in a truthful error state —
 * never a fake "active".
 */
async function boostEnable(rec, pct) {
  if (!rec || rec.boostStarting) return;
  rec.boostStarting = true;
  setBoostLocal(rec.tab.id, { gain: pct, state: 'pending' });
  try {
    await chrome.runtime.sendMessage({
      type: 'mcp-boost-start',
      tabId: rec.tab.id,
      gain: pct,
    });
    scheduleBoostResultTimeout(rec.tab.id);
  } catch (e) {
    setBoostLocal(rec.tab.id, { gain: pct, state: 'error', error: errText(e) });
    scheduleBoostErrorClear(rec.tab.id);
  }
  rec.boostStarting = false;
  updateRow(rec);
}

async function boostDisable(rec) {
  if (!rec) return;
  // stop means stop: no pending gain update may fire afterwards, and the
  // pipeline is released even if the start is still in flight
  if (rec.boostTimer !== undefined) {
    clearTimeout(rec.boostTimer);
    rec.boostTimer = undefined;
  }
  rec.pendingBoost = null;
  rec.boostStarting = false;
  setBoostLocal(rec.tab.id, undefined);
  try {
    await chrome.runtime.sendMessage({ type: 'mcp-boost-stop', tabId: rec.tab.id });
  } catch {
    // no receiver (harness): the optimistic state still shows the reset
  }
}

// Boost results that only the offscreen document can report (its getUserMedia
// step failed after the background already accepted the start).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type !== 'mcp-boost-result' || msg.ok !== false) return;
  if (typeof msg.tabId !== 'number') return;
  setBoostLocal(msg.tabId, {
    gain: Number(msg.gain) || 100,
    state: 'error',
    error: String(msg.error ?? 'Capture failed'),
  });
  scheduleBoostErrorClear(msg.tabId);
});

// --- card rendering --------------------------------------------------------------------

/**
 * Fold authoritative tabs.* fields into a row. `chrome.tabs.update` resolves
 * with the post-change Tab, and focus reconciles read `chrome.tabs.get`, so
 * the mute icon (and every other tab-derived readout) reflects the browser,
 * not a possibly-missed event.
 */
function applyTabState(rec, tab) {
  if (!rec || !tab) return;
  if (tab.url !== undefined) rec.tab.url = tab.url;
  if (tab.title !== undefined) rec.tab.title = tab.title;
  if (tab.favIconUrl !== undefined) rec.tab.favIconUrl = tab.favIconUrl;
  if (tab.audible !== undefined) rec.tab.audible = tab.audible;
  if (tab.mutedInfo !== undefined) rec.tab.mutedInfo = tab.mutedInfo;
  if (tab.index !== undefined) rec.tab.index = tab.index;
  updateRow(rec);
  refreshChrome();
}

/**
 * Re-read every listed tab once. Event-driven callers only (popup focus and
 * right after a mute command) — this is not a polling loop.
 */
let reconcileInFlight = null;
function reconcileTabState() {
  if (reconcileInFlight) return reconcileInFlight;
  const startedAt = Date.now();
  reconcileInFlight = Promise.allSettled(
    [...rows.values()].map(async (rec) => {
      try {
        const tab = await chrome.tabs.get(rec.tab.id);
        // a mute command issued after this read began owns the row's state
        if (rows.get(rec.tab.id) === rec && startedAt >= rec.muteCommandAt) {
          applyTabState(rec, tab);
        }
      } catch {
        // tab gone; tabs.onRemoved owns the cleanup
      }
    }),
  ).finally(() => {
    reconcileInFlight = null;
  });
  return reconcileInFlight;
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
  nodes.title.title = titleText; // free full-text tooltip for truncated titles

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
  nodes.pinBtn.querySelector('.menu-label').textContent =
    tab.id === pinnedTabId ? 'Unpin target' : 'Pin as target';

  // track adapters follow the tab's current site: the buttons keep their
  // place in the timeline and speak through disabled state, not visibility
  rec.adapter = adapterFor(tab.url);
  const known = rec.adapterState;
  nodes.prevBtn.disabled = !rec.adapter || (known?.prev ? !known.prev.found || known.prev.disabled : false);
  nodes.nextBtn.disabled = !rec.adapter || (known?.next ? !known.next.found || known.next.disabled : false);
  nodes.prevBtn.title = rec.adapter
    ? known?.prev && !known.prev.found
      ? 'This site has no previous-track control'
      : 'Previous track'
    : 'Previous track — not available on this site';
  nodes.nextBtn.title = rec.adapter
    ? known?.next && !known.next.found
      ? 'This site has no next-track control'
      : known?.next?.disabled
        ? 'No next track'
        : 'Next track'
    : 'Next track — not available on this site';

  // identity: mediaSession artwork when available, favicon otherwise, letter
  // tile as the last resort
  const artUrl = rec.probe?.artwork;
  const favUrl = tab.favIconUrl;
  if (artUrl && /^(https?:|data:)/.test(artUrl)) {
    if (nodes.artwork.src !== artUrl) nodes.artwork.src = artUrl;
    nodes.artwork.hidden = false;
    nodes.artwork.onerror = () => {
      nodes.artwork.hidden = true;
      applyFavicon(favUrl);
    };
    nodes.fav.hidden = true;
    nodes.favLetter.hidden = true;
  } else {
    nodes.artwork.hidden = true;
    applyFavicon(favUrl);
  }

  function applyFavicon(url) {
    nodes.favLetter.textContent = (host || titleText || '?').charAt(0).toUpperCase();
    if (url && /^(https?:|data:)/.test(url)) {
      if (nodes.fav.src !== url) nodes.fav.src = url;
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
    }
  }

  if (!nodes.li.parentNode) listEl.append(nodes.li);

  // ping loop follows playing state; stopPing syncs once on pause
  if (rec.playing && rec.probe && !rec.ping) startPing(rec);
  if (rec.ping && !rec.playing) stopPing(rec);
  syncCard(rec);
}

/** Fill a card's values from probe + policy state. The single render path. */
function syncCard(rec) {
  const n = rec.nodes;
  const disabled = !rec.probe;

  // Policy and pipeline-state readouts render even mid-drag: they are not
  // user-dragged values, and a held drag must never freeze truthful state.
  const ov = pageOverride(rec.tab.id);
  const policyActive = Math.abs(globalSpeed - 1) > 1e-9 || !!ov;
  const element = primaryOfProbe(rec.probe)?.element;
  // With no policy in force the manager is inactive, so the honest display is
  // the rate the page is ACTUALLY running (probed/pinged), not the global.
  const rate = displayedSpeed(rec);
  n.rateReadout.textContent = fmtSpeed(rate);
  n.speedCluster.classList.toggle('overridden', !!ov);
  n.rateReset.hidden = !ov;
  n.speedCluster.title = ov
    ? `Page override ${fmtSpeed(ov.rate)} — global is ${fmtSpeed(globalSpeed)}`
    : !policyActive && element && Math.abs(rate - globalSpeed) > 1e-9
      ? `Website-set rate ${fmtSpeed(rate)} — global is ${fmtSpeed(globalSpeed)}`
      : `Inherits global speed (${fmtSpeed(globalSpeed)})`;

  // boost chip + popover status: truthful state only — pending, active,
  // error, or off. Starting a boost is offered for the viewed tab only
  // (tabCapture targets need the activeTab grant); an existing boost stays
  // visible and stoppable from any card.
  const bs = boostStates.get(rec.tab.id);
  const boostPct = bs?.gain ?? 100;
  const boostStartable = rec.tab.id === activeTabId;
  const chipReadout = n.boostBtn.querySelector('.boost-readout');
  if (bs?.state === 'pending') {
    chipReadout.textContent = '…';
    n.boostBtn.classList.add('active');
    n.boostBtn.title = 'Starting tab boost…';
  } else if (bs?.state === 'active') {
    chipReadout.textContent = `${boostPct}%`;
    n.boostBtn.classList.add('active');
    n.boostBtn.title = `Tab boost ${boostPct}% — click for controls`;
  } else {
    chipReadout.textContent = '100%';
    n.boostBtn.classList.remove('active');
    n.boostBtn.title =
      bs?.state === 'error'
        ? `Boost failed: ${bs.error}`
        : boostStartable
          ? 'Tab volume boost'
          : 'Boost captures the tab you are viewing — switch to this tab first';
  }
  n.boostPopReadout.textContent = `${boostPct}%`;
  n.boostStatus.textContent = bs?.state === 'error' ? bs.error : '';
  n.boostStatus.classList.toggle('error', bs?.state === 'error');
  n.boostReset.disabled = !bs || bs.state === 'pending';

  // Below: values the user may be holding — the render must not fight the
  // hand while a slider is dragged.
  if (rec.dragging) return;

  n.pos.disabled = n.vol.disabled = disabled;
  n.pipBtn.disabled = disabled;
  n.back10.disabled = n.fwd10.disabled = disabled;
  n.rateDec.disabled = n.rateInc.disabled = disabled;
  n.boostBtn.disabled = disabled || (!bs && !boostStartable);

  if (element) {
    const live = element.duration === -1;
    n.pos.closest('.card-timeline').classList.toggle('live', live);
    // seeking is meaningless on live streams: the ±10 s buttons stay in
    // place and truthfully disabled rather than no-op
    n.back10.disabled = n.fwd10.disabled = disabled || live;
    if (!live) {
      n.pos.max = String(Math.floor(element.duration));
      n.pos.value = String(Math.floor(element.currentTime));
      setFill(n.pos);
      n.posReadout.textContent = `${fmtTime(element.currentTime)} / ${fmtTime(element.duration)}`;
    }
    if (rec.openPopover === 'vol' && rec.pendingVolume === null) {
      n.vol.value = String(element.volume);
      setFill(n.vol);
      n.volReadout.textContent = `${Math.round(element.volume * 100)}%`;
    }
    n.volBtn.title = `Volume ${Math.round(element.volume * 100)}%`;
    // PiP only where it is applicable: video media
    n.pipBtn.hidden = element.tag !== 'video';
    n.pipBtn.classList.toggle('on', !!rec.pip);
  } else {
    n.posReadout.textContent = '—';
    n.volReadout.textContent = '—';
    n.pipBtn.hidden = true;
  }

  if (rec.pendingBoost === null) {
    n.boost.value = String(boostStates.get(rec.tab.id)?.gain ?? 100);
    setFill(n.boost);
  }
}

/** Order: pinned target, playing, then the rest; stable within groups. */
function reorder() {
  const order = [...rows.values()].sort((a, b) => {
    const rank = (r) => (r.tab.id === pinnedTabId ? 0 : r.playing ? 1 : 2);
    return rank(a) - rank(b) || a.tab.index - b.tab.index || a.tab.id - b.tab.id;
  });
  for (const rec of order) listEl.append(rec.nodes.li);
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

/** Site-button selectors for the tab's adapter, or null when it has none. */
function siteSelectors(rec) {
  return rec.adapter ? { next: rec.adapter.nextSel, prev: rec.adapter.prevSel } : null;
}

/** One cheap pagePing on the primary frame; refreshes card readouts. */
async function pingNow(rec) {
  if (!rec?.probe) return null;
  const startedAt = Date.now();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, frameIds: [rec.probe.primaryFrameId] },
      func: pagePing,
      args: [siteSelectors(rec)],
    });
    // the row may have been removed while the ping was in flight — a late
    // result must never resurrect its card into the DOM
    if (rows.get(rec.tab.id) !== rec) return null;
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
    if (state.siteButtons) rec.adapterState = state.siteButtons;
    // a ping captured before the newest command landed — or while a command
    // is still in flight — is stale: the command's play state outranks it
    // (element readouts are still good either way)
    if (startedAt >= rec.commandAt && !rec.commandPending) {
      rec.mediaPlaying = state.playing;
      rec.pip = !!state.pip;
    }
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
  if (rec.probe) void pingNow(rec); // one last sync after pause
}

// --- global actions and pinned target ------------------------------------------------

async function pauseAll() {
  const jobs = [...rows.values()].filter((r) => r.playing).map(async (rec) => {
    rec.mediaPlaying = false;
    // mark the ordering BEFORE dispatch: any ping or probe already in flight
    // is stale and must not flip this tab back to playing; the pending flag
    // also covers pings dispatched after the mark but racing the pause
    rec.commandAt = Date.now();
    rec.commandPending = true;
    updateRow(rec);
    try {
      // all frames: media can live in embeds outside the primary frame
      await chrome.scripting.executeScript({
        target: { tabId: rec.tab.id, allFrames: true },
        func: pagePause,
      });
    } catch {
      // tab gone; onRemoved cleans up
    } finally {
      rec.commandPending = false;
    }
  });
  await Promise.allSettled(jobs);
  refreshChrome();
  reorder();
}

async function muteAll() {
  const allMuted = rows.size > 0 && [...rows.values()].every((r) => r.tab.mutedInfo?.muted);
  const target = !allMuted;
  // Apply the resolved Tab of each update immediately (same truth the
  // onUpdated event carries), so the header label and every card stay in
  // sync even if an event is missed while the popup regains focus.
  await Promise.allSettled(
    [...rows.values()]
      .filter((r) => !!r.tab.mutedInfo?.muted !== target)
      .map(async (r) => {
        try {
          r.muteCommandAt = Date.now();
          const updated = await chrome.tabs.update(r.tab.id, { muted: target });
          if (updated) applyTabState(r, updated);
        } catch {
          // tab gone; onRemoved cleans up
        }
      }),
  );
  await reconcileTabState();
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
  reorder();
  updateTargetReadout();
}

function updateTargetReadout() {
  const rec = pinnedTabId !== null ? rows.get(pinnedTabId) : null;
  targetEl.textContent = rec
    ? `Target · ${hostOf(rec.tab.url) || 'system page'}`
    : 'Target none';
  targetEl.classList.toggle('set', !!rec);
}

/** executeScript helper targeting the primary frame. */
async function exec(rec, func, args) {
  if (!rec?.probe) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, frameIds: [rec.probe.primaryFrameId] },
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
  pendingPageSpeed.delete(tabId);
  rec.probe = null; // no last-sync ping on removal — dead rows stay dead
  stopPing(rec);
  if (rec.volTimer !== undefined) {
    clearTimeout(rec.volTimer);
    rec.volTimer = undefined;
  }
  if (rec.boostTimer !== undefined) {
    clearTimeout(rec.boostTimer);
    rec.boostTimer = undefined;
  }
  if (rec.errorTimer !== undefined) {
    clearTimeout(rec.errorTimer);
    rec.errorTimer = undefined;
  }
  rec.nodes.li.remove();
  rows.delete(tabId);
  if (pinnedTabId === tabId) {
    pinnedTabId = null;
    void chrome.storage.session.remove('target').catch(() => {});
    updateTargetReadout();
  }
  refreshChrome();
  reorder();
}

async function togglePlay(rec, { exclusive } = {}) {
  if (!rec) return;
  if (exclusive) {
    await playExclusive(rec);
    return;
  }
  rec.mediaPlaying = rec.playing ? false : true;
  rec.commandAt = Date.now(); // in-flight pings/probes are stale from here
  rec.commandPending = true;
  updateRow(rec);
  reorder();
  try {
    await chrome.scripting.executeScript({ target: targetFor(rec), func: pageToggle });
  } catch {
    // uninjectable tab (chrome://, sandboxed frame): the command never landed,
    // so fall back to the truth we know instead of the optimistic guess
    rec.mediaPlaying = null;
    updateRow(rec);
  } finally {
    rec.commandPending = false;
  }
}

/**
 * Exclusive playback, the Alt+click play: the chosen tab starts, every other
 * playing tab pauses. The chosen tab goes first and only a landed command
 * (the target really held playable media) triggers the pauses — an
 * uninjectable or empty target must never silence the rest.
 */
async function playExclusive(rec) {
  let played = false;
  rec.commandPending = true;
  try {
    const results = await chrome.scripting.executeScript({
      target: targetFor(rec),
      func: pagePlay,
    });
    played = results[0]?.result?.acted === true;
  } catch {
    played = false; // uninjectable tab; the world stays as it was
  } finally {
    rec.commandPending = false;
  }
  if (!played) return;
  rec.mediaPlaying = true;
  rec.commandAt = Date.now();
  updateRow(rec);
  const jobs = [...rows.values()]
    .filter((r) => r !== rec && r.playing)
    .map(async (other) => {
      other.mediaPlaying = false;
      other.commandAt = Date.now(); // in-flight pings/probes are stale
      other.commandPending = true;
      updateRow(other);
      try {
        // all frames: media can live in embeds outside the primary frame
        await chrome.scripting.executeScript({
          target: { tabId: other.tab.id, allFrames: true },
          func: pagePause,
        });
      } catch {
        // tab gone; onRemoved cleans up
      } finally {
        other.commandPending = false;
      }
    });
  await Promise.allSettled(jobs);
  refreshChrome();
  reorder();
}

/** Next/previous track through the site's own player buttons. */
async function runAdapter(rec, direction) {
  if (!rec?.adapter) return;
  try {
    await chrome.scripting.executeScript({
      target: targetFor(rec),
      func: direction === 'next' ? rec.adapter.next : rec.adapter.prev,
    });
  } catch {
    // tab gone or uninjectable; nothing to correct
  }
}

async function muteTab(rec) {
  if (!rec) return;
  // Read the browser's real state before toggling: the card can be a stale
  // snapshot (the tab strip, a keyboard command or another context can mute
  // it), and a toggle computed from a stale icon would issue the wrong
  // command. One authoritative read, one update — never a repeated mute.
  let tab;
  try {
    tab = await chrome.tabs.get(rec.tab.id);
  } catch {
    return; // tab gone
  }
  const muted = !tab.mutedInfo?.muted;
  rec.muteCommandAt = Date.now();
  try {
    const updated = await chrome.tabs.update(rec.tab.id, { muted });
    applyTabState(rec, updated ?? { ...tab, mutedInfo: { muted, reason: 'extension' } });
  } catch {
    // the command did not land: fall back to the browser's truth
    void reconcileTabState();
  }
}

/** Injection target: the primary frame when probed, all frames otherwise. */
function targetFor(rec) {
  return rec.probe
    ? { tabId: rec.tab.id, frameIds: [primaryOfProbe(rec.probe)?.frameId] }
    : { tabId: rec.tab.id, allFrames: true };
}

// --- settings -----------------------------------------------------------------------

function setSettingsOpen(open) {
  settingsOpen = open;
  settingsEl.classList.toggle('open', open);
  settingsEl.toggleAttribute('inert', !open);
  settingsBtn.setAttribute('aria-expanded', String(open));
  settingsBtn.classList.toggle('on', open);
}

/** Turning the recent list off drops the rows that existed only because of it. */
function pruneRecentOnlyRows() {
  void chrome.storage.session.remove('recent').catch(() => {});
  for (const rec of [...rows.values()]) {
    const t = rec.tab;
    // sound, muted, element-playing and pinned tabs earn their place on their own
    if (!rec.playing && !t.audible && !t.mutedInfo?.muted && t.id !== pinnedTabId) {
      removeRow(t.id);
    }
  }
}

async function changeSetting(key, value) {
  settings = await saveSettings({ ...settings, [key]: value });
  if (key === 'recentTabs' && !value) pruneRecentOnlyRows();
  return settings;
}

/** Apply the appearance preference to the whole popup surface. */
function applyTheme(theme) {
  document.documentElement.dataset.theme = THEMES.includes(theme) ? theme : 'system';
}

/** Reflect the stored preference on the segmented control. */
function renderTheme() {
  for (const btn of themeButtons) {
    btn.setAttribute('aria-checked', String(btn.dataset.themeValue === settings.theme));
  }
}

// --- probe ------------------------------------------------------------------------

/** Land a probe result on a record: primary truth + pip state, then render. */
function applyProbe(rec, probe) {
  rec.probe = probe;
  if (probe?.siteButtons) rec.adapterState = probe.siteButtons;
  const primary = probe ? primaryOfProbe(probe) : null;
  // A probe captured before the newest command landed is stale: the command's
  // optimistic play state (rec.mediaPlaying) outranks it. Element data and pip
  // stay valid either way; a null probe leaves no element truth at all.
  const stale = !!probe && probe.at < rec.commandAt;
  if (!stale) rec.mediaPlaying = probe ? (primary?.element.playing ?? null) : null;
  rec.pip = probe
    ? !!probe.frames.find((f) => f.frameId === rec.probe.primaryFrameId)?.pip
    : false;
  updateRow(rec);
}

async function probeTab(rec) {
  const startedAt = Date.now();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, allFrames: true },
      func: pageProbe,
      args: [siteSelectors(rec)],
    });
    const frames = results
      .filter((r) => r.result && r.result.elements && r.result.elements.length)
      .map((r) => ({ frameId: r.frameId, ...r.result }));
    if (!frames.length) return null;
    let elementCount = 0;
    for (const f of frames) elementCount += f.elements.length;
    const primary = primaryOfProbe({ frames });
    // site-button availability: prefer a frame that actually found one
    const siteButtons = frames.map((f) => f.siteButtons).find((s) => s?.next.found || s?.prev.found) ?? null;
    return {
      frames,
      primaryFrameId: primary?.frameId ?? frames[0].frameId,
      elementCount,
      artwork: frames.map((f) => f.artwork).find(Boolean) ?? null,
      siteButtons,
      at: startedAt,
    };
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
      void chrome.tabs
        .get(tabId)
        .then((tab) => {
          if (!tab || rows.has(tabId)) return;
          void adoptTab(tab);
        })
        .catch(() => {}); // tab closed before we could look
    }
    return;
  }
  // The event payload is authoritative for the fields it carries, and
  // applyTabState is the single truth path for tab-derived controls.
  applyTabState(rec, info);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  removeRow(tabId);
});

// An action popup can lose and regain focus (or the popup-as-page document
// can be backgrounded). Re-read the listed tabs once on return instead of
// trusting a possibly-missed event; this is focus-driven, not a poll.
const reconcileOnReturn = () => {
  if (document.visibilityState !== 'hidden') void reconcileTabState();
};
window.addEventListener('focus', reconcileOnReturn);
document.addEventListener('visibilitychange', reconcileOnReturn);

// --- keyboard navigation -------------------------------------------------------------
//
// Arrows move focus between cards (landing on the card's play button; Tab then
// reaches the card's other controls natively), Home/End jump to first/last,
// and Left/Right seek ±10 s on the focused card. While a slider has focus,
// all four arrows belong to the slider instead. Pure convenience over the
// native tab order — every control stays reachable by Tab alone.

function rowRecords() {
  const byNode = new Map([...rows.values()].map((r) => [r.nodes.li, r]));
  return [...listEl.querySelectorAll('.row')].map((li) => byNode.get(li));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const anyPopover = [...rows.values()].some((r) => r.openPopover);
    if (anyPopover) {
      e.preventDefault();
      for (const r of rows.values()) closePopover(r);
      return;
    }
    if (settingsOpen) {
      e.preventDefault();
      setSettingsOpen(false);
      return;
    }
  }
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const recs = rowRecords();
  if (!recs.length) return;

  const active = document.activeElement;
  const onInput = active?.tagName === 'INPUT';
  const activeRow = active?.closest?.('.row');
  const idx = recs.findIndex((r) => r.nodes.li === activeRow);
  const focusPlay = (rec) => rec?.nodes.playBtn.focus();

  // all four arrows belong to a focused slider (a range input adjusts with
  // every one of them); card navigation only applies outside inputs
  if (e.key === 'ArrowDown' && !onInput) {
    e.preventDefault();
    focusPlay(recs[idx === -1 ? 0 : (idx + 1) % recs.length]);
  } else if (e.key === 'ArrowUp' && !onInput) {
    e.preventDefault();
    focusPlay(recs[idx === -1 ? recs.length - 1 : (idx - 1 + recs.length) % recs.length]);
  } else if (e.key === 'Home' && !onInput) {
    e.preventDefault();
    focusPlay(recs[0]);
  } else if (e.key === 'End' && !onInput) {
    e.preventDefault();
    focusPlay(recs[recs.length - 1]);
  } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !onInput && idx !== -1) {
    const rec = recs[idx];
    if (rec.probe) {
      e.preventDefault();
      void exec(rec, pageSeekBy, { seconds: e.key === 'ArrowRight' ? 10 : -10 });
      setTimeout(() => void pingNow(rec), 120);
    }
  }
});

async function adoptTab(tab) {
  const rec = makeRow(tab);
  reorder();
  const probe = await probeTab(rec);
  if (!rows.has(tab.id)) return; // tab closed while probing
  applyProbe(rec, probe);
  refreshChrome();
}

// --- init ----------------------------------------------------------------------------

function buildHints() {
  if (/Mac/.test(navigator.userAgent)) {
    hintsEl.textContent = '⌥⇧P Pause all · ⌥⇧M Mute all';
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
    chrome.storage.session.get(['target', 'recent', 'speedOverrides', 'boosts']).catch(() => ({})),
  ]);
  settings = await loadSettings();
  applyTheme(settings.theme);
  renderTheme();
  globalSpeed = await loadGlobalSpeed();
  overrides = new Map(
    Object.entries(
      stored.speedOverrides && typeof stored.speedOverrides === 'object' ? stored.speedOverrides : {},
    ).map(([k, v]) => [Number(k), v]),
  );
  boostStates = new Map(
    Object.entries(
      stored.boosts && typeof stored.boosts === 'object' ? stored.boosts : {},
    ).map(([k, v]) => [Number(k), v]),
  );
  settingsBtn.addEventListener('click', () => setSettingsOpen(!settingsOpen));
  for (const [key, input] of Object.entries(settingInputs)) {
    input.checked = settings[key];
    input.addEventListener('change', () => void changeSetting(key, input.checked));
  }
  for (const btn of themeButtons) {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.themeValue;
      if (settings.theme === theme) return;
      // optimistic repaint; storage confirms through its change event
      settings = { ...settings, theme };
      applyTheme(theme);
      renderTheme();
      void changeSetting('theme', theme).then(() => {
        applyTheme(settings.theme);
        renderTheme();
      });
    });
  }
  gspeedDec.addEventListener('click', () => void changeGlobalSpeed(globalSpeed - SPEED_STEP));
  gspeedInc.addEventListener('click', () => void changeGlobalSpeed(globalSpeed + SPEED_STEP));
  gspeedReset.addEventListener('click', () => void changeGlobalSpeed(SPEED_DEFAULT));
  renderGlobalSpeed();

  pinnedTabId = typeof stored.target === 'number' ? stored.target : null;
  const recentIds = Array.isArray(stored.recent)
    ? stored.recent.filter((n) => typeof n === 'number')
    : [];

  // keep popup state in sync with the stores the background owns: global
  // speed, page overrides, boost truth, and the pinned target
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      // another popup context (or a manual write) changed a preference:
      // adopt the stored truth and repaint the surface
      void loadSettings().then((s) => {
        settings = s;
        applyTheme(s.theme);
        renderTheme();
        for (const [key, input] of Object.entries(settingInputs)) input.checked = s[key];
      });
    }
    if (area === 'local' && changes.speed) {
      // while our own serialized writes are in flight, an event carrying an
      // older value is a late echo of an earlier click — never a newer truth
      if (gspeedWritesPending > 0) return;
      globalSpeed = clampSpeed(changes.speed.newValue);
      renderGlobalSpeed();
      for (const r of rows.values()) updateRow(r);
    }
    if (area === 'session' && changes.speedOverrides) {
      const next = new Map(
        Object.entries(changes.speedOverrides.newValue ?? {}).map(([k, v]) => [Number(k), v]),
      );
      // the user's latest optimistic choice outranks a late echo of an
      // earlier page-speed command; a matching event confirms and clears it
      for (const [tabId, pending] of pendingPageSpeed) {
        const incoming = next.get(tabId);
        const confirmed =
          pending === null ? !incoming : !!incoming && Math.abs(incoming.rate - pending) < 1e-9;
        if (confirmed) pendingPageSpeed.delete(tabId);
        else if (pending === null) next.delete(tabId);
        else next.set(tabId, { url: incoming?.url ?? '', rate: pending, at: Date.now() });
      }
      overrides = next;
      renderGlobalSpeed();
      for (const r of rows.values()) updateRow(r);
    }
    if (area === 'session' && changes.boosts) {
      boostStates = new Map(
        Object.entries(changes.boosts.newValue ?? {}).map(([k, v]) => [Number(k), v]),
      );
      for (const r of rows.values()) updateRow(r);
    }
    if (area !== 'session' || !('target' in changes)) return;
    const v = changes.target.newValue;
    const next = typeof v === 'number' ? v : null;
    if (next !== pinnedTabId) {
      pinnedTabId = next;
      for (const r of rows.values()) updateRow(r);
      reorder();
    }
    updateTargetReadout();
  });

  // the viewed tab decides where boost may START (tabCapture targets need the
  // activeTab grant — only the viewed tab carries it). Real popups close when
  // focus moves, so this mostly matters for the popup-as-page test context.
  try {
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = typeof current?.id === 'number' ? current.id : null;
  } catch {
    activeTabId = null;
  }
  chrome.tabs.onActivated?.addListener?.(({ tabId }) => {
    activeTabId = tabId;
    for (const r of rows.values()) updateRow(r);
  });

  // ask the background to reconcile speed enforcement and the boost pipeline
  // once while we show the list — closes the gap for pages that predate the
  // worker's last wake
  chrome.runtime.sendMessage({ type: 'mcp-speed-sync' }).catch(() => {});

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
  reorder();
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

  // Opt-in auto-pause, strictly after the probes settle: the pause command
  // then can never race a probe snapshot back into phantom playing state,
  // and the rows show what was playing the instant the popup opened.
  if (settings.autoPauseOnOpen) await pauseAll();
  reorder();
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

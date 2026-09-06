// Side panel UI. Renders one card per media session; owns the keep-alive ping
// that keeps the service worker alive while the panel is open.

import { PANEL_PORT, SEEK_STEP_SECONDS } from '../shared/protocol';
import type { MediaCommand, MediaSessionInfo, PanelInbound, PanelOutbound } from '../shared/protocol';
import { clampRate, loadSettings, saveSettings } from '../shared/settings';
import type { Settings } from '../shared/settings';

const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zm8 0h4v14h-4z"/></svg>';
const ICON_SOUND =
  '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 7.5a6 6 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const ICON_MUTED =
  '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16 9l5 6m0-6l-5 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

// --- state ---------------------------------------------------------------------

const sessions = new Map<string, MediaSessionInfo>();
const cards = new Map<string, Card>();
let pinnedKey: string | null = null;
let port: chrome.runtime.Port | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

interface Card {
  root: HTMLDivElement;
  update(info: MediaSessionInfo): void;
}

// --- messaging -------------------------------------------------------------------

function connect(): void {
  if (reconnectTimer !== undefined) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  port = chrome.runtime.connect({ name: PANEL_PORT });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    port = null;
    reconnectTimer = setTimeout(connect, 1000);
  });
}

function send(msg: PanelInbound): void {
  port?.postMessage(msg);
}

function command(key: string, cmd: MediaCommand): void {
  send({ type: 'command', key, command: cmd });
}

// Keep the service worker alive while the panel exists; if it was reaped while
// the panel was hidden, reconnect as soon as the panel is visible again.
setInterval(() => send({ type: 'ping' }), 20_000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !port) connect();
});

function onMessage(msg: PanelOutbound): void {
  switch (msg.type) {
    case 'sessions':
      sessions.clear();
      for (const s of msg.sessions) sessions.set(s.key, s);
      reconcile();
      break;
    case 'patch': {
      const info = sessions.get(msg.key);
      if (!info) break;
      info.element = { ...info.element, ...msg.patch };
      cards.get(msg.key)?.update(info);
      break;
    }
    case 'pinned':
      pinnedKey = msg.key;
      for (const [key, card] of cards) card.root.classList.toggle('pinned', key === pinnedKey);
      break;
    case 'pong':
      break;
  }
}

// --- layout ----------------------------------------------------------------------

const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
  <header class="header">
    <span class="header-title">Media</span>
    <span class="header-spacer"></span>
    <button id="pause-all" class="btn subtle" title="Pause every media item">Pause all</button>
    <button id="mute-all" class="btn subtle" title="Mute every media item">Mute all</button>
  </header>
  <main id="list" class="list"></main>
  <div id="empty" class="empty">
    No media detected.<br />Play a video or audio in any tab and it will show up here.
  </div>
  <footer class="footer">
    <label class="footer-row">
      <input type="checkbox" id="global-rate-enabled" />
      <span>Default speed for new media</span>
    </label>
    <div class="footer-row" id="global-rate-row">
      <input type="range" id="global-rate" min="0.25" max="4" step="0.05" />
      <span id="global-rate-value"></span>
    </div>
    <p class="footer-hint">Applied when media appears or starts playing; per-item changes win.</p>
  </footer>
`;
const listEl = document.getElementById('list') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const pauseAllBtn = document.getElementById('pause-all') as HTMLButtonElement;
const muteAllBtn = document.getElementById('mute-all') as HTMLButtonElement;

pauseAllBtn.addEventListener('click', () => send({ type: 'pause-all' }));
muteAllBtn.addEventListener('click', () => {
  const allMuted = sessions.size > 0 && [...sessions.values()].every((s) => s.element.muted);
  send({ type: 'mute-all', muted: !allMuted });
});

function updateHeaderState(): void {
  const allMuted = sessions.size > 0 && [...sessions.values()].every((s) => s.element.muted);
  pauseAllBtn.disabled = sessions.size === 0;
  muteAllBtn.disabled = sessions.size === 0;
  muteAllBtn.textContent = allMuted ? 'Unmute all' : 'Mute all';
}

// --- global settings -----------------------------------------------------------------

let settings: Settings = { globalRateEnabled: false, globalRate: 1 };
const globalRateEnabled = document.getElementById('global-rate-enabled') as HTMLInputElement;
const globalRate = document.getElementById('global-rate') as HTMLInputElement;
const globalRateValue = document.getElementById('global-rate-value') as HTMLElement;
const globalRateRow = document.getElementById('global-rate-row') as HTMLElement;

function renderSettings(): void {
  globalRateEnabled.checked = settings.globalRateEnabled;
  globalRateRow.classList.toggle('disabled', !settings.globalRateEnabled);
  globalRate.value = String(Math.min(4, Math.max(0.25, settings.globalRate)));
  globalRateValue.textContent = fmtRate(settings.globalRate);
}

globalRateEnabled.addEventListener('change', () => {
  void saveSettings({ globalRateEnabled: globalRateEnabled.checked });
});
globalRate.addEventListener('input', () => {
  const rate = clampRate(Number(globalRate.value));
  globalRateValue.textContent = fmtRate(rate);
  void saveSettings({ globalRate: rate });
});

void loadSettings().then((s) => {
  settings = s;
  renderSettings();
});

function reconcile(): void {
  const seen = new Set<string>();
  for (const info of sessions.values()) {
    seen.add(info.key);
    let card = cards.get(info.key);
    if (!card) {
      card = createCard(info);
      cards.set(info.key, card);
      listEl.appendChild(card.root);
    }
    card.update(info);
  }
  for (const [key, card] of cards) {
    if (!seen.has(key)) {
      card.root.remove();
      cards.delete(key);
    }
  }
  emptyEl.classList.toggle('hidden', sessions.size > 0);
  updateHeaderState();
}

// --- utils -------------------------------------------------------------------------

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url || 'unknown source';
  }
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '–:––';
  const total = Math.floor(seconds);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

function fmtRate(rate: number): string {
  return `${Math.round(rate * 100) / 100}\u00d7`;
}

// --- cards --------------------------------------------------------------------------

function createCard(initial: MediaSessionInfo): Card {
  let info = initial;
  const root = document.createElement('div');
  root.className = 'card';
  root.innerHTML = `
    <div class="card-main">
      <img class="favicon" alt="" />
      <span class="favicon-fallback"></span>
      <div class="titles">
        <span class="title"></span>
        <span class="subtitle"></span>
      </div>
      <button class="btn pin" title="Send commands and shortcuts to this item">&#128204;</button>
    </div>
    <div class="progress-row">
      <span class="time time-cur"></span>
      <input class="seek" type="range" min="0" max="0" step="0.1" />
      <span class="time time-dur"></span>
    </div>
    <div class="controls-row">
      <button class="btn transport seek-back" title="Back 10 seconds">&minus;${SEEK_STEP_SECONDS}s</button>
      <button class="btn transport play" title="Play / pause"></button>
      <button class="btn transport seek-fwd" title="Forward 10 seconds">+${SEEK_STEP_SECONDS}s</button>
      <button class="btn mute" title="Mute / unmute"></button>
      <input class="volume" type="range" min="0" max="1" step="0.01" title="Volume" />
      <span class="vol-label"></span>
    </div>
    <div class="rate-row">
      <span class="rate-label">Speed</span>
      <input class="rate" type="range" min="0.25" max="4" step="0.05" title="Playback speed" />
      <span class="rate-value"></span>
    </div>
  `;
  const main = root.querySelector('.card-main') as HTMLDivElement;
  const favicon = root.querySelector('.favicon') as HTMLImageElement;
  const favFallback = root.querySelector('.favicon-fallback') as HTMLSpanElement;
  const titleEl = root.querySelector('.title') as HTMLElement;
  const subEl = root.querySelector('.subtitle') as HTMLElement;
  const timeCur = root.querySelector('.time-cur') as HTMLElement;
  const seek = root.querySelector('.seek') as HTMLInputElement;
  const timeDur = root.querySelector('.time-dur') as HTMLElement;
  const playBtn = root.querySelector('.play') as HTMLButtonElement;
  const muteBtn = root.querySelector('.mute') as HTMLButtonElement;
  const volume = root.querySelector('.volume') as HTMLInputElement;
  const volLabel = root.querySelector('.vol-label') as HTMLElement;
  const rate = root.querySelector('.rate') as HTMLInputElement;
  const rateValue = root.querySelector('.rate-value') as HTMLElement;

  main.addEventListener('click', () => send({ type: 'focus-tab', tabId: info.tabId }));
  (root.querySelector('.pin') as HTMLButtonElement).addEventListener('click', (e) => {
    e.stopPropagation();
    send({ type: 'pin', key: pinnedKey === info.key ? null : info.key });
  });
  playBtn.addEventListener('click', () => command(info.key, { kind: 'toggle' }));
  (root.querySelector('.seek-back') as HTMLButtonElement).addEventListener('click', () =>
    command(info.key, { kind: 'seek-by', seconds: -SEEK_STEP_SECONDS }),
  );
  (root.querySelector('.seek-fwd') as HTMLButtonElement).addEventListener('click', () =>
    command(info.key, { kind: 'seek-by', seconds: SEEK_STEP_SECONDS }),
  );

  let scrubbing = false;
  seek.addEventListener('input', () => {
    scrubbing = true;
    timeCur.textContent = fmtTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    scrubbing = false;
    command(info.key, { kind: 'seek-to', time: Number(seek.value) });
  });

  muteBtn.addEventListener('click', () => command(info.key, { kind: 'set-muted', muted: !info.element.muted }));
  volume.addEventListener('input', () => {
    command(info.key, { kind: 'set-volume', volume: Number(volume.value) });
    volLabel.textContent = `${Math.round(Number(volume.value) * 100)}%`;
  });
  volume.addEventListener('change', () => {
    if (info.element.muted) command(info.key, { kind: 'set-muted', muted: false });
  });
  rate.addEventListener('input', () => {
    command(info.key, { kind: 'set-rate', rate: Number(rate.value) });
    rateValue.textContent = fmtRate(Number(rate.value));
  });

  const update = (cur: MediaSessionInfo): void => {
    info = cur;
    const el = cur.element;
    if (cur.favIconUrl) {
      if (favicon.getAttribute('src') !== cur.favIconUrl) favicon.src = cur.favIconUrl;
      favicon.classList.remove('hidden');
      favFallback.classList.add('hidden');
    } else {
      favicon.removeAttribute('src');
      favicon.classList.add('hidden');
      favFallback.classList.remove('hidden');
      favFallback.textContent = (hostOf(cur.tabUrl)[0] ?? '?').toUpperCase();
    }
    titleEl.textContent = el.title || cur.tabTitle || 'Untitled media';
    subEl.textContent = [el.artist, hostOf(cur.tabUrl), el.kind].filter(Boolean).join(' · ');
    timeCur.textContent = fmtTime(el.currentTime);
    if (el.live || el.duration <= 0) {
      seek.classList.add('hidden');
      timeDur.textContent = el.live ? 'LIVE' : '–:––';
      timeDur.classList.toggle('live', el.live);
    } else {
      seek.classList.remove('hidden');
      seek.max = String(el.duration);
      if (!scrubbing) seek.value = String(el.currentTime);
      timeDur.textContent = fmtTime(el.duration);
      timeDur.classList.remove('live');
    }
    playBtn.innerHTML = el.playing ? ICON_PAUSE : ICON_PLAY;
    muteBtn.innerHTML = el.muted ? ICON_MUTED : ICON_SOUND;
    volume.value = String(el.volume);
    volLabel.textContent = el.muted ? 'Muted' : `${Math.round(el.volume * 100)}%`;
    rate.value = String(Math.min(4, Math.max(0.25, el.rate)));
    rateValue.textContent = fmtRate(el.rate);
  };
  update(info);
  return { root, update };
}

connect();

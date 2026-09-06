// Side panel UI. Renders one card per media session; owns the keep-alive ping
// that keeps the service worker alive while the panel is open.

import { PANEL_PORT } from '../shared/protocol';
import type { MediaSessionInfo, PanelInbound, PanelOutbound } from '../shared/protocol';

// --- state ---------------------------------------------------------------------

const sessions = new Map<string, MediaSessionInfo>();
const cards = new Map<string, Card>();
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
    case 'pong':
      break;
  }
}

// --- layout ----------------------------------------------------------------------

const app = document.getElementById('app') as HTMLDivElement;
app.innerHTML = `
  <header class="header"><span class="header-title">Media</span></header>
  <main id="list" class="list"></main>
  <div id="empty" class="empty">
    No media detected.<br />Play a video or audio in any tab and it will show up here.
  </div>
`;
const listEl = document.getElementById('list') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;

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
    </div>
    <div class="progress-row">
      <span class="time time-cur"></span>
      <input class="seek" type="range" min="0" max="0" step="0.1" disabled />
      <span class="time time-dur"></span>
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

  main.addEventListener('click', () => send({ type: 'focus-tab', tabId: info.tabId }));

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
      seek.value = String(el.currentTime);
      timeDur.textContent = fmtTime(el.duration);
      timeDur.classList.remove('live');
    }
  };
  update(info);
  return { root, update };
}

connect();

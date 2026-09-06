// Content script: discovers <audio>/<video> elements in its frame, reports
// their state and executes commands. It stays fully dormant — no port, no
// messages, no timers beyond a debounced MutationObserver — until the service
// worker asks for a sync, which only happens while a panel is open.

import { MEDIA_PORT } from '../shared/protocol';
import type { ContentInbound, MediaCommand, MediaElementPatch, MediaElementState, WorkerInbound } from '../shared/protocol';
import { clampRate, DEFAULT_SETTINGS, loadSettings } from '../shared/settings';
import type { Settings } from '../shared/settings';

interface TrackedElement {
  el: HTMLMediaElement;
  id: string;
  /** Set once the user picked a rate for this item from the panel. */
  rateTouched: boolean;
  lastTimeSent: number;
  events: AbortController;
}

const tracked = new Map<HTMLMediaElement, TrackedElement>();
let counter = 0;
let port: chrome.runtime.Port | null = null;
let settings: Settings = { ...DEFAULT_SETTINGS };
let rescanTimer: ReturnType<typeof setTimeout> | undefined;

const EVENT_TYPES = [
  'play',
  'pause',
  'ended',
  'seeked',
  'seeking',
  'timeupdate',
  'volumechange',
  'ratechange',
  'durationchange',
  'loadedmetadata',
  'emptied',
] as const;

// --- state -----------------------------------------------------------------

function readMediaSessionMetadata(): { title: string | null; artist: string | null; artwork: string | null } {
  const out = { title: null as string | null, artist: null as string | null, artwork: null as string | null };
  try {
    const md = navigator.mediaSession.metadata;
    if (!md) return out;
    out.title = md.title || null;
    out.artist = md.artist || null;
    const last = md.artwork.length ? md.artwork[md.artwork.length - 1] : undefined;
    if (last?.src) {
      try {
        out.artwork = new URL(last.src, location.href).href;
      } catch {
        out.artwork = last.src;
      }
    }
  } catch {
    // Media Session metadata may be unreadable in the isolated world; the DOM
    // fallbacks below cover it.
  }
  return out;
}

function buildState(t: TrackedElement, allowMediaSession: boolean): MediaElementState {
  const el = t.el;
  const live = el.duration === Infinity;
  let title: string | null = null;
  let artist: string | null = null;
  let artwork: string | null = null;
  if (allowMediaSession) {
    const md = readMediaSessionMetadata();
    title = md.title;
    artist = md.artist;
    artwork = md.artwork;
  }
  if (!title) {
    const og = document.querySelector<HTMLMetaElement>('meta[property="og:title"], meta[name="twitter:title"]');
    title = el.title || og?.content || document.title || null;
  }
  return {
    id: t.id,
    kind: el.tagName === 'VIDEO' ? 'video' : 'audio',
    title,
    artist,
    artwork,
    duration: live || !Number.isFinite(el.duration) ? -1 : el.duration,
    currentTime: el.currentTime || 0,
    playing: !el.paused && !el.ended,
    muted: el.muted,
    volume: el.volume,
    rate: el.playbackRate,
    live,
    ended: el.ended,
  };
}

function buildPatch(t: TrackedElement, allowMediaSession: boolean): MediaElementPatch {
  const { id: _id, ...patch } = buildState(t, allowMediaSession);
  return patch;
}

// --- messaging ---------------------------------------------------------------

function send(msg: WorkerInbound): void {
  port?.postMessage(msg);
}

function ensurePort(): void {
  if (port) return;
  try {
    port = chrome.runtime.connect({ name: MEDIA_PORT });
    port.onDisconnect.addListener(() => {
      port = null;
    });
  } catch {
    port = null; // extension context went away (e.g. reload while debugging)
  }
}

function goDormant(): void {
  port?.disconnect();
  port = null;
}

function flushSnapshot(): void {
  const allowMediaSession = tracked.size === 1;
  send({
    type: 'snapshot',
    snapshot: {
      frameUrl: location.href,
      elements: [...tracked.values()].map((t) => buildState(t, allowMediaSession)),
    },
  });
}

// --- discovery ---------------------------------------------------------------

function applyDefaultRate(t: TrackedElement): void {
  if (settings.globalRateEnabled && !t.rateTouched) {
    t.el.playbackRate = clampRate(settings.globalRate);
  }
}

function track(el: HTMLMediaElement): void {
  const t: TrackedElement = {
    el,
    id: `e${++counter}`,
    rateTouched: false,
    lastTimeSent: 0,
    events: new AbortController(),
  };
  tracked.set(el, t);
  for (const type of EVENT_TYPES) {
    el.addEventListener(type, () => onMediaEvent(t, type), { passive: true, signal: t.events.signal });
  }
  applyDefaultRate(t);
}

function untrack(t: TrackedElement): void {
  t.events.abort();
  tracked.delete(t.el);
}

function scan(): void {
  let changed = false;
  for (const node of document.querySelectorAll('video, audio')) {
    if (node instanceof HTMLMediaElement && !tracked.has(node)) {
      track(node);
      changed = true;
    }
  }
  for (const t of [...tracked.values()]) {
    if (!t.el.isConnected) {
      untrack(t);
      changed = true;
    }
  }
  if (changed) flushSnapshot();
}

function scheduleRescan(): void {
  if (rescanTimer !== undefined) clearTimeout(rescanTimer);
  rescanTimer = setTimeout(() => {
    rescanTimer = undefined;
    scan();
  }, 250);
}

new MutationObserver(scheduleRescan).observe(document.documentElement, { childList: true, subtree: true });

// --- events & commands ---------------------------------------------------------

function onMediaEvent(t: TrackedElement, type: (typeof EVENT_TYPES)[number]): void {
  if (type === 'play') applyDefaultRate(t);
  if (!port) return; // dormant: no messaging while no panel is attached
  if (type === 'timeupdate') {
    const now = performance.now();
    if (now - t.lastTimeSent < 900) return;
    t.lastTimeSent = now;
    send({ type: 'update', id: t.id, patch: { currentTime: t.el.currentTime } });
    return;
  }
  send({ type: 'update', id: t.id, patch: buildPatch(t, tracked.size === 1) });
}

function execute(id: string, command: MediaCommand): void {
  const t = [...tracked.values()].find((c) => c.id === id);
  if (!t) return;
  const el = t.el;
  switch (command.kind) {
    case 'play':
      void el.play().catch(() => {});
      break;
    case 'pause':
      el.pause();
      break;
    case 'toggle':
      if (el.paused || el.ended) void el.play().catch(() => {});
      else el.pause();
      break;
    case 'seek-by': {
      const target = el.currentTime + command.seconds;
      el.currentTime = Number.isFinite(el.duration) ? Math.min(Math.max(0, target), el.duration) : Math.max(0, target);
      break;
    }
    case 'seek-to':
      el.currentTime = Math.max(0, command.time);
      break;
    case 'set-volume':
      el.volume = Math.min(1, Math.max(0, command.volume));
      break;
    case 'set-muted':
      el.muted = command.muted;
      break;
    case 'set-rate':
      t.rateTouched = true;
      el.playbackRate = clampRate(command.rate);
      break;
  }
}

chrome.runtime.onMessage.addListener((msg: ContentInbound) => {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'sync-request':
      ensurePort();
      scan();
      flushSnapshot();
      break;
    case 'sleep':
      goDormant();
      break;
    case 'command':
      execute(msg.id, msg.command);
      break;
  }
});

// --- settings (read straight from storage; never wakes the worker) -------------

void loadSettings().then((s) => {
  settings = s;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const change = changes['settings'];
  if (!change?.newValue) return;
  settings = { ...DEFAULT_SETTINGS, ...change.newValue };
  if (settings.globalRateEnabled) {
    for (const t of tracked.values()) applyDefaultRate(t);
  }
});

scan();

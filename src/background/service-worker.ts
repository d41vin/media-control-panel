// Service worker: keeps the session registry, routes commands between the
// panel and content scripts, and broadcasts sync requests. All state is
// rebuildable — the registry is refreshed from content-script snapshots every
// time a panel attaches — so the worker is free to sleep whenever nothing is
// happening.

import { MEDIA_PORT, PANEL_PORT } from '../shared/protocol';
import type {
  ContentInbound,
  FrameSnapshot,
  MediaCommand,
  MediaSessionInfo,
  PanelInbound,
  PanelOutbound,
  WorkerInbound,
} from '../shared/protocol';

interface FrameConn {
  tabId: number;
  frameId: number;
  port: chrome.runtime.Port;
}

interface TabInfo {
  title: string;
  url: string;
  favIconUrl: string | null;
}

const frames = new Map<string, FrameConn>(); // "tabId:frameId"
const registry = new Map<string, MediaSessionInfo>(); // "tabId:frameId:elementId"
const tabInfo = new Map<number, TabInfo>();
const panelPorts = new Set<chrome.runtime.Port>();
let pinnedKey: string | null = null;

const frameKey = (tabId: number, frameId: number) => `${tabId}:${frameId}`;
const sessionKey = (tabId: number, frameId: number, elementId: string) => `${tabId}:${frameId}:${elementId}`;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('setPanelBehavior failed', err));

// --- panel fan-out -----------------------------------------------------------

function sendToPanel(msg: PanelOutbound): void {
  for (const p of panelPorts) p.postMessage(msg);
}

function broadcastSessions(): void {
  if (!panelPorts.size) return;
  sendToPanel({ type: 'sessions', sessions: [...registry.values()] });
}

function broadcastPinned(): void {
  if (!panelPorts.size) return;
  sendToPanel({ type: 'pinned', key: pinnedKey });
}

// --- registry maintenance ------------------------------------------------------

async function ensureTabInfo(tabId: number): Promise<TabInfo> {
  const cached = tabInfo.get(tabId);
  if (cached) return cached;
  try {
    const tab = await chrome.tabs.get(tabId);
    const info: TabInfo = { title: tab.title ?? '', url: tab.url ?? '', favIconUrl: tab.favIconUrl ?? null };
    tabInfo.set(tabId, info);
    return info;
  } catch {
    return { title: '', url: '', favIconUrl: null };
  }
}

async function refreshAllTabInfo(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    tabInfo.set(tab.id, { title: tab.title ?? '', url: tab.url ?? '', favIconUrl: tab.favIconUrl ?? null });
  }
}

async function replaceFrame(tabId: number, frameId: number, snapshot: FrameSnapshot): Promise<void> {
  const fk = frameKey(tabId, frameId);
  for (const key of [...registry.keys()]) {
    if (key.startsWith(`${fk}:`)) registry.delete(key);
  }
  const info = await ensureTabInfo(tabId);
  for (const el of snapshot.elements) {
    const key = sessionKey(tabId, frameId, el.id);
    registry.set(key, {
      key,
      tabId,
      frameId,
      tabTitle: info.title,
      tabUrl: info.url,
      favIconUrl: info.favIconUrl,
      element: el,
    });
  }
  broadcastSessions();
}

function dropFrame(tabId: number, frameId: number): void {
  const fk = frameKey(tabId, frameId);
  let removed = false;
  for (const key of [...registry.keys()]) {
    if (key.startsWith(`${fk}:`)) {
      registry.delete(key);
      removed = true;
    }
  }
  if (removed) broadcastSessions();
}

function dropTab(tabId: number): void {
  tabInfo.delete(tabId);
  let removed = false;
  for (const key of [...registry.keys()]) {
    if (key.startsWith(`${tabId}:`)) {
      registry.delete(key);
      removed = true;
    }
  }
  if (removed) broadcastSessions();
}

// --- sync ----------------------------------------------------------------------

async function broadcastToTabs(msg: ContentInbound): Promise<void> {
  const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    void chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const cached = tabInfo.get(tabId);
  if (cached) {
    if (changeInfo.title !== undefined) cached.title = changeInfo.title;
    if (changeInfo.url !== undefined) cached.url = changeInfo.url;
    if (changeInfo.favIconUrl !== undefined) cached.favIconUrl = changeInfo.favIconUrl;
    let touched = false;
    for (const rec of registry.values()) {
      if (rec.tabId === tabId) {
        rec.tabTitle = cached.title;
        rec.tabUrl = cached.url;
        rec.favIconUrl = cached.favIconUrl;
        touched = true;
      }
    }
    if (touched) broadcastSessions();
  }
  // Freshly loaded pages only report in while a panel is listening.
  if (panelPorts.size && (changeInfo.status === 'complete' || changeInfo.url !== undefined)) {
    void chrome.tabs.sendMessage(tabId, { type: 'sync-request' }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => dropTab(tabId));

// --- command routing -------------------------------------------------------------

function routeCommand(key: string, command: MediaCommand): void {
  const rec = registry.get(key);
  if (!rec) return;
  const msg: ContentInbound = { type: 'command', id: rec.element.id, command };
  const frame = frames.get(frameKey(rec.tabId, rec.frameId));
  if (frame) frame.port.postMessage(msg);
  else void chrome.tabs.sendMessage(rec.tabId, msg, { frameId: rec.frameId }).catch(() => {});
}

// --- panel messages ----------------------------------------------------------------

async function onPanelMessage(port: chrome.runtime.Port, msg: PanelInbound): Promise<void> {
  switch (msg.type) {
    case 'ping':
      port.postMessage({ type: 'pong' });
      break;
    case 'command':
      routeCommand(msg.key, msg.command);
      break;
    case 'focus-tab':
      try {
        const tab = await chrome.tabs.update(msg.tabId, { active: true });
        if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
      } catch {
        // tab or window may be gone
      }
      break;
    case 'pin': {
      pinnedKey = msg.key;
      if (pinnedKey === null) void chrome.storage.session.remove('pinned');
      else void chrome.storage.session.set({ pinned: pinnedKey });
      broadcastPinned();
      break;
    }
    case 'pause-all':
      for (const key of [...registry.keys()]) routeCommand(key, { kind: 'pause' });
      break;
    case 'mute-all':
      for (const key of [...registry.keys()]) routeCommand(key, { kind: 'set-muted', muted: msg.muted });
      break;
  }
}

// --- ports --------------------------------------------------------------------------

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === MEDIA_PORT) {
    const tabId = port.sender?.tab?.id;
    const frameId = port.sender?.frameId;
    if (tabId === undefined || frameId === undefined) {
      port.disconnect();
      return;
    }
    const fk = frameKey(tabId, frameId);
    frames.get(fk)?.port.disconnect(); // replace any stale connection for this frame
    frames.set(fk, { tabId, frameId, port });
    port.onMessage.addListener((msg: WorkerInbound) => {
      if (msg?.type === 'snapshot') {
        void replaceFrame(tabId, frameId, msg.snapshot);
      } else if (msg?.type === 'update') {
        const key = sessionKey(tabId, frameId, msg.id);
        const rec = registry.get(key);
        if (rec) {
          rec.element = { ...rec.element, ...msg.patch };
          if (panelPorts.size) sendToPanel({ type: 'patch', key, patch: msg.patch });
        }
      }
    });
    port.onDisconnect.addListener(() => {
      if (frames.get(fk)?.port === port) frames.delete(fk);
      dropFrame(tabId, frameId);
    });
  } else if (port.name === PANEL_PORT) {
    panelPorts.add(port);
    port.onMessage.addListener((msg: PanelInbound) => void onPanelMessage(port, msg));
    port.onDisconnect.addListener(() => {
      panelPorts.delete(port);
      if (!panelPorts.size) void broadcastToTabs({ type: 'sleep' });
    });
    void (async () => {
      await refreshAllTabInfo();
      const stored = await chrome.storage.session.get('pinned');
      if (typeof stored['pinned'] === 'string') pinnedKey = stored['pinned'];
      sendToPanel({ type: 'sessions', sessions: [...registry.values()] });
      broadcastPinned();
      await broadcastToTabs({ type: 'sync-request' });
    })();
  }
});

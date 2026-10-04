// Service worker. While the popup is closed this worker owns exactly one
// visible job: keeping the toolbar badge equal to the number of tabs playing
// audio — the "something is playing" affordance Chrome's media hub has. It
// wakes only for tab audible changes and keyboard commands, does cheap
// early-exit work, and sleeps 30 s later like any MV3 worker. No intervals,
// no ports, no persistent content scripts.

import { pagePause, pageProbe, pageToggle } from './lib/page.js';

// --- badge ---------------------------------------------------------------------

let lastCount = -1;

async function updateBadge() {
  try {
    const audible = await chrome.tabs.query({ audible: true });
    const n = audible.length;
    if (n !== lastCount) {
      lastCount = n;
      await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    }
  } catch {
    // extension context shutting down
  }
}

// Tabs that played recently stay listed (paused, resumable) the next time the
// popup opens — the behavior Chrome's media panel has. Recorded on the same
// audible events the badge already consumes: no extra wakes.
const RECENT_MAX = 8;

async function noteRecent(tabId) {
  try {
    const { recent } = await chrome.storage.session.get('recent');
    const next = [tabId, ...((recent ?? []).filter((id) => id !== tabId))].slice(0, RECENT_MAX);
    await chrome.storage.session.set({ recent: next });
  } catch {
    // storage unavailable; the popup just won't show paused media
  }
}

async function pruneRecent(tabId) {
  try {
    const { recent } = await chrome.storage.session.get('recent');
    if (Array.isArray(recent) && recent.includes(tabId)) {
      await chrome.storage.session.set({ recent: recent.filter((id) => id !== tabId) });
    }
  } catch {
    // nothing to do
  }
}

// Only audible changes can move the count — every other onUpdated reason is
// skipped without touching the tabs API.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.audible === undefined) return;
  void updateBadge();
  if (info.audible === true) void noteRecent(tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateBadge();
  void pruneRecent(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: '#e30613' });
  void chrome.action.setBadgeTextColor({ color: '#ffffff' });
  void updateBadge();
});

// initial state after every worker start
void updateBadge();

// --- keyboard commands ------------------------------------------------------------

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command);
});

async function handleCommand(command) {
  if (command === 'pause-all') {
    // every tab that could be playing: sounding now, or media tabs from this
    // session (muted playback isn't audible but still needs pausing);
    // pagePause no-ops on tabs with nothing playing
    const [audible, stored] = await Promise.all([
      chrome.tabs.query({ audible: true }),
      chrome.storage.session.get('recent').catch(() => ({})),
    ]);
    const ids = new Set(audible.map((t) => t.id).filter((id) => id !== undefined));
    if (Array.isArray(stored.recent)) {
      for (const id of stored.recent) if (typeof id === 'number') ids.add(id);
    }
    for (const tabId of ids) {
      chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: pagePause })
        .catch(() => {});
    }
    return;
  }

  if (command === 'mute-all') {
    const audible = await chrome.tabs.query({ audible: true });
    const anyUnmuted = audible.some((t) => !t.mutedInfo?.muted);
    if (anyUnmuted) {
      for (const t of audible) {
        if (t.id !== undefined && !t.mutedInfo?.muted) {
          void chrome.tabs.update(t.id, { muted: true }).catch(() => {});
        }
      }
    } else {
      // everything audible is muted: unmute what this extension muted
      const muted = await chrome.tabs.query({ muted: true });
      for (const t of muted) {
        if (t.id !== undefined && t.mutedInfo?.reason === 'extension') {
          void chrome.tabs.update(t.id, { muted: false }).catch(() => {});
        }
      }
    }
    return;
  }

  if (command === 'toggle-target') {
    const stored = await chrome.storage.session.get('target').catch(() => ({}));
    const tabId = stored.target;
    if (typeof tabId !== 'number') return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return;
    } catch {
      // target tab is gone; drop the pin
      void chrome.storage.session.remove('target').catch(() => {});
      return;
    }
    try {
      // find the frame that owns the primary element, toggle only there —
      // an allFrames toggle would double-fire on multi-frame pages
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: pageProbe,
      });
      const frames = results.filter((r) => r.result?.elements?.length);
      let frameId = frames.find((r) => r.result.elements.some((e) => e.playing))?.frameId;
      frameId ??= frames[0]?.frameId;
      const target = frameId !== undefined ? { tabId, frameId } : { tabId, allFrames: true };
      await chrome.scripting.executeScript({ target, func: pageToggle });
    } catch {
      // probe failed but the tab exists: last-resort toggle everywhere
      chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: pageToggle })
        .catch(() => {});
    }
  }
}

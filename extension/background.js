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

// Only audible changes can move the count — every other onUpdated reason is
// skipped without touching the tabs API.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.audible !== undefined) void updateBadge();
});

chrome.tabs.onRemoved.addListener(() => {
  void updateBadge();
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
    const audible = await chrome.tabs.query({ audible: true });
    for (const tab of audible) {
      if (tab.id === undefined) continue;
      chrome.scripting
        .executeScript({ target: { tabId: tab.id, allFrames: true }, func: pagePause })
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

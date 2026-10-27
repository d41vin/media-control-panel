// User settings: device-level preferences under one chrome.storage.local
// key. Defaults are no-behavior-change, so someone who never opens the
// settings panel gets exactly the v2.0 popup. Both the popup and the
// background worker import this module.

export const DEFAULT_SETTINGS = Object.freeze({
  // pause every playing tab when the popup opens (opt-in)
  autoPauseOnOpen: false,
  // toolbar badge shows the playing-tab count
  badge: true,
  // paused media tabs stay listed for this browser session
  recentTabs: true,
});

function normalize(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    out[key] = typeof src[key] === 'boolean' ? src[key] : DEFAULT_SETTINGS[key];
  }
  return out;
}

export async function loadSettings() {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    return normalize(settings);
  } catch {
    return { ...DEFAULT_SETTINGS }; // storage unavailable; defaults govern
  }
}

/** Persist and return the normalized settings (the truth, not the input). */
export async function saveSettings(settings) {
  const clean = normalize(settings);
  try {
    await chrome.storage.local.set({ settings: clean });
  } catch {
    // storage unavailable: the caller's in-memory copy still governs
  }
  return clean;
}

// Global, locally-stored preferences. Content scripts read these directly from
// chrome.storage, so applying defaults never needs to wake the service worker.

export interface Settings {
  /** Apply globalRate when media appears or starts, unless overridden per item. */
  globalRateEnabled: boolean;
  globalRate: number;
}

export const DEFAULT_SETTINGS: Settings = { globalRateEnabled: false, globalRate: 1 };

const STORAGE_KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEY] as Partial<Settings> | undefined) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  const current = await loadSettings();
  await chrome.storage.local.set({ [STORAGE_KEY]: { ...current, ...patch } });
}

/** Chrome keeps audio audible roughly within [0.0625, 16]; clamp custom rates there. */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(16, Math.max(0.0625, rate));
}

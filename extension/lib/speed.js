// Playback speed model shared by the popup, the background worker and the
// page-level manager (via the background): one global default plus optional
// per-page overrides.
//
// State ownership (see RESEARCH.md):
//   - global speed: chrome.storage.local, key 'speed' — survives restarts.
//   - page overrides: chrome.storage.session, key 'speedOverrides' —
//     { [tabId]: { url, rate, at } }. Session-scoped by design: they die with
//     the browser, are only valid for the URL they were made on (navigation
//     clears them) and never pretend that capture/enforcement was restored
//     after a restart.
//
// Precedence rules (single source of truth — do not reimplement elsewhere):
//   1. a page without an override inherits the global speed;
//   2. changing the global speed updates every inheriting page;
//   3. a page with an override keeps its own speed when global changes;
//   4. a page-originated rate change away from the inherited rate becomes the
//      page's override — including a change to exactly 1.00×;
//   5. the global speed is never forced onto an overridden page;
//   6. resetting a page to global removes the override and re-applies global;
//   7. a page-originated change that lands exactly on the global rate is
//      indistinguishable from inheriting, so the override is dropped;
//   8. website-reported rates are preserved exactly (1.10× stays 1.10×) —
//      the 0.25× grid applies only to extension-initiated adjustments.

export const SPEED_MIN = 0.25;
export const SPEED_MAX = 16; // Chromium's media ceiling; 0.25x steps to it
export const SPEED_STEP = 0.25;
export const SPEED_DEFAULT = 1;

/** Clamp to the supported range without snapping to the grid. */
export function clampSpeed(rate) {
  if (!Number.isFinite(rate)) return SPEED_DEFAULT;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
}

/** Clamp AND snap to the 0.25 grid — extension-initiated adjustments only. */
export function snapSpeed(rate) {
  return clampSpeed(Math.round(rate / SPEED_STEP) * SPEED_STEP);
}

/**
 * Display a rate without ever hiding what the website really reported:
 * values that ARE two-decimal values get the familiar two digits (1.10×),
 * genuine off-grid precision survives (1.175×, 1.3333×).
 */
export function fmtSpeed(rate) {
  const r = Number.isFinite(rate) && rate > 0 ? rate : SPEED_DEFAULT;
  const clean = Math.round(r * 10000) / 10000;
  const twoDec = Math.round(clean * 100) / 100;
  return `${Math.abs(clean - twoDec) < 1e-9 ? twoDec.toFixed(2) : String(clean)}×`;
}

// --- global speed (storage.local) ---------------------------------------------

export async function loadGlobalSpeed() {
  try {
    const { speed } = await chrome.storage.local.get('speed');
    return typeof speed === 'number' ? clampSpeed(speed) : SPEED_DEFAULT;
  } catch {
    return SPEED_DEFAULT; // storage unavailable; defaults govern
  }
}

export async function saveGlobalSpeed(rate) {
  const clean = clampSpeed(rate);
  try {
    await chrome.storage.local.set({ speed: clean });
  } catch {
    // storage unavailable: the caller's in-memory copy still governs
  }
  return clean;
}

// --- page overrides (storage.session) -------------------------------------------

export async function loadOverrides() {
  try {
    const { speedOverrides } = await chrome.storage.session.get('speedOverrides');
    return speedOverrides && typeof speedOverrides === 'object' ? speedOverrides : {};
  } catch {
    return {};
  }
}

export async function writeOverrides(map) {
  try {
    await chrome.storage.session.set({ speedOverrides: map });
  } catch {
    // storage unavailable: enforcement falls back to the global speed
  }
  return map;
}

// Per-site adapters, with explicit capabilities.
//
// Two kinds of capability live here:
//
//   - `next`/`prev` — the site's own track buttons, the one thing generic
//     media-element control cannot offer. Injected into the ISOLATED world
//     on click only; cost nothing at idle. If a redesign moves a button, the
//     adapter no-ops — never breaks.
//   - `syncPlayer` — a MAIN-world function that aligns a site's PRIVATE
//     player state with the media element's ACTUAL state. Needed because
//     some players (YouTube's first-party player is the reported case) keep
//     their own speed/volume/mute model: element writes change the playback
//     but leave the site's visible UI untouched, and the page-world API
//     objects are invisible from the isolated world. The function runs in
//     the page's own JS context, feature-detects the API surface, and writes
//     only what differs — a settled player sees zero duplicate writes. If
//     the player API clamps a value (YouTube's rate menu tops out at 2.00×),
//     the element ends at the clamped value and the standard ratechange/
//     volumechange events carry the truth back to the extension.
//
// Serialization rules as lib/page.js: every function is passed to
// chrome.scripting.executeScript, so each must be fully self-contained (no
// closures, no module-scope references). Only hosts listed below are ever
// handed these functions — no global dependence on private player internals.

function ytNext() {
  const btn = document.querySelector('.ytp-next-button');
  if (!btn) return { acted: false };
  btn.click();
  return { acted: true };
}

function ytPrev() {
  const btn = document.querySelector('.ytp-prev-button');
  if (!btn) return { acted: false };
  btn.click();
  return { acted: true };
}

function spNext() {
  const btn = document.querySelector('[data-testid="control-button-skip-forward"]');
  if (!btn) return { acted: false };
  btn.click();
  return { acted: true };
}

function spPrev() {
  const btn = document.querySelector('[data-testid="control-button-skip-back"]');
  if (!btn) return { acted: false };
  btn.click();
  return { acted: true };
}

function scNext() {
  const btn = document.querySelector('.skipControl__next');
  if (!btn) return { acted: false };
  btn.click();
  return { acted: true };
}

function scPrev() {
  const btn = document.querySelector('.skipControl__previous');
  if (!btn) return { acted: false };
  btn.click();
  return { acted: true };
}

/**
 * MAIN world. Squaring the player's private state with the media element.
 *
 * NOTE: YouTube's first-party player methods used here are INTERNAL —
 * the same names the IFrame Player API uses, but not the official API, not
 * documented, and able to change without notice. They are feature-detected
 * on the player element; without them the extension falls back to the media
 * element, which always works but may not move the site's own UI.
 *
 * Direction per channel matters, and the reported YouTube behavior proves it:
 *
 *   - rate / volume: ELEMENT → player API. The manager and the volume slider
 *     write the element; the site's UI only follows when its own model is
 *     updated, so the element truth is pushed in. The rate push is made
 *     harmless: if the player's menu clamps the element back down (some builds
 *     drag the media to their advertised maximum), the element's actual rate
 *     is restored, and a per-element marker stops the next sync from
 *     re-entering the same fight.
 *   - mute: PLAYER → element. The player owns its mute model; builds that
 *     ignore element writes (or reassert their own state over them, sometimes
 *     only on tab activation) are exactly the failure reports. The player's
 *     API is the site's own mute mechanism, so its state is the truth and the
 *     element is aligned to it — never the other way.
 *
 * Idempotent by construction: every branch compares first and writes only a
 * real difference, so repeated syncs are no-ops.
 */
function ytSyncPlayer() {
  let p = null;
  try {
    p = document.getElementById('movie_player');
  } catch {
    return { found: false };
  }
  if (!p) return { found: false };
  const caps = {
    rate: typeof p.getPlaybackRate === 'function' && typeof p.setPlaybackRate === 'function',
    volume: typeof p.getVolume === 'function' && typeof p.setVolume === 'function',
    mute:
      typeof p.isMuted === 'function' &&
      typeof p.mute === 'function' &&
      typeof p.unMute === 'function',
  };
  let el = null;
  try {
    el = p.querySelector('video, audio');
  } catch {
    // non-element stand-in
  }
  if (!el) {
    try {
      el = document.querySelector('video, audio');
    } catch {}
  }
  if (!el) return { found: true, caps, element: false };
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  try {
    if (caps.rate) {
      const want = el.playbackRate;
      // __mcpPlayerRate: the last rate this sync reconciled. Without it a
      // player that clamps its element would be re-fought on every call.
      if (Number.isFinite(want) && !near(want, p.getPlaybackRate()) && el.__mcpPlayerRate !== want) {
        p.setPlaybackRate(want);
        // the player's menu may refuse the value; the media element's actual
        // playback is what matters, so put it back if the call dragged it
        if (!near(el.playbackRate, want)) el.playbackRate = want;
        el.__mcpPlayerRate = want;
      }
    }
    if (caps.volume) {
      const want = Math.round(el.volume * 100);
      if (Number.isFinite(want) && want !== Math.round(p.getVolume())) p.setVolume(want);
    }
    if (caps.mute) {
      // the player's model is authoritative for mute; align the element TO it
      const want = !!p.isMuted();
      if (want !== !!el.muted) want ? p.mute() : p.unMute();
    }
  } catch {
    // a wrapped or mid-upgrade player refuses: element-level control holds
  }
  const out = { found: true, caps, element: true };
  try {
    if (caps.rate) out.rate = p.getPlaybackRate();
    if (caps.volume) out.volume = p.getVolume();
    if (caps.mute) out.muted = !!p.isMuted();
  } catch {}
  return out;
}

/**
 * MAIN world. Set the player's mute through its OWN API — the only channel a
 * player that reasserts its internal state actually obeys. Reads back what
 * the player reports so the popup renders the real state, not the request.
 */
function ytSetMuted(input) {
  const want = !!input?.muted;
  const p = document.getElementById('movie_player');
  if (
    !p ||
    typeof p.isMuted !== 'function' ||
    typeof p.mute !== 'function' ||
    typeof p.unMute !== 'function'
  ) {
    return { found: false, acted: false };
  }
  try {
    if (!!p.isMuted() !== want) want ? p.mute() : p.unMute();
  } catch {
    return { found: true, acted: false };
  }
  let el = null;
  try {
    el = p.querySelector('video, audio') || document.querySelector('video, audio');
  } catch {}
  return {
    found: true,
    acted: true,
    muted: !!p.isMuted(),
    elMuted: el ? !!el.muted : null,
  };
}

/**
 * MAIN world. The player's own state, read-only — the popup's "Player audio"
 * row must show what the site's player believes, even on builds whose UI does
 * not reflect it in the media element promptly.
 */
function ytPlayerState() {
  const p = document.getElementById('movie_player');
  if (!p) return { found: false };
  const out = { found: true };
  try {
    if (typeof p.isMuted === 'function') out.muted = !!p.isMuted();
  } catch {}
  try {
    if (typeof p.getVolume === 'function') out.volume = p.getVolume();
  } catch {}
  try {
    if (typeof p.getPlaybackRate === 'function') out.rate = p.getPlaybackRate();
  } catch {}
  return out;
}

export const ADAPTERS = {
  youtube: {
    hosts: ['youtube.com', 'youtube-nocookie.com'],
    caps: ['next', 'prev', 'speed-sync', 'volume-sync', 'mute-sync', 'mute-api', 'read-state'],
    next: ytNext,
    prev: ytPrev,
    nextSel: '.ytp-next-button',
    prevSel: '.ytp-prev-button',
    syncPlayer: ytSyncPlayer,
    setMuted: ytSetMuted,
    readState: ytPlayerState,
  },
  spotify: {
    hosts: ['spotify.com'],
    caps: ['next', 'prev'],
    next: spNext,
    prev: spPrev,
    nextSel: '[data-testid="control-button-skip-forward"]',
    prevSel: '[data-testid="control-button-skip-back"]',
    // no syncPlayer: the web player exposes no reliable public API in the
    // page — its UI is driven by private internals this extension does not
    // touch. Element truth (probes/pings) stays the display source.
  },
  soundcloud: {
    hosts: ['soundcloud.com'],
    caps: ['next', 'prev'],
    next: scNext,
    prev: scPrev,
    nextSel: '.skipControl__next',
    prevSel: '.skipControl__previous',
    // no syncPlayer, same reason as Spotify
  },
};

/** The adapter for a tab URL, or null when the site has none. */
export function adapterFor(url) {
  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const [key, adapter] of Object.entries(ADAPTERS)) {
    for (const h of adapter.hosts) {
      if (host === h || host.endsWith('.' + h)) {
        return {
          key,
          caps: adapter.caps,
          next: adapter.next,
          prev: adapter.prev,
          nextSel: adapter.nextSel,
          prevSel: adapter.prevSel,
          syncPlayer: adapter.syncPlayer ?? null,
          setMuted: adapter.setMuted ?? null,
          readState: adapter.readState ?? null,
        };
      }
    }
  }
  return null;
}

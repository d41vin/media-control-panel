// Per-site track adapters: next/previous via the site's own player buttons —
// the one capability generic media-element control can't offer (extension
// APIs cannot invoke another page's mediaSession handlers).
//
// Same serialization rules as lib/page.js: every function is passed to
// chrome.scripting.executeScript, so each must be fully self-contained (no
// closures, no module-scope references). Adapters are injected only on click;
// they cost nothing at idle. If a site redesign moves a button, the adapter
// no-ops — never breaks.

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

export const ADAPTERS = {
  youtube: {
    hosts: ['youtube.com', 'youtube-nocookie.com'],
    next: ytNext,
    prev: ytPrev,
  },
  spotify: {
    hosts: ['spotify.com'],
    next: spNext,
    prev: spPrev,
  },
  soundcloud: {
    hosts: ['soundcloud.com'],
    next: scNext,
    prev: scPrev,
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
        return { key, next: adapter.next, prev: adapter.prev };
      }
    }
  }
  return null;
}

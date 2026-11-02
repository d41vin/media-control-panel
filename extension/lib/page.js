// Functions injected into pages via chrome.scripting.executeScript.
//
// Every export is serialized with Function.prototype.toString when passed as
// `func`, so each must be fully self-contained: no imports, no closures over
// module scope. The element-collection and primary-selection helpers are
// therefore deliberately inlined inside every function — keep them identical.
//
// They run in the ISOLATED world: full DOM access, no page-JS globals. All of
// them return plain JSON-serializable data.

/**
 * Snapshot every media element in this frame (open shadow roots included).
 * Returned once per frame by executeScript({allFrames: true}).
 *
 * `site` (optional) names the site's own track buttons; when given, the
 * frame also reports whether each control exists and whether the site has
 * disabled it (no next track, etc.) — the popup mirrors that truthfully.
 */
export function pageProbe(site) {
  const siteButtonState = (sel) => {
    if (!sel) return { found: false, disabled: true };
    let b = null;
    try {
      b = document.querySelector(sel);
    } catch {
      return { found: false, disabled: true };
    }
    if (!b) return { found: false, disabled: true };
    // A site can express "no previous track" in more than one way: a real
    // disabled attribute, aria-disabled, or (YouTube) a hidden button. All of
    // them mean the control is unavailable, so the popup disables its own
    // button instead of clicking a no-op.
    let invisible = false;
    try {
      invisible =
        b.hidden === true ||
        b.getAttribute('aria-hidden') === 'true' ||
        (typeof b.getClientRects === 'function' && b.getClientRects().length === 0) ||
        (typeof getComputedStyle === 'function' &&
          (getComputedStyle(b).display === 'none' || getComputedStyle(b).visibility === 'hidden'));
    } catch {
      // non-Element stand-ins (mock harnesses) have no layout; treat visible
    }
    return {
      found: true,
      disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true' || invisible),
    };
  };
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const siteButtons = site
    ? {
        next: siteButtonState(site.next),
        prev: siteButtonState(site.prev),
      }
    : null;
  let sessionTitle = null;
  let artwork = null;
  try {
    sessionTitle = navigator.mediaSession?.metadata?.title || null;
    const arts = navigator.mediaSession?.metadata?.artwork ?? [];
    // prefer the largest declared size; any src beats none
    const best = [...arts]
      .filter((a) => a && a.src)
      .sort((a, b) => (parseInt(b.sizes) || 0) - (parseInt(a.sizes) || 0))[0];
    artwork = best?.src ?? null;
  } catch {
    // isolated world may refuse mediaSession access; DOM fallbacks cover it
  }
  const elements = els.map((el) => ({
    tag: el.tagName === 'VIDEO' ? 'video' : 'audio',
    playing: !el.paused && !el.ended,
    currentTime: el.currentTime || 0,
    duration: Number.isFinite(el.duration) ? el.duration : -1,
    muted: !!el.muted,
    volume: el.volume,
    rate: el.playbackRate,
    hasVideo: el.tagName === 'VIDEO',
    title:
      el.title ||
      (els.length === 1 ? sessionTitle : null) ||
      document.title ||
      null,
  }));
  return {
    docTitle: document.title,
    pip: !!document.pictureInPictureElement,
    artwork,
    elements,
    siteButtons,
  };
}

/** Tiny state ping for the expanded panel's live seek/volume/rate/pip. */
export function pagePing(site) {
  const siteButtonState = (sel) => {
    if (!sel) return { found: false, disabled: true };
    let b = null;
    try {
      b = document.querySelector(sel);
    } catch {
      return { found: false, disabled: true };
    }
    if (!b) return { found: false, disabled: true };
    // keep this identical to pageProbe's checker: disabled, aria-disabled and
    // hidden all mean the site's control is unavailable
    let invisible = false;
    try {
      invisible =
        b.hidden === true ||
        b.getAttribute('aria-hidden') === 'true' ||
        (typeof b.getClientRects === 'function' && b.getClientRects().length === 0) ||
        (typeof getComputedStyle === 'function' &&
          (getComputedStyle(b).display === 'none' || getComputedStyle(b).visibility === 'hidden'));
    } catch {
      // non-Element stand-ins (mock harnesses) have no layout; treat visible
    }
    return {
      found: true,
      disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true' || invisible),
    };
  };
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const el = els.find((m) => !m.paused && !m.ended) || els[0];
  if (!el) return { present: false };
  return {
    present: true,
    playing: !el.paused && !el.ended,
    currentTime: el.currentTime || 0,
    duration: Number.isFinite(el.duration) ? el.duration : -1,
    volume: el.volume,
    rate: el.playbackRate,
    pip: !!document.pictureInPictureElement,
    siteButtons: site
      ? { next: siteButtonState(site.next), prev: siteButtonState(site.prev) }
      : null,
  };
}

/** Toggle: any playing -> pause all in this frame; else resume what played. */
export function pageToggle() {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  if (!els.length) return { acted: false };
  const playing = els.filter((el) => !el.paused && !el.ended);
  if (playing.length) {
    for (const el of playing) el.pause();
    return { acted: true, state: 'paused' };
  }
  // resume the element most likely to be "the" media: one that actually
  // started before, then any loaded one, then the first available — never a
  // dead element with no sources (readyState 0)
  const paused = els.filter((el) => el.paused && !el.ended);
  const target =
    paused.find((el) => el.currentTime > 0 && el.readyState >= 2) ||
    paused.find((el) => el.readyState >= 2) ||
    paused[0];
  if (!target) return { acted: false };
  const p = target.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return { acted: true, state: 'played' };
}

/**
 * Force-play the primary element — the exclusive-playback primitive. Unlike
 * pageToggle this never pauses: if something already plays it reports that
 * and leaves it alone.
 */
export function pagePlay() {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  if (!els.length) return { acted: false };
  if (els.some((el) => !el.paused && !el.ended)) return { acted: true, state: 'playing' };
  // same resume tiers as pageToggle: an element that actually started, then
  // any loaded one, then the first available — never a dead element
  const paused = els.filter((el) => el.paused && !el.ended);
  const target =
    paused.find((el) => el.currentTime > 0 && el.readyState >= 2) ||
    paused.find((el) => el.readyState >= 2) ||
    paused[0];
  if (!target) return { acted: false };
  const p = target.play();
  if (p && typeof p.catch === 'function') p.catch(() => {});
  return { acted: true, state: 'played' };
}

/** Pause every playing element in this frame. No-op when nothing plays. */
export function pagePause() {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const playing = els.filter((el) => !el.paused && !el.ended);
  for (const el of playing) el.pause();
  return { paused: playing.length };
}

/** Seek the primary element. Clamped; refused on live streams. */
export function pageSeekTo({ time }) {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const el = els.find((m) => !m.paused && !m.ended) || els[0];
  if (!el || el.duration === Infinity) return { acted: false };
  // duration can be -1/NaN before metadata loads — seek unclamped rather
  // than compute a negative currentTime (which throws)
  const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
  try {
    el.currentTime = Math.min(Math.max(0, time), max);
  } catch {
    return { acted: false };
  }
  return { acted: true };
}

export function pageSeekBy({ seconds }) {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const el = els.find((m) => !m.paused && !m.ended) || els[0];
  if (!el) return { acted: false };
  const max = Number.isFinite(el.duration) && el.duration > 0 ? el.duration : Infinity;
  try {
    el.currentTime = Math.min(Math.max(0, el.currentTime + seconds), max);
  } catch {
    return { acted: false };
  }
  return { acted: true };
}

/** Volume of the primary element (0..1). */
export function pageSetVolume({ volume }) {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const el = els.find((m) => !m.paused && !m.ended) || els[0];
  if (!el) return { acted: false };
  el.volume = Math.min(1, Math.max(0, volume));
  return { acted: true, volume: el.volume };
}

/** Toggle Picture-in-Picture on the primary video. */
export function pagePiP() {
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return { acted: true, pip: false };
  }
  const els = (() => {
    const found = [...document.querySelectorAll('video')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const el = els.find((m) => !m.paused && !m.ended) || els[0];
  if (!el || !el.requestPictureInPicture) return { acted: false };
  el.requestPictureInPicture().catch(() => {});
  return { acted: true, pip: true };
}

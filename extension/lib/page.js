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
 */
export function pageProbe() {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  let sessionTitle = null;
  try {
    sessionTitle = navigator.mediaSession?.metadata?.title || null;
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
    elements,
  };
}

/** Tiny state ping for the expanded panel's live seek/volume/rate/pip. */
export function pagePing() {
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
  };
}

/** Toggle: any playing -> pause all in this frame; else play the first paused. */
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
  const target = els.find((el) => !el.ended) || els[0];
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

/** Playback rate of the primary element (0.0625..16 hard limits). */
export function pageSetRate({ rate }) {
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
  const el = els.find((m) => !m.paused && !m.ended) || els[0];
  if (!el) return { acted: false };
  el.playbackRate = Math.min(16, Math.max(0.0625, rate));
  return { acted: true, rate: el.playbackRate };
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

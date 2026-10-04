// In-memory chrome.* mock for testing the real popup.js (and the real
// injected functions from lib/page.js) inside a plain web page.
//
// The interesting part is scripting.executeScript: it runs the actual injected
// function against a per-tab fake document by rebinding its `document` and
// `navigator` globals — the same serialization path chrome uses
// (func.toString()), so a function that passes here generally survives real
// injection too.
//
// Used by test/popup-mock.html.

export function faviconSvg(letter, bg) {
  return `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="${bg}"/><text x="16" y="22" font-family="Arial" font-size="18" font-weight="bold" fill="#fff" text-anchor="middle">${letter}</text></svg>`,
  )}`;
}
function fakeMedia(tag, props) {
  return {
    tagName: tag,
    paused: !props.playing,
    ended: false,
    currentTime: props.time ?? 0,
    duration: props.duration ?? -1,
    muted: !!props.muted,
    volume: props.volume ?? 1,
    playbackRate: props.rate ?? 1,
    isConnected: true,
    title: props.title ?? '',
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    requestPictureInPicture() {
      this._pip = true;
      return Promise.resolve();
    },
  };
}

/** A fake tab: page state + the fake documents the injected functions see. */
function fakeTab(def) {
  const elements = (def.elements ?? []).map((e) => fakeMedia(e.tag, e));
  const tab = {
    id: def.id,
    index: def.id - 1,
    windowId: 1,
    title: def.title,
    url: def.url,
    favIconUrl: def.favicon ?? null,
    audible: false,
    mutedInfo: def.muted ? { muted: true, reason: 'extension' } : { muted: false, reason: '' },
    // harness-only handles
    _elements: elements,
    _injectable: def.injectable !== false,
  };
  Object.defineProperty(tab, '_doc', {
    get() {
      const els = this._elements;
      return {
        querySelectorAll(sel) {
          if (sel === 'video, audio' || sel === 'video') {
            return els.filter((el) => (sel === 'video' ? el.tagName === 'VIDEO' : true));
          }
          return []; // no shadow roots in the fake pages
        },
        get pictureInPictureElement() {
          return els.find((el) => el._pip) ?? null;
        },
        exitPictureInPicture() {
          for (const el of els) el._pip = false;
          return Promise.resolve();
        },
        title: def.title,
      };
    },
  });
  Object.defineProperty(tab, 'audible', {
    get() {
      return !this.mutedInfo.muted && this._elements.some((el) => !el.paused && !el.ended);
    },
  });
  return tab;
}

export function installMockChrome({ sessionSeed = {} } = {}) {
  const tabs = new Map();
  let nextId = 1;
  const onUpdated = [];
  const onRemoved = [];
  const storageChanged = [];
  const session = new Map(Object.entries(sessionSeed));

  const addTab = (def) => {
    const tab = fakeTab({ id: nextId++, ...def });
    tabs.set(tab.id, tab);
    return tab;
  };

  const fireUpdated = (tabId, info) => {
    for (const fn of onUpdated) fn(tabId, info);
  };

  const commandHandlers = [];
  const onInstalledHandlers = [];

  const chrome = {
    action: {
      _calls: [],
      async setBadgeText(details) {
        this._calls.push({ fn: 'setBadgeText', ...details });
      },
      async setBadgeBackgroundColor(details) {
        this._calls.push({ fn: 'setBadgeBackgroundColor', ...details });
      },
      async setBadgeTextColor(details) {
        this._calls.push({ fn: 'setBadgeTextColor', ...details });
      },
    },

    commands: {
      onCommand: {
        addListener(fn) {
          commandHandlers.push(fn);
        },
      },
    },

    runtime: {
      lastError: null,
      onInstalled: {
        addListener(fn) {
          onInstalledHandlers.push(fn);
        },
      },
    },

    tabs: {
      async query(filter = {}) {
        return [...tabs.values()]
          .filter((t) => filter.audible === undefined || t.audible === filter.audible)
          .filter((t) => filter.muted === undefined || !!t.mutedInfo?.muted === filter.muted)
          .map((t) => ({ ...t }));
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error('No tab with id');
        return { ...t };
      },
      async update(id, props) {
        const t = tabs.get(id);
        if (!t) throw new Error('No tab with id');
        if (props.muted !== undefined && props.muted !== t.mutedInfo.muted) {
          t.mutedInfo = { muted: props.muted, reason: 'extension' };
          fireUpdated(id, { mutedInfo: t.mutedInfo, audible: t.audible });
        }
        return { ...t };
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error('No tab with id');
        tabs.delete(id);
        for (const fn of onRemoved) fn(id);
      },
      onUpdated: { addListener: (fn) => onUpdated.push(fn) },
      onRemoved: { addListener: (fn) => onRemoved.push(fn) },
    },

    windows: {
      async update() {},
    },

    scripting: {
      async executeScript({ target, func, args }) {
        const runIn = (doc) => {
          const factory = new Function(
            'document',
            'navigator',
            `"use strict"; return (${func.toString()});`,
          );
          const fn = factory(doc, navigator);
          return fn(...(args ?? []));
        };
        const tab = tabs.get(target.tabId);
        if (!tab) throw new Error('No tab with id');
        if (!tab._injectable) throw new Error('Cannot access contents of this page');
        const before = tab.audible;
        const result = target.allFrames
          ? [{ frameId: 0, result: runIn(tab._doc) }]
          : [{ frameId: target.frameId, result: runIn(tab._doc) }];
        // like real Chrome, where injected play/pause flips the tab's audible
        // state and that arrives as a tabs.onUpdated event
        if (tab.audible !== before) fireUpdated(target.tabId, { audible: tab.audible });
        return result;
      },
    },

    storage: {
      session: {
        async get(keys) {
          if (typeof keys === 'string') return { [keys]: session.get(keys) };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((k) => [k, session.get(k)]));
          }
          if (keys && typeof keys === 'object') {
            return Object.fromEntries(
              Object.keys(keys).map((k) => [k, session.has(k) ? session.get(k) : keys[k]]),
            );
          }
          return {};
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: session.get(k), newValue: v };
            session.set(k, v);
          }
          for (const fn of storageChanged) fn(changes, 'session');
        },
        async remove(key) {
          const oldValue = session.get(key);
          if (!session.has(key)) return;
          session.delete(key);
          for (const fn of storageChanged) fn({ [key]: { oldValue } }, 'session');
        },
      },
      onChanged: { addListener: (fn) => storageChanged.push(fn) },
    },

    // --- harness-only handles ----------------------------------------------

    _mock: {
      tabs,
      addTab,
      fireUpdated,
      fireCommand(command) {
        for (const fn of commandHandlers) fn(command);
      },
      fireInstalled() {
        for (const fn of onInstalledHandlers) fn();
      },
      badgeText() {
        const calls = chrome.action._calls.filter((c) => c.fn === 'setBadgeText');
        return calls.length ? calls[calls.length - 1].text : null;
      },
      /** Simulate a play/pause on a tab's primary element. */
      toggle(id) {
        const t = tabs.get(id);
        const el = t?._elements[0];
        if (!el) return;
        el.paused = !el.paused;
        fireUpdated(id, { audible: t.audible });
      },
      mute(id) {
        const t = tabs.get(id);
        t.mutedInfo = { muted: !t.mutedInfo.muted, reason: t.mutedInfo.muted ? '' : 'extension' };
        fireUpdated(id, { mutedInfo: t.mutedInfo, audible: t.audible });
      },
      /** Advance playing media one second (drives the popup's ping loop). */
      tick() {
        for (const t of tabs.values()) {
          for (const el of t._elements) {
            if (!el.paused && Number.isFinite(el.duration) && el.duration > 0) {
              el.currentTime = Math.min(el.duration, el.currentTime + 1);
            }
          }
        }
      },
    },
  };

  window.chrome = chrome;
  return chrome;
}

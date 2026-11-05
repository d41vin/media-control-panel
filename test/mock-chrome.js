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
    defaultPlaybackRate: props.defaultRate ?? 1,
    readyState: props.readyState ?? 4,
    isConnected: true,
    title: props.title ?? '',
    // minimal EventTarget surface so injected listeners (speed manager) attach
    _listeners: {},
    addEventListener(type, fn) {
      (this._listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      this._listeners[type] = (this._listeners[type] ?? []).filter((f) => f !== fn);
    },
    dispatch(type) {
      for (const fn of this._listeners[type] ?? []) fn({ target: this });
    },
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
    active: !!def.active,
    mutedInfo: def.muted ? { muted: true, reason: 'extension' } : { muted: false, reason: '' },
    // harness-only handles
    _elements: elements,
    _injectable: def.injectable !== false,
    _siteButtons: def.siteButtons ?? {}, // '.selector' -> click counter name
    _clicks: {},
  };
  Object.defineProperty(tab, '_doc', {
    get() {
      const els = this._elements;
      const tabRef = this;
      return {
        // a REAL detached node: injected managers observe it with the page's
        // genuine MutationObserver, which rejects plain-object stand-ins
        documentElement: document.createElement('div'),
        querySelectorAll(sel) {
          if (sel === 'video, audio' || sel === 'video') {
            return els.filter((el) => (sel === 'video' ? el.tagName === 'VIDEO' : true));
          }
          return []; // no shadow roots in the fake pages
        },
        querySelector(sel) {
          if (sel in tabRef._siteButtons) {
            // a stand-in for a real, visible, enabled site button — probed
            // by pageProbe's availability check (hidden/disabled/aria all
            // read), so it must answer like a live element
            return {
              disabled: false,
              hidden: false,
              getAttribute: () => null,
              getClientRects: () => [{}],
              click() {
                const key = tabRef._siteButtons[sel];
                tabRef._clicks[key] = (tabRef._clicks[key] ?? 0) + 1;
              },
            };
          }
          return null;
        },
        // player-API sync functions probe the page for a private player; the
        // fake pages have none, so the probe must resolve cleanly to null
        getElementById() {
          return null;
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
  const onCreated = [];
  const onActivated = [];
  const storageChanged = [];
  const runtimeMessageHandlers = [];
  const onCommitted = [];
  const onHistoryState = [];
  const onReferenceFragment = [];
  let docIdSeq = 0;
  const session = new Map(Object.entries(sessionSeed));
  const local = new Map();
  // extension API call logs — the background harness asserts on these
  const scriptingCalls = [];
  const sentTabMessages = [];

  const addTab = (def) => {
    const tab = fakeTab({ id: nextId++, ...def });
    tabs.set(tab.id, tab);
    // like the real API: a created tab fires tabs.onCreated with its Tab
    for (const fn of onCreated) fn({ ...tab, id: tab.id, windowId: tab.windowId, index: tab.index });
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
      onMessage: {
        addListener(fn) {
          runtimeMessageHandlers.push(fn);
        },
        removeListener(fn) {
          const i = runtimeMessageHandlers.indexOf(fn);
          if (i !== -1) runtimeMessageHandlers.splice(i, 1);
        },
      },
      /**
       * Broadcast to every listener registered in this context. Handlers must
       * filter by msg.type — the mock, like the real bus, does not route.
       */
      async sendMessage(msg) {
        for (const fn of [...runtimeMessageHandlers]) {
          await fn(msg, {
            id: 'mock-extension',
            tab: msg.__senderTab,
            documentId: msg.__senderDocId,
            frameId: msg.__senderFrameId ?? 0,
          });
        }
      },
      async getContexts({ contextTypes } = {}) {
        if (contextTypes?.includes('OFFSCREEN_DOCUMENT') && chrome.offscreen._created > chrome.offscreen._closed) {
          return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
        }
        return [];
      },
    },

    offscreen: {
      _created: 0,
      _closed: 0,
      async createDocument() {
        // a test-installed gate holds creation open so a cancellation during
        // offscreen-document setup can be exercised deterministically
        const gate = chrome._mock.offscreenCreateGate;
        if (gate) await gate;
        this._created++;
      },
      async closeDocument() {
        this._closed++;
      },
    },

    tabCapture: {
      async getMediaStreamId({ targetTabId } = {}) {
        const t = tabs.get(targetTabId);
        if (!t) throw new Error('No tab with id');
        if (t._injectable === false) throw new Error('Cannot capture this tab');
        // a test-installed gate holds the resolution open so cancellation
        // paths can be exercised deterministically
        const gate = chrome._mock.tabCaptureGates.get(targetTabId);
        if (gate) await gate;
        return `mock-stream-${targetTabId}`;
      },
    },

    tabs: {
      async query(filter = {}) {
        return [...tabs.values()]
          .filter((t) => filter.audible === undefined || t.audible === filter.audible)
          .filter((t) => filter.muted === undefined || !!t.mutedInfo?.muted === filter.muted)
          .filter((t) => filter.active === undefined || !!t.active === filter.active)
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
        if (props.active === true && !t.active) {
          for (const other of tabs.values()) other.active = other.id === id;
          for (const fn of onActivated) fn({ tabId: id, windowId: t.windowId });
        }
        return { ...t };
      },
      async remove(id) {
        if (!tabs.has(id)) throw new Error('No tab with id');
        tabs.delete(id);
        for (const fn of onRemoved) fn(id);
      },
      async sendMessage(tabId, msg) {
        // no page-level managers exist in the mock; record for assertions
        sentTabMessages.push({ tabId, msg });
      },
      onUpdated: { addListener: (fn) => onUpdated.push(fn) },
      onRemoved: { addListener: (fn) => onRemoved.push(fn) },
      onCreated: { addListener: (fn) => onCreated.push(fn) },
      onActivated: { addListener: (fn) => onActivated.push(fn) },
    },

    windows: {
      async update() {},
    },

    webNavigation: {
      onCommitted: { addListener: (fn) => onCommitted.push(fn) },
      onHistoryStateUpdated: { addListener: (fn) => onHistoryState.push(fn) },
      onReferenceFragmentUpdated: { addListener: (fn) => onReferenceFragment.push(fn) },
    },

    scripting: {
      async executeScript({ target, func, args, world }) {
        scriptingCalls.push({
          target: { ...target },
          func: func?.name ?? 'anonymous',
          args,
          world: world ?? 'ISOLATED',
        });
        // the real API has no singular `frameId` on the target — Chrome would
        // silently ignore it; the mock rejects so the mistake can't return
        if ('frameId' in target) {
          throw new Error('ScriptInjectionTarget uses frameIds: [id], not frameId');
        }
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
        // a test-installed one-shot failure (see failNextExecuteScript) —
        // thrown BEFORE running the function, like the real API
        const failOnce = chrome._mock._failOnce;
        if (failOnce && failOnce.tabId === target.tabId) {
          chrome._mock._failOnce = null;
          (chrome._mock._failLog ??= []).push({ func: func?.name, msg: failOnce.message });
          throw new Error(failOnce.message);
        }
        const before = tab.audible;
        const result = target.allFrames
          ? [{ frameId: 0, result: runIn(tab._doc) }]
          : (target.frameIds ?? [0]).map((frameId) => ({ frameId, result: runIn(tab._doc) }));
        // like real Chrome, where injected play/pause flips the tab's audible
        // state and that arrives as a tabs.onUpdated event
        if (tab.audible !== before) fireUpdated(target.tabId, { audible: tab.audible });
        return result;
      },
    },

    storage: (() => {
      // session and local behave identically; onChanged carries the area name
      const makeArea = (name, map) => ({
        async get(keys) {
          // test hook: a held gate keeps reads pending so a scenario can fire
          // a message INSIDE the worker's cold-start window, before its
          // startup state load completes (test/background-restart.html's
          // cold-race scenario). Never set outside that page.
          if (chrome._mock?.storageGetGate) await chrome._mock.storageGetGate;
          if (typeof keys === 'string') return { [keys]: map.get(keys) };
          if (Array.isArray(keys)) {
            return Object.fromEntries(keys.map((k) => [k, map.get(k)]));
          }
          if (keys && typeof keys === 'object') {
            return Object.fromEntries(
              Object.keys(keys).map((k) => [k, map.has(k) ? map.get(k) : keys[k]]),
            );
          }
          return {};
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) {
            changes[k] = { oldValue: map.get(k), newValue: v };
            map.set(k, v);
          }
          for (const fn of storageChanged) fn(changes, name);
        },
        async remove(key) {
          const oldValue = map.get(key);
          if (!map.has(key)) return;
          map.delete(key);
          for (const fn of storageChanged) fn({ [key]: { oldValue } }, name);
        },
      });
      return {
        session: makeArea('session', session),
        local: makeArea('local', local),
        onChanged: { addListener: (fn) => storageChanged.push(fn) },
      };
    })(),

    // --- harness-only handles ----------------------------------------------

    _mock: {
      tabs,
      addTab,
      fireUpdated,
      scriptingCalls,
      sentTabMessages,
      /** Deliver a runtime message as if it came from an extension context. */
      fireMessage(msg, sender = {}) {
        return chrome.runtime.sendMessage({ ...msg, __senderTab: sender.tab });
      },
      /** Deliver a runtime message as if it came from inside a tab. */
      fireMessageFromTab(msg, tabId, documentId, frameId = 0) {
        const t = tabs.get(tabId);
        return chrome.runtime.sendMessage({
          ...msg,
          __senderTab: t ? { id: t.id, url: t.url } : undefined,
          __senderDocId: documentId ?? t?._committedDocId,
          __senderFrameId: frameId,
        });
      },
      fireActivated(tabId) {
        for (const other of tabs.values()) other.active = other.id === tabId;
        for (const fn of onActivated) fn({ tabId, windowId: 1 });
      },
      /**
       * A full top-level navigation commits: the tab's URL becomes `url` and
       * the committed document gets a fresh documentId (Chrome's identity —
       * a same-URL reload changes it). Pass `documentId` to pin one.
       */
      fireCommitted(tabId, url, documentId) {
        const t = tabs.get(tabId);
        const docId = documentId ?? `doc-${++docIdSeq}`;
        if (t) {
          t.url = url;
          t._committedDocId = docId;
        }
        for (const fn of onCommitted) fn({ tabId, frameId: 0, url, documentId: docId, transitionType: 'link' });
      },
      /** A same-document SPA transition: URL changes, document does not. */
      fireHistoryState(tabId, url) {
        const t = tabs.get(tabId);
        if (t) t.url = url;
        for (const fn of onHistoryState) fn({ tabId, frameId: 0, url });
      },
      /**
       * A subframe's document commits: record its identity WITHOUT touching
       * the tab URL (the top-level page is unchanged).
       */
      fireFrameCommitted(tabId, frameId, url, documentId) {
        const docId = documentId ?? `doc-${++docIdSeq}`;
        for (const fn of onCommitted) fn({ tabId, frameId, url, documentId: docId, transitionType: 'auto_subframe' });
      },
      /** A hash-only change: URL changes, document does not. */
      fireReferenceFragment(tabId, url) {
        const t = tabs.get(tabId);
        if (t) t.url = url;
        for (const fn of onReferenceFragment) fn({ tabId, frameId: 0, url });
      },
      /**
       * Hold getMediaStreamId for a tab open until `release()` is called —
       * the deterministic way to test cancellation mid-startup.
       */
      gateCapture(tabId) {
        let release;
        const promise = new Promise((r) => {
          release = r;
        });
        this.tabCaptureGates.set(tabId, promise);
        return {
          release: () => {
            this.tabCaptureGates.delete(tabId);
            release();
          },
        };
      },
      /**
       * Hold offscreen-document creation open until `release()` is called —
       * the deterministic way to test a cancellation during document setup.
       */
      gateOffscreenCreate() {
        let release;
        const promise = new Promise((r) => {
          release = r;
        });
        this.offscreenCreateGate = promise;
        return {
          release: () => {
            this.offscreenCreateGate = null;
            release();
          },
        };
      },
      offscreenCreateGate: null,
      tabCaptureGates: new Map(),
      /** Fail the next executeScript for this tab with this error (once) —
          the deterministic way to exercise the worker's transient-failure
          retry classification. */
      failNextExecuteScript(tabId, message) {
        this._failOnce = { tabId, message };
      },
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

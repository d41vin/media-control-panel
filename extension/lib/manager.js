// The page-level speed manager, injected with chrome.scripting.executeScript
// into every injectable frame of a tab whenever a speed policy needs
// enforcing (global speed ≠ 1.00×, or the page has an override).
//
// Event-driven by design: per-element `ratechange`/`play` listeners plus a
// debounced MutationObserver for media added later. No polling loop. When no
// policy needs enforcing the background sends 'mcp-speed-disconnect' and
// every listener, observer and reference here is removed.
//
// The rate model (mirrors lib/speed.js precedence rules):
//   - `expected` is the rate this page should be at (override, else global).
//     `rev` is the policy revision the background assigned (see DESIGN.md):
//     it advances on every policy mutation, and both applies and reports
//     carry it, so stale messages from a superseded policy can never land.
//   - Writing the policy sets BOTH `playbackRate` and `defaultPlaybackRate`.
//     The media load algorithm resets `playbackRate` to `defaultPlaybackRate`
//     whenever a source (re)loads, so stamped elements survive src swaps and
//     site re-inits with no event handling at all. The site's prior default
//     is remembered per element and restored on teardown.
//   - Assignments we make produce ratechange events at `expected` — ignored
//     via one echo credit per assignment, so there is no feedback loop.
//   - Any OTHER observed rate is the page speaking: it is reported to the
//     background (with rev), which adopts it as the page override (or drops
//     the override when it lands exactly on the global rate). The extension
//     never fights the page — EXCEPT when the injection carries
//     adoptForeign: false (a per-page command from the popup): the user has
//     just chosen this tab's rate, so pre-existing foreign rates are
//     overwritten, not adopted, and the command cannot be undone by a stale
//     report.
//   - Media encountered at the default 1.00× is treated as untouched and
//     receives `expected` (on injection, or when it starts playing). Media
//     already running at a non-default rate is adopted instead of clobbered
//     (adoption is what install-time and play-time encounters do).
//
// Serialization rules as lib/page.js: the export is fully self-contained —
// no imports, no module-scope references — because executeScript serializes
// it with Function.prototype.toString. It runs in the ISOLATED world, so
// chrome.runtime messaging is available.

export function installSpeedManager(init) {
  // Re-injection (SW restart, repeated sync) updates the expectation in place
  // instead of stacking a second set of listeners.
  const prior = window.__mcpSpeed;
  if (prior) {
    prior.expected = init.rate;
    prior.rev = typeof init.rev === 'number' ? init.rev : prior.rev;
    prior.adoptForeign = init.adoptForeign !== false;
    prior.applyAll();
    return { managed: prior.list.length, expected: prior.expected };
  }

  const S = {
    expected: init.rate,
    rev: typeof init.rev === 'number' ? init.rev : 0,
    adoptForeign: init.adoptForeign !== false,
    list: [],
    observer: null,
    scanTimer: 0,
    handler: null,
  };
  // One echo credit per assignment we make: media events fire ASYNCHRONOUSLY,
  // so the ratechange from our own assignment can dispatch after `expected`
  // has already moved on (rapid global changes, an element ending in
  // between). Credits — not a rate comparison — are what distinguish our
  // late echoes from genuine page changes. Because coalesced echoes read the
  // element's CURRENT rate, an echo of an older write can arrive after a
  // newer write changed both the rate and the `__mcpRate` marker — so the
  // matcher checks a small ring of recently-assigned rates, not just the last.
  const echoCredits = new WeakMap();
  const sentRates = new WeakMap(); // el -> rates we assigned, most recent last

  const collect = () => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  };

  const near = (a, b) => Math.abs(a - b) < 1e-6;

  // MediaStream-backed elements (srcObject — live capture previews) cannot
  // hold an arbitrary playbackRate: Chromium clamps the write and fires a
  // ratechange at the clamped value, which would bounce back forever as a
  // "page choice". They are unmanageable — skip them entirely.
  const unmanageable = (el) => !!el.srcObject;

  /**
   * Enforce `expected` on one element. The assignment is marked on the
   * element (`__mcpRate` + `__mcpRev`, isolated-world only): if this manager
   * is later re-injected, a rate we set ourselves must not be misread as a
   * deliberate page choice. `defaultPlaybackRate` gets the same target so
   * the load algorithm re-applies the policy on source changes.
   *
   * Playing media is enforced blindly — a foreign rate on playing media was
   * already reported via ratechange. Paused/ended media keeps its foreign
   * rate when this injection is a plain sync (the page may have chosen it;
   * adopt-on-play will report it) and takes the policy when the injection is
   * a user command (adoptForeign: false — a page-speed choice or a reset),
   * so a reset reaches paused media and cannot be undone by the old value.
   */
  const applyTo = (el) => {
    if (unmanageable(el)) return;
    const playing = !el.paused && !el.ended;
    if (!playing && S.adoptForeign) {
      const ours = typeof el.__mcpRate === 'number' && near(el.__mcpRate, el.playbackRate);
      if (!near(el.playbackRate, S.expected) && !near(el.playbackRate, 1) && !ours) return;
    }
    // Chromium fires a ratechange for the defaultPlaybackRate write as well
    // as the playbackRate write — one credit per actual attribute write, or
    // the second echo escapes and gets adopted as a bogus page choice.
    let echoes = 0;
    if (!near(el.playbackRate, S.expected)) {
      el.playbackRate = S.expected;
      el.__mcpRate = S.expected;
      el.__mcpRev = S.rev;
      echoes++;
    }
    if (!near(el.defaultPlaybackRate ?? S.expected, S.expected)) {
      try {
        if (typeof el.__mcpPrevDefault !== 'number') el.__mcpPrevDefault = el.defaultPlaybackRate;
        el.defaultPlaybackRate = S.expected;
        echoes++;
      } catch {
        // a wrapped element may refuse; playbackRate enforcement still holds
      }
    }
    if (echoes > 0) {
      echoCredits.set(el, (echoCredits.get(el) ?? 0) + echoes);
      const sent = sentRates.get(el) ?? [];
      sent.push(S.expected);
      if (sent.length > 4) sent.shift();
      sentRates.set(el, sent);
    }
  };

  S.applyAll = () => {
    for (const el of S.list) applyTo(el);
  };

  const report = (rate) => {
    if (near(rate, S.expected)) return;
    try {
      const p = chrome.runtime.sendMessage({ type: 'mcp-speed-report', rate, rev: S.rev });
      if (p && typeof p.catch === 'function') p.catch(() => void teardown());
    } catch {
      void teardown(); // extension context gone (reload/update)
    }
  };

  const adopt = (el) => {
    // Encounter rule: media at the default 1.00×, or at a rate this extension
    // set itself (marked __mcpRate), is untouched-by-the-page and receives
    // `expected`. Media already running at any other rate made its own choice
    // and is adopted rather than clobbered — unless this injection came from
    // a per-page command (adoptForeign: false), in which case the user's
    // fresh choice outranks whatever the element was doing.
    if (near(el.playbackRate, S.expected)) return;
    const ours = typeof el.__mcpRate === 'number' && near(el.__mcpRate, el.playbackRate);
    if (near(el.playbackRate, 1) || ours || !S.adoptForeign) applyTo(el);
    else report(el.playbackRate);
  };

  const onRateChange = (e) => {
    const el = e.target;
    const credits = echoCredits.get(el) ?? 0;
    if (credits > 0) {
      const sent = sentRates.get(el) ?? [];
      if (sent.some((r) => near(r, el.playbackRate))) {
        echoCredits.set(el, credits - 1); // our own echo (possibly a late one)
        return;
      }
    }
    if (near(el.playbackRate, S.expected)) return; // page matched our policy
    report(el.playbackRate); // the page (user or site JS) changed the rate
  };

  const onPlay = (e) => adopt(e.target);

  const attach = (el) => {
    if (unmanageable(el) || S.list.includes(el)) return;
    el.addEventListener('ratechange', onRateChange);
    el.addEventListener('play', onPlay);
    S.list.push(el);
    adopt(el); // media already playing right now
  };

  const scan = () => {
    for (const el of collect()) attach(el);
  };

  const scheduleScan = (mutations) => {
    // attribute-only mutations (the most frequent kind on busy pages) never
    // trigger a DOM walk — only actual element insertions do
    const added = mutations.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1));
    if (!added || S.scanTimer) return;
    S.scanTimer = setTimeout(() => {
      S.scanTimer = 0;
      scan();
    }, 200);
  };

  S.handler = (msg) => {
    if (!msg || typeof msg.type !== 'string') return;
    if (msg.type === 'mcp-speed-apply') {
      // an apply older than the revision we already hold is a replay of a
      // superseded policy — two applies must never land out of order
      if (typeof msg.rev === 'number' && msg.rev < S.rev) return;
      S.expected = msg.rate;
      S.rev = typeof msg.rev === 'number' ? msg.rev : S.rev;
      S.applyAll();
    } else if (msg.type === 'mcp-speed-disconnect') {
      teardown();
    }
  };
  chrome.runtime.onMessage.addListener(S.handler);

  S.observer = new MutationObserver(scheduleScan);
  S.observer.observe(document.documentElement, { childList: true, subtree: true });

  // the re-injection anchor: without this, every sync stacks a fresh manager
  // (fresh listeners, stale expectations) on the same elements
  window.__mcpSpeed = S;

  scan();

  function teardown() {
    if (S.scanTimer) clearTimeout(S.scanTimer);
    // listeners go first: restoring the inheriting media to 1.00× below must
    // not fire ratechange into our own reporter and resurrect a policy
    for (const el of S.list) {
      el.removeEventListener('ratechange', onRateChange);
      el.removeEventListener('play', onPlay);
    }
    // the policy is being lifted (global is back to 1.00×, no overrides):
    // media this extension moved to the old expected rate returns to 1.00× —
    // paused media included, so nothing is stranded at a dead rate — and the
    // stamped defaultPlaybackRate values go back to the site's own choices,
    // so nothing we did can later be mistaken for a native player setting
    for (const el of S.list) {
      if (near(el.playbackRate, S.expected)) el.playbackRate = 1;
      if (typeof el.__mcpPrevDefault === 'number') {
        try {
          if (!near(el.defaultPlaybackRate ?? el.__mcpPrevDefault, el.__mcpPrevDefault)) {
            el.defaultPlaybackRate = el.__mcpPrevDefault;
          }
        } catch {
          // wrapped element; nothing to restore
        }
      }
      delete el.__mcpRate;
      delete el.__mcpRev;
      delete el.__mcpPrevDefault;
    }
    S.observer?.disconnect();
    if (S.handler) chrome.runtime.onMessage.removeListener(S.handler);
    delete window.__mcpSpeed;
  }

  return { managed: S.list.length, expected: S.expected };
}

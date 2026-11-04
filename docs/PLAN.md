# Plan — v2.0 rebuild (2026-10-04), v2.1 feature release (2026-10-28)

Mission: rebuild the extension as an action popup — Chrome's Global Media
Controls behavior, Swiss design — pure HTML/CSS/JS, no build step, no
frameworks, minimal idle resource use. See RESEARCH.md for why and DESIGN.md
for the look.

**Status: v2.0 and v2.1 shipped; the project is finished for now.** The final
release (player-owned mute synchronization, 16× speed range, Chrome-first
verification) is documented in README.md and DESIGN.md and was last verified in
Google Chrome 156.0.8078.76 on 2026-11-04. Build order below was followed;
deviations and additions are recorded in git history.

## Architecture

```
extension/
  manifest.json        MV3 — permissions: scripting+storage+tabCapture+offscreen;
                       host: <all_urls>
  popup.html/css/js    the whole UI; lives only while open
  background.js        badge + keyboard commands + speed-policy authority +
                       boost routing; sleeps otherwise
  lib/page.js          functions injected via executeScript (probe + controls);
                       imported as source by popup & background
  lib/manager.js       conditional page-level speed manager (event-driven,
                       self-removing), injected only while a policy is active
  lib/speed.js         shared speed model (range, stepping, formatting, storage)
  lib/adapters.js      per-site capabilities: next/prev track
                       (YouTube/Spotify/SoundCloud, injected on click) plus the
                       YouTube player integration (MAIN world, feature-detected
                       internal #movie_player methods — next/prev and
                       speed/volume/mute sync; see DESIGN.md Y1/Y2)
  lib/settings.js      shared settings model (chrome.storage.local)
  offscreen.html/js    audio boost pipeline (capture → gain → limiter → output)
  icons/               generated Swiss mark (scripts/make-icons.mjs)
```

Data flow:

- **Detect** — `tabs.query({})` → candidates = audible ∪ muted ∪ pinned ∪
  recently-playing (session list kept by the badge worker).
- **Probe** — one `executeScript({allFrames:true})` per candidate returns media
  elements (shadow-DOM aware) with state + frameIds (+ mediaSession artwork).
- **Control** — `executeScript` into the element's frame; mute via
  `tabs.update` (no injection); play state confirmed by `tabs.onUpdated`
  audible events, not re-probing.
- **Speed** — popup writes the global speed or page overrides through the
  background, which owns the policy: it injects/updates/removes the page
  managers (`lib/manager.js`) so the policy holds while the popup is closed.
  Page-originated `ratechange` reports flow back through the worker.
- **Boost** — popup (user gesture) → `tabCapture.getMediaStreamId` →
  background ensures the offscreen document → offscreen Web Audio graph;
  session state is the truth.
- **Badge** — worker listens to tab events, early-exits unless
  audible/muted/removal changed, updates count only on change.
- **Pin target** — one tab stored in `chrome.storage.session`; keyboard
  command toggles its playback without opening the popup.
- **Settings** — one normalized object in `chrome.storage.local`
  (`lib/settings.js`, shared by popup and background): auto-pause on open
  (opt-in), playing-count badge, recently-playing list.

## Deliberately dropped from v0.1 (with reasons)

- Per-*element* cards — one card per *tab* (Chrome GMC model). Multi-element
  tabs expose the primary element; count shown if >1.
- `tabs` permission, `sidePanel` permission, esbuild/TypeScript toolchain.
- Permanent per-hostname speed preferences — overrides are per-page and
  session-scoped by design; domain memory is a future opt-in if wanted.

## Roadmap

Shipped since the v2.0 release (tracked in git history):

1. ~~Site adapters for next/prev track~~ — shipped: YouTube, Spotify,
   SoundCloud (`lib/adapters.js`), injected only on click.
2. ~~Exclusive playback mode (play one, pause rest)~~ — shipped: Alt+click a
   card's play button.
3. ~~Auto-pause-on-popup-open setting~~ — shipped as an opt-in setting, along
   with the badge and recently-playing toggles (`lib/settings.js`).
4. ~~Media-card redesign~~ — shipped (v2.1): every everyday control on the
   card, no details accordion; popovers for volume/boost/menu.
5. ~~Global playback speed with per-page overrides~~ — shipped (v2.1):
   persisted global default, page overrides with native-ratechange respect,
   conditional page managers. See RESEARCH.md for the precedence rules and
   the honest lifecycle trade-off.
6. ~~Tab volume boost 100–600 %~~ — shipped (v2.1): tabCapture + offscreen
   Web Audio gain, per-tab, released at reset, truthful state. See
   RESEARCH.md for the documented API flow and permissions.
7. ~~Speed reliability audit + corrective pass~~ — shipped (2026-10-31): the
   page manager anchors itself for true idempotent re-injection, the state
   model is normative (DESIGN.md R1–R7) with per-tab policy revisions, SPA vs
   committed navigation is split via `webNavigation`, enforcement stamps
   `defaultPlaybackRate` (the Global Speed pattern), reset reaches paused
   media atomically, echo suppression is a per-write ledger instead of a time
   window, and two storage races are closed. A 16-step deterministic speed
   matrix (`test/speed-suite.html`) plus 42 mock assertions pin it down.
8. ~~Final correctness pass~~ — shipped (2026-11-02): boost pending-gain
   ordering, per-request capture cancellation (delayed-operation tests),
   documentId-scoped overrides (same-URL reload clears, SPA/hash keep),
   declared `activeTab`, and `fmtSpeed` off-grid precision.
9. ~~Reliability corrections (second pass)~~ — shipped (2026-11-02): frame-aware
   report provenance, full-scope boost startup cancellation + end-to-end
   deadline, offscreen failure cleanup and restart reconciliation, and
   global-speed coverage of every open injectable tab.
10. ~~UI polish pass~~ — shipped (2026-10-31): Chromium-style transport row
   (prev → −10 s → seek+times → +10 s → next) with stable disabled states
   (adapters, live streams), rounded popup stage (14 px body, 12 px cards),
   corrected icon semantics (mute pair vs waved volume vs speaker+plus boost,
   gauge, ±10 circular arrows), and menu-item glyphs.
10b. ~~Manual-test fixes and final UX polish~~ — shipped (2026-11-02):
   player-initialization settling window (new tabs and SPA video changes keep
   the global/override policy), startup state gate + `tabs.onCreated`,
   authoritative mute reconciliation (no duplicate cards / stale toggles),
   tab-level boost persistence across navigation, appearance selector,
   5 %/10 % slider steps, adapter hidden-state handling, standard-volumechange
   fixture, and frame-gap-free theming.

## Not built — optional or deferred, not unfinished work

These were considered and deliberately left out; none is required for the
extension to be complete:

- Playlist autoplay (would need injected `ended` listeners — weighed against
  the idle cost).
- Boost limiter tuning / optional compressor presets for music vs speech.
- Remembering speed per hostname (opt-in; speed is currently per-page
  override, session-scoped).

## Known limitations (by design or platform)

- Closed shadow roots, DRM-protected pages and WebAudio-only playback are
  unreachable for every extension in this category.
- Native player UI synchronization exists only for YouTube, through its
  feature-detected **internal** `#movie_player` methods (not the official
  IFrame Player API; they may change). Element-level control remains the
  fallback.
- Spotify and SoundCloud expose no reliable public player API: no native UI
  synchronization there.
- The action popup's outer frame is browser-owned (square on Chrome); the
  extension styles only the content surface.
- Boost audibility/distortion cannot be judged by automation.

## Manual checks that remain

- **Capture success with a real toolbar click.** The `activeTab` grant cannot
  be granted by automation, so `npm run verify-capture` records the browser's
  refusal instead; start a boost from a real toolbar invocation to confirm
  capture on a normal desktop (CHECKLIST #59d).
- Audio quality by ear: boost loudness/distortion/leakage (CHECKLIST #53) and
  the YouTube menu/indicator sync (#45b, #45c).

## Build order (one conventional commit each)

1. docs: research + design + plan
2. feat(popup): Swiss shell — manifest, popup.html/css, tokens, header/footer
3. feat(popup): detection & list (probe lib, rendering, live updates)
4. feat(popup): controls (play/pause, mute, seek, volume, speed, PiP, tab
   actions, expanded panel)
5. feat(popup): global actions + pinned target
6. feat(background): badge + keyboard commands
7. chore: remove v0.1 side panel, TS toolchain, dist
8. test: mock harness + docs; README rewrite
9. improve: audit pass per shadcn/improve rubric, fix findings

v2.1 was built in one pass (speed backend → boost backend → popup redesign →
tests → docs); see the final report in the task thread and git history for
the breakdown.

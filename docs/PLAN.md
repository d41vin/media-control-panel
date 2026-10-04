# Plan — v2.0 rebuild (2026-10-04)

Mission: rebuild the extension as an action popup — Chrome's Global Media
Controls behavior, Swiss design — pure HTML/CSS/JS, no build step, no
frameworks, minimal idle resource use. See RESEARCH.md for why and DESIGN.md
for the look.

**Status: shipped.** Build order below was followed; deviations and additions
are recorded in git history (recently-playing list, letter tiles, muted glyph
and the truthful play-state model came out of testing).

## Architecture

```
extension/
  manifest.json        MV3 — permissions: scripting+storage; host: <all_urls>
  popup.html/css/js    the whole UI; lives only while open
  background.js        badge count + keyboard commands; sleeps otherwise
  lib/page.js          functions injected via executeScript (probe + controls);
                       imported as source by popup & background
  icons/               generated Swiss mark (scripts/make-icons.mjs)
```

Data flow (no persistent content scripts anywhere):

- **Detect** — `tabs.query({})` → candidates = audible ∪ muted ∪ pinned.
- **Probe** — one `executeScript({allFrames:true})` per candidate returns media
  elements (shadow-DOM aware) with state + frameIds.
- **Control** — `executeScript` into the element's frame; mute via
  `tabs.update` (no injection); play state confirmed by `tabs.onUpdated`
  audible events, not re-probing.
- **Badge** — worker listens to tab events, early-exits unless
  audible/muted/removal changed, updates count only on change.
- **Pin target** — one tab stored in `chrome.storage.session`; keyboard
  command toggles its playback without opening the popup.

## Deliberately dropped from v0.1 (with reasons)

- Global "default speed, auto-apply to new media" — required the always-on
  content script we are deleting. Per-tab speed control stays.
- Per-*element* cards — one row per *tab* (Chrome GMC model). Multi-element
  tabs expose the primary element; count shown if >1.
- `tabs` permission, `sidePanel` permission, esbuild/TypeScript toolchain.

## Roadmap (post-v2.0, in priority order)

1. Site adapters for next/prev track (YouTube first) — opt-in quality layer.
2. Exclusive playback mode (play one, pause rest).
3. Playlist autoplay (needs injected `ended` listeners — weigh idle cost).
4. Volume boost via tabCapture (rejected for battery; revisit as opt-in).
5. Auto-pause-on-popup-open setting (TabNoodle idea).

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

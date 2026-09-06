# Media Control Panel

A fast, lightweight Chrome extension that puts every video and audio player in your browser into
one side panel — play, pause, seek, per-item volume and speed, and more. Inspired by Chrome's
built-in Global Media Controls, but far more capable: it works across tabs, exposes per-item
volume and playback rate, and applies global defaults that sites can't silently take away.

Everything is local: no accounts, no analytics, no network requests. Live session data is kept in
memory and `chrome.storage.session` (cleared when the browser closes); preferences live in
`chrome.storage.local` on your machine only.

## Features (v0.1)

- **Cross-tab media cards** — every `<audio>`/`<video>` element in every tab (including
  cross-origin iframes) shows up as a card with artwork/favicon, title, site and live/paused state.
- **Transport controls** — play/pause, −10 s / +10 s seek, and drag-to-scrub progress bar.
- **Per-item volume and mute** — 0–100 % per media element, independent of tab/site volume.
- **Per-item playback speed** — 0.25×–4× slider per card.
- **Global default speed** — set a default (e.g. 1.25×) that is applied automatically when media
  appears or starts playing, until a per-item override takes over. Applied "once", not enforced —
  sites can still change speed afterwards (enforcement/"lock" mode is on the roadmap).
- **Jump to source** — clicking a card focuses that tab and window.
- **Pin** — mark one item as the command target (used by future shortcuts).
- **Pause all / Mute all** across every registered item.
- **Live-stream aware** — live media is labelled and seeks are disabled.

## Install (unpacked)

1. Build: `npm install && npm run build` (output lands in `dist/`).
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, select `dist/`.
3. Click the toolbar icon to open the side panel. To use it in private windows also enable
   **Allow in Incognito** on the extension card.

## Try it

`npm run serve`, then open <http://localhost:8080/test/media-page.html> — a fixture page with two
remote videos, a local tone, a remote mp3 and a cross-origin YouTube embed. All five should appear
as separate cards.

## How it works

- **Content script** (all frames, all http/https sites): discovers media via a debounced
  `MutationObserver` and element events — no polling. It stays fully dormant (no ports, no
  messages) until a panel is attached, so pages without the panel open cost ~nothing.
- **Service worker**: keeps the session registry and routes commands. It sleeps whenever nothing
  happens; the registry is rebuilt from content-script snapshots whenever the panel reattaches.
- **Side panel**: vanilla DOM, no framework. Pings the worker every 20 s while open, interpolates
  progress locally, and receives at most ~1 progress update per second per playing item.
- Progress updates only flow **while the panel is open**; with the panel closed the extension is
  completely silent.

## Limitations

- Media inside **shadow DOM** players isn't discovered yet.
- **DRM** streams (Netflix etc.): transport controls generally work, but some sites reset
  extension-applied values; "lock" mode is planned to counter that.
- Metadata is read from the page's Media Session API when available, with DOM fallbacks.
- Some sites swap or recreate players aggressively; cards refresh automatically, but a broken
  card can be cleared by re-opening the panel.

## Roadmap

1. **Rules** — Global → Site → Tab → Item setting hierarchy with provenance badges and lock mode.
2. **Volume boost** — per-tab amplification beyond 100 % via `tabCapture` + a Web Audio gain stage
   (with limiter), which is why it will be a separate, per-tab opt-in control rather than a slider
   that silently crosses 100 %.
3. **Power features** — keyboard shortcuts (including optional hardware media-key interception),
   compact toolbar popup, configurable seek step.
4. **Provider adapters** — next/previous and queue controls for YouTube & co.
5. **Later** — PiP controls, A/B loop, sleep timer, EQ/balance/mono, automation rules.

## Development

- `npm run build` — bundle to `dist/`
- `npm run watch` — rebuild on change (reload the extension in Chrome to pick it up)
- `npm run typecheck` — strict TypeScript check
- `npm run serve` — static server for the test fixture page

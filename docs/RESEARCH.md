# Research — v2.0 rebuild

Findings that shaped the v2.0 architecture. Sources listed at the bottom.

## The pivot: side panel → action popup

v0.1 used a side panel with a content script injected into every page
(`document_idle`, all frames) that kept a `MutationObserver` watching the whole
document forever, plus a 20 s ping loop that pinned the service worker in memory
while the panel was open. Even "dormant", that is per-page observer setup on
every site the user visits — exactly the idle cost we are eliminating.

v2.0 is an action popup. A popup only exists while it is open; when closed, its
listeners, DOM and timers are destroyed by the browser for free. That single
change converts the extension from "runs on every page" to "runs when you look
at it".

## What Chrome's own Global Media Controls does (design target)

Chrome's media hub: a toolbar icon that appears when media plays; the popup
lists one card per playing session with artwork, title, site, play/pause,
prev/next and a seek bar. Internally it is powered by the MediaSessionService in
the browser process — **extensions cannot read Chrome's session list**. Every
extension in this space rebuilds an approximation from public APIs. Chrome's
panel also only *controls one session at a time*; batch control (pause all,
mute all) is a real gap we fill.

What we adopt: the popup form factor, one-row-per-playing-tab, the seek bar with
times, and the "toolbar icon shows you something is playing" affordance (our
badge). What we skip: artwork (adds image loads; favicon carries the identity in
less space), prev/next track (no extension API can invoke another page's media
session handlers — only Chrome-internal code can).

## How other extensions solve it

**tab-media-controller** (MIT, closest peer) — manifest `tabs`+`scripting`+
`activeTab`+`storage`, no persistent content scripts; popup probes tabs via
`chrome.scripting.executeScript` and injects play/pause/PiP on demand; badge
counts playing tabs; Alt+P toggles the most recent audible tab. Features worth
stealing: Picture-in-Picture toggle (`requestPictureInPicture()` from an
injected function — one line), and per-tab *close* and *go to tab*. Their
weakness: they probe **every** tab on popup open and only reach same-origin
iframes. We probe only audible/muted/pinned tabs and use `allFrames: true`.

**StreamKeys / site-adapter extensions** — maintain hand-written per-site
adapters (YouTube, Spotify, …) to drive player buttons. Powerful but brittle:
every site redesign breaks them, and the adapter table is dead weight for every
non-adapter site. We go the opposite way: generic `<video>`/`<audio>` element
control, which works on every site that uses standard elements, with zero
per-site code. (Trade-off recorded in the roadmap: adapter *quality* — e.g.
next/prev track — is the one thing generic elements can't do.)

**Volume Master / boost extensions** — implement volume >100 % via
`tabCapture` + Web Audio GainNode. `tabCapture` shows a persistent recording
indicator and keeps a real-time audio graph running — a constant CPU/battery
cost. Rejected for this project (stays on the roadmap as an opt-in note).
Element `.volume` (0–1) plus tab-level mute via `chrome.tabs.update({muted})`
covers the everyday cases at zero idle cost.

**TabNoodle** — auto-pauses playing media when its popup opens. Cute, but as a
default it punishes the common case (open popup to *check*, not to silence).
Roadmap as an opt-in setting if ever wanted.

**"Media Controller" (Web Store)** — total footprint ~12 KiB. Proof that this
category can be tiny; our budget: popup HTML+CSS+JS under ~20 KiB unpacked, no
webfonts, no frameworks, no images beyond icons.

## Permission research (least-privilege pass)

From the `chrome.tabs` reference:

- `tab.audible` and `tab.mutedInfo` require **no permission at all**.
- `chrome.tabs.update(tabId, {muted})` requires **no permission**.
- Reading `title` / `url` / `favIconUrl` needs the `tabs` permission **or host
  permissions for the page** — and we hold `<all_urls>` anyway for injection.

So the manifest drops the `tabs` permission entirely (its install warning is
"Read your browsing history"). Final set:

| Key | Value | Why |
|---|---|---|
| `permissions` | `scripting`, `storage` | on-demand injection; settings + pinned target |
| `host_permissions` | `<all_urls>` | `executeScript` into arbitrary media tabs; also unlocks tab titles in `tabs.query` |
| `commands` | 3 shortcuts | no permission needed |

`<all_urls>` is the one unavoidable scary warning — without host access we
cannot pause a video in a background tab, which is the entire product. It is
used only for on-demand injection (never persistent scripts) and costs nothing
at idle.

## MV3 performance rules applied

- Event listeners registered at top level of the service worker so events wake
  it reliably; handlers do cheap early-exit filtering before any async work.
- The service worker owns exactly one job while the popup is closed: keeping the
  badge count right. It listens to `tabs.onUpdated`/`onRemoved`, early-returns
  unless `audible`/`mutedInfo`/removal changed, and only calls
  `action.setBadgeText` when the count actually changes. No intervals, no ports,
  no keep-alives — the worker sleeps after 30 s like any MV3 worker.
- No `tabs.onUpdated` work in the popup either beyond cheap field copies.
- Seek bar: no polling loop. One thin probe per second *only while a row is
  expanded and playing*, plus local interpolation between probes; everything
  clears on collapse/close.
- Probe cost is bounded by real media usage: audible ∪ muted ∪ pinned tabs,
  typically 1–5 `executeScript` calls per popup open.

## Detection model

1. `chrome.tabs.query({})` (no permission needed) → candidate = `audible` or
   `mutedInfo.muted` or pinned target.
2. One probe per candidate: `executeScript({allFrames: true})` walks
   `video, audio` elements **including open shadow roots**, returns per-frame
   state (playing/paused, time, duration, live, volume, rate, media title from
   `navigator.mediaSession` when readable).
3. The audible event stream (`tabs.onUpdated` `changeInfo.audible`) is the
   source of truth for playing state while the popup is open — no re-probe
   needed after play/pause commands.

Known hard limits (all shared by every extension in this category, including
v0.1): DRM pages may refuse element-level seek; media inside closed shadow
roots or WebRTC/WebAudio-only playback is invisible; `muted` tabs with no media
can appear until probed (probe filters them).

## Sources

- Chrome blog — "Manage audio and video in Chrome with one click" (2020)
- The Verge — Chrome testing a toolbar play button (2019)
- chrome.tabs API reference — permission notes on `audible`/`mutedInfo`/`title`
- developer.chrome.com — Service worker event handling (top-level listeners,
  event filters)
- github.com/nuwanprabhath/tab-media-controller — architecture + feature review
- StreamKeys / Volume Master / TabNoodle — Web Store listings, pattern review
- shadcn/ui component catalog — component vocabulary mapping (see DESIGN.md)

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
less space). Prev/next track has no extension API (nothing can invoke another
page's media session handlers — only Chrome-internal code can), so v2.0 shipped
without it; the later per-site adapters (`lib/adapters.js`) close that gap where
a site exposes its own player buttons to click.

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
per-site code. (That trade-off is now partially closed: `lib/adapters.js` adds
opt-in adapter *quality* — next/prev on YouTube, Spotify and SoundCloud —
injected only on click, so non-adapter sites carry none of the weight.)

**Volume Master / boost extensions** — implement volume >100 % via
`tabCapture` + Web Audio GainNode. `tabCapture` shows a persistent recording
indicator and keeps a real-time audio graph running — a constant CPU/battery
cost. v2.0 rejected this globally; v2.1 ships it as an **explicitly opt-in,
per-tab** control (the user names the tab that gets amplified, the pipeline
exists only while a boost is above 100 %, and reset releases everything) —
the cost is now paid only where the user asked for it. See the tabCapture
addendum below.

**TabNoodle** — auto-pauses playing media when its popup opens. Cute, but as a
default it punishes the common case (open popup to *check*, not to silence).
Shipped here as an opt-in setting ("auto-pause on open") rather than a default.

**"Media Controller" (Web Store)** — total footprint ~12 KiB. Proof that this
category can be tiny; our starting budget: popup HTML+CSS+JS under ~20 KiB
unpacked, no webfonts, no frameworks, no images beyond icons. (The budget was
later relaxed as adapters, keyboard navigation and settings landed — the
extension is ~70 KB unpacked and still holds every other line of that budget.)

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
- developer.chrome.com — `commands` (allowed keys: `Space` is valid;
  `Alt+Shift+Space` parses), `action` (no theme-aware icons; badge APIs),
  `scripting` (func serialization rules; **`ScriptInjectionTarget` has only
  `frameIds: number[]` — there is no singular `frameId`, and a misspelled key
  is silently ignored, which is how the first build injected into the main
  frame instead of an iframe's media**)
- github.com/nuwanprabhath/tab-media-controller — architecture + feature review
- StreamKeys / Volume Master / TabNoodle — Web Store listings, pattern review
- shadcn/ui component catalog — component vocabulary mapping (see DESIGN.md)

## Testing the real extension (what we learned)

- **Branded Chrome 137+ ignores `--load-extension`** (the
  `DisableLoadExtensionCommandLineSwitch` workaround is also gone), and
  Chrome's own component extensions also register `service_worker` targets —
  match the worker by `url.endsWith('/background.js')`, never by scheme alone.
- The E2E rig (`scripts/e2e.mjs`) therefore drives **Edge** (Chromium, still
  honors `--load-extension`) over raw CDP with node's built-in WebSocket:
  popup.html opened as a page behaves like the real popup with full
  `chrome.*` context. 58 assertions, all passing.
- Edge rejects `Alt+Shift+P` (unassigned); it stays as the suggested key for
  Chrome, and every command is user-remappable.
- A browser binary was once downloaded into this OneDrive-synced repo for
  testing and the antivirus flagged it; it was removed immediately and the
  rig uses the installed Edge instead. Don't ship binaries in synced repos.
- **Headless environments can stop reporting `tab.audible`** while elements
  keep playing fine (observed mid-session on real hardware). The E2E rig
  detects this and gates only the audible-event-driven assertions (badge,
  live adoption), seeding the recent list — a real popup detection path — so
  everything probe-driven still runs.

## Addendum — global speed with per-page overrides (v2.1)

**The intent problem.** `ratechange` events carry no intent: a user picking
1.5× in YouTube's menu, site JS normalizing rates, and an ad-boundary reset
all look identical. The model therefore never guesses intent: *any* observed
rate away from the page's expected rate becomes the page's own override, and
the global speed is never forced onto an overridden page. Reset-to-global is
always one click away. Two special cases keep the model honest:

- A rate landing **exactly on the global rate** is indistinguishable from
  inheritance, so the override is dropped (the visible outcome is identical).
- Media encountered at the **default 1.00×** is treated as untouched and
  receives the policy; media already running at a non-default rate is adopted
  rather than clobbered.

**Echo handling — the hard part.** Media events fire asynchronously, so the
`ratechange` from our own assignment can dispatch late — after `expected` has
already moved on (rapid global changes, an element ending in between) — and
late events read the element's *current* rate, not the one that triggered
them. Two defenses, both tested: the page manager keeps per-element **echo
credits** (one per assignment; an event consumes a credit only if the
observed rate also matches the last rate we assigned on that element — a
coalesced event that reads a page-changed rate must not consume it), and the
background keeps a **last-applied rate + window** per tab so a report echoing
what we just wrote is ignored even if it slips past the manager.

**Enforcement lifecycle.** The policy is enforced by a page-level manager
(`lib/manager.js`) injected with `chrome.scripting.executeScript({allFrames})`
— in the ISOLATED world, so it can message the worker. It is **conditional**:
injected only into media candidate tabs while global ≠ 1.00× or an override
exists; event-driven (`ratechange`/`play` per element plus a debounced
MutationObserver for inserted media — no polling); idempotent across
re-injection (worker restarts are invisible to it); and self-removing on
disconnect, restoring media we had moved back to 1.00× so nothing is
stranded at a dead rate. There are still no content scripts in the manifest;
the honest trade-off is that *while a policy is active*, media tabs carry
extension event listeners.

**State ownership.** Global speed: `storage.local`. Page overrides:
`storage.session` keyed `{tabId: {url, rate, at}}` — they die with the
browser, never follow a navigation, and are cleared on tab close. Speed syncs
are serialized in the worker and read live state at run time, so two rapid
global changes can never land out of order.

## Addendum — tab capture + offscreen audio (v2.1, corrected 2026-10-29)

The documented MV3 flow, verified against the official docs and the
`sample.tabcapture-recorder` sample:

1. The popup's boost click reaches this extension's **service worker as an
   extension message** (user gestures propagate through extension
   messaging). The **worker** calls `chrome.tabCapture.getMediaStreamId
   ({targetTabId})` — the docs explicitly bless the service-worker →
   offscreen-document consumer path for the returned id ("a stream ID
   obtained in a service worker can be used in an offscreen document").
   Earlier builds fetched the id in the popup; the worker-side call removes
   any doubt about cross-context consumption.
2. Popup-facing and offscreen-facing boost commands use **different message
   types** (`mcp-boost-*` vs `mcp-boost-offscreen-*`): the offscreen document
   ignores everything else, so the popup's original broadcast can never
   reach it as a second start with the same one-time stream id. The worker
   additionally serializes starts **per tab** (a second start while one is
   in flight is dropped; the user's latest gain choice is applied once the
   first attempt lands).
3. The background ensures the offscreen document exists
   (`chrome.offscreen.createDocument`, reason **`USER_MEDIA`**) and forwards.
   The offscreen document consumes the id via
   `navigator.mediaDevices.getUserMedia({audio: {mandatory: {chromeMediaSource:
   'tab', chromeMediaSourceId}}})` — this **redirects** the tab's audio into
   the graph (the tab goes quiet and sounds only through the pipeline, which
   is why no pipeline is ever created at 100 %, and moving the slider back to
   100 % stops it). Chain: source → `GainNode` (1.0–6.0) →
   `DynamicsCompressorNode` as a soft limiter → destination. Gain changes
   ride `setTargetAtTime` on the existing node — no restart.
4. **Reason choice matters for lifetime**: the offscreen docs state
   "The AUDIO_PLAYBACK reason sets the document to close after 30 seconds
   without audio playing", while other reasons set no lifetime limit. A
   boosted tab that is merely PAUSED would silence the pipeline and let
   Chrome destroy it while session state still claims active — so the
   document is created with `USER_MEDIA` ("interacting with media streams,
   e.g. getUserMedia()", the same reason the official tab-capture sample
   uses).
5. Truthful state: `storage.session` holds `{tabId: {gain, state}}`, written
   pending → active/error from the offscreen document's report, cleared on
   stream end, tab close, **navigation** (any `tabs.onUpdated` url change —
   ordinary and SPA/pushState alike; the platform itself would keep in-tab
   capture alive across navigations, but the product rule is that a boost
   belongs to the page it was started on), and reset. A start that never
   reports back times out into an honest error on both sides; a stale result
   for an already-stopped boost is ignored (no resurrection); and a
   **reconciliation** pass (worker start + popup open) clears session state
   that claims active boosts while no offscreen document exists. Nothing
   persists across a browser restart pretending capture was restored.

**Targeting constraint (verified against docs AND a live browser)**: the
`tabCapture` reference states that only tabs for which the extension has been
granted `activeTab` may be used as `getMediaStreamId` targets — effectively
the tab in front of the user when the popup opens. A headed-browser probe
(`npm run verify-capture`, real window + real mouse input) captured the
browser's exact refusal without the invocation grant:
`Extension has not been invoked for the current page (see activeTab
permission). Chrome pages cannot be captured.` The popup therefore gates
boost **start** to the viewed tab's card (other cards show a truthful
disabled state with an explanation), while existing boosts stay visible and
stoppable from any card. Whether the final capture-success path works with a
real toolbar-button click cannot be automated (CDP cannot click the toolbar);
it remains the one manual audio check, alongside audibility itself.

Known costs, stated plainly: `tabCapture` shows the browser's recording
indicator on captured tabs; capture redirects the tab's audio, so tab mute
and element volume still apply underneath the boost (multiplicative, as on
any mixer). Headless test browsers refuse capture entirely — the UI fails
into a visible error state, and real audibility checks (distortion,
duplication, leakage) are manual checklist items.

## Addendum — speed reliability audit (v2.1 corrective pass, 2026-10-31)

A correctness audit against the public Global Speed extension
(polywock/globalSpeed, read as a behavioral/engineering reference, not copied)
found the shipped speed implementation's instability to be structural, not
incidental. The findings below are the reasons behind the state model now
normative in DESIGN.md.

**The reference's core trick is `defaultPlaybackRate`.** Global Speed writes
the target to BOTH `playbackRate` and `defaultPlaybackRate`. The media load
algorithm resets `playbackRate` to `defaultPlaybackRate` whenever a source
(re)loads, so stamped elements survive src swaps and site re-inits with zero
event handling — which is how Global Speed gets away with a 1 s reconcile
interval plus event hooks instead of fighting every `ratechange`. We adopted
the stamping (with the site's prior default remembered and restored on
teardown); we did not adopt its "global always wins" model, because this
product's spec requires respecting native player choices.

**The shipped manager never anchored itself.** The re-injection guard
(`window.__mcpSpeed`) checked for a prior instance that was never assigned —
every sync stacked a fresh manager (fresh listeners, empty echo ledger, stale
expectation) on the same elements. Stale instances then reported the *new*
instance's assignments back as "page choices", creating bogus overrides that
pinned pages at old rates — the single largest source of the reported
"inconsistent speed" symptoms. One line fixed the class: anchor the instance.

**Blink fires a `ratechange` for the `defaultPlaybackRate` write too**
(verified empirically: setting both attributes produces two events per write).
One echo credit per *attribute write* (not per assignment) keeps the ledger
balanced; the second echo of a single-credit design escaped and was adopted as
a bogus override whenever `expected` had already moved on.

**Time-based echo suppression is the wrong tool.** The background's 1500 ms
"last-applied" window could swallow a genuine native choice made within the
window (the reproducible case: a native change landing while a global sync was
still queued) and could not suppress genuinely late echoes. It is replaced by
**per-tab policy revisions**: bumped when that tab's policy mutates (override
set/cleared, committed navigation), carried on every apply and report; a
report is honored iff its revision matches. Wall-clock time never decides
anything. Global-speed changes deliberately do NOT bump the revision — they
are ordinary applies that re-read live state, so a native choice made while
such an apply is queued still wins.

**`tabs.onUpdated` cannot tell a committed navigation from a pushState** —
both surface as `url` changes, so the old "override belongs to its URL" check
wiped overrides on every YouTube in-site transition (and the accompanying
stale reports resurrected old values). The documented split is
`webNavigation.onCommitted` (full navigations; clears the override, scoped by
URL comparison) vs `onHistoryStateUpdated` (same-document; keeps the override
and re-syncs so the SPA's next element inherits the current policy). Cost: the
`webNavigation` permission adds Chrome's "Read your browsing history" warning;
only top-frame commit/history events are consumed and nothing about browsing
is stored.

**Paused media needed explicit rules, not blanket skipping.** The original
`applyTo` ignored non-playing elements entirely — which made reset-to-global
unable to reach an ended element (found by the new deterministic matrix: a
10 s tone ended mid-scenario and the reset silently didn't apply). The rule
now: playing media is enforced blindly; paused/ended media takes the policy
when untouched (1.00× or extension-set) and keeps a foreign rate for
adopt-on-play — unless the injection is a user command (page-speed choice or
reset), which reaches paused media directly. Reset is thereby atomic against
both stale reports and stale element state.

**Two storage races were found by driving rapid interactions.** (1) The
background re-read its own `speedOverrides` writes from `storage.onChanged` —
a slow earlier write completing after a newer one regressed the in-memory
cache, and the next tab event re-applied the old rate. The background is the
single writer, so the cache is now write-through (storage is persistence,
reloaded at startup). (2) The popup's global-speed clicks issued overlapping
`storage.local.set` calls that could complete out of order, regressing both
the stored value and the popup's own optimistic display; saves are now
serialized and the storage-event reconcile stands down while the popup's own
writes are in flight (mirrored by a pending-choice guard for page-speed
commands).

**MediaStream-backed elements cannot hold a playbackRate** (Chromium clamps
`srcObject` writes and fires a `ratechange` at the clamped value), so the
manager skips them entirely — otherwise every enforcement write bounces back
as a "page choice" and the tab's policy churns forever.

**The regression rig changed shape.** The old fixture leaned on remote media
and a 10 s tone, which made "the tone ended mid-assertion" a plausible test
outcome. `test/speed-suite.html` generates 180 s WAV blobs in memory (no
network), exposes a driving API for site-like behavior (native rate changes,
SPA element swaps, source reloads, pushState), and the e2e suite runs a
16-step continuous matrix over it — plus mirrored state-machine assertions in
the background mock, each tagged with where it runs.

## Addendum — final correctness pass (2026-11-02)

Five targeted issues from an independent review, fixed without touching the
architecture:

**Pending gain updates were lost.** `releaseBoostStart()` deleted the
per-tab `pendingDesiredGain` entry, and the successful `mcp-boost-result`
handler called it BEFORE reading the desired gain — so a boost changed while
capture was starting always settled at the start gain. The handler now reads
the pending choice first; the active pipeline is moved to that gain (one
`offscreen-gain` message, no capture restart) and the session state shows it.

**Capture startup could not be cancelled reliably.** A stop could not abort a
`getUserMedia()` that had not yet produced a chain. Every start now carries a
per-tab **request id**; every async stage re-checks it (stream-id fetch,
offscreen forward) and the offscreen document marks a pending request
cancelled on stop, so a stream that resolves late has its tracks stopped
immediately, no graph is built and no result is sent. Results carry the
request id and are ignored unless they belong to the tab's current request —
a late success cannot resurrect a stop or overwrite a newer gain. The ordering
of `stopBoostForTab` matters too: the offscreen stop is delivered BEFORE the
session state clears, so a fast restart can never race a trailing stop (found
by the new delayed-operation tests).

**Overrides were scoped by URL, missing same-URL reloads.**
`webNavigation.onCommitted` supplies a unique `documentId` (Chrome 106+, our
floor is 116); overrides now record it and are cleared when the committed
document changes — a hard reload of the same URL clears them, while
`pushState` and hash changes (same document) keep them. URL comparison
remains only as a fallback for entries recorded before a commit event.
Reports from a document that is no longer the tab's committed document are
dropped as stragglers.

**The `activeTab` grant was undeclared.** The `tabCapture` reference states
that "only tabs where the extension has been granted activeTab can be used as
the target tab" for `getMediaStreamId({targetTabId})`, and that capture "can
only be called after the extension is invoked". `activeTab` is now declared
(no install-time warning); invoking the toolbar action grants it to the viewed
tab, which is exactly the product's boost target. The explicit-target call is
kept — it is the documented, unambiguous form — and the remaining manual check
is a real toolbar-click invocation (`npm run verify-capture` cannot click the
toolbar).

**`fmtSpeed` rounded every value to two decimals.**
`Number.isInteger(Math.round(clean * 100))` is always true, so 1.175 displayed
as 1.17 and 1.3333 as 1.33. The formatter now asks whether the value IS a
two-decimal value (with an epsilon for float noise): 1 → 1.00×, 1.1 → 1.10×,
1.5 → 1.50×, 1.175 → 1.175×, 1.3333 → 1.3333×. Explicit cases run in the
mock harness.

**Hash navigation.** Boost stopping relied on `tabs.onUpdated` URL changes.
`webNavigation.onReferenceFragmentUpdated` is now handled explicitly (boost
released; speed state deliberately untouched — it is the same document), with
mock support and a deterministic test.

**Test rig notes.** The background harness now runs the REAL `offscreen.js`
against a deferred `getUserMedia` stub and a fake Web Audio graph, so delayed
cancellation is tested end-to-end in-page; the browser is launched with the
background-throttling flags disabled (headless timer clamping made
delayed-operation tests crawl); the runner prints MCPDBG diagnostics and a
live progress line, and surfaces page errors instead of hanging. Harness: 52
assertions; e2e: 83 (the matrix gained the same-URL reload and hash-change
cases).

## Addendum — reliability corrections (2026-11-02, second pass)

**Frame-aware report provenance.** The manager is injected into all frames
(`allFrames`), and each frame document carries its own `documentId`. The
first documentId pass compared a report against the TAB's top-level document,
which would reject every legitimate iframe report as stale. Committed
documents are now tracked per tab and frame from
`webNavigation.onCommitted` (subframe events included); a report is validated
against the committed document of the frame it came from (`sender.frameId`),
while the page override stays scoped to the top-level document. Subframe
commits also trigger an idempotent re-sync so a freshly created frame document
gets its own manager. Top-level commits clear the tab's frame records; tab
removal clears both maps.

**Boost startup: full-scope cancellation and a real deadline.** Two gaps
remained. First, there was no ownership check after `await ensureOffscreen()`,
so a stop during document creation could let the request forward afterwards.
Second, the 12 s timeout was armed in a `finally` after the stream-id fetch and
forwarding — a hang earlier in the flow (or in `getUserMedia`) was never
bounded. The startup now arms a request-specific deadline when it BEGINS, and
re-checks ownership after every asynchronous stage: offscreen creation,
stream-id fetch, forwarding; the offscreen document re-checks after
`getUserMedia` and after AudioContext initialization and before the graph
becomes visible. The offscreen document is prepared BEFORE the stream id is
requested — the id is single-use and expires within seconds, so no slow
document setup may sit between generating it and forwarding it. Stops carry
the request id, so a delayed stop that belongs to an older request can never
tear down a restarted pipeline; a timeout sends a request-scoped stop,
invalidates the id, and a late stream is dropped with its tracks stopped.

**Offscreen cleanup on every failure path.** A half-built graph now
disconnects every node created so far, stops the stream's tracks, and closes
the shared AudioContext when no pipeline remains. The worker closes the
offscreen document when a startup fails (no pipeline exists) and again when a
lingering error entry auto-clears — necessary because `USER_MEDIA` documents
have no inactivity lifetime. On worker restart, any `pending` boost entry is
orphaned by definition (no request can be in flight) and is converged to a
truthful error instead of staying stuck; a popup-open sync leaves live
startups alone.

**Global-speed coverage.** Candidate detection (audible/muted/recent/pinned)
could not see a silent page whose media had not played yet, so a global change
could miss an open tab. While a policy is active the sync now targets EVERY
open injectable tab (http/https/file) plus previously managed tabs; managers
are idempotent and event-driven, and at factory defaults nothing is injected
or polled. Newly navigated pages are re-synced from `tabs.onUpdated`. The
trade-off is explicit: while global ≠ 1.00× or an override exists, a global
change fans out one idempotent install+apply per open tab; with no policy the
extension is exactly as light as before.

**Test rig.** The harness gained frame-commit simulation (`fireFrameCommitted`,
frame-scoped senders), an offscreen-create gate, an AudioContext resume gate,
and the shared graph stubs now report disconnects; it runs 67 assertions. The
e2e rig gained a frame-host fixture (same-origin iframe with its own fixture
API) and a silent-tab dynamic-insertion scenario; it runs 91 assertions. The
harness also filters a browser-injected `passwordalert` script error that Edge
intermittently logs into mock pages — not our code.

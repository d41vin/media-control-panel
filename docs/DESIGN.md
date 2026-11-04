# Design — v2.1 "Swiss media cards"

International Typographic Style applied to a 440 px toolbar popup. The
reference is Chrome's Global Media Controls for *behavior*; the look is Swiss:
grid, typography, restraint — softened with rounded cards because the popup now
carries full control surfaces on every row.

---

## Speed state model (normative)

This section is the single, explicit speed policy the implementation enforces.
The behavior reference is the public Global Speed extension (polywock) — its
engineering pattern of *stamping* both `playbackRate` and `defaultPlaybackRate`
is adopted; its "global always wins" model is not (this product respects
native player choices, see R5).

### Owners — one source of truth per piece of state

| State | Owner | Store |
|---|---|---|
| Global speed | background worker | `storage.local` `speed` |
| Page overrides `{[tabId]: {url, rate, at}}` | background worker | `storage.session` `speedOverrides` |
| Policy revision per tab (`rev`) | background worker | `storage.session` `speedRevs` |
| Committed document URL per tab | background worker | `storage.session` `speedCommitted` |
| Committed frame documents | background worker | `storage.session` `speedFrameDocs` |
| Managed tabs (may hold a page manager) | background worker | `storage.session` `speedManaged` |
| Element echo suppression | page manager (in-page) | `echoCredits` + `__mcpRate` markers |
| Player-settling window | page manager (in-page) | `settleUntil` WeakMap |
| Boost state `{[tabId]: {gain, state}}` | background worker | `storage.session` `boosts` |
| Settings (incl. appearance) | popup writes / worker reads | `storage.local` `settings` |
| Popup display mirror | popup (memory + storage events) | never written by the popup |

### The policy revision (rev)

One monotonic counter. The background bumps it on **every policy mutation**:
global speed change, override set (popup command or adopted native report),
override cleared (reset / committed navigation / tab removal).

Every manager injection and every `mcp-speed-apply` carries the rev current
when it was dispatched; every `mcp-speed-report` carries the rev the manager
was last given. The manager ignores applies older than its own rev; the
background drops reports whose rev is not current.

- **R1 (staleness is structural, not timed).** A report is honored iff
  `report.rev === currentRev`. Anything else is speaking about a superseded
  policy and is dropped without side effects. This replaces the former
  1500 ms echo window, which could swallow genuine native choices and fail on
  late echoes. Wall-clock time never decides anything.
- **R1a (frame-aware provenance).** The manager runs in every frame and each
  frame document has its own `documentId`. A report is validated against the
  committed document of the REPORTING frame (`sender.frameId`): a current
  iframe document is accepted, a replaced or navigated-away one is rejected.
  Subframe commits are recorded from `webNavigation.onCommitted` (frameId > 0)
  and an idempotent re-sync installs the manager into the new frame document.
  The page OVERRIDE still belongs to the tab's committed top-level document —
  frame provenance only validates who spoke, never where the policy lives.

### Precedence (unchanged)

1. A page with an override runs at the override rate, exactly (1.10× stays
   1.10×); 2. otherwise it inherits the global speed; 3. extension-initiated
   adjustments snap to the 0.25 grid, observed/native rates never snap; 4.
   changing the global speed updates every inheriting page and never touches
   an overridden page.

### Override scope — committed documents, not URLs seen

`webNavigation.onCommitted` (top frame) records the tab's **committed
document identity** — the event's unique `documentId` (Chrome 106+; this
build's floor is 116) plus the URL; `onHistoryStateUpdated` and
`onReferenceFragmentUpdated` mark same-document transitions.

- **R2.** An override is cleared when the tab's committed *document* changes —
  identity is the `documentId`, not the URL. A hard reload of the same URL
  produces a new document and clears the override; URL comparison is only the
  fallback for entries recorded before a commit was seen. SPA `pushState` and
  hash changes fire no `onCommitted`, so they never clear it.
- **R3.** A same-document transition keeps the override and re-syncs
  enforcement, so media the SPA creates next receives the current policy.

### Enforcement (page manager)

Installed (idempotent re-injection) into all frames of **every open,
injectable tab** while enforcement is needed (global ≠ 1.00× or any override)
— candidate detection (audible/muted/recent/pinned) cannot see a silent page
whose media has not played yet, and the global-speed promise covers existing
tabs **and tabs created after the policy was chosen**. Every enforcement
decision awaits the worker's startup state load (`ensureSpeedState`), so an
event racing a fresh worker never evaluates the factory defaults and answers
with a disconnect; `tabs.onCreated`, `tabs.onUpdated` and
`webNavigation.onCommitted` all feed the same idempotent sync. The whole
fan-out only runs while a policy is active; at factory defaults nothing is
injected or polled. Disconnected everywhere when no policy remains.

- **R4 (default-rate stamping).** Writing the policy also writes the element's
  `defaultPlaybackRate` (the site's prior value is remembered). The media load
  algorithm resets `playbackRate` to `defaultPlaybackRate` whenever a source
  changes, so stamped elements survive src swaps and site reloads with no
  event handling at all — the same mechanism Global Speed uses. Teardown
  restores stamped defaults and returns media the extension moved to 1.00×.
- **R4a (playing vs paused media).** Playing media is enforced blindly (its
  foreign rates were already reported through ratechange). Paused or ended
  media keeps a foreign rate under a plain sync — the page may have chosen
  it; adopt-on-play reports it — and takes the policy when the injection is a
  user command (page-speed choice or reset, `adoptForeign: false`), so a
  reset reaches paused media and old override values cannot resurface after
  play/pause.
- **R4b (player initialization is not a page choice).** Attaching a media
  element and its `emptied`/`loadstart`/`loadedmetadata`/`loadeddata`/
  `canplay`/`playing` events open a short (2 s) settling window. Within that
  window a `ratechange` is the site's player initializing itself — YouTube
  writes its own default 1.00× on every new video — so the manager re-stamps
  the policy (both rates) and does not report it. Once the window expires, a
  rate change is a real native/user choice and follows R5. The window is
  event-driven and bounded; there is no polling. This is what keeps a page
  override on the next SPA video and what keeps a newly opened tab at the
  global speed when its player announces 1.00×.
- Encounter rule (injection / `play`): at the expected rate → nothing; at
  1.00× (untouched default) or at a rate this extension set (`__mcpRate`) →
  apply the policy; at any other foreign rate → report it, unless the
  injection came from a per-page popup command (`adoptForeign: false`) — the
  user's fresh choice overwrites pre-existing foreign rates — or the element
  is still settling (R4b), in which case the policy wins.
- `ratechange`: own echo (echo credit + `__mcpRate` match) → consumed, no
  report; page matched the expected rate → nothing; still settling → re-stamp
  without reporting; otherwise → report with rev.

### Report semantics and honest limits

- **R5.** A ratechange report while a policy is enforced is adopted as the
  page override, with two declared limits: a change landing exactly on the
  global rate resumes inheritance (indistinguishable from inheriting), and a
  rate a site re-applies from its own saved settings after the element has
  settled is indistinguishable from a live user choice and is adopted the
  same way. Player initialization writes inside the settling window (R4b) are
  excluded from this: they are setup, not intent. The browser exposes no
  source identifier for media-rate changes; the popup always displays what
  actually happened (override vs website-set vs inheriting) and
  reset-to-global is one click.

### Atomicity

- **R6.** All speed syncs serialize through one queue and re-read live state
  at run time; a queued stale sync can never write an older rate over a newer
  choice. Applies carry the rev and the manager drops older ones, so two
  applies can never land out of order.
- **R7.** A command bumps the rev before its effects are dispatched: a reset
  or navigation-clear cannot be undone by an in-flight report from the
  superseded policy.

### Reset to global

Removes the override, re-applies the current global speed to current media,
and — via the manager that stays installed while global ≠ 1.00× — governs
every later element. Old override values cannot resurface after popup
reopen, play/pause, or global changes (R1/R6/R7).

### Display rules

Policy active → the card shows the policy rate (override marked with accent +
visible reset). No policy → the card shows the element's *observed* rate,
labeled "Website-set rate" when it differs from global, and extension steps
build from that observed rate. The popup never writes policy stores; it
mirrors and commands.

## Boost lifecycle (normative)

Boost is a **tab** setting, not a document setting.

- **B1.** A boost starts only from the viewed tab's card (the `activeTab`
  grant is what `tabCapture` requires) and is keyed by `tabId` in
  `storage.session` `boosts`. State values: `pending`, `active`, `error`.
- **B2.** Chrome's tab-capture stream continues across navigations in the same
  tab. SPA pushState/hash changes, full reloads, committed navigation and a
  navigation to another origin therefore do **not** stop or restart the
  pipeline. No navigation handler calls the boost stop path.
- **B3.** Only an explicit reset to 100 %, tab close, or the stream ending on
  its own stops the capture. A stop carries the per-tab request id so a
  delayed stop from an older request cannot tear down a newer pipeline.
- **B4.** At most one capture pipeline exists per tab: a start while one is in
  flight is dropped (its requested gain is applied on success), and the
  offscreen document itself refuses a second chain for the same tab.
- **B5.** A browser restart never restores capture: `storage.session` is gone
  and a live offscreen document is required for an `active` entry. A worker
  restart keeps a live pipeline (the document exists) and truthfully clears
  one that vanished.
- **B6.** Element volume, tab mute and boost are independent controls whose
  effects multiply at playback; moving one never changes another.

## Truthful tab state (mute)

The popup renders mute from `tab.mutedInfo` and never invents a state. The
quick-mute toggle reads `chrome.tabs.get` before issuing one
`chrome.tabs.update({muted})`, then applies the resolved Tab (the same truth
`tabs.onUpdated` carries); Mute all does the same per row, and a focus /
visibility return re-reads the listed tabs once. There is no extension code
path that unmutes a tab except an explicit Mute all / shortcut action. A
stale read that began before a mute command is discarded by the row's command
timestamp, and `makeRow` reuses an existing record instead of appending a
duplicate card, so the icon the user clicked is the icon that updates.

## Two audio truths and player-API sync (normative)

The extension distinguishes two independent mute states and never merges
them. The volume popover names both, side by side, each row its own toggle:

| State | Owner | Written through | Popup surface |
|---|---|---|---|
| Browser tab mute | Chrome (`tab.mutedInfo`) | `chrome.tabs.update({muted})` | card speaker icon, popover "Tab audio" row, Mute all, Alt+Shift+M |
| Native player mute | the SITE PLAYER's own model when it exposes one (`#movie_player.isMuted/mute/unMute`), else the element (`muted`) | `setMuted` (MAIN world, player API) / `pageSetMuted` (element fallback) | popover "Player audio" row |
| Normal volume | the media element (`volume`) | element write (`pageSetVolume`) | popover slider + readout |
| Tab boost | the capture pipeline | offscreen gain node | boost chip + popover |

- **M1 (independence).** Tab mute and player mute are written through
  different channels and can disagree; no code path lets one reverse the
  other. A native player mute never touches `tabs.update`, and tab mute
  never writes an element.
- **M2 (site → extension).** A native player change (the site's own mute
  button, volume slider or rate menu) reaches the popup through observation:
  the ping loop of an open card carries the primary element's `muted` and
  `volume`, and the volume popover keeps that loop alive even for PAUSED
  media while it is open. Opening the popover fires one fresh ping, so the
  slider shows the element's current truth — never the snapshot from when
  the popup or probe was new, and never a jump-back from an older probe.
- **M3 (extension → site, generic).** Extension writes land on the element;
  the standard `volumechange`/`ratechange` events carry them to any site
  that listens (`test/volume-sync.html` proves it with no adapter). The
  popup readout always reflects what actually landed: a site that rounds or
  clamps is corrected by the confirmation ping.
- **Y1 (private players).** A player that keeps its own UI state — YouTube's
  first-party player is the reported case — ignores element writes in its
  UI, and some builds actively REASSERT their internal mute model over
  element writes (sometimes only on tab activation). It is synchronized
  through its documented API surface (`#movie_player`, the method names the
  official IFrame Player API exposes) by adapter capabilities that run in
  the MAIN world (the API lives on page-world objects the isolated world
  cannot see), host-gated to known hosts and feature-detected:
  - `syncPlayer` — the direction is per channel, because ownership is per
    channel. **Rate/volume: ELEMENT → API** (the manager/slider write the
    element; the site UI follows its own model). **Mute: PLAYER → ELEMENT**
    (the player's model is the site's own truth; the element is aligned to
    it, never the other way — element-first mute writes lose on reasserting
    builds, the reported failure). A clamping rate menu may not drag the
    media down: the element's actual rate is restored, and a per-element
    marker prevents re-fighting the same reconciliation.
  - `setMuted` — the player API is the only mute channel that sticks on a
    reasserting player: `p.mute()/p.unMute()`, then the ACTUAL `isMuted()`
    is read back and adopted by the popup (commands are idempotent and
    reconciled, never optimistic-only).
  - `readState` — the popup's ping reads the player's own `isMuted()` so the
    "Player audio" row follows native site mute even on builds whose UI
    updates the element lazily; `null` (no player surface) falls back to the
    element.
- **Y2 (when syncs fire).** After every speed apply on an adapter-host tab
  (background), and after every popup-initiated volume/player-mute command
  there, exactly one `syncPlayer` runs. A settled player sees zero writes —
  idempotence is asserted in the E2E rig (reassertion, reverted element
  writes and both sync directions are covered there too). Sites without a
  reliable public player API (Spotify, SoundCloud web players) declare no
  sync capability: element truth stays the display source, player mute is
  the element's `muted`, and next/prev remains their only adapter surface.

## Appearance

One `theme` preference (`system` | `light` | `dark`, default `system`) lives
in `storage.local` `settings`. The popup sets `data-theme` on `<html>`:
`system` leaves the `prefers-color-scheme` media query in charge, while
`light`/`dark` override the token block. Every card, popover, switch, range
control and disabled state reads the same tokens, so one attribute repaints
the whole surface. The document's own background is the theme paper, filling
the browser-owned square popup frame; the rounded stage/cards are the inner
surface.

## Computational rules for controls

- Normal volume: 0–100 % with `step=0.05` (5 %). Pointer drag and keyboard
  arrows snap to the same grid; the readout is the actual value.
- Tab boost: 100–600 % with `step=10` (10 %); the readout is the actual gain.
- Site-set element volumes are displayed truthfully even when they are not on
  the 5 % grid; the next pointer/keyboard interaction snaps to it.
- Site volume indicators: the extension writes the element's `volume` and the
  browser emits the standard `volumechange`; a site that listens (the test
  fixture does) follows with no adapter. A site with a private volume model
  that ignores the event keeps its own display — documented, not hacked
  around.

---

## Principles

1. **Type is the interface.** No icons where a word works, no decoration that
   doesn't inform. One display moment per state (the big `0` when empty).
2. **The grid is non-negotiable.** 8 px baseline, 12–14 px gutters, 8 px card
   gap. Everything aligns to it.
3. **Monochrome + one accent.** Ink on paper, three grays, Swiss red used only
   for *live* meaning: the pinned target's card border, live indicators, page
   speed overrides, active boost. Never decoration. One glyph per meaning:
   the quick-mute pair is the bare/struck speaker, the volume control is the
   waved speaker, boost is speaker-with-plus (never a download arrow), the
   global speed bar carries a gauge, and ±10 s are circular arrows carrying
   the 10 — never confusable with prev/next track.
4. **Flat, softly.** Zero shadows, zero gradients, a rounded 14 px stage (the
   popup body itself — Chromium paints the action bubble from the document, so
   the corners are real) and 12 px cards on 1 px hairlines, 6–9 px control
   radii. Depth comes from hierarchy, not elevation.
5. **Fast is a feature.** System Helvetica stack — no font downloads. Native
   `title` tooltips — no tooltip JS. CSS transitions under 150 ms, all disabled
   under `prefers-reduced-motion`.
6. **Controls are visible, states are truthful.** Everything the card can do
   sits on the card — no details accordion. A control that cannot act is
   disabled; a state that is not real (boost "active" without a pipeline) is
   never shown.

## Tokens

```css
--paper:      #ffffff   /* dark: #141414 — stage */
--card:       #ffffff   /* dark: #1b1b1b — card surface */
--ink:        #111111   /* dark: #f2f2f2 */
--muted:      #6f6f6f   /* dark: #9a9a9a */
--faint:      #b5b5b5   /* dark: #5a5a5a  — disabled, big 0 */
--hairline:   #e4e4e4   /* dark: #2b2b2b */
--hover:      #f4f4f4   /* dark: #242424 */
--accent:     #e30613   /* dark: #ff3b30  — Swiss red */
--art-badge:  rgba(255,255,255,.88) /* dark: rgba(20,20,20,.88) — eq badge */
```

Type scale (all Helvetica Neue → Helvetica → Arial → system):

| Role | Size/weight | Notes |
|---|---|---|
| Wordmark, section labels | 10 px / 700, uppercase, +0.8–1.2 px tracking | `MEDIA CONTROL`, `SPEED`, `VOLUME`, `TAB BOOST` |
| Card title | 13 px / 600 (400 paused) | tab or media title, one line, ellipsis |
| Card site | 10 px / 500, uppercase, +0.5 px | hostname, `· ×N` multi-element count |
| Times, readouts, footer | 10–11 px | `font-variant-numeric: tabular-nums` |
| Empty display | 96 px / 200 | the `0` |

Spacing: 3 / 4 / 8 / 10 / 12 / 14. Popup: 440 px wide, max-height 640 px.

## shadcn/ui → vanilla mapping

Each shadcn concept is hand-rolled at near-zero cost — no framework, no copy
dirs, just the pattern:

| shadcn | Our take |
|---|---|
| Card | `.card` — 1 px hairline, 10 px radius, accent border when pinned |
| Button (ghost / icon) | `.icon-btn` 28×28 (play 34×34, filled ink, accent on hover) |
| Button (link) | header text buttons: 10 px uppercase, underline on hover |
| Stepper | `.step-btn` 22×22 hairline squares — global + per-card speed |
| Badge / chip | `.boost-btn` pill chip — quiet at 100 %, accent while active |
| Popover | inline collapsible section (`.popover`, max-height transition) — volume, boost, overflow menu |
| Separator | 1 px `--hairline` rules — header, speed bar, footer, popover tops |
| Slider | native `<input type=range>` restyled: 3 px rounded track, 11 px ink thumb, filled portion ink |
| Progress | the seek bar's filled portion (same slider, read-only styling) |
| Tooltip | native `title` attributes only |
| Kbd | footer shortcut hints, 9 px in 1 px hairline box |
| Empty | big `0` + `NOTHING PLAYING` + one-line hint |
| Scroll Area | native `overflow-y: auto`, `scrollbar-width: thin` |

## Anatomy

```
╭────────────────────────────────────────────────╮
│ MEDIA CONTROL ·2          PAUSE ALL  MUTE ALL ⚙ │  44 px header
├────────────────────────────────────────────────┤
│ ◔ SPEED                      [−] 1.00× [+] [↺] │  38 px global speed bar
├────────────────────────────────────────────────┤
│ ┌────────────────────────────────────────────┐ │
│ │ [art]  Video Title …               🔇  [ ▶ ]│ │  card head
│ │        SITE.COM · ×6                       │ │
│ │ ⏮ ↺10 ────●──────── 0:12 / 3:45 ─── ↻10 ⏭  │ │  timeline row
│ │ [PIP]      − 1.00× + ↺   🔊  ↑ 100 %   ⋯    │ │  controls row
│ │    └ popover: VOLUME ────●──  80 %          │ │  inline, on demand
│ └────────────────────────────────────────────┘ │
│ ┌────────────────────────────────────────────┐ │
│ │ [art]  Song Title …                 [ ▶ ]  │ │
│ └────────────────────────────────────────────┘ │
├────────────────────────────────────────────────┤
│ ⇧⌥P PAUSE ALL · ⇧⌥M MUTE ALL        TARGET NONE │  32 px footer
╰────────────────────────────────────────────────╯
```

- **Art** (40 px, 6 px radius): mediaSession artwork when the page provides
  it, favicon otherwise, letter tile (first character of the host) as the
  last resort. The equalizer badge (3 CSS bars) sits on the art's corner
  while playing; a struck-through speaker marks a muted tab.
- **Play control**: the one filled element on the card — ink fill, paper
  glyph, accent on hover. Alt+click solos the tab.
- **Timeline row** (Chromium-transport arrangement): prev → back-10 →
  slider + centered times (`0:12 / 3:45`, the slider the largest element) →
  forward-10 → next. Prev/next and ±10 s keep their place on every card;
  unsupported ones disable (adapter missing, site button gone or disabled,
  live streams can't seek) rather than vanish or no-op. Live streams replace
  the slider + times with the red `LIVE` tag and the row gets `.live`.
- **Controls row**: PiP (only when the primary element is video), then
  right-aligned: the per-page speed stepper (`− 1.00× +`, `↺` reset appears
  only while overridden — the value gets the accent + dotted underline then),
  the volume button (opens the popover), the boost chip (icon + percentage,
  accent while active), and the overflow menu (pin target, switch to tab,
  close tab — each with its glyph; close is destructive red).
- **Popovers** are inline collapsible sections inside the card, not floating
  layers: they cannot clip, overlap, or escape the popup. One open at a time
  across all cards; click-away and `Esc` close.
- **Global speed bar** under the header: label, override note (`1 PAGE
  OVERRIDE` when any exist), stepper cluster with reset. Disabled states at
  0.25× / 16.00× / 1.00× (reset is pointless at the default). Speeds above
  a site player's own menu cap still play — YouTube's menu stops at 2.00×
  while the media runs at up to 16×; the card always shows the element's
  actual rate.
- **Settings panel**: unchanged pattern — three rows (label + one-line
  description + sharp square-knob switch), footed by "Settings are stored on
  this device only". `Esc` closes; `inert` while closed.
- **Footer**: shortcut hints left; live target readout right (`TARGET ·
  site` or `TARGET NONE`); the pinned card shows the accent border.

## States

- **Empty**: big `0`, `NOTHING PLAYING`, hint. Nothing else.
- **Recently playing**: tabs that played this session stay listed while
  paused, so media remains resumable after the popup reopens.
- **Probe-miss** (audible tab where no element was reachable, e.g. a
  `chrome://` player): card still renders with tab-level mute and play;
  seek/volume/speed/boost/PiP are disabled. Never a lying button.
- **Speed override**: accent value + dotted underline + visible reset;
  tooltip names both rates (`Page override 1.50× — global is 2.00×`).
- **Website-set rate** (no policy in force): the card shows the element's
  observed rate, tooltip `Website-set rate 1.50× — global is 1.00×`; stepping
  builds from the observed value.
- **Boost**: chip quiet at 100 %, accent + percentage while active, `…`
  while starting, honest error text in the popover if capture failed (and a
  timestamped auto-clear so a failure never sticks).
- **Dark**: `prefers-color-scheme`, token swap only — no second stylesheet.
- **Focus**: every control has a `:focus-visible` ring; `Tab` order runs
  header → speed bar → card controls in DOM order.
- **Sorting**: pinned target first, then playing, then paused/muted.

## Motion

150 ms `ease-out` on the settings/popover collapses, card border-color,
slider thumb and switch knob. Equalizer bars: 900 ms loop, three bars,
subtle. All disabled under `prefers-reduced-motion`.

## Keyboard

`↑`/`↓` walk cards (focus lands on the card's play button; `Tab` reaches the
card's other controls natively), `Home`/`End` jump, and `←`/`→` seek ±10 s on
the focused card. While a slider has focus, all four arrows belong to the
slider — native adjustment, no card navigation, no ±10 s seek. `Esc` closes
any open popover first, then settings.

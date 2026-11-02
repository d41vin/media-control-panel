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
| Policy revision (`rev`) | background worker | `storage.session` `speedRev` |
| Committed document URL per tab | background worker | `storage.session` `speedCommitted` |
| Managed tabs (may hold a page manager) | background worker | `storage.session` `speedManaged` |
| Element echo suppression | page manager (in-page) | `echoCredits` + `__mcpRate` markers |
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
tabs. Newly navigated pages are re-synced from `tabs.onUpdated`. The whole
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
- Encounter rule (injection / `play`): at the expected rate → nothing; at
  1.00× (untouched default) or at a rate this extension set (`__mcpRate`) →
  apply the policy; at any other foreign rate → report it, unless the
  injection came from a per-page popup command (`adoptForeign: false`) — the
  user's fresh choice overwrites pre-existing foreign rates.
- `ratechange`: own echo (echo credit + `__mcpRate` match) → consumed, no
  report; page matched the expected rate → nothing; otherwise → report with
  rev.

### Report semantics and honest limits

- **R5.** A ratechange report while a policy is enforced is adopted as the
  page override, with two declared limits: a change landing exactly on the
  global rate resumes inheritance (indistinguishable from inheriting), and a
  rate a site re-applies from its own saved settings (e.g. a video site
  reasserting the rate last chosen in its own menu on the next video) is
  indistinguishable from a live user choice and is adopted the same way. The
  browser exposes no source identifier for media-rate changes; the popup
  always displays what actually happened (override vs website-set vs
  inheriting) and reset-to-global is one click.

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
  0.25× / 4.00× / 1.00× (reset is pointless at the default).
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

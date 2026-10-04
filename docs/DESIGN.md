# Design — v2.0 "Swiss media panel"

International Typographic Style applied to a 380 px toolbar popup. The reference
is Chrome's Global Media Controls for *behavior*; the look is Swiss: grid,
typography, restraint.

## Principles

1. **Type is the interface.** No icons where a word works, no decoration that
   doesn't inform. One display moment per state (the big `0` when empty).
2. **The grid is non-negotiable.** 8 px baseline. 16 px page gutters. 12 px
   column gap. Everything aligns to it, including the numbers in the gutter.
3. **Monochrome + one accent.** Ink on paper, three grays, Swiss red used only
   for *live* meaning: the pinned target's index and the play state dot. Never
   decoration.
4. **Flat.** Zero shadows, zero gradients, sharp corners (0–2 px), 1 px
   hairlines. Depth comes from hierarchy, not elevation.
5. **Fast is a feature.** System Helvetica stack — no font downloads. Native
   `title` tooltips — no tooltip JS. CSS-only animations under 130 ms, all
   disabled under `prefers-reduced-motion`.

## Tokens

```css
--paper:      #ffffff   /* dark: #141414 */
--ink:        #111111   /* dark: #f2f2f2 */
--muted:      #6f6f6f   /* dark: #9a9a9a */
--faint:      #b5b5b5   /* dark: #5a5a5a  — disabled, big 0 */
--hairline:   #e4e4e4   /* dark: #2b2b2b */
--hover:      #f4f4f4   /* dark: #1f1f1f */
--accent:     #e30613   /* dark: #ff3b30  — Swiss red */
--accent-ink: #ffffff
```

Type scale (all Helvetica Neue → Helvetica → Arial → system):

| Role | Size/weight | Notes |
|---|---|---|
| Wordmark, section labels | 10 px / 700, uppercase, +0.8 px tracking | `MEDIA CONTROL`, `POSITION`, `VOLUME`, `SPEED` |
| Row title | 13 px / 500 | tab or media title, one line, ellipsis |
| Row site | 10 px / 500, uppercase, +0.5 px | hostname |
| Times, badge, footer | 11 px | `font-variant-numeric: tabular-nums` |
| Empty display | 96 px / 200 | the `0` |

Spacing: 4 / 8 / 12 / 16 / 24. Row height 52 px collapsed. Popup: 380 px wide,
max-height 560 px.

## shadcn/ui → vanilla mapping

Each shadcn concept is hand-rolled at near-zero cost — no framework, no copy
dirs, just the pattern:

| shadcn | Our take |
|---|---|
| Button (ghost / icon) | `.icon-btn` 28×28, hover `--hover`, focus-visible 1.5 px ink outline offset 2 px |
| Button (link) | header text buttons: 10 px uppercase, underline on hover |
| Badge | count chip next to wordmark: 10 px, hairline border |
| Separator | 1 px `--hairline` rules — header, footer, every 8th row? no: only structure, not rhythm |
| Collapsible | row expand; chevron rotates 90°, 120 ms |
| Slider | native `<input type=range>` restyled: 2 px track, 10 px square ink thumb, filled portion ink (live: accent) |
| Progress | the seek bar's filled portion (same slider, read-only styling) |
| Tooltip | native `title` attributes only |
| Kbd | footer shortcut hints, 10 px in 1 px hairline box |
| Empty | big `0` + `NOTHING PLAYING` + one-line hint |
| Scroll Area | native `overflow-y: auto`, `scrollbar-width: thin` |
| Skeleton | n/a — first paint is one `tabs.query` away (~ms), no loading state needed |

## Anatomy

```
┌──────────────────────────────────────────────┐
│ MEDIA CONTROL ·3            PAUSE ALL  MUTE ALL │  44 px header
├──────────────────────────────────────────────┤
│ 01  □ fav  Video title …        SITE.COM  ♪ ▪▶ ⌄│  52 px row
│ 02  □ fav  Song title …        SITE.COM  ♪ ▪▶ ⌄│
│     └ expanded: POSITION ────●──  12:34 / 1:00:03│
│                VOLUME  ──●──────  80 %            │
│                SPEED   ──●──────  1.00×           │
│                [−10s] [+10s] [PiP] [TAB] [PIN] [×]│
├──────────────────────────────────────────────┤
│ ⇧⌥P PAUSE ALL · ⇧⌥M MUTE ALL    TARGET: 01 …      │  32 px footer
└──────────────────────────────────────────────┘
```

- **Number column** (24 px): zero-padded index, 10 px, `--muted`. The pinned
  target's number is `--accent`. Purely structural — Swiss editorial rhythm.
- **Favicon** 16 px, grayscale? no — identity is information; full color.
- **Title line** = media title (mediaSession) if it differs from tab title,
  else tab title. **Site** = hostname, uppercase.
- **Playing glyph**: 3-bar equalizer, CSS-only, ink at 60 %, static under
  reduced-motion. **Muted**: struck-through speaker replaces it.
- **Row controls**: play/pause always visible; mute + chevron visible on
  hover/focus/expanded (desktop pointer convention; keyboard focus also
  reveals). Everything is a real button with `aria-label`.
- **Expanded panel** (grid label column + control column): seek with times
  (`LIVE` when duration is Infinity), volume %, speed ×, then a button row:
  ±10 s, PiP, switch to tab, pin target, close tab. Red used only on pin-when-
  active and close-tab hover (#e30613 hover = destructive affordance).
- **Header actions**: PAUSE ALL always available; MUTE ALL label flips to
  UNMUTE ALL contextually (all-candidate-muted → unmute).
- **Footer**: shortcut hints left; live target readout right (`TARGET 02 —
  youtube.com` or `TARGET NONE`).

## States

- **Empty**: big `0`, `NOTHING PLAYING`, hint "Start a video or song in any
  tab — it appears here." Nothing else.
- **Probe-miss** (audible tab where no element was found, e.g. cast tab): row
  still renders with tab-level mute + go-to-tab only; play/pause hidden. Never
  a dead button.
- **Dark**: `prefers-color-scheme`, token swap only — no second stylesheet.
- **Focus**: every control focus-visible ring; rows are `<li>` with buttons
  inside — tab order: play/pause → mute → chevron → (expanded: sliders, then
  row actions).
- **Sorting**: pinned target first, then playing, then paused/muted; index
  renumbers after every render.

## Motion

120 ms `ease-out` on background-color, opacity, chevron rotation. Equalizer
bars: 900 ms loop, three bars, subtle. All wrapped in
`@media (prefers-reduced-motion: no-preference)`.

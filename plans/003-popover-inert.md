# Plan 003: Make closed popovers inert — their controls are keyboard-focusable while invisible

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/popup.js extension/popup.css scripts/harness.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (a11y/keyboard)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C3 (closed popovers keep focusable controls, HIGH)

## Why this matters

A closed card popover is collapsed with `max-height: 0; opacity: 0;
overflow: hidden`. Clipped-but-rendered elements stay in the Tab order, so a
keyboard user tabbing across a card falls through the volume slider, the two
audio-truth toggles, the boost slider/reset and three menu items with zero
visible focus; `Esc`-closing a popover leaves focus inside the collapsed
region. Screen readers likewise announce invisible controls. The settings
panel solved this exact problem with the `inert` attribute
(`popup.js:1550`); popovers were missed. The repo's own design principle is
"Controls are visible, states are truthful" (DESIGN.md Principles) — invisible
focusables violate it.

## Current state

Files and roles:
- `extension/popup.js` — the whole popup UI; `syncPopover` is the single render path for popover open/close.
- `extension/popup.css` — token-driven stylesheet; `.popover` collapse transition.
- `scripts/harness.mjs` — headless runner whose popup pass drives the real popup against the mock (the right layer for a deterministic focus/inert assertion).

Excerpts (verified at `f6101d2`):

`extension/popup.js:671-679` — only classes and aria toggles today:
```js
function syncPopover(rec) {
  const n = rec.nodes;
  n.volPop.classList.toggle('open', rec.openPopover === 'vol');
  n.boostPop.classList.toggle('open', rec.openPopover === 'boost');
  n.menuPop.classList.toggle('open', rec.openPopover === 'menu');
  n.volBtn.setAttribute('aria-expanded', String(rec.openPopover === 'vol'));
  n.boostBtn.setAttribute('aria-expanded', String(rec.openPopover === 'boost'));
  n.menuBtn.setAttribute('aria-expanded', String(rec.openPopover === 'menu'));
}
```

`extension/popup.css:758-766` — the collapse (no visibility/inert):
```css
.popover {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
  margin-top: 0;
  border-top: 0 solid var(--hairline);
  transition: max-height 150ms ease-out, opacity 150ms ease-out, margin-top 150ms ease-out;
}
```

The in-repo precedent — `extension/popup.js:1547-1553`:
```js
function setSettingsOpen(open) {
  settingsOpen = open;
  settingsEl.classList.toggle('open', open);
  settingsEl.toggleAttribute('inert', !open);
  settingsBtn.setAttribute('aria-expanded', String(open));
  settingsBtn.classList.toggle('on', open);
}
```

Popovers are created closed in `makeRow` (`popup.js:344-406`: `volPop`,
`boostPop`, `menuPop` appended in the collapsed state) — so the initial DOM
must carry `inert` too, not only state changes.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke pass (grows by the new inert assertions) |
| Full e2e | `npm run e2e` | exit 0; 122/122 |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/popup.js` (`syncPopover` + initial creation in `makeRow`)
- `extension/popup.css` (visibility fallback on `.popover`/`.popover.open`)
- `scripts/harness.mjs` (popup-pass assertions for the inert state)
- `README.md` harness count if it changes

**Out of scope**:
- Focus restoration after `Esc` (whether `Esc` should move focus to the card's play button is a UX decision — note it for the maintainer in the PR description, do not implement).
- The settings panel (`setSettingsOpen` already correct).
- Any change to the popover open/close triggers, click-away handler, or the one-popover-at-a-time rule.

## Git workflow
- Branch: `advisor/003-popover-inert`
- One or two conventional commits (`fix(popup): inert collapsed popovers`, `test(harness): popover inert assertions`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Toggle `inert` in `syncPopup`'s single render path
`extension/popup.js:671-679` becomes:
```js
function syncPopover(rec) {
  const n = rec.nodes;
  n.volPop.classList.toggle('open', rec.openPopover === 'vol');
  n.boostPop.classList.toggle('open', rec.openPopover === 'boost');
  n.menuPop.classList.toggle('open', rec.openPopover === 'menu');
  // collapsed popovers are invisible: their controls must leave the tab
  // order and the a11y tree, exactly like the closed settings panel
  n.volPop.toggleAttribute('inert', rec.openPopover !== 'vol');
  n.boostPop.toggleAttribute('inert', rec.openPopover !== 'boost');
  n.menuPop.toggleAttribute('inert', rec.openPopover !== 'menu');
  n.volBtn.setAttribute('aria-expanded', String(rec.openPopover === 'vol'));
  n.boostBtn.setAttribute('aria-expanded', String(rec.openPopover === 'boost'));
  n.menuBtn.setAttribute('aria-expanded', String(rec.openPopover === 'menu'));
}
```
Also set the initial attribute at creation in `makeRow` (after the three
popovers are built, before `card.append(...)` at `popup.js:408`):
```js
  volPop.toggleAttribute('inert', true);
  boostPop.toggleAttribute('inert', true);
  menuPop.toggleAttribute('inert', true);
```

**Verify**: `npm test` → exit 0.

### Step 2: CSS visibility fallback
In `extension/popup.css`, extend the two rules:
```css
.popover {
  max-height: 0;
  opacity: 0;
  visibility: hidden;
  overflow: hidden;
  margin-top: 0;
  border-top: 0 solid var(--hairline);
  transition: max-height 150ms ease-out, opacity 150ms ease-out,
    margin-top 150ms ease-out, visibility 0s 150ms;
}
```
and inside `.popover.open` add `visibility: visible;` plus extend its
transition with `visibility 0s 0s` (so the 150 ms open animation still
plays). Match the existing formatting/one-property-per-line style of the
file.

**Verify**: `npm test` → exit 0.

### Step 3: Harness assertions
In the popup pass of `scripts/harness.mjs` (the big `(async () => { … })()`
eval at `:210-288`), add after the existing popover interaction block (the
volume popover section is a good anchor — it already clicks `.vol-btn`):
```js
// closed popovers are inert; the open one is interactive
const popInert = {
  initial: [...document.querySelectorAll('.popover')].every((p) => p.hasAttribute('inert')),
  open: (() => {
    const v = document.querySelector('.row .vol-pop');
    const opened = !v.hasAttribute('inert');
    const others = [...document.querySelectorAll('.popover')].filter((p) => p !== v).every((p) => p.hasAttribute('inert'));
    return opened && others;
  })(),
  closedAgain: (() => {
    document.body.click(); // click-away closes it
    return [...document.querySelectorAll('.popover')].every((p) => p.hasAttribute('inert'));
  })(),
};
```
Return `popInert` in the eval's state object and add to the pass criteria
(next to `audioTruthsOk`):
```js
const popInertOk = pmState?.popInert?.initial === true && pmState.popInert.open === true && pmState.popInert.closedAgain === true;
```
Include `popInertOk` in the composite failure check and add one
`console.log('  ok  popup-mock popovers: closed popovers are inert, open popover interactive')` line
following the file's existing ok-line style. Mind the ordering of existing
interactions (the volume-popover block toggles state; place the new reads so
they don't disturb the mute/audioTruths timings).

**Verify**: `npm run harness` → exit 0; output includes the new ok line; total count grows (record it).

### Step 4: Full regression gate
**Verify**: `npm run e2e` → exit 0, 122/122 (nothing in e2e depends on popover focusability; the appearance/geometry assertions are unaffected).

## Test plan
- New harness assertions (Step 3) cover: initial inert, exactly-one-open interactive, click-away re-inerts.
- Manual spot-check (documented in the PR body, not automated): Tab through a card in the real popup before/after — before, focus disappears into collapsed popovers; after, Tab walks card controls only.

## Done criteria
- [ ] `syncPopover` and `makeRow` manage `inert` on all three popovers
- [ ] `.popover` uses a `visibility` fallback consistent with the 150 ms motion budget (`prefers-reduced-motion` still collapses without animation)
- [ ] `npm test`, `npm run harness`, `npm run e2e` all exit 0; harness count updated in `README.md` if changed
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions
- The `syncPopover`/CSS excerpts don't match (drift).
- An existing harness assertion (3.3 s quick-mute window, audio truths, themes) starts failing after the change — the `inert` toggle must not alter event timing; report rather than reorder existing interactions.
- e2e appearance/frame-gap geometry assertions fail — the visibility change interacts with rendering; stop and report the failing assertion.

## Maintenance notes
- Any NEW popover-style surface (a future fourth popover) must set `inert` at creation and in its sync function; consider wiring it into `syncPopover`'s pattern rather than a parallel mechanism.
- If the maintainer later wants Esc to restore focus to the card's play button, that is a deliberate UX addition — keep it out of this plan's scope.
- Reviewers should scrutinize: `toggleAttribute('inert', cond)` semantics (second arg forces presence/absence) and that the transition's `visibility` delay keeps the open animation visible.

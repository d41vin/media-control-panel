# Plan 018: Single source for boost constants; remove dead code (unused gauge icon, unused snapSpeed)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/popup.js extension/background.js extension/offscreen.js extension/lib/speed.js extension/lib/settings.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: S
- **Risk**: LOW
- **Depends on**: recommended BEFORE plans/005 and 012's timer touches are re-read (the belt constant moves here) — if those plans already landed, their named constants make this mechanical
- **Category**: tech-debt
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: D2 (boost constants live in three files, deadlines paired by comment only, HIGH), D4 (dead code: `ICONS.gauge`, `snapSpeed`; the lone `console.warn` convention, HIGH)

## Why this matters

The speed model has a single source of truth (`lib/speed.js`, imported by
popup and background — the audit verified the discipline holds). Boost does
not: the 100–600 % range is encoded as DOM attributes in the popup, re-encoded
as `clampGainPct` in the worker, and re-encoded as a 1–6 multiplier in the
offscreen document; the paired deadlines (worker 12 s vs popup 15 s belt; the
8 s error auto-clear on both sides) are coupled by comments. Changing the
boost ceiling today means touching three files and matching two comments;
a missed site yields a popup that offers values the worker silently clamps
away. Dead code compounds the reader cost: `ICONS.gauge` suggests a UI element
that ships as an inline SVG in popup.html instead, and the imported-but-never-
called `snapSpeed` invites use where the file's own logic says clamping (not
snapping) is correct.

## Current state

Files and roles:
- `extension/popup.js` — boost slider DOM attributes, `?? 100` defaults, belt/auto-clear timers, the dead icon + import.
- `extension/background.js` — `clampGainPct`, `BOOST_START_TIMEOUT_MS`, the worker-side 8 s auto-clear, the lone `console.warn`.
- `extension/offscreen.js` — `gainMultiplier` (a PLAIN SCRIPT — loaded via `offscreen.html` `<script src>`, NOT a module: it cannot `import`).
- `extension/lib/speed.js` — the model file whose neighborhood the boost constants join.

Excerpts (verified at `f6101d2`):

`extension/popup.js:378-384` — the slider encoding:
```js
  const boost = el('input', 'boost');
  boost.type = 'range';
  boost.min = '100';
  boost.max = '600';
  boost.step = '10';
  boost.value = '100';
```
`extension/popup.js:82-83` — the dead icon:
```js
  gauge:
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4a9 9 0 0 0-9 9c0 2.2.8 4.2 2.1 5.8l1.5-1.3A6.9 6.9 0 0 1 5.1 13 6.9 6.9 0 1 1 17 18.4l1.4 1.5A9 9 0 0 0 12 4z"/><path d="m12.9 14.6-5.2-5.4 1.5-1.4 5 5.3a1.7 1.7 0 1 1-1.3 1.5z"/></svg>',
```
(the same path IS rendered by `extension/popup.html:23` inline — the constant
is an unused duplicate; `ICONS.gauge` has no other reference.)
`extension/popup.js:36` + `extension/lib/speed.js:38-40` — the dead export:
```js
  snapSpeed,
```
```js
/** Clamp AND snap to the 0.25 grid — extension-initiated adjustments only. */
export function snapSpeed(rate) {
  return clampSpeed(Math.round(rate / SPEED_STEP) * SPEED_STEP);
}
```
(the only other mention is the comment at `popup.js:733` — "clampSpeed, not
snapSpeed" — the deliberate decision that made it dead.)
`extension/background.js:538-542`:
```js
function clampGainPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 100;
  return Math.min(600, Math.max(100, Math.round(n)));
}
```
`extension/offscreen.js:46-50`:
```js
function gainMultiplier(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 1;
  return Math.min(6, Math.max(1, n / 100));
}
```
`extension/background.js:481` / `:648-655` and `extension/popup.js:787-797` /
`:799-808` — the paired deadlines (12 s/8 s worker; 8 s/15 s popup).
`extension/background.js:337` — the lone console output:
```js
        console.warn('MCPDBG speed inject retry:', msg.slice(0, 120));
```
(~60 catch sites elsewhere all swallow with a comment; this is the single
exception, and the harness actively prints `MCPDBG`-prefixed page output —
so the convention is: MCPDBG-prefixed output is the ONLY sanctioned console
output. Say so; don't delete the line.)

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0 (the popup pass asserts the boost slider step — now driven by the constants) |
| Full e2e | `npm run e2e` | exit 0; 122/122 (boost plumbing steps) |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/lib/speed.js` (add the boost constants block — or a new `extension/lib/boost.js`; prefer `speed.js` to avoid a new module)
- `extension/popup.js` (import + use; delete the dead icon and the dead import)
- `extension/background.js` (import + use in `clampGainPct`; document the console convention)
- `extension/offscreen.js` (comment-only pin — it cannot import)

**Out of scope**:
- Converting `offscreen.js` to a module (its `<script>` load and its role as a serialized-runtime-free page are deliberate; the comment pin is the agreed fix).
- Any behavior change: the constants' VALUES are identical; only their source moves.
- `extension/offscreen.html` (unchanged script tag).
- The boost state machine logic (plans 001/005).

## Git workflow
- Branch: `advisor/018-boost-constants-dead-code`
- Conventional commits (`refactor(boost): one source for the boost constants`, `chore: remove dead gauge icon and snapSpeed`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the constants to `extension/lib/speed.js`
Append a section after the speed constants, matching the file's style:
```js
// --- boost (tab volume boost range) --------------------------------------------
// Single source for the boost range: the popup's slider attributes, the
// worker's clamp, and the offscreen document's multiplier all derive from
// these. The offscreen document is a plain script and cannot import — its
// gainMultiplier carries a comment pinning it here.
export const BOOST_MIN = 100;
export const BOOST_MAX = 600;
export const BOOST_STEP = 10;
/** Worker-side startup deadline for a capture request (popup arms a belt
    3 s behind it as the last line of defense). */
export const BOOST_START_TIMEOUT_MS = 12000;
/** Popup-side belt for a start that never reports back. */
export const BOOST_RESULT_BELT_MS = 15000;
/** Error entries auto-clear after this long (both sides). */
export const BOOST_ERROR_CLEAR_MS = 8000;
```
(If plans/005 introduced `BOOST_RESULT_BELT_MS` locally in popup.js, import
it instead — same name.)

### Step 2: Consume the constants
- `popup.js`: import `BOOST_MIN, BOOST_MAX, BOOST_STEP` (+ the two timer
  constants if 005/this plan's Step 1 named them); set the slider attributes
  from them (`boost.min = String(BOOST_MIN)` etc.), and replace the `?? 100`
  defaults with `?? BOOST_MIN`.
- `background.js`: import `BOOST_MIN, BOOST_MAX, BOOST_START_TIMEOUT_MS,
  BOOST_ERROR_CLEAR_MS`; `clampGainPct` becomes `Math.min(BOOST_MAX,
  Math.max(BOOST_MIN, Math.round(n)))` with the `100` fallback becoming
  `BOOST_MIN`; `BOOST_START_TIMEOUT_MS` and the 8 s auto-clear use the
  imports (delete the local `const BOOST_START_TIMEOUT_MS = 12000;`).
- `offscreen.js`: comment-only change on `gainMultiplier`:
```js
// The 100–600 % range (→ 1–6 multiplier) is owned by lib/speed.js
// (BOOST_MIN/BOOST_MAX) — this plain script cannot import it; keep in sync.
```

**Verify**: `npm test` → exit 0; `npm run harness` → exit 0 (the popup pass
asserts `boostStep === '10'` — driven by the constant now).

### Step 3: Remove the dead code
- `popup.js`: delete the `gauge:` entry from `ICONS` and `snapSpeed,` from
  the `lib/speed.js` import; keep the `:733` comment but reword it to not
  name a function that no longer exists ("…not grid-snapped").
- `speed.js`: delete `snapSpeed`.
**Verify**: `grep -rn "snapSpeed\|ICONS.gauge\|'gauge'" extension/ scripts/` → no references; `npm test` → exit 0 (the parse list covers `lib/speed.js`).

### Step 4: Document the console convention
In `extension/background.js`'s header comment block (top of file), add one
line: "MCPDBG-prefixed console output is the only sanctioned console output
(the harness prints it); every other failure path swallows with a comment."
**Verify**: `npm run harness` → exit 0 (its MCPDBG printing keeps working).

### Step 5: Regression gate
**Verify**: `npm run e2e` → exit 0, 122/122 (the boost plumbing steps read
real slider behavior — identical values, so no assertion changes).

## Test plan
- No new tests: this is a pure refactor — the existing harness boost
  assertions (slider step, pending/active/error flows) and e2e boost steps
  are the gate that values and behavior are unchanged.

## Done criteria
- [ ] Boost range/deadlines exist once in `lib/speed.js`; popup/background import them; offscreen carries the pin comment
- [ ] `ICONS.gauge` and `snapSpeed` are gone with zero remaining references; the console convention is documented
- [ ] `npm test`, `npm run harness`, `npm run e2e` all exit 0
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The excerpts don't match (drift), or plans 005/001 landed with different timer constant names — reconcile names rather than introducing two spellings.
- The e2e boost steps fail after the constant move — the values must be byte-identical; a failure means a transcription slip. Stop and diff.
- `offscreen.js` turns out to already import something (it must not at `f6101d2`) — report; the plain-script assumption is wrong.

## Maintenance notes
- Any future boost-range change is now a one-file edit plus a CHECKLIST pass (#52–#63 exercise the range); the offscreen comment is the only manual sync point left.
- plans/019 (pause consolidation) touches the same popup file — sequence to avoid conflicts.
- Reviewers should scrutinize: no value changed (diff should show identical numerals via the new names), and the import lists stay minimal (no `import *`).

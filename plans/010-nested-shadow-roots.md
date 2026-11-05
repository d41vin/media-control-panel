# Plan 010: Reach media inside nested open shadow roots (probe, ping, controls, and the speed manager)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/lib/page.js extension/lib/manager.js test/speed-suite.html scripts/e2e.mjs README.md plans/002-manager-detached-element-pruning.md`
> If any in-scope file changed since this plan was written (especially plan
> 002's pruning edits to `manager.js`), compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status
- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (strictly widens the visited set)
- **Depends on**: plans/002 (recommended — same functions in `manager.js`; land the pruning first), plans/008 (recommended — its drift guard protects the 11 inline copies this plan edits)
- **Category**: bug (+ the test that pins it)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C12 (nested open shadow roots invisible, HIGH mechanism / rare trigger), T3-shadow (shadow-DOM collection never tested, HIGH)

## Why this matters

Every media-collection walk — 10 inlined copies in `lib/page.js` plus the
manager's `collect()` — iterates `document.querySelectorAll('*')` and checks
`el.shadowRoot` on each light-DOM element. A shadow HOST inside another
element's open shadow root is never visited, so its shadow root is never
searched: a player nested two levels deep in open roots (web-component
players) produces no card at all and never receives the speed policy. The
README's "Known limits" claims only CLOSED roots are unreachable, and
`lib/page.js`'s header says "open shadow roots included" — both are wrong
for the nested case. The fix is a root worklist: start at `document`, and
enqueue every visited element's `shadowRoot` (when present) as another root
to search. Because the copies are deliberately inlined (serialization rule),
all 11 sites need the same mechanical change — which is exactly why plans/008's
drift guard should land first.

## Current state

Files and roles:
- `extension/lib/page.js` — injected probe/controls; 10 inlined collection blocks.
- `extension/lib/manager.js` — the speed manager's `collect()`.
- `test/speed-suite.html` — deterministic e2e fixture (right layer for the nested-root step).
- `README.md:352-356` — Known limits (the closed-roots claim stays true after the fix; nothing to change there unless wording).

Excerpts (verified at `f6101d2`) — the canonical copy, `extension/lib/page.js:49-55`:
```js
  const els = (() => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  })();
```
Identical blocks (per the audit's mechanical diff) at `page.js:128-134`
(ping), `:154-160` (toggle), `:186-192` (play), `:211-217` (pause),
`:225-231` (seekTo), `:246-252` (seekBy), `:266-272` (setVolume),
`:286-292` (setMuted); the video-only PiP variant at `:305-311` selects
`'video'`; and `extension/lib/manager.js:98-104`:
```js
  const collect = () => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  };
```
The serialization constraint — `extension/lib/page.js:1-9` header: every
export must be fully self-contained (no module-scope helpers); the copies
exist precisely because of this, so the fix must be applied per copy, not
extracted.

Performance note (from the perf audit): the flat walk is O(all elements) per
scan; the worklist version must remain bounded the same way (it visits each
element once). plans/012 separately reduces scan *frequency*; this plan only
changes *coverage*.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0 — now also proving the copies stayed in sync (if plans/008 landed) |
| Mock harness | `npm run harness` | exit 0 |
| Full e2e | `npm run e2e` | exit 0; previous total + the new nested-root matrix step |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/lib/page.js` (10 collection blocks)
- `extension/lib/manager.js` (`collect()`)
- `test/speed-suite.html` (nested shadow fixture elements + fixture API)
- `scripts/e2e.mjs` (one matrix step)
- `README.md` / `docs/RESEARCH.md` counts if changed

**Out of scope**:
- Closed shadow roots (platform-impossible; the Known-limits line stays).
- `scripts/check.mjs` (plans/008).
- The manager's pruning/guards (plans/002) — compose, don't rework.
- Detection of `srcObject` elements — still skipped by `unmanageable()`.

## Git workflow
- Branch: `advisor/010-nested-shadow-roots`
- Conventional commits (`fix(media): reach media inside nested open shadow roots`, `test(e2e): nested shadow-root matrix step`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: The worklist collection (canonical form)
```js
  const els = (() => {
    // root worklist: every open shadow root is another root to search, so
    // media nested inside component-in-component players is reached too
    const found = [];
    const seen = new Set();
    const roots = [document];
    while (roots.length) {
      const root = roots.pop();
      for (const el of root.querySelectorAll('video, audio')) {
        if (!seen.has(el)) { seen.add(el); if (el.isConnected) found.push(el); }
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot && !seen.has(el.shadowRoot)) {
          seen.add(el.shadowRoot);
          roots.push(el.shadowRoot);
        }
      }
    }
    return found;
  })();
```
Design decisions to preserve: the `seen` set prevents duplicate visits
(media elements reachable from multiple roots are pushed once); hosts are
enqueued once; `isConnected` still filters. Complexity stays O(elements +
roots) — each element visited exactly once across both loops.

### Step 2: Apply to all 11 sites
Replace the 10 `lib/page.js` blocks and the `manager.js` `collect()` body
with the worklist (PiP variant: `'video'` selector instead of
`'video, audio'`). Keep each function self-contained (the whole worklist
lives inside the existing IIFE per copy — no new module-scope helpers).

**Verify**: `npm test` → exit 0 — and if plans/008 has landed, its drift
guard now enforces the new canonical text across all copies (update the
guard's expected count: still 10 page.js copies + 1 manager copy).

### Step 3: Fixture — nested open shadow roots in `test/speed-suite.html`
Add a fixture element:
```js
        // a web-component-style player: host → shadow root → nested host →
        // its shadow root → the actual media
        addNested() {
          const outer = document.createElement('div');
          const outerRoot = outer.attachShadow({ mode: 'open' });
          const inner = document.createElement('div');
          const innerRoot = inner.attachShadow({ mode: 'open' });
          const a = document.createElement('audio');
          a.src = SRC;
          innerRoot.append(a);
          outerRoot.append(inner);
          document.body.append(outer);
          els.push(a);
          return els.length - 1;
        },
```
(`SRC`/`els` per the fixture's existing `add()` implementation.)

### Step 4: One e2e matrix step
In `scripts/e2e.mjs`, after the fixture tab is set up with a policy active:
1. `mcpFix.addNested()` → wait for the popup to list the tab with elementCount reflecting the nested audio (the probe must see it — that IS the C12 pin for detection).
2. Assert the nested media received the policy (its `playbackRate` equals the effective rate within the settle bounds).
3. Assert controls reach it: pause it via the card's play button and observe `paused === true` (or assert the ping loop updates its readout).
Use the existing `ok`/`bad` naming, e.g. `speed-matrix 19: media in nested open shadow roots is detected, governed, and controllable`.

**Verify**: `npm run e2e` → exit 0 with the new step; record the new total; update documented counts.

### Step 5: Final gates
**Verify**: `npm run harness` → exit 0 (the mock's `_doc.querySelectorAll('*')` returns `[]` for `'*'`, so the harness never executes the loop — no mock change required; note this in the PR body). `npm test` → exit 0.

## Test plan
- New: the matrix step (detection + governance + control of nested media).
- The drift guard (plans/008) is the regression net for the 11 copies.
- Existing suites green; the perf character is unchanged (single visit per element).

## Done criteria
- [ ] All 10 `page.js` collection blocks + `manager.js` `collect()` use the root worklist (same shape; PiP selects video only)
- [ ] The nested fixture element is detected, governed, and controllable in e2e
- [ ] `npm test`, `npm run harness`, `npm run e2e` all exit 0; counts updated where changed
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The excerpts don't match, or plans/002 has landed with a materially different `collect()` shape this plan would clobber — rebase the worklist onto the live code and re-verify.
- Any existing e2e step that counts elements or rows starts failing (the fixture pages gain a nested element only where this plan adds it — a failure elsewhere means the walk changed behavior on FLAT structures, which it must not).
- Duplicate-element regressions (a media element counted twice via light DOM + shadow) — the `seen` set must prevent it; if a step observes `×N` doubling, stop and report.

## Maintenance notes
- Any future injected function that enumerates media must copy the worklist form; the plans/008 drift guard is the enforcement point.
- The mock harness's `'*'` returning `[]` stays true — if the mock ever grows shadow roots, the drift guard's count expectation must be revisited.
- Reviewers should scrutinize: no element visited twice (the `seen` set), `isConnected` filtering preserved, and that `MutationObserver`-driven rescans pick up nested hosts added later (they do — attribute/childList mutations of the outer document surface the outer host; nested insertions INSIDE an existing root are caught because the rescan walks roots again).

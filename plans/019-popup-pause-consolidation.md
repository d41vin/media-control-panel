# Plan 019: Consolidate the duplicated pause/command-stamp loop in popup.js

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/popup.js plans/006-popup-state-reliability.md plans/011-popup-phantom-playing-recovery.md`
> If any in-scope file changed since this plan was written (plans 006/011 edit
> nearby popup code), compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: S
- **Risk**: MED (this is the state-machine code the ordering comments warn about — the helper must preserve the mark-before-dispatch order exactly)
- **Depends on**: plans/006 and plans/011 (recommended — they edit the same file; land those first, then consolidate on the settled code)
- **Category**: tech-debt
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: D3 (pause/command-stamp block implemented twice; the c1f976c fix had to touch five sites in lockstep, HIGH)

## Why this matters

The per-tab "mark the play state, stamp the command ordering, dispatch the
all-frames pause, clear the pending flag" block exists twice — in `pauseAll`
and in the pause-others loop of `playExclusive`. The command-ordering stamps
(`commandAt` / `commandPending` / `mediaPlaying`) are the popup's most
subtle invariant (the phantom-playback guard), and commit `c1f976c`
("commands outrank stale probe and ping results") had to change
`togglePlay`, `pauseAll`, `playExclusive`, `pingNow` and `applyProbe` in
lockstep — the exact bug class a missed site causes. One file-local helper
collapses the two dispatch sites so the next fix to the ordering rules is a
one-place change. Deliberately NOT in scope: the two 80 ms debounce
implementations (volume/boost) and the duplicated `playerMuted ?? element.muted`
derivations — two occurrences each, and consolidating them trades clarity
for nothing until a third appears.

## Current state

Files and roles:
- `extension/popup.js` — the two dispatch sites + the helpers they use.

Excerpts (verified at `f6101d2`):

Site 1 — `pauseAll`'s job body, `extension/popup.js:1228-1252`:
```js
async function pauseAll() {
  const jobs = [...rows.values()].filter((r) => r.playing).map(async (rec) => {
    rec.mediaPlaying = false;
    // mark the ordering BEFORE dispatch: any ping or probe already in flight
    // is stale and must not flip this tab back to playing; the pending flag
    // also covers pings dispatched after the mark but racing the pause
    rec.commandAt = Date.now();
    rec.commandPending = true;
    updateRow(rec);
    try {
      // all frames: media can live in embeds outside the primary frame
      await chrome.scripting.executeScript({
        target: { tabId: rec.tab.id, allFrames: true },
        func: pagePause,
      });
    } catch {
      // tab gone; onRemoved cleans up
    } finally {
      rec.commandPending = false;
    }
  });
  await Promise.allSettled(jobs);
  refreshChrome();
  reorder();
}
```

Site 2 — `playExclusive`'s pause-others loop, `extension/popup.js:1401-1420`:
```js
  const jobs = [...rows.values()]
    .filter((r) => r !== rec && r.playing)
    .map(async (other) => {
      other.mediaPlaying = false;
      other.commandAt = Date.now(); // in-flight pings/probes are stale
      other.commandPending = true;
      updateRow(other);
      try {
        // all frames: media can live in embeds outside the primary frame
        await chrome.scripting.executeScript({
          target: { tabId: other.tab.id, allFrames: true },
          func: pagePause,
        });
      } catch {
        // tab gone; onRemoved cleans up
      } finally {
        other.commandPending = false;
      }
    });
  await Promise.allSettled(jobs);
  refreshChrome();
  reorder();
```
The two bodies are the same modulo the record variable and one comment line.
The record fields live on the row (`popup.js:505-507`: `commandAt`,
`commandPending`; `mediaPlaying` beside them).

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0 (the 3.3 s quick-mute and command-matrix assertions exercise these paths) |
| Full e2e | `npm run e2e` | exit 0; 122/122 (exclusive-playback and pause-all steps are the canary) |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/popup.js` (extract one helper; replace the two bodies)

**Out of scope**:
- `togglePlay`/`playExclusive`'s own optimistic handling (only the shared pause-dispatch block is extracted).
- The debounce pairs and the `playerMuted` derivation duplicates (documented as not-worth-doing).
- `pingNow`/`applyProbe` (plans 006/011 own their changes).
- Any behavior change whatsoever — this is a mechanical extraction.

## Git workflow
- Branch: `advisor/019-pause-consolidation`
- One conventional commit (`refactor(popup): one helper for the mark-and-pause dispatch`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Extract the helper
Place it directly above `pauseAll`:
```js
/**
 * The shared pause dispatch: mark the play state and the command ordering
 * BEFORE injecting, so any ping/probe already in flight is stale and cannot
 * flip the tab back to playing; the pending flag also covers pings
 * dispatched after the mark but racing the pause. Used by Pause all and by
 * exclusive playback's pause-others loop — the ordering rules live HERE and
 * nowhere else.
 */
async function pauseViaCommand(rec) {
  rec.mediaPlaying = false;
  rec.commandAt = Date.now();
  rec.commandPending = true;
  updateRow(rec);
  try {
    // all frames: media can live in embeds outside the primary frame
    await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, allFrames: true },
      func: pagePause,
    });
  } catch {
    // tab gone; onRemoved cleans up
  } finally {
    rec.commandPending = false;
  }
}
```
Then both sites become `.map((rec) => pauseViaCommand(rec))` (site 2 keeps
its `r !== rec && r.playing` filter and its `other` naming at the call site).

**Verify**: `npm test` → exit 0.

### Step 2: Prove equivalence with the suites
The ordering-sensitive canaries:
- harness: the background-mock command scenarios + the popup pass's 3.3 s quick-mute window;
- e2e: the exclusive-playback steps, pause-all, and the rapid-command matrix steps (7a/7b/8a/8b) — these fail loudly if the mark-before-dispatch order moved.

**Verify**: `npm run harness` → exit 0; `npm run e2e` → exit 0, 122/122.

## Test plan
- No new tests: the existing ordering canaries ARE the test (their assertion names must not change); the PR body lists them as the equivalence proof.

## Done criteria
- [ ] One `pauseViaCommand` helper exists; both call sites delegate; the mark-before-dispatch order is byte-preserved inside it
- [ ] `npm test`, `npm run harness`, `npm run e2e` all exit 0 with unchanged assertion counts
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The two excerpts have drifted apart (they must be identical modulo the record variable at `f6101d2`) — if they differ, the difference is an unrecorded behavioral divergence: STOP and report the delta instead of choosing a winner silently.
- Any ordering canary fails or flakes — the extraction must be invisible; report.
- plans 006/011 have not landed and the file is mid-restructure — rebase first (dependency).

## Maintenance notes
- Future changes to the command-ordering rules now land in one place; `togglePlay`/`playExclusive`'s own optimistic marks remain intentionally separate (they mark PLAY state, not pause).
- If a third dispatch site ever appears, fold it into the helper — that was the whole point.
- Reviewers should scrutinize the diff for any accidental reordering of the four stamp statements.

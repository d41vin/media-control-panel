# Plan 011: Recover a card whose media disappears mid-session (phantom "playing" with frozen readouts)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/popup.js extension/lib/page.js scripts/e2e.mjs plans/006-popup-state-reliability.md`
> If any in-scope file changed since this plan was written (especially plan
> 006's popup edits), compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: M
- **Risk**: MED (touches the probe/command ordering guards — the popup's most subtle invariant; every step must respect `commandAt`/`commandPending`)
- **Depends on**: plans/006 (recommended — same file; land the small popup fixes first)
- **Category**: bug
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C11 (phantom playing after media removal, MED confidence — mechanism certain, occurrence narrow)

## Why this matters

An SPA that detaches/replaces its video while it plays (or a frame navigation
that lands mid-probe) leaves the card permanently wrong until the popup is
reopened: the equalizer keeps animating, the button says "Pause", position
and title freeze, the row ranks as playing, and it is included in Pause all.
Three gaps compose:

1. `pingNow` returns `null` on `!state?.present` **before** updating
   `rec.mediaPlaying` — the last "playing" truth is frozen.
2. `togglePlay` awaits `pageToggle` but discards its `{acted}` result — the
   optimistic flip is never corrected when nothing is there to toggle.
3. The ping loop keeps running (`rec.playing` stays true) but every ping
   short-circuits; the only re-probe path after init is the probeless-volume-
   open one.

The fix: treat `present: false` as evidence — after N consecutive misses,
clear the element truth and re-probe once; and fold `pageToggle`'s `acted`
result into the optimistic state exactly like `playExclusive` already does.

## Current state

Files and roles:
- `extension/popup.js` — rows, ping loop, command handling.
- `extension/lib/page.js` — `pagePing` returns `{present: false}` when the frame holds no media; `pageToggle` returns `{acted: false}`.
- `scripts/e2e.mjs` — the deterministic layer for the repro (real DOM removal).

Excerpts (verified at `f6101d2`):

`extension/popup.js:1161-1209` — `pingNow` (the short-circuit at `:1173-1174`
precedes the state fold at `:1196-1203`):
```js
async function pingNow(rec) {
  if (!rec?.probe) return null;
  const startedAt = Date.now();
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: rec.tab.id, frameIds: [rec.probe.primaryFrameId] },
      func: pagePing,
      args: [siteSelectors(rec)],
    });
    // the row may have been removed while the ping was in flight — a late
    // result must never resurrect its card into the DOM
    if (rows.get(rec.tab.id) !== rec) return null;
    const state = results[0]?.result;
    if (!state?.present) return null;
```
(the command-staleness fold follows at `:1196-1203`:
```js
    if (startedAt >= rec.commandAt && !rec.commandPending) {
      rec.mediaPlaying = state.playing;
      rec.pip = !!state.pip;
    }
```
)

`extension/popup.js:1354-1375` — `togglePlay` discards the result:
```js
  rec.mediaPlaying = rec.playing ? false : true;
  rec.commandAt = Date.now(); // in-flight pings/probes are stale from here
  rec.commandPending = true;
  updateRow(rec);
  reorder();
  try {
    await chrome.scripting.executeScript({ target: targetFor(rec), func: pageToggle });
  } catch {
    // uninjectable tab (chrome://, sandboxed frame): the command never landed,
    // so fall back to the truth we know instead of the optimistic guess
    rec.mediaPlaying = null;
    updateRow(rec);
  } finally {
    rec.commandPending = false;
  }
```
The precedent for consuming results — `playExclusive` at `:1387-1391`:
```js
    const results = await chrome.scripting.executeScript({
      target: targetFor(rec),
      func: pagePlay,
    });
    played = results[0]?.result?.acted === true;
```
and `lib/page.js:161-178` — `pageToggle` returns `{acted: false}` when the
frame holds no media, `{acted: true, state: 'paused'|'played'}` otherwise.

`extension/popup.js:1005-1012` — the loop follows `wantPing`:
```js
  const wantPing = rec.playing || rec.openPopover === 'vol';
  if (wantPing && rec.probe && !rec.ping) startPing(rec);
  if (rec.ping && !wantPing) stopPing(rec);
```

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0 |
| Full e2e | `npm run e2e` | exit 0; previous total + the new repro step |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/popup.js` (`pingNow`, `togglePlay`, plus one row-record counter field)
- `scripts/e2e.mjs` (one repro step using real DOM removal)
- `README.md` counts if changed

**Out of scope**:
- `extension/background.js` (this is popup display state only).
- The probeless-volume-open recovery path (`popup.js:640-653`) — leave as is.
- Row removal/keep-without-media logic in `init()` — untouched.
- plans/006's ping-after-adapter change — compose (the same `pingNow`).

## Git workflow
- Branch: `advisor/011-phantom-playing-recovery`
- Conventional commits (`fix(popup): re-probe cards whose media vanished`, `fix(popup): togglePlay folds the acted result`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (part A): `togglePlay` folds the `acted` result
Mirror `playExclusive`:
```js
  try {
    const results = await chrome.scripting.executeScript({ target: targetFor(rec), func: pageToggle });
    const acted = results[0]?.result?.acted === true;
    if (!acted && rows.get(rec.tab.id) === rec) {
      // nothing toggled: the optimistic flip was wrong (media gone or the
      // tab turned uninjectable) — fall back to the known truth
      rec.mediaPlaying = null;
      updateRow(rec);
    }
  } catch {
    // uninjectable tab (chrome://, sandboxed frame): the command never landed,
    // so fall back to the truth we know instead of the optimistic guess
    rec.mediaPlaying = null;
    updateRow(rec);
  } finally {
    rec.commandPending = false;
  }
```
(The catch branch's existing behavior is preserved; the new branch handles
the injectable-but-empty case. The `rows.get(...) === rec` guard follows the
file's late-result convention.)

**Verify**: `npm test` → exit 0.

### Step 2 (part B): Re-probe after consecutive present-misses
1. Add a counter to the row record (next to `ping: null`): `presentMisses: 0,`.
2. In `pingNow`, replace the bare short-circuit:
```js
    if (!state?.present) {
      // the primary frame reports no media: either a transient probe miss or
      // the media vanished. Freeze nothing — count it and re-probe once the
      // misses look real. Command-staleness rules apply as everywhere else.
      if (rows.get(rec.tab.id) === rec && startedAt >= rec.commandAt && !rec.commandPending) {
        rec.presentMisses = (rec.presentMisses ?? 0) + 1;
        if (rec.presentMisses >= 3) {
          rec.presentMisses = 0;
          void probeTab(rec).then((probe) => {
            if (rows.get(rec.tab.id) !== rec) return; // closed meanwhile
            applyProbe(rec, probe); // null probe clears element truth + mediaPlaying
            refreshChrome();
          });
        }
      }
      return null;
    }
    rec.presentMisses = 0;
```
`applyProbe(rec, null)` already performs the correct demotion
(`rec.mediaPlaying = null`, element truth cleared) — that single render path
is the reason this fix stays small. Note: `pingNow`'s `!rec?.probe` early
return at the top still applies — the re-probe path only runs for rows that
HAD a probe (rows without a probe are the probe-miss state, already truthful).

3. Reset `presentMisses` wherever a fresh probe lands (in `applyProbe`, set
   `rec.presentMisses = 0;` beside `rec.playerMuted = null;`).

**Verify**: `npm test` → exit 0.

### Step 3: e2e repro step
In `scripts/e2e.mjs`, add a step (real DOM removal — the fixture layers are
the deterministic repro):
1. With a playing element on a fixture tab (row exists, ping loop live), evaluate in the page: `document.querySelectorAll('audio')[0].remove()` (or `mcpFix.remove(0)` if matrix context).
2. Bounded poll (≤6 s) and assert the card demotes: the row gains `.paused` (no equalizer), the play button reads "Play" (`aria-label`), and — for a tab that is not audible/pinned — the row LEAVES the list on the next reconcile (its only anchor was the phantom playing state) OR stays with truthful paused state if kept. Assert precisely what the code now does and encode it: with no probe, `keepWithoutMedia` logic does not apply mid-session — the row stays but shows probe-miss truth (controls disabled, no phantom playing). Assert: `.rate-readout` shows `1.00×` (no policy) or the policy rate, `.pos.disabled === true`, play `aria-label` flips back to "Play" within the poll window.
3. Restore by re-adding a media element (fixture `add()`) and assert the card recovers to playing after the re-probe (the same machinery, opposite direction).
Name: `popup: a card whose media vanishes demotes to truthful paused state and recovers when media returns`.

**Verify**: `npm run e2e` → exit 0 with the new step; record totals; update documented counts.

## Test plan
- New e2e step (Step 3) — the repro pin in both directions (vanish → truthful demotion; re-add → recovery).
- Harness-level guard (add to the popup pass if cheap): with the popup-mock's fake background, remove the mock element and assert the row demotes — only if the mock supports element removal without new machinery; otherwise the e2e step stands alone (mock elements are plain objects; removal support is NOT required — skip rather than build it).
- Existing suites green — especially the command-vs-probe ordering steps (the re-probe must respect `commandAt`/`commandPending`; the matrix's rapid-command steps are the canary).

## Done criteria
- [ ] `togglePlay` folds `acted`; `pingNow` counts present-misses and re-probes at 3; `applyProbe` resets the counter
- [ ] The e2e repro step passes in both directions; `npm test`/`npm run harness`/`npm run e2e` all exit 0
- [ ] Counts updated where changed; no files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions
- The excerpts don't match, or plans/006 has materially reshaped `pingNow`'s tail — re-verify the compose.
- Any rapid-command matrix step (7a/7b/8a/8b) becomes flaky — the re-probe must never race a command; a flake means the `commandAt`/`commandPending` guards are misapplied. Stop and report.
- The demoted row's expected truthful state differs from the assertions in Step 3.2 (e.g. the row is removed rather than demoted) — encode the OBSERVED correct behavior only if it matches DESIGN.md's "Probe-miss" state definition; otherwise stop and report the divergence.

## Maintenance notes
- If the popup later gains incremental re-probes for other stale states (e.g. artwork), reuse this counter pattern rather than ad-hoc timers.
- The `presentMisses >= 3` threshold trades responsiveness (~3 s) against false re-probes on busy frames; keep it a named constant if it is ever tuned.
- Reviewers should scrutinize: the re-probe respects the row-identity guard AND the command-staleness windows; `applyProbe(null)` cannot clobber a command that landed during the probe (the `stale` check inside `applyProbe` covers it — verify).

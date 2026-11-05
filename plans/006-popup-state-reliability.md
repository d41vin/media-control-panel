# Plan 006: Popup state reliability — adapter refresh, ghost-override fallback, authoritative volume commit

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/popup.js extension/lib/page.js scripts/harness.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C6 (next/prev never refreshes the card, HIGH), C7 (page-speed fallback leaves a ghost override, HIGH), C14 (volume commit discards the authoritative result — straddling ping regression, MED)

Three small, independent popup-state defects that share one theme — the
popup's optimistic state must converge on the authoritative truth — and
share one file. They are grouped because each fix is tiny and each has its
own deterministic harness assertion; splitting them into three plans would
triple the ceremony for ~20 lines total.

## Why this matters

1. **C6**: On sites whose skip stays paused (Spotify web player, muted tabs),
   next/previous changes the track but the card keeps the old title, times
   and adapter-button state indefinitely — no ping loop runs for a paused
   card without the volume popover open. Every other transport control
   schedules a confirmation ping; the adapter path was missed.
2. **C7**: `notePendingPageSpeed`'s 3 s fallback comment promises "falls back
   to the stored truth", but it only deletes the pending marker and
   re-renders — the optimistic mirror entry written by `setPageSpeed`
   survives, so a command that never lands (dying tab, storage failure,
   harness) leaves a ghost override: accent value, visible reset button,
   wrong step base, wrong "N page overrides" count, for the popup's lifetime.
3. **C14**: The debounced volume commit throws away `pageSetVolume`'s
   authoritative result (`{acted, volume}`), so a 1 Hz ping that read the OLD
   volume just before the write can pull the slider/readout back to the
   pre-drag value for up to a second after release.

## Current state

Files and roles:
- `extension/popup.js` — the whole popup UI.
- `extension/lib/page.js` — injected functions; `pageSetVolume` returns the applied volume.
- `scripts/harness.mjs` — popup pass is the deterministic test layer.

Excerpts (verified at `f6101d2`):

C6 — `extension/popup.js:1426-1436`:
```js
/** Next/previous track through the site's own player buttons. */
async function runAdapter(rec, direction) {
  if (!rec?.adapter) return;
  try {
    await chrome.scripting.executeScript({
      target: targetFor(rec),
      func: direction === 'next' ? rec.adapter.next : rec.adapter.prev,
    });
  } catch {
    // tab gone or uninjectable; nothing to correct
  }
}
```
The established pattern — `:416-423` (back10):
```js
  back10.addEventListener('click', () => {
    void exec(rec(), pageSeekBy, { seconds: -10 });
    setTimeout(() => void pingNow(rows.get(tab.id)), 120);
  });
```

C7 — `extension/popup.js:125-136`:
```js
function notePendingPageSpeed(tabId, pending) {
  pendingPageSpeed.set(tabId, pending);
  // a command that never confirms (dead tab, no receiver) falls back to the
  // stored truth instead of pinning the card to a ghost choice
  setTimeout(() => {
    if (pendingPageSpeed.get(tabId) === pending) {
      pendingPageSpeed.delete(tabId);
      const r = rows.get(tabId);
      if (r) updateRow(r);
    }
  }, 3000);
}
```
and the optimistic write it must roll back — `:753-764`:
```js
async function setPageSpeed(rec, rate) {
  if (!rec) return;
  // optimistic: the storage event reconciles; the background validates
  notePendingPageSpeed(rec.tab.id, rate);
  overrides.set(rec.tab.id, { url: rec.tab.url, rate, at: Date.now() });
  updateRow(rec);
  try {
    await chrome.runtime.sendMessage({ type: 'mcp-speed-page', tabId: rec.tab.id, rate });
  } catch {
    // no receiver (harness): the optimistic state still shows the choice
  }
}
```
(`resetPageSpeed` at `:766-776` has the mirror-image shape for resets. The
worker legitimately produces no confirming event: `background.js:723-724`
early-returns without writing when the tab URL can't be read.)

C14 — `extension/popup.js:566-574` (inside the volume `input` handler's
debounced commit):
```js
        const wanted = rec.pendingVolume;
        rec.pendingVolume = null;
        void (async () => {
          await exec(rec, pageSetVolume, { volume: wanted });
          // hosts with a private player API need the API channel too —
          // element writes alone don't move their UI
          await syncSitePlayer(rec);
          // the site may have rounded or clamped the value; the ping is
          // what makes the readout the element's actual truth
          void pingNow(rec);
        })();
```
`exec` (`:1299-1311`) returns `results[0]?.result ?? null`, and
`extension/lib/page.js:275-277` returns the applied value:
```js
  el.volume = Math.min(1, Math.max(0, volume));
  return { acted: true, volume: el.volume };
```
The regression window: `pingNow` (`:1174-1185`) folds any ping result into
`p.element.volume`; `syncCard` (`:1113-1117`) writes `element.volume` into
the slider whenever `rec.pendingVolume === null` — i.e. after the commit
cleared it, a ping dispatched BEFORE the write can regress the readout.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke pass (grows) |
| Full e2e | `npm run e2e` | exit 0; 122/122 |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/popup.js` (the three fixes)
- `scripts/harness.mjs` (popup-pass assertions for C6 and C7; C14's is covered by the existing volume-popover assertions plus one new read)
- `README.md` harness count if changed

**Out of scope**:
- `extension/background.js` (plan 007 owns its fixes) — in particular do NOT change the worker's early-return at `background.js:723-724`; the popup-side fallback is the agreed remediation.
- `extension/lib/page.js` (functions are correct and serialization-checked).
- The pending-page-speed confirm/clear logic in the storage.onChanged handler (`popup.js:1827-1844`) — verified sound.
- `pingNow`'s stale-command ordering guards (`commandAt`/`commandPending`) — untouched.

## Git workflow
- Branch: `advisor/006-popup-state-reliability`
- Conventional commits, one per finding (`fix(popup): adapter skips refresh the card`, `fix(popup): page-speed fallback restores the stored truth`, `fix(popup): volume commit adopts the applied value`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (C6): Adapter clicks refresh the card
`runAdapter` gains the same confirmation ping the transport buttons use:
```js
async function runAdapter(rec, direction) {
  if (!rec?.adapter) return;
  try {
    await chrome.scripting.executeScript({
      target: targetFor(rec),
      func: direction === 'next' ? rec.adapter.next : rec.adapter.prev,
    });
    // a paused card has no ping loop: without this the card keeps the old
    // track's title/times until the user interacts (Spotify, muted tabs)
    setTimeout(() => void pingNow(rows.get(rec.tab.id)), 250);
  } catch {
    // tab gone or uninjectable; nothing to correct
  }
}
```
(The 250 ms matches the PiP confirmation at `popup.js:426`.)
**Verify**: `npm test` → exit 0.

### Step 2 (C7): The fallback restores the stored truth
`notePendingPageSpeed`'s timeout must reload the store before re-rendering:
```js
function notePendingPageSpeed(tabId, pending) {
  pendingPageSpeed.set(tabId, pending);
  // a command that never confirms (dead tab, no receiver) falls back to the
  // stored truth instead of pinning the card to a ghost choice
  setTimeout(() => {
    if (pendingPageSpeed.get(tabId) !== pending) return; // superseded meanwhile
    pendingPageSpeed.delete(tabId);
    void (async () => {
      try {
        const { speedOverrides } = await chrome.storage.session.get('speedOverrides');
        // only roll the mirror back when no confirming event replaced it
        if (pendingPageSpeed.has(tabId)) return;
        overrides = new Map(
          Object.entries(speedOverrides && typeof speedOverrides === 'object' ? speedOverrides : {}).map(([k, v]) => [Number(k), v]),
        );
      } catch {
        // storage unavailable: at minimum drop this tab's optimistic entry
        overrides.delete(tabId);
      }
      const r = rows.get(tabId);
      if (r) updateRow(r);
      renderGlobalSpeed();
    })();
  }, 3000);
}
```
The `pendingPageSpeed.has(tabId)` re-check guards against a NEWER command
having been issued while the storage read was in flight (its own pending
marker must win). Note this helper now needs `renderGlobalSpeed` in scope —
it is a module-level function in the same file; call ordering is unchanged.

**Verify**: `npm test` → exit 0.

### Step 3 (C14): The commit adopts the applied value
```js
        const wanted = rec.pendingVolume;
        rec.pendingVolume = null;
        void (async () => {
          const applied = await exec(rec, pageSetVolume, { volume: wanted });
          // adopt what actually landed: a ping dispatched before the write
          // must not drag the readout back to the pre-drag value
          const p = applied?.acted ? primaryOfProbe(rec.probe)?.element : null;
          if (p && Number.isFinite(applied.volume)) {
            p.volume = applied.volume;
            if (rows.get(rec.tab.id) === rec && !rec.dragging) updateRow(rec);
          }
          // hosts with a private player API need the API channel too —
          // element writes alone don't move their UI
          await syncSitePlayer(rec);
          // the site may have rounded or clamped the value; the ping is
          // what makes the readout the element's actual truth
          void pingNow(rec);
        })();
```
**Verify**: `npm test` → exit 0.

### Step 4: Harness assertions
In the popup pass of `scripts/harness.mjs`:
- **C6**: the mock tab for the adapter row (the popup-mock seeds an adapter-host tab — its row has non-disabled prev/next). Click `.next` while the element is PAUSED (pause it via `chrome._mock.toggle(1)` first if needed), then poll ≤2 s for the card's title to change to the mock's next-track title (the popup-mock's site-button click counter names it — read the fixture's `_siteButtons` wiring) or, more robustly, assert `.adapterState`/time fields refreshed: the deterministic signal is `chrome._mock.tabs.get(1)._clicks.next === 1` AND a fresh ping having run — assert the card's `.pos-readout`/title changed after the click. Name it `popup-mock adapter: next on a paused card refreshes the card`.
- **C7**: send a page-speed command for a tab the background-mock will refuse (the popup-mock's fake background has no `mcp-speed-page` refusal knob — instead simulate the no-receiver case: temporarily delete the listener? Simplest deterministic route: use the EXISTING popup-mock behavior — it confirms page-speed commands, so instead drive the fallback directly: call the popup's flow with a tab id that has no row … this needs a small mock knob: in `test/popup-mock.html`'s fake background add `mcp-speed-page` refusal when `chrome._mock.refuseSpeedPage` is set (mirror the `boostFailNext` knob pattern from plans/005). Then: set `refuseSpeedPage = true`, click `.rate-inc`, assert the override shows optimistically, wait ~3.5 s, assert the card shows the stored truth (override marker gone, since storage never gained the entry) and `#gspeed-note` counts drop back.
- **C14**: extend the existing volume block: after dispatching `input`+`change` on `.vol` to 0.45, poll the readout equals `45%` and STAYS `45%` across one ping tick (two samples 1.1 s apart) — pre-fix, a straddling ping could regress it; post-fix the authoritative fold pins it.

Wire results into the pass criteria and ok-lines per the file's pattern.
**Verify**: `npm run harness` → exit 0; record the new totals.

### Step 5: Update counts + regression gate
Update documented harness counts; **Verify**: `npm run e2e` → exit 0, 122/122.

## Test plan
- New harness assertions: adapter-refresh (C6), ghost-override fallback (C7, needs the `refuseSpeedPage` knob), volume-commit stability across a ping tick (C14).
- Existing: full harness + e2e green; in particular the override-echo/pending confirm logic in `popup.js:1827-1844` is untouched and its e2e steps must stay green.

## Done criteria
- [ ] `runAdapter` schedules a confirmation ping; the fallback timeout reloads `speedOverrides` before re-rendering; the volume commit folds `applied.volume` into the probe element
- [ ] `npm test` exits 0; `npm run harness` exits 0 with the three new assertion groups; `npm run e2e` exits 0 at 122/122
- [ ] Counts updated where changed; no files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions
- The excerpts don't match (drift).
- The `refuseSpeedPage` knob cannot be added without altering the fake background's confirm semantics for EXISTING tests — report; do not weaken existing popup-mock flows.
- The C7 reload races a real storage event in the harness (flaky on re-run) — stop after two tuning attempts; the re-check guard should prevent it, so a flake means a misread of the ordering.

## Maintenance notes
- The fallback reload replaces the whole `overrides` map — if plans/007 or later changes the store's shape (keys/values), revisit this mapping.
- C11 (phantom playing after media removal, plans/011) extends `pingNow` with re-probe logic — the `present:false` short-circuit this plan deliberately leaves alone; keep the two changes orthogonal.
- Reviewers should scrutinize the double-check `pendingPageSpeed.has(tabId)` ordering relative to the storage read, and that `renderGlobalSpeed()` is called so the header override count follows.

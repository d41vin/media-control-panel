# Plan 005: Make the popup's 15 s boost belt per-attempt, and drive the popup's boost UI in the harness

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/popup.js scripts/harness.mjs test/popup-mock.html`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (+ test coverage that pins it)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C5 (15 s belt not per-attempt — lying error over a legitimate retry, HIGH), T6 (popup boost UI never driven in the harness, HIGH)

## Why this matters

The popup arms a 15 s belt ("Capture did not start") on every boost start,
because the worker answers boost commands fire-and-forget. The belt is a bare
`setTimeout` that is never stored or cancelled. A first attempt that fails
fast (its error auto-clears after 8 s) followed by a retry inside the first
attempt's belt window gets stamped with a **lying error** while the second
attempt is legitimately pending (the worker's own deadline is 12 s from ITS
start): the chip flips to error mid-start, the user may click Reset, and the
state flips back if the worker succeeds. That violates the project's core
"states are truthful" principle in exactly the flow designed to guarantee it.

Separately, the popup side of boost is the only surface users see, and no
suite ever clicks it: `test/popup-mock.html` implements a full fake boost
flow, but the harness's popup pass reads only the slider's `step` attribute.
The belt fix therefore lands together with the harness coverage that pins it
(pending→active, gain, error text, auto-clear, belt fairness).

## Current state

Files and roles:
- `extension/popup.js` — boost UI state machine (chip, popover, belt, error auto-clear).
- `scripts/harness.mjs` — runner; its popup pass drives the real popup against `test/popup-mock.html` and asserts final states.
- `test/popup-mock.html` — popup harness page; already simulates the worker's boost flow (start → pending → active after 60 ms, gain, stop).

Excerpts (verified at `f6101d2`):

`extension/popup.js:799-808` — the belt, never stored or cancelled:
```js
/** A start that never reports back (hung capture) must not stay pending. */
function scheduleBoostResultTimeout(tabId) {
  setTimeout(() => {
    const cur = boostStates.get(tabId);
    if (cur?.state === 'pending') {
      setBoostLocal(tabId, { gain: cur.gain, state: 'error', error: 'Capture did not start' });
      scheduleBoostErrorClear(tabId);
    }
  }, 15000); // the worker converges its own state at 12 s; this is the belt
}
```

`extension/popup.js:817-834` — armed on every `boostEnable`:
```js
async function boostEnable(rec, pct) {
  if (!rec || rec.boostStarting) return;
  rec.boostStarting = true;
  setBoostLocal(rec.tab.id, { gain: pct, state: 'pending' });
  try {
    await chrome.runtime.sendMessage({
      type: 'mcp-boost-start',
      tabId: rec.tab.id,
      gain: pct,
    });
    scheduleBoostResultTimeout(rec.tab.id);
  } catch (e) {
    setBoostLocal(rec.tab.id, { gain: pct, state: 'error', error: errText(e) });
    scheduleBoostErrorClear(rec.tab.id);
  }
  rec.boostStarting = false;
  updateRow(rec);
}
```

`extension/popup.js:836-852` — `boostDisable` clears `boostTimer`/`pendingBoost` but not the belt. The row record already has timer slots to reuse (`popup.js:510-515`: `volTimer`, `boostTimer`, `errorTimer`). The success path (`mcp-boost-result` listener at `:856-865`) also never cancels the belt (harmless once active — the belt checks `state === 'pending'` — but cancelling is cleaner and required for the retry fix).

The worker-side counterpart for context (unchanged): `background.js:481`
`BOOST_START_TIMEOUT_MS = 12000`; the popup's 8 s error auto-clear is
`scheduleBoostErrorClear` (`popup.js:787-797`).

The mock's fake worker flow — `test/popup-mock.html:231-241`:
```js
        } else if (msg.type === 'mcp-boost-start') {
          // simulate the worker's capture flow: the tab is "capturable", so
          // the start succeeds and the pipeline reports active
          const map = await boostsMap();
          map[msg.tabId] = { gain: msg.gain, state: 'pending' };
          await chrome.storage.session.set({ boosts: map });
          await new Promise((r) => setTimeout(r, 60));
```

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke pass (grows) |
| Full e2e | `npm run e2e` | exit 0; 122/122 |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/popup.js` (belt timer bookkeeping; belt constant extraction to a named module constant is welcome but optional — plans/018 later moves boost constants)
- `scripts/harness.mjs` (popup-pass boost block)
- `test/popup-mock.html` (a failing-start knob for the mock's fake worker, mirroring the existing gate style)
- `README.md` harness count if changed

**Out of scope**:
- `extension/background.js` / `extension/offscreen.js` — the worker's 12 s deadline and request-id machinery are correct (plans/001 owns their cold-start gate).
- Slider drag-guard and debounce logic (`wireCard`'s boost input handler) beyond what the belt fix requires.
- The error auto-clear duration (8 s) and the belt duration (15 s) — keep the values; only the bookkeeping changes.

## Git workflow
- Branch: `advisor/005-boost-belt-per-attempt`
- Conventional commits (`fix(popup): the boost result belt is per-attempt`, `test(harness): drive the popup's boost UI`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Store, clear, and re-arm the belt per row
In `extension/popup.js`:
1. Extract the duration to a named constant near the other popup constants
   (top of file, after the imports): `const BOOST_RESULT_BELT_MS = 15000; // the worker converges its own state at 12 s; this is the belt`
2. `scheduleBoostResultTimeout` becomes re-arm-safe and returns the handle:
```js
/** A start that never reports back (hung capture) must not stay pending.
    Re-armed (never stacked) per attempt: a stale belt from a failed attempt
    must not stamp a lying error over a legitimate retry. */
function scheduleBoostResultTimeout(tabId) {
  const rec = rows.get(tabId);
  if (rec?.beltTimer !== undefined) clearTimeout(rec.beltTimer);
  const timer = setTimeout(() => {
    const cur = boostStates.get(tabId);
    const r = rows.get(tabId);
    if (r) r.beltTimer = undefined;
    if (cur?.state === 'pending') {
      setBoostLocal(tabId, { gain: cur.gain, state: 'error', error: 'Capture did not start' });
      scheduleBoostErrorClear(tabId);
    }
  }, BOOST_RESULT_BELT_MS);
  if (rec) rec.beltTimer = timer;
}
```
3. Add `beltTimer: undefined,` to the row record literal (next to `errorTimer` at `popup.js:515`).
4. Cancel the belt at every terminal transition:
   - in `boostDisable` (next to the `boostTimer` cleanup, `popup.js:840-843`): clear `beltTimer` and set it `undefined`;
   - in the `mcp-boost-result` listener (`popup.js:856-865`): when a result arrives (either branch), clear the row's `beltTimer` the same way;
   - in `removeRow` (`popup.js:1325-1352`): clear `beltTimer` alongside the other timers.

**Verify**: `npm test` → exit 0.

### Step 2: Give the mock a failing-start knob
In `test/popup-mock.html`, extend the `mcp-boost-start` branch of the fake
worker: if `chrome._mock.boostFailNext` is set, consume it and record the
start as an ERROR instead of pending→active:
```js
        } else if (msg.type === 'mcp-boost-start') {
          const map = await boostsMap();
          if (chrome._mock.boostFailNext) {
            chrome._mock.boostFailNext = false;
            map[msg.tabId] = { gain: msg.gain, state: 'error', error: 'mock capture refused' };
            await chrome.storage.session.set({ boosts: map });
          } else {
            /* existing pending → active-after-60 ms flow, unchanged */
          }
```
(Initialize `chrome._mock.boostFailNext = false` wherever the page sets up
`chrome._mock` knobs; follow the file's existing knob style.)

**Verify**: `npm test` → exit 0 (static suite only checks referenced files parse — the real gate is Step 3's harness run).

### Step 3: Drive the popup's boost UI in the harness popup pass
In `scripts/harness.mjs`'s popup eval block, add a boost section AFTER the
existing audio-truths block (so the existing timings are untouched):
1. Happy path: set the boost slider to 250 (`b.value='250'` + `input` event),
   poll (≤2 s) until the chip readout shows `250%` and the mock's storage has
   `state:'active'`; move to 300 while active; assert the gain lands at 300
   without a second start (read `chrome._mock.scriptingCalls`-equivalent — in
   the popup mock the signal is the storage entry + no new pending phase).
2. Stop path: click `.boost-reset`; poll until the chip is back to `100%` and
   storage has no entry.
3. Belt fairness (the C5 regression, ~23 s total): set
   `chrome._mock.boostFailNext = true`, drag to 150 → assert the chip shows
   the truthful error text `mock capture refused`; wait out the 8 s
   auto-clear; drag to 150 again (attempt 2 legitimately pending) and
   immediately verify the chip reads `…` (pending); wait out the first
   attempt's belt window (the code under test must NOT fire it) and assert
   the chip NEVER showed `Capture did not start` during attempt 2's pending
   phase (sample at ~1 s intervals into an array), then lands `active` at the
   60 ms mock flow. Reset to 100 %.
   NOTE: this makes the harness popup pass ~25 s longer — acceptable and
   deterministic; note the new total runtime in the PR body.
4. Wire the collected booleans into the pass criteria like the existing
   `audioTruthsOk` pattern and add an ok-line
   (`popup-mock boost: pending→active, gain, truthful failure, belt is per-attempt`).

**Verify**: `npm run harness` → exit 0 with the new ok line; total counts updated.

### Step 4: Update documented counts + regression gate
Update the harness count wherever documented (`README.md` Testing table,
`docs/RESEARCH.md` "Current state") to the new total.
**Verify**: `npm run e2e` → exit 0, 122/122 (the e2e boost block is unaffected by popup-internal timer bookkeeping).

## Test plan
- New (harness popup pass): pending→active, gain-while-active, reset, truthful error text, 8 s auto-clear, belt-fairness across a fast-fail + retry (the C5 pin).
- Existing: full `npm run e2e` (its boost block exercises the worker side end-to-end in the headless error branch), all background assertions.

## Done criteria
- [ ] The belt timer is stored on the row (`beltTimer`), cleared in `boostDisable`, on `mcp-boost-result`, and in `removeRow`; re-armed (never stacked) by `scheduleBoostResultTimeout` itself
- [ ] `npm test` exits 0; `npm run harness` exits 0 including the new boost block; `npm run e2e` exits 0 at 122/122
- [ ] Harness/README counts updated where changed
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions
- The excerpts don't match (drift).
- The harness popup pass exceeds ~60 s wall time or becomes flaky (timing-based assertions failing on re-run) — stop and report; do not replace waits with shorter sleeps to force a pass.
- Making the mock fail a start requires changing the real worker's message contract — out of scope; report.

## Maintenance notes
- plans/018 later extracts the boost constants (100–600 %, deadlines) into a shared module; keep `BOOST_RESULT_BELT_MS` a single named constant so that move is mechanical.
- If the worker ever starts replying to boost commands (a response-bearing `sendMessage`), the belt can shrink dramatically — revisit then.
- Reviewers should scrutinize: every terminal boost transition clears the belt (error, success, stop, row removal) — a missed path reintroduces the lying error in that path's timing window.

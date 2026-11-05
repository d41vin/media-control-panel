# Plan 013: Coalesce and parallelize the global-speed fan-out

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/background.js test/background-mock.html plans/004-no-policy-disconnect-fanout.md plans/007-background-speed-sync-hardening.md`
> If any in-scope file changed since this plan was written (plans 004/007
> reshape nearby code), compare the "Current state" excerpts against the live
> code before proceeding; on a mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: M
- **Risk**: MED (the serialization exists to guarantee applies never land out of order — R6; the coalescing must preserve it)
- **Depends on**: plans/004 and plans/007 (same file/paths; land those first)
- **Category**: perf
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: PERF-3 (serial, uncoalesced global fan-out — O(tabs) awaited round trips per click, HIGH)

## Why this matters

While a speed policy is active, every global-speed change fans out to every
open injectable tab, and the fan-out is strictly serial: one queued batch
awaits `rawSyncSpeedTab` per tab, each performing up to three awaited API
calls (ISOLATED-world install, apply message, optional MAIN-world sync). At
5–10 tabs that is ~0.1–0.5 s of worker time per click; at 30+ tabs it is
multi-second, with rates converging tab-by-tab. Rapid stepper clicks stack
several complete fan-outs whose intermediate passes are fully superseded
(each pass re-reads live state, so only the last matters) — hundreds of
redundant injections and a worker kept awake for seconds.

Two safe transformations, combined:
1. **Parallelize within a batch** — tabs don't interact; the chain still
   serializes batch-vs-batch, which is what R6 actually requires.
2. **Coalesce queued no-op passes** — if a queued `syncSpeedEverywhere`
   arrives while an identical pass is already queued/running, it can collapse
   into it, because every per-tab sync re-reads the effective rate at run
   time (`effectiveRate`/`ensureSpeedState`) and stale applies are dropped by
   rev. A dirty-flag makes "another change arrived mid-pass" run exactly one
   follow-up pass instead of one per click.

## Current state

Files and roles:
- `extension/background.js` — the sync queue, the fan-out, and the trigger.
- `test/background-mock.html` — deterministic layer (the mock records every `executeScript`; call counts are assertable).

Excerpts (verified at `f6101d2`):

`extension/background.js:290-298` — the queue:
```js
// Speed syncs are serialized and read live state at run time: two rapid
// global-speed changes must never land out of order — a stale apply would
// drag a page back to an older rate and fight the newer choice.
let speedSyncChain = Promise.resolve();
function queueSpeedSync(fn) {
  const run = speedSyncChain.then(fn);
  speedSyncChain = run.catch(() => {});
  return run;
}
```

`extension/background.js:397-414` — the serial fan-out (unchanged by plan
004 except the no-policy branch already present):
```js
async function syncSpeedEverywhere() {
  return queueSpeedSync(async () => {
    // every previously managed tab must hear the change even when it is not
    // injectable any more — otherwise a manager survives with a stale
    // expectation
    const targets = await speedSyncTargets();
    if (!enforcementNeeded()) {
      for (const tabId of targets) {
        await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
        noteUnmanaged(tabId);
      }
      return;
    }
    for (const tabId of targets) {
      await rawSyncSpeedTab(tabId);
    }
  });
}
```

The trigger — `extension/background.js:1009-1012`:
```js
  if (area === 'local' && changes.speed) {
    globalSpeed = clampSpeed(changes.speed.newValue);
    void syncSpeedEverywhere();
  }
```
(and `tabs.onCreated`/`onUpdated`/webNavigation paths call the per-tab
`syncSpeedTab`, which queues individual items — those keep their ordering
guarantees and are NOT coalesced by this plan.)

R6 for reference — `docs/DESIGN.md:144-147`: "All speed syncs serialize
through one queue and re-read live state at run time… Applies carry the rev
and the manager drops older ones, so two applies can never land out of
order." Per-tab applies are inherently rev-guarded (`mcp-speed-apply` drops
`rev < S.rev` in `manager.js:261-267`), which is what makes within-batch
parallelism safe.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke (grows by the coalescing assertion) |
| Full e2e | `npm run e2e` | exit 0; current total — the rapid-change matrix steps (8a/8b) are the correctness canary |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/background.js` (`syncSpeedEverywhere` + a batch-dirty flag)
- `test/background-mock.html` (call-count/coalescing assertion)
- `README.md` counts if changed

**Out of scope**:
- `rawSyncSpeedTab` internals (plans 007/012 own their pieces).
- The per-tab syncs' internal ordering (install → apply → optional MAIN sync per tab stays as is).
- `speedSyncTargets` enumeration.
- The popup's global-speed save chain (`popup.js:699-719`) — already serialized, unrelated.

## Git workflow
- Branch: `advisor/013-fanout-coalescing`
- Conventional commits (`perf(speed): parallelize the global fan-out within a batch`, `perf(speed): coalesce superseded global passes`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Parallelize within a batch
```js
async function syncSpeedEverywhere() {
  return queueSpeedSync(async () => {
    const targets = await speedSyncTargets();
    if (!enforcementNeeded()) {
      await Promise.all(
        targets.map(async (tabId) => {
          await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
          noteUnmanaged(tabId);
        }),
      );
      return;
    }
    // tabs don't interact: one batch runs them concurrently while the chain
    // still serializes batch-vs-batch (R6). Per-tab applies are rev-guarded.
    await Promise.all(targets.map((tabId) => rawSyncSpeedTab(tabId)));
  });
}
```
`rawSyncSpeedTab` must not be re-entered for the same tab concurrently by
this batch — targets are unique in the set returned by `speedSyncTargets`
(verify: it builds a `Set` — true at `f6101d2`).

**Verify**: `npm test` → exit 0.

### Step 2: Coalesce superseded passes
Add a dirty-flag next to the queue:
```js
let speedFanoutDirty = false;
function requestSpeedEverywhere() {
  if (fanoutPassActive) {
    // a pass is queued/running: mark it stale so exactly one follow-up pass
    // converges every tab to the newest rate (each sync re-reads live state)
    speedFanoutDirty = true;
    return;
  }
  return queueSpeedSync(runSpeedEverywherePass);
}
async function runSpeedEverywherePass() {
  fanoutPassActive = true;
  try {
    await syncSpeedEverywhereBody();
    while (speedFanoutDirty) {
      speedFanoutDirty = false;
      await syncSpeedEverywhereBody(); // converge to the newest rate once
    }
  } finally {
    fanoutPassActive = false;
  }
}
```
(where `syncSpeedEverywhereBody` is the current body of
`syncSpeedEverywhere`, and the whole pass still runs INSIDE the queue via
`queueSpeedSync` — so per-tab `syncSpeedTab` items queued by tab events
during the pass keep their own place in the chain AFTER it). Change the
storage.onChanged trigger (`:1009-1012`) and the `mcp-speed-sync`/install
callers of `syncSpeedEverywhere` to call `requestSpeedEverywhere()`.
Concurrency guard: the flag set/checked inside the queued run is atomic per
event-loop turn — a change event arriving mid-pass sets the flag on the
microtask it runs in; the pass's `while` loop observes it. Keep the three
names close together with one comment block explaining the contract.

**Verify**: `npm test` → exit 0.

### Step 3: Mock assertions
In `test/background-mock.html`, with 3 injectable tabs and a policy active:
1. Rapid changes: set `chrome.storage.local` speed 1.5 → 2.0 → 2.5 in the
   same tick (three onChanged events, three `requestSpeedEverywhere` calls).
   Poll until `installSpeedManager` calls settle, then assert the TOTAL
   install calls across the coalesced pass is ≤ 6 (≤2 passes × 3 tabs;
   pre-fix, 3 serial passes = 9) and that every tab's final applied rate is
   2.5 (the newest).
2. Ordering canary (unchanged semantics): after a pass, a per-tab
   `syncSpeedTab` item queued during the pass still lands after it (assert
   via call order in `scriptingCalls`).
3. Existing rapid-change e2e steps (8a/8b) remain the live ordering canary.

**Verify**: `npm run harness` → exit 0; totals recorded.

### Step 4: Regression gate
**Verify**: `npm run e2e` → exit 0 at the current total (the matrix's rapid-global-change steps are exactly the behavior that must not regress). Update documented counts if the mock grew.

## Test plan
- New (background-mock): the coalescing call-count + final-rate assertion and the ordering canary.
- Existing: the full speed matrix; specifically "three rapid page-speed commands land on the final choice" and "rapid global changes never restore an obsolete value".

## Done criteria
- [ ] Within-batch tab syncs run via `Promise.all`; batch-vs-batch still serialized through `speedSyncChain`
- [ ] Superseded global passes collapse (dirty-flag, one follow-up pass); all callers of the old `syncSpeedEverywhere` now use `requestSpeedEverywhere()`
- [ ] The mock asserts the reduced install-call count and the unchanged final rate; `npm test`/`npm run harness`/`npm run e2e` all exit 0
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The excerpts don't match, or plans 004/007 have not landed (rebase first).
- Any rapid-change matrix step (8a/8b) fails or becomes flaky — the coalescing must be invisible to the final state; a failure means the pass/dirty-flag interleaving is wrong. Stop and report; do not add delays to make it pass.
- The mock's storage.onChanged delivery ordering makes the three-in-one-tick setup non-deterministic — report; do not add artificial awaits between the writes.

## Maintenance notes
- If `speedSyncTargets` ever returns duplicates, the `Promise.all` would double-sync a tab — keep the Set-based dedup (asserted in the drift check).
- The dirty-flag contract ("one follow-up pass per settled rate") should be restated in the comment above `queueSpeedSync` so future triggers keep using `requestSpeedEverywhere()` rather than raw `syncSpeedEverywhere`.
- Reviewers should scrutinize: no per-tab state (e.g. `boostStartsInFlight`-style sets) is touched concurrently by parallel tab syncs — the speed path holds no such per-tab mutexes today (verify), and R6's guarantee now rests on batch serialization + rev guards (state that in the PR).

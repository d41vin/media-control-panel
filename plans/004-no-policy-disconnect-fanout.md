# Plan 004: Disconnect every page manager when the policy lifts (no-policy transition leaves stale managers)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/background.js test/background-mock.html docs/DESIGN.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (design-drift from a normative invariant)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C4 (last-override-clear never disconnects other tabs' managers, HIGH)

## Why this matters

`docs/DESIGN.md` (Enforcement section, lines 92-94) is normative:
"Disconnected everywhere when no policy remains." The implementation only
disconnects the tab whose override was cleared. When the LAST override clears
while global speed is 1.00×, every OTHER previously managed tab keeps its
live page manager — observers, load-lifecycle listeners, the debounced
MutationObserver — indefinitely, until the next popup open or global-speed
change. Two concrete costs:

1. The idle-footprint promise ("at factory defaults nothing is injected or
   polled") is broken.
2. A lingering manager keeps enforcing/stamping. Its `ratechange` reports are
   still honored (its rev still matches — clearing tab A's override does not
   bump tab B's rev), so a site-set rate on any other tab is adopted as a NEW
   override (R5 semantics applied where the model says no manager should
   exist), re-activating a policy the user just reset. Because teardown never
   runs for those tabs, the stamped `defaultPlaybackRate` also persists —
   new media on those tabs starts at the old inherited rate instead of the
   site's own default.

## Current state

Files and roles:
- `extension/background.js` — the speed-policy authority; `clearOverride` is the single override-removal path.
- `test/background-mock.html` — harness page driving the real background against the mock (right layer for the regression test).
- `docs/DESIGN.md` — normative model; unchanged by this plan (the code comes into line with it).

Excerpts (verified at `f6101d2`):

`extension/background.js:264-274` — the only disconnect sites are
clearOverride's single-tab send and syncSpeedEverywhere's no-policy branch:
```js
async function clearOverride(tabId, resync = true) {
  if (overrides[tabId]) {
    delete overrides[tabId];
    // the override is gone — reports written under it must not resurrect it
    bumpTabRev(tabId);
    await writeOverrides(overrides);
  }
  if (resync && !enforcementNeeded()) {
    await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
  }
}
```

The three callers that can clear the LAST override:
- `mcp-speed-reset` (`:738-746`): `await clearOverride(msg.tabId); if (enforcementNeeded()) await syncSpeedTab(msg.tabId, undefined, false);` — when enforcement is no longer needed, nothing else happens.
- `mcp-speed-report` landing exactly on global (`:696-701`): `await clearOverride(tabId); if (enforcementNeeded()) await sendToTab(…apply…);` — same shape.
- `onCommittedNavigation` (`:964-978`): `await clearOverride(tabId, false); if (enforcementNeeded()) void syncSpeedTab(tabId, url);` — with `resync = false` even the cleared tab gets no disconnect (its document is being replaced anyway; but other tabs are never told).

The fan-out that already exists for other transitions —
`extension/background.js:397-414`:
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

Target enumeration — `speedSyncTargets` (`:378-395`) returns previously
managed tabs plus every open http/https/file tab plus recent/pinned ids;
sending a disconnect to a tab without a manager is a documented no-op
(`sendToTab` at `:256-262` swallows errors).

**Important interaction**: `clearOverride` is also called FROM INSIDE the
queued sync (`rawSyncSpeedTab:311` calls `clearOverride(tabId, false)`). The
fix below must NOT enqueue anything through `queueSpeedSync` from within
`clearOverride` — it would deadlock the chain (a queued item waiting on the
currently-running item). Direct sends are safe in all callers.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|--------------------------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke pass (grows by the new assertions) |
| Full e2e | `npm run e2e` | exit 0; 122/122 |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/background.js` (`clearOverride` only)
- `test/background-mock.html` (regression scenario)
- `README.md` harness count if changed

**Out of scope**:
- `syncSpeedEverywhere`/`speedSyncTargets` semantics (reused as-is).
- The manager (`extension/lib/manager.js`) — its teardown is correct; the bug is that teardown is never requested.
- `scripts/e2e.mjs` — the mock-level assertion is deterministic; e2e already covers the transition's user-visible outcome (reset returns media to global).
- Rev machinery (`bumpTabRev`) — unchanged.

## Git workflow
- Branch: `advisor/004-no-policy-disconnect-fanout`
- Conventional commits (`fix(speed): disconnect every manager when the last override clears`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fan the disconnect out from `clearOverride`
`extension/background.js:264-274` becomes:
```js
async function clearOverride(tabId, resync = true) {
  if (overrides[tabId]) {
    delete overrides[tabId];
    // the override is gone — reports written under it must not resurrect it
    bumpTabRev(tabId);
    await writeOverrides(overrides);
  }
  if (!enforcementNeeded()) {
    // the policy just lifted: EVERY previously managed tab must tear its
    // manager down (DESIGN.md: "Disconnected everywhere when no policy
    // remains") — a lingering manager keeps stamping media and adopting
    // page rates as overrides. Sends are direct, never queued: callers
    // include the queued sync itself, and queueSpeedSync from inside a
    // queued run would deadlock the chain. A disconnect to a tab without
    // a manager is a no-op.
    const targets = await speedSyncTargets();
    for (const tid of targets) {
      await sendToTab(tid, { type: 'mcp-speed-disconnect' });
      noteUnmanaged(tid);
    }
    return;
  }
  if (resync) {
    await syncSpeedTab(tabId, undefined, false);
  }
}
```
Note the second behavior change this folding introduces deliberately: the old
`resync` branch sent only a disconnect message to `tabId`; now, when a policy
is STILL active (the common reset case: global ≠ 1.00×, override cleared),
the caller-owned `syncSpeedTab` in `mcp-speed-reset`/`mcp-speed-report`
already re-applies the policy — so `clearOverride` itself must NOT also
re-sync (that would double-apply). Keep the `resync` parameter but make it a
no-op retention for signature compatibility ONLY if removing it would touch
out-of-scope callers; the minimal change is:

```js
  if (!enforcementNeeded()) {
    const targets = await speedSyncTargets();
    for (const tid of targets) {
      await sendToTab(tid, { type: 'mcp-speed-disconnect' });
      noteUnmanaged(tid);
    }
    return;
  }
```
appended AFTER the existing `if (resync && !enforcementNeeded())` block is
REMOVED — i.e. the single-tab disconnect is subsumed by the fan-out, and the
`resync` parameter becomes unused-but-retained (mark it with a short comment
so a reader knows callers still pass it). Do not re-apply the policy here;
the callers do that when `enforcementNeeded()` is true.

**Verify**: `npm test` → exit 0.

### Step 2: Regression scenario in `test/background-mock.html`
Add a block following the file's existing scenario style (assert helper, mock
tabs, `fireMessage*` sends). Setup:
1. Seed the mock with two injectable tabs A and B.
2. Make the policy active with an override on A only: set
   `chrome.storage.local.set({ speed: 1.5 })` via the mock (the worker's
   storage.onChanged fan-outs managers to A and B — both get
   `installSpeedManager` via the mock's `executeScript`), then deliver a
   page-speed command for A
   (`mock.fireMessage({ type: 'mcp-speed-page', tabId: A, rate: 2 })` from a
   popup-style sender) so `speedOverrides` holds A→2.
3. Return global to 1.00 (`chrome.storage.local.set({ speed: 1 })`) — A keeps
   its override; enforcement remains active because of it.
4. Fire `mock.fireMessage({ type: 'mcp-speed-reset', tabId: A })`.
5. Poll, then assert: `chrome.storage.session.get('speedOverrides')` has no
   entry for A, AND the mock's `sentTabMessages` log contains
   `{ type: 'mcp-speed-disconnect' }` for BOTH A and B (pre-fix, B receives
   none — that absence is the regression being pinned). Also assert
   `chrome.storage.session.get('speedManaged')` empties out.

**Verify**: `npm run harness` → exit 0; the new assertions pass; record the new total count.

### Step 3: Update documented counts + regression gate
- Update the harness count in `README.md` / `docs/RESEARCH.md` if it changed.
- **Verify**: `npm run e2e` → exit 0, 122/122 (the e2e already asserts the user-visible reset outcome; the fan-out must not disturb any existing step — notably "reset-to-global re-applies the global speed" and the managed-tab coverage steps).

## Test plan
- New: the background-mock block in Step 2 (the B-gets-disconnect assertion is the regression pin).
- Existing: all 79 background assertions, the e2e matrix (incl. the managed-tab-stays-governed and full-navigation-cleanup steps) must stay green.

## Done criteria
- [ ] `clearOverride` fans `mcp-speed-disconnect` out over `speedSyncTargets()` exactly when `enforcementNeeded()` turns false, and does not queue from inside the sync chain
- [ ] `npm test` exits 0; `npm run harness` exits 0 with the new scenario; `npm run e2e` exits 0 at 122/122
- [ ] `resync` parameter retained-or-cleaned-up without touching `lib/` files
- [ ] Documented harness counts updated where changed
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions
- The excerpts don't match (drift).
- `clearOverride` turns out to have a caller inside `rawSyncSpeedTab` that relies on the old single-tab disconnect semantics in a way the fan-out breaks (an existing harness assertion fails) — report the exact step; do not reintroduce per-caller special cases without review.
- The mock cannot observe manager disconnects for tab B (e.g. `sentTabMessages` recording changes) — report; do not add new mock transport layers.

## Maintenance notes
- Any future caller of `clearOverride` inherits the fan-out for free; if a caller ever needs "clear without the no-policy fan-out", add an explicit parameter rather than reverting the fan-out.
- Plans 007 (background speed-state hardening) touches `refreshSpeedState` and the retry loop in the same file — sequence it after this plan lands and re-run its drift check.
- Reviewers should scrutinize: no `queueSpeedSync` call inside `clearOverride` (deadlock), and that `noteUnmanaged` runs for every disconnected target.

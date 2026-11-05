# Plan 012: Performance — scan only inserted subtrees, and inject the manager into a committing subframe only

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/lib/manager.js extension/background.js test/background-mock.html plans/002-manager-detached-element-pruning.md plans/010-nested-shadow-roots.md`
> If any in-scope file changed since this plan was written (especially plans
> 002/010 having reshaped `manager.js`), compare the "Current state" excerpts
> against the live code before proceeding; on a mismatch, treat it as a STOP
> condition.

## Status
- **Priority**: P3
- **Effort**: S/M
- **Risk**: LOW (behavior-preserving; missed-element worst case self-heals on the next whole-tab sync)
- **Depends on**: plans/002 and plans/010 (recommended — same functions; land those first)
- **Category**: perf
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: PERF-1 (debounced rescan degenerates to ~5 Hz full-DOM walks, HIGH), PERF-2 (subframe commits re-inject all frames — O(frames²), HIGH)

## Why this matters

Both costs land on the page's own main thread and only while a speed policy
is active — which is exactly the configuration a speed-focused user lives in:

1. **PERF-1**: `scheduleScan` re-arms its 200 ms timer on every mutation batch
   containing any element insertion. On a DOM-churning page (YouTube with
   chat, infinite feeds), that is a full-document walk —
   `document.querySelectorAll('*')` plus a `shadowRoot` check per element —
   every ~200 ms, indefinitely: effective polling (~0.5–1.5 % of a core on a
   multi-thousand-element page) that the README's "no polling" claim is meant
   to exclude. Scanning only the subtrees named in the mutation records does
   the same job for a fraction of the cost.
2. **PERF-2**: every non-top-frame `webNavigation.onCommitted` re-runs the
   whole-tab sync — `executeScript({allFrames: true})` into every frame, in
   both worlds on adapter hosts, plus a whole-map storage write. A watch-page
   load with ~15 subframe commits issues ~15 all-frames injections (hundreds
   of function executions) that are redundant after the first: the manager is
   idempotent and the frames' managers are already current. Injecting into
   the newly committed frame only keeps the same guarantee (the idempotent
   manager + the existing top-level/status/url syncs cover the rest, and a
   missed frame self-heals on the next whole-tab sync).

## Current state

Files and roles:
- `extension/lib/manager.js` — the manager's observer/scan machinery.
- `extension/background.js` — the subframe-commit sync path.
- `test/background-mock.html` — deterministic layer for the frame-scoped injection assertion (the mock records every `executeScript` target).

Excerpts (verified at `f6101d2`):

`extension/lib/manager.js:244-257`:
```js
  const scan = () => {
    for (const el of collect()) attach(el);
  };

  const scheduleScan = (mutations) => {
    // attribute-only mutations (the most frequent kind on busy pages) never
    // trigger a DOM walk — only actual element insertions do
    const added = mutations.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1));
    if (!added || S.scanTimer) return;
    S.scanTimer = setTimeout(() => {
      S.scanTimer = 0;
      scan();
    }, 200);
  };
```
and the full-document walk it triggers — `collect()` at `:98-104` (see plans
002/010 excerpts; after those plans land, `collect()` is the worklist form).

`extension/background.js:931-942` — the subframe branch:
```js
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.tabId < 0) return;
  if (details.frameId === 0) {
    void onCommittedNavigation(details.tabId, details.url, details.documentId);
  } else {
    // a frame's document changed: record it so its manager's reports can be
    // validated against the frame's CURRENT document, and re-sync the tab so
    // a freshly created frame document gets its own manager (idempotent)
    noteFrameCommit(details.tabId, details.frameId, details.url, details.documentId);
    if (enforcementNeeded()) void syncSpeedTab(details.tabId);
  }
});
```
`rawSyncSpeedTab` (`:300-365`) always injects `{ tabId, allFrames: true }`
(`:328-332`), then sends the apply to the tab (`:346`), then optionally runs
the MAIN-world adapter sync all-frames (`:356-360`). Every subframe commit
also writes both doc maps (`persistCommitted` at `:202-208`).

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke |
| Full e2e | `npm run e2e` | exit 0; current total (the frame-host step is the live guard) |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/lib/manager.js` (`scheduleScan`/`scan` — subtree scan)
- `extension/background.js` (frame-scoped variant of the subframe sync)
- `test/background-mock.html` (assertion: subframe commit → frame-scoped target)
- `README.md` counts if changed

**Out of scope**:
- The debounce duration (200 ms) and the observer options — unchanged.
- `syncSpeedEverywhere`/global fan-out parallelization (plans/013).
- The nested-root walk shape (plans/010) — composed, not rewritten.
- `persistCommitted` write-deduplication (optional in the original finding — skip; the session store is RAM-backed and user-paced commits make the write volume acceptable; note as deliberately deferred).

## Git workflow
- Branch: `advisor/012-scan-subtree-frame-scoped`
- Conventional commits (`perf(media): scan inserted subtrees only`, `perf(speed): frame-scoped sync on subframe commits`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (PERF-1): Scan the mutated subtrees
In `extension/lib/manager.js`, thread the mutation records into the scan:
```js
  const scan = (roots) => {
    // subtree scan: walk only what the mutations inserted (the initial
    // install still walks the whole document). A host whose shadow root
    // gains media is found because its HOST element is one of the inserted
    // nodes; media added INSIDE an existing open root is reached via the
    // root walk below.
    if (!roots) {
      for (const el of collect()) attach(el);
      return;
    }
    for (const root of roots) {
      for (const el of root.querySelectorAll('video, audio')) attach(el);
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          for (const m of el.shadowRoot.querySelectorAll('video, audio')) attach(m);
        }
      }
    }
  };

  const scheduleScan = (mutations) => {
    const addedNodes = [];
    for (const m of mutations) {
      for (const n of m.addedNodes) if (n.nodeType === 1) addedNodes.push(n);
    }
    if (!addedNodes.length || S.scanTimer) return;
    S.pendingRoots = S.pendingRoots ?? new Set();
    for (const n of addedNodes) {
      S.pendingRoots.add(n.getRootNode()); // document or an open shadow root
      if (n.shadowRoot) S.pendingRoots.add(n.shadowRoot);
    }
    S.scanTimer = setTimeout(() => {
      S.scanTimer = 0;
      const roots = [...S.pendingRoots];
      S.pendingRoots = null;
      scan(roots);
    }, 200);
  };
```
Semantics to preserve: an inserted SUBTREE still gets fully scanned (the
added node IS a root — `root.querySelectorAll` walks its descendants);
elements added inside an existing open shadow root are found via
`getRootNode()`; the initial `scan()` call at install keeps the full walk.
`getRootNode()` on a node in a CLOSED root returns the closed root object
from the ISOLATED world? — it does not: closed roots are inaccessible and
`getRootNode()` returns the host's outer document boundary for the isolated
world in practice; the function must simply not throw. Add a defensive
`try`/`catch`-free design: `querySelectorAll` on whatever `getRootNode()`
returned is safe for Document/ShadowRoot/DocumentFragment; a closed root is
never returned to the isolated world (the node would not be reachable at
all), so no guard is needed — but if the executor observes otherwise, treat
it as a STOP condition.

**Verify**: `npm test` → exit 0 (the drift guard from plans/008 still matches — this plan edits `scheduleScan`/`scan`, NOT the inlined collection blocks; if the guard complains, reconcile with plans/010's canonical text).

### Step 2 (PERF-2): Frame-scoped subframe sync
In `extension/background.js`, split a frame-scoped variant out of
`rawSyncSpeedTab` (factor the injection block, or add a small function):
```js
/** Subframe commit: install/update the manager in THAT frame only — the
    other frames' managers are current, and a whole-tab sync per subframe
    commit is O(frames²) during page load. A missed frame self-heals on the
    next whole-tab sync (top-level commits, status complete, url changes). */
async function syncSpeedFrame(tabId, frameId, pageUrl) {
  await ensureSpeedState();
  if (!enforcementNeeded()) return;
  const rate = effectiveRate(tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: installSpeedManager,
      args: [{ rate, adoptForeign: true, rev: revOf(tabId) }],
    });
    noteManaged(tabId);
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!/Cannot access contents|No tab with id|Frame with ID|cannot be scripted/.test(msg)) {
      void syncSpeedTab(tabId, pageUrl); // transient: fall back to the whole-tab path
    }
  }
}
```
and the subframe branch becomes:
```js
    noteFrameCommit(details.tabId, details.frameId, details.url, details.documentId);
    if (enforcementNeeded()) void syncSpeedFrame(details.tabId, details.frameId, details.url);
```
Deliberately NOT carried over: the per-frame MAIN-world adapter sync (the
whole-tab syncs still run it; the manager's ISOLATED-world enforcement is
what matters per frame) and the apply message (the freshly installed manager
holds the current rate by construction). Retry semantics: the frame-scoped
path falls back to one whole-tab sync on transient errors instead of a bare
retry — simpler and self-healing.

**Verify**: `npm test` → exit 0.

### Step 3: Mock assertion for the frame-scoped target
In `test/background-mock.html`, extend an existing frame-commit scenario (or
add one): with a policy active, `mock.fireFrameCommitted(tabId, 3, url, docId)`
and assert the newest `scriptingCalls` entry for `installSpeedManager` has
`target.frameIds` equal to `[3]` (not `allFrames: true`). Also assert the
existing whole-tab triggers (top-level commit via `fireCommitted`, status
complete via `fireUpdated`) still target `allFrames`.

**Verify**: `npm run harness` → exit 0; totals recorded.

### Step 4: Regression gate
The e2e frame-host fixture (same-origin iframe with its own media) is the
live guard for Step 2: its existing steps must pass unchanged.
**Verify**: `npm run e2e` → exit 0 at the current total. Update documented counts only if the mock count grew.

## Test plan
- New (background-mock): the frame-scoped-target assertion (Step 3).
- Existing: the frame-host e2e steps, the silent-tab dynamic-insertion step (exercises observer-driven scans — now subtree-scanned), and the whole speed matrix must stay green.

## Done criteria
- [ ] `scheduleScan` collects added nodes and scans their root subtrees only; the install-time `scan()` still walks the whole document
- [ ] Subframe commits inject into the committed `frameId` only; transient errors fall back to one whole-tab sync; permanent errors are silent
- [ ] The mock asserts the frame-scoped target; `npm test`/`npm run harness`/`npm run e2e` all exit 0
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The excerpts don't match, or plans 002/010 have not landed and the compose is unclear — land those first (dependency).
- Any e2e step that relies on whole-tab injection after a subframe commit fails (e.g. media in a DIFFERENT frame getting the policy via the subframe path) — the fallback contract is "whole-tab syncs cover the rest"; if a real gap appears, report instead of re-broadening the injection.
- `getRootNode()` inside the isolated world returns an object whose `querySelectorAll` throws on any fixture — stop and report (the design assumption is wrong).

## Maintenance notes
- The subtree scan slightly changes what a single debounce tick covers (roots accumulate in `S.pendingRoots` across batches within the window) — that is intentional and bounded.
- If `persistCommitted` write-deduplication is wanted later, it composes cleanly (per-frame unchanged detection); deliberately deferred here.
- Reviewers should scrutinize: media inserted directly into an open shadow root (host not re-inserted) is still found via `getRootNode()`, and that the frame-scoped path cannot double-report via `noteManaged` (idempotent).

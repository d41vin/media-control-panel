# Plan 007: Background speed-state synchronization hardening — load-once caches, retry ownership, recent-list serialization, report clamping

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/background.js extension/lib/speed.js test/mock-chrome.js test/background-mock.html plans/004-no-policy-disconnect-fanout.md`
> If any in-scope file changed since this plan was written (including plan 004
> having landed), compare the "Current state" excerpts against the live code
> before proceeding; on a mismatch, treat it as a STOP condition.

## Status
- **Priority**: P2
- **Effort**: S/M
- **Risk**: MED (the retry change touches the sync chain; tests must gate it)
- **Depends on**: plans/004 (same file, `clearOverride` reshaped — land it first and re-run this drift check)
- **Category**: bug (four small background-state races + one hardening)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C8 (refreshSpeedState clobber, MED), C9 (retry can install a ghost manager, MED), C16 (recent-list RMW race, LOW), C17 (clamp page-reported rates + fmtSpeed(0) quirk, LOW hardening), T5-retry (retry branch untested, HIGH)

## Why this matters

Four narrow but real background-state defects, grouped because they live in
one file and share the same verification layer (background-mock):

1. **C8** — `refreshSpeedState()` wholesale-assigns the worker-owned caches
   (`overrides`, `tabRevs`, `committedDocs`, `frameDocs`) from storage
   snapshots. It runs on EVERY popup open (`mcp-speed-sync`), while the
   storage.onChanged listener deliberately refuses to re-read own writes
   ("re-reading own writes lets a slow earlier write regress the cache") and
   merges `speedRevs` monotonically for the same reason. A page report that
   mutates the in-memory maps while the popup-open refresh's six storage
   reads are in flight gets clobbered by the stale snapshot — a regressed rev
   then makes `msg.rev !== revOf(tabId)` accept superseded reports.
2. **C9** — the injection retry (150 ms sleep) reuses the rate computed
   before the sleep while re-reading only the rev. A reset (or last-override
   clear) landing inside the window tears the old manager down and the retry
   then installs a fresh manager holding the stale rate with the CURRENT rev
   — its reports are honored, the just-reset rate resurrects, and nothing
   re-syncs it because enforcement is no longer needed.
3. **C16** — `noteRecent`/`pruneRecent` are unserialized get→filter→set; two
   tabs going audible in one tick (or an audible event racing a tab close)
   read the same base list and the second write drops the first tab.
4. **C17** — `mcp-speed-report` validates only `Number.isFinite(rate)` while
   the popup-sourced `mcp-speed-page` clamps. Reports originate from
   `report(el.playbackRate)` (platform-bounded), so this is hardening for
   symmetry — but it also fixes a real display quirk: a 0-rate override
   (element `playbackRate = 0` is legal) is stored raw and `fmtSpeed(0)`
   displays "1.00×" while the media is frozen.

## Current state

Files and roles:
- `extension/background.js` — all four fix sites.
- `extension/lib/speed.js` — `clampSpeed` (the clamp to reuse; preserve exact rates per rule 8 of its header — clamp the range, never snap to the grid).
- `test/mock-chrome.js` — mock; needs a transient-failure hook for the retry test.
- `test/background-mock.html` — the deterministic test layer for all four.

Excerpts (verified at `f6101d2`):

C8 — `extension/background.js:168-185`:
```js
async function refreshSpeedState() {
  const [g, o, m, r, c, f] = await Promise.all([
    loadGlobalSpeed(),
    loadOverrides(),
    chrome.storage.session.get('speedManaged').catch(() => ({})),
    chrome.storage.session.get('speedRevs').catch(() => ({})),
    chrome.storage.session.get('speedCommitted').catch(() => ({})),
    chrome.storage.session.get('speedFrameDocs').catch(() => ({})),
  ]);
  globalSpeed = g;
  overrides = o && typeof o === 'object' ? o : {};
  managedTabs = new Set(
    Array.isArray(m.speedManaged) ? m.speedManaged.filter((n) => typeof n === 'number') : [],
  );
  tabRevs = r.speedRevs && typeof r.speedRevs === 'object' ? r.speedRevs : {};
  committedDocs = c.speedCommitted && typeof c.speedCommitted === 'object' ? c.speedCommitted : {};
  frameDocs = f.speedFrameDocs && typeof f.speedFrameDocs === 'object' ? f.speedFrameDocs : {};
}
```
called on every popup open — `:747-753`:
```js
    case 'mcp-speed-sync': {
      // popup open (or install): reconcile every candidate tab once, and
      // check the boost pipeline's existence against the session truth
      await refreshSpeedState();
      await syncSpeedEverywhere();
      await reconcileBoosts();
      return;
    }
```
The monotonic-merge precedent — `:1024-1030`:
```js
  if (area === 'session' && changes.speedRevs && typeof changes.speedRevs.newValue === 'object') {
    for (const [tabId, rev] of Object.entries(changes.speedRevs.newValue)) {
      if (typeof rev === 'number' && rev > (tabRevs[Number(tabId)] ?? 0)) {
        tabRevs[Number(tabId)] = rev; // monotonic per tab, never moved back
      }
    }
  }
```

C9 — the retry loop, `extension/background.js:319-343` (rate computed once at `:319`, rev re-read per attempt at `:331`):
```js
  const rate = effectiveRate(tabId);
  // executeScript fails intermittently on busy tabs (frame not ready, tab
  // mid-navigation). A swallowed failure strands the manager on a stale
  // expectation with nothing left to re-trigger the sync, so retry once —
  // but not for permanently-uninjectable pages (chrome://, extension pages),
  // where a retry is pure noise.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // all frames: media can live in embeds; installSpeedManager is idempotent
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: installSpeedManager,
        args: [{ rate, adoptForeign, rev: revOf(tabId) }],
      });
      break;
    } catch (e) {
      const msg = String(e?.message ?? e);
      if (attempt === 0 && !/Cannot access contents|No tab with id|Frame with ID|cannot be scripted/.test(msg)) {
        console.warn('MCPDBG speed inject retry:', msg.slice(0, 120));
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      return; // uninjectable tab (chrome://, discarded) — nothing to manage
    }
  }
```

C16 — `extension/background.js:57-77`:
```js
async function noteRecent(tabId) {
  if (!recentEnabled) return;
  try {
    const { recent } = await chrome.storage.session.get('recent');
    const next = [tabId, ...((recent ?? []).filter((id) => id !== tabId))].slice(0, RECENT_MAX);
    await chrome.storage.session.set({ recent: next });
  } catch {
    // storage unavailable; the popup just won't show paused media
  }
}

async function pruneRecent(tabId) {
  try {
    const { recent } = await chrome.storage.session.get('recent');
    if (Array.isArray(recent) && recent.includes(tabId)) {
      await chrome.storage.session.set({ recent: recent.filter((id) => id !== tabId) });
    }
  } catch {
    // nothing to do
  }
}
```

C17 — the report write, `extension/background.js:703-710`:
```js
        overrides[tabId] = {
          url,
          documentId: committed?.documentId ?? sender.documentId,
          rate: msg.rate,
          at: Date.now(),
        };
```
versus the clamped popup path `:725-731` (`rate: clampSpeed(rate)`), and the
clamp to reuse — `extension/lib/speed.js:32-35`:
```js
export function clampSpeed(rate) {
  if (!Number.isFinite(rate)) return SPEED_DEFAULT;
  return Math.min(SPEED_MAX, Math.max(SPEED_MIN, rate));
}
```

The mock's executeScript — `test/mock-chrome.js:304-338` — fails only for
unknown tabs, non-injectable tabs, or `frameId` misuse; there is no
transient-failure hook (that is the T5 gap).

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke (grows) |
| Full e2e | `npm run e2e` | exit 0; 122/122 |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/background.js` (the four sites)
- `test/mock-chrome.js` (one hook: transient executeScript failure)
- `test/background-mock.html` (four regression blocks)
- `README.md` harness count if changed

**Out of scope**:
- `extension/lib/manager.js` and `extension/lib/speed.js` (import/use only; plans 002/010 own manager edits).
- `scripts/e2e.mjs` (mock-level tests are deterministic; e2e stays the final gate).
- The boost machinery (plans/001).
- The popup's pending-page-speed logic (plans/006).
- The `MCPDBG` console.warn (plans/018 owns the convention note).

## Git workflow
- Branch: `advisor/007-background-sync-hardening`
- Conventional commits per fix (`fix(speed): load-once policy caches`, `fix(speed): injection retry re-reads the policy`, `fix(media): serialize the recent list`, `fix(speed): clamp adopted report rates`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (C8): Load-once semantics for the worker-owned caches
Guard `refreshSpeedState` so a warm worker never regresses its caches:
```js
let speedStateLoaded = false;
async function refreshSpeedState() {
  if (speedStateLoaded) return; // load-once per worker life: the worker is
  // the sole writer of these maps, and re-reading own (possibly slower)
  // writes would regress newer in-memory state — the exact hazard the
  // storage.onChanged comments forbid. Storage remains the restart source.
  const [g, o, m, r, c, f] = await Promise.all([ /* existing six reads, unchanged */ ]);
  globalSpeed = g;
  overrides = o && typeof o === 'object' ? o : {};
  managedTabs = new Set(/* unchanged */);
  tabRevs = /* unchanged wholesale assign on the ONE cold load */;
  committedDocs = /* unchanged */;
  frameDocs = /* unchanged */;
  speedStateLoaded = true;
}
```
Keep the single cold-load assignment wholesale (that is the restart-recovery
path B5-style: storage is the truth when the worker wakes fresh). The
monotonic `speedRevs` merge in storage.onChanged stays as-is. `mcp-speed-sync`
keeps calling `refreshSpeedState()` — it becomes a cheap no-op when warm,
preserving the popup-open reconcile intent.

**Verify**: `npm test` → exit 0.

### Step 2 (C9): The retry re-reads the policy and re-checks enforcement
Move the rate/enforcement computation inside the loop:
```js
  for (let attempt = 0; attempt < 2; attempt++) {
    // re-read per attempt: a reset or last-override clear can land inside
    // the retry sleep — a stale rate with a fresh rev would install a ghost
    // manager that resurrects the reset choice
    if (!enforcementNeeded()) {
      await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
      noteUnmanaged(tabId);
      return;
    }
    const rate = effectiveRate(tabId);
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: installSpeedManager,
        args: [{ rate, adoptForeign, rev: revOf(tabId) }],
      });
      break;
    } catch (e) {
      /* unchanged classification, sleep, and give-up path */
    }
  }
```
Keep the error-classification regex and the 150 ms sleep exactly as they are.
Note `clearOverride`'s disconnect handling already covers the no-policy
transition after plans/004; the in-loop re-check here closes the window
between the sleep and the install.

**Verify**: `npm test` → exit 0.

### Step 3 (C16): Serialize the recent list
```js
let recentChain = Promise.resolve();
function mutateRecent(fn) {
  // read-modify-write under one chain: two tabs going audible in the same
  // tick (or an audible event racing a tab close) must not drop entries
  const run = recentChain.then(fn);
  recentChain = run.catch(() => {});
  return run;
}
```
Route both bodies through it:
```js
async function noteRecent(tabId) {
  if (!recentEnabled) return;
  await mutateRecent(async () => { /* existing get→merge→set body */ });
}
async function pruneRecent(tabId) {
  await mutateRecent(async () => { /* existing get→filter→set body */ });
}
```
Callers already `void` these — no await-side changes needed.

**Verify**: `npm test` → exit 0.

### Step 4 (C17): Clamp adopted report rates
In the `mcp-speed-report` adoption branch (`:703-710`) change `rate: msg.rate` to `rate: clampSpeed(msg.rate)` and mirror it in the apply sent right after (`sendToTab(… { type: 'mcp-speed-apply', rate: clampSpeed(msg.rate), … })`) so the manager's expectation equals the stored value. The `near(msg.rate, globalSpeed)` inheritance check above stays on the RAW value first, then uses the clamped value for storage — spec precisely:
```js
      const rate = clampSpeed(msg.rate);
      if (near(rate, globalSpeed)) { /* existing inheritance path, using `rate` */ }
      else { overrides[tabId] = { …, rate, … }; /* apply with `rate` */ }
```
(Rule 8 of `lib/speed.js` — website-exact rates preserved — is respected:
clampSpeed clamps the range only, never snaps.)

**Verify**: `npm test` → exit 0.

### Step 5 (T5): Transient-failure hook + four regression blocks in the background mock
1. `test/mock-chrome.js`: add to `_mock`:
```js
      /** Fail the next executeScript for this tab with this error (once). */
      failNextExecuteScript(tabId, message) {
        this._failOnce = { tabId, message };
      },
```
and at the top of the mock's `executeScript` (after the tab/injectable checks, before running): if `this._failOnce?.tabId === target.tabId`, consume it and `throw new Error(this._failOnce.message)`.
2. `test/background-mock.html` blocks:
   - **Retry re-check (C9)**: active policy (global 1.5) on injectable tab; `mock._mock.failNextExecuteScript(tab, 'busy tab')`; then set global to 1.0 *and* deliver `mcp-speed-reset` for the tab inside the 150 ms window (deterministically: issue the reset via `fireMessage` immediately after the failing sync is triggered). Assert: no `installSpeedManager` call lands after the reset (inspect `scriptingCalls` — the second attempt must be the disconnect/no-manager path, not an install with the stale 1.5 rate), and `sentTabMessages` carries the disconnect.
   - **Load-once (C8)**: with the worker warm (post-startup), capture `tabRevs` via storage; deliver a `mcp-speed-report` from a tab sender that bumps the rev; then trigger `mock.fireMessage({ type: 'mcp-speed-sync' })`; assert the rev did NOT regress and the override survived (pre-fix the wholesale refresh could drop it).
   - **Recent serialization (C16)**: fire `audible: true` `fireUpdated` for two tabs in the same tick; poll and assert both ids are in `chrome.storage.session.get('recent')`.
   - **Report clamp (C17)**: deliver `mcp-speed-report` with `rate: 0` from a tab sender under an active policy; assert the stored override is `0.25` (SPEED_MIN) and the apply message carried `0.25` (not `0`).
3. Wire counts; run.

**Verify**: `npm run harness` → exit 0 with the four new blocks; record totals.

### Step 6: Counts + regression gate
Update documented harness counts; **Verify**: `npm run e2e` → exit 0, 122/122 (the speed matrix exercises the retry path indirectly — a regression here fails loudly).

## Test plan
- New (background-mock): retry-ownership, load-once caches, recent serialization, report clamp — each pins one fix.
- Existing: full harness + e2e green; especially the "rapid global changes never restore an obsolete value" and frame-provenance matrix steps.

## Done criteria
- [ ] `refreshSpeedState` is load-once per worker life; the cold-load assignment and the storage.onChanged merge are unchanged
- [ ] The retry loop re-checks `enforcementNeeded()` and recomputes rate/rev per attempt; classification regex untouched
- [ ] `noteRecent`/`pruneRecent` run under one promise chain
- [ ] Report rates are clamped in both the storage write and the apply message
- [ ] The four new background-mock blocks pass; `npm test`/`npm run harness`/`npm run e2e` all exit 0
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The excerpts don't match, or plans/004 has NOT landed (this plan re-bases its drift check on it).
- The C9 in-loop re-check breaks an existing matrix step (rapid-change steps depend on the queue's ordering; the re-check must be invisible when the policy is stable) — report the failing step.
- The mock hook cannot make the retry window deterministic after two attempts — report; do not introduce real timers shorter than 50 ms into the mock.

## Maintenance notes
- If plans/013 later parallelizes the global fan-out, the per-tab re-check from this plan remains valid (each tab's sync still re-reads live state).
- The load-once flag must be reset nowhere except worker death; if a future feature legitimately mutates these stores from another context, revisit — today the worker is the sole writer by design (storage.onChanged comments).
- Reviewers should scrutinize: `clampSpeed` in the report path must NOT snap to the grid (rule 8), and the inheritance check ordering (raw vs clamped) matches the spec in Step 4.

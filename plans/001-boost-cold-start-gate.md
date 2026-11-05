# Plan 001: Gate boost message handling on the startup boost-state load (cold worker can kill other tabs' live pipelines)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/background.js test/background-mock.html test/mock-chrome.js scripts/harness.mjs`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P1
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C1 (boost cold-start race, HIGH), T2 (worker cold-start/restart tests untested, HIGH)

## Why this matters

The MV3 service worker sleeps ~30 s after its last event. The offscreen audio
document outlives worker sleeps by design (DESIGN.md B5), so boost events
genuinely wake a **cold** worker. On wake, the module evaluates, the startup
IIFE begins, and event handlers can run **before** `refreshBoosts()` (the
fourth `await` in the IIFE) has loaded the persisted boost state — the handler
then reads the module default `let boosts = {}`.

In that window every boost handler acts on the empty map:

- `mcp-boost-ended` does `delete boosts[tabId]` (no-op), then `writeBoosts()`
  persists `{}` — **wiping every other tab's persisted boost entry** — then
  `closeOffscreenIfIdle()` sees no boosts and **closes the offscreen document,
  killing another tab's live capture pipeline** (its audio drops the boost).
- A cold `mcp-speed-*`-style race cannot happen for speed because
  `routeMessage` already gates `mcp-speed-*` on `ensureSpeedState()` — but
  there is no equivalent gate for boosts.
- A cold `mcp-boost-gain` writes the in-memory map (only the one tab) over
  storage, which can leave a *running* pipeline with no state entry — the
  popup then shows 100 % for a tab that is actually captured (unboostable
  from the UI until browser restart).

Concrete user scenario: two tabs boosted, tab A's stream ends (or A is
closed) while the worker is asleep → B's boost dies and B's session entry is
wiped. This is exactly the class of "state must be truthful / a stop must
never tear down a restarted pipeline" bug the codebase already fights
elsewhere with request ids; the missing piece is the startup load gate.

## Current state

Files and roles:
- `extension/background.js` — service worker; owns badge, speed policy, boost routing.
- `test/mock-chrome.js` — in-memory `chrome.*` mock; `installMockChrome({ sessionSeed })` seeds `storage.session` (line 131, `const session = new Map(Object.entries(sessionSeed))`).
- `test/background-mock.html` — harness page: imports the real `background.js` + `offscreen.js` once against the mock, asserts 79 scenarios.
- `scripts/harness.mjs` — runner that loads mock pages in headless Chrome and fails on page errors / failed titles.

Excerpts (verified at `f6101d2`):

`extension/background.js:668-671` — the gate exists only for speed:
```js
async function routeMessage(msg, sender) {
  // policy commands and reports never race the startup state load
  if (msg.type.startsWith('mcp-speed-')) await ensureSpeedState();
  switch (msg.type) {
```

`extension/background.js:445` — cold default:
```js
let boosts = {}; // tabId -> { gain, state: 'pending' | 'active' | 'error', error? }
```

`extension/background.js:456-463` — the loader:
```js
async function refreshBoosts() {
  try {
    const { boosts: b } = await chrome.storage.session.get('boosts');
    boosts = b && typeof b === 'object' ? b : {};
  } catch {
    boosts = {};
  }
}
```

`extension/background.js:883-893` — one of the unguarded handlers:
```js
    case 'mcp-boost-ended': {
      // the stream ended on its own (tab closed, capture killed) — the state
      // must tell the truth, so the entry goes immediately
      if (typeof msg.tabId !== 'number') return;
      clearBoostTimer(msg.tabId);
      boostReqs.delete(msg.tabId);
      releaseBoostStart(msg.tabId);
      delete boosts[msg.tabId];
      await writeBoosts();
      await withOffscreenGate(closeOffscreenIfIdle);
      return;
    }
```

`extension/background.js:1044-1051` — `refreshBoosts()` runs only as the
third await of the startup IIFE:
```js
void (async () => {
  await refreshSettings();
  await ensureSpeedState();
  await refreshBoosts();
  await reconcileBoosts(true); // a fresh worker: no startup can be in flight
  await updateBadge();
  if (enforcementNeeded()) void syncSpeedEverywhere();
})();
```

Also relevant: `stopBoostForTab` (`background.js:629-646`) reads `boosts` and
is called from event paths (`onTabGone`, `mcp-boost-stop`) that do not go
through `routeMessage`'s speed gate; `writeBoosts` (`:465-471`) persists the
whole in-memory map; `closeOffscreenIfIdle` (`:568-579`) computes `busy` from
`Object.values(boosts)`.

The speed-side precedent to mirror — `ensureSpeedState`
(`background.js:192-200`):
```js
let speedStateReady = null;
function ensureSpeedState() {
  if (!speedStateReady) {
    speedStateReady = refreshSpeedState().catch(() => {
      speedStateReady = null; // retry on the next event
    });
  }
  return speedStateReady;
}
```

Conventions to follow: catches swallow with an explanatory comment (see any
handler in `background.js`); no new dependencies; match the existing
section-comment style.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|--------------------------------------|
| Static checks | `npm test` | exit 0, "all checks passed" (23 checks) |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke pass |
| Full e2e (regression gate at the end) | `npm run e2e` | exit 0; 122/122 in Chrome (headless capture branch) |
| Local fixture server (started by the rigs themselves) | `npm run serve` | serves repo at http://localhost:8080 |

The rigs use an isolated temp profile, auto-detect Chrome (MCP_BROWSER=edge
forces Edge), and refuse to run if a zombie browser holds their debug port.

## Scope

**In scope** (the only files you should modify):
- `extension/background.js`
- `test/background-mock.html` (new cold-start/restart scenario blocks)
- `test/mock-chrome.js` (only if a tiny hook is needed for the new scenario — see Step 3 note)
- `scripts/harness.mjs` (only the assertion-count/log expectations if the new page changes them — see Step 3)

**Out of scope** (do NOT touch, even though they look related):
- `extension/offscreen.js` — its request-id/stop semantics are correct; the bug is worker-side only.
- `extension/popup.js` — the popup reads storage truth; no popup change needed.
- Any change to message type names or storage key names (`boosts`, `speedRevs`, …) — external contract.
- The e2e suite (`scripts/e2e.mjs`) — a real service-worker restart smoke is explicitly deferred (see Maintenance notes).

## Git workflow
- Branch: `advisor/001-boost-cold-start-gate`
- Commit per step, conventional style matching the repo (`fix(boost): …`, `test(harness): …`); body lines explaining the why.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add a boost-state startup gate, mirroring `ensureSpeedState`
In `extension/background.js`, directly above `refreshBoosts` (≈ line 456), add:

```js
// Boost handlers must never act on the module default (empty) map: the
// offscreen document outlives worker sleeps, so boost messages wake a COLD
// worker whose persisted state has not loaded yet. Every boost decision
// awaits this gate, exactly like the speed policy's ensureSpeedState.
let boostStateReady = null;
function ensureBoostState() {
  if (!boostStateReady) {
    boostStateReady = refreshBoosts().catch(() => {
      boostStateReady = null; // retry on the next event
    });
  }
  return boostStateReady;
}
```

Then:
- In `routeMessage` (line ~669), change the gate line to:
  `if (msg.type.startsWith('mcp-speed-')) await ensureSpeedState();`
  `if (msg.type.startsWith('mcp-boost-')) await ensureBoostState();`
- In `stopBoostForTab` (line ~629), add `await ensureBoostState();` as its first statement.
- In `onTabGone` (line ~986), add `await ensureBoostState();` before the boost branch (`if (boosts[tabId] || boostStartsInFlight.has(tabId))`).
- In the startup IIFE (line ~1047), replace `await refreshBoosts();` with
  `await ensureBoostState();` (same load, now shared/cached).

**Verify**: `npm test` → exit 0 ("all checks passed").

### Step 2: Sanity-run the existing suites
**Verify**: `npm run harness` → exit 0, all existing background assertions still pass (the gate must not change any warm-start behavior; ordering is unchanged once state is loaded).

### Step 3: Add the cold-start + restart regression scenarios to the background mock
`test/background-mock.html` imports the real `background.js` once, so a fresh
worker life needs a fresh page. Add a second harness page,
`test/background-restart.html`, modeled on `background-mock.html`'s structure
(same `installMockChrome` import pattern, same `extBase` manifest probe, same
`assert(name, cond)` helper style that appends `.pass`/`.fail` divs and sets
`document.title` to `PASS (n) — …` / `FAILED (n) — …` so the runner picks it
up). It takes its scenario from the query string.

Scenario A (`?scenario=cold-race`) — the C1 regression test:
1. `installMockChrome({ sessionSeed: { boosts: { 7: { gain: 250, state: 'active' }, 8: { gain: 150, state: 'pending' } } } })`.
2. Seed a live offscreen document: `chrome.offscreen._created = 1;` before importing background.js (the mock's `getContexts` counts `_created > _closed`).
3. Import `background.js` (this starts the startup IIFE), then **immediately**
   `mock.fireMessage({ type: 'mcp-boost-ended', tabId: 8 })` — firing before
   the IIFE's awaits complete, i.e. in the cold-start window.
4. Await convergence (poll `chrome.storage.session.get('boosts')` until it contains tab 8's terminal state), then assert:
   - tab 7's entry is still `{ gain: 250, state: 'active' }` (not wiped by the ended-handler's `writeBoosts`),
   - tab 8's entry is gone or terminal, never resurrected,
   - `chrome.offscreen._closed` stays `0` for at least one tick after convergence **or** the close only happens after tab 7 is gone — assert precisely: with tab 7 active, `closeOffscreenIfIdle` must NOT have closed the document (`_closed === 0` while tab 7 is active).

Scenario B (`?scenario=restart-reconcile`) — the T2 reconcileBoosts(true) test:
1. Same seeding, two variants by query (`&doc=1` / `&doc=0`) controlling `chrome.offscreen._created`:
   - With a live document (`doc=1`): after startup, tab 7 stays `active`, tab 8 (pending, orphaned by definition on a fresh worker) converges to `{ state: 'error', error: 'Capture did not start' }`.
   - Without a document (`doc=0`): after startup, `boosts` converges to `{}` (B5: nothing survives pretending capture was restored).
2. Use a fresh page instance per variant (the harness can open the page twice with different query strings).

If the mock needs a hook to make one deterministic ordering possible (e.g.
holding the IIFE's `refreshSettings` so the fired message provably lands
inside the cold window), add the smallest possible knob to
`test/mock-chrome.js` `_mock` (like the existing `gateCapture` /
`gateOffscreenCreate` gates) — nothing that changes default behavior.

Then add the new page(s) to `scripts/harness.mjs`: replicate the
background-mock runner block (createTarget → attach → Runtime.enable →
`waitFor` on `document.title` matching `/^(PASS|FAILED) \(/`) for
`/test/background-restart.html?scenario=cold-race` and both restart variants.
Keep the progress-title pattern so failures surface page errors.

**Verify**: `npm run harness` → exit 0; output shows the new pages PASS (the exact total count will now exceed 79 — record the new number in the plan's final report and update `README.md`'s harness count ONLY if the plan's final step instructs it; see Step 4).

### Step 4: Update the documented harness count
`README.md` (Testing section, "npm run harness" row and the Architecture
section mention) documents "79 background assertions". After Step 3 the number
grows. Update the count in `README.md` to the actual new total, and the same
figure wherever `docs/RESEARCH.md` "Current state" lists it.

**Verify**: `grep -rn "79 background\|79 assertions" README.md docs/RESEARCH.md` → returns no stale occurrences (or only intentional historical mentions clearly marked as historical).

### Step 5: Full regression gate
**Verify**: `npm run e2e` → exit 0, 122/122 (headless capture-refusal branch is expected; active-capture assertions are covered by plan 015).

## Test plan
- New tests live in `test/background-restart.html` (scenario A = the C1 regression: a cold `mcp-boost-ended` must not wipe tab 7's entry or close the document while tab 7 is active; scenario B = T2 restart reconciliation both ways).
- Structural pattern: model on `test/background-mock.html`'s assert/`document.title` conventions (same runner contract).
- Existing suites are the regression gate: `npm test`, `npm run harness`, `npm run e2e` all exit 0.

## Done criteria
- [ ] `git diff f6101d2..HEAD -- extension/background.js` shows the `ensureBoostState` gate awaited in `routeMessage` (boost types), `stopBoostForTab`, `onTabGone`, and used by the startup IIFE
- [ ] `npm test` exits 0
- [ ] `npm run harness` exits 0 including the new `background-restart.html` scenarios (cold-race, restart-reconcile ×2)
- [ ] `npm run e2e` exits 0 with 122/122
- [ ] No files outside the in-scope list modified (`git status --short`)
- [ ] `plans/README.md` status row updated

## STOP conditions
Stop and report if:
- The code at the excerpted locations does not match (drift since `f6101d2`).
- Adding the gate breaks an existing harness assertion — do NOT weaken the assertion to make it pass; report the failing assertion name and the interleaving you observe.
- The mock's single-context `sendMessage` semantics make the cold-race scenario non-deterministic after two tuning attempts (report instead of inventing a new mocking layer).
- You find yourself needing to change `offscreen.js` or message type names.

## Maintenance notes
- The gate is load-once per worker life; `refreshSpeedState`/`ensureSpeedState` remain the speed-side equivalent — keep the two symmetric when touching either (plan 007 changes `refreshSpeedState`'s assignment semantics; its load-once change must not disturb this gate).
- If a real service-worker-restart e2e smoke is wanted later (CDP
  `ServiceWorker.stopAllWorkers` + assert active boost survives / pending
  converges), it builds on this plan's restart scenarios — record it in the
  plan index rather than growing this plan.
- Reviewers should scrutinize: the gate must be awaited BEFORE any read of
  `boosts`, `boostReqs`, `boostStartsInFlight`-adjacent persisted state in
  every new future boost handler.

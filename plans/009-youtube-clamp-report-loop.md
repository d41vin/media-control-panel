# Plan 009: Stop the YouTube clamp-restore loop — the MAIN-world rate restore must not be reported as a page choice

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/lib/adapters.js extension/lib/manager.js test/player-sync.html scripts/e2e.mjs README.md docs/DESIGN.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P2
- **Effort**: S/M
- **Risk**: MED (touches the echo/report boundary; a wrong suppression could swallow genuine native choices — R5. Tests must gate both directions.)
- **Depends on**: plans/008 (soft — its drift guard and message contract make the cross-file change safe; re-run this plan's drift check after 009 lands on top of 008)
- **Category**: bug (+ the test that pins it)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C10 (clamp protection defeats itself, MED confidence, latent), T4 (clamp→report→adopt loop never tested with enforcement active, HIGH)

## Why this matters

On YouTube builds whose player clamps its media element down to the menu cap
(the repo's own comments say this was "the reported failure" on some builds),
the adapter's clamp guard loses:

1. The background applies 16×; the manager stamps both rates (2 echo credits).
2. `ytSyncPlayer` (MAIN world) pushes 16× into the player API; a clamping
   build drags the ELEMENT to ~2.00× — a `ratechange` fires at 2.00×.
3. The adapter restores the element (`el.playbackRate = want`) — that
   ratechange lands at 16× = expected, so nothing is reported for it, but the
   clamp transient at 2.00× was already dispatched: no echo credit matches it
   (the ring holds only 16×), it isn't `expected`, and past the settle window
   it is `report()`ed.
4. The background adopts 2.00× as the page override and re-applies it — the
   media collapses to the clamp value, contradicting README.md:114-116 and
   DESIGN.md Y1 ("A clamping rate menu may not drag the media down"). The
   `__mcpPlayerRate` marker then stops the next sync from re-pushing 16×.

The settle window (R4b) masks this for ~2 s after play — which is why the
real-site check (speed applied right after starting playback) passes while
the latent bug remains. The verified Chrome 156 build does not drag; the fix
is for the builds that do, and the test makes the loop deterministic.

## Current state

Files and roles:
- `extension/lib/adapters.js` — `ytSyncPlayer` (MAIN world, self-contained): rate push + clamp restore + `__mcpPlayerRate` marker.
- `extension/lib/manager.js` — ISOLATED-world manager: echo credits, settle window, `report()`.
- `test/player-sync.html` — the private-player fixture (`#movie_player` stand-in with `getPlaybackRate/setPlaybackRate` etc., site UI driven only by the API).
- `scripts/e2e.mjs` — the clamping-player section currently runs with ALL policy disconnected (it clears overrides first, `:1133-1158`), so the manager's echo/report path is not under test there.
- `docs/DESIGN.md` — Y1/Y2 normative text; a one-line addition documents the cross-world suppression.

Excerpts (verified at `f6101d2`):

`extension/lib/adapters.js:125-135`:
```js
    if (caps.rate) {
      const want = el.playbackRate;
      // __mcpPlayerRate: the last rate this sync reconciled. Without it a
      // player that clamps its element would be re-fought on every call.
      if (Number.isFinite(want) && !near(want, p.getPlaybackRate()) && el.__mcpPlayerRate !== want) {
        p.setPlaybackRate(want);
        // the player's menu may refuse the value; the media element's actual
        // playback is what matters, so put it back if the call dragged it
        if (!near(el.playbackRate, want)) el.playbackRate = want;
        el.__mcpPlayerRate = want;
      }
    }
```

`extension/lib/manager.js:195-215` — the report path (no knowledge of MAIN-world syncs):
```js
  const onRateChange = (e) => {
    const el = e.target;
    const credits = echoCredits.get(el) ?? 0;
    if (credits > 0) {
      const sent = sentRates.get(el) ?? [];
      if (sent.some((r) => near(r, el.playbackRate))) {
        echoCredits.set(el, credits - 1); // our own echo (possibly a late one)
        return;
      }
    }
    if (near(el.playbackRate, S.expected)) return; // page matched our policy
    // A rate write during the element's load/play settling window is the
    // player initializing itself (YouTube writes 1.00× for each new video).
    // Restore the policy without reporting: it is not a user choice, and
    // adopting it would overwrite the page override / global speed.
    if (settling(el)) {
      applyTo(el, true);
      return;
    }
    report(el.playbackRate); // the page (user or site JS) changed the rate
  };
```

The e2e section that disconnects policy first — `scripts/e2e.mjs:1133-1141`:
```js
    // Clean policy state first: an earlier section left a page override on the
    // media tab, which keeps enforcement active — and an active policy's page
    // manager correctly re-stamps the ps fixture's direct element writes back
    // to the inherited global rate. The adapter sync is what is under test
    // here, so clear the override and let the manager disconnect everywhere.
```
and the existing clamping assertion (`:1285-1311`) verifies element 2.50× /
menu 2.00× / UI 2.00× with NO manager active.

Worlds note: expando JS properties are per-world — the MAIN world cannot
read the manager's `__mcpRate`, and vice versa. But **content attributes**
(`data-*`) live on the shared element and are visible from both worlds.
That is the channel for the fix.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" (incl. the plan-008 drift guard, if landed) |
| Mock harness | `npm run harness` | exit 0 |
| Full e2e | `npm run e2e` | exit 0; 122/122 + the new policy-active clamp step (record the total) |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `extension/lib/adapters.js` (stamp the sync window with a `data-` attribute)
- `extension/lib/manager.js` (suppress reports inside a recognized sync window)
- `test/player-sync.html` (a `clampElement` mode: the player clamps the ELEMENT, not just its API)
- `scripts/e2e.mjs` (one matrix step: clamp + enforcement ACTIVE, asserting convergence)
- `docs/DESIGN.md` (one sentence in Y1) and `README.md` count updates

**Out of scope**:
- The echo-credit ring, settle window values, R4b semantics — unchanged.
- `extension/background.js` report handling (plan 007 owns the clamp there; orthogonal).
- Real-YouTube verification beyond the existing `npm run youtube-check` (still passes; the dragging build cannot be reproduced on the verified browser — see STOP conditions).

## Git workflow
- Branch: `advisor/009-clamp-report-loop`
- Conventional commits (`fix(adapters): mark the MAIN-world rate sync so the manager ignores its clamp transient`, `test(e2e): clamp loop with enforcement active`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Stamp the sync in `ytSyncPlayer` (MAIN world)
Pick one attribute name, e.g. `data-mcp-player-sync`. In `adapters.js:125-135`:
```js
    if (caps.rate) {
      const want = el.playbackRate;
      if (Number.isFinite(want) && !near(want, p.getPlaybackRate()) && el.__mcpPlayerRate !== want) {
        // content attributes are shared across worlds: the ISOLATED-world
        // manager reads this stamp and treats ratechanges arriving within
        // the window as THIS sync's clamp/restore echoes, not page choices
        el.setAttribute('data-mcp-player-sync', String(Date.now()));
        p.setPlaybackRate(want);
        if (!near(el.playbackRate, want)) el.playbackRate = want;
        el.__mcpPlayerRate = want;
      }
    }
```
(The attribute persists after the sync — that is intentional; the manager's
check is time-bounded, so a stale stamp has no effect.)

### Step 2: Recognize the window in the manager (ISOLATED world)
In `extension/lib/manager.js`, add near the settle machinery:
```js
  const PLAYER_SYNC_WINDOW_MS = 750; // covers the clamp transient + restore
  const playerSynced = (el) => {
    const at = Number(el.getAttribute?.('data-mcp-player-sync'));
    return Number.isFinite(at) && performance.now() - at < PLAYER_SYNC_WINDOW_MS;
  };
```
and in `onRateChange`, immediately after the settle-window branch (so
settling still wins first):
```js
    // a MAIN-world player-API sync (ytSyncPlayer) just wrote this element:
    // its clamp transient and restore are extension echoes, not page
    // choices. Bounded by the stamp's age, never consumed as a credit.
    if (playerSynced(el)) {
      applyTo(el, true);
      return;
    }
```
Apply with `force` (this is setup context, matching the settle-window branch
that also forces) and WITHOUT consuming an echo credit. Keep the ordering:
echo credits → expected match → settle window → player-sync window → report.

**Verify**: `npm test` → exit 0 (the plan-008 scope-walk must accept the new code; the drift guard still matches all inline copies — Step 1 edits only `ytSyncPlayer`, which contains no inlined collection IIFE).

### Step 3: Fixture mode — a player that clamps the ELEMENT
`test/player-sync.html`'s player stub currently clamps only its own API
value. Add a mode (query param `?clampElement=1` or a fixture-API toggle the
e2e can set) under which `setPlaybackRate(v)` ALSO writes
`els.media.playbackRate = Math.min(v, 2)` (the element gets dragged, firing
the real `ratechange` the manager must classify). Keep the default mode
byte-compatible with the existing section's assertions.

### Step 4: One e2e matrix step with enforcement active
In `scripts/e2e.mjs`, add a step AFTER the existing clamping section (do not
modify the existing one):
1. Re-activate a policy on the ps tab: set global 2.5× (popup click) — the manager installs into the ps tab.
2. Enable the fixture's `clampElement` mode.
3. Drive the sync (popup speed step or a direct `ADAPTERS.youtube.syncPlayer()` eval like the existing section does).
4. Bounded poll (≤5 s), then assert ALL of:
   - the element's rate is ≥ 2.5 (the policy holds; the clamp transient was suppressed),
   - `chrome.storage.session.get('speedOverrides')` shows NO adopted 2.0× override from the transient (either no override, or the pre-existing one),
   - the fixture's `ratechange` event counter growth is bounded (sample before/after; assert growth ≤ 4 — clamp + restore + echoes — proving no report/apply feedback loop).
   Name: `speed-matrix 18: a clamping player cannot drag the media down while a policy is enforced (no bogus adoption)`.
**Verify**: `npm run e2e` → exit 0; the new step passes; record the new total.

### Step 5: Docs
- `docs/DESIGN.md` Y1 bullet: add one sentence — "The MAIN-world sync stamps the element (`data-mcp-player-sync`); ratechanges within a short window of that stamp are the sync's own clamp/restore echoes and are re-stamped without reporting."
- Update the e2e count in `README.md` / `docs/RESEARCH.md` if changed.

**Verify**: `npm run youtube-check` is NOT runnable in CI-less offline audits — record it as the maintainer's post-merge real-site confirmation instead (CHECKLIST #36b/#45b still apply).

## Test plan
- New e2e step (Step 4) is the pin: with `clampElement` on AND a policy active, no adoption, policy holds, bounded events.
- Regression direction (must NOT over-suppress): the fixture's SITE-side rate buttons (`data-ps-rate`) still produce adopted overrides in the existing sections — those go through the site UI, not the sync stamp, so the window never suppresses them. The existing "native rate change is adopted and displayed" e2e assertion is the guard.
- Existing suites all green.

## Done criteria
- [ ] `ytSyncPlayer` stamps `data-mcp-player-sync`; the manager's `onRateChange` re-stamps without reporting inside the bounded window; ordering echo → expected → settle → sync-window → report preserved
- [ ] Fixture gains `clampElement`; the new e2e matrix step passes; no existing step regressed
- [ ] `npm test` (incl. plan-008 checks, if landed), `npm run harness`, `npm run e2e` all exit 0
- [ ] DESIGN.md Y1 sentence added; counts updated where changed
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- The excerpts don't match (drift).
- The new e2e step cannot be made deterministic (the clamp transient's event timing varies beyond the bounded poll) after two tuning attempts — report; do not widen `PLAYER_SYNC_WINDOW_MS` beyond 1500 ms to force it.
- Any EXISTING adoption assertion ("native rate change is adopted and displayed (1.10× exact)", the site-button rate steps) starts failing — the suppression is swallowing genuine page choices; stop immediately and report (that is the plan's designated over-suppression guard).
- `npm run youtube-check` behavior changes when the maintainer runs it post-merge (it needs internet + headed Chrome; not part of this plan's automated gate).

## Maintenance notes
- If YouTube ships a real IFrame-API-compatible surface, the whole internal-player channel (and this stamp) can retire — tracked by DESIGN.md Y1's caveat, not by this plan.
- The attribute name is a cross-world contract shared by `adapters.js` and `manager.js`; plan 008's message-contract table is the place to add a literal-presence assertion if drift between the two files is ever observed.
- Reviewers should scrutinize the ordering in `onRateChange` and that `applyTo(el, true)` in the sync window cannot clobber a genuinely NEWER page choice that arrives within 750 ms of a sync (the window is short precisely for this reason).

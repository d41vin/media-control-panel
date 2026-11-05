# Plan 002: Prune detached media from the page speed manager's element list (leak + dead-element override reports)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/lib/manager.js test/speed-suite.html scripts/e2e.mjs README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C2 (S.list never pruned — leak + dead-element reports, HIGH), T3-detachment (detachment never tested, HIGH)

## Why this matters

`lib/manager.js` runs in every injectable frame while a speed policy is
active. It pushes every encountered media element into `S.list` and never
removes anything: `collect()` filters `isConnected` only for newly scanned
elements, and no code path ever filters the list itself.

Two consequences on long-lived SPA pages that replace their players
(YouTube-style video swaps):

1. **Memory**: every replaced `<video>`/`<audio>` stays strongly referenced
   (list entry + attached listeners) for the manager's lifetime — unbounded
   growth of detached media nodes and their decoded resources while a policy
   is active.
2. **Correctness**: media events still fire on detached elements. If a
   site's cleanup JS writes a rate to a discarded element (e.g.
   `el.playbackRate = 1` when tearing down an old player), the manager's
   `onRateChange` reports it as a page choice. At global 1.00× the
   background's report handler treats a report landing on the global rate as
   inheritance and **silently deletes the user's page override**
   (`background.js:696-698`); at any other rate it creates a bogus override
   and re-stamps every live element. `applyAll` also stamps detached
   elements pointlessly.

The fix is strictly subtractive: elements no live `querySelectorAll` could
return are dropped, and events from detached nodes are ignored. No live
behavior changes.

## Current state

Files and roles:
- `extension/lib/manager.js` — the injected per-frame speed manager (ISOLATED world, self-contained export — see `scripts/check.mjs` step 5 which enforces that `installSpeedManager` references no module-scope helpers).
- `test/speed-suite.html` — deterministic e2e fixture with a driving API (`mcpFix`): `add`, `swapSrc`, `remove`, `pushState`, `rates`, …
- `scripts/e2e.mjs` — real-Chrome e2e suite; contains the 16-step speed-regression matrix driven over `mcpFix`.
- `docs/DESIGN.md` — normative speed state model (R1–R7). This plan adds no new invariant; it enforces the existing model on detached nodes.

Excerpts (verified at `f6101d2`):

`extension/lib/manager.js:234-246` — attach pushes; scan only adds:
```js
  const attach = (el) => {
    if (unmanageable(el) || S.list.includes(el)) return;
    touch(el);
    el.addEventListener('ratechange', onRateChange);
    el.addEventListener('play', onPlay);
    for (const type of LIFECYCLE) el.addEventListener(type, onLifecycle);
    S.list.push(el);
    adopt(el); // media already playing right now
  };

  const scan = () => {
    for (const el of collect()) attach(el);
  };
```

`extension/lib/manager.js:98-104` — `collect()` filters only at scan time:
```js
  const collect = () => {
    const found = [...document.querySelectorAll('video, audio')];
    for (const el of document.querySelectorAll('*')) {
      if (el.shadowRoot) found.push(...el.shadowRoot.querySelectorAll('video, audio'));
    }
    return found.filter((el) => el.isConnected);
  };
```

`extension/lib/manager.js:195-203` — no `isConnected` guard before reporting:
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
```
(`onPlay` at `:217-220` — `touch(e.target); adopt(e.target);` — has the same gap. `applyAll` at `:165-167` stamps every list entry.)

`extension/lib/manager.js:283-315` — teardown iterates `S.list` to restore
rates but never clears the list (harmless post-teardown since `S` becomes
unreachable, but hygiene belongs here).

The report consumer that turns dead-element writes into override changes —
`extension/background.js:696-714` (adoption branch).

`test/speed-suite.html:85-91` — the fixture already has removal, but it
splices the array so the handle is lost:
```js
        remove(i) {
          els[i].pause();
          els[i].src = '';
          els[i].remove();
          els.splice(i, 1);
        },
```

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|--------------------------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0; 79 background assertions + popup smoke pass |
| Full e2e | `npm run e2e` | exit 0; 122/122 in Chrome (grows by the new matrix step's assertions — record the new total) |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope** (the only files you should modify):
- `extension/lib/manager.js`
- `test/speed-suite.html` (add a `detach`/`reattach` fixture API)
- `scripts/e2e.mjs` (add one matrix step + its assertions)
- `README.md` (only the e2e assertion count if it changes)

**Out of scope** (do NOT touch):
- The nested-shadow-root collection gap (different finding, plans/010) — do not restructure `collect()` beyond the pruning change.
- `extension/background.js` — the report handler is correct; dead-element reports must simply never arrive.
- Echo-credit machinery (`echoCredits`/`sentRates`), settle window, R4b — verified sound by the audit; leave untouched.
- `scripts/check.mjs` (plans/008 owns it).

## Git workflow
- Branch: `advisor/002-manager-detached-pruning`
- Conventional commits per step (`fix(media): prune detached media from the speed manager`, `test(e2e): detached-element matrix step`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Prune and guard in `extension/lib/manager.js`
1. At the top of `scan()`:
```js
  const scan = () => {
    // replaced SPA elements leave detached nodes behind: drop them so the
    // list cannot grow without bound and dead elements cannot report
    S.list = S.list.filter((el) => el.isConnected);
    for (const el of collect()) attach(el);
  };
```
2. At the top of `S.applyAll`:
```js
  S.applyAll = () => {
    S.list = S.list.filter((el) => el.isConnected);
    for (const el of S.list) applyTo(el);
  };
```
3. At the top of `onRateChange` (after `const el = e.target;`) and `onPlay`:
```js
    if (!el.isConnected) return; // a discarded element's write is not a page choice
```
4. At the end of `teardown()`, after the listener/observer removal loop:
```js
    S.list.length = 0;
```
Keep every comment style consistent with the file (the prune comments above follow it).

**Verify**: `npm test` → exit 0 (the self-contained check must still pass — no module-scope references introduced).

### Step 2: Fixture API for detachment in `test/speed-suite.html`
Add next to `remove(i)`:
```js
        // detach WITHOUT losing the handle: a site discarding an old player
        // often writes a cleanup rate to the detached node afterwards
        detach(i) {
          els[i].pause();
          els[i].remove();
        },
        reattach(i) {
          document.body.append(els[i]);
        },
```

**Verify**: `npm test` → exit 0 (fixture parses as part of the repo? It is an HTML file — verify instead via the e2e run in Step 3).

### Step 3: One e2e matrix step in `scripts/e2e.mjs`
Inside the speed-regression matrix section, add a step (model the code on the
existing `mcpFix`-driven steps, e.g. the SPA replacement step at
`scripts/e2e.mjs:1925-1940`):
1. With a page override active at 1.50× and 3 elements, `mcpFix.detach(2)`.
2. Write a cleanup rate to the detached node:
   `mcpFix`-style eval `document.querySelectorAll('audio')[2].playbackRate = 1` (or via a fixture helper `rate(i, r)` that works detached — prefer using the existing `rate()` helper if it operates on the retained handle).
3. Wait ~1.5 s (bounded poll), then assert via the service-worker session:
   `chrome.storage.session.get('speedOverrides')` still holds the 1.50× override (no adoption, no deletion).
4. Change the global speed (popup `gspeed-inc` click) and assert the detached element's `playbackRate` is **not** re-stamped (it stays at the value written in step 2) while live elements move.
5. `mcpFix.reattach(2)` and assert the element is adopted/stamped per the encounter rule within the same matrix step (it lands at the policy rate after the next sync/scan — a committed-navigation-free reattach triggers the manager's observer → scan → attach).

Use the existing `ok`/`bad` helpers with a descriptive name, e.g.
`speed-matrix 17: detached media is pruned — cleanup writes are not adopted and global applies skip it`.

**Verify**: `npm run e2e` → exit 0 with 123/123 (one new assertion group; record the exact total).

### Step 4: Update the documented e2e count
Update the "npm run e2e | … | 122/122" cell in `README.md` (Testing table)
and the equivalent mention in `docs/RESEARCH.md` "Current state" to the new
total from Step 3.

**Verify**: `grep -n "122/122\|122 " README.md docs/RESEARCH.md` → no stale count remains.

## Test plan
- New: the matrix step above (detachment pruning: no adoption from detached writes, no re-stamp of detached nodes, reattach re-governs).
- Existing: `npm test`, `npm run harness` (79 + popup smoke), full `npm run e2e` — all must stay green; the manager's warm-path behavior must be byte-for-byte identical.

## Done criteria
- [ ] `S.list` is filtered at `scan`/`applyAll`; `onRateChange`/`onPlay` return early for disconnected targets; `teardown` clears the list
- [ ] `npm test` exits 0 (self-contained check passes)
- [ ] `npm run e2e` exits 0 including the new detachment step
- [ ] README/RESEARCH counts updated to the actual totals
- [ ] No files outside the in-scope list modified
- [ ] `plans/README.md` status row updated

## STOP conditions
- The excerpts no longer match the code (drift).
- Pruning changes any EXISTING matrix step's outcome (it must not — report which step and the observed rates; do not adjust the policy logic to compensate).
- The `rate()` fixture helper cannot write to a detached node without new fixture code beyond the approved `detach`/`reattach` additions — stop and report rather than redesigning the fixture.

## Maintenance notes
- Plans 010 (nested shadow roots) edits the same `collect()`-adjacent inline code in `manager.js` and `lib/page.js` — land this plan first so its prune/guard lines are the base.
- When the manager gains any new per-element structure (e.g. a second WeakMap), re-check that detached pruning still covers it.
- Reviewers should scrutinize: `S.list = S.list.filter(...)` reassignment inside the closure is safe (`S.list` is only ever read in loops; no aliasing exists) — verify no new code aliases the array.

# Plan 014: e2e robustness + mock fidelity — event-counter absence windows, per-step fault isolation, honest mock transport

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- scripts/e2e.mjs test/mock-chrome.js test/background-mock.html test/popup-mock.html test/frame-host.html`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: M
- **Risk**: MED (stricter mock semantics WILL require editing existing tests that lean on the loose ones — budgeted, in scope)
- **Depends on**: none strictly; recommended AFTER plans 001–007 (so the new tests land on the stricter mock from the start)
- **Category**: tests
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: T8 (fixed-sleep absence windows + fail-fast coupling, MED), T7 (mock-chrome divergences hide contract regressions, MED), T5-toggle (toggle-target frame selection untested, HIGH/MED)

## Why this matters

1. **Absence assertions over fixed windows** (e.g. "the native rate was not
   clobbered — sleep 1.5 s then check"; "no oscillation over 0.8 s") both
   flake under machine load and under-detect (a loop that starts at 1.6 s
   passes vacuously). The fixtures already expose event counters; absence
   should be asserted as a zero delta across sampled polls.
2. **One throw aborts the suite**: the e2e is one linear `try` — a flaky
   early `waitFor` fails the run and every later assertion silently never
   runs, so a reported "122/122" can quietly degrade to "first 40 only".
3. **The mock diverges from real `chrome.*` semantics** in three ways that
   hide contract regressions: `storage.set` fires `onChanged` synchronously
   before `set()` resolves (real Chrome delivers asynchronously);
   `runtime.sendMessage` always resolves `undefined` (real bus returns a
   listener's response); `tabs.sendMessage` only RECORDS and never delivers,
   so the background→manager apply transport is never exercised in the
   harness — tests work around it by firing the same types as runtime
   broadcasts the real background never sends.

## Current state

Files and roles:
- `scripts/e2e.mjs` — the real-Chrome suite (fixed-sleep sites + linear try/catch).
- `test/mock-chrome.js` — the in-memory `chrome.*` mock (the three divergences).
- `test/background-mock.html` / `test/popup-mock.html` — consumers that may need edits after the mock tightens.
- `test/frame-host.html` — same-origin iframe fixture (exists; used by the frame-provenance e2e steps).

Excerpts (verified at `f6101d2`):

`scripts/e2e.mjs:609-613` — a fixed absence window:
```js
    await sleep(1500); // give any overzealous enforcement time to clobber it
    const bNativeKept = await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate`);
    Math.abs(bNativeKept - 1.1) < 0.001
      ? ok('the extension does not overwrite the native rate (still 1.10× after 1.5s)')
      : bad('the extension does not overwrite the native rate (still 1.10× after 1.5s)', `B=${bNativeKept}`);
```
`scripts/e2e.mjs:643-651` — the oscillation window (five samples, 300 ms apart):
```js
    // no oscillation: A holds steady at the global rate
    const rates = [];
    for (let i = 0; i < 5; i++) {
      rates.push(await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].playbackRate`));
      await sleep(300);
    }
```
`scripts/e2e.mjs:2250-2266` — the linear try/catch tail:
```js
    console.log(`\n${results.length - failed}/${results.length} e2e assertions passed`);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error('E2E setup failure:', err.message);
    process.exitCode = 1;
  } finally {
```
Further fixed-sleep sites per the audit: `:1930` (800 ms before reading the
SPA re-stamp), `:2013-2026` (rapid-change stability reads).

The mock divergences — `test/mock-chrome.js:355-362` (`storage` `set` fires
`onChanged` synchronously inside the async fn), `:203-216`
(`runtime.sendMessage` loops listeners, returns nothing), `:284-287`:
```js
      async sendMessage(tabId, msg) {
        // no page-level managers exist in the mock; record for assertions
        sentTabMessages.push({ tabId, msg });
      },
```

`extension/background.js:1101-1131` — `toggle-target` frame selection (the
probe-then-pick logic whose `frameIds: [frameId]` path is unreachable in
tests; the mock returns one frame per doc, `mock-chrome.js:330-336`).

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------------------|----------------------|
| Static checks | `npm test` | exit 0, "all checks passed" |
| Mock harness | `npm run harness` | exit 0 (after fallout edits) |
| Full e2e | `npm run e2e` | exit 0; same assertion count (rewrites, not additions, except the toggle-target step) |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `scripts/e2e.mjs` (counter-based absence helper; per-section fault isolation; one toggle-target step)
- `test/mock-chrome.js` (three targeted fidelity upgrades + `tabs.sendMessage` delivery)
- `test/background-mock.html` / `test/popup-mock.html` (fallout edits replacing the `fireMessage('mcp-speed-disconnect')`-style workarounds)
- `test/frame-host.html` (only if the toggle-target step needs a pinning hook — prefer none)
- `README.md` counts if changed

**Out of scope**:
- `extension/` source — if tightening the mock exposes a REAL latent bug, stop and report it as a finding; do not fix it inside this plan.
- The youtube-check / verify-capture / screenshot rigs (they have their own posture; only e2e + harness are in scope).
- Assertion-count churn beyond the one new step.

## Git workflow
- Branch: `advisor/014-e2e-robustness-mock-fidelity`
- Conventional commits per area (`test(e2e): counter-based absence windows`, `test(mock): honest transport semantics`, `test(e2e): per-section fault isolation`, `test(e2e): toggle-target multi-frame step`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (T8a): Counter-based absence helper in e2e
Add beside the existing helpers:
```js
/** Assert absence by event-counter delta: sample the counter, let N polls
    pass, require zero growth. Replaces fixed sleeps that both flake under
    load and under-detect (a late divergence after one fixed window passed
    vacuously). `counterExpr` must return a number. */
async function assertNoEvents(cdp, sessionId, counterExpr, { polls = 3, gapMs = 500 } = {}) {
  const before = await evalIn(cdp, sessionId, counterExpr, true);
  for (let i = 0; i < polls; i++) await sleep(gapMs);
  const after = await evalIn(cdp, sessionId, counterExpr, true);
  return { before, after, held: after === before };
}
```
Convert the fixed-sleep absence sites (`:609-613`, `:643-651`, `:2013-2026`)
to sample an event counter instead — the fixtures already expose
`mcpVolume.events()`, `mcpPS.events()`, `mcpFix`-adjacent counters; where a
counter does not exist for the asserted quantity (e.g. the native-rate-kept
check), poll the RATE for stability across the same window and assert no
deviation from the native value at each sample (strictly stronger than the
single 1.5 s read). Rewrite `:1930`'s fixed 800 ms into a bounded
`waitFor` on the re-stamped rate.
**Verify**: `npm run e2e` → exit 0 at the same assertion count (rewritten sites keep their names).

### Step 2 (T8b): Per-section fault isolation
Wrap each top-level e2e section (the `// --- section ---` blocks) in
`try { … } catch (err) { bad('section <name> completed', err.message); }`
while keeping the final summary semantics (`results.length - failed`). The
setup-critical preamble (browser launch, extension load, first popup) STAYS
fatal — everything after the first popup opens is isolated. Deliberate
`throw`s used as control flow inside the matrix (`:1872`, `:1905`, `:2042`)
become section-local failures instead of run-killers.
**Verify**: `npm run e2e` → exit 0 at the same count; deliberately break one late section locally (scratch) and confirm the run still reports the earlier sections — restore.

### Step 3 (T7): Honest mock transport — three upgrades + fallout
In `test/mock-chrome.js`:
1. **`tabs.sendMessage` delivers**: add a per-tab fake-page listener registry
   (`_mock.pageListeners: Map<tabId, fn[]>` + `addPageListener(tabId, fn)`),
   make `tabs.sendMessage` invoke the registered listeners (await them) and
   STILL record. Then fix the fallout: `test/background-mock.html` blocks
   that fire `mcp-speed-disconnect`/`mcp-speed-apply` via
   `mock.fireMessage` workarounds (e.g. `:646` per the audit) switch to
   registering a page listener and asserting the REAL worker→tab transport.
2. **`onChanged` is asynchronous**: queue the `storageChanged` notifications
   behind a microtask (`queueMicrotask(() => fn(changes, name))`) AFTER
   `map.set` — mirroring "delivered after the write commits". Fallout: any
   test reading storage synchronously after `set()` and relying on the
   listener having already run must await a tick (edit those spots).
3. **`runtime.sendMessage` returns a response**: resolve with the first
   non-`undefined` value a listener returns (real sendResponse semantics —
   the mock's listeners are sync/async mixed; await each). Fallout:
   fire-and-forget call sites are unaffected (they never await); only tests
   asserting the resolved value change — there are none today, so this is
   forward-looking fidelity.
Run both suites after each sub-step; edit fallout minimally and commit per
sub-step.
**Verify**: `npm test` → exit 0; `npm run harness` → exit 0 after fallout edits (record counts if assertion text changed).

### Step 4 (T5-toggle): toggle-target multi-frame step
In `scripts/e2e.mjs`, add one step using the frame-host fixture: pin the
frame-host tab as target (`Pin as target` via the popup or seed
`chrome.storage.session.target`), make the IFRAME's media the playing one
(pause the top-level media, play the frame's), fire the command via CDP
(`Input.dispatchKeyEvent`-free approach: the command requires a real
keyboard event — instead call the same code path the command handler runs by
dispatching through the extension page: `chrome.commands` cannot be fired
programmatically; the honest e2e path is to extract nothing and instead
assert the OBSERVABLE: evaluate the handler's logic indirectly by pausing
all frames then resuming only the frame's media and asserting the popup's
target-card state flips). If true command dispatch is impossible over CDP,
document the limitation and assert the probe-then-pick behavior via a unit
call: import `pageProbe` + replicate the frame-pick expression in the page
eval and assert it selects the iframe's `frameId` — mark the assertion as
"handler-logic parity" rather than a true command run. Record which approach
was taken in the PR body.
**Verify**: `npm run e2e` → exit 0; +1 assertion group.

## Test plan
- The plan is itself tests; its regression gate is the UNCHANGED total semantics of all suites (rewritten sites keep their assertion names), plus the new toggle-target step.
- Negative self-checks during development (scratch-run only, not committed): a temporarily broken mock delivery must fail the new transport assertions.

## Done criteria
- [ ] `assertNoEvents` replaces the fixed-sleep absence sites; the SPA re-stamp read is a bounded waitFor
- [ ] Late-section throws record `bad(...)` and the run completes; the setup preamble stays fatal
- [ ] The mock delivers `tabs.sendMessage`, async-queues `onChanged`, returns listener responses; the background-mock workarounds assert the real transport
- [ ] The toggle-target step exists with an honestly-documented approach
- [ ] `npm test`/`npm run harness`/`npm run e2e` all exit 0; counts updated where changed
- [ ] No `extension/` files modified; `plans/README.md` row updated

## STOP conditions
- Tightening the mock exposes a REAL extension bug (a handler that only works because of the loose semantics) — stop, record the finding in the plan index's notes, and let the operator decide; do not fix extension code in this plan.
- The async `onChanged` change cannot be made deterministic for the harness's module-scope test blocks after two attempts — report; a partial revert of ONLY sub-step 2 is acceptable if documented.
- e2e wall time grows beyond ~1.5× the pre-plan baseline — the counter polls must be tuned, not the waits lengthened; stop if it cannot be brought back.

## Maintenance notes
- After this plan, every NEW absence assertion must use `assertNoEvents` (state it in plans that add them: 001/002/011's steps reference it).
- The mock's listener-response semantics make `fireMessage` awaitable — future harness tests can assert reply plumbing without new knobs.
- Reviewers should scrutinize: the isolated sections still fail the RUN (exit 1) when any section fails — isolation is about completing coverage, not about tolerating failures.

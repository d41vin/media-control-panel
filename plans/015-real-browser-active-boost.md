# Plan 015: Give the active-boost lifecycle one asserting, real-browser path

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- scripts/e2e.mjs scripts/verify-capture.mjs scripts/youtube-check.mjs scripts/browser.mjs README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: M
- **Risk**: LOW (opt-in headed mode; the standard headless run is unchanged)
- **Depends on**: none strictly; makes the most sense after plans/001 and 005 (their fixes are what these assertions will pin)
- **Category**: tests
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: T1 (the 7 active-boost e2e assertions never execute — headless capture always refuses; `verify-capture` asserts nothing, HIGH)

## Why this matters

Every real-Chrome boost behavior — the tab-capture stream surviving
navigation (B2), the offscreen document's real `USER_MEDIA` lifetime (B4),
an actual audible pipeline — is guarded only by mocks and manual observation.
`scripts/e2e.mjs` contains 7 well-written active-boost assertions
(offscreen doc created, gain moves the running pipeline, popup close keeps
it, reopen restores the chip, reset releases the document), but they sit
behind `if (boostOutcome === 'active')` and `docs/RESEARCH.md:322-323`
documents that "Headless test browsers refuse capture entirely" — so the
standard `npm run e2e` always takes the 2-assertion error branch.
`scripts/verify-capture.mjs` records outcomes and asserts nothing, by design.
A regression that breaks real capture while passing the mocks (streamId
expiry timing, Chrome closing the document) would pass every suite.

The fix: an opt-in **headed** e2e mode (like `youtube-check`'s headed window)
in which capture is grantable and the active branch runs with assertions —
plus minimal assertions in `verify-capture` for the parts that are
deterministic even without the toolbar click.

## Current state

Files and roles:
- `scripts/e2e.mjs` — the suite; its boost block and launch flags are the work site.
- `scripts/browser.mjs` — shared browser selection/launch helpers (add the headed flag plumbing here if shared).
- `scripts/verify-capture.mjs` — records the capture API's real behavior; currently zero `ok(`/`bad(` calls.
- `scripts/youtube-check.mjs` — the precedent for a headed, internet-enabled rig (`:399-405` cleanup pattern).

Excerpts (verified at `f6101d2`):

`scripts/e2e.mjs:146-160` — the launch (headless today):
```js
    browserProcess = spawn(
      browserPath,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...extensionArgs(EXT),
        '--autoplay-policy=no-user-gesture-required',
        // new headless renders audio to real speakers — mute the browser,
        // not the elements/tabs (assertions read those states)
        '--mute-audio',
        '--window-size=1000,900',
        'about:blank',
      ],
```

`scripts/e2e.mjs:1505-1506` — the branch gate:
```js
    if (boostOutcome === 'active') {
      ok('boost capture established — chip shows 250% truthfully');
```
The active branch then asserts: offscreen document created (`:1508-1517`),
session state `active` (`:1519-1526`), gain 300 moves the running pipeline
with no duplicate document (`:1528-1545`), popup close keeps the boost
(`:1546-1558`), and the tail asserts "reset to 100 % releases capture +
offscreen document" (`:1585-1586`).

`scripts/e2e.mjs:1593-1612` — the headless error branch (2 assertions) with
the honest note:
```js
        note('real capture/audibility could not be exercised here — manual checklist item');
```

`scripts/browser.mjs:69-77` — the extension-args split (Chrome CDP path vs
Edge flags) — the headed flag must compose with both.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|-------------------------|--------------------------------------|
| Standard headless e2e (unchanged) | `npm run e2e` | exit 0; 122/122 (capture-refusal branch) |
| NEW headed e2e | `npm run e2e:headed` | exit 0; 122+7 assertions incl. the active-boost branch (a window appears; capture starts) |
| Capture probe with assertions | `npm run verify-capture` | exit 0; now reports `ok`/`bad` lines for the deterministic parts |
| Mock harness / static | `npm run harness`, `npm test` | exit 0 (unchanged) |

## Scope

**In scope**:
- `scripts/e2e.mjs` (headed mode + package script), `package.json` (the new script)
- `scripts/browser.mjs` (only if shared flag plumbing is cleaner)
- `scripts/verify-capture.mjs` (minimal assertions; record-not-fail posture KEPT for the activeTab probe)
- `README.md` (Testing table: new command row) / `docs/RESEARCH.md` if counts change

**Out of scope**:
- `extension/` source — a headed failure that exposes a real bug is a finding to report, not fix here.
- Audibility-by-ear (CHECKLIST #53) — automation asserts states, never sound quality.
- The toolbar-click `activeTab` grant (CHECKLIST #59d) — still manual; `chrome.action.openPopup()` does NOT grant it (documented in the repo's own research).

## Git workflow
- Branch: `advisor/015-real-browser-active-boost`
- Conventional commits (`test(e2e): headed mode runs the active-boost assertions`, `test(capture): assert the deterministic probe outcomes`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Headed mode in e2e
1. Read the mode from the environment: `const HEADED = process.env.MCP_HEADED === '1';`
2. In the launch args, replace `'--headless=new'` with a conditional:
   `...(HEADED ? [] : ['--headless=new'])` and drop `'--mute-audio'` when
   headed (audio must actually flow for capture to be meaningful; the
   machine's speakers get brief tone audio — say so in the README row and
   the script's header comment).
3. Headed Chrome needs a window: keep `--window-size` and add
   `--window-position=40,40`. Everything else (temp profile, CDP port,
   `extensionArgs`) is unchanged — the popup opens via
   `chrome-extension://…/popup.html` exactly as today.
4. The boost block's gesture path: headed mode still cannot click the real
   toolbar, and `openPopup()` does not grant `activeTab` — so the headed run
   uses the popup-as-page gesture path (`evalGesture`, already used by the
   block) which the capture API accepts in a real window (this is exactly
   what `verify-capture` records). If capture is STILL refused headed (the
   platform may require a real invocation), the branch falls back to the
   error assertions — print a `note` and exit 0 with the suite minus 7; the
   README row documents this platform-dependent outcome honestly.
**Verify**: `npm run e2e` (headless) → exit 0, unchanged 122/122. `MCP_HEADED=1 npm run e2e` → a window opens; record the outcome (expected: active branch runs, ~129 assertions; acceptable: refusal fallback with a note).

### Step 2: `package.json` script + README row
Add `"e2e:headed": "node scripts/e2e.mjs"` (env via cross-platform syntax:
document `MCP_HEADED=1` usage for Git Bash/PowerShell in the README row — or
read a `--headed` argv flag instead, which is cleaner cross-platform; prefer
argv: `node scripts/e2e.mjs --headed`).
README Testing table gains: `npm run e2e:headed` | headed Chrome; runs the active-boost assertions real capture allows | passed (or the refusal note).

**Verify**: `npm run e2e:headed` works from a clean shell (Windows Git Bash).

### Step 3: Minimal assertions in `verify-capture`
Keep its record-not-fail posture for the activeTab probe, but assert the
deterministic postures it already exercises:
- after a successful programmatic start attempt (popup-as-page): session
  state is exactly one of `pending`/`active`/`error` — never a fourth value,
  and never `active` while `getContexts` reports no document (truthfulness
  invariant B5);
- on failure: the offscreen document is released (`getContexts` length 0
  after the error auto-clear) — the invariant the e2e error branch already
  pins, now also pinned in the real headed probe;
- after a reset following a successful start: no document remains.
Implement with the existing `ok`/`bad`-style helpers (add them; the script
currently only prints). Exit code: still 0 when the probe merely records a
refusal; non-zero only when an ASSERTED invariant fails.
**Verify**: `npm run verify-capture` → exit 0 with the new ok/bad lines visible.

### Step 4: Docs + final gates
Update `README.md` (Testing table + the verify-capture row's description)
and `docs/RESEARCH.md` "Current state" (test-results list gains the headed
variant's last-verified outcome).
**Verify**: `npm test`, `npm run harness` → exit 0 (unchanged); `git status --short` shows only in-scope files.

## Test plan
- The headed run itself is the test (7 active assertions become reachable); `verify-capture` gains invariant assertions.
- Regression: the standard headless suite must remain byte-identical in outcome (122/122).

## Done criteria
- [ ] `node scripts/e2e.mjs --headed` runs the active-boost branch with assertions (or honestly records the platform refusal) without touching the headless default
- [ ] `verify-capture` asserts the truthfulness invariants while keeping its record-not-fail posture
- [ ] README/RESEARCH updated; `npm test`/`npm run harness` exit 0
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated

## STOP conditions
- Headed capture requires changes to `extension/` code to pass — that is a real finding; stop and report (it likely means the gesture path assumption is wrong on the current Chrome build).
- The headed window cannot run in this environment (RDP/service session — the repo's own research documents `openPopup` failures there); record it, keep the headless default, and mark the plan DONE-WITH-NOTE in the index rather than forcing it.
- verify-capture's asserted invariants fail on the real browser — a genuine truthfulness bug; report it as a new finding with the recorded outcome.

## Maintenance notes
- The headed rig's window/steal-focus caveats are documented in the repo's research (`verify-capture` already catches a dead popup session) — reuse its handling.
- If Chrome ever allows granting activeTab programmatically, CHECKLIST #59d's manual step can fold into this rig.
- Reviewers should scrutinize: the headless default path is byte-identical (no flag drift), and the exit-code contract of verify-capture (0 = recorded, non-zero = invariant violated).

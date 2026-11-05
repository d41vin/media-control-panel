# Plan 008: Harden `scripts/check.mjs` — serialization scope-walk, inline-copy drift guard, message/storage-key contract table

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- scripts/check.mjs extension/lib/page.js extension/lib/adapters.js extension/lib/manager.js extension/background.js extension/popup.js extension/offscreen.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P2
- **Effort**: S/M
- **Risk**: LOW
- **Depends on**: none (but run BEFORE plans 009/010/012 — it guards the inline-copy edits those plans make)
- **Category**: tests / dx (static contract checks; test-only change)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: D1 = TESTS-10 (serialization guard greps only two obsolete helper names) + DEBT-01 (no drift guard for the 9 deliberately-inlined copies) + DEBT-03 (message types & storage keys are convention-only)

## Why this matters

`scripts/check.mjs` is the repo's only static layer, and its most important
check — "injected functions must be self-contained because
`executeScript` serializes them with `Function.prototype.toString`" —
currently greps each extracted function body for exactly two strings,
`collectMedia(` and `primaryOf(`, which are names of helpers that no longer
exist. Any OTHER module-scope reference (a new helper, an import, a renamed
adapter verb) ships unguarded, and the failure mode is the worst the
extension has: a probe that throws in every real page (probe-miss cards
everywhere). Similarly, the `siteButtonState` checker and the media-collection
IIFE are deliberately inlined in ~10 injected functions that must stay
byte-identical (the files' own headers say "keep them identical") — nothing
detects drift between the copies, and a drift between `pageProbe`'s and
`pagePing`'s availability checker would make next/prev buttons flap
enabled/disabled. Finally, the 14 `mcp-*` message types and the
storage-session/local key names are held in sync by convention across
`popup.js`, `background.js`, `lib/manager.js`, `lib/offscreen.js` — a one-sided
type or a renamed key fails silently until a test that doesn't exist yet runs.

All three gaps close inside `scripts/check.mjs` itself: static, no build
step, no new dependencies — the repo's own style. A constants module is
deliberately NOT the fix for the message types: `lib/manager.js` is a
serialized function and `offscreen.js` a plain script, so half the consumers
cannot import.

## Current state

File and role:
- `scripts/check.mjs` — static checks run by `npm test`: module syntax for every JS file, manifest sanity, icons, popup.html references, and the §5 injected-function guard.

Excerpts (verified at `f6101d2`):

`scripts/check.mjs:104-132` — the guard to replace:
```js
// 5. injected functions are self-contained (no module-scope references that
//    would break after toString serialization)
const pageSrc = readFileSync(join(ext, 'lib', 'page.js'), 'utf8');
const adapterSrc = readFileSync(join(ext, 'lib', 'adapters.js'), 'utf8');
const managerSrc = readFileSync(join(ext, 'lib', 'manager.js'), 'utf8');
const fns = [...pageSrc.matchAll(/export (?:async )?function (page\w+)/g)].map((m) => m[1]);
// adapter next/prev fns are injected too — they live inside the ADAPTERS literal
const adapterFns = [...adapterSrc.matchAll(/function ((?:yt|sp|sc)(?:Next|Prev|SyncPlayer|SetMuted|PlayerState))\(/g)].map((m) => m[1]);
if (!fns.length) fail('no exported page functions found');
for (const fn of [...fns, ...adapterFns]) {
  const src = pageSrc.includes(`function ${fn}`) ? pageSrc : adapterSrc;
  const body = src.slice(src.indexOf(`function ${fn}`));
  const end = body.indexOf('\nfunction ', 1);
  const code = end === -1 ? body : body.slice(0, end);
  for (const helper of ['collectMedia(', 'primaryOf(']) {
    if (code.includes(helper)) fail(`${fn} references module-scope helper ${helper}`);
  }
}
// the speed manager is injected with args and must likewise be self-contained
if (!/export function installSpeedManager\(/.test(managerSrc)) {
  fail('lib/manager.js must export installSpeedManager');
}
const mgrBody = managerSrc.slice(managerSrc.indexOf('function installSpeedManager'));
for (const helper of ['collectMedia(', 'primaryOf(']) {
  if (mgrBody.includes(helper)) fail(`installSpeedManager references module-scope helper ${helper}`);
}
ok(
  `page.js + adapters.js + manager.js functions self-contained (${fns.length + adapterFns.length + 1} injected)`,
);
```

The inline copies that must stay identical (from the audit's mechanical
diff): the media-collection IIFE appears 10× in `lib/page.js` (probe
`:49-55`, ping `:128-134`, toggle `:154-160`, play `:186-192`, pause
`:211-217`, seekTo `:225-231`, seekBy `:246-252`, setVolume `:266-272`,
setMuted `:286-292`, plus the video-only PiP variant `:305-311` which is
deliberately different) and once in `lib/manager.js` (`:98-104`);
`siteButtonState` is duplicated between `pageProbe` (`:20-48`) and `pagePing`
(`:101-127`) — code-identical today, only the comment differs.

Message types (14): `mcp-speed-report`, `mcp-speed-page`, `mcp-speed-reset`,
`mcp-speed-sync`, `mcp-speed-apply`, `mcp-speed-disconnect`,
`mcp-boost-start`, `mcp-boost-gain`, `mcp-boost-stop`, `mcp-boost-result`,
`mcp-boost-ended`, `mcp-boost-offscreen-start`, `mcp-boost-offscreen-gain`,
`mcp-boost-offscreen-stop` — senders/receivers: popup (`popup.js:760,772,822,848,1879`),
background router (`background.js:673-894`) + apply sender (`:346,700,713`),
manager (`lib/manager.js:172` send; `:261,268` receive), offscreen
(`offscreen.js:225-229`). Storage keys: `speed` (local), `settings` (local),
`speedOverrides`, `speedRevs`, `speedCommitted`, `speedFrameDocs`,
`speedManaged`, `boosts`, `recent`, `target` (session).

Adapter function names live in the `ADAPTERS` literal
(`extension/lib/adapters.js:212-244`): `next`, `prev`, `syncPlayer`,
`setMuted`, `readState` per adapter — derive the injected list from the
literal, not the `(?:yt|sp|sc)` name regex.

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|---------------------|--------------------------------------|
| Static checks | `npm test` | exit 0, "all checks passed" — with the new checks reported |
| Mock harness | `npm run harness` | exit 0 (unchanged; run once as a sanity gate) |
| Negative self-test | `node -e "…"` snippets below | each mutation makes `npm test` fail |

## Scope

**In scope**:
- `scripts/check.mjs` only.

**Out of scope**:
- Any file under `extension/` — the checks must pass against the code as it
  stands at `f6101d2`. If a new check FAILS on current code, the check is
  wrong or the finding is a NEW bug — stop and report; do not edit the
  extension to make a check pass.
- `docs/` — no doc updates needed (the check output line changes only).
- plans 009/010/012's code changes — this plan only builds the guardrails
  they will rely on.

## Git workflow
- Branch: `advisor/008-check-static-contracts`
- Conventional commits (`test(check): scope-walk the injected functions`, `test(check): inline-copy drift guard`, `test(check): message and storage-key contract table`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Replace the two-name grep with a module-scope walk
In `scripts/check.mjs` §5, for each injected function (page functions,
adapter functions derived from the `ADAPTERS` literal, `installSpeedManager`):
1. Extract the function body as today (keep the existing slicing approach;
   also extract `ytSyncPlayer`, `ytSetMuted`, `ytPlayerState` bodies the same
   way — they are MAIN-world injected and equally self-contained).
2. Collect the module-scope identifiers of that file with a regex pass over
   the WHOLE file minus the function's own body: `import … from …` names,
   top-level `const|let|function` declarations, and `export` names.
3. Flag any occurrence of a module-scope identifier inside the function body
   that is not redeclared/shadowed within the body and is not a known global.
   Keep a small allowlist of legitimate globals the injected code uses
   (`document`, `window`, `navigator`, `chrome`, `performance`,
   `MutationObserver`, `getComputedStyle`, `WeakMap`, `Number`, `Math`,
   `JSON`, `String`, `Boolean`, `Array`, `Object`, `Error`, `Promise`,
   `setTimeout`, `clearTimeout`, `URL` …) — tune the list until the CURRENT
   code passes.
4. Fail with `${fn} references module-scope ${name}`; keep the final
   `ok('… self-contained (N injected)')` line with the true count.

**Verify**: `npm test` → exit 0. Negative self-test:
`node -e "const fs=require('fs');const p='extension/lib/page.js';fs.writeFileSync(p+'.bak',fs.readFileSync(p));fs.writeFileSync(p,fs.readFileSync(p,'utf8').replace('export function pagePing(','const ICECream=1;\\nexport function pagePing('));" && npm test; echo "exit=$?"; mv extension/lib/page.js.bak extension/lib/page.js`
→ `npm test` must FAIL with a scope-walk message, then the file is restored.
Confirm with `git diff --stat extension/lib/page.js` that the tree is clean
after the restore.

### Step 2: Inline-copy drift guard
Add a check that slices the repeated snippets out of `lib/page.js` and
`lib/manager.js` and asserts byte-identical text:
- The media-collection IIFE: extract from `pageProbe` and from each function
  that contains the `const els = (() => {` block (normalize leading
  whitespace only); assert all 10 page.js copies are identical and the
  manager's `collect()` body (the statements inside the arrow function)
  matches the same canonical text (the manager names it `found` — normalize
  the single local variable name before comparing, and assert you found the
  expected count of copies: 10 in page.js incl. the video-only variant
  excluded, 1 in manager.js).
- `siteButtonState`: assert the two copies are identical after whitespace
  normalization.
- On mismatch, fail with the two function names
  (`pageProbe vs pagePing: siteButtonState copies diverged`).
- Whitelist the PiP variant explicitly (it collects `video` only — document
  the exemption in a comment).

**Verify**: `npm test` → exit 0. Negative self-test: temporarily edit one
copy in a scratch copy of the file (same backup/restore pattern as Step 1)
→ `npm test` fails naming both functions; restore; `git status` clean.

### Step 3: Message-type and storage-key contract table
Add a §6 to `check.mjs`:
1. Declare the contract as data:
```js
const MESSAGE_CONTRACT = {
  'mcp-speed-report':    { send: ['lib/manager.js'], receive: ['background.js'] },
  'mcp-speed-page':      { send: ['popup.js'], receive: ['background.js'] },
  'mcp-speed-reset':     { send: ['popup.js'], receive: ['background.js'] },
  'mcp-speed-sync':      { send: ['popup.js'], receive: ['background.js'] },
  'mcp-speed-apply':     { send: ['background.js'], receive: ['lib/manager.js'] },
  'mcp-speed-disconnect':{ send: ['background.js'], receive: ['lib/manager.js'] },
  'mcp-boost-start':     { send: ['popup.js'], receive: ['background.js'] },
  'mcp-boost-gain':      { send: ['popup.js'], receive: ['background.js'] },
  'mcp-boost-stop':      { send: ['popup.js'], receive: ['background.js'] },
  'mcp-boost-result':    { send: ['background.js', 'offscreen.js', 'popup.js'], receive: ['background.js', 'popup.js'] },
  'mcp-boost-ended':     { send: ['offscreen.js'], receive: ['background.js'] },
  'mcp-boost-offscreen-start': { send: ['background.js'], receive: ['offscreen.js'] },
  'mcp-boost-offscreen-gain':  { send: ['background.js'], receive: ['offscreen.js'] },
  'mcp-boost-offscreen-stop':  { send: ['background.js'], receive: ['offscreen.js'] },
};
const STORAGE_KEYS = {
  local:   { speed: ['background.js', 'popup.js', 'lib/speed.js'],
             settings: ['background.js', 'popup.js', 'lib/settings.js'] },
  session: { speedOverrides: ['background.js', 'popup.js', 'lib/speed.js'],
             speedRevs: ['background.js'], speedCommitted: ['background.js'],
             speedFrameDocs: ['background.js'], speedManaged: ['background.js'],
             boosts: ['background.js', 'popup.js', 'offscreen.js'],
             recent: ['background.js', 'popup.js'], target: ['background.js', 'popup.js'] },
};
```
2. For every declared type/key, grep each file in `send`/`receive` (and the
   key's file lists) for the literal and require presence; then extract ALL
   `'mcp-…'` literals and session/local key strings actually occurring per
   file and fail on any occurrence NOT declared (unknown type in a file, or a
   key string like `'boosts'` appearing in a file not listed). Normalize the
   file paths relative to `extension/`; read `popup.js`, `background.js`,
   `lib/*.js`, `offscreen.js`.
3. Test-rig files are excluded from the reverse direction (they deliberately
   fire raw messages) — scope the scan to `extension/` only, and say so in a
   comment.

**Verify**: `npm test` → exit 0. Negative self-test: add a fake
`'mcp-speed-nope'` send into a scratch copy of `background.js` → `npm test`
fails with `undeclared message type`; restore; `git status` clean.

### Step 4: Full gate
**Verify**: `npm run harness` → exit 0 (unchanged suite — this plan touches
no runtime code). `git status --short` → clean tree apart from `scripts/check.mjs`.

## Test plan
- This plan IS tests: three new static checks, each with a negative self-test
  performed during development (documented in the commit bodies; the backup/
  restore mutations must not persist).
- Existing `npm test` output grows by the new `ok` lines; no runtime suite changes.

## Done criteria
- [ ] The scope-walk replaces the two-name grep; adapter functions derive from the `ADAPTERS` literal; `ytSyncPlayer`/`ytSetMuted`/`ytPlayerState` bodies are covered
- [ ] The drift guard asserts byte-equality (modulo whitespace + the named variable normalization) of the collection IIFE (10 page.js copies + manager) and `siteButtonState` (2 copies), with the PiP variant whitelisted
- [ ] The contract table validates all 14 message types and the session/local keys in both directions, extension/ files only
- [ ] `npm test` exits 0; all three negative self-tests demonstrated during development
- [ ] `git status --short` shows only `scripts/check.mjs` modified; `plans/README.md` row updated

## STOP conditions
- Any new check fails against the UNMODIFIED `f6101d2` code after allowlist tuning — that is either a check bug or a live instance of the guarded failure mode; stop and report the exact identifier and location.
- The regex-based module-scope extraction produces false positives that need more than a small allowlist (e.g. destructured imports) — stop and report rather than building an AST parser into check.mjs (out of the repo's no-tooling style).
- The IIFE extraction cannot normalize manager.js's differing local name without distorting the comparison — report the actual textual difference.

## Maintenance notes
- plans 009/010/012 edit the guarded copies — their executors must re-run `npm test` after every copy edit; the drift guard is what makes those plans safe.
- When a 15th message type or new storage key is added, updating `MESSAGE_CONTRACT`/`STORAGE_KEYS` is part of the change — the check makes forgetting it impossible to merge silently.
- Reviewers should scrutinize the allowlist (too broad = the guard is toothless; too narrow = false alarms) and that the negative self-tests were actually run (commit messages should name the observed failures).

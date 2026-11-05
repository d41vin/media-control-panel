# Plan 020: Investigate two truthfulness edge cases — unknown-duration display and YouTube player-mute alignment

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- extension/lib/page.js extension/popup.js extension/lib/adapters.js docs/DESIGN.md README.md`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P3
- **Effort**: S/M
- **Risk**: LOW (investigation + doc-or-tiny-fix; no state-machine changes)
- **Depends on**: none (YouTube observation needs internet + a headed browser — same environment as `npm run youtube-check`)
- **Category**: direction/investigation (characterization plan, not a fix plan — the two problems are medium-confidence and one depends on undocumented player internals)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: C15 (NaN duration renders as LIVE — MED, transient), C13 (`ytSyncPlayer`'s mute branch may be inert in the player-unmuted/element-muted direction — MED, build-dependent)

## Why this matters

Both findings are real code paths whose USER-VISIBLE impact is not yet
established, so fixing them today would mean shipping a change for an
unverified problem. This plan characterizes both, then lands either the
smallest honest fix or an explicit documentation statement — decided by
evidence, not assumption:

1. **C15 — unknown duration displays as LIVE.** `pageProbe`/`pagePing` map
   every non-finite duration (`NaN` = metadata not loaded, `Infinity` = live
   stream) to `-1`, and the popup treats `-1` as LIVE: a video that is merely
   buffering shows the red LIVE tag with seek disabled, then flips back once
   metadata arrives. Transient (self-corrects on the 1 s ping) but a lie
   DESIGN.md reserves for live streams. Open question: is the transient
   window observable in practice (popup opened before metadata), and is a
   third state ("duration unknown") worth its UI cost — or should the
   behavior just be documented as accepted?
2. **C13 — the mute-alignment poke may be inert.** `ytSyncPlayer`'s mute
   branch calls `p.mute()/p.unMute()` with the player's OWN current state —
   a pure re-assertion poke that never writes `el.muted`. On builds that
   re-push their model on the call (the design's assumption, Y1: "the
   element is aligned to it"), that works. On builds that don't, the
   mismatch direction player-unmuted/element-muted (constructible: the
   element-level mute fallback ran while the player surface was absent, then
   the surface reappeared on SPA navigation) leaves silent audio while the
   popup's "Player audio" row truthfully shows the player's "unmuted".
   Open question: does the verified Chrome 156 build re-push on the call?
   (The real-site mute matrix passes, suggesting the mismatch may be
   unreachable or self-correcting today.)

## Current state

Files and roles:
- `extension/lib/page.js` — the duration mapping (in two inlined copies).
- `extension/popup.js` — the LIVE decision.
- `extension/lib/adapters.js` — the mute branch under investigation.
- `docs/DESIGN.md` — Y1's normative mute-direction text; the "States" section is where an unknown-duration state would be specified.
- `npm run youtube-check` — the real-site rig to extend for the observation (headed Chrome + internet required).

Excerpts (verified at `f6101d2`):

`extension/lib/page.js:79` (probe) and `:141` (ping) — identical mapping:
```js
    duration: Number.isFinite(el.duration) ? el.duration : -1,
```

`extension/popup.js:1101-1106`:
```js
  if (element) {
    const live = element.duration === -1;
    n.pos.closest('.card-timeline').classList.toggle('live', live);
    // seeking is meaningless on live streams: the ±10 s buttons stay in
    // place and truthfully disabled rather than no-op
    n.back10.disabled = n.fwd10.disabled = disabled || live;
```

`extension/lib/adapters.js:141-145`:
```js
    if (caps.mute) {
      // the player's model is authoritative for mute; align the element TO it
      const want = !!p.isMuted();
      if (want !== !!el.muted) want ? p.mute() : p.unMute();
    }
```
Note the branch only RUNS on a mismatch and then calls the API with the
value the player already holds — so the call is either (a) a re-assertion
that writes through to the element, or (b) a no-op. DESIGN.md:246-249
documents the intent:
```md
  - `syncPlayer` — the direction is per channel, because ownership is per
    channel. **Rate/volume: ELEMENT → API** … **Mute: PLAYER → ELEMENT**
    (the player's model is the site's own truth; the element is aligned to
    it, never the other way …
```

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|-----------------------------|--------------------------------------|
| Static checks | `npm test` | exit 0 |
| Real-site observation | `npm run youtube-check` | 13/13 (the current matrix; this plan ADDS observation steps, see Step 2) |
| Full e2e | `npm run e2e` | exit 0; 122/122 |
| Mock harness | `npm run harness` | exit 0 |
| Local fixture server | `npm run serve` | repo at http://localhost:8080 |

## Scope

**In scope**:
- `test/player-sync.html` and/or a small probe page (characterization fixtures)
- `scripts/youtube-check.mjs` (temporary or permanent observation steps)
- ONE of, per finding, decided by the evidence: a small code fix (`page.js` mapping + `popup.js` display, or the one-line `el.muted = want` alignment in `adapters.js`), OR a documentation statement (`DESIGN.md` / README Known limits)
- `README.md`/`docs/` counts if a fix lands

**Out of scope**:
- The clamp/restore machinery (plans/009), the echo-credit ring, the settle window.
- Any new popup UI beyond what the duration decision strictly requires (e.g. no redesign of the timeline row).
- Trusting either hypothesis without the recorded observation (the whole point).

## Git workflow
- Branch: `advisor/020-investigate-duration-and-mute`
- Conventional commits (`test(shots): characterize unknown-duration and mute-alignment behavior`, then `fix(...)` or `docs: ...` per decision).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1 (C15): Characterize the unknown-duration window
1. Fixture probe: serve a local page with a `<video>` whose `src` is delayed
   (e.g. set `src` after a 5 s timer, or a large file with throttled devtools
   — simplest: a page that creates the element with NO src, then assigns it).
   Probe it via the extension popup (or the popup-mock with a mock element
   whose `duration` is NaN) and record: what the card shows before metadata
   (LIVE tag? disabled ±10 s?) and how it transitions after.
2. Decision gate (record the answer in the PR body):
   - If the window is effectively unobservable in real use (metadata arrives
     before the popup can render), document the mapping as accepted in
     DESIGN.md's States section and STOP for this finding.
   - If observable: implement the minimal honest fix — `page.js` reports
     `duration: el.duration === Infinity ? -1 : (Number.isFinite(el.duration) ? el.duration : null)`
     (null = unknown) in BOTH copies; `popup.js` renders `null` as a plain
     disabled slider with the standard times readout showing `—` and does
     NOT apply the `live` class; `live` stays reserved for `Infinity`.
     Mock/harness assertions: the popup-mock element gains a NaN-duration
     case asserting the disabled-not-live state.
**Verify**: `npm test`/`npm run harness`/`npm run e2e` all exit 0 (either the doc-only or the code path).

### Step 2 (C13): Characterize the mute-alignment poke on real YouTube
1. Extend `scripts/youtube-check.mjs` with an observation step (clearly
   marked as such): construct the mismatch in a controlled way —
   `pageSetMuted`-style element write (`document.querySelector('video').muted = true`)
   while the player surface exists, then invoke `ADAPTERS.youtube.syncPlayer()`
   via the same MAIN-world path the popup uses, then sample BOTH
   `p.isMuted()` and `el.muted` at ~250 ms intervals for ~3 s.
2. Record one of: (a) the element converges to the player's unmuted state
   (the poke writes through — behavior matches Y1 as implemented),
   (b) the element stays muted (inert poke — Y1's alignment promise does not
   hold on this build), or (c) the player reasserts the element back to ITS
   state spontaneously within the window.
3. Decision gate (record in the PR body):
   - (a) or (c): document the observed behavior in DESIGN.md Y1 with one
     sentence ("the poke re-asserts the player's model onto the element /
     the player's own reassertion corrects the mismatch on the verified
     build") — no code change.
   - (b): the one-line alignment fix in `adapters.js` —
     `if (want !== !!el.muted) { want ? p.mute() : p.unMute(); el.muted = want; }`
     — plus the same observation step promoted to a permanent assertion
     (the fixture's player stub gains a non-reasserting mode and the e2e
     player-sync section asserts the element converges).
**Verify**: `npm run youtube-check` → 13/13 (plus the observation output recorded); if the fix landed, `npm run e2e` → exit 0 with the new assertion.

### Step 3: Write the outcome down
Either way, the findings end up decided: update `docs/DESIGN.md` (States
and/or Y1) and — if a fix landed — `README.md` counts. Leave the
observation step in `youtube-check.mjs` only if it is fast and stable;
otherwise record the transcript in the PR body and keep the rig at 13/13.

**Verify**: `git status --short` shows only in-scope files; all suites green.

## Test plan
- Characterization: the probe page + the youtube-check observation step (recorded, possibly temporary).
- If C15's fix lands: popup-mock NaN-duration assertion. If C13's fix lands: a non-reasserting player-stub mode + one e2e convergence assertion.
- Existing suites remain the regression gate.

## Done criteria
- [ ] Both behaviors are RECORDED (observation transcript in the PR body) — not assumed
- [ ] Each finding ends in exactly one of: documented-as-accepted, or the minimal fix + its pinning assertion
- [ ] `npm test`/`npm run harness`/`npm run e2e` exit 0; `npm run youtube-check` 13/13 (or the documented new count)
- [ ] No files outside the in-scope list modified; `plans/README.md` row updated with the decision

## STOP conditions
- The real-site observation cannot be performed (no internet/headed browser in the executor's environment) — STOP and report; both decisions then remain open and the plan stays IN PROGRESS rather than guessing.
- The mismatch construction itself fails (the player refuses the element write, or the surface cannot be made to reappear) — record that as the finding for (C13) and default to the documentation outcome.
- The C15 fix would require popup UI beyond the disabled-slider shape specified here — report; a richer "unknown duration" design is a maintainer decision.

## Maintenance notes
- If YouTube's player ever exposes an official page-facing API, Y1's whole channel (and this alignment question) retires — tracked by DESIGN.md's caveat.
- The `null` duration convention (if adopted) must be added to plans/002's and plans/010's fixture expectations — the drift guard in check.mjs (plans/008) plus this note keep the copies honest.
- Reviewers should scrutinize the PR body's recorded observations — the plan's value is the evidence, and a reviewer should reject a merge where the "decision gate" was skipped.

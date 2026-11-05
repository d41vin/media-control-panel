# Plan 016: Reconcile the documentation with the actual data flows (privacy claims, stale addenda)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat f6101d2..HEAD -- README.md docs/RESEARCH.md extension/background.js extension/lib/page.js extension/popup.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status
- **Priority**: P2
- **Effort**: S
- **Risk**: LOW (docs-only)
- **Depends on**: none
- **Category**: docs (+ security-claim accuracy)
- **Planned at**: commit `f6101d2`, 2026-11-05
- **Covers audit findings**: S1 (README privacy claims contradict the implementation — URL recording + artwork/favicon fetches, HIGH evidence / LOW risk), DOC1 (RESEARCH.md stale lines: boost-cleared-on-navigation; "local interpolation between probes")

## Why this matters

The README's privacy statements are materially false as written, and a stale
research addendum contradicts the normative design. This is a
documented-decision drift, not a data-egress bug — nothing leaves the device
— but anyone trusting the README (including a future auditor) would
mis-assess the extension's data footprint:

1. **URL recording**: `webNavigation.onCommitted` records the committed
   document of EVERY tab — top frame AND every subframe — into
   `storage.session` (`speedCommitted`, `speedFrameDocs`) for the whole
   browser session, unconditionally (not gated on a speed policy being
   active). README claims: "listens only to top-frame commit/history events"
   and "It stores nothing about where you browse", plus "two sleeping event
   listeners" while idle. All three are wrong as written: subframe events ARE
   consumed (they are what validates iframe report provenance — R1a), the
   current URL of every tab and iframe IS held in session storage, and the
   listener set is ~10 (the perf audit judged the extra wakes trivial; the
   claim is still inaccurate).
2. **Image fetches**: the popup renders `navigator.mediaSession` artwork and
   the tab's `favIconUrl` — both page-chosen remote URLs — so opening the
   popup DOES issue network requests to page-chosen hosts. README claims
   "Everything is local: no accounts, no analytics, no network requests". A
   page can also use a session-unique artwork URL as a beacon to detect the
   extension/popup-open (honest severity: LOW, personal use).
3. **Stale RESEARCH.md lines**: the tab-capture addendum still says boost is
   "cleared on stream end, tab close, **navigation**" — superseded by the
   later "Boost is a tab setting" pass (DESIGN.md B2) and not listed in the
   file header's superseded-items disclaimer; and it claims the seek bar does
   "local interpolation between probes" — no such code exists.

The remediation here is documentation-only: the recording and fetching are
functional requirements of the shipped features (documentId-scoped overrides
need the committed docs; artwork/favicon are the card's identity). The
alternative code-side mitigations (gating recording on `enforcementNeeded()`,
restricting artwork to `data:` URLs) are explicitly out of scope and listed
as options for the maintainer.

## Current state

Files and roles:
- `README.md` — the claims to correct (privacy paragraph, "Why it's light" section, webNavigation permission row).
- `docs/RESEARCH.md` — the research log; header disclaimer lists what is superseded; two more lines belong there (or in-place fixes).
- The code being described (read-only for this plan): `extension/background.js:931-942` (unconditional onCommitted), `:958-962` (`noteFrameCommit` stores subframe URLs), `:202-208` (`persistCommitted` writes both maps); `extension/lib/page.js:62-71` (mediaSession artwork harvest); `extension/popup.js:970-999` (artwork/favicon `img.src` assignment, scheme-filtered `https?:|data:`).

Excerpts (verified at `f6101d2`) — the claims:

`README.md:15-16`:
```md
Everything is local: no accounts, no analytics, no network requests, and audio
boost processing never leaves the device.
```

`README.md:292-295`:
```md
No `tabs` permission — audible/muted state is free, and host permissions already unlock titles.
`webNavigation` carries Chrome's "Read your browsing history" install warning; the extension
listens only to top-frame commit/history events to scope speed overrides to the right document
(boost is tab-level and is not tied to a navigation). It stores nothing about where you browse.
```

`docs/RESEARCH.md:151`:
```md
- Seek bar: no polling loop. One thin probe per second *only while a row is
  expanded and playing*, plus local interpolation between probes; everything
  clears on collapse/close.
```

`docs/RESEARCH.md:294-299`:
```md
5. Truthful state: `storage.session` holds `{tabId: {gain, state}}`, written
   pending → active/error from the offscreen document's report, cleared on
   stream end, tab close, **navigation** (any `tabs.onUpdated` url change —
```

## Commands you will need

| Purpose | Command | Expected on success |
|-----------|-----------------------------|----------------------|
| Static checks | `npm test` | exit 0 (docs don't affect it — run as a no-op gate) |
| Claim audit | `grep`/`rg` commands below | each corrected claim verified against the code |

## Scope

**In scope**:
- `README.md`
- `docs/RESEARCH.md`

**Out of scope**:
- ALL extension source (this plan must not touch code).
- `docs/DESIGN.md` (B2/R1a are already correct), `docs/PLAN.md`, `docs/CHECKLIST.md`, `REVIEW-STATUS.txt`.
- Code-side mitigations (gating recording, artwork restrictions) — listed below as maintainer options only.

## Git workflow
- Branch: `advisor/016-docs-privacy-reconciliation`
- One conventional commit (`docs: reconcile the privacy and behavior claims with the implementation`).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Correct the README privacy paragraph (`:15-16`)
Replace with an accurate, same-tone paragraph, e.g.:
```md
Everything is local: no accounts, no analytics, and audio boost processing
never leaves the device. The only network requests are image loads the popup
renders from page-provided sources — the page's mediaSession artwork and the
tab's favicon — and those go to the page's own hosts. State lives in
`chrome.storage` (see below); the current committed URL of each tab and its
iframes is kept in session storage while a speed policy may apply, because
that identity is what scopes per-page speed overrides (it is never logged,
never leaves the device, and is replaced on every navigation).
```

### Step 2: Correct the webNavigation row (`:292-295`)
Replace the two false sentences with, e.g.:
```md
`webNavigation` carries Chrome's "Read your browsing history" install warning; the
extension consumes top-frame commit/history events to scope speed overrides to the
right document, and subframe commit events to validate which frame's document a
native speed report came from (iframe media). The committed URL + documentId of
each tab and iframe is held in `chrome.storage.session` (replaced per navigation,
cleared when the browser closes); nothing is logged and nothing leaves the device.
```
And in "Why it's light", replace "the extension is two sleeping event listeners"
with an accurate count ("a handful of sleeping event listeners") — the perf
audit verified the idle cost is trivial; the claim should simply be true.

### Step 3: Fix RESEARCH.md's stale lines
1. Line 151 (MV3 performance rules): drop the interpolation clause — describe
   what IS implemented: "One thin probe per second only while a row is
   playing (or the volume popover is open); the readouts come from the
   probe/ping, with no interpolation between them."
2. Addendum 4 (`:294-299`): amend the boost state sentence to the current
   rule (tab-level, survives navigation) and add `boost (tab-level, survives
   navigation — see the manual-test-fixes addendum and DESIGN.md B2)` to the
   header's superseded-items list so the historical text is explicitly
   marked.
3. Line 151's "expanded and playing" phrasing: also stale (the popover keeps
   the loop alive on paused media) — correct while editing that bullet.

### Step 4: Claim audit
Run each verification and read the surrounding text once more:
- `grep -n "no network requests\|nothing about where you browse\|top-frame commit/history\|two sleeping" README.md` → no stale occurrences.
- `grep -n "interpolation" docs/RESEARCH.md` → only in corrected/historical context.
- `grep -n "cleared on stream end, tab close, \*\*navigation\*\*" docs/RESEARCH.md` → no stale occurrence.
Cross-check every replacement sentence against the code excerpts listed
under Current state (this is the whole point of the plan — the claims must
be true statements about `background.js`/`popup.js` as they exist).
**Verify**: `npm test` → exit 0 (unchanged), `git status --short` → only the two docs files.

## Test plan
- Docs-only: the "tests" are the greps above plus a human read-through of
  the three corrected passages against the code.

## Done criteria
- [ ] README's privacy paragraph, webNavigation row, and idle-footprint claim are accurate statements about the implementation
- [ ] RESEARCH.md's interpolation claim and the boost-navigation addendum are corrected/marked superseded
- [ ] `git status --short` shows only `README.md` and `docs/RESEARCH.md`
- [ ] `plans/README.md` status row updated

## STOP conditions
- The code excerpts under "Current state" no longer match (e.g. a code plan
  landed that gated the recording) — re-verify what IS true now and write
  that instead; the claims must describe the live code, never the plan's
  snapshot.
- A maintainer decision arrives to implement a code-side mitigation instead
  — stop; that is a different plan (record it in the index's notes).

## Maintenance notes
- Future features that add ANY network fetch or any new persisted key must update this paragraph in the same commit — the claim audit greps make forgetting detectable.
- Maintainer options deliberately not planned (record for later): gate `noteFrameCommit`/`committedDocs` recording on `enforcementNeeded()` (M, MED risk — provenance validation depends on it); restrict artwork to `data:` URLs (M, worse card visuals).
- Reviewers should scrutinize each corrected sentence against the code — this plan's whole value is truthfulness.

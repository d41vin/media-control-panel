// Service worker. While the popup is closed this worker owns three jobs, all
// event-driven with no polling:
//
//   1. the toolbar badge (playing-tab count),
//   2. the speed policy: global speed + per-page overrides, and the lifecycle
//      of the page-level managers that enforce them (lib/manager.js),
//   3. boost capture: the popup's click arrives here as a message (user
//      gestures propagate through extension messaging), this worker obtains
//      the tabCapture stream id — the docs-blessed consumer path is
//      service-worker -> offscreen document — and keeps the truthful boost
//      state. Boost commands and offscreen-targeted commands use DIFFERENT
//      message types, so a broadcast can never start two capture attempts
//      with one stream id.
//
// It wakes for tab events, storage changes and extension messages, does
// cheap early-exit work, and sleeps 30 s later like any MV3 worker. The
// architectural trade-offs versus v2.0, both event-driven and self-cleaning:
// while a speed policy is active, injected page managers keep listeners alive
// inside media tabs; while a boost is active, the offscreen audio document
// exists. Neither runs at factory defaults.

import { pagePause, pageProbe, pageToggle } from './lib/page.js';
import { installSpeedManager } from './lib/manager.js';
import { loadSettings } from './lib/settings.js';
import {
  SPEED_DEFAULT,
  clampSpeed,
  loadGlobalSpeed,
  loadOverrides,
  writeOverrides,
} from './lib/speed.js';

// --- badge ---------------------------------------------------------------------

let lastCount = -1;
let badgeEnabled = true;

async function updateBadge() {
  try {
    const n = badgeEnabled ? (await chrome.tabs.query({ audible: true })).length : 0;
    if (n !== lastCount) {
      lastCount = n;
      await chrome.action.setBadgeText({ text: n ? String(n) : '' });
    }
  } catch {
    // extension context shutting down
  }
}

// Tabs that played recently stay listed (paused, resumable) the next time the
// popup opens — the behavior Chrome's media panel has. Recorded on the same
// audible events the badge already consumes: no extra wakes.
const RECENT_MAX = 8;
let recentEnabled = true;

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

// Settings live in storage.local; the sleeping worker wakes on the change,
// re-reads them once, and corrects the badge immediately. Turning the recent
// list off also wipes what was already recorded.
async function refreshSettings() {
  const s = await loadSettings();
  const badgeChanged = s.badge !== badgeEnabled;
  badgeEnabled = s.badge;
  recentEnabled = s.recentTabs;
  if (!s.recentTabs) void chrome.storage.session.remove('recent').catch(() => {});
  if (badgeChanged) void updateBadge();
}

// --- speed policy -----------------------------------------------------------------
//
// State ownership: global speed = storage.local ('speed'); page overrides =
// storage.session ('speedOverrides', keyed to tab + committed page URL). Both
// are cached here for cheap synchronous checks; storage stays the truth and
// storage events keep the caches fresh.
//
// Ordering is structural, not timed: a single policy revision (`speedRev`,
// session-persisted) is bumped on every policy mutation, and every apply and
// report carries the revision it belongs to (see DESIGN.md, invariants R1–R7).
// Stale reports — sent under a superseded policy — are dropped by revision
// comparison instead of a wall-clock echo window.

let globalSpeed = SPEED_DEFAULT;
let overrides = {}; // tabId -> { url, rate, at }
// Per-tab policy revision: bumped when THIS tab's policy mutates in a way
// that must invalidate its in-flight reports — an override set (adopted or
// commanded) or cleared (reset, committed navigation, tab removal). Global
// speed changes do NOT bump: they are ordinary applies that re-read live
// state, and a native choice made while such an apply is queued must still
// be honored (DESIGN.md R1/R7). Applies and reports carry the tab's rev.
let tabRevs = {}; // tabId -> int
// The tab's last COMMITTED top-level document, as webNavigation.onCommitted
// reports it: a unique documentId (Chrome 106+, min version 116 here) plus
// the URL. Overrides are scoped to the document identity — a hard reload of
// the same URL produces a NEW documentId and clears the override, while a
// same-document SPA transition (pushState, hash change) keeps it.
let committedDocs = {}; // tabId -> { url, documentId }
// Committed documents for NON-TOP frames, per tab and frame. The manager is
// injected into every frame, and each frame has its own documentId — a report
// from a current iframe document must be accepted, while a report from a
// replaced frame document must not. Top-level identity stays the basis for
// page-override scope; this map only validates report provenance.
let frameDocs = {}; // tabId -> { [frameId]: { url, documentId } }

function near(a, b) {
  return Math.abs(a - b) < 1e-6;
}

/** This tab's policy mutated: anything in flight under the old rev is stale. */
function bumpTabRev(tabId) {
  tabRevs[tabId] = (tabRevs[tabId] ?? 0) + 1;
  void chrome.storage.session.set({ speedRevs: tabRevs }).catch(() => {});
  return tabRevs[tabId];
}

function revOf(tabId) {
  return tabRevs[tabId] ?? 0;
}

/** The committed document entry for a tab (or null when none is known). */
function committedDocOf(tabId) {
  return committedDocs[tabId] ?? null;
}

/** The committed document entry for one frame (top frame included). */
function committedFrameDocOf(tabId, frameId) {
  if (frameId === 0) return committedDocs[tabId] ?? null;
  return frameDocs[tabId]?.[frameId] ?? null;
}

/**
 * Does the tab's override still belong to the tab's current committed
 * document? Compared by documentId when both sides know it (the reliable
 * signal — a same-URL reload changes it); URL comparison is the fallback
 * for entries recorded before a commit event was seen.
 */
function overrideIsCurrent(tabId) {
  const ov = overrides[tabId];
  if (!ov) return true;
  const doc = committedDocs[tabId];
  if (!doc) return true;
  if (ov.documentId && doc.documentId) return ov.documentId === doc.documentId;
  if (ov.url && doc.url) return ov.url === doc.url;
  return true;
}

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

async function persistCommitted() {
  try {
    await chrome.storage.session.set({ speedCommitted: committedDocs, speedFrameDocs: frameDocs });
  } catch {
    // storage unavailable: the in-memory map still governs this worker life
  }
}

/**
 * Tabs with an installed page manager (session-scoped mirror). Candidate
 * detection (audible ∪ muted ∪ recent ∪ pinned) can miss a tab we already
 * manage — its media paused and the recent list moved on — and a global-speed
 * change or reset must still reach every previously managed tab. Over-
 * inclusion is harmless (a disconnect to a tab without a manager no-ops).
 */
let managedTabs = new Set();

async function persistManagedTabs() {
  try {
    await chrome.storage.session.set({ speedManaged: [...managedTabs] });
  } catch {
    // storage unavailable: the in-memory set still governs this worker life
  }
}

function noteManaged(tabId) {
  if (!managedTabs.has(tabId)) {
    managedTabs.add(tabId);
    void persistManagedTabs();
  }
}

function noteUnmanaged(tabId) {
  if (managedTabs.delete(tabId)) void persistManagedTabs();
}

/** A policy needs enforcing anywhere → managers may exist in pages. */
function enforcementNeeded() {
  return Math.abs(globalSpeed - 1) > 1e-9 || Object.keys(overrides).length > 0;
}

function effectiveRate(tabId) {
  const ov = overrides[tabId];
  return ov ? ov.rate : globalSpeed;
}

async function safeTabUrl(tabId) {
  try {
    return (await chrome.tabs.get(tabId))?.url ?? null;
  } catch {
    return null; // tab gone
  }
}

async function sendToTab(tabId, msg) {
  try {
    await chrome.tabs.sendMessage(tabId, msg);
  } catch {
    // no manager in that tab yet, or the tab is gone — both fine
  }
}

async function clearOverride(tabId, resync = true) {
  if (overrides[tabId]) {
    delete overrides[tabId];
    // the override is gone — reports written under it must not resurrect it
    bumpTabRev(tabId);
    await writeOverrides(overrides);
  }
  if (resync && !enforcementNeeded()) {
    await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
  }
}

/**
 * Make one tab's speed policy real: reconcile a stale-URL override, then
 * inject/update the page manager with the effective rate — or disconnect it
 * when no policy applies. Idempotent; safe to call on every relevant event.
 *
 * adoptForeign: false marks a per-page COMMAND (the popup just set this
 * tab's rate) — the manager then overwrites pre-existing foreign rates
 * instead of adopting them, so the fresh user choice cannot be undone by a
 * stale install-time report.
 */
async function syncSpeedTab(tabId, pageUrl, adoptForeign = true) {
  return queueSpeedSync(() => rawSyncSpeedTab(tabId, pageUrl, adoptForeign));
}

// Speed syncs are serialized and read live state at run time: two rapid
// global-speed changes must never land out of order — a stale apply would
// drag a page back to an older rate and fight the newer choice.
let speedSyncChain = Promise.resolve();
function queueSpeedSync(fn) {
  const run = speedSyncChain.then(fn);
  speedSyncChain = run.catch(() => {});
  return run;
}

async function rawSyncSpeedTab(tabId, pageUrl, adoptForeign = true) {
  const url = pageUrl ?? (await safeTabUrl(tabId));
  if (url === null) {
    await clearOverride(tabId, false);
    noteUnmanaged(tabId);
    return;
  }
  // an override belongs to the tab's COMMITTED document — it never follows a
  // navigation, even to a URL that looks similar; a same-document (SPA) URL
  // change is not a committed navigation, so it leaves the override alone
  if (overrides[tabId] && !overrideIsCurrent(tabId)) {
    await clearOverride(tabId, false);
  }
  if (!enforcementNeeded()) {
    await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
    noteUnmanaged(tabId);
    return;
  }
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
  noteManaged(tabId);
  // frames that already had a manager learn the new expectation by message
  await sendToTab(tabId, { type: 'mcp-speed-apply', rate, rev: revOf(tabId) });
}

/**
 * Tabs a speed sync must reach while enforcement is active.
 *
 * The global-speed promise covers media in EXISTING tabs, and candidate
 * detection (audible/muted/recent/pinned) cannot see a silent page whose
 * media has not played yet — so every open, injectable tab is included.
 * Managers are idempotent, and this whole fan-out only ever runs while a
 * policy is active; at factory defaults nothing is injected or polled.
 * Previously managed tabs stay in the set even when non-injectable, so a
 * lifted policy still disconnects them.
 */
async function speedSyncTargets() {
  const [all, stored] = await Promise.all([
    chrome.tabs.query({}).catch(() => []),
    chrome.storage.session.get(['recent', 'target']).catch(() => ({})),
  ]);
  const ids = new Set(managedTabs);
  for (const t of all) {
    if (typeof t.id !== 'number') continue;
    if (managedTabs.has(t.id) || /^(https?|file):/i.test(t.url ?? '')) ids.add(t.id);
  }
  // recent/pinned entries keep tabs reachable in the moment after a restart
  // before their URL is populated
  if (Array.isArray(stored.recent)) {
    for (const id of stored.recent) if (typeof id === 'number') ids.add(id);
  }
  if (typeof stored.target === 'number') ids.add(stored.target);
  return [...ids];
}

async function syncSpeedEverywhere() {
  return queueSpeedSync(async () => {
    // every previously managed tab must hear the change even when it is not
    // injectable any more — otherwise a manager survives with a stale
    // expectation
    const targets = await speedSyncTargets();
    if (!enforcementNeeded()) {
      for (const tabId of targets) {
        await sendToTab(tabId, { type: 'mcp-speed-disconnect' });
        noteUnmanaged(tabId);
      }
      return;
    }
    for (const tabId of targets) {
      await rawSyncSpeedTab(tabId);
    }
  });
}

// --- boost capture -------------------------------------------------------------------
//
// Message flow (fix for the double-start bug: popup-facing and offscreen-
// facing commands use DIFFERENT types, and only this worker calls the
// capture API):
//
//   popup click (user gesture — gestures propagate through extension
//   messaging) -> 'mcp-boost-start' -> THIS WORKER calls
//   tabCapture.getMediaStreamId({targetTabId}) [only the docs-blessed
//   service-worker -> offscreen consumer path is used] -> ensures the
//   offscreen document -> forwards 'mcp-boost-offscreen-start' (the
//   offscreen document ignores everything else, so the popup's original
//   broadcast can never reach it as a second start with the same stream id).
//
// Per-tab startup serialization: while a tab's start is in flight, further
// starts for that tab are dropped (their desired gain re-applied on success),
// so exactly one capture attempt consumes the one-time stream id.
//
// Truthful state lives in storage.session ('boosts': { [tabId]: { gain, state } })
// and converges from every direction: capture failure, hung starts (12 s),
// stream end, tab close, navigation away, and a missing offscreen document —
// nothing survives a browser restart pretending capture was restored.

let boosts = {}; // tabId -> { gain, state: 'pending' | 'active' | 'error', error? }
const boostStartsInFlight = new Set(); // tabIds with a capture start pending
const pendingDesiredGain = new Map(); // tabId -> gain requested mid-start
// Per-tab capture REQUEST ID. Every async step of a start (stream id fetch,
// offscreen forward) re-checks that its request still owns the tab, and every
// result carries it — so a stop, navigation, reset or restart reliably
// cancels an in-flight capture: a resolved stream is dropped, a late result
// is ignored, and nothing can resurrect a stopped boost.
let boostReqSeq = 0;
const boostReqs = new Map(); // tabId -> request id of the current request

async function refreshBoosts() {
  try {
    const { boosts: b } = await chrome.storage.session.get('boosts');
    boosts = b && typeof b === 'object' ? b : {};
  } catch {
    boosts = {};
  }
}

async function writeBoosts() {
  try {
    await chrome.storage.session.set({ boosts });
  } catch {
    // storage unavailable; the offscreen pipeline still owns the real state
  }
}

function releaseBoostStart(tabId) {
  boostStartsInFlight.delete(tabId);
  pendingDesiredGain.delete(tabId);
}

// End-to-end startup deadline per tab, armed when the request begins — it
// covers offscreen creation, the stream-id fetch, forwarding, getUserMedia
// and graph setup, not merely the tail of the flow.
const BOOST_START_TIMEOUT_MS = 12000;
const boostTimers = new Map(); // tabId -> timeout handle

function clearBoostTimer(tabId) {
  const t = boostTimers.get(tabId);
  if (t !== undefined) {
    clearTimeout(t);
    boostTimers.delete(tabId);
  }
}

function armBoostTimeout(tabId, reqId) {
  clearBoostTimer(tabId);
  const t = setTimeout(() => {
    boostTimers.delete(tabId);
    expireBoostRequest(tabId, reqId);
  }, BOOST_START_TIMEOUT_MS);
  boostTimers.set(tabId, t);
}

/**
 * The startup deadline fired: invalidate the request, tell the offscreen
 * document to drop whatever it may already be doing for that request (the
 * id scopes the stop so a restarted request is untouched), converge the
 * state to a truthful error and release the document when idle.
 */
function expireBoostRequest(tabId, reqId) {
  if (boostReqs.get(tabId) !== reqId) return; // already superseded/cancelled
  boostReqs.delete(tabId);
  releaseBoostStart(tabId);
  void chrome.runtime.sendMessage({ type: 'mcp-boost-offscreen-stop', tabId, reqId }).catch(() => {});
  if (boosts[tabId]?.state === 'pending') {
    boosts[tabId] = { gain: clampGainPct(boosts[tabId].gain), state: 'error', error: 'Capture did not start' };
    void writeBoosts().then(() => withOffscreenGate(closeOffscreenIfIdle));
    clearBoostErrorLater(tabId);
  }
}

/**
 * Terminate one tab's own capture request with an error. The request must
 * still own the tab — a cancelled or superseded request never touches state.
 * The stop sent to the offscreen document carries the failed request's id,
 * so a request started afterwards cannot be torn down by it.
 */
function failBoostStart(tabId, reqId, error) {
  if (boostReqs.get(tabId) !== reqId) return;
  clearBoostTimer(tabId);
  boostReqs.delete(tabId);
  releaseBoostStart(tabId);
  void chrome.runtime.sendMessage({ type: 'mcp-boost-offscreen-stop', tabId, reqId }).catch(() => {});
  if (boosts[tabId]?.state === 'pending') {
    boosts[tabId] = { gain: clampGainPct(boosts[tabId].gain), state: 'error', error };
    void writeBoosts().then(() => withOffscreenGate(closeOffscreenIfIdle));
    clearBoostErrorLater(tabId);
  }
}

function clampGainPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 100;
  return Math.min(600, Math.max(100, Math.round(n)));
}

// Serialize offscreen document create/close so a start racing an idle-close
// cannot drop the start message.
let offscreenGate = Promise.resolve();
function withOffscreenGate(fn) {
  const run = offscreenGate.then(fn);
  offscreenGate = run.catch(() => {});
  return run;
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // USER_MEDIA is the documented reason for documents interacting with
    // media streams (getUserMedia) and sets NO lifetime limit; AUDIO_PLAYBACK
    // would let Chrome close the document after 30 s without audio — which
    // would silently kill the pipeline while a boosted tab is merely paused.
    reasons: ['USER_MEDIA'],
    justification:
      'Volume boost: consume the captured tab-audio stream and process it locally with a Web Audio gain node. No recording, no network.',
  });
}

async function closeOffscreenIfIdle() {
  // error entries are not pipelines: only a pending start or an active chain
  // keeps the document alive
  const busy = Object.values(boosts).some((b) => b && b.state !== 'error');
  if (busy) return;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (contexts.length) await chrome.offscreen.closeDocument();
  } catch {
    // already closed or shutting down
  }
}

/**
 * Lifecycle reconciliation, called at worker start and on popup open.
 *
 * - If the session claims boosts but no offscreen document exists, the
 *   pipeline is gone (browser closed it, crash, extension update) — the
 *   state must tell the truth.
 * - On a WORKER RESTART (startup = true) no capture request can be in
 *   flight, so a 'pending' entry is orphaned by definition: it is converged
 *   to a truthful error instead of staying stuck forever. (On a popup-open
 *   sync the in-memory request maps still know the difference, so live
 *   startups are left alone.)
 *
 * Lazy — no polling.
 */
async function reconcileBoosts(startup = false) {
  let live = true;
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    live = contexts.length > 0;
  } catch {
    return; // cannot tell — do not lie in either direction
  }
  let changed = false;
  if (startup) {
    for (const [id, b] of Object.entries(boosts)) {
      if (b && b.state === 'pending') {
        boosts[id] = { gain: clampGainPct(b.gain), state: 'error', error: 'Capture did not start' };
        changed = true;
        clearBoostErrorLater(Number(id));
      }
    }
  }
  if (!live && Object.keys(boosts).some((id) => boosts[id]?.state !== 'error')) {
    boostStartsInFlight.clear();
    pendingDesiredGain.clear();
    boostReqs.clear();
    for (const t of boostTimers.values()) clearTimeout(t);
    boostTimers.clear();
    boosts = {};
    changed = true;
  }
  if (changed) {
    await writeBoosts();
    void withOffscreenGate(closeOffscreenIfIdle);
  }
}

/** Stop one tab's boost from the worker side (navigation, tab removal). */
async function stopBoostForTab(tabId) {
  // cancelling the request id aborts every pending step of an in-flight
  // start (stream-id fetch, offscreen forward, in-flight getUserMedia); the
  // id travels with the stop so a DELAYED stop from an older request can
  // never tear down a newer, restarted pipeline
  clearBoostTimer(tabId);
  const reqId = boostReqs.get(tabId);
  boostReqs.delete(tabId);
  releaseBoostStart(tabId);
  // deliver the pipeline stop BEFORE the state clears: a caller (or a fast
  // restart) that observes the cleared state must never race a trailing stop
  await chrome.runtime.sendMessage({ type: 'mcp-boost-offscreen-stop', tabId, reqId }).catch(() => {});
  if (boosts[tabId]) {
    delete boosts[tabId];
    await writeBoosts();
  }
  await withOffscreenGate(closeOffscreenIfIdle);
}

function clearBoostErrorLater(tabId) {
  setTimeout(() => {
    if (boosts[tabId]?.state === 'error') {
      delete boosts[tabId];
      void writeBoosts().then(() => withOffscreenGate(closeOffscreenIfIdle));
    }
  }, 8000);
}

// --- extension messages ------------------------------------------------------------
//
// Senders: page managers (mcp-speed-report), the popup (speed + boost
// commands), and the offscreen document (boost results). Message objects are
// broadcast to every extension context; each context routes by type.

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || typeof msg.type !== 'string' || !msg.type.startsWith('mcp-')) return;
  void routeMessage(msg, sender).catch(() => {});
});

async function routeMessage(msg, sender) {
  switch (msg.type) {
    // --- from page managers --------------------------------------------------
    case 'mcp-speed-report': {
      const tabId = sender.tab?.id;
      if (typeof tabId !== 'number' || !Number.isFinite(msg.rate)) return;
      // R1: a report is honored only under the policy revision it was
      // enforced under — anything else is a stale page speaking about a
      // superseded policy (pre-reset, pre-navigation, pre-page-command).
      // Global-speed changes don't advance the tab rev, so a native choice
      // made while a global apply is queued is still honored.
      if (msg.rev !== revOf(tabId)) return;
      // frame-aware provenance: the manager runs in every frame, and each
      // frame has its own documentId — validate the report against the
      // committed document of the FRAME it came from. A current iframe
      // document is accepted; a replaced/navigated-away document is not.
      const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
      const frameDoc = committedFrameDocOf(tabId, frameId);
      if (frameDoc?.documentId && sender.documentId && sender.documentId !== frameDoc.documentId) {
        return;
      }
      // the page override belongs to the tab's committed TOP-LEVEL document,
      // whichever frame the native change came from
      const committed = committedDocOf(tabId);
      const url = committed?.url ?? sender.tab?.url ?? (await safeTabUrl(tabId));
      if (url === null) return;
      if (near(msg.rate, globalSpeed)) {
        // a native change landing exactly on the global rate is inheritance
        await clearOverride(tabId);
        if (enforcementNeeded()) {
          await sendToTab(tabId, { type: 'mcp-speed-apply', rate: globalSpeed, rev: revOf(tabId) });
        }
      } else {
        overrides[tabId] = {
          url,
          documentId: committed?.documentId ?? sender.documentId,
          rate: msg.rate,
          at: Date.now(),
        };
        bumpTabRev(tabId);
        await writeOverrides(overrides);
        // apply, not re-injection: re-running adopt here could re-report the
        // other elements of a multi-rate page and churn the fresh override
        await sendToTab(tabId, { type: 'mcp-speed-apply', rate: msg.rate, rev: revOf(tabId) });
      }
      return;
    }

    // --- from the popup --------------------------------------------------------
    case 'mcp-speed-page': {
      const { tabId, rate } = msg;
      if (typeof tabId !== 'number' || !Number.isFinite(rate)) return;
      const committed = committedDocOf(tabId);
      const url = committed?.url ?? (await safeTabUrl(tabId));
      if (url === null) return;
      overrides[tabId] = {
        url,
        documentId: committed?.documentId,
        rate: clampSpeed(rate),
        at: Date.now(),
      };
      bumpTabRev(tabId);
      await writeOverrides(overrides);
      // adoptForeign: false — the user just chose this tab's rate; a stale
      // install-time report must not adopt the old element rate over it
      await syncSpeedTab(tabId, url, false);
      return;
    }
    case 'mcp-speed-reset': {
      if (typeof msg.tabId !== 'number') return;
      await clearOverride(msg.tabId);
      // adoptForeign: false — reset is a user command, like a page-speed
      // choice: it reaches paused media and overwrites pre-existing foreign
      // rates instead of adopting them back as a resurrected override
      if (enforcementNeeded()) await syncSpeedTab(msg.tabId, undefined, false);
      return;
    }
    case 'mcp-speed-sync': {
      // popup open (or install): reconcile every candidate tab once, and
      // check the boost pipeline's existence against the session truth
      await refreshSpeedState();
      await syncSpeedEverywhere();
      await reconcileBoosts();
      return;
    }

    // --- boost: popup -> this worker -> offscreen --------------------------------
    case 'mcp-boost-start': {
      const { tabId, gain } = msg;
      if (typeof tabId !== 'number') return;
      if (boostStartsInFlight.has(tabId)) {
        // one capture attempt per tab at a time; remember what the user
        // asked for so the running attempt can end there
        pendingDesiredGain.set(tabId, clampGainPct(gain));
        return;
      }
      boostStartsInFlight.add(tabId);
      const reqId = ++boostReqSeq;
      boostReqs.set(tabId, reqId);
      boosts[tabId] = { gain: clampGainPct(gain), state: 'pending' };
      await writeBoosts();
      // the deadline covers the WHOLE startup, from here to graph setup
      armBoostTimeout(tabId, reqId);
      try {
        // prepare the consumer BEFORE generating the stream id: the id is
        // single-use and expires after a few seconds, so no slow document
        // setup may sit between generating it and forwarding it
        await withOffscreenGate(async () => {
          if (boostReqs.get(tabId) !== reqId) return;
          await ensureOffscreen();
        });
        // ownership after offscreen creation — a stop during document setup
        // must abort before the one-time id is even requested
        if (boostReqs.get(tabId) !== reqId) return;
        let streamId;
        try {
          // the popup's click is the invocation; the gesture rides the message
          streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
        } catch (e) {
          failBoostStart(tabId, reqId, String(e?.message ?? e));
          return;
        }
        if (boostReqs.get(tabId) !== reqId) {
          return; // cancelled while the stream id was being fetched
        }
        // offscreen-facing type: the offscreen document ignores everything
        // else, so the popup's original broadcast cannot double-start here
        await chrome.runtime
          .sendMessage({ type: 'mcp-boost-offscreen-start', tabId, streamId, gain, reqId })
          .catch(() => {});
      } catch (e) {
        failBoostStart(tabId, reqId, String(e?.message ?? e));
      }
      return;
    }
    case 'mcp-boost-gain': {
      const { tabId, gain } = msg;
      if (typeof tabId !== 'number') return;
      const g = clampGainPct(gain);
      if (boostStartsInFlight.has(tabId)) {
        // the capture attempt is still consuming its stream id; deliver the
        // user's latest choice once it lands
        pendingDesiredGain.set(tabId, g);
      } else {
        await chrome.runtime
          .sendMessage({ type: 'mcp-boost-offscreen-gain', tabId, gain: g })
          .catch(() => {});
      }
      if (boosts[tabId] && boosts[tabId].state !== 'error') {
        boosts[tabId] = { gain: g, state: boosts[tabId].state || 'active' };
        await writeBoosts();
      }
      return;
    }
    case 'mcp-boost-stop': {
      const { tabId } = msg;
      if (typeof tabId !== 'number') return;
      await stopBoostForTab(tabId);
      return;
    }

    // --- boost: from the offscreen document --------------------------------------
    case 'mcp-boost-result': {
      const { tabId, ok, gain, error, reqId } = msg;
      if (typeof tabId !== 'number') return;
      // the user's latest mid-startup gain choice, read BEFORE any release —
      // the successful capture must land exactly there
      const desired = pendingDesiredGain.get(tabId);
      if (boostReqs.get(tabId) !== reqId) {
        // a stale result for a cancelled or superseded request: it owns
        // nothing — never overwrite a newer gain, never resurrect a stop
        return;
      }
      const cur = boosts[tabId];
      if (!cur || cur.state !== 'pending') {
        // no live pending request even though the id matched — the boost was
        // stopped without a request change; release and move on
        boostReqs.delete(tabId);
        releaseBoostStart(tabId);
        return;
      }
      if (ok) {
        const applied = clampGainPct(gain);
        const finalGain = desired !== undefined ? desired : applied;
        clearBoostTimer(tabId);
        // the request id stays: it identifies the LIVE pipeline, so a later
        // stop carries it and cannot tear down a restarted pipeline
        releaseBoostStart(tabId);
        boosts[tabId] = { gain: finalGain, state: 'active' };
        await writeBoosts();
        if (finalGain !== applied) {
          // the pipeline was built at the start gain; move it to the user's
          // latest choice without restarting the capture
          await chrome.runtime
            .sendMessage({ type: 'mcp-boost-offscreen-gain', tabId, gain: finalGain })
            .catch(() => {});
        }
      } else {
        clearBoostTimer(tabId);
        boostReqs.delete(tabId);
        releaseBoostStart(tabId);
        boosts[tabId] = {
          gain: clampGainPct(cur.gain),
          state: 'error',
          error: String(error ?? 'Capture failed'),
        };
        await writeBoosts();
        // no pipeline exists for a failed capture: release the document
        void withOffscreenGate(closeOffscreenIfIdle);
        clearBoostErrorLater(tabId);
      }
      return;
    }
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
  }
}

// --- tab events -----------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.audible !== undefined) {
    void updateBadge();
    if (info.audible === true) void noteRecent(tabId);
  }
  // boost: the product rule is that a boost belongs to the page it was
  // started on — ANY url change stops it. This covers ordinary navigation
  // AND SPA/pushState transitions (both fire onUpdated with a url change).
  // The platform itself would keep in-tab capture alive; we release it.
  // webNavigation below is the authoritative source; this is the belt.
  if (info.url !== undefined) void onTabNavigated(tabId);
  // speed: media state, page identity or load completion changed — reconcile.
  // All checks before this line are memory reads; syncSpeedTab is idempotent.
  if (info.audible !== undefined || info.url !== undefined || info.status === 'complete') {
    if (enforcementNeeded()) void syncSpeedTab(tabId, info.url);
  }
});

// Navigation identity, from the documented API. tabs.onUpdated sees every URL
// change but cannot tell a committed navigation from a same-document SPA
// transition — webNavigation can, and the override scope depends on it.

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

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  // same-document transition: the page keeps its override (R2/R3), but a
  // boost belongs to the URL it was started on — release it
  void onTabNavigated(details.tabId);
  if (enforcementNeeded()) void syncSpeedTab(details.tabId);
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  if (details.frameId !== 0 || details.tabId < 0) return;
  // hash-only change: still the same document (the override survives — this
  // event deliberately touches no speed state), but the URL the boost was
  // started on is gone
  void onTabNavigated(details.tabId);
});

/** Record a subframe's committed document (frameId > 0). */
function noteFrameCommit(tabId, frameId, url, documentId) {
  const forTab = frameDocs[tabId] ?? (frameDocs[tabId] = {});
  forTab[frameId] = { url, documentId };
  void persistCommitted();
}

async function onCommittedNavigation(tabId, url, documentId) {
  const previous = committedDocs[tabId];
  committedDocs[tabId] = { url, documentId };
  // the old top-level page is gone — its frame documents went with it (the
  // new page's frames repopulate this as they commit)
  if (frameDocs[tabId]) delete frameDocs[tabId];
  void persistCommitted();
  // a committed navigation replaces the document — the old page's override
  // dies with it (a hard reload of the SAME URL counts: new documentId).
  // It is a policy mutation, so the tab rev advances with it.
  if (previous && overrides[tabId] && !overrideIsCurrent(tabId)) {
    await clearOverride(tabId, false);
  }
  await onTabNavigated(tabId);
  if (enforcementNeeded()) void syncSpeedTab(tabId, url);
}

async function onTabNavigated(tabId) {
  if (!boosts[tabId] && !boostStartsInFlight.has(tabId)) return;
  await stopBoostForTab(tabId);
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void updateBadge();
  void pruneRecent(tabId);
  void onTabGone(tabId);
});

async function onTabGone(tabId) {
  if (overrides[tabId]) {
    delete overrides[tabId];
    bumpTabRev(tabId);
    await writeOverrides(overrides);
  }
  if (committedDocs[tabId] !== undefined || frameDocs[tabId] !== undefined) {
    delete committedDocs[tabId];
    delete frameDocs[tabId];
    void persistCommitted();
  }
  if (tabRevs[tabId] !== undefined) {
    delete tabRevs[tabId];
    void chrome.storage.session.set({ speedRevs: tabRevs }).catch(() => {});
  }
  noteUnmanaged(tabId);
  if (boosts[tabId] || boostStartsInFlight.has(tabId)) {
    await stopBoostForTab(tabId);
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) void refreshSettings();
  if (area === 'local' && changes.speed) {
    globalSpeed = clampSpeed(changes.speed.newValue);
    void syncSpeedEverywhere();
  }
  // speedOverrides is NOT re-read here: this worker is its only writer, and
  // re-reading own writes lets a slow earlier write regress the cache (two
  // rapid page-speed commands would resurrect the older rate on the next
  // sync). The in-memory map is the truth while this worker lives; storage is
  // persistence, reloaded by refreshSpeedState on startup. The same applies
  // to speedCommitted. speedRevs merges monotonically below for the same
  // reason. 'boosts' keeps its listener: test rigs seed it directly, and the
  // offscreen truth must always win over a stale in-memory copy.
  if (area === 'session' && changes.boosts) {
    boosts = changes.boosts.newValue ?? {};
  }
  if (area === 'session' && changes.speedRevs && typeof changes.speedRevs.newValue === 'object') {
    for (const [tabId, rev] of Object.entries(changes.speedRevs.newValue)) {
      if (typeof rev === 'number' && rev > (tabRevs[Number(tabId)] ?? 0)) {
        tabRevs[Number(tabId)] = rev; // monotonic per tab, never moved back
      }
    }
  }
});

chrome.runtime.onInstalled.addListener(() => {
  void chrome.action.setBadgeBackgroundColor({ color: '#e30613' });
  void chrome.action.setBadgeTextColor({ color: '#ffffff' });
  void refreshSettings();
  void refreshSpeedState().then(() => syncSpeedEverywhere());
});

// initial state after every worker start — the speed re-sync is what makes
// enforcement self-healing after the worker was killed and re-spawned, and
// the boost reconciliation makes a vanished offscreen document converge on
// truthful (cleared) state
void (async () => {
  await refreshSettings();
  await refreshSpeedState();
  await refreshBoosts();
  await reconcileBoosts(true); // a fresh worker: no startup can be in flight
  await updateBadge();
  if (enforcementNeeded()) void syncSpeedEverywhere();
})();

// --- keyboard commands ------------------------------------------------------------

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command);
});

async function handleCommand(command) {
  if (command === 'pause-all') {
    // every tab that could be playing: sounding now, or media tabs from this
    // session (muted playback isn't audible but still needs pausing);
    // pagePause no-ops on tabs with nothing playing
    const [audible, stored] = await Promise.all([
      chrome.tabs.query({ audible: true }),
      chrome.storage.session.get('recent').catch(() => ({})),
    ]);
    const ids = new Set(audible.map((t) => t.id).filter((id) => id !== undefined));
    if (Array.isArray(stored.recent)) {
      for (const id of stored.recent) if (typeof id === 'number') ids.add(id);
    }
    for (const tabId of ids) {
      chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: pagePause })
        .catch(() => {});
    }
    return;
  }

  if (command === 'mute-all') {
    const audible = await chrome.tabs.query({ audible: true });
    const anyUnmuted = audible.some((t) => !t.mutedInfo?.muted);
    if (anyUnmuted) {
      for (const t of audible) {
        if (t.id !== undefined && !t.mutedInfo?.muted) {
          void chrome.tabs.update(t.id, { muted: true }).catch(() => {});
        }
      }
    } else {
      // everything audible is muted: unmute what this extension muted
      const muted = await chrome.tabs.query({ muted: true });
      for (const t of muted) {
        if (t.id !== undefined && t.mutedInfo?.reason === 'extension') {
          void chrome.tabs.update(t.id, { muted: false }).catch(() => {});
        }
      }
    }
    return;
  }

  if (command === 'toggle-target') {
    const stored = await chrome.storage.session.get('target').catch(() => ({}));
    const tabId = stored.target;
    if (typeof tabId !== 'number') return;
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return;
    } catch {
      // target tab is gone; drop the pin
      void chrome.storage.session.remove('target').catch(() => {});
      return;
    }
    try {
      // find the frame that owns the primary element, toggle only there —
      // an allFrames toggle would double-fire on multi-frame pages
      const results = await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: pageProbe,
      });
      const frames = results.filter((r) => r.result?.elements?.length);
      let frameId = frames.find((r) => r.result.elements.some((e) => e.playing))?.frameId;
      frameId ??= frames[0]?.frameId;
      const target = frameId !== undefined ? { tabId, frameIds: [frameId] } : { tabId, allFrames: true };
      await chrome.scripting.executeScript({ target, func: pageToggle });
    } catch {
      // probe failed but the tab exists: last-resort toggle everywhere
      chrome.scripting
        .executeScript({ target: { tabId, allFrames: true }, func: pageToggle })
        .catch(() => {});
    }
  }
}

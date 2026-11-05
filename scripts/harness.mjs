// Browser harness runner: loads the two mock pages in a real headless
// browser — Google Chrome by default, Edge via MCP_BROWSER=edge — and reports
// their results. No extension is installed here: the pages run the real
// background.js / popup.js against an in-memory chrome.* mock.
//
//   node scripts/harness.mjs     (also: npm run harness)
//
//   - test/background-mock.html runs its assertions on load and encodes the
//     outcome in document.title ("PASS (n) — background harness" / "FAILED (n)").
//   - test/popup-mock.html drives the real popup UI against the mock browser;
//     it has no assertions — the runner fails on any page exception or console
//     error while it runs.
//
// Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { browserName, browserPath as browserPathOf, browserVersion, ensureExtension, extensionArgs } from './browser.mjs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 9227;
const SERVE_PORT = 8080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.pageErrors = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const text = String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
        // Edge injects its own password-manager script into pages; its errors
        // are browser-internal noise, not the harness page's code
        if (/passwordalert is not defined/i.test(text)) return;
        this.pageErrors.push(text.slice(0, 400));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        if (/passwordalert is not defined/i.test(text)) return;
        this.pageErrors.push(text.slice(0, 400));
      }
    });
  }
  send(method, params = {}, sessionId, timeoutMs = 20000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, timeoutMs);
    });
  }
}

async function evalIn(cdp, sessionId, expression, awaitPromise = false, timeoutMs = 20000) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    sessionId,
    timeoutMs,
  );
  if (r.exceptionDetails) {
    throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

async function waitFor(fn, ms = 15000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep polling
    }
    if (Date.now() - t0 > ms) throw new Error('waitFor: condition not met in time');
    await sleep(step);
  }
}

/**
 * Run one background-style harness page (asserts on load, encodes the
 * outcome in document.title, renders .pass/.fail divs) and print its lines.
 * Used for background-mock.html and the background-restart.html scenarios.
 */
async function runHarnessPage(cdp, url, label) {
  const target = await cdp.send('Target.createTarget', { url });
  const session = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, session);
  let lastProgress = '';
  const title = await waitFor(
    () =>
      evalIn(cdp, session, `document.title`).then((t) => {
        if (t !== lastProgress) {
          lastProgress = t;
          console.log('  ..', String(t).slice(0, 110));
        }
        return /^(PASS|FAILED) \(/.test(t) ? t : null;
      }),
    120000,
  ).catch((e) => {
    // surface what the page reported instead of failing blind
    const errs = cdp.pageErrors.join('\n  ');
    throw new Error(`${label} never finished: ${e.message}\n  page errors:\n  ${errs}`);
  });
  const lines = await evalIn(
    cdp,
    session,
    `[...document.querySelectorAll('.pass, .fail')].map(d => d.className + ' ' + d.textContent.trim())`,
  );
  for (const line of lines) console.log(`  ${line}`);
  return { title, lines };
}

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'mcp-harness-'));
  let browserProcess = null;
  let ws = null;
  let failed = false;

  try {
    // a zombie browser from a killed/failed run holds the debug port; attaching
    // to it would drive a stale session (old tabs, old extension) and produce
    // phantom assertions — refuse to run instead
    if (!(await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => false, () => true))) {
      throw new Error(`debug port ${PORT} is already in use — kill the leftover test browser first`);
    }
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/test/background-mock.html`);
      return r.ok;
    }, 8000);

    const browserPath = browserPathOf();
    console.log(`browser: ${browserName()} ${browserVersion(browserPath) ?? '(version unknown)'} — ${browserPath}`);
    browserProcess = spawn(
      browserPath,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        // the mock pages are background targets: without these, Chromium
        // clamps their timers to >=1 s and the delayed-operation tests crawl
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--autoplay-policy=no-user-gesture-required',
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    const wsUrl = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      const j = await r.json();
      return j.webSocketDebuggerUrl;
    }, 30000);
    ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new Cdp(ws);

    // --- background command + speed harness --------------------------------
    const bg = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/background-mock.html`,
    });
    const bgSession = (await cdp.send('Target.attachToTarget', { targetId: bg.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, bgSession);
    // temporary MCPDBG diagnostics from the page (worker + offscreen) print inline
    cdp.ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
          if (text.includes('MCPDBG')) console.log('  BG:', text.slice(0, 220));
        }
      } catch {}
    });
    let lastProgress = '';
    const bgTitle = await waitFor(
      () =>
        evalIn(cdp, bgSession, `document.title`).then((t) => {
          if (t !== lastProgress) {
            lastProgress = t;
            console.log('  ..', String(t).slice(0, 110));
          }
          return /^(PASS|FAILED) \(/.test(t) ? t : null;
        }),
      120000,
    ).catch((e) => {
      // surface what the page reported instead of failing blind
      const errs = cdp.pageErrors.join('\n  ');
      throw new Error(`background-mock never finished: ${e.message}\n  page errors:\n  ${errs}`);
    });
    const bgResults = await evalIn(
      cdp,
      bgSession,
      `[...document.querySelectorAll('.pass, .fail')].map(d => d.className + ' ' + d.textContent.trim())`,
    );
    for (const line of bgResults) console.log(`  ${line}`);
    if (!bgTitle.startsWith('PASS')) {
      failed = true;
      console.error(`FAIL  background-mock: ${bgTitle}`);
    } else {
      console.log(`  ok  background-mock: ${bgTitle}`);
    }

    // --- background cold-start / restart scenarios ----------------------------
    // Each page loads a FRESH module instance against a pre-seeded session —
    // the deterministic stand-in for a worker restart (a page cannot re-import
    // a module with fresh state).
    for (const [url, label] of [
      [`http://127.0.0.1:${SERVE_PORT}/test/background-restart.html?scenario=cold-race`, 'background-restart cold-race'],
      [`http://127.0.0.1:${SERVE_PORT}/test/background-restart.html?scenario=restart-reconcile&doc=1`, 'background-restart reconcile (doc live)'],
      [`http://127.0.0.1:${SERVE_PORT}/test/background-restart.html?scenario=restart-reconcile&doc=0`, 'background-restart reconcile (doc gone)'],
    ]) {
      const { title } = await runHarnessPage(cdp, url, label);
      if (!title.startsWith('PASS')) {
        failed = true;
        console.error(`FAIL  ${label}: ${title}`);
      } else {
        console.log(`  ok  ${label}: ${title}`);
      }
    }

    // --- popup mock harness (smoke: real popup.js against the mock) ----------
    const pm = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/popup-mock.html`,
    });
    const pmSession = (await cdp.send('Target.attachToTarget', { targetId: pm.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, pmSession);
    // rows, probes and fake background traffic settle asynchronously; poll for
    // the first row instead of a fixed sleep (init time varies with machine
    // load, and the interactions below assume a row exists)
    const pmReady = await waitFor(
      () => evalIn(cdp, pmSession, `document.querySelectorAll('.row').length >= 1`),
      15000,
    ).catch(() => false);
    await sleep(600); // probes + first ping pass
    const pmRows = await evalIn(cdp, pmSession, `document.querySelectorAll('.row').length`);
    if (!pmReady || pmRows < 1) {
      console.error('FAIL  popup-mock never produced a row');
      failed = true;
    }
    // exercise the visible interactions once: global speed + a card stepper
    const pmState = await evalIn(
      cdp,
      pmSession,
      `(async () => {
         // every popover starts collapsed → inert from creation
         const initialInert = [...document.querySelectorAll('.popover')].every((p) => p.hasAttribute('inert'));
         document.getElementById('gspeed-inc').click();
         await new Promise((r) => setTimeout(r, 150));
         const rows = [...document.querySelectorAll('.row')];
         const withMedia = rows.find((r) => !r.querySelector('.rate-dec').disabled);
         if (withMedia) {
           withMedia.querySelector('.rate-inc').click();
           await new Promise((r) => setTimeout(r, 150));
         }
         // appearance: all three preferences repaint through html[data-theme]
         document.getElementById('settings-toggle').click();
         const theme = {};
         for (const value of ['dark', 'light', 'system']) {
           document.querySelector('[data-theme-value="' + value + '"]').click();
           await new Promise((r) => setTimeout(r, 80));
           theme[value] = {
             attr: document.documentElement.dataset.theme,
             paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
             stored: (await chrome.storage.local.get('settings')).settings?.theme,
           };
         }
         // slider increments
         const first = document.querySelector('.row');
         const volStep = first.querySelector('.vol').step;
         const boostStep = first.querySelector('.boost').step;
         // quick mute must stay muted while the ping loop runs
         first.querySelector('.mute').click();
         await new Promise((r) => setTimeout(r, 3300));
         const mute = {
           aria: first.querySelector('.mute').getAttribute('aria-label'),
           badge: !first.querySelector('.eq-muted').hidden,
           browser: chrome._mock.tabs.get(1).mutedInfo.muted,
         };
         first.querySelector('.mute').click();
         await new Promise((r) => setTimeout(r, 200));
         mute.afterUnmute = first.querySelector('.mute').getAttribute('aria-label');
         // volume popover: the two independent audio truths, and the
         // player-audio toggle writing the element (not the tab)
         first.querySelector('.vol-btn').click();
         await new Promise((r) => setTimeout(r, 250));
         const audioTruths = {
           tab: first.querySelector('.vol-state.tab-audio .vs-value').textContent,
           player: first.querySelector('.vol-state.player-audio .vs-value').textContent,
         };
         first.querySelector('.vol-state.player-audio').click();
         await new Promise((r) => setTimeout(r, 350));
         audioTruths.playerAfterToggle =
           first.querySelector('.vol-state.player-audio .vs-value').textContent;
         audioTruths.elementMuted = chrome._mock.tabs.get(1)._elements[0].muted;
         audioTruths.tabStillUnmuted = !chrome._mock.tabs.get(1).mutedInfo.muted;
         first.querySelector('.vol-state.player-audio').click();
         await new Promise((r) => setTimeout(r, 350));
         audioTruths.playerRestored =
           first.querySelector('.vol-state.player-audio .vs-value').textContent;
         audioTruths.elementRestored = chrome._mock.tabs.get(1)._elements[0].muted;
         // a volume change on an adapter-host row also invokes the MAIN-world
         // player-API sync — the private-player channel (the YouTube case)
         const volMove = first.querySelector('.vol');
         volMove.value = '0.45';
         volMove.dispatchEvent(new Event('input', { bubbles: true }));
         volMove.dispatchEvent(new Event('change', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 500));
         audioTruths.playerSyncWired = chrome._mock.scriptingCalls.some(
           (c) => c.func === 'ytSyncPlayer' && c.world === 'MAIN' && c.target.tabId === 1,
         );
         // closed popovers are inert (out of the tab order and the a11y
         // tree); the open one is interactive; click-away re-inerts all
         const popInert = (() => {
           const pops = [...document.querySelectorAll('.popover')];
           const openPop = pops.find((p) => p.classList.contains('open'));
           const openOk =
             !!openPop &&
             !openPop.hasAttribute('inert') &&
             pops.filter((p) => p !== openPop).every((p) => p.hasAttribute('inert'));
           document.body.click();
           const closedOk = pops.every((p) => p.hasAttribute('inert'));
           return { openOk, closedOk, initialInert };
         })();
         return {
           rows: rows.length,
           gspeed: document.getElementById('gspeed-value').textContent,
           overridden: rows.some((r) => r.querySelector('.speed-cluster').classList.contains('overridden')),
           theme,
           volStep,
           boostStep,
           mute,
           audioTruths,
           popInert,
         };
       })()`,
      true,
    );
    // boost UI in its OWN evaluate (the belt-fairness scenario runs ~16 s in
    // the page — past the default CDP timeout for a single evaluate)
    const boost = await evalIn(
      cdp,
      pmSession,
      `(async () => {
         const first = document.querySelector('.row');
         first.querySelector('.boost-btn').click();
         await new Promise((r) => setTimeout(r, 150));
         const out = {};
         const bslider = first.querySelector('.boost');
         bslider.value = '250';
         bslider.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 300));
         out.activeGain = (await chrome.storage.session.get('boosts')).boosts?.[1]?.gain;
         bslider.value = '300';
         bslider.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 300));
         out.gainMoved = (await chrome.storage.session.get('boosts')).boosts?.[1]?.gain;
         first.querySelector('.boost-reset').click();
         await new Promise((r) => setTimeout(r, 200));
         out.stopped = !(await chrome.storage.session.get('boosts')).boosts?.[1];
         // belt fairness: attempt 1 fails fast (belt-1 armed at t≈0, deadline
         // t≈15); attempt 2 starts ~1 s later and is HELD pending — pre-fix,
         // belt-1 fires at t≈15 over the legitimately pending attempt and
         // stamps "Capture did not start"; post-fix, attempt 2 re-armed the
         // belt (belt-1 gone) and the start lands before attempt 2's own belt
         chrome._mock.boostFailNext = true;
         bslider.value = '150';
         bslider.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 150));
         out.failText = first.querySelector('.boost-status').textContent;
         await new Promise((r) => setTimeout(r, 850)); // attempt 2 ~1 s after attempt 1
         chrome._mock.boostHoldPending = true;
         bslider.value = '160';
         bslider.dispatchEvent(new Event('input', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 150));
         out.retryPending = first.querySelector('.boost-readout').textContent === '…';
         const errorsSeen = new Set();
         const releaseAt = Date.now() + 14200; // before attempt 2's own belt (≈16 s)
         while (Date.now() < releaseAt) {
           errorsSeen.add(first.querySelector('.boost-status').textContent);
           await new Promise((r) => setTimeout(r, 400));
         }
         chrome._mock.boostHoldPending = false; // the start lands, pipeline goes active
         const beltDeadline = Date.now() + 4000;
         while (Date.now() < beltDeadline) {
           errorsSeen.add(first.querySelector('.boost-status').textContent);
           const st = (await chrome.storage.session.get('boosts')).boosts?.[1];
           if (st?.state === 'active') break;
           await new Promise((r) => setTimeout(r, 300));
         }
         out.noLyingError = !errorsSeen.has('Capture did not start');
         out.finalActive = (await chrome.storage.session.get('boosts')).boosts?.[1]?.state === 'active';
         first.querySelector('.boost-reset').click();
         await new Promise((r) => setTimeout(r, 200));
         return out;
       })()`,
      true,
      45000,
    );
    // popup state reliability: adapter refresh, ghost-override fallback,
    // authoritative volume commit (each pins one plans/006 fix)
    const reliability = await evalIn(
      cdp,
      pmSession,
      `(async () => {
         const rowFor = (needle) =>
           [...document.querySelectorAll('.row')].find((r) =>
             r.querySelector('.t-title').textContent.includes(needle));
         const out = {};
         // adapter click refreshes the card even when paused (no ping loop
         // runs for a paused card): the click must schedule a ping
         chrome._mock.toggle(1); // pause tab 1's element
         await new Promise((r) => setTimeout(r, 300));
         const ytRow = rowFor('Big Buck Bunny —');
         const callsBefore = chrome._mock.scriptingCalls.length;
         const clicksBefore = chrome._mock.tabs.get(1)._clicks.next ?? 0;
         ytRow.querySelector('.next').click();
         await new Promise((r) => setTimeout(r, 700));
         const newCalls = chrome._mock.scriptingCalls.slice(callsBefore);
         out.adapterClicked = (chrome._mock.tabs.get(1)._clicks.next ?? 0) === clicksBefore + 1;
         out.adapterPingFollowed = newCalls.some((c) => c.func === 'pagePing');
         chrome._mock.toggle(1); // restore playback
         await new Promise((r) => setTimeout(r, 150));
         // page-speed fallback: a command that never lands must restore the
         // stored truth, not leave a ghost override
         chrome._mock.refuseSpeedPage = true;
         const nfRow = rowFor('Netflix');
         nfRow.querySelector('.rate-inc').click();
         await new Promise((r) => setTimeout(r, 400));
         out.ghostShownOptimistic =
           nfRow.querySelector('.speed-cluster').classList.contains('overridden');
         await new Promise((r) => setTimeout(r, 3300));
         out.ghostGone = !nfRow.querySelector('.speed-cluster').classList.contains('overridden') &&
           nfRow.querySelector('.rate-reset').hidden === true;
         // the ghost never reached the store (tab 1's real override remains)
         const ovsAfter = (await chrome.storage.session.get('speedOverrides')).speedOverrides ?? {};
         out.ghostNotInStore = !ovsAfter[3];
         // volume commit adopts the applied value: the readout holds across
         // ping ticks instead of being dragged back by a straddling ping
         const vRow = rowFor('Big Buck Bunny —');
         vRow.querySelector('.vol-btn').click();
         await new Promise((r) => setTimeout(r, 250));
         const vol = vRow.querySelector('.vol');
         vol.value = '0.3';
         vol.dispatchEvent(new Event('input', { bubbles: true }));
         vol.dispatchEvent(new Event('change', { bubbles: true }));
         await new Promise((r) => setTimeout(r, 1200));
         const r1 = vRow.querySelector('.vol-readout').textContent;
         await new Promise((r) => setTimeout(r, 1200));
         const r2 = vRow.querySelector('.vol-readout').textContent;
         out.volumeStable = r1 === '30%' && r2 === '30%';
         document.body.click(); // close the popover
         return out;
       })()`,
      true,
    );
    // let any async fallout surface
    await sleep(800);
    const themeOk =
      pmState?.theme?.dark?.attr === 'dark' &&
      pmState.theme.dark.paper === '#141414' &&
      pmState.theme.dark.stored === 'dark' &&
      pmState.theme.light?.attr === 'light' &&
      pmState.theme.light.paper === '#ffffff' &&
      pmState.theme.light.stored === 'light' &&
      pmState.theme.system?.attr === 'system' &&
      pmState.theme.system.stored === 'system';
    const stepsOk = pmState?.volStep === '0.05' && pmState?.boostStep === '10';
    const muteOk =
      pmState?.mute?.aria === 'Unmute tab' &&
      pmState.mute.badge === true &&
      pmState.mute.browser === true &&
      pmState.mute.afterUnmute === 'Mute tab';
    const t = pmState?.audioTruths;
    const audioTruthsOk =
      t?.tab === 'Unmuted' &&
      t?.player === 'Unmuted' &&
      t?.playerAfterToggle === 'Muted' &&
      t?.elementMuted === true &&
      t?.tabStillUnmuted === true &&
      t?.playerRestored === 'Unmuted' &&
      t?.elementRestored === false &&
      t?.playerSyncWired === true;
    const popInertOk =
      pmState?.popInert?.initialInert === true &&
      pmState.popInert.openOk === true &&
      pmState.popInert.closedOk === true;
    const b = boost;
    const boostOk =
      b?.activeGain === 250 &&
      b?.gainMoved === 300 &&
      b?.stopped === true &&
      b?.failText === 'mock capture refused' &&
      b?.retryPending === true &&
      b?.noLyingError === true &&
      b?.finalActive === true;
    const rel = reliability;
    const reliabilityOk =
      rel?.adapterClicked === true &&
      rel?.adapterPingFollowed === true &&
      rel?.ghostShownOptimistic === true &&
      rel?.ghostGone === true &&
      rel?.ghostNotInStore === true &&
      rel?.volumeStable === true;
    if (cdp.pageErrors.length) {
      failed = true;
      for (const e of cdp.pageErrors) console.error(`FAIL  popup-mock page error: ${e}`);
    } else if (pmRows < 1 || !pmState.gspeed.startsWith('1.25')) {
      failed = true;
      console.error(`FAIL  popup-mock smoke: rows=${pmRows} state=${JSON.stringify(pmState)}`);
    } else if (!themeOk || !stepsOk || !muteOk || !audioTruthsOk || !popInertOk || !boostOk || !reliabilityOk) {
      failed = true;
      console.error(
        `FAIL  popup-mock behavior: theme=${themeOk} steps=${stepsOk} mute=${muteOk} audioTruths=${audioTruthsOk} popInert=${popInertOk} boost=${boostOk} reliability=${JSON.stringify(rel)}`,
      );
    } else {
      console.log(`  ok  popup-mock smoke: ${pmRows} row(s), global ${pmState.gspeed}, override shown: ${pmState.overridden}`);
      console.log(
        `  ok  popup-mock settings: theme dark/light/system repaint, vol step ${pmState.volStep}, boost step ${pmState.boostStep}`,
      );
      console.log('  ok  popup-mock quick mute stays muted for 3.3 s (browser + UI)');
      console.log('  ok  popup-mock volume popover: tab audio and player audio independent, player toggle writes the element');
      console.log('  ok  popup-mock popovers: collapsed popovers are inert, the open one interactive, click-away re-inerts');
      console.log('  ok  popup-mock boost: start→gain→stop, truthful failure, and the belt is per-attempt (no lying error over a retry)');
      console.log('  ok  popup-mock reliability: adapter click refreshes a paused card, a refused page-speed command falls back to the stored truth, the volume readout holds across pings');
    }

    if (failed) process.exitCode = 1;
    else console.log('\nharness: all mock pages passed');
  } catch (err) {
    console.error('Harness failure:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      ws?.close(); // otherwise node's event loop keeps the process alive forever
    } catch {}
    try {
      browserProcess?.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    server.kill();
    // belt: nothing may keep this process alive past the run — a lingering
    // handle would hold the debug port and poison the next run
    process.exit(process.exitCode ?? 0);
  }
}

main();

// Browser harness runner: loads the two mock pages in real Edge (headless)
// and reports their results.
//
//   node scripts/harness.mjs     (also: npm run harness)
//
//   - test/background-mock.html runs its assertions on load and encodes the
//     outcome in document.title ("PASS (n) — background harness" / "FAILED (n)").
//   - test/popup-mock.html drives the real popup against the mock browser; it
//     has no assertions — the runner fails on any page exception or console
//     error while it runs.
//
// Exits non-zero on any failure.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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
  send(method, params = {}, sessionId) {
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
      }, 20000);
    });
  }
}

async function evalIn(cdp, sessionId, expression, awaitPromise = false) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, sessionId);
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

    const browserPath = [
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((p) => existsSync(p));
    if (!browserPath) throw new Error('no Edge installation found for the harness runner');
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
         return {
           rows: rows.length,
           gspeed: document.getElementById('gspeed-value').textContent,
           overridden: rows.some((r) => r.querySelector('.speed-cluster').classList.contains('overridden')),
           theme,
           volStep,
           boostStep,
           mute,
           audioTruths,
         };
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
    if (cdp.pageErrors.length) {
      failed = true;
      for (const e of cdp.pageErrors) console.error(`FAIL  popup-mock page error: ${e}`);
    } else if (pmRows < 1 || !pmState.gspeed.startsWith('1.25')) {
      failed = true;
      console.error(`FAIL  popup-mock smoke: rows=${pmRows} state=${JSON.stringify(pmState)}`);
    } else if (!themeOk || !stepsOk || !muteOk || !audioTruthsOk) {
      failed = true;
      console.error(
        `FAIL  popup-mock behavior: theme=${themeOk} steps=${stepsOk} mute=${muteOk} audioTruths=${audioTruthsOk} state=${JSON.stringify(pmState)}`,
      );
    } else {
      console.log(`  ok  popup-mock smoke: ${pmRows} row(s), global ${pmState.gspeed}, override shown: ${pmState.overridden}`);
      console.log(
        `  ok  popup-mock settings: theme dark/light/system repaint, vol step ${pmState.volStep}, boost step ${pmState.boostStep}`,
      );
      console.log('  ok  popup-mock quick mute stays muted for 3.3 s (browser + UI)');
      console.log('  ok  popup-mock volume popover: tab audio and player audio independent, player toggle writes the element');
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

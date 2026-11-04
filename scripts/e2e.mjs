// Real-browser end-to-end test: launches actual Edge (headless) with the
// unpacked extension loaded, opens the media fixture and the popup as a page
// (chrome-extension://<id>/popup.html behaves like the popup with full
// chrome.* context), then drives the whole feature matrix over CDP:
// detection, playback, seek/volume, the global + per-page speed policy
// (including native ratechange adoption), mute/global actions, badge, pin,
// boost plumbing, keyboard navigation, commands and settings.
//
//   node scripts/e2e.mjs
//
// Exits non-zero on any failure. Needs the media fixture served on :8080 —
// the script starts serve.mjs itself.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the repo keeps the extension in extension/; the packaged archive has it
// at its root (manifest at the archive root) — resolve whichever this is
const EXT = existsSync(join(ROOT, 'extension', 'manifest.json')) ? join(ROOT, 'extension') : ROOT;
// URL prefix for the served extension files (fixture pages import the real
// page.js/adapters.js over HTTP): '/extension' in the repo, '' when packaged
const EXT_URL = EXT === ROOT ? '' : '/extension';
const PORT = 9223;
const SERVE_PORT = 8080;

const results = [];
const ok = (name) => {
  results.push({ name, pass: true });
  console.log(`  ok  ${name}`);
};
const bad = (name, detail) => {
  results.push({ name, pass: false, detail });
  console.log(`FAIL  ${name}  — ${detail}`);
};
const note = (msg) => console.log(`  ..  ${msg}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- CDP over WebSocket (node 22+) ----------------------------------------------

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
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
      }, 30000);
    });
  }
}

async function evalIn(cdp, sessionId, expression, awaitPromise = false) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(`page eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

/** Like evalIn, but inside an emulated user gesture (capture APIs need one). */
async function evalGesture(cdp, sessionId, expression) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true, userGesture: true },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(`gesture eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}

async function waitFor(fn, ms = 8000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // keep polling
    }
    if (Date.now() - t0 > ms) {
      const at = (new Error().stack ?? '').split('\n')[2]?.trim() ?? '';
      throw new Error(`waitFor: condition not met in time — ${at}`);
    }
    await sleep(step);
  }
}

// --- browsers -------------------------------------------------------------------


async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'mcp-e2e-'));
  let browserProcess = null;
  let ws = null;

  try {
    // a zombie browser from a killed/failed run holds the debug port; attaching
    // to it would drive a stale session (old tabs, old extension) and produce
    // phantom assertions — refuse to run instead
    if (!(await fetch(`http://127.0.0.1:${PORT}/json/version`).then(() => false, () => true))) {
      throw new Error(`debug port ${PORT} is already in use — kill the leftover test browser first`);
    }
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/test/media-page.html`);
      return r.ok;
    }, 8000);

    // Edge (Chromium) still honors --load-extension; branded Chrome 137+
    // does not, and downloading a test browser into the repo is off the table
    const browserPath = ['C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
    if (!browserPath) throw new Error('no Edge installation found for the E2E rig');
    browserProcess = spawn(
      browserPath,
      [
        '--headless=new',
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--autoplay-policy=no-user-gesture-required',
        // new headless renders audio to real speakers — mute the browser,
        // not the elements/tabs (assertions read those states)
        '--mute-audio',
        '--window-size=1000,900',
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );

    // browser websocket
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
    // surface service-worker exceptions (and any MCPDBG-tagged logs) inline —
    // an exception inside the worker otherwise fails assertions far away
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Runtime.consoleAPICalled') {
          const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
          if (text.includes('MCPDBG')) console.log('  SW:', text.slice(0, 300));
        } else if (msg.method === 'Runtime.exceptionThrown') {
          console.log('  SW EXCEPTION:', String(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text).slice(0, 400));
        }
      } catch {}
    });
    const cdp = new Cdp(ws);

    // the extension's service worker target proves the manifest parsed and
    // the worker started (bad manifests never get here)
    let sw;
    try {
      sw = await waitFor(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find(
          (t) => t.type === 'service_worker' && t.url.endsWith('/background.js'),
        );
      }, 30000);
    } catch {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      throw new Error(
        `extension service worker not found. targets:\n  ${list.map((t) => `${t.type} | ${t.url}`).join('\n  ')}`,
      );
    }
    const extId = new URL(sw.url).host;
    console.log(`extension loaded: ${extId}`);
    ok('manifest parses and service worker starts');
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, swSession); // temporary diagnostics

    // media page
    const media = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-page.html`,
    });
    const mediaSession = (await cdp.send('Target.attachToTarget', { targetId: media.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, mediaSession); // temporary diagnostics
    await waitFor(() => evalIn(cdp, mediaSession, `!!document.querySelector('audio')`));

    // start the local audio (autoplay flag allows it)
    const playResult = await evalIn(
      cdp,
      mediaSession,
      `document.querySelectorAll('audio')[0].play().then(() => 'played').catch(e => 'blocked: ' + e.name)`,
      true,
    );
    if (playResult !== 'played') {
      note(`tone play() result: ${playResult}`);
    }
    await waitFor(() =>
      evalIn(cdp, mediaSession, `!document.querySelectorAll('audio')[0].paused`),
    );
    await sleep(300);

    // Does this environment report tab-level audibility at all? Headless audio
    // endpoints can be unavailable (element plays, tab.audible stays false).
    // Everything probe-driven works regardless; only the audible-event-driven
    // assertions (live adoption, badge) are gated on this.
    const mediaTabId = await evalIn(
      cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(t => t[0]?.id)`, true,
    );
    const AUDIBLE_OK =
      (await waitFor(
        () => evalIn(cdp, swSession, `chrome.tabs.query({audible:true}).then(t => t.length > 0)`),
        6000,
      ).catch(() => null)) === true;
    if (!AUDIBLE_OK) {
      note('tab audibility not reported in this environment — audible-event assertions will be gated');
    }
    // The recent list is a real popup detection path: seeding the media tab
    // keeps detection working even without audible events (the popup probes
    // candidates and keeps only tabs that really hold media).
    const seedRecent = (tabId) =>
      evalIn(
        cdp,
        swSession,
        `chrome.storage.session.get('recent').then(s => chrome.storage.session.set({ recent: [...new Set([${tabId}, ...(s.recent ?? [])])] }))`,
      );
    await seedRecent(mediaTabId);

    // popup as a page
    const popup = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupSession = (await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
    try {
      await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length >= 1`));
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, popupSession, `document.body ? document.body.innerHTML.length : 'no body'`),
        evalIn(cdp, popupSession, `document.getElementById('empty').hidden`),
        evalIn(cdp, swSession, `chrome.tabs.query({}).then(ts => JSON.stringify(ts.map(t => ({ id: t.id, url: (t.url || '').slice(0, 60), audible: t.audible }))))`, true),
        evalIn(cdp, mediaSession, `(() => { const a = document.querySelectorAll('audio')[0]; return JSON.stringify({ paused: a.paused, muted: a.muted, volume: a.volume, t: a.currentTime, rs: a.readyState, net: a.networkState }); })()`),
      ]);
      note(`init diagnostics: bodyLen=${diag[0]} emptyHidden=${diag[1]} tabs=${diag[2]} audio=${diag[3]}`);
      throw new Error('no rows after popup open');
    }

    const row = (i) => `document.querySelectorAll('.row')[${i}]`;

    // --- detection ---------------------------------------------------------
    const rowCount = await evalIn(cdp, popupSession, `document.querySelectorAll('.row').length`);
    rowCount >= 1 ? ok(`media tab detected (${rowCount} row(s))`) : bad('media tab detected', `rows=${rowCount}`);

    const firstTitle = await evalIn(cdp, popupSession, `document.querySelector('.row .t-title').textContent`);
    const expectTitle = await evalIn(cdp, mediaSession, 'document.title');
    firstTitle === expectTitle
      ? ok('row shows the tab title')
      : bad('row shows the tab title', `got "${firstTitle}", want "${expectTitle}"`);

    const playAria = await waitFor(() =>
      evalIn(cdp, popupSession, `document.querySelector('.row .play').getAttribute('aria-label') === 'Pause' ? 'Pause' : null`),
    ).catch(() => null);
    playAria === 'Pause'
      ? ok('playing state shown (probe confirms playback)')
      : bad('playing state shown (probe confirms playback)', `aria="${playAria}"`);

    const probeCount = await evalIn(
      cdp,
      popupSession,
      `document.querySelector('.row .t-site').textContent`,
    );
    /×\d/.test(probeCount)
      ? ok(`multi-element count shown (${probeCount.trim()})`)
      : note(`element count "${probeCount.trim()}" (remote videos may not load — tolerant)`);

    // card shows live position data without any expansion
    const posText = await waitFor(
      () =>
        evalIn(cdp, popupSession, `document.querySelector('.row .pos-readout').textContent`).then(
          (t) => (t.includes('/') ? t : null),
        ),
      8000,
    ).catch(() => null);
    posText
      ? ok(`card shows position readout without expansion (${posText})`)
      : bad('card shows position readout without expansion', 'pos-readout never filled');

    // --- play/pause ---------------------------------------------------------
    // The local 10 s tone may have ended while the card/probe assertions ran
    // (slower machines); pageToggle then resumes a different element and the
    // assertion below would be testing the wrong media. Restart the
    // deterministic local tone first — a real user click path, not a shortcut.
    const toneRestart = await evalIn(
      cdp,
      mediaSession,
      `(async () => {
         const a = document.querySelectorAll('audio')[0];
         a.loop = true; // a 10 s tone must not end between the section's clicks
         a.currentTime = 0;
         // the canvas live video never ends; if it is playing, pageToggle
         // would pause-all on the "resume" click instead of resuming the
         // tone — pause it so the tone is the only playing element
         document.getElementById('canvas-video').pause();
         try { await a.play(); return 'played'; } catch (e) { return 'blocked: ' + e.name; }
       })()`,
      true,
    );
    if (toneRestart !== 'played') note(`tone restart before play/pause: ${toneRestart}`);
    await waitFor(() => evalIn(cdp, mediaSession, `!document.querySelectorAll('audio')[0].paused`));
    await evalIn(cdp, popupSession, `document.querySelector('.row .play').click()`);
    await waitFor(() => evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].paused`));
    ok('row play button pauses the page media');
    await evalIn(cdp, popupSession, `document.querySelector('.row .play').click()`);
    await waitFor(() => evalIn(cdp, mediaSession, `!document.querySelectorAll('audio')[0].paused`));
    ok('row play button resumes the page media');

    // --- exclusive playback (Alt+click play) ---------------------------------
    const media2 = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-page.html`,
    });
    const media2Session = (await cdp.send('Target.attachToTarget', { targetId: media2.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, media2Session, `!!document.querySelector('audio')`));
    await evalIn(cdp, media2Session, `document.querySelectorAll('audio')[0].play()`);
    if (AUDIBLE_OK) {
      await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length === 2`));
      ok('second media tab adopted while the popup is open');
    } else {
      // no audible events in this environment: seed the recent list and
      // reload — the popup's candidate model must still find the tab
      const media2TabId = await evalIn(
        cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(t => t.map(x => x.id))`, true,
      );
      for (const id of media2TabId ?? []) await seedRecent(id);
      await evalIn(cdp, popupSession, `location.reload()`);
      await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length === 2`));
      note('second media tab adopted via reload (live audible-event adoption needs audibility reporting)');
    }

    await evalIn(
      cdp,
      popupSession,
      `[...document.querySelectorAll('.row')].pop()
         .querySelector('.play')
         .dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))`,
    );
    await waitFor(() => evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].paused`));
    await waitFor(() => evalIn(cdp, media2Session, `!document.querySelectorAll('audio')[0].paused`));
    ok('Alt+click play is exclusive — the other tab pauses');

    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row.paused').length === 1`));
    await evalIn(cdp, popupSession, `document.querySelector('.row.paused .play').click()`);
    await waitFor(() => evalIn(cdp, mediaSession, `!document.querySelectorAll('audio')[0].paused`));
    const plainKeptSecond = await evalIn(cdp, media2Session, `!document.querySelectorAll('audio')[0].paused`);
    plainKeptSecond
      ? ok('plain play leaves the other tab playing')
      : bad('plain play leaves the other tab playing', 'second tab was paused by a plain click');

    await cdp.send('Target.closeTarget', { targetId: media2.targetId });
    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length === 1`));

    // --- seek, volume popover, ±10s --------------------------------------------
    await evalIn(
      cdp,
      popupSession,
      `(() => { const p = document.querySelector('.pos'); p.value = '7'; p.dispatchEvent(new Event('input', {bubbles:true})); p.dispatchEvent(new Event('change', {bubbles:true})); })()`,
    );
    await waitFor(() => evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].currentTime > 5`));
    ok('seek slider moves the page media');

    const notLive = await evalIn(cdp, popupSession, `document.querySelector('.row .card-timeline.live') === null`);
    notLive
      ? ok('non-live seek bar active (no LIVE tag on the tone)')
      : bad('non-live seek bar active', 'row falsely marked live');

    await evalIn(cdp, popupSession, `document.querySelector('.row .vol-btn').click()`);
    const volOpen = await evalIn(
      cdp,
      popupSession,
      `document.querySelector('.row .vol-pop').classList.contains('open')`,
    );
    volOpen
      ? ok('volume popover opens from the card')
      : bad('volume popover opens from the card', 'popover did not open');
    await evalIn(
      cdp,
      popupSession,
      `(() => { const v = document.querySelector('.row .vol'); v.value = '0.35'; v.dispatchEvent(new Event('input', {bubbles:true})); })()`,
    );
    await waitFor(() =>
      evalIn(cdp, mediaSession, `Math.abs(document.querySelectorAll('audio')[0].volume - 0.35) < 0.02`),
    );
    ok('volume popover slider reaches the page media');
    await evalIn(cdp, popupSession, `document.querySelector('.row .vol-btn').click()`);

    const beforeBack = await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].currentTime`);
    await evalIn(cdp, popupSession, `document.querySelector('.row .back10').click()`);
    await waitFor(() =>
      evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].currentTime <= ${beforeBack} - 5`),
    );
    ok('−10s button seeks the page media back');

    // --- global speed ------------------------------------------------------------
    // default, stepping, bounds, reset, persistence, applying to inheriting
    // media (the manager injects and applies the rate to playing elements)
    const g0 = await evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent`);
    g0 === '1.00×'
      ? ok('global speed defaults to 1.00×')
      : bad('global speed defaults to 1.00×', `got "${g0}"`);

    await evalIn(cdp, popupSession, `document.getElementById('gspeed-inc').click()`);
    const g1 = await evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent`);
    g1 === '1.25×'
      ? ok('global speed steps by 0.25×')
      : bad('global speed steps by 0.25×', `got "${g1}"`);
    await waitFor(() =>
      evalIn(cdp, mediaSession, `Math.abs(document.querySelectorAll('audio')[0].playbackRate - 1.25) < 0.01`),
    );
    ok('global speed applies to playing media (page manager)');

    const speedStored = await evalIn(cdp, swSession, `chrome.storage.local.get('speed').then(s => s.speed)`, true);
    Math.abs(speedStored - 1.25) < 1e-9
      ? ok('global speed persists to storage.local')
      : bad('global speed persists to storage.local', `stored=${speedStored}`);

    // bounds: down to 0.25 → dec disabled; back up and reset to 1.00
    for (let i = 0; i < 4; i++) {
      await evalIn(cdp, popupSession, `document.getElementById('gspeed-dec').click()`);
      await sleep(60);
    }
    const atMin = await evalIn(
      cdp,
      popupSession,
      `({ v: document.getElementById('gspeed-value').textContent, d: document.getElementById('gspeed-dec').disabled })`,
    );
    atMin.v === '0.25×' && atMin.d
      ? ok('global speed honors the 0.25× floor (decrease disabled)')
      : bad('global speed honors the 0.25× floor (decrease disabled)', JSON.stringify(atMin));
    await evalIn(cdp, popupSession, `document.getElementById('gspeed-reset').click()`);
    await waitFor(() => evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent === '1.00×' && document.getElementById('gspeed-reset').disabled`));
    ok('reset returns to 1.00× and disables itself');

    // paused media inherits when playback starts; multiple tabs inherit
    await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].pause()`);
    for (let i = 0; i < 4; i++) {
      await evalIn(cdp, popupSession, `document.getElementById('gspeed-inc').click()`);
      await sleep(60);
    }
    await waitFor(() => evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent === '2.00×'`));
    await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].play()`);
    await waitFor(() =>
      evalIn(cdp, mediaSession, `Math.abs(document.querySelectorAll('audio')[0].playbackRate - 2) < 0.01`),
    );
    ok('global speed applies to media that starts later (paused → play)');

    const media2b = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html`,
    });
    const media2bSession = (await cdp.send('Target.attachToTarget', { targetId: media2b.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, media2bSession); // temporary diagnostics
    await waitFor(() => evalIn(cdp, media2bSession, `!!document.querySelector('audio')`));
    await evalIn(cdp, media2bSession, `document.querySelector('audio').play()`);
    await waitFor(() =>
      evalIn(cdp, media2bSession, `Math.abs(document.querySelector('audio').playbackRate - 2) < 0.01`),
    );
    ok('global speed applies to other tabs (multiple inheriting tabs)');

    // --- new tabs opened AFTER the global speed was chosen -------------------------
    // The manual repro: set 2.00×, open a fresh tab, play media. The tab must
    // receive the current global policy on its first injectable document —
    // and a player that writes its own default 1.00× during media setup must
    // not be mistaken for a page override.
    const freshTarget = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/speed-suite.html?t=NEWGLOBAL`,
    });
    const freshSession = (await cdp.send('Target.attachToTarget', { targetId: freshTarget.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, freshSession, `!!window.mcpFix`), 15000);
    await evalIn(cdp, freshSession, `mcpFix.play(0)`, true);
    await waitFor(() =>
      evalIn(cdp, freshSession, `Math.abs(mcpFix.rates()[0] - 2) < 0.01`),
    );
    ok('global 2.00× applies to a tab opened after the speed was chosen');
    // the site's player re-initializes the media at its own default 1.00×
    await evalIn(
      cdp,
      freshSession,
      `(async () => { mcpFix.swapSrc(0); await mcpFix.play(0); mcpFix.rate(0, 1); return mcpFix.rates()[0]; })()`,
      true,
    );
    await sleep(900);
    const freshRateAfterInit = await evalIn(cdp, freshSession, `mcpFix.rates()[0]`);
    const freshTabId = await evalIn(
      cdp, swSession,
      `chrome.tabs.query({url:'http://127.0.0.1:8080/test/speed-suite.html*'}).then(ts => ts.find(x => (x.url || '').includes('NEWGLOBAL'))?.id)`, true,
    );
    const freshOverrides = await evalIn(
      cdp, swSession, `chrome.storage.session.get('speedOverrides').then(s => s.speedOverrides ?? {})`, true,
    );
    Math.abs(freshRateAfterInit - 2) < 0.01 && !freshOverrides[freshTabId]
      ? ok('a player initialization write (1.00×) is re-stamped, not adopted as an override')
      : bad(
          'a player initialization write (1.00×) is re-stamped, not adopted as an override',
          `rate=${freshRateAfterInit} override=${JSON.stringify(freshOverrides[freshTabId])}`,
        );
    await cdp.send('Target.closeTarget', { targetId: freshTarget.targetId });

    // --- per-page overrides ----------------------------------------------------------
    // Tab A = media-page (rows[0]), tab B = media-audio (rows[1]); both playing.
    if (!AUDIBLE_OK) {
      const media2bTabId = await evalIn(
        cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/test/media-audio.html'}).then(t => t[0]?.id)`, true,
      );
      if (media2bTabId) await seedRecent(media2bTabId);
      await evalIn(cdp, popupSession, `location.reload()`);
    }
    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length === 2`));
    ok('both media tabs listed (two rows)');

    // B: page override via its card stepper
    await evalIn(cdp, popupSession, `${row(1)}.querySelector('.rate-inc').click()`);
    await waitFor(() =>
      evalIn(cdp, media2bSession, `Math.abs(document.querySelector('audio').playbackRate - 2.25) < 0.01`),
    );
    ok('per-page stepper sets a page override (B at 2.25×)');

    const aStill = await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].playbackRate`);
    Math.abs(aStill - 2) < 0.01
      ? ok('page override does not touch other tabs (A still 2.00×)')
      : bad('page override does not touch other tabs (A still 2.00×)', `A=${aStill}`);

    // override marker: readout + reset affordance
    const ovMarked = await evalIn(
      cdp,
      popupSession,
      `${row(1)}.querySelector('.speed-cluster').classList.contains('overridden') && !${row(1)}.querySelector('.rate-reset').hidden`,
    );
    ovMarked
      ? ok('card marks the override (accent + reset-to-global visible)')
      : bad('card marks the override (accent + reset-to-global visible)', 'no override marker');

    // global changes must not touch the overridden page
    await evalIn(cdp, popupSession, `document.getElementById('gspeed-inc').click()`);
    await evalIn(cdp, popupSession, `document.getElementById('gspeed-inc').click()`);
    await waitFor(() => evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent === '2.50×'`));
    try {
      await waitFor(() =>
        evalIn(cdp, mediaSession, `Math.abs(document.querySelectorAll('audio')[0].playbackRate - 2.5) < 0.01`),
      );
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].playbackRate`),
        evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent`),
        evalIn(cdp, swSession, `chrome.storage.local.get('speed').then(s => s.speed)`, true),
        evalIn(cdp, swSession, `chrome.storage.session.get('speedOverrides').then(s => JSON.stringify(s.speedOverrides ?? {}))`, true),
      ]);
      note(`2.50× diagnostics: rateA=${diag[0]} popup=${diag[1]} stored=${diag[2]} overrides=${diag[3]}`);
      throw new Error('A never reached 2.50×');
    }
    const bAfterGlobal = await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate`);
    Math.abs(bAfterGlobal - 2.25) < 0.01
      ? ok('global change updates the inheriting tab (A → 2.50×)')
      : bad('global change updates the inheriting tab (A → 2.50×)', `A=${bAfterGlobal}`);
    ok('global change leaves the overridden tab alone (B stays 2.25×)');

    // --- native player rate change is respected (the critical regression) ----------
    // report -> worker -> storage -> repaint crosses four contexts; deep in a
    // long run on a busy machine one hop can stall, so re-pick the rate once
    // (a user nudging the site control again is the same behavior) before
    // failing
    const readout110 = () =>
      evalIn(cdp, popupSession, `${row(1)}.querySelector('.rate-readout').textContent === '1.10×'`);
    await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate = 1.1`);
    if (!(await waitFor(readout110, 15000).catch(() => null))) {
      await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate = 1.1`);
      await waitFor(readout110, 15000);
    }
    ok('native rate change is adopted and displayed (1.10× exact)');
    await sleep(1500); // give any overzealous enforcement time to clobber it
    const bNativeKept = await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate`);
    Math.abs(bNativeKept - 1.1) < 0.001
      ? ok('the extension does not overwrite the native rate (still 1.10× after 1.5s)')
      : bad('the extension does not overwrite the native rate (still 1.10× after 1.5s)', `B=${bNativeKept}`);

    await evalIn(cdp, popupSession, `document.getElementById('gspeed-inc').click()`);
    await waitFor(() => evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent === '2.75×'`));
    await sleep(600);
    const bStill110 = await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate`);
    Math.abs(bStill110 - 1.1) < 0.001
      ? ok('overridden page keeps its rate across further global changes')
      : bad('overridden page keeps its rate across further global changes', `B=${bStill110}`);

    // reset to global
    await evalIn(cdp, popupSession, `${row(1)}.querySelector('.rate-reset').click()`);
    try {
      await waitFor(() =>
        evalIn(cdp, media2bSession, `Math.abs(document.querySelector('audio').playbackRate - 2.75) < 0.01`),
      );
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, media2bSession, `JSON.stringify({ paused: document.querySelector('audio').paused, rate: document.querySelector('audio').playbackRate, def: document.querySelector('audio').defaultPlaybackRate })`),
        evalIn(cdp, popupSession, `${row(1)} ? JSON.stringify({ resetHidden: ${row(1)}.querySelector('.rate-reset').hidden, readout: ${row(1)}.querySelector('.rate-readout').textContent }) : 'no row'`),
        evalIn(cdp, swSession, `Promise.all([chrome.storage.session.get(['speedOverrides','speedRevs','speedManaged']), chrome.storage.local.get('speed')]).then(([s, l]) => JSON.stringify({ ...s, speed: l.speed }))`, true),
      ]);
      note(`reset-2.75 diagnostics: page=${diag[0]} popup=${diag[1]} session=${diag[2]}`);
      throw new Error('B never reached 2.75× on reset');
    }
    ok('reset-to-global re-applies the global speed (B → 2.75×)');

    // no oscillation: A holds steady at the global rate
    const rates = [];
    for (let i = 0; i < 5; i++) {
      rates.push(await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].playbackRate`));
      await sleep(300);
    }
    const stable = rates.every((r) => Math.abs(r - 2.75) < 0.01);
    stable
      ? ok('no speed oscillation (A stable at 2.75× across 1.5s)')
      : bad('no speed oscillation (A stable at 2.75× across 1.5s)', `rates=${rates}`);

    // --- mute / global actions ------------------------------------------------------
    // Quick mute must stay muted: sample the BROWSER state and the POPUP icon
    // over the window where the manual report saw a revert. The event log
    // proves whether any extension path unmuted the tab.
    const muteTabId = await evalIn(
      cdp, swSession,
      `chrome.tabs.query({url:'http://127.0.0.1:8080/test/media-page.html'}).then(t => t[0].id)`, true,
    );
    await evalIn(
      cdp, swSession,
      `(() => {
         globalThis.__muteLog = [];
         chrome.tabs.onUpdated.addListener((id, info) => {
           if (info.mutedInfo) globalThis.__muteLog.push({ id, muted: info.mutedInfo.muted, reason: info.mutedInfo.reason, t: Date.now() });
         });
         return true;
       })()`,
    );
    await evalIn(cdp, popupSession, `${row(0)}.querySelector('.mute').click()`);
    await waitFor(() =>
      evalIn(cdp, swSession, `chrome.tabs.get(${muteTabId}).then(t => !!t.mutedInfo?.muted)`, true),
    );
    ok('row mute mutes the tab (tabs API, no injection)');
    const muteSamples = [];
    let muteElapsed = 0;
    for (const at of [0, 500, 1000, 3000]) {
      if (at > muteElapsed) await sleep(at - muteElapsed);
      muteElapsed = at;
      const browser = await evalIn(
        cdp, swSession, `chrome.tabs.get(${muteTabId}).then(t => t.mutedInfo)`, true,
      );
      const ui = await evalIn(
        cdp,
        popupSession,
        `(() => {
           const r = ${row(0)};
           return r ? { aria: r.querySelector('.mute').getAttribute('aria-label'), badge: !r.querySelector('.eq-muted').hidden } : null;
         })()`,
      );
      muteSamples.push({ at, browser, ui });
    }
    const muteStable = muteSamples.every(
      (s) => s.browser?.muted === true && s.browser?.reason === 'extension' && s.ui?.aria === 'Unmute tab' && s.ui?.badge === true,
    );
    const muteLog = await evalIn(cdp, swSession, `globalThis.__muteLog`, true);
    const muteReverted = (muteLog ?? []).some((e) => e.id === muteTabId && e.muted === false);
    muteStable && !muteReverted
      ? ok('quick mute stays muted for 3 s — browser state and popup icon agree (no unmute event)')
      : bad('quick mute stays muted for 3 s — browser state and popup icon agree (no unmute event)', JSON.stringify({ muteSamples, muteLog }));
    // element volume and boost are independent controls; changing volume while
    // the tab is muted must not unmute it
    await evalIn(
      cdp,
      popupSession,
      `(() => { const v = ${row(0)}.querySelector('.vol'); v.value = '0.4'; v.dispatchEvent(new Event('input', {bubbles:true})); })()`,
    );
    await sleep(500);
    const muteAfterVolume = await evalIn(
      cdp, swSession, `chrome.tabs.get(${muteTabId}).then(t => t.mutedInfo)`, true,
    );
    muteAfterVolume?.muted === true
      ? ok('element volume is independent of tab mute — the mute stays')
      : bad('element volume is independent of tab mute — the mute stays', JSON.stringify(muteAfterVolume));
    await evalIn(cdp, popupSession, `${row(0)}.querySelector('.mute').click()`);
    await waitFor(() => evalIn(cdp, swSession, `chrome.tabs.query({muted:true}).then(t => t.length === 0)`));
    ok('row unmute restores the tab');

    await evalIn(cdp, popupSession, `document.getElementById('mute-all').click()`);
    await waitFor(() => evalIn(cdp, swSession, `chrome.tabs.query({muted:true}).then(t => t.length >= 1)`));
    const muteAllLabel = await evalIn(cdp, popupSession, `document.getElementById('mute-all').textContent`);
    muteAllLabel === 'Unmute all'
      ? ok('mute-all works and flips to Unmute all')
      : bad('mute-all works and flips to Unmute all', `label="${muteAllLabel}"`);
    await evalIn(cdp, popupSession, `document.getElementById('mute-all').click()`);
    await waitFor(() => evalIn(cdp, swSession, `chrome.tabs.query({muted:true}).then(t => t.length === 0)`));
    ok('unmute-all restores tabs');

    await evalIn(cdp, popupSession, `document.getElementById('pause-all').click()`);
    await waitFor(() => evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].paused`));
    await waitFor(() => evalIn(cdp, media2bSession, `document.querySelector('audio').paused`));
    ok('pause-all pauses media in every tab');
    // let the popup's play-state model settle (pings racing the pause can
    // show a row as playing for up to a ping cycle)
    await waitFor(() =>
      evalIn(cdp, popupSession, `[...document.querySelectorAll('.row')].every(r => r.classList.contains('paused'))`),
    );

    // --- badge ------------------------------------------------------------------
    if (AUDIBLE_OK) {
      await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].play()`);
      await waitFor(() =>
        evalIn(cdp, swSession, `chrome.action.getBadgeText({}).then(t => t === '1')`),
      );
      ok('badge shows playing-tab count (1)');
      await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].pause()`);
      await waitFor(() => evalIn(cdp, swSession, `chrome.action.getBadgeText({}).then(t => t === '')`));
      ok('badge clears when nothing plays');
    } else {
      note('badge assertions skipped: tab audibility not reported here (badge logic is tabs.query({audible}) — covered when audibility works)');
    }

    // --- pin target (overflow menu) ------------------------------------------------
    await evalIn(cdp, popupSession, `${row(0)}.querySelector('.menu-btn').click()`);
    await evalIn(cdp, popupSession, `${row(0)}.querySelector('.pin').click()`);
    const target = await evalIn(cdp, swSession, `chrome.storage.session.get('target').then(s => s.target)`, true);
    const pinnedMediaTabId = await evalIn(cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1/*'}).then(t => t[0].id)`, true);
    target === pinnedMediaTabId
      ? ok('pin writes the target tabId for the keyboard command')
      : bad('pin writes the target tabId for the keyboard command', `target=${target} media=${pinnedMediaTabId}`);

    // --- override survives popup close/reopen; navigation clears it -----------------
    // B: set an override, close the popup, reopen, the card must still show it.
    const playB = await evalIn(
      cdp,
      media2bSession,
      `(async () => {
         const a = document.querySelector('audio');
         a.currentTime = 0;
         try { await a.play(); return 'played'; } catch (e) { return 'blocked: ' + e.name; }
       })()`,
      true,
    );
    if (playB !== 'played') note(`B play() result: ${playB}`);
    await evalIn(cdp, popupSession, `${row(1)}.querySelector('.rate-inc').click()`);
    try {
      await waitFor(() =>
        evalIn(cdp, media2bSession, `Math.abs(document.querySelector('audio').playbackRate - 3) < 0.01`),
      );
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, media2bSession, `JSON.stringify({ paused: document.querySelector('audio').paused, rate: document.querySelector('audio').playbackRate })`),
        evalIn(cdp, popupSession, `JSON.stringify([...document.querySelectorAll('.row')].map(r => r.querySelector('.rate-readout').textContent))`),
        evalIn(cdp, swSession, `chrome.storage.session.get('speedOverrides').then(s => JSON.stringify(s.speedOverrides ?? {}))`, true),
      ]);
      note(`3.00× diagnostics: audioB=${diag[0]} readouts=${diag[1]} overrides=${diag[2]}`);
      throw new Error('B never reached 3.00×');
    }
    await cdp.send('Target.closeTarget', { targetId: popup.targetId });
    await sleep(300);
    const popup2 = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let popupSession2 = (await cdp.send('Target.attachToTarget', { targetId: popup2.targetId, flatten: true })).sessionId;
    await sleep(800);
    const reopenedRow = await evalIn(
      cdp,
      popupSession2,
      `[...document.querySelectorAll('.row')].findIndex(r => (r.querySelector('.rate-readout').textContent || '').startsWith('3.00'))`,
    );
    reopenedRow >= 0
      ? ok('page override survives popup close/reopen (B card shows 3.00×)')
      : bad('page override survives popup close/reopen (B card shows 3.00×)', `rows=${await evalIn(cdp, popupSession2, `document.querySelectorAll('.row').length`)}`);
    const reopenedPlaying = await evalIn(cdp, media2bSession, `document.querySelector('audio').playbackRate`);
    Math.abs(reopenedPlaying - 3) < 0.01
      ? ok('override re-applies to media that starts after reopen (B at 3.00×)')
      : bad('override re-applies to media that starts after reopen (B at 3.00×)', `B=${reopenedPlaying}`);

    // navigating B to a different page clears its override
    await evalIn(cdp, media2bSession, `location.href = 'http://127.0.0.1:${SERVE_PORT}/test/media-audio.html?nav=1'`);
    await waitFor(async () => {
      const ov = await evalIn(cdp, swSession, `chrome.storage.session.get('speedOverrides').then(s => s.speedOverrides ?? {})`, true);
      return !Object.values(ov).some((o) => o.rate === 3);
    });
    ok('navigation to a different page clears the page override');

    // --- managed tabs: a tab detection loses still hears the policy (fix) -------------
    // A is managed at global 2.75×. Make A ineligible for detection — media
    // paused, recent list without A, pin dropped — then return global to 1.00×.
    // The manager must be disconnected and the rate restored anyway.
    await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].pause()`);
    await evalIn(cdp, swSession, `chrome.storage.session.remove('target')`);
    const bTabIdOnly = await evalIn(
      cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(t => t.find(x => (x.url || '').includes('media-audio')).id)`, true,
    );
    await evalIn(cdp, swSession, `chrome.storage.session.set({ recent: [${bTabIdOnly}] })`);
    await evalIn(cdp, popupSession2, `document.getElementById('gspeed-reset').click()`);
    await waitFor(() => evalIn(cdp, popupSession2, `document.getElementById('gspeed-value').textContent === '1.00×'`));
    await waitFor(() =>
      evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].playbackRate === 1`),
    );
    ok('global 1× reaches a managed tab that detection no longer lists (rate restored)');
    // and no zombie manager wakes up when the media starts again
    await evalIn(
      cdp,
      mediaSession,
      `(function () { const a = document.querySelectorAll('audio')[0]; a.currentTime = 0; return a.play().catch(e => 'blocked'); })()`,
      true,
    );
    await sleep(600);
    const aRateAfterDisconnect = await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].playbackRate`);
    Math.abs(aRateAfterDisconnect - 1) < 0.01
      ? ok('media that restarts after the disconnect stays at 1.00× (no zombie manager)')
      : bad('media that restarts after the disconnect stays at 1.00× (no zombie manager)', `rate=${aRateAfterDisconnect}`);

    // --- card speed reflects the real player when no policy is active (fix) ------------
    // Global is 1.00× with no override: the manager is inactive, so the card
    // must show the site's ACTUAL rate, and a step must build on that rate.
    // The long remote mp3 is the observed element: the 10 s tone would end
    // mid-assert, and the canvas video's MediaStream forces playbackRate 1.0.
    await evalIn(
      cdp,
      mediaSession,
      `(async () => {
         document.querySelectorAll('audio')[0].pause();
         document.getElementById('canvas-video').pause();
         const a = document.querySelectorAll('audio')[1];
         a.currentTime = 0;
         await a.play();
         a.playbackRate = 1.5;
         return 'set';
       })()`,
      true,
    );
    await sleep(300);
    // A lost its detection candidacy in the managed-tab test above (paused +
    // aged out of the recent list) — re-seed it so the popup lists the card
    const aTabIdAgain = await evalIn(
      cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(t => t.find(x => (x.url || '').includes('media-page')).id)`, true,
    );
    await evalIn(cdp, swSession, `chrome.storage.session.get('recent').then(s => chrome.storage.session.set({ recent: [...new Set([${aTabIdAgain}, ...(s.recent ?? [])])] }))`);
    await evalIn(cdp, popupSession2, `location.reload()`);
    await waitFor(() => evalIn(cdp, popupSession2, `document.querySelectorAll('.row').length >= 2`));
    let shownNative = null;
    try {
      shownNative = await waitFor(
        () =>
          evalIn(cdp, popupSession2, `document.querySelector('.row .rate-readout').textContent === '1.50×' ? '1.50×' : null`),
      );
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, mediaSession, `JSON.stringify([...document.querySelectorAll('audio'), document.getElementById('canvas-video')].map(a => ({ paused: a.paused, rate: a.playbackRate })))`),
        evalIn(cdp, popupSession2, `JSON.stringify([...document.querySelectorAll('.row')].map(r => ({ t: r.querySelector('.t-title').textContent.slice(0, 14), rate: r.querySelector('.rate-readout').textContent })))`),
        evalIn(cdp, swSession, `chrome.storage.local.get('speed').then(s => s.speed)`, true),
        evalIn(cdp, swSession, `chrome.storage.session.get('speedOverrides').then(s => JSON.stringify(s.speedOverrides ?? {}))`, true),
      ]);
      note(`1.50× display diagnostics: page=${diag[0]} ui=${diag[1]} speed=${diag[2]} ov=${diag[3]}`);
    }
    shownNative === '1.50×'
      ? ok('card shows the website-set rate while the manager is inactive (1.50×)')
      : bad('card shows the website-set rate while the manager is inactive (1.50×)', `shown=${await evalIn(cdp, popupSession2, 'document.querySelector(".row .rate-readout").textContent')}`);
    await evalIn(cdp, popupSession2, `document.querySelector('.row .rate-inc').click()`);
    await waitFor(() =>
      evalIn(cdp, mediaSession, `Math.abs(document.querySelectorAll('audio')[1].playbackRate - 1.75) < 0.01`),
    );
    ok('extension-initiated step builds on the observed rate (1.50× → 1.75×)');
    const shownStepped = await waitFor(
      () =>
        evalIn(cdp, popupSession2, `document.querySelector('.row .rate-readout').textContent === '1.75×' ? '1.75×' : null`),
    ).catch(() => null);
    shownStepped === '1.75×'
      ? ok('card reflects the new page override after the step (1.75×)')
      : bad('card reflects the new page override after the step (1.75×)', `shown=${shownStepped}`);

    // --- track adapters -----------------------------------------------------------------
    const adapterGone = await evalIn(
      cdp,
      popupSession2,
      `[...document.querySelectorAll('.row')].every(r => r.querySelector('.prev').disabled && r.querySelector('.next').disabled)`,
    );
    adapterGone
      ? ok('adapter buttons disabled (not hidden) on non-adapter sites')
      : bad('adapter buttons disabled (not hidden) on non-adapter sites', 'prev/next enabled on 127.0.0.1');
    const adapterClick = await evalIn(
      cdp,
      mediaSession,
      `(async () => {
        const b = document.createElement('button');
        b.className = 'ytp-next-button';
        let clicks = 0;
        b.click = () => { clicks++; };
        document.body.append(b);
        const lib = await import('${EXT_URL}/lib/adapters.js');
        const r = lib.ADAPTERS.youtube.next();
        b.remove();
        return { acted: r.acted, clicks };
      })()`,
      true,
    );
    adapterClick?.acted && adapterClick.clicks === 1
      ? ok('youtube adapter clicks the site next button')
      : bad('youtube adapter clicks the site next button', JSON.stringify(adapterClick));

    // --- adapter disabled-state truth (supported site, first video, no control) -----
    const adapterStates = await evalIn(
      cdp,
      mediaSession,
      `(async () => {
         const { pageProbe } = await import('${EXT_URL}/lib/page.js');
         const { adapterFor } = await import('${EXT_URL}/lib/adapters.js');
         const b = document.createElement('button');
         b.className = 'ytp-prev-button';
         document.body.append(b);
         const probe = () => pageProbe({ next: '.ytp-next-button', prev: '.ytp-prev-button' }).siteButtons.prev;
         const states = {};
         states.visible = probe();
         b.setAttribute('aria-disabled', 'true');
         states.aria = probe();
         b.removeAttribute('aria-disabled');
         b.disabled = true;
         states.disabled = probe();
         b.disabled = false;
         b.style.display = 'none';
         states.hidden = probe();
         b.remove();
         states.absent = probe();
         const hosts = ['https://www.youtube.com/watch?v=x', 'https://open.spotify.com/track/1', 'https://soundcloud.com/a/b', 'https://www.netflix.com/watch/1', 'https://example.com/x']
           .map((u) => [u, !!adapterFor(u)]);
         return { states, hosts };
       })()`,
      true,
    );
    const as = adapterStates?.states;
    const hostsOk =
      JSON.stringify(adapterStates?.hosts?.map((h) => h[1])) === JSON.stringify([true, true, true, false, false]);
    as?.visible?.found && as.visible.disabled === false &&
    as?.aria?.disabled === true && as?.disabled?.disabled === true &&
    as?.hidden?.disabled === true && as?.absent?.found === false && as.absent.disabled === true && hostsOk
      ? ok('adapter availability: enabled only for a real, enabled site button; hidden/aria-disabled/disabled/absent all disable')
      : bad('adapter availability: enabled only for a real, enabled site button', JSON.stringify(adapterStates));

    // --- site volume indicator follows the standard volumechange event --------------
    // The fixture's own UI is driven only by the media element's volumechange
    // event. If this moves, a site that follows the standard needs no adapter.
    const volSyncTarget = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/volume-sync.html`,
    });
    const volSyncSession = (await cdp.send('Target.attachToTarget', { targetId: volSyncTarget.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, volSyncSession, `!!window.mcpVolume`));
    await evalIn(cdp, volSyncSession, `mcpVolume.play().catch(() => {})`);
    const volSyncPlay = await evalIn(
      cdp, volSyncSession,
      `mcpVolume.audio.paused === false ? 'playing' : 'not playing: ' + mcpVolume.audio.paused`, true,
    );
    if (volSyncPlay !== 'playing') note(`vol-sync tone: ${volSyncPlay}`);
    const volSyncTabId = await evalIn(
      cdp, swSession,
      `chrome.tabs.query({url:'http://127.0.0.1:8080/test/volume-sync.html'}).then(t => t[0]?.id)`, true,
    );
    await seedRecent(volSyncTabId);
    await evalIn(cdp, popupSession2, `location.reload()`);
    await waitFor(() =>
      evalIn(
        cdp,
        popupSession2,
        `[...document.querySelectorAll('.row')].some(r => r.querySelector('.t-title').textContent.includes('Volume Sync'))`,
      ),
    );
    const volSyncRow = `[...document.querySelectorAll('.row')].find(r => r.querySelector('.t-title').textContent.includes('Volume Sync'))`;
    await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.vol-btn').click()`);
    await evalIn(
      cdp,
      popupSession2,
      `(() => { const v = (${volSyncRow}).querySelector('.vol'); v.value = '0.4'; v.dispatchEvent(new Event('input', { bubbles: true })); v.dispatchEvent(new Event('change', { bubbles: true })); })()`,
    );
    const siteFollowed = await waitFor(async () => {
      const state = await evalIn(
        cdp, volSyncSession,
        `({ events: mcpVolume.events(), indicator: mcpVolume.indicator(), volume: mcpVolume.audio.volume })`, true,
      );
      return state.events > 0 && state.indicator === '40%' && Math.abs(state.volume - 0.4) < 0.001 ? state : null;
    }).catch(() => null);
    siteFollowed
      ? ok('site volume indicator follows the standard volumechange event (no site adapter)')
      : bad(
          'site volume indicator follows the standard volumechange event (no site adapter)',
          JSON.stringify(await evalIn(cdp, volSyncSession, `({ events: mcpVolume.events(), indicator: mcpVolume.indicator(), volume: mcpVolume.audio.volume })`, true)),
        );
    const volSyncReadout = await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.vol-readout').textContent`);
    volSyncReadout === '40%'
      ? ok('popup volume readout matches the selected 5 % step value')
      : bad('popup volume readout matches the selected 5 % step value', `readout=${volSyncReadout}`);

    // --- two-way sync: site → extension, and the two mute truths -------------
    // The site's own volume control changes the element; the popup readout
    // must follow (the ping loop tracks the open card's element).
    await evalIn(cdp, volSyncSession, `mcpVolume.setSiteVolume(0.6)`);
    const siteToExt = await waitFor(
      () => evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.vol-readout').textContent === '60%'`),
    ).catch(() => null);
    siteToExt
      ? ok('native site volume change reaches the popup readout (60%)')
      : bad(
          'native site volume change reaches the popup readout (60%)',
          JSON.stringify({
            readout: await evalIn(cdp, popupSession2, `(${volSyncRow})?.querySelector('.vol-readout')?.textContent ?? null`),
            popOpen: await evalIn(cdp, popupSession2, `(${volSyncRow})?.querySelector('.vol-pop')?.classList.contains('open') ?? null`),
            rowPaused: await evalIn(cdp, popupSession2, `(${volSyncRow})?.classList.contains('paused') ?? null`),
            site: await evalIn(cdp, volSyncSession, `({ v: mcpVolume.audio.volume, paused: mcpVolume.audio.paused, ended: mcpVolume.audio.ended, ind: mcpVolume.indicator() })`, true),
          }),
        );

    // The site mutes its player natively: the popover's Player audio row must
    // show Muted while Tab audio stays Unmuted — two independent truths.
    await evalIn(cdp, volSyncSession, `mcpVolume.setSiteMuted(true)`);
    const playerMutedShown = await waitFor(
      () =>
        evalIn(
          cdp,
          popupSession2,
          `(${volSyncRow}).querySelector('.vol-state.player-audio .vs-value').textContent === 'Muted'`,
        ),
    ).catch(() => null);
    const tabAudioStill = await evalIn(
      cdp,
      popupSession2,
      `(${volSyncRow}).querySelector('.vol-state.tab-audio .vs-value').textContent`,
    );
    playerMutedShown && tabAudioStill === 'Unmuted'
      ? ok('native player mute shows in the popover; tab audio stays independent')
      : bad('native player mute shows in the popover; tab audio stays independent', `player=${playerMutedShown} tab="${tabAudioStill}"`);

    // Unmute through the extension's player-audio row: the site's own mute
    // indicator (driven only by volumechange) must follow.
    await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.vol-state.player-audio').click()`);
    const extUnmuteFollowed = await waitFor(
      () => evalIn(cdp, volSyncSession, `mcpVolume.muteIndicator() === 'off' && mcpVolume.audio.muted === false`),
    ).catch(() => null);
    const rowBackToUnmuted = await evalIn(
      cdp,
      popupSession2,
      `(${volSyncRow}).querySelector('.vol-state.player-audio .vs-value').textContent`,
    );
    extUnmuteFollowed && rowBackToUnmuted === 'Unmuted'
      ? ok('extension player-unmute reaches the element and the site UI follows')
      : bad('extension player-unmute reaches the element and the site UI follows', `followed=${extUnmuteFollowed} row="${rowBackToUnmuted}"`);

    // Tab mute (browser) and player mute (element) coexist without interference.
    await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.mute').click()`);
    await waitFor(() =>
      evalIn(cdp, swSession, `chrome.tabs.query({muted:true}).then(t => t.length === 1)`, true),
    );
    const tabMutedPlayerState = await evalIn(
      cdp,
      popupSession2,
      `({
         tab: (${volSyncRow}).querySelector('.vol-state.tab-audio .vs-value').textContent,
         player: (${volSyncRow}).querySelector('.vol-state.player-audio .vs-value').textContent,
       })`,
    );
    tabMutedPlayerState?.tab === 'Muted' && tabMutedPlayerState.player === 'Unmuted'
      ? ok('browser tab mute and native player mute are represented independently')
      : bad('browser tab mute and native player mute are represented independently', JSON.stringify(tabMutedPlayerState));
    await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.vol-state.tab-audio').click()`);
    await waitFor(() => evalIn(cdp, swSession, `chrome.tabs.query({muted:true}).then(t => t.length === 0)`));
    ok('the tab-audio row unmutes the tab (same authoritative tab-mute path)');

    // No state oscillation: with nothing changing, the site's event counters
    // stop growing — no duplicate writes loop anywhere.
    const evBefore = await evalIn(cdp, volSyncSession, `({ v: mcpVolume.events(), r: mcpVolume.rateEvents() })`, true);
    await sleep(1500);
    const evAfter = await evalIn(cdp, volSyncSession, `({ v: mcpVolume.events(), r: mcpVolume.rateEvents() })`, true);
    evAfter.v === evBefore.v && evAfter.r === evBefore.r
      ? ok(`no duplicate-update oscillation (volumechange ${evBefore.v}→${evAfter.v}, ratechange ${evBefore.r}→${evAfter.r})`)
      : bad('no duplicate-update oscillation', JSON.stringify({ evBefore, evAfter }));

    // Reopening the popup reads the CURRENT page state, not a stale snapshot:
    // native volume 0.55 + native mute, then a fresh popup + open popover.
    await evalIn(cdp, volSyncSession, `mcpVolume.setSiteVolume(0.55); mcpVolume.setSiteMuted(true)`);
    const popupR = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupRSession = (await cdp.send('Target.attachToTarget', { targetId: popupR.targetId, flatten: true })).sessionId;
    await waitFor(() =>
      evalIn(
        cdp,
        popupRSession,
        `[...document.querySelectorAll('.row')].some(r => r.querySelector('.t-title').textContent.includes('Volume Sync'))`,
      ),
    );
    const freshRow = `[...document.querySelectorAll('.row')].find(r => r.querySelector('.t-title').textContent.includes('Volume Sync'))`;
    await evalIn(cdp, popupRSession, `(${freshRow}).querySelector('.vol-btn').click()`);
    await sleep(500); // the popover-open ping lands
    const freshState = await evalIn(
      cdp,
      popupRSession,
      `({
         vol: (${freshRow}).querySelector('.vol-readout').textContent,
         player: (${freshRow}).querySelector('.vol-state.player-audio .vs-value').textContent,
         slider: Math.round(parseFloat((${freshRow}).querySelector('.vol').value) * 100),
       })`,
    );
    freshState.vol === '55%' && freshState.player === 'Muted' && freshState.slider === 55
      ? ok('reopened popup reads current volume (55%) and player mute — no stale snapshot, no jump-back')
      : bad('reopened popup reads current volume (55%) and player mute — no stale snapshot, no jump-back', JSON.stringify(freshState));
    await cdp.send('Target.closeTarget', { targetId: popupR.targetId });

    // Clean policy state first: an earlier section left a page override on the
    // media tab, which keeps enforcement active — and an active policy's page
    // manager correctly re-stamps the ps fixture's direct element writes back
    // to the inherited global rate. The adapter sync is what is under test
    // here, so clear the override and let the manager disconnect everywhere.
    await evalIn(
      cdp,
      popupSession2,
      `(() => {
         const r = [...document.querySelectorAll('.row')].find((x) => {
           const b = x.querySelector('.rate-reset');
           return b && !b.hidden;
         });
         if (r) r.querySelector('.rate-reset').click();
       })()`,
    );
    await waitFor(
      () =>
        evalIn(
          cdp,
          swSession,
          `chrome.storage.session.get('speedOverrides').then((s) => Object.keys(s.speedOverrides ?? {}).length === 0)`,
          true,
        ),
      15000,
    );

    // --- site adapter: private-player sync (the YouTube first-party case) ----
    // player-sync.html stands in for a site whose player UI is driven by a
    // PRIVATE player state with an API surface (#movie_player) — element
    // writes are invisible to its UI, exactly the reported YouTube behavior.
    // The adapter's syncPlayer is the reliable channel: element truth → API →
    // site UI. It runs in the MAIN world (page-JS objects are invisible to
    // the isolated world), feature-detects, and no-ops without the player.
    const psTarget = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/player-sync.html`,
    });
    const psSession = (await cdp.send('Target.attachToTarget', { targetId: psTarget.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, psSession, `!!window.mcpPS`));
    const psPlay = await evalIn(
      cdp, psSession,
      `mcpPS.play().then(() => 'played').catch(e => 'blocked: ' + e.name)`, true,
    );
    if (psPlay !== 'played') note(`player-sync tone: ${psPlay}`);
    const psTabId = await evalIn(
      cdp, swSession,
      `chrome.tabs.query({url:'http://127.0.0.1:8080/test/player-sync.html'}).then(t => t[0]?.id)`, true,
    );
    await seedRecent(psTabId);
    await evalIn(cdp, popupSession2, `location.reload()`);
    await waitFor(() =>
      evalIn(cdp, popupSession2, `[...document.querySelectorAll('.row')].some(r => r.querySelector('.t-title').textContent.includes('Player Sync'))`),
    );
    const psRow = `[...document.querySelectorAll('.row')].find(r => r.querySelector('.t-title').textContent.includes('Player Sync'))`;

    // generic two-way speed sync on the event-driven fixture: the site's own
    // rate choice is displayed exactly, and an extension step reaches the
    // site's readout through the standard ratechange event
    await evalIn(cdp, volSyncSession, `mcpVolume.setSiteRate(1.1)`);
    const siteSpeedShown = await waitFor(
      () => evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.rate-readout').textContent === '1.10×'`),
    ).catch(() => null);
    siteSpeedShown
      ? ok('native site speed change is displayed exactly (1.10×, no snap)')
      : bad('native site speed change is displayed exactly (1.10×, no snap)', `shown=${await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.rate-readout').textContent`)}`);
    await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.rate-inc').click()`);
    const extSpeedFollowed = await waitFor(
      () => evalIn(cdp, volSyncSession, `mcpVolume.rateIndicator() === '1.35×'`),
    ).catch(() => null);
    extSpeedFollowed
      ? ok('extension speed step reaches the site UI via the standard ratechange event (1.35×)')
      : bad('extension speed step reaches the site UI via the standard ratechange event (1.35×)', `site=${await evalIn(cdp, volSyncSession, `mcpVolume.rateIndicator()`)}`);
    await evalIn(cdp, popupSession2, `(${volSyncRow}).querySelector('.rate-reset').click()`);
    await waitFor(() => evalIn(cdp, volSyncSession, `Math.abs(mcpVolume.audio.playbackRate - 1) < 0.01`));

    // 1) element writes leave the private-player UI stale; the adapter sync
    //    carries the element truth into the player API for rate and volume
    //    (the channels where the element is authoritative)
    const sync1 = await evalIn(
      cdp,
      psSession,
      `(async () => {
         const { ADAPTERS } = await import('${EXT_URL}/lib/adapters.js');
         mcpPS.el.playbackRate = 1.5; mcpPS.el.volume = 0.4;
         const before = { ui: mcpPS.ui(), elRate: mcpPS.el.playbackRate };
         const res = ADAPTERS.youtube.syncPlayer();
         return { before, res, after: mcpPS.ui(), state: mcpPS.state() };
       })()`,
      true,
    );
    sync1?.before?.ui?.rate === '1.00×' && Math.abs(sync1.before.elRate - 1.5) < 0.001
      ? ok('private-player site UI ignores direct element writes (stale before the sync)')
      : bad('private-player site UI ignores direct element writes (stale before the sync)', JSON.stringify(sync1?.before));
    sync1?.after?.rate === '1.50×' && sync1.after.volume === '40%' &&
    Math.abs(sync1?.state?.apiRate - 1.5) < 0.001 && Math.abs(sync1?.state?.apiVolume - 40) < 0.001
      ? ok('adapter syncPlayer carries element rate/volume into the player API')
      : bad('adapter syncPlayer carries element rate/volume into the player API', JSON.stringify(sync1));

    // 1b) MUTE runs the other way: the player owns its mute model and a build
    //     that reasserts it over element writes must not lose the command (the
    //     reported YouTube failure). A raw element write is reverted; the
    //     adapter's setMuted goes through the player API and sticks, with the
    //     element aligned to it.
    const rawMute = await evalIn(
      cdp,
      psSession,
      `(async () => {
         mcpPS.el.muted = true;
         await new Promise((r) => setTimeout(r, 80)); // the player's reassertion task
         return { elMuted: mcpPS.el.muted, apiMuted: mcpPS.player.isMuted() };
       })()`,
      true,
    );
    rawMute?.apiMuted === false && rawMute?.elMuted === false
      ? ok('element-first mute is reverted by a reasserting player (the reported failure, reproduced)')
      : bad('element-first mute is reverted by a reasserting player (the reported failure, reproduced)', JSON.stringify(rawMute));
    const apiMute = await evalIn(
      cdp,
      psSession,
      `(async () => {
         const { ADAPTERS } = await import('${EXT_URL}/lib/adapters.js');
         const res = ADAPTERS.youtube.setMuted({ muted: true });
         await new Promise((r) => setTimeout(r, 120)); // reassertion would run now
         return { res, elMuted: mcpPS.el.muted, apiMuted: mcpPS.player.isMuted() };
       })()`,
      true,
    );
    apiMute?.res?.found === true && apiMute?.res?.muted === true && apiMute?.elMuted === true && apiMute?.apiMuted === true
      ? ok('adapter setMuted goes through the player API and survives reassertion (element aligned)')
      : bad('adapter setMuted goes through the player API and survives reassertion (element aligned)', JSON.stringify(apiMute));

    // 1c) native player mute/unmute is readable from the player itself, and
    //     the extension API can override a native choice both ways
    const nativeMute = await evalIn(
      cdp,
      psSession,
      `(async () => {
         const { ADAPTERS } = await import('${EXT_URL}/lib/adapters.js');
         mcpPS.player.mute(); // the site's own control
         const readMuted = ADAPTERS.youtube.readState();
         mcpPS.player.unMute();
         const readUnmuted = ADAPTERS.youtube.readState();
         const st = ADAPTERS.youtube.setMuted({ muted: false });
         return { readMuted, readUnmuted, st, elMuted: mcpPS.el.muted, apiMuted: mcpPS.player.isMuted() };
       })()`,
      true,
    );
    nativeMute?.readMuted?.muted === true && nativeMute?.readUnmuted?.muted === false &&
    nativeMute?.st?.found === true && nativeMute?.elMuted === false && nativeMute?.apiMuted === false
      ? ok('native mute is readable via the player state, and extension unmute overrides it')
      : bad('native mute is readable via the player state, and extension unmute overrides it', JSON.stringify(nativeMute));

    // 2) a player whose menu clamps (YouTube shows at most 2.00x) must not
    //    drag the ACTUAL playback below the requested rate: the sync restores
    //    the element and remembers what it reconciled, so it never re-fights.
    //    ratechange dispatches in a QUEUED task — sampled after a tick.
    const sync2 = await evalIn(
      cdp,
      psSession,
      `(async () => {
         const { ADAPTERS } = await import('${EXT_URL}/lib/adapters.js');
         const evs = mcpPS.events().ratechange;
         mcpPS.el.playbackRate = 2.5; // above the site's rate menu
         const res = ADAPTERS.youtube.syncPlayer();
         return { res, state: mcpPS.state(), ui: mcpPS.ui(), evs };
       })()`,
      true,
    );
    await sleep(400); // let the queued ratechange tasks dispatch
    const rateEventsAfter = await evalIn(cdp, psSession, `mcpPS.events().ratechange`, true);
    Math.abs(sync2?.state?.rate - 2.5) < 0.001 && Math.abs(sync2?.state?.apiRate - 2) < 0.001 &&
    sync2?.ui?.rate === '2.00×' && rateEventsAfter > sync2.evs
      ? ok('a clamping player menu cannot drag the media element down (element 2.50×, menu 2.00×)')
      : bad('a clamping player menu cannot drag the media element down (element 2.50×, menu 2.00×)', JSON.stringify({ sync2, rateEventsAfter }));
    // open the volume popover: its open fires a fresh ping (togglePopover),
    // so the card readout lands deterministically instead of whenever the
    // 1 s ping cadence happens to run
    await evalIn(cdp, popupSession2, `(${psRow}).querySelector('.vol-btn').click()`);
    const psShown = await waitFor(
      () => evalIn(cdp, popupSession2, `(${psRow}).querySelector('.rate-readout').textContent === '2.50×'`),
      15000,
    ).catch(() => null);
    psShown
      ? ok('the card shows the actual playback rate (2.50×), not the site menu’s 2.00×')
      : bad(
          'the card shows the actual playback rate (2.50×), not the site menu’s 2.00×',
          JSON.stringify({
            shown: await evalIn(cdp, popupSession2, `[...document.querySelectorAll('.row')].map(r => ({ t: r.querySelector('.t-title').textContent.slice(0, 14), rate: r.querySelector('.rate-readout').textContent }))`),
            psState: await evalIn(cdp, psSession, `mcpPS.state()`, true),
            stores: await evalIn(cdp, swSession, `Promise.all([chrome.storage.local.get('speed'), chrome.storage.session.get('speedOverrides')]).then(([l, s]) => JSON.stringify({ speed: l.speed, ov: s.speedOverrides ?? {} }))`, true),
          }),
        );

    // 3) idempotence: a settled sync writes nothing — no duplicate updates
    const evA = await evalIn(cdp, psSession, `mcpPS.events()`, true);
    await evalIn(
      cdp,
      psSession,
      `(async () => { const { ADAPTERS } = await import('${EXT_URL}/lib/adapters.js'); ADAPTERS.youtube.syncPlayer(); ADAPTERS.youtube.syncPlayer(); })()`,
      true,
    );
    const evB = await evalIn(cdp, psSession, `mcpPS.events()`, true);
    evA?.volumechange === evB?.volumechange && evA?.ratechange === evB?.ratechange
      ? ok('adapter sync is idempotent — a settled player sees zero duplicate writes')
      : bad('adapter sync is idempotent — a settled player sees zero duplicate writes', JSON.stringify({ evA, evB }));

    // 4) graceful no-op on pages without the private player
    const noPlayerTarget = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html?noplayer=1`,
    });
    const noPlayerSession = (await cdp.send('Target.attachToTarget', { targetId: noPlayerTarget.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, noPlayerSession, `!!document.querySelector('audio')`));
    const noPlayer = await evalIn(
      cdp,
      noPlayerSession,
      `(async () => { const { ADAPTERS } = await import('${EXT_URL}/lib/adapters.js'); return ADAPTERS.youtube.syncPlayer(); })()`,
      true,
    );
    noPlayer?.found === false
      ? ok('syncPlayer feature-detects and no-ops on pages without the player API')
      : bad('syncPlayer feature-detects and no-ops on pages without the player API', JSON.stringify(noPlayer));
    await cdp.send('Target.closeTarget', { targetId: noPlayerTarget.targetId });

    await cdp.send('Target.closeTarget', { targetId: psTarget.targetId });
    await cdp.send('Target.closeTarget', { targetId: volSyncTarget.targetId });

    // --- keyboard navigation ----------------------------------------------------------
    const keyNav = await evalIn(
      cdp,
      popupSession2,
      `(async () => {
        const rows = [...document.querySelectorAll('.row')];
        if (!rows.length) return { rows: 0 };
        rows[0].querySelector('.play').focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        const afterDown = document.activeElement.closest('.row');
        return { rows: rows.length, movedTo: rows.indexOf(afterDown), focused: document.activeElement.className };
      })()`,
      true,
    );
    keyNav?.rows >= 1 && keyNav.movedTo !== -1 && keyNav.focused.includes('play')
      ? ok(`arrow key focuses a row's play button (${keyNav.rows} row(s)) — multi-row walk covered in the mock`)
      : bad("arrow key focuses a row's play button", JSON.stringify(keyNav));

    // --- keyboard vs sliders -----------------------------------------------------------
    // A focused range slider owns all four arrows. Real key events via CDP so
    // the input's native adjustment actually runs.
    await evalIn(
      cdp,
      popupSession2,
      `(() => {
        const r = document.querySelector('.row');
        // no popover here: an open volume popover tracks the live element
        // value and would rewrite the slider between this write and the key
        const v = r.querySelector('.vol');
        v.value = '0.5';
        v.focus();
      })()`,
    );
    const pressArrow = (key, vk) =>
      cdp.send(
        'Input.dispatchKeyEvent',
        { type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk },
        popupSession2,
      );
    const sliderState = () =>
      evalIn(
        cdp,
        popupSession2,
        `({ on: document.activeElement.className, val: parseFloat(document.querySelector('.row .vol').value) })`,
      );
    await pressArrow('ArrowDown', 40);
    const afterDown = await sliderState();
    await pressArrow('ArrowUp', 38);
    const afterUp = await sliderState();
    const onSlider = (s) => s.on.includes('vol');
    afterDown.onSlider = onSlider(afterDown) && Math.abs(afterDown.val - 0.45) < 0.001;
    afterUp.onSlider = onSlider(afterUp) && Math.abs(afterUp.val - 0.5) < 0.001;
    afterDown.onSlider
      ? ok('ArrowDown adjusts the focused volume slider by 5 % (0.50 → 0.45), focus stays')
      : bad('ArrowDown adjusts the focused volume slider by 5 % (0.50 → 0.45), focus stays', JSON.stringify(afterDown));
    afterUp.onSlider
      ? ok('ArrowUp adjusts the focused volume slider back by 5 % (focus stays)')
      : bad('ArrowUp adjusts the focused volume slider back by 5 % (focus stays)', JSON.stringify(afterUp));
    const sliderSteps = await evalIn(
      cdp,
      popupSession2,
      `({
         vol: { step: document.querySelector('.row .vol').step, min: document.querySelector('.row .vol').min, max: document.querySelector('.row .vol').max },
         boost: { step: document.querySelector('.row .boost').step, min: document.querySelector('.row .boost').min, max: document.querySelector('.row .boost').max },
       })`,
    );
    sliderSteps?.vol?.step === '0.05' && sliderSteps.vol.min === '0' && sliderSteps.vol.max === '1' &&
    sliderSteps?.boost?.step === '10' && sliderSteps.boost.min === '100' && sliderSteps.boost.max === '600'
      ? ok('slider increments: volume 0–100 % in 5 % steps, boost 100–600 % in 10 % steps')
      : bad('slider increments: volume 0–100 % in 5 % steps, boost 100–600 % in 10 % steps', JSON.stringify(sliderSteps));
    await evalIn(cdp, popupSession2, `document.activeElement.blur()`); // release dragGuard

    // --- commands registered ----------------------------------------------------------
    const commands = await evalIn(
      cdp,
      swSession,
      `chrome.commands.getAll().then(c => c.map(x => x.name + '=' + (x.shortcut || 'unassigned')).join(', '))`, true,
    );
    commands.includes('toggle-target') && commands.includes('pause-all') && commands.includes('mute-all')
      ? ok(`keyboard commands registered (${commands})`)
      : bad('keyboard commands registered', commands);

    // --- volume boost (plumbing) ---------------------------------------------------------
    // Truth-first: whatever this browser allows, the UI must never show a
    // state the pipeline does not have. Capture audibility itself is a manual
    // checklist item (headless has no ears). Boost START is offered for the
    // viewed tab only (tabCapture targets need the activeTab grant), so make
    // the media tab the viewed tab and reload the popup to re-query.
    await evalIn(
      cdp,
      swSession,
      `chrome.tabs.query({url:'http://127.0.0.1:8080/test/media-page.html'}).then(t => chrome.tabs.update(t[0].id, {active: true}))`,
      true,
    );
    await evalIn(cdp, popupSession2, `location.reload()`);
    await waitFor(() => evalIn(cdp, popupSession2, `document.querySelectorAll('.row').length >= 1`));
    const bBoostGated = await evalIn(
      cdp,
      popupSession2,
      `[...document.querySelectorAll('.row')][1]
         ? [...document.querySelectorAll('.row')][1].querySelector('.boost-btn').disabled
         : null`,
    );
    bBoostGated === true
      ? ok('boost start is gated to the viewed tab (background card disabled)')
      : bad('boost start is gated to the viewed tab (background card disabled)', `disabled=${bBoostGated}`);

    const boostDefault = await evalIn(
      cdp,
      swSession,
      `Promise.all([chrome.storage.session.get('boosts'), chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})])
        .then(([s, cs]) => (!s.boosts || Object.keys(s.boosts).length === 0) && cs.length === 0)`,
      true,
    );
    boostDefault
      ? ok('boost defaults to 100% — no capture pipeline, no state')
      : bad('boost defaults to 100% — no capture pipeline, no state', 'pre-existing boost state or offscreen doc');

    await evalGesture(cdp, popupSession2, `document.querySelector('.row .boost-btn').click()`);
    await evalGesture(
      cdp,
      popupSession2,
      `(() => { const b = document.querySelector('.row .boost'); b.value = '250'; b.dispatchEvent(new Event('input', {bubbles:true})); })()`,
    );
    let boostOutcome = null;
    try {
      boostOutcome = await waitFor(
        () =>
          evalIn(
            cdp,
            popupSession2,
            `(() => {
               const btn = document.querySelector('.row .boost-btn');
               if (btn.classList.contains('active') && btn.textContent.includes('250')) return 'active';
               const st = document.querySelector('.row .boost-status');
               if (st && st.textContent) return 'error';
               return null;
             })()`,
          ),
        12000,
      );
    } catch {
      boostOutcome = 'stuck';
    }
    // Which popup is live when the settings section starts.
    let settingsPopup = null;

    if (boostOutcome === 'active') {
      ok('boost capture established — chip shows 250% truthfully');
      const offscreenUp = await evalIn(
        cdp,
        swSession,
        `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(cs => cs.length === 1)`,
        true,
      );
      offscreenUp
        ? ok('offscreen audio document created for the boost pipeline')
        : bad('offscreen audio document created for the boost pipeline', 'no offscreen document');
      const boostState = await evalIn(
        cdp,
        swSession,
        `chrome.storage.session.get('boosts').then(s => Object.values(s.boosts ?? {})[0]?.state)`,
        true,
      );
      boostState === 'active'
        ? ok('boost session state is truthful (active)')
        : bad('boost session state is truthful (active)', `state=${boostState}`);

      // gain update moves the existing pipeline — no second offscreen doc
      await evalGesture(
        cdp,
        popupSession2,
        `(() => { const b = document.querySelector('.row .boost'); b.value = '300'; b.dispatchEvent(new Event('input', {bubbles:true})); })()`,
      );
      await waitFor(() =>
        evalIn(cdp, swSession, `chrome.storage.session.get('boosts').then(s => Object.values(s.boosts ?? {})[0]?.gain === 300)`),
      );
      const stillOne = await evalIn(
        cdp,
        swSession,
        `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(cs => cs.length)`,
        true,
      );
      stillOne === 1
        ? ok('gain slider updates the running pipeline (no duplicate offscreen doc)')
        : bad('gain slider updates the running pipeline (no duplicate offscreen doc)', `docs=${stillOne}`);

      // popup close must not kill an active boost
      await cdp.send('Target.closeTarget', { targetId: popup2.targetId });
      await sleep(500);
      const boostSurvives = await evalIn(
        cdp,
        swSession,
        `Promise.all([chrome.storage.session.get('boosts'), chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})])
          .then(([s, cs]) => Object.values(s.boosts ?? {})[0]?.state === 'active' && cs.length === 1)`,
        true,
      );
      boostSurvives
        ? ok('popup close leaves the active boost running (offscreen owns it)')
        : bad('popup close leaves the active boost running (offscreen owns it)', 'boost lost on popup close');

      // reopen: state restored from session, still truthful
      const popupB = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
      const popupBSession = (await cdp.send('Target.attachToTarget', { targetId: popupB.targetId, flatten: true })).sessionId;
      await sleep(700);
      const chipRestored = await evalIn(
        cdp,
        popupBSession,
        `[...document.querySelectorAll('.row')].some(r => r.querySelector('.boost-btn').classList.contains('active') && r.querySelector('.boost-btn').textContent.includes('300'))`,
      );
      chipRestored
        ? ok('reopened popup restores the active boost state from session')
        : bad('reopened popup restores the active boost state from session', 'chip not active after reopen');

      // reset to 100% releases everything
      await evalIn(cdp, popupBSession, `document.querySelector('.row .boost-btn').click()`);
      await evalIn(cdp, popupBSession, `document.querySelector('.row .boost-reset').click()`);
      await waitFor(async () => {
        const cleared = await evalIn(
          cdp,
          swSession,
          `Promise.all([chrome.storage.session.get('boosts'), chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})])
            .then(([s, cs]) => (!s.boosts || Object.keys(s.boosts).length === 0) && cs.length === 0)`,
          true,
        );
        return cleared;
      });
      ok('reset to 100% releases capture + offscreen document');
      await cdp.send('Target.closeTarget', { targetId: popupB.targetId });
      settingsPopup = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
      popupSession2 = (await cdp.send('Target.attachToTarget', { targetId: settingsPopup.targetId, flatten: true })).sessionId;
      await sleep(600);
    } else {
      if (boostOutcome === 'error') {
        ok('boost failure surfaces a truthful error state (capture refused by this browser)');
        // a failed startup must release the offscreen document — USER_MEDIA
        // has no inactivity lifetime, so this cleanup is the only guard
        const errDocClosed = await waitFor(
          () =>
            evalIn(
              cdp,
              swSession,
              `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(cs => cs.length === 0)`,
              true,
            ),
          6000,
        ).catch(() => false);
        errDocClosed
          ? ok('failed capture releases the offscreen document (no lingering pipeline doc)')
          : bad('failed capture releases the offscreen document (no lingering pipeline doc)', 'offscreen document survived a failed startup');
        note('real capture/audibility could not be exercised here — manual checklist item');
      } else {
        bad('boost reaches a truthful terminal state (active or error)', `outcome=${boostOutcome}`);
      }
      await cdp.send('Target.closeTarget', { targetId: popup2.targetId });
      settingsPopup = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
      popupSession2 = (await cdp.send('Target.attachToTarget', { targetId: settingsPopup.targetId, flatten: true })).sessionId;
      await sleep(600);
    }

    // --- settings -----------------------------------------------------------------
    await evalIn(cdp, popupSession2, `document.getElementById('settings-toggle').click()`);
    const panelOpen = await evalIn(
      cdp,
      popupSession2,
      `document.getElementById('settings').classList.contains('open') &&
       document.getElementById('settings-toggle').getAttribute('aria-expanded') === 'true'`,
    );
    panelOpen ? ok('settings panel opens from the header') : bad('settings panel opens from the header', 'panel not open');

    // --- appearance: System / Light / Dark, applied and persisted ----------------
    const defaultTheme = await evalIn(
      cdp,
      popupSession2,
      `({ attr: document.documentElement.dataset.theme, stored: null, system: matchMedia('(prefers-color-scheme: dark)').matches })`,
    );
    defaultTheme.attr === 'system'
      ? ok('appearance defaults to System')
      : bad('appearance defaults to System', JSON.stringify(defaultTheme));
    const setTheme = async (value) => {
      await evalIn(cdp, popupSession2, `document.querySelector('[data-theme-value="${value}"]').click()`);
      await sleep(220);
      return evalIn(
        cdp,
        popupSession2,
        `(async () => {
           const s = await chrome.storage.local.get('settings');
           const prev = document.querySelector('.row .prev');
           return {
             attr: document.documentElement.dataset.theme,
             stored: s.settings?.theme,
             paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
             card: getComputedStyle(document.documentElement).getPropertyValue('--card').trim(),
             htmlBg: getComputedStyle(document.documentElement).backgroundColor,
             bodyBg: getComputedStyle(document.body).backgroundColor,
             bodyRadius: getComputedStyle(document.body).borderRadius,
             cardRadius: document.querySelector('.row .card') ? getComputedStyle(document.querySelector('.row .card')).borderRadius : null,
             disabledColor: prev ? getComputedStyle(prev).color : null,
             warnColor: getComputedStyle(document.querySelector('.row .boost-warn')).color,
             checked: document.querySelector('[data-theme-value="${value}"]').getAttribute('aria-checked'),
           };
         })()`,
        true,
      );
    };
    const lightTheme = await setTheme('light');
    lightTheme.attr === 'light' && lightTheme.stored === 'light' && lightTheme.paper === '#ffffff' &&
    lightTheme.card === '#ffffff' && lightTheme.disabledColor === 'rgb(181, 181, 181)' && lightTheme.checked === 'true' &&
    lightTheme.htmlBg === 'rgb(255, 255, 255)' && lightTheme.bodyBg === lightTheme.htmlBg &&
    lightTheme.bodyRadius === '14px' && lightTheme.cardRadius === '12px'
      ? ok('Light applies to the stage, cards and disabled controls (persisted); frame gap-free, inner surface rounded')
      : bad('Light applies to the stage, cards and disabled controls (persisted); frame gap-free, inner surface rounded', JSON.stringify(lightTheme));
    const darkTheme = await setTheme('dark');
    darkTheme.attr === 'dark' && darkTheme.stored === 'dark' && darkTheme.paper === '#141414' &&
    darkTheme.card === '#1b1b1b' && darkTheme.disabledColor === 'rgb(90, 90, 90)' &&
    darkTheme.warnColor === 'rgb(154, 154, 154)' && darkTheme.checked === 'true' &&
    darkTheme.htmlBg === 'rgb(20, 20, 20)' && darkTheme.bodyBg === darkTheme.htmlBg &&
    darkTheme.bodyRadius === '14px' && darkTheme.cardRadius === '12px'
      ? ok('Dark applies to the stage, cards, popovers and disabled controls (persisted); frame gap-free, inner surface rounded')
      : bad('Dark applies to the stage, cards, popovers and disabled controls (persisted); frame gap-free, inner surface rounded', JSON.stringify(darkTheme));
    const systemTheme = await setTheme('system');
    systemTheme.attr === 'system' && systemTheme.stored === 'system' && systemTheme.checked === 'true'
      ? ok('System remains selectable and is stored as the preference')
      : bad('System remains selectable and is stored as the preference', JSON.stringify(systemTheme));
    // leave Dark stored: the reopen below proves it survives a popup cycle
    await setTheme('dark');

    await evalIn(cdp, popupSession2, `document.getElementById('set-autopause').click()`);
    const autoPauseStored = await evalIn(
      cdp,
      swSession,
      `chrome.storage.local.get('settings').then(s => s.settings?.autoPauseOnOpen === true)`,
      true,
    );
    autoPauseStored
      ? ok('auto-pause toggle persists to storage.local')
      : bad('auto-pause toggle persists to storage.local', JSON.stringify(autoPauseStored));

    await cdp.send('Target.closeTarget', { targetId: settingsPopup.targetId });
    await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].play()`);
    await waitFor(() => evalIn(cdp, swSession, `chrome.action.getBadgeText({}).then(t => t === '1')`));
    const popup3 = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupSession3 = (await cdp.send('Target.attachToTarget', { targetId: popup3.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].paused`));
    ok('auto-pause on open pauses playing media');

    // the appearance preference survives the popup close/reopen cycle
    const reopenedTheme = await evalIn(
      cdp,
      popupSession3,
      `(async () => {
         const s = await chrome.storage.local.get('settings');
         return {
           attr: document.documentElement.dataset.theme,
           stored: s.settings?.theme,
           paper: getComputedStyle(document.documentElement).getPropertyValue('--paper').trim(),
         };
       })()`,
      true,
    );
    reopenedTheme.attr === 'dark' && reopenedTheme.stored === 'dark' && reopenedTheme.paper === '#141414'
      ? ok('Dark preference survives popup close/reopen')
      : bad('Dark preference survives popup close/reopen', JSON.stringify(reopenedTheme));
    // return to the default so the rest of the run is appearance-neutral
    await evalIn(cdp, popupSession3, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popupSession3, `document.querySelector('[data-theme-value="system"]').click()`);
    await sleep(200);

    // From here on, nothing may depend on Chrome clearing tab.audible: in
    // headless the flag can latch after an injected pause. So the badge
    // toggles run on a throwaway audible tab, and the recent-list checks run
    // on a never-played silent tab planted in the recent list.
    await cdp.send('Target.closeTarget', { targetId: media.targetId });
    await cdp.send('Target.closeTarget', { targetId: media2b.targetId });
    const audibleTab = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html`,
    });
    const audibleSession = (await cdp.send('Target.attachToTarget', { targetId: audibleTab.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, audibleSession, `!!document.querySelector('audio')`));

    // badge toggle reacts live through the sleeping worker (needs audibility)
    await evalIn(cdp, audibleSession, `document.querySelector('audio').play()`);
    if (AUDIBLE_OK) {
      await waitFor(() => evalIn(cdp, swSession, `chrome.action.getBadgeText({}).then(t => t === '1')`));
      await evalIn(cdp, popupSession3, `document.getElementById('set-badge').click()`);
      await waitFor(() => evalIn(cdp, swSession, `chrome.action.getBadgeText({}).then(t => t === '')`));
      ok('badge toggle off clears the badge immediately');
      await evalIn(cdp, popupSession3, `document.getElementById('set-badge').click()`);
      await waitFor(() => evalIn(cdp, swSession, `chrome.action.getBadgeText({}).then(t => t === '1')`));
      ok('badge toggle on restores the badge');
    } else {
      note('badge-toggle assertions skipped: tab audibility not reported here');
    }
    await cdp.send('Target.closeTarget', { targetId: audibleTab.targetId });

    // A silent, never-played tab lands in the recent list only through the
    // planted session entry — a clean stand-in for "played earlier, paused now".
    const silentTab = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html`,
    });
    const silentSession = (await cdp.send('Target.attachToTarget', { targetId: silentTab.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, silentSession, `!!document.querySelector('audio')`));
    const silentTabId = await evalIn(cdp, swSession, `chrome.tabs.query({}).then(t => t.find(x => (x.url || '').includes('media-audio')).id)`, true);
    // the pin test left the old media tab pinned; a pinned tab earns its row
    // no matter what, so drop the pin to observe the recent list's effect alone
    await evalIn(cdp, swSession, `chrome.storage.session.remove('target')`);
    await evalIn(cdp, swSession, `chrome.storage.session.set({ recent: [${silentTabId}] })`);

    await cdp.send('Target.closeTarget', { targetId: popup3.targetId });
    const popup4 = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupSession4 = (await cdp.send('Target.attachToTarget', { targetId: popup4.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, popupSession4, `document.querySelectorAll('.row').length === 1`));
    const listedPaused = await evalIn(
      cdp,
      popupSession4,
      `document.querySelector('.row').classList.contains('paused')`,
    );
    listedPaused
      ? ok('planted silent recent tab listed (paused) while setting is on')
      : bad('planted silent recent tab listed (paused) while setting is on', 'row not paused');

    // toggling the recent list off prunes exactly such rows, live
    await evalIn(cdp, popupSession4, `document.getElementById('set-recent').click()`);
    await waitFor(() => evalIn(cdp, popupSession4, `document.querySelectorAll('.row').length === 0`));
    ok('recently-playing off drops its rows immediately');
    const recentCleared = await evalIn(
      cdp,
      swSession,
      `chrome.storage.session.get('recent').then(s => !s.recent || s.recent.length === 0)`,
      true,
    );
    recentCleared
      ? ok('recent list cleared when the toggle goes off')
      : bad('recent list cleared when the toggle goes off', 'session recent still populated');

    await cdp.send('Target.closeTarget', { targetId: popup4.targetId });
    const popup5 = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupSession5 = (await cdp.send('Target.attachToTarget', { targetId: popup5.targetId, flatten: true })).sessionId;
    await sleep(800);
    const emptyWithNoRecent = await evalIn(
      cdp,
      popupSession5,
      `document.getElementById('empty').hidden === false && document.querySelectorAll('.row').length === 0`,
    );
    emptyWithNoRecent
      ? ok('recently-playing off leaves paused media tabs unlisted')
      : bad('recently-playing off leaves paused media tabs unlisted', 'empty state not shown');

    // --- speed regression matrix (deterministic fixture, no network) ------------
    // One continuous scenario over test/speed-suite.html — generated 180 s
    // tones, so nothing ends mid-assert. Covers the shipped state model
    // (DESIGN.md R1–R7): policy revs, SPA survival, native adoption, resets,
    // rapid interactions, popup reopen cycles, managed-tab reachability.
    // The rev/stale-report internals additionally run in the background mock.
    const fix = {};
    const openFixture = async (tag) => {
      const t = await cdp.send('Target.createTarget', {
        url: `http://127.0.0.1:${SERVE_PORT}/test/speed-suite.html?t=${tag}`,
      });
      const s = (await cdp.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).sessionId;
      await waitFor(() => evalIn(cdp, s, `!!window.mcpFix`));
      fix[tag] = { targetId: t.targetId, session: s };
      await evalIn(cdp, s, `mcpFix.play(0)`, true);
      const id = await evalIn(
        cdp, swSession,
        `chrome.tabs.query({url:'http://127.0.0.1:8080/test/speed-suite.html*'}).then(ts => ts.find(x => (x.url || '').includes('t=${tag}'))?.id)`, true,
      );
      if (id) await seedRecent(id);
      return id;
    };
    await openFixture('A');
    await openFixture('B');
    // the original sections enabled auto-pause-on-open; the matrix popup must
    // not pause the fixtures it is about to drive
    await evalIn(
      cdp, swSession,
      `chrome.storage.local.set({ settings: { autoPauseOnOpen: false, badge: true, recentTabs: true } })`,
    );
    await cdp.send('Target.closeTarget', { targetId: popup5.targetId });
    let pm = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let pmS = (await cdp.send('Target.attachToTarget', { targetId: pm.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, pmS, `document.querySelectorAll('.row').length >= 2`), 15000);

    // Cross-context syncs (popup -> worker -> page) on a busy headless
    // browser occasionally outrun the default 8 s; same conditions, more
    // patience.
    const waitSync = (fn) => waitFor(fn, 15000);
    const rowExpr = (tag, inner) =>
      `(function(){ const r=[...document.querySelectorAll('.row')].find(x => x.querySelector('.t-title').textContent.includes('${tag}')); return r ? (${inner}) : null; })()`;
    const openOverrides = async () =>
      evalIn(cdp, swSession, `chrome.storage.session.get('speedOverrides').then(s => s.speedOverrides ?? {})`, true);
    const reopenPopup = async () => {
      await cdp.send('Target.closeTarget', { targetId: pm.targetId });
      await sleep(250);
      pm = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
      pmS = (await cdp.send('Target.attachToTarget', { targetId: pm.targetId, flatten: true })).sessionId;
      await waitFor(() => evalIn(cdp, pmS, `document.querySelectorAll('.row').length >= 2`), 15000);
    };

    // 1. global 2.00× — playing media follows, and the policy is stamped into
    //    defaultPlaybackRate so source reloads inherit it (R4)
    for (let i = 0; i < 4; i++) {
      await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
      await sleep(40);
    }
    try {
      await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '2.00×'`));
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, pmS, `JSON.stringify({ shown: document.getElementById('gspeed-value').textContent, incDisabled: document.getElementById('gspeed-inc').disabled, rows: document.querySelectorAll('.row').length })`),
        evalIn(cdp, swSession, `chrome.storage.local.get('speed').then(s => s.speed)`, true),
      ]);
      note(`matrix-1 diagnostics: popup=${diag[0]} stored=${diag[1]}`);
      throw new Error('matrix global never reached 2.00×');
    }
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 2) < 0.01`));
    ok('speed-matrix 1: global 2.00× reaches playing media in a fresh tab');
    const stampedDefault = await evalIn(cdp, fix.A.session, `mcpFix.defaults()[0]`, true);
    Math.abs(stampedDefault - 2) < 0.01
      ? ok('speed-matrix 1b: policy stamped into defaultPlaybackRate (source reloads inherit)')
      : bad('speed-matrix 1b: policy stamped into defaultPlaybackRate (source reloads inherit)', `default=${stampedDefault}`);

    // 2. native player speed 1.50× — adopted as the page override. Wait out
    //    the player-settling window first: immediately after attach/play a
    //    1.00×-style write is player setup, not a user choice (matrix 4/6
    //    cover that side explicitly).
    await sleep(2200);
    await evalIn(cdp, fix.A.session, `mcpFix.rate(0, 1.5)`);
    await waitSync(() => evalIn(cdp, pmS, rowExpr('A', `!r.querySelector('.rate-reset').hidden`)));
    const aReadout15 = await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-readout').textContent`));
    aReadout15 === '1.50×'
      ? ok('speed-matrix 2: native 1.50× adopted and displayed as the page override')
      : bad('speed-matrix 2: native 1.50× adopted and displayed as the page override', `readout=${aReadout15}`);

    // 3. global → 2.50×: the overriding page keeps 1.50×, inheriting B moves
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    try {
      await waitSync(() => evalIn(cdp, fix.B.session, `Math.abs(mcpFix.rates()[0] - 2.5) < 0.01`));
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, fix.B.session, `JSON.stringify({ rates: mcpFix.rates(), playing: mcpFix.playing(), fix: !!window.mcpFix })`).catch((e) => `eval: ${e.message}`),
        evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent`),
        evalIn(cdp, swSession, `Promise.all([chrome.storage.local.get('speed'), chrome.storage.session.get(['speedOverrides','speedRevs','speedManaged'])]).then(([l, s]) => JSON.stringify({ speed: l.speed, ...s }))`, true),
      ]);
      note(`matrix-3 diagnostics: B=${diag[0]} popup=${diag[1]} session=${diag[2]}`);
      throw new Error('B never reached 2.50× in matrix 3');
    }
    const aStill15 = await evalIn(cdp, fix.A.session, `mcpFix.rates()[0]`, true);
    Math.abs(aStill15 - 1.5) < 0.01
      ? ok('speed-matrix 3: global change moved inheriting B to 2.50× and left overridden A at 1.50×')
      : bad('speed-matrix 3: global change moved inheriting B to 2.50× and left overridden A at 1.50×', `A=${aStill15}`);

    // 4. SPA next video on A (pushState + fresh element): the override must
    //    survive the same-document transition and govern the new element (R2/R3)
    await evalIn(
      cdp,
      fix.A.session,
      `(async () => { mcpFix.pushState('?t=A&v=2'); const i = mcpFix.newMedia(); await mcpFix.play(i); return i; })()`,
      true,
    );
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[2] - 1.5) < 0.01`));
    // the site's player writes its own default rate while setting up the new
    // video — exactly what YouTube does; the override must win. A source
    // reload re-opens the player-settling window deterministically.
    await evalIn(
      cdp,
      fix.A.session,
      `(async () => { mcpFix.swapSrc(2); await mcpFix.play(2); mcpFix.rate(2, 1); })()`,
      true,
    );
    await sleep(800);
    const spaInitRate = await evalIn(cdp, fix.A.session, `mcpFix.rates()[2]`, true);
    const ovAfterSpa = await openOverrides();
    Math.abs(spaInitRate - 1.5) < 0.01 &&
    Object.values(ovAfterSpa).some((o) => Math.abs(o.rate - 1.5) < 1e-9)
      ? ok('speed-matrix 4: SPA video change keeps the page override; player init write is re-stamped (1.50×)')
      : bad(
          'speed-matrix 4: SPA video change keeps the page override; player init write is re-stamped (1.50×)',
          `rate=${spaInitRate} overrides=${JSON.stringify(ovAfterSpa)}`,
        );

    // 5. extension stepper builds on the current effective rate
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-inc').click()`));
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 1.75) < 0.01`));
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-dec').click()`));
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 1.5) < 0.01`));
    ok('speed-matrix 5: page stepper steps from the effective rate (1.50→1.75→1.50)');

    // 6. reset to global: current media AND the next videos follow 2.50× —
    //    including a player that writes 1.00× while setting each one up
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-reset').click()`));
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 2.5) < 0.01`));
    let lastSpaIndex = await evalIn(
      cdp,
      fix.A.session,
      `(async () => { const i = mcpFix.newMedia(); await mcpFix.play(i); return i; })()`,
      true,
    );
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[${lastSpaIndex}] - 2.5) < 0.01`));
    // now that the manager owns the element, the player re-loads the source
    // and initializes it at 1× — the policy must be re-stamped
    await evalIn(
      cdp,
      fix.A.session,
      `(async () => { mcpFix.swapSrc(${lastSpaIndex}); await mcpFix.play(${lastSpaIndex}); mcpFix.rate(${lastSpaIndex}, 1); })()`,
      true,
    );
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[${lastSpaIndex}] - 2.5) < 0.01`));
    // repeated replacement videos: every one keeps the reset policy
    for (let k = 0; k < 3; k++) {
      lastSpaIndex = await evalIn(
        cdp,
        fix.A.session,
        `(async () => { const i = mcpFix.newMedia(); await mcpFix.play(i); return i; })()`,
        true,
      );
      await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[${lastSpaIndex}] - 2.5) < 0.01`));
      await evalIn(
        cdp,
        fix.A.session,
        `(async () => { mcpFix.swapSrc(${lastSpaIndex}); await mcpFix.play(${lastSpaIndex}); mcpFix.rate(${lastSpaIndex}, 1); })()`,
        true,
      );
      await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[${lastSpaIndex}] - 2.5) < 0.01`));
    }
    ok('speed-matrix 6: reset-to-global survives repeated SPA video replacement (2.50×)');

    // 7. native 1.00× under global 2.50× is a real override (matrix #7).
    // One native write, one report, one adoption — deep into a long run a
    // single cross-context chain can outrun even 15 s, so nudge once more
    // (a user re-picking the rate is the same behavior) before failing.
    const matrix7Readout = () =>
      evalIn(cdp, pmS, rowExpr('A', `!r.querySelector('.rate-reset').hidden && r.querySelector('.rate-readout').textContent === '1.00×'`));
    await evalIn(cdp, fix.A.session, `mcpFix.rate(0, 1)`);
    if (!(await waitSync(matrix7Readout).catch(() => null))) {
      await evalIn(cdp, fix.A.session, `mcpFix.rate(0, 1)`);
      await waitSync(matrix7Readout);
    }
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '2.75×'`));
    await sleep(500);
    const aNative1 = await evalIn(cdp, fix.A.session, `mcpFix.rates()[0]`, true);
    Math.abs(aNative1 - 1) < 0.01
      ? ok('speed-matrix 7: native 1.00× respected as override; global 2.75× left it alone')
      : bad('speed-matrix 7: native 1.00× respected as override; global 2.75× left it alone', `A=${aNative1}`);

    // 8. rapid interactions (matrix #8): fast stepper commands converge on the
    //    last choice; fast global changes never drag an overriding page back
    for (let i = 0; i < 3; i++) {
      await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-inc').click()`));
      await sleep(60);
    }
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 1.75) < 0.01`));
    await sleep(800);
    const aStable175 = await evalIn(cdp, fix.A.session, `mcpFix.rates()[0]`, true);
    Math.abs(aStable175 - 1.75) < 0.01
      ? ok('speed-matrix 8a: three rapid page-speed commands land on the final choice (1.75×)')
      : bad('speed-matrix 8a: three rapid page-speed commands land on the final choice (1.75×)', `A=${aStable175}`);
    await evalIn(cdp, fix.A.session, `mcpFix.rate(0, 1.1)`);
    await waitSync(() => evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-readout').textContent === '1.10×'`)));
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await sleep(1000);
    const aStable11 = await evalIn(cdp, fix.A.session, `mcpFix.rates()[0]`, true);
    Math.abs(aStable11 - 1.1) < 0.01
      ? ok('speed-matrix 8b: rapid global changes never restore an obsolete value (A holds 1.10×)')
      : bad('speed-matrix 8b: rapid global changes never restore an obsolete value (A holds 1.10×)', `A=${aStable11}`);

    // 9. pause/resume across a global change keeps the policy (matrix #9)
    await evalIn(cdp, fix.B.session, `mcpFix.pause(0)`);
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '3.75×'`));
    await evalIn(cdp, fix.B.session, `mcpFix.play(0)`);
    try {
      await waitSync(() => evalIn(cdp, fix.B.session, `Math.abs(mcpFix.rates()[0] - 3.75) < 0.01`));
    } catch {
      const diag = await Promise.all([
        evalIn(cdp, fix.B.session, `JSON.stringify({ rates: mcpFix.rates(), playing: mcpFix.playing() })`).catch((e) => `eval: ${e.message}`),
        evalIn(cdp, swSession, `Promise.all([chrome.storage.local.get('speed'), chrome.storage.session.get(['speedOverrides','speedRevs','speedManaged','recent'])]).then(([l, s]) => JSON.stringify({ speed: l.speed, ...s }))`, true),
      ]);
      note(`matrix-9 diagnostics: B=${diag[0]} session=${diag[1]}`);
      throw new Error('B never reached 3.75× on resume');
    }
    ok('speed-matrix 9: media paused across a global change inherits on resume (B 3.75×)');

    // 10. one element ends while a policy change is in flight (matrix #10)
    const endingIndex = await evalIn(
      cdp,
      fix.A.session,
      `(async () => { const i = mcpFix.newMedia('audio', 2); await mcpFix.play(i); return i; })()`,
      true,
    );
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-dec').click()`));
    await waitSync(() => evalIn(cdp, fix.A.session, `mcpFix.els[${endingIndex}].ended`));
    const nextIndex = await evalIn(
      cdp,
      fix.A.session,
      `(async () => { const i = mcpFix.newMedia(); await mcpFix.play(i); return i; })()`,
      true,
    );
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[${nextIndex}] - 0.85) < 0.01`));
    ok('speed-matrix 10: media ending mid-command does not strand the next element (follows 0.85×)');

    // 11. popup close/reopen cycles keep state truthful (matrix #11)
    await reopenPopup();
    const reopenReadout = await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-readout').textContent`));
    reopenReadout === '0.85×'
      ? ok('speed-matrix 11: popup reopen shows the same page override (A 0.85×)')
      : bad('speed-matrix 11: popup reopen shows the same page override (A 0.85×)', `readout=${reopenReadout}`);

    // 12. off-grid native rate: exact display, exact adoption, grid stepping (matrix #12)
    await evalIn(cdp, fix.A.session, `mcpFix.rate(3, 1.1)`);
    await waitSync(() => evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-readout').textContent === '1.10×'`)));
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-inc').click()`));
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[3] - 1.35) < 0.001`));
    ok('speed-matrix 12: native 1.10× preserved exactly; extension step lands on the grid (1.35×)');

    // 13. global reset to 1.00× — nobody is stranded at the old rate (matrix #13)
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-reset').click()`));
    await evalIn(cdp, pmS, `document.getElementById('gspeed-reset').click()`);
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '1.00×'`));
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 1) < 0.01 && Math.abs(mcpFix.rates()[3] - 1) < 0.01`));
    await waitSync(() => evalIn(cdp, fix.B.session, `Math.abs(mcpFix.rates()[0] - 1) < 0.01`));
    await evalIn(cdp, fix.B.session, `(async () => { const i = mcpFix.newMedia(); await mcpFix.play(i); })()`, true);
    await waitSync(() => evalIn(cdp, fix.B.session, `Math.abs(mcpFix.rates()[1] - 1) < 0.01`));
    ok('speed-matrix 13: global 1.00× restore reaches current and future inheriting media (no stranding)');

    // 14. a managed tab outside the candidate list still hears the policy (matrix #14)
    // B is playing and listed → managed at 2.00×. Then it loses every
    // detection candidacy (headless: not audible, not muted, recent pruned,
    // unpinned) — a further global change must still reach it via the
    // managed-tab union.
    for (let i = 0; i < 4; i++) {
      await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
      await sleep(40);
    }
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '2.00×'`));
    await waitSync(() => evalIn(cdp, fix.B.session, `Math.abs(mcpFix.rates()[0] - 2) < 0.01`));
    const aTabIdM = await evalIn(
      cdp, swSession,
      `chrome.tabs.query({url:'http://127.0.0.1:8080/test/speed-suite.html*'}).then(ts => ts.find(x => (x.url || '').includes('t=A'))?.id)`, true,
    );
    await evalIn(cdp, swSession, `chrome.storage.session.set({ recent: [${aTabIdM}] })`);
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
    await waitSync(() => evalIn(cdp, fix.B.session, `Math.abs(mcpFix.rates()[0] - 2.5) < 0.01`));
    ok('speed-matrix 14: global change reaches a managed tab detection no longer lists (B 2.50×)');

    // 15. full top-level navigation clears the page override (matrix #15)
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-inc').click()`));
    await waitSync(() => evalIn(cdp, pmS, rowExpr('A', `!r.querySelector('.rate-reset').hidden`)));
    await evalIn(cdp, fix.A.session, `location.href = 'http://127.0.0.1:${SERVE_PORT}/test/speed-suite.html?t=A2'`);
    await waitSync(async () => {
      const ov = await openOverrides();
      return !Object.values(ov).some((o) => (o.url || '').includes('speed-suite.html?t=A'));
    });
    ok('speed-matrix 15: full navigation clears the page override');

    // 15b. a hard reload of the SAME URL is a new document (new documentId):
    //      the override dies with the old page
    await waitSync(() => evalIn(cdp, fix.A.session, `!!window.mcpFix`));
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-inc').click()`));
    await waitSync(() => evalIn(cdp, pmS, rowExpr('A', `!r.querySelector('.rate-reset').hidden`)));
    await evalIn(cdp, fix.A.session, `location.reload()`);
    await waitSync(async () => {
      const ov = await openOverrides();
      return !Object.values(ov).some((o) => (o.url || '').includes('speed-suite.html'));
    });
    ok('speed-matrix 15b: hard reload of the same URL clears the override (documentId)');

    // 15c. a hash-only change is the same document: the override and the
    //      applied rate survive
    await waitSync(() => evalIn(cdp, fix.A.session, `!!window.mcpFix`));
    await evalIn(cdp, pmS, rowExpr('A', `r.querySelector('.rate-inc').click()`));
    await waitSync(() => evalIn(cdp, pmS, rowExpr('A', `!r.querySelector('.rate-reset').hidden`)));
    // wait for the element to actually carry the override before snapshotting
    await waitSync(() => evalIn(cdp, fix.A.session, `Math.abs(mcpFix.rates()[0] - 2.75) < 0.01`));
    const rateBeforeHash = await evalIn(cdp, fix.A.session, `mcpFix.rates()[0]`, true);
    await evalIn(cdp, fix.A.session, `location.hash = '#mcp'`);
    await sleep(700);
    const ovAfterHash = await openOverrides();
    const rateAfterHash = await evalIn(cdp, fix.A.session, `mcpFix.rates()[0]`, true);
    Object.values(ovAfterHash).some((o) => (o.url || '').includes('speed-suite.html')) &&
    Math.abs(rateAfterHash - rateBeforeHash) < 0.01
      ? ok('speed-matrix 15c: hash-only change keeps the override and the rate')
      : bad('speed-matrix 15c: hash-only change keeps the override and the rate',
          `ov=${JSON.stringify(ovAfterHash)} rate=${rateAfterHash}`);
    // matrix #16 (stale report cannot resurrect a cleared override) is
    // deterministic in the background mock — the real page cannot forge a
    // superseded-revision report.

    await cdp.send('Target.closeTarget', { targetId: fix.A.targetId });
    await cdp.send('Target.closeTarget', { targetId: fix.B.targetId });

    // --- real-browser: cross-frame reports + silent-tab global coverage ----------
    // Clean slate: no overrides, global back to 1.00×.
    await evalIn(cdp, pmS, `document.getElementById('gspeed-reset').click()`);
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '1.00×'`));
    await waitSync(async () => Object.keys(await openOverrides()).length === 0);

    // 1) media inside a same-origin iframe: the manager runs in the FRAME and
    //    a native change there must be accepted as the tab's page override
    const frameTarget = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/frame-host.html`,
    });
    const frameSession = (await cdp.send('Target.attachToTarget', { targetId: frameTarget.targetId, flatten: true })).sessionId;
    await waitSync(() => evalIn(cdp, frameSession, `!!(window.mcpFrame && window.mcpFrame())`), 15000);
    for (let i = 0; i < 4; i++) {
      await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
      await sleep(40);
    }
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '2.00×'`));
    await waitSync(() => evalIn(cdp, frameSession, `Math.abs(mcpFrame().els[0].playbackRate - 2) < 0.01`));
    ok('global speed reaches media inside an iframe (allFrames manager)');
    // wait out the player-settling window: a rate write immediately after the
    // manager attaches is setup, not a user choice (see speed-matrix 4/6)
    await sleep(2200);
    await evalIn(cdp, frameSession, `mcpFrame().rate(0, 1.5)`);
    await waitSync(async () => {
      const ov = await openOverrides();
      return Object.values(ov).some((o) => Math.abs(o.rate - 1.5) < 1e-9);
    }, 15000);
    ok('a native change originating in a current child frame is adopted as the page override');

    // the child frame navigates to a new document: the top page (and its
    // override) is unchanged, and the new frame document follows the policy
    await evalIn(cdp, frameSession, `window.mcpFrameNav('speed-suite.html?t=FRAME2')`);
    await waitSync(
      () =>
        evalIn(
          cdp,
          frameSession,
          `!!(window.mcpFrame && window.mcpFrame() && mcpFrame().els[0] && mcpFrame().els[0].ownerDocument.title.includes('FRAME2'))`,
        ),
      15000,
    );
    const ovAfterFrameNav = await openOverrides();
    Object.values(ovAfterFrameNav).some((o) => Math.abs(o.rate - 1.5) < 1e-9)
      ? ok('child-frame navigation leaves the top-level page override intact')
      : bad('child-frame navigation leaves the top-level page override intact', `ov=${JSON.stringify(ovAfterFrameNav)}`);
    await evalIn(cdp, frameSession, `(async () => { const f = mcpFrame(); await f.play(0); })()`, true);
    await waitSync(() => evalIn(cdp, frameSession, `Math.abs(mcpFrame().els[0].playbackRate - 1.5) < 0.01`));
    ok('media in the replacement frame document follows the current page policy (1.50×)');

    // a top-level navigation invalidates the frame documents and the override
    await evalIn(cdp, frameSession, `location.href = 'http://127.0.0.1:${SERVE_PORT}/test/frame-host.html?top=2'`);
    await waitSync(async () => Object.keys(await openOverrides()).length === 0, 15000);
    ok('top-level navigation clears the page override made from a child frame');
    await cdp.send('Target.closeTarget', { targetId: frameTarget.targetId });
    await evalIn(cdp, pmS, `document.getElementById('gspeed-reset').click()`);
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '1.00×'`));

    // 2) a silent tab: opened before the policy, never played, never audible,
    //    not muted, not recent, not pinned — global speed must still cover it
    const quietTarget = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/speed-suite.html?t=SILENT`,
    });
    const quietSession = (await cdp.send('Target.attachToTarget', { targetId: quietTarget.targetId, flatten: true })).sessionId;
    await waitSync(() => evalIn(cdp, quietSession, `!!window.mcpFix`));
    for (let i = 0; i < 4; i++) {
      await evalIn(cdp, pmS, `document.getElementById('gspeed-inc').click()`);
      await sleep(40);
    }
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '2.00×'`));
    // media inserted AFTER the page loaded, in a tab nothing else selected
    await evalIn(
      cdp,
      quietSession,
      `(async () => { const i = mcpFix.newMedia(); await mcpFix.play(i); })()`,
      true,
    );
    await waitSync(() => evalIn(cdp, quietSession, `Math.abs(mcpFix.rates()[2] - 2) < 0.01`), 15000);
    ok('global 2.00× covers a silent open tab: dynamically inserted media inherits it');
    // reset: future media returns to normal behavior
    await evalIn(cdp, pmS, `document.getElementById('gspeed-reset').click()`);
    await waitSync(() => evalIn(cdp, pmS, `document.getElementById('gspeed-value').textContent === '1.00×'`));
    await evalIn(
      cdp,
      quietSession,
      `(async () => { const i = mcpFix.newMedia(); await mcpFix.play(i); })()`,
      true,
    );
    await waitSync(() => evalIn(cdp, quietSession, `Math.abs(mcpFix.rates()[3] - 1) < 0.01`), 15000);
    ok('global reset returns future media in that tab to normal behavior (1.00×)');
    await cdp.send('Target.closeTarget', { targetId: quietTarget.targetId });
    await cdp.send('Target.closeTarget', { targetId: pm.targetId });

    // summary
    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} e2e assertions passed`);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error('E2E setup failure:', err.message);
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

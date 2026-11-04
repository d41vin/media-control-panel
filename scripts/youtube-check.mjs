// Real-site verification on youtube.com, driven through CDP in a headed Edge
// window with the unpacked extension loaded.
//
//   node scripts/youtube-check.mjs
//
// Prints the ACTUAL player state (media element + #movie_player's internal
// API) around every mute path the extension offers, so behavior on the real
// site is checked against the real player — not a fixture:
//
//   1. baseline while playing
//   2. extension "Player audio" mute on the active tab (does it stick?)
//   3. native YouTube mute (does the popup's Player audio row follow?)
//   4. extension unmute after a native mute (does it reach the player?)
//   5. extension mute while the tab is in the background, then activation
//
// Requires internet access from the browser. Exits non-zero when a step's
// expected state is not observed; prints the raw traces either way.
//
// The popup is opened as an extension page (chrome-extension://<id>/popup.html)
// in its own tab — the same chrome.* context a real action popup gets, minus
// the browser-owned bubble.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the repo keeps the extension in extension/; the packaged archive has it
// at its root (manifest at the archive root) — resolve whichever this is
const EXT = existsSync(join(ROOT, 'extension', 'manifest.json')) ? join(ROOT, 'extension') : ROOT;
const PORT = 9233;
const VIDEO = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const ok = (name) => {
  results.push({ name, pass: true });
  console.log(`  ok  ${name}`);
};
const bad = (name, detail) => {
  results.push({ name, pass: false, detail });
  console.log(`FAIL  ${name} — ${detail}`);
};

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
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}
async function evalIn(cdp, sessionId, expression, opts = {}) {
  const r = await cdp.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: !!opts.await, userGesture: !!opts.gesture },
    sessionId,
  );
  if (r.exceptionDetails) {
    throw new Error(`eval failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  }
  return r.result?.value;
}
async function waitFor(fn, ms = 20000, step = 250) {
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

// The state we care about, read from BOTH sides: the media element (what the
// extension sees) and the player's internal API (what the site UI and the user
// experience). Reading both is what separates "element changed" from "player
// disagrees".
const STATE_EXPR = `(() => {
  const p = document.getElementById('movie_player');
  const v = document.querySelector('video');
  if (!v) return null;
  const api = p && typeof p.isMuted === 'function' ? {
    muted: p.isMuted(),
    volume: typeof p.getVolume === 'function' ? p.getVolume() : null,
    rate: typeof p.getPlaybackRate === 'function' ? p.getPlaybackRate() : null,
  } : null;
  const btn = document.querySelector('.ytp-mute-button');
  return {
    elMuted: !!v.muted,
    elVolume: Math.round(v.volume * 100) / 100,
    elRate: v.playbackRate,
    paused: v.paused,
    api,
    uiMuted: btn ? /muted/i.test(btn.getAttribute('aria-label') || '') || btn.getAttribute('title') === 'Unmute' : null,
    uiRate: (() => {
      const el = document.querySelector('.ytp-rate-button') || document.querySelector('.ytp-settings-button');
      return el ? el.textContent.trim() || el.getAttribute('aria-label') || null : null;
    })(),
  };
})()`;

const state = (cdp, s) => evalIn(cdp, s, STATE_EXPR, { await: true });

async function dumpState(cdp, s, tag) {
  const st = await state(cdp, s);
  console.log(`  state[${tag}]:`, JSON.stringify(st));
  return st;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'mcp-yt-'));
  let browserProcess = null;
  let ws = null;
  try {
    const browserPath = ['C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => existsSync(p));
    if (!browserPath) throw new Error('no Edge installation found');
    // real headed window: visibility/focus behavior (the reported unmute-on-
    // activation) only exists with actual tabs in a real window
    browserProcess = spawn(
      browserPath,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio', // no audible noise; element/tab mute states still real
        '--window-size=1100,800',
        `--disable-extensions-except=${EXT}`,
        `--load-extension=${EXT}`,
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

    const sw = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    }, 30000);
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
    const extId = new URL(sw.url).host;
    console.log(`extension loaded: ${extId}`);

    // --- youtube.com, playing ------------------------------------------------
    const yt = await cdp.send('Target.createTarget', { url: VIDEO });
    const ytSession = (await cdp.send('Target.attachToTarget', { targetId: yt.targetId, flatten: true })).sessionId;
    await cdp.send('Runtime.enable', {}, ytSession);
    const ytTabId = await waitFor(
      () => evalIn(cdp, swSession, `chrome.tabs.query({url:'https://www.youtube.com/*'}).then(t => t[0]?.id)`, { await: true }),
      30000,
    );
    // consent wall handling (EU): accept whatever the page asks once
    await waitFor(async () => {
      const t = await evalIn(cdp, ytSession, 'document.title');
      const consent = await evalIn(
        cdp, ytSession,
        `!!(document.querySelector('button[aria-label*="Accept"]') || document.querySelector('tp-yt-paper-button[aria-label*="Accept"]'))`,
      );
      if (consent) {
        await evalIn(
          cdp, ytSession,
          `(() => { const b = document.querySelector('button[aria-label*="Accept"]') || document.querySelector('tp-yt-paper-button[aria-label*="Accept"]'); if (b) b.click(); })()`,
          { gesture: true },
        );
        await sleep(2000);
        return false;
      }
      return t && t !== 'Before you continue to YouTube' && t !== 'YouTube';
    }, 45000).catch(() => {});
    await waitFor(() => evalIn(cdp, ytSession, `!!document.querySelector('video')`), 45000);
    // start playback (ads may run first; the main player handles both)
    await evalIn(
      cdp, ytSession,
      `(async () => {
         const v = document.querySelector('video');
         try { await v.play(); } catch { document.querySelector('.ytp-large-play-button')?.click(); }
         return v.paused;
       })()`,
      { await: true, gesture: true },
    );
    await waitFor(() => evalIn(cdp, ytSession, `document.querySelector('video') && !document.querySelector('video').paused`), 45000);
    // let the player finish initializing (its own volume/mute write-back)
    await sleep(2500);
    const baseline = await dumpState(cdp, ytSession, 'baseline');
    if (!baseline?.api) throw new Error('movie_player API not found — the internal player surface changed');

    // --- the popup as an extension page -------------------------------------
    // This Edge runs with --mute-audio, so the tab never reports audible;
    // seed the recent list (the extension's own detection path for paused/
    // silent media) so the popup lists the YouTube tab, as it would on a
    // normal audible session.
    await evalIn(cdp, swSession, `chrome.storage.session.set({ recent: [${ytTabId}] })`, { await: true });
    const popup = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupSession = (await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
    const popupTabId = await waitFor(
      () => evalIn(cdp, swSession, `chrome.tabs.query({url:'chrome-extension://${extId}/popup.html'}).then(t => t[0]?.id)`, { await: true }),
      10000,
    );
    const rowExpr = `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.t-site')?.textContent.includes('youtube'))`;
    try {
      await waitFor(() => evalIn(cdp, popupSession, `!!(${rowExpr})`), 6000);
    } catch {
      await evalIn(cdp, popupSession, `location.reload()`);
      await waitFor(() => evalIn(cdp, popupSession, `!!(${rowExpr})`), 20000);
    }
    try {
      // nothing
    } catch (e) {
      console.log('  popup diagnostics:', JSON.stringify(await evalIn(
        cdp, popupSession,
        `({ rows: [...document.querySelectorAll('.row')].map((r) => r.querySelector('.t-site')?.textContent), body: document.body?.innerHTML.length })`,
      )));
      console.log('  sw diagnostics:', JSON.stringify(await evalIn(
        cdp, swSession,
        `Promise.all([chrome.tabs.query({}), chrome.storage.session.get('recent')]).then(([tabs, s]) => ({
           tabs: tabs.map((t) => ({ id: t.id, url: (t.url || '').slice(0, 40), audible: t.audible, active: t.active })),
           recent: s.recent ?? [],
         }))`,
        { await: true },
      )));
      throw e;
    }
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.vol-btn').click()`);
    await sleep(600);
    const rowState = () =>
      evalIn(
        cdp, popupSession,
        `(() => { const r = ${rowExpr}; return r ? {
           tab: r.querySelector('.tab-audio .vs-value')?.textContent,
           player: r.querySelector('.player-audio .vs-value')?.textContent,
           vol: r.querySelector('.vol-readout')?.textContent,
           rate: r.querySelector('.rate-readout')?.textContent,
         } : null; })()`,
      );

    console.log('  popup rows[baseline]:', JSON.stringify(await rowState()));
    if ((await rowState())?.player !== 'Unmuted') {
      // make the scenarios deterministic: YouTube may remember a muted state
      await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.player-audio').click()`);
      await sleep(1500);
    }
    const pre = await dumpState(cdp, ytSession, 'pre-scenario');
    if (!pre?.elMuted) ok('baseline: element unmuted and player unmuted (precondition)');
    else bad('baseline: element unmuted and player unmuted (precondition)', JSON.stringify(pre));

    // --- 1) extension mute on the ACTIVE tab ---------------------------------
    await evalIn(cdp, swSession, `chrome.tabs.update(${ytTabId}, {active: true})`, { await: true });
    await sleep(600);
    await dumpState(cdp, ytSession, 'youtube activated');
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.player-audio').click()`);
    await sleep(150);
    const m1a = await dumpState(cdp, ytSession, 'ext-mute +150ms');
    await sleep(350);
    const m1b = await dumpState(cdp, ytSession, 'ext-mute +500ms');
    await sleep(2500);
    const m1c = await dumpState(cdp, ytSession, 'ext-mute +3s');
    const popM1 = await rowState();
    console.log('  popup rows[ext-mute +3s]:', JSON.stringify(popM1));
    m1c?.elMuted === true && m1c?.api?.muted === true && popM1?.player === 'Muted'
      ? ok('extension Player-audio mute sticks on the active tab (element + player + popup agree)')
      : bad('extension Player-audio mute sticks on the active tab (element + player + popup agree)', JSON.stringify({ m1a, m1b, m1c, popM1 }));

    // --- 2) extension unmute (round trip) ------------------------------------
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.player-audio').click()`);
    await sleep(1200);
    const m2 = await dumpState(cdp, ytSession, 'ext-unmute');
    const popM2 = await rowState();
    m2?.elMuted === false && m2?.api?.muted === false && popM2?.player === 'Unmuted'
      ? ok('extension Player-audio unmute reaches the player (element + player + popup agree)')
      : bad('extension Player-audio unmute reaches the player (element + player + popup agree)', JSON.stringify({ m2, popM2 }));

    // --- 3) native YouTube mute -> popup indicator ---------------------------
    const nativeMuteClicked = await evalIn(
      cdp, ytSession,
      `(() => {
         const b = document.querySelector('.ytp-mute-button');
         if (!b) return false;
         b.click();
         return true;
       })()`,
      { gesture: true },
    );
    await sleep(1500);
    const m3 = await dumpState(cdp, ytSession, 'native-mute');
    const popM3 = await rowState();
    console.log('  popup rows[native-mute]:', JSON.stringify(popM3));
    nativeMuteClicked && m3?.api?.muted === true && popM3?.player === 'Muted'
      ? ok('native YouTube mute shows up in the popup Player-audio row')
      : bad('native YouTube mute shows up in the popup Player-audio row', JSON.stringify({ nativeMuteClicked, m3, popM3 }));

    // --- 4) extension unmute after a native mute -----------------------------
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.player-audio').click()`);
    await sleep(1500);
    const m4 = await dumpState(cdp, ytSession, 'ext-unmute-after-native');
    const popM4 = await rowState();
    m4?.api?.muted === false && m4?.elMuted === false && popM4?.player === 'Unmuted'
      ? ok('extension Player-audio unmute overrides a native mute (player accepts it)')
      : bad('extension Player-audio unmute overrides a native mute (player accepts it)', JSON.stringify({ m4, popM4 }));

    // --- 5) mute while BACKGROUNDED, then activate ---------------------------
    await evalIn(cdp, swSession, `chrome.tabs.update(${popupTabId}, {active: true})`, { await: true });
    await sleep(400);
    await sleep(800);
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.player-audio').click()`);
    await sleep(1500);
    const m5a = await dumpState(cdp, ytSession, 'bg-ext-mute');
    await evalIn(cdp, swSession, `chrome.tabs.update(${ytTabId}, {active: true})`, { await: true });
    await sleep(2000);
    const m5b = await dumpState(cdp, ytSession, 'bg-ext-mute after activation');
    const popM5 = await rowState();
    m5a?.api?.muted === true && m5b?.api?.muted === true && popM5?.player === 'Muted'
      ? ok('extension Player-audio mute survives backgrounding and tab activation')
      : bad('extension Player-audio mute survives backgrounding and tab activation', JSON.stringify({ m5a, m5b, popM5 }));

    // --- 6) tab audio stays independent -------------------------------------
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.tab-audio').click()`);
    await sleep(800);
    const tabMutedInfo = await evalIn(cdp, swSession, `chrome.tabs.get(${ytTabId}).then((t) => t.mutedInfo)`, { await: true });
    const m6 = await dumpState(cdp, ytSession, 'tab-mute');
    const popM6 = await rowState();
    tabMutedInfo?.muted === true && m6?.api?.muted === true && m6?.elMuted === true && popM6?.tab === 'Muted' && popM6?.player === 'Muted'
      ? ok('browser tab mute is independent: tab muted while player mute state is untouched')
      : bad('browser tab mute is independent: tab muted while player mute state is untouched', JSON.stringify({ tabMutedInfo, m6, popM6 }));
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.tab-audio').click()`);
    await evalIn(cdp, popupSession, `(${rowExpr}).querySelector('.player-audio').click()`);
    await sleep(800);

    // --- 7) speed range: 2x / 2.5x / 4x / 8x / 16x actual playback -----------
    // Drive the real policy path (global speed change -> background -> page
    // manager) and assert the ELEMENT's actual playback rate — the site's own
    // menu may cap at 2.00x while the media really runs faster.
    const rateChecks = [];
    for (const rate of [2, 2.5, 4, 8, 16]) {
      await evalIn(cdp, swSession, `chrome.storage.local.set({ speed: ${rate} })`, { await: true });
      const applied = await waitFor(async () => {
        const st = await state(cdp, ytSession);
        return st && Math.abs(st.elRate - rate) < 0.01 ? st : null;
      }, 12000).catch(() => null);
      const st = applied ?? (await state(cdp, ytSession));
      rateChecks.push({ rate, elRate: st?.elRate, apiRate: st?.api?.rate, uiRate: st?.uiRate });
      console.log(`  state[rate ${rate}]:`, JSON.stringify(st));
      applied
        ? ok(`speed ${rate}× actually plays (element rate ${st.elRate})`)
        : bad(`speed ${rate}× actually plays`, JSON.stringify({ requested: rate, state: st }));
    }
    // the popup must display the ACTUAL rate, not the requested one
    const shownRate = await evalIn(cdp, popupSession, `document.getElementById('gspeed-value').textContent`).catch(() => null);
    const last = rateChecks[rateChecks.length - 1];
    shownRate === '16.00×' && last && Math.abs(last.elRate - 16) < 0.01
      ? ok('the popup displays the applied rate at the 16× ceiling')
      : bad('the popup displays the applied rate at the 16× ceiling', JSON.stringify({ shownRate, last }));
    await evalIn(cdp, swSession, `chrome.storage.local.set({ speed: 1 })`, { await: true });

    const failed = results.filter((r) => !r.pass).length;
    console.log(`\n${results.length - failed}/${results.length} real-site checks passed`);
    if (failed) process.exitCode = 1;
  } catch (err) {
    console.error('Real-site check failure:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      ws?.close();
    } catch {}
    try {
      browserProcess?.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    process.exit(process.exitCode ?? 0);
  }
}

main();

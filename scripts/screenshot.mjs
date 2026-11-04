// Regenerates the README screenshots from the ACTUAL extension popup: loads
// the unpacked extension in Edge (headless), plays real content (youtube.com
// when the network allows it, plus a local sample tab), opens popup.html as an
// extension page — the same chrome.* context the action popup gets — and
// captures the popup surface in its real states:
//
//   docs/screenshots/popup-card.png      one media card
//   docs/screenshots/popup-multi.png     two media cards
//   docs/screenshots/popup-volume.png    volume popover: Tab audio / Player audio
//   docs/screenshots/popup-settings.png  settings panel (appearance + toggles)
//   docs/screenshots/popup-light.png     light theme, multi-card
//   docs/screenshots/popup-dark.png      dark theme, multi-card
//
//   node scripts/screenshot.mjs     (also: npm run shots)
//
// Captures are 2x for readability. The html backdrop is painted gray for the
// shot only so the popup's own rounded surface is visible against a contrast;
// the shipped CSS keeps it transparent (the real bubble shows the page
// beneath).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the repo keeps the extension in extension/; the packaged archive has it
// at its root (manifest at the archive root) — resolve whichever this is
const EXT = existsSync(join(ROOT, 'extension', 'manifest.json')) ? join(ROOT, 'extension') : ROOT;
const PORT = 9228;
const SERVE_PORT = 8080;
const OUT = join(ROOT, 'docs', 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const profile = mkdtempSync(join(tmpdir(), 'mcp-shots-'));
  let browserProcess = null;
  let ws = null;

  try {
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/test/media-page.html`);
      return r.ok;
    }, 8000);

    const browserPath = [
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    ].find((p) => existsSync(p));
    if (!browserPath) throw new Error('no Edge installation found');
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
        '--mute-audio', // no audible noise while capturing
        '--window-size=520,780',
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

    console.log('browser up; waiting for the service worker');
    const sw = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    }, 30000);
    const extId = new URL(sw.url).host;
    console.log('extension loaded:', extId);
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;

    // --- real content: a YouTube video (when reachable) + a local sample -----
    const yt = await cdp.send('Target.createTarget', { url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' });
    const ytSession = (await cdp.send('Target.attachToTarget', { targetId: yt.targetId, flatten: true })).sessionId;
    let ytPlaying = false;
    try {
      await waitFor(() => evalIn(cdp, ytSession, `!!document.querySelector('video')`), 45000);
      await evalIn(
        cdp, ytSession,
        `(async () => { const v = document.querySelector('video'); try { await v.play(); } catch { document.querySelector('.ytp-large-play-button')?.click(); } })()`,
        true,
      );
      await waitFor(() => evalIn(cdp, ytSession, `document.querySelector('video') && !document.querySelector('video').paused`), 45000);
      await waitFor(() => evalIn(cdp, ytSession, `!/ad-showing/.test(document.querySelector('.html5-video-player')?.className || '')`), 60000).catch(() => {});
      await waitFor(() => evalIn(cdp, ytSession, `!!navigator.mediaSession?.metadata?.title`), 20000).catch(() => {});
      ytPlaying = true;
    } catch (e) {
      console.log(`youtube unavailable for the shots (${e.message.slice(0, 80)}) — using local content only`);
    }
    const ytTabId = await evalIn(cdp, swSession, `chrome.tabs.query({url:'https://www.youtube.com/*'}).then(t => t[0]?.id)`, true);

    // single-audio fixture: the media-page's live canvas element would take
    // primacy once its tone ends and truthfully render as LIVE in the card
    const local = await cdp.send('Target.createTarget', { url: `http://localhost:${SERVE_PORT}/test/media-audio.html` });
    const localSession = (await cdp.send('Target.attachToTarget', { targetId: local.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, localSession, `!!document.querySelector('audio')`));
    await evalIn(cdp, localSession, `document.title = 'Big Buck Bunny — sample media'`);
    await evalIn(
      cdp, localSession,
      `(() => { const a = document.querySelector('audio'); a.loop = true; a.currentTime = 0; a.play().catch(() => {}); })()`,
    ).catch(() => {});
    await sleep(500);
    const localTabId = await evalIn(cdp, swSession, `chrome.tabs.query({url:'http://localhost:${SERVE_PORT}/*'}).then(t => t[0]?.id)`, true);

    const seedRecent = (ids) =>
      evalIn(cdp, swSession, `chrome.storage.session.set({ recent: ${JSON.stringify(ids)} })`, true);

    const openPopup = async () => {
      const p = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
      const s = (await cdp.send('Target.attachToTarget', { targetId: p.targetId, flatten: true })).sessionId;
      await waitFor(() => evalIn(cdp, s, `document.querySelectorAll('.row').length >= 1`), 20000);
      await sleep(700); // probes settle (artwork/titles)
      return s;
    };

    // paint the backdrop gray + set up the clip for the CURRENT body size
    // Frame the shot by making the viewport EXACTLY the popup's size at 2x:
    // no clip arithmetic to get wrong, and the browser paints crisp 2x text.
    const sizeViewport = async (s) => {
      const raw = await evalIn(
        cdp, s,
        `(() => { const b = document.body.getBoundingClientRect(); return { w: Math.ceil(b.width), h: Math.ceil(Math.min(b.height, 644)) }; })()`,
      );
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        { width: raw.w, height: raw.h, deviceScaleFactor: 2, mobile: false },
        s,
      );
      await sleep(250);
      return raw;
    };
    const artSettled = (s) =>
      evalIn(
        cdp, s,
        `(() => [...document.querySelectorAll('.art')].every((art) => {
           const img = art.querySelector('img:not([hidden])');
           if (!img) return true;
           return img.complete && img.naturalWidth > 0;
         }))()`,
      ).catch(() => true);
    const shot = async (s, name) => {
      await waitFor(() => artSettled(s), 8000).catch(() => {});
      await sleep(250); // let the fallback paints settle
      await evalIn(cdp, s, `document.documentElement.style.background = '#707070'`);
      await sizeViewport(s);
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
      const out = join(OUT, name);
      writeFileSync(out, Buffer.from(img.data, 'base64'));
      console.log(`wrote ${out}`);
    };

    // --- 1) one media card ---------------------------------------------------
    await seedRecent(ytPlaying ? [ytTabId] : [localTabId]);
    let popupTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    let popupSession = (await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length >= 1`), 20000);
    await sleep(700);
    // explicit light theme so the shot is deterministic
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popupSession, `document.querySelector('[data-theme-value="light"]').click()`);
    await sleep(300);
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await sleep(400);
    await shot(popupSession, 'popup-card.png');
    await cdp.send('Target.closeTarget', { targetId: popupTarget.targetId }).catch(() => {});

    // --- 2..6) two cards, volume popover, settings, light/dark --------------
    await seedRecent(ytPlaying ? [ytTabId, localTabId] : [localTabId]);
    popupTarget = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    popupSession = (await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length >= 1`), 20000);
    await sleep(700);
    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length >= ${ytPlaying ? 2 : 1}`), 15000);
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`).catch(() => {});
    await evalIn(cdp, popupSession, `document.querySelector('[data-theme-value="light"]').click()`).catch(() => {});
    await sleep(300);
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await sleep(400);
    await shot(popupSession, 'popup-multi.png');

    // volume popover: the two audio truths, with the player muted to show the
    // accent state (and the tab audio left unmuted — they are independent)
    const rowExpr = `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.t-site').textContent.includes(${ytPlaying ? "'youtube'" : "'localhost'"}))`;
    await evalIn(cdp, popupSession, `((${rowExpr}) || document.querySelector('.row')).querySelector('.vol-btn').click()`);
    await sleep(700);
    await evalIn(cdp, popupSession, `((${rowExpr}) || document.querySelector('.row')).querySelector('.player-audio').click()`).catch(() => {});
    await sleep(900);
    await shot(popupSession, 'popup-volume.png');

    // settings panel
    await evalIn(cdp, popupSession, `[...document.querySelectorAll('.row')].forEach((r) => r.querySelector('.vol-btn').click())`).catch(() => {});
    await sleep(200);
    await evalIn(cdp, popupSession, `document.querySelector('.row .vol-btn').click()`).catch(() => {});
    await sleep(300);
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await sleep(500);
    await shot(popupSession, 'popup-settings.png');

    // light + dark multi-card (settings closed, theme via the real selector)
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popupSession, `document.querySelector('[data-theme-value="light"]').click()`);
    await sleep(500);
    await shot(popupSession, 'popup-light.png');
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popupSession, `document.querySelector('[data-theme-value="dark"]').click()`);
    await sleep(300);
    await evalIn(cdp, popupSession, `document.getElementById('settings-toggle').click()`);
    await sleep(500);
    await shot(popupSession, 'popup-dark.png');

    console.log('screenshots written to docs/screenshots/');
  } catch (err) {
    console.error('Screenshot failure:', err.message);
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
    server.kill();
    process.exit(process.exitCode ?? 0);
  }
}

main();

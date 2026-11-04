// Regenerates the README screenshots from the REAL extension action popup.
//
//   node scripts/screenshot.mjs     (also: npm run shots)
//
// A headed Google Chrome window opens briefly (Edge via MCP_BROWSER=edge)
// with the unpacked extension loaded and two real tabs playing (youtube.com
// when the network allows it, plus a local sample). The actual toolbar
// action popup is opened with chrome.action.openPopup() — anchored to the
// toolbar, i.e. the real browser bubble, NOT a tab rendering of popup.html —
// and its content is captured over CDP:
//
//   docs/screenshots/popup-card.png      one media card (real popup)
//   docs/screenshots/popup-multi.png     two media cards (real popup)
//   docs/screenshots/popup-volume.png    volume popover: Tab audio / Player audio
//   docs/screenshots/popup-settings.png  settings panel (appearance + toggles)
//   docs/screenshots/popup-light.png     light theme, multi-card
//   docs/screenshots/popup-dark.png      dark theme, multi-card
//
// What a CDP screenshot of the popup contains: the popup's own document, at
// its real size, exactly what the browser renders inside the bubble. The
// bubble's OUTER frame, shadow and rounded window decorations are drawn by
// the browser's UI layer and are not part of a page capture — the shots are
// the internal popup surface only, as it actually appears. No fake backdrop
// is painted; the document's own theme background fills the frame.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { browserName, browserPath as browserPathOf, browserVersion, ensureExtension, extensionArgs } from './browser.mjs';

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

    const browserPath = browserPathOf();
    console.log(`browser: ${browserName()} ${browserVersion(browserPath) ?? '(version unknown)'} — ${browserPath}`);
    // headed: the real action popup needs a focused window; no headless flag
    browserProcess = spawn(
      browserPath,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        ...extensionArgs(EXT),
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio', // no audible noise while capturing
        '--window-size=760,900',
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
    await ensureExtension((method, params) => cdp.send(method, params), EXT);

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

    /** Open the REAL toolbar action popup; returns its target + session. */
    const openActionPopup = async (recentIds) => {
      await seedRecent(recentIds);
      const winId = await evalIn(cdp, swSession, `chrome.windows.getCurrent().then((w) => w.id)`, true);
      await evalIn(cdp, swSession, `chrome.windows.update(${winId}, { focused: true }).catch(() => {})`, true);
      await sleep(400);
      await evalIn(cdp, swSession, `chrome.action.openPopup()`, true);
      const target = await waitFor(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
      }, 15000);
      const session = (await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
      await waitFor(() => evalIn(cdp, session, `document.querySelectorAll('.row').length >= 1`), 20000);
      await sleep(700); // probes settle (artwork/titles)
      return { target, session };
    };

    const closeActionPopup = async (target) => {
      await cdp.send('Target.closeTarget', { targetId: target.targetId }).catch(() => {});
      await sleep(500);
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

    // The capture is the popup document itself at its real size — the bubble
    // frame/shadow is browser UI and is not part of a page capture.
    const shot = async (s, name) => {
      await waitFor(() => artSettled(s), 8000).catch(() => {});
      await sleep(350);
      const img = await cdp.send('Page.captureScreenshot', { format: 'png' }, s);
      const out = join(OUT, name);
      writeFileSync(out, Buffer.from(img.data, 'base64'));
      console.log(`wrote ${out}`);
    };

    // --- 1) real popup with one media card -----------------------------------
    let popup = await openActionPopup(ytPlaying ? [ytTabId] : [localTabId]);
    const geom = await evalIn(
      cdp, popup.session,
      `({ w: innerWidth, h: innerHeight,
         htmlBg: getComputedStyle(document.documentElement).backgroundColor,
         bodyBg: getComputedStyle(document.body).backgroundColor,
         bodyRadius: getComputedStyle(document.body).borderRadius })`,
    );
    console.log('real popup geometry:', JSON.stringify(geom));
    // explicit light theme so the shot is deterministic (real selector)
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popup.session, `document.querySelector('[data-theme-value="light"]').click()`);
    await sleep(300);
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await sleep(400);
    await shot(popup.session, 'popup-card.png');
    await closeActionPopup(popup.target);

    // --- 2..6) real popup with two cards, volume, settings, light/dark -------
    popup = await openActionPopup(ytPlaying ? [ytTabId, localTabId] : [localTabId]);
    await waitFor(() => evalIn(cdp, popup.session, `document.querySelectorAll('.row').length >= ${ytPlaying ? 2 : 1}`), 15000);
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popup.session, `document.querySelector('[data-theme-value="light"]').click()`);
    await sleep(300);
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await sleep(400);
    await shot(popup.session, 'popup-multi.png');

    // volume popover: both audio truths, with the player muted to show the
    // accent state (tab audio stays independent)
    const rowExpr = `[...document.querySelectorAll('.row')].find((r) => r.querySelector('.t-site').textContent.includes(${ytPlaying ? "'youtube'" : "'localhost'"}))`;
    await evalIn(cdp, popup.session, `((${rowExpr}) || document.querySelector('.row')).querySelector('.vol-btn').click()`);
    await sleep(700);
    await evalIn(cdp, popup.session, `((${rowExpr}) || document.querySelector('.row')).querySelector('.player-audio').click()`).catch(() => {});
    await sleep(900);
    await shot(popup.session, 'popup-volume.png');

    // settings panel (close any open popover first)
    await evalIn(cdp, popup.session, `[...document.querySelectorAll('.row')].forEach((r) => { if (r.querySelector('.vol-pop').classList.contains('open')) r.querySelector('.vol-btn').click(); })`).catch(() => {});
    await sleep(300);
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await sleep(500);
    await shot(popup.session, 'popup-settings.png');

    // light + dark multi-card (settings closed, theme via the real selector)
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popup.session, `document.querySelector('[data-theme-value="light"]').click()`);
    await sleep(500);
    await shot(popup.session, 'popup-light.png');
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await evalIn(cdp, popup.session, `document.querySelector('[data-theme-value="dark"]').click()`);
    await sleep(300);
    await evalIn(cdp, popup.session, `document.getElementById('settings-toggle').click()`);
    await sleep(500);
    await shot(popup.session, 'popup-dark.png');
    await closeActionPopup(popup.target);

    console.log('screenshots written to docs/screenshots/ (real action popup)');
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

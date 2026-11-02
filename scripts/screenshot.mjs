// Regenerates the README screenshots: loads the unpacked extension in Edge
// (headless), plays the media fixture, opens the popup as a page, and captures
// the popup region in light and dark.
//
//   node scripts/screenshot.mjs     (also: npm run shots)
//
// Output: docs/screenshots/popup-light.png, docs/screenshots/popup-dark.png

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXT = join(ROOT, 'extension');
const PORT = 9228;
const SERVE_PORT = 8080;

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
  const profile = mkdtempSync(join(tmpdir(), 'mcp-shots-'));
  let browserProcess = null;

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
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=520,760',
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
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const cdp = new Cdp(ws);

    const sw = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    }, 30000);
    const extId = new URL(sw.url).host;
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;

    const media = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-page.html`,
    });
    const mediaSession = (await cdp.send('Target.attachToTarget', { targetId: media.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, mediaSession, `!!document.querySelector('audio')`));
    await evalIn(cdp, mediaSession, `document.querySelectorAll('audio')[0].play()`, true);
    // a second, paused tab gives the list its "recently playing" row
    await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html`,
    });
    // give the popup something to show for candidates without audibility
    const ids = await evalIn(cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(t => t.map(x => x.id))`, true);
    await evalIn(cdp, swSession, `chrome.storage.session.set({ recent: ${JSON.stringify(ids)} })`);
    await sleep(500);

    const popup = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
    const popupSession = (await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, popupSession, `document.querySelectorAll('.row').length >= 1`));
    // open the volume popover on the first card so the shot shows the pattern
    await evalIn(cdp, popupSession, `document.querySelector('.row .vol-btn').click()`);
    await sleep(400);

    // the popup document is what Chromium paints the action bubble from: a
    // rounded 14 px body over a transparent html background. For the shot
    // only, paint the html backdrop a contrasting gray so the popup's own
    // outer corners are visible and verifiable (the shipped CSS keeps the
    // backdrop transparent — the real bubble shows the page beneath).
    const MARGIN = 14;
    await evalIn(cdp, popupSession, `document.documentElement.style.background = '#707070'`);
    const clipRaw = await evalIn(
      cdp,
      popupSession,
      `(() => { const b = document.body.getBoundingClientRect(); return { w: Math.ceil(b.width), h: Math.min(Math.ceil(b.height), 660) }; })()`,
    );
    const clip = { x: -MARGIN, y: -MARGIN, width: clipRaw.w + MARGIN * 2, height: clipRaw.h + MARGIN * 2, scale: 1 };

    for (const scheme of ['light', 'dark']) {
      await cdp.send(
        'Emulation.setEmulatedMedia',
        { features: [{ name: 'prefers-color-scheme', value: scheme }] },
        popupSession,
      );
      await sleep(200);
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip }, popupSession);
      const out = join(ROOT, 'docs', 'screenshots', `popup-${scheme}.png`);
      writeFileSync(out, Buffer.from(shot.data, 'base64'));
      console.log(`wrote ${out}`);
    }

    // third shot: the old expanded-panel shot is gone; keep the set at two
  } catch (err) {
    console.error('Screenshot failure:', err.message);
    process.exitCode = 1;
  } finally {
    try {
      browserProcess?.kill();
    } catch {}
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
    server.kill();
  }
}

main();

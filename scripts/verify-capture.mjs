// Verifies tab-capture targeting in a REAL (headed) browser window — the one
// thing the headless E2E rig cannot do (headless refuses capture entirely).
//
//   node scripts/verify-capture.mjs     (also: npm run verify-capture)
//
// What it does, with a real headed browser window (Chrome by default, Edge
// via MCP_BROWSER=edge) and real CDP mouse input:
//   1. plays the audio fixture, opens the REAL action popup
//      (chrome.action.openPopup), and clicks through the boost control —
//      the documented active-tab flow;
//   2. reports whether the capture pipeline actually starts (session state
//      + offscreen document + Web Audio chain);
//   3. then, from the popup context, calls the raw
//      tabCapture.getMediaStreamId for (a) the viewed tab and (b) a
//      background tab, recording which one the browser allows.
//
// A brief browser window will open on the desktop while this runs (isolated
// temporary profile). The fixture tone plays at reduced volume. Exit code 0 =
// the probe ran (capture outcomes are REPORTED, not failed); setup failures
// exit non-zero.
//
// Historical results (2026-10-29, Edge 156, Windows): recorded in
// docs/RESEARCH.md and the README boost section. The activeTab refusal is a
// browser rule, not an Edge quirk.

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { browserName, browserPath as browserPathOf, browserVersion, ensureExtension, extensionArgs } from './browser.mjs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// the repo keeps the extension in extension/; the packaged archive has it
// at its root (manifest at the archive root) — resolve whichever this is
const EXT = existsSync(join(ROOT, 'extension', 'manifest.json')) ? join(ROOT, 'extension') : ROOT;
const PORT = 9233;
const SERVE_PORT = 8080;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findings = [];

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
      }, 25000);
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

async function clickAt(cdp, sessionId, x, y) {
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send(
      'Input.dispatchMouseEvent',
      { type, x, y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 },
      sessionId,
    );
  }
}

async function main() {
  const server = spawn(process.execPath, [join(ROOT, 'serve.mjs')], { stdio: 'ignore' });
  const profile = mkdtempSync(join(tmpdir(), 'mcp-verify-'));
  let browserProcess = null;
  let ws = null;

  try {
    await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${SERVE_PORT}/test/media-audio.html`);
      return r.ok;
    }, 8000);

    const browserPath = browserPathOf();
    console.log(`browser: ${browserName()} ${browserVersion(browserPath) ?? '(version unknown)'} — ${browserPath}`);
    console.log('launching a real (headed) browser window — it closes again in under a minute');
    browserProcess = spawn(
      browserPath,
      [
        `--remote-debugging-port=${PORT}`,
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=900,700',
        ...extensionArgs(EXT),
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

    const sw = await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      return targetInfos.find((t) => t.type === 'service_worker' && t.url.endsWith('/background.js'));
    }, 30000);
    const extId = new URL(sw.url).host;
    const swSession = (await cdp.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;

    // media fixture, quiet, playing — this is the VIEWED tab
    const media = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html`,
    });
    const mediaSession = (await cdp.send('Target.attachToTarget', { targetId: media.targetId, flatten: true })).sessionId;
    await waitFor(() => evalIn(cdp, mediaSession, `!!document.querySelector('audio')`));
    await evalIn(cdp, mediaSession, `(() => { const a = document.querySelector('audio'); a.volume = 0.15; return a.play().then(() => 'played').catch(e => 'blocked: ' + e.name); })()`, true);
    await sleep(400);
    const mediaTabId = await evalIn(cdp, swSession, `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(t => t[0].id)`, true);
    console.log(`media tab: ${mediaTabId} (viewed, playing)`);

    // open the REAL action popup (openPopup needs a focused window)
    let popupOpened = true;
    try {
      const winId = await evalIn(cdp, swSession, `chrome.windows.getCurrent().then((w) => w.id)`, true);
      await evalIn(cdp, swSession, `chrome.windows.update(${winId}, { focused: true }).catch(() => {})`, true);
      await sleep(500);
      await evalIn(cdp, swSession, `chrome.action.openPopup()`, true);
    } catch (e) {
      popupOpened = false;
      findings.push(`openPopup() unavailable/rejected: ${e.message} — real-popup flow NOT verified; raw-API checks below still ran`);
    }
    if (popupOpened) {
      try {
      const popupTarget = await waitFor(async () => {
        const { targetInfos } = await cdp.send('Target.getTargets');
        return targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
      }, 8000).catch(() => null);
      if (!popupTarget) {
        findings.push('the action popup did not appear as an attachable target — real-popup flow NOT verified');
      } else {
        const popupSession = (await cdp.send('Target.attachToTarget', { targetId: popupTarget.targetId, flatten: true })).sessionId;
        await sleep(800); // rows + probes
        const rows = await evalIn(cdp, popupSession, `document.querySelectorAll('.row').length`);
        const boostEnabled = await evalIn(cdp, popupSession, `document.querySelector('.row .boost-btn')?.disabled`);
        console.log(`popup open (${rows} row(s)); viewed tab's boost chip disabled=${boostEnabled}`);

        if (boostEnabled === false) {
          // real mouse clicks: open the boost popover, then click the slider
          // track at ~40% (a press sets the value and fires input — the
          // genuine user path)
          const chip = await evalIn(
            cdp,
            popupSession,
            `(() => { const b = document.querySelector('.row .boost-btn').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`,
          );
          await clickAt(cdp, popupSession, Math.round(chip.x), Math.round(chip.y));
          await sleep(400);
          const slider = await evalIn(
            cdp,
            popupSession,
            `(() => { const b = document.querySelector('.row .boost').getBoundingClientRect(); return { x: b.x + b.width * 0.4, y: b.y + b.height / 2 }; })()`,
          );
          await clickAt(cdp, popupSession, Math.round(slider.x), Math.round(slider.y));
          await sleep(500);

          const outcome = await waitFor(
            () =>
              evalIn(
                cdp,
                popupSession,
                `(async () => {
                   const s = await chrome.storage.session.get('boosts');
                   const st = s.boosts?.[${mediaTabId}];
                   if (st?.state === 'active') return 'active';
                   if (st?.state === 'error') return 'error: ' + String(st.error);
                   if (st) return 'other: ' + JSON.stringify(st);
                   return '';
                 })()`,
              ).catch(() => ''),
            15000,
          ).catch(() => 'no-terminal-state');
          const sliderNow = await evalIn(cdp, popupSession, `document.querySelector('.row .boost')?.value`, true).catch(() => '?');
          if (outcome === 'active') {
            findings.push('VERIFIED: boost capture started for the VIEWED tab in a real browser (popup click → pipeline active)');
            const offscreen = await evalIn(cdp, swSession, `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(cs => cs.length)`, true);
            findings.push(`offscreen document: ${offscreen === 1 ? 'exactly one, running' : `count=${offscreen}`}`);

            // repeated use, with real mouse input: reset to 100% must release
            // the capture, and a fresh slider click must start it again
            const resetBtn = await evalIn(
              cdp,
              popupSession,
              `(() => { const b = document.querySelector('.row .boost-reset').getBoundingClientRect(); return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }; })()`,
            );
            await clickAt(cdp, popupSession, resetBtn.x, resetBtn.y);
            const released = await waitFor(
              () => evalIn(cdp, popupSession, `(async () => { const s = await chrome.storage.session.get('boosts'); return !s.boosts?.[${mediaTabId}]; })()`).catch(() => false),
              10000,
            ).catch(() => false);
            findings.push(released
              ? 'VERIFIED: reset to 100% released the capture (real popup click)'
              : 'NOT VERIFIED: reset to 100% did not release the capture');

            const sliderAgain = await evalIn(
              cdp,
              popupSession,
              `(() => { const b = document.querySelector('.row .boost').getBoundingClientRect(); return { x: Math.round(b.x + b.width * 0.4), y: Math.round(b.y + b.height / 2) }; })()`,
            );
            await clickAt(cdp, popupSession, sliderAgain.x, sliderAgain.y);
            const restart = await waitFor(
              () =>
                evalIn(
                  cdp,
                  popupSession,
                  `(async () => { const s = await chrome.storage.session.get('boosts'); return s.boosts?.[${mediaTabId}]?.state; })()`,
                ).catch(() => ''),
              15000,
            ).catch(() => 'no-terminal-state');
            findings.push(restart === 'active'
              ? 'VERIFIED: boost restarted after a reset (fresh capture, same popup)'
              : `NOT VERIFIED: boost restart outcome: ${restart || '(nothing)'}`);

            // A boost is a TAB setting: navigation within the tab must keep
            // the same capture pipeline running (Chrome tabCapture continues
            // across navigations; the extension must not tear it down).
            const boostAfterNav = async () => {
              const raw = await evalIn(
                cdp,
                swSession,
                `Promise.all([chrome.storage.session.get('boosts'), chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})])
                   .then(([s, cs]) => JSON.stringify({ state: s.boosts?.[${mediaTabId}]?.state, gain: s.boosts?.[${mediaTabId}]?.gain, docs: cs.length }))`,
                true,
              );
              return JSON.parse(raw || '{}');
            };
            const boostBeforeNav = await boostAfterNav();
            await evalIn(cdp, mediaSession, `location.href = 'http://127.0.0.1:${SERVE_PORT}/test/media-audio.html?nav=boost'`);
            await sleep(1800);
            const navSame = await boostAfterNav();
            findings.push(navSame.state === 'active' && navSame.gain === boostBeforeNav.gain && navSame.docs === 1
              ? 'VERIFIED: boost survives a full navigation in the same tab (same offscreen pipeline, same gain)'
              : `NOT VERIFIED: boost after same-origin navigation: ${JSON.stringify({ boostBeforeNav, navSame })}`);
            // different origin (localhost vs 127.0.0.1)
            await evalIn(cdp, mediaSession, `location.href = 'http://localhost:${SERVE_PORT}/test/media-audio.html?nav=origin'`);
            await sleep(1800);
            const navCross = await boostAfterNav();
            findings.push(navCross.state === 'active' && navCross.gain === boostBeforeNav.gain && navCross.docs === 1
              ? 'VERIFIED: boost survives navigation to a different origin (same offscreen pipeline)'
              : `NOT VERIFIED: boost after cross-origin navigation: ${JSON.stringify(navCross)}`);
            // reset after navigation releases the capture
            const resetPage = await cdp.send('Target.createTarget', { url: `chrome-extension://${extId}/popup.html` });
            const resetSession = (await cdp.send('Target.attachToTarget', { targetId: resetPage.targetId, flatten: true })).sessionId;
            await sleep(500);
            await evalIn(cdp, resetSession, `chrome.runtime.sendMessage({ type: 'mcp-boost-stop', tabId: ${mediaTabId} }).catch(() => {})`, true);
            const releasedAfterNav = await waitFor(
              () => evalIn(
                cdp,
                swSession,
                `Promise.all([chrome.storage.session.get('boosts'), chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})])
                   .then(([s, cs]) => !s.boosts?.[${mediaTabId}] && cs.length === 0)`,
                true,
              ),
              10000,
            ).catch(() => false);
            findings.push(releasedAfterNav
              ? 'VERIFIED: reset to 100% after navigation releases capture + offscreen document'
              : 'NOT VERIFIED: reset after navigation did not release the pipeline');
          } else {
            findings.push(`NOT VERIFIED: viewed-tab capture did not start — outcome: ${outcome || '(nothing)'} (slider at ${sliderNow})`);
            const boostsDump = await evalIn(cdp, swSession, `chrome.storage.session.get('boosts').then((s) => JSON.stringify(s.boosts ?? {}))`, true);
            findings.push(`boosts storage at outcome: ${boostsDump}`);
          }
        } else {
          findings.push('the viewed tab’s boost chip was unexpectedly disabled — real-popup flow NOT verified');
        }

        // second media tab — creating it makes it the viewed tab (and
        // dismisses the real popup), so the first tab becomes background
        const media2 = await cdp.send('Target.createTarget', {
          url: `http://127.0.0.1:${SERVE_PORT}/test/media-audio.html?second=1`,
        });
        const media2Session = (await cdp.send('Target.attachToTarget', { targetId: media2.targetId, flatten: true })).sessionId;
        await waitFor(() => evalIn(cdp, media2Session, `!!document.querySelector('audio')`));
        await evalIn(cdp, media2Session, `(() => { const a = document.querySelector('audio'); a.volume = 0.15; return a.play().catch(() => {}); })()`, true);
        await sleep(1200);
        const tabIdsRaw = await evalIn(
          cdp,
          swSession,
          `chrome.tabs.query({url:'http://127.0.0.1:8080/*'}).then(ts => JSON.stringify(ts.map((t) => ({ id: t.id, url: t.url }))))`,
          true,
        );
        const tabIds = JSON.parse(tabIdsRaw);
        const viewedId = tabIds.find((t) => t.url.includes('second=1'))?.id;
        const backgroundId = tabIds.find((t) => !t.url.includes('second=1'))?.id;
        console.log(`second pass: viewed tab ${viewedId}, background tab ${backgroundId}`);
        try {
          const winId2 = await evalIn(cdp, swSession, `chrome.windows.getCurrent().then((w) => w.id)`, true);
          await evalIn(cdp, swSession, `chrome.windows.update(${winId2}, { focused: true }).catch(() => {})`, true);
          await sleep(500);
          await evalIn(cdp, swSession, `chrome.action.openPopup()`, true);
        } catch (e) {
          findings.push(`openPopup() for the second pass failed: ${e.message}`);
        }
        const popupTarget2 = await waitFor(async () => {
          const { targetInfos } = await cdp.send('Target.getTargets');
          return targetInfos.find((t) => t.type === 'page' && t.url.endsWith('/popup.html'));
        }, 8000).catch(() => null);
        if (popupTarget2) {
          const popupSession2 = (await cdp.send('Target.attachToTarget', { targetId: popupTarget2.targetId, flatten: true })).sessionId;
          await sleep(800);
          // raw API check from the popup context, with real user activation:
          // viewed tab vs background tab
          const rawViewed = await evalIn(
            cdp,
            popupSession2,
            `chrome.tabCapture.getMediaStreamId({targetTabId: ${viewedId}}).then(() => 'granted', (e) => 'refused: ' + e.message)`,
            true,
          );
          findings.push(`raw getMediaStreamId for the VIEWED tab: ${rawViewed}`);
          const rawBackground = await evalIn(
            cdp,
            popupSession2,
            `chrome.tabCapture.getMediaStreamId({targetTabId: ${backgroundId}}).then(() => 'granted', (e) => 'refused: ' + e.message)`,
            true,
          );
          findings.push(`raw getMediaStreamId for a BACKGROUND tab: ${rawBackground}`);
        }
      }
      } catch (e) {
        // A real action popup can close at any moment when the environment
        // steals focus (CI desktops, another browser window). The capture
        // outcome up to that point is still a finding, not a setup failure.
        findings.push(`real-popup interaction interrupted: ${e.message} — the action popup may have closed; later real-popup checks were skipped`);
      }
    }

    console.log('\n=== capture verification findings ===');
    for (const f of findings) console.log(`  - ${f}`);
    console.log('(headless E2E additionally covers the truthful error path; audibility needs ears — CHECKLIST #53)');
  } catch (err) {
    console.error('verify-capture setup failure:', err.message);
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

// Browser selection for the test rigs.
//
// Google Chrome is the primary target (the user's daily browser); Microsoft
// Edge stays available for comparison. MCP_BROWSER=chrome|edge overrides the
// autodetection.
//
// Loading the unpacked extension differs per browser:
//   - Edge: --disable-extensions-except + --load-extension on the command
//     line (with the feature flag that keeps that switch honored).
//   - Branded Chrome 137+ ignores --load-extension. The supported path is the
//     DevTools Extensions domain: launch with
//     --enable-unsafe-extension-debugging and call Extensions.loadUnpacked
//     over the browser-level CDP connection. The returned id is the real
//     extension id (the same id an unpacked load produces).

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANDIDATES = {
  chrome: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  edge: [
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ],
};

export function browserName() {
  const forced = (process.env.MCP_BROWSER || '').toLowerCase();
  if (forced === 'chrome' || forced === 'edge') return forced;
  return CANDIDATES.chrome.some(existsSync) ? 'chrome' : 'edge';
}

export function browserPath() {
  const name = browserName();
  const found = CANDIDATES[name].find(existsSync);
  if (!found) throw new Error(`no ${name} installation found`);
  return found;
}

/**
 * The browser's own version, or null when unavailable. Never runs the
 * browser: on Windows `chrome.exe --version` hands off to a running session
 * (it can open a tab in the user's profile), so the executable's file
 * version info is read instead.
 */
export function browserVersion(path = browserPath()) {
  try {
    const quoted = path.replace(/'/g, "''");
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `(Get-Item '${quoted}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    );
    const out = `${r.stdout ?? ''}`.trim();
    return /^\d+(\.\d+)+$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Command-line arguments that prepare the browser for the unpacked
 * extension. Chrome takes the CDP path (loadUnpacked after connect); Edge
 * takes the flag path.
 */
export function extensionArgs(extPath) {
  return browserName() === 'chrome'
    ? ['--enable-unsafe-extension-debugging']
    : [
        '--disable-features=DisableLoadExtensionCommandLineSwitch',
        `--disable-extensions-except=${extPath}`,
        `--load-extension=${extPath}`,
      ];
}

/**
 * Make the unpacked extension available. Edge loaded it from the command
 * line already; Chrome needs one browser-level CDP call. `send` is the
 * rig's browser-level CDP sender.
 */
export async function ensureExtension(send, extPath) {
  if (browserName() !== 'chrome') return null;
  const res = await send('Extensions.loadUnpacked', { path: extPath });
  if (!res?.id) throw new Error(`Chrome refused Extensions.loadUnpacked: ${JSON.stringify(res)}`);
  return res.id;
}

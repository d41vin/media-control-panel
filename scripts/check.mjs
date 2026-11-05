// Static checks that need no browser: module syntax for every JS file the
// extension loads, manifest sanity, and icon presence/sizes.
//
//   npm test

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// the repo keeps the extension in extension/; the packaged archive has it at
// its root (manifest at the archive root) — resolve whichever this is
const ext = existsSync(join(root, 'extension', 'manifest.json')) ? join(root, 'extension') : root;
let failures = 0;

const fail = (msg) => {
  failures++;
  console.error(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

// 1. every JS file parses as a module
for (const rel of [
  'popup.js',
  'background.js',
  'lib/page.js',
  'lib/adapters.js',
  'lib/settings.js',
  'lib/speed.js',
  'lib/manager.js',
  'offscreen.js',
]) {
  const file = join(ext, rel);
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: readFileSync(file),
    encoding: 'utf8',
  });
  if (r.status !== 0) fail(`${rel}: ${r.stderr}`);
  else ok(`${rel} parses`);
}
for (const rel of ['test/mock-chrome.js', 'scripts/make-icons.mjs']) {
  const r = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: readFileSync(join(root, rel)),
    encoding: 'utf8',
  });
  if (r.status !== 0) fail(`${rel}: ${r.stderr}`);
  else ok(`${rel} parses`);
}

// 2. manifest sanity
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) fail('manifest_version must be 3');
else ok('manifest_version 3');
for (const key of ['permissions', 'host_permissions', 'action', 'background', 'commands']) {
  if (!(key in manifest)) fail(`manifest missing ${key}`);
}
ok('manifest keys present');
for (const p of ['scripting', 'storage', 'activeTab', 'tabCapture', 'offscreen', 'webNavigation']) {
  if (!manifest.permissions.includes(p)) fail(`manifest missing ${p} permission`);
}
ok('speed/boost/navigation permissions present (scripting, storage, activeTab, tabCapture, offscreen, webNavigation)');
if (manifest.permissions.includes('tabs')) fail('tabs permission should not be needed');
else ok('no tabs permission');
if (manifest.permissions.includes('sidePanel')) fail('sidePanel permission should be gone');
else ok('no sidePanel permission');
if (manifest.content_scripts) fail('no persistent content scripts expected');
else ok('no persistent content scripts');
if (manifest.action.default_popup !== 'popup.html') fail('action popup path');

// 3. referenced files exist
for (const p of [manifest.action.default_popup, manifest.background.service_worker, 'offscreen.html']) {
  if (!existsSync(join(ext, p))) fail(`missing file: ${p}`);
  else ok(`exists: ${p}`);
}
const offscreenHtml = readFileSync(join(ext, 'offscreen.html'), 'utf8');
if (!offscreenHtml.includes('offscreen.js')) fail('offscreen.html must load offscreen.js');
else ok('offscreen.html references offscreen.js');
for (const size of ['16', '32', '48', '128']) {
  const icon = join(ext, 'icons', `icon${size}.png`);
  if (!existsSync(icon)) {
    fail(`missing icon${size}.png`);
    continue;
  }
  const buf = readFileSync(icon);
  const isPng =
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!isPng) fail(`icon${size}.png is not a PNG`);
  else ok(`icon${size}.png valid (${statSync(icon).size} bytes)`);
}

// 4. popup.html references resolve
const html = readFileSync(join(ext, 'popup.html'), 'utf8');
for (const ref of ['popup.css', 'popup.js']) {
  if (!html.includes(ref)) fail(`popup.html missing reference to ${ref}`);
  else ok(`popup.html references ${ref}`);
  if (!existsSync(join(ext, ref))) fail(`missing file: ${ref}`);
}
for (const theme of ['system', 'light', 'dark']) {
  if (!html.includes(`data-theme-value="${theme}"`)) fail(`appearance selector missing "${theme}"`);
}
ok('appearance selector offers System, Light and Dark');

// 5. injected functions are self-contained (no module-scope references that
//    would break after toString serialization) + the deliberately-inlined
//    copies stay identical
const pageSrc = readFileSync(join(ext, 'lib', 'page.js'), 'utf8');
const adapterSrc = readFileSync(join(ext, 'lib', 'adapters.js'), 'utf8');
const managerSrc = readFileSync(join(ext, 'lib', 'manager.js'), 'utf8');

// module-scope declared names of a file: top-level (column-0) declarations
// and import bindings — the identifiers an injected function must never
// reference after Function.prototype.toString serialization
const moduleScopeNames = (src) => {
  const names = new Set();
  for (const m of src.matchAll(/^import\s(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from/gm)) {
    for (const part of (m[1] ?? '').split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (n) names.add(n);
    }
    if (m[2]) names.add(m[2]);
    if (m[3]) names.add(m[3]);
  }
  for (const m of src.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for (const m of src.matchAll(/^(?:export\s+)?(?:const|let|class)\s+(\w+)/gm)) names.add(m[1]);
  return names;
};

// the body of a top-level function: from its declaration to the next
// column-0 declaration (nested declarations are indented and don't match)
const topLevelBody = (src, name) => {
  const start = src.indexOf(`function ${name}`);
  if (start === -1) return null;
  const rest = src.slice(start);
  const end = rest.slice(1).search(/\n(?:export\s+)?(?:async\s+)?(?:function|const|let|class)\s/);
  return end === -1 ? rest : rest.slice(0, end + 1);
};

const checkSelfContained = (file, src, fnNames) => {
  const moduleNames = moduleScopeNames(src);
  for (const fn of fnNames) {
    const body = topLevelBody(src, fn);
    if (!body) {
      fail(`${file}: injected function ${fn} not found`);
      continue;
    }
    // comments serialize harmlessly but mention sibling functions ("keep
    // this identical to pageProbe's checker") — scan code only
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // the function's own name may appear (recursion); anything else declared
    // at module scope must not
    for (const name of moduleNames) {
      if (name === fn) continue;
      if (new RegExp(`\\b${name}\\b`).test(code) && !new RegExp(`(?:function|const|let|var|class)\\s+${name}\\b`).test(code)) {
        fail(`${file}: ${fn} references module-scope ${name}`);
      }
    }
  }
};

const pageFns = [...pageSrc.matchAll(/export (?:async )?function (page\w+)/g)].map((m) => m[1]);
// adapter functions are injected too — derive them from the ADAPTERS literal
// (not a name pattern) so a new verb cannot ship unguarded
const adaptersBlock = adapterSrc.slice(adapterSrc.indexOf('const ADAPTERS'));
const adapterFns = [...adaptersBlock.matchAll(/^\s+(?:next|prev|syncPlayer|setMuted|readState):\s*(\w+),?$/gm)].map((m) => m[1]);
if (!pageFns.length) fail('no exported page functions found');
if (!adapterFns.length) fail('no adapter functions found in the ADAPTERS literal');
checkSelfContained('lib/page.js', pageSrc, pageFns);
checkSelfContained('lib/adapters.js', adapterSrc, [...new Set(adapterFns)]);
if (!/export function installSpeedManager\(/.test(managerSrc)) {
  fail('lib/manager.js must export installSpeedManager');
} else {
  checkSelfContained('lib/manager.js', managerSrc, ['installSpeedManager']);
}

// drift guard: the media-collection walk and the site-button checker are
// deliberately inlined into every injected function ("keep them identical" —
// lib/page.js header). Strip comments, collapse whitespace, compare.
const stripNorm = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\s+/g, ' ').trim();
const innerOf = (block) => {
  const start = block.indexOf('{');
  const end = block.lastIndexOf('}');
  return stripNorm(block.slice(start + 1, end));
};
const pageIifes = [...pageSrc.matchAll(/const \w+ = \(\(\) => \{[\s\S]*?\}\)\(\);/g)].map((m) => m[0]);
const standardCopies = [];
let videoCopies = 0;
for (const block of pageIifes) {
  if (block.includes("'video, audio'")) standardCopies.push(innerOf(block));
  else if (block.includes("'video'")) videoCopies++;
  else fail('lib/page.js: unrecognized collection IIFE (neither video,audio nor video)');
}
if (standardCopies.length !== 9 || videoCopies !== 1) {
  fail(`lib/page.js: expected 9 standard + 1 video collection copies, found ${standardCopies.length} + ${videoCopies}`);
}
if (standardCopies.length && new Set(standardCopies).size !== 1) {
  const first = standardCopies[0];
  const diverged = pageFns.filter((_, i) => standardCopies[i] !== first);
  fail(`lib/page.js: the inlined media-collection copies have diverged in: ${diverged.join(', ')}`);
}
const mgrCollect = managerSrc.match(/const collect = \(\) => \{[\s\S]*?\n  \};/);
if (!mgrCollect) {
  fail('lib/manager.js: collect() not found for the drift guard');
} else if (standardCopies.length && innerOf(mgrCollect[0]) !== standardCopies[0]) {
  fail('lib/manager.js: collect() has diverged from lib/page.js collection copies');
}
const siteButtonCopies = [...pageSrc.matchAll(/const siteButtonState = \(sel\) => \{[\s\S]*?\n  \};/g)].map((m) => innerOf(m[0]));
if (siteButtonCopies.length !== 2) {
  fail(`lib/page.js: expected siteButtonState in pageProbe and pagePing, found ${siteButtonCopies.length}`);
}
if (siteButtonCopies.length === 2 && siteButtonCopies[0] !== siteButtonCopies[1]) {
  fail('lib/page.js: the siteButtonState copies in pageProbe and pagePing have diverged');
}
ok(
  `page.js + adapters.js + manager.js functions self-contained (${pageFns.length + new Set(adapterFns).size + 1} injected); collection copies in sync (9+1+1), siteButtonState in sync (2)`,
);

// 6. message-type and storage-key contracts -----------------------------------
// The mcp-* message types and the storage keys are kept in sync across
// contexts by convention (a constants module cannot serve lib/manager.js — a
// serialized function — or offscreen.js — a plain script). This table turns
// the convention into a checked contract: every declared participant must
// reference the literal, and every literal in extension/ must be declared.
const extFiles = {
  'popup.js': readFileSync(join(ext, 'popup.js'), 'utf8'),
  'background.js': readFileSync(join(ext, 'background.js'), 'utf8'),
  'lib/page.js': pageSrc,
  'lib/adapters.js': adapterSrc,
  'lib/manager.js': managerSrc,
  'lib/speed.js': readFileSync(join(ext, 'lib', 'speed.js'), 'utf8'),
  'lib/settings.js': readFileSync(join(ext, 'lib', 'settings.js'), 'utf8'),
  'offscreen.js': readFileSync(join(ext, 'offscreen.js'), 'utf8'),
};
const MESSAGE_CONTRACT = {
  'mcp-speed-report': { send: ['lib/manager.js'], receive: ['background.js'] },
  'mcp-speed-page': { send: ['popup.js'], receive: ['background.js'] },
  'mcp-speed-reset': { send: ['popup.js'], receive: ['background.js'] },
  'mcp-speed-sync': { send: ['popup.js'], receive: ['background.js'] },
  'mcp-speed-apply': { send: ['background.js'], receive: ['lib/manager.js'] },
  'mcp-speed-disconnect': { send: ['background.js'], receive: ['lib/manager.js'] },
  'mcp-boost-start': { send: ['popup.js'], receive: ['background.js'] },
  'mcp-boost-gain': { send: ['popup.js'], receive: ['background.js'] },
  'mcp-boost-stop': { send: ['popup.js'], receive: ['background.js'] },
  'mcp-boost-result': { send: ['offscreen.js'], receive: ['background.js', 'popup.js'] },
  'mcp-boost-ended': { send: ['offscreen.js'], receive: ['background.js'] },
  'mcp-boost-offscreen-start': { send: ['background.js'], receive: ['offscreen.js'] },
  'mcp-boost-offscreen-gain': { send: ['background.js'], receive: ['offscreen.js'] },
  'mcp-boost-offscreen-stop': { send: ['background.js'], receive: ['offscreen.js'] },
};
const messageSides = {};
for (const [type, sides] of Object.entries(MESSAGE_CONTRACT)) {
  for (const f of sides.send) {
    if (!extFiles[f].includes(`'${type}'`)) fail(`message ${type}: declared sender ${f} does not reference it`);
    (messageSides[f] ??= new Set()).add(type);
  }
  for (const f of sides.receive) {
    if (!extFiles[f].includes(`'${type}'`)) fail(`message ${type}: declared receiver ${f} does not reference it`);
    (messageSides[f] ??= new Set()).add(type);
  }
}
// Scan code, not prose: comments mention keys and message types, and
// getElementById('settings') is a DOM id, not the storage key.
const codeOnly = (s) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').replace(/getElementById\('([^']*)'\)/g, "getElementById('')");
for (const [f, src] of Object.entries(extFiles)) {
  const code = codeOnly(src);
  for (const m of code.matchAll(/'(mcp-[a-z-]+)'/g)) {
    // 'mcp-speed-'/'mcp-boost-' style literals are ROUTING PREFIXES
    // (startsWith checks), not message types
    if (m[1].endsWith('-')) continue;
    if (!MESSAGE_CONTRACT[m[1]]) fail(`${f}: undeclared message type '${m[1]}'`);
    else if (!messageSides[f]?.has(m[1])) {
      fail(`${f}: unexpected use of '${m[1]}' — add ${f} to its contract entry`);
    }
  }
}
const STORAGE_KEYS = {
  local: {
    speed: ['lib/speed.js'],
    settings: ['lib/settings.js'],
  },
  session: {
    speedOverrides: ['background.js', 'lib/speed.js', 'popup.js'],
    speedRevs: ['background.js'],
    speedCommitted: ['background.js'],
    speedFrameDocs: ['background.js'],
    speedManaged: ['background.js'],
    boosts: ['background.js', 'popup.js'],
    recent: ['background.js', 'popup.js'],
    target: ['background.js', 'popup.js'],
  },
};
const declaredKeys = new Map(); // 'key' -> Set(files)
for (const [area, keys] of Object.entries(STORAGE_KEYS)) {
  for (const [key, files] of Object.entries(keys)) {
    for (const f of files) {
      if (!extFiles[f].includes(`'${key}'`)) fail(`storage ${area}.${key}: declared user ${f} does not reference it`);
      if (!declaredKeys.has(key)) declaredKeys.set(key, new Set());
      declaredKeys.get(key).add(f);
    }
  }
}
for (const [f, src] of Object.entries(extFiles)) {
  const code = codeOnly(src);
  for (const m of code.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'/g)) {
    if (declaredKeys.has(m[1]) && !declaredKeys.get(m[1]).has(f)) {
      fail(`${f}: unexpected use of storage key '${m[1]}' — add ${f} to its contract entry`);
    }
  }
}
ok(`message-type contract checked (${Object.keys(MESSAGE_CONTRACT).length} types) and storage-key contract checked (${declaredKeys.size} keys)`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

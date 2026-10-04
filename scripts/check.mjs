// Static checks that need no browser: module syntax for every JS file the
// extension loads, manifest sanity, and icon presence/sizes.
//
//   npm test

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');
let failures = 0;

const fail = (msg) => {
  failures++;
  console.error(`FAIL ${msg}`);
};
const ok = (msg) => console.log(`ok   ${msg}`);

// 1. every JS file parses as a module
for (const rel of ['popup.js', 'background.js', 'lib/page.js']) {
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
if (manifest.permissions.includes('tabs')) fail('tabs permission should not be needed');
else ok('no tabs permission');
if (manifest.permissions.includes('sidePanel')) fail('sidePanel permission should be gone');
else ok('no sidePanel permission');
if (manifest.content_scripts) fail('no persistent content scripts expected');
else ok('no persistent content scripts');
if (manifest.action.default_popup !== 'popup.html') fail('action popup path');

// 3. referenced files exist
for (const p of [manifest.action.default_popup, manifest.background.service_worker]) {
  if (!existsSync(join(ext, p))) fail(`missing file: ${p}`);
  else ok(`exists: ${p}`);
}
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

// 5. page.js functions are self-contained (no module-scope references that
//    would break after toString serialization)
const pageSrc = readFileSync(join(ext, 'lib', 'page.js'), 'utf8');
const fns = [...pageSrc.matchAll(/export (?:async )?function (page\w+)/g)].map((m) => m[1]);
if (!fns.length) fail('no exported page functions found');
for (const fn of fns) {
  const body = pageSrc.slice(pageSrc.indexOf(`function ${fn}`));
  const end = body.indexOf('\nexport ', 1);
  const src = end === -1 ? body : body.slice(0, end);
  for (const helper of ['collectMedia(', 'primaryOf(']) {
    if (src.includes(helper)) fail(`${fn} references module-scope helper ${helper}`);
  }
}
ok(`page.js functions self-contained (${fns.length} exported)`);

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall checks passed');

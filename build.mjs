// Bundles the extension into dist/ with esbuild and copies static assets.
// Everything is bundled as IIFE single files: content scripts must be classic
// scripts, and classic service workers/panel scripts keep the manifest simple.

import esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist', { recursive: true });

const targets = [
  { entry: 'src/content/content.ts', out: 'content.js' },
  { entry: 'src/background/service-worker.ts', out: 'service-worker.js' },
  { entry: 'src/panel/panel.ts', out: 'panel.js' },
];

const statics = ['src/manifest.json', 'src/panel/panel.html', 'src/panel/panel.css'];

/** @type {import('esbuild').BuildOptions} */
const options = {
  bundle: true,
  format: 'iife',
  target: ['chrome116'],
  logLevel: 'info',
};

for (const target of targets) {
  const buildOptions = { ...options, entryPoints: [target.entry], outfile: path.join('dist', target.out) };
  if (watch) {
    const context = await esbuild.context(buildOptions);
    await context.watch();
  } else {
    await esbuild.build(buildOptions);
  }
}

for (const file of statics) {
  fs.copyFileSync(file, path.join('dist', path.basename(file)));
}

if (watch) console.log('watching for changes...');

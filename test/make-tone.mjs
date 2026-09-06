// Generates test/media/tone.wav: a 10 s 440 Hz sine with a slow amplitude
// wobble, so playback is obvious by ear and by the panel's progress bar.

import fs from 'node:fs';
import path from 'node:path';

const sampleRate = 8000;
const seconds = 10;
const frames = sampleRate * seconds;

const data = Buffer.alloc(frames * 2);
for (let i = 0; i < frames; i++) {
  const wobble = 0.6 + 0.4 * Math.sin((2 * Math.PI * 0.5 * i) / sampleRate);
  data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000 * wobble), i * 2);
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20); // PCM
header.writeUInt16LE(1, 22); // mono
header.writeUInt32LE(sampleRate, 24);
header.writeUInt32LE(sampleRate * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const outDir = path.join(import.meta.dirname, 'media');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tone.wav'), Buffer.concat([header, data]));
console.log('wrote test/media/tone.wav');

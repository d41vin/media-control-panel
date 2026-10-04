// Generates the extension icon set: a Swiss mark — ink square, paper play
// triangle, one red counter-square. Rendered at 512 px and box-downsampled so
// the small sizes get free anti-aliasing. No dependencies beyond node:zlib.
//
//   node scripts/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'extension', 'icons');

const S = 512;
const INK = [17, 17, 17];
const PAPER = [255, 255, 255];
const RED = [227, 6, 19];

// Triangle pointing right, optically centered (slightly left of true center
// because a triangle's visual mass sits at its base).
const TRI = [
  [176, 148],
  [176, 364],
  [352, 256],
];
// Red counter-square, bottom right.
const SQ = { x0: 352, y0: 352, x1: 416, y1: 416 };

function inTriangle(x, y) {
  const [[ax, ay], [bx, by], [cx, cy]] = TRI;
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function renderPixel(x, y) {
  if (x >= SQ.x0 && x < SQ.x1 && y >= SQ.y0 && y < SQ.y1) return RED;
  if (inTriangle(x, y)) return PAPER;
  return INK;
}

// --- master raster -----------------------------------------------------------
const master = new Uint8Array(S * S * 3);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const [r, g, b] = renderPixel(x, y);
    const i = (y * S + x) * 3;
    master[i] = r;
    master[i + 1] = g;
    master[i + 2] = b;
  }
}

// --- box downsample to target size (RGB -> RGBA) -----------------------------
function downsample(size) {
  const f = S / size;
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      const x0 = Math.floor(x * f), x1 = Math.floor((x + 1) * f);
      const y0 = Math.floor(y * f), y1 = Math.floor((y + 1) * f);
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * S + sx) * 3;
          r += master[i];
          g += master[i + 1];
          b += master[i + 2];
          n++;
        }
      }
      const o = (y * size + x) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = 255;
    }
  }
  return out;
}

// --- minimal PNG encoder ------------------------------------------------------
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${size}.png`), encodePng(size, downsample(size)));
  console.log(`icon${size}.png`);
}

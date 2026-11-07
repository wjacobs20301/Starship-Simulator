// The weather's land / sea mask: land fraction (0..255) on a 0.5-degree grid, 720 x 360,
// row 0 at 90 N, column 0 at 180 W. Classified from the Blue Marble globe texture (ocean is
// dark blue: blue well above red), then averaged per cell, so coasts come out as fractions.
//   npx tsx scripts/globe/build-landmask.ts
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '../..');
const W = 720;
const H = 360;

const { data, info } = await sharp(resolve(ROOT, 'public/globe/earth.jpg')).raw().toBuffer({ resolveWithObject: true });
const sw = info.width;
const sh = info.height;
const ch = info.channels;
const sum = new Float64Array(W * H);
const count = new Float64Array(W * H);
for (let y = 0; y < sh; y++) {
  const j = Math.min(H - 1, Math.floor((y / sh) * H));
  for (let x = 0; x < sw; x++) {
    const i = Math.min(W - 1, Math.floor((x / sw) * W));
    const o = (y * sw + x) * ch;
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const ocean = b > r + 12 && b + 8 > g && r + g + b < 420;
    sum[j * W + i] += ocean ? 0 : 1;
    count[j * W + i] += 1;
  }
}
const out = new Uint8Array(W * H);
for (let k = 0; k < W * H; k++) out[k] = Math.round((255 * sum[k]) / Math.max(1, count[k]));
writeFileSync(resolve(ROOT, 'public/data/landmask.bin'), out);
// A preview, to check by eye.
await sharp(Buffer.from(out), { raw: { width: W, height: H, channels: 1 } }).png().toFile(resolve(tmpdir(), 'landmask-preview.png'));
console.log('public/data/landmask.bin', W, 'x', H);

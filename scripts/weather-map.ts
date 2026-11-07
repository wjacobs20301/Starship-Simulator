// Bakes the global weather map and writes a preview (clouds over the land mask), to check the
// weather's patterns by eye without the renderer.
//   npx tsx scripts/weather-map.ts [seed] [site weather] [hours after t0] [out.png]
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { Land, type SiteWeather, WeatherModel } from '../src/weather/model';

const ROOT = resolve(import.meta.dirname, '..');
const seed = Number(process.argv[2] ?? 1);
const site = (process.argv[3] ?? 'natural') as SiteWeather;
const hours = Number(process.argv[4] ?? 0);
const out = process.argv[5] ?? resolve(tmpdir(), `weather-${seed}-${site}-${hours}.png`);

const land = new Land(new Uint8Array(readFileSync(resolve(ROOT, 'public/data/landmask.bin'))));
const model = new WeatherModel({ seed, season: Number(process.env.SEASON ?? -15), site, siteLat: 25.996, siteLon: -97.157, t0: 0 }, land);
const W = 1024, H = 512;
const a = new Uint8Array(W * H * 4), b = new Uint8Array(W * H * 4);
const sun = [Math.cos(-15 * Math.PI / 180), 0, Math.sin(-15 * Math.PI / 180)];
const t = hours * 3600;
const t0 = performance.now();
model.bake(t, sun, W, H, a, b);
console.log('bake', (performance.now() - t0).toFixed(0), 'ms;', model.states(t).length, 'systems');
const s = model.sample(25.996, -97.157, t, sun);
console.log('site', JSON.stringify(Object.fromEntries(Object.entries(s).map(([k, v]) => [k, +v.toFixed(2)]))));
for (const h of [10, 1000, 10000]) console.log('wind', h, model.wind(25.996, -97.157, h, t, false).map((x) => x.toFixed(1)).join(' '));

const img = new Uint8Array(W * H * 3);
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const o = (j * W + i) * 4;
  const lat = -90 + ((j + 0.5) * 180) / H, lon = -180 + ((i + 0.5) * 360) / W;
  const L = land.frac(lat, lon);
  const cov = a[o] / 255, hi = b[o] / 255, pr = b[o + 1] / 255;
  const top = a[o + 1] / 255;
  const base = [20 + 60 * L, 40 + 70 * L, 90 - 50 * L];
  const c = Math.min(1, cov * (0.75 + 0.25 * top * 2) + hi * 0.35 * (1 - cov));
  const row = H - 1 - j;
  const p = (row * W + i) * 3;
  for (let k = 0; k < 3; k++) img[p + k] = Math.round(base[k] * (1 - c) + 255 * c * (k === 2 ? 1 : 1 - 0.25 * pr));
}
await sharp(Buffer.from(img), { raw: { width: W, height: H, channels: 3 } }).png().toFile(out);
console.log(out);

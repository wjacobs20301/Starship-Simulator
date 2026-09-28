// Builds the streamed whole-Earth imagery: NASA Blue Marble Next Generation (July 2004,
// topography + bathymetry, 500 m/px, public domain) reprojected into a Web Mercator tile
// pyramid public/globe/tiles/{z}/{x}/{y}.jpg for z0..z7 (~1.2 km/px at z7).
//
// Land colours around Starbase are matched to the streamed region: the per-channel gain between
// the region's imagery and Blue Marble over the same area is measured and applied to land near
// the region (full strength out to ~120 km, fading to none by ~500 km), so the region blends in
// without a colour step while the rest of the world keeps Blue Marble's natural colours. Ocean
// is untouched (the region's water already takes its colour from Blue Marble).
//
// Sources: art/source/globe/bmng_{A1..D2}.jpg (8 x 21600^2 tiles, 90 x 90 degrees each).
//   npx tsx scripts/globe/build-globe.ts
import { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import sharp from 'sharp';

const ROOT = resolve(import.meta.dirname, '../..');
const SRC = resolve(ROOT, 'art/source/globe');
const LIVE = resolve(ROOT, 'public/globe/tiles');
const OUT = `${LIVE}.building`;
const TERRAIN = resolve(ROOT, 'public/terrain');
export const GLOBE_MAX_ZOOM = 7;
const SRC_SIZE = 21600;
const PX_PER_DEG = SRC_SIZE / 90;

sharp.cache(false);

const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileYToLat = (y: number, z: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));

/** Source tile letter/number covering a lon/lat: A..D = 90-degree columns from -180, 1 = north. */
const sourceName = (col: number, row: number) => `bmng_${'ABCD'[col]}${row + 1}.jpg`;

interface Source { col: number; row: number; data: Buffer }

async function loadSource(col: number, row: number): Promise<Source> {
  const file = resolve(SRC, sourceName(col, row));
  const { data } = await sharp(file, { limitInputPixels: false }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { col, row, data };
}

/** Bilinear sample of a source tile at lon/lat (must lie inside it), writes sRGB 0..255. */
function sample(src: Source, lat: number, lon: number, out: number[]) {
  const fx = (lon - (-180 + 90 * src.col)) * PX_PER_DEG - 0.5;
  const fy = ((src.row === 0 ? 90 : 0) - lat) * PX_PER_DEG - 0.5;
  const x0 = Math.max(0, Math.min(SRC_SIZE - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(SRC_SIZE - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const d = src.data;
  for (let c = 0; c < 3; c++) {
    const p = (x: number, y: number) => d[(y * SRC_SIZE + x) * 3 + c];
    out[c] = (p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx) * (1 - ty) + (p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx) * ty;
  }
}

/** Blue Marble ocean is distinctly blue; land isn't. Soft 0..1 land weight. */
function landWeight(rgb: number[]): number {
  const blueness = rgb[2] - Math.max(rgb[0], rgb[1]);
  return 1 - Math.min(1, Math.max(0, (blueness - 8) / 20));
}

const REGION = { lat: 25.99613, lon: -97.15442 };
/** 0..1 strength of the local colour match by great-circle distance from Starbase. */
function matchStrength(lat: number, lon: number): number {
  const r = Math.PI / 180;
  const c = Math.sin(lat * r) * Math.sin(REGION.lat * r) + Math.cos(lat * r) * Math.cos(REGION.lat * r) * Math.cos((lon - REGION.lon) * r);
  const km = Math.acos(Math.min(1, Math.max(-1, c))) * 6371;
  const t = Math.min(1, Math.max(0, (km - 120) / 380));
  return 1 - t * t * (3 - 2 * t);
}

const toLin = (v: number) => (v / 255) ** 2.2;
const toSrgb = (v: number) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));

/**
 * Per-channel linear gain that maps Blue Marble land onto the region imagery, measured over the
 * region's z10 tiles (land pixels only).
 */
async function measureGain(src: Source): Promise<number[]> {
  const index = JSON.parse(readFileSync(resolve(TERRAIN, 'index.json'), 'utf8'));
  const r = index.ranges['10'];
  const sumA = [0, 0, 0];
  const sumB = [0, 0, 0];
  const bm = [0, 0, 0];
  let n = 0;
  for (let x = r.x0; x <= r.x1; x++) {
    for (let y = r.y0; y <= r.y1; y++) {
      const f = resolve(TERRAIN, `img/10/${x}/${y}.jpg`);
      if (!existsSync(f)) continue;
      const { data, info } = await sharp(f).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      for (let py = 0; py < info.height; py += 2) {
        const lat = tileYToLat(y + (py + 0.5) / info.height, 10);
        for (let px = 0; px < info.width; px += 2) {
          const lon = tileXToLon(x + (px + 0.5) / info.width, 10);
          sample(src, lat, lon, bm);
          if (landWeight(bm) < 0.99) continue;
          const k = (py * info.width + px) * 3;
          for (let c = 0; c < 3; c++) {
            sumA[c] += toLin(data[k + c]);
            sumB[c] += toLin(bm[c]);
          }
          n++;
        }
      }
    }
  }
  const gain = sumA.map((a, c) => (n ? a / sumB[c] : 1));
  console.log(`colour gain from ${n} land samples: ${gain.map((g) => g.toFixed(2)).join(', ')}`);
  return gain;
}

function write(file: string, buf: Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, buf);
}

async function main() {
  rmSync(OUT, { recursive: true, force: true });
  const z = GLOBE_MAX_ZOOM;
  const n = 2 ** z;
  let gain = [1, 1, 1];
  const rgb = [0, 0, 0];
  // z7: one source tile at a time (each is 1.4 GB decoded). Mercator rows split cleanly at the
  // equator and columns at 90-degree meridians, so every z7 tile lies inside one source tile.
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 4; col++) {
      const src = await loadSource(col, row);
      // Starbase (97 W, 26 N) lies in A1, the first source processed: measure the colour gain there.
      if (col === 0 && row === 0) gain = await measureGain(src);
      const x0 = (col * n) / 4;
      const y0 = row === 0 ? 0 : n / 2;
      const jobs: Promise<void>[] = [];
      for (let x = x0; x < x0 + n / 4; x++) {
        for (let y = y0; y < y0 + n / 2; y++) {
          const out = Buffer.alloc(256 * 256 * 3);
          for (let py = 0; py < 256; py++) {
            const lat = tileYToLat(y + (py + 0.5) / 256, z);
            for (let px = 0; px < 256; px++) {
              const lon = tileXToLon(x + (px + 0.5) / 256, z);
              sample(src, lat, lon, rgb);
              const w = landWeight(rgb) * matchStrength(lat, lon);
              const k = (py * 256 + px) * 3;
              for (let c = 0; c < 3; c++) {
                const lin = toLin(rgb[c]);
                out[k + c] = toSrgb(lin * (1 + (gain[c] - 1) * w));
              }
            }
          }
          jobs.push(
            sharp(out, { raw: { width: 256, height: 256, channels: 3 } })
              .jpeg({ quality: 85 })
              .toBuffer()
              .then((b) => write(resolve(OUT, `${z}/${x}/${y}.jpg`), b)),
          );
          if (jobs.length >= 32) await Promise.all(jobs.splice(0));
        }
      }
      await Promise.all(jobs);
      console.log(`z${z}: source ${sourceName(col, row)} done`);
    }
  }
  // Lower zooms: 2x2 children -> 512 -> 256.
  for (let zz = z - 1; zz >= 0; zz--) {
    const m = 2 ** zz;
    const jobs: Promise<void>[] = [];
    for (let x = 0; x < m; x++) {
      for (let y = 0; y < m; y++) {
        const kids = [];
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) kids.push({ input: resolve(OUT, `${zz + 1}/${2 * x + dx}/${2 * y + dy}.jpg`), left: dx * 256, top: dy * 256 });
        jobs.push(
          sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } } })
            .composite(kids)
            .raw()
            .toBuffer({ resolveWithObject: true })
            .then(({ data, info }) => sharp(data, { raw: info }).resize(256, 256, { kernel: 'lanczos3' }).jpeg({ quality: 85 }).toBuffer())
            .then((b) => write(resolve(OUT, `${zz}/${x}/${y}.jpg`), b)),
        );
        if (jobs.length >= 32) await Promise.all(jobs.splice(0));
      }
    }
    await Promise.all(jobs);
    console.log(`z${zz}: ${m * m} tiles`);
  }
  writeFileSync(resolve(OUT, 'index.json'), JSON.stringify({ maxZoom: z, gain, source: 'NASA Blue Marble Next Generation, July 2004 (topography + bathymetry), public domain' }));
  rmSync(LIVE, { recursive: true, force: true });
  renameSync(OUT, LIVE);
  console.log('globe tiles swapped in');
}

main();

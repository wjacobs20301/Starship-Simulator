// Repairs "no data" in the built imagery: aerial survey (NAIP) tiles at the edge of its coverage
// hold black pixels where it has none, and the coarser tiles built from them carry those down.
// In the game they showed as dark lines and strips along the survey's edge (the Rio Grande, the
// coverage limits). Every tile with black pixels gets them, and a thin fringe round them (JPEG
// smears the black a pixel or two), replaced by the satellite imagery of the same ground:
//   z >= 14: the Sentinel-2 mosaic tile, cropped and scaled up;
//   z 12-13: the Sentinel-2 tiles under it, put together and scaled down;
//   coarser: the global imagery (Blue Marble), which is all there is at that scale.
// Works in place on the live tiles (never through a hard link to a source tile); tiles without
// black are left alone. Run: npx tsx scripts/terrain/fix-nodata.ts [--dry-run]

import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import sharp from 'sharp';
import { OUT as LIVE, S2_ZOOM, SRC, tileXToLon, tileYToLat } from './config';

const dryRun = process.argv.includes('--dry-run');
/** --only=z/x/y --preview=file.jpg: repair one tile into a preview file (the live tile untouched). */
const only = process.argv.find((a) => a.startsWith('--only='))?.slice(7);
const preview = process.argv.find((a) => a.startsWith('--preview='))?.slice(10);
const IMG = resolve(LIVE, 'img');
const S2 = resolve(SRC, 's2', String(S2_ZOOM));
const BLACK = 20; // all channels below this: no data
const FRINGE = 2; // px round the black also replaced

const s2File = (x: number, y: number) => {
  const f = resolve(S2, `${x}/${y}.jpg`);
  return existsSync(f) && statSync(f).size >= 2000 ? f : null;
};

/** 256x256 RGB of the satellite imagery for tile (z, x, y), or null where there's none. */
async function fallback(z: number, x: number, y: number, globe: (lat: number, lon: number, out: number[]) => void): Promise<Buffer | null> {
  if (z >= S2_ZOOM) {
    const d = z - S2_ZOOM;
    const f = s2File(x >> d, y >> d);
    if (!f) return null;
    const size = 256 >> d;
    return sharp(f)
      .removeAlpha()
      .extract({ left: (x - ((x >> d) << d)) * size, top: (y - ((y >> d) << d)) * size, width: size, height: size })
      .resize(256, 256, { kernel: 'cubic' })
      .raw()
      .toBuffer();
  }
  const d = S2_ZOOM - z;
  if (d <= 2) {
    const n = 1 << d;
    const parts: sharp.OverlayOptions[] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const f = s2File((x << d) + i, (y << d) + j);
      if (f) parts.push({ input: f, left: i * 256, top: j * 256 });
    }
    if (!parts.length) return null;
    const big = await sharp({ create: { width: n * 256, height: n * 256, channels: 3, background: { r: 0, g: 0, b: 0 } } }).composite(parts).png().toBuffer();
    return sharp(big).resize(256, 256, { kernel: 'lanczos3' }).removeAlpha().raw().toBuffer();
  }
  const out = Buffer.alloc(256 * 256 * 3);
  const c = [0, 0, 0];
  for (let py = 0; py < 256; py++) {
    const lat = tileYToLat(y + (py + 0.5) / 256, z);
    for (let px = 0; px < 256; px++) {
      globe(lat, tileXToLon(x + (px + 0.5) / 256, z), c);
      out.set(c.map(Math.round), (py * 256 + px) * 3);
    }
  }
  return out;
}

async function main() {
  const { data: gData, info: gInfo } = await sharp(resolve(LIVE, '../globe/earth.jpg')).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const globe = (lat: number, lon: number, out: number[]) => {
    const fx = ((lon + 180) / 360) * gInfo.width - 0.5;
    const fy = ((90 - lat) / 180) * gInfo.height - 0.5;
    const x0 = Math.max(0, Math.min(gInfo.width - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(gInfo.height - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let ch = 0; ch < 3; ch++) {
      const p = (px: number, py: number) => gData[(py * gInfo.width + px) * 3 + ch];
      out[ch] = (p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx) * (1 - ty) + (p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx) * ty;
    }
  };

  const files: [number, number, number][] = [];
  if (only) files.push(only.split('/').map(Number) as [number, number, number]);
  else for (const z of readdirSync(IMG).map(Number).filter(Number.isFinite)) {
    for (const x of readdirSync(resolve(IMG, String(z)))) {
      for (const f of readdirSync(resolve(IMG, `${z}/${x}`))) if (f.endsWith('.jpg')) files.push([z, Number(x), Number(f.slice(0, -4))]);
    }
  }
  console.log(`${files.length} imagery tiles to check${dryRun ? ' (dry run)' : ''}`);
  const perZoom: Record<number, number> = {};
  let fixed = 0, noFallback = 0, done = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < files.length) {
        const [z, x, y] = files[next++];
        const file = resolve(IMG, `${z}/${x}/${y}.jpg`);
        const { data, info } = await sharp(readFileSync(file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
        const W = info.width, H = info.height;
        const black = new Uint8Array(W * H);
        let any = false;
        for (let i = 0; i < W * H; i++) {
          if (data[i * 3] < BLACK && data[i * 3 + 1] < BLACK && data[i * 3 + 2] < BLACK) {
            black[i] = 1;
            any = true;
          }
        }
        if (++done % 50000 === 0) console.log(`  ${done} / ${files.length} checked, ${fixed} fixed`);
        if (!any) continue;
        // Grow the mask by the fringe.
        const mask = new Uint8Array(black);
        for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
          if (!black[py * W + px]) continue;
          for (let dy = -FRINGE; dy <= FRINGE; dy++) for (let dx = -FRINGE; dx <= FRINGE; dx++) {
            const qx = px + dx, qy = py + dy;
            if (qx >= 0 && qy >= 0 && qx < W && qy < H) mask[qy * W + qx] = 1;
          }
        }
        const fill = await fallback(z, x, y, globe);
        if (!fill) {
          noFallback++;
          continue;
        }
        for (let i = 0; i < W * H; i++) if (mask[i]) for (let ch = 0; ch < 3; ch++) data[i * 3 + ch] = fill[i * 3 + ch];
        perZoom[z] = (perZoom[z] ?? 0) + 1;
        fixed++;
        if (dryRun) continue;
        const jpg = await sharp(data, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 88 }).toBuffer();
        if (preview) {
          writeFileSync(preview, jpg);
          continue;
        }
        rmSync(file); // may be a hard link to a source tile: never write through it
        writeFileSync(file, jpg);
      }
    }),
  );
  console.log(`fixed ${fixed} tiles`, perZoom, noFallback ? `(${noFallback} with black but no satellite imagery to fill from)` : '');
}

main();

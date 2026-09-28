// Downloads USGS 3DEP bare-earth elevation (public domain) for the 40 km core as
// 6 x 6 float32 GeoTIFF chunks on a geographic (lat/lon) grid, ~3 m spacing.
// Heights are NAVD88 metres; open water is hydro-flattened (Gulf ~0 m, bays ~-0.6 m).
//   npx tsx scripts/terrain/fetch-dem.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CORE as BOUNDS, SRC } from './config';

export const DEM_SPACING_M = 3;
export const DEM_CHUNKS = 6; // per axis (the service times out on very large requests)

const URL = 'https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage';

export function demChunks() {
  const lonSpan = BOUNDS.east - BOUNDS.west;
  const latSpan = BOUNDS.north - BOUNDS.south;
  const widthM = lonSpan * 111_320 * Math.cos(((BOUNDS.north + BOUNDS.south) / 2) * (Math.PI / 180));
  const px = Math.ceil(widthM / DEM_SPACING_M / DEM_CHUNKS);
  const chunks = [];
  for (let i = 0; i < DEM_CHUNKS; i++) {
    for (let j = 0; j < DEM_CHUNKS; j++) {
      // 1% overlap so bilinear sampling never falls between chunks.
      const pad = 0.01 / DEM_CHUNKS;
      const west = BOUNDS.west + lonSpan * (j / DEM_CHUNKS - pad);
      const east = BOUNDS.west + lonSpan * ((j + 1) / DEM_CHUNKS + pad);
      const south = BOUNDS.south + latSpan * (i / DEM_CHUNKS - pad);
      const north = BOUNDS.south + latSpan * ((i + 1) / DEM_CHUNKS + pad);
      chunks.push({ file: resolve(SRC, `dem/chunk_${i}_${j}.tif`), west, east, south, north, w: Math.round(px * 1.02), h: Math.round(px * 1.02) });
    }
  }
  return chunks;
}

async function main() {
  mkdirSync(resolve(SRC, 'dem'), { recursive: true });
  for (const c of demChunks()) {
    if (existsSync(c.file)) {
      console.log(`have ${c.file}`);
      continue;
    }
    const q = new URLSearchParams({
      bbox: `${c.west},${c.south},${c.east},${c.north}`,
      bboxSR: '4326',
      imageSR: '4326',
      size: `${c.w},${c.h}`,
      format: 'tiff',
      pixelType: 'F32',
      noData: '-9999',
      interpolation: 'RSP_BilinearInterpolation',
      compression: 'LZ77',
      f: 'image',
    });
    const t = Date.now();
    let buf: Buffer | null = null;
    for (let attempt = 0; attempt < 5 && !buf; attempt++) {
      const res = await fetch(`${URL}?${q}`);
      if (res.ok) buf = Buffer.from(await res.arrayBuffer());
      else {
        console.warn(`HTTP ${res.status} for ${c.file}, retrying`);
        await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
      }
    }
    if (!buf) throw new Error(`giving up on ${c.file}`);
    writeFileSync(c.file, buf);
    console.log(`${c.file}: ${c.w}x${c.h}, ${(buf.length / 1e6).toFixed(0)} MB in ${((Date.now() - t) / 1000).toFixed(0)} s`);
  }
}

import { pathToFileURL } from 'node:url';
if (import.meta.url === pathToFileURL(process.argv[1]).href) main();

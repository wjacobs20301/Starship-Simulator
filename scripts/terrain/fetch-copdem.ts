// Downloads the Copernicus GLO-30 DEM (30 m; free for use with attribution) 1-degree COGs
// covering the 200 km region, from the AWS Open Data mirror (no sign-in). The 3 m USGS lidar
// still covers the 40 km core. Tiles over open sea don't exist and are skipped.
//   npx tsx scripts/terrain/fetch-copdem.ts
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BOUNDS, SRC } from './config';

async function main() {
  const dir = resolve(SRC, 'copdem');
  mkdirSync(dir, { recursive: true });
  for (let lat = Math.floor(BOUNDS.south); lat <= Math.floor(BOUNDS.north); lat++) {
    for (let lon = Math.floor(BOUNDS.west); lon <= Math.floor(BOUNDS.east); lon++) {
      const ns = `${lat >= 0 ? 'N' : 'S'}${String(Math.abs(lat)).padStart(2, '0')}_00`;
      const ew = `${lon >= 0 ? 'E' : 'W'}${String(Math.abs(lon)).padStart(3, '0')}_00`;
      const id = `Copernicus_DSM_COG_10_${ns}_${ew}_DEM`;
      const file = resolve(dir, `${id}.tif`);
      if (existsSync(file)) continue;
      const res = await fetch(`https://copernicus-dem-30m.s3.amazonaws.com/${id}/${id}.tif`);
      if (res.status === 404 || res.status === 403) {
        console.log(`${id}: none (open sea)`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${id}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(file, buf);
      console.log(`${id}: ${(buf.length / 1e6).toFixed(1)} MB`);
    }
  }
}

main();

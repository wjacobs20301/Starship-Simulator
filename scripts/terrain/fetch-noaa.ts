// Downloads NOAA's January 2026 aerial survey of Starbase: orthorectified GeoTIFFs, 0.3 m a
// pixel, in 45-arcsecond cells (NOAA Emergency Response Imagery, flight GC2601a of 18 January
// 2026; public domain, from the NOAA Open Data Dissemination bucket). Twice as sharp as the 2022
// NAIP survey the terrain is built from, and four years newer: Pad 2, the roundabout, the
// Starfactory and the Gigabay are in it. Only the cells over the launch site, the production
// site and the road between them (noaa-cells.ts): ~700 MB. Resumable.
//   npx tsx scripts/terrain/fetch-noaa.ts
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { NOAA_BASE, NOAA_DIR, noaaCells } from './noaa-cells';

async function main() {
  mkdirSync(NOAA_DIR, { recursive: true });
  for (const c of noaaCells()) {
    const file = resolve(NOAA_DIR, c.name);
    const head = await fetch(NOAA_BASE + c.name, { method: 'HEAD' });
    if (!head.ok) {
      console.warn(`no ${c.name}: HTTP ${head.status}`);
      continue;
    }
    const size = Number(head.headers.get('content-length'));
    if (existsSync(file) && statSync(file).size === size) {
      console.log(`have ${c.name}`);
      continue;
    }
    const res = await fetch(NOAA_BASE + c.name);
    if (!res.ok || !res.body) throw new Error(`${c.name}: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(`${file}.part`));
    if (statSync(`${file}.part`).size !== size) throw new Error(`${c.name}: cut short`);
    renameSync(`${file}.part`, file);
    console.log(`${c.name}  ${(size / 1e6).toFixed(0)} MB`);
  }
}

main();

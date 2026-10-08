// Downloads the whole-Earth imagery the globe is built from: NASA Blue Marble Next Generation,
// July 2004, topography + bathymetry, 500 m/px (public domain), as 8 tiles of 21600 x 21600
// (90 x 90 degrees each, ~420 MB in all) -> art/source/globe/bmng_{A1..D2}.jpg.
// Resumable: a tile already there at its full size is skipped.
//   npx tsx scripts/globe/fetch-globe.ts
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const ROOT = resolve(import.meta.dirname, '../..');
const DIR = resolve(ROOT, 'art/source/globe');
const BASE = 'https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july';
const TILES = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'];

async function fetchTile(tile: string): Promise<void> {
  const url = `${BASE}/world.topo.bathy.200407.3x21600x21600.${tile}.jpg`;
  const file = resolve(DIR, `bmng_${tile}.jpg`);
  const head = await fetch(url, { method: 'HEAD' });
  if (!head.ok) throw new Error(`${tile}: HTTP ${head.status} from ${url}`);
  const size = Number(head.headers.get('content-length'));
  if (existsSync(file) && statSync(file).size === size) {
    console.log(`${tile}: already here`);
    return;
  }
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${tile}: HTTP ${res.status} from ${url}`);
  // To a part file, renamed when complete (an interrupted download is never mistaken for a tile).
  const part = `${file}.part`;
  await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), createWriteStream(part));
  if (statSync(part).size !== size) throw new Error(`${tile}: got ${statSync(part).size} bytes, expected ${size}`);
  renameSync(part, file);
  console.log(`${tile}: ${(size / 1e6).toFixed(1)} MB`);
}

async function main() {
  mkdirSync(DIR, { recursive: true });
  for (const tile of TILES) await fetchTile(tile);
  console.log(`Blue Marble sources in ${DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

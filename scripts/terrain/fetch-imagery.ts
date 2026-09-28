// Downloads NAIP 2022 imagery tiles (Web Mercator z18 JPEG) for the terrain region.
// Only tiles inside NAIP quarter-quad footprints are requested (most of the region is Gulf
// or Mexico, which NAIP doesn't cover). Resumable: existing tiles are skipped; tiles with no
// imagery are remembered.
//   npx tsx scripts/terrain/fetch-imagery.ts [--concurrency=16]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { BOUNDS, MAX_ZOOM, NAIP_MOSAIC_SEARCH, SRC, stacSearch, tileRange, tileXToLon, tileYToLat } from './config';

const API = 'https://planetarycomputer.microsoft.com/api/data/v1';
const concurrency = Number(process.argv.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? 16);
const dir = resolve(SRC, 'naip');
const emptyFile = resolve(dir, 'empty.json');

async function register(): Promise<string> {
  const res = await fetch(`${API}/mosaic/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(NAIP_MOSAIC_SEARCH),
  });
  const json = (await res.json()) as { searchid: string };
  return json.searchid;
}

async function main() {
  mkdirSync(dir, { recursive: true });
  const empty = new Set<string>(existsSync(emptyFile) ? JSON.parse(readFileSync(emptyFile, 'utf8')) : []);
  const sid = await register();
  const z = MAX_ZOOM;
  const { x0, x1, y0, y1 } = tileRange(z);
  const items = await stacSearch({
    collections: ['naip'],
    bbox: [BOUNDS.west, BOUNDS.south, BOUNDS.east, BOUNDS.north],
    limit: 500,
    query: { 'naip:year': { eq: '2022' }, 'naip:state': { eq: 'tx' } },
  });
  const boxes = items.map((f) => f.bbox);
  writeFileSync(resolve(dir, 'footprints.json'), JSON.stringify(boxes));
  const inNaip = (x: number, y: number) => {
    const w = tileXToLon(x, z), e = tileXToLon(x + 1, z), n = tileYToLat(y, z), s = tileYToLat(y + 1, z);
    return boxes.some((b) => b[0] < e && b[2] > w && b[1] < n && b[3] > s);
  };
  const jobs: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) if (inNaip(x, y)) jobs.push([x, y]);
  console.log(`${items.length} NAIP quarter-quads`);
  const todo = jobs.filter(([x, y]) => !empty.has(`${x}/${y}`) && !existsSync(resolve(dir, `${z}/${x}/${y}.jpg`)));
  console.log(`z${z}: ${jobs.length} tiles in bounds, ${todo.length} to fetch (search ${sid})`);

  let done = 0;
  let failed = 0;
  const started = Date.now();
  const fetchTile = async ([x, y]: [number, number]) => {
    const url = `${API}/mosaic/tiles/${sid}/WebMercatorQuad/${z}/${x}/${y}@1x.jpg?collection=naip&assets=image&asset_bidx=image%7C1,2,3`;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 404 || res.status === 204) {
          empty.add(`${x}/${y}`);
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        const file = resolve(dir, `${z}/${x}/${y}.jpg`);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, buf);
        return;
      } catch (err) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        if (attempt === 4) {
          failed++;
          console.warn(`failed ${x}/${y}: ${(err as Error).message}`);
        }
      }
    }
  };

  let next = 0;
  const worker = async () => {
    while (next < todo.length) {
      const job = todo[next++];
      await fetchTile(job);
      done++;
      if (done % 500 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        const eta = (todo.length - done) / rate / 60;
        console.log(`${done}/${todo.length}  ${rate.toFixed(1)} tiles/s  ETA ${eta.toFixed(0)} min  (${empty.size} empty)`);
        writeFileSync(emptyFile, JSON.stringify([...empty]));
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  writeFileSync(emptyFile, JSON.stringify([...empty]));
  console.log(`done: ${done} processed, ${failed} failed, ${empty.size} empty`);
}

main();

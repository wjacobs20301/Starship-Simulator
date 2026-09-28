// Resumable, concurrent download of Planetary Computer mosaic tiles (Web Mercator JPEG).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const API = 'https://planetarycomputer.microsoft.com/api/data/v1';

export async function registerMosaic(search: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${API}/mosaic/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(search),
  });
  return ((await res.json()) as { searchid: string }).searchid;
}

/** Fetch z/x/y tiles into dir/z/x/y.jpg; 404/204 tiles are recorded in dir/empty.json. */
export async function downloadTiles(opts: {
  search: Record<string, unknown>;
  collection: string;
  query: string;
  z: number;
  jobs: [number, number][];
  dir: string;
  concurrency: number;
}): Promise<void> {
  const { z, dir } = opts;
  mkdirSync(dir, { recursive: true });
  const emptyFile = resolve(dir, 'empty.json');
  const empty = new Set<string>(existsSync(emptyFile) ? JSON.parse(readFileSync(emptyFile, 'utf8')) : []);
  const sid = await registerMosaic(opts.search);
  const todo = opts.jobs.filter(([x, y]) => !empty.has(`${x}/${y}`) && !existsSync(resolve(dir, `${z}/${x}/${y}.jpg`)));
  console.log(`z${z}: ${opts.jobs.length} tiles, ${todo.length} to fetch (search ${sid})`);

  let done = 0;
  let failed = 0;
  const started = Date.now();
  const fetchTile = async ([x, y]: [number, number]) => {
    const url = `${API}/mosaic/tiles/${sid}/WebMercatorQuad/${z}/${x}/${y}@1x.jpg?collection=${opts.collection}&${opts.query}`;
    for (let attempt = 0; attempt < 6; attempt++) {
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
        if (attempt === 5) {
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
      if (done % 1000 === 0) {
        const rate = done / ((Date.now() - started) / 1000);
        console.log(`${done}/${todo.length}  ${rate.toFixed(1)} tiles/s  ETA ${((todo.length - done) / rate / 60).toFixed(0)} min  (${empty.size} empty)`);
        writeFileSync(emptyFile, JSON.stringify([...empty]));
      }
    }
  };
  await Promise.all(Array.from({ length: opts.concurrency }, worker));
  writeFileSync(emptyFile, JSON.stringify([...empty]));
  console.log(`done: ${done} processed, ${failed} failed, ${empty.size} empty`);
}

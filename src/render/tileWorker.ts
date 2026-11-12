// The page's side of the tile workers (tiles.worker.ts): a tile to build goes to one of a few
// workers, and comes back as finished arrays (image compressed, vertices, normals, triangles),
// handed over without copying. terrain.ts and globeTiles.ts wrap them in a mesh.

import type { FromTileWorker, GlobeTileJob, GlobeTileResult, TerrainTileJob, TerrainTileResult, TileJob, TileResult, ToTileWorker } from '../worker/tileProtocol';
import TileWorker from '../worker/tiles.worker.ts?worker';

interface Waiting {
  resolve: (r: TileResult) => void;
  reject: (err: Error) => void;
}

/** A worker (started when first needed) and the tiles it's building. */
interface Slot {
  worker: Worker | null;
  waiting: Map<number, Waiting>;
}

/**
 * Two or three workers where there are the cores for them (a tile is mostly fetching, then a
 * few milliseconds of compressing: with twenty in flight one worker falls behind the network),
 * leaving cores for the page, the sim's worker and the browser.
 */
const POOL = Math.max(1, Math.min(3, Math.floor((navigator.hardwareConcurrency ?? 4) / 2) - 1));
const slots: Slot[] = Array.from({ length: POOL }, () => ({ worker: null, waiting: new Map() }));
let nextId = 1;

/** A worker that broke (its script didn't load, or it died): its tiles fail, to be tried again on a new one. */
function broke(slot: Slot, worker: Worker, why: string): void {
  if (slot.worker !== worker) return;
  worker.terminate();
  slot.worker = null;
  const waiting = [...slot.waiting.values()];
  slot.waiting.clear();
  for (const w of waiting) w.reject(new Error(`tile worker: ${why}`));
}

function start(slot: Slot): Worker {
  const worker = new TileWorker();
  worker.onmessage = (ev: MessageEvent<FromTileWorker>) => {
    const w = slot.waiting.get(ev.data.id);
    if (!w) return;
    slot.waiting.delete(ev.data.id);
    if (ev.data.ok) w.resolve(ev.data.result);
    else w.reject(new Error(ev.data.error));
  };
  worker.onerror = (ev) => broke(slot, worker, ev.message || 'failed');
  worker.onmessageerror = () => broke(slot, worker, 'unreadable message');
  return worker;
}

/**
 * The worker for a tile: the least busy; but tiles taking their heights from the same DEM tile
 * (the finest ones all do, from a few) go to the same worker, which has it already, unless that
 * one is well behind the others.
 */
function pick(dem: string | null): Slot {
  let least = slots[0];
  for (const s of slots) if (s.waiting.size < least.waiting.size) least = s;
  if (dem === null) return least;
  let h = 0;
  for (let i = 0; i < dem.length; i++) h = (Math.imul(h, 31) + dem.charCodeAt(i)) | 0;
  const own = slots[(h >>> 0) % slots.length];
  return own.waiting.size > least.waiting.size + 3 ? least : own;
}

/** (A worker's addresses are relative to its own script, not the page.) */
const absolute = (url: string): string => new URL(url, document.baseURI).href;

function run(job: TileJob): Promise<TileResult> {
  const dem = job.kind === 'terrain' && job.dem ? job.dem.url : null;
  const slot = pick(dem);
  slot.worker ??= start(slot);
  const id = nextId++;
  return new Promise((resolve, reject) => {
    slot.waiting.set(id, { resolve, reject });
    slot.worker!.postMessage({ id, job } satisfies ToTileWorker);
  });
}

/** Build a terrain tile: heights, geometry and (asked for) its image compressed. Rejects if a fetch fails. */
export function buildTerrainTile(job: Omit<TerrainTileJob, 'kind'>): Promise<TerrainTileResult> {
  return run({
    kind: 'terrain',
    shape: job.shape,
    dem: job.dem && { ...job.dem, url: absolute(job.dem.url) },
    image: job.image && absolute(job.image),
  }) as Promise<TerrainTileResult>;
}

/** Build a globe tile: geometry and (asked for) its image compressed. */
export function buildGlobeTile(job: Omit<GlobeTileJob, 'kind'>): Promise<GlobeTileResult> {
  return run({ kind: 'globe', shape: job.shape, image: job.image && absolute(job.image) }) as Promise<GlobeTileResult>;
}

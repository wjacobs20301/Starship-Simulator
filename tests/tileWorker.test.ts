import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGlobeGeometry, buildTerrainGeometry, tileHeights, DEM_MARGIN, cleanDem, demCellSize } from '../src/render/tileGeometry';
import { toWorld, tileXToLon, tileYToLat } from '../src/render/geo';
import type { FromTileWorker, TerrainTileJob, TileJob, ToTileWorker } from '../src/worker/tileProtocol';
import { decodeBc1, psnr } from './bc1Reference';

// The tile worker (src/worker/tiles.worker.ts) run in node, with the browser's parts stood in
// for: fetch, createImageBitmap and an OffscreenCanvas that hand back made-up pixels. What's
// checked is the worker's own work: the tile it sends back, which way up the image is, what it
// does when a fetch fails or the browser can't read pixels in a worker.

/** A made-up tile image, rows top to bottom: red at the top going to blue at the bottom. */
function picture(width: number, height: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out.set([255 - Math.round((y / (height - 1)) * 255), 40 + (x >> 3), Math.round((y / (height - 1)) * 255), 255], (y * width + x) * 4);
  }
  return out;
}

const G = 129;
const DEM = Int16Array.from({ length: G * G }, (_, i) => Math.round(200 * Math.sin((i % G) / 11) + 150 * Math.cos(Math.floor(i / G) / 7)));

interface Posted {
  msg: FromTileWorker;
  transfer: ArrayBuffer[];
}

/** Start a worker (a fresh copy of the module) and get a way to send it a job. */
async function startWorker(opts: { canvas?: boolean; size?: [number, number]; failDem?: number } = {}) {
  const size = opts.size ?? [256, 256];
  let demFails = opts.failDem ?? 0;
  const fetched: string[] = [];
  const bitmaps = { open: 0 };
  const waiting = new Map<number, (p: Posted) => void>();
  const scope = {
    onmessage: null as ((ev: { data: ToTileWorker }) => void) | null,
    postMessage(msg: FromTileWorker, o?: { transfer?: ArrayBuffer[] }) {
      waiting.get(msg.id)?.({ msg, transfer: o?.transfer ?? [] });
    },
  };
  vi.resetModules();
  vi.stubGlobal('self', scope);
  vi.stubGlobal('fetch', async (url: string) => {
    fetched.push(url);
    if (url.includes('missing')) return { ok: false, status: 404 };
    if (url.endsWith('.bin')) {
      if (demFails-- > 0) throw new TypeError('network down');
      return { ok: true, status: 200, arrayBuffer: async () => DEM.buffer.slice(0) };
    }
    return { ok: true, status: 200, blob: async () => ({ jpeg: true }) };
  });
  vi.stubGlobal('createImageBitmap', async () => {
    bitmaps.open++;
    return { width: size[0], height: size[1], rgba: picture(size[0], size[1]), close: () => bitmaps.open-- };
  });
  if (opts.canvas ?? true) {
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        drawn: Uint8ClampedArray | null = null;
        constructor(public width: number, public height: number) {}
        getContext() {
          const canvas = this;
          return {
            canvas,
            globalCompositeOperation: 'source-over',
            drawImage(bmp: { rgba: Uint8ClampedArray }) {
              canvas.drawn = bmp.rgba;
            },
            getImageData: () => ({ data: new Uint8ClampedArray(canvas.drawn!) }),
          };
        }
      },
    );
  } else vi.stubGlobal('OffscreenCanvas', undefined);
  await import('../src/worker/tiles.worker');
  let nextId = 1;
  const send = (job: TileJob) =>
    new Promise<Posted>((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      scope.onmessage!({ data: { id, job } });
    });
  return { send, fetched, bitmaps };
}

const Z = 15, X = 7540, Y = 13920;
function terrainJob(over: Partial<TerrainTileJob> = {}): TerrainTileJob {
  return {
    kind: 'terrain',
    shape: {
      z: Z,
      x: X,
      y: Y,
      center: toWorld(tileYToLat(Y + 0.5, Z), tileXToLon(X + 0.5, Z), 0),
      drop: 20,
      skirts: true,
      uvOff: [0, 0],
      uvScale: 1,
      waterWeight: 1,
    },
    dem: { url: `http://tiles/dem/13/${X >> 2}/${Y >> 2}.bin`, at: { z: 13, x: X >> 2, y: Y >> 2 }, grid: G },
    image: `http://tiles/img/${Z}/${X}/${Y}.jpg`,
    ...over,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('tile worker', () => {
  let worker: Awaited<ReturnType<typeof startWorker>>;
  beforeEach(async () => {
    worker = await startWorker();
  });

  it('builds a terrain tile: heights, geometry and the image compressed', async () => {
    const job = terrainJob();
    const { msg } = await worker.send(job);
    if (!msg.ok || msg.result.kind !== 'terrain') throw new Error('no tile');
    const r = msg.result;
    // (The DEM tile made ready first, as the worker does: with no neighbours known, here.)
    const heights = tileHeights(job.shape, cleanDem(DEM, [], G, demCellSize(job.dem!.at, G)), job.dem!.at, G, DEM_MARGIN);
    expect([...r.heights]).toEqual([...heights]);
    const geo = buildTerrainGeometry(job.shape, heights);
    for (const k of Object.keys(geo) as (keyof typeof geo)[]) expect([...r.geometry[k]], k).toEqual([...geo[k]]);
    expect(r.imageSkipped).toBe(false);
    expect(r.image!.levels.length).toBe(9);
    expect(r.image!.data.length).toBe(43704);
    expect(worker.fetched.sort()).toEqual([job.dem!.url, job.image!].sort());
    // (The decoded image is let go once its pixels are read.)
    expect(worker.bitmaps.open).toBe(0);
  });

  it('turns the image upside down: the first rows of the texture are the bottom of the picture', async () => {
    const { msg } = await worker.send(terrainJob());
    if (!msg.ok) throw new Error(msg.error);
    const img = msg.result.image!;
    const back = decodeBc1(img.data.subarray(0, img.levels[0].length), 256, 256);
    expect(back.opaque).toBe(true);
    const src = picture(256, 256);
    const flipped = new Uint8Array(src.length);
    for (let y = 0; y < 256; y++) flipped.set(src.subarray((255 - y) * 1024, (256 - y) * 1024), y * 1024);
    // (Blue at the picture's bottom: the texture's first row, where v = 0, as the uncompressed
    // path has it with the browser flipping the image as it decodes.)
    expect(back.rgba[2]).toBeGreaterThan(240);
    expect(back.rgba[0]).toBeLessThan(15);
    expect(psnr(flipped, back.rgba)).toBeGreaterThan(40);
    expect(psnr(new Uint8Array(src), back.rgba)).toBeLessThan(15);
  });

  it('hands its arrays over, each its own buffer', async () => {
    const { msg, transfer } = await worker.send(terrainJob());
    if (!msg.ok || msg.result.kind !== 'terrain') throw new Error('no tile');
    // 7 geometry arrays, the heights, the image.
    expect(transfer.length).toBe(9);
    expect(new Set(transfer).size).toBe(9);
    // (As postMessage would move them: allowed, and nothing left behind.)
    const moved = structuredClone(msg, { transfer });
    if (!moved.ok || moved.result.kind !== 'terrain') throw new Error('no tile');
    expect(msg.result.geometry.position.length).toBe(0);
    expect(msg.result.heights.length).toBe(0);
    expect(msg.result.image!.data.length).toBe(0);
    expect(moved.result.geometry.position.length).toBe((33 * 33 + 128) * 3);
    expect(moved.result.geometry.index).toBeInstanceOf(Uint16Array);
    expect(moved.result.heights.length).toBe(33 * 33);
    expect(moved.result.image!.data.length).toBe(43704);
  });

  it('leaves the image to the page when not asked for it, and has no heights to fetch at sea', async () => {
    const { msg } = await worker.send(terrainJob({ image: null, dem: null }));
    if (!msg.ok || msg.result.kind !== 'terrain') throw new Error('no tile');
    expect(msg.result.image).toBeNull();
    expect(msg.result.imageSkipped).toBe(false);
    expect(Math.max(...msg.result.heights)).toBe(0);
    expect(worker.fetched).toEqual([]);
  });

  it('fails the tile when its image is not there', async () => {
    const { msg } = await worker.send(terrainJob({ image: 'http://tiles/img/missing.jpg' }));
    expect(msg.ok).toBe(false);
    if (!msg.ok) expect(msg.error).toContain('404');
  });

  it('treats a DEM tile that is not there as sea level, as before', async () => {
    const job = terrainJob();
    const { msg } = await worker.send({ ...job, dem: { ...job.dem!, url: 'http://tiles/dem/missing.bin' } });
    if (!msg.ok || msg.result.kind !== 'terrain') throw new Error('no tile');
    expect(Math.max(...msg.result.heights.map(Math.abs))).toBe(0);
  });

  it('fetches a DEM tile once for the tiles that share it, but again after a failure', async () => {
    const a = await worker.send(terrainJob({ image: null }));
    const b = await worker.send(terrainJob({ image: null }));
    expect(a.msg.ok && b.msg.ok).toBe(true);
    expect(worker.fetched.length).toBe(1);

    const flaky = await startWorker({ failDem: 1 });
    const first = await flaky.send(terrainJob({ image: null }));
    expect(first.msg.ok).toBe(false);
    const second = await flaky.send(terrainJob({ image: null }));
    expect(second.msg.ok).toBe(true);
    expect(flaky.fetched.length).toBe(2);
  });

  it('builds a globe tile', async () => {
    const shape = { z: 3, x: 1, y: 3, center: toWorld(tileYToLat(3.5, 3), tileXToLon(1.5, 3), 0), grid: 33, height: -40 };
    const { msg, transfer } = await worker.send({ kind: 'globe', shape, image: 'http://tiles/globe/3/1/3.jpg' });
    if (!msg.ok || msg.result.kind !== 'globe') throw new Error('no tile');
    const geo = buildGlobeGeometry(shape);
    for (const k of Object.keys(geo) as (keyof typeof geo)[]) expect([...msg.result.geometry[k]], k).toEqual([...geo[k]]);
    expect(msg.result.image!.levels.length).toBe(9);
    expect(transfer.length).toBe(5);
  });

  it('says so when it cannot compress: no canvas in a worker, or an image of an odd size', async () => {
    const plain = await startWorker({ canvas: false });
    const a = await plain.send(terrainJob());
    if (!a.msg.ok) throw new Error(a.msg.error);
    expect(a.msg.result.image).toBeNull();
    expect(a.msg.result.imageSkipped).toBe(true);
    // (The page loads the image itself then: the worker didn't fetch it.)
    expect(plain.fetched.some((u) => u.endsWith('.jpg'))).toBe(false);

    const odd = await startWorker({ size: [300, 300] });
    const b = await odd.send(terrainJob());
    if (!b.msg.ok) throw new Error(b.msg.error);
    expect(b.msg.result.image).toBeNull();
    expect(b.msg.result.imageSkipped).toBe(true);
    expect(odd.bitmaps.open).toBe(0);
  });
});

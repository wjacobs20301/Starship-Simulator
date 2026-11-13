// Builds map tiles off the main thread: fetches a tile's image and compresses it for the GPU
// (BC1, with its mipmaps), fetches its heights, and works out its vertices, normals and
// triangles. The page gets the finished arrays and only has to wrap them in a mesh: before, all
// of this ran between frames, a dozen tiles at a time while the ground streamed in.

import { type Bc1Image, bc1Sizes, encodeBc1Mipmaps } from '../render/bc1';
import { DEM_MARGIN, buildGlobeGeometry, buildTerrainGeometry, cleanDem, demCellSize, flatHeights, tileHeights } from '../render/tileGeometry';
import type { FromTileWorker, TerrainTileJob, TileJob, TileResult, ToTileWorker } from './tileProtocol';

// --- Heights -------------------------------------------------------------------------------

/**
 * DEM tiles lately fetched (33 kB each) and made ready (cleanDem: each with its neighbours, so
 * most are fetched for several): the finest tiles all take their heights from the same few.
 * (Each worker has its own; the page sends tiles sharing a DEM tile to the same worker.)
 */
const rawCache = new Map<string, Promise<Int16Array | null>>();
const demCache = new Map<string, Promise<Int16Array | null>>();
const RAW_CACHE = 320;
const DEM_CACHE = 160;

/** Kept in a cache while it's being fetched and after, unless it failed: then it's tried again. */
function cached(cache: Map<string, Promise<Int16Array | null>>, max: number, key: string, make: () => Promise<Int16Array | null>): Promise<Int16Array | null> {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
    p.catch(() => {
      if (cache.get(key) === p) cache.delete(key);
    });
    if (cache.size > max) cache.delete(cache.keys().next().value!);
  }
  return p;
}

/** A DEM tile as it is on the server (null: none there). */
function rawDem(url: string, grid: number): Promise<Int16Array | null> {
  return cached(rawCache, RAW_CACHE, url, () =>
    fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b && b.byteLength === grid * grid * 2 ? new Int16Array(b) : null)),
  );
}

/** A DEM tile ready for the meshes (tileGeometry.ts, cleanDem), DEM_MARGIN cells of margin round it. */
function dem(d: NonNullable<TerrainTileJob['dem']>): Promise<Int16Array | null> {
  return cached(demCache, DEM_CACHE, d.url, async () => {
    const [centre, ...ring] = await Promise.all([rawDem(d.url, d.grid), ...(d.ring ?? []).map((u) => (u ? rawDem(u, d.grid) : null))]);
    return centre ? cleanDem(centre, ring, d.grid, demCellSize(d.at, d.grid)) : null;
  });
}

// --- Imagery -------------------------------------------------------------------------------

/** A canvas to read a decoded image's pixels from (false: this browser has none in a worker). */
let reader: OffscreenCanvasRenderingContext2D | false | null = null;

function pixelReader(): OffscreenCanvasRenderingContext2D | false {
  if (reader === null) {
    try {
      // (willReadFrequently: kept in memory, not on the GPU, where each read would be a round trip.)
      reader = (typeof createImageBitmap === 'function' && new OffscreenCanvas(256, 256).getContext('2d', { willReadFrequently: true })) || false;
    } catch {
      reader = false;
    }
  }
  return reader;
}

/**
 * A tile's image, compressed: fetched, decoded, turned upside down, and BC1 with mipmaps made of
 * it. null: can't be done here (no canvas, or a size BC1 can't take); the page loads it as before.
 *
 * Upside down, because a texture's first row is its bottom one: the uncompressed path has the
 * browser flip the image as it decodes it (tileTexture.ts), and a compressed texture can't be
 * flipped on upload either. Flipped here by hand, the same rows end up in the same place, and no
 * tile's texture coordinates change.
 */
async function compressedImage(url: string): Promise<Bc1Image | null> {
  const ctx = pixelReader();
  if (!ctx) return null;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  const blob = await res.blob();
  let bmp: ImageBitmap;
  try {
    // (The pixels as they are in the file, as the uncompressed path asks for them.)
    bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  } catch {
    // (A browser that won't take the options. The tiles are opaque sRGB JPEGs: the same pixels.)
    bmp = await createImageBitmap(blob);
  }
  const { width, height } = bmp;
  if (!bc1Sizes(width, height)) {
    bmp.close();
    return null;
  }
  if (ctx.canvas.width !== width || ctx.canvas.height !== height) {
    ctx.canvas.width = width;
    ctx.canvas.height = height;
  }
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const rgba = ctx.getImageData(0, 0, width, height).data;
  flipRows(rgba, width, height);
  return encodeBc1Mipmaps(rgba, width, height);
}

function flipRows(rgba: Uint8ClampedArray, width: number, height: number): void {
  const row = width * 4;
  const tmp = new Uint8ClampedArray(row);
  for (let y = 0; y < height >> 1; y++) {
    const a = y * row;
    const b = (height - 1 - y) * row;
    tmp.set(rgba.subarray(a, a + row));
    rgba.copyWithin(a, b, b + row);
    rgba.set(tmp, b);
  }
}

// --- Tiles ---------------------------------------------------------------------------------

async function build(job: TileJob): Promise<TileResult> {
  // (Image and heights fetched side by side.)
  const image = job.image ? compressedImage(job.image) : null;
  if (job.kind === 'globe') {
    const img = await image;
    return { kind: 'globe', geometry: buildGlobeGeometry(job.shape), image: img, imageSkipped: !!job.image && !img };
  }
  // (The image's failure is the tile's, but not unhandled while the heights are waited for.)
  image?.catch(() => {});
  const d = job.dem;
  const heights = d ? tileHeights(job.shape, await dem(d), d.at, d.grid, DEM_MARGIN) : flatHeights();
  const img = await image;
  return { kind: 'terrain', heights, geometry: buildTerrainGeometry(job.shape, heights), image: img, imageSkipped: !!job.image && !img };
}

/** The buffers of a built tile, to hand to the page without copying. */
function buffers(r: TileResult): ArrayBuffer[] {
  const out: ArrayBuffer[] = Object.values(r.geometry).map((a: Float32Array | Uint16Array) => a.buffer as ArrayBuffer);
  if (r.kind === 'terrain') out.push(r.heights.buffer as ArrayBuffer);
  if (r.image) out.push(r.image.data.buffer as ArrayBuffer);
  return out;
}

self.onmessage = (ev: MessageEvent<ToTileWorker>) => {
  const { id, job } = ev.data;
  // (Every job gets an answer, a failure to send the tile included: the page counts the tiles
  // it's waiting for, and one never answered would hold a place in that queue for good.)
  build(job)
    .then((result) => self.postMessage({ id, ok: true, result } satisfies FromTileWorker, { transfer: buffers(result) }))
    .catch((err) => self.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) } satisfies FromTileWorker));
};

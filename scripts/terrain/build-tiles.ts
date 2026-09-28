// Builds the streamed terrain from the downloaded sources:
//   public/terrain/img/{z}/{x}/{y}.jpg   imagery pyramid (z8..z18, 256 px Web Mercator tiles):
//                                        NAIP 0.6 m where it exists (US), Sentinel-2 10 m elsewhere
//   public/terrain/dem/{z}/{x}/{y}.bin   heights, Int16 centimetres, DEM_GRID^2 samples:
//                                        USGS 3DEP 3 m in the 40 km core, Copernicus 30 m around it
//   public/terrain/index.json            bounds, zoom ranges, tile availability bitsets
//   public/terrain/facilities.json       OSM buildings / tanks as footprints in pad-local metres
// Hero edits: the fenced launch site is flattened (the lidar predates the orbital pads) and
// the pads are painted as concrete (the 2022 photo shows Pad 1's tower lying across the
// ground due to relief displacement, and Pad 2 as bare sand).
//   npx tsx scripts/terrain/build-tiles.ts [--skip-imagery]
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fromFile } from 'geotiff';
import sharp from 'sharp';
import {
  BOUNDS, CENTER, CORE, MAX_ZOOM, MIN_ZOOM, OUT as LIVE, S2_ZOOM, SRC, tileRange, tileXToLon, tileYToLat,
} from './config';

/** Built into a staging folder and swapped in at the end, so the running game never sees a
 *  half-built tile set. */
const OUT = `${LIVE}.building`;
const ROOT_DIR = resolve(LIVE, '../..');

/** Height tiles: z8..z13 across the region (Copernicus 30 m); z14..z16 only in the lidar core. */
export const DEM_REGION_MAX_ZOOM = 13;
export const DEM_TILE_MAX_ZOOM = 16;
export const DEM_GRID = 129;
/** Heights below this (NAVD88 m) are water: the Gulf is flattened to ~0 m, bays to ~-0.6 m. */
export const WATER_LEVEL = 0.25;

const skipImagery = process.argv.includes('--skip-imagery');
/** Re-bake water into the live coarse imagery only (quick; no full rebuild). */
const waterOnly = process.argv.find((a) => a.startsWith('--water-only'));
const M_PER_DEG_LAT = 110_800;
const M_PER_DEG_LON = 111_320 * Math.cos((CENTER.lat * Math.PI) / 180);
/** Local east/north metres from the Pad 1 mount (flat approximation; for footprints and edits). */
const toEN = (lat: number, lon: number) => [(lon - CENTER.lon) * M_PER_DEG_LON, (lat - CENTER.lat) * M_PER_DEG_LAT];

// --- Elevation ------------------------------------------------------------------

interface Chunk { i: number; j: number; west: number; east: number; south: number; north: number; w: number; h: number; data: Float32Array }

async function loadDem(): Promise<Chunk[]> {
  const dir = resolve(SRC, 'dem');
  const chunks: Chunk[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.tif'))) {
    const tiff = await fromFile(resolve(dir, f));
    const img = await tiff.getImage();
    const [west, south, east, north] = img.getBoundingBox();
    const [data] = (await img.readRasters()) as unknown as [Float32Array];
    const [, i, j] = /chunk_(\d+)_(\d+)/.exec(f)!.map(Number);
    chunks.push({ i, j, west, east, south, north, w: img.getWidth(), h: img.getHeight(), data });
  }
  console.log(`DEM: ${chunks.length} chunks loaded`);
  return chunks;
}

function makeSampler(chunks: Chunk[]) {
  const n = Math.round(Math.sqrt(chunks.length));
  const grid: Chunk[][] = Array.from({ length: n }, () => new Array(n));
  for (const c of chunks) grid[c.i][c.j] = c;
  const lonSpan = CORE.east - CORE.west;
  const latSpan = CORE.north - CORE.south;
  return (lat: number, lon: number): number => {
    // Chunks tile the core in an n x n grid (row i = south to north) with a small overlap.
    const j = Math.floor(((lon - CORE.west) / lonSpan) * n);
    const i = Math.floor(((lat - CORE.south) / latSpan) * n);
    if (i < 0 || j < 0 || i >= n || j >= n) return 0;
    const best = grid[i][j];
    const fx = ((lon - best.west) / (best.east - best.west)) * best.w - 0.5;
    const fy = ((best.north - lat) / (best.north - best.south)) * best.h - 0.5;
    const x0 = Math.max(0, Math.min(best.w - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(best.h - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const g = (x: number, y: number) => {
      const v = best!.data[y * best!.w + x];
      return v < -1000 || !Number.isFinite(v) ? 0 : v;
    };
    return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
  };
}

/** Copernicus GLO-30 1-degree tiles (EGM2008 heights; open sea has no tile = 0 m). */
async function loadCopernicus(): Promise<(lat: number, lon: number) => number> {
  const dir = resolve(SRC, 'copdem');
  const tiles = new Map<string, { west: number; north: number; w: number; h: number; data: Float32Array }>();
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.tif'))) {
    const img = await (await fromFile(resolve(dir, f))).getImage();
    const [west, , , north] = img.getBoundingBox();
    const [data] = (await img.readRasters()) as unknown as [Float32Array];
    tiles.set(`${Math.round(north - 1)},${Math.round(west)}`, { west, north, w: img.getWidth(), h: img.getHeight(), data });
  }
  console.log(`Copernicus DEM: ${tiles.size} tiles loaded`);
  return (lat, lon) => {
    const t = tiles.get(`${Math.floor(lat)},${Math.floor(lon)}`);
    if (!t) return 0;
    const fx = (lon - t.west) * t.w - 0.5;
    const fy = (t.north - lat) * t.h - 0.5;
    const x0 = Math.max(0, Math.min(t.w - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(t.h - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    const g = (x: number, y: number) => {
      const v = t.data[y * t.w + x];
      return v < -1000 || !Number.isFinite(v) ? 0 : v;
    };
    return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
  };
}

/** Lidar inside the core, Copernicus outside, blended over the core's outer 1 km. */
function combine(lidar: (lat: number, lon: number) => number, cop: (lat: number, lon: number) => number) {
  const blendM = 1000;
  return (lat: number, lon: number) => {
    const inside = Math.min(lat - CORE.south, CORE.north - lat) * M_PER_DEG_LAT;
    const insideLon = Math.min(lon - CORE.west, CORE.east - lon) * M_PER_DEG_LON;
    const d = Math.min(inside, insideLon);
    if (d <= 0) return cop(lat, lon);
    if (d >= blendM) return lidar(lat, lon);
    const w = d / blendM;
    return lidar(lat, lon) * w + cop(lat, lon) * (1 - w);
  };
}

// --- Hero edits ------------------------------------------------------------------

/** Fenced launch site (OSM "Launchsite fence"), in local east/north metres from the Pad 1 mount. */
const SITE = { e0: -400, e1: 135, n0: -170, n1: 300, blend: 40 };
/** Pad centers (launch mounts) in local metres; painted as concrete in the imagery. */
export const PADS_EN = {
  pad1: toEN(25.99613, -97.15442),
  pad2: toEN(25.99673, -97.15809),
};
/** Areas painted as concrete: pad aprons plus the leaning Pad 1 tower seen in the 2022 photo. */
const CONCRETE: { kind: 'circle' | 'rect'; c?: number[]; r?: number; e0?: number; e1?: number; n0?: number; n1?: number }[] = [
  { kind: 'circle', c: PADS_EN.pad1, r: 75 },
  { kind: 'circle', c: PADS_EN.pad2, r: 75 },
  { kind: 'rect', ...rectFromLatLon(25.9958, 25.99635, -97.15485, -97.15315) },
];

function rectFromLatLon(s: number, n: number, w: number, e: number) {
  const [e0, n0] = toEN(s, w);
  const [e1, n1] = toEN(n, e);
  return { e0, e1, n0, n1 };
}

function touchesConcrete(e0: number, e1: number, n0: number, n1: number): boolean {
  return CONCRETE.some((c) =>
    c.kind === 'rect'
      ? !(c.e1! + 4 < e0 || c.e0! - 4 > e1 || c.n1! + 4 < n0 || c.n0! - 4 > n1)
      : Math.hypot(Math.max(e0 - c.c![0], 0, c.c![0] - e1), Math.max(n0 - c.c![1], 0, c.c![1] - n1)) < c.r! + 4,
  );
}

const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

function siteWeight(e: number, n: number): number {
  const d = Math.max(SITE.e0 - e, e - SITE.e1, SITE.n0 - n, n - SITE.n1);
  return 1 - smooth(d / SITE.blend);
}

function concreteWeight(e: number, n: number): number {
  let w = 0;
  for (const c of CONCRETE) {
    let d: number;
    if (c.kind === 'circle') d = Math.hypot(e - c.c![0], n - c.c![1]) - c.r!;
    else d = Math.max(c.e0! - e, e - c.e1!, c.n0! - n, n - c.n1!);
    w = Math.max(w, 1 - smooth((d + 2) / 4));
  }
  return w;
}

// --- Tiles -----------------------------------------------------------------------

type Bitset = Uint8Array;
const newBits = (z: number) => {
  const r = tileRange(z);
  return new Uint8Array(Math.ceil(((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)) / 8));
};
const bitIndex = (z: number, x: number, y: number) => {
  const r = tileRange(z);
  return (y - r.y0) * (r.x1 - r.x0 + 1) + (x - r.x0);
};
const setBit = (b: Bitset, i: number) => (b[i >> 3] |= 1 << (i & 7));
const getBit = (b: Bitset, i: number) => (b[i >> 3] >> (i & 7)) & 1;

function write(file: string, data: Buffer | Uint8Array) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
}

async function buildDem(sample: (lat: number, lon: number) => number, siteHeight: number) {
  const bits: Record<number, Bitset> = {};
  const height = (lat: number, lon: number) => {
    const h = sample(lat, lon);
    const [e, n] = toEN(lat, lon);
    const w = siteWeight(e, n);
    return w > 0 ? h * (1 - w) + siteHeight * w : h;
  };
  for (let z = MIN_ZOOM; z <= DEM_TILE_MAX_ZOOM; z++) {
    bits[z] = newBits(z);
    const r = tileRange(z);
    const rc = tileRange(z, CORE);
    let written = 0;
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        if (z > DEM_REGION_MAX_ZOOM && (x < rc.x0 || x > rc.x1 || y < rc.y0 || y > rc.y1)) continue;
        const out = new Int16Array(DEM_GRID * DEM_GRID);
        let land = false;
        for (let j = 0; j < DEM_GRID; j++) {
          const lat = tileYToLat(y + j / (DEM_GRID - 1), z);
          for (let i = 0; i < DEM_GRID; i++) {
            const lon = tileXToLon(x + i / (DEM_GRID - 1), z);
            const h = height(lat, lon);
            if (Math.abs(h) > 0.02) land = true;
            out[j * DEM_GRID + i] = Math.max(-32768, Math.min(32767, Math.round(h * 100)));
          }
        }
        if (!land) continue; // pure open sea: the runtime treats a missing tile as flat 0 m
        write(resolve(OUT, `dem/${z}/${x}/${y}.bin`), new Uint8Array(out.buffer));
        setBit(bits[z], bitIndex(z, x, y));
        written++;
      }
    }
    console.log(`DEM z${z}: ${written} tiles`);
  }
  return bits;
}

const WATER_RGB = [70, 105, 110]; // matches the renderer's water color
const CONCRETE_RGB = [176, 174, 168];

async function buildImagery() {
  const bits: Record<number, Bitset> = {};
  const src = resolve(SRC, 'naip', String(MAX_ZOOM));
  // z18: copy source tiles, painting concrete where needed.
  {
    const z = MAX_ZOOM;
    bits[z] = newBits(z);
    const r = tileRange(z);
    let n = 0;
    let painted = 0;
    for (let x = r.x0; x <= r.x1; x++) {
      const col = resolve(src, String(x));
      if (!existsSync(col)) continue;
      for (const f of readdirSync(col)) {
        const y = Number(f.split('.')[0]);
        if (y < r.y0 || y > r.y1) continue;
        const out = resolve(OUT, `img/${z}/${x}/${y}.jpg`);
        // Does this tile touch a concrete area?
        const [e0, n0] = toEN(tileYToLat(y + 1, z), tileXToLon(x, z));
        const [e1, n1] = toEN(tileYToLat(y, z), tileXToLon(x + 1, z));
        if (touchesConcrete(e0, e1, n0, n1)) {
          const buf = readFileSync(resolve(col, f));
          const { data, info } = await sharp(buf).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          for (let py = 0; py < info.height; py++) {
            const lat = tileYToLat(y + (py + 0.5) / info.height, z);
            for (let px = 0; px < info.width; px++) {
              const lon = tileXToLon(x + (px + 0.5) / info.width, z);
              const [e, nn] = toEN(lat, lon);
              const w = concreteWeight(e, nn);
              if (w <= 0) continue;
              const k = (py * info.width + px) * 3;
              const grain = 0.94 + 0.06 * Math.sin(e * 3.1) * Math.sin(nn * 2.7) + 0.03 * ((((e * 13) | 0) ^ ((nn * 17) | 0)) & 1);
              for (let ch = 0; ch < 3; ch++) data[k + ch] = Math.round(data[k + ch] * (1 - w) + CONCRETE_RGB[ch] * grain * w);
            }
          }
          write(out, await sharp(data, { raw: info }).jpeg({ quality: 88 }).toBuffer());
          painted++;
        } else {
          // Hard link: half a million tiles would otherwise be stored twice.
          mkdirSync(dirname(out), { recursive: true });
          if (existsSync(out)) rmSync(out);
          linkSync(resolve(col, f), out);
        }
        setBit(bits[z], bitIndex(z, x, y));
        n++;
      }
    }
    console.log(`imagery z${z}: ${n} tiles (${painted} painted)`);
  }
  // Lower zooms: 2x2 children -> 512 -> 256. Quadrants without NAIP are filled from the
  // Sentinel-2 mosaic (cropped and upscaled from its z14 tile), or water where it has none.
  const water = await sharp({ create: { width: 256, height: 256, channels: 3, background: { r: WATER_RGB[0], g: WATER_RGB[1], b: WATER_RGB[2] } } }).png().toBuffer();
  const s2Dir = resolve(SRC, 's2', String(S2_ZOOM));
  const s2Cache = new Map<string, Promise<Buffer | null>>();
  /** 256 px image for tile (z, x, y) from Sentinel-2, for z >= S2_ZOOM. */
  const s2Tile = (z: number, x: number, y: number): Promise<Buffer | null> => {
    const k = `${z}/${x}/${y}`;
    let p = s2Cache.get(k);
    if (!p) {
      const d = z - S2_ZOOM;
      const ax = x >> d, ay = y >> d;
      const file = resolve(s2Dir, `${ax}/${ay}.jpg`);
      // Tiny files are uniform no-data tiles at the edges of satellite passes.
      if (!existsSync(file) || statSync(file).size < 2000) p = Promise.resolve(null);
      else if (d === 0) p = Promise.resolve(readFileSync(file));
      else {
        const size = 256 >> d;
        p = sharp(file)
          .extract({ left: (x - (ax << d)) * size, top: (y - (ay << d)) * size, width: size, height: size })
          .resize(256, 256, { kernel: 'cubic' })
          .jpeg({ quality: 90 })
          .toBuffer();
      }
      s2Cache.set(k, p);
      if (s2Cache.size > 4000) s2Cache.delete(s2Cache.keys().next().value!);
    }
    return p;
  };
  const s2Exists = (x: number, y: number) => {
    const f = resolve(s2Dir, `${x}/${y}.jpg`);
    return existsSync(f) && statSync(f).size >= 2000;
  };
  for (let z = MAX_ZOOM - 1; z >= MIN_ZOOM; z--) {
    bits[z] = newBits(z);
    // Only visit tiles with something below them (or Sentinel-2 coverage at its own zoom).
    const candidates = new Set<string>();
    const rk = tileRange(z + 1);
    const kidBits = bits[z + 1];
    for (let y = rk.y0; y <= rk.y1; y++) {
      for (let x = rk.x0; x <= rk.x1; x++) {
        const i = (y - rk.y0) * (rk.x1 - rk.x0 + 1) + (x - rk.x0);
        if ((kidBits[i >> 3] >> (i & 7)) & 1) candidates.add(`${x >> 1}/${y >> 1}`);
      }
    }
    if (z === S2_ZOOM) {
      const r = tileRange(z);
      for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) if (s2Exists(x, y)) candidates.add(`${x}/${y}`);
    }
    const r = tileRange(z);
    let n = 0;
    const tileJob = async (x: number, y: number) => {
      const kids: { input: Buffer | string; left: number; top: number }[] = [];
      let any = false;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const cx = 2 * x + dx, cy = 2 * y + dy;
          const has = cx >= rk.x0 && cx <= rk.x1 && cy >= rk.y0 && cy <= rk.y1 &&
            ((kidBits[((cy - rk.y0) * (rk.x1 - rk.x0 + 1) + (cx - rk.x0)) >> 3] >> (((cy - rk.y0) * (rk.x1 - rk.x0 + 1) + (cx - rk.x0)) & 7)) & 1) === 1;
          any ||= has;
          let fill: Buffer = water;
          if (!has && z + 1 >= S2_ZOOM) fill = (await s2Tile(z + 1, cx, cy)) ?? water;
          kids.push({ input: has ? resolve(OUT, `img/${z + 1}/${cx}/${cy}.jpg`) : fill, left: dx * 256, top: dy * 256 });
        }
      }
      const out = resolve(OUT, `img/${z}/${x}/${y}.jpg`);
      if (!any) {
        // Only reached at the Sentinel-2 zoom: no NAIP below, use the Sentinel-2 tile itself.
        const s2 = await s2Tile(z, x, y);
        if (!s2) return;
        write(out, s2);
      } else {
        const { data, info } = await sharp({ create: { width: 512, height: 512, channels: 3, background: { r: 0, g: 0, b: 0 } } })
          .composite(kids)
          .raw()
          .toBuffer({ resolveWithObject: true });
        write(out, await sharp(data, { raw: info }).resize(256, 256, { kernel: 'lanczos3' }).jpeg({ quality: 86 }).toBuffer());
      }
      setBit(bits[z], bitIndex(z, x, y));
      n++;
    };
    const list = [...candidates].map((k) => k.split('/').map(Number)).filter(([x, y]) => x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1);
    let next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < list.length) {
        const [x, y] = list[next++];
        await tileJob(x, y);
      }
    }));
    console.log(`imagery z${z}: ${n} tiles`);
  }
  return bits;
}

/**
 * Coarse imagery (z <= S2_ZOOM) gets its water baked in: pixels whose full-resolution height
 * is at sea level are blended toward the same sea colour the renderer uses (Blue Marble + a
 * teal tint). At those zooms the mesh is too coarse to find the shoreline at runtime, and raw
 * aerial photos of water are full of sun glint.
 */
async function bakeWater(bits: Record<number, Bitset>, sample: (lat: number, lon: number) => number, dir = OUT, strength = 0.98) {
  const globeFile = resolve(ROOT_DIR, 'public/globe/earth.jpg');
  const { data: gData, info: gInfo } = await sharp(globeFile).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const globeAt = (lat: number, lon: number, out: number[]) => {
    // Bilinear, like the GPU: nearest-pixel sampling turns each ~7 km globe pixel into a square.
    const fx = ((lon + 180) / 360) * gInfo.width - 0.5;
    const fy = ((90 - lat) / 180) * gInfo.height - 0.5;
    const x0 = Math.max(0, Math.min(gInfo.width - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(gInfo.height - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let c = 0; c < 3; c++) {
      const p = (x: number, y: number) => gData[(y * gInfo.width + x) * 3 + c];
      const g = (p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx) * (1 - ty) + (p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx) * ty;
      // Same blend as the shader: mix(teal, globe, 0.75) in sRGB.
      out[c] = WATER_RGB[c] * 0.25 + g * 0.75;
    }
  };
  const sea = [0, 0, 0];
  for (let z = MIN_ZOOM; z <= S2_ZOOM; z++) {
    const r = tileRange(z);
    let n = 0;
    const jobs: Promise<void>[] = [];
    for (let x = r.x0; x <= r.x1; x++) {
      for (let y = r.y0; y <= r.y1; y++) {
        if (!getBit(bits[z], bitIndex(z, x, y))) continue;
        const file = resolve(dir, `img/${z}/${x}/${y}.jpg`);
        jobs.push(
          (async () => {
            const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
            for (let py = 0; py < info.height; py++) {
              const lat = tileYToLat(y + (py + 0.5) / info.height, z);
              for (let px = 0; px < info.width; px++) {
                const lon = tileXToLon(x + (px + 0.5) / info.width, z);
                const h = sample(lat, lon);
                const w = strength * (1 - smooth((h - (WATER_LEVEL - 0.12)) / 0.17));
                if (w <= 0) continue;
                globeAt(lat, lon, sea);
                const k = (py * info.width + px) * 3;
                for (let c = 0; c < 3; c++) data[k + c] = Math.round(data[k + c] * (1 - w) + sea[c] * w);
              }
            }
            rmSync(file); // may be a hard link to a source tile: never write through it
            write(file, await sharp(data, { raw: info }).jpeg({ quality: 86 }).toBuffer());
          })(),
        );
        n++;
        if (jobs.length >= 16) await Promise.all(jobs.splice(0));
      }
    }
    await Promise.all(jobs);
    console.log(`water baked into imagery z${z}: ${n} tiles`);
  }
}

// --- Facilities (OpenStreetMap) --------------------------------------------------

interface Facility {
  kind: 'building' | 'vtank' | 'htank';
  name?: string;
  /** Footprint ring, local east/north metres (buildings). */
  ring?: number[][];
  center: number[];
  base: number; // ground height, m (NAVD88)
  height: number;
  diameter?: number;
  length?: number;
  angle?: number; // htank axis, radians from east
  material: 'industrial' | 'bay' | 'house' | 'tank' | 'rocket';
}

function parseHeight(t: Record<string, string>): number | null {
  if (t.height) {
    const v = parseFloat(t.height);
    if (Number.isFinite(v)) return v;
  }
  if (t['building:levels']) return parseFloat(t['building:levels']) * 3.5;
  return null;
}

function buildFacilities(sample: (lat: number, lon: number) => number, siteHeight: number): Facility[] {
  const osm = JSON.parse(readFileSync(resolve(SRC, 'osm.json'), 'utf8')) as {
    elements: { type: string; id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[]; members?: { role: string; geometry?: { lat: number; lon: number }[] }[] }[];
  };
  const out: Facility[] = [];
  const ground = (lat: number, lon: number) => {
    const [e, n] = toEN(lat, lon);
    const w = siteWeight(e, n);
    const h = sample(lat, lon);
    return Math.max(WATER_LEVEL, w > 0 ? h * (1 - w) + siteHeight * w : h);
  };
  for (const el of osm.elements) {
    const t = el.tags ?? {};
    // Modeled separately in 3D (towers, chopsticks, launch mounts) or not solid structures.
    if (t['tower:type'] === 'launch_tower' || t.man_made === 'gantry' || t.name === 'Flame Trench' || t.ref === 'OLM 2') continue;
    if (t.man_made === 'pipeline' || t.building === 'construction' && !t.height) continue;
    let pts = el.geometry;
    if (!pts && el.members) pts = el.members.find((m) => m.role === 'outer' && m.geometry)?.geometry;
    if (!pts || pts.length < 3) continue;
    const ring = pts.map((p) => toEN(p.lat, p.lon));
    const cLat = pts.reduce((a, p) => a + p.lat, 0) / pts.length;
    const cLon = pts.reduce((a, p) => a + p.lon, 0) / pts.length;
    const center = toEN(cLat, cLon);
    const base = ground(cLat, cLon);
    // Oriented extent via principal axis.
    let sxx = 0, syy = 0, sxy = 0;
    for (const [e, n] of ring) {
      const de = e - center[0], dn = n - center[1];
      sxx += de * de; syy += dn * dn; sxy += de * dn;
    }
    const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const ax = [Math.cos(angle), Math.sin(angle)];
    let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [e, n] of ring) {
      const de = e - center[0], dn = n - center[1];
      const a = de * ax[0] + dn * ax[1];
      const b = -de * ax[1] + dn * ax[0];
      a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b);
    }
    const len = a1 - a0;
    const wid = b1 - b0;
    const tagged = parseHeight(t);
    if (t.man_made === 'storage_tank' || t.man_made === 'silo') {
      if (len > 1.8 * wid) {
        out.push({ kind: 'htank', center, base, height: wid, diameter: wid, length: len, angle, material: 'tank', name: t.name });
      } else {
        const d = (len + wid) / 2;
        out.push({ kind: 'vtank', center, base, height: tagged ?? Math.min(32, Math.max(3, 2.4 * d)), diameter: d, material: 'tank', name: t.name });
      }
      continue;
    }
    if (!t.building && t.man_made !== 'tower' && t.man_made !== 'mast') continue;
    const name = t.name ?? '';
    let material: Facility['material'] = 'industrial';
    if (/bay|gigabay|starfactory/i.test(name)) material = 'bay';
    else if (t.building === 'house' || t.building === 'residential' || t.building === 'apartments') material = 'house';
    else if (t.building === 'rocket' || /^(S|B)\d+$/.test(name)) material = 'rocket';
    const height = tagged ?? (t.building === 'industrial' || t.building === 'warehouse' ? 10 : t.building === 'container' ? 2.6 : 6);
    out.push({ kind: 'building', ring, center, base, height, material, name: t.name });
  }
  console.log(`facilities: ${out.length} (${out.filter((f) => f.kind !== 'building').length} tanks)`);
  return out;
}

// --- Main ------------------------------------------------------------------------

function siteHeightFrom(sample: (lat: number, lon: number) => number): number {
  const hs: number[] = [];
  for (let e = SITE.e0; e <= SITE.e1; e += 10) {
    for (let n = SITE.n0; n <= SITE.n1; n += 10) {
      hs.push(sample(CENTER.lat + n / M_PER_DEG_LAT, CENTER.lon + e / M_PER_DEG_LON));
    }
  }
  hs.sort((a, b) => a - b);
  // The launch site is built up on fill above the surrounding flats.
  return Math.max(1.5, hs[Math.floor(hs.length * 0.6)]);
}

async function main() {
  if (waterOnly) {
    const prev = JSON.parse(readFileSync(resolve(LIVE, 'index.json'), 'utf8'));
    const bits: Record<number, Bitset> = {};
    for (const [z, b] of Object.entries(prev.img as Record<string, string>)) bits[Number(z)] = Buffer.from(b, 'base64');
    const sample = combine(makeSampler(await loadDem()), await loadCopernicus());
    await bakeWater(bits, sample, LIVE, Number(waterOnly.split('=')[1] ?? 0.98));
    return;
  }
  rmSync(OUT, { recursive: true, force: true });
  const chunks = await loadDem();
  const sample = combine(makeSampler(chunks), await loadCopernicus());
  const siteHeight = siteHeightFrom(sample);
  console.log(`launch site ground: ${siteHeight.toFixed(2)} m (NAVD88)`);
  const demBits = await buildDem(sample, siteHeight);
  const facilities = buildFacilities(sample, siteHeight);
  write(resolve(OUT, 'facilities.json'), Buffer.from(JSON.stringify({ facilities })));
  let imgBits: Record<number, Bitset> = {};
  if (!skipImagery) {
    imgBits = await buildImagery();
    await bakeWater(imgBits, sample);
  }
  else if (existsSync(resolve(LIVE, 'index.json'))) {
    // Reuse the live imagery: move it into the staging folder.
    const prev = JSON.parse(readFileSync(resolve(LIVE, 'index.json'), 'utf8'));
    for (const [z, b] of Object.entries(prev.img as Record<string, string>)) imgBits[Number(z)] = Buffer.from(b, 'base64');
    if (existsSync(resolve(LIVE, 'img'))) renameSync(resolve(LIVE, 'img'), resolve(OUT, 'img'));
  }
  const b64 = (bits: Record<number, Bitset>) => Object.fromEntries(Object.entries(bits).map(([z, b]) => [z, Buffer.from(b).toString('base64')]));
  const ranges = Object.fromEntries(Array.from({ length: MAX_ZOOM - MIN_ZOOM + 1 }, (_, i) => [MIN_ZOOM + i, tileRange(MIN_ZOOM + i)]));
  write(
    resolve(OUT, 'index.json'),
    Buffer.from(JSON.stringify({
      bounds: BOUNDS,
      minZoom: MIN_ZOOM,
      maxZoom: MAX_ZOOM,
      demMaxZoom: DEM_TILE_MAX_ZOOM,
      demGrid: DEM_GRID,
      waterLevel: WATER_LEVEL,
      siteHeight,
      ranges,
      img: b64(imgBits),
      dem: b64(demBits),
      sources: {
        imagery: 'USDA NAIP 2022 (public domain), via Microsoft Planetary Computer',
        elevation: 'USGS 3DEP (public domain); Copernicus GLO-30 DEM (© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA)',
        s2: 'Contains modified Copernicus Sentinel data 2025-2026',
        facilities: '© OpenStreetMap contributors (ODbL)',
      },
    })),
  );
  // Swap the finished build in.
  const old = `${LIVE}.old`;
  rmSync(old, { recursive: true, force: true });
  if (existsSync(LIVE)) renameSync(LIVE, old);
  renameSync(OUT, LIVE);
  rmSync(old, { recursive: true, force: true });
  console.log('wrote index.json; terrain swapped in');
}

main();

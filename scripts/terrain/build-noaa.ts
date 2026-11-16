// Lays NOAA's January 2026 survey (fetch-noaa.ts: 0.3 m a pixel) over the terrain's imagery at
// Starbase: the launch site, the production site and village, and the road between them.
//   public/terrain/noaa2026/index.json            which tiles there are (as the terrain's own
//                                                 index.json has it), and the folder they're in
//   public/terrain/noaa2026/{dir}/{z}/{x}/{y}.jpg the tiles: z19 (the survey's own sharpness, one
//                                                 level finer than the terrain's) down to z8
// An overlay, not a rebuild: the terrain's own tiles are left as they are, and the game shows
// one of these wherever there is one (src/render/terrain.ts). So a build of the game from before
// this still finds everything it asks for, and the survey can be taken out again by deleting a
// folder. Each tile is the survey where it has ground, colour-matched to the terrain's own imagery
// (NAIP 2022) and blended into it at its edges: its broad colour over the outer 450 m, its detail
// over the outer 100 m; at z14 and coarser the water stays as the terrain build baked it.
// And, from the same survey, two pictures for the models that stand on it, in git with the game
// (they aren't map tiles): the launch site's own ground, for its slab (src/render/launchSite.ts:
// public/media/launch-site-2026.jpg), and the Starfactory's roofs (src/render/facilities.ts:
// public/media/starfactory-roof-2026.jpg).
// Run after `npm run terrain:build` (it reads the built tiles):
//   npx tsx scripts/terrain/build-noaa.ts [--preview=file.jpg] [--site-only]
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fromFile } from 'geotiff';
import sharp from 'sharp';
import { CENTER, MAX_ZOOM, MIN_ZOOM, OUT as LIVE, latToTileY, lonToTileX, tileXToLon, tileYToLat } from './config';
import { NOAA_DIR, noaaCells } from './noaa-cells';
import { HIGHWAY_4_EAST, HIGHWAY_4_WEST, ROUNDABOUT, SIDE_ROADS } from '../../src/render/roadLines';
import { SITE_OUTLINE, distanceToLine } from '../../src/render/siteOutline';

/** The survey's own zoom: 0.27 m a pixel here (it has 0.27 x 0.30 m). */
const NOAA_ZOOM = 19;
/**
 * The tiles' folder. The server lets browsers keep a tile for 30 days: a rebuild that changes
 * the picture goes in a new folder (bump this), so nobody sees old tiles among new ones.
 */
const VERSION = 't1';
const DIR = resolve(LIVE, 'noaa2026');
const T = 256;
/** The survey fades into the older imagery over this much at its edges (m), starting this far in. */
const FEATHER_M = 100;
const FEATHER_INSET_M = 6;
/**
 * And its broad colour (what's left of it blurred over ~100 m) over this much: the tidal flats
 * are wet or dry, dark or pale, as the day finds them, and four years apart the two surveys found
 * them differently. Faded over 100 m alone, the survey's edge was a line across every flat.
 */
const TONE_M = 450;
const TONE_CELL_M = 8;
const WATER_RGB = [70, 105, 110];
const WATER_LEVEL = 0.25;
const DEM_ZOOM = 16;
const DEM_GRID = 129;

const M_PER_DEG_LAT = 110_800;
const M_PER_DEG_LON = 111_320 * Math.cos((CENTER.lat * Math.PI) / 180);
const smooth = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

// --- The survey ------------------------------------------------------------------

/** A cell's pixels (RGBA), pixel (i, j)'s centre at west + i dx, north - j dy. */
interface Cell { west: number; north: number; dx: number; dy: number; w: number; h: number; data: Uint8Array }
/** By nominal corner: floor(lon * 80), ceil(lat * 80) (the cells are 1/80 of a degree). */
const cells = new Map<string, Cell>();
const BOX = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };

async function loadCells() {
  for (const c of noaaCells()) {
    const file = resolve(NOAA_DIR, c.name);
    if (!existsSync(file)) throw new Error(`missing ${c.name}: run scripts/terrain/fetch-noaa.ts`);
    const img = await (await fromFile(file)).getImage(0);
    const [west, , , north] = img.getBoundingBox();
    const [dx, dy] = img.getResolution();
    const data = (await img.readRasters({ interleave: true })) as unknown as Uint8Array;
    if (img.getSamplesPerPixel() !== 4) throw new Error(`${c.name}: expected RGBA`);
    cells.set(`${Math.round(c.west * 80)},${Math.round(c.north * 80)}`, { west, north, dx, dy: Math.abs(dy), w: img.getWidth(), h: img.getHeight(), data });
    BOX.west = Math.min(BOX.west, c.west);
    BOX.east = Math.max(BOX.east, c.east);
    BOX.south = Math.min(BOX.south, c.south);
    BOX.north = Math.max(BOX.north, c.north);
  }
  console.log(`survey: ${cells.size} cells, ${((BOX.east - BOX.west) * M_PER_DEG_LON / 1000).toFixed(1)} x ${((BOX.north - BOX.south) * M_PER_DEG_LAT / 1000).toFixed(1)} km`);
}

/** The survey at a point (bilinear): r, g, b, a into out; false where it has no cell. */
function survey(lat: number, lon: number, out: number[]): boolean {
  const c = cells.get(`${Math.floor(lon * 80)},${Math.ceil(lat * 80)}`);
  if (!c) return false;
  const fx = (lon - c.west) / c.dx;
  const fy = (c.north - lat) / c.dy;
  const x0 = Math.max(0, Math.min(c.w - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(c.h - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x0));
  const ty = Math.max(0, Math.min(1, fy - y0));
  const k = (y0 * c.w + x0) * 4;
  const d = c.data;
  const row = c.w * 4;
  for (let ch = 0; ch < 4; ch++) {
    out[ch] = (d[k + ch] * (1 - tx) + d[k + 4 + ch] * tx) * (1 - ty) + (d[k + row + ch] * (1 - tx) + d[k + row + 4 + ch] * tx) * ty;
  }
  return true;
}

// --- How much of the survey shows: all of it inside, fading out toward its edges ----

const MASK_M = 3;
let maskW = 0;
let maskH = 0;
/** Distance to the survey's edge (m), on a 3 m grid over its box. */
let edge: Float32Array;

function buildFeather() {
  maskW = Math.ceil(((BOX.east - BOX.west) * M_PER_DEG_LON) / MASK_M) + 1;
  maskH = Math.ceil(((BOX.north - BOX.south) * M_PER_DEG_LAT) / MASK_M) + 1;
  edge = new Float32Array(maskW * maskH);
  const px = [0, 0, 0, 0];
  for (let j = 0; j < maskH; j++) {
    const lat = BOX.north - (j * MASK_M) / M_PER_DEG_LAT;
    for (let i = 0; i < maskW; i++) {
      const lon = BOX.west + (i * MASK_M) / M_PER_DEG_LON;
      const inside = i > 0 && j > 0 && i < maskW - 1 && j < maskH - 1 && survey(lat, lon, px) && px[3] > 250;
      edge[j * maskW + i] = inside ? 1e9 : 0;
    }
  }
  // (Chamfer distance, two passes.)
  const D = Math.SQRT2;
  for (let j = 1; j < maskH; j++) {
    for (let i = 1; i < maskW - 1; i++) {
      const k = j * maskW + i;
      edge[k] = Math.min(edge[k], edge[k - 1] + 1, edge[k - maskW] + 1, edge[k - maskW - 1] + D, edge[k - maskW + 1] + D);
    }
  }
  for (let j = maskH - 2; j >= 0; j--) {
    for (let i = maskW - 2; i >= 1; i--) {
      const k = j * maskW + i;
      edge[k] = Math.min(edge[k], edge[k + 1] + 1, edge[k + maskW] + 1, edge[k + maskW + 1] + D, edge[k + maskW - 1] + D);
    }
  }
  for (let k = 0; k < edge.length; k++) edge[k] *= MASK_M;
}

/** How far inside the survey's edge a point is (m; 0 outside). */
function inside(lat: number, lon: number): number {
  const fx = ((lon - BOX.west) * M_PER_DEG_LON) / MASK_M;
  const fy = ((BOX.north - lat) * M_PER_DEG_LAT) / MASK_M;
  if (fx < 0 || fy < 0 || fx > maskW - 1 || fy > maskH - 1) return 0;
  const x0 = Math.min(maskW - 2, Math.floor(fx));
  const y0 = Math.min(maskH - 2, Math.floor(fy));
  const tx = fx - x0;
  const ty = fy - y0;
  const k = y0 * maskW + x0;
  return (edge[k] * (1 - tx) + edge[k + 1] * tx) * (1 - ty) + (edge[k + maskW] * (1 - tx) + edge[k + maskW + 1] * tx) * ty;
}

const feather = (lat: number, lon: number) => smooth((inside(lat, lon) - FEATHER_INSET_M) / FEATHER_M);

// --- Retouching ------------------------------------------------------------------------

/**
 * Shadows in the survey of things the game draws itself, falling on open ground it doesn't cover
 * with ground of its own: there the photo's shadow lay beside the one the game's sun casts.
 * Each a box (pad east / north, m) filled with the ground next to it: the strip `from` metres
 * wide just west of the box, mirrored back and forth across it.
 *   - Pad 2's tower, 145 m of it at 1 pm in January, reaching north over Highway 4 onto the
 *     verge and the parking beyond. (South of the road it's on the launch site's slab.)
 */
const HEAL: { e0: number; e1: number; n0: number; n1: number; from: number }[] = [{ e0: -360, e1: -337, n0: 238, n1: 268, from: 15 }];
const HEAL_EDGE_M = 2.5;

/** The survey at a point, retouched (HEAL). */
function shot(lat: number, lon: number, out: number[]): boolean {
  if (!survey(lat, lon, out)) return false;
  const e = (lon - CENTER.lon) * M_PER_DEG_LON;
  const n = (lat - CENTER.lat) * M_PER_DEG_LAT;
  for (const h of HEAL) {
    const d = Math.min(e - h.e0, h.e1 - e, n - h.n0, h.n1 - n);
    if (d <= 0) continue;
    const u = (e - h.e0) % (2 * h.from);
    const src = h.e0 - 0.5 - (u < h.from ? u : 2 * h.from - u);
    const o = [out[0], out[1], out[2]];
    survey(lat, CENTER.lon + src / M_PER_DEG_LON, out);
    const w = smooth(d / HEAL_EDGE_M);
    for (let c = 0; c < 3; c++) out[c] = o[c] * (1 - w) + out[c] * w;
  }
  return true;
}

// --- The terrain as built: its imagery and heights -----------------------------------

type RGB = Uint8Array;
const decode = async (input: string | Buffer): Promise<RGB> => new Uint8Array((await sharp(input).removeAlpha().raw().toBuffer()).buffer);

/**
 * The terrain's own picture for a tile: its tile, or (finer than it goes, or none there) the
 * matching part of the nearest tile above, as the game shows it; water where there's none.
 */
async function baseTile(z: number, x: number, y: number): Promise<RGB> {
  for (let d = 0; z - d >= MIN_ZOOM && d <= 7; d++) {
    if (z - d > MAX_ZOOM) continue;
    const file = resolve(LIVE, `img/${z - d}/${x >> d}/${y >> d}.jpg`);
    if (!existsSync(file)) continue;
    if (d === 0) return decode(file);
    const size = T >> d;
    const part = await sharp(file)
      .extract({ left: (x - ((x >> d) << d)) * size, top: (y - ((y >> d) << d)) * size, width: size, height: size })
      .resize(T, T, { kernel: 'cubic' })
      .toBuffer();
    return decode(part);
  }
  const out = new Uint8Array(T * T * 3);
  for (let k = 0; k < out.length; k++) out[k] = WATER_RGB[k % 3];
  return out;
}

const demTiles = new Map<string, Int16Array | null>();
/** Ground height (m, NAVD88) from the built height tiles; 0 where there's none (open sea). */
function height(lat: number, lon: number): number {
  const fx = lonToTileX(lon, DEM_ZOOM);
  const fy = latToTileY(lat, DEM_ZOOM);
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const key = `${x}/${y}`;
  let t = demTiles.get(key);
  if (t === undefined) {
    const file = resolve(LIVE, `dem/${DEM_ZOOM}/${key}.bin`);
    t = existsSync(file) ? new Int16Array(new Uint8Array(readFileSync(file)).buffer) : null;
    demTiles.set(key, t);
  }
  if (!t) return 0;
  const u = (fx - x) * (DEM_GRID - 1);
  const v = (fy - y) * (DEM_GRID - 1);
  const i = Math.min(DEM_GRID - 2, Math.floor(u));
  const j = Math.min(DEM_GRID - 2, Math.floor(v));
  const a = u - i;
  const b = v - j;
  const k = j * DEM_GRID + i;
  return ((t[k] * (1 - a) + t[k + 1] * a) * (1 - b) + (t[k + DEM_GRID] * (1 - a) + t[k + DEM_GRID + 1] * a) * b) / 100;
}

// --- Colour: the survey matched to the imagery round it --------------------------------

/** Per channel: out = in * gain + offset. */
const GAIN = [1, 1, 1];
const OFFSET = [0, 0, 0];

/**
 * A winter afternoon's light and another camera: left as it is, the survey sat in the 2022
 * imagery as a patch of another colour. Matched over the dry land the two share (mean and
 * spread of each channel): the same sand and scrub the same colour in both.
 */
async function matchColour() {
  const z = 16;
  const sum = [0, 0, 0], sum2 = [0, 0, 0], bsum = [0, 0, 0], bsum2 = [0, 0, 0];
  let n = 0;
  const px = [0, 0, 0, 0];
  const acc = [0, 0, 0];
  for (let x = Math.floor(lonToTileX(BOX.west, z)); x <= Math.floor(lonToTileX(BOX.east, z)); x++) {
    for (let y = Math.floor(latToTileY(BOX.north, z)); y <= Math.floor(latToTileY(BOX.south, z)); y++) {
      const file = resolve(LIVE, `img/${z}/${x}/${y}.jpg`);
      if (!existsSync(file)) continue;
      const base = await decode(file);
      const mLat = 2.4 / M_PER_DEG_LAT / 3;
      const mLon = 2.4 / M_PER_DEG_LON / 3;
      for (let py = 2; py < T; py += 4) {
        const lat = tileYToLat(y + (py + 0.5) / T, z);
        for (let qx = 2; qx < T; qx += 4) {
          const lon = tileXToLon(x + (qx + 0.5) / T, z);
          if (feather(lat, lon) < 0.99 || height(lat, lon) < 0.7) continue;
          // (The survey over this pixel's 2.4 m: nine points of it.)
          acc[0] = acc[1] = acc[2] = 0;
          for (let a = -1; a <= 1; a++) {
            for (let b = -1; b <= 1; b++) {
              survey(lat + a * mLat, lon + b * mLon, px);
              for (let c = 0; c < 3; c++) acc[c] += px[c] / 9;
            }
          }
          const k = (py * T + qx) * 3;
          for (let c = 0; c < 3; c++) {
            sum[c] += acc[c];
            sum2[c] += acc[c] * acc[c];
            bsum[c] += base[k + c];
            bsum2[c] += base[k + c] * base[k + c];
          }
          n++;
        }
      }
    }
  }
  for (let c = 0; c < 3; c++) {
    const m = sum[c] / n, bm = bsum[c] / n;
    const sd = Math.sqrt(sum2[c] / n - m * m), bsd = Math.sqrt(bsum2[c] / n - bm * bm);
    GAIN[c] = Math.max(0.6, Math.min(1.6, bsd / sd));
    OFFSET[c] = bm - GAIN[c] * m;
    console.log(`colour ${'RGB'[c]}: survey ${m.toFixed(1)} ± ${sd.toFixed(1)}, terrain ${bm.toFixed(1)} ± ${bsd.toFixed(1)}  ->  x${GAIN[c].toFixed(3)} ${OFFSET[c] >= 0 ? '+' : ''}${OFFSET[c].toFixed(1)}`);
  }
}

// --- Tone: the survey's broad colour brought to the terrain's toward its edges ----------

let toneW = 0;
let toneH = 0;
/** The terrain's imagery less the survey's, both blurred (r, g, b per cell of TONE_CELL_M). */
let tone: Float32Array;

async function buildTone() {
  toneW = Math.ceil(((BOX.east - BOX.west) * M_PER_DEG_LON) / TONE_CELL_M) + 1;
  toneH = Math.ceil(((BOX.north - BOX.south) * M_PER_DEG_LAT) / TONE_CELL_M) + 1;
  const n = toneW * toneH;
  // (Per cell: the terrain's colour, the survey's, and whether both have one.)
  const a = new Float32Array(n * 3), b = new Float32Array(n * 3), ok = new Float32Array(n);
  const z = 15;
  const tiles = new Map<string, RGB | null>();
  const px = [0, 0, 0, 0];
  for (let j = 0; j < toneH; j++) {
    const lat = BOX.north - (j * TONE_CELL_M) / M_PER_DEG_LAT;
    for (let i = 0; i < toneW; i++) {
      const lon = BOX.west + (i * TONE_CELL_M) / M_PER_DEG_LON;
      if (inside(lat, lon) <= 0) continue;
      const fx = lonToTileX(lon, z), fy = latToTileY(lat, z);
      const key = `${Math.floor(fx)}/${Math.floor(fy)}`;
      let t = tiles.get(key);
      if (t === undefined) {
        const file = resolve(LIVE, `img/${z}/${key}.jpg`);
        t = existsSync(file) ? await decode(file) : null;
        tiles.set(key, t);
      }
      if (!t) continue;
      const k = j * toneW + i;
      const tp = (Math.min(T - 1, Math.floor((fy % 1) * T)) * T + Math.min(T - 1, Math.floor((fx % 1) * T))) * 3;
      // (The survey over the cell: sixteen points of it.)
      for (let q = 0; q < 16; q++) {
        survey(lat + (((q >> 2) - 1.5) * 2) / M_PER_DEG_LAT, lon + (((q & 3) - 1.5) * 2) / M_PER_DEG_LON, px);
        for (let c = 0; c < 3; c++) b[k * 3 + c] += (px[c] * GAIN[c] + OFFSET[c]) / 16;
      }
      for (let c = 0; c < 3; c++) a[k * 3 + c] = t[tp + c];
      ok[k] = 1;
    }
  }
  // Blurred: three passes of a box 13 cells wide each way (about a 50 m Gaussian), over the
  // cells that have both.
  const R = 6;
  const blur = (v: Float32Array, ch: number) => {
    const tmp = new Float32Array(n * ch);
    for (let pass = 0; pass < 3; pass++) {
      for (const [src, dst, horizontal] of [[v, tmp, true], [tmp, v, false]] as [Float32Array, Float32Array, boolean][]) {
        for (let j = 0; j < toneH; j++) {
          for (let i = 0; i < toneW; i++) {
            for (let c = 0; c < ch; c++) {
              let sum = 0;
              for (let r = -R; r <= R; r++) {
                const ii = horizontal ? Math.max(0, Math.min(toneW - 1, i + r)) : i;
                const jj = horizontal ? j : Math.max(0, Math.min(toneH - 1, j + r));
                sum += src[(jj * toneW + ii) * ch + c];
              }
              dst[(j * toneW + i) * ch + c] = sum / (2 * R + 1);
            }
          }
        }
      }
    }
  };
  blur(a, 3);
  blur(b, 3);
  blur(ok, 1);
  tone = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    if (ok[k] < 0.02) continue;
    for (let c = 0; c < 3; c++) tone[k * 3 + c] = Math.max(-70, Math.min(70, (a[k * 3 + c] - b[k * 3 + c]) / ok[k]));
  }
}

/** What to add to the survey's colour at a point (into out). */
function toneAt(lat: number, lon: number, out: number[]): void {
  const t = 1 - smooth((inside(lat, lon) - FEATHER_INSET_M) / TONE_M);
  out[0] = out[1] = out[2] = 0;
  if (t <= 0) return;
  const fx = Math.max(0, Math.min(toneW - 1.001, ((lon - BOX.west) * M_PER_DEG_LON) / TONE_CELL_M));
  const fy = Math.max(0, Math.min(toneH - 1.001, ((BOX.north - lat) * M_PER_DEG_LAT) / TONE_CELL_M));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const k = (y0 * toneW + x0) * 3;
  for (let c = 0; c < 3; c++) {
    out[c] = t * ((tone[k + c] * (1 - tx) + tone[k + 3 + c] * tx) * (1 - ty) + (tone[k + toneW * 3 + c] * (1 - tx) + tone[k + toneW * 3 + 3 + c] * tx) * ty);
  }
}

// --- Tiles -----------------------------------------------------------------------------

/** A tile of the survey: colour times how much of it shows, and how much (r w, g w, b w, w). */
type Layer = Float32Array;
const written: Record<number, Set<string>> = {};

function surveyTile(x: number, y: number): Layer | null {
  const z = NOAA_ZOOM;
  const out = new Float32Array(T * T * 4);
  const px = [0, 0, 0, 0];
  const add = [0, 0, 0];
  let any = false;
  for (let py = 0; py < T; py++) {
    const lat = tileYToLat(y + (py + 0.5) / T, z);
    for (let qx = 0; qx < T; qx++) {
      const lon = tileXToLon(x + (qx + 0.5) / T, z);
      const w = feather(lat, lon);
      if (w <= 0 || !shot(lat, lon, px)) continue;
      toneAt(lat, lon, add);
      const k = (py * T + qx) * 4;
      for (let c = 0; c < 3; c++) out[k + c] = Math.max(0, Math.min(255, px[c] * GAIN[c] + OFFSET[c] + add[c])) * w;
      out[k + 3] = w;
      any = true;
    }
  }
  return any ? out : null;
}

function halve(kids: (Layer | null)[]): Layer {
  const out = new Float32Array(T * T * 4);
  const H = T / 2;
  kids.forEach((kid, q) => {
    if (!kid) return;
    const ox = (q & 1) * H, oy = (q >> 1) * H;
    for (let py = 0; py < H; py++) {
      for (let qx = 0; qx < H; qx++) {
        const s = (2 * py * T + 2 * qx) * 4;
        const d = ((oy + py) * T + ox + qx) * 4;
        for (let c = 0; c < 4; c++) out[d + c] = (kid[s + c] + kid[s + 4 + c] + kid[s + T * 4 + c] + kid[s + T * 4 + 4 + c]) / 4;
      }
    }
  });
  return out;
}

async function writeTile(z: number, x: number, y: number, layer: Layer) {
  let most = 0;
  let least = 1;
  for (let k = 3; k < layer.length; k += 4) {
    if (layer[k] > most) most = layer[k];
    if (layer[k] < least) least = layer[k];
  }
  if (most < 0.004) return;
  // (Water at the coarse zooms: as the terrain build baked it, not the survey's.)
  const baked = z <= 14;
  const base = least < 0.999 || baked ? await baseTile(z, x, y) : null;
  const out = Buffer.alloc(T * T * 3);
  for (let py = 0; py < T; py++) {
    const lat = baked ? tileYToLat(y + (py + 0.5) / T, z) : 0;
    for (let qx = 0; qx < T; qx++) {
      const k = py * T + qx;
      const w = layer[k * 4 + 3];
      let keep = 1;
      if (baked && w > 0) keep = smooth((height(lat, tileXToLon(x + (qx + 0.5) / T, z)) - (WATER_LEVEL - 0.12)) / 0.17);
      for (let c = 0; c < 3; c++) {
        const b = base ? base[k * 3 + c] : 0;
        out[k * 3 + c] = Math.round(b * (1 - w * keep) + layer[k * 4 + c] * keep);
      }
    }
  }
  const file = resolve(DIR, `${VERSION}/${z}/${x}/${y}.jpg`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, await sharp(out, { raw: { width: T, height: T, channels: 3 } }).jpeg({ quality: 90, mozjpeg: true }).toBuffer());
  (written[z] ??= new Set()).add(`${x}/${y}`);
}

async function build(z: number, x: number, y: number): Promise<Layer | null> {
  if (tileXToLon(x + 1, z) <= BOX.west || tileXToLon(x, z) >= BOX.east || tileYToLat(y, z) <= BOX.south || tileYToLat(y + 1, z) >= BOX.north) return null;
  let layer: Layer | null;
  if (z === NOAA_ZOOM) layer = surveyTile(x, y);
  else {
    const at = [0, 1, 2, 3].map((q) => [2 * x + (q & 1), 2 * y + (q >> 1)]);
    const kids: (Layer | null)[] = [];
    // (The finest three levels a tile's worth at a time; the rest one after another: each
    // layer is a megabyte.)
    if (z >= NOAA_ZOOM - 2) kids.push(...(await Promise.all(at.map(([cx, cy]) => build(z + 1, cx, cy)))));
    else for (const [cx, cy] of at) kids.push(await build(z + 1, cx, cy));
    layer = kids.some((k) => k) ? halve(kids) : null;
  }
  if (layer) await writeTile(z, x, y, layer);
  return layer;
}

/**
 * The launch site as the survey has it: the picture the slab is drawn with. Pad east / north of
 * its south-west corner, its size (m) and width in pixels (the survey's own 0.3 m): the same
 * numbers as SITE_PHOTO in src/render/launchSite.ts.
 */
const SITE_PHOTO = { e0: -470, n0: -100, w: 620, h: 330, px: 2048, file: 'launch-site-2026.jpg' };
/** The Starfactory's roofs, for its model (ROOF_PHOTO in src/render/facilities.ts). */
const ROOF_PHOTO = { e0: -3395, n0: -1165, w: 470, h: 440, px: 1568, file: 'starfactory-roof-2026.jpg' };

async function writeSitePhoto(SITE_PHOTO: { e0: number; n0: number; w: number; h: number; px: number; file: string }) {
  const W = SITE_PHOTO.px;
  const H = Math.round((W * SITE_PHOTO.h) / SITE_PHOTO.w);
  const out = Buffer.alloc(W * H * 3);
  const px = [0, 0, 0, 0];
  for (let j = 0; j < H; j++) {
    const lat = CENTER.lat + (SITE_PHOTO.n0 + SITE_PHOTO.h * (1 - (j + 0.5) / H)) / M_PER_DEG_LAT;
    for (let i = 0; i < W; i++) {
      shot(lat, CENTER.lon + (SITE_PHOTO.e0 + (SITE_PHOTO.w * (i + 0.5)) / W) / M_PER_DEG_LON, px);
      for (let c = 0; c < 3; c++) out[(j * W + i) * 3 + c] = Math.max(0, Math.min(255, Math.round(px[c] * GAIN[c] + OFFSET[c])));
    }
  }
  const file = resolve(LIVE, `../media/${SITE_PHOTO.file}`);
  writeFileSync(file, await sharp(out, { raw: { width: W, height: H, channels: 3 } }).jpeg({ quality: 84, mozjpeg: true }).toBuffer());
  console.log(`wrote ${file} (${W} x ${H})`);
}

/**
 * Where scrub grows, for the tufts the game stands on the ground near the camera
 * (src/render/scrub.ts; the same numbers as SCRUB_MAP there): public/media/starbase-scrub-2026.jpg,
 * grey, 3 m a pixel over the survey. Scrub and dune grass show in the survey as speckle (dark
 * clumps on pale sand); mud, sand, water and paving are smooth. So: how uneven each 3 m of ground
 * is, where it isn't too bright to be anything but sand; none on the sites (buildings and parked
 * cars speckle too) or within a few metres of a road.
 */
const SCRUB_MAP = { px: 3 };

async function writeScrubMask() {
  const W = Math.floor(((BOX.east - BOX.west) * M_PER_DEG_LON) / SCRUB_MAP.px);
  const H = Math.floor(((BOX.north - BOX.south) * M_PER_DEG_LAT) / SCRUB_MAP.px);
  const e0 = (BOX.west - CENTER.lon) * M_PER_DEG_LON;
  const n1 = (BOX.north - CENTER.lat) * M_PER_DEG_LAT;
  const out = Buffer.alloc(W * H);
  const px = [0, 0, 0, 0];
  const roads: [number, readonly (readonly [number, number])[]][] = [[9, HIGHWAY_4_WEST], [9, HIGHWAY_4_EAST], ...SIDE_ROADS.map(([half, line]) => [half + 3, line] as [number, [number, number][]])];
  /** Each road's box, to pass over those nowhere near. */
  const boxes = roads.map(([reach, line]) => [Math.min(...line.map((q) => q[0])) - reach, Math.max(...line.map((q) => q[0])) + reach, Math.min(...line.map((q) => q[1])) - reach, Math.max(...line.map((q) => q[1])) + reach]);
  const inSite = (e: number, n: number) => {
    let inside = false;
    for (let i = 0, j = SITE_OUTLINE.length - 1; i < SITE_OUTLINE.length; j = i++) {
      const [a, b] = [SITE_OUTLINE[i], SITE_OUTLINE[j]];
      if (a[1] > n !== b[1] > n && e < ((b[0] - a[0]) * (n - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside || distanceToLine([e, n], [...SITE_OUTLINE, SITE_OUTLINE[0]]) < 12;
  };
  for (let j = 0; j < H; j++) {
    const n = n1 - (j + 0.5) * SCRUB_MAP.px;
    for (let i = 0; i < W; i++) {
      const e = e0 + (i + 0.5) * SCRUB_MAP.px;
      // (Built ground: the production site and village; the launch site and the yards across
      // the road from it.)
      if ((e > -3950 && e < -2560 && n > -1800 && n < -120) || (e > 140 && e < 340 && n > 105 && n < 240) || (e > -345 && e < -255 && n > 262 && n < 330)) continue;
      if (Math.hypot(e - ROUNDABOUT.center[0], n - ROUNDABOUT.center[1]) < ROUNDABOUT.radius + 8) continue;
      if (e > -470 && e < 150 && n > -100 && n < 230 && inSite(e, n)) continue;
      if (roads.some(([reach, line], k) => e > boxes[k][0] && e < boxes[k][1] && n > boxes[k][2] && n < boxes[k][3] && distanceToLine([e, n], line) < reach)) continue;
      // (And along the highway's north verge at the launch site, where the cars park.)
      if (e > -700 && e < 420 && n > 60 && distanceToLine([e, n], HIGHWAY_4_WEST) < 26) continue;
      let sum = 0, sum2 = 0;
      for (let q = 0; q < 36; q++) {
        const de = ((q % 6) - 2.5) * 0.5, dn = (Math.floor(q / 6) - 2.5) * 0.5;
        if (!survey(CENTER.lat + (n + dn) / M_PER_DEG_LAT, CENTER.lon + (e + de) / M_PER_DEG_LON, px) || px[3] < 250) {
          sum = -1;
          break;
        }
        const l = 0.3 * px[0] + 0.59 * px[1] + 0.11 * px[2];
        sum += l;
        sum2 += l * l;
      }
      if (sum < 0) continue;
      const mean = sum / 36;
      const sd = Math.sqrt(Math.max(0, sum2 / 36 - mean * mean));
      out[j * W + i] = Math.round(255 * smooth((sd - 5) / 9) * smooth((188 - mean) / 30) * smooth((height(CENTER.lat + n / M_PER_DEG_LAT, CENTER.lon + e / M_PER_DEG_LON) - 0.35) / 0.3));
    }
  }
  // (A little blurred: a clump's own bright and dark pixels are one clump.)
  const file = resolve(LIVE, '../media/starbase-scrub-2026.jpg');
  writeFileSync(file, await sharp(out, { raw: { width: W, height: H, channels: 1 } }).blur(1.2).jpeg({ quality: 72 }).toBuffer());
  console.log(`wrote ${file} (${W} x ${H}), from pad east ${e0.toFixed(1)}, north ${(n1 - H * SCRUB_MAP.px).toFixed(1)}: ${(W * SCRUB_MAP.px).toFixed(0)} x ${(H * SCRUB_MAP.px).toFixed(0)} m`);
}

async function main() {
  await loadCells();
  buildFeather();
  await matchColour();
  await writeSitePhoto(SITE_PHOTO);
  await writeSitePhoto(ROOF_PHOTO);
  await writeScrubMask();
  if (process.argv.includes('--site-only')) return;
  await buildTone();
  // (Whatever folder was there before, this one included.)
  rmSync(DIR, { recursive: true, force: true });
  const z = MIN_ZOOM;
  for (let x = Math.floor(lonToTileX(BOX.west, z)); x <= Math.floor(lonToTileX(BOX.east, z)); x++) {
    for (let y = Math.floor(latToTileY(BOX.north, z)); y <= Math.floor(latToTileY(BOX.south, z)); y++) await build(z, x, y);
  }
  // The index: each zoom's tiles as a bitset over the box they lie in.
  const ranges: Record<number, { x0: number; x1: number; y0: number; y1: number }> = {};
  const img: Record<number, string> = {};
  let total = 0;
  for (let zz = MIN_ZOOM; zz <= NOAA_ZOOM; zz++) {
    const keys = [...(written[zz] ?? [])].map((k) => k.split('/').map(Number));
    if (!keys.length) continue;
    const r = { x0: Math.min(...keys.map((k) => k[0])), x1: Math.max(...keys.map((k) => k[0])), y0: Math.min(...keys.map((k) => k[1])), y1: Math.max(...keys.map((k) => k[1])) };
    const bits = new Uint8Array(Math.ceil(((r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1)) / 8));
    for (const [x, y] of keys) {
      const i = (y - r.y0) * (r.x1 - r.x0 + 1) + (x - r.x0);
      bits[i >> 3] |= 1 << (i & 7);
    }
    ranges[zz] = r;
    img[zz] = Buffer.from(bits).toString('base64');
    total += keys.length;
    console.log(`z${zz}: ${keys.length} tiles`);
  }
  writeFileSync(
    resolve(DIR, 'index.json'),
    JSON.stringify({
      dir: VERSION,
      minZoom: MIN_ZOOM,
      maxZoom: NOAA_ZOOM,
      ranges,
      img,
      source: 'NOAA National Geodetic Survey, Emergency Response Imagery, flight GC2601a, 18 January 2026 (public domain), via NOAA Open Data Dissemination',
    }),
  );
  console.log(`wrote ${total} tiles and index.json`);

  const preview = process.argv.find((a) => a.startsWith('--preview='))?.split('=')[1];
  if (preview) {
    // (The whole overlay at z15, for a look.)
    const pz = 15;
    const r = ranges[pz];
    const comps = [...written[pz]].map((k) => {
      const [x, y] = k.split('/').map(Number);
      return { input: resolve(DIR, `${VERSION}/${pz}/${k}.jpg`), left: (x - r.x0) * T, top: (y - r.y0) * T };
    });
    await sharp({ create: { width: (r.x1 - r.x0 + 1) * T, height: (r.y1 - r.y0 + 1) * T, channels: 3, background: '#f0f' } }).composite(comps).jpeg({ quality: 88 }).toFile(preview);
  }
}

main();

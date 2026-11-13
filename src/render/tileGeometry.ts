// The vertex data of a map tile: the terrain's (terrain.ts: a 33 x 33 height grid with skirts,
// each vertex placed on the curved Earth in the pad's frame) and the globe's (globeTiles.ts).
// Each vertex is a geodetic -> world conversion, a few hundred microseconds a tile and more for
// the big globe tiles: built in the tile worker (tiles.worker.ts), between frames no longer.
// No DOM, no three: plain typed arrays, handed to the main thread as they are.

import { PAD } from '../sim/constants';
import type { V3 } from '../sim/math';
import { ecefToWorld, tileXToLon, tileYToLat, toWorld } from './geo';

/** Vertices per terrain tile edge. */
export const TERRAIN_GRID = 33;

/** A tile's place in the quadtree. */
export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** A tile's heights where there's no DEM (open sea): 0 m. */
export const flatHeights = (): Float32Array => new Float32Array(TERRAIN_GRID * TERRAIN_GRID);

/**
 * Heights (m, NAVD88) for a tile at TERRAIN_GRID x TERRAIN_GRID, from a DEM tile (Int16
 * centimetres, grid x grid, with `margin` cells of its neighbours' round it: cleanDem): its own
 * or an ancestor's (at: that tile's place). A DEM tile that isn't there: 0 m.
 *
 * Where the mesh is as fine as the DEM, sampled bilinearly. Where it is coarser (a tile on its
 * own DEM tile has a point every fourth cell), each point is the average of the cells round it,
 * out to the next point's (a tent): taken at the point alone, a shore's place depended on
 * which cells the points fell on, and it moved, by a cell or three, each time the ground changed
 * detail under the camera; a bank a cell or two wide was land at one level and water at the next.
 */
export function tileHeights(t: TileId, dem: Int16Array | null, at: TileId, grid: number, margin = 0): Float32Array {
  const GRID = TERRAIN_GRID;
  const out = flatHeights();
  if (!dem) return out;
  const G = grid;
  const S = G + 2 * margin;
  const scale = 2 ** (t.z - at.z);
  const step = Math.round((G - 1) / ((GRID - 1) * scale));
  if (step >= 2 && (G - 1) % ((GRID - 1) * scale) === 0) {
    // (Its points fall on cells. Past the tile and its margin: the last cell there is.)
    const lo = -margin;
    const hi = G - 1 + margin;
    const x0 = (t.x / scale - at.x) * (G - 1);
    const y0 = (t.y / scale - at.y) * (G - 1);
    const norm = 1 / (step * step * step * step * 100);
    for (let j = 0; j < GRID; j++) {
      const cy = Math.round(y0 + j * step);
      for (let i = 0; i < GRID; i++) {
        const cx = Math.round(x0 + i * step);
        let sum = 0;
        for (let dj = 1 - step; dj < step; dj++) {
          const row = (Math.min(hi, Math.max(lo, cy + dj)) + margin) * S + margin;
          const wj = step - Math.abs(dj);
          let r = 0;
          for (let di = 1 - step; di < step; di++) r += dem[row + Math.min(hi, Math.max(lo, cx + di))] * (step - Math.abs(di));
          sum += r * wj;
        }
        out[j * GRID + i] = sum * norm;
      }
    }
    return out;
  }
  for (let j = 0; j < GRID; j++) {
    const gy = ((t.y + j / (GRID - 1)) / scale - at.y) * (G - 1);
    const y0 = Math.min(G - 2, Math.floor(gy));
    const fy = gy - y0;
    const r0 = (y0 + margin) * S + margin;
    const r1 = r0 + S;
    for (let i = 0; i < GRID; i++) {
      const gx = ((t.x + i / (GRID - 1)) / scale - at.x) * (G - 1);
      const x0 = Math.min(G - 2, Math.floor(gx));
      const fx = gx - x0;
      const h00 = dem[r0 + x0], h10 = dem[r0 + x0 + 1];
      const h01 = dem[r1 + x0], h11 = dem[r1 + x0 + 1];
      out[j * GRID + i] = ((h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy) / 100;
    }
  }
  return out;
}

/** Above this (cm, NAVD88) the ground starts to show through the water (terrain.ts, waterMask). */
const SHOWS = 13;
/** A cell there's no height for (a neighbour's that has no DEM tile). */
export const NO_HEIGHT = -32768;
/**
 * What's taken for a wave: a speck up to `area` m² and `top` cm high, or a broader patch if lower
 * (where the survey left a whole stretch of the Gulf unflattened, crests 30 to 50 cm up over
 * most of a hectare); where its far side can't be seen, a speck that barely shows.
 */
const SPECK = { area: 1000, top: 60, broadArea: 8000, broadTop: 50, edgeTop: 30 };

/**
 * Heights (a square of them, `size` a side: a DEM tile, or one with its neighbours round it) with
 * the specks in the water taken out, in place: cell: the cells' size, m.
 *
 * The survey flattened open water to 0 m, but left returns off wave crests and boat wakes in it:
 * lone cells and small clumps 20 to 40 cm up, in the Gulf and the bays. Those are over the level
 * the ground shows at, so each drew as a patch of the aerial photo's pale water in the sea, with
 * the sea's surf round it. And every detail level has its own, in other places: as the camera
 * moved in and out they came, went and jumped about.
 *
 * Taken out: ground with water all round it that is small and low (a real island that size
 * stands higher). What reaches the edge of the heights there are is left, the rest of it being
 * out of sight, unless it is a speck within the band where ground only half shows anyway.
 */
export function despeckleWater(dem: Int16Array, size: number, cell: number): Int16Array {
  const G = size;
  const a = cell * cell;
  // (One cell at the least: at the coarse levels a cell is bigger than any speck.)
  const small = Math.max(1, Math.floor(SPECK.area / a));
  const broad = Math.max(small, Math.floor(SPECK.broadArea / a));
  const seen = new Uint8Array(G * G);
  const stack: number[] = [];
  const clump: number[] = [];
  for (let s = 0; s < G * G; s++) {
    if (seen[s] || dem[s] <= SHOWS) continue;
    stack.length = clump.length = 0;
    stack.push(s);
    seen[s] = 1;
    let top = -Infinity;
    let edge = false;
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % G;
      const j = (k - i) / G;
      // (Past `broad` it is land whatever its height: no need to remember its cells.)
      if (clump.length <= broad) clump.push(k);
      if (dem[k] > top) top = dem[k];
      if (i === 0 || j === 0 || i === G - 1 || j === G - 1) edge = true;
      for (let n = 0; n < 4; n++) {
        if ((n === 0 && i === 0) || (n === 1 && i === G - 1) || (n === 2 && j === 0) || (n === 3 && j === G - 1)) continue;
        const q = n === 0 ? k - 1 : n === 1 ? k + 1 : n === 2 ? k - G : k + G;
        if (dem[q] === NO_HEIGHT) edge = true;
        else if (!seen[q] && dem[q] > SHOWS) {
          seen[q] = 1;
          stack.push(q);
        }
      }
    }
    const n = clump.length;
    if (edge ? n <= small && top <= SPECK.edgeTop : (n <= small && top <= SPECK.top) || (n <= broad && top <= SPECK.broadTop)) for (const k of clump) dem[k] = 0;
  }
  return dem;
}

/** Cells of its neighbours kept round a cleaned DEM tile (cleanDem): what tileHeights' tent reaches. */
export const DEM_MARGIN = 4;
/** The band the shore is smoothed in, cm: the level ground shows at is its middle. */
const SHORE_BAND = [-20, 60];

/**
 * A DEM tile made ready for the ground's meshes: with DEM_MARGIN cells of its neighbours round
 * it ((grid + 2 * DEM_MARGIN) a side), the specks out of its water (despeckleWater) and its
 * shores smoothed. ring: the eight tiles round it, by rows from the north-west (null: none
 * there); cell: the cells' size, m.
 *
 * With its neighbours, because a tile on its own can't tell a speck that lies across its edge
 * from the tip of a shore: those were left, and one tile in three offshore had a few. And so
 * that the tiles to either side of an edge make the same of the ground along it.
 *
 * The shores: the survey's water is flat and its banks start a cell further on, so a shore was
 * a staircase of 4 m squares (17 m ones from higher up). Near the level the ground shows at,
 * each cell becomes the average of those round it (twice over; heights taken as no lower than
 * the band and no higher, so a dune or a sea wall next to the water doesn't lift it): the stairs
 * go, a straight shore stays where it was (the showing level is the band's middle), and ground
 * over the band is left as surveyed: nothing built or banked is worn down.
 */
export function cleanDem(centre: Int16Array, ring: readonly (Int16Array | null)[], grid: number, cell: number): Int16Array {
  const G = grid;
  const M = 3 * (G - 1) + 1;
  const mosaic = new Int16Array(M * M).fill(NO_HEIGHT);
  // (A neighbour with no tile of its own is open sea if this tile's side of it is water; else
  // unknown: beyond the survey.)
  const wet = (cells: (k: number) => number, n: number): boolean => {
    let w = 0;
    for (let k = 0; k < n; k++) if (centre[cells(k)] <= SHOWS) w++;
    return w >= 0.75 * n;
  };
  const sea = [
    wet(() => 0, 1), wet((k) => k, G), wet(() => G - 1, 1),
    wet((k) => k * G, G), wet((k) => k * G + G - 1, G),
    wet(() => (G - 1) * G, 1), wet((k) => (G - 1) * G + k, G), wet(() => G * G - 1, 1),
  ];
  for (let n = 0; n < 9; n++) {
    const src = n === 4 ? centre : ring[n < 4 ? n : n - 1] ?? null;
    const ox = (n % 3) * (G - 1);
    const oy = Math.floor(n / 3) * (G - 1);
    if (!src) {
      if (sea[n < 4 ? n : n - 1]) for (let j = 0; j < G; j++) mosaic.fill(0, (oy + j) * M + ox, (oy + j) * M + ox + G);
      continue;
    }
    for (let j = 0; j < G; j++) mosaic.set(src.subarray(j * G, j * G + G), (oy + j) * M + ox);
  }
  // (The tile's own cells last: along its edges, its own, whatever the neighbours' say.)
  for (let j = 0; j < G; j++) mosaic.set(centre.subarray(j * G, j * G + G), (G - 1 + j) * M + G - 1);
  despeckleWater(mosaic, M, cell);

  // The part kept, and round it what the smoothing reaches (two passes, a cell each).
  const m = DEM_MARGIN;
  const S = G + 2 * m;
  const W = S + 4;
  const o = G - 1 - m - 2;
  const [lo, hi] = SHORE_BAND;
  let band = new Float32Array(W * W);
  for (let j = 0; j < W; j++) {
    for (let i = 0; i < W; i++) {
      const h = mosaic[(o + j) * M + o + i];
      // (Nothing known there: as its nearest cell of the tile's own.)
      band[j * W + i] = Math.min(hi, Math.max(lo, h === NO_HEIGHT ? centre[Math.min(G - 1, Math.max(0, j - m - 2)) * G + Math.min(G - 1, Math.max(0, i - m - 2))] : h));
    }
  }
  for (let pass = 0; pass < 2; pass++) {
    const next = band.slice();
    for (let j = 1; j < W - 1; j++) {
      for (let i = 1; i < W - 1; i++) {
        const k = j * W + i;
        next[k] = (4 * band[k] + 2 * (band[k - 1] + band[k + 1] + band[k - W] + band[k + W]) + band[k - W - 1] + band[k - W + 1] + band[k + W - 1] + band[k + W + 1]) / 16;
      }
    }
    band = next;
  }
  const out = new Int16Array(S * S);
  for (let j = 0; j < S; j++) {
    for (let i = 0; i < S; i++) {
      let h = mosaic[(o + 2 + j) * M + o + 2 + i];
      if (h === NO_HEIGHT) h = centre[Math.min(G - 1, Math.max(0, j - m)) * G + Math.min(G - 1, Math.max(0, i - m))];
      out[j * S + i] = h >= lo && h < hi ? Math.round(band[(j + 2) * W + i + 2]) : h;
    }
  }
  return out;
}

/** The size of a DEM tile's cells, m: tile `at`, `grid` cells a side. */
export function demCellSize(at: TileId, grid: number): number {
  const lat = tileYToLat(at.y + 0.5, at.z);
  return (40075016.686 * Math.cos((lat * Math.PI) / 180)) / 2 ** at.z / (grid - 1);
}

/** What a terrain tile's mesh is built from, besides its heights. */
export interface TerrainTileShape extends TileId {
  /** The tile's centre (render world, float64): vertices are relative to it. */
  center: V3;
  /** How far the skirts hang below the tile's edges, m. */
  drop: number;
  /** Whether the skirts are drawn (not on the fading tiles at the region's edge). */
  skirts: boolean;
  /** Where the tile sits in its image (its own: 0, 0 and 1; a part of an ancestor's otherwise). */
  uvOff: [number, number];
  uvScale: number;
  /** The water shader's weight for every vertex (terrain.ts: 0 baked, 1 live, 2 no imagery). */
  waterWeight: number;
}

export interface TerrainGeometry {
  position: Float32Array;
  uv: Float32Array;
  /** Height above the pad's ground, m. */
  aHeight: Float32Array;
  /** Pad east / north, m. */
  aEN: Float32Array;
  aWaterWeight: Float32Array;
  normal: Float32Array;
  index: Uint16Array;
}

/**
 * A terrain tile's vertices: the grid, then one more ring of them hung below its edge (skirts,
 * hiding the cracks between detail levels), and the triangles.
 */
export function buildTerrainGeometry(t: TerrainTileShape, hts: Float32Array): TerrainGeometry {
  const GRID = TERRAIN_GRID;
  const n = GRID * GRID;
  const skirt = 4 * GRID - 4;
  const pos = new Float32Array((n + skirt) * 3);
  const uv = new Float32Array((n + skirt) * 2);
  const hAttr = new Float32Array(n + skirt);
  const en = new Float32Array((n + skirt) * 2);
  const waterWeight = new Float32Array(n + skirt).fill(t.waterWeight);
  const c = t.center;
  for (let j = 0; j < GRID; j++) {
    const v = j / (GRID - 1);
    const lat = tileYToLat(t.y + v, t.z);
    for (let i = 0; i < GRID; i++) {
      const u = i / (GRID - 1);
      const k = j * GRID + i;
      const h = hts[k];
      const w = toWorld(lat, tileXToLon(t.x + u, t.z), h);
      pos[k * 3] = w[0] - c[0];
      pos[k * 3 + 1] = w[1] - c[1];
      pos[k * 3 + 2] = w[2] - c[2];
      uv[k * 2] = t.uvOff[0] + u * t.uvScale;
      uv[k * 2 + 1] = 1 - (t.uvOff[1] + v * t.uvScale);
      hAttr[k] = h - PAD.groundAlt;
      en[k * 2] = w[0];
      en[k * 2 + 1] = -w[2];
    }
  }
  // Skirts hang below the tile edges to hide cracks between detail levels.
  const edge = new Uint16Array(skirt);
  let s = 0;
  for (let i = 0; i < GRID; i++) edge[s++] = i;
  for (let j = 1; j < GRID; j++) edge[s++] = j * GRID + GRID - 1;
  for (let i = GRID - 2; i >= 0; i--) edge[s++] = (GRID - 1) * GRID + i;
  for (let j = GRID - 2; j >= 1; j--) edge[s++] = j * GRID;
  for (s = 0; s < skirt; s++) {
    const src = edge[s];
    const k = n + s;
    pos[k * 3] = pos[src * 3];
    pos[k * 3 + 1] = pos[src * 3 + 1] - t.drop;
    pos[k * 3 + 2] = pos[src * 3 + 2];
    uv[k * 2] = uv[src * 2];
    uv[k * 2 + 1] = uv[src * 2 + 1];
    hAttr[k] = hAttr[src];
    en[k * 2] = en[src * 2];
    en[k * 2 + 1] = en[src * 2 + 1];
  }
  const surfaceCount = (GRID - 1) * (GRID - 1) * 6;
  const index = new Uint16Array(surfaceCount + (t.skirts ? skirt * 12 : 0));
  let o = 0;
  for (let j = 0; j < GRID - 1; j++) {
    for (let i = 0; i < GRID - 1; i++) {
      const a = j * GRID + i, b = a + 1, d = a + GRID, e = d + 1;
      index[o++] = a; index[o++] = d; index[o++] = b;
      index[o++] = b; index[o++] = d; index[o++] = e;
    }
  }
  if (t.skirts) {
    for (s = 0; s < skirt; s++) {
      const a = edge[s], b = edge[(s + 1) % skirt];
      const a2 = n + s, b2 = n + ((s + 1) % skirt);
      // (Both windings: skirts are seen from either side.)
      index[o++] = a; index[o++] = b; index[o++] = a2;
      index[o++] = b; index[o++] = b2; index[o++] = a2;
      index[o++] = a; index[o++] = a2; index[o++] = b;
      index[o++] = b; index[o++] = a2; index[o++] = b2;
    }
  }
  // Normals from the surface only (skirt faces would tilt the edge normals and shade every
  // tile border differently), then copied down onto the skirt.
  const normal = vertexNormals(pos, index, surfaceCount);
  for (s = 0; s < skirt; s++) {
    const src = edge[s] * 3;
    const k = (n + s) * 3;
    normal[k] = normal[src];
    normal[k + 1] = normal[src + 1];
    normal[k + 2] = normal[src + 2];
  }
  return { position: pos, uv, aHeight: hAttr, aEN: en, aWaterWeight: waterWeight, normal, index };
}

/**
 * Vertex normals from the first `count` indices' triangles: each face's normal (weighted by its
 * area) summed at its corners, then made unit length. As three's computeVertexNormals does it,
 * step for step (sums kept in single precision as it keeps them), so a tile is shaded exactly as
 * when three built it.
 */
export function vertexNormals(pos: Float32Array, index: Uint16Array, count: number): Float32Array {
  const nrm = new Float32Array(pos.length);
  for (let i = 0; i < count; i += 3) {
    const a = index[i] * 3, b = index[i + 1] * 3, c = index[i + 2] * 3;
    const cbx = pos[c] - pos[b], cby = pos[c + 1] - pos[b + 1], cbz = pos[c + 2] - pos[b + 2];
    const abx = pos[a] - pos[b], aby = pos[a + 1] - pos[b + 1], abz = pos[a + 2] - pos[b + 2];
    const x = cby * abz - cbz * aby;
    const y = cbz * abx - cbx * abz;
    const z = cbx * aby - cby * abx;
    nrm[a] += x; nrm[a + 1] += y; nrm[a + 2] += z;
    nrm[b] += x; nrm[b + 1] += y; nrm[b + 2] += z;
    nrm[c] += x; nrm[c + 1] += y; nrm[c + 2] += z;
  }
  for (let i = 0; i < nrm.length; i += 3) {
    const x = nrm[i], y = nrm[i + 1], z = nrm[i + 2];
    const f = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    nrm[i] = x * f;
    nrm[i + 1] = y * f;
    nrm[i + 2] = z * f;
  }
  return nrm;
}

/** What a globe tile's mesh is built from. */
export interface GlobeTileShape extends TileId {
  /** The tile's centre (render world, float64): vertices are relative to it. */
  center: V3;
  /** Vertices per edge. */
  grid: number;
  /** Height of the surface (m; a little below sea level, under the terrain). */
  height: number;
}

export interface GlobeGeometry {
  position: Float32Array;
  normal: Float32Array;
  uv: Float32Array;
  index: Uint16Array;
}

const EARTH_CENTER = ecefToWorld([0, 0, 0]);

/** A globe tile's vertices: a grid on the ellipsoid, normals straight out from the Earth's centre. */
export function buildGlobeGeometry(t: GlobeTileShape): GlobeGeometry {
  const grid = t.grid;
  const pos = new Float32Array(grid * grid * 3);
  const nrm = new Float32Array(grid * grid * 3);
  const uv = new Float32Array(grid * grid * 2);
  const c = t.center;
  for (let j = 0; j < grid; j++) {
    const v = j / (grid - 1);
    const lat = tileYToLat(t.y + v, t.z);
    for (let i = 0; i < grid; i++) {
      const u = i / (grid - 1);
      const k = j * grid + i;
      const p = toWorld(lat, tileXToLon(t.x + u, t.z), t.height);
      pos[k * 3] = p[0] - c[0];
      pos[k * 3 + 1] = p[1] - c[1];
      pos[k * 3 + 2] = p[2] - c[2];
      const nx = p[0] - EARTH_CENTER[0], ny = p[1] - EARTH_CENTER[1], nz = p[2] - EARTH_CENTER[2];
      const l = Math.hypot(nx, ny, nz);
      nrm[k * 3] = nx / l;
      nrm[k * 3 + 1] = ny / l;
      nrm[k * 3 + 2] = nz / l;
      uv[k * 2] = u;
      uv[k * 2 + 1] = 1 - v;
    }
  }
  const index = new Uint16Array((grid - 1) * (grid - 1) * 6);
  let o = 0;
  for (let j = 0; j < grid - 1; j++) {
    for (let i = 0; i < grid - 1; i++) {
      const a = j * grid + i, b = a + 1, d = a + grid, e = d + 1;
      index[o++] = a; index[o++] = d; index[o++] = b;
      index[o++] = b; index[o++] = d; index[o++] = e;
    }
  }
  return { position: pos, normal: nrm, uv, index };
}

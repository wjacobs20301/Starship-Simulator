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
 * centimetres, grid x grid): its own or an ancestor's (at: that tile's place), sampled bilinearly.
 * A DEM tile that isn't there: 0 m.
 */
export function tileHeights(t: TileId, dem: Int16Array | null, at: TileId, grid: number): Float32Array {
  const GRID = TERRAIN_GRID;
  const out = flatHeights();
  if (!dem) return out;
  const G = grid;
  const scale = 2 ** (t.z - at.z);
  for (let j = 0; j < GRID; j++) {
    const gy = ((t.y + j / (GRID - 1)) / scale - at.y) * (G - 1);
    const y0 = Math.min(G - 2, Math.floor(gy));
    const fy = gy - y0;
    for (let i = 0; i < GRID; i++) {
      const gx = ((t.x + i / (GRID - 1)) / scale - at.x) * (G - 1);
      const x0 = Math.min(G - 2, Math.floor(gx));
      const fx = gx - x0;
      const h00 = dem[y0 * G + x0], h10 = dem[y0 * G + x0 + 1];
      const h01 = dem[(y0 + 1) * G + x0], h11 = dem[(y0 + 1) * G + x0 + 1];
      out[j * GRID + i] = ((h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy) / 100;
    }
  }
  return out;
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

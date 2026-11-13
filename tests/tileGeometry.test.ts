import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PAD } from '../src/sim/constants';
import type { V3 } from '../src/sim/math';
import { ecefToWorld, tileXToLon, tileYToLat, toWorld } from '../src/render/geo';
import { DEM_MARGIN, NO_HEIGHT, TERRAIN_GRID, type TerrainTileShape, buildGlobeGeometry, buildTerrainGeometry, cleanDem, demCellSize, despeckleWater, flatHeights, tileHeights, vertexNormals } from '../src/render/tileGeometry';

// The tile worker's geometry (src/render/tileGeometry.ts) against the code it replaced: what
// Terrain.build and GlobeTiles.build did on the main thread with three, kept here as it was.
// The arrays must come out the same to the last bit: the ground is shaded, lit and collided with
// from them.

const GRID = 33;

/** Terrain.heights as it was (the DEM tile handed in, not fetched). */
function oldHeights(t: { z: number; x: number; y: number }, dem: Int16Array | null, zd: number, dx: number, dy: number, G: number): Float32Array {
  const out = new Float32Array(GRID * GRID);
  if (!dem) return out;
  const scale = 2 ** (t.z - zd);
  for (let j = 0; j < GRID; j++) {
    const gy = ((t.y + j / (GRID - 1)) / scale - dy) * (G - 1);
    const y0 = Math.min(G - 2, Math.floor(gy));
    const fy = gy - y0;
    for (let i = 0; i < GRID; i++) {
      const gx = ((t.x + i / (GRID - 1)) / scale - dx) * (G - 1);
      const x0 = Math.min(G - 2, Math.floor(gx));
      const fx = gx - x0;
      const h00 = dem[y0 * G + x0], h10 = dem[y0 * G + x0 + 1];
      const h01 = dem[(y0 + 1) * G + x0], h11 = dem[(y0 + 1) * G + x0 + 1];
      out[j * GRID + i] = ((h00 * (1 - fx) + h10 * fx) * (1 - fy) + (h01 * (1 - fx) + h11 * fx) * fy) / 100;
    }
  }
  return out;
}

/** Terrain.build's geometry as it was. */
function oldTerrain(
  t: { z: number; x: number; y: number; center: V3; size: number },
  hts: Float32Array,
  off: [number, number],
  texScale: number,
  weight: number,
  fading: boolean,
): THREE.BufferGeometry {
  const n = GRID * GRID;
  const skirt = 4 * GRID - 4;
  const pos = new Float32Array((n + skirt) * 3);
  const uv = new Float32Array((n + skirt) * 2);
  const hAttr = new Float32Array(n + skirt);
  const en = new Float32Array((n + skirt) * 2);
  const waterWeight = new Float32Array(n + skirt).fill(weight);
  const c = t.center;
  for (let j = 0; j < GRID; j++) {
    const v = j / (GRID - 1);
    const lat = tileYToLat(t.y + v, t.z);
    for (let i = 0; i < GRID; i++) {
      const u = i / (GRID - 1);
      const k = j * GRID + i;
      const h = hts[k];
      const w = toWorld(lat, tileXToLon(t.x + u, t.z), h);
      pos.set([w[0] - c[0], w[1] - c[1], w[2] - c[2]], k * 3);
      uv.set([off[0] + u * texScale, 1 - (off[1] + v * texScale)], k * 2);
      hAttr[k] = h - PAD.groundAlt;
      en.set([w[0], -w[2]], k * 2);
    }
  }
  const drop = Math.max(2, t.size * 0.02);
  const edge: number[] = [];
  for (let i = 0; i < GRID; i++) edge.push(i);
  for (let j = 1; j < GRID; j++) edge.push(j * GRID + GRID - 1);
  for (let i = GRID - 2; i >= 0; i--) edge.push((GRID - 1) * GRID + i);
  for (let j = GRID - 2; j >= 1; j--) edge.push(j * GRID);
  edge.forEach((src, s) => {
    const k = n + s;
    pos.set([pos[src * 3], pos[src * 3 + 1] - drop, pos[src * 3 + 2]], k * 3);
    uv.set([uv[src * 2], uv[src * 2 + 1]], k * 2);
    hAttr[k] = hAttr[src];
    en.set([en[src * 2], en[src * 2 + 1]], k * 2);
  });
  const idx: number[] = [];
  for (let j = 0; j < GRID - 1; j++) {
    for (let i = 0; i < GRID - 1; i++) {
      const a = j * GRID + i, b = a + 1, d = a + GRID, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
  }
  const surfaceCount = idx.length;
  for (let s = 0; s < (fading ? 0 : edge.length); s++) {
    const a = edge[s], b = edge[(s + 1) % edge.length];
    const a2 = n + s, b2 = n + ((s + 1) % edge.length);
    idx.push(a, b, a2, b, b2, a2, a, a2, b, b, a2, b2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aHeight', new THREE.BufferAttribute(hAttr, 1));
  g.setAttribute('aEN', new THREE.BufferAttribute(en, 2));
  g.setAttribute('aWaterWeight', new THREE.BufferAttribute(waterWeight, 1));
  g.setIndex(idx.slice(0, surfaceCount));
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  edge.forEach((src, s) => nrm.setXYZ(n + s, nrm.getX(src), nrm.getY(src), nrm.getZ(src)));
  g.setIndex(idx);
  return g;
}

/** The terrain Tile's centre and size as terrain.ts works them out. */
function tileFrame(z: number, x: number, y: number): { center: V3; size: number } {
  const a = toWorld(tileYToLat(y, z), tileXToLon(x, z), 0);
  const b = toWorld(tileYToLat(y + 1, z), tileXToLon(x + 1, z), 0);
  return { center: toWorld(tileYToLat(y + 0.5, z), tileXToLon(x + 0.5, z), 0), size: Math.hypot(b[0] - a[0], b[2] - a[2]) / Math.SQRT2 };
}

/** The tile holding the pad at a zoom, moved over by dx, dy tiles. */
function tileAt(z: number, dx = 0, dy = 0): { z: number; x: number; y: number } {
  const lat = (PAD.latDeg * Math.PI) / 180;
  return {
    z,
    x: Math.floor(((PAD.lonDeg + 180) / 360) * 2 ** z) + dx,
    y: Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * 2 ** z) + dy,
  };
}

/** A DEM tile of made-up ground: dunes, a channel below sea level, some roughness (Int16 cm). */
function fakeDem(G: number, seed: number): Int16Array {
  const out = new Int16Array(G * G);
  let s = seed >>> 0;
  for (let j = 0; j < G; j++) {
    for (let i = 0; i < G; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      const h = 180 * Math.sin(i / 9) * Math.cos(j / 13) + 300 * Math.sin((i + 2 * j) / 31) - 120 + (s / 2 ** 32) * 40;
      out[j * G + i] = Math.round(h);
    }
  }
  return out;
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>, what: string) => {
  expect(a.length, `${what}: length`).toBe(b.length);
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) throw new Error(`${what}[${i}]: ${a[i]} != ${b[i]}`);
};

describe('terrain tile geometry', () => {
  const G = 129;
  // A fine tile on its own DEM tile; one finer than the DEM goes (heights from an ancestor two
  // levels up); a fading one at the region's edge (no skirts); one borrowing an ancestor's image.
  const cases = [
    { name: 'own DEM, own image', t: tileAt(15), up: 0, off: [0, 0] as [number, number], scale: 1, weight: 1, fading: false },
    { name: 'ancestor DEM', t: tileAt(17, 1, -2), up: 2, off: [0, 0] as [number, number], scale: 1, weight: 1, fading: false },
    { name: 'fading, coarse', t: tileAt(11, 1, 0), up: 0, off: [0, 0] as [number, number], scale: 1, weight: 0, fading: true },
    { name: 'borrowed image', t: tileAt(16, 3, 1), up: 1, off: [0.25, 0.5] as [number, number], scale: 0.25, weight: 0, fading: false },
    { name: 'open sea', t: tileAt(14, 9, 4), up: -1, off: [0, 0] as [number, number], scale: 1, weight: 2, fading: false },
  ];

  for (const c of cases) {
    it(`matches the main-thread build: ${c.name}`, () => {
      const { t } = c;
      const frame = tileFrame(t.z, t.x, t.y);
      const dem = c.up < 0 ? null : fakeDem(G, t.z * 7 + t.x);
      const at = { z: t.z - Math.max(0, c.up), x: t.x >> Math.max(0, c.up), y: t.y >> Math.max(0, c.up) };

      const hNew = dem ? tileHeights(t, dem, at, G) : flatHeights();
      // (As fine as its DEM: point for point as it was. Coarser: each point an average now,
      // below; the mesh built from those heights is still the old one's.)
      const hOld = c.up >= 2 || !dem ? oldHeights(t, dem, at.z, at.x, at.y, G) : hNew;
      same(hNew, hOld, 'heights');
      if (dem) expect(Math.max(...hNew) - Math.min(...hNew)).toBeGreaterThan(0.5);

      const old = oldTerrain({ ...t, ...frame }, hOld, c.off, c.scale, c.weight, c.fading);
      const shape: TerrainTileShape = {
        ...t,
        center: frame.center,
        drop: Math.max(2, frame.size * 0.02),
        skirts: !c.fading,
        uvOff: c.off,
        uvScale: c.scale,
        waterWeight: c.weight,
      };
      const geo = buildTerrainGeometry(shape, hNew);
      same(geo.position, old.getAttribute('position').array, 'position');
      same(geo.uv, old.getAttribute('uv').array, 'uv');
      same(geo.aHeight, old.getAttribute('aHeight').array, 'aHeight');
      same(geo.aEN, old.getAttribute('aEN').array, 'aEN');
      same(geo.aWaterWeight, old.getAttribute('aWaterWeight').array, 'aWaterWeight');
      same(geo.normal, old.getAttribute('normal').array, 'normal');
      same(geo.index, old.index!.array, 'index');
      // (three made the index 16-bit too: the same buffer type on the GPU.)
      expect(old.index!.array).toBeInstanceOf(Uint16Array);
      expect(geo.index).toBeInstanceOf(Uint16Array);

      // And it's a sane tile: the grid plus a ring of skirt vertices, normals unit and upward.
      const n = TERRAIN_GRID * TERRAIN_GRID;
      expect(geo.position.length).toBe((n + 4 * TERRAIN_GRID - 4) * 3);
      expect(geo.index.length).toBe(32 * 32 * 6 + (c.fading ? 0 : 128 * 12));
      for (let i = 0; i < geo.normal.length; i += 3) {
        expect(Math.hypot(geo.normal[i], geo.normal[i + 1], geo.normal[i + 2])).toBeCloseTo(1, 5);
        expect(geo.normal[i + 1]).toBeGreaterThan(0.5);
      }
    });
  }

  it('makes the normals three makes, on any mesh', () => {
    // A lumpy grid with every triangle, against computeVertexNormals.
    const N = 9;
    const pos = new Float32Array(N * N * 3);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) pos.set([i * 1.3, Math.sin(i * 1.7) * Math.cos(j * 0.9) * 2, j * 0.8], (j * N + i) * 3);
    const idx: number[] = [];
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) idx.push(j * N + i, (j + 1) * N + i, j * N + i + 1, j * N + i + 1, (j + 1) * N + i, (j + 1) * N + i + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos.slice(), 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    same(vertexNormals(pos, Uint16Array.from(idx), idx.length), g.getAttribute('normal').array, 'normal');
  });
});

describe('globe tile geometry', () => {
  /** GlobeTiles.build's geometry as it was. */
  function oldGlobe(t: { z: number; x: number; y: number; center: V3 }, sink: number) {
    const EARTH_CENTER = ecefToWorld([0, 0, 0]);
    const grid = t.z <= 2 ? 129 : 33;
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
        const p = toWorld(lat, tileXToLon(t.x + u, t.z), sink);
        pos.set([p[0] - c[0], p[1] - c[1], p[2] - c[2]], k * 3);
        const n = [p[0] - EARTH_CENTER[0], p[1] - EARTH_CENTER[1], p[2] - EARTH_CENTER[2]];
        const l = Math.hypot(n[0], n[1], n[2]);
        nrm.set([n[0] / l, n[1] / l, n[2] / l], k * 3);
        uv.set([u, 1 - v], k * 2);
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < grid - 1; j++) {
      for (let i = 0; i < grid - 1; i++) {
        const a = j * grid + i, b = a + 1, d = a + grid, e = d + 1;
        idx.push(a, d, b, b, d, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(idx);
    return g;
  }

  for (const t of [{ z: 0, x: 0, y: 0 }, { z: 2, x: 1, y: 1 }, tileAt(5), tileAt(7, -1, 1)]) {
    it(`matches the main-thread build: ${t.z}/${t.x}/${t.y}`, () => {
      // (The centre as GlobeTile takes it: the middle of a 3 x 3 sample.)
      const center = toWorld(tileYToLat(t.y + 0.5, t.z), tileXToLon(t.x + 0.5, t.z), 0);
      const old = oldGlobe({ ...t, center }, -40);
      const geo = buildGlobeGeometry({ ...t, center, grid: t.z <= 2 ? 129 : 33, height: -40 });
      same(geo.position, old.getAttribute('position').array, 'position');
      same(geo.normal, old.getAttribute('normal').array, 'normal');
      same(geo.uv, old.getAttribute('uv').array, 'uv');
      same(geo.index, old.index!.array, 'index');
      expect(old.index!.array).toBeInstanceOf(Uint16Array);
    });
  }
});

// The survey's open water is flat at 0 m but for returns off wave crests: specks 20 to 40 cm up,
// over the level the ground shows through at. Each detail level has its own, so they drew as pale
// patches in the sea that came and went as the camera zoomed.
describe('specks in the water', () => {
  const G = 129;
  /** Flat water with `cells` raised to `cm` (each [i, j]). */
  const water = (cells: [number, number][], cm: number): Int16Array => {
    const d = new Int16Array(G * G);
    for (const [i, j] of cells) d[j * G + i] = cm;
    return d;
  };
  const block = (i0: number, j0: number, w: number, h: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let j = j0; j < j0 + h; j++) for (let i = i0; i < i0 + w; i++) out.push([i, j]);
    return out;
  };
  const land = (d: Int16Array) => d.reduce((n, v) => n + (v > 13 ? 1 : 0), 0);

  it('sizes a height tile\'s cells', () => {
    // (Boca Chica, level 16: 4.3 m.)
    expect(demCellSize({ z: 16, x: 15082, y: 27862 }, G)).toBeCloseTo(4.29, 1);
    expect(demCellSize({ z: 13, x: 1885, y: 3482 }, G)).toBeCloseTo(34.4, 0);
  });

  it('takes out a wave crest: a few low cells with water all round', () => {
    const d = water([...block(40, 40, 1, 6), ...block(90, 20, 3, 3)], 34);
    despeckleWater(d, G, 4.3);
    expect(land(d)).toBe(0);
  });

  it('leaves an island: as small, but standing higher', () => {
    const d = water(block(40, 40, 3, 3), 34);
    d[41 * G + 41] = 140;
    despeckleWater(d, G, 4.3);
    expect(land(d)).toBe(9);
  });

  it('leaves a shoal: low, but broad', () => {
    const d = water(block(30, 30, 24, 24), 28);
    despeckleWater(d, G, 4.3);
    expect(land(d)).toBe(576);
  });

  it('takes out a broader patch only if it is low', () => {
    const low = water(block(30, 30, 12, 12), 45);
    const high = water(block(30, 30, 12, 12), 58);
    despeckleWater(low, G, 4.3);
    despeckleWater(high, G, 4.3);
    expect(land(low)).toBe(0);
    expect(land(high)).toBe(144);
  });

  it('leaves what runs off the tile, the next tile having the rest, unless it barely shows', () => {
    const d = water([...block(0, 50, 2, 2), ...block(60, 127, 2, 2)], 40);
    despeckleWater(d, G, 4.3);
    expect(land(d)).toBe(8);
    const faint = water([...block(0, 50, 2, 2), ...block(60, 127, 2, 2)], 24);
    despeckleWater(faint, G, 4.3);
    expect(land(faint)).toBe(0);
    // (A low shore running along the edge is no speck.)
    const shore = water(block(0, 10, 2, 100), 24);
    despeckleWater(shore, G, 4.3);
    expect(land(shore)).toBe(200);
  });

  it('at a coarse level takes single cells only', () => {
    const d = water([[20, 20], ...block(60, 60, 2, 1)], 30);
    despeckleWater(d, G, 69);
    expect(d[20 * G + 20]).toBe(0);
    expect(land(d)).toBe(2);
    // (Level 14: a patch of a few cells, if low.)
    const mid = water(block(60, 60, 4, 4), 40);
    despeckleWater(mid, G, 17.2);
    expect(land(mid)).toBe(0);
  });

  it('leaves the shore and the land alone', () => {
    const d = new Int16Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) d[j * G + i] = i > 64 ? 20 + ((i * 7 + j * 3) % 90) : 0;
    const before = d.slice();
    despeckleWater(d, G, 4.3);
    expect(d).toEqual(before);
  });
});

// A mesh coarser than its DEM takes each point as the average of the cells round it: taken at
// the point alone, a shore moved each time the ground changed detail.
describe('heights for a mesh coarser than the DEM', () => {
  const G = 129;
  const t = { z: 16, x: 15082, y: 27862 };

  it('leaves a plane as it is', () => {
    const dem = Int16Array.from({ length: G * G }, (_, k) => 3 * (k % G) + 5 * Math.floor(k / G));
    const h = tileHeights(t, dem, t, G);
    // (Away from the tile's edge, where there's nothing past it to average with.)
    for (const [i, j] of [[1, 1], [16, 16], [31, 20]]) expect(h[j * 33 + i]).toBeCloseTo((3 * 4 * i + 5 * 4 * j) / 100, 5);
  });

  it('sees a bank between its points', () => {
    // (A bank one cell wide, 2 m high, running between two columns of points.)
    const dem = new Int16Array(G * G);
    for (let j = 0; j < G; j++) dem[j * G + 42] = 200;
    const h = tileHeights(t, dem, t, G);
    expect(h[16 * 33 + 10]).toBeCloseTo((2 * 2) / 16, 5);
    expect(h[16 * 33 + 11]).toBeCloseTo((2 * 2) / 16, 5);
    expect(h[16 * 33 + 9]).toBe(0);
  });

  it('makes the same of a shore at either detail', () => {
    // (A shore running at a slant: water 0, land 1 m. The level-17 tiles over the same ground,
    // a point every other cell, put the half-metre line within a cell of where the level-16 one does.)
    const dem = Int16Array.from({ length: G * G }, (_, k) => ((k % G) + 0.37 * Math.floor(k / G) > 30.3 ? 100 : 0));
    const coarse = tileHeights(t, dem, t, G);
    const fine = tileHeights({ z: 17, x: t.x * 2, y: t.y * 2 }, dem, t, G);
    // (Along a row of each: where the height crosses 0.5 m, in cells.)
    const crossing = (h: Float32Array, row: number, step: number): number => {
      for (let i = 1; i < 33; i++) {
        const a = h[row * 33 + i - 1], b = h[row * 33 + i];
        if (a < 0.5 && b >= 0.5) return (i - 1 + (0.5 - a) / (b - a)) * step;
      }
      return NaN;
    };
    for (const row of [4, 8, 12]) expect(Math.abs(crossing(coarse, row, 4) - crossing(fine, row * 2, 2))).toBeLessThan(1);
  });

  it('reads past the tile into its margin', () => {
    const m = DEM_MARGIN, S = G + 2 * m;
    const wide = Int16Array.from({ length: S * S }, (_, k) => 3 * ((k % S) - m) + 5 * (Math.floor(k / S) - m));
    const h = tileHeights(t, wide, t, G, m);
    expect(h[0]).toBeCloseTo(0, 5);
    expect(h[32 * 33 + 32]).toBeCloseTo((3 * 128 + 5 * 128) / 100, 5);
  });
});

// A DEM tile made ready with its neighbours round it: specks across its edges judged whole, the
// tiles to either side of an edge agreeing, shores without their stairs.
describe('a DEM tile with its neighbours', () => {
  const G = 129, m = DEM_MARGIN, S = G + 2 * m;
  const at = (d: Int16Array, i: number, j: number) => d[(j + m) * S + i + m];
  const flat = (v = 0) => new Int16Array(G * G).fill(v);
  const sea = () => Array.from({ length: 8 }, () => flat());

  it('takes out a speck lying across its edge', () => {
    // (Three cells of it in this tile, three in the tile to the east: column 128 here is column 0 there.)
    const c = flat(), e = flat();
    for (const i of [126, 127, 128]) c[40 * G + i] = 40;
    for (const i of [0, 1, 2]) e[40 * G + i] = 40;
    const ring = sea();
    ring[4] = e;
    const out = cleanDem(c, ring, G, 4.3);
    for (let i = 120; i <= 132; i++) expect(at(out, i, 40)).toBe(0);
  });

  it('leaves the tip of a shore that comes in over its edge', () => {
    const c = flat(), e = flat(150);
    for (let j = 0; j < G; j++) for (const i of [126, 127, 128]) c[j * G + i] = 150;
    const ring = sea();
    ring[2] = ring[4] = ring[7] = e;
    const out = cleanDem(c, ring, G, 4.3);
    expect(at(out, 127, 40)).toBe(150);
    expect(at(out, 130, 40)).toBe(150);
  });

  it('agrees with the tile next door along their edge', () => {
    const noise = (seed: number) => Int16Array.from({ length: G * G }, (_, k) => Math.round(30 + 40 * Math.sin((k % G) / 3 + seed) * Math.cos(Math.floor(k / G) / 4 + seed)));
    const a = noise(1), b = noise(2);
    // (They share the edge's cells.)
    for (let j = 0; j < G; j++) b[j * G] = a[j * G + G - 1];
    const none = Array(8).fill(null) as (Int16Array | null)[];
    const ra = none.slice(), rb = none.slice();
    ra[4] = b;
    rb[3] = a;
    const ca = cleanDem(a, ra, G, 4.3), cb = cleanDem(b, rb, G, 4.3);
    // (Away from the corners, where each has a neighbour the other hasn't.)
    for (let j = 8; j < G - 8; j++) for (let d = -m; d <= m; d++) expect(at(ca, G - 1 + d, j)).toBe(at(cb, d, j));
  });

  it('takes the stairs out of a shore, and leaves it where it was', () => {
    // (Water 0, land 40 cm, the shore one cell further east every three rows.)
    const c = Int16Array.from({ length: G * G }, (_, k) => ((k % G) > 40 + Math.floor(Math.floor(k / G) / 3) ? 40 : 0));
    const out = cleanDem(c, sea(), G, 4.3);
    // (Where each row crosses 20 cm, the middle of the band: a third of a cell on from the row before.)
    const cross = (j: number): number => {
      for (let i = 1; i < G; i++) {
        const a = at(out, i - 1, j), b = at(out, i, j);
        if (a < 20 && b >= 20) return i - 1 + (20 - a) / (b - a);
      }
      return NaN;
    };
    for (let j = 31; j < 60; j++) {
      expect(cross(j) - cross(j - 1)).toBeGreaterThan(0.1);
      expect(cross(j) - cross(j - 1)).toBeLessThan(0.6);
      // (The stairs' own line: half a cell past the last water cell, on average.)
      expect(Math.abs(cross(j) - (40.5 + (j - 1) / 3))).toBeLessThan(0.75);
    }
  });

  it('leaves ground above the band as surveyed, and deep water', () => {
    const c = Int16Array.from({ length: G * G }, (_, k) => ((k % G) < 30 ? -60 : (k % G) < 60 ? 0 : 60 + ((k * 7) % 300)));
    const out = cleanDem(c, sea(), G, 4.3);
    for (let j = 0; j < G; j += 7) {
      for (let i = 60; i < G; i += 5) expect(at(out, i, j)).toBe(c[j * G + i]);
      for (let i = 0; i < 30; i += 5) expect(at(out, i, j)).toBe(-60);
    }
    // (A sea wall doesn't lift the water beside it over the level it shows at.)
    expect(at(out, 58, 40)).toBeLessThanOrEqual(13);
    expect(NO_HEIGHT).toBe(-32768);
  });
});

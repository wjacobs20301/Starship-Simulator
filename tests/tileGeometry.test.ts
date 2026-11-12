import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { PAD } from '../src/sim/constants';
import type { V3 } from '../src/sim/math';
import { ecefToWorld, tileXToLon, tileYToLat, toWorld } from '../src/render/geo';
import { TERRAIN_GRID, type TerrainTileShape, buildGlobeGeometry, buildTerrainGeometry, flatHeights, tileHeights, vertexNormals } from '../src/render/tileGeometry';

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

      const hOld = oldHeights(t, dem, at.z, at.x, at.y, G);
      const hNew = dem ? tileHeights(t, dem, at, G) : flatHeights();
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

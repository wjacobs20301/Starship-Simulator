// The noise the clouds are made of: a tiling 64^3 volume, generated once at start-up.
//   R: "Perlin-Worley" billows (cloud shapes: puffy, with rounded tops);
//   G: finer Worley noise (erodes the edges into wisps).
// (Twice as fine, 128^3, was tried: no better to look at, close up or far.)
// The same data can be sampled on the CPU (sample).

import * as THREE from 'three';

export const NOISE_SIZE = 64;

/** Deterministic hash -> 0..1 (so the weather is the same every run). */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + z * 2147483647 + seed * 144269504) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

/**
 * Tiling Worley (cellular) noise, `cells` per side: 1 at the feature points, 0 far from them.
 * Returns a function of a point in cell units (0..cells). (The feature points worked out once,
 * not hashed again for each of the 27 cells round every texel: most of a second at start-up.)
 */
function worley(cells: number, seed: number): (px: number, py: number, pz: number) => number {
  const pts = new Float64Array(cells * cells * cells * 3);
  for (let z = 0; z < cells; z++) {
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < cells; x++) {
        const o = ((z * cells + y) * cells + x) * 3;
        pts[o] = hash3(x, y, z, seed);
        pts[o + 1] = hash3(x, y, z, seed + 1);
        pts[o + 2] = hash3(x, y, z, seed + 2);
      }
    }
  }
  // (The point's own cell first, then only the neighbours that reach nearer than the nearest
  // point found so far: most don't.)
  const ORDER = [0, -1, 1];
  return (px, py, pz) => {
    const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
    const rx = px - cx, ry = py - cy, rz = pz - cz;
    let best = 9;
    for (let a = 0; a < 3; a++) {
      const dz = ORDER[a];
      const az = dz < 0 ? rz : dz > 0 ? 1 - rz : 0;
      if (az * az >= best) continue;
      const gz = cz + dz;
      const oz = (gz < 0 ? gz + cells : gz >= cells ? gz - cells : gz) * cells;
      for (let b = 0; b < 3; b++) {
        const dy = ORDER[b];
        const ay = dy < 0 ? ry : dy > 0 ? 1 - ry : 0;
        const ayz = az * az + ay * ay;
        if (ayz >= best) continue;
        const gy = cy + dy;
        const oy = (oz + (gy < 0 ? gy + cells : gy >= cells ? gy - cells : gy)) * cells;
        for (let c = 0; c < 3; c++) {
          const dx = ORDER[c];
          const ax = dx < 0 ? rx : dx > 0 ? 1 - rx : 0;
          if (ayz + ax * ax >= best) continue;
          const gx = cx + dx;
          const o = (oy + (gx < 0 ? gx + cells : gx >= cells ? gx - cells : gx)) * 3;
          const fx = gx + pts[o] - px;
          const fy = gy + pts[o + 1] - py;
          const fz = gz + pts[o + 2] - pz;
          const d = fx * fx + fy * fy + fz * fz;
          if (d < best) best = d;
        }
      }
    }
    return 1 - Math.min(1, Math.sqrt(best));
  };
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * Tiling gradient (Perlin-style) noise, `period` lattice cells per side, about -1..1. Returns a
 * function of a point in lattice units.
 */
function perlin(period: number, seed: number): (px: number, py: number, pz: number) => number {
  const grads = new Uint8Array(period * period * period);
  for (let z = 0; z < period; z++) {
    for (let y = 0; y < period; y++) {
      for (let x = 0; x < period; x++) grads[(z * period + y) * period + x] = Math.floor(hash3(x, y, z, seed) * 12);
    }
  }
  // (Each gradient's three components, flat.)
  const G = new Float64Array(12 * 3);
  GRADS.forEach((g, i) => G.set(g, i * 3));
  return (px, py, pz) => {
    const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
    const fx = px - x0, fy = py - y0, fz = pz - z0;
    const u = fade(fx), v = fade(fy), w = fade(fz);
    const xa = mod(x0, period), xb = mod(x0 + 1, period);
    const ya = mod(y0, period) * period, yb = mod(y0 + 1, period) * period;
    const za = mod(z0, period) * period * period, zb = mod(z0 + 1, period) * period * period;
    // (The corners in the order the sums were always taken in: the same values to the last bit.)
    let g = grads[za + ya + xa] * 3;
    const c000 = G[g] * fx + G[g + 1] * fy + G[g + 2] * fz;
    g = grads[za + ya + xb] * 3;
    const c100 = G[g] * (fx - 1) + G[g + 1] * fy + G[g + 2] * fz;
    g = grads[za + yb + xa] * 3;
    const c010 = G[g] * fx + G[g + 1] * (fy - 1) + G[g + 2] * fz;
    g = grads[za + yb + xb] * 3;
    const c110 = G[g] * (fx - 1) + G[g + 1] * (fy - 1) + G[g + 2] * fz;
    g = grads[zb + ya + xa] * 3;
    const c001 = G[g] * fx + G[g + 1] * fy + G[g + 2] * (fz - 1);
    g = grads[zb + ya + xb] * 3;
    const c101 = G[g] * (fx - 1) + G[g + 1] * fy + G[g + 2] * (fz - 1);
    g = grads[zb + yb + xa] * 3;
    const c011 = G[g] * fx + G[g + 1] * (fy - 1) + G[g + 2] * (fz - 1);
    g = grads[zb + yb + xb] * 3;
    const c111 = G[g] * (fx - 1) + G[g + 1] * (fy - 1) + G[g + 2] * (fz - 1);
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0v = x00 + (x10 - x00) * v, y1v = x01 + (x11 - x01) * v;
    return y0v + (y1v - y0v) * w;
  };
}
const GRADS = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0], [1, 0, 1], [-1, 0, 1],
  [1, 0, -1], [-1, 0, -1], [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

const remap = (v: number, a: number, b: number, c: number, d: number) => c + ((v - a) / (b - a)) * (d - c);

export class CloudNoise {
  readonly texture: THREE.Data3DTexture;
  private data: Uint8Array;

  constructor() {
    const N = NOISE_SIZE;
    const data = new Uint8Array(N * N * N * 2);
    const p4 = perlin(4, 1), p8 = perlin(8, 2), p16 = perlin(16, 3);
    const s4 = worley(4, 11), s8 = worley(8, 12), s16 = worley(16, 13);
    const d8 = worley(8, 21), d16 = worley(16, 22), d32 = worley(32, 23);
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = i / N, y = j / N, z = k / N;
          // Billows: Perlin fBm, pinched into rounded cells by Worley fBm.
          const p = 0.5 + 0.5 * (p4(x * 4, y * 4, z * 4) * 0.6 + p8(x * 8, y * 8, z * 8) * 0.3 + p16(x * 16, y * 16, z * 16) * 0.15);
          const w1 = s4(x * 4, y * 4, z * 4) * 0.625 + s8(x * 8, y * 8, z * 8) * 0.25 + s16(x * 16, y * 16, z * 16) * 0.125;
          const shape = Math.min(1, Math.max(0, remap(p, w1 - 1, 1, 0, 1)));
          const detail = d8(x * 8, y * 8, z * 8) * 0.625 + d16(x * 16, y * 16, z * 16) * 0.25 + d32(x * 32, y * 32, z * 32) * 0.125;
          const o = ((k * N + j) * N + i) * 2;
          data[o] = Math.round(shape * 255);
          data[o + 1] = Math.round(detail * 255);
        }
      }
    }
    this.data = data;
    const tex = new THREE.Data3DTexture(data, N, N, N);
    tex.format = THREE.RGFormat;
    tex.type = THREE.UnsignedByteType;
    // Mipmapped: seen from far off, the fine detail is averaged, not sampled sparsely (which
    // shimmers as the view moves); the shaders pick the level for each sample's distance.
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    this.texture = tex;
  }

  /** Trilinear sample (repeating) of a channel (0 = shape, 1 = detail), 0..1. */
  sample(x: number, y: number, z: number, channel: 0 | 1): number {
    const N = NOISE_SIZE;
    const fx = x * N - 0.5, fy = y * N - 0.5, fz = z * N - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), z0 = Math.floor(fz);
    const tx = fx - x0, ty = fy - y0, tz = fz - z0;
    const at = (i: number, j: number, k: number) => this.data[((mod(k, N) * N + mod(j, N)) * N + mod(i, N)) * 2 + channel] / 255;
    const l = (a: number, b: number, t: number) => a + (b - a) * t;
    return l(
      l(l(at(x0, y0, z0), at(x0 + 1, y0, z0), tx), l(at(x0, y0 + 1, z0), at(x0 + 1, y0 + 1, z0), tx), ty),
      l(l(at(x0, y0, z0 + 1), at(x0 + 1, y0, z0 + 1), tx), l(at(x0, y0 + 1, z0 + 1), at(x0 + 1, y0 + 1, z0 + 1), tx), ty),
      tz,
    );
  }
}

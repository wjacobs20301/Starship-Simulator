// The noise the clouds are made of: a tiling 64^3 volume, generated once at start-up.
//   R: "Perlin-Worley" billows (cloud shapes: puffy, with rounded tops);
//   G: finer Worley noise (erodes the edges into wisps).
// The same data is sampled on the CPU (cloudAt) so the game knows how cloudy it is where the
// camera is: for rain, and dimming the sunlight under overcast.

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

/** Tiling Worley (cellular) noise, `cells` per side: 1 at the feature points, 0 far from them. */
function worley(x: number, y: number, z: number, cells: number, seed: number): number {
  const px = x * cells, py = y * cells, pz = z * cells;
  const cx = Math.floor(px), cy = Math.floor(py), cz = Math.floor(pz);
  let best = 9;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const gx = cx + dx, gy = cy + dy, gz = cz + dz;
        const wx = mod(gx, cells), wy = mod(gy, cells), wz = mod(gz, cells);
        const fx = gx + hash3(wx, wy, wz, seed) - px;
        const fy = gy + hash3(wx, wy, wz, seed + 1) - py;
        const fz = gz + hash3(wx, wy, wz, seed + 2) - pz;
        const d = fx * fx + fy * fy + fz * fz;
        if (d < best) best = d;
      }
    }
  }
  return 1 - Math.min(1, Math.sqrt(best));
}

/** Tiling gradient (Perlin-style) noise, `period` lattice cells per side, about -1..1. */
function perlin(x: number, y: number, z: number, period: number, seed: number): number {
  const px = x * period, py = y * period, pz = z * period;
  const x0 = Math.floor(px), y0 = Math.floor(py), z0 = Math.floor(pz);
  const fx = px - x0, fy = py - y0, fz = pz - z0;
  const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
  const grad = (ix: number, iy: number, iz: number, dx: number, dy: number, dz: number) => {
    const h = Math.floor(hash3(mod(ix, period), mod(iy, period), mod(iz, period), seed) * 12);
    const g = GRADS[h];
    return g[0] * dx + g[1] * dy + g[2] * dz;
  };
  const u = fade(fx), v = fade(fy), w = fade(fz);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const c = (i: number, j: number, k: number) => grad(x0 + i, y0 + j, z0 + k, fx - i, fy - j, fz - k);
  return lerp(
    lerp(lerp(c(0, 0, 0), c(1, 0, 0), u), lerp(c(0, 1, 0), c(1, 1, 0), u), v),
    lerp(lerp(c(0, 0, 1), c(1, 0, 1), u), lerp(c(0, 1, 1), c(1, 1, 1), u), v),
    w,
  );
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
    for (let k = 0; k < N; k++) {
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = i / N, y = j / N, z = k / N;
          // Billows: Perlin fBm, pinched into rounded cells by Worley fBm.
          const p = 0.5 + 0.5 * (perlin(x, y, z, 4, 1) * 0.6 + perlin(x, y, z, 8, 2) * 0.3 + perlin(x, y, z, 16, 3) * 0.15);
          const w1 = worley(x, y, z, 4, 11) * 0.625 + worley(x, y, z, 8, 12) * 0.25 + worley(x, y, z, 16, 13) * 0.125;
          const shape = Math.min(1, Math.max(0, remap(p, w1 - 1, 1, 0, 1)));
          const detail = worley(x, y, z, 8, 21) * 0.625 + worley(x, y, z, 16, 22) * 0.25 + worley(x, y, z, 32, 23) * 0.125;
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

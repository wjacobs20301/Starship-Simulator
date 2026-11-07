// Seeded 3D gradient (Perlin) noise for the weather model: pure, no DOM, so the same weather
// comes out in the render thread, the bake worker, the physics worker and the tests.

/** A small fast PRNG (mulberry32): 0..1. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer hash of a few numbers (for seeding per system, per time slot). */
export function hashInts(...xs: number[]): number {
  let h = 0x811c9dc5;
  for (const x of xs) {
    h ^= x | 0;
    h = Math.imul(h, 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
  }
  return h >>> 0;
}

const GX = new Float32Array([1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0, 1, 0, -1, 0]);
const GY = new Float32Array([1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1, 1, -1, 1, -1]);
const GZ = new Float32Array([0, 0, 0, 0, 1, 1, -1, -1, 1, 1, -1, -1, 0, 1, 0, -1]);

function grad(h: number, dx: number, dy: number, dz: number): number {
  const k = h & 15;
  return GX[k] * dx + GY[k] * dy + GZ[k] * dz;
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export class Noise3 {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const r = rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** About -1..1 (mostly within +-0.7). */
  get(x: number, y: number, z: number): number {
    const P = this.perm;
    const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z);
    const X = xf & 255, Y = yf & 255, Z = zf & 255;
    x -= xf;
    y -= yf;
    z -= zf;
    const u = x * x * x * (x * (x * 6 - 15) + 10);
    const v = y * y * y * (y * (y * 6 - 15) + 10);
    const w = z * z * z * (z * (z * 6 - 15) + 10);
    const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z;
    const B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
    return lerp(
      lerp(lerp(grad(P[AA], x, y, z), grad(P[BA], x - 1, y, z), u), lerp(grad(P[AB], x, y - 1, z), grad(P[BB], x - 1, y - 1, z), u), v),
      lerp(lerp(grad(P[AA + 1], x, y, z - 1), grad(P[BA + 1], x - 1, y, z - 1), u), lerp(grad(P[AB + 1], x, y - 1, z - 1), grad(P[BB + 1], x - 1, y - 1, z - 1), u), v),
      w,
    );
  }

  /** Fractal sum of `oct` octaves, about -1..1. */
  fbm(x: number, y: number, z: number, oct: number): number {
    let s = 0;
    let a = 0.5;
    let n = 0;
    for (let o = 0; o < oct; o++) {
      s += a * this.get(x, y, z);
      n += a;
      x = x * 2.03 + 17.1;
      y = y * 2.03 + 3.7;
      z = z * 2.03 + 9.2;
      a *= 0.5;
    }
    return s / n;
  }
}

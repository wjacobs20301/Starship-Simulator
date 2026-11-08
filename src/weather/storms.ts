// Thunderstorm cells, one by one (cumulonimbus): where the weather has deep convection, cells on
// a jittered grid STORM_GRID apart over a cube's faces (Earth-fixed), each its own size, height
// and stage. The renderer draws them (atmosphere.ts: findStormCells, the same hash and layout);
// the lightning strikes in them.

export const STORM_GRID = 60000;

/** The same integer hash as the shader's stormHash. */
export function stormHash(f: number, i: number, j: number, k: number): number {
  let x = (Math.imul(i, 0x8da6b343) ^ Math.imul(j, 0xd8163841) ^ Math.imul((k + f * 16) >>> 0, 0xcb1ab31f)) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
export const stormRand = (f: number, i: number, j: number, k: number) => (stormHash(f, i, j, k) >>> 8) / 16777216;

/** A unit vector's (Earth-fixed) cube face and its place on it (m, gnomonic, on a sphere of radius R). */
export function stormFace(e: readonly number[], R: number): [number, number, number] {
  const ax = Math.abs(e[0]), ay = Math.abs(e[1]), az = Math.abs(e[2]);
  if (ax >= ay && ax >= az) return [e[0] > 0 ? 0 : 1, (e[1] / ax) * R, (e[2] / ax) * R];
  if (ay >= az) return [e[1] > 0 ? 2 : 3, (e[2] / ay) * R, (e[0] / ay) * R];
  return [e[2] > 0 ? 4 : 5, (e[0] / az) * R, (e[1] / az) * R];
}
export function stormFaceDir(f: number, u: number, v: number, R: number): [number, number, number] {
  u /= R;
  v /= R;
  const e: [number, number, number] = f < 2 ? [f === 0 ? 1 : -1, u, v] : f < 4 ? [v, f === 2 ? 1 : -1, u] : [u, v, f === 4 ? 1 : -1];
  const l = Math.hypot(...e);
  return [e[0] / l, e[1] / l, e[2] / l];
}

export interface StormCell {
  /** Its centre (unit, Earth-fixed). */
  dir: [number, number, number];
  /** Tower radius, its top (m above the ground), anvil radius (0: still growing, none). */
  rT: number;
  top: number;
  rA: number;
}

/**
 * The cells with their centres within `range` m of e (unit, Earth-fixed). conv: the deep
 * convection at a direction (0..1); base, top: the weather's cloud base and top there, m.
 */
export function stormCells(e: readonly number[], R: number, range: number, conv: (dir: [number, number, number]) => number, base: number, top: number): StormCell[] {
  const out: StormCell[] = [];
  const [f, gu, gv] = stormFace(e, R);
  const n = Math.ceil(range / STORM_GRID) + 1;
  const i0 = Math.floor(gu / STORM_GRID), j0 = Math.floor(gv / STORM_GRID);
  for (let j = j0 - n; j <= j0 + n; j++) {
    for (let i = i0 - n; i <= i0 + n; i++) {
      const h0 = stormRand(f, i, j, 0);
      const cu = (i + 0.5 + (stormRand(f, i, j, 1) - 0.5) * 0.5) * STORM_GRID;
      const cv = (j + 0.5 + (stormRand(f, i, j, 2) - 0.5) * 0.5) * STORM_GRID;
      const dir = stormFaceDir(f, cu, cv, R);
      const dot = dir[0] * e[0] + dir[1] * e[1] + dir[2] * e[2];
      if (Math.acos(Math.min(1, dot)) * R > range) continue;
      const x = Math.min(1, Math.max(0, (conv(dir) - h0) / 0.25));
      const k = x * x * (3 - 2 * x);
      if (k <= 0) continue;
      const stage = stormRand(f, i, j, 3);
      const mature = stage >= 0.35 ? 1 : 0;
      out.push({
        dir,
        rT: (3000 + 3500 * stormRand(f, i, j, 4)) * (0.6 + 0.4 * k),
        top: base + (top - base) * (mature ? 0.88 + 0.12 * stormRand(f, i, j, 5) : 0.35 + 1.4 * stage),
        rA: mature * (7000 + 6000 * stormRand(f, i, j, 6)) * (0.5 + 0.5 * k),
      });
    }
  }
  return out;
}

/**
 * Under the thunderstorms at e (unit, Earth-fixed) on the ground: rain (0..1, under a tower) and
 * shade (0..1, under a tower or an anvil). As stormCells' arguments.
 */
export function underStorms(e: readonly number[], R: number, conv: (dir: [number, number, number]) => number, base: number, top: number): { rain: number; shade: number } {
  let rain = 0;
  let shade = 0;
  const lon = Math.atan2(e[1], e[0]);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  for (const c of stormCells(e, R, 45000, conv, base, top)) {
    // (Across the ground from the cell's centre, m: east and the rest.)
    const d = [(c.dir[0] - e[0]) * R, (c.dir[1] - e[1]) * R, (c.dir[2] - e[2]) * R];
    const x = d[0] * east[0] + d[1] * east[1];
    const r = Math.hypot(...d);
    const rest = Math.sqrt(Math.max(0, r * r - x * x));
    const tower = smooth(c.rT * 1.15, c.rT * 0.6, r);
    rain = Math.max(rain, tower);
    shade = Math.max(shade, tower);
    if (c.rA > 0) {
      // (The anvil, downwind of the tower: e is west of its centre by x + its offset.)
      const off = 0.1 * (c.top - base) + 0.45 * c.rA;
      shade = Math.max(shade, 0.8 * smooth(c.rA * 1.15, c.rA * 0.8, Math.hypot(x + off, rest)));
    }
  }
  return { rain, shade };
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

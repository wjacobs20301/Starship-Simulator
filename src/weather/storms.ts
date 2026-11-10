// Thunderstorm cells, one by one (cumulonimbus): where the weather has deep convection, cells on
// a jittered grid STORM_GRID apart over a cube's faces (Earth-fixed), each its own size, height
// and stage. The renderer draws them (atmosphere.ts: findStormCells, the same hash and layout);
// the lightning strikes in them.

import { RE, RP } from '../sim/constants';

export const STORM_GRID = 60000;

// Directions: the weather's latitudes are geodetic (the site's, the sim's), so a place's
// direction here is its ground normal, not the line from the Earth's centre (at 26 deg those are
// ~17 km apart on the ground).
const K2 = (RE / RP) ** 2;
/** The weather's direction (geodetic lat / lon) of an Earth-fixed point (from the centre). */
export function weatherDir(x: number, y: number, z: number): [number, number, number] {
  const zz = z * K2;
  const l = Math.hypot(x, y, zz);
  return [x / l, y / l, zz / l];
}
/** The line from the Earth's centre to the ground under a weather direction. */
export function centreDir(d: readonly number[]): [number, number, number] {
  const zz = d[2] / K2;
  const l = Math.hypot(d[0], d[1], zz);
  return [d[0] / l, d[1] / l, zz / l];
}

/**
 * The cells drift with the storms (east, ~25 km/h, toward the coast as they come off the land),
 * so they pass over a place rather than sitting on fixed spots: the grid's offset on the cube
 * faces, m, at time t: (u0 + vu t, v0 + vv t). Set by the weather (render/weather.ts) for each
 * day; the renderer's cells (atmosphere.ts, uStormShift) and the lightning use the same.
 */
export const stormDrift = { u0: 0, v0: 0, vu: 0, vv: 0 };
export const stormShift = (t: number): [number, number] => [stormDrift.u0 + stormDrift.vu * t, stormDrift.v0 + stormDrift.vv * t];
/** How fast the storms move (east), m/s. */
export const STORM_SPEED = 7;

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
export function stormCells(e: readonly number[], R: number, range: number, conv: (dir: [number, number, number]) => number, base: number, top: number, t = 0): StormCell[] {
  const out: StormCell[] = [];
  const [f, gu0, gv0] = stormFace(e, R);
  // (In the drifting grid: where e is on it, and the cells' centres moved back by the drift.)
  const [su, sv] = stormShift(t);
  const gu = gu0 - su;
  const gv = gv0 - sv;
  const n = Math.ceil(range / STORM_GRID) + 1;
  const i0 = Math.floor(gu / STORM_GRID), j0 = Math.floor(gv / STORM_GRID);
  for (let j = j0 - n; j <= j0 + n; j++) {
    for (let i = i0 - n; i <= i0 + n; i++) {
      const h0 = stormRand(f, i, j, 0);
      const cu = (i + 0.5 + (stormRand(f, i, j, 1) - 0.5) * 0.5) * STORM_GRID + su;
      const cv = (j + 0.5 + (stormRand(f, i, j, 2) - 0.5) * 0.5) * STORM_GRID + sv;
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
export function underStorms(e: readonly number[], R: number, conv: (dir: [number, number, number]) => number, base: number, top: number, t = 0): { rain: number; shade: number } {
  let rain = 0;
  let shade = 0;
  const lon = Math.atan2(e[1], e[0]);
  const east = [-Math.sin(lon), Math.cos(lon), 0];
  for (const c of stormCells(e, R, 45000, conv, base, top, t)) {
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

/**
 * The drift for a day at a site (lat, lon, deg) from t0: the cells moving east at STORM_SPEED;
 * on a thunderstorm day (`storm`), the grid placed so a mature cell (raining, its anvil out) is
 * just west of the site at t0, coming in over it. R: the Earth's radius, m.
 */
export function setStormDrift(lat: number, lon: number, t0: number, storm: boolean, seed = 0, R = 6378137): void {
  const D = Math.PI / 180;
  const at = (la: number, lo: number) => [Math.cos(la * D) * Math.cos(lo * D), Math.cos(la * D) * Math.sin(lo * D), Math.sin(la * D)];
  const [f, gu, gv] = stormFace(at(lat, lon), R);
  // East, on the site's face: the face coordinates a kilometre east.
  const [, eu, ev] = stormFace(at(lat, lon + 1000 / (R * Math.cos(lat * D)) / D), R);
  const ku = (eu - gu) / 1000;
  const kv = (ev - gv) / 1000;
  stormDrift.vu = ku * STORM_SPEED;
  stormDrift.vv = kv * STORM_SPEED;
  stormDrift.u0 = 0;
  stormDrift.v0 = 0;
  if (!storm) return;
  // Where the cell should be at t0 (a few km west of the site, a little north or south: each day
  // its own), and the mature cell nearest it on the grid as it stands: shift the grid so that one
  // is there.
  const rnd = (k: number) => stormRand(6, seed | 0, k, 9);
  const west = 4000 * rnd(1);
  const across = (rnd(2) - 0.5) * 6000;
  // (North on the face: perpendicular to east.)
  const pu = gu - ku * west - kv * across;
  const pv = gv - kv * west + ku * across;
  const [su, sv] = stormShift(t0);
  const i0 = Math.floor((pu - su) / STORM_GRID);
  const j0 = Math.floor((pv - sv) / STORM_GRID);
  let best: [number, number] | null = null;
  let bestD = Infinity;
  for (let j = j0 - 2; j <= j0 + 2; j++) {
    for (let i = i0 - 2; i <= i0 + 2; i++) {
      // (Mature, and one that switches on in moderate convection.)
      if (stormRand(f, i, j, 3) < 0.35 || stormRand(f, i, j, 0) > 0.45) continue;
      const cu = (i + 0.5 + (stormRand(f, i, j, 1) - 0.5) * 0.5) * STORM_GRID + su;
      const cv = (j + 0.5 + (stormRand(f, i, j, 2) - 0.5) * 0.5) * STORM_GRID + sv;
      const d = Math.hypot(cu - pu, cv - pv);
      if (d < bestD) [bestD, best] = [d, [cu, cv]];
    }
  }
  if (best) {
    stormDrift.u0 += pu - best[0];
    stormDrift.v0 += pv - best[1];
  }
}

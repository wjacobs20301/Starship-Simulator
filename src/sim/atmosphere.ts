// U.S. Standard Atmosphere 1976.
// 0-86 km: exact layer equations in geopotential altitude.
// Above 86 km: log-linear interpolation of the tabulated density.

const R_AIR = 287.05287; // J/(kg K)
const GAMMA = 1.4;
const G0 = 9.80665;
const R0 = 6356766; // Earth radius used by US76 for geopotential altitude, m

// [base geopotential altitude m, base temperature K, lapse rate K/m, base pressure Pa]
const LAYERS: readonly (readonly [number, number, number, number])[] = [
  [0, 288.15, -0.0065, 101325],
  [11000, 216.65, 0, 22632.06],
  [20000, 216.65, 0.001, 5474.889],
  [32000, 228.65, 0.0028, 868.0187],
  [47000, 270.65, 0, 110.9063],
  [51000, 270.65, -0.0028, 66.93887],
  [71000, 214.65, -0.002, 3.95642],
];
const H_TOP = 84852; // geopotential top of the lower atmosphere (86 km geometric)

// Geometric altitude km -> density kg/m^3 (US76 tables), plus kinetic temperature K.
const UPPER: readonly (readonly [number, number, number])[] = [
  [86, 6.958e-6, 186.87],
  [90, 3.416e-6, 186.87],
  [100, 5.604e-7, 195.08],
  [110, 9.708e-8, 240.0],
  [120, 2.222e-8, 360.0],
  [130, 8.152e-9, 469.27],
  [150, 2.076e-9, 634.39],
  [175, 6.231e-10, 755.3],
  [200, 2.541e-10, 854.56],
  [250, 6.073e-11, 941.33],
  [300, 1.916e-11, 976.01],
  [400, 2.803e-12, 995.83],
  [500, 5.215e-13, 999.24],
  [700, 3.07e-14, 999.99],
  [1000, 3.561e-15, 1000.0],
];

export interface AtmosphereState {
  T: number; // K
  p: number; // Pa
  rho: number; // kg/m^3
  a: number; // speed of sound, m/s
}

export function atmosphere(zGeometric: number): AtmosphereState {
  // Slightly below the ellipsoid the troposphere equations extrapolate fine; clamp far below.
  const z = Math.max(zGeometric, -1000);
  const h = (R0 * z) / (R0 + z);
  if (h < H_TOP) {
    let i = LAYERS.length - 1;
    while (i > 0 && h < LAYERS[i][0]) i--;
    const [hb, Tb, L, pb] = LAYERS[i];
    const T = Tb + L * (h - hb);
    const p = L === 0 ? pb * Math.exp((-G0 * (h - hb)) / (R_AIR * Tb)) : pb * Math.pow(Tb / T, G0 / (R_AIR * L));
    const rho = p / (R_AIR * T);
    return { T, p, rho, a: Math.sqrt(GAMMA * R_AIR * T) };
  }
  const zk = z / 1000;
  if (zk >= UPPER[UPPER.length - 1][0]) return { T: 1000, p: 0, rho: 0, a: Math.sqrt(GAMMA * R_AIR * 1000) };
  let i = 1;
  while (zk > UPPER[i][0]) i++;
  const [z0, r0, t0] = UPPER[i - 1];
  const [z1, r1, t1] = UPPER[i];
  const f = Math.max(0, (zk - z0) / (z1 - z0));
  const rho = Math.exp(Math.log(r0) + f * (Math.log(r1) - Math.log(r0)));
  const T = t0 + f * (t1 - t0);
  // Above 86 km the mean molecular weight changes; using sea-level R is adequate for pressure-thrust effects.
  const p = rho * R_AIR * T;
  return { T, p, rho, a: Math.sqrt(GAMMA * R_AIR * T) };
}

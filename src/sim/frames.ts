// Reference frames.
// ECI: inertial, z = Earth's spin axis, aligned with ECEF at t = 0.
// ECEF: Earth-fixed, rotates with the Earth about z.
// ENU: local East-North-Up tangent frame at a geodetic point.

import { E2, OMEGA_E, RE } from './constants';
import { type M3, type V3, mat3FromColumns, mat3Transpose } from './math';

export interface Geodetic {
  lat: number; // rad
  lon: number; // rad
  h: number; // m above the WGS84 ellipsoid
}

export function geodeticToEcef(lat: number, lon: number, h: number): V3 {
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const n = RE / Math.sqrt(1 - E2 * sl * sl);
  return [(n + h) * cl * Math.cos(lon), (n + h) * cl * Math.sin(lon), (n * (1 - E2) + h) * sl];
}

/** Bowring's method: mm-level accuracy near the surface, metres at orbital altitudes. */
export function ecefToGeodetic(p: V3): Geodetic {
  const [x, y, z] = p;
  const b = RE * Math.sqrt(1 - E2);
  const ep2 = (RE * RE - b * b) / (b * b);
  const rho = Math.hypot(x, y);
  if (rho < 1e-6) return { lat: Math.sign(z || 1) * Math.PI / 2, lon: 0, h: Math.abs(z) - b };
  const th = Math.atan2(z * RE, rho * b);
  const st = Math.sin(th);
  const ct = Math.cos(th);
  const lat = Math.atan2(z + ep2 * b * st * st * st, rho - E2 * RE * ct * ct * ct);
  const sl = Math.sin(lat);
  const n = RE / Math.sqrt(1 - E2 * sl * sl);
  const h = rho / Math.cos(lat) - n;
  return { lat, lon: Math.atan2(y, x), h };
}

export const earthAngle = (t: number): number => OMEGA_E * t;

export function eciToEcef(r: V3, t: number): V3 {
  const th = earthAngle(t);
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [c * r[0] + s * r[1], -s * r[0] + c * r[1], r[2]];
}

export function ecefToEci(r: V3, t: number): V3 {
  const th = earthAngle(t);
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [c * r[0] - s * r[1], s * r[0] + c * r[1], r[2]];
}

/** Rotation matrix taking ECI vectors to ECEF. */
export function eciToEcefMatrix(t: number): M3 {
  const th = earthAngle(t);
  const c = Math.cos(th);
  const s = Math.sin(th);
  return [c, s, 0, -s, c, 0, 0, 0, 1];
}

/** East, North, Up unit vectors (in ECEF) at a geodetic point. */
export function enuBasis(lat: number, lon: number): { e: V3; n: V3; u: V3 } {
  const sl = Math.sin(lat);
  const cl = Math.cos(lat);
  const so = Math.sin(lon);
  const co = Math.cos(lon);
  return {
    e: [-so, co, 0],
    n: [-sl * co, -sl * so, cl],
    u: [cl * co, cl * so, sl],
  };
}

/** Matrix taking ECEF vectors to ENU components at (lat, lon). */
export function ecefToEnuMatrix(lat: number, lon: number): M3 {
  const { e, n, u } = enuBasis(lat, lon);
  return mat3Transpose(mat3FromColumns(e, n, u));
}

/** Velocity relative to the rotating atmosphere / ground, expressed in ECI. */
export function airRelativeVelocity(r: V3, v: V3): V3 {
  // v - omega x r, with omega = (0, 0, OMEGA_E)
  return [v[0] + OMEGA_E * r[1], v[1] - OMEGA_E * r[0], v[2]];
}

/** Local ENU basis at the vehicle's position, expressed in ECI. */
export function localBasisEci(geo: Geodetic, t: number): { e: V3; n: V3; u: V3 } {
  const { e, n, u } = enuBasis(geo.lat, geo.lon);
  return { e: ecefToEci(e, t), n: ecefToEci(n, t), u: ecefToEci(u, t) };
}


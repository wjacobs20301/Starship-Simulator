// The launch site's local frame (East-North-Up at Pad 1's ground level), rotating with the
// Earth. Used for the booster's return: targets, errors and landing guidance live here.

import { DEG, PAD } from './constants';
import { airRelativeVelocity, ecefToEci, ecefToEnuMatrix, eciToEcef, enuBasis, geodeticToEcef } from './frames';
import { type V3, add, mat3Vec, scale, sub } from './math';

const lat = PAD.latDeg * DEG;
const lon = PAD.lonDeg * DEG;
export const PAD_GROUND_ECEF = geodeticToEcef(lat, lon, PAD.groundAlt);
const ECEF_TO_ENU = ecefToEnuMatrix(lat, lon);
const BASIS = enuBasis(lat, lon);

/** ECI position -> pad ENU position, m. */
export function eciToPad(r: V3, t: number): V3 {
  return mat3Vec(ECEF_TO_ENU, sub(eciToEcef(r, t), PAD_GROUND_ECEF));
}

/** ECI velocity -> velocity relative to the ground, in pad ENU components, m/s. */
export function eciVelToPad(r: V3, v: V3, t: number): V3 {
  return mat3Vec(ECEF_TO_ENU, eciToEcef(airRelativeVelocity(r, v), t));
}

/** ECI direction -> pad ENU components. */
export function eciDirToPad(d: V3, t: number): V3 {
  return mat3Vec(ECEF_TO_ENU, eciToEcef(d, t));
}

/** Pad ENU direction -> ECI direction. */
export function padDirToEci(d: V3, t: number): V3 {
  const ecef = add(add(scale(BASIS.e, d[0]), scale(BASIS.n, d[1])), scale(BASIS.u, d[2]));
  return ecefToEci(ecef, t);
}

/** Pad ENU position -> ECI position. */
export function padToEci(p: V3, t: number): V3 {
  return ecefToEci(add(PAD_GROUND_ECEF, [
    BASIS.e[0] * p[0] + BASIS.n[0] * p[1] + BASIS.u[0] * p[2],
    BASIS.e[1] * p[0] + BASIS.n[1] * p[1] + BASIS.u[1] * p[2],
    BASIS.e[2] * p[0] + BASIS.n[2] * p[1] + BASIS.u[2] * p[2],
  ]), t);
}

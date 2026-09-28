// Geodetic -> render-world conversion shared by the terrain and the globe. The render world is
// the pad's ENU frame (x = East, y = Up, z = -North, metres from the pad ground point), the
// same frame the physics snapshot uses, so ground and vehicle always agree.

import { DEG, PAD } from '../sim/constants';
import { ecefToEnuMatrix, ecefToGeodetic, geodeticToEcef } from '../sim/frames';
import { type V3, add, mat3Transpose, mat3Vec, sub } from '../sim/math';

const PAD_ECEF = geodeticToEcef(PAD.latDeg * DEG, PAD.lonDeg * DEG, PAD.groundAlt);
const ECEF_TO_ENU = ecefToEnuMatrix(PAD.latDeg * DEG, PAD.lonDeg * DEG);

export function ecefToWorld(p: V3): V3 {
  const enu = mat3Vec(ECEF_TO_ENU, sub(p, PAD_ECEF));
  return [enu[0], enu[2], -enu[1]];
}

const ENU_TO_ECEF = mat3Transpose(ECEF_TO_ENU);

/** Render world -> geodetic latitude / longitude (degrees) and height above the ellipsoid (m). */
export function worldToGeodetic(w: V3): { lat: number; lon: number; h: number } {
  const g = ecefToGeodetic(add(PAD_ECEF, mat3Vec(ENU_TO_ECEF, [w[0], -w[2], w[1]])));
  return { lat: g.lat / DEG, lon: g.lon / DEG, h: g.h };
}

export const toWorld = (latDeg: number, lonDeg: number, h: number): V3 =>
  ecefToWorld(geodeticToEcef(latDeg * DEG, lonDeg * DEG, h));

export const tileXToLon = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
export const tileYToLat = (y: number, z: number) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI - (2 * Math.PI * y) / 2 ** z));

/** Local east/north metres -> approximate lat/lon (for shaders; good to ~0.1% within 100 km). */
export const M_PER_DEG_LAT = 110_800;
export const M_PER_DEG_LON = 111_320 * Math.cos(PAD.latDeg * DEG);

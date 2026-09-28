// Physical constants (SI units).

/** Earth gravitational parameter, m^3/s^2 (EGM96 / WGS84). */
export const MU = 3.986004418e14;
/** WGS84 equatorial radius, m. */
export const RE = 6378137.0;
/** WGS84 flattening. */
export const FLATTENING = 1 / 298.257223563;
/** WGS84 polar radius, m. */
export const RP = RE * (1 - FLATTENING);
/** First eccentricity squared. */
export const E2 = FLATTENING * (2 - FLATTENING);
/** Second zonal harmonic (Earth oblateness). */
export const J2 = 1.08262668e-3;
/** Earth rotation rate, rad/s. */
export const OMEGA_E = 7.2921159e-5;
/** Standard gravity, m/s^2 (defines Isp). */
export const G0 = 9.80665;
/** Sea-level standard pressure, Pa. */
export const P0 = 101325;

/**
 * Starbase Pad 1 ("Pad A"), the launch pad used by the sim. Mount position from
 * OpenStreetMap (flame trench / launch mount, 2026); ground height is the flattened launch
 * site from the terrain build (USGS 3DEP, NAVD88 ~ treated as sea level).
 */
export const PAD = {
  name: 'Pad 1',
  latDeg: 25.99613,
  lonDeg: -97.15442,
  /** Ground elevation of the launch site, m. */
  groundAlt: 1.5,
  /**
   * Top of the launch mount (booster base) above the ground, m: ~17-18 m in photos of a V3 stack
   * on Pad 2 (scaled by the 124 m stack), which puts the ship's nose just below the tower top.
   */
  mountHeight: 18,
  /** Tower center relative to the mount, m (east, north) and tower height, m. */
  tower: { e: -32, n: 0, height: 143 },
  /** V3 flame trench under the mount: OSM footprint 85 x 23.5 m outside the walls (19 m inside); depth approx / tune. */
  trench: { axisDeg: 47.9, length: 85, width: 19, depth: 6 },
};

/** Starbase Pad 2 ("Pad B"): tower 35.5 m north of its mount (OpenStreetMap). */
export const PAD2 = {
  name: 'Pad 2',
  latDeg: 25.99673,
  lonDeg: -97.15809,
  tower: { e: 0, n: 35.5, height: 144.5 },
  trench: { axisDeg: -36.8, length: 85, width: 19, depth: 6 },
};

/** A V3 pad's flame trench: axis direction (degrees counter-clockwise from east), size in m. */
export interface Trench {
  axisDeg: number;
  length: number;
  width: number;
  depth: number;
}

export const DEG = Math.PI / 180;

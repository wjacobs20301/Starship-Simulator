// Slender-body aerodynamics for a 9 m cylinder with a nose.
// Axial force: C_A(Mach) * cos(alpha). Normal force: linear slender-body term plus
// viscous crossflow, which keeps the model sane all the way to broadside/tumbling flow.

import { interp } from './math';

export const REF_DIAMETER = 9;
export const REF_AREA = Math.PI * (REF_DIAMETER / 2) ** 2;

/** Zero-alpha axial force coefficient vs Mach (approximate; tune against telemetry). */
export const AXIAL_CA: readonly (readonly [number, number])[] = [
  [0, 0.32],
  [0.6, 0.34],
  [0.85, 0.42],
  [1.0, 0.72],
  [1.2, 0.82],
  [1.5, 0.74],
  [2.0, 0.6],
  [3.0, 0.46],
  [5.0, 0.36],
  [10.0, 0.3],
  [25.0, 0.28],
];

/** Normal-force slope per radian near alpha = 0 (slender-body theory ~2 plus body lift). */
export const CN_ALPHA = 2.5;
/** Crossflow drag coefficient of a circular cylinder, times an efficiency factor. */
const CROSSFLOW = 1.2 * 0.6;
/** Pitch damping coefficient (per rad of qL/2V, referenced to area and body length). */
export const CMQ = -8;

/**
 * Axial force coefficient flying engines-first (a returning booster): the blunt engine bay
 * and skirt lead, so drag is much higher than nose-first (approx / tune).
 */
export const AXIAL_CA_BASE_FIRST: readonly (readonly [number, number])[] = [
  [0, 0.95],
  [0.8, 1.05],
  [1.0, 1.35],
  [1.5, 1.55],
  [3.0, 1.45],
  [6.0, 1.35],
  [25.0, 1.3],
];

export function axialCoefficient(mach: number, baseFirst = false): number {
  return interp(baseFirst ? AXIAL_CA_BASE_FIRST : AXIAL_CA, mach);
}

/**
 * Grid-fin normal force coefficient on the fins' planform area for local angle of attack alpha.
 * Lattice fins work well at small alpha and stall out toward broadside flow.
 */
export function gridFinCoefficient(alpha: number): number {
  return 1.1 * Math.sin(alpha) * Math.abs(Math.cos(alpha));
}

/** Largest grid-fin deflection, rad, and its normal-force coefficient. */
export const GRID_FIN_MAX_DEFLECTION = 25 * Math.PI / 180;
export const GRID_FIN_CONTROL_CN = 1.1 * Math.sin(GRID_FIN_MAX_DEFLECTION);

/**
 * Normal-force coefficient for angle of attack alpha (0..pi) on a body of the given length.
 * Positive result pushes the vehicle away from the direction of the crossflow component.
 */
export function normalCoefficient(alpha: number, length: number): number {
  const s = Math.sin(alpha);
  return CN_ALPHA * s * Math.abs(Math.cos(alpha)) + CROSSFLOW * ((length * REF_DIAMETER) / REF_AREA) * s * s;
}

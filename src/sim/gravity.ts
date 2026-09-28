// Point-mass gravity plus the J2 oblateness term, in ECI (z = spin axis).

import { J2, MU, RE } from './constants';
import type { V3 } from './math';

export function gravityJ2(r: V3): V3 {
  const [x, y, z] = r;
  const r2 = x * x + y * y + z * z;
  const rn = Math.sqrt(r2);
  const k = -MU / (r2 * rn);
  const j = 1.5 * J2 * (RE * RE) / r2;
  const zz = (5 * z * z) / r2;
  return [k * x * (1 + j * (1 - zz)), k * y * (1 + j * (1 - zz)), k * z * (1 + j * (3 - zz))];
}

/** Gravitational potential energy per unit mass consistent with gravityJ2. */
export function potentialJ2(r: V3): number {
  const rn = Math.hypot(r[0], r[1], r[2]);
  const s2 = (r[2] / rn) ** 2;
  return -MU / rn + (MU * J2 * RE * RE * (3 * s2 - 1)) / (2 * rn ** 3);
}

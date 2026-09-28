import { describe, expect, it } from 'vitest';
import { OMEGA_E, RE, RP } from '../src/sim/constants';
import { gravityJ2 } from '../src/sim/gravity';
import { type V3, norm } from '../src/sim/math';

/** Effective gravity felt on the rotating Earth: gravity plus centrifugal. */
const effective = (r: V3) => {
  const g = gravityJ2(r);
  return norm([g[0] + OMEGA_E ** 2 * r[0], g[1] + OMEGA_E ** 2 * r[1], g[2]]);
};

describe('J2 gravity', () => {
  it('equatorial surface gravity ~9.780 m/s^2', () => {
    expect(effective([RE, 0, 0])).toBeCloseTo(9.7803, 3);
  });
  it('polar surface gravity ~9.832 m/s^2', () => {
    expect(effective([0, 0, RP])).toBeCloseTo(9.8322, 3);
  });
  it('points toward the center at the equator', () => {
    const g = gravityJ2([RE, 0, 0]);
    expect(g[0]).toBeLessThan(0);
    expect(Math.abs(g[1]) + Math.abs(g[2])).toBe(0);
  });
});

import { describe, expect, it } from 'vitest';
import { atmosphere } from '../src/sim/atmosphere';

// U.S. Standard Atmosphere 1976 tabulated values at geometric altitude.
describe('US Standard Atmosphere 1976', () => {
  it.each([
    [0, 288.15, 101325, 1.225],
    [11000, 216.774, 22699.9, 0.3648],
    [20000, 216.65, 5529.3, 0.08891],
    [32000, 228.49, 889.06, 0.013555],
    [50000, 270.65, 79.779, 0.0010269],
    [80000, 198.64, 1.0524, 1.8458e-5],
  ])('z = %d m', (z, T, p, rho) => {
    const a = atmosphere(z);
    expect(a.T).toBeCloseTo(T, 0);
    expect(a.p / p).toBeCloseTo(1, 2);
    expect(a.rho / rho).toBeCloseTo(1, 2);
  });

  it('speed of sound at sea level', () => {
    expect(atmosphere(0).a).toBeCloseTo(340.29, 1);
  });

  it('upper atmosphere decays smoothly and vanishes in space', () => {
    expect(atmosphere(100e3).rho / 5.604e-7).toBeCloseTo(1, 2);
    expect(atmosphere(200e3).rho).toBeLessThan(atmosphere(150e3).rho);
    expect(atmosphere(2000e3).rho).toBe(0);
  });
});

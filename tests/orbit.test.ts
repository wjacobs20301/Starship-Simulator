import { describe, expect, it } from 'vitest';
import { STARSHIP_V3 } from '../src/sim/config/starshipV3';
import { MU, RE } from '../src/sim/constants';
import { rk4Step } from '../src/sim/dynamics';
import { potentialJ2 } from '../src/sim/gravity';
import { cross, dot } from '../src/sim/math';
import { Vehicle } from '../src/sim/vehicle';

describe('orbital propagation (RK4, J2, no thrust or drag)', () => {
  it('conserves energy and polar angular momentum over 3 orbits', () => {
    const v = new Vehicle('ship', 'Starship', [{ def: STARSHIP_V3, prop: 0 }]);
    const r = RE + 200e3;
    const vc = Math.sqrt(MU / r);
    const inc = (30 * Math.PI) / 180;
    v.r = [r, 0, 0];
    v.v = [0, vc * Math.cos(inc), vc * Math.sin(inc)];
    v.status = 'flight';
    const energy = () => dot(v.v, v.v) / 2 + potentialJ2(v.r);
    const hz = () => cross(v.r, v.v)[2];
    const e0 = energy();
    const h0 = hz();
    const period = 2 * Math.PI * Math.sqrt(r ** 3 / MU);
    const dt = 1;
    for (let t = 0; t < 3 * period; t += dt) rk4Step(v, t, dt, { gravity: true, aero: false });
    expect(Math.abs((energy() - e0) / e0)).toBeLessThan(1e-6);
    expect(Math.abs((hz() - h0) / h0)).toBeLessThan(1e-6);
  });
});

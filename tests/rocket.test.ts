import { describe, expect, it } from 'vitest';
import { RAPTOR3_VAC, STARSHIP_V3 } from '../src/sim/config/starshipV3';
import { G0, RE } from '../src/sim/constants';
import { rk4Step } from '../src/sim/dynamics';
import { norm } from '../src/sim/math';
import { Vehicle, massProps } from '../src/sim/vehicle';

describe('rocket equation', () => {
  it('vacuum burn without gravity matches Tsiolkovsky within 0.1%', () => {
    const def = { ...STARSHIP_V3, engines: STARSHIP_V3.engines.filter((e) => e.type === RAPTOR3_VAC) };
    const v = new Vehicle('ship', 'Starship', [{ def, prop: def.propMass }]);
    v.r = [RE + 500e3, 0, 0];
    v.status = 'flight';
    for (const e of v.engines) e.throttle = 1;
    const m0 = massProps(v.stages, [def.propMass]).mass;
    const mf = massProps(v.stages, [0]).mass;
    const dt = 0.01;
    for (let t = 0; v.stages[0].prop > 0 && t < 1000; t += dt) rk4Step(v, t, dt, { gravity: false, aero: false });
    const ideal = RAPTOR3_VAC.ispVac * G0 * Math.log(m0 / mf);
    expect(Math.abs(norm(v.v) - ideal) / ideal).toBeLessThan(1e-3);
  });
});

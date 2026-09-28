import { describe, expect, it } from 'vitest';
import { orbitApsides } from '../src/sim/guidance';
import { Simulation } from '../src/sim/simulation';

// Phase 4: plan a burn at apoapsis that turns the suborbital coast into an orbit, fly it with SAS
// pointed at the node, then time-warp on rails around the orbit.
describe('maneuver node and on-rails warp', () => {
  it('circularises at apoapsis, then coasts on rails', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.launch();
    while (sim.mission.phase !== 'coast') sim.step();
    const ship = sim.find('ship')!;
    sim.pilot.set({ manual: true, target: 'ship', sas: 'maneuver', throttle: 0, engines: 2 });

    // Node at the predicted apoapsis, prograde enough to lift the perigee above 180 km.
    const pred = sim.predictTrajectories().find((t) => t.id === 'ship')!;
    const tAp = pred.t + pred.apoapsis!.dt;
    sim.setNode({ vehicle: 'ship', t: tAp, dv: [150, 0, 0] });
    const planned = sim.predictTrajectories().find((t) => t.id === 'ship:node')!;
    expect(planned.nodeIndex).toBeGreaterThan(0);
    expect(planned.impact).toBeNull();
    expect(planned.orbit.perigee).toBeGreaterThan(150e3);

    // Coast to the burn (half the burn time early), then burn until the node clears.
    const snap = () => sim.snapshot().node;
    while (sim.t < tAp - snap()!.burnTime / 2) sim.step();
    sim.pilot.set({ throttle: 1 });
    let guard = 0;
    while (sim.node && guard++ < 30000) sim.step();
    sim.pilot.set({ throttle: 0 });
    for (let i = 0; i < 300; i++) sim.step();
    expect(sim.node).toBeNull();
    expect(sim.events.some((e) => /Maneuver complete/.test(e.text))).toBe(true);
    const aps = orbitApsides(ship.r, ship.v);
    expect(aps.perigee).toBeGreaterThan(140e3);
    expect(Math.abs(aps.perigee - planned.orbit.perigee)).toBeLessThan(30e3);

    // On rails: most of an orbit in a few big steps, staying in orbit.
    expect(sim.railsAllowed()).toBe(true);
    const t0 = sim.t;
    const done = sim.railsStep(4000);
    expect(done).toBeCloseTo(4000, 0);
    expect(sim.t - t0).toBeCloseTo(4000, 0);
    const after = orbitApsides(ship.r, ship.v);
    expect(Math.abs(after.perigee - aps.perigee)).toBeLessThan(15e3);
    expect(ship.status).toBe('flight');
  });
});

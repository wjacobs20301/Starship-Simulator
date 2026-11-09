import { describe, expect, it } from 'vitest';
import { STARLINK_V3 } from '../src/sim/config/starshipV3';
import { orbitApsides } from '../src/sim/guidance';
import { norm, sub } from '../src/sim/math';
import { Simulation } from '../src/sim/simulation';
import { massProps, payloadOf } from '../src/sim/vehicle';

/** Flight 15 as the mission flies it: Pad 2, 26 Starlink V3 aboard, home to a tower after SECO. */
function flight15() {
  const sim = new Simulation();
  sim.launchPad = 1;
  sim.configure({ payload: 'starlink', parkingAlt: 275e3 });
  sim.reset();
  sim.launch();
  while (sim.mission.phase !== 'coast') sim.step();
  sim.commandReturn({ kind: 'tower', pad: -1 });
  return sim;
}

/** Run on (warping on rails where it may) until `done` or the guard. */
function runUntil(sim: Simulation, done: () => boolean, guard = 3e6) {
  for (let i = 0; i < guard && !done(); i++) {
    const a = sim.waitUntil;
    if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(60, a - sim.t));
    else sim.step();
  }
}

describe('Starlink deployment (Flight 15)', () => {
  it('carries 26 satellites and deploys them in orbit from T+34 min, one every ~70 s, then closes the door', { timeout: 240_000 }, () => {
    const sim = flight15();
    const ship = sim.find('ship')!;
    expect(payloadOf(ship.stages[0])).toBeCloseTo(26 * STARLINK_V3.mass, 0);
    const before = massProps(ship.stages, ship.stages.map((s) => s.prop)).mass;
    runUntil(sim, () => sim.bay!.state === 'done' || ship.status !== 'flight');
    const bay = sim.bay!;
    expect(bay.state).toBe('done');
    expect(bay.aboard).toBe(0);
    expect(bay.sats).toHaveLength(26);
    expect(payloadOf(ship.stages[0])).toBe(0);
    // Each one 1.9 t off the ship.
    const after = massProps(ship.stages, ship.stages.map((s) => s.prop)).mass;
    expect(before - after).toBeGreaterThan(26 * STARLINK_V3.mass - 1);
    // On time, in orbit, at the planned pace; the log tells it.
    const t0 = sim.mission.tZero!;
    const first = sim.events.find((e) => /^Starlink 1 of 26 deployed/.test(e.text))!;
    const last = sim.events.find((e) => /^Starlink 26 of 26 deployed/.test(e.text))!;
    expect(first.t - t0).toBeGreaterThan(STARLINK_V3.deployAt);
    expect(first.t - t0).toBeLessThan(STARLINK_V3.deployAt + 120);
    expect((last.t - first.t) / 60).toBeGreaterThan(25);
    expect((last.t - first.t) / 60).toBeLessThan(35);
    expect(sim.events.some((e) => /^Payload door closed/.test(e.text))).toBe(true);
    // They're in orbit with the ship, drifting slowly away from it, not falling or flying off.
    for (const s of bay.sats) {
      expect(orbitApsides(s.r, s.v).perigee).toBeGreaterThan(150e3);
      expect(norm(sub(s.v, ship.v))).toBeLessThan(5);
    }
    expect(norm(sub(bay.sats[25].r, ship.r))).toBeLessThan(200);
    expect(norm(sub(bay.sats[0].r, ship.r))).toBeGreaterThan(200);
  });

  it('the whole flight: booster caught at Pad 2, satellites out, ship caught at Pad 1 about 14 orbits later', { timeout: 400_000 }, () => {
    const sim = flight15();
    const ship = sim.find('ship')!;
    runUntil(sim, () => ship.status !== 'flight' || !sim.mission.shipReturn);
    expect(sim.events.some((e) => /^Booster caught!/.test(e.text))).toBe(true);
    expect(sim.find('booster')!.caughtPad).toBe(1);
    expect(sim.bay!.aboard).toBe(0);
    expect(ship.status).toBe('caught');
    expect(ship.caughtPad).toBe(0);
    const hours = (sim.t - sim.mission.tZero!) / 3600;
    expect(hours).toBeGreaterThan(18);
    expect(hours).toBeLessThan(26);
  });
});

import { describe, expect, it } from 'vitest';
import { throttleForThrust } from '../src/sim/engine';
import { Simulation } from '../src/sim/simulation';

const run = (sim: Simulation, seconds: number, until?: () => boolean) => {
  for (let i = 0; i < seconds / 0.01; i++) {
    sim.step();
    if (until?.()) return;
  }
};

describe('breakup and heating limits', () => {
  it('a hard pitch at max-Q breaks the stack up', () => {
    const sim = new Simulation();
    sim.pilot.set({ manual: true, target: 'stack', sas: 'stability', throttle: 1 });
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 50) sim.step();
    sim.pilot.set({ pitch: 1 });
    run(sim, 20, () => sim.find('stack')!.status === 'destroyed');
    expect(sim.find('stack')!.status).toBe('destroyed');
    expect(sim.events.some((e) => /structural failure/.test(e.text))).toBe(true);
  });

  const entry = (sas: 'prograde' | 'entry') => {
    const sim = new Simulation();
    sim.launch();
    while (sim.mission.phase !== 'coast') sim.step();
    sim.pilot.set({ manual: true, target: 'ship', sas, throttle: 0 });
    const ship = sim.find('ship')!;
    while (ship.status === 'flight' && sim.aux.get('ship')!.geo.h > 25e3) sim.step();
    return { sim, ship };
  };

  it('entering nose-first burns through', { timeout: 120_000 }, () => {
    const { sim, ship } = entry('prograde');
    expect(ship.status).toBe('destroyed');
    expect(sim.events.some((e) => /burn-through/.test(e.text))).toBe(true);
  });

  it('entry SAS (belly-first) brings the ship through the plasma', { timeout: 120_000 }, () => {
    const { sim, ship } = entry('entry');
    expect(ship.status).toBe('flight');
    expect(sim.health.get('ship')!.heat).toBeLessThan(0.2);
  });
});

describe('manual booster catch', () => {
  it('the tower catches a booster the player lowers onto the arms', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.launch();
    const booster = () => sim.find('booster');
    const br = () => sim.mission.boosterReturn;
    // Autopilot brings it in; the player takes over for the last few tens of metres.
    const lined = () => {
      const b = booster();
      if (b?.status !== 'flight' || br()?.phase !== 'terminal') return false;
      const g = br()!.guide(b, sim.aux.get('booster')!);
      return g.above < 20 && Math.hypot(g.east, g.north) < 1 && Math.hypot(...g.vel) < 3;
    };
    while (!lined()) {
      sim.step();
      expect(sim.t).toBeLessThan(2000);
    }
    sim.pilot.set({ manual: true, target: 'booster', sas: 'retrograde', engines: 2, throttle: 0.5 });
    const b = booster()!;
    for (let i = 0; i < 6000 && b.status === 'flight'; i++) {
      if (i % 10 === 0) {
        const aux = sim.aux.get('booster')!;
        const g = br()!.guide(b, aux);
        const vzCmd = -Math.min(3, Math.max(1.2, 0.1 * g.above + 1.2));
        const force = aux.mp.mass * (9.8 + 1.4 * (vzCmd - g.vel[2]));
        sim.pilot.set({ throttle: throttleForThrust(b.engines[0].place.type, force / 3, aux.pAmb) });
      }
      sim.step();
    }
    expect(b.status).toBe('caught');
    expect(sim.events.some((e) => /Booster caught/.test(e.text))).toBe(true);
  });
});

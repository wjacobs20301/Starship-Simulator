import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/sim/simulation';
import { distanceKm } from '../src/game/missions';

// Missions that start part-way through a flight: the flight is run ahead to there.
describe('mission start points', () => {
  const at = (start: Parameters<Simulation['startAt']>[0]) => {
    const sim = new Simulation();
    const t0 = performance.now();
    sim.startAt(start);
    return { sim, ms: performance.now() - t0, snap: sim.snapshot() };
  };

  it('just after stage separation, both stages flying', () => {
    const { snap } = at('separation');
    expect(snap.vehicles.map((v) => v.id).sort()).toEqual(['booster', 'ship']);
    expect(snap.vehicles.every((v) => v.status === 'flight')).toBe(true);
  });

  it('the booster falling toward its landing burn', () => {
    const { snap } = at('boosterLanding');
    const b = snap.vehicles.find((v) => v.id === 'booster')!;
    expect(snap.vehicles.length).toBe(1);
    expect(b.status).toBe('flight');
    expect(b.telemetry.altitude).toBeGreaterThan(8e3);
    expect(b.telemetry.altitude).toBeLessThan(30e3);
    expect(b.telemetry.verticalSpeed).toBeLessThan(0);
  }, 30_000);

  it('the ship at the edge of the atmosphere, coming down', () => {
    const { snap, ms } = at('entry');
    const s = snap.vehicles.find((v) => v.id === 'ship')!;
    expect(snap.vehicles.length).toBe(1);
    expect(s.telemetry.altitude).toBeGreaterThan(105e3);
    expect(s.telemetry.altitude).toBeLessThan(120e3);
    expect(s.telemetry.speed).toBeGreaterThan(6500);
    expect(ms).toBeLessThan(15000); // (typically ~2.5 s; generous for a busy machine)
  }, 30_000);
  it('handed back to the autopilot high in the entry, it flies the entry down to the target', { timeout: 180_000 }, () => {
    // (It used to take the nose-high entry attitude for "upright" and light up for a landing burn
    // at 114 km, flying off into a high orbit.)
    const { sim } = at('entry');
    const target = { lat: -15.2, lon: 111.9 };
    sim.pilot.set({ manual: true, target: 'ship', throttle: 0, engines: 1, sas: 'entry' });
    for (let i = 0; i < 300; i++) sim.step();
    sim.pilot.set({ manual: false });
    const ship = sim.find('ship')!;
    let top = 0;
    for (let i = 0; i < 200_000 && ship.status === 'flight'; i++) {
      sim.step();
      if (i % 100 === 0) top = Math.max(top, sim.snapshot().vehicles.find((v) => v.id === 'ship')!.telemetry.altitude);
    }
    const s = sim.snapshot().vehicles.find((v) => v.id === 'ship')!;
    expect(top).toBeLessThan(120e3);
    expect(ship.status).toBe('landed');
    expect(distanceKm(s.telemetry, target)).toBeLessThan(50);
  });
});

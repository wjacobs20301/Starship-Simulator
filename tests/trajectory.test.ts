import { beforeAll, describe, expect, it } from 'vitest';
import { ecefToGeodetic, eciToEcef } from '../src/sim/frames';
import { Simulation } from '../src/sim/simulation';
import type { Trajectory } from '../src/sim/trajectory';

// The map view's prediction, checked against the flight itself: made in the coast after SECO,
// it should call the entry interface almost exactly (vacuum) and the splashdown roughly (the
// real entry flies an attitude profile and a landing burn the prediction knows nothing about).
describe('trajectory prediction', () => {
  const sim = new Simulation();
  let pred: Trajectory;
  let predAt = 0;
  let entryAt = NaN;
  let splash: { lat: number; lon: number; t: number } | null = null;

  beforeAll(() => {
    sim.launch();
    while (sim.mission.phase !== 'coast') sim.step();
    for (let i = 0; i < 6000; i++) sim.step(); // a minute into the coast
    pred = sim.predictTrajectories().find((t) => t.id === 'ship')!;
    predAt = sim.t;
    let prevAlt = Infinity;
    while (sim.t - predAt < 2 * 3600) {
      for (let i = 0; i < 100; i++) sim.step();
      const ship = sim.find('ship');
      if (!ship || ship.status !== 'flight') break;
      const alt = sim.aux.get('ship')!.geo.h;
      if (prevAlt >= 100e3 && alt < 100e3) entryAt = sim.t - predAt;
      prevAlt = alt;
    }
    const ship = sim.find('ship')!;
    const geo = ecefToGeodetic(eciToEcef(ship.r, sim.t));
    splash = { lat: (geo.lat * 180) / Math.PI, lon: (geo.lon * 180) / Math.PI, t: sim.t - predAt };
  }, 120_000);

  it('sees a suborbital path with an apoapsis, an entry and an impact', () => {
    expect(pred).toBeDefined();
    expect(pred.points.length).toBeGreaterThan(50);
    expect(pred.points.length).toBeLessThanOrEqual(701);
    expect(pred.apoapsis).not.toBeNull();
    expect(pred.entry).not.toBeNull();
    expect(pred.impact).not.toBeNull();
    expect(pred.orbit.inclination).toBeGreaterThan(20);
    expect(pred.orbit.inclination).toBeLessThan(35);
  });

  it('predicts the entry interface within seconds', () => {
    expect(entryAt).not.toBeNaN();
    expect(Math.abs(pred.entry!.dt - entryAt)).toBeLessThan(15);
  });

  it('puts the impact near the real splashdown', () => {
    const km = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => {
      const R = 6371;
      const r = Math.PI / 180;
      const dLat = (b.lat - a.lat) * r;
      const dLon = (b.lon - a.lon) * r;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
      return 2 * R * Math.asin(Math.sqrt(h));
    };
    expect(km(pred.impact!, splash!)).toBeLessThan(150);
    expect(Math.abs(pred.impact!.dt - splash!.t)).toBeLessThan(240);
  });
});

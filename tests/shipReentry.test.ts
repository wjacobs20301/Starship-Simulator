import { beforeAll, describe, expect, it } from 'vitest';
import { airRelativeVelocity } from '../src/sim/frames';
import { norm, qrotInv, scale } from '../src/sim/math';
import { Simulation } from '../src/sim/simulation';

// Whole flight through the ship's return. As elsewhere, the bands check the shape (it happens,
// in order, around the real test flights' timeline and place), not exact numbers.
describe('ship reentry and splashdown', () => {
  const sim = new Simulation();
  const at = (re: RegExp) => sim.events.find((e) => re.test(e.text));
  let landedAt: { lat: number; lon: number } | null = null;
  /** During hypersonic entry: the airflow's direction in the ship's body frame (worst case seen). */
  let minBellyFlow = Infinity;

  beforeAll(() => {
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 4500) {
      sim.step(0.02);
      const ship = sim.find('ship');
      const a = sim.aux.get('ship');
      if (ship?.status === 'flight' && a && a.q > 1000 && a.mach > 5) {
        const va = airRelativeVelocity(ship.r, ship.v);
        minBellyFlow = Math.min(minBellyFlow, qrotInv(ship.q, scale(va, 1 / norm(va)))[1]);
      }
      if (ship?.status === 'landed' || ship?.status === 'destroyed') break;
    }
    const aux = sim.aux.get('ship');
    if (aux) landedAt = { lat: (aux.geo.lat * 180) / Math.PI, lon: (aux.geo.lon * 180) / Math.PI };
  }, 240_000); // (A whole flight: ~20 s alone, several times that with the full suite running in parallel.)

  it('flies entry, belly-flop, flip and landing burn in order', () => {
    const order = [/^SECO/, /^Entry interface/, /^Peak heating/, /^Subsonic: belly-flop/, /^Landing flip/, /^Splashdown/];
    const times = order.map((re) => at(re)?.missionTime ?? NaN);
    for (const t of times) expect(t).not.toBeNaN();
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThanOrEqual(times[i - 1]);
  });

  it('holds its entry attitude (a controlled entry, not a tumble)', () => {
    const heat = Number(/~(\d+) W/.exec(at(/^Peak heating/)!.text)![1]);
    expect(heat).toBeGreaterThan(10);
    expect(heat).toBeLessThan(120);
  });

  it('splashes down softly in the Indian Ocean about an hour after launch', () => {
    const e = at(/^Splashdown/)!;
    expect(e.missionTime! / 60).toBeGreaterThan(50);
    expect(e.missionTime! / 60).toBeLessThan(80);
    expect(Number(/\(([\d.]+) m\/s/.exec(e.text)![1])).toBeLessThan(6);
    expect(landedAt!.lon).toBeGreaterThan(50);
    expect(landedAt!.lon).toBeLessThan(125);
    expect(landedAt!.lat).toBeLessThan(5);
    expect(landedAt!.lat).toBeGreaterThan(-40);
  });

  it('enters belly-first: the flow meets the tiled side (body +y, the model\'s heat shield)', () => {
    expect(minBellyFlow).toBeLessThan(Infinity);
    // At 60 deg angle of attack the flow's component onto the belly is sin(60) = 0.87.
    expect(minBellyFlow).toBeGreaterThan(0.7);
  });
});

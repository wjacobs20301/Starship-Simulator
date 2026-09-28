import { describe, expect, it } from 'vitest';
import { RAPTOR3 } from '../src/sim/config/starshipV3';
import { planIgnition } from '../src/sim/landingPlan';
import { Simulation } from '../src/sim/simulation';

// The booster comes home however the player flew the ascent and whenever they staged, as long as
// it has the propellant to: staged early (heavy, so it has to vent and light the landing burn
// earlier), staged late off a steep climb (a fast fall from high up: entry burn), or flown
// off the autopilot's profile.
describe('booster recovery after a player-flown ascent', () => {
  /**
   * Fly the ascent (the autopilot, or the player holding prograde with a pitch input for a
   * while), stage at `stageAt` s, and let the booster come home.
   */
  const fly = (stageAt: number, manual: { pitch: number; from: number; to: number } | null) => {
    const sim = new Simulation();
    sim.launch();
    const tm = () => sim.mission.missionTime ?? -99;
    let staged = false;
    while (tm() < 800) {
      const t = tm();
      if (manual && !staged && t > 10) {
        sim.pilot.set({ manual: true, target: 'stack', sas: 'prograde', throttle: 1, pitch: t > manual.from && t < manual.to ? manual.pitch : 0 });
      }
      if (!staged && t >= stageAt && sim.find('stack')) {
        sim.stage();
        staged = true;
        if (manual) sim.pilot.set({ pitch: 0 });
      }
      if (manual && staged && sim.find('ship')) sim.pilot.set({ target: 'ship', sas: 'prograde' });
      sim.step();
      const b = sim.find('booster');
      if (b && b.status !== 'flight') break;
    }
    const caught = sim.events.find((e) => /^Booster caught/.test(e.text));
    return { sim, caught, events: sim.events.map((e) => e.text) };
  };

  const expectCaught = (r: ReturnType<typeof fly>) => {
    expect(r.caught, r.events.slice(-6).join(' | ')).toBeTruthy();
    expect(Number(/([\d.]+) m off center/.exec(r.caught!.text)![1])).toBeLessThan(1.5);
  };

  it('staged early and heavy: vents what it can\'t use and lands', () => {
    const r = fly(80, null);
    expectCaught(r);
    expect(r.events.some((e) => /^Venting excess propellant/.test(e))).toBe(true);
  }, 60_000);

  it('staged at 45 km off a flatter climb', () => {
    expectCaught(fly(110, { pitch: 0.3, from: 20, to: 30 }));
  }, 60_000);

  it('staged high off a steep climb: an entry burn keeps the fall inside the airframe\'s limits', () => {
    const r = fly(135, { pitch: 0, from: 0, to: 0 });
    expectCaught(r);
    expect(r.events.some((e) => /^Entry burn startup/.test(e))).toBe(true);
  }, 60_000);

  it('the boostback puts the landing point within 100 m of the tower', () => {
    const r = fly(9999, null);
    const cutoff = r.events.find((e) => /^Boostback burn shutdown/.test(e))!;
    expect(Number(/miss ([\d.]+) km/.exec(cutoff)![1])).toBeLessThan(0.1);
    expectCaught(r);
  }, 60_000);
});

describe('landing burn planning', () => {
  const lander = { type: RAPTOR3, many: 13, few: 3, liftPerRad: 170 };
  const fall = (mass: number) => planIgnition({ z: 30e3, vh: 50, vz: -900, mass }, 150, lander, 0.8);

  it('lights as late as it can with margin', () => {
    const p = fall(350e3);
    expect(p.ok).toBe(true);
    expect(p.burn.peak).toBeLessThanOrEqual(0.8);
    expect(p.z).toBeGreaterThan(2e3);
    expect(p.z).toBeLessThan(15e3);
  });

  it('a heavier booster lights higher', () => {
    expect(fall(550e3).z).toBeGreaterThan(fall(350e3).z + 500);
  });
});

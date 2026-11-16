import { describe, expect, it } from 'vitest';
import { PAD } from '../src/sim/constants';
import { STARSHIP_V3 } from '../src/sim/config/starshipV3';
import { SHIP_CATCH_PIN } from '../src/sim/shipReturn';
import { STANDS, STAND_HEIGHT } from '../src/sim/padCollision';
import { eciDirToPad, eciToPad } from '../src/sim/padFrame';
import { qrot } from '../src/sim/math';
import { ROLL, rolloutRoute, routeAt, routeLength } from '../src/sim/rollout';
import { Simulation } from '../src/sim/simulation';
import { ARMS } from '../src/sim/tower';

describe('rollout: the ship comes from the Starfactory on its transport', () => {
  it('the way runs along the highway and ends on each pad\'s stand', () => {
    for (const pad of [0, 1]) {
      const route = rolloutRoute(pad);
      const len = routeLength(route);
      expect(len).toBeGreaterThan(3500);
      expect(len).toBeLessThan(4600);
      const end = routeAt(route, len);
      expect(Math.hypot(end.e - STANDS[pad].at[0], end.n - STANDS[pad].at[1])).toBeLessThan(1e-6);
      // (No doubling back on itself: every 20 m along it is 20 m, or nearly, from the last.)
      let last = routeAt(route, 0);
      for (let s = 20; s < len; s += 20) {
        const p = routeAt(route, s);
        expect(Math.hypot(p.e - last.e, p.n - last.n)).toBeGreaterThan(14);
        last = p;
      }
    }
  });

  it('filmed in clips, the transport is taken on up the road: never back, never onto the stand, and still upright there', () => {
    const sim = new Simulation();
    sim.reset();
    sim.startAt('rollout');
    const ship = sim.find('ship')!;
    const length = routeLength(sim.transport!.route);
    for (let i = 0; i < 300; i++) sim.step();
    sim.skipRollout(1500);
    expect(sim.transport!.s).toBe(1500);
    expect(sim.transport!.v).toBe(ROLL.speed);
    const at = routeAt(sim.transport!.route, 1500);
    const p = eciToPad(ship.r, sim.t);
    expect(Math.hypot(p[0] - at.e, p[1] - at.n)).toBeLessThan(0.01);
    expect(eciDirToPad(qrot(ship.q, [1, 0, 0]), sim.t)[2]).toBeGreaterThan(0.99999);
    expect(sim.snapshot().transport?.progress).toBeCloseTo(1500 / length, 9);
    // (On from there as ever.)
    for (let i = 0; i < 100; i++) sim.step();
    expect(sim.transport!.s).toBeCloseTo(1500 + ROLL.speed, 1);
    sim.skipRollout(400);
    expect(sim.transport!.s).toBeGreaterThan(1500);
    // (To the end: short of the stand, at the crawl, and it drives onto it.)
    sim.skipRollout(length + 100);
    expect(length - sim.transport!.s).toBeCloseTo(8, 6);
    expect(sim.transport!.v).toBe(ROLL.crawl);
    expect(sim.transport!.arrived).toBe(false);
    let steps = 0;
    while (!sim.transport!.arrived && steps++ < 100 * 60) sim.step();
    expect(sim.transport!.arrived).toBe(true);
    const end = eciToPad(ship.r, sim.t);
    expect(Math.hypot(end[0] - STANDS[0].at[0], end[1] - STANDS[0].at[1])).toBeLessThan(0.05);
    // (Nothing to skip once it's there.)
    sim.skipRollout(10);
    expect(sim.transport!.arrived).toBe(true);
  });

  for (const pad of [0, 1]) {
    it(`Pad ${pad + 1}: it arrives on the stand, is lifted off it, stacked on the booster, and the stack can launch`, { timeout: 240_000 }, () => {
      const sim = new Simulation();
      sim.launchPad = pad;
      sim.reset();
      sim.startAt('rollout');
      const arms = sim.towers[pad];
      const ship = sim.find('ship')!;
      const booster = sim.find('booster')!;
      const run = (sec: number) => {
        for (let i = 0; i < sec * 100; i++) sim.step();
      };
      expect(booster.status).toBe('held');
      expect(ship.status).toBe('landed');
      const start = eciToPad(ship.r, sim.t);
      expect(Math.hypot(start[0] - STANDS[pad].at[0], start[1] - STANDS[pad].at[1])).toBeGreaterThan(2500);
      // On its way: never faster than its speed, always upright, and there in a quarter of an hour.
      let before = start;
      let steps = 0;
      while (!sim.transport!.arrived && steps++ < 100 * 60 * 16) {
        sim.step();
        const at = eciToPad(ship.r, sim.t);
        expect(Math.hypot(at[0] - before[0], at[1] - before[1])).toBeLessThan(ROLL.speed * 0.01 + 0.02);
        before = at;
        if (steps % 500 === 0) expect(eciDirToPad(qrot(ship.q, [1, 0, 0]), sim.t)[2]).toBeGreaterThan(0.9999);
      }
      expect(sim.transport!.arrived).toBe(true);
      run(2);
      const at = eciToPad(ship.r, sim.t);
      expect(Math.hypot(at[0] - STANDS[pad].at[0], at[1] - STANDS[pad].at[1])).toBeLessThan(0.05);
      expect(ship.status).toBe('landed');
      expect(sim.snapshot().transport?.arrived).toBe(true);
      // (How far along it is, for the cameras and the music: all the way, and stopped.)
      expect(sim.snapshot().transport?.progress).toBeCloseTo(1, 6);
      expect(sim.snapshot().transport?.speed).toBe(0);
      // The arms round to it, down to its fittings, closed, up; back over the mount; down onto the booster.
      // (Nearly shut before they swing: open wide, the arm nearer the mount would be over the
      // booster still when the pair is as far round as it goes, and the carriage would wait up
      // there for it. Swinging and lowering at once is fine: the carriage waits while an arm
      // is over the booster's top.)
      arms.command({ angle: 18 });
      run(5);
      arms.command({ slew: ARMS.maxSlewDeg, offset: STAND_HEIGHT + SHIP_CATCH_PIN - ARMS.homeTop });
      run(60);
      expect(Math.abs(sim.snapshot().towers[pad].lift!.dz)).toBeLessThan(0.05);
      arms.command({ angle: 0 });
      run(8);
      expect(arms.contact).toBe(true);
      arms.command({ offset: PAD.mountHeight + STARSHIP_V3.xBase + SHIP_CATCH_PIN + 4 - ARMS.homeTop });
      run(45);
      expect(ship.status).toBe('caught');
      arms.command({ slew: 0 });
      run(30);
      arms.command({ offset: ARMS.minOffset });
      run(10);
      arms.command({ angle: ARMS.maxOpenDeg });
      run(8);
      expect(sim.events.filter((e) => /pushed over|destroyed/.test(e.text)).map((e) => e.text)).toEqual([]);
      expect(sim.events.some((e) => /stacked on Super Heavy/.test(e.text))).toBe(true);
      expect(sim.find('stack')?.status).toBe('held');
      sim.launch();
      expect(sim.events.at(-1)!.text).toMatch(/Countdown started/);
    });
  }
});

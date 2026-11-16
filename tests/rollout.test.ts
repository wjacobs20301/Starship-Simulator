import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AutoStack } from '../src/sim/autoStack';
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

  it('across the launch site the way keeps clear of every tank, the wall and rack along their ends, and the buildings', () => {
    interface Facility { kind: 'building' | 'vtank' | 'htank'; center: number[]; ring?: number[][]; diameter?: number; length?: number; angle?: number }
    // (The site's tanks and buildings as the game has them: a copy kept with the tests, the game's own file being built, not kept.)
    const facilities = (JSON.parse(readFileSync(new URL('./fixtures/launch-site-facilities.json', import.meta.url), 'utf8')) as { facilities: Facility[] }).facilities;
    expect(facilities.filter((f) => f.kind === 'htank').length).toBeGreaterThan(30);
    /** How far a point is from a tank's or a building's footprint, m (0: on it). */
    const off = (f: Facility, e: number, n: number): number => {
      if (f.kind === 'vtank') return Math.max(0, Math.hypot(e - f.center[0], n - f.center[1]) - f.diameter! / 2);
      if (f.kind === 'htank') {
        const [c, s] = [Math.cos(f.angle!), Math.sin(f.angle!)];
        const [u, v] = [(e - f.center[0]) * c + (n - f.center[1]) * s, -(e - f.center[0]) * s + (n - f.center[1]) * c];
        return Math.hypot(Math.max(0, Math.abs(u) - f.length! / 2), Math.max(0, Math.abs(v) - f.diameter! / 2));
      }
      const ring = f.ring ?? [];
      let d = Infinity;
      let inside = false;
      for (let k = 0; k + 1 < ring.length; k++) {
        const [a, b] = [ring[k], ring[k + 1]];
        const t = Math.max(0, Math.min(1, ((e - a[0]) * (b[0] - a[0]) + (n - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2 || 1)));
        d = Math.min(d, Math.hypot(e - a[0] - t * (b[0] - a[0]), n - a[1] - t * (b[1] - a[1])));
        if (a[1] > n !== b[1] > n && e < a[0] + ((n - a[1]) / (b[1] - a[1])) * (b[0] - a[0])) inside = !inside;
      }
      return inside ? 0 : d;
    };
    for (const pad of [0, 1]) {
      const route = rolloutRoute(pad);
      const len = routeLength(route);
      // (From where it leaves the highway to where it turns in beside the mount.)
      for (let s = len - 420 - pad * 360; s < len - 40; s += 0.5) {
        const p = routeAt(route, s);
        for (const f of facilities) {
          // A big tank lying down: its end, the blast wall 4 m off it, the pipe rack to 10.5 m, and half the transport's 13 m.
          const need = f.kind === 'htank' ? (f.diameter! > 5 ? 18 : 10) : f.kind === 'vtank' ? 9 : 7.5;
          const d = off(f, p.e, p.n);
          if (d < need) throw new Error(`Pad ${pad + 1}: ${d.toFixed(1)} m from a ${f.kind} at ${f.center.map((x) => x.toFixed(0))}, ${(len - s).toFixed(0)} m from the stand`);
        }
      }
    }
  });

  for (const pad of [0, 1]) {
    it(`Pad ${pad + 1}: the arms stack it by themselves, and the stack can launch; a hand on the arms stops them`, { timeout: 120_000 }, () => {
      const sim = new Simulation();
      sim.launchPad = pad;
      sim.reset();
      sim.startAt('rollout');
      // (Nothing to stack until it's on the stand.)
      expect(AutoStack.ready(sim, pad)).toBe(false);
      expect(new AutoStack(sim, pad).stage).toBeNull();
      sim.skipRollout(routeLength(sim.transport!.route));
      for (let i = 0; i < 6000 && !sim.transport!.arrived; i++) sim.step();
      expect(AutoStack.ready(sim, pad)).toBe(true);
      expect(AutoStack.ready(sim, 1 - pad)).toBe(false);
      const stacker = new AutoStack(sim, pad);
      const stages: string[] = [];
      const t0 = sim.t;
      for (let i = 0; i < 100 * 300 && stacker.stage; i++) {
        if (stages[stages.length - 1] !== stacker.stage) stages.push(stacker.stage);
        stacker.step();
        sim.step();
      }
      expect(stages).toEqual(['close', 'reach', 'grip', 'lift', 'swing', 'lower', 'clear']);
      expect(sim.t - t0).toBeLessThan(180);
      expect(sim.events.filter((e) => /pushed over|destroyed|Stacking stopped/.test(e.text)).map((e) => e.text)).toEqual([]);
      expect(sim.events.some((e) => /stacked on Super Heavy/.test(e.text))).toBe(true);
      expect(sim.find('stack')?.status).toBe('held');
      // (The arms where they stand for a launch.)
      expect(sim.towers[pad].offset).toBeCloseTo(ARMS.launchOffset, 1);
      expect(sim.towers[pad].angle).toBeCloseTo(ARMS.openDeg, 0);
      sim.launch();
      expect(sim.events.at(-1)!.text).toMatch(/Countdown started/);
    });
  }

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

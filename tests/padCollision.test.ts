import { describe, expect, it } from 'vitest';
import { OMEGA_E, PAD } from '../src/sim/constants';
import { STARSHIP_V3 } from '../src/sim/config/starshipV3';
import { SHIP_CATCH_PIN } from '../src/sim/shipReturn';
import { type V3, add, cross } from '../src/sim/math';
import { MOUNTS, TOWERS, armColumns, armContact, awayFromTower, catchGap, catchPoint, cylinder, qdContact, surfaceUnder, towerContact } from '../src/sim/padCollision';
import { PAD_COLLIDERS } from '../src/sim/padColliders';
import { padDirToEci, padToEci } from '../src/sim/padFrame';
import { Simulation } from '../src/sim/simulation';
import { ARMS } from '../src/sim/tower';

const settled = { offset: ARMS.launchOffset, angle: 0, broken: { L: false, R: false }, down: false, slew: 0, qd: ARMS.qdStowedDeg, qdBroken: false };

describe('tower and chopstick collisions', () => {
  it('the arms first touch a centred booster well before they are fully closed', () => {
    const top = ARMS.homeTop + ARMS.launchOffset;
    const hull = cylinder([0, 0, top - 65], [0, 0, 1], 72);
    expect(armContact(0, 'L', settled, hull, 40)).toBeNull();
    expect(armContact(0, 'R', settled, hull, 40)).toBeNull();
    expect(armContact(0, 'L', settled, hull, 0)).not.toBeNull();
    expect(armContact(0, 'R', settled, hull, 0)).not.toBeNull();
  });

  it('the nominal catch never touches an arm and the arms stop on the hull', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 480 && sim.find('booster')?.status !== 'caught') sim.step();
    expect(sim.find('booster')!.status).toBe('caught');
    expect(sim.events.some((e) => /struck|hit the|wrecked|destroyed/.test(e.text))).toBe(false);
    expect(sim.towers[0].angle).toBeGreaterThan(10);
    expect(sim.towers[0].contact).toBe(true);
    expect(sim.health.get('booster')?.damage ?? 0).toBe(0);
  });

  /** Take the hovering booster, put its CG at `cg` (pad frame) moving at `vel` (m/s), run 8 s. */
  const fly = (place: (sim: Simulation) => { cg: V3; vel: V3 }) => {
    const sim = new Simulation();
    sim.launch();
    while (!sim.events.some((e) => /^Final approach/.test(e.text))) sim.step();
    sim.pilot.set({ manual: true, target: 'booster', sas: 'stability', engines: 2, throttle: 0.4 });
    const b = sim.find('booster')!;
    const { cg, vel } = place(sim);
    b.r = padToEci(cg, sim.t);
    b.v = add(padDirToEci(vel, sim.t), cross([0, 0, OMEGA_E], b.r));
    for (let i = 0; i < 800; i++) sim.step();
    return { sim, b };
  };

  /**
   * Beside the south arm, halfway along it, fins just below the rails, moving square into it.
   * (Offset square to the arm, which runs diagonally away from the tower.)
   */
  const intoArm = (speed: number) =>
    fly((sim) => {
      const arms = sim.towers[0];
      const cols = (['L', 'R'] as const).map((s) => armColumns(0, s, arms.offset, arms.angle));
      const meanN = (c: Float64Array) => c.filter((_, i) => i % 4 === 1).reduce((a, x) => a + x, 0);
      const south = meanN(cols[0]) < meanN(cols[1]) ? cols[0] : cols[1];
      // Arm direction from the hinge (on Pad 1's tower corner) out to a column about halfway
      // along it, and its outward normal (away from the centreline between the arms).
      const [he, hn] = [PAD_COLLIDERS[0].carriage.pos[0], -PAD_COLLIDERS[0].carriage.pos[2]];
      let best = 0;
      const along = (i: number) => Math.abs(Math.hypot(south[i] - he, south[i + 1] - hn) - 12);
      for (let i = 0; i < south.length; i += 4) if (along(i) < along(best)) best = i;
      const d = [south[best] - he, south[best + 1] - hn];
      const len = Math.hypot(d[0], d[1]);
      let nrm = [-d[1] / len, d[0] / len];
      if (nrm[1] > 0) nrm = [-nrm[0], -nrm[1]];
      const xcg = sim.aux.get('booster')!.mp.xcg;
      const off = 10;
      return {
        cg: [south[best] + nrm[0] * off, south[best + 1] + nrm[1] * off, arms.top - 70 + xcg],
        vel: [-nrm[0] * speed, -nrm[1] * speed, 0],
      };
    });

  it('ramming an arm wrecks both the booster and the arm', { timeout: 120_000 }, () => {
    const { sim, b } = intoArm(8);
    expect(b.status).toBe('destroyed');
    expect(sim.events.some((e) => /hit the Pad 1 chopsticks/.test(e.text))).toBe(true);
    expect(sim.towers[0].broken.L || sim.towers[0].broken.R).toBe(true);
    // Wrecked arms don't move any more.
    const a = sim.towers[0].angle;
    sim.commandArms(0, null, -1);
    for (let i = 0; i < 100; i++) sim.step();
    expect(sim.towers[0].angle).toBe(a);
  });

  it('a gentle knock pushes the booster away and damages it', { timeout: 120_000 }, () => {
    const { sim, b } = intoArm(2);
    expect(b.status).toBe('flight');
    const d = sim.health.get('booster')!.damage;
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
    expect(sim.towers[0].broken.L || sim.towers[0].broken.R).toBe(false);
  });

  it('flying into the tower wrecks the tower', { timeout: 120_000 }, () => {
    // East face of Pad 1's tower lattice is at e = -25.4: start just clear of it, moving west.
    const { sim, b } = fly((s) => ({ cg: [-25.4 + 5, 0, 60 + s.aux.get('booster')!.mp.xcg], vel: [-6, 0, 0] }));
    expect(b.status).toBe('destroyed');
    expect(sim.towers[0].down).toBe(true);
    expect(sim.events.some((e) => /Pad 1 tower destroyed/.test(e.text))).toBe(true);
  });
});

describe('a caught booster hangs on the arms, not on nothing', () => {
  it('stays up while the arms grip it; falls when they open', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.launch();
    while (sim.find('booster')?.status !== 'caught') {
      sim.step();
      expect(sim.mission.missionTime ?? 0).toBeLessThan(500);
    }
    const b = sim.find('booster')!;
    // Hangs there while the arms stay closed on it.
    for (let i = 0; i < 1000; i++) sim.step();
    expect(b.status).toBe('caught');
    // The player opens the chopsticks: it drops onto the launch mount.
    sim.commandArms(0, null, 1);
    for (let i = 0; i < 1500 && b.status !== 'destroyed'; i++) sim.step();
    expect(sim.events.some((e) => /released: the chopsticks let go/.test(e.text))).toBe(true);
    expect(b.status).toBe('destroyed');
  });

  it('the connected ship QD arm reaches the ship on the mount, and clears it once swung back', () => {
    for (const pad of [0, 1]) {
      const [e, n] = MOUNTS[pad];
      const a = awayFromTower(pad);
      const hull = cylinder([e - 3 * a[0], n - 3 * a[1], 80], [0, 0, 1], 52);
      const out = { ...settled, qd: 0 };
      expect(qdContact(pad, out, hull)).not.toBeNull();
      expect(qdContact(pad, { ...out, qd: ARMS.qdStowedDeg }, hull)).toBeNull();
      expect(qdContact(pad, { ...out, qdBroken: true }, hull)).toBeNull();
      // Connected (as for fuelling), its hood meets the hull of a ship centred on the mount.
      const centred = cylinder([e, n, 80], [0, 0, 1], 52);
      expect(qdContact(pad, out, centred)).not.toBeNull();
      expect(qdContact(pad, { ...out, qd: ARMS.qdStowedDeg }, centred)).toBeNull();
    }
  });

  it('the catch gap runs across each tower-to-mount line', () => {
    expect(catchGap(0)[1]).toBeCloseTo(1, 3);
    expect(Math.abs(catchGap(1)[0])).toBeCloseTo(1, 2);
    for (const pad of [0, 1]) expect(Math.abs(catchGap(pad)[0] * awayFromTower(pad)[0] + catchGap(pad)[1] * awayFromTower(pad)[1])).toBeLessThan(1e-9);
  });

  it('the arms swing what they hold round the tower, clear of it and of the mount', () => {
    for (const pad of [0, 1]) {
      expect(catchPoint(pad, 0)).toEqual(MOUNTS[pad]);
      const [se, sn] = catchPoint(pad, 90);
      const [me, mn] = MOUNTS[pad];
      const [te, tn] = TOWERS[pad];
      // Swung about the carriage pivot: off to the tower's side, clear of the mount.
      expect(Math.hypot(se - te, sn - tn)).toBeGreaterThan(20);
      expect(Math.hypot(se - me, sn - mn)).toBeGreaterThan(25);
      expect(surfaceUnder([se, sn, 0])).toBe(0);
      // A vehicle set down there is clear of the tower and its (swung) arms.
      const hull = cylinder([se, sn, 0], [0, 0, 1], 70);
      const t = { ...settled, offset: 0, slew: 90, angle: 40 };
      expect(towerContact(pad, t, hull)).toBeNull();
      expect(qdContact(pad, t, hull)).toBeNull();
    }
  });

  it('an arm swung into a standing rocket tips it over, and it is destroyed when it hits the ground', () => {
    const sim = new Simulation();
    const stack = sim.find('stack')!;
    sim.towers[0].command({ slew: ARMS.maxSlewDeg });
    let pushed = -1;
    for (let i = 0; i < 60 * 100 && stack.status !== 'destroyed'; i++) {
      sim.step();
      if (pushed < 0 && sim.events.some((e) => /pushed over/.test(e.text))) pushed = sim.t;
    }
    expect(pushed).toBeGreaterThan(0);
    expect(stack.status).toBe('destroyed');
    expect(sim.events.some((e) => /toppled over/.test(e.text))).toBe(true);
  });

  it('closing both arms on a standing rocket squeezes it without tipping it', () => {
    const sim = new Simulation();
    const stack = sim.find('stack')!;
    sim.towers[0].command({ angle: 0 });
    for (let i = 0; i < 30 * 100; i++) sim.step();
    expect(sim.events.some((e) => /pushed over/.test(e.text))).toBe(false);
    expect(stack.status).toBe('held');
  });

  it('the arms lift the ship off the booster by its catch fittings and stack it back on', () => {
    const sim = new Simulation();
    const arms = sim.towers[0];
    const run = (sec: number) => {
      for (let i = 0; i < sec * 100; i++) sim.step();
    };
    const knobs = PAD.mountHeight + STARSHIP_V3.xBase + SHIP_CATCH_PIN;
    // Rails to the ship's fittings, close on it, lift.
    arms.command({ offset: knobs - ARMS.homeTop });
    run(10);
    arms.command({ angle: 0 });
    run(8);
    expect(arms.contact).toBe(true);
    arms.command({ offset: knobs - ARMS.homeTop + 6 });
    run(5);
    expect(sim.events.some((e) => /lifting Starship off Super Heavy/.test(e.text))).toBe(true);
    const ship = sim.find('ship')!;
    const booster = sim.find('booster')!;
    expect(ship.status).toBe('caught');
    expect(booster.status).toBe('held');
    // Launch refuses with the ship off.
    sim.launch();
    expect(sim.events.at(-1)!.text).toMatch(/Can't launch/);
    // Down again: it comes to rest on the booster (the carriage stops there), then let go.
    arms.command({ offset: ARMS.minOffset });
    run(8);
    arms.command({ angle: ARMS.maxOpenDeg });
    run(6);
    expect(sim.events.some((e) => /stacked on Super Heavy/.test(e.text))).toBe(true);
    const stack = sim.find('stack')!;
    expect(stack.status).toBe('held');
    expect(sim.find('ship')).toBeUndefined();
    sim.launch();
    expect(sim.events.at(-1)!.text).toMatch(/Countdown started/);
  });
});

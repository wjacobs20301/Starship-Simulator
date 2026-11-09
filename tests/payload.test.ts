import { describe, expect, it } from 'vitest';
import { STARLINK_V3 } from '../src/sim/config/starshipV3';
import { orbitApsides } from '../src/sim/guidance';
import { norm, qrotInv, sub } from '../src/sim/math';
import { Simulation } from '../src/sim/simulation';
import { massProps, payloadOf } from '../src/sim/vehicle';

/** Flight 15 as the mission flies it: Pad 2, 26 Starlink V3 aboard, home after SECO to the Pad 2 tower, swung round. */
function flight15() {
  const sim = new Simulation();
  sim.launchPad = 1;
  sim.configure({ payload: 'starlink', parkingAlt: 275e3 });
  sim.reset();
  sim.launch();
  while (sim.mission.phase !== 'coast') sim.step();
  sim.commandReturn({ kind: 'tower', pad: 1, slew: -70 });
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

  it('the whole flight: booster caught at Pad 2 and set back on its mount, satellites out, ship caught by the same tower, swung round, about 14 orbits later', { timeout: 400_000 }, () => {
    const sim = flight15();
    const ship = sim.find('ship')!;
    runUntil(sim, () => ship.status !== 'flight' || !sim.mission.shipReturn);
    const has = (re: RegExp) => sim.events.some((e) => re.test(e.text));
    expect(has(/^Booster caught!/)).toBe(true);
    // The tower turned round for the ship: booster on the mount, arms up and swung aside.
    expect(has(/^Super Heavy back on the Pad 2 launch mount/)).toBe(true);
    expect(has(/pushed over/)).toBe(false);
    expect(has(/^Pad 2 chopsticks ready for the ship/)).toBe(true);
    const booster = sim.find('booster')!;
    expect(booster.status).not.toBe('destroyed');
    expect(booster.status).not.toBe('caught');
    expect(sim.bay!.aboard).toBe(0);
    expect(ship.status).toBe('caught');
    expect(ship.caughtPad).toBe(1);
    expect(sim.towers[1].slew).toBeCloseTo(-70, 0);
    const hours = (sim.t - sim.mission.tZero!) / 3600;
    expect(hours).toBeGreaterThan(18);
    expect(hours).toBeLessThan(26);
  });
});

describe('Starlink spacing and the deploy key', () => {
  it('the satellites string out: none closes on another or comes back to the ship', { timeout: 300_000 }, () => {
    const sim = flight15();
    const ship = sim.find('ship')!;
    const bay = sim.bay!;
    let pair = Infinity;
    let toShip = Infinity;
    let last = 0;
    const end = () => sim.t - sim.mission.tZero!;
    for (let i = 0; i < 3e6 && end() < 3 * 3600 && ship.status === 'flight'; i++) {
      const a = sim.waitUntil;
      if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(20, a - sim.t));
      else sim.step();
      if (sim.t - last < 5) continue;
      last = sim.t;
      const s = bay.sats;
      for (let p = 0; p < s.length; p++) {
        // (Once clear of the slot: neighbours leave it ~35 m apart.)
        if (sim.t - s[p].released < 60) continue;
        toShip = Math.min(toShip, norm(sub(s[p].r, ship.r)));
        for (let q = p + 1; q < s.length; q++) if (sim.t - s[q].released >= 60) pair = Math.min(pair, norm(sub(s[p].r, s[q].r)));
      }
    }
    expect(bay.sats).toHaveLength(26);
    expect(pair).toBeGreaterThan(25);
    expect(toShip).toBeGreaterThan(30);
  });

  it('each satellite leaves straight through the slot: it fills it with only centimetres to spare', { timeout: 300_000 }, () => {
    const sim = flight15();
    const ship = sim.find('ship')!;
    const bay = sim.bay!;
    const start = new Map<number, number[]>();
    let along = 0;
    let across = 0;
    let seen = 0;
    runUntil(sim, () => {
      // (The satellites moved on to the ship's time first.)
      bay.fly(sim.t);
      for (const s of bay.sats) {
        if (sim.t - s.released > 12) continue;
        const rel = qrotInv(ship.q, sub(s.r, ship.r));
        if (!start.has(s.n)) start.set(s.n, rel);
        const st = start.get(s.n)!;
        // Until its inner edge is out past the hull.
        if (st[1] - rel[1] < STARLINK_V3.width + 0.6) {
          along = Math.max(along, Math.abs(rel[0] - st[0]));
          across = Math.max(across, Math.abs(rel[2] - st[2]));
          seen++;
        }
      }
      return bay.state === 'done' || ship.status !== 'flight';
    });
    expect(start.size).toBe(26);
    expect(seen).toBeGreaterThan(1000);
    expect(along).toBeLessThan(0.02);
    expect(across).toBeLessThan(0.02);
    // (The slot runs 34.65-35.52 m up the ship; a stowed satellite spans -0.38/+0.43 m about its bus.)
    expect(STARLINK_V3.doorX - 0.38).toBeGreaterThan(34.65);
    expect(STARLINK_V3.doorX + 0.43).toBeLessThan(35.52);
  });

  it('B deploys when asked (Free Roam): not before separation, held and resumed, burned up if suborbital', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.configure({ payload: 'starlink', deploy: 'manual' });
    sim.reset();
    sim.launch();
    const has = (re: RegExp) => sim.events.some((e) => re.test(e.text));
    for (let i = 0; i < 2000; i++) sim.step();
    sim.requestDeploy();
    expect(has(/^Starlinks deploy from the ship, once it has separated/)).toBe(true);
    const ship = () => sim.find('ship');
    // Up past 120 km in the coast (the test-flight profile: suborbital).
    for (let i = 0; i < 60000 && !(ship() && sim.mission.phase === 'coast' && norm(ship()!.r) - 6378137 > 150e3); i++) sim.step();
    // (Engines spooled down.)
    for (let i = 0; i < 3000; i++) sim.step();
    // (Not on its own: the planned time passes without a deployment.)
    expect(sim.bay!.state).toBe('stowed');
    sim.requestDeploy();
    expect(has(/^Starlink deployment: ship turning to the deployment attitude, 26 to go/)).toBe(true);
    for (let i = 0; i < 30000 && sim.bay!.aboard > 24; i++) sim.step();
    expect(sim.bay!.aboard).toBe(24);
    sim.requestDeploy();
    expect(has(/^Starlink deployment held: 24 still aboard/)).toBe(true);
    for (let i = 0; i < 30000 && sim.bay!.state !== 'stowed'; i++) sim.step();
    expect(has(/^Payload door shut: 24 Starlinks still aboard/)).toBe(true);
    expect(has(/^Payload door closed/)).toBe(false);
    // They came out on the ship's suborbital path: down with it, they burn up.
    for (let i = 0; i < 400000 && sim.bay!.sats.length; i++) sim.step();
    expect(has(/^Starlink 1 re-entered and burned up/)).toBe(true);
  });
});

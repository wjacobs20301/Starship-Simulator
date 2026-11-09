import { describe, expect, it } from 'vitest';
import { BOOSTER_OCEAN_ENU, MissionTracker, PACIFIC_TARGET, missionById } from '../src/game/missions';
import { overflight } from '../src/game/places';
import { HeatShield, SHIELD } from '../src/sim/heatShield';
import { Simulation } from '../src/sim/simulation';

/** Run on (warping on rails where it may) until `done` or the guard. */
function runUntil(sim: Simulation, done: () => boolean, guard = 3e6) {
  for (let i = 0; i < guard && !done(); i++) {
    const a = sim.waitUntil;
    if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(60, a - sim.t));
    else sim.step();
  }
}

describe('engine failures', () => {
  it('a landing-burn engine that will not light: the booster balances the rest and is still caught', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.configure({ faults: [{ vehicle: 'booster', stage: 'booster', ring: 1, n: 2, noRelightAfter: 300 }] });
    sim.reset();
    sim.launch();
    runUntil(sim, () => ['caught', 'destroyed', 'landed'].includes(sim.find('booster')?.status ?? ''), 60000);
    expect(sim.events.some((e) => /^Engine out: Booster inner ring Raptor 3 failed to light/.test(e.text))).toBe(true);
    expect(sim.find('booster')!.status).toBe('caught');
  });

  it('an RVac that will not relight in orbit: the sea-level engines join the burn and steer it', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.launchPad = 1;
    sim.configure({ parkingAlt: 275e3, faults: [{ vehicle: 'ship', stage: 'ship', ring: 1, n: 2, noRelightAfter: 600 }] });
    sim.reset();
    sim.launch();
    while (sim.mission.phase !== 'coast') sim.step();
    sim.commandReturn({ kind: 'tower', pad: -1 });
    const ship = sim.find('ship')!;
    // Through the circularisation burn at apoapsis.
    runUntil(sim, () => sim.events.some((e) => /^Return: re-planned deorbit/.test(e.text)) || ship.status !== 'flight');
    expect(sim.events.some((e) => /^Engine out: Ship RVac 3 failed to relight in space/.test(e.text))).toBe(true);
    expect(sim.events.some((e) => /^In-space Raptor relight: 5 of 6 engines lit/.test(e.text))).toBe(true);
    expect(ship.status).toBe('flight');
    expect(sim.snapshot().vehicles.find((v) => v.id === 'ship')!.telemetry.perigee).toBeGreaterThan(200e3);
  });
});

describe('heat shield', () => {
  // A nominal entry's heating on the windward centreline: ~1.2e8 J/m^2 over ~10 minutes.
  const entry = (sh: HeatShield) => {
    for (let t = 0; t < 600; t += 0.5) {
      const flux = 3.7e5 * Math.exp(-(((t - 250) / 180) ** 2));
      const lost = sh.heat(flux, 1, 0.5);
      if (lost) return lost;
    }
    return null;
  };
  const mid = SHIELD.cols / 2;

  it('a missing tile or two scorches; a dozen together burns through; a whole patch gone loses the ship', () => {
    const logs: string[] = [];
    const few = new HeatShield({ lost: [{ row: 12, col: mid, n: 2 }] }, 1, (t) => logs.push(t));
    expect(few.inspect().verdict).toBe('go');
    expect(entry(few)).toBeNull();
    expect(Math.max(...few.char)).toBeLessThan(0.6);

    const dozen = new HeatShield({ lost: [{ row: 12, col: mid, n: 12 }] }, 1, (t) => logs.push(t));
    expect(dozen.inspect().verdict).toBe('nogo');
    expect(entry(dozen)).toBeNull();
    expect(logs.some((l) => /^Burn-through/.test(l))).toBe(true);

    const patch = new HeatShield({ lost: [{ row: 12, col: mid, n: SHIELD.tilesPer }] }, 1, () => {});
    expect(entry(patch)).toMatch(/burn-through into the tank/);
  });

  it('a burn-through at a flap hinge cooks the flap, not the tank', () => {
    const sh = new HeatShield({ lost: [{ row: 2, col: 0, n: SHIELD.tilesPer }] }, 1, () => {});
    // (The sides take less heat than the centreline: a hotter entry to burn through there.)
    for (let t = 0; t < 600; t += 0.5) sh.heat(1.2e6 * Math.exp(-(((t - 250) / 140) ** 2)), 1, 0.5);
    expect(sh.flapsHit.size).toBe(1);
  });

  it('random loss on the way up is a few tiles at most, and none when off', () => {
    let total = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const sh = new HeatShield('random', seed, () => {});
      sh.shake('liftoff');
      sh.shake('maxq');
      sh.shake('staging');
      expect(sh.lost).toBeLessThan(30);
      total += sh.lost;
    }
    expect(total / 40).toBeGreaterThan(0.5);
    expect(total / 40).toBeLessThan(8);
    const off = new HeatShield('off', 1, () => {});
    off.shake('staging');
    expect(off.lost).toBe(0);
  });
});

describe('the way home over Mexico', () => {
  it('names the places under the entry corridor', () => {
    expect(overflight(24.5, -118)).toBe('over the Pacific Ocean');
    expect(overflight(25.44, -110.39)).toBe('over the Gulf of California');
    expect(overflight(25.7, -100.3)).toBe('over Monterrey, Nuevo León');
    expect(overflight(26.0, -97.16)).toBe('over Starbase, Texas');
    expect(overflight(-15, 110)).toBeNull();
  });
});

describe('Flight 14 replay', () => {
  it('flies as it happened: engine outs, the booster on the Gulf, orbit, 26 Starlinks, a splashdown north of Hawaii', { timeout: 300_000 }, () => {
    const def = missionById('flight14');
    const tracker = new MissionTracker(def);
    const sim = new Simulation();
    sim.launchPad = def.setup.pad!;
    sim.boosterOcean = BOOSTER_OCEAN_ENU;
    sim.configure({ payload: 'starlink', parkingAlt: def.setup.parkingAlt, faults: def.setup.faults, splashFireball: true });
    sim.reset();
    sim.launch();
    let result = null;
    let i = 0;
    const feed = () => {
      if (i++ % 50 === 0 || sim.mission.phase === 'coast') result ??= tracker.update(sim.snapshot());
    };
    while (sim.mission.phase !== 'coast') {
      sim.step();
      feed();
    }
    // (What the game does at SECO for this mission: home to its target.)
    sim.commandReturn({ kind: 'ocean', ...PACIFIC_TARGET });
    const ship = sim.find('ship')!;
    for (let k = 0; k < 3e6 && ship.status !== 'destroyed'; k++) {
      const a = sim.waitUntil;
      if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(60, a - sim.t));
      else sim.step();
      feed();
    }
    result ??= tracker.update(sim.snapshot());
    const has = (re: RegExp) => sim.events.some((e) => re.test(e.text));
    expect(has(/^Engine out: Ship sea-level Raptor 2 shut down/)).toBe(true);
    expect(has(/^Engine out: Booster inner ring/)).toBe(true);
    expect(has(/^Super Heavy splashdown/)).toBe(true);
    expect(has(/^All 26 Starlink V3 satellites deployed/)).toBe(true);
    expect(has(/^Starship tipped over after its splashdown/)).toBe(true);
    const hours = (sim.t - sim.mission.tZero!) / 3600;
    expect(hours).toBeGreaterThan(2.7);
    expect(hours).toBeLessThan(3.6);
    expect(result).not.toBeNull();
    expect(result!.states.every((s) => s === 'done')).toBe(true);
    expect(tracker.record.splash!.km).toBeLessThan(50);
  });
});

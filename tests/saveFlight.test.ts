import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENV } from '../src/sim/dynamics';
import { SAVE_VERSION, type SavedSimulation } from '../src/sim/saveFlight';
import { type Json, constantParts, readGraph, writeGraph } from '../src/sim/saveGraph';
import { ShipReentry } from '../src/sim/shipReentry';
import { ShipReturn } from '../src/sim/shipReturn';
import { Simulation } from '../src/sim/simulation';
import { Land, type WeatherConfig } from '../src/weather/model';
import { flightWeather, loadFlight, saveFlight } from '../src/worker/savedFlight';

// A flight saved part-way and picked up again in a new simulation (a page reload) flies on
// exactly as the original does: not close, the same. Each test flies a flight to some moment,
// saves it, puts the save through JSON text into a fresh Simulation, then flies the original and
// the copy side by side: their snapshots (what the player sees: clock, phase, telemetry, the log
// lines as they come) must be equal all the way, and at the end so must their complete saves
// (everything inside: autopilot plans, random number generators, caches).

/** Through JSON text and into a new simulation, as a reload does. */
function reload(sim: Simulation): Simulation {
  const text = JSON.stringify(sim.save());
  const copy = new Simulation();
  copy.load(JSON.parse(text) as SavedSimulation);
  return copy;
}

/** The two are the same flight: what they show, and everything they hold. */
function expectSame(original: Simulation, copy: Simulation): void {
  expect(copy.snapshot()).toEqual(original.snapshot());
  expect(JSON.stringify(copy.save())).toBe(JSON.stringify(original.save()));
}

const step = (sim: Simulation) => sim.step();
/** As the game's time warp: on rails to the autopilot's next event where it may, else a step. */
const warp = (sim: Simulation) => {
  const a = sim.waitUntil;
  if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(60, a - sim.t));
  else sim.step();
};

/**
 * Fly both on side by side until `done` (of the original), the same way each, checking the
 * snapshots every so often (each check also compares the log lines since the last one).
 */
function flyBoth(original: Simulation, copy: Simulation, done: () => boolean, advance = step, guard = 300_000): void {
  for (let n = 0; n < guard && !done(); n++) {
    advance(original);
    advance(copy);
    if (n % 200 === 0) expect(copy.snapshot()).toEqual(original.snapshot());
  }
  expectSame(original, copy);
}

const missionTime = (sim: Simulation) => sim.mission.missionTime ?? -99;
const logged = (sim: Simulation, re: RegExp) => sim.events.some((e) => re.test(e.text));

/** Only what JSON carries: no undefined, NaN, Infinity, -0, Map, Set, class instance, function. */
function expectPlainJson(x: unknown, path = 'save'): void {
  if (x === null || typeof x === 'string' || typeof x === 'boolean') return;
  if (typeof x === 'number') {
    if (!Number.isFinite(x) || Object.is(x, -0)) throw new Error(`${path}: ${Object.is(x, -0) ? '-0' : x} doesn't survive JSON`);
    return;
  }
  if (Array.isArray(x)) return x.forEach((item, i) => expectPlainJson(item, `${path}[${i}]`));
  if (typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype) {
    for (const [key, value] of Object.entries(x)) expectPlainJson(value, `${path}.${key}`);
    return;
  }
  throw new Error(`${path}: not plain JSON (${typeof x === 'object' ? x.constructor?.name : typeof x})`);
}

describe('the save itself', () => {
  it('is plain JSON, with a version, the flight\'s options and where it had got to', () => {
    const sim = new Simulation();
    sim.launchPad = 1;
    sim.boosterOcean = [30e3, 2e3];
    sim.configure({ payload: 'starlink', parkingAlt: 275e3, faults: [{ vehicle: 'booster', stage: 'booster', ring: 1, n: 2, noRelightAfter: 300 }], tiles: 'random', faultSeed: 9 });
    sim.reset();
    sim.launch();
    while (missionTime(sim) < 5) sim.step();
    const saved = sim.save();
    expectPlainJson(saved);
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(saved.version).toBe(SAVE_VERSION);
    expect(saved.t).toBe(sim.t);
    expect(saved.missionTime).toBeCloseTo(5, 1);
    expect(saved.phase).toBe('ascent');
    expect(saved.pad).toBe(1);
    expect(saved.boosterOcean).toEqual([30e3, 2e3]);
    expect(saved.options).toEqual({
      payload: 'starlink',
      parkingAlt: 275e3,
      faults: [{ vehicle: 'booster', stage: 'booster', ring: 1, n: 2, noRelightAfter: 300 }],
      faultSeed: 9,
      tiles: 'random',
      splashFireball: false,
      deploy: 'auto',
    });
    // (Small enough for localStorage: tens of kilobytes.)
    expect(JSON.stringify(saved).length).toBeLessThan(200e3);
    // A fresh simulation needs nothing set up first: the options and the pad come with the flight.
    const copy = reload(sim);
    expect(copy.launchPad).toBe(1);
    expect(copy.boosterOcean).toEqual([30e3, 2e3]);
    expect(copy.options).toEqual(sim.options);
    expectSame(sim, copy);
  });

  it('refuses a save of another version, or a damaged one, and leaves the flight in progress alone', () => {
    const sim = new Simulation();
    sim.launch();
    while (missionTime(sim) < 3) sim.step();
    const saved = JSON.parse(JSON.stringify(sim.save())) as SavedSimulation;

    const other = new Simulation();
    other.configure({ payload: 'starlink' });
    other.reset();
    for (let i = 0; i < 50; i++) other.step();
    const before = JSON.stringify(other.save());
    expect(() => other.load({ ...saved, version: SAVE_VERSION + 1 })).toThrow(/format version/);
    expect(() => other.load({ ...saved, version: 0 })).toThrow(/format version/);
    expect(() => other.load(null as unknown as SavedSimulation)).toThrow(/isn't a saved flight/);
    expect(() => other.load({ ...saved, state: { ...saved.state, t: { $: 'class', name: 'Warpdrive', fields: {} } } })).toThrow(/Warpdrive/);
    expect(() => other.load({ ...saved, state: { ...saved.state, vehicles: { $: 'ref', id: 9999 } } })).toThrow(/damaged/);
    const { vehicles: _dropped, ...short } = saved.state;
    expect(() => other.load({ ...saved, state: short })).toThrow(/vehicles/);
    expect(() => other.load({ ...saved, state: { ...saved.state, extra: 1 } })).toThrow(/extra/);
    // Nothing changed: still its own flight, and it still flies.
    expect(JSON.stringify(other.save())).toBe(before);
    other.step();
    // And the good save still loads into it, replacing what it was doing.
    other.load(saved);
    expectSame(sim, other);
  });

  it('keeps what JSON alone would lose', () => {
    class Thing {
      constructor(public owner: object | null, public n: number) {}
      double(): number {
        return this.n * 2;
      }
    }
    const fixed = { engines: [{ type: { name: 'Raptor' } }] };
    const kit = { classes: { Thing }, constants: constantParts({ fixed }), functions: { log: Math.abs } };
    const shared = [1, 2, 3];
    const root: Record<string, unknown> = {
      numbers: [NaN, Infinity, -Infinity, -0, 0, 1.1e-300, 0.1 + 0.2],
      nothing: undefined,
      list: [undefined, null],
      map: new Map<unknown, unknown>([['a', new Set([1, 'two'])], [2, shared]]),
      typed: new Float64Array([1.5, -0, NaN]),
      bytes: new Uint8Array([1, 255]),
      a: shared,
      b: shared,
      part: fixed.engines[0].type,
      log: Math.abs,
      skipped: 'left out',
    };
    const thing = new Thing(root, 21);
    root.thing = thing;
    root.loop = { thing, self: null as unknown };
    (root.loop as { self: unknown }).self = root.loop;
    const written = JSON.parse(JSON.stringify(writeGraph(root, kit, ['skipped']))) as Json;
    expectPlainJson(written);
    const newRoot = {};
    const back = readGraph(written, newRoot, kit);
    expect(Object.keys(back)).toEqual(Object.keys(root).filter((k) => k !== 'skipped'));
    expect((back.numbers as number[]).map((x) => (Object.is(x, -0) ? '-0' : String(x)))).toEqual(['NaN', 'Infinity', '-Infinity', '-0', '0', '1.1e-300', '0.30000000000000004']);
    expect('nothing' in back && back.nothing === undefined).toBe(true);
    expect(back.list).toEqual([undefined, null]);
    const map = back.map as Map<unknown, unknown>;
    expect(map).toBeInstanceOf(Map);
    expect([...map.keys()]).toEqual(['a', 2]);
    expect(map.get('a')).toEqual(new Set([1, 'two']));
    expect(back.typed).toBeInstanceOf(Float64Array);
    expect(Object.is((back.typed as Float64Array)[1], -0)).toBe(true);
    expect((back.typed as Float64Array)[2]).toBeNaN();
    expect(back.bytes).toEqual(new Uint8Array([1, 255]));
    // Shared things are one thing again; loops close; the root is the new root.
    expect(back.a).toEqual([1, 2, 3]);
    expect(back.b).toBe(back.a);
    expect(map.get(2)).toBe(back.a);
    const loop = back.loop as { thing: Thing; self: unknown };
    expect(loop.self).toBe(loop);
    expect(loop.thing).toBe(back.thing);
    // A class instance has its methods back (and its constructor didn't run again).
    expect(back.thing).toBeInstanceOf(Thing);
    expect((back.thing as Thing).double()).toBe(42);
    expect((back.thing as Thing).owner).toBe(newRoot);
    // The program's own things are pointed at, not copied.
    expect(back.part).toBe(fixed.engines[0].type);
    expect(back.log).toBe(Math.abs);
    // What can't be saved stops the save, saying where.
    expect(() => writeGraph({ deep: { down: [() => 0] } }, kit)).toThrow(/function.*deep\.down\.0/);
    expect(() => writeGraph({ when: new Date(0) }, kit)).toThrow(/Date.*when/);
  });
});

/**
 * Every field a save holds, class by class. A loaded flight gets exactly the fields its save
 * has: a field added to one of these classes since isn't in an older save, and the flight loaded
 * from it would fly without it. So when this list changes, SAVE_VERSION (sim/saveFlight.ts) must
 * go up, so that older saves are refused; then bring the list up to date.
 */
const SAVED_FIELDS: Record<string, string> = {
  BoosterReturn: 'arms closing correctFrom correcting dvSince entryBurn finVel finalDescent flipWait hoverI hovering impact jac keepEst landEnd lastFin log miss missRef nextPredict ocean pad phase plan sim start threeEngines trimDvBest trimming ventDone vented venting windTab',
  EngineFaults: 'done failures lastRan log ran rand relight relights reported setting starting',
  GravityTurnGuidance: 'azimuthDeg kickAngleDeg kickStart phase',
  HeatShield: 'burned char flapsHit glow load log missing n rand setting shaken verdict',
  InsertionGuidance: 'climbAtCutoff kd kp targetAlt',
  Mission: 'booster boosterReturn flags ignited lastTarget liftoffT maxQ nextSplashCheck phase ship shipManual shipReentry shipReturn sim splashTrim tMeco tZero',
  PayloadBay: 'aboard attitude auto door holding lastRelease nextRelease sats seed state total',
  Pilot: 'cmd deployHold hold maneuverDir sasDir targetDir',
  SeededRandom: 'state',
  ShipReentry: 'heading log logged peakHeat phase sim',
  ShipReturn: 'alphaUp bank bankSign burnIndex burning closing glideHeading heading intOff lastPin lit log milestones nextGuide nextQCheck offLine oneEngine peakHeat phase pinVel plan predicted qAhead reversedAt rollErr ship sim status target touchedUp ventLeft vented venting',
  Simulation: 'aux bay boosterOcean captured deployMode engineFaults eventCursor events faultSeed faults gripped health inOrbitSince launchPad logLine mission node parkingAlt payloadKind pilot returnNotice seaTips shield splashFireball t tileLoss toppling towers turnaround vehicles waitUntil',
  TowerArms: 'angle blocked broken contact down fallDir floor offset qd qdBroken qdTarget slew targetAngle targetOffset targetSlew touching',
  Vehicle: 'catchPin caughtPad engines extForce id name q r rcsTorque rest stages status surfaceAngles surfaceEff surfaces v ventUntil w',
};

describe('the save format', () => {
  it(`is version ${SAVE_VERSION}: the fields saved are the ones this version was pinned with`, { timeout: 60_000 }, () => {
    // A flight with one of everything: both stages just separated, Starlinks aboard, and the
    // ship's two ways down (which a real flight only makes at engine cutoff).
    const sim = new Simulation();
    sim.configure({ payload: 'starlink' });
    sim.reset();
    sim.startAt('separation');
    sim.mission.shipReentry = new ShipReentry(sim, sim.logLine);
    sim.mission.shipReturn = new ShipReturn(sim, sim.find('ship')!, { kind: 'ocean', lat: 0, lon: 0 }, sim.logLine, false);
    const saved = JSON.parse(JSON.stringify(sim.save())) as SavedSimulation;
    const found: Record<string, Set<string>> = { Simulation: new Set(Object.keys(saved.state)) };
    const walk = (x: Json): void => {
      if (x === null || typeof x !== 'object') return;
      if (Array.isArray(x)) return x.forEach(walk);
      if (x.$ === 'class') for (const key of Object.keys(x.fields as object)) (found[String(x.name)] ??= new Set()).add(key);
      Object.values(x).forEach(walk);
    };
    walk(saved.state);
    const fields = Object.fromEntries(Object.keys(found).sort().map((name) => [name, [...found[name]].sort().join(' ')]));
    expect(fields, 'the saved fields changed: raise SAVE_VERSION in src/sim/saveFlight.ts, then update SAVED_FIELDS here').toEqual(SAVED_FIELDS);
    expect(SAVE_VERSION).toBe(1);
    // (And that flight, odd as it is, loads and flies on the same.)
    const copy = reload(sim);
    flyBoth(sim, copy, () => false, step, 500);
  });
});

describe('a flight saved and loaded flies on exactly as the original', () => {
  // (Two seconds alone; the default five were not always enough with every core busy on the
  // rest of the suite.)
  it('on the pad before launch: the countdown, ignition and liftoff', { timeout: 30_000 }, () => {
    const sim = new Simulation();
    sim.configure({ parkingAlt: 275e3 });
    sim.reset();
    for (let i = 0; i < 100; i++) sim.step();
    const copy = reload(sim);
    expectSame(sim, copy);
    expect(copy.mission.phase).toBe('prelaunch');
    sim.launch();
    copy.launch();
    flyBoth(sim, copy, () => missionTime(sim) >= 20);
    expect(copy.mission.phase).toBe('ascent');
    expect(copy.mission.missionTime).toBeCloseTo(20, 1);
    expect(copy.events.map((e) => e.text.replace(/ \(.*/, ''))).toEqual(['Countdown started', 'Ship QD arm retracting', 'Chopsticks opening wide for launch', 'Raptor ignition sequence start', 'Liftoff', 'Tower cleared']);
    expect(copy.find('stack')!.status).toBe('flight');
  });

  it('in the ascent at T+60 s, through max-Q, staging and an engine out; then after separation, with both stages flying, to the booster catch and SECO', { timeout: 240_000 }, () => {
    // (Scripted faults: one that has happened by the second save, one still to come after it.)
    const sim = new Simulation();
    sim.configure({
      payload: 'starlink',
      faults: [
        { vehicle: 'stack', stage: 'ship', ring: 1, n: 0, at: 150 },
        { vehicle: 'booster', stage: 'booster', ring: 1, n: 2, noRelightAfter: 300 },
      ],
    });
    sim.reset();
    sim.launch();
    while (missionTime(sim) < 60) sim.step();
    expect(sim.mission.phase).toBe('ascent');
    const ascent = reload(sim);
    expect(ascent.mission.missionTime).toBe(sim.mission.missionTime);
    // (The log so far comes with it.)
    expect(ascent.events).toEqual(sim.events);
    flyBoth(sim, ascent, () => missionTime(sim) >= 200);
    for (const re of [/^Max-Q/, /^Booster MECO/, /^Stage separation/, /^RVac ignition/, /^Boostback burn startup/, /^Engine out: Ship RVac 1 shut down/]) expect(logged(ascent, re)).toBe(true);
    expect(ascent.vehicles.map((v) => `${v.id}:${v.status}`)).toEqual(['booster:flight', 'ship:flight']);

    // Both stages flying: the booster coasting back, the ship on its burn (an engine short).
    expect(sim.mission.phase).toBe('shipburn');
    expect(sim.mission.boosterReturn!.phase).toBe('coast');
    const copy = reload(sim);
    expect(copy.snapshot()).toEqual(ascent.snapshot());
    flyBoth(sim, copy, () => (sim.mission.phase === 'coast' && sim.find('booster')!.status !== 'flight') || missionTime(sim) > 600);
    // The copy's autopilots flew on: the engine that wouldn't relight didn't, the booster came
    // home to the arms regardless, and the ship reached its engine cutoff.
    expect(logged(copy, /^Engine out: Booster inner ring Raptor 3 failed to light/)).toBe(true);
    expect(logged(copy, /^Booster caught!/)).toBe(true);
    expect(copy.find('booster')!.status).toBe('caught');
    expect(logged(copy, /^SECO/)).toBe(true);
    expect(copy.mission.phase).toBe('coast');
    expect(copy.mission.missionTime).toBe(sim.mission.missionTime);
    expect(copy.bay!.aboard).toBe(26);
    // Every line of the flight's log, from before the saves and after, in both.
    expect(copy.events).toEqual(sim.events);
    // (Its log goes to its own simulation, not back to the one it was saved from.)
    const lines = sim.events.length;
    copy.log('only in the copy');
    expect(sim.events.length).toBe(lines);
  });

  it('in the coast with the player at the controls: a maneuver node, its burn, the tower arms moving, time warp on rails', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.scene('orbit');
    sim.pilot.set({ manual: true, target: 'ship', sas: 'prograde', throttle: 0, engines: 2 });
    sim.setNode({ vehicle: 'ship', t: sim.t + 200, dv: [40, 5, -3] });
    sim.commandArms(0, -1, 1, 1);
    sim.commandArms(1, 1, -1, -1);
    for (let i = 0; i < 2000; i++) sim.step();
    sim.pilot.set({ pitch: 0.4, roll: -0.2 });
    for (let i = 0; i < 300; i++) sim.step();
    sim.pilot.set({ pitch: 0, roll: 0, sas: 'stability' });
    for (let i = 0; i < 500; i++) sim.step();
    const copy = reload(sim);
    expectSame(sim, copy);
    expect(copy.snapshot().pilot).toMatchObject({ manual: true, target: 'ship', sas: 'stability' });
    expect(copy.snapshot().node).toMatchObject({ vehicle: 'ship', dv: [40, 5, -3] });
    // The same inputs to both from here: point at the node, burn it, shut down, warp.
    const both = (act: (s: Simulation) => void) => [sim, copy].forEach(act);
    both((s) => s.pilot.set({ sas: 'maneuver' }));
    flyBoth(sim, copy, () => sim.t >= sim.node!.node.t - 8);
    both((s) => s.pilot.set({ throttle: 1 }));
    flyBoth(sim, copy, () => sim.node === null, step, 20_000);
    expect(logged(copy, /^Maneuver complete/)).toBe(true);
    both((s) => s.pilot.set({ throttle: 0, sas: 'off' }));
    flyBoth(sim, copy, () => sim.railsAllowed(), step, 2000);
    expect(copy.railsAllowed()).toBe(true);
    const t0 = sim.t;
    flyBoth(sim, copy, () => sim.t - t0 >= 3000, (s) => s.railsStep(250), 100);
    expect(copy.t - t0).toBeGreaterThanOrEqual(3000);
    expect(copy.towers.map((a) => a.moving)).toEqual([false, false]);
  });

  it('a ship in its entry with tiles missing: the heat shield chars and burns through the same', { timeout: 240_000 }, () => {
    const sim = new Simulation();
    sim.configure({ tiles: { lost: [{ row: 10, col: 6, n: 28 }, { row: 3, col: 0, n: 20 }, { row: 14, col: 5, n: 2 }] } });
    sim.reset();
    sim.startAt('entry');
    // Into the heat: 250 s on, ~70 km up, the gaps charring.
    for (let i = 0; i < 25_000; i++) sim.step();
    expect(sim.mission.shipReturn!.phase).toBe('entry');
    expect(Math.max(...sim.shield.char)).toBeGreaterThan(0.1);
    expect(Math.max(...sim.shield.char)).toBeLessThan(1);
    const copy = reload(sim);
    const t0 = sim.t;
    flyBoth(sim, copy, () => sim.t - t0 >= 250 || sim.find('ship')!.status !== 'flight');
    expect(logged(copy, /^Burn-through low on the belly/)).toBe(true);
    expect(copy.find('ship')!.status).toBe('flight');
    expect(copy.snapshot().shield.char).toEqual(sim.snapshot().shield.char);
    expect(Math.max(...copy.shield.char)).toBeGreaterThan(1);
  });

  it('a ship on its way down to the tower: the flip, the landing burn, the hover and the catch', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    sim.scene('shipCatch');
    for (let i = 0; i < 500; i++) sim.step();
    expect(sim.mission.shipReturn!.phase).toBe('bellyflop');
    const copy = reload(sim);
    flyBoth(sim, copy, () => sim.find('ship')!.status !== 'flight', step, 20_000);
    expect(logged(copy, /^Return: flip and landing burn/)).toBe(true);
    expect(logged(copy, /^Ship caught by the Pad 1 tower!/)).toBe(true);
    expect(copy.find('ship')!.status).toBe('caught');
    // And on from there: hanging on the arms, lowered by them.
    [sim, copy].forEach((s) => s.commandArms(0, -1, null));
    flyBoth(sim, copy, () => false, step, 1500);
    expect(copy.find('ship')!.status).toBe('caught');
  });
});

describe('saved and loaded the way the worker does it, in the weather', () => {
  const land = new Land(new Uint8Array(readFileSync(resolve(import.meta.dirname, '../public/data/landmask.bin'))));
  const weather: WeatherConfig = { seed: 4, season: -1.7, site: 'clear', siteLat: 25.99613, siteLon: -97.15442, t0: 0 };

  /** A simulation flying in the weather, as the worker sets one up. */
  const inWeather = () => {
    const live = flightWeather(weather, land)!;
    return { sim: new Simulation({ ...DEFAULT_ENV, wind: live.wind }), live };
  };

  /** Through JSON text into a new simulation with no wind of its own: the wind is built again from the saved weather. */
  const reloadInWeather = (sim: Simulation, live: ReturnType<typeof flightWeather>): Simulation => {
    const text = JSON.stringify(saveFlight(sim, live));
    const copy = new Simulation({ ...DEFAULT_ENV });
    expect(loadFlight(copy, JSON.parse(text), land)!.cfg).toEqual(weather);
    expect(copy.env.wind).toBeDefined();
    return copy;
  };

  it('a Starlink flight from Pad 2 in the wind, with random engine failures and tile loss: the same failures, the same tiles, the same satellites', { timeout: 300_000 }, () => {
    const { sim, live } = inWeather();
    sim.launchPad = 1;
    sim.configure({ payload: 'starlink', parkingAlt: 275e3, faults: 'random', faultSeed: 41, tiles: 'random' });
    sim.reset();
    sim.launch();
    while (missionTime(sim) < 30) sim.step();
    // Saved before any of it happens: what the dice do next is in the save.
    expect(sim.events.filter((e) => /^Engine out|^Heat shield/.test(e.text)).map((e) => e.text)).toEqual(['Heat shield: 7 tiles shaken loose (liftoff)']);
    const saved = saveFlight(sim, live);
    expectPlainJson(saved);
    expect(saved.weather).toEqual(weather);
    expect(saved.env.wind).toBe(true);
    const ascent = reloadInWeather(sim, live);
    flyBoth(sim, ascent, () => missionTime(sim) >= 150);
    expect(ascent.events.filter((e) => /^Engine out|^Heat shield/.test(e.text)).map((e) => e.text)).toEqual([
      'Heat shield: 7 tiles shaken loose (liftoff)',
      'Heat shield: 4 tiles shaken loose (max-Q)',
      'Engine out: Booster outer ring Raptor 12 shut down (32 of 33 left)',
      'Heat shield: 8 tiles shaken loose (hot staging)',
    ]);
    expect(ascent.shield.lost).toBe(19);

    // On to orbit and into the deployment (the ship sent home to the Pad 2 tower, as the mission
    // does at SECO; warping on rails where it may): saved again with satellites out, the door
    // open, the dispenser part-way through its cycle, a deorbit burn planned.
    while (sim.mission.phase !== 'coast') sim.step();
    sim.commandReturn({ kind: 'tower', pad: 1, slew: -70 });
    for (let n = 0; n < 3e6 && sim.bay!.sats.length < 2; n++) warp(sim);
    for (let i = 0; i < 2500; i++) sim.step();
    expect(sim.bay!.state).toBe('deploying');
    expect(sim.mission.shipReturn!.phase).toBe('burn');
    const copy = reloadInWeather(sim, live);
    expectSame(sim, copy);
    flyBoth(sim, copy, () => sim.bay!.sats.length >= 5, warp);
    expect(logged(copy, /^Starlink 5 of 26 deployed/)).toBe(true);
    expect(copy.bay!.aboard).toBe(21);
    expect(copy.snapshot().payload!.sats.map((s) => s.n)).toEqual([1, 2, 3, 4, 5]);
    expect(copy.snapshot().shipReturn!.burns.map((b) => b.label)).toEqual(sim.snapshot().shipReturn!.burns.map((b) => b.label));
  });

  it('a save that can\'t be loaded leaves the wind as it was', () => {
    const { sim, live } = inWeather();
    const saved = saveFlight(sim, live);
    const other = new Simulation({ ...DEFAULT_ENV });
    expect(other.env.wind).toBeUndefined();
    expect(() => loadFlight(other, { ...saved, version: 99 }, land)).toThrow(/format version/);
    expect(other.env.wind).toBeUndefined();
    // Still air comes back as still air.
    const windy = inWeather().sim;
    expect(loadFlight(windy, JSON.parse(JSON.stringify(saveFlight(new Simulation(), null))), land)).toBeNull();
    expect(windy.env.wind).toBeUndefined();
  });
});

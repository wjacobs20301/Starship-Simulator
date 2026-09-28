import { describe, expect, it } from 'vitest';
import { BOOSTER_OCEAN_ENU, MissionTracker, missionById } from '../src/game/missions';
import { throttleForThrust } from '../src/sim/engine';
import { Simulation } from '../src/sim/simulation';

describe('missions and scoring', () => {
  it('the autopilot flies the Flight Test mission to a top grade', { timeout: 180_000 }, () => {
    const sim = new Simulation();
    const tracker = new MissionTracker(missionById('ift'));
    sim.launch();
    let result = null;
    for (let i = 0; i < 5000 * 100 && !result; i++) {
      sim.step();
      if (i % 100 === 0) result = tracker.update(sim.snapshot());
    }
    expect(result).not.toBeNull();
    expect(result!.states.every((s) => s === 'done')).toBe(true);
    expect(tracker.record.caught!.off).toBeLessThan(2.5);
    expect(tracker.record.splash!.km).toBeLessThan(50);
    expect(result!.total).toBeGreaterThan(850);
  });

  it('a breakup fails the hand-flown ascent', () => {
    const sim = new Simulation();
    const tracker = new MissionTracker(missionById('ascent'));
    sim.pilot.set({ manual: true, target: 'stack', sas: 'stability', throttle: 1 });
    sim.launch();
    let result = null;
    for (let i = 0; i < 200 * 100 && !result; i++) {
      if (sim.mission.missionTime !== null && sim.mission.missionTime > 50) sim.pilot.set({ pitch: 1 });
      sim.step();
      if (i % 50 === 0) result = tracker.update(sim.snapshot());
    }
    expect(result).not.toBeNull();
    expect(result!.states).toContain('failed');
    expect(result!.total).toBeLessThan(100);
  });

  it('Catch the Booster: the hand-over is flyable with TGT SAS and the throttle', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    const def = missionById('catch');
    const tracker = new MissionTracker(def);
    // (From the mission's start the autopilot flies the landing burn here; the player's part
    // tested is the final approach and catch.)
    sim.startAt(def.setup.start!);
    while (!sim.events.some((e) => /^Final approach/.test(e.text))) sim.step();
    const b = sim.find('booster')!;
    const br = sim.mission.boosterReturn!;
    // A steady player: TGT holds the lean, the throttle holds a gentle sink (pausing if off-line).
    sim.pilot.set({ manual: true, target: 'booster', sas: 'target', engines: 2, throttle: 0.6 });
    let result = null;
    for (let i = 0; i < 20000 && !result; i++) {
      if (i % 10 === 0 && b.status === 'flight') {
        const aux = sim.aux.get('booster')!;
        const g = br.guide(b, aux);
        const off = Math.hypot(g.east, g.north);
        const vzCmd = off > 3 && g.above < 25 ? 0 : -Math.min(4, Math.max(1.5, 0.12 * g.above + 1.5));
        const force = aux.mp.mass * (9.8 + (vzCmd - g.vel[2]));
        sim.pilot.set({ throttle: throttleForThrust(b.engines[0].place.type, force / 3, aux.pAmb) });
      }
      sim.step();
      if (i % 50 === 0) result = tracker.update(sim.snapshot());
    }
    expect(b.status).toBe('caught');
    expect(result).not.toBeNull();
    expect(result!.total).toBeGreaterThan(700);
  });

  it('Ship Landing: hold ENT through entry, flip and burn to a soft splashdown', { timeout: 180_000 }, () => {
    const sim = new Simulation();
    const tracker = new MissionTracker(missionById('landing'));
    // The mission starts at the edge of the atmosphere (the flight run ahead to there).
    sim.startAt(missionById('landing').setup.start!);
    let result = tracker.update(sim.snapshot());
    sim.pilot.set({ manual: true, target: 'ship', sas: 'entry', throttle: 0, engines: 1 });
    const ship = sim.find('ship')!;
    let burning = false;
    for (let i = 0; i < 400000 && !result; i++) {
      if (i % 10 === 0 && ship.status === 'flight') {
        const snap = sim.snapshot();
        const t = snap.vehicles.find((v) => v.id === 'ship')!.telemetry;
        const aux = sim.aux.get('ship')!;
        const h = t.altitude;
        const vz = -t.verticalSpeed;
        // Flip and light up when a constant-deceleration stop needs about half the 3 engines' push.
        const aMax = (3 * 2.6e6) / aux.mp.mass - 9.8;
        if (!burning && h < 3000 && vz * vz / (2 * Math.max(1, h)) > 0.35 * aMax) burning = true;
        if (burning) {
          const aNeed = Math.max(0, vz * vz - 1) / (2 * Math.max(0.5, h - 2)) + 9.8;
          sim.pilot.set({ sas: 'retrograde', throttle: throttleForThrust(ship.engines[0].place.type, (aux.mp.mass * aNeed) / 3, aux.pAmb) });
        }
      }
      sim.step();
      if (i % 50 === 0) result = tracker.update(sim.snapshot());
    }
    expect(result).not.toBeNull();
    expect(tracker.record.entrySurvived).toBe(true);
    expect(ship.status).toBe('landed');
    expect(result!.total).toBeGreaterThan(500);
  });

  it('Booster Splashdown: the autopilot puts Super Heavy on the Gulf marker', { timeout: 120_000 }, () => {
    const sim = new Simulation();
    const def = missionById('boostersplash');
    sim.boosterOcean = BOOSTER_OCEAN_ENU;
    const tracker = new MissionTracker(def);
    sim.launch();
    let result = null;
    for (let i = 0; i < 600 * 100 && !result; i++) {
      sim.step();
      if (i % 100 === 0) result = tracker.update(sim.snapshot());
    }
    expect(result).not.toBeNull();
    expect(result!.states.every((s) => s === 'done')).toBe(true);
    expect(tracker.record.boosterSplash!.km).toBeLessThan(1);
  });

  it('Ship Catch: booster and ship both caught, the ship sent home at SECO', { timeout: 240_000 }, () => {
    const sim = new Simulation();
    const def = missionById('shipcatch');
    const tracker = new MissionTracker(def);
    sim.launch();
    let result = null;
    let sent = false;
    let seen = 0;
    for (let i = 0; i < 4e6 && !result; i++) {
      // What the game does at SECO for this mission.
      for (; seen < sim.events.length; seen++) {
        if (!sent && def.setup.shipReturn && /^SECO/.test(sim.events[seen].text)) {
          sent = true;
          sim.commandReturn({ kind: 'tower', pad: -1 });
        }
      }
      const a = sim.waitUntil;
      if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(60, a - sim.t));
      else sim.step();
      if (i % 100 === 0) result = tracker.update(sim.snapshot());
    }
    expect(result).not.toBeNull();
    expect(result!.states.every((s) => s === 'done')).toBe(true);
    expect(tracker.record.shipCaught!.pad).toBe(2);
    expect(result!.total).toBeGreaterThan(850);
  });
});

import { describe, expect, it } from 'vitest';
import { type ReturnTarget, greatCircleKm } from '../src/sim/shipReturn';
import { Simulation } from '../src/sim/simulation';

/** Nominal flight to a minute after SECO, then the return command; runs (auto-warping) to the end. */
function fly(target: ReturnTarget, prep?: (sim: Simulation) => void) {
  const sim = new Simulation();
  sim.launch();
  while (sim.mission.phase !== 'coast') sim.step();
  for (let i = 0; i < 3000; i++) sim.step();
  prep?.(sim);
  sim.commandReturn(target);
  const ship = sim.find('ship')!;
  for (let guard = 0; ship.status === 'flight' && sim.mission.shipReturn && guard < 3e6; guard++) {
    const a = sim.waitUntil;
    if (a !== null && a > sim.t + 1 && sim.railsAllowed()) sim.railsStep(Math.min(60, a - sim.t));
    else sim.step();
  }
  const s = sim.snapshot().vehicles.find((v) => v.id === 'ship')!;
  return { sim, ship, at: { lat: s.telemetry.lat, lon: s.telemetry.lon } };
}

describe('ship return (autopilot home)', () => {
  it('ocean target near its natural impact: entry guidance and a splashdown on it', { timeout: 120_000 }, () => {
    const target = { kind: 'ocean', lat: -15.2, lon: 111.9 } as const;
    const { sim, ship, at } = fly(target);
    // (Its orbit after SECO falls near the target; a small deorbit trim, if any, is fine.)
    expect(sim.events.some((e) => /Return to the ocean target planned/.test(e.text))).toBe(true);
    expect(ship.status).toBe('landed');
    expect(greatCircleKm(at, target)).toBeLessThan(2);
  });

  it('ocean target off its path: circularises, waits for a pass, deorbits, steers in', { timeout: 180_000 }, () => {
    const target = { kind: 'ocean', lat: -13.5, lon: 110.0 } as const;
    const { sim, ship, at } = fly(target);
    expect(sim.events.some((e) => /planned: circularize/.test(e.text))).toBe(true);
    expect(sim.events.some((e) => /bank reversal/.test(e.text))).toBe(true);
    expect(ship.status).toBe('landed');
    expect(greatCircleKm(at, target)).toBeLessThan(2);
  });

  it('back to Starbase: caught by the free tower (Pad 1 holds the booster)', { timeout: 240_000 }, () => {
    const { sim, ship } = fly({ kind: 'tower', pad: -1 });
    expect(sim.events.some((e) => /Return to Pad 2 tower planned/.test(e.text))).toBe(true);
    expect(ship.status).toBe('caught');
    expect(ship.caughtPad).toBe(1);
    expect(sim.events.some((e) => /Ship caught by the Pad 2 tower/.test(e.text))).toBe(true);
    // It hangs there while the arms stay closed.
    for (let i = 0; i < 500; i++) sim.step();
    expect(ship.status).toBe('caught');
  });

  it('refuses when the propellant cannot cover it', { timeout: 30_000 }, () => {
    const sim = new Simulation();
    sim.launch();
    while (sim.mission.phase !== 'coast') sim.step();
    // Leave only the landing reserve in the tanks.
    sim.find('ship')!.stages[0].prop = 40e3;
    sim.commandReturn({ kind: 'tower', pad: -1 });
    expect(sim.mission.shipReturn).toBeNull();
    expect(sim.events.some((e) => /Can't return: needs \d+ m\/s but only \d+ m\/s/.test(e.text))).toBe(true);
  });
});

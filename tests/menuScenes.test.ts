import { describe, expect, it } from 'vitest';
import { type MenuScene, Simulation } from '../src/sim/simulation';

// The main menu's backdrops have to hold still (or fly properly) while the menu is up.
describe('menu scenes', () => {
  const run = (kind: MenuScene, seconds: number) => {
    const sim = new Simulation();
    sim.scene(kind);
    for (let i = 0; i < seconds * 100; i++) sim.step();
    return sim;
  };

  it('ship in orbit stays in orbit', () => {
    const sim = run('orbit', 30);
    const ship = sim.snapshot().vehicles.find((v) => v.id === 'ship')!;
    expect(ship.status).toBe('flight');
    expect(ship.telemetry.altitude).toBeGreaterThan(240e3);
    expect(ship.telemetry.altitude).toBeLessThan(260e3);
  });

  it.each(['shipCaught'] as MenuScene[])('%s stays on the arms', (kind) => {
    const sim = run(kind, 20);
    const caught = sim.vehicles.filter((v) => v.status === 'caught');
    expect(caught.length).toBe(1);
    expect(sim.vehicles.every((v) => v.status !== 'destroyed' && v.status !== 'flight')).toBe(true);
  });

  it('the reentry backdrop flies belly-first through the heating, shielded', () => {
    const sim = run('reentry', 25);
    const ship = sim.snapshot().vehicles.find((v) => v.id === 'ship')!;
    expect(ship.status).toBe('flight');
    expect(ship.health.flux).toBeGreaterThan(1e5);
    expect(ship.health.shielded).toBeGreaterThan(0.9);
    expect(ship.health.heat).toBeLessThan(0.05);
  });

  it('the ship-catch backdrop flips, burns and ends with the ship on Pad 1\'s arms', { timeout: 60_000 }, () => {
    const sim = run('shipCatch', 75);
    const ship = sim.find('ship')!;
    expect(ship.status).toBe('caught');
    expect(ship.caughtPad).toBe(0);
    expect(sim.events.some((e) => /Landing flip/.test(e.text))).toBe(true);
  });

  it('the booster-catch backdrop ends with the booster on the arms', () => {
    const sim = run('boosterCatch', 40);
    expect(sim.find('booster')!.status).toBe('caught');
    expect(sim.find('ship')).toBeUndefined();
  }, 30_000);

  it('stack on the pad and the liftoff', () => {
    expect(run('pad', 5).find('stack')!.status).toBe('held');
    const lift = run('liftoff', 25).find('stack')!;
    expect(lift.status).toBe('flight');
  });
});

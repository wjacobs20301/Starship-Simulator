import { beforeAll, describe, expect, it } from 'vitest';
import { MISSION } from '../src/sim/config/starshipV3';
import { Simulation } from '../src/sim/simulation';

// Full nominal flight. Bands are deliberately loose: the vehicle numbers are public
// approximations, and this test guards the shape of the flight, not exact values.
describe('nominal ascent', () => {
  const sim = new Simulation();
  const at = (re: RegExp) => sim.events.find((e) => re.test(e.text));

  beforeAll(() => {
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 560) sim.step();
  }, 60_000);

  it('lifts off at T-0 with a realistic thrust-to-weight', () => {
    const e = at(/^Liftoff/)!;
    expect(e.missionTime!).toBeGreaterThanOrEqual(0);
    expect(e.missionTime!).toBeLessThan(1);
    const twr = Number(/T\/W ([\d.]+)/.exec(e.text)![1]);
    expect(twr).toBeGreaterThan(1.3);
    expect(twr).toBeLessThan(1.6);
  });

  it('passes max-Q around one minute in', () => {
    const e = at(/^Max-Q/)!;
    const t = Number(/at T\+(\d+)/.exec(e.text)![1]);
    const kPa = Number(/Max-Q ([\d.]+)/.exec(e.text)![1]);
    expect(t).toBeGreaterThan(45);
    expect(t).toBeLessThan(80);
    expect(kPa).toBeGreaterThan(20);
    expect(kPa).toBeLessThan(45);
  });

  it('stages in the right window', () => {
    const e = at(/^Booster MECO/)!;
    const [, km, kmh] = /([\d.]+) km, (\d+) km\/h/.exec(e.text)!.map(Number);
    expect(e.missionTime!).toBeGreaterThan(130);
    expect(e.missionTime!).toBeLessThan(175);
    expect(km).toBeGreaterThan(55);
    expect(km).toBeLessThan(80);
    expect(kmh).toBeGreaterThan(5000);
    expect(kmh).toBeLessThan(7500);
    const events = sim.events.map((x) => x.text);
    const order = ['Liftoff', 'Max-Q', 'Booster MECO', 'Ship engine ignition', 'Stage separation', 'RVac ignition', 'SECO'];
    const idx = order.map((o) => events.findIndex((x) => x.startsWith(o)));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it('ship reaches the test-flight trajectory at SECO', () => {
    const e = at(/^SECO/)!;
    const [kmh] = [Number(/: (\d+) km\/h/.exec(e.text)![1])];
    const alt = Number(/alt (\d+) km/.exec(e.text)![1]);
    const perigee = Number(/orbit (-?\d+) x/.exec(e.text)![1]);
    expect(e.missionTime!).toBeGreaterThan(420);
    expect(e.missionTime!).toBeLessThan(560);
    expect(kmh).toBeGreaterThan(25000);
    expect(kmh).toBeLessThan(28000);
    expect(alt).toBeGreaterThan(140);
    expect(alt).toBeLessThan(220);
    // Transatmospheric: SECO comes when the predicted splashdown reaches the target, before the
    // perigee backstop.
    expect(perigee).toBeGreaterThan(-100);
    expect(perigee).toBeLessThanOrEqual(MISSION.targetPerigeeAlt / 1000 + 1);
    expect(e.text).not.toMatch(/reserve/);
  });
});

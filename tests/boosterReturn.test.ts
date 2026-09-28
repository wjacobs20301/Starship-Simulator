import { beforeAll, describe, expect, it } from 'vitest';
import { currentAux } from '../src/sim/dynamics';
import { add, qrot } from '../src/sim/math';
import { catchPoint } from '../src/sim/padCollision';
import { eciToPad } from '../src/sim/padFrame';
import { Simulation } from '../src/sim/simulation';
import { ARMS } from '../src/sim/tower';

// Full flight through the booster's return. Like the ascent test, the bands guard the shape of
// the return (it happens, in order, around the real timeline), not exact numbers.
describe('booster return and catch', () => {
  const sim = new Simulation();
  const at = (re: RegExp) => sim.events.find((e) => re.test(e.text));

  beforeAll(() => {
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 480 && sim.find('booster')?.status !== 'caught') sim.step();
  }, 60_000);

  it('flies the return sequence in order', () => {
    const order = [/^Boostback burn startup/, /^Boostback burn shutdown/, /^Grid fins/, /^Landing burn startup/, /^Inner ring shutdown/, /^Chopsticks closing/, /^Booster caught/];
    const times = order.map((re) => at(re)?.missionTime ?? NaN);
    for (const t of times) expect(t).not.toBeNaN();
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
  });

  it('is caught on the chopsticks around T+6 to T+7.5 min', () => {
    const e = at(/^Booster caught/)!;
    expect(e.missionTime!).toBeGreaterThan(330);
    expect(e.missionTime!).toBeLessThan(450);
    expect(sim.find('booster')!.status).toBe('caught');
    expect(Number(/([\d.]+) m off center/.exec(e.text)![1])).toBeLessThan(1.5);
  });

  it('keeps some propellant margin at the catch', () => {
    const b = sim.find('booster')!;
    expect(b.stages[0].prop).toBeGreaterThan(3e3);
  });

  it('the arms can swing the caught booster round the tower and set it down beside it', () => {
    const b = sim.find('booster')!;
    expect(b.status).toBe('caught');
    const arms = sim.towers[0];
    arms.command({ slew: 90 });
    for (let i = 0; i < 6000 && Math.abs(arms.slew - 90) > 0.01; i++) sim.step();
    // All the way down: the carriage stops with the booster standing on the ground.
    arms.command({ offset: ARMS.minOffset });
    for (let i = 0; i < 6000 && arms.moving; i++) sim.step();
    const xcg = currentAux(b, sim.t, sim.env).mp.xcg;
    const base = eciToPad(add(b.r, qrot(b.q, [-(xcg - b.extent[0]), 0, 0])), sim.t);
    const [se, sn] = catchPoint(0, 90);
    expect(Math.hypot(base[0] - se, base[1] - sn)).toBeLessThan(0.5);
    expect(base[2]).toBeCloseTo(0, 1);
    // Open the arms: it stays standing there.
    arms.command({ angle: ARMS.maxOpenDeg });
    for (let i = 0; i < 1000; i++) sim.step();
    expect(b.status).toBe('landed');
    expect(sim.events.some((e) => /touchdown/.test(e.text))).toBe(true);
  });
});

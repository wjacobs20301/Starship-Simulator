import { beforeAll, describe, expect, it } from 'vitest';
import { add, qrot } from '../src/sim/math';
import { eciToPad } from '../src/sim/padFrame';
import { Simulation } from '../src/sim/simulation';

// Super Heavy on autopilot to a point in the Gulf instead of the tower: boostback short of the
// coast, a landing burn and a soft touchdown on the water, on the target.
describe('booster ocean splashdown', () => {
  const sim = new Simulation();
  const target: [number, number] = [32000, -4000];
  sim.boosterOcean = target;
  beforeAll(() => {
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 520 && !['landed', 'destroyed'].includes(sim.find('booster')?.status ?? '')) sim.step();
  }, 60_000);

  it('lands softly on the water at the target', () => {
    const b = sim.find('booster')!;
    const log = sim.events.map((e) => `${e.missionTime?.toFixed(0)} ${e.text}`).join('\n');
    expect(b.status, log).toBe('landed');
    const e = sim.events.find((x) => /splashdown/.test(x.text))!;
    expect(Number(/at ([\d.]+) m\/s/.exec(e.text)![1])).toBeLessThan(6);
    const base = eciToPad(add(b.r, qrot(b.q, [-10, 0, 0])), sim.t);
    expect(Math.hypot(base[0] - target[0], base[1] - target[1])).toBeLessThan(500);
  });
});

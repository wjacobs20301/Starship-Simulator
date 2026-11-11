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

  it('then tips over in the waves and breaks apart, as the real ones do', () => {
    const b = sim.find('booster')!;
    const landedAt = sim.t;
    let tilt = 0;
    while (sim.t < landedAt + 40 && b.status === 'landed') {
      sim.step();
      const up = qrot(b.q, [1, 0, 0]);
      const r = Math.hypot(...b.r);
      tilt = Math.max(tilt, Math.acos((up[0] * b.r[0] + up[1] * b.r[1] + up[2] * b.r[2]) / r));
    }
    const has = (re: RegExp) => sim.events.some((e) => re.test(e.text));
    expect(has(/^Super Heavy is tipping over in the waves/)).toBe(true);
    expect(has(/^Super Heavy tipped over after its splashdown and broke apart/)).toBe(true);
    expect(b.status).toBe('destroyed');
    expect(tilt).toBeGreaterThan(1.2);
    // (It stood a few seconds first, and took several more to go over.)
    const tipT = sim.events.find((e) => /tipping over/.test(e.text))!.t;
    const brokeT = sim.events.find((e) => /broke apart/.test(e.text))!.t;
    expect(tipT - landedAt).toBeGreaterThan(5);
    expect(brokeT - tipT).toBeGreaterThan(5);
  });
});

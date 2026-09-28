import { beforeAll, describe, expect, it } from 'vitest';
import { add, qrot } from '../src/sim/math';
import { MOUNTS } from '../src/sim/padCollision';
import { eciToPad } from '../src/sim/padFrame';
import { Simulation } from '../src/sim/simulation';

// Launching from Pad 2: the stack stands on Pad 2's mount, and the booster comes home to Pad 2's
// tower.
describe('launch from Pad 2', () => {
  const sim = new Simulation();
  sim.launchPad = 1;
  sim.reset();

  it('stands on Pad 2 before launch', () => {
    const before = new Simulation();
    before.launchPad = 1;
    before.reset();
    const stack = before.find('stack')!;
    const base = eciToPad(add(stack.r, qrot(stack.q, [-(before.aux.get('stack')!.mp.xcg - stack.extent[0]), 0, 0])), before.t);
    expect(Math.hypot(base[0] - MOUNTS[1][0], base[1] - MOUNTS[1][1])).toBeLessThan(0.5);
  });

  beforeAll(() => {
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 480 && sim.find('booster')?.status !== 'caught') sim.step();
  }, 60_000);

  it("is caught on Pad 2's chopsticks", () => {
    const b = sim.find('booster')!;
    expect(b.status).toBe('caught');
    expect(b.caughtPad).toBe(1);
    const e = sim.events.find((x) => /^Booster caught/.test(x.text))!;
    expect(Number(/([\d.]+) m off center/.exec(e.text)![1])).toBeLessThan(1.5);
  });
});

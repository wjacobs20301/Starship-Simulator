import { describe, expect, it } from 'vitest';
import { DEG } from '../src/sim/constants';
import { type V3, dot, qrot } from '../src/sim/math';
import { sasDirection } from '../src/sim/pilot';
import { Simulation } from '../src/sim/simulation';

const nose = (sim: Simulation, id: string): V3 => qrot(sim.find(id)!.q, [1, 0, 0]);
const angle = (a: V3, b: V3) => Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) / DEG;
const run = (sim: Simulation, seconds: number) => {
  for (let i = 0; i < seconds / 0.01; i++) sim.step();
};

describe('manual flight (fly-by-wire + SAS)', () => {
  it('pitches on command, holds attitude, tracks prograde, throttles and stages', () => {
    const sim = new Simulation();
    sim.pilot.set({ manual: true, target: 'stack', sas: 'stability', throttle: 1 });
    sim.launch();
    while ((sim.mission.missionTime ?? -99) < 15) sim.step();
    expect(sim.find('stack')!.status).toBe('flight');

    // W for 3 s at 5 deg/s: the nose tips over ~15 deg.
    const before = nose(sim, 'stack');
    sim.pilot.set({ pitch: 1 });
    run(sim, 3);
    sim.pilot.set({ pitch: 0 });
    const tipped = angle(before, nose(sim, 'stack'));
    expect(tipped).toBeGreaterThan(9);
    expect(tipped).toBeLessThan(20);

    // Hands off: SAS holds the new attitude.
    run(sim, 1.5);
    const held = nose(sim, 'stack');
    run(sim, 5);
    expect(angle(held, nose(sim, 'stack'))).toBeLessThan(1.5);

    // Prograde hold.
    sim.pilot.set({ sas: 'prograde' });
    run(sim, 12);
    const stack = sim.find('stack')!;
    const aux = sim.aux.get('stack')!;
    expect(angle(nose(sim, 'stack'), sasDirection('prograde', stack, aux))).toBeLessThan(2);

    // Throttle down to 60%.
    sim.pilot.set({ throttle: 0.6 });
    run(sim, 2);
    const lit = stack.engines.filter((e) => e.throttle > 0.02);
    expect(lit.length).toBe(33);
    for (const e of lit) expect(e.throttle).toBeCloseTo(0.6, 2);

    // Stage: the player now flies the ship; the booster goes home on autopilot.
    sim.stage();
    run(sim, 3);
    expect(sim.find('stack')).toBeUndefined();
    expect(sim.pilot.cmd.target).toBe('ship');
    expect(sim.mission.boosterReturn).not.toBeNull();
    expect(sim.events.some((e) => /^Staging: booster MECO/.test(e.text))).toBe(true);
  });
});

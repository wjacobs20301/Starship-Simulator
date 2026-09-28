// Headless booster return: prints the booster's state through boostback, entry, landing and catch.
// Usage: npx tsx scripts/booster-return.ts [--every=5]
import { DT, Simulation } from '../src/sim/simulation';
import { eciToPad, eciVelToPad } from '../src/sim/padFrame';

const every = Number(process.argv.find((a) => a.startsWith('--every='))?.split('=')[1] ?? 5);
const sim = new Simulation();
sim.launch();
let next = 130;
while ((sim.mission.missionTime ?? -99) < 700) {
  sim.step(DT);
  const tm = sim.mission.missionTime!;
  for (const e of sim.drainEvents()) console.log(`  >> T+${e.missionTime!.toFixed(1)}  ${e.text}`);
  const b = sim.find('booster');
  if (!b || b.status === 'destroyed') {
    if (tm > 200) break;
    continue;
  }
  if (b.status === 'caught') break;
  const low = sim.mission.boosterReturn && ['landing', 'terminal'].includes(sim.mission.boosterReturn.phase);
  if (tm >= next) {
    next += low ? 0.25 : every;
    const p = eciToPad(b.r, sim.t);
    const v = eciVelToPad(b.r, b.v, sim.t);
    const aux = sim.aux.get('booster')!;
    const thr = b.engines.filter((e) => e.throttle > 0.02);
    console.log(
      `T+${tm.toFixed(0).padStart(4)} ${sim.mission.boosterReturn?.phase.padEnd(9)} E ${(p[0] / 1000).toFixed(2).padStart(7)} N ${(p[1] / 1000).toFixed(2).padStart(6)} U ${(p[2] / 1000).toFixed(2).padStart(7)} km  ` +
        `v ${v.map((x) => x.toFixed(0).padStart(6)).join('')}  q ${(aux.q / 1000).toFixed(1).padStart(6)} kPa  ` +
        `eng ${String(thr.length).padStart(2)} @${(thr[0]?.throttle ?? 0).toFixed(2)}  prop ${(b.stages[0].prop / 1000).toFixed(0)} t  aoa ${(aux.alpha * 57.3).toFixed(0)}  ` +
        `miss ${((sim.mission.boosterReturn as unknown as { impact: { pos: number[] } | null })?.impact?.pos.slice(0, 2).map((x) => x.toFixed(0)).join(",") ?? "-")}`,
    );
  }
}

// Headless nominal flight: prints a telemetry table and the event log.
// Usage: npm run fly [-- --until=600]
import { DT, Simulation } from '../src/sim/simulation';

const until = Number(process.argv.find((a) => a.startsWith('--until='))?.split('=')[1] ?? 560);
const sim = new Simulation();
sim.launch();
const rows: string[] = [];
let nextPrint = -10;
while ((sim.mission.missionTime ?? -99) < until) {
  sim.step(DT);
  const tm = sim.mission.missionTime!;
  if (tm >= nextPrint) {
    nextPrint += 10;
    const s = sim.snapshot();
    for (const e of s.events) rows.push(`  >> T${e.missionTime! >= 0 ? '+' : ''}${e.missionTime!.toFixed(1)}  ${e.text}`);
    for (const v of s.vehicles) {
      if (v.status === 'destroyed') continue;
      const m = v.telemetry;
      rows.push(
        `T+${tm.toFixed(0).padStart(4)} ${v.id.padEnd(8)} alt ${(m.altitude / 1000).toFixed(1).padStart(6)} km  ` +
          `v ${(m.speed * 3.6).toFixed(0).padStart(6)} km/h  vz ${m.verticalSpeed.toFixed(0).padStart(5)}  ` +
          `M ${m.mach.toFixed(2).padStart(5)}  q ${(m.q / 1000).toFixed(1).padStart(5)} kPa  ` +
          `a ${m.accelG.toFixed(2)} g  dr ${(m.downrange / 1000).toFixed(0).padStart(5)} km  ` +
          `aoa ${m.alphaDeg.toFixed(1).padStart(5)}  m ${(m.mass / 1000).toFixed(0).padStart(5)} t`,
      );
    }
  }
}
for (const e of sim.drainEvents()) rows.push(`  >> T+${e.missionTime!.toFixed(1)}  ${e.text}`);
console.log(rows.join('\n'));

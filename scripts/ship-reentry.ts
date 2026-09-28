// Headless ship flight past SECO: coast, entry, belly-flop, flip and landing burn.
// Usage: npx tsx scripts/ship-reentry.ts
import { DT, Simulation } from '../src/sim/simulation';
import { heatFlux } from '../src/sim/shipReentry';

const sim = new Simulation();
sim.launch();
let next = 0;
while ((sim.mission.missionTime ?? -99) < 6000) {
  sim.step(DT);
  const tm = sim.mission.missionTime!;
  for (const e of sim.drainEvents()) if (tm > 400) console.log(`  >> T+${(e.missionTime! / 60).toFixed(2)} min  ${e.text}`);
  const s = sim.find('ship');
  if (!s || s.status === 'destroyed' || s.status === 'landed') {
    if (tm > 480) break;
    continue;
  }
  const aux = sim.aux.get('ship')!;
  const phase = sim.mission.shipReentry?.phase ?? '-';
  const fine = ['bellyflop', 'flip', 'landing'].includes(phase);
  const every = fine ? 2 : phase === 'entry' ? 20 : 300;
  if (tm >= next && tm > 470) {
    next = tm + every;
    const speed = aux.mach * aux.soundSpeed;
    console.log(
      `T+${(tm / 60).toFixed(2).padStart(6)} min ${phase.padEnd(9)} lat ${(aux.geo.lat * 57.3).toFixed(2).padStart(7)} lon ${(aux.geo.lon * 57.3).toFixed(2).padStart(8)} ` +
        `h ${(aux.geo.h / 1000).toFixed(2).padStart(7)} km  v ${(speed * 3.6).toFixed(0).padStart(6)} km/h  M ${aux.mach.toFixed(2).padStart(5)} ` +
        `q ${(aux.q / 1000).toFixed(1).padStart(5)} kPa  aoa ${(aux.alpha * 57.3).toFixed(0).padStart(3)}  heat ${(heatFlux(aux.rho, speed) / 1e4).toFixed(0).padStart(4)} W/cm2  ` +
        `a ${(aux.properAccel / 9.81).toFixed(2)} g  prop ${(s.stages[0].prop / 1000).toFixed(1)} t`,
    );
  }
}

// The flight's own lines in the HUD's status corner.

import { overflight } from '../game/places';
import { kbd } from './keyLabels';
import type { Snapshot } from '../sim/simulation';

/**
 * The flight's own lines in the status corner: how many Starlinks are out (and the door), the
 * heat shield's state, engines out, and where a ship coming home is.
 */
export function flightLines(s: Snapshot, freeRoam: boolean): string {
  const lines: string[] = [];
  const p = s.payload;
  if (p) {
    const out = p.total - p.aboard;
    const door =
      p.state === 'orienting' ? ', ship turning to deploy'
      : p.state === 'opening' ? ', door opening'
      : p.state === 'closing' ? ', door closing'
      : p.door > 0.5 ? ', door open'
      : p.state === 'stowed' && freeRoam ? ` · ${kbd('deploy')} to deploy`
      : '';
    lines.push(`Starlink V3: ${out} of ${p.total} deployed${door}`);
  }
  const ship = s.vehicles.find((v) => v.stages.length === 1 && v.stages[0] === 'ship' && v.status === 'flight');
  const sh = s.shield;
  if (sh.lost > 0 || sh.verdict) {
    const burned = sh.char.filter((c) => c >= 1).length;
    lines.push(
      `Heat shield: ${sh.lost ? `${sh.lost} tile${sh.lost > 1 ? 's' : ''} missing` : 'intact'}` +
        (burned ? ` · <span class="bad">${burned} burn-through${burned > 1 ? 's' : ''}</span>` : '') +
        (sh.verdict ? ` · ${sh.verdict === 'go' ? 'inspection GO' : '<span class="bad">inspection NO-GO</span>'}` : ''),
    );
  }
  const outs = s.vehicles
    .filter((v) => v.status !== 'destroyed')
    .flatMap((v) => Object.entries(v.stageState).map(([id, st]) => [id, st?.failed.filter(Boolean).length ?? 0] as const))
    .filter(([, n]) => n > 0);
  if (outs.length) lines.push(`Engines out: ${outs.map(([id, n]) => `${id === 'ship' ? 'ship' : 'booster'} ${n}`).join(', ')}`);
  // Coming home: what it's over (the corridor in from the Pacific, across Mexico).
  if (ship && ship.telemetry.altitude < 140e3 && ship.telemetry.verticalSpeed < 0) {
    const over = overflight(ship.telemetry.lat, ship.telemetry.lon);
    if (over) lines.push(`Ship ${over}`);
  }
  return lines.join('<br>');
}

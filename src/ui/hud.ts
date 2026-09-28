// The flight display: the webcast-style overlay along the bottom (webcast.ts), a quiet phase /
// orbit line up top, the status corner, and the full event log (hidden unless asked for).

import type { Snapshot } from '../sim/simulation';
import { onSettingsChange } from '../settings';
import { Webcast, formatClock } from './webcast';

export { formatClock };

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

export class Hud {
  readonly webcast = new Webcast(document.body);
  private phase = $('#phase');
  private log = $('#log');
  private status = $('#status');
  private orbit = $('#orbit');
  private lastStatus = '';

  constructor() {
    onSettingsChange((s) => this.webcast.setShipName(`STARSHIP · ${s.shipSerial.toUpperCase()}`));
  }

  setMission(title: string): void {
    this.webcast.setMission(title);
  }

  toggleLog(): void {
    this.log.classList.toggle('hidden');
  }

  update(
    s: Snapshot,
    info: { camera: string; tracked: string; warp: string; paused: boolean; armsPad: number; orbit?: { inclination: number; period: number } | null },
  ): void {
    this.webcast.update(s);
    const label = (s.shipPhase && SHIP_PHASE_LABEL[s.shipPhase]) || PHASE_LABEL[s.phase];
    if (this.phase.textContent !== label) this.phase.textContent = label;
    const ship = s.vehicles.find((v) => v.id === 'ship');
    const orbit =
      ship && ship.telemetry.altitude > 80e3
        ? `Orbit ${Math.round(ship.telemetry.perigee / 1000)} × ${Math.round(ship.telemetry.apogee / 1000)} km` +
          (info.orbit ? ` · i ${info.orbit.inclination.toFixed(1)}°` + (info.orbit.period > 0 ? ` · ${(info.orbit.period / 60).toFixed(0)} min` : '') : '') +
          ` · downrange ${Math.round(ship.telemetry.downrange / 1000)} km`
        : '';
    if (this.orbit.textContent !== orbit) this.orbit.textContent = orbit;
    const arms = s.towers[info.armsPad];
    const status =
      `${info.camera} · ${info.tracked} · ${info.paused ? 'PAUSED' : info.warp}` +
      (arms
        ? `<br>Pad ${info.armsPad + 1} ` +
          (arms.down
            ? '<span class="bad">tower destroyed</span>'
            : arms.broken.L || arms.broken.R
              ? '<span class="bad">chopsticks wrecked</span>'
              : `arms: rails ${arms.top.toFixed(0)} m, open ${arms.angle.toFixed(0)}°${Math.abs(arms.slew) > 0.5 ? `, swung ${arms.slew.toFixed(0)}°` : ''}`)
        : '');
    // (Only touch the DOM when the text changes: every write costs a style / layout pass.)
    if (status !== this.lastStatus) {
      this.status.innerHTML = status;
      this.lastStatus = status;
    }
    for (const e of s.events) {
      const row = document.createElement('div');
      row.innerHTML = `<b>${formatClock(e.missionTime)}</b> ${e.text}`;
      this.log.prepend(row);
    }
  }

  clearLog(): void {
    this.log.innerHTML = '';
    this.webcast.reset();
  }
}

const PHASE_LABEL: Record<Snapshot['phase'], string> = {
  prelaunch: 'Press SPACE to start the countdown',
  countdown: 'Terminal count',
  ascent: 'Ascent',
  hotstaging: 'Hot staging',
  shipburn: 'Ship insertion burn',
  coast: 'Coast',
  aborted: 'Aborted',
};

const SHIP_PHASE_LABEL: Record<string, string> = {
  coast: 'Coast',
  entry: 'Reentry',
  bellyflop: 'Belly-flop',
  flip: 'Landing flip',
  landing: 'Landing burn',
  landed: 'Splashdown',
  lost: 'Vehicle lost',
};

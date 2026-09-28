// Flight controls, built into the webcast overlay: while the player flies, the middle of it turns
// into a cockpit (throttle ring, navball, SAS mode buttons) in place of the timeline arc, with the
// mission clock small under the navball, and the numbers a pilot needs (heading, pitch, T/W,
// delta-v, engine set) go under the flown vehicle's block. Above the overlay, load / heating /
// catch warnings.

import { ENGINE_SETS, type SasMode, activeStageId } from '../sim/pilot';
import type { Snapshot, VehicleSnapshot } from '../sim/simulation';
import { type MissionTarget, distanceKm } from '../game/missions';
import type { StageId } from '../sim/vehicle';
import { Navball } from './navball';
import { Gauge, type Webcast } from './webcast';

const SAS_BUTTONS: { mode: SasMode; label: string; title: string }[] = [
  { mode: 'stability', label: '⊙', title: 'Hold attitude' },
  { mode: 'prograde', label: 'PRO', title: 'Prograde' },
  { mode: 'retrograde', label: 'RET', title: 'Retrograde' },
  { mode: 'radialOut', label: 'R+', title: 'Radial out' },
  { mode: 'radialIn', label: 'R−', title: 'Radial in' },
  { mode: 'normal', label: 'N+', title: 'Normal' },
  { mode: 'antiNormal', label: 'N−', title: 'Anti-normal' },
  { mode: 'entry', label: 'ENT', title: 'Entry: belly-first, heat shield into the flow' },
  { mode: 'maneuver', label: 'MNV', title: 'Maneuver: point at the planned burn' },
  { mode: 'target', label: 'TGT', title: 'Target: lean the booster toward the chopsticks (catch)' },
];

export class FlightPanel {
  private navball: Navball;
  private throttle = new Gauge('THROTTLE', '%', 1);
  private readout: HTMLElement;
  /** Warnings and catch guidance, a line above the webcast. */
  private alerts: HTMLElement;
  private buttons = new Map<SasMode, HTMLButtonElement>();
  private flownStage: StageId | null = null;

  constructor(
    private webcast: Webcast,
    alertsParent: HTMLElement,
    onSas: (mode: SasMode) => void,
  ) {
    // Throttle ring | navball | SAS modes, in the webcast's centre; the numbers under the flown
    // vehicle's block.
    const cockpit = webcast.cockpit;
    cockpit.appendChild(this.throttle.el);
    this.navball = new Navball(cockpit, 124);
    const sas = document.createElement('div');
    sas.className = 'wc-sas';
    for (const b of SAS_BUTTONS) {
      const el = document.createElement('button');
      el.textContent = b.label;
      el.title = `SAS: ${b.title}`;
      el.addEventListener('click', () => onSas(b.mode));
      sas.appendChild(el);
      this.buttons.set(b.mode, el);
    }
    cockpit.appendChild(sas);
    this.readout = document.createElement('div');
    this.readout.className = 'wc-readout';
    this.alerts = document.createElement('div');
    this.alerts.id = 'wc-alerts';
    alertsParent.appendChild(this.alerts);
  }

  /** target: the mission's landing target, if it has one (range and bearing shown for its vehicle). */
  update(s: Snapshot, v: VehicleSnapshot | undefined, target: MissionTarget | null = null): void {
    const p = s.pilot;
    const flying = !!p.manual && !!v && v.id === p.target && v.status === 'flight';
    // The cockpit opens once the vehicle is actually flying (at liftoff when taken on the pad);
    // before that the countdown keeps the middle.
    const airborne = s.phase !== 'prelaunch' && s.phase !== 'countdown' && (s.missionTime ?? 0) >= 0;
    const piloting = flying && airborne;
    this.webcast.setPiloting(piloting);
    this.webcast.setMode(
      p.manual
        ? `<b>MANUAL</b> · ${flying ? '' : `${(p.target === 'stack' ? 'STARSHIP' : p.target).toUpperCase()} · `}<kbd>L</kbd> AUTOPILOT`
        : `AUTOPILOT · <kbd>L</kbd> TAKE CONTROL`,
    );
    // Tag the flown vehicle's block (the stack flies on the booster).
    const stage = piloting && v ? activeStageId(v.stages) : null;
    if (stage !== this.flownStage) {
      if (this.flownStage) this.webcast.block(this.flownStage).setFlying(false);
      if (stage) this.webcast.block(stage).setFlying(true, this.readout);
      else this.readout.remove();
      this.flownStage = stage;
    }
    for (const [mode, el] of this.buttons) el.classList.toggle('on', piloting && p.sas === mode);
    this.webcast.cockpit.classList.toggle('sas-off', piloting && p.sas === 'off');
    this.setAlerts(v ? { health: healthLine(v), catch: flying ? catchLine(s) : '', target: targetLine(s, v, target, flying) } : {});
    if (!v || !stage) return;

    const t = v.telemetry;
    this.navball.draw({
      rotLocal: t.rotLocal,
      vSurfLocal: t.vSurfLocal,
      vOrbLocal: t.vOrbLocal,
      altitude: t.altitude,
      sasDirLocal: p.sasDirLocal,
      maneuverLocal: s.node && s.node.vehicle === v.id ? s.node.remainingLocal : null,
    });
    this.throttle.set(p.throttle, String(Math.round(p.throttle * 100)));

    const lit = (v.stageState[stage]?.throttles ?? []).filter((x) => x > 0.02);
    const set = ENGINE_SETS[stage][p.engines];
    const dv = Object.entries(t.deltaV)
      .map(([id, x]) => `${id === 'booster' ? 'B' : 'S'} ${Math.round(x ?? 0).toLocaleString('en-US')}`)
      .join(' / ');
    this.readout.innerHTML =
      `HDG <b>${this.navball.heading.toFixed(0).padStart(3, '0')}°</b> PITCH <b>${this.navball.pitch.toFixed(0)}°</b> ` +
      `T/W <b>${t.twr.toFixed(2)}</b> ΔV <b>${dv}</b> <b>${lit.length}</b> LIT${set ? ` · ${set.label.toUpperCase()}` : ''}` +
      (p.sas === 'off' ? ' <b class="warn">SAS OFF</b>' : '');
  }

  /**
   * Show the alert lines (html per line, '' for none). A line that's already up is updated in
   * place: only a line that appears fades in (rebuilding them all would restart the fade on
   * every change of a number, and they'd flash).
   */
  private setAlerts(lines: Partial<Record<(typeof ALERT_LINES)[number], string>>): void {
    let prev: Element | null = null;
    for (const k of ALERT_LINES) {
      const html = lines[k] ?? '';
      let el = this.alerts.querySelector<HTMLElement>(`:scope > [data-k="${k}"]`);
      if (!html) {
        el?.remove();
        continue;
      }
      if (!el) {
        el = document.createElement('div');
        el.dataset.k = k;
        if (prev) prev.after(el);
        else this.alerts.prepend(el);
      }
      if (el.innerHTML !== html) el.innerHTML = html;
      prev = el;
    }
  }
}

/** The alert lines' order under the countdown. */
const ALERT_LINES = ['health', 'catch', 'target'] as const;

/** Structural load and heating warnings, once they matter. */
function healthLine(v: VehicleSnapshot): string {
  const h = v.health;
  const parts: string[] = [];
  if (h.load > 0.5) parts.push(`<b class="${h.load > 0.8 ? 'bad' : 'warn'}">LOAD ${Math.round(h.load * 100)}%</b>`);
  if (h.flux > 3e4 && h.shielded < 0.99) parts.push(`<b class="${h.shielded < 0.5 ? 'bad' : 'warn'}">HEAT ON BARE STEEL</b>`);
  if (h.damage > 0.01) parts.push(`<b class="${h.damage > 0.5 ? 'bad' : 'warn'}">HULL DAMAGE ${Math.round(h.damage * 100)}%</b>`);
  if (h.heat > 0.01) parts.push(`<b class="${h.heat > 0.6 ? 'bad' : 'warn'}">HEAT DAMAGE ${Math.round(h.heat * 100)}%</b>`);
  else if (h.flux > 1e5) parts.push(`<span>heating ${(h.flux / 1e4).toFixed(0)} W/cm²</span>`);
  return parts.join(' · ');
}

/** Catch guidance for a player flying the booster home: where the fins are vs the arms. */
function catchLine(s: Snapshot): string {
  const g = s.catchGuide;
  if (!g || g.above > 3000) return '';
  const off = Math.hypot(g.east, g.north);
  const dir = off > 0.3 ? compass(Math.atan2(-g.east, -g.north)) : '';
  const cls = off < g.captureRadius ? 'ok' : off < 15 ? 'warn' : 'bad';
  const vz = -g.vel[2];
  if (g.ocean) {
    // Over the water: how far off the marker, and the height above the sea.
    return (
      `<span>TARGET</span> <b class="${off < 150 ? 'ok' : off < 1000 ? 'warn' : 'bad'}">${off < 1000 ? `${off.toFixed(0)} m` : `${(off / 1000).toFixed(2)} km`} off${dir ? ` · steer ${dir}` : ''}</b>` +
      ` · ${g.above.toFixed(0)} m above the water · ↓${vz.toFixed(1)} m/s · drift ${Math.hypot(g.vel[0], g.vel[1]).toFixed(1)} m/s`
    );
  }
  return (
    `<span>CATCH</span> <b class="${cls}">${off.toFixed(1)} m off${dir ? ` · steer ${dir}` : ''}</b>` +
    ` · ${g.above.toFixed(0)} m above arms · ↓${vz.toFixed(1)} m/s` +
    ` · drift ${Math.hypot(g.vel[0], g.vel[1]).toFixed(1)} m/s · tilt ${g.tilt.toFixed(1)}°` +
    (g.armsAngle < 1.5 ? ' · <b class="ok">ARMS CLOSED</b>' : '')
  );
}

/** Range and bearing to the mission's target, for the vehicle it's for (until the close-in guide takes over). */
function targetLine(s: Snapshot, v: VehicleSnapshot, target: MissionTarget | null, flying: boolean): string {
  if (!target || v.id !== target.vehicle || v.status !== 'flight') return '';
  if (flying && s.catchGuide?.ocean && s.catchGuide.above < 3000) return '';
  const t = v.telemetry;
  const r = Math.PI / 180;
  const dLon = (target.lon - t.lon) * r;
  const y = Math.sin(dLon) * Math.cos(target.lat * r);
  const x = Math.cos(t.lat * r) * Math.sin(target.lat * r) - Math.sin(t.lat * r) * Math.cos(target.lat * r) * Math.cos(dLon);
  const bearing = Math.atan2(y, x);
  const km = distanceKm(t, target);
  return (
    `<span>TARGET</span> <b>${km < 10 ? km.toFixed(2) : km.toFixed(0)} km</b> · bearing ` +
    `<b>${String(Math.round(((bearing / r) + 360) % 360)).padStart(3, '0')}° ${compass(bearing)}</b>`
  );
}

/** Compass point for a direction (radians clockwise from north). */
function compass(a: number): string {
  const names = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return names[((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8];
}

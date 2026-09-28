// The player at the controls of one vehicle (KSP-style fly-by-wire).
//
//   Attitude  pitch / yaw / roll inputs (-1..1) command body rotation rates; the control system
//             turns them into gimbal, RCS, grid-fin and flap commands.
//   SAS       with no input: hold the current attitude (stability), or point at prograde,
//             retrograde, radial in/out or normal/anti-normal; or (ship) hold the belly-first
//             entry attitude the autopilot flies. Off: the vehicle drifts.
//   Throttle  0..1 on the active stage's selected engines (Raptors run no lower than their
//             minimum throttle; 0 shuts them down).
//
// Body axes: +x nose. Pitch rotates the nose toward +y ("down" on the navball), about +z; yaw
// toward +z ("right"), about -y; roll about +x.

import { DEG } from './constants';
import { applyControl, applyRateControl, releaseControl } from './control';
import type { Aux } from './dynamics';
import { airRelativeVelocity } from './frames';
import { type V3, add, clamp, cross, dot, norm, normalize, qrot, scale, sub } from './math';
import { type StageId, type Vehicle, setThrottle } from './vehicle';
import { entryAlpha, entryAttitude } from './shipReentry';

export type SasMode = 'off' | 'stability' | 'prograde' | 'retrograde' | 'radialOut' | 'radialIn' | 'normal' | 'antiNormal' | 'entry' | 'maneuver' | 'target';

export interface PilotCommand {
  /** Player in control (false: the autopilot flies everything). */
  manual: boolean;
  /** Id of the vehicle the player flies. */
  target: string;
  pitch: number;
  yaw: number;
  roll: number;
  throttle: number;
  sas: SasMode;
  /** Engine set index for the active stage (see ENGINE_SETS). */
  engines: number;
}

/** Selectable engine sets per stage: [label, ring filter]. */
export const ENGINE_SETS: Record<StageId, { label: string; rings: (ring: number) => boolean }[]> = {
  booster: [
    { label: 'All 33', rings: () => true },
    { label: 'Inner 13', rings: (r) => r <= 1 },
    { label: 'Center 3', rings: (r) => r === 0 },
  ],
  ship: [
    { label: 'All 6', rings: () => true },
    { label: 'Sea-level 3', rings: (r) => r === 0 },
    { label: 'Vacuum 3', rings: (r) => r === 1 },
  ],
};

/** Commanded rates at full input, rad/s. */
const PITCH_YAW_RATE = 5 * DEG;
const ROLL_RATE = 10 * DEG;
/** Pitch/yaw rate below which SAS stability locks the attitude, rad/s. */
const SETTLED_RATE = 0.15 * DEG;
/** Below this altitude, prograde/retrograde follow the air-relative velocity (like KSP's surface mode). */
const SURFACE_MODE_ALT = 36e3;
/** Stiff attitude loop for the target hold (the booster's catch approach). */
const TARGET_GAINS = { wn: 1.6, zeta: 1.0, rollDamp: 0.5 };
/** Below this descent speed (m/s, near the ground) retrograde becomes a landing helper. */
const LANDING_ASSIST_SPEED = 60;

export function activeStage(v: Vehicle): StageId {
  return v.stageIndex('booster') >= 0 ? 'booster' : 'ship';
}

/** The stage whose engines fly a vehicle made of these stages (the lowest one). */
export function activeStageId(stages: StageId[]): StageId {
  return stages.includes('booster') ? 'booster' : 'ship';
}

export class Pilot {
  cmd: PilotCommand = { manual: false, target: 'stack', pitch: 0, yaw: 0, roll: 0, throttle: 1, sas: 'stability', engines: 0 };
  /** Attitude being held by SAS stability (ECI nose and body +z). */
  private hold: { nose: V3; z: V3 } | null = null;
  /** Direction SAS is pointing at this cycle (ECI), for the navball. */
  sasDir: V3 | null = null;
  /** The maneuver node's remaining burn direction (ECI), set by the sim each step. */
  maneuverDir: V3 | null = null;
  /** Target hold (booster catch): thrust direction leaning toward the catch point, and the roll reference (ECI), set by the sim. */
  targetDir: { dir: V3; rollRef: V3 } | null = null;

  set(patch: Partial<PilotCommand>): void {
    const prev = this.cmd;
    this.cmd = { ...prev, ...patch };
    if (patch.target !== undefined && patch.target !== prev.target) this.hold = null;
    if (patch.sas !== undefined && patch.sas !== prev.sas) this.hold = null;
    if (patch.manual && !prev.manual) this.hold = null;
  }

  /** Whether the player is flying this vehicle right now. */
  flies(v: Vehicle): boolean {
    return this.cmd.manual && this.cmd.target === v.id && v.status === 'flight';
  }

  /**
   * Fly the vehicle for one control cycle. throttle: false while an automatic sequence (hot
   * staging) owns the engines.
   */
  apply(v: Vehicle, aux: Aux, dt: number, throttle = true): void {
    const c = this.cmd;
    if (throttle) {
      const stage = activeStage(v);
      const set = ENGINE_SETS[stage][c.engines] ?? ENGINE_SETS[stage][0];
      setThrottle(v, stage, 0, (r) => !set.rings(r));
      setThrottle(v, stage, c.throttle > 0.001 ? c.throttle : 0, set.rings);
    }

    this.sasDir = null;
    const input = Math.abs(c.pitch) + Math.abs(c.yaw) + Math.abs(c.roll) > 0.05;
    if (input) {
      this.hold = null;
      applyRateControl(v, aux, [c.roll * ROLL_RATE, -c.yaw * PITCH_YAW_RATE, c.pitch * PITCH_YAW_RATE], dt);
      return;
    }
    if (c.sas === 'off') {
      releaseControl(v, dt);
      return;
    }
    if (c.sas === 'stability') {
      if (!this.hold) {
        // Stop the rotation first, then lock whatever attitude that leaves (no swing back).
        if (Math.hypot(v.w[1], v.w[2]) > SETTLED_RATE) {
          applyRateControl(v, aux, [0, 0, 0], dt, 2.0);
          return;
        }
        this.hold = { nose: qrot(v.q, [1, 0, 0]), z: qrot(v.q, [0, 0, 1]) };
      }
      this.sasDir = this.hold.nose;
      applyControl(v, aux, this.hold.nose, dt, undefined, this.hold.z);
      return;
    }
    if (c.sas === 'target') {
      if (this.targetDir) {
        this.sasDir = this.targetDir.dir;
        applyControl(v, aux, this.targetDir.dir, dt, TARGET_GAINS, this.targetDir.rollRef);
      } else {
        applyRateControl(v, aux, [0, 0, 0], dt, 2.0);
      }
      return;
    }
    if (c.sas === 'maneuver') {
      const dir = this.maneuverDir ?? qrot(v.q, [1, 0, 0]);
      this.sasDir = dir;
      applyControl(v, aux, dir, dt);
      return;
    }
    if (c.sas === 'entry') {
      const att = entryHold(v, aux);
      this.sasDir = att.nose;
      applyControl(v, aux, att.nose, dt, undefined, att.bodyZ);
      return;
    }
    const dir = sasDirection(c.sas, v, aux);
    this.sasDir = dir;
    applyControl(v, aux, dir, dt);
  }
}

/** Belly-first entry attitude: heat shield into the flow at the entry angle of attack for this Mach. */
export function entryHold(v: Vehicle, aux: Aux): { nose: V3; bodyZ: V3 } {
  const vAir = airRelativeVelocity(v.r, v.v);
  const up = normalize(v.r);
  const speed = norm(vAir);
  const vHat = speed > 1 ? scale(vAir, 1 / speed) : scale(up, -1);
  const vh = sub(vAir, scale(up, dot(vAir, up)));
  const heading = norm(vh) > 1 ? normalize(vh) : normalize(cross(up, [0, 0, 1]));
  return entryAttitude(vHat, up, heading, entryAlpha(aux.mach));
}

/** The direction (ECI) an SAS pointing mode aims at. */
export function sasDirection(mode: SasMode, v: Vehicle, aux: Aux): V3 {
  const vel = aux.geo.h < SURFACE_MODE_ALT ? airRelativeVelocity(v.r, v.v) : v.v;
  const pro = norm(vel) > 1 ? normalize(vel) : normalize(v.r);
  const up = normalize(v.r);
  const radial = sub(up, scale(pro, dot(up, pro)));
  const radialOut = norm(radial) > 1e-6 ? normalize(radial) : up;
  const normal = normalize(cross(v.r, v.v));
  switch (mode) {
    case 'prograde':
      return pro;
    case 'retrograde': {
      // Landing helper: slow and low, "retrograde" stays near upright and only leans against the
      // sideways drift (true retrograde swings wildly as the speed goes to zero).
      const surface = aux.geo.h < SURFACE_MODE_ALT;
      const speed = norm(vel);
      if (surface && speed < LANDING_ASSIST_SPEED && (dot(vel, up) < 0 || speed < 15)) {
        const vh = sub(vel, scale(up, dot(vel, up)));
        let lean = scale(vh, -0.03);
        const l = norm(lean);
        if (l > Math.tan(12 * DEG)) lean = scale(lean, Math.tan(12 * DEG) / l);
        const upright = normalize(add(up, lean));
        // Blend into true retrograde as the speed builds.
        const f = dot(vel, up) < 0 ? clamp((speed - 0.6 * LANDING_ASSIST_SPEED) / (0.4 * LANDING_ASSIST_SPEED), 0, 1) : 0;
        return normalize(add(scale(upright, 1 - f), scale(pro, -f)));
      }
      return scale(pro, -1);
    }
    case 'radialOut':
      return radialOut;
    case 'radialIn':
      return scale(radialOut, -1);
    case 'normal':
      return normal;
    case 'antiNormal':
      return scale(normal, -1);
    default:
      return qrot(v.q, [1, 0, 0]);
  }
}

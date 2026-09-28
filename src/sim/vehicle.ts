// Vehicle definitions, runtime vehicle state and mass properties.
// Body frame: +x along the stack axis toward the nose, origin at the booster base
// (the stack's frame is kept by both stages after separation). +y and +z lateral.

import type { EngineType } from './engine';
import type { Q, V3 } from './math';
import type { SurfaceDef, SurfaceInstance } from './surfaces';

export type StageId = 'booster' | 'ship';

export interface EnginePlacement {
  type: EngineType;
  /** Gimbal point in the body frame, m. */
  pos: V3;
  /** Ring index for display/sequencing (0 = center). */
  ring: number;
}

export interface StageDef {
  id: StageId;
  name: string;
  /** Body-frame x of the stage's base, m. */
  xBase: number;
  length: number;
  radius: number;
  /** Dry mass including any payload or ballast, kg. */
  dryMass: number;
  /** Dry center of mass as a fraction of stage length from the base. */
  dryCgFrac: number;
  /** Full propellant load, kg. */
  propMass: number;
  /** Oxidizer-to-fuel mass ratio. */
  mixtureRatio: number;
  loxDensity: number;
  ch4Density: number;
  /** Height of the LOX tank bottom above the stage base, m (CH4 tank sits above LOX). */
  tankStart: number;
  /** Propellant kept in reserve at engine cutoff (boostback / landing), kg. */
  reserve: number;
  /**
   * Header tanks: landing propellant kept apart from the main tanks (kg), and their mass
   * centre's height above the stage base (m). Filled first, drawn last.
   */
  header?: { mass: number; x: number };
  /** Maximum control torque from RCS / cold-gas thrusters, N m (per axis). */
  rcsTorque: number;
  /** Grid fins: body-frame x of their center of pressure (m) and total planform area (m^2). */
  gridFins?: { x: number; area: number };
  /** Movable aerodynamic surfaces (flaps, grid fins): see surfaces.ts. */
  surfaces?: SurfaceDef[];
  engines: EnginePlacement[];
}

export interface EngineState {
  place: EnginePlacement;
  /** Index into Vehicle.stages of the stage that feeds this engine. */
  stage: number;
  throttleCmd: number;
  throttle: number;
  /** Gimbal angles (rad) producing lateral thrust along body y / z. */
  gy: number;
  gz: number;
  gyCmd: number;
  gzCmd: number;
  failed: boolean;
}

export interface StageState {
  def: StageDef;
  prop: number;
}

export type VehicleStatus = 'held' | 'flight' | 'caught' | 'landed' | 'destroyed';

export class Vehicle {
  stages: StageState[];
  engines: EngineState[];
  /** Center-of-mass position and velocity in ECI, m and m/s. */
  r: V3 = [0, 0, 0];
  v: V3 = [0, 0, 0];
  /** Body -> ECI attitude. */
  q: Q = [1, 0, 0, 0];
  /** Body angular rate, rad/s. */
  w: V3 = [0, 0, 0];
  status: VehicleStatus = 'held';
  /** Control torque from RCS / fins held over the step (body frame, N m). */
  rcsTorque: V3 = [0, 0, 0];
  /** Extra external force over the step (ECI, N), e.g. plume impingement during hot staging. */
  extForce: V3 = [0, 0, 0];
  /** Resting place (Earth-fixed position and attitude) once landed. */
  rest: { rEcef: V3; qEcef: Q } | null = null;
  /** Hanging on a tower's arms: which pad, and the catch point's height above the vehicle's base, m. */
  caughtPad = 0;
  catchPin = 65;
  /** Flaps / grid fins (hinges in the body frame) and their current angles, rad. */
  surfaces: SurfaceInstance[];
  surfaceAngles: number[];

  constructor(
    public id: string,
    public name: string,
    stages: StageState[],
    engines?: EngineState[],
  ) {
    this.stages = stages;
    this.engines = engines ?? stages.flatMap((s, i) => s.def.engines.map((place) => newEngine(place, i)));
    this.surfaces = stages.flatMap((s) =>
      (s.def.surfaces ?? []).map((def) => ({ def, hinge: [def.hinge[0] + s.def.xBase, def.hinge[1], def.hinge[2]] as V3 })),
    );
    // Stacked (more than one stage): surfaces start parked; a single stage starts at neutral.
    this.surfaceAngles = this.surfaces.map((s) => (stages.length > 1 ? (s.def.parked ?? s.def.neutral) : s.def.neutral));
  }

  /** Body-frame x range covered by the vehicle. */
  get extent(): [number, number] {
    const lo = Math.min(...this.stages.map((s) => s.def.xBase));
    const hi = Math.max(...this.stages.map((s) => s.def.xBase + s.def.length));
    return [lo, hi];
  }

  get maxRcsTorque(): number {
    return this.stages.reduce((a, s) => a + s.def.rcsTorque, 0);
  }

  stageIndex(id: StageId): number {
    return this.stages.findIndex((s) => s.def.id === id);
  }
}

export function newEngine(place: EnginePlacement, stage: number): EngineState {
  return { place, stage, throttleCmd: 0, throttle: 0, gy: 0, gz: 0, gyCmd: 0, gzCmd: 0, failed: false };
}

export interface MassProps {
  mass: number;
  /** Body-frame x of the center of mass, m. */
  xcg: number;
  /** Roll inertia about the x axis, kg m^2. */
  ix: number;
  /** Pitch/yaw inertia about the center of mass, kg m^2. */
  it: number;
}

/** Height of the full LOX column, used to fix where the CH4 tank sits. */
function fullLoxHeight(d: StageDef): number {
  const area = Math.PI * d.radius ** 2;
  return ((d.propMass * d.mixtureRatio) / (1 + d.mixtureRatio)) / (d.loxDensity * area);
}

/**
 * Mass, CG and inertia from dry structure (thin cylindrical shell) and two propellant
 * columns (solid cylinders) whose liquid level drops as propellant is consumed.
 */
export function massProps(stages: readonly StageState[], props: ArrayLike<number>): MassProps {
  const parts: { m: number; x: number; ix: number; it: number }[] = [];
  stages.forEach((s, i) => {
    const d = s.def;
    const r2 = d.radius ** 2;
    const area = Math.PI * r2;
    parts.push({
      m: d.dryMass,
      x: d.xBase + d.dryCgFrac * d.length,
      ix: d.dryMass * r2,
      it: d.dryMass * (r2 / 2 + d.length ** 2 / 12),
    });
    let prop = Math.max(0, props[i]);
    if (d.header) {
      const h = Math.min(prop, d.header.mass);
      prop -= h;
      parts.push({ m: h, x: d.xBase + d.header.x, ix: 0.25 * h * r2, it: 0.1 * h * r2 });
    }
    const lox = (prop * d.mixtureRatio) / (1 + d.mixtureRatio);
    const ch4 = prop - lox;
    const loxBottom = d.xBase + d.tankStart;
    const hLox = lox / (d.loxDensity * area);
    parts.push({ m: lox, x: loxBottom + hLox / 2, ix: 0.5 * lox * r2, it: lox * (r2 / 4 + hLox ** 2 / 12) });
    const ch4Bottom = loxBottom + fullLoxHeight(d) + 1.5; // common-dome gap
    const hCh4 = ch4 / (d.ch4Density * area);
    parts.push({ m: ch4, x: ch4Bottom + hCh4 / 2, ix: 0.5 * ch4 * r2, it: ch4 * (r2 / 4 + hCh4 ** 2 / 12) });
  });
  let mass = 0;
  let mx = 0;
  for (const p of parts) {
    mass += p.m;
    mx += p.m * p.x;
  }
  const xcg = mx / mass;
  let ix = 0;
  let it = 0;
  for (const p of parts) {
    ix += p.ix;
    it += p.it + p.m * (p.x - xcg) ** 2;
  }
  return { mass, xcg, ix, it };
}

/** Command a throttle on one stage's engines, optionally only some rings. */
export function setThrottle(v: Vehicle, stage: StageId, cmd: number, ringFilter?: (ring: number) => boolean): void {
  const idx = v.stageIndex(stage);
  for (const e of v.engines) {
    if (e.stage === idx && (!ringFilter || ringFilter(e.place.ring))) e.throttleCmd = cmd;
  }
}

// Attitude control: PD law on the pointing error -> desired torque, allocated first to
// thrust vector control (gimballing engines), then to the flaps / grid fins (by choosing their
// angles, moved at their actuators' rates), with RCS covering what's left.

import type { Aux } from './dynamics';
import { type V3, clamp, norm, qrotInv } from './math';
import { type Flow, surfaceLoad, surfaceLoads } from './surfaces';
import type { Vehicle } from './vehicle';

/**
 * The flight software plans surface angles for at least this much dynamic pressure (Pa): in thin
 * air (or none) the surfaces still answer the controls as they would low down, though they make
 * almost no force there (RCS does the work). Their real force always comes from the real air.
 */
const PLAN_Q_FLOOR = 500;

export interface ControlGains {
  /** Pitch/yaw natural frequency, rad/s. */
  wn: number;
  zeta: number;
  /** Roll rate damping, 1/s. */
  rollDamp: number;
}

export const DEFAULT_GAINS: ControlGains = { wn: 0.6, zeta: 0.9, rollDamp: 0.5 };

/** Pointing error rotation vector (body frame) that turns body +x onto the target direction. */
export function pointingError(veh: Vehicle, targetEci: V3): V3 {
  const tb = qrotInv(veh.q, targetEci);
  const c: V3 = [0, -tb[2], tb[1]]; // x_hat cross t
  const s = norm(c);
  const ang = Math.atan2(s, tb[0]);
  if (s < 1e-9) return tb[0] >= 0 ? [0, 0, 0] : [0, 0, Math.PI];
  return [0, (c[1] * ang) / s, (c[2] * ang) / s];
}

/**
 * Compute gimbal commands and RCS torque for this control cycle, then slew the gimbals.
 * targetEci = null means "hold still": damp body rates only. rollRef (ECI), if given, is the
 * direction the body +z axis should face (roll control); otherwise roll rate is only damped.
 */
export function applyControl(
  veh: Vehicle,
  aux: Aux,
  targetEci: V3 | null,
  dt: number,
  gains = DEFAULT_GAINS,
  rollRef: V3 | null = null,
): void {
  const w = veh.w;
  const err = targetEci ? pointingError(veh, targetEci) : ([0, 0, 0] as V3);
  const kp = gains.wn * gains.wn;
  const kd = 2 * gains.zeta * gains.wn;
  let rollAccel = -gains.rollDamp * w[0];
  if (rollRef) {
    // Rotation about body x that takes +z onto the reference's projection: z -> (0, -sin, cos).
    const rb = qrotInv(veh.q, rollRef);
    const phi = Math.atan2(-rb[1], rb[2]);
    rollAccel = 0.16 * phi - 0.8 * w[0];
  }
  const alpha: V3 = [rollAccel, kp * err[1] - kd * w[1], kp * err[2] - kd * w[2]];
  allocateControl(veh, aux, alpha, dt);
}

/**
 * Fly-by-wire rate control: track commanded body rates (rad/s; x roll, y yaw, z pitch).
 * gain: how quickly rate errors are removed, 1/s.
 */
export function applyRateControl(veh: Vehicle, aux: Aux, wCmd: V3, dt: number, gain = 1.2): void {
  const w = veh.w;
  allocateControl(veh, aux, [gain * (wCmd[0] - w[0]), gain * (wCmd[1] - w[1]), gain * (wCmd[2] - w[2])], dt);
}

/** No attitude control at all: gimbals centred, thrusters and fins idle (the vehicle drifts). */
export function releaseControl(veh: Vehicle, dt: number): void {
  for (const e of veh.engines) {
    const t = e.place.type;
    e.gyCmd = 0;
    e.gzCmd = 0;
    const step = t.gimbalRate * dt;
    e.gy += clamp(-e.gy, -step, step);
    e.gz += clamp(-e.gz, -step, step);
  }
  veh.rcsTorque = [0, 0, 0];
}

/**
 * Turn a desired angular acceleration (body frame) into gimbal commands and RCS / fin torque,
 * then slew the gimbals.
 */
function allocateControl(veh: Vehicle, aux: Aux, alpha: V3, dt: number): void {
  const { mp } = aux;
  // Torque still needed on top of the aerodynamic moment and what the flaps / fins already make
  // at their current angles (they only move at actuator speed, so they're counted as they are).
  const st = aux.surfaceTorque;
  const tau: V3 = [
    mp.ix * alpha[0] - st[0],
    mp.it * alpha[1] - aux.aeroTorque[1] - st[1],
    mp.it * alpha[2] - aux.aeroTorque[2] - st[2],
  ];

  // Thrust vector control authority: torque per radian of common gimbal deflection.
  let k = 0;
  let gMax = Infinity;
  veh.engines.forEach((e, i) => {
    if (e.place.type.gimbalMax > 0 && aux.engineThrust[i] > 0) {
      k += aux.engineThrust[i] * (mp.xcg - e.place.pos[0]);
      gMax = Math.min(gMax, e.place.type.gimbalMax);
    }
  });
  let gy = 0;
  let gz = 0;
  if (k > 0) {
    // Lateral thrust along +z at a point below the CG produces +y torque, along +y produces -z torque.
    gz = tau[1] / k;
    gy = -tau[2] / k;
    const mag = Math.hypot(gy, gz);
    if (mag > gMax) {
      gy *= gMax / mag;
      gz *= gMax / mag;
    }
  }
  for (const e of veh.engines) {
    const t = e.place.type;
    e.gyCmd = t.gimbalMax > 0 ? gy : 0;
    e.gzCmd = t.gimbalMax > 0 ? gz : 0;
    const step = t.gimbalRate * dt;
    e.gy += clamp(e.gyCmd - e.gy, -step, step);
    e.gz += clamp(e.gzCmd - e.gz, -step, step);
  }

  // Flaps / grid fins: what they make now plus whatever the gimbals don't (they can do all of
  // roll). Counted from where the gimbals actually are: while they slew or sit at their stops,
  // the surfaces help. RCS covers what the surfaces can't reach.
  const steer = veh.engines.find((e) => e.place.type.gimbalMax > 0);
  const gyNow = steer ? steer.gy : 0;
  const gzNow = steer ? steer.gz : 0;
  const rest: V3 = [st[0] + tau[0], st[1] + tau[1] - k * gzNow, st[2] + tau[2] + k * gyNow];
  const surf = allocateSurfaces(veh, aux, rest, dt);
  const lim = veh.maxRcsTorque;
  veh.rcsTorque = [
    clamp(rest[0] - surf[0], -lim, lim),
    clamp(rest[1] - surf[1], -lim, lim),
    clamp(rest[2] - surf[2], -lim, lim),
  ];
}

/**
 * Move the flaps / grid fins toward the angles that make torque `want` (body frame, N m), at
 * their actuators' rates. Linearised each control cycle (the torque's slope with each surface's
 * angle, by finite difference) and solved least-squares with a light pull toward each surface's
 * neutral angle (so the redundant flaps settle somewhere sensible). Returns the torque the
 * surfaces actually make at their new angles in the real air.
 */
export function allocateSurfaces(veh: Vehicle, aux: Aux, want: V3, dt: number): V3 {
  const list = veh.surfaces;
  const n = list.length;
  if (!n) return [0, 0, 0];
  const a = veh.surfaceAngles;
  const xcg = aux.mp.xcg;
  // Plan in the real flow direction if moving through the air, else a nominal one (belly-first
  // for the ship, engines-first for a booster, nose-first for the stack).
  const moving = norm(aux.vAir) > 1;
  const nominal: V3 = veh.stages.length > 1 ? [1, 0, 0] : list[0].def.kind === 'flap' ? [0, 1, 0] : [-1, 0, 0];
  const plan: Flow = { vHat: moving ? aux.flow.vHat : nominal, q: Math.max(aux.q, PLAN_Q_FLOOR), mach: aux.mach };
  // Torque now and its slope with each surface's angle.
  const eps = 0.01;
  const t0 = surfaceLoads(list, a, plan, xcg).t;
  const J: V3[] = list.map((s, i) => {
    const lo = surfaceLoad(s, a[i], plan, xcg).t;
    const hi = surfaceLoad(s, a[i] + eps, plan, xcg).t;
    return [(hi[0] - lo[0]) / eps, (hi[1] - lo[1]) / eps, (hi[2] - lo[2]) / eps];
  });
  // Normal equations (J^T J + lambda I) d = J^T (want - t0) + lambda (neutral - a).
  const err: V3 = [want[0] - t0[0], want[1] - t0[1], want[2] - t0[2]];
  const A: number[][] = [];
  const b: number[] = [];
  let diag = 0;
  for (let i = 0; i < n; i++) {
    A.push([]);
    for (let j = 0; j < n; j++) A[i].push(J[i][0] * J[j][0] + J[i][1] * J[j][1] + J[i][2] * J[j][2]);
    diag += A[i][i];
    b.push(J[i][0] * err[0] + J[i][1] * err[1] + J[i][2] * err[2]);
  }
  // Only a light pull to neutral (parked while stacked): it should settle the redundant
  // surfaces, not fight the torque.
  const lambda = 1e-4 * (diag / n) + 1;
  const stacked = veh.stages.length > 1;
  for (let i = 0; i < n; i++) {
    const def = list[i].def;
    A[i][i] += lambda;
    b[i] += lambda * ((stacked ? (def.parked ?? def.neutral) : def.neutral) - a[i]);
  }
  const d = solve(A, b);
  for (let i = 0; i < n; i++) {
    const def = list[i].def;
    const step = def.rate * dt;
    a[i] = clamp(a[i] + clamp(d[i], -step, step), def.min, def.max);
  }
  // What they really do: the real air, the real flow.
  if (!moving || aux.q <= 0) return [0, 0, 0];
  return surfaceLoads(list, a, aux.flow, xcg).t;
}

/** Solve a small dense linear system (Gaussian elimination with partial pivoting). */
function solve(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const piv = M[c][c];
    if (Math.abs(piv) < 1e-12) continue;
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / piv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let sum = M[r][n];
    for (let k = r + 1; k < n; k++) sum -= M[r][k] * x[k];
    x[r] = Math.abs(M[r][r]) > 1e-12 ? sum / M[r][r] : 0;
  }
  return x;
}

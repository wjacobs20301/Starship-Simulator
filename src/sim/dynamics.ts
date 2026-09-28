// 6DOF rigid-body equations of motion with variable mass, integrated with RK4.
// State: ECI position/velocity of the CG, body->ECI quaternion, body rates, and
// propellant mass per stage. Engine throttles/gimbals and RCS torques are held
// constant over a step (zero-order hold, like a flight computer's control cycle).

import { CMQ, REF_AREA, axialCoefficient, normalCoefficient } from './aero';
import { type Flow, surfaceLoads } from './surfaces';
import { atmosphere } from './atmosphere';
import { engineMassFlow, engineThrust } from './engine';
import { airRelativeVelocity, ecefToGeodetic, eciToEcef, type Geodetic } from './frames';
import { gravityJ2 } from './gravity';
import { type Q, type V3, cross, norm, qnormalize, qrot, qrotInv } from './math';
import { type MassProps, type Vehicle, massProps } from './vehicle';

export interface Env {
  gravity: boolean;
  aero: boolean;
}

export const DEFAULT_ENV: Env = { gravity: true, aero: true };

/** Derived quantities at the start of a step, used by guidance, control and telemetry. */
export interface Aux {
  mp: MassProps;
  geo: Geodetic;
  pAmb: number;
  rho: number;
  soundSpeed: number;
  vAir: V3;
  mach: number;
  q: number;
  alpha: number;
  /** Per-engine thrust, N. */
  engineThrust: number[];
  thrust: number;
  /** Aerodynamic torque about the CG from the body alone (not the flaps / fins), body frame. */
  aeroTorque: V3;
  /** Torque from the flaps / grid fins at their current angles, body frame. */
  surfaceTorque: V3;
  /** The airflow as the surfaces see it (body frame), for control allocation. */
  flow: Flow;
  /** Non-gravitational acceleration magnitude (what an accelerometer reads), m/s^2. */
  properAccel: number;
}

const N_BASE = 13;

export function packState(v: Vehicle): Float64Array {
  const y = new Float64Array(N_BASE + v.stages.length);
  y.set(v.r, 0);
  y.set(v.v, 3);
  y.set(v.q, 6);
  y.set(v.w, 10);
  v.stages.forEach((s, i) => (y[N_BASE + i] = s.prop));
  return y;
}

export function unpackState(v: Vehicle, y: Float64Array): void {
  v.r = [y[0], y[1], y[2]];
  v.v = [y[3], y[4], y[5]];
  v.q = qnormalize([y[6], y[7], y[8], y[9]]);
  v.w = [y[10], y[11], y[12]];
  v.stages.forEach((s, i) => (s.prop = Math.max(0, y[N_BASE + i])));
}

/** Evaluate forces and the state derivative. */
export function evaluate(veh: Vehicle, y: Float64Array, t: number, env: Env): { dy: Float64Array; aux: Aux } {
  const r: V3 = [y[0], y[1], y[2]];
  const v: V3 = [y[3], y[4], y[5]];
  const q: Q = [y[6], y[7], y[8], y[9]];
  const w: V3 = [y[10], y[11], y[12]];
  const props = y.subarray(N_BASE);
  const mp = massProps(veh.stages, props);

  const geo = ecefToGeodetic(eciToEcef(r, t));
  const atm = atmosphere(geo.h);
  const pAmb = env.aero ? atm.p : 0;
  const dy = new Float64Array(y.length);

  // --- Propulsion ---
  const force: V3 = [0, 0, 0];
  const torque: V3 = [0, 0, 0];
  const thrusts: number[] = new Array(veh.engines.length).fill(0);
  let totalThrust = 0;
  veh.engines.forEach((e, i) => {
    if (e.failed || e.throttle <= 0 || props[e.stage] <= 0) return;
    const f = engineThrust(e.place.type, e.throttle, pAmb);
    dy[N_BASE + e.stage] -= engineMassFlow(e.place.type, e.throttle);
    const inv = 1 / Math.sqrt(1 + e.gy * e.gy + e.gz * e.gz);
    const fv: V3 = [f * inv, f * e.gy * inv, f * e.gz * inv];
    const arm: V3 = [e.place.pos[0] - mp.xcg, e.place.pos[1], e.place.pos[2]];
    const tq = cross(arm, fv);
    force[0] += fv[0];
    force[1] += fv[1];
    force[2] += fv[2];
    torque[0] += tq[0];
    torque[1] += tq[1];
    torque[2] += tq[2];
    thrusts[i] = f;
    totalThrust += f;
  });

  // --- Aerodynamics ---
  const vAir = airRelativeVelocity(r, v);
  const speed = norm(vAir);
  const aeroTorque: V3 = [0, 0, 0];
  let surfaceTorque: V3 = [0, 0, 0];
  let flow: Flow = { vHat: [0, 0, 0], q: 0, mach: 0 };
  let qDyn = 0;
  let mach = 0;
  let alpha = 0;
  if (env.aero && atm.rho > 0 && speed > 1) {
    qDyn = 0.5 * atm.rho * speed * speed;
    mach = speed / atm.a;
    const vb = qrotInv(q, vAir);
    alpha = Math.acos(Math.max(-1, Math.min(1, vb[0] / speed)));
    const [xLo, xHi] = veh.extent;
    const length = xHi - xLo;
    const fa: V3 = [-qDyn * REF_AREA * axialCoefficient(mach, vb[0] < 0) * (vb[0] / speed), 0, 0];
    const cross2 = Math.hypot(vb[1], vb[2]);
    if (cross2 > 1e-9) {
      const fn = qDyn * REF_AREA * normalCoefficient(alpha, length);
      fa[1] = (-fn * vb[1]) / cross2;
      fa[2] = (-fn * vb[2]) / cross2;
    }
    // Center of pressure: toward the leading end at small alpha (slender-body lift is made there),
    // moving to the side-on outline's centroid when broadside (a bit below mid-length: the
    // tapered nose has less area than the barrel). Flying engines-first, the leading end is the
    // base, so the same shape mirrors toward the base.
    const cpNose = 0.6 - 0.15 * Math.sin(alpha);
    const cpFrac = vb[0] >= 0 ? cpNose : 1 - cpNose;
    const arm: V3 = [xLo + cpFrac * length - mp.xcg, 0, 0];
    const tq = cross(arm, fa);
    const damp = qDyn * REF_AREA * length * CMQ * (length / (2 * speed));
    aeroTorque[0] = tq[0];
    aeroTorque[1] = tq[1] + damp * w[1];
    aeroTorque[2] = tq[2] + damp * w[2];
    force[0] += fa[0];
    force[1] += fa[1];
    force[2] += fa[2];
    // Flaps and grid fins: each its own force at its own place.
    flow = { vHat: [vb[0] / speed, vb[1] / speed, vb[2] / speed], q: qDyn, mach };
    const sl = surfaceLoads(veh.surfaces, veh.surfaceAngles, flow, mp.xcg);
    surfaceTorque = sl.t;
    force[0] += sl.f[0];
    force[1] += sl.f[1];
    force[2] += sl.f[2];
  }
  torque[0] += aeroTorque[0] + surfaceTorque[0] + veh.rcsTorque[0];
  torque[1] += aeroTorque[1] + surfaceTorque[1] + veh.rcsTorque[1];
  torque[2] += aeroTorque[2] + surfaceTorque[2] + veh.rcsTorque[2];

  // --- Translation ---
  const fEci = qrot(q, force);
  fEci[0] += veh.extForce[0];
  fEci[1] += veh.extForce[1];
  fEci[2] += veh.extForce[2];
  const g = env.gravity ? gravityJ2(r) : ([0, 0, 0] as V3);
  dy[0] = v[0];
  dy[1] = v[1];
  dy[2] = v[2];
  dy[3] = g[0] + fEci[0] / mp.mass;
  dy[4] = g[1] + fEci[1] / mp.mass;
  dy[5] = g[2] + fEci[2] / mp.mass;

  // --- Rotation: q' = 0.5 q (0, w); I w' = tau - w x I w ---
  dy[6] = 0.5 * (-q[1] * w[0] - q[2] * w[1] - q[3] * w[2]);
  dy[7] = 0.5 * (q[0] * w[0] + q[2] * w[2] - q[3] * w[1]);
  dy[8] = 0.5 * (q[0] * w[1] - q[1] * w[2] + q[3] * w[0]);
  dy[9] = 0.5 * (q[0] * w[2] + q[1] * w[1] - q[2] * w[0]);
  const iw: V3 = [mp.ix * w[0], mp.it * w[1], mp.it * w[2]];
  const gyro = cross(w, iw);
  dy[10] = (torque[0] - gyro[0]) / mp.ix;
  dy[11] = (torque[1] - gyro[1]) / mp.it;
  dy[12] = (torque[2] - gyro[2]) / mp.it;

  return {
    dy,
    aux: {
      mp,
      geo,
      pAmb,
      rho: env.aero ? atm.rho : 0,
      soundSpeed: atm.a,
      vAir,
      mach,
      q: qDyn,
      alpha,
      engineThrust: thrusts,
      thrust: totalThrust,
      aeroTorque,
      surfaceTorque,
      flow,
      properAccel: norm(fEci) / mp.mass,
    },
  };
}

/** Advance one RK4 step. Returns the aux evaluated at the start of the step. */
export function rk4Step(veh: Vehicle, t: number, dt: number, env: Env = DEFAULT_ENV): Aux {
  const y0 = packState(veh);
  const n = y0.length;
  const k1 = evaluate(veh, y0, t, env);
  const tmp = new Float64Array(n);
  const stage = (k: Float64Array, h: number) => {
    for (let i = 0; i < n; i++) tmp[i] = y0[i] + k[i] * h;
    return tmp;
  };
  const k2 = evaluate(veh, stage(k1.dy, dt / 2), t + dt / 2, env).dy;
  const k3 = evaluate(veh, stage(k2, dt / 2), t + dt / 2, env).dy;
  const k4 = evaluate(veh, stage(k3, dt), t + dt, env).dy;
  const y1 = new Float64Array(n);
  for (let i = 0; i < n; i++) y1[i] = y0[i] + (dt / 6) * (k1.dy[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
  unpackState(veh, y1);
  return k1.aux;
}

/** Evaluate aux without stepping (for telemetry of held/static vehicles). */
export function currentAux(veh: Vehicle, t: number, env: Env = DEFAULT_ENV): Aux {
  return evaluate(veh, packState(veh), t, env).aux;
}

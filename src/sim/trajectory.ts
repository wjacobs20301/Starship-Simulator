// Predicted trajectory for the map view: where a vehicle goes if its engines stopped now (the
// KSP convention; burning, it updates live). Point-mass propagation with J2 gravity and drag
// through the US76 atmosphere, until it hits the ground or, for an orbit that stays out of the
// air, for about an orbit and a half.
//
// The path is returned in Earth-fixed coordinates, so it lies over the right ground (the ground
// track and impact point); an orbit therefore doesn't close on itself: the Earth turns under it.

import { atmosphere } from './atmosphere';
import { MU } from './constants';
import { airRelativeVelocity, ecefToGeodetic, eciToEcef } from './frames';
import { gravityJ2 } from './gravity';
import { orbitApsides } from './guidance';
import { type V3, add, cross, dot, norm, scale, sub } from './math';

export interface TrajectoryMark {
  /** Earth-fixed position, m. */
  ecef: V3;
  /** Altitude above the ellipsoid, m. */
  alt: number;
  /** Seconds from now. */
  dt: number;
}

export interface Trajectory {
  id: string;
  /** Sim time the prediction starts from, s. */
  t: number;
  /** Earth-fixed path points, m (starting at the vehicle). */
  points: V3[];
  /** Index of the first point inside the atmosphere (below 100 km) on the way down, or -1. */
  entryIndex: number;
  /** Index of the maneuver burn (paths predicted with a burn), or -1. */
  nodeIndex: number;
  apoapsis: TrajectoryMark | null;
  periapsis: TrajectoryMark | null;
  entry: TrajectoryMark | null;
  /** Ground impact (lat/lon in degrees) or null if it stays up. */
  impact: (TrajectoryMark & { lat: number; lon: number; speed: number }) | null;
  /** Osculating orbit: apsides above the mean radius, inclination (deg), period (s, 0 if open). */
  orbit: { perigee: number; apogee: number; inclination: number; period: number };
}

const ENTRY_ALT = 100e3;
const MAX_POINTS = 700;

/** How a vehicle meets the air: drag area (Cd x reference area, m^2) and lift. */
export interface EntryModel {
  dragArea: number;
  /** Lift-to-drag ratio vs air speed (lift acts upward, in the vertical plane, unless banked). */
  liftToDrag?: (speed: number) => number;
  /**
   * Bank angle, rad: the lift vector rolled about the velocity away from straight up, toward
   * cross(up, velocity) for positive angles (the side the entry guidance steers with).
   */
  bank?: number;
}

/** r, v: ECI state at time t (s); mass in kg. */
export function predictTrajectory(
  id: string,
  r0: V3,
  v0: V3,
  t0: number,
  model: EntryModel,
  mass: number,
  /** An impulsive burn (ECI delta-v) at sim time t: the path after a maneuver node. */
  burn?: { t: number; dv: V3 },
): Trajectory {
  // The orbit that matters is the one after the burn.
  let rO = r0;
  let vO = v0;
  if (burn) {
    const at = propagate(r0, v0, t0, Math.max(t0, burn.t), model, mass);
    rO = at.r;
    vO = add(at.v, burn.dv);
  }
  const aps = orbitApsides(rO, vO);
  const h = cross(rO, vO);
  const energy = dot(vO, vO) / 2 - MU / norm(rO);
  const a = -MU / (2 * energy);
  const period = energy < 0 ? 2 * Math.PI * Math.sqrt((a * a * a) / MU) : 0;
  const orbit = { perigee: aps.perigee, apogee: aps.apogee, inclination: (Math.acos(h[2] / norm(h)) * 180) / Math.PI, period };
  // Stays out of the atmosphere: show 1.5 orbits; otherwise follow it down (up to 3 h).
  const stable = period > 0 && aps.perigee > 140e3;
  const tMax = (burn ? Math.max(0, burn.t - t0) : 0) + (stable ? 1.5 * period : Math.min(3 * 3600, period > 0 ? 1.5 * period : 3 * 3600));

  const accel = (r: V3, v: V3, alt: number): V3 => coastAccel(r, v, alt, model, mass);

  let r = r0;
  let v = v0;
  let t = t0;
  let alt = ecefToGeodetic(eciToEcef(r, t)).h;
  const pts: V3[] = [eciToEcef(r, t)];
  const alts: number[] = [alt];
  const times: number[] = [0];
  let impact: Trajectory['impact'] = null;
  let entry: TrajectoryMark | null = null;
  let entryIndex = -1;
  let burned = false;
  let nodeIndex = -1;
  while (t - t0 < tMax) {
    // Step size: long in vacuum, short in the air and near the ground; ending exactly on a burn.
    let dt = stepSize(alt);
    if (burn && !burned && t + dt >= burn.t) dt = Math.max(1e-3, burn.t - t);
    let [rNext, vNext] = rk4(r, v, dt, alt, accel);
    if (burn && !burned && t + dt >= burn.t - 1e-6) {
      burned = true;
      vNext = add(vNext, burn.dv);
      nodeIndex = pts.length;
    }
    const tNext = t + dt;
    const ecef = eciToEcef(rNext, tNext);
    const altNext = ecefToGeodetic(ecef).h;
    if (!entry && alt >= ENTRY_ALT && altNext < ENTRY_ALT) {
      entry = { ecef, alt: ENTRY_ALT, dt: tNext - t0 };
      entryIndex = pts.length;
    }
    if (altNext <= 0) {
      // Interpolate to the ground.
      const f = alt / Math.max(1e-6, alt - altNext);
      const p = eciToEcef(add(r, scale(add(rNext, scale(r, -1)), f)), t + f * dt);
      const geo = ecefToGeodetic(p);
      pts.push(p);
      alts.push(0);
      times.push(t + f * dt - t0);
      impact = { ecef: p, alt: 0, dt: t + f * dt - t0, lat: (geo.lat * 180) / Math.PI, lon: (geo.lon * 180) / Math.PI, speed: norm(airRelativeVelocity(rNext, vNext)) };
      break;
    }
    r = rNext;
    v = vNext;
    t = tNext;
    alt = altNext;
    pts.push(ecef);
    alts.push(alt);
    times.push(t - t0);
  }

  // Apsides along the path: the first altitude maximum / minimum ahead (after the burn, if any).
  const extremum = (sign: 1 | -1): TrajectoryMark | null => {
    for (let i = Math.max(1, nodeIndex); i < alts.length - 1; i++) {
      if (sign * (alts[i] - alts[i - 1]) >= 0 && sign * (alts[i + 1] - alts[i]) < 0) {
        return { ecef: pts[i], alt: alts[i], dt: times[i] };
      }
    }
    return null;
  };
  const apoapsis = extremum(1);
  const periapsis = impact ? null : extremum(-1);

  // Thin the path for drawing, keeping the ends and the entry point.
  let points = pts;
  if (pts.length > MAX_POINTS) {
    const step = Math.ceil(pts.length / MAX_POINTS);
    points = [];
    for (let i = 0; i < pts.length; i += step) points.push(pts[i]);
    if (points[points.length - 1] !== pts[pts.length - 1]) points.push(pts[pts.length - 1]);
    entryIndex = entryIndex >= 0 ? Math.floor(entryIndex / step) : -1;
    nodeIndex = nodeIndex >= 0 ? Math.floor(nodeIndex / step) : -1;
  }
  return { id, t: t0, points, entryIndex, nodeIndex, apoapsis, periapsis, entry, impact, orbit };
}

/** Gravity (J2) plus drag and lift for a coasting vehicle, m/s^2 (ECI). */
function coastAccel(r: V3, v: V3, alt: number, model: EntryModel, mass: number): V3 {
  const { dragArea, liftToDrag } = model;
  const g = gravityJ2(r);
  if (alt > 150e3 || dragArea <= 0) return g;
  const rho = atmosphere(Math.max(0, alt)).rho;
  if (rho <= 0) return g;
  const va = airRelativeVelocity(r, v);
  const speed = norm(va);
  const k = (-0.5 * rho * speed * dragArea) / mass;
  const withDrag = add(g, scale(va, k));
  const ld = liftToDrag?.(speed) ?? 0;
  if (ld <= 0 || speed < 1) return withDrag;
  // Lift: up (square to the airflow), rolled by the bank angle.
  const up = scale(r, 1 / norm(r));
  const u = scale(va, 1 / speed);
  let lift = sub(up, scale(u, dot(up, u)));
  const ln = norm(lift);
  if (ln < 1e-6) return withDrag;
  lift = scale(lift, 1 / ln);
  if (model.bank) lift = add(scale(lift, Math.cos(model.bank)), scale(cross(lift, u), Math.sin(model.bank)));
  return add(withDrag, scale(lift, -k * speed * ld));
}

const stepSize = (alt: number) => (alt > 200e3 ? 20 : alt > 100e3 ? 8 : alt > 30e3 ? 2 : alt > 5e3 ? 1 : 0.5);

/** One RK4 step of the translational state. */
function rk4(r: V3, v: V3, dt: number, alt: number, accel: (r: V3, v: V3, alt: number) => V3): [V3, V3] {
  const k1v = accel(r, v, alt);
  const r2 = add(r, scale(v, dt / 2));
  const v2 = add(v, scale(k1v, dt / 2));
  const k2v = accel(r2, v2, alt);
  const r3 = add(r, scale(v2, dt / 2));
  const v3 = add(v, scale(k2v, dt / 2));
  const k3v = accel(r3, v3, alt);
  const r4 = add(r, scale(v3, dt));
  const v4 = add(v, scale(k3v, dt));
  const k4v = accel(r4, v4, alt);
  return [
    add(r, scale(add(add(v, scale(v2, 2)), add(scale(v3, 2), v4)), dt / 6)),
    add(v, scale(add(add(k1v, scale(k2v, 2)), add(scale(k3v, 2), k4v)), dt / 6)),
  ];
}

/** Coast from (r, v) at t0 to t1 (ECI). maxStep caps the step (on-rails warp uses it). */
export function propagate(r0: V3, v0: V3, t0: number, t1: number, model: EntryModel, mass: number, maxStep = Infinity): { r: V3; v: V3 } {
  let r = r0;
  let v = v0;
  let t = t0;
  while (t < t1 - 1e-9) {
    const alt = norm(r) - 6371e3; // rough (step size only)
    const dt = Math.min(stepSize(alt), maxStep, t1 - t);
    [r, v] = rk4(r, v, dt, alt, (rr, vv) => coastAccel(rr, vv, ecefToGeodetic(eciToEcef(rr, t)).h, model, mass));
    t += dt;
  }
  return { r, v };
}

/** Local orbital frame at (r, v): prograde, normal, radial (out) unit vectors, ECI. */
export function orbitalFrame(r: V3, v: V3): { pro: V3; nrm: V3; rad: V3 } {
  const pro = scale(v, 1 / norm(v));
  const hv = cross(r, v);
  const nrm = scale(hv, 1 / norm(hv));
  const rad = cross(pro, nrm);
  return { pro, nrm, rad };
}

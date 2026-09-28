// Ascent guidance laws. Each returns a desired body +x direction in ECI.

import { DEG, MU } from './constants';
import type { Aux } from './dynamics';
import { localBasisEci } from './frames';
import { type V3, add, clamp, dot, norm, normalize, scale, sub } from './math';
import type { Vehicle } from './vehicle';

/** Horizontal unit vector along a launch azimuth (deg from north, clockwise). */
export function azimuthDir(aux: Aux, t: number, azimuthDeg: number): { up: V3; dir: V3 } {
  const { e, n, u } = localBasisEci(aux.geo, t);
  const a = azimuthDeg * DEG;
  return { up: u, dir: add(scale(n, Math.cos(a)), scale(e, Math.sin(a))) };
}

/**
 * Booster: vertical rise, a small pitch-over ("kick") toward the launch azimuth, then a
 * zero-angle-of-attack gravity turn that follows the air-relative velocity.
 */
export class GravityTurnGuidance {
  phase: 'vertical' | 'kick' | 'turn' = 'vertical';

  constructor(
    private azimuthDeg: number,
    private kickStart: number,
    private kickAngleDeg: number,
  ) {}

  target(_veh: Vehicle, aux: Aux, t: number, sinceLiftoff: number): V3 {
    const { up, dir } = azimuthDir(aux, t, this.azimuthDeg);
    if (this.phase === 'vertical') {
      if (sinceLiftoff >= this.kickStart) this.phase = 'kick';
      else return up;
    }
    const k = this.kickAngleDeg * DEG;
    const kickDir = normalize(add(scale(up, Math.cos(k)), scale(dir, Math.sin(k))));
    const vAirUp = dot(normalize(aux.vAir), up);
    if (this.phase === 'kick') {
      // Hold the kick attitude until the velocity vector has tipped over as far.
      if (norm(aux.vAir) > 50 && vAirUp <= Math.cos(k)) this.phase = 'turn';
      else return kickDir;
    }
    return normalize(aux.vAir);
  }
}

/**
 * Ship: closed-loop altitude/vertical-speed law. Commands the vertical acceleration that
 * drives altitude to the target while cancelling gravity minus centrifugal lift, then
 * points thrust accordingly with the rest along the horizontal velocity.
 */
export class InsertionGuidance {
  kp = 3e-4;
  kd = 0.035;

  /**
   * @param targetAlt altitude held through most of the burn, m
   * @param climbAtCutoff vertical speed built up over the last ~1 km/s of the burn, m/s: the
   *   ship cuts off still climbing and coasts up to a higher apogee (as on the test flights)
   */
  constructor(
    private targetAlt: number,
    private climbAtCutoff = 0,
  ) {}

  target(veh: Vehicle, aux: Aux, t: number): V3 {
    const { u: up } = localBasisEci(aux.geo, t);
    const r = norm(veh.r);
    const vz = dot(veh.v, up);
    const vhVec = sub(veh.v, scale(up, vz));
    const vh = norm(vhVec);
    const aThrust = aux.thrust / aux.mp.mass;
    const hDir = vh > 1 ? scale(vhVec, 1 / vh) : up;
    if (aThrust < 0.5) return normalize(veh.v);
    const vzTarget = this.climbAtCutoff * clamp((vh - 6300) / 1000, 0, 1);
    const aCmd = MU / (r * r) - (vh * vh) / r + this.kp * (this.targetAlt - aux.geo.h) - this.kd * (vz - vzTarget);
    const s = clamp(aCmd / aThrust, Math.sin(-15 * DEG), Math.sin(55 * DEG));
    const c = Math.sqrt(1 - s * s);
    return normalize(add(scale(hDir, c), scale(up, s)));
  }
}

/** Perigee and apogee altitudes (above the mean Earth radius) of the osculating orbit. */
export function orbitApsides(r: V3, v: V3): { perigee: number; apogee: number } {
  const rn = norm(r);
  const energy = dot(v, v) / 2 - MU / rn;
  const h = norm([r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]]);
  const a = -MU / (2 * energy);
  const e = Math.sqrt(Math.max(0, 1 + (2 * energy * h * h) / (MU * MU)));
  const RE_MEAN = 6371000;
  return { perigee: a * (1 - e) - RE_MEAN, apogee: energy < 0 ? a * (1 + e) - RE_MEAN : Infinity };
}

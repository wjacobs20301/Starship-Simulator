// Starship's return from its (transatmospheric) orbit, as flown on the test flights:
//
//   coast      after SECO, swing to the entry attitude: belly (heat shield, body +y) forward
//   entry      hypersonic, belly-first at ~60 deg angle of attack; the flaps hold attitude as the
//              air thickens; peak heating around 70-80 km
//   bellyflop  subsonic, falling belly-first at ~90 deg, at terminal velocity (~300 km/h)
//   flip       ~1 km up: the three sea-level Raptors light and swing the ship upright
//   landing    landing burn to a soft touchdown on the ocean (the test flights' "splashdown")
//
// The attitude reference: nose (body +x) tilted from the air-relative velocity toward "up" by the
// angle of attack, rolled so the heat shield faces into the flow.

import { DEG } from './constants';
import { applyControl } from './control';
import type { Aux } from './dynamics';
import { engineThrust, throttleForThrust } from './engine';
import { airRelativeVelocity, localBasisEci } from './frames';
import { type V3, add, clamp, cross, dot, norm, normalize, qrot, scale, sub } from './math';
import type { Simulation } from './simulation';
import type { EntryModel } from './trajectory';
import { type Vehicle, setThrottle } from './vehicle';

export type ReentryPhase = 'coast' | 'entry' | 'bellyflop' | 'flip' | 'landing' | 'landed' | 'lost';

/** Hypersonic and subsonic angles of attack, rad (approx / tune). */
const ALPHA_HYPERSONIC = 60 * DEG;
const ALPHA_BELLYFLOP = 88 * DEG;
/** Nose radius-ish length for the stagnation heating estimate (belly-first: broad), m. */
const HEAT_RADIUS = 6;
/** Planned net deceleration of the landing burn, as a fraction of 3 engines at full throttle. */
const LANDING_PLAN = 0.4;
/** Seconds of fall to allow for the flip before the burn really starts braking. */
const FLIP_MARGIN_S = 4;
const LANDING_GAINS = { wn: 1.2, zeta: 0.9, rollDamp: 0.5 };

/**
 * The entry as this autopilot flies it (belly-first, lift up; flaps included), for trajectory
 * prediction: drag area (m^2) and lift-to-drag by speed. Measured from the sim (approx).
 */
export const SHIP_ENTRY: EntryModel = { dragArea: 339, liftToDrag: (speed) => (speed > 1000 ? 0.53 : speed > 700 ? 0.3 : 0.12) };

/** Sutton-Graves stagnation-point convective heat flux, W/m^2. */
export function heatFlux(rho: number, speed: number): number {
  return 1.7415e-4 * Math.sqrt(Math.max(0, rho) / HEAT_RADIUS) * speed ** 3;
}

export class ShipReentry {
  phase: ReentryPhase = 'coast';
  private heading: V3 | null = null;
  private peakHeat = 0;
  private logged = new Set<string>();

  constructor(
    private sim: Simulation,
    private log: (text: string) => void,
  ) {}

  private once(key: string, text: string): void {
    if (!this.logged.has(key)) {
      this.logged.add(key);
      this.log(text);
    }
  }

  update(ship: Vehicle, aux: Aux, dt: number): void {
    const t = this.sim.t;
    const { u: up } = localBasisEci(aux.geo, t);
    const vAir = airRelativeVelocity(ship.r, ship.v);
    const speed = norm(vAir);
    const vHat = speed > 1 ? scale(vAir, 1 / speed) : scale(up, -1);
    const vz = dot(vAir, up);
    const rsl = (ring: number) => ring === 0;

    // Heading (horizontal direction of travel), kept once the ship is falling nearly vertically.
    const vh = sub(vAir, scale(up, vz));
    if (norm(vh) > 20) this.heading = normalize(vh);
    const heading = this.heading ?? normalize(cross(up, [0, 0, 1]));

    const heat = heatFlux(aux.rho, speed);
    if (heat > this.peakHeat) this.peakHeat = heat;
    else if (this.peakHeat > 1e5 && heat < 0.9 * this.peakHeat) {
      this.once('peakHeat', `Peak heating ~${(this.peakHeat / 1e4).toFixed(0)} W/cm² at ${(aux.geo.h / 1000).toFixed(0)} km`);
    }

    // Base (bottom of the ship) height: the CG less the distance down the axis to the ship's base.
    const axis = qrot(ship.q, [1, 0, 0]);
    const xBase = ship.stages[0].def.xBase;
    const baseHeight = aux.geo.h - (aux.mp.xcg - xBase) * dot(axis, up);

    switch (this.phase) {
      case 'coast':
      case 'entry':
      case 'bellyflop': {
        if (this.phase === 'coast' && aux.geo.h < 100e3 && vz < 0) {
          this.phase = 'entry';
          this.log('Entry interface (100 km)');
        }
        if (this.phase === 'entry' && aux.mach < 1 && aux.geo.h < 30e3) {
          this.phase = 'bellyflop';
          this.log(`Subsonic: belly-flop at ${(speed * 3.6).toFixed(0)} km/h`);
        }
        if (this.phase === 'entry' && aux.q > 1e3) this.once('flaps', 'Flaps active');
        // Angle of attack: 60 deg hypersonic, easing to a flat belly-flop below Mach ~2.
        const att = entryAttitude(vHat, up, heading, entryAlpha(aux.mach));
        applyControl(ship, aux, att.nose, dt, undefined, att.bodyZ);
        if (this.phase === 'bellyflop' && this.shouldIgnite(ship, aux, baseHeight, vz)) {
          setThrottle(ship, 'ship', 1, rsl);
          this.phase = 'flip';
          this.log(`Landing flip and burn (${(baseHeight / 1000).toFixed(2)} km, ${(speed * 3.6).toFixed(0)} km/h)`);
        }
        break;
      }

      case 'flip':
      case 'landing': {
        // Vertical: constant deceleration to touch down at ~1 m/s. Horizontal: kill the drift.
        const h = Math.max(0.5, baseHeight);
        const down = -vz;
        const aUp = Math.max(0, down * down - 1) / (2 * h) + 9.8;
        const aH = scale(vh, -0.6);
        let aCmd = add(scale(up, aUp), aH);
        // Tilt no more than 20 deg from vertical once upright.
        const hMag = norm(aH);
        const maxH = aUp * Math.tan(20 * DEG);
        if (hMag > maxH) aCmd = add(scale(up, aUp), scale(aH, maxH / hMag));
        // Drag still helps early in the burn (the ship is broadside to the flow during the flip).
        const force = aux.mp.mass * norm(aCmd);
        const perEngine = engineThrust(ship.engines[0].place.type, 1, aux.pAmb);
        const throttle = this.phase === 'flip' ? 1 : clamp(throttleForThrust(ship.engines[0].place.type, force / 3, aux.pAmb), 0.4, 1);
        void perEngine;
        setThrottle(ship, 'ship', throttle, rsl);
        applyControl(ship, aux, normalize(aCmd), dt, LANDING_GAINS);
        if (this.phase === 'flip' && dot(axis, up) > Math.cos(20 * DEG)) this.phase = 'landing';
        if (baseHeight <= 0.3 || (this.phase === 'landing' && down < 0.2 && baseHeight < 3)) {
          setThrottle(ship, 'ship', 0);
          this.phase = 'landed';
          ship.status = 'landed';
          this.log(`Splashdown! (${down.toFixed(1)} m/s, ${norm(vh).toFixed(1)} m/s sideways)`);
        }
        if (ship.stages[0].prop <= 0) this.phase = 'lost';
        break;
      }

      case 'landed':
        break;

      case 'lost':
        setThrottle(ship, 'ship', 0);
        applyControl(ship, aux, null, dt);
        break;
    }
  }

  /** Light the engines once the stop, plus time for the flip, needs 40% of 3 engines' capability. */
  private shouldIgnite(ship: Vehicle, aux: Aux, baseHeight: number, vz: number): boolean {
    if (vz > -10 || baseHeight > 3000) return false;
    const perEngine = engineThrust(ship.engines[0].place.type, 1, aux.pAmb);
    const aNet = LANDING_PLAN * ((3 * perEngine) / aux.mp.mass);
    const down = -vz;
    return baseHeight <= (down * down) / (2 * aNet) + down * FLIP_MARGIN_S;
  }
}

/**
 * Target nose direction and roll reference (for body +z) for flying belly-first at angle of
 * attack a: nose tilted from the velocity toward "up", heat shield (body +y) into the flow.
 */
export function entryAttitude(vHat: V3, up: V3, heading: V3, a: number, bank = 0): { nose: V3; bodyZ: V3 } {
  // Direction perpendicular to the velocity, toward up (or along the heading if falling straight
  // down), rolled about the velocity by the bank angle: the way the lift will point.
  let perp = sub(up, scale(vHat, dot(up, vHat)));
  perp = norm(perp) > 0.2 ? normalize(perp) : heading;
  if (bank) perp = normalize(add(scale(perp, Math.cos(bank)), scale(cross(perp, vHat), Math.sin(bank))));
  const nose = normalize(add(scale(vHat, Math.cos(a)), scale(perp, Math.sin(a))));
  // Belly faces the flow: along the velocity's component across the body axis. The tiles are on
  // the model's body +y side (its mesh +X; the logo and serial are on the steel side, -y).
  const bodyY = normalize(sub(vHat, scale(nose, dot(vHat, nose))));
  const bodyZ = cross(nose, bodyY);
  return { nose, bodyZ };
}


/** Entry angle of attack by Mach: 60 deg hypersonic, easing to a flat belly-flop below Mach ~2. */
export function entryAlpha(mach: number): number {
  return ALPHA_HYPERSONIC + (ALPHA_BELLYFLOP - ALPHA_HYPERSONIC) * clamp((3 - mach) / 2.5, 0, 1);
}

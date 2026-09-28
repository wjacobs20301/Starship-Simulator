// Structural and thermal limits: what breaks a vehicle the player flies badly.
//
//   Aero loads  The stack and the booster are long, thin tanks: side loads (q x sin(alpha))
//               bend them. Nominal flight peaks near 0.7 kPa for the stack (max-Q at ~1 deg)
//               and ~8 kPa for the booster (engines-first entry); the ship is built to fly
//               broadside, so only raw dynamic pressure limits it.
//   Heating     Sutton-Graves stagnation heating. Only surfaces made for it face the flow
//               safely: the ship's tiled belly, the booster's engine end (engines-first), the
//               stack's nose on the way up. Anything else heats bare steel, and the heat load
//               eats into a burn-through margin; the tiles also have a peak-flux limit.
//
// All limits approximate / tuned for play (nominal flights stay well inside them).

import type { Aux } from './dynamics';
import { airRelativeVelocity } from './frames';
import { clamp, norm, qrotInv, scale } from './math';
import { heatFlux } from './shipReentry';
import type { Vehicle } from './vehicle';

export const LIMITS = {
  /** Side load (q sin alpha) the stack survives, Pa. */
  stackQAlpha: 6e3,
  boosterQAlpha: 25e3,
  /** Dynamic pressure limits, Pa. */
  boosterQ: 420e3,
  shipQ: 40e3,
  /** Heat flux bare steel shrugs off, W/m^2. */
  steelFlux: 3e4,
  /** Peak flux the heat shield tiles take, W/m^2. */
  tileFlux: 8e5,
  /** Excess heat load (J/m^2) that burns through. */
  burnThrough: 4e6,
};

export interface VehicleHealth {
  /** Heat damage, 0..1 (1 = burn-through). */
  heat: number;
  /** Fraction of the structural limit in use right now, 0..1+. */
  load: number;
  /** Current stagnation heat flux, W/m^2. */
  flux: number;
  /** How well the flow meets the heat-protected side, 0..1. */
  shielded: number;
  /** Structural damage from knocks against the tower / arms, 0..1 (1 = breaks up). */
  damage: number;
}

export function newHealth(): VehicleHealth {
  return { heat: 0, load: 0, flux: 0, shielded: 1, damage: 0 };
}

/**
 * Update a flying vehicle's health for one step. Returns the reason it breaks up, or null.
 */
export function checkLimits(v: Vehicle, aux: Aux, health: VehicleHealth, dt: number): string | null {
  const ids = v.stages.map((s) => s.def.id);
  const kind = ids.length > 1 ? 'stack' : ids[0];
  const sinA = Math.abs(Math.sin(aux.alpha));
  let load: number;
  let why: string;
  if (kind === 'stack') {
    load = (aux.q * sinA) / LIMITS.stackQAlpha;
    why = `structural failure: side load ${((aux.q * sinA) / 1000).toFixed(1)} kPa at ${(aux.alpha * 57.3).toFixed(0)}° angle of attack`;
  } else if (kind === 'booster') {
    load = Math.max((aux.q * sinA) / LIMITS.boosterQAlpha, aux.q / LIMITS.boosterQ);
    why = `structural failure at ${(aux.q / 1000).toFixed(0)} kPa, ${(aux.alpha * 57.3).toFixed(0)}° angle of attack`;
  } else {
    load = aux.q / LIMITS.shipQ;
    why = `structural failure at ${(aux.q / 1000).toFixed(0)} kPa`;
  }
  health.load = load;
  if (load > 1) return why;

  // Heating: which side meets the flow (body-frame direction of travel through the air).
  const va = airRelativeVelocity(v.r, v.v);
  const speed = norm(va);
  const flux = heatFlux(aux.rho, speed);
  health.flux = flux;
  if (speed < 1 || flux < LIMITS.steelFlux) {
    health.shielded = 1;
    return null;
  }
  const b = qrotInv(v.q, scale(va, 1 / speed));
  // Ship: tiled belly (body +y) windward. Booster: engines (body -x) first. Stack: nose first.
  const shielded =
    kind === 'ship' ? clamp((b[1] - 0.2) / 0.3, 0, 1) : kind === 'booster' ? clamp((-b[0] - 0.6) / 0.3, 0, 1) : clamp((b[0] - 0.6) / 0.3, 0, 1);
  health.shielded = shielded;
  const bare = Math.max(0, flux * (1 - shielded) - LIMITS.steelFlux);
  const tiles = kind === 'ship' ? Math.max(0, flux - LIMITS.tileFlux) * shielded : 0;
  health.heat += ((bare + tiles) * dt) / LIMITS.burnThrough;
  if (health.heat >= 1) return kind === 'ship' && tiles > bare ? 'heat shield failure: burn-through' : 'burn-through: unprotected steel facing the plasma';
  return null;
}

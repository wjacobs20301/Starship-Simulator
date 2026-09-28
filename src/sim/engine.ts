// Rocket engine model.
// Mass flow depends only on throttle. Thrust loses ambient pressure x nozzle exit area:
//   F = throttle * F_vac - p_amb * A_exit
// so sea-level engines gain ~5% thrust on the way up, and big-nozzle vacuum engines lose a lot at sea level.

import { G0, P0 } from './constants';

export interface EngineType {
  name: string;
  /** Full-throttle vacuum thrust, N. */
  thrustVac: number;
  /** Vacuum specific impulse, s. */
  ispVac: number;
  /** Nozzle exit area, m^2. */
  exitArea: number;
  /** Maximum gimbal deflection, rad (0 = fixed engine). */
  gimbalMax: number;
  /** Gimbal slew rate, rad/s. */
  gimbalRate: number;
  /** Minimum throttle while running (deep throttling limit). */
  minThrottle: number;
  /** Gimbal point to nozzle exit, m (geometry only). */
  length: number;
}

/** Build an engine type from its published sea-level figures. */
export function engineFromSeaLevel(
  name: string,
  thrustSL: number,
  ispSL: number,
  exitDiameter: number,
  rest: Pick<EngineType, 'gimbalMax' | 'gimbalRate' | 'minThrottle' | 'length'>,
): EngineType {
  const exitArea = Math.PI * (exitDiameter / 2) ** 2;
  const thrustVac = thrustSL + P0 * exitArea;
  return { name, thrustVac, ispVac: (ispSL * thrustVac) / thrustSL, exitArea, ...rest };
}

export const engineThrust = (e: EngineType, throttle: number, pAmb: number): number =>
  throttle <= 0 ? 0 : Math.max(0, throttle * e.thrustVac - pAmb * e.exitArea);

export const engineMassFlow = (e: EngineType, throttle: number): number =>
  throttle <= 0 ? 0 : (throttle * e.thrustVac) / (e.ispVac * G0);

/** Throttle that gives `thrust` (N) per engine at ambient pressure pAmb (inverse of engineThrust). */
export const throttleForThrust = (e: EngineType, thrust: number, pAmb: number): number =>
  (thrust + pAmb * e.exitArea) / e.thrustVac;

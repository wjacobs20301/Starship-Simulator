// Starship V3 / Super Heavy V3 / Raptor 3 parameters.
//
// Every number here is an APPROXIMATION assembled from public sources (SpaceX
// statements and press coverage of the V3 debut, webcast telemetry, community
// estimates). They are the knobs for matching real flight data: tune here only.
//
// Sources for the headline figures:
// - Stack ~124 m (408 ft), 9 m diameter, ~18 Mlbf liftoff thrust:
//   space.com "How SpaceX's new Starship V3 differs from its predecessors" (2026),
//   satnews.com "SpaceX debuts Starship V3" (2026-05-14)
// - Raptor 3 sea-level thrust ~551,000 lbf (2.45 MN): coverage of the V3 debut.
// - Block 3 Super Heavy: 72.3 m, 3,650 t propellant, 80.8 MN, three grid fins in a
//   90/90/180 arrangement, integrated hot stage: en.wikipedia.org/wiki/SpaceX_Super_Heavy

import { BOOSTER_SURFACES, SHIP_SURFACES } from '../surfaces';
import { DEG } from '../constants';
import { type EngineType, engineFromSeaLevel } from '../engine';
import type { V3 } from '../math';
import type { EnginePlacement, StageDef } from '../vehicle';

export const RAPTOR3: EngineType = engineFromSeaLevel('Raptor 3', 2.45e6, 350, 1.3, {
  gimbalMax: 15 * DEG,
  gimbalRate: 20 * DEG,
  minThrottle: 0.4,
  length: 2.87, // gimbal point to nozzle exit, from the Clarence365 model
});

export const RAPTOR3_VAC: EngineType = {
  name: 'Raptor 3 Vacuum',
  thrustVac: 2.65e6, // approx / tune
  ispVac: 380,
  exitArea: Math.PI * 1.15 ** 2, // ~2.3 m exit diameter
  gimbalMax: 0, // fixed on the ship
  gimbalRate: 0,
  minThrottle: 0.4,
  length: 4.45, // from the Clarence365 model
};

/** A fixed (non-gimballing) variant of Raptor 3 for the booster's outer ring. */
const RAPTOR3_FIXED: EngineType = { ...RAPTOR3, gimbalMax: 0, gimbalRate: 0 };

function ring(type: EngineType, count: number, radius: number, x: number, ringIndex: number, phase = 0): EnginePlacement[] {
  return Array.from({ length: count }, (_, i) => {
    const a = phase + (i / count) * Math.PI * 2;
    const pos: V3 = [x, radius * Math.cos(a), radius * Math.sin(a)];
    return { type, pos, ring: ringIndex };
  });
}

export const BOOSTER_LENGTH = 72.3; // Wikipedia (Block 3)
export const SHIP_LENGTH = 52.1; // Block 2 figure; V3 stack quoted at ~124 m

/** Body x of the booster's engine gimbal plane: nozzle exits sit at the booster base (x = 0). */
const BOOSTER_GIMBAL_X = RAPTOR3.length;
/** Ship gimbal points: RVac exits at the ship's base, sea-level Raptors mounted higher. */
const SHIP_RVAC_X = BOOSTER_LENGTH + RAPTOR3_VAC.length;
const SHIP_RSL_X = BOOSTER_LENGTH + 3.11;

export const SUPER_HEAVY_V3: StageDef = {
  id: 'booster',
  name: 'Super Heavy',
  xBase: 0,
  length: BOOSTER_LENGTH,
  radius: 4.5,
  dryMass: 285e3, // approx / tune (incl. hot-stage ring); leaves 3 engines at min throttle able to hover
  dryCgFrac: 0.36, // 33 engines make the dry booster bottom-heavy
  propMass: 3650e3, // Wikipedia (Block 3)
  mixtureRatio: 3.6,
  loxDensity: 1200, // subcooled
  ch4Density: 440, // subcooled
  tankStart: 5.5,
  reserve: 400e3, // ~11% kept for boostback + landing burn (approx / tune)
  rcsTorque: 4e6, // cold-gas thrusters, approx
  // Three grid fins (90/90/180) around x = 65.6 m, each ~3.4 x 4.5 m (Clarence365 model).
  gridFins: { x: 65.6, area: 3 * 15 },
  surfaces: BOOSTER_SURFACES,
  engines: [
    // 3 center + 10 inner ring gimbal; 20 outer ring are fixed. Radii and phases match the
    // engine positions in the Clarence365 model (art/source/vehicle).
    ...ring(RAPTOR3, 3, 0.75, BOOSTER_GIMBAL_X, 0, 0),
    ...ring(RAPTOR3, 10, 2.36, BOOSTER_GIMBAL_X, 1, Math.PI / 10),
    ...ring(RAPTOR3_FIXED, 20, 3.82, BOOSTER_GIMBAL_X, 2, Math.PI / 20),
  ],
};

/**
 * Starship's catch fittings: the two wedge-shaped knobs on the flap sides (body +-z), part of
 * the ship model (art: Clarence365). The tower's arms catch the ship by their flat undersides.
 * Height of the undersides above the ship's base, m (measured from the model).
 */
export const SHIP_CATCH_PIN = 38.5;

export const STARSHIP_V3: StageDef = {
  id: 'ship',
  name: 'Starship',
  xBase: BOOSTER_LENGTH,
  length: SHIP_LENGTH,
  radius: 4.5,
  // Approx dry + a payload-simulator load in the payload bay (test flights carry Starlink
  // simulators). The payload sits high, which keeps the CG near the belly-flop CP. / tune
  dryMass: 135e3 + 60e3,
  dryCgFrac: 0.48,
  propMass: 1600e3, // approx / tune
  mixtureRatio: 3.6,
  loxDensity: 1200,
  ch4Density: 440,
  tankStart: 4.0,
  reserve: 40e3, // landing-burn reserve
  // The landing propellant lives in header tanks: LOX in the nosecone, CH4 inside the main LOX
  // tank (most of the mass is LOX, so the combined centre is well forward). approx / tune
  header: { mass: 40e3, x: 36 },
  rcsTorque: 3e6,
  // Two forward and two aft flaps (~6.5 x 3.5 m fwd, ~12 x 3.5 m aft, Clarence365 model).
  surfaces: SHIP_SURFACES,
  engines: [
    ...ring(RAPTOR3, 3, 0.86, SHIP_RSL_X, 0, Math.PI / 3),
    ...ring(RAPTOR3_VAC, 3, 3.18, SHIP_RVAC_X, 1, 0),
  ],
};

/** Mission / flight-software parameters for a test-flight-style suborbital profile. */
export const MISSION = {
  /** Launch azimuth, degrees clockwise from north (Starbase flies just south of east). */
  azimuthDeg: 97,
  /** Countdown length after pressing launch, s. */
  countdown: 10,
  /** Engine start relative to T-0, s. */
  ignitionAt: -3,
  /** Required thrust-to-weight before releasing the hold-down clamps. */
  releaseTwr: 1.2,
  /** Start of the pitch-over maneuver after liftoff, s (after clearing the tower). */
  kickStart: 9,
  /** Pitch-over angle from vertical, deg. Main knob for the ascent shape. */
  kickAngleDeg: 4.8,
  /** Dynamic pressure at which the booster throttles down for max-Q, Pa. */
  qBucket: 32e3,
  qBucketThrottle: 0.8,
  /** Hot staging timeline after booster MECO, s. */
  shipIgnitionDelay: 0.4,
  separationDelay: 1.2,
  rvacIgnitionDelay: 2.0,
  boosterCenterOffDelay: 2.5,
  /** Ship guidance: target altitude for the insertion burn, m. */
  shipTargetAlt: 150e3,
  /** Vertical speed at SECO, m/s: the ship coasts up to its apogee over the next ~15 min. */
  shipClimbAtCutoff: 350,
  /**
   * Fraction of the ship's propellant capacity loaded. V3 has more performance than this
   * suborbital profile needs; a partial load leaves roughly the landing reserve at SECO.
   */
  shipPropLoad: 0.9,
  /**
   * The test flights' splashdown target in the Indian Ocean, deg. SECO comes when the predicted
   * splashdown (a conservative glide) reaches it, which leaves the ship some range to spare that
   * its entry guidance banks away as it steers onto the target...
   */
  splashTarget: { lat: -15.2, lon: 111.9 },
  /** ... or, as a backstop, when perigee reaches this altitude, m (negative = transatmospheric). */
  targetPerigeeAlt: -30e3,
  /** Start predicting the splashdown once perigee is above this, m. */
  splashCheckPerigee: -150e3,
  /** Ship acceleration limit, in g. */
  shipMaxAccelG: 4.0,
};

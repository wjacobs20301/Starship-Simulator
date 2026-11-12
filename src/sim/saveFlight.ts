// A flight saved part-way through, to be picked up again later (after a page reload: one mission
// lasts 22 hours). Simulation.save() writes everything the simulation holds as plain JSON and
// Simulation.load() puts it back into a new one, which then flies on exactly as the original
// would have: the same numbers, step for step (tests/saveFlight.test.ts).
//
// Nothing is listed field by field: the simulation's whole web of objects is walked and written
// (saveGraph.ts), so a field added to a vehicle or an autopilot is saved without anyone
// remembering to. What the walk needs from here is the short list of things it can't work out:
// the classes by name, the fixed vehicle definitions (pointed at, never copied), and the one
// function fields hold (the flight log).
//
// Not saved, because it isn't the simulation's: the environment's wind (a function made by
// whoever owns the simulation; the worker saves the weather it was built from and builds it
// again, worker/sim.worker.ts).

import { BoosterReturn } from './boosterReturn';
import { STARSHIP_V3, SUPER_HEAVY_V3 } from './config/starshipV3';
import { EngineFaults } from './engineFaults';
import { GravityTurnGuidance, InsertionGuidance } from './guidance';
import { HeatShield } from './heatShield';
import { PayloadBay } from './payload';
import { Pilot } from './pilot';
import { type GraphKit, type Json, constantParts } from './saveGraph';
import { SeededRandom } from './seededRandom';
import { Mission, type Phase } from './sequencer';
import { ShipReentry } from './shipReentry';
import { ShipReturn } from './shipReturn';
import type { FlightOptions } from './simulation';
import { TowerArms } from './tower';
import { Vehicle } from './vehicle';

/**
 * The save format's version (SAVE_VERSION, kept in saveVersion.ts). A save of an older version is
 * run through the upgrades there (SAVE_UPGRADES) first; one that can't be is refused
 * (Simulation.load throws).
 *
 * Raise it whenever what the simulation holds changes shape or meaning: a field added to,
 * removed from or renamed in the Simulation or any class below, a class added, a vehicle
 * definition that gains or loses engines or surfaces. An old save would load without the new
 * field (classes are rebuilt without running their constructors) and fly wrong. The list of
 * fields is pinned in tests/saveFlight.test.ts, which fails when it changes, as a reminder. And
 * add the upgrade from the old version in SAVE_UPGRADES, if the old saves can be made good.
 */
export { SAVE_VERSION } from './saveVersion';

/** A saved flight: plain JSON (it survives JSON.stringify and back, localStorage, IndexedDB). */
export interface SavedSimulation {
  version: number;
  /** For a list of saved flights, without unpacking one: sim time, mission time (s) and phase when saved. */
  t: number;
  missionTime: number | null;
  phase: Phase;
  /** The flight's setup (Simulation.configure), the pad it launched from and the booster's ocean target, as the worker's 'reset' message takes them. */
  options: FlightOptions;
  pad: number;
  boosterOcean: [number, number] | null;
  /** The environment it flew in: gravity and air on or off, and whether there was a wind (whose owner must supply it again before loading). */
  env: { gravity: boolean; aero: boolean; wind: boolean };
  /** Everything the simulation holds (saveGraph.ts). */
  state: { [key: string]: Json };
}

/** The classes a flight's state is made of. (A class missing here stops a save with an error naming it.) */
const CLASSES = {
  BoosterReturn,
  EngineFaults,
  GravityTurnGuidance,
  HeatShield,
  InsertionGuidance,
  Mission,
  PayloadBay,
  Pilot,
  SeededRandom,
  ShipReentry,
  ShipReturn,
  TowerArms,
  Vehicle,
};

/**
 * The vehicle definitions: every stage, engine placement, engine type and control surface a
 * vehicle points at. A loaded vehicle points at this program's own (the code compares them by
 * identity, and they hold nothing a flight changes).
 */
const CONSTANTS = constantParts({ booster: SUPER_HEAVY_V3, ship: STARSHIP_V3 });

/** What the walk needs for a simulation whose flight log is written by `log`. */
export function saveKit(log: (text: string) => void): GraphKit {
  return { classes: CLASSES, constants: CONSTANTS, functions: { log } };
}
